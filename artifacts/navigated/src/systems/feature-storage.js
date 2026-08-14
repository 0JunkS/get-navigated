import { FEATURE_SAVE_KEY } from "./feature-config.js";

const DEFAULT_STATE = {
  version: 1,
  combo: { current: 0, best: 0, successes: 0 },
  stats: {
    eventSurvived: 0,
    worldsUnlocked: 1,
    coresCollected: 1,
    dailyStreak: 0,
    weeklyTopTen: 0,
  },
  cores: {
    owned: { speed: 1 },
    levels: { speed: 1 },
    equipped: "speed",
  },
  daily: {
    date: "",
    challengeId: "",
    bestMs: null,
    plays: 0,
    targetClaimed: false,
    participationClaimed: false,
  },
  weekly: {
    weekId: "",
    challengeId: "",
    bestMs: null,
    rank: null,
    plays: 0,
    participationClaimed: false,
    resultClaimed: false,
  },
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function mergeState(base, incoming) {
  if (!incoming || typeof incoming !== "object") return base;
  const next = clone(base);
  Object.entries(incoming).forEach(([key, value]) => {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      next[key] &&
      typeof next[key] === "object"
    ) {
      next[key] = mergeState(next[key], value);
    } else if (value !== undefined) {
      next[key] = value;
    }
  });
  return next;
}

export function createFeatureState(incoming) {
  return mergeState(clone(DEFAULT_STATE), incoming);
}

export function loadFeatureState() {
  try {
    const raw = localStorage.getItem(FEATURE_SAVE_KEY);
    return createFeatureState(raw ? JSON.parse(raw) : undefined);
  } catch {
    return createFeatureState();
  }
}

export function saveFeatureState(state) {
  try {
    localStorage.setItem(FEATURE_SAVE_KEY, JSON.stringify(state));
  } catch {
    // The base game's save path already treats storage as best effort.
  }
}

export function getDefaultFeatureState() {
  return createFeatureState();
}

export function serializeFeatureState(state) {
  return clone(state);
}
