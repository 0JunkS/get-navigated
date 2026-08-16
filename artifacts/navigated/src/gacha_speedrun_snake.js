/**
 * gacha_speedrun_snake.js
 * 
 * 1. 크로시스 가챠 중복 아이템 코인 환급 & 확률 보정 (Smart RNG)
 * 2. 게임 시작 ~ 클리어 스피드런 타이머 (Speedrun Timer)
 * 3. 3D 머지 스네이크 (Slither-style 3D Arrow Survival) 미니게임
 */

(function(){
'use strict';

// ══════════════════════════════════════════════════
// 1. 크로시스 가챠 중복 환급 & 확률 보정
// ══════════════════════════════════════════════════

// Smart RNG: 미보유 스킨/맵 가중치 우대 (중복 잘 안 나오게 보정)
window._smartCgPick = function(pool) {
  if (!pool || !pool.length) return pool ? pool[0] : null;
  const adjustedPool = pool.map(item => {
    let w = item.w || 10;
    if (item.type === 'skin' && typeof window.owned !== 'undefined' && window.owned.has(item.id)) {
      w = Math.max(1, Math.floor(w * 0.15)); // 85% 감쇄 -> 미보유 약 5.6배 우대
    } else if (item.type === 'map' && typeof window.ownedMaps !== 'undefined' && window.ownedMaps.has(item.id)) {
      w = Math.max(1, Math.floor(w * 0.15));
    }
    return { ...item, w };
  });
  const total = adjustedPool.reduce((s, r) => s + r.w, 0);
  let rand = Math.random() * total;
  for (const r of adjustedPool) {
    rand -= r.w;
    if (rand <= 0) return r;
  }
  return adjustedPool[0] || pool[0];
};

// Gacha Grant Reward with Duplicate Coin Refund
window._smartCgGrantReward = function(reward, jackpot) {
  function _cgRand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

  if (reward.type === 'coins') {
    let amt = _cgRand(reward.min, reward.max);
    if (jackpot) amt *= 2;
    if (typeof window.coins !== 'undefined') {
      window.coins += amt;
      if (typeof window.doSave === 'function') window.doSave();
      if (typeof window.updateCoins === 'function') window.updateCoins();
    }
    return { text: (jackpot ? '🎆 잭팟! ' : '') + '+' + (jackpot ? amt/2 + '×2=' + amt : amt) + ' 💰', amount: amt, jackpot, isDuplicate: false };
  }

  if (reward.type === 'skin') {
    const isDup = (typeof window.owned !== 'undefined' && window.owned.has(reward.id));
    if (!isDup) {
      if (typeof window.owned !== 'undefined') window.owned.add(reward.id);
      if (typeof window.doSave === 'function') window.doSave();
      if (typeof window.renderShopGrid === 'function') window.renderShopGrid();
      return { text: '🎁 스킨 획득!', amount: 0, jackpot: false, isDuplicate: false };
    } else {
      // 중복 스킨 -> 희귀도별 코인 환급!
      let refundAmt = reward.gacha_excl ? 3000 : 1200;
      if (reward.id === 'crosis_blessed') refundAmt = 4000;
      if (jackpot) refundAmt *= 2;
      if (typeof window.coins !== 'undefined') {
        window.coins += refundAmt;
        if (typeof window.doSave === 'function') window.doSave();
        if (typeof window.updateCoins === 'function') window.updateCoins();
      }
      return { text: `♻️ 중복 스킨 환급! +${refundAmt} 💰`, amount: refundAmt, jackpot, isDuplicate: true };
    }
  }

  if (reward.type === 'map') {
    const isDup = (typeof window.ownedMaps !== 'undefined' && window.ownedMaps.has(reward.id));
    if (!isDup) {
      if (typeof window.ownedMaps !== 'undefined') window.ownedMaps.add(reward.id);
      if (typeof window.doSave === 'function') window.doSave();
      if (typeof window.renderShopGrid === 'function') window.renderShopGrid();
      return { text: '🗺️ 맵 획득!', amount: 0, jackpot: false, isDuplicate: false };
    } else {
      let refundAmt = reward.gacha_excl ? 3500 : 1800;
      if (jackpot) refundAmt *= 2;
      if (typeof window.coins !== 'undefined') {
        window.coins += refundAmt;
        if (typeof window.doSave === 'function') window.doSave();
        if (typeof window.updateCoins === 'function') window.updateCoins();
      }
      return { text: `♻️ 중복 맵 환급! +${refundAmt} 💰`, amount: refundAmt, jackpot, isDuplicate: true };
    }
  }

  return { text: '보상!', amount: 0, jackpot: false, isDuplicate: false };
};

// ══════════════════════════════════════════════════
// 2. 게임 시작 ~ 클리어 스피드런 타이머
// ══════════════════════════════════════════════════
const _speedrunState = {
  active: false,
  startTime: 0,
  elapsed: 0,
  timerId: null,
  bestTime: parseFloat(localStorage.getItem('e3_best_time') || '0')
};

function formatTimeMS(ms) {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  const cs = Math.floor((ms % 1000) / 10);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${cs.toString().padStart(2, '0')}`;
}

function startSpeedrunTimer() {
  if (_speedrunState.active) return;
  _speedrunState.active = true;
  _speedrunState.startTime = performance.now() - _speedrunState.elapsed;
  if (_speedrunState.timerId) clearInterval(_speedrunState.timerId);
  _speedrunState.timerId = setInterval(() => {
    if (!_speedrunState.active) return;
    _speedrunState.elapsed = performance.now() - _speedrunState.startTime;
    const el = document.getElementById('speedrun-hud-txt');
    if (el) el.textContent = formatTimeMS(_speedrunState.elapsed);
  }, 40);
  const hudEl = document.getElementById('speedrun-hud');
  if (hudEl) hudEl.style.display = 'flex';
}

function stopSpeedrunTimer(isClear) {
  _speedrunState.active = false;
  if (_speedrunState.timerId) {
    clearInterval(_speedrunState.timerId);
    _speedrunState.timerId = null;
  }
  if (isClear && _speedrunState.elapsed > 0) {
    if (!_speedrunState.bestTime || _speedrunState.elapsed < _speedrunState.bestTime) {
      _speedrunState.bestTime = _speedrunState.elapsed;
      localStorage.setItem('e3_best_time', _speedrunState.elapsed.toString());
    }
  }
}

function resetSpeedrunTimer() {
  stopSpeedrunTimer(false);
  _speedrunState.elapsed = 0;
  const el = document.getElementById('speedrun-hud-txt');
  if (el) el.textContent = '00:00.00';
}

window.startSpeedrunTimer = startSpeedrunTimer;
window.stopSpeedrunTimer = stopSpeedrunTimer;
window.resetSpeedrunTimer = resetSpeedrunTimer;
window.getSpeedrunFormatted = function() { return formatTimeMS(_speedrunState.elapsed); };
window.getSpeedrunBestFormatted = function() { return _speedrunState.bestTime ? formatTimeMS(_speedrunState.bestTime) : '--:--.--'; };


// ══════════════════════════════════════════════════
// 3. 3D MERGE SNAKE (Slither-style Survival)
// ══════════════════════════════════════════════════
let _snakeActive = false;
let _snakeScene, _snakeCamera, _snakeRenderer;
let _snakeAnimId = null;
let _playerSnake = null;
let _aiSnakes = [];
let _neonDots = [];
let _snakeKeys = {};
let _snakeJoyX = 0, _snakeJoyY = 0;
const FIELD_SIZE = 40; // boundary

function initSnakeEngine() {
  const canvas = document.getElementById('snake-canvas');
  if (!canvas || typeof THREE === 'undefined') return;

  _snakeScene = new THREE.Scene();
  _snakeScene.background = new THREE.Color(0x060919);
  _snakeScene.fog = new THREE.FogExp2(0x060919, 0.018);

  _snakeCamera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 300);
  _snakeCamera.position.set(0, 30, 26);
  _snakeCamera.lookAt(0, 0, 0);

  _snakeRenderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  _snakeRenderer.setSize(window.innerWidth, window.innerHeight);
  _snakeRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  // Lights
  const ambLight = new THREE.AmbientLight(0xffffff, 0.85);
  _snakeScene.add(ambLight);
  const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
  dirLight.position.set(20, 45, 20);
  _snakeScene.add(dirLight);

  // Neon Grid & Fence
  const gridHelper = new THREE.GridHelper(FIELD_SIZE * 2, 40, 0x00f3ff, 0x1a264a);
  gridHelper.position.y = -0.05;
  _snakeScene.add(gridHelper);

  const fenceGeo = new THREE.RingGeometry(FIELD_SIZE - 0.5, FIELD_SIZE + 0.5, 64);
  const fenceMat = new THREE.MeshBasicMaterial({ color: 0xff007f, side: THREE.DoubleSide });
  const fenceMesh = new THREE.Mesh(fenceGeo, fenceMat);
  fenceMesh.rotation.x = Math.PI / 2;
  _snakeScene.add(fenceMesh);

  window.addEventListener('resize', () => {
    if (!_snakeRenderer || !_snakeCamera) return;
    _snakeCamera.aspect = window.innerWidth / window.innerHeight;
    _snakeCamera.updateProjectionMatrix();
    _snakeRenderer.setSize(window.innerWidth, window.innerHeight);
  });

  window.addEventListener('keydown', (e) => { if (_snakeActive) _snakeKeys[e.key.toLowerCase()] = true; });
  window.addEventListener('keyup', (e) => { if (_snakeActive) _snakeKeys[e.key.toLowerCase()] = false; });

  setupJoystick();
}

function setupJoystick() {
  const joy = document.getElementById('snake-joystick');
  const knob = document.getElementById('snake-jknob');
  if (!joy || !knob) return;

  function handleTouch(e) {
    if (!_snakeActive) return;
    const touch = Array.from(e.touches).find(t => t.target.closest('#snake-joystick'));
    if (!touch) {
      _snakeJoyX = 0; _snakeJoyY = 0;
      knob.style.transform = `translate(0px, 0px)`;
      return;
    }
    const rect = joy.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let dx = touch.clientX - cx;
    let dy = touch.clientY - cy;
    const dist = Math.hypot(dx, dy);
    const maxDist = rect.width / 2 - 10;
    if (dist > maxDist) {
      dx = (dx / dist) * maxDist;
      dy = (dy / dist) * maxDist;
    }
    _snakeJoyX = dx / maxDist;
    _snakeJoyY = dy / maxDist;
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
  }

  joy.addEventListener('touchstart', handleTouch, { passive: false });
  joy.addEventListener('touchmove', handleTouch, { passive: false });
  joy.addEventListener('touchend', () => { _snakeJoyX = 0; _snakeJoyY = 0; knob.style.transform = `translate(0px, 0px)`; });
}

function buildSnakeSegmentMesh(skinId, colorHex) {
  const group = new THREE.Group();
  const col = colorHex || '#00f3ff';
  
  if (typeof window.buildArrow === 'function' && typeof window.skinDef === 'function') {
    try {
      const sk = window.skinDef(skinId || 'default');
      window.buildArrow(col, sk, group, null);
      group.scale.set(0.65, 0.65, 0.65);
      return group;
    } catch(e) {}
  }
  
  // Fallback 3D Cone Arrow
  const bodyMat = new THREE.MeshStandardMaterial({ color: col, metalness: 0.6, roughness: 0.2 });
  const bodyGeo = new THREE.ConeGeometry(0.55, 1.3, 8);
  const headMesh = new THREE.Mesh(bodyGeo, bodyMat);
  headMesh.rotation.x = Math.PI / 2;
  group.add(headMesh);
  group.scale.set(0.7, 0.7, 0.7);
  return group;
}

function createSnakeObject(isPlayer, skinId, startX, startZ, isBot) {
  const colorHex = isPlayer ? '#00f3ff' : ['#ff007f', '#39ff14', '#ffee00', '#b500ff', '#ff6600'][Math.floor(Math.random()*5)];
  const headMesh = buildSnakeSegmentMesh(skinId, colorHex);
  _snakeScene.add(headMesh);

  const snake = {
    isPlayer,
    isBot,
    skinId,
    colorHex,
    headMesh,
    pos: new THREE.Vector3(startX, 0.5, startZ),
    angle: Math.random() * Math.PI * 2,
    speed: isPlayer ? 6.5 : 5.2,
    history: [],
    segments: [],
    length: 3,
    energy: 0,
    kills: 0,
    dead: false
  };

  headMesh.position.copy(snake.pos);

  for (let i = 0; i < snake.length - 1; i++) {
    const segMesh = buildSnakeSegmentMesh(skinId, isPlayer ? '#70a1ff' : colorHex);
    _snakeScene.add(segMesh);
    snake.segments.push(segMesh);
  }

  return snake;
}

const NEON_COLORS = [0xff007f, 0x00f3ff, 0x39ff14, 0xffee00, 0xb500ff, 0xff6600];

function spawnNeonDot(x, z, sizeMult = 1) {
  const color = NEON_COLORS[Math.floor(Math.random() * NEON_COLORS.length)];
  const geo = new THREE.SphereGeometry(0.35 * sizeMult, 12, 12);
  const mat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.3, roughness: 0.2 });
  const mesh = new THREE.Mesh(geo, mat);
  const px = x !== undefined ? x : (Math.random() * 2 - 1) * (FIELD_SIZE - 4);
  const pz = z !== undefined ? z : (Math.random() * 2 - 1) * (FIELD_SIZE - 4);
  mesh.position.set(px, 0.4, pz);
  _snakeScene.add(mesh);
  return { mesh, pos: mesh.position, color, size: sizeMult };
}

function initNeonDots(count = 70) {
  _neonDots.forEach(d => _snakeScene.remove(d.mesh));
  _neonDots = [];
  for (let i = 0; i < count; i++) {
    _neonDots.push(spawnNeonDot());
  }
}

function startSnakeGame() {
  if (!_snakeScene) initSnakeEngine();

  if (_playerSnake) {
    _snakeScene.remove(_playerSnake.headMesh);
    _playerSnake.segments.forEach(s => _snakeScene.remove(s));
  }
  _aiSnakes.forEach(bot => {
    _snakeScene.remove(bot.headMesh);
    bot.segments.forEach(s => _snakeScene.remove(s));
  });
  _aiSnakes = [];

  const pSkin = typeof window.activeSkin !== 'undefined' ? window.activeSkin : 'default';
  _playerSnake = createSnakeObject(true, pSkin, 0, 0, false);

  for (let i = 0; i < 5; i++) {
    const rx = (Math.random() * 2 - 1) * 25;
    const rz = (Math.random() * 2 - 1) * 25;
    _aiSnakes.push(createSnakeObject(false, 'neon', rx, rz, true));
  }

  initNeonDots(75);

  _snakeActive = true;
  document.getElementById('snake-game').classList.add('on');
  document.getElementById('snake-modal').style.display = 'none';

  updateSnakeUI();

  if (_snakeAnimId) cancelAnimationFrame(_snakeAnimId);
  let lastTime = performance.now();

  function loop(now) {
    if (!_snakeActive) return;
    const dt = Math.min((now - lastTime) / 1000, 0.1);
    lastTime = now;

    updateSnakeLoop(dt);
    _snakeRenderer.render(_snakeScene, _snakeCamera);
    _snakeAnimId = requestAnimationFrame(loop);
  }

  _snakeAnimId = requestAnimationFrame(loop);
}

function updateSnakeLoop(dt) {
  if (!_playerSnake || _playerSnake.dead) return;

  // Steering
  let moveX = _snakeJoyX;
  let moveZ = _snakeJoyY;

  if (_snakeKeys['w'] || _snakeKeys['arrowup']) moveZ = -1;
  if (_snakeKeys['s'] || _snakeKeys['arrowdown']) moveZ = 1;
  if (_snakeKeys['a'] || _snakeKeys['arrowleft']) moveX = -1;
  if (_snakeKeys['d'] || _snakeKeys['arrowright']) moveX = 1;

  if (Math.abs(moveX) > 0.1 || Math.abs(moveZ) > 0.1) {
    const targetAngle = Math.atan2(moveZ, moveX);
    let diff = targetAngle - _playerSnake.angle;
    while (diff < -Math.PI) diff += Math.PI * 2;
    while (diff > Math.PI) diff -= Math.PI * 2;
    _playerSnake.angle += diff * Math.min(1.0, dt * 10);
  }

  const allSnakes = [_playerSnake, ..._aiSnakes.filter(b => !b.dead)];

  allSnakes.forEach(snake => {
    if (snake.dead) return;

    if (snake.isBot && Math.random() < 0.04) {
      let nearest = null, minDist = 999;
      _neonDots.forEach(d => {
        const dist = snake.pos.distanceTo(d.pos);
        if (dist < minDist) { minDist = dist; nearest = d; }
      });
      if (nearest && minDist < 20) {
        snake.angle = Math.atan2(nearest.pos.z - snake.pos.z, nearest.pos.x - snake.pos.x);
      } else {
        snake.angle += (Math.random() - 0.5) * 1.5;
      }
    }

    snake.pos.x += Math.cos(snake.angle) * snake.speed * dt;
    snake.pos.z += Math.sin(snake.angle) * snake.speed * dt;

    const distFromCenter = Math.hypot(snake.pos.x, snake.pos.z);
    if (distFromCenter > FIELD_SIZE - 1.5) {
      const normalAngle = Math.atan2(-snake.pos.z, -snake.pos.x);
      snake.angle = normalAngle + (Math.random() - 0.5) * 0.5;
      snake.pos.x = Math.cos(snake.angle) * (FIELD_SIZE - 2);
      snake.pos.z = Math.sin(snake.angle) * (FIELD_SIZE - 2);
    }

    snake.headMesh.position.copy(snake.pos);
    snake.headMesh.rotation.y = -snake.angle + Math.PI / 2;

    snake.history.unshift(snake.pos.clone());
    if (snake.history.length > 300) snake.history.pop();

    const spacing = 10;
    snake.segments.forEach((segMesh, idx) => {
      const historyIdx = (idx + 1) * spacing;
      if (snake.history[historyIdx]) {
        segMesh.position.copy(snake.history[historyIdx]);
        const prevPos = idx === 0 ? snake.pos : snake.history[idx * spacing];
        if (prevPos) {
          const segAngle = Math.atan2(prevPos.z - segMesh.position.z, prevPos.x - segMesh.position.x);
          segMesh.rotation.y = -segAngle + Math.PI / 2;
        }
      }
    });

    // Neon dots pickup
    for (let i = _neonDots.length - 1; i >= 0; i--) {
      const dot = _neonDots[i];
      if (snake.pos.distanceTo(dot.pos) < 1.2) {
        _snakeScene.remove(dot.mesh);
        _neonDots.splice(i, 1);
        
        snake.energy += dot.size;
        if (snake.energy >= 3) {
          snake.energy = 0;
          snake.length++;
          const newSeg = buildSnakeSegmentMesh(snake.skinId, snake.colorHex);
          _snakeScene.add(newSeg);
          snake.segments.push(newSeg);
        }

        _neonDots.push(spawnNeonDot());
        if (snake.isPlayer) updateSnakeUI();
      }
    }
  });

  // Camera tracking
  if (_playerSnake && !_playerSnake.dead) {
    _snakeCamera.position.set(_playerSnake.pos.x, 26, _playerSnake.pos.z + 20);
    _snakeCamera.lookAt(_playerSnake.pos.x, 0, _playerSnake.pos.z);
  }

  // Slither Collision Check: Head vs Body/Tail
  allSnakes.forEach(attacker => {
    if (attacker.dead) return;

    allSnakes.forEach(target => {
      if (target.dead) return;

      const minSegIdx = (attacker === target) ? 3 : 0;
      for (let sIdx = minSegIdx; sIdx < target.segments.length; sIdx++) {
        const segPos = target.segments[sIdx].position;
        if (attacker.pos.distanceTo(segPos) < 0.95) {
          // Collision triggered!
          if (attacker.isPlayer) {
            // Player head hit target body -> Player dies!
            killSnake(attacker, false);
            return;
          } else {
            // AI bot head hit body -> Bot dies!
            killSnake(attacker, true);
            if (target.isPlayer) {
              _playerSnake.kills++;
              updateSnakeUI();
            }
          }
        }
      }
    });
  });
}

function killSnake(snake, killedByPlayer) {
  snake.dead = true;
  _snakeScene.remove(snake.headMesh);

  snake.segments.forEach(seg => {
    _snakeScene.remove(seg);
    for (let k = 0; k < 2; k++) {
      const rx = seg.position.x + (Math.random() - 0.5) * 1.5;
      const rz = seg.position.z + (Math.random() - 0.5) * 1.5;
      _neonDots.push(spawnNeonDot(rx, rz, 1.5));
    }
  });
  snake.segments = [];

  if (snake.isPlayer) {
    setTimeout(showSnakeGameOverModal, 600);
  } else if (snake.isBot) {
    setTimeout(() => {
      if (!_snakeActive) return;
      const rx = (Math.random() * 2 - 1) * 30;
      const rz = (Math.random() * 2 - 1) * 30;
      const newBot = createSnakeObject(false, 'neon', rx, rz, true);
      const idx = _aiSnakes.indexOf(snake);
      if (idx !== -1) _aiSnakes[idx] = newBot;
    }, 4000);
  }
}

function updateSnakeUI() {
  if (!_playerSnake) return;
  const lenEl = document.getElementById('snake-len');
  const killsEl = document.getElementById('snake-kills');
  const bestEl = document.getElementById('snake-best');
  const fillEl = document.getElementById('snake-energy-fill');

  const bestLen = Math.max(_playerSnake.length, parseInt(localStorage.getItem('e3_snake_best') || '1'));
  if (_playerSnake.length > bestLen) localStorage.setItem('e3_snake_best', _playerSnake.length.toString());

  if (lenEl) lenEl.textContent = `🐍 ${_playerSnake.length}`;
  if (killsEl) killsEl.textContent = `💥 ${_playerSnake.kills}`;
  if (bestEl) bestEl.textContent = `${bestLen}`;
  if (fillEl) fillEl.style.width = `${(_playerSnake.energy / 3) * 100}%`;
}

function showSnakeGameOverModal() {
  _snakeActive = false;
  const modal = document.getElementById('snake-modal');
  if (!modal) return;

  const len = _playerSnake ? _playerSnake.length : 1;
  const kills = _playerSnake ? _playerSnake.kills : 0;
  const coinsEarned = len * 15 + kills * 50;

  if (typeof window.coins !== 'undefined') {
    window.coins += coinsEarned;
    if (typeof window.doSave === 'function') window.doSave();
    if (typeof window.updateCoins === 'function') window.updateCoins();
  }

  const emojiEl = document.getElementById('snake-modal-emoji');
  const titleEl = document.getElementById('snake-modal-title');
  const subEl = document.getElementById('snake-modal-sub');

  if (emojiEl) emojiEl.textContent = len > 8 ? '👑' : '🐍';
  if (titleEl) titleEl.textContent = 'GAME OVER';
  if (subEl) subEl.textContent = `3D 서바이벌 완료! 화살표 길이: ${len}`;

  const finalLenEl = document.getElementById('snake-final-len');
  const finalKillsEl = document.getElementById('snake-final-kills');
  const earnedEl = document.getElementById('snake-earned');

  if (finalLenEl) finalLenEl.textContent = len;
  if (finalKillsEl) finalKillsEl.textContent = kills;
  if (earnedEl) earnedEl.textContent = `+${coinsEarned} 💰`;

  modal.style.display = 'flex';
}

function closeSnakeGame() {
  _snakeActive = false;
  if (_snakeAnimId) cancelAnimationFrame(_snakeAnimId);
  const gameEl = document.getElementById('snake-game');
  if (gameEl) gameEl.classList.remove('on');
  if (typeof window.showUI === 'function') window.showUI('game-select');
}

window.startSnakeGame = startSnakeGame;
window.closeSnakeGame = closeSnakeGame;

// ══════════════════════════════════════════════════
// Event Hook & Initializations
// ══════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  const pickBtn = document.getElementById('pick-snake');
  if (pickBtn) {
    pickBtn.addEventListener('click', () => {
      const gs = document.getElementById('game-select');
      if (gs) gs.classList.remove('on');
      startSnakeGame();
    });
  }

  const backBtn = document.getElementById('snake-back');
  if (backBtn) backBtn.addEventListener('click', closeSnakeGame);

  const startBtn = document.getElementById('snake-btn-start');
  if (startBtn) startBtn.addEventListener('click', startSnakeGame);
});

// Hook into window.loadLevel & window.endGame for Speedrun timer
(function hookSpeedrunAndGacha() {
  const origLoadLevel = window.loadLevel;
  window.loadLevel = function(i) {
    if (i === 0 || i === 1) {
      resetSpeedrunTimer();
    }
    startSpeedrunTimer();
    if (origLoadLevel) return origLoadLevel.apply(this, arguments);
  };

  const origEndGame = window.endGame;
  window.endGame = function(won) {
    if (won) {
      stopSpeedrunTimer(true);
      const wTimeEl = document.getElementById('w-time');
      if (wTimeEl) {
        wTimeEl.style.display = 'block';
        wTimeEl.innerHTML = `⏱️ 타임: ${window.getSpeedrunFormatted()} <span style="font-size:12px;color:#ffd700">(🏆 Best: ${window.getSpeedrunBestFormatted()})</span>`;
      }
    } else {
      stopSpeedrunTimer(false);
    }
    if (origEndGame) return origEndGame.apply(this, arguments);
  };
})();

})();
