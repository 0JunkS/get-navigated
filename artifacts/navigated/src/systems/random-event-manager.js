import { EVENT_DEFS, GAME_CONFIG } from "./feature-config.js";

function seededRandom(seed) {
  let value = Math.abs(Number(seed) || 1) % 2147483647;
  return () => {
    value = (value * 16807) % 2147483647;
    return (value - 1) / 2147483646;
  };
}

export class RandomEventManager {
  constructor({ onStart, onEnd, onUpdate } = {}) {
    this.onStart = onStart;
    this.onEnd = onEnd;
    this.onUpdate = onUpdate;
    this.active = null;
    this.elapsed = 0;
    this.cooldown = GAME_CONFIG.events.cooldownSeconds;
    this.random = Math.random;
    this.enabled = true;
    this.level = 0;
    this.ranked = false;
    this.tutorial = false;
  }

  startLevel({ level = 0, ranked = false, tutorial = false, seed } = {}) {
    this.endEvent("level-start");
    this.level = level;
    this.ranked = Boolean(ranked);
    this.tutorial = Boolean(tutorial);
    this.enabled = !this.ranked && !this.tutorial && level >= GAME_CONFIG.events.minLevel;
    this.cooldown = 4;
    this.random = seed === undefined ? Math.random : seededRandom(seed);
  }

  getRandomEvent() {
    const available = EVENT_DEFS.filter((event) => event.id !== this.active?.id);
    return available[Math.floor(this.random() * available.length)] || null;
  }

  startEvent(eventOrId, { forced = false } = {}) {
    if (this.ranked || this.tutorial || !this.enabled || this.active) return null;
    if (!forced && this.cooldown > 0) return null;
    const next =
      typeof eventOrId === "string"
        ? EVENT_DEFS.find((event) => event.id === eventOrId)
        : eventOrId || this.getRandomEvent();
    if (!next) return null;
    this.active = { ...next, remaining: next.duration };
    this.elapsed = 0;
    this.onStart?.(this.active);
    return this.active;
  }

  endEvent(reason = "duration") {
    if (!this.active) return;
    const ended = this.active;
    this.active = null;
    this.elapsed = 0;
    this.cooldown = GAME_CONFIG.events.cooldownSeconds;
    this.onEnd?.(ended, reason);
  }

  isEventActive(id) {
    return Boolean(this.active && (!id || this.active.id === id));
  }

  update(deltaSeconds, { phase = "playing" } = {}) {
    if (phase !== "playing" || !this.enabled || this.ranked || this.tutorial) {
      return 1;
    }
    const dt = Math.max(0, Number(deltaSeconds) || 0);
    this.cooldown = Math.max(0, this.cooldown - dt);
    if (this.active) {
      this.elapsed += dt;
      this.active.remaining = Math.max(0, this.active.remaining - dt);
      this.onUpdate?.(this.active);
      if (this.active.remaining <= 0) this.endEvent();
    } else if (
      this.cooldown <= 0 &&
      this.random() < GAME_CONFIG.events.chancePerSecond * dt
    ) {
      this.startEvent();
    }
    if (!this.active) return 1;
    if (this.active.gameplay === "overdrive") return 1.12;
    if (this.active.gameplay === "freeze") return 0.45;
    return 1;
  }

  getCoinBonus() {
    return this.active?.gameplay === "goldRush"
      ? GAME_CONFIG.rewards.goldRushMultiplier - 1
      : 0;
  }

  snapshot() {
    return this.active ? { ...this.active } : null;
  }
}
