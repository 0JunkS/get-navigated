/* NAVIGATED feature UI
 * Pure DOM presentation helpers. Game state and persistence stay in game.js. */

const PANEL_KEYS = [
  'combo',
  'random-events',
  'world-map',
  'core-equipment',
  'daily-challenge',
  'weekly-challenge'
];

const PANEL_COPY = {
  combo: { eyebrow: 'Run signal', title: 'Combo' },
  'random-events': { eyebrow: 'Live modifiers', title: 'Random Events' },
  'world-map': { eyebrow: 'Route overview', title: 'World Map' },
  'core-equipment': { eyebrow: 'Loadout matrix', title: 'Core Equipment' },
  'daily-challenge': { eyebrow: 'Resets daily', title: 'Daily Challenge' },
  'weekly-challenge': { eyebrow: 'Resets weekly', title: 'Weekly Challenge' }
};

let overlayRoot = null;
let scrim = null;
const panelRefs = {};

function text(value, fallback = '') {
  return value === undefined || value === null ? fallback : String(value);
}

function escapeHTML(value) {
  return text(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function asArray(value, keys = []) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    for (const key of keys) {
      if (Array.isArray(value[key])) return value[key];
    }
  }
  return [];
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function percent(current, target) {
  const safeTarget = number(target, 0);
  if (safeTarget <= 0) return number(current, 0) > 0 ? 100 : 0;
  return Math.max(0, Math.min(100, (number(current, 0) / safeTarget) * 100));
}

function safeKey(value) {
  return text(value).toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

function panelMarkup(key) {
  const copy = PANEL_COPY[key];
  return `
    <section class="feature-panel" data-feature-panel="${key}" aria-labelledby="feature-title-${key}" hidden>
      <header class="feature-panel__header">
        <div class="feature-panel__heading">
          <div class="feature-panel__eyebrow">${copy.eyebrow}</div>
          <h2 class="feature-panel__title" id="feature-title-${key}">${copy.title}</h2>
        </div>
        <button class="feature-panel__close" type="button" data-feature-close="${key}" aria-label="Close ${copy.title}">×</button>
      </header>
      <div class="feature-panel__body" data-feature-body="${key}"></div>
    </section>
  `;
}

function comboHudMarkup() {
  return `
    <div class="feature-combo-hud" id="feature-combo-hud" aria-live="polite" aria-atomic="true">
      <div class="feature-combo-hud__mark">CB</div>
      <div>
        <div class="feature-combo-hud__label">Combo</div>
        <div class="feature-combo-hud__value" data-combo-value>0</div>
      </div>
      <div class="feature-combo-hud__best" data-combo-best>Best 0</div>
    </div>
  `;
}

function eventBannerMarkup() {
  return `
    <aside class="feature-event-banner" id="feature-event-banner" aria-live="polite" aria-atomic="true" hidden>
      <div class="feature-event-banner__accent"></div>
      <div class="feature-event-banner__copy">
        <div class="feature-event-banner__label">Random event</div>
        <div class="feature-event-banner__title" data-event-title></div>
        <div class="feature-event-banner__detail" data-event-detail></div>
      </div>
      <button class="feature-event-banner__close" type="button" data-event-dismiss aria-label="Dismiss event banner">×</button>
    </aside>
  `;
}

function setPanelVisibility(key, visible) {
  const panel = panelRefs[key];
  if (!panel) return;
  panel.hidden = !visible;
  panel.classList.toggle('is-visible', visible);
  panel.setAttribute('aria-hidden', String(!visible));
}

function syncScrim() {
  if (!scrim) return;
  const panelOpen = PANEL_KEYS.some((key) => panelRefs[key]?.classList.contains('is-visible'));
  scrim.classList.toggle('is-visible', panelOpen);
}

function closeAllPanels() {
  PANEL_KEYS.forEach((key) => setPanelVisibility(key, false));
  syncScrim();
}

/**
 * Create or return the feature-only DOM layer. This does not touch game state.
 */
export function createFeatureOverlay(options = {}) {
  if (overlayRoot && overlayRoot.isConnected) return overlayRoot;

  const mount = options.mount instanceof HTMLElement ? options.mount : document.body;
  overlayRoot = document.createElement('div');
  overlayRoot.id = 'feature-ui';
  overlayRoot.innerHTML = `
    <div class="feature-scrim" data-feature-scrim></div>
    ${comboHudMarkup()}
    ${eventBannerMarkup()}
    ${PANEL_KEYS.map(panelMarkup).join('')}
  `;
  mount.appendChild(overlayRoot);

  scrim = overlayRoot.querySelector('[data-feature-scrim]');
  PANEL_KEYS.forEach((key) => {
    panelRefs[key] = overlayRoot.querySelector(`[data-feature-panel="${key}"]`);
  });
  updateComboHud({ combo: 0, best: 0, visible: false });
  panelRefs['random-events'].querySelector('[data-feature-body]').innerHTML = renderEventCards([]);
  renderWorldMap({ zones: [] });
  renderCoreInventory({ items: [] });
  renderChallengeCards([], 'daily');
  renderChallengeCards([], 'weekly');

  overlayRoot.querySelectorAll('[data-feature-close]').forEach((button) => {
    button.addEventListener('click', () => hideFeaturePanel(button.dataset.featureClose));
  });
  scrim.addEventListener('click', closeAllPanels);
  overlayRoot.querySelector('[data-event-dismiss]').addEventListener('click', () => {
    const banner = overlayRoot.querySelector('#feature-event-banner');
    banner.classList.remove('is-visible');
    banner.hidden = true;
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeAllPanels();
  });

  return overlayRoot;
}

/**
 * Show one feature panel. key accepts a public panel key or a panel element.
 */
export function showFeaturePanel(key, data) {
  createFeatureOverlay();
  const panelKey = typeof key === 'string' ? key : key?.dataset?.featurePanel;
  if (!PANEL_COPY[panelKey]) return null;
  setPanelVisibility(panelKey, true);
  syncScrim();

  if (data !== undefined) {
    if (panelKey === 'world-map') renderWorldMap(data);
    if (panelKey === 'core-equipment') renderCoreInventory(data);
    if (panelKey === 'random-events') {
      panelRefs[panelKey].querySelector('[data-feature-body]').innerHTML = renderEventCards(asArray(data, ['events', 'items', 'modifiers']));
    }
    if (panelKey === 'combo') updateComboHud(data);
    if (panelKey === 'daily-challenge') renderChallengeCards(data, 'daily');
    if (panelKey === 'weekly-challenge') renderChallengeCards(data, 'weekly');
  }
  return panelRefs[panelKey];
}

/**
 * Hide one panel, or all feature panels when called without a key.
 */
export function hideFeaturePanel(key) {
  createFeatureOverlay();
  if (!key) {
    closeAllPanels();
    return;
  }
  const panelKey = typeof key === 'string' ? key : key?.dataset?.featurePanel;
  if (!PANEL_COPY[panelKey]) return;
  setPanelVisibility(panelKey, false);
  syncScrim();
}

/**
 * Update the small persistent combo HUD and the detailed Combo panel.
 */
export function updateComboHud(state = {}) {
  createFeatureOverlay();
  const combo = number(state.combo ?? state.current ?? state.value, 0);
  const best = number(state.best ?? state.highScore, 0);
  const target = number(state.target ?? state.next ?? 0, 0);
  const hud = overlayRoot.querySelector('#feature-combo-hud');
  hud.querySelector('[data-combo-value]').textContent = text(combo);
  hud.querySelector('[data-combo-best]').textContent = `Best ${text(best)}`;
  hud.classList.toggle('is-visible', state.visible !== false && combo > 0);

  const body = panelRefs.combo.querySelector('[data-feature-body]');
  const progress = target > 0 ? percent(combo, target) : 0;
  body.innerHTML = `
    <div class="feature-combo-card">
      <div class="feature-statline">
        <span class="feature-statline__label">Current chain</span>
        <strong class="feature-statline__value">${escapeHTML(combo)}</strong>
      </div>
      <div class="feature-progress" role="progressbar" aria-valuenow="${escapeHTML(combo)}" aria-valuemin="0" aria-valuemax="${escapeHTML(target || 0)}">
        <div class="feature-progress__fill" style="transform:scaleX(${progress / 100})"></div>
      </div>
      <div class="feature-combo-card__meta">
        <span>${target > 0 ? `Next milestone ${escapeHTML(target)}` : 'Keep the chain alive'}</span>
        <span>Best ${escapeHTML(best)}</span>
      </div>
    </div>
  `;
  return { combo, best, target };
}

/**
 * Present a short-lived random event notice. Timing remains the caller's job.
 */
export function showEventBanner(event = {}) {
  createFeatureOverlay();
  const banner = overlayRoot.querySelector('#feature-event-banner');
  banner.querySelector('[data-event-title]').textContent = text(event.title ?? event.name, 'New event');
  banner.querySelector('[data-event-detail]').textContent = text(event.detail ?? event.description, 'A new modifier is active.');
  banner.hidden = false;
  requestAnimationFrame(() => banner.classList.add('is-visible'));
  return banner;
}

function renderEventCards(events) {
  if (!events.length) return '<div class="feature-empty">No active events</div>';
  return `<div class="feature-event-list">${events.map((event, index) => `
    <article class="feature-event-card">
      <div class="feature-event-card__index">${String(index + 1).padStart(2, '0')}</div>
      <div>
        <div class="feature-item-title">${escapeHTML(event.title ?? event.name ?? 'Event')}</div>
        <div class="feature-item-copy">${escapeHTML(event.detail ?? event.description ?? 'Modifier active')}</div>
        ${event.duration ? `<div class="feature-item-meta">${escapeHTML(event.duration)}</div>` : ''}
      </div>
    </article>
  `).join('')}</div>`;
}

/**
 * Render map nodes. Supports an array of zones or { zones, currentZone, progress }.
 */
export function renderWorldMap(data = {}) {
  createFeatureOverlay();
  const zones = asArray(data, ['zones', 'nodes', 'regions']);
  const current = data && !Array.isArray(data) ? data.currentZone ?? data.current ?? 0 : 0;
  const currentIndex = zones.findIndex((zone, index) => zone.id === current || zone.index === current || index === current);
  const activeIndex = currentIndex >= 0 ? currentIndex : Math.max(0, number(current, 0));
  const cleared = zones.filter((zone) => zone.cleared || zone.status === 'cleared').length;
  const summary = data && !Array.isArray(data) ? data.progress ?? `${cleared}/${zones.length}` : `${cleared}/${zones.length}`;
  const body = panelRefs['world-map'].querySelector('[data-feature-body]');

  if (!zones.length) {
    body.innerHTML = '<div class="feature-empty">World route data is unavailable</div>';
    return body;
  }

  body.innerHTML = `
    <div class="feature-map-summary">
      <div>
        <div class="feature-panel__eyebrow">Current sector</div>
        <div class="feature-map-summary__zone">${escapeHTML(zones[activeIndex]?.name ?? `Zone ${activeIndex + 1}`)}</div>
      </div>
      <div class="feature-map-summary__copy">${escapeHTML(summary)}<br>route progress</div>
    </div>
    <div class="feature-map-track" style="--feature-map-columns:${Math.min(5, Math.max(2, zones.length))}">
      ${zones.map((zone, index) => {
        const status = zone.status ?? (zone.cleared ? 'cleared' : zone.locked ? 'locked' : index === activeIndex ? 'current' : 'available');
        return `
          <div class="feature-map-node is-${escapeHTML(status)}">
            <div class="feature-map-node__dot">${escapeHTML(zone.short ?? zone.number ?? index + 1)}</div>
            <div class="feature-map-node__label">${escapeHTML(zone.name ?? `Zone ${index + 1}`)}</div>
          </div>
        `;
      }).join('')}
    </div>
    <div class="feature-map-legend">
      <span class="is-cleared"><i></i>Cleared</span>
      <span class="is-current"><i></i>Current</span>
      <span><i></i>Locked</span>
    </div>
  `;
  return body;
}

/**
 * Render core modules. Supports an array or { items, power }.
 */
export function renderCoreInventory(data = {}) {
  createFeatureOverlay();
  const items = asArray(data, ['items', 'inventory', 'cores']);
  const power = data && !Array.isArray(data) ? data.power ?? data.score : undefined;
  const body = panelRefs['core-equipment'].querySelector('[data-feature-body]');
  if (!items.length) {
    body.innerHTML = '<div class="feature-empty">No core modules equipped</div>';
    return body;
  }

  body.innerHTML = `
    ${power !== undefined ? `
      <div class="feature-core-power">
        <div class="feature-core-power__label">Core rating</div>
        <div class="feature-core-power__value">${escapeHTML(power)}</div>
      </div>
    ` : ''}
    <div class="feature-inventory-list">
      ${items.map((item, index) => `
        <article class="feature-inventory-card">
          <div class="feature-inventory-card__glyph">${escapeHTML(item.short ?? item.code ?? String(index + 1).padStart(2, '0'))}</div>
          <div>
            <div class="feature-item-title">${escapeHTML(item.name ?? `Core module ${index + 1}`)}</div>
            <div class="feature-inventory-card__state">${escapeHTML(item.effect ?? item.description ?? 'Ready for deployment')}</div>
          </div>
          <div class="feature-inventory-card__level">${escapeHTML(item.level ?? item.rank ?? 'Ready')}</div>
        </article>
      `).join('')}
    </div>
  `;
  return body;
}

function challengeMarkup(challenges) {
  if (!challenges.length) return '<div class="feature-empty">No challenges available</div>';
  return `<div class="feature-challenge-list">${challenges.map((challenge, index) => {
    const current = number(challenge.current ?? challenge.progress ?? challenge.value, 0);
    const target = number(challenge.target ?? challenge.goal ?? challenge.total, 0);
    const complete = Boolean(challenge.complete ?? challenge.completed) || (target > 0 && current >= target);
    const progress = target > 0 ? percent(current, target) : complete ? 100 : 0;
    return `
      <article class="feature-challenge-card${complete ? ' is-complete' : ''}" data-challenge-card="${safeKey(challenge.id ?? index)}">
        <div class="feature-challenge-card__top">
          <div class="feature-item-title">${escapeHTML(challenge.title ?? challenge.name ?? `Challenge ${index + 1}`)}</div>
          ${challenge.reward !== undefined ? `<div class="feature-challenge-card__reward">${escapeHTML(challenge.reward)}</div>` : ''}
        </div>
        <div class="feature-item-copy">${escapeHTML(challenge.description ?? challenge.detail ?? 'Complete the objective to claim the reward.')}</div>
        <div class="feature-challenge-card__progress">
          <span>${complete ? 'Complete' : 'Progress'}</span>
          <span>${escapeHTML(current)}${target > 0 ? ` / ${escapeHTML(target)}` : ''}</span>
        </div>
        <div class="feature-progress" role="progressbar" aria-valuenow="${escapeHTML(current)}" aria-valuemin="0" aria-valuemax="${escapeHTML(target || 0)}">
          <div class="feature-progress__fill" style="transform:scaleX(${progress / 100})"></div>
        </div>
      </article>
    `;
  }).join('')}</div>`;
}

/**
 * Render daily, weekly, or both challenge feeds.
 */
export function renderChallengeCards(data = {}, cadence) {
  createFeatureOverlay();
  if (!cadence && data && !Array.isArray(data)) {
    if (data.daily !== undefined) renderChallengeCards(data.daily, 'daily');
    if (data.weekly !== undefined) renderChallengeCards(data.weekly, 'weekly');
    return;
  }
  const key = cadence === 'weekly' || cadence === 'week' ? 'weekly-challenge' : 'daily-challenge';
  const challenges = asArray(data, ['challenges', 'items', 'missions']);
  const body = panelRefs[key].querySelector('[data-feature-body]');
  body.innerHTML = challengeMarkup(challenges);
  return body;
}

const featureUI = {
  createFeatureOverlay,
  showFeaturePanel,
  hideFeaturePanel,
  updateComboHud,
  showEventBanner,
  renderWorldMap,
  renderCoreInventory,
  renderChallengeCards
};

if (typeof window !== 'undefined') {
  window.NavigatedFeatureUI = featureUI;
}

createFeatureOverlay();