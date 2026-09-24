/**
 * gacha_speedrun_snake.js
 * 
 * 1. 크로시스 가챠 중복 아이템 코인 환급 & 확률 보정 (Smart RNG)
 * 2. 게임 시작 ~ 클리어 스피드런 타이머 (Speedrun Timer)
 * 3. 3D 머지 스네이크 (Slither-style 3D Cuboid Survival) 10인 멀티플레이어 미니게임
 */

import * as THREE from 'three';
if (typeof window !== 'undefined') {
  window.THREE = THREE;
}

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

})();

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
