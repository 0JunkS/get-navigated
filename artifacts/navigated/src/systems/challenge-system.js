import { GAME_CONFIG } from "./feature-config.js";

const DAILY_POOL = Object.freeze([
  { id: "daily-precision", title: "PRECISION RUN", mapId: "neon-07", target: 15, rules: "15 arrows, one life" },
  { id: "daily-forest", title: "FOREST SIGNAL", mapId: "forest-04", target: 12, rules: "12 arrows, no miss" },
  { id: "daily-orbit", title: "ORBIT BREAK", mapId: "space-03", target: 18, rules: "18 arrows, 30 seconds" },
]);

const WEEKLY_POOL = Object.freeze([
  { id: "weekly-neon-07", title: "NEON-07 CIRCUIT", mapId: "neon-07", target: 20, rules: "Fixed seed, no cores, no events" },
  { id: "weekly-space-03", title: "ORBITAL DESCENT", mapId: "space-03", target: 20, rules: "Fixed seed, no cores, no events" },
  { id: "weekly-forest-05", title: "FOREST GATE", mapId: "forest-05", target: 20, rules: "Fixed seed, no cores, no events" },
]);

function pad(value) {
  return String(value).padStart(2, "0");
}

export function utcDateKey(timestamp = Date.now()) {
  const date = new Date(timestamp);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

export function utcWeekKey(timestamp = Date.now()) {
  const date = new Date(timestamp);
  const first = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const day = Math.floor((date - first) / 86400000);
  return `${date.getUTCFullYear()}-W${pad(Math.floor((day + first.getUTCDay()) / 7) + 1)}`;
}

function stableIndex(key, length) {
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return Math.abs(hash) % length;
}

export function getDailyChallenge(timestamp = Date.now()) {
  const date = utcDateKey(timestamp);
  return { ...DAILY_POOL[stableIndex(date, DAILY_POOL.length)], date, challengeId: `daily-${date}` };
}

export function getWeeklyChallenge(timestamp = Date.now()) {
  const weekId = utcWeekKey(timestamp);
  return { ...WEEKLY_POOL[stableIndex(weekId, WEEKLY_POOL.length)], weekId, challengeId: `weekly-${weekId}` };
}

export class ChallengeSystem {
  constructor({ state, onChange, onSave } = {}) {
    this.state = state || { daily: {}, weekly: {} };
    this.onChange = onChange;
    this.onSave = onSave;
    this.serverOffset = 0;
    this.syncPeriod = 0;
    this.refresh(Date.now());
  }

  setServerTime(timestamp) {
    if (Number.isFinite(timestamp)) this.serverOffset = timestamp - Date.now();
    this.refresh(this.now());
  }

  now() {
    return Date.now() + this.serverOffset;
  }

  refresh(timestamp = this.now()) {
    const daily = getDailyChallenge(timestamp);
    const weekly = getWeeklyChallenge(timestamp);
    if (this.state.daily.date !== daily.date || this.state.daily.challengeId !== daily.challengeId) {
      this.state.daily = { date: daily.date, challengeId: daily.challengeId, bestMs: null, plays: 0, targetClaimed: false, participationClaimed: false };
    }
    if (this.state.weekly.weekId !== weekly.weekId || this.state.weekly.challengeId !== weekly.challengeId) {
      this.state.weekly = { weekId: weekly.weekId, challengeId: weekly.challengeId, bestMs: null, rank: null, plays: 0, participationClaimed: false, resultClaimed: false };
    }
    this.onChange?.(this.cards());
  }

  update(deltaSeconds = 0) {
    this.syncPeriod += Math.max(0, deltaSeconds);
    if (this.syncPeriod > 60) {
      this.syncPeriod = 0;
      this.refresh();
    }
  }

  submitDaily(timeMs) {
    this.refresh();
    const time = Math.max(1, Math.round(Number(timeMs) || 0));
    const previous = this.state.daily.bestMs;
    this.state.daily.plays += 1;
    this.state.daily.bestMs = previous === null ? time : Math.min(previous, time);
    this.onSave?.("daily", { ...this.state.daily, time });
    this.onChange?.(this.cards());
    return { bestMs: this.state.daily.bestMs, isBest: previous === null || time < previous };
  }

  submitWeekly(timeMs) {
    this.refresh();
    const time = Math.max(1, Math.round(Number(timeMs) || 0));
    const previous = this.state.weekly.bestMs;
    this.state.weekly.plays += 1;
    this.state.weekly.bestMs = previous === null ? time : Math.min(previous, time);
    this.onSave?.("weekly", { ...this.state.weekly, time });
    this.onChange?.(this.cards());
    return { bestMs: this.state.weekly.bestMs, isBest: previous === null || time < previous };
  }

  cards() {
    const daily = getDailyChallenge(this.now());
    const weekly = getWeeklyChallenge(this.now());
    return {
      daily: [{
        ...daily,
        current: this.state.daily.plays,
        target: daily.target,
        description: `${daily.mapId} · ${daily.rules}`,
        reward: `+${GAME_CONFIG.rewards.dailyParticipationCoins} coins / +${GAME_CONFIG.rewards.dailyParticipationXp} XP`,
        best: this.state.daily.bestMs ? `${(this.state.daily.bestMs / 1000).toFixed(2)}s` : "—",
      }],
      weekly: [{
        ...weekly,
        current: this.state.weekly.plays,
        target: weekly.target,
        description: `${weekly.mapId} · ${weekly.rules}`,
        reward: `+${GAME_CONFIG.rewards.weeklyParticipationCoins} coins / +${GAME_CONFIG.rewards.weeklyParticipationXp} XP`,
        best: this.state.weekly.bestMs ? `${(this.state.weekly.bestMs / 1000).toFixed(2)}s` : "—",
        rank: this.state.weekly.rank ? `#${this.state.weekly.rank}` : "Unranked",
      }],
    };
  }
}
