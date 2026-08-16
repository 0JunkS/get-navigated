import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  setDoc,
} from 'firebase/firestore';

const MAX_MATCHES = 50;
const HISTORY_KEY = 'navigated_history_v1';
const REPLAY_KEY = 'navigated_replays_v1';

function storageKey(base, user) {
  return `${base}:${user?.uid || 'guest'}`;
}

function readLocal(base, user, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey(base, user)) || 'null');
    return Array.isArray(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function writeLocal(base, user, value) {
  try {
    localStorage.setItem(storageKey(base, user), JSON.stringify(value));
  } catch {
    // Storage is best-effort on private browsing and low-storage devices.
  }
}

function trimMatches(matches) {
  return [...matches]
    .sort((a, b) => Number(b.playedAt || 0) - Number(a.playedAt || 0))
    .slice(0, MAX_MATCHES);
}

export function getLocalHistory(user) {
  return trimMatches(readLocal(HISTORY_KEY, user, []));
}

export function getLocalReplay(id, user) {
  const replays = readLocal(REPLAY_KEY, user, []);
  return replays.find((replay) => replay.id === id) || null;
}

export async function saveMatchRecord({ db, user, record, replay }) {
  const history = getLocalHistory(user);
  writeLocal(HISTORY_KEY, user, trimMatches([record, ...history]));

  const replays = readLocal(REPLAY_KEY, user, []);
  writeLocal(
    REPLAY_KEY,
    user,
    [replay, ...replays.filter((item) => item.id !== replay.id)].slice(0, MAX_MATCHES),
  );

  if (!db || !user) return record;

  const matchRef = doc(db, 'users', user.uid, 'matches', record.id);
  const replayRef = doc(db, 'users', user.uid, 'replays', replay.id);
  await setDoc(matchRef, { ...record, ownerUid: user.uid });
  await setDoc(replayRef, { ...replay, ownerUid: user.uid });
  return record;
}

export async function loadUserHistory({ db, user }) {
  if (!user) return getLocalHistory(null);

  if (!db) return getLocalHistory(user);

  try {
    const matchesRef = collection(db, 'users', user.uid, 'matches');
    const snapshot = await getDocs(query(matchesRef, orderBy('playedAt', 'desc'), limit(MAX_MATCHES)));
    const cloudMatches = snapshot.docs.map((item) => ({
      id: item.id,
      ...item.data(),
    }));
    const sorted = trimMatches(cloudMatches);
    writeLocal(HISTORY_KEY, user, sorted);
    return sorted;
  } catch (error) {
    console.warn('[Replay] History load failed:', error);
    return getLocalHistory(user);
  }
}

export async function loadReplay({ db, user, id }) {
  if (!id) return null;
  if (!db || !user) return getLocalReplay(id, user);

  try {
    const replayRef = doc(db, 'users', user.uid, 'replays', id);
    const snapshot = await getDoc(replayRef);
    if (!snapshot.exists()) return getLocalReplay(id, user);
    const replay = { id: snapshot.id, ...snapshot.data() };

    const local = readLocal(REPLAY_KEY, user, []);
    writeLocal(
      REPLAY_KEY,
      user,
      [replay, ...local.filter((item) => item.id !== replay.id)].slice(0, MAX_MATCHES),
    );
    return replay;
  } catch (error) {
    console.warn('[Replay] Replay load failed:', error);
    return getLocalReplay(id, user);
  }
}