import { CORE_DEFS } from "./feature-config.js";

function clampLevel(value) {
  return Math.max(1, Math.min(3, Number(value) || 1));
}

export class CoreSystem {
  constructor({ state, onChange } = {}) {
    this.state = state || {
      owned: { speed: 1 },
      levels: { speed: 1 },
      equipped: "speed",
    };
    this.onChange = onChange;
    this.sanitize();
  }

  sanitize() {
    this.state.owned ||= {};
    this.state.levels ||= {};
    if (!this.state.owned.speed) this.state.owned.speed = 1;
    if (!this.state.levels.speed) this.state.levels.speed = 1;
    if (!CORE_DEFS.some((core) => core.id === this.state.equipped)) {
      this.state.equipped = "speed";
    }
  }

  getDefinition(id) {
    return CORE_DEFS.find((core) => core.id === id) || null;
  }

  list() {
    return CORE_DEFS.map((core) => {
      const owned = Boolean(this.state.owned[core.id]);
      const level = clampLevel(this.state.levels[core.id]);
      const value = core.levels[level - 1] ?? core.levels[0];
      return {
        ...core,
        owned,
        equipped: this.state.equipped === core.id,
        level,
        value,
      };
    });
  }

  grant(id, level = 1) {
    const core = this.getDefinition(id);
    if (!core) return false;
    this.state.owned[id] = Math.max(this.state.owned[id] || 0, 1);
    this.state.levels[id] = Math.max(
      clampLevel(this.state.levels[id]),
      clampLevel(level),
    );
    this.emit();
    return true;
  }

  upgrade(id) {
    if (!this.state.owned[id]) return false;
    const current = clampLevel(this.state.levels[id]);
    if (current >= 3) return false;
    this.state.levels[id] = current + 1;
    this.emit();
    return true;
  }

  equip(id) {
    if (!this.state.owned[id] || !this.getDefinition(id)) return false;
    this.state.equipped = id;
    this.emit();
    return true;
  }

  getModifiers({ ranked = false } = {}) {
    if (ranked) {
      return {
        speed: 0,
        precision: 0,
        coin: 0,
        life: 0,
        combo: 0,
        luck: 0,
      };
    }
    const core = this.getDefinition(this.state.equipped);
    if (!core) return { speed: 0, precision: 0, coin: 0, life: 0, combo: 0, luck: 0 };
    const value = core.levels[clampLevel(this.state.levels[core.id]) - 1] ?? 0;
    return {
      speed: core.effect === "speed" ? value : 0,
      precision: core.effect === "precision" ? value : 0,
      coin: core.effect === "coin" ? value : 0,
      life: core.effect === "life" ? value : 0,
      combo: core.effect === "combo" ? value : 0,
      luck: core.effect === "luck" ? value : 0,
    };
  }

  emit() {
    this.onChange?.(this.list());
  }
}
