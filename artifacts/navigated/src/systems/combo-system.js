import { GAME_CONFIG } from "./feature-config.js";

function tierFor(combo) {
  if (combo >= 10) return 10;
  if (combo >= 5) return 5;
  if (combo >= 3) return 3;
  if (combo >= 2) return 2;
  return 1;
}

export class ComboSystem {
  constructor({ state, onChange, onMilestone } = {}) {
    this.state = state || { current: 0, best: 0, successes: 0 };
    this.onChange = onChange;
    this.onMilestone = onMilestone;
  }

  restore(state) {
    this.state = {
      current: Math.max(0, Number(state?.current) || 0),
      best: Math.max(0, Number(state?.best) || 0),
      successes: Math.max(0, Number(state?.successes) || 0),
    };
    this.emit();
  }

  success({ ranked = false, tutorial = false } = {}) {
    if (ranked || tutorial) {
      this.reset({ silent: true });
      return this.snapshot();
    }
    const beforeTier = tierFor(this.state.current);
    this.state.current = Math.min(
      GAME_CONFIG.combo.max,
      this.state.current + 1,
    );
    this.state.best = Math.max(this.state.best, this.state.current);
    this.state.successes += 1;
    const nextTier = tierFor(this.state.current);
    this.emit();
    if (nextTier !== beforeTier || this.state.current === 1) {
      this.onMilestone?.(this.snapshot());
    }
    return this.snapshot();
  }

  failure({ ranked = false } = {}) {
    if (ranked) return this.snapshot();
    return this.reset();
  }

  reset({ silent = false } = {}) {
    this.state.current = 0;
    if (!silent) this.emit();
    return this.snapshot();
  }

  getScoreMultiplier() {
    const tier = tierFor(this.state.current);
    return GAME_CONFIG.combo.scoreMultipliers[tier] || 1;
  }

  getCoinMultiplier({ ranked = false, coreBonus = 0, eventBonus = 0 } = {}) {
    if (ranked) return 1;
    const comboBonus = Math.min(
      GAME_CONFIG.combo.maxCoinBonus,
      Math.max(0, this.state.current - 1) * GAME_CONFIG.combo.coinStep,
    );
    return 1 + comboBonus + coreBonus + eventBonus;
  }

  snapshot() {
    return {
      ...this.state,
      tier: tierFor(this.state.current),
      scoreMultiplier: this.getScoreMultiplier(),
    };
  }

  emit() {
    this.onChange?.(this.snapshot());
  }
}
