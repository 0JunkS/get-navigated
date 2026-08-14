import {
  createFeatureState,
  loadFeatureState,
  saveFeatureState,
  serializeFeatureState,
} from "./feature-storage.js";
import { ComboSystem } from "./combo-system.js";
import { CoreSystem } from "./core-system.js";
import { RandomEventManager } from "./random-event-manager.js";
import { ChallengeSystem } from "./challenge-system.js";
import { getWorldMapState } from "./world-map-system.js";
import {
  createFeatureOverlay,
  hideFeaturePanel,
  renderChallengeCards,
  renderCoreInventory,
  renderWorldMap,
  showEventBanner,
  showFeaturePanel,
  updateComboHud,
} from "./feature-ui.js";

function eventCopy(event) {
  return {
    title: event.label,
    detail: event.subtitle,
    color: event.color,
    name: event.label,
    description: event.subtitle,
    duration: `${Math.ceil(event.remaining ?? event.duration)}s`,
  };
}

export function createFeatureRuntime() {
  const state = loadFeatureState();
  const runtime = {
    state,
    mode: "solo",
    level: 0,
    ranked: false,
    tutorial: false,
    cloudAdapter: null,
    saveTimer: null,
  };

  const persist = ({ cloud = true } = {}) => {
    saveFeatureState(state);
    if (!cloud || runtime.saveTimer) return;
    runtime.saveTimer = setTimeout(() => {
      runtime.saveTimer = null;
      runtime.cloudAdapter?.save?.(serializeFeatureState(state));
    }, 900);
  };

  const combo = new ComboSystem({
    state: state.combo,
    onChange: (snapshot) => {
      state.combo = { current: snapshot.current, best: snapshot.best, successes: snapshot.successes };
      updateComboHud({ ...snapshot, combo: snapshot.current, visible: runtime.isPlaying() });
      persist();
    },
    onMilestone: (snapshot) => {
      if (snapshot.current >= 10) {
        showEventBanner({ title: "SPECIAL COMBO", detail: `x${snapshot.current} chain reached` });
      }
    },
  });

  const cores = new CoreSystem({
    state: state.cores,
    onChange: (items) => {
      renderCoreInventory({
        items: items.filter((item) => item.owned).map((item) => ({
          name: item.name,
          short: item.icon,
          effect: `${item.rarity} · ${item.equipped ? "EQUIPPED" : "READY"}`,
          level: `Lv.${item.level}`,
        })),
        power: items.filter((item) => item.owned).length,
      });
      persist();
    },
  });

  const events = new RandomEventManager({
    onStart: (event) => showEventBanner(eventCopy(event)),
    onEnd: () => {
      document.body.classList.remove("feature-event-blackout", "feature-event-mirage");
    },
    onUpdate: (event) => {
      if (event.gameplay === "blackout") document.body.classList.add("feature-event-blackout");
      if (event.gameplay === "mirage") document.body.classList.add("feature-event-mirage");
    },
  });

  const challenges = new ChallengeSystem({
    state: state,
    onChange: (cards) => {
      renderChallengeCards(cards.daily, "daily");
      renderChallengeCards(cards.weekly, "weekly");
      persist();
    },
    onSave: (kind, record) => runtime.cloudAdapter?.saveChallenge?.(kind, record),
  });

  runtime.isPlaying = () => runtime.mode === "solo" && !runtime.ranked;

  runtime.init = () => {
    createFeatureOverlay();
    combo.emit();
    cores.emit();
    challenges.refresh();
    runtime.updateMenuActions();
  };

  runtime.updateMenuActions = () => {
    const menu = document.getElementById("menu-bottom");
    if (!menu || menu.querySelector("[data-feature-menu]")) return;
    const rail = document.createElement("div");
    rail.dataset.featureMenu = "true";
    rail.className = "feature-menu-rail";
    rail.innerHTML = `
      <button type="button" data-feature-open="world-map">WORLD</button>
      <button type="button" data-feature-open="core-equipment">CORE</button>
      <button type="button" data-feature-open="daily-challenge">DAILY</button>
      <button type="button" data-feature-open="weekly-challenge">WEEKLY</button>
    `;
    rail.querySelectorAll("[data-feature-open]").forEach((button) => {
      button.addEventListener("click", () => runtime.open(button.dataset.featureOpen));
    });
    menu.appendChild(rail);
  };

  runtime.open = (panel) => {
    if (panel === "world-map") {
      const worlds = getWorldMapState({ progress: window._navigatedProgress?.() ?? 0, clearedLevels: window._navigatedClearedLevels?.() ?? {} });
      renderWorldMap({
        zones: worlds.flatMap((world) => world.nodes.map((node) => ({
          ...node,
          name: `${world.subtitle} ${node.label}`,
          short: node.boss ? "B" : node.label,
          status: node.cleared ? "cleared" : node.available ? "current" : "locked",
        }))),
        progress: `${worlds.filter((world) => world.unlocked).length}/${worlds.length} worlds`,
      });
    }
    if (panel === "core-equipment") cores.emit();
    if (panel === "daily-challenge" || panel === "weekly-challenge") challenges.refresh();
    showFeaturePanel(panel);
  };

  runtime.setCloudAdapter = (adapter) => {
    runtime.cloudAdapter = adapter;
  };

  runtime.restoreCloud = (incoming) => {
    const merged = createFeatureState(incoming);
    Object.assign(state, merged);
    combo.restore(state.combo);
    cores.state = state.cores;
    cores.sanitize();
    challenges.state = state;
    challenges.refresh();
  };

  runtime.serialize = () => serializeFeatureState(state);
  runtime.saveLocal = () => persist({ cloud: false });

  runtime.startLevel = ({ level = 0, ranked = false, tutorial = false, seed } = {}) => {
    runtime.level = level;
    runtime.ranked = Boolean(ranked);
    runtime.tutorial = Boolean(tutorial);
    runtime.mode = runtime.ranked ? "ranked" : "solo";
    combo.reset({ silent: true });
    events.startLevel({ level, ranked: runtime.ranked, tutorial: runtime.tutorial, seed });
    updateComboHud({ combo: 0, best: state.combo.best, visible: true });
  };

  runtime.success = () => {
    if (runtime.ranked || runtime.tutorial) return;
    const snapshot = combo.success({ ranked: runtime.ranked, tutorial: runtime.tutorial });
    state.stats.eventSurvived += events.isEventActive() ? 1 : 0;
    if (snapshot.current >= 10 && state.cores.owned.luck) cores.grant("luck");
  };

  runtime.failure = () => {
    if (!runtime.ranked) combo.failure({ ranked: runtime.ranked });
  };

  runtime.update = (deltaSeconds, { phase = "playing", ranked = runtime.ranked } = {}) => {
    challenges.update(deltaSeconds);
    runtime.ranked = Boolean(ranked);
    return events.update(deltaSeconds, { phase });
  };

  runtime.endLevel = (won) => {
    if (!won) combo.reset();
    events.endEvent(won ? "clear" : "failure");
    persist();
  };

  runtime.getRewardMultiplier = () => {
    const modifiers = cores.getModifiers({ ranked: runtime.ranked });
    return combo.getCoinMultiplier({
      ranked: runtime.ranked,
      coreBonus: modifiers.coin,
      eventBonus: events.getCoinBonus(),
    });
  };

  runtime.getSpeedMultiplier = () => {
    if (runtime.ranked) return 1;
    return 1 + cores.getModifiers({ ranked: false }).speed;
  };

  runtime.getCoreModifiers = () => cores.getModifiers({ ranked: runtime.ranked });
  runtime.getChallenges = () => challenges.cards();
  runtime.submitDaily = (timeMs) => challenges.submitDaily(timeMs);
  runtime.submitWeekly = (timeMs) => challenges.submitWeekly(timeMs);
  runtime.equipCore = (id) => cores.equip(id);
  runtime.upgradeCore = (id) => cores.upgrade(id);
  runtime.grantCore = (id, level) => cores.grant(id, level);
  runtime.hidePanels = () => hideFeaturePanel();

  return runtime;
}

export const featureRuntime = createFeatureRuntime();

if (typeof window !== "undefined") window.NavigatedFeatures = featureRuntime;
