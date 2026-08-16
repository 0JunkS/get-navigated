/**
 * gacha_speedrun_snake.js
 * 
 * 1. 크로시스 가챠 중복 아이템 코인 환급 & 확률 보정 (Smart RNG)
 * 2. 게임 시작 ~ 클리어 스피드런 타이머 (Speedrun Timer)
 * 3. 3D 머지 스네이크 (Slither-style 3D Cuboid Survival) 10인 멀티플레이어 미니게임
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
// 3. 3D MERGE SNAKE (10-PLAYER MULTIPLAYER MINIGAME)
// ══════════════════════════════════════════════════

// Space Dimensions (Spacious 3D Cuboid Box Container)
const BOX_X = 140; // Full width -70 to 70
const BOX_Y = 70;  // Full height -35 to 35
const BOX_Z = 140; // Full depth -70 to 70
const TOTAL_PLAYERS = 10;

// Background Maps Presets
const SNAKE_MAPS = {
  cyber: {
    id: 'cyber',
    name: '🌌 사이버 룸 (Neon Cyber Void)',
    desc: '네온 푸른 빛과 보랏빛 안개의 미래형 공간',
    bgColor: 0x060919,
    fogColor: 0x060919,
    fogDensity: 0.008,
    ambColor: 0xffffff,
    ambIntensity: 0.85,
    dirColor: 0x00f3ff,
    dirIntensity: 1.6,
    edgeColor: 0x00f3ff,
    cornerColor: 0xff007f,
    gridColor: 0x1a264a,
    particleColor: 0x00f3ff,
    particleCount: 180
  },
  volcano: {
    id: 'volcano',
    name: '🌋 용암 챔버 (Volcanic Lava)',
    desc: '뜨거운 불꽃과 주황빛 용암 에너지 공간',
    bgColor: 0x180505,
    fogColor: 0x1c0606,
    fogDensity: 0.010,
    ambColor: 0xffaa77,
    ambIntensity: 0.9,
    dirColor: 0xff3300,
    dirIntensity: 1.8,
    edgeColor: 0xff3300,
    cornerColor: 0xffaa00,
    gridColor: 0x4a1a1a,
    particleColor: 0xff7700,
    particleCount: 220
  },
  crystal: {
    id: 'crystal',
    name: '💎 크리스탈 림 (Crystal Prism)',
    desc: '영롱한 보석 결정과 빛의 굴절 프리즘 공간',
    bgColor: 0x0b0619,
    fogColor: 0x0d0720,
    fogDensity: 0.008,
    ambColor: 0xe0c3fc,
    ambIntensity: 0.9,
    dirColor: 0xb500ff,
    dirIntensity: 1.6,
    edgeColor: 0xe0c3fc,
    cornerColor: 0x00f3ff,
    gridColor: 0x301a4a,
    particleColor: 0x9d4edd,
    particleCount: 180
  },
  sunset: {
    id: 'sunset',
    name: '🌅 신스웨이브 선셋 (Synthwave Sunset)',
    desc: '황혼빛 그리드와 80년대 레트로 감성 공간',
    bgColor: 0x1a0926,
    fogColor: 0x1f0b2e,
    fogDensity: 0.009,
    ambColor: 0xffd166,
    ambIntensity: 0.85,
    dirColor: 0xf72585,
    dirIntensity: 1.7,
    edgeColor: 0xffb703,
    cornerColor: 0xf72585,
    gridColor: 0x4a1a3a,
    particleColor: 0xffb703,
    particleCount: 160
  },
  galaxy: {
    id: 'galaxy',
    name: '🪐 은하수 스페이스 (Galaxy Starfield)',
    desc: '깊은 우주 속 별빛과 반짝이는 은하수 성운',
    bgColor: 0x03030c,
    fogColor: 0x040412,
    fogDensity: 0.006,
    ambColor: 0x90e0ef,
    ambIntensity: 0.8,
    dirColor: 0x4cc9f0,
    dirIntensity: 1.6,
    edgeColor: 0x4cc9f0,
    cornerColor: 0x7209b7,
    gridColor: 0x0f1a30,
    particleColor: 0xffffff,
    particleCount: 260
  }
};

let _activeMapKey = localStorage.getItem('e3_snake_selected_map') || 'cyber';
let _activeSkinKey = localStorage.getItem('e3_snake_selected_skin') || 'dragon';

// AI Bot Nickname Pool
const BOT_NICKNAMES = [
  '네온쉐도우', '골든코브라', '바이퍼99', '크로시스왕', '드래곤슬레이어',
  '갤럭시슬라이더', '픽셀바이퍼', '알파스네이크', '스타헌터', '플라즈마뱀',
  '섀도우킹', '볼텍스리퍼', '나이트크롤러', '메테오드래곤', '코스믹뱀'
];

let _snakeActive = false;
let _snakeScene, _snakeCamera, _snakeRenderer;
let _snakeAnimId = null;
let _playerSnake = null;
let _aiSnakes = [];
let _energyOrbs = [];
let _cuboidEdgeLines = null;
let _cuboidCorners = [];
let _particleSystem = null;
let _snakeKeys = {};
let _snakeJoyX = 0, _snakeJoyY = 0, _snakeJoyPitch = 0;
let _isBoosting = false;
let _matchTimer = 0;
let _matchTimerInterval = null;

// Audio context or sound fx placeholders
function playSnakeSfx(type) {
  try {
    const ctx = window.AudioContext || window.webkitAudioContext;
    if (!ctx) return;
    if (!window._snakeAudioCtx) window._snakeAudioCtx = new ctx();
    const actx = window._snakeAudioCtx;
    if (actx.state === 'suspended') actx.resume();

    const osc = actx.createOscillator();
    const gain = actx.createGain();
    osc.connect(gain);
    gain.connect(actx.destination);

    const now = actx.currentTime;
    if (type === 'eat') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(440, now);
      osc.frequency.exponentialRampToValueAtTime(880, now + 0.1);
      gain.gain.setValueAtTime(0.15, now);
      gain.gain.linearRampToValueAtTime(0.01, now + 0.1);
      osc.start(now); osc.stop(now + 0.1);
    } else if (type === 'kill') {
      osc.type = 'square';
      osc.frequency.setValueAtTime(200, now);
      osc.frequency.exponentialRampToValueAtTime(600, now + 0.25);
      gain.gain.setValueAtTime(0.25, now);
      gain.gain.linearRampToValueAtTime(0.01, now + 0.25);
      osc.start(now); osc.stop(now + 0.25);
    } else if (type === 'dead') {
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(350, now);
      osc.frequency.exponentialRampToValueAtTime(80, now + 0.4);
      gain.gain.setValueAtTime(0.3, now);
      gain.gain.linearRampToValueAtTime(0.01, now + 0.4);
      osc.start(now); osc.stop(now + 0.4);
    } else if (type === 'boost') {
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(150, now);
      gain.gain.setValueAtTime(0.08, now);
      gain.gain.linearRampToValueAtTime(0.01, now + 0.15);
      osc.start(now); osc.stop(now + 0.15);
    }
  } catch (e) {}
}

function initSnakeEngine() {
  const canvas = document.getElementById('snake-canvas');
  if (!canvas || typeof THREE === 'undefined') return;

  _snakeScene = new THREE.Scene();
  _snakeCamera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 500);
  _snakeCamera.position.set(0, 35, 45);
  _snakeCamera.lookAt(0, 0, 0);

  _snakeRenderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  _snakeRenderer.setSize(window.innerWidth, window.innerHeight);
  _snakeRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  // Base Lights
  const ambLight = new THREE.AmbientLight(0xffffff, 0.85);
  ambLight.name = 'ambLight';
  _snakeScene.add(ambLight);

  const dirLight = new THREE.DirectionalLight(0xffffff, 1.6);
  dirLight.name = 'dirLight';
  dirLight.position.set(40, 70, 40);
  _snakeScene.add(dirLight);

  // Apply map styling
  applyMapStyle(_activeMapKey);

  // Build Glowing Cuboid Edges
  buildCuboidBoundary();

  // Resize listener
  window.addEventListener('resize', () => {
    if (!_snakeRenderer || !_snakeCamera) return;
    _snakeCamera.aspect = window.innerWidth / window.innerHeight;
    _snakeCamera.updateProjectionMatrix();
    _snakeRenderer.setSize(window.innerWidth, window.innerHeight);
  });

  // Controls listeners
  window.addEventListener('keydown', (e) => {
    if (!_snakeActive) return;
    const k = e.key.toLowerCase();
    _snakeKeys[k] = true;
    if (k === ' ' || k === 'shift') {
      _isBoosting = true;
      e.preventDefault();
    }
  });

  window.addEventListener('keyup', (e) => {
    if (!_snakeActive) return;
    const k = e.key.toLowerCase();
    _snakeKeys[k] = false;
    if (k === ' ' || k === 'shift') {
      _isBoosting = false;
    }
  });

  setupSnakeTouchAndMouse();
}

function applyMapStyle(mapKey) {
  if (!_snakeScene) return;
  const mapData = SNAKE_MAPS[mapKey] || SNAKE_MAPS.cyber;
  _activeMapKey = mapData.id;
  localStorage.setItem('e3_snake_selected_map', _activeMapKey);

  _snakeScene.background = new THREE.Color(mapData.bgColor);
  _snakeScene.fog = new THREE.FogExp2(mapData.fogColor, mapData.fogDensity);

  const amb = _snakeScene.getObjectByName('ambLight');
  if (amb) {
    amb.color.setHex(mapData.ambColor);
    amb.intensity = mapData.ambIntensity;
  }

  const dir = _snakeScene.getObjectByName('dirLight');
  if (dir) {
    dir.color.setHex(mapData.dirColor);
    dir.intensity = mapData.dirIntensity;
  }

  // Update glowing edges color
  if (_cuboidEdgeLines && _cuboidEdgeLines.material) {
    _cuboidEdgeLines.material.color.setHex(mapData.edgeColor);
  }

  _cuboidCorners.forEach(c => {
    if (c.material) c.material.color.setHex(mapData.cornerColor);
  });

  // Update Background Particles
  createAmbientParticles(mapData);

  // Update UI Map name
  const mNameEl = document.getElementById('snake-hud-mapname');
  if (mNameEl) mNameEl.textContent = mapData.name;
}

function createAmbientParticles(mapData) {
  if (_particleSystem) _snakeScene.remove(_particleSystem);

  const count = mapData.particleCount || 200;
  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array(count * 3);

  const hx = BOX_X / 2 - 2;
  const hy = BOX_Y / 2 - 2;
  const hz = BOX_Z / 2 - 2;

  for (let i = 0; i < count * 3; i += 3) {
    positions[i] = (Math.random() * 2 - 1) * hx;
    positions[i + 1] = (Math.random() * 2 - 1) * hy;
    positions[i + 2] = (Math.random() * 2 - 1) * hz;
  }

  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

  const mat = new THREE.PointsMaterial({
    color: mapData.particleColor,
    size: 0.9,
    transparent: true,
    opacity: 0.75,
    blending: THREE.AdditiveBlending
  });

  _particleSystem = new THREE.Points(geo, mat);
  _snakeScene.add(_particleSystem);
}

// ══════════════════════════════════════════════════
// 3D Cuboid Space Edge Line Segments & Corners
// ══════════════════════════════════════════════════
function buildCuboidBoundary() {
  const hx = BOX_X / 2;
  const hy = BOX_Y / 2;
  const hz = BOX_Z / 2;

  // 8 Corner Vertices of the Cuboid
  const vertices = [
    new THREE.Vector3(-hx, -hy, -hz), // 0
    new THREE.Vector3( hx, -hy, -hz), // 1
    new THREE.Vector3( hx, -hy,  hz), // 2
    new THREE.Vector3(-hx, -hy,  hz), // 3
    new THREE.Vector3(-hx,  hy, -hz), // 4
    new THREE.Vector3( hx,  hy, -hz), // 5
    new THREE.Vector3( hx,  hy,  hz), // 6
    new THREE.Vector3(-hx,  hy,  hz)  // 7
  ];

  // 12 Line Edges connecting vertices
  const edgeIndices = [
    // Bottom rectangle
    0,1,  1,2,  2,3,  3,0,
    // Top rectangle
    4,5,  5,6,  6,7,  7,4,
    // Vertical pillars
    0,4,  1,5,  2,6,  3,7
  ];

  const linePositions = [];
  edgeIndices.forEach(idx => {
    const v = vertices[idx];
    linePositions.push(v.x, v.y, v.z);
  });

  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3));

  const mapData = SNAKE_MAPS[_activeMapKey] || SNAKE_MAPS.cyber;
  const lineMat = new THREE.LineBasicMaterial({
    color: mapData.edgeColor,
    linewidth: 3,
    transparent: true,
    opacity: 0.95
  });

  _cuboidEdgeLines = new THREE.LineSegments(lineGeo, lineMat);
  _snakeScene.add(_cuboidEdgeLines);

  // 8 Glowing Corner Spheres (끝부분 빛나는 버텍스)
  _cuboidCorners.forEach(c => _snakeScene.remove(c));
  _cuboidCorners = [];

  const cornerGeo = new THREE.SphereGeometry(1.4, 16, 16);
  vertices.forEach(v => {
    const cornerMat = new THREE.MeshStandardMaterial({
      color: mapData.cornerColor,
      emissive: mapData.cornerColor,
      emissiveIntensity: 1.8,
      roughness: 0.1
    });
    const sphere = new THREE.Mesh(cornerGeo, cornerMat);
    sphere.position.copy(v);
    _snakeScene.add(sphere);
    _cuboidCorners.push(sphere);
  });

  // Floor Grid Helper
  const gridFloor = new THREE.GridHelper(BOX_X, 28, mapData.edgeColor, mapData.gridColor);
  gridFloor.position.y = -hy + 0.05;
  _snakeScene.add(gridFloor);
}

// ══════════════════════════════════════════════════
// Touch & Mouse Steering Setup
// ══════════════════════════════════════════════════
function setupSnakeTouchAndMouse() {
  const joy = document.getElementById('snake-joystick');
  const knob = document.getElementById('snake-jknob');

  if (joy && knob) {
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
    joy.addEventListener('touchend', () => {
      _snakeJoyX = 0; _snakeJoyY = 0;
      knob.style.transform = `translate(0px, 0px)`;
    });
  }

  // Mouse steer on canvas
  const canvas = document.getElementById('snake-canvas');
  if (canvas) {
    canvas.addEventListener('mousemove', (e) => {
      if (!_snakeActive || !_playerSnake || _playerSnake.dead) return;
      const cx = window.innerWidth / 2;
      const cy = window.innerHeight / 2;
      const dx = (e.clientX - cx) / (window.innerWidth / 2);
      const dy = (e.clientY - cy) / (window.innerHeight / 2);
      
      if (Math.hypot(dx, dy) > 0.15) {
        _snakeJoyX = Math.max(-1, Math.min(1, dx * 1.4));
        _snakeJoyY = Math.max(-1, Math.min(1, dy * 1.4));
      }
    });

    canvas.addEventListener('mousedown', (e) => {
      if (_snakeActive && e.button === 0) {
        _isBoosting = true;
      }
    });
    window.addEventListener('mouseup', () => {
      _isBoosting = false;
    });
  }

  const boostBtn = document.getElementById('snake-btn-boost');
  if (boostBtn) {
    boostBtn.addEventListener('touchstart', (e) => { e.preventDefault(); _isBoosting = true; });
    boostBtn.addEventListener('touchend', (e) => { e.preventDefault(); _isBoosting = false; });
  }
}

// ══════════════════════════════════════════════════
// Snake Skin Segment Generator
// ══════════════════════════════════════════════════
function buildSnakeSegmentMesh(skinId, colorHex, isHead = false, level = 1) {
  const group = new THREE.Group();
  const col = colorHex || '#00f3ff';
  const sk = skinId || _activeSkinKey || 'dragon';

  const bodyMat = new THREE.MeshStandardMaterial({
    color: col,
    metalness: sk === 'cobra' ? 0.9 : 0.6,
    roughness: sk === 'pixel' ? 0.5 : 0.2,
    emissive: sk === 'rainbow' ? col : '#000000',
    emissiveIntensity: sk === 'rainbow' ? 0.5 : 0.0
  });

  if (isHead) {
    // Distinctive Snake Head Mesh per Skin
    if (sk === 'dragon') {
      // Dragon Head with Horns & Eyes
      const headGeo = new THREE.ConeGeometry(0.7, 1.8, 8);
      const headMesh = new THREE.Mesh(headGeo, bodyMat);
      headMesh.rotation.x = Math.PI / 2;
      group.add(headMesh);

      // Horns
      const hornGeo = new THREE.ConeGeometry(0.25, 0.9, 6);
      const hornMat = new THREE.MeshBasicMaterial({ color: 0xff007f });
      const h1 = new THREE.Mesh(hornGeo, hornMat);
      h1.position.set(-0.35, 0.4, -0.2);
      h1.rotation.z = -0.4;
      const h2 = new THREE.Mesh(hornGeo, hornMat);
      h2.position.set(0.35, 0.4, -0.2);
      h2.rotation.z = 0.4;
      group.add(h1); group.add(h2);
    } else if (sk === 'viper') {
      // Cyber Viper Head
      const headGeo = new THREE.BoxGeometry(1.2, 0.7, 1.5);
      const headMesh = new THREE.Mesh(headGeo, bodyMat);
      group.add(headMesh);

      const visorGeo = new THREE.BoxGeometry(1.0, 0.25, 0.6);
      const visorMat = new THREE.MeshBasicMaterial({ color: 0x00f3ff });
      const visor = new THREE.Mesh(visorGeo, visorMat);
      visor.position.set(0, 0.15, 0.5);
      group.add(visor);
    } else if (sk === 'cobra') {
      // Golden Cobra Hood
      const headGeo = new THREE.SphereGeometry(0.8, 12, 12);
      const headMesh = new THREE.Mesh(headGeo, bodyMat);
      group.add(headMesh);

      const hoodGeo = new THREE.CylinderGeometry(1.3, 0.2, 0.2, 12);
      const hoodMat = new THREE.MeshStandardMaterial({ color: 0xffd700, metalness: 0.9, roughness: 0.1 });
      const hood = new THREE.Mesh(hoodGeo, hoodMat);
      hood.position.set(0, 0.1, -0.2);
      group.add(hood);
    } else if (sk === 'pixel') {
      // Cubic Pixel Head
      const headGeo = new THREE.BoxGeometry(1.2, 1.2, 1.2);
      const headMesh = new THREE.Mesh(headGeo, bodyMat);
      group.add(headMesh);
    } else {
      // Classic / Rainbow Head
      const headGeo = new THREE.SphereGeometry(0.75, 16, 16);
      const headMesh = new THREE.Mesh(headGeo, bodyMat);
      group.add(headMesh);

      // Glowing Eyes
      const eyeGeo = new THREE.SphereGeometry(0.18, 8, 8);
      const eyeMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
      const e1 = new THREE.Mesh(eyeGeo, eyeMat);
      e1.position.set(-0.32, 0.2, 0.55);
      const e2 = new THREE.Mesh(eyeGeo, eyeMat);
      e2.position.set(0.32, 0.2, 0.55);
      group.add(e1); group.add(e2);
    }

    // Level Badge Indicator above head
    const badgeGeo = new THREE.OctahedronGeometry(0.3, 0);
    const badgeMat = new THREE.MeshBasicMaterial({ color: 0xffd700 });
    const badge = new THREE.Mesh(badgeGeo, badgeMat);
    badge.position.set(0, 1.4, 0);
    badge.name = 'headBadge';
    group.add(badge);
  } else {
    // Body Segment Mesh matching skin
    if (sk === 'pixel') {
      const segGeo = new THREE.BoxGeometry(0.85, 0.85, 0.85);
      const segMesh = new THREE.Mesh(segGeo, bodyMat);
      group.add(segMesh);
    } else if (sk === 'cobra') {
      const segGeo = new THREE.SphereGeometry(0.55, 12, 12);
      const segMesh = new THREE.Mesh(segGeo, bodyMat);
      group.add(segMesh);
    } else {
      const segGeo = new THREE.SphereGeometry(0.5, 14, 14);
      const segMesh = new THREE.Mesh(segGeo, bodyMat);
      group.add(segMesh);
    }
  }

  group.scale.set(0.8, 0.8, 0.8);
  return group;
}

// ══════════════════════════════════════════════════
// Snake Object Factory
// ══════════════════════════════════════════════════
function createSnakeObject(isPlayer, skinId, startX, startY, startZ, isBot, botName, level = 1) {
  const colorHex = isPlayer
    ? '#00f3ff'
    : ['#ff007f', '#39ff14', '#ffee00', '#b500ff', '#ff6600', '#7209b7', '#4cc9f0'][Math.floor(Math.random() * 7)];

  const headMesh = buildSnakeSegmentMesh(skinId, colorHex, true, level);
  _snakeScene.add(headMesh);

  const snake = {
    id: Math.random().toString(36).substring(2, 9),
    isPlayer,
    isBot,
    name: isPlayer ? '나 (PLAYER)' : botName,
    skinId,
    colorHex,
    level,
    headMesh,
    pos: new THREE.Vector3(startX, startY, startZ),
    vel: new THREE.Vector3(0, 0, 1),
    yaw: Math.random() * Math.PI * 2,
    pitch: 0,
    baseSpeed: isPlayer ? 8.5 : 7.2,
    speed: isPlayer ? 8.5 : 7.2,
    history: [],
    segments: [],
    length: Math.max(3, Math.floor(level * 1.5)),
    energy: 0,
    maxEnergy: 3,
    kills: 0,
    dead: false,
    score: level * 100
  };

  headMesh.position.copy(snake.pos);

  // Initialize Tail Segments
  for (let i = 0; i < snake.length - 1; i++) {
    const segMesh = buildSnakeSegmentMesh(skinId, isPlayer ? '#70a1ff' : colorHex, false, level);
    // Tapering scale towards tail
    const taper = Math.max(0.4, 0.8 - (i / snake.length) * 0.35);
    segMesh.scale.set(taper, taper, taper);
    _snakeScene.add(segMesh);
    snake.segments.push(segMesh);
  }

  return snake;
}

// ══════════════════════════════════════════════════
// 3D Energy Orbs Engine
// ══════════════════════════════════════════════════
const ORB_TYPES = [
  { type: 'small', val: 1, radius: 0.38, color: 0x39ff14 },
  { type: 'medium', val: 3, radius: 0.6, color: 0xffee00 },
  { type: 'mega', val: 6, radius: 0.9, color: 0xb500ff }
];

function spawnEnergyOrb(x, y, z, valType = null) {
  const orbDef = valType
    ? ORB_TYPES.find(t => t.type === valType)
    : (Math.random() < 0.75 ? ORB_TYPES[0] : (Math.random() < 0.85 ? ORB_TYPES[1] : ORB_TYPES[2]));

  const geo = new THREE.SphereGeometry(orbDef.radius, 12, 12);
  const mat = new THREE.MeshStandardMaterial({
    color: orbDef.color,
    emissive: orbDef.color,
    emissiveIntensity: 1.8,
    roughness: 0.1
  });

  const mesh = new THREE.Mesh(geo, mat);

  const hx = BOX_X / 2 - 4;
  const hy = BOX_Y / 2 - 4;
  const hz = BOX_Z / 2 - 4;

  const px = x !== undefined ? x : (Math.random() * 2 - 1) * hx;
  const py = y !== undefined ? y : (Math.random() * 2 - 1) * hy;
  const pz = z !== undefined ? z : (Math.random() * 2 - 1) * hz;

  mesh.position.set(px, py, pz);
  _snakeScene.add(mesh);

  return {
    mesh,
    pos: mesh.position,
    baseY: py,
    val: orbDef.val,
    radius: orbDef.radius,
    color: orbDef.color,
    phase: Math.random() * Math.PI * 2
  };
}

function initEnergyOrbs(count = 90) {
  _energyOrbs.forEach(o => _snakeScene.remove(o.mesh));
  _energyOrbs = [];
  for (let i = 0; i < count; i++) {
    _energyOrbs.push(spawnEnergyOrb());
  }
}

// ══════════════════════════════════════════════════
// Start Minigame & Loop
// ══════════════════════════════════════════════════
function startSnakeGame() {
  if (!_snakeScene) initSnakeEngine();

  // Clear previous entities
  if (_playerSnake) {
    _snakeScene.remove(_playerSnake.headMesh);
    _playerSnake.segments.forEach(s => _snakeScene.remove(s));
  }
  _aiSnakes.forEach(bot => {
    _snakeScene.remove(bot.headMesh);
    bot.segments.forEach(s => _snakeScene.remove(s));
  });
  _aiSnakes = [];

  // Create Player
  const pSkin = localStorage.getItem('e3_snake_selected_skin') || _activeSkinKey || 'dragon';
  _playerSnake = createSnakeObject(true, pSkin, 0, 0, 0, false, 'PLAYER', 1);

  // Spawn 9 AI Bots to make 10 players total
  const nickPool = [...BOT_NICKNAMES].sort(() => Math.random() - 0.5);
  for (let i = 0; i < TOTAL_PLAYERS - 1; i++) {
    const rx = (Math.random() * 2 - 1) * (BOX_X / 2 - 15);
    const ry = (Math.random() * 2 - 1) * (BOX_Y / 2 - 10);
    const rz = (Math.random() * 2 - 1) * (BOX_Z / 2 - 15);
    const botName = nickPool[i % nickPool.length];
    const botSkin = Object.keys(SNAKE_MAPS)[i % 5];
    const botLevel = Math.floor(Math.random() * 4) + 1;
    _aiSnakes.push(createSnakeObject(false, botSkin, rx, ry, rz, true, botName, botLevel));
  }

  // Populate Orbs
  initEnergyOrbs(100);

  _snakeActive = true;
  _matchTimer = 0;

  // Show HUD, Hide lobby modal
  document.getElementById('snake-game').classList.add('on');
  const setupModal = document.getElementById('snake-setup-modal');
  if (setupModal) setupModal.style.display = 'none';
  const overModal = document.getElementById('snake-modal');
  if (overModal) overModal.style.display = 'none';

  if (_matchTimerInterval) clearInterval(_matchTimerInterval);
  _matchTimerInterval = setInterval(() => {
    if (!_snakeActive) return;
    _matchTimer++;
    const tEl = document.getElementById('snake-hud-timer');
    if (tEl) {
      const m = Math.floor(_matchTimer / 60).toString().padStart(2, '0');
      const s = (_matchTimer % 60).toString().padStart(2, '0');
      tEl.textContent = `${m}:${s}`;
    }
  }, 1000);

  updateSnakeUI();

  if (_snakeAnimId) cancelAnimationFrame(_snakeAnimId);
  let lastTime = performance.now();

  function loop(now) {
    if (!_snakeActive) return;
    const dt = Math.min((now - lastTime) / 1000, 0.1);
    lastTime = now;

    updateSnakeLoop(dt, now);
    renderRadarAndLeaderboard(now);

    _snakeRenderer.render(_snakeScene, _snakeCamera);
    _snakeAnimId = requestAnimationFrame(loop);
  }

  _snakeAnimId = requestAnimationFrame(loop);
}

// ══════════════════════════════════════════════════
// Main Game Update Loop
// ══════════════════════════════════════════════════
function updateSnakeLoop(dt, now) {
  if (!_playerSnake) return;

  // Pulse edge lights & ambient particles
  if (_cuboidEdgeLines && _cuboidEdgeLines.material) {
    _cuboidEdgeLines.material.opacity = 0.75 + Math.sin(now * 0.003) * 0.2;
  }
  _cuboidCorners.forEach((c, idx) => {
    if (c.material) {
      c.material.emissiveIntensity = 1.4 + Math.sin(now * 0.004 + idx) * 0.6;
    }
  });
  if (_particleSystem) {
    _particleSystem.rotation.y += 0.0005;
  }

  // Float Orbs
  _energyOrbs.forEach(orb => {
    orb.mesh.position.y = orb.baseY + Math.sin(now * 0.0025 + orb.phase) * 0.4;
    orb.mesh.rotation.y += 0.02;
  });

  // Handle Steering for Player
  if (!_playerSnake.dead) {
    let turnYaw = _snakeJoyX;
    let turnPitch = -_snakeJoyY;

    if (_snakeKeys['w'] || _snakeKeys['arrowup']) turnPitch = 0.8;
    if (_snakeKeys['s'] || _snakeKeys['arrowdown']) turnPitch = -0.8;
    if (_snakeKeys['a'] || _snakeKeys['arrowleft']) turnYaw = -1.0;
    if (_snakeKeys['d'] || _snakeKeys['arrowright']) turnYaw = 1.0;

    _playerSnake.yaw += turnYaw * dt * 2.8;
    _playerSnake.pitch += turnPitch * dt * 1.8;
    _playerSnake.pitch = Math.max(-Math.PI / 3, Math.min(Math.PI / 3, _playerSnake.pitch));

    // Boosting
    if (_isBoosting && _playerSnake.length > 2) {
      _playerSnake.speed = _playerSnake.baseSpeed * 1.7;
      if (Math.random() < 0.15) playSnakeSfx('boost');
    } else {
      _playerSnake.speed = _playerSnake.baseSpeed;
    }
  }

  const allSnakes = [_playerSnake, ..._aiSnakes.filter(b => !b.dead)];

  // Update All Snakes Movement
  allSnakes.forEach(snake => {
    if (snake.dead) return;

    // AI Bot Behavior Steering
    if (snake.isBot) {
      if (Math.random() < 0.05) {
        // Target nearest high-value orb or player
        let nearestOrb = null, minDist = 999;
        _energyOrbs.forEach(o => {
          const d = snake.pos.distanceTo(o.pos);
          if (d < minDist) { minDist = d; nearestOrb = o; }
        });

        if (nearestOrb && minDist < 35) {
          const dx = nearestOrb.pos.x - snake.pos.x;
          const dy = nearestOrb.pos.y - snake.pos.y;
          const dz = nearestOrb.pos.z - snake.pos.z;
          const targetYaw = Math.atan2(dx, dz);
          const targetPitch = Math.atan2(dy, Math.hypot(dx, dz));

          snake.yaw += (targetYaw - snake.yaw) * 0.15;
          snake.pitch += (targetPitch - snake.pitch) * 0.15;
        } else {
          snake.yaw += (Math.random() - 0.5) * 0.8;
          snake.pitch += (Math.random() - 0.5) * 0.4;
        }
      }

      // Random AI Dash
      if (Math.random() < 0.01) {
        snake.speed = snake.baseSpeed * 1.5;
      } else {
        snake.speed = snake.baseSpeed;
      }
    }

    // Direction Velocity Vector
    const cosP = Math.cos(snake.pitch);
    snake.vel.set(
      Math.sin(snake.yaw) * cosP,
      Math.sin(snake.pitch),
      Math.cos(snake.yaw) * cosP
    ).normalize();

    snake.pos.addScaledVector(snake.vel, snake.speed * dt);

    // 3D Cuboid Boundary Containment (Wall bounce/turn)
    const hx = BOX_X / 2 - 2;
    const hy = BOX_Y / 2 - 2;
    const hz = BOX_Z / 2 - 2;

    if (Math.abs(snake.pos.x) > hx || Math.abs(snake.pos.y) > hy || Math.abs(snake.pos.z) > hz) {
      if (snake.isPlayer) {
        // Player crashes into boundary wall!
        killSnake(snake, false, '벽 충돌');
        return;
      } else {
        // AI bot smooth turn back
        snake.yaw += Math.PI * 0.8;
        snake.pos.x = Math.max(-hx + 1, Math.min(hx - 1, snake.pos.x));
        snake.pos.y = Math.max(-hy + 1, Math.min(hy - 1, snake.pos.y));
        snake.pos.z = Math.max(-hz + 1, Math.min(hz - 1, snake.pos.z));
      }
    }

    // Update Head Transform
    snake.headMesh.position.copy(snake.pos);
    snake.headMesh.rotation.y = snake.yaw;
    snake.headMesh.rotation.x = -snake.pitch;

    // History Buffer for Smooth Continuous Body Follow
    snake.history.unshift(snake.pos.clone());
    if (snake.history.length > 400) snake.history.pop();

    const spacing = 7;
    snake.segments.forEach((segMesh, idx) => {
      const hIdx = (idx + 1) * spacing;
      if (snake.history[hIdx]) {
        segMesh.position.copy(snake.history[hIdx]);
        const prevPos = idx === 0 ? snake.pos : snake.history[idx * spacing];
        if (prevPos) {
          segMesh.lookAt(prevPos);
        }
      }
    });

    // Orb Pickup Detection
    for (let i = _energyOrbs.length - 1; i >= 0; i--) {
      const orb = _energyOrbs[i];
      if (snake.pos.distanceTo(orb.pos) < 1.4 + orb.radius) {
        _snakeScene.remove(orb.mesh);
        _energyOrbs.splice(i, 1);

        snake.energy += orb.val;
        snake.score += orb.val * 25;

        if (snake.isPlayer) playSnakeSfx('eat');

        // Grow Tail Segment on Energy Threshold
        if (snake.energy >= snake.maxEnergy) {
          snake.energy = 0;
          snake.length++;
          snake.level++;

          const newSeg = buildSnakeSegmentMesh(snake.skinId, snake.colorHex, false, snake.level);
          const taper = Math.max(0.35, 0.8 - (snake.length / 50));
          newSeg.scale.set(taper, taper, taper);
          _snakeScene.add(newSeg);
          snake.segments.push(newSeg);

          // Update head badge level
          const b = snake.headMesh.getObjectByName('headBadge');
          if (b) b.rotation.y += 0.5;
        }

        // Respawn new orb
        _energyOrbs.push(spawnEnergyOrb());
        if (snake.isPlayer) updateSnakeUI();
      }
    }
  });

  // Camera Third-Person Chasing Player
  if (_playerSnake && !_playerSnake.dead) {
    const camOffset = new THREE.Vector3(
      -Math.sin(_playerSnake.yaw) * 32,
      18 - Math.sin(_playerSnake.pitch) * 12,
      -Math.cos(_playerSnake.yaw) * 32
    );

    const targetCamPos = _playerSnake.pos.clone().add(camOffset);
    _snakeCamera.position.lerp(targetCamPos, 0.12);
    _snakeCamera.lookAt(_playerSnake.pos.clone().add(new THREE.Vector3(0, 2, 0)));
  }

  // ══════════════════════════════════════════════════
  // Slither Collision Detection Rules
  // ══════════════════════════════════════════════════
  allSnakes.forEach(attacker => {
    if (attacker.dead) return;

    allSnakes.forEach(target => {
      if (target.dead) return;

      // Rule 1: Head vs Body Segments Collision
      const minSegIdx = (attacker === target) ? 4 : 0;
      for (let sIdx = minSegIdx; sIdx < target.segments.length; sIdx++) {
        const segPos = target.segments[sIdx].position;
        if (attacker.pos.distanceTo(segPos) < 1.15) {
          if (attacker.isPlayer) {
            // Player head hit target's body/side -> Player Dies! (죽는 경우)
            killSnake(attacker, false, `${target.name}의 측면에 부딫힘`);
            return;
          } else {
            // AI bot head hit player/other snake body -> Bot Dies! (죽이는 경우)
            killSnake(attacker, target.isPlayer, `${target.name}에게 킬 당함`);
            if (target.isPlayer) {
              _playerSnake.kills++;
              _playerSnake.score += 500;
              playSnakeSfx('kill');
              showKillNotice(`💥 ${attacker.name} 처치! (+500 Pts)`);
              updateSnakeUI();
            }
            return;
          }
        }
      }

      // Rule 2: Head vs Head Collision (Different Snakes)
      if (attacker !== target && attacker.pos.distanceTo(target.pos) < 1.4) {
        if (attacker.length < target.length) {
          killSnake(attacker, target.isPlayer, '정면 대결 패배');
        } else if (target.length < attacker.length) {
          killSnake(target, attacker.isPlayer, '정면 대결 패배');
        } else {
          // Bounce away
          attacker.yaw += Math.PI * 0.8;
          target.yaw += Math.PI * 0.8;
        }
      }
    });
  });
}

// ══════════════════════════════════════════════════
// Snake Elimination & Explosion into Energy Orbs
// ══════════════════════════════════════════════════
function killSnake(snake, killedByPlayer, reason = '') {
  if (snake.dead) return;
  snake.dead = true;

  _snakeScene.remove(snake.headMesh);

  // Turn all body segments into glowing energy orb clusters!
  snake.segments.forEach(seg => {
    _snakeScene.remove(seg);
    for (let k = 0; k < 2; k++) {
      const rx = seg.position.x + (Math.random() - 0.5) * 2.0;
      const ry = seg.position.y + (Math.random() - 0.5) * 2.0;
      const rz = seg.position.z + (Math.random() - 0.5) * 2.0;
      _energyOrbs.push(spawnEnergyOrb(rx, ry, rz, Math.random() < 0.3 ? 'medium' : 'small'));
    }
  });
  snake.segments = [];

  if (snake.isPlayer) {
    playSnakeSfx('dead');
    setTimeout(() => showSnakeGameOverModal(reason), 700);
  } else if (snake.isBot) {
    // Respawn AI bot after 3.5s to maintain 10 active players
    setTimeout(() => {
      if (!_snakeActive) return;
      const nickPool = [...BOT_NICKNAMES].sort(() => Math.random() - 0.5);
      const botName = nickPool[0];
      const botSkin = Object.keys(SNAKE_MAPS)[Math.floor(Math.random() * 5)];
      const rx = (Math.random() * 2 - 1) * (BOX_X / 2 - 15);
      const ry = (Math.random() * 2 - 1) * (BOX_Y / 2 - 10);
      const rz = (Math.random() * 2 - 1) * (BOX_Z / 2 - 15);
      const newBot = createSnakeObject(false, botSkin, rx, ry, rz, true, botName, Math.floor(Math.random() * 4) + 1);
      
      const idx = _aiSnakes.indexOf(snake);
      if (idx !== -1) _aiSnakes[idx] = newBot;
      else _aiSnakes.push(newBot);
    }, 3500);
  }
}

// ══════════════════════════════════════════════════
// AI Direction Radar Arrows & Real-time Leaderboard
// ══════════════════════════════════════════════════
function renderRadarAndLeaderboard(now) {
  if (!_playerSnake || !_snakeCamera) return;

  const canvas = document.getElementById('snake-radar-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const radius = Math.min(cx, cy) - 16;

  // Draw Radar Border
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(0, 243, 255, 0.4)';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Radar Sweeper line
  const angle = (now * 0.002) % (Math.PI * 2);
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius);
  ctx.strokeStyle = 'rgba(0, 243, 255, 0.25)';
  ctx.stroke();

  // Plot Enemies on Radar
  _aiSnakes.forEach(bot => {
    if (bot.dead) return;
    const dx = bot.pos.x - _playerSnake.pos.x;
    const dz = bot.pos.z - _playerSnake.pos.z;
    const dist = Math.hypot(dx, dz);

    const mapScale = radius / 75; // 75m range
    const rx = cx + dx * mapScale;
    const ry = cy + dz * mapScale;

    if (Math.hypot(rx - cx, ry - cy) <= radius) {
      ctx.fillStyle = bot.length > _playerSnake.length ? '#ff007f' : '#39ff14';
      ctx.beginPath();
      ctx.arc(rx, ry, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
  });

  // Player Center Marker
  ctx.fillStyle = '#00f3ff';
  ctx.beginPath();
  ctx.arc(cx, cy, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // ══════════════════════════════════════════════════
  // Real-time 10-Player Leaderboard HUD
  // ══════════════════════════════════════════════════
  const allSnakes = [_playerSnake, ..._aiSnakes.filter(b => !b.dead)];
  allSnakes.sort((a, b) => (b.length * 100 + b.kills * 50) - (a.length * 100 + a.kills * 50));

  const listEl = document.getElementById('snake-leaderboard-list');
  if (listEl) {
    let html = '';
    allSnakes.slice(0, 10).forEach((s, rank) => {
      const isSelf = s.isPlayer;
      const rankBadge = rank === 0 ? '👑' : (rank === 1 ? '🥈' : (rank === 2 ? '🥉' : `#${rank + 1}`));
      html += `
        <div class="s-lb-item ${isSelf ? 'self' : ''}">
          <span class="s-lb-rank">${rankBadge}</span>
          <span class="s-lb-name">${s.name}</span>
          <span class="s-lb-len">🐍${s.length}</span>
        </div>
      `;
    });
    listEl.innerHTML = html;
  }

  // Update Player Rank in HUD
  const myRank = allSnakes.findIndex(s => s.isPlayer) + 1;
  const rankEl = document.getElementById('snake-hud-rank');
  if (rankEl) rankEl.textContent = `#${myRank > 0 ? myRank : '-'}`;
}

function showKillNotice(text) {
  const el = document.getElementById('snake-kill-flash');
  if (!el) return;
  el.textContent = text;
  el.style.opacity = '1';
  setTimeout(() => { el.style.opacity = '0'; }, 1800);
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
  if (fillEl) fillEl.style.width = `${(_playerSnake.energy / _playerSnake.maxEnergy) * 100}%`;
}

function showSnakeGameOverModal(reason = '') {
  _snakeActive = false;
  if (_matchTimerInterval) clearInterval(_matchTimerInterval);

  const modal = document.getElementById('snake-modal');
  if (!modal) return;

  const len = _playerSnake ? _playerSnake.length : 1;
  const kills = _playerSnake ? _playerSnake.kills : 0;
  const score = _playerSnake ? _playerSnake.score : 0;
  const coinsEarned = len * 25 + kills * 80 + Math.floor(score * 0.1);

  if (typeof window.coins !== 'undefined') {
    window.coins += coinsEarned;
    if (typeof window.doSave === 'function') window.doSave();
    if (typeof window.updateCoins === 'function') window.updateCoins();
  }

  const emojiEl = document.getElementById('snake-modal-emoji');
  const titleEl = document.getElementById('snake-modal-title');
  const subEl = document.getElementById('snake-modal-sub');

  if (emojiEl) emojiEl.textContent = len > 10 ? '🏆' : '💀';
  if (titleEl) titleEl.textContent = len > 10 ? 'SURVIVAL VICTORY!' : 'GAME OVER';
  if (subEl) subEl.textContent = reason ? `사유: ${reason}` : `3D 10인 생존 매치 완료!`;

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
  if (_matchTimerInterval) clearInterval(_matchTimerInterval);

  const gameEl = document.getElementById('snake-game');
  if (gameEl) gameEl.classList.remove('on');
  if (typeof window.showUI === 'function') window.showUI('game-select');
}

function openSnakeSetupModal() {
  const modal = document.getElementById('snake-setup-modal');
  if (modal) modal.style.display = 'flex';
}

window.startSnakeGame = startSnakeGame;
window.closeSnakeGame = closeSnakeGame;
window.openSnakeSetupModal = openSnakeSetupModal;
window.applySnakeMap = applyMapStyle;

// ══════════════════════════════════════════════════
// Event Hook & Initializations
// ══════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  const pickBtn = document.getElementById('pick-snake');
  if (pickBtn) {
    pickBtn.addEventListener('click', () => {
      const gs = document.getElementById('game-select');
      if (gs) gs.classList.remove('on');
      openSnakeSetupModal();
    });
  }

  const backBtn = document.getElementById('snake-back');
  if (backBtn) backBtn.addEventListener('click', closeSnakeGame);

  const startBtn = document.getElementById('snake-btn-start');
  if (startBtn) startBtn.addEventListener('click', startSnakeGame);

  const lobbyStartBtn = document.getElementById('snake-lobby-btn-start');
  if (lobbyStartBtn) lobbyStartBtn.addEventListener('click', startSnakeGame);

  // Direct Arcade buttons in Main Menu & Modes Hub
  const btnArcade = document.getElementById('btn-arcade');
  if (btnArcade) {
    btnArcade.addEventListener('click', () => {
      if (typeof window.showUI === 'function') window.showUI('hub');
    });
  }

  const mhArcade = document.getElementById('mh-arcade');
  if (mhArcade) {
    mhArcade.addEventListener('click', () => {
      if (typeof window._closePanel === 'function') window._closePanel('modes-ov');
      if (typeof window.showUI === 'function') window.showUI('hub');
    });
  }

  // Map Selector buttons in setup modal
  const mapGrid = document.getElementById('snake-map-selector');
  if (mapGrid) {
    mapGrid.addEventListener('click', (e) => {
      const card = e.target.closest('.snake-map-card');
      if (!card) return;
      const mapKey = card.dataset.map;
      document.querySelectorAll('.snake-map-card').forEach(c => c.classList.remove('on'));
      card.classList.add('on');
      applyMapStyle(mapKey);
    });
  }
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
