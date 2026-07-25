/**
 * redeploy: 2026-07-19T12:00:00.000Z
 * 3D Escape – Multiplayer WebSocket Relay Server + Social (DM + Friends) + Leaderboard API
 * Deploy this file to Render (Node.js Web Service).
 *
 * Start command : node server.mjs
 * Environment   : PORT (Render sets this automatically)
 */

import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const PORT = Number(process.env.PORT ?? 10000);

// ── Data persistence helpers ──────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "data");
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

const LB_FILE    = join(DATA_DIR, "leaderboard.json");
const HIST_FILE  = join(DATA_DIR, "msghistory.json");
const QUEUE_FILE = join(DATA_DIR, "offlinequeue.json");
const USERS_FILE = join(DATA_DIR, "users.json"); // 가입한 유저 닉네임 목록

function loadJSON(path, fallback) {
  try {
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
  } catch {}
  return fallback;
}

function saveJSON(path, data) {
  try { writeFileSync(path, JSON.stringify(data), "utf8"); } catch {}
}

// ── Known users (가입 이력이 있는 닉네임) ────────────────────────────────────
const _savedUsers = loadJSON(USERS_FILE, []);
const SEED_USERS = ["Sedon", "GaNaDi"];
const knownUsers = new Set([...SEED_USERS, ...(Array.isArray(_savedUsers) ? _savedUsers : [])]);

function registerKnownUser(nick) {
  if (!knownUsers.has(nick)) {
    knownUsers.add(nick);
    saveJSON(USERS_FILE, [...knownUsers]);
  }
}

// ── Game room state ──────────────────────────────────────────────────────────
const rooms = new Map(); // code → { host: WebSocket, guest: WebSocket|null }

function safeSend(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}
function getOpponent(room, ws) {
  if (room.host === ws) return room.guest;
  if (room.guest === ws) return room.host;
  return null;
}
function cleanupRoom(code, ws) {
  const room = rooms.get(code);
  if (!room) return;
  const opp = getOpponent(room, ws);
  if (opp) safeSend(opp, { type: "opponent_disconnected" });
  rooms.delete(code);
}

// ── Social state ─────────────────────────────────────────────────────────────
// nickname → WebSocket  (사용자별 상시 연결)
const users = new Map();

// 대화 키: 두 닉네임 정렬 후 ":"로 연결
function convKey(a, b) { return [a, b].sort().join(":"); }

// 메시지 히스토리: convKey → [ {from, text, at} ]  (최대 200개)
// 파일에서 복원
const _savedHist = loadJSON(HIST_FILE, {});
const msgHistory = new Map(Object.entries(_savedHist));

// 오프라인 큐: nickname → [ msg ]  (접속 전 받은 메시지/알림)
// ★ 파일에서 복원 → 서버 재시작 후에도 친구 요청/메시지 유지
const _savedQueue = loadJSON(QUEUE_FILE, {});
const offlineQueue = new Map(
  Object.entries(_savedQueue).map(([k, v]) => [k, Array.isArray(v) ? v : []])
);

function persistOfflineQueue() {
  const obj = {};
  for (const [k, v] of offlineQueue) {
    if (v && v.length > 0) obj[k] = v;
  }
  saveJSON(QUEUE_FILE, obj);
}

function queueOffline(nickname, msg) {
  if (!offlineQueue.has(nickname)) offlineQueue.set(nickname, []);
  const q = offlineQueue.get(nickname);
  q.push(msg);
  if (q.length > 100) q.shift(); // 최대 100개
  persistOfflineQueue(); // ★ 즉시 파일에 저장
}

function flushOffline(nickname, ws) {
  const q = offlineQueue.get(nickname);
  if (!q || !q.length) return;
  for (const msg of q) safeSend(ws, msg);
  offlineQueue.delete(nickname);
  persistOfflineQueue(); // ★ 전달 후 파일 갱신
}

// 메시지 히스토리 파일 저장
function persistMsgHistory() {
  const obj = {};
  for (const [k, v] of msgHistory) obj[k] = v;
  saveJSON(HIST_FILE, obj);
}

// ── Leaderboard (파일 영속) ──────────────────────────────────────────────────
const leaderboard = new Map();
const AI_RIVALS = [
  { name: "ArrowMaster", pts: 820 },
  { name: "QuickEscape",  pts: 710 },
  { name: "NeonFlight",   pts: 650 },
  { name: "StarRider",    pts: 580 },
  { name: "BlazePath",    pts: 490 },
  { name: "SkyBolt",      pts: 420 },
  { name: "CrystalRun",   pts: 350 },
  { name: "SwiftWing",    pts: 260 },
  { name: "LightStep",    pts: 180 },
  { name: "NewPlayer",    pts:  80 },
];

// AI 라이벌 먼저 등록
for (const r of AI_RIVALS) {
  leaderboard.set(r.name, { name: r.name, pts: r.pts, type: "ai", updatedAt: Date.now() });
}
// 저장된 데이터로 덮어쓰기 (사람 점수 복원)
const _savedLb = loadJSON(LB_FILE, []);
for (const e of _savedLb) {
  leaderboard.set(e.name, e);
}

setInterval(() => {
  for (const [, e] of leaderboard) {
    if (e.type !== "ai") continue;
    const d = Math.floor(10 + Math.random() * 20) * (Math.random() < 0.55 ? 1 : -1);
    e.pts = Math.max(10, Math.min(2000, e.pts + d));
    e.updatedAt = Date.now();
  }
  persistLeaderboard(); // AI 변동도 주기적으로 저장
}, 60_000);

function getFullLeaderboard() {
  // knownUsers에 등록된 닉네임은 점수 없어도 포함 (0점)
  const result = new Map([...leaderboard]);
  for (const nick of knownUsers) {
    if (!result.has(nick)) {
      result.set(nick, { name: nick, pts: 0, type: "human", updatedAt: Date.now() });
    }
  }
  const sorted = [...result.values()].sort((a, b) => b.pts - a.pts);
  return sorted.map((e, i) => ({ ...e, rank: i + 1 }));
}
function upsertScore(name, pts, type = "human") {
  if (!name || typeof pts !== "number" || pts < 0) return;
  const ex = leaderboard.get(name);
  leaderboard.set(name, { name, pts, type: ex?.type ?? type, updatedAt: Date.now() });
  persistLeaderboard();
}
function persistLeaderboard() {
  saveJSON(LB_FILE, [...leaderboard.values()]);
}

// 30초마다 히스토리도 저장 (혹시 놓친 경우 대비)
setInterval(persistMsgHistory, 30_000);

// ── CORS helper ───────────────────────────────────────────────────────────────
function setCORS(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const httpServer = createServer((req, res) => {
  setCORS(res);
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  const url = new URL(req.url, "http://localhost");

  if (req.method === "GET" && url.pathname === "/leaderboard") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, data: getFullLeaderboard() }));
    return;
  }

  function readBody(cb) {
    let b = "";
    req.on("data", c => (b += c));
    req.on("end", () => { try { cb(JSON.parse(b)); } catch { res.writeHead(400); res.end('{"ok":false}'); } });
  }

  if (req.method === "POST" && url.pathname === "/leaderboard") {
    readBody(({ name, pts }) => {
      upsertScore(String(name).slice(0, 20), Math.round(pts), "human");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, data: getFullLeaderboard() }));
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/battle") {
    readBody((d) => {
      if (d.winner) upsertScore(String(d.winner).slice(0,20), Math.round(d.winnerPts||0), d.winnerType||"human");
      if (d.loser)  upsertScore(String(d.loser).slice(0,20),  Math.round(d.loserPts||0),  d.loserType||"human");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    });
    return;
  }

  // 유저 존재 여부 확인 (친구 추가 전 검증용)
  if (req.method === "GET" && url.pathname === "/user-exists") {
    const nick = (url.searchParams.get("nickname") || "").trim();
    const exists = nick.length > 0 && knownUsers.has(nick);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, exists }));
    return;
  }

  // 헬스 체크 (서버를 깨우기 위한 핑용)
  if (req.method === "GET" && url.pathname === "/ping") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, ts: Date.now() }));
    return;
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "ok", rooms: rooms.size, users: users.size }));
});

// ── WebSocket server ──────────────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });
httpServer.on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
});

wss.on("connection", (ws) => {
  let assignedCode = null;   // game room
  let myNick       = null;   // social nick

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg?.type) return;

    // ── GAME: join room ──────────────────────────────────────────────────────
    if (msg.type === "join") {
      const code = String(msg.code ?? "").trim();
      if (!code || code.length !== 4) return;
      assignedCode = code;
      const ex = rooms.get(code);
      if (!ex) {
        rooms.set(code, { host: ws, guest: null });
        safeSend(ws, { type: "joined", role: "host" });
      } else if (!ex.guest) {
        ex.guest = ws;
        safeSend(ws, { type: "joined", role: "guest" });
        safeSend(ex.host, { type: "opponent_joined" });
      } else {
        safeSend(ws, { type: "room_full" });
        assignedCode = null;
        ws.close();
      }
      return;
    }

    // ── SOCIAL: register nickname ─────────────────────────────────────────────
    if (msg.type === "register") {
      const nick = String(msg.nickname || "").trim().slice(0, 20);
      if (!nick) return;
      // 같은 닉네임의 기존 연결 해제
      if (users.has(nick) && users.get(nick) !== ws) {
        safeSend(users.get(nick), { type: "session_replaced" });
        users.get(nick).close();
      }
      myNick = nick;
      users.set(nick, ws);
      registerKnownUser(nick); // 가입 이력 기록
      safeSend(ws, { type: "registered", nickname: nick });
      // 오프라인 중 밀린 메시지/알림 전달 (파일에서 복원된 큐 포함)
      flushOffline(nick, ws);
      return;
    }

    // ── SOCIAL: DM 전송 ───────────────────────────────────────────────────────
    if (msg.type === "dm") {
      if (!myNick) return;
      const to   = String(msg.to  || "").trim();
      const text = String(msg.text || "").trim().slice(0, 500);
      if (!to || !text) return;
      const at = Date.now();
      // 히스토리 저장 (서버)
      const key = convKey(myNick, to);
      if (!msgHistory.has(key)) msgHistory.set(key, []);
      const hist = msgHistory.get(key);
      hist.push({ from: myNick, text, at });
      if (hist.length > 200) hist.shift();
      persistMsgHistory();
      // 수신자에게 전달
      const dm = { type: "dm", from: myNick, text, at };
      if (users.has(to)) {
        safeSend(users.get(to), dm);
      } else {
        queueOffline(to, dm);   // ★ 오프라인이면 파일 영속 큐에 보관
      }
      // 발신자에게 확인 (내 기기에 저장)
      safeSend(ws, { type: "dm_sent", to, text, at });
      return;
    }

    // ── SOCIAL: 히스토리 요청 ─────────────────────────────────────────────────
    if (msg.type === "dm_history_req") {
      if (!myNick) return;
      const with_ = String(msg.with || "").trim();
      const key   = convKey(myNick, with_);
      const hist  = msgHistory.get(key) || [];
      safeSend(ws, { type: "dm_history", with: with_, messages: hist });
      return;
    }

    // ── SOCIAL: 친구 요청 (상대방에게 알림 → 자동 상호 추가) ─────────────────
    if (msg.type === "friend_request") {
      if (!myNick) return;
      const to = String(msg.to || "").trim();
      if (!to) return;

      // ★ 중복 친구 요청 방지: 큐에 이미 있으면 다시 넣지 않음
      const notif = { type: "friend_request_incoming", from: myNick };
      if (users.has(to)) {
        safeSend(users.get(to), notif);
      } else {
        // 오프라인 큐 중복 확인
        const existing = offlineQueue.get(to) || [];
        const alreadyQueued = existing.some(
          q => q.type === "friend_request_incoming" && q.from === myNick
        );
        if (!alreadyQueued) {
          queueOffline(to, notif); // ★ 파일 영속 큐에 보관
        }
      }
      return;
    }

    // ── SOCIAL: 친구 삭제 알림 ────────────────────────────────────────────────
    if (msg.type === "friend_delete") {
      if (!myNick) return;
      const to = String(msg.to || "").trim();
      if (!to) return;
      const notif = { type: "friend_deleted_by", from: myNick };
      if (users.has(to)) {
        safeSend(users.get(to), notif);
      } else {
        queueOffline(to, notif); // ★ 파일 영속 큐에 보관
      }
      return;
    }

    
    // ── PLAZA: global chat broadcast ────────────────────────────────────────────
    if (msg.type === "plaza_chat") {
      if (!myNick) return;
      const text = String(msg.text || "").trim().slice(0, 150);
      if (!text) return;
      const bcast = { type: "plaza_chat", from: myNick, text, at: Date.now() };
      for (const [, uw] of users) { if(uw.readyState===WebSocket.OPEN) safeSend(uw,bcast); }
      return;
    }
    // ── PLAZA: position sync ───────────────────────────────────────────────────
    if (msg.type === "plaza_pos") {
      if (!myNick) return;
      const bcast = { type:"plaza_pos", from:myNick, x:msg.x, y:msg.y, d:msg.d, skin:msg.skin };
      for (const [nick, uw] of users) {
        if(nick!==myNick && uw.readyState===WebSocket.OPEN) safeSend(uw,bcast);
      }
      return;
    }
    // ── PLAZA: join / leave ────────────────────────────────────────────────────
    if (msg.type === "plaza_join" || msg.type === "plaza_leave") {
      if (!myNick) return;
      const bcast = { type:msg.type, from:myNick };
      for (const [nick, uw] of users) {
        if(nick!==myNick && uw.readyState===WebSocket.OPEN) safeSend(uw,bcast);
      }
      return;
    }

    // ── GAME: relay ───────────────────────────────────────────────────────────
    if (assignedCode) {
      const room = rooms.get(assignedCode);
      if (!room) return;
      const opp = getOpponent(room, ws);
      if (opp) safeSend(opp, msg);
    }
  });

  ws.on("close", () => {
    if (assignedCode) cleanupRoom(assignedCode, ws);
    if (myNick && users.get(myNick) === ws) users.delete(myNick);
  });

  ws.on("error", () => {
    if (assignedCode) cleanupRoom(assignedCode, ws);
    if (myNick && users.get(myNick) === ws) users.delete(myNick);
  });
});

// Ping every 25s to keep connections alive
setInterval(() => {
  wss.clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.ping(); });
}, 25_000);

httpServer.listen(PORT, () => console.log(`3D Escape server running on port ${PORT}`));
