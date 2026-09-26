import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ── Firebase 모듈형 SDK ────────────────────────────────────────────────────
import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signOut,
  onAuthStateChanged
} from 'firebase/auth';
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  serverTimestamp
} from 'firebase/firestore';
import {
  getLocalHistory,
  loadReplay,
  loadUserHistory,
  saveMatchRecord
} from './replay-store.js';

// window._FB_CFG는 index.html의 <script> 블록에서 설정됨
const _fbApp = window._FB_CFG ? initializeApp(window._FB_CFG) : null;
const _fbAuth = _fbApp ? getAuth(_fbApp) : null;
const _fbDb = _fbApp ? getFirestore(_fbApp) : null;
let _fbUser = null;
function _localServerTimestamp(){
  return Date.now();
}
const bgm=new Audio('/bgm.mp3');
bgm.loop=true;
bgm.volume=0.5;
bgm.preload='auto';
let _bgmStarted=false;
function playBgm(){
  if(_bgmStarted)return;
  bgm.play().then(()=>{
    _bgmStarted=true;
    window.removeEventListener('pointerdown',playBgm);
    window.removeEventListener('keydown',playBgm);
    window.removeEventListener('touchstart',playBgm);
  }).catch(err=>console.warn('BGM 재생 실패, 재시도 대기:', err));
}
window.addEventListener('pointerdown',playBgm);
window.addEventListener('keydown',playBgm);
window.addEventListener('touchstart',playBgm);

// ══════════════════════════════════════════════════
// SEEDED RANDOM (Mulberry32)
// ══════════════════════════════════════════════════
function seededRand(seed){
  let s=(seed^0xdeadbeef)>>>0;
  return function(){
    s=Math.imul(s^(s>>>16),0x45d9f3b)>>>0;
    s=Math.imul(s^(s>>>16),0x45d9f3b)>>>0;
    s=(s^(s>>>16))>>>0;
    return s/0xffffffff;
  };
}

// ══════════════════════════════════════════════════
// CONSTANTS
// ══════════════════════════════════════════════════
const GRID=0.65,ESCAPE=14,SPEED=5.5;
// ── JUST SYSTEM ──
const SPIN_SPEED=Math.PI*1.3;   // rad/s — 0.65 revolutions/sec
const JUST_WINDOW=0.30;          // ±0.30 rad (≈±17°) for PERFECT timing
const BR=0.015,BL=0.30,HR=0.088,HH=0.21;
const DIRS_ALL=['px','nx','py','ny','pz','nz'];
const DEFAULT_COLORS=['#FF6B6B','#4ECDC4','#45B7D1','#96CEB4','#FFEAA7','#DDA0DD',
  '#98D8C8','#F7DC6F','#BB8FCE','#85C1E9','#F0B27A','#82E0AA',
  '#F1948A','#AED6F1','#FAD7A0','#D2B4DE','#A2D9CE','#FDFEFE',
  '#F8C8D4','#C8E6C9','#B3E5FC','#FFE0B2','#E1BEE7','#BBDEFB'];
const DV={px:new THREE.Vector3(1,0,0),nx:new THREE.Vector3(-1,0,0),
  py:new THREE.Vector3(0,1,0),ny:new THREE.Vector3(0,-1,0),
  pz:new THREE.Vector3(0,0,1),nz:new THREE.Vector3(0,0,-1)};

// Difficulty config per level index
// Grid dimensions for a fully packed (no-gap) layout
function gridDims(n){
  // All grids have D>=2 so front/back (pz/nz) arrows always appear
  if(n<=6)  return[3,1,2];   // 3×1×2 = 6
  if(n<=9)  return[3,1,3];   // 3×1×3 = 9
  if(n<=12) return[3,2,2];   // 3×2×2 = 12
  if(n<=16) return[4,2,2];   // 4×2×2 = 16
  if(n<=20) return[5,2,2];   // 5×2×2 = 20
  if(n<=25) return[5,1,5];   // 5×1×5 = 25
  if(n<=36) return[4,3,3];
  if(n<=48) return[4,4,3];
  if(n<=60) return[5,4,3];
  if(n<=75) return[5,5,3];
  if(n<=100)return[5,5,4];
  if(n<=125)return[5,5,5];
  if(n<=150)return[5,5,6];
  return[6,6,Math.ceil(n/36)];
}
function diffConfig(idx){
  let count,label;
  if(idx<3){count=[6,9,12][idx];label='easy';}
  else if(idx<9){count=16+(idx-3)*4;label='med';}
  else if(idx<21){count=36+(idx-9)*6;label='hard';}
  else{count=Math.min(108+(idx-21)*8,200);label='ext';}
  // 스토리 라운드(3,6,9,12...)는 짝수 개 화살표 필수 (서로 충돌해서 탈출)
  if((idx+1)%3===0&&count%2!==0)count++;
  return{count,label};
}

// ══════════════════════════════════════════════════
// PROC GEN (seeded, difficulty-aware)
// ══════════════════════════════════════════════════
// Static blocking check using raw position arrays (for level gen)
function isBlockedByPool(pos,dir,pool){
  const[ax,ay,az]=pos;
  return pool.some(([bx,by,bz])=>{
    if(dir==='px')return by===ay&&bz===az&&bx>ax;
    if(dir==='nx')return by===ay&&bz===az&&bx<ax;
    if(dir==='py')return bx===ax&&bz===az&&by>ay;
    if(dir==='ny')return bx===ax&&bz===az&&by<ay;
    if(dir==='pz')return bx===ax&&by===ay&&bz>az;
    if(dir==='nz')return bx===ax&&by===ay&&bz<az;
    return false;
  });
}

function genLevel(idx){
  const cfg=diffConfig(idx);
  const{count}=cfg;
  const[W,H,D]=gridDims(count);
  const offX=Math.floor(W/2),offY=Math.floor(H/2),offZ=Math.floor(D/2);

  // Build all grid positions
  const positions=[];
  for(let z=0;z<D;z++)for(let y=0;y<H;y++)for(let x=0;x<W;x++){
    if(positions.length>=count)break;
    positions.push([x-offX,y-offY,z-offZ]);
  }

  // ── GREEDY REMOVAL ALGORITHM (guaranteed solvable) ──────────────────
  // At each step, find any arrow whose direction is NOT blocked by any
  // remaining arrow, assign it a direction, remove it from the pool.
  // Proof: in any 3D grid, the arrow furthest in each axis row always has
  // a clear outward path → at least one arrow is always free → always terminates.
  const rand=seededRand(idx*7919+13337);
  const result=new Array(count);
  const remaining=new Set([...Array(count).keys()]);

  // Shuffle removal order for variety (random, but greedy guarantees correctness)
  const shuffled=[...Array(count).keys()];
  for(let i=shuffled.length-1;i>0;i--){
    const j=Math.floor(rand()*(i+1));[shuffled[i],shuffled[j]]=[shuffled[j],shuffled[i]];
  }

  while(remaining.size>0){
    let freed=false;
    for(const posIdx of shuffled){
      if(!remaining.has(posIdx))continue;
      const pos=positions[posIdx];
      const pool=[...remaining].filter(i=>i!==posIdx).map(i=>positions[i]);
      const validDirs=DIRS_ALL.filter(d=>!isBlockedByPool(pos,d,pool));
      if(validDirs.length>0){
        result[posIdx]={pos,dir:validDirs[Math.floor(rand()*validDirs.length)]};
        remaining.delete(posIdx);
        freed=true;
        break; // restart scan from shuffled order to keep variety
      }
    }
    if(!freed){
      // Absolute fallback (never reached in a valid grid): point to nearest boundary
      const posIdx=[...remaining][0];
      const[x,y,z]=positions[posIdx];
      const ox=x+offX,oy=y+offY,oz=z+offZ;
      const dists={px:W-1-ox,nx:ox,py:H-1-oy,ny:oy,pz:D-1-oz,nz:oz};
      const dir=DIRS_ALL.slice().sort((a,b)=>dists[a]-dists[b])[0];
      result[posIdx]={pos:positions[posIdx],dir};
      remaining.delete(posIdx);
    }
  }
  return result;
}

// Seeded multi-level generation from room code (guaranteed solvable)
function genMultiLevel(code,count){
  count=count||12;
  const seed=parseInt(code)*31337+42;
  const rand=seededRand(seed);
  const[W,H,D]=gridDims(count);
  const offX=Math.floor(W/2),offY=Math.floor(H/2),offZ=Math.floor(D/2);
  const positions=[];
  for(let z=0;z<D;z++)for(let y=0;y<H;y++)for(let x=0;x<W;x++)
    positions.push([x-offX,y-offY,z-offZ]);
  // count already set from parameter
  const result=new Array(count);
  const remaining=new Set([...Array(count).keys()]);
  const shuffled=[...Array(count).keys()];
  for(let i=shuffled.length-1;i>0;i--){
    const j=Math.floor(rand()*(i+1));[shuffled[i],shuffled[j]]=[shuffled[j],shuffled[i]];
  }
  while(remaining.size>0){
    let freed=false;
    for(const posIdx of shuffled){
      if(!remaining.has(posIdx))continue;
      const pos=positions[posIdx];
      const pool=[...remaining].filter(i=>i!==posIdx).map(i=>positions[i]);
      const validDirs=DIRS_ALL.filter(d=>!isBlockedByPool(pos,d,pool));
      if(validDirs.length>0){
        result[posIdx]={pos,dir:validDirs[Math.floor(rand()*validDirs.length)]};
        remaining.delete(posIdx);freed=true;break;
      }
    }
    if(!freed){
      const posIdx=[...remaining][0];const[x,y,z]=positions[posIdx];
      const ox=x+offX,oy=y+offY,oz=z+offZ;
      const dists={px:W-1-ox,nx:ox,py:H-1-oy,ny:oy,pz:D-1-oz,nz:oz};
      const dir=DIRS_ALL.slice().sort((a,b)=>dists[a]-dists[b])[0];
      result[posIdx]={pos:positions[posIdx],dir};remaining.delete(posIdx);
    }
  }
  return result;
}

function getLevel(i){return genLevel(i);}
function getLevelArrowCount(i){return diffConfig(i).count;}

// ══════════════════════════════════════════════════
// SKINS
// ══════════════════════════════════════════════════
const SKINS=[
  {id:'default',  name:'기본',         desc:'모던 젬 스타일',           price:0,   emoji:'💠',pc:'p-free',  r:0.55,m:0.15,                         rarity:'common'},
  {id:'gold',     name:'골드',         desc:'반짝이는 금빛 유광',       price:50,  emoji:'✨',pc:'p-cheap', r:0.06,m:0.92,fc:'#FFD700',            rarity:'common'},
  {id:'silver',   name:'실버',         desc:'고급 은빛 도금',           price:60,  emoji:'🥈',pc:'p-cheap', r:0.04,m:0.97,fc:'#d0d4e0',            rarity:'common'},
  {id:'chrome',   name:'크롬',         desc:'완벽한 크롬 마감',         price:90,  emoji:'💿',pc:'p-cheap', r:0.0, m:1.0, fc:'#e8eeff',            rarity:'common'},
  {id:'neon',     name:'네온',         desc:'빛나는 형광 글로우',       price:150, emoji:'💡',pc:'p-cheap', r:1.0, m:0.0, neon:true,               rarity:'rare'},
  {id:'crystal',  name:'크리스탈',     desc:'투명한 유리 질감',         price:350, emoji:'💎',pc:'p-exp',   r:0.0, m:0.1, tr:true,op:1,crystal:true, rarity:'epic'},
  {id:'car',      name:'자동차',       desc:'달리는 자동차 모양',       price:500, emoji:'🚗',pc:'p-exp',   shape:'car',                           rarity:'rare'},
  {id:'rocket',   name:'로켓',         desc:'솟아오르는 로켓 형태',     price:600, emoji:'🚀',pc:'p-exp',   shape:'rocket',                        rarity:'epic'},
  {id:'star',     name:'별',           desc:'다섯 꼭짓점 별 모양',      price:400, emoji:'⭐',pc:'p-exp',   shape:'star',                          rarity:'rare'},
  {id:'sword',    name:'검',           desc:'날카로운 검 형태',         price:500, emoji:'⚔️',pc:'p-exp',   shape:'sword',                         rarity:'epic'},
  {id:'mushroom', name:'버섯',         desc:'귀여운 버섯 모양',         price:300, emoji:'🍄',pc:'p-cheap', shape:'mushroom',                      rarity:'common'},
  {id:'crystal2', name:'크리스탈 샤드',desc:'날카로운 크리스탈 파편',   price:700, emoji:'🔷',pc:'p-exp',   shape:'crystal2',                      rarity:'epic'},
  // ── 신규 스킨 ──────────────────────────────────
  {id:'flame',    name:'불꽃',         desc:'타오르는 불꽃 화살',       price:400, emoji:'🔥',pc:'p-exp',   shape:'flame',   fc:'#FF4500',r:0.9,m:0,neon:true,  rarity:'rare'},
  {id:'ice',      name:'얼음',         desc:'차가운 얼음 화살',         price:400, emoji:'❄️',pc:'p-exp',   shape:'ice',     fc:'#C8F4FF',r:0,m:0.1,tr:true,op:1,crystal:true, rarity:'rare'},
  {id:'thunder',  name:'번개',         desc:'번쩍이는 번개 화살',       price:700, emoji:'⚡',pc:'p-exp',   shape:'thunder', fc:'#FFE600',r:1,m:0,neon:true,    rarity:'epic'},
  {id:'dragon',   name:'드래곤',       desc:'전설의 드래곤 화살 · 크로시스 가챠 전용', price:0, emoji:'🐉',pc:'p-gacha', shape:'dragon', gacha:true, fc:'#1E6B3A',r:0.4,m:0.55, rarity:'legendary'},
  {id:'rainbow',  name:'무지개',       desc:'화려한 무지개 화살',       price:800, emoji:'🌈',pc:'p-exp',   shape:'rainbow', fc:'#FF6EFF',r:0.9,m:0,neon:true,  rarity:'epic'},
  {id:'ghost',    name:'유령',         desc:'투명한 유령 화살',         price:450, emoji:'👻',pc:'p-exp',   shape:'ghost',   fc:'#D8E4FF',r:0.3,m:0,tr:true,op:1, rarity:'rare'},
  {id:'lava',     name:'용암',         desc:'뜨거운 용암 화살',         price:900, emoji:'🌋',pc:'p-exp',   shape:'lava',    fc:'#1A1A1A',r:0.95,m:0.1,          rarity:'epic'},
  {id:'cosmic',   name:'코스믹',       desc:'우주의 힘 · 크로시스 가챠 전용', price:0,   emoji:'🌟',pc:'p-gacha', shape:'cosmic', gacha:true, fc:'#1010AA',r:0,m:0.2,tr:true,op:1,crystal:true, rarity:'legendary'},
];

// ══════════════════════════════════════════════════
// MAPS
// ══════════════════════════════════════════════════
const MAPS=[
  {id:'default',name:'우주',desc:'다채로운 기본 우주',price:0,emoji:'🌌',pc:'p-free',
   bg:'#06061a',fogColor:'#06061a',fogNear:22,fogFar:65,
   ambient:[0xffffff,1.85],sun:[0xffffff,2.4],fill:[0x7799ff,1.0],starCol:0xffffff,colors:null,tex:null},
  {id:'mars',name:'화성',desc:'붉은 화성 · 먼지 구름 하늘',price:200,emoji:'🔴',pc:'p-cheap',
   bg:'#c47a45',fogColor:'#c06030',fogNear:14,fogFar:45,
   ambient:[0xffaa77,1.95],sun:[0xff7744,2.4],fill:[0x992200,1.0],starCol:0xff9966,
   colors:['#FF4500','#FF6347','#FF7F50','#E34234','#FF4444','#CC3300',
           '#FF5500','#DD2200','#FF8C00','#FF6600','#CD2626','#B22222',
           '#DC143C','#FF2400','#C0392B','#E74C3C','#FF3300','#FF4136'],tex:'mars'},
  {id:'earth',name:'지구',desc:'파란 지구 · 구름 하늘',price:200,emoji:'🌍',pc:'p-cheap',
   bg:'#1a6ab5',fogColor:'#4498d0',fogNear:18,fogFar:55,
   ambient:[0xbbddff,1.95],sun:[0xffffff,2.4],fill:[0x0066bb,1.1],starCol:0x88ffcc,
   colors:['#2E8B57','#3CB371','#006400','#1E90FF','#4169E1','#00CED1',
           '#228B22','#32CD32','#0000CD','#4682B4','#20B2AA','#66CDAA',
           '#5F9EA0','#008080','#2196F3','#4CAF50','#45B7D1','#1ABC9C'],tex:'earth'},
];

// ══════════════════════════════════════════════════
// PERSISTENCE
// ══════════════════════════════════════════════════
let coins=0, owned=new Set(['default']), activeSkin='default', progress=0;
let ownedMaps=new Set(['default']), activeMap='default';
let clearedLevels={};
let skinDates={}; // { skinId: timestamp }

function loadSave(){
  try{
    coins=parseInt(localStorage.getItem('e3_coins')||'0')||0;
    owned=new Set(JSON.parse(localStorage.getItem('e3_owned')||'["default"]'));
    activeSkin=localStorage.getItem('e3_skin')||'default';
    progress=parseInt(localStorage.getItem('e3_prog')||'0')||0;
    ownedMaps=new Set(JSON.parse(localStorage.getItem('e3_mown')||'["default"]'));
    activeMap=localStorage.getItem('e3_map')||'default';
    clearedLevels=JSON.parse(localStorage.getItem('e3_clv')||'{}');
    skinDates=JSON.parse(localStorage.getItem('e3_skin_dates')||'{}');
    // 기본 스킨 날짜 없으면 초기화
    if(!skinDates['default'])skinDates['default']=Date.now();
  }catch{}
}
function doSave(){
  try{
    localStorage.setItem('e3_coins',String(coins));
    localStorage.setItem('e3_owned',JSON.stringify([...owned]));
    localStorage.setItem('e3_skin',activeSkin);
    localStorage.setItem('e3_prog',String(progress));
    localStorage.setItem('e3_mown',JSON.stringify([...ownedMaps]));
    localStorage.setItem('e3_map',activeMap);
    localStorage.setItem('e3_clv',JSON.stringify(clearedLevels));
    localStorage.setItem('e3_skin_dates',JSON.stringify(skinDates));
  }catch{}
  if(_fbUser)fbCloudSave();
}
function recordSkinDate(id){if(!skinDates[id])skinDates[id]=Date.now();}
function reward(idx,liv,maxLiv){
  const b=idx<10?10+idx*9:95+(idx-9)*15;
  return b+Math.floor((liv/maxLiv)*b*0.5);
}

// ══════════════════════════════════════════════════
// THREE.JS
// ══════════════════════════════════════════════════
const canvas=document.getElementById('c');
const renderer=new THREE.WebGLRenderer({canvas,antialias:true,powerPreference:'high-performance'});
renderer.setPixelRatio(Math.min(devicePixelRatio,2.5));
renderer.setSize(innerWidth,innerHeight);
renderer.toneMapping=THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure=1.75;
renderer.outputColorSpace=THREE.SRGBColorSpace;
// 터치 이벤트 정상 처리를 위해 touch-action 명시
canvas.style.touchAction='none';

const _pmrem=new THREE.PMREMGenerator(renderer);
_pmrem.compileEquirectangularShader();
let _skinEnvMap=(()=>{
  const ec=document.createElement('canvas');ec.width=512;ec.height=256;
  const ectx=ec.getContext('2d');
  const eg=ectx.createLinearGradient(0,0,0,256);
  eg.addColorStop(0,'#112244');eg.addColorStop(0.35,'#5588bb');eg.addColorStop(0.65,'#aaccee');eg.addColorStop(1,'#334455');
  ectx.fillStyle=eg;ectx.fillRect(0,0,512,256);
  [[80,55,55],[256,40,70],[420,60,50],[160,180,40],[350,190,45]].forEach(([x,y,r])=>{
    const rg=ectx.createRadialGradient(x,y,0,x,y,r);
    rg.addColorStop(0,'rgba(255,255,255,0.92)');rg.addColorStop(0.5,'rgba(200,220,255,0.45)');rg.addColorStop(1,'rgba(0,0,0,0)');
    ectx.fillStyle=rg;ectx.beginPath();ectx.arc(x,y,r,0,Math.PI*2);ectx.fill();
  });
  const wg=ectx.createLinearGradient(0,180,0,256);
  wg.addColorStop(0,'rgba(255,200,100,0)');wg.addColorStop(1,'rgba(255,180,80,0.28)');
  ectx.fillStyle=wg;ectx.fillRect(0,180,512,76);
  const et=new THREE.CanvasTexture(ec);
  et.mapping=THREE.EquirectangularReflectionMapping;
  const envTex=_pmrem.fromEquirectangular(et).texture;
  _pmrem.dispose();et.dispose();
  return envTex;
})();

const scene=new THREE.Scene();
scene.background=new THREE.Color('#06061a');
scene.fog=new THREE.Fog('#06061a',22,65);
const camera=new THREE.PerspectiveCamera(50,innerWidth/innerHeight,0.1,100);
camera.position.set(2,3,9);
const controls=new OrbitControls(camera,canvas);
controls.enablePan=false;controls.minDistance=1;controls.maxDistance=18;
controls.dampingFactor=0.08;controls.enableDamping=true;
controls.autoRotate=false;
const ambLight=new THREE.AmbientLight(0xffffff,1.85);
const sunLight=new THREE.DirectionalLight(0xffffff,2.4);sunLight.position.set(8,12,8);
const fillLight=new THREE.DirectionalLight(0x7799ff,1.0);fillLight.position.set(-6,-4,-6);
const ptLight=new THREE.PointLight(0xffffff,2.2,40);ptLight.position.set(1,2,1);
scene.add(ambLight,sunLight,fillLight,ptLight);
const sg=new THREE.BufferGeometry();
const sv=[];for(let i=0;i<1800;i++)sv.push((Math.random()-.5)*130,(Math.random()-.5)*130,(Math.random()-.5)*130);
sg.setAttribute('position',new THREE.Float32BufferAttribute(sv,3));
const starsMesh=new THREE.Points(sg,new THREE.PointsMaterial({color:0xffffff,size:.12,sizeAttenuation:true}));
scene.add(starsMesh);
const rc=new THREE.Raycaster();
const pt2=new THREE.Vector2();

// ══════════════════════════════════════════════════
// PROCEDURAL TEXTURES
// ══════════════════════════════════════════════════
const _TC={};
function makeMoonTex(){if(_TC.moon)return _TC.moon;const c=document.createElement('canvas');c.width=c.height=256;const ctx=c.getContext('2d');const g=ctx.createRadialGradient(128,128,0,128,128,180);g.addColorStop(0,'#c2c2c2');g.addColorStop(1,'#787878');ctx.fillStyle=g;ctx.fillRect(0,0,256,256);for(let i=0;i<9000;i++){const x=Math.random()*256,y=Math.random()*256,v=Math.floor(Math.random()*75+88);ctx.fillStyle=`rgb(${v},${v},${v})`;ctx.fillRect(x,y,Math.ceil(Math.random()*3),Math.ceil(Math.random()*3));}for(let i=0;i<14;i++){const x=20+Math.random()*216,y=20+Math.random()*216,r=4+Math.random()*17;const grd=ctx.createRadialGradient(x,y,0,x,y,r);grd.addColorStop(0,'rgba(55,55,55,0.75)');grd.addColorStop(0.55,'rgba(95,95,95,0.45)');grd.addColorStop(1,'rgba(200,200,200,0)');ctx.fillStyle=grd;ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fill();}return(_TC.moon=new THREE.CanvasTexture(c));}
function makeStoneTex(){if(_TC.stone)return _TC.stone;const c=document.createElement('canvas');c.width=c.height=256;const ctx=c.getContext('2d');ctx.fillStyle='#7d6b5d';ctx.fillRect(0,0,256,256);for(let i=0;i<10000;i++){const x=Math.random()*256,y=Math.random()*256,b=Math.floor(Math.random()*60+75),r=Math.min(255,Math.floor(b*1.22)),g=Math.min(255,Math.floor(b*1.05));ctx.fillStyle=`rgb(${r},${g},${b})`;ctx.fillRect(x,y,Math.ceil(Math.random()*4),Math.ceil(Math.random()*4));}return(_TC.stone=new THREE.CanvasTexture(c));}
function makeMarsTex(){if(_TC.mars)return _TC.mars;const c=document.createElement('canvas');c.width=c.height=256;const ctx=c.getContext('2d');ctx.fillStyle='#a04020';ctx.fillRect(0,0,256,256);for(let i=0;i<12000;i++){const x=Math.random()*256,y=Math.random()*256;const v=Math.floor(Math.random()*60);const r=Math.min(255,140+v),g=Math.floor(50+v*0.4),b=Math.floor(15+v*0.2);ctx.fillStyle=`rgb(${r},${g},${b})`;ctx.fillRect(x,y,Math.ceil(Math.random()*3),Math.ceil(Math.random()*3));}return(_TC.mars=new THREE.CanvasTexture(c));}
function makeEarthTex(){if(_TC.earth)return _TC.earth;const c=document.createElement('canvas');c.width=c.height=256;const ctx=c.getContext('2d');ctx.fillStyle='#1a4fa0';ctx.fillRect(0,0,256,256);for(let i=0;i<8;i++){const x=Math.random()*256,y=Math.random()*256,w=20+Math.random()*60,h=15+Math.random()*40;const grd=ctx.createRadialGradient(x,y,0,x,y,Math.max(w,h));grd.addColorStop(0,'rgba(34,120,50,0.95)');grd.addColorStop(1,'rgba(10,80,30,0)');ctx.fillStyle=grd;ctx.save();ctx.translate(x,y);ctx.scale(w/Math.max(w,h),h/Math.max(w,h));ctx.translate(-x,-y);ctx.beginPath();ctx.arc(x,y,Math.max(w,h),0,Math.PI*2);ctx.fill();ctx.restore();}return(_TC.earth=new THREE.CanvasTexture(c));}
function getMapTex(mapId){const m=MAPS.find(x=>x.id===mapId);if(!m||!m.tex)return null;if(m.tex==='moon')return makeMoonTex();if(m.tex==='stone')return makeStoneTex();if(m.tex==='mars')return makeMarsTex();if(m.tex==='earth')return makeEarthTex();return null;}

// ══════════════════════════════════════════════════
// SKY DOMES
// ══════════════════════════════════════════════════
let _marsDome=null,_earthDome=null;
function makeMarsDome(){
  if(_marsDome)return _marsDome;
  const c=document.createElement('canvas');c.width=1024;c.height=512;
  const ctx=c.getContext('2d');
  const g=ctx.createLinearGradient(0,0,0,512);
  g.addColorStop(0,'#3d1205');g.addColorStop(0.25,'#7a2e0a');g.addColorStop(0.55,'#c1683a');g.addColorStop(0.78,'#d4855a');g.addColorStop(1,'#e8a472');
  ctx.fillStyle=g;ctx.fillRect(0,0,1024,512);
  for(let i=0;i<22;i++){const x=Math.random()*1100-50,y=80+Math.random()*280,rw=100+Math.random()*220,rh=25+Math.random()*55,alpha=0.18+Math.random()*0.28,r=Math.floor(90+Math.random()*40),gr=Math.floor(35+Math.random()*20),b=Math.floor(8+Math.random()*12);const cg=ctx.createRadialGradient(x,y,0,x,y,Math.max(rw,rh));cg.addColorStop(0,`rgba(${r},${gr},${b},${alpha})`);cg.addColorStop(1,'rgba(0,0,0,0)');ctx.fillStyle=cg;ctx.save();ctx.translate(x,y);ctx.scale(rw/Math.max(rw,rh),rh/Math.max(rw,rh));ctx.translate(-x,-y);ctx.beginPath();ctx.arc(x,y,Math.max(rw,rh),0,Math.PI*2);ctx.fill();ctx.restore();}
  const tex=new THREE.CanvasTexture(c);
  const geo=new THREE.SphereGeometry(58,48,24);
  const mat=new THREE.MeshBasicMaterial({map:tex,side:THREE.BackSide,depthWrite:false,fog:false});
  _marsDome=new THREE.Mesh(geo,mat);_marsDome.renderOrder=-1;return _marsDome;
}
function makeEarthDome(){
  if(_earthDome)return _earthDome;
  const c=document.createElement('canvas');c.width=1024;c.height=512;
  const ctx=c.getContext('2d');
  const g=ctx.createLinearGradient(0,0,0,512);
  g.addColorStop(0,'#0a2f6e');g.addColorStop(0.3,'#1462b8');g.addColorStop(0.62,'#3a9de4');g.addColorStop(0.82,'#7ac8f0');g.addColorStop(1,'#c8eaf8');
  ctx.fillStyle=g;ctx.fillRect(0,0,1024,512);
  function drawCloud(cx2,cy2,size){const puffs=[[0,0,size],[size*-0.55,size*0.25,size*0.72],[size*0.58,size*0.22,size*0.68],[size*0.0,size*0.45,size*0.5]];puffs.forEach(([px,py,r])=>{const cg=ctx.createRadialGradient(cx2+px,cy2+py,0,cx2+px,cy2+py,r);cg.addColorStop(0,'rgba(255,255,255,0.92)');cg.addColorStop(1,'rgba(255,255,255,0)');ctx.fillStyle=cg;ctx.beginPath();ctx.arc(cx2+px,cy2+py,r,0,Math.PI*2);ctx.fill();});}
  for(let i=0;i<18;i++){drawCloud(Math.random()*1100-50,160+Math.random()*210,28+Math.random()*58);}
  const tex=new THREE.CanvasTexture(c);
  const geo=new THREE.SphereGeometry(58,48,24);
  const mat=new THREE.MeshBasicMaterial({map:tex,side:THREE.BackSide,depthWrite:false,fog:false});
  _earthDome=new THREE.Mesh(geo,mat);_earthDome.renderOrder=-1;return _earthDome;
}

// ══════════════════════════════════════════════════
// APPLY MAP
// ══════════════════════════════════════════════════
function applyMap(mapId){
  const m=MAPS.find(x=>x.id===mapId)||MAPS[0];
  if(_marsDome&&_marsDome.parent)scene.remove(_marsDome);
  if(_earthDome&&_earthDome.parent)scene.remove(_earthDome);
  if(mapId==='mars'){scene.background.set('#c47a45');scene.add(makeMarsDome());starsMesh.visible=false;}
  else if(mapId==='earth'){scene.background.set('#1a6ab5');scene.add(makeEarthDome());starsMesh.visible=false;}
  else{scene.background.set(m.bg);starsMesh.visible=true;}
  scene.fog.color.set(m.fogColor);scene.fog.near=m.fogNear;scene.fog.far=m.fogFar;
  ambLight.color.set(m.ambient[0]);ambLight.intensity=m.ambient[1];
  sunLight.color.set(m.sun[0]);sunLight.intensity=m.sun[1];
  fillLight.color.set(m.fill[0]);fillLight.intensity=m.fill[1];
  starsMesh.material.color.set(m.starCol);
  activeMap=mapId;doSave();
}

// ══════════════════════════════════════════════════
// SKIN HELPERS
// ══════════════════════════════════════════════════
function skinDef(id){return SKINS.find(s=>s.id===id)||SKINS[0];}
function mkMat(col,sk,tex,em='#000',ei=0){
  const c=sk.fc||col;
  const isMetallic=(sk.m??0)>=0.88;
  const useEnv=isMetallic||sk.crystal;
  const emCol=sk.neon?col:(em!=='#000'?em:c);
  const emInt=sk.neon?1.8:(ei||0.55);
  const mat=new THREE.MeshStandardMaterial({
    color:c,emissive:emCol,emissiveIntensity:emInt,
    roughness:sk.r??0.38,metalness:sk.m??0.15,
    transparent:sk.tr||false,opacity:sk.op??1,
    side:sk.tr?THREE.DoubleSide:THREE.FrontSide,
    envMap:useEnv?_skinEnvMap:null,
    envMapIntensity:isMetallic?2.5:sk.crystal?1.8:0.8,
  });
  if(tex&&!isMetallic&&!sk.crystal){mat.roughnessMap=tex;mat.needsUpdate=true;}
  return mat;
}

// ══════════════════════════════════════════════════
// MESH FACTORIES — modern cute gem arrows
// ══════════════════════════════════════════════════
function buildArrow(col,sk,grp,tex){
  const baseMat=()=>mkMat(col,sk,tex);

  // Tapered shaft body (slightly wider at base)
  const body=new THREE.Mesh(new THREE.CylinderGeometry(BR*0.82,BR,BL,12),baseMat());
  body.position.y=-BL/2-HH*0.08;

  // Rounded bottom cap
  const bottomCap=new THREE.Mesh(new THREE.SphereGeometry(BR,12,7),baseMat());
  bottomCap.position.y=-BL-HH*0.08;

  // Decorative glowing collar ring where shaft meets head
  const collarMat=new THREE.MeshStandardMaterial({
    color:col,emissive:col,emissiveIntensity:0.8,
    roughness:0.1,metalness:0.6,transparent:false,opacity:1
  });
  const collar=new THREE.Mesh(new THREE.TorusGeometry(HR*0.55,BR*1.3,8,24),collarMat);
  collar.rotation.x=Math.PI/2;
  collar.position.y=-HH*0.06;

  // Gem/diamond shaped head — elongated octahedron
  const headGeo=new THREE.OctahedronGeometry(HR*0.82,0);
  // Stretch it to be more pointy and elegant
  headGeo.applyMatrix4(new THREE.Matrix4().makeScale(0.9,1.75,0.9));
  const head=new THREE.Mesh(headGeo,baseMat());
  head.position.y=HH*0.52;

  // Cute bright sparkle sphere at the very tip
  const tipMat=new THREE.MeshStandardMaterial({
    color:'#ffffff',emissive:'#ffffff',emissiveIntensity:1.5,
    roughness:0.02,metalness:0.6,transparent:false,opacity:1,
    envMap:_skinEnvMap,envMapIntensity:1.8
  });
  const tip=new THREE.Mesh(new THREE.SphereGeometry(BR*1.6,10,8),tipMat);
  tip.position.y=HH*0.52+HR*0.82*1.75;

  // Small decorative side fins at head base
  const finMat=new THREE.MeshStandardMaterial({
    color:col,emissive:col,emissiveIntensity:0.6,roughness:0.2,metalness:0.3,
    transparent:false,opacity:1,side:THREE.DoubleSide
  });
  const finGeo=new THREE.ConeGeometry(HR*0.42,HH*0.28,3);
  const finL=new THREE.Mesh(finGeo,finMat);finL.position.set(-HR*0.6,HH*0.1,0);finL.rotation.z=Math.PI*0.5;
  const finR=new THREE.Mesh(finGeo,finMat);finR.position.set(HR*0.6,HH*0.1,0);finR.rotation.z=-Math.PI*0.5;
  const finF=new THREE.Mesh(finGeo,finMat);finF.position.set(0,HH*0.1,HR*0.6);finF.rotation.x=-Math.PI*0.5;
  const finB=new THREE.Mesh(finGeo,finMat);finB.position.set(0,HH*0.1,-HR*0.6);finB.rotation.x=Math.PI*0.5;

  // 투명 히트박스 — 시각적으로 안 보이지만 레이캐스팅 범위를 10배 확장해 터치 인식 향상
  const hitMat=new THREE.MeshBasicMaterial({transparent:true,opacity:0,depthWrite:false});
  const hitMesh=new THREE.Mesh(new THREE.CylinderGeometry(0.13,0.13,0.72,6),hitMat);
  hitMesh.position.y=(-BL*0.5+HH*0.25);
  grp.add(hitMesh); // arrowId는 부모(root) 체인으로 hitTest에서 탐색됨

  grp.add(body,bottomCap,collar,head,tip,finL,finR,finF,finB);
  return[body,bottomCap,collar,head,tip,finL,finR,finF,finB];
}

function buildCar(col,sk,grp){
  const c=sk.fc||col;
  const isMetallic=(sk.m??0)>=0.88;
  const useEnv=isMetallic||sk.crystal;
  const emCol=sk.neon?col:'#000';
  const emInt=sk.neon?1.4:0;
  const mat=(hex,r=0.8,m=0.1,useSkColor=false)=>{
    const mc=useSkColor?c:hex;
    return new THREE.MeshStandardMaterial({
      color:mc,roughness:useSkColor?(sk.r??r):r,metalness:useSkColor?(sk.m??m):m,
      emissive:useSkColor?emCol:'#000',emissiveIntensity:useSkColor?emInt:0,
      transparent:useSkColor?(sk.tr||false):false,opacity:useSkColor?(sk.op??1):1,
      envMap:useSkColor&&useEnv?_skinEnvMap:null,
      envMapIntensity:useSkColor&&isMetallic?2.2:useSkColor&&sk.crystal?1.4:0,
    });
  };
  const body=new THREE.Mesh(new THREE.BoxGeometry(0.38,0.55,0.18),mat(c,0.8,0.1,true));
  const cabin=new THREE.Mesh(new THREE.BoxGeometry(0.32,0.24,0.17),mat(c,0.8,0.1,true));cabin.position.set(0,0.05,0.175);
  const ws=new THREE.Mesh(new THREE.BoxGeometry(0.26,0.2,0.02),mat('#1a3355',0.1,0.1));ws.position.set(0,0.09,0.265);
  const grille=new THREE.Mesh(new THREE.BoxGeometry(0.3,0.06,0.12),mat('#111',0.9,0));grille.position.set(0,0.29,0);
  const hlg=new THREE.BoxGeometry(0.07,0.04,0.06),hlm=mat('#ffffaa',0.3,0.1);
  [[-0.13,0.28,0.07],[0.13,0.28,0.07]].forEach(([x,y,z])=>{const h=new THREE.Mesh(hlg,hlm);h.position.set(x,y,z);grp.add(h);});
  const wg=new THREE.CylinderGeometry(0.09,0.09,0.07,8),wm=mat('#111',0.9,0);
  const wheels=[[-0.22,0.18,-0.04],[0.22,0.18,-0.04],[-0.22,-0.18,-0.04],[0.22,-0.18,-0.04]].map(([x,y,z])=>{const w=new THREE.Mesh(wg,wm);w.rotation.z=Math.PI/2;w.position.set(x,y,z);grp.add(w);return w;});
  grp.add(body,cabin,ws,grille);return[body,cabin,ws,grille,...wheels];
}

// ── Rocket ────────────────────────────────────────
function buildRocket(col,sk,grp){
  const bm=()=>mkMat(col,sk,null);
  // Main body cylinder
  const body=new THREE.Mesh(new THREE.CylinderGeometry(BR*1.6,BR*1.8,BL*1.1,10),bm());
  body.position.y=-BL*0.1;
  // Nose cone
  const nose=new THREE.Mesh(new THREE.ConeGeometry(BR*1.6,HH*1.2,10),bm());
  nose.position.y=BL*0.55+HH*0.6;
  // Nose tip sparkle
  const tipMat=new THREE.MeshStandardMaterial({color:'#fff',emissive:col,emissiveIntensity:1.3,roughness:0.05,metalness:0.5,transparent:false,opacity:1,envMap:_skinEnvMap,envMapIntensity:1.5});
  const tip=new THREE.Mesh(new THREE.SphereGeometry(BR*1.0,8,6),tipMat);
  tip.position.y=BL*0.55+HH*1.2;
  // 4 fins at base
  const finMat=new THREE.MeshStandardMaterial({color:col,emissive:col,emissiveIntensity:0.4,roughness:0.5,metalness:0.2,side:THREE.DoubleSide});
  const finGeo=new THREE.ConeGeometry(BR*2.8,BL*0.55,3,1,false,0,Math.PI*2);
  const fins=[[0,0,1],[0,0,-1],[1,0,0],[-1,0,0]].map(([x,,z])=>{
    const f=new THREE.Mesh(new THREE.BoxGeometry(BR*0.3,BL*0.45,BR*2.8),finMat.clone());
    f.position.set(x*BR*2,BL*-0.38,z*BR*2);
    if(x!==0)f.rotation.y=Math.PI/2;
    grp.add(f);return f;
  });
  // Engine nozzle
  const nozzle=new THREE.Mesh(new THREE.CylinderGeometry(BR*2.2,BR*1.4,BR*2,10),bm());
  nozzle.position.y=-BL*0.65;
  // Engine glow
  const glowMat=new THREE.MeshStandardMaterial({color:'#ff6600',emissive:'#ff4400',emissiveIntensity:2.0,roughness:1,transparent:false,opacity:1});
  const glow=new THREE.Mesh(new THREE.SphereGeometry(BR*1.6,8,6),glowMat);
  glow.position.y=-BL*0.78;
  // Window
  const winMat=new THREE.MeshStandardMaterial({color:'#88ccff',emissive:'#4499ff',emissiveIntensity:0.7,roughness:0.1,metalness:0.3,transparent:false,opacity:1});
  const win=new THREE.Mesh(new THREE.SphereGeometry(BR*0.9,8,6),winMat);
  win.position.y=BL*0.12;win.position.z=BR*1.7;
  grp.add(body,nose,tip,nozzle,glow,win,...fins);
  return[body,nose,tip,nozzle,glow,win,...fins];
}

// ── Star ──────────────────────────────────────────
function buildStar(col,sk,grp){
  const bm=()=>mkMat(col,sk,null);
  // Hexagonal body shaft
  const body=new THREE.Mesh(new THREE.CylinderGeometry(BR*0.7,BR*0.9,BL,6),bm());
  body.position.y=-BL/2-0.04;
  // Bottom cap
  const cap=new THREE.Mesh(new THREE.SphereGeometry(BR*0.9,8,6),bm());
  cap.position.y=-BL-0.04;
  // 5-pointed star head: central hub + 5 spikes
  const hub=new THREE.Mesh(new THREE.SphereGeometry(HR*0.42,10,8),bm());
  hub.position.y=HH*0.45;
  const spikeMat=()=>mkMat(col,sk,null);
  for(let i=0;i<5;i++){
    const angle=(i/5)*Math.PI*2-Math.PI/2;
    const px=Math.cos(angle)*HR*0.6, pz=Math.sin(angle)*HR*0.6;
    const spike=new THREE.Mesh(new THREE.ConeGeometry(BR*1.0,HH*0.75,6),spikeMat());
    spike.position.set(px,HH*0.45,pz);
    // Rotate to point outward
    const dir=new THREE.Vector3(px,0,pz).normalize();
    spike.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),dir);
    grp.add(spike);
  }
  // Top center spike (pointing forward)
  const topSpike=new THREE.Mesh(new THREE.ConeGeometry(BR*1.1,HH*0.9,6),bm());
  topSpike.position.y=HH*0.9;
  // Center sparkle
  const sparkMat=new THREE.MeshStandardMaterial({color:'#fff',emissive:col,emissiveIntensity:1.6,roughness:0.05,metalness:0.4,transparent:false,opacity:1,envMap:_skinEnvMap,envMapIntensity:1.8});
  const spark=new THREE.Mesh(new THREE.OctahedronGeometry(BR*1.6,0),sparkMat);
  spark.position.y=HH*0.45;
  grp.add(body,cap,hub,topSpike,spark);
  return[body,cap,hub,topSpike,spark];
}

// ── Sword ─────────────────────────────────────────
function buildSword(col,sk,grp){
  const bm=()=>mkMat(col,sk,null);
  const bladeMat=new THREE.MeshStandardMaterial({color:'#d0e8ff',emissive:'#88aaff',emissiveIntensity:0.45,roughness:0.08,metalness:0.95,envMap:_skinEnvMap,envMapIntensity:2.5});
  // Blade: very thin flat rectangle, elongated
  const blade=new THREE.Mesh(new THREE.BoxGeometry(BR*1.4,BL*1.4,BR*0.3),bladeMat.clone());
  blade.position.y=BL*0.15;
  // Blade tip (tapered)
  const tipGeo=new THREE.CylinderGeometry(0,BR*0.7,HH*0.8,4);
  const tip=new THREE.Mesh(tipGeo,bladeMat.clone());
  tip.position.y=BL*0.88;tip.rotation.y=Math.PI/4;
  // Guard (crossguard)
  const guardMat=bm();
  const guard=new THREE.Mesh(new THREE.BoxGeometry(HR*2.4,BR*1.4,BR*1.4),guardMat);
  guard.position.y=-BL*0.55;
  // Handle
  const handle=new THREE.Mesh(new THREE.CylinderGeometry(BR*0.9,BR*1.1,BL*0.52,8),bm());
  handle.position.y=-BL*0.93;
  // Pommel (round bottom)
  const pommelMat=new THREE.MeshStandardMaterial({color:col,emissive:col,emissiveIntensity:0.6,roughness:0.2,metalness:0.7,envMap:_skinEnvMap,envMapIntensity:1.6});
  const pommel=new THREE.Mesh(new THREE.SphereGeometry(BR*1.5,10,8),pommelMat);
  pommel.position.y=-BL*1.22;
  // Gem in guard
  const gemMat=new THREE.MeshStandardMaterial({color:col,emissive:col,emissiveIntensity:1.1,roughness:0.0,metalness:0.1,transparent:false,opacity:1,envMap:_skinEnvMap,envMapIntensity:2});
  const gem=new THREE.Mesh(new THREE.OctahedronGeometry(BR*1.1,0),gemMat);
  gem.position.y=-BL*0.55;
  grp.add(blade,tip,guard,handle,pommel,gem);
  return[blade,tip,guard,handle,pommel,gem];
}

// ── Mushroom ──────────────────────────────────────
function buildMushroom(col,sk,grp){
  const bm=()=>mkMat(col,sk,null);
  // Stem: short cylinder
  const stemMat=new THREE.MeshStandardMaterial({color:'#fff5e0',emissive:'#fff0cc',emissiveIntensity:0.15,roughness:0.85,metalness:0.0});
  const stem=new THREE.Mesh(new THREE.CylinderGeometry(BR*1.1,BR*1.4,BL*0.85,10),stemMat);
  stem.position.y=-BL*0.05;
  // Bottom cap
  const bottomCap=new THREE.Mesh(new THREE.SphereGeometry(BR*1.4,10,6),stemMat);
  bottomCap.position.y=-BL*0.48;
  // Cap (flattened sphere) - big mushroom cap
  const capMat=bm();
  const capGeo=new THREE.SphereGeometry(HH*1.05,14,9);
  capGeo.applyMatrix4(new THREE.Matrix4().makeScale(1,0.6,1));
  const cap=new THREE.Mesh(capGeo,capMat);
  cap.position.y=BL*0.42;
  // Spots on cap
  const spotMat=new THREE.MeshStandardMaterial({color:'#ffffff',emissive:'#ffffff',emissiveIntensity:0.5,roughness:0.8,metalness:0});
  [[0,0],[0.55,0.4],[-0.5,0.3],[0.2,-0.45],[-0.25,-0.35],[0.5,-0.15]].forEach(([sx,sz])=>{
    if(typeof sx!=='number')return;
    const spot=new THREE.Mesh(new THREE.SphereGeometry(BR*0.65,6,5),spotMat.clone());
    spot.position.set(sx*HH*0.85,BL*0.55,sz*HH*0.85);
    grp.add(spot);
  });
  // Top sparkle
  const sparkMat=new THREE.MeshStandardMaterial({color:'#fff',emissive:col,emissiveIntensity:1.2,roughness:0.05,transparent:false,opacity:1});
  const spark=new THREE.Mesh(new THREE.SphereGeometry(BR*1.3,8,6),sparkMat);
  spark.position.y=BL*0.7;
  grp.add(stem,bottomCap,cap,spark);
  return[stem,bottomCap,cap,spark];
}

// ── Crystal Shard ─────────────────────────────────
function buildCrystal2(col,sk,grp){
  const bm=()=>mkMat(col,sk,null);
  // Main large shard: tall thin octahedron
  const mainGeo=new THREE.OctahedronGeometry(HR*0.7,0);
  mainGeo.applyMatrix4(new THREE.Matrix4().makeScale(0.6,2.8,0.6));
  const mainShard=new THREE.Mesh(mainGeo,new THREE.MeshStandardMaterial({color:col,emissive:'#000',emissiveIntensity:0,roughness:0.0,metalness:0.1,transparent:false,opacity:1,envMap:_skinEnvMap,envMapIntensity:2.4,side:THREE.DoubleSide}));
  mainShard.position.y=HH*0.25;
  // 2 side shards
  [[-1,0.65],[1,-0.55]].forEach(([sign,yOff])=>{
    const sg=new THREE.OctahedronGeometry(HR*0.42,0);
    sg.applyMatrix4(new THREE.Matrix4().makeScale(0.5,2.0,0.5));
    const s=new THREE.Mesh(sg,new THREE.MeshStandardMaterial({color:col,emissive:col,emissiveIntensity:0.5,roughness:0.0,metalness:0.1,transparent:false,opacity:1,envMap:_skinEnvMap,envMapIntensity:2,side:THREE.DoubleSide}));
    s.position.set(sign*HR*0.75,yOff*HH,0);
    s.rotation.z=sign*0.35;
    grp.add(s);
  });
  // Glowing core
  const coreMat=new THREE.MeshStandardMaterial({color:'#ffffff',emissive:col,emissiveIntensity:2.2,roughness:0,transparent:false,opacity:1});
  const core=new THREE.Mesh(new THREE.SphereGeometry(BR*1.2,8,6),coreMat);
  core.position.y=HH*0.3;
  grp.add(mainShard,core);
  return[mainShard,core];
}

// ══════════════════════════════════════════════════
// ARROW POOL
// ══════════════════════════════════════════════════
let arrows=[],arrowMap={};

// ══════════════════════════════════════════════════
// 테마 스킨 MESH 팩토리
// ══════════════════════════════════════════════════

// 🔥 불꽃 — 겹겹이 쌓인 반투명 불꽃 혀
function buildFlame(col,sk,grp){
  const fc='#FF4500';
  const body=new THREE.Mesh(
    new THREE.CylinderGeometry(BR*0.5,BR*0.9,BL*0.8,8),
    new THREE.MeshStandardMaterial({color:'#FF6600',emissive:'#FF3300',emissiveIntensity:1.8,roughness:1,metalness:0,transparent:false,opacity:1})
  );
  body.position.y=-BL*0.4;grp.add(body);
  const parts=[body];
  // 불꽃 혀 (크기·각도 다른 원뿔 4개)
  const tongues=[
    {h:BL*1.1,r:HR*0.7,col:'#FF6600',em:'#FF4400',op:1,rx:0,    rz:0,     py:HH*0.3},
    {h:BL*0.95,r:HR*0.55,col:'#FF8800',em:'#FF5500',op:1,rx:0.22,rz:0.15,  py:HH*0.25},
    {h:BL*0.85,r:HR*0.45,col:'#FFAA00',em:'#FF8800',op:1,rx:-0.18,rz:-0.12,py:HH*0.2},
    {h:BL*0.6, r:HR*0.28,col:'#FFD700',em:'#FFBB00',op:1,rx:0,  rz:0,     py:HH*0.7},
  ];
  tongues.forEach(t=>{
    const m=new THREE.Mesh(
      new THREE.ConeGeometry(t.r,t.h,7),
      new THREE.MeshStandardMaterial({color:t.col,emissive:t.em,emissiveIntensity:2.2,roughness:1,metalness:0,transparent:false,opacity:1,side:THREE.DoubleSide})
    );
    m.position.y=t.py;m.rotation.x=t.rx;m.rotation.z=t.rz;
    grp.add(m);parts.push(m);
  });
  // 뜨거운 코어 구
  const core=new THREE.Mesh(
    new THREE.SphereGeometry(BR*2.2,8,6),
    new THREE.MeshStandardMaterial({color:'#FFFFFF',emissive:'#FF6600',emissiveIntensity:3,roughness:1,transparent:false,opacity:1})
  );
  core.position.y=HH*0.9;grp.add(core);parts.push(core);
  return parts;
}

// ❄️ 얼음 — 고드름 + 크리스탈 파편
function buildIce(col,sk,grp){
  const ic='#C8F4FF',ie=0.6;
  const iceMat=()=>new THREE.MeshStandardMaterial({
    color:ic,emissive:'#88CCFF',emissiveIntensity:ie,
    roughness:0,metalness:0.1,transparent:false,opacity:1,
    envMap:_skinEnvMap,envMapIntensity:2,side:THREE.DoubleSide
  });
  // 메인 고드름 (긴 원뿔)
  const icicle=new THREE.Mesh(new THREE.ConeGeometry(HR*0.6,BL*1.6,6),iceMat());
  icicle.position.y=HH*0.35;grp.add(icicle);
  // 주변 파편 3개
  const frags=[{s:0.55,y:HH*0.1,x:-HR*0.8,rz:0.4},{s:0.45,y:-HH*0.1,x:HR*0.75,rz:-0.35},{s:0.38,y:HH*0.3,x:0,z:HR*0.7,rz:0.2}];
  frags.forEach(f=>{
    const geo=new THREE.OctahedronGeometry(HR*f.s,0);
    geo.applyMatrix4(new THREE.Matrix4().makeScale(0.55,2.1,0.55));
    const m=new THREE.Mesh(geo,iceMat());
    m.position.set(f.x||0,f.y,f.z||0);m.rotation.z=f.rz||0;
    grp.add(m);
  });
  // 서리 구
  const frost=new THREE.Mesh(
    new THREE.SphereGeometry(BR*2.4,8,6),
    new THREE.MeshStandardMaterial({color:'#EEFAFF',emissive:'#AADDFF',emissiveIntensity:1.2,roughness:0,transparent:false,opacity:1,envMap:_skinEnvMap,envMapIntensity:1.5})
  );
  frost.position.y=-BL*0.65;grp.add(frost);
  return[icicle,frost];
}

// ⚡ 번개 — 지그재그 볼트
function buildThunder(col,sk,grp){
  const bm=()=>new THREE.MeshStandardMaterial({color:'#FFE600',emissive:'#FFE600',emissiveIntensity:2.5,roughness:1,metalness:0});
  const parts=[];
  // 볼트 세그먼트 (5개, 지그재그)
  const segs=[
    {y:-BL*0.7,rx:0.38, rz:0.22, len:BL*0.42},
    {y:-BL*0.28,rx:-0.32,rz:-0.18,len:BL*0.38},
    {y:HH*0.05,rx:0.28, rz:0.14, len:BL*0.36},
    {y:HH*0.42,rx:-0.22,rz:-0.10,len:BL*0.3},
    {y:HH*0.72,rx:0.15, rz:0.08, len:BL*0.25},
  ];
  segs.forEach(s=>{
    const m=new THREE.Mesh(
      new THREE.CylinderGeometry(BR*2.2,BR*2.8,s.len,5),bm()
    );
    m.position.y=s.y;m.rotation.x=s.rx;m.rotation.z=s.rz;
    grp.add(m);parts.push(m);
  });
  // 번쩍이는 팁
  const tip=new THREE.Mesh(
    new THREE.SphereGeometry(HR*0.45,8,6),
    new THREE.MeshStandardMaterial({color:'#FFFFFF',emissive:'#FFE600',emissiveIntensity:4,roughness:1,transparent:false,opacity:1})
  );
  tip.position.y=HH*1.0;grp.add(tip);parts.push(tip);
  // 전기 링 2개
  [0.55,0.25].forEach((py,i)=>{
    const ring=new THREE.Mesh(
      new THREE.TorusGeometry(HR*(0.55-i*0.12),BR*1.5,5,16),
      new THREE.MeshStandardMaterial({color:'#FFE600',emissive:'#FFE600',emissiveIntensity:3,roughness:1,metalness:0,transparent:false,opacity:1})
    );
    ring.position.y=HH*py;ring.rotation.x=Math.PI/2;
    grp.add(ring);parts.push(ring);
  });
  return parts;
}

// 🐉 드래곤 — 뱀처럼 구불구불한 몸통 + 날개
function buildDragon(col,sk,grp){
  const parts=[];
  const scaleM=()=>new THREE.MeshStandardMaterial({color:'#1E6B3A',emissive:'#0D3B1E',emissiveIntensity:0.4,roughness:0.4,metalness:0.55,envMap:_skinEnvMap,envMapIntensity:1.2});
  const goldM=()=>new THREE.MeshStandardMaterial({color:'#FFD700',emissive:'#CC8800',emissiveIntensity:0.9,roughness:0.2,metalness:0.85,envMap:_skinEnvMap,envMapIntensity:2});
  const redM=()=>new THREE.MeshStandardMaterial({color:'#CC0000',emissive:'#880000',emissiveIntensity:0.7,roughness:0.5,metalness:0.3});
  // 몸통 세그먼트 (구체 5개 이어진 뱀)
  const bodyPos=[
    {y:-BL*0.68,r:BR*3.0},{y:-BL*0.35,r:BR*3.6},{y:HH*0.05,r:BR*3.2},
    {y:HH*0.45,r:BR*2.5},{y:HH*0.82,r:BR*1.8}
  ];
  bodyPos.forEach(b=>{
    const m=new THREE.Mesh(new THREE.SphereGeometry(b.r,10,8),scaleM());
    m.position.y=b.y;grp.add(m);parts.push(m);
  });
  // 머리
  const head=new THREE.Mesh(new THREE.SphereGeometry(HR*0.65,10,8),scaleM());
  head.scale.y=1.4;head.position.y=HH*1.15;grp.add(head);parts.push(head);
  // 뿔 2개
  [-1,1].forEach(s=>{
    const horn=new THREE.Mesh(new THREE.ConeGeometry(BR*1.4,HH*0.55,5),goldM());
    horn.position.set(s*HR*0.38,HH*1.55,0);horn.rotation.z=s*0.4;
    grp.add(horn);parts.push(horn);
  });
  // 날개 2개 (납작 원뿔)
  [-1,1].forEach(s=>{
    const wingGeo=new THREE.ConeGeometry(HR*1.1,HH*0.9,4);
    wingGeo.applyMatrix4(new THREE.Matrix4().makeScale(1,0.35,1));
    const wing=new THREE.Mesh(wingGeo,new THREE.MeshStandardMaterial({
      color:'#0A4020',emissive:'#081808',emissiveIntensity:0.3,roughness:0.6,metalness:0.2,
      transparent:false,opacity:1,side:THREE.DoubleSide
    }));
    wing.position.set(s*HR*1.2,HH*0.4,0);wing.rotation.z=s*1.1;
    grp.add(wing);parts.push(wing);
  });
  // 황금 눈
  [-1,1].forEach(s=>{
    const eye=new THREE.Mesh(new THREE.SphereGeometry(BR*1.2,6,4),
      new THREE.MeshStandardMaterial({color:'#FFD700',emissive:'#FFAA00',emissiveIntensity:2.5,roughness:0}));
    eye.position.set(s*HR*0.28,HH*1.22,HR*0.48);
    grp.add(eye);parts.push(eye);
  });
  return parts;
}

// 🌈 무지개 — 7색 고리가 쌓인 아치
function buildRainbow(col,sk,grp){
  const RCOLS=['#FF0000','#FF7700','#FFEE00','#00CC44','#0088FF','#6600FF','#FF00CC'];
  const parts=[];
  // 중심 흰 기둥
  const stem=new THREE.Mesh(
    new THREE.CylinderGeometry(BR*0.9,BR*1.1,BL*1.1,8),
    new THREE.MeshStandardMaterial({color:'#FFFFFF',emissive:'#FFFFFF',emissiveIntensity:0.8,roughness:1,metalness:0,transparent:false,opacity:1})
  );
  stem.position.y=-BL*0.28;grp.add(stem);parts.push(stem);
  // 7색 링
  RCOLS.forEach((c,i)=>{
    const ring=new THREE.Mesh(
      new THREE.TorusGeometry(HR*(0.38+i*0.11),BR*(2.0-i*0.15),5,20),
      new THREE.MeshStandardMaterial({color:c,emissive:c,emissiveIntensity:2.0,roughness:1,metalness:0,transparent:false,opacity:1-i*0.04})
    );
    ring.position.y=HH*(0.7-i*0.18);ring.rotation.x=Math.PI/2;
    grp.add(ring);parts.push(ring);
  });
  // 반짝이 팁
  const tip=new THREE.Mesh(
    new THREE.OctahedronGeometry(HR*0.55,0),
    new THREE.MeshStandardMaterial({color:'#FFFFFF',emissive:'#FFFFFF',emissiveIntensity:3,roughness:0,transparent:false,opacity:1,envMap:_skinEnvMap,envMapIntensity:2})
  );
  tip.position.y=HH*1.1;grp.add(tip);parts.push(tip);
  return parts;
}

// 👻 유령 — 반투명 둥근 머리 + 물결 치마
function buildGhost(col,sk,grp){
  const gm=()=>new THREE.MeshStandardMaterial({
    color:'#D8E4FF',emissive:'#8899CC',emissiveIntensity:0.7,
    roughness:0.3,metalness:0,transparent:false,opacity:1,side:THREE.DoubleSide
  });
  const parts=[];
  // 치마 (아래 물결 구체들)
  const skirtPos=[
    {x:0,z:0,y:-BL*0.75,r:BR*4.5},
    {x:-HR*0.6,z:0,y:-BL*0.52,r:BR*3.5},
    {x:HR*0.6,z:0,y:-BL*0.52,r:BR*3.5},
    {x:0,z:-HR*0.6,y:-BL*0.52,r:BR*3.2},
    {x:0,z:HR*0.6,y:-BL*0.52,r:BR*3.2},
  ];
  skirtPos.forEach(p=>{
    const m=new THREE.Mesh(new THREE.SphereGeometry(p.r,8,6),gm());
    m.position.set(p.x,p.y,p.z);grp.add(m);parts.push(m);
  });
  // 몸통
  const body=new THREE.Mesh(new THREE.SphereGeometry(HR*0.62,10,8),gm());
  body.scale.y=1.6;body.position.y=HH*0.18;grp.add(body);parts.push(body);
  // 머리
  const head=new THREE.Mesh(new THREE.SphereGeometry(HR*0.52,10,8),gm());
  head.position.y=HH*0.92;grp.add(head);parts.push(head);
  // 눈 2개
  [-1,1].forEach(s=>{
    const eye=new THREE.Mesh(new THREE.SphereGeometry(BR*1.8,6,4),
      new THREE.MeshStandardMaterial({color:'#001133',emissive:'#002266',emissiveIntensity:1.5,roughness:0,transparent:false,opacity:1}));
    eye.position.set(s*HR*0.2,HH*0.98,HR*0.42);grp.add(eye);parts.push(eye);
  });
  // 유령 글로우 헤일로
  const halo=new THREE.Mesh(
    new THREE.SphereGeometry(HR*0.68,8,6),
    new THREE.MeshStandardMaterial({color:'#AABBFF',emissive:'#7788FF',emissiveIntensity:1.5,roughness:1,transparent:false,opacity:1})
  );
  halo.scale.set(1.6,1.6,1.6);halo.position.y=HH*0.92;grp.add(halo);parts.push(halo);
  return parts;
}

// 🌋 용암 — 어두운 바위 + 글로잉 크랙
function buildLava(col,sk,grp){
  const rockM=()=>new THREE.MeshStandardMaterial({color:'#1A1A1A',emissive:'#000000',emissiveIntensity:0,roughness:0.98,metalness:0.08});
  const glowM=()=>new THREE.MeshStandardMaterial({color:'#FF4500',emissive:'#FF3300',emissiveIntensity:2.8,roughness:1,metalness:0,transparent:false,opacity:1});
  const parts=[];
  // 바위 몸통 (이코사헤드론 - 울퉁불퉁)
  const rock=new THREE.Mesh(new THREE.IcosahedronGeometry(HR*0.78,0),rockM());
  rock.scale.y=2.2;rock.position.y=HH*0.12;grp.add(rock);parts.push(rock);
  // 아래 무거운 베이스
  const base=new THREE.Mesh(new THREE.CylinderGeometry(HR*0.65,HR*0.85,BL*0.5,6),rockM());
  base.position.y=-BL*0.48;grp.add(base);parts.push(base);
  // 균열 (얇은 박스 세그먼트)
  const crackDefs=[
    {px:0,pz:0,py:HH*0.2,rx:0.55,rz:0.3,w:BR*1.2,h:HH*0.7},
    {px:HR*0.3,pz:0,py:HH*0.0,rx:-0.3,rz:0.6,w:BR*0.9,h:HH*0.55},
    {px:-HR*0.25,pz:HR*0.2,py:HH*0.35,rx:0.2,rz:-0.45,w:BR*0.8,h:HH*0.45},
  ];
  crackDefs.forEach(c=>{
    const m=new THREE.Mesh(new THREE.BoxGeometry(c.w,c.h,BR*0.6),glowM());
    m.position.set(c.px,c.py,c.pz);m.rotation.x=c.rx;m.rotation.z=c.rz;
    grp.add(m);parts.push(m);
  });
  // 녹아내리는 용암 팁
  const tip=new THREE.Mesh(
    new THREE.SphereGeometry(HR*0.42,8,6),
    new THREE.MeshStandardMaterial({color:'#FF6600',emissive:'#FF4400',emissiveIntensity:3.5,roughness:1,transparent:false,opacity:1})
  );
  tip.position.y=HH*1.05;grp.add(tip);parts.push(tip);
  // 용암 방울 (아래)
  [[-HR*0.3,-BL*0.3],[HR*0.28,-BL*0.45],[0,-BL*0.18]].forEach(([x,y])=>{
    const d=new THREE.Mesh(new THREE.SphereGeometry(BR*2.5,6,4),glowM());
    d.position.set(x,y,0);grp.add(d);parts.push(d);
  });
  return parts;
}

// 🌟 코스믹 — 우주 에너지 코어 + 오비탈 링
function buildCosmic(col,sk,grp){
  const parts=[];
  const deepM=()=>new THREE.MeshStandardMaterial({
    color:'#080028',emissive:'#2020AA',emissiveIntensity:0.5,
    roughness:0,metalness:0.2,transparent:false,opacity:1,
    envMap:_skinEnvMap,envMapIntensity:1.6
  });
  const glowM=(c,ei=2)=>new THREE.MeshStandardMaterial({color:c,emissive:c,emissiveIntensity:ei,roughness:0,transparent:false,opacity:1,envMap:_skinEnvMap,envMapIntensity:2});
  // 슬림 본체
  const body=new THREE.Mesh(new THREE.CylinderGeometry(BR*0.6,BR*0.9,BL*1.1,8),deepM());
  body.position.y=-BL*0.35;grp.add(body);parts.push(body);
  // 코어 에너지 구
  const core=new THREE.Mesh(
    new THREE.SphereGeometry(HR*0.48,10,8),
    new THREE.MeshStandardMaterial({color:'#FFFFFF',emissive:'#8080FF',emissiveIntensity:3.5,roughness:0,transparent:false,opacity:1,envMap:_skinEnvMap,envMapIntensity:2.5})
  );
  core.position.y=HH*0.35;grp.add(core);parts.push(core);
  // 오비탈 링 3개 (다른 각도)
  const ringCols=['#4444FF','#AA44FF','#44AAFF'];
  ringCols.forEach((rc,i)=>{
    const ring=new THREE.Mesh(
      new THREE.TorusGeometry(HR*(0.62+i*0.12),BR*1.4,5,24),
      glowM(rc,1.8)
    );
    ring.position.y=HH*(0.35+i*0.04);
    ring.rotation.x=(i===0?0:i===1?Math.PI/3:Math.PI*0.7);
    ring.rotation.z=i*0.6;
    grp.add(ring);parts.push(ring);
  });
  // 별 파편 (작은 팔면체들)
  [[HR*0.7,HH*0.6,0],[- HR*0.65,HH*0.15,0],[0,HH*0.8,HR*0.5],[HR*0.35,-BL*0.2,HR*0.4]].forEach(([x,y,z])=>{
    const star=new THREE.Mesh(new THREE.OctahedronGeometry(BR*2.2,0),
      glowM(['#FFD700','#AAFFFF','#FF88FF','#AAFFAA'][Math.round(Math.random()*3)],2.5));
    star.position.set(x,y,z);star.rotation.x=Math.random()*Math.PI;star.rotation.z=Math.random()*Math.PI;
    grp.add(star);parts.push(star);
  });
  // 테일 파티클 (하단)
  const tail=new THREE.Mesh(new THREE.ConeGeometry(HR*0.3,BL*0.4,6),
    new THREE.MeshStandardMaterial({color:'#0000FF',emissive:'#4444FF',emissiveIntensity:2,roughness:1,transparent:false,opacity:1}));
  tail.position.y=-BL*0.85;grp.add(tail);parts.push(tail);
  return parts;
}

function spawnArrows(lvl,skinId){
  arrows.forEach(a=>scene.remove(a.root));
  arrows=[];arrowMap={};
  const sk=skinDef(skinId||activeSkin);
  const mapDef=MAPS.find(m=>m.id===activeMap)||MAPS[0];
  const cols=mapDef.colors||DEFAULT_COLORS;
  const tex=getMapTex(activeMap);
  lvl.forEach((def,i)=>{
    const col=cols[i%cols.length];
    const root=new THREE.Group(),inner=new THREE.Group();root.add(inner);
    const parts=sk.shape==='car'?buildCar(col,sk,inner):sk.shape==='rocket'?buildRocket(col,sk,inner):sk.shape==='star'?buildStar(col,sk,inner):sk.shape==='sword'?buildSword(col,sk,inner):sk.shape==='mushroom'?buildMushroom(col,sk,inner):sk.shape==='crystal2'?buildCrystal2(col,sk,inner):sk.shape==='flame'?buildFlame(col,sk,inner):sk.shape==='ice'?buildIce(col,sk,inner):sk.shape==='thunder'?buildThunder(col,sk,inner):sk.shape==='dragon'?buildDragon(col,sk,inner):sk.shape==='rainbow'?buildRainbow(col,sk,inner):sk.shape==='ghost'?buildGhost(col,sk,inner):sk.shape==='lava'?buildLava(col,sk,inner):sk.shape==='cosmic'?buildCosmic(col,sk,inner):buildArrow(col,sk,inner,tex);
    const dv=DV[def.dir].clone();
    inner.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),dv);
    // 모든 스킨 공통 투명 히트박스 (inner에 추가 → 방향 따라 회전)
    {const hm=new THREE.MeshBasicMaterial({transparent:true,opacity:0,depthWrite:false});
     const hg=new THREE.Mesh(new THREE.CylinderGeometry(0.13,0.13,0.72,6),hm);
     hg.position.y=0;inner.add(hg);}
    const ring=new THREE.Mesh(new THREE.TorusGeometry(0.27,0.028,8,32),new THREE.MeshStandardMaterial({color:'#fff',emissive:'#fff',emissiveIntensity:1.3,roughness:1,metalness:0}));
    ring.rotation.x=Math.PI/2;ring.visible=false;root.add(ring);
    const bp=new THREE.Vector3(def.pos[0]*GRID,def.pos[1]*GRID,def.pos[2]*GRID);
    root.position.copy(bp);
    const aid=`a${i}`;
    root.userData.arrowId=aid;inner.userData.arrowId=aid;
    parts.forEach(p=>{p.userData.arrowId=aid;});
    scene.add(root);
    const entry={id:aid,def:{...def,pos:[...def.pos],id:aid,col},root,inner,ring,parts,state:'idle',prog:0,bp:bp.clone(),dv,oDelay:i*0.055,oStart:new THREE.Vector3(),spinAngle:Math.random()*Math.PI*2};
    arrows.push(entry);arrowMap[aid]=entry;
  });
}

// ══════════════════════════════════════════════════
// BLOCKING
// ══════════════════════════════════════════════════
function blocked(a,pool){
  pool=pool||arrows;
  const[ax,ay,az]=a.def.pos,d=a.def.dir;
  return pool.some(o=>{
    if(o.id===a.id||o.state==='escaped')return false;
    const[bx,by,bz]=o.def.pos;
    if(d==='px')return by===ay&&bz===az&&bx>ax;if(d==='nx')return by===ay&&bz===az&&bx<ax;
    if(d==='py')return bx===ax&&bz===az&&by>ay;if(d==='ny')return bx===ax&&bz===az&&by<ay;
    if(d==='pz')return bx===ax&&by===ay&&bz>az;if(d==='nz')return bx===ax&&by===ay&&bz<az;
  });
}
// ── Ray-based collision for rotated escape directions (non-vertical arrows) ──
function blockedInDirection(a,dir){
  return arrows.some(o=>{
    if(o.id===a.id||o.state==='escaped')return false;
    const delta=o.bp.clone().sub(a.bp);
    const dot=delta.dot(dir);
    if(dot<=0.05)return false;
    const perp=delta.clone().sub(dir.clone().multiplyScalar(dot));
    return perp.length()<GRID*0.6;
  });
}

// ══════════════════════════════════════════════════
// PATH PREVIEW
// ══════════════════════════════════════════════════
let prevMesh=null;
function showPreview(a){
  clearPreview();
  const s=a.bp.clone(),e=s.clone().addScaledVector(a.dv,4.2),m=s.clone().lerp(e,0.5),l=s.distanceTo(e);
  const q=new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0),a.dv);
  prevMesh=new THREE.Mesh(new THREE.CylinderGeometry(0.013,0.013,l,6),new THREE.MeshStandardMaterial({color:a.def.col,transparent:false,opacity:1,emissive:a.def.col,emissiveIntensity:0.35,roughness:1,metalness:0}));
  prevMesh.position.copy(m);prevMesh.quaternion.copy(q);scene.add(prevMesh);
}
function clearPreview(){if(prevMesh){scene.remove(prevMesh);prevMesh=null;}}

// ══════════════════════════════════════════════════
// GLOW
// ══════════════════════════════════════════════════
function setGlow(entry,on){
  entry.parts.forEach(p=>{
    if(!p.material)return;
    p.material.emissive.set('#000');
    p.material.emissiveIntensity=0; // 발광 안 되게 0 고정
  });
  entry.ring.visible=on; // 선택 링만 깔끔하게 표시
}

// ══════════════════════════════════════════════════
// GAME STATE
// ══════════════════════════════════════════════════
let phase='menu';
let lvIdx=0,lives=5,maxLiv=5,selId=null;
let escaped=0,shk=0;
let opening=false,openT=0;
let lastId=null,lastT=0;
let idleT=0,hudOn=true;
let demoIdx=0,demoT=0;

// ══════════════════════════════════════════════════
// REPLAY + PERSONAL HISTORY
// ══════════════════════════════════════════════════
let _activeReplay=null;
let _lastCompletedReplay=null;
let _historyRecords=[];
let _historyFilter='all';
let _replayPlayback=null;

function _replayId(){
  if(typeof crypto!=='undefined'&&typeof crypto.randomUUID==='function')return crypto.randomUUID();
  return `replay-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
}

function _replayModeLabel(mode){
  if(mode==='rank')return '랭크';
  if(mode==='blast-rank')return '블라스트 랭크';
  if(mode==='general-ai')return 'AI 대전';
  return mode==='general'?'일반 멀티':'일반';
}

function _replayTimeLabel(seconds){
  if(seconds===null||seconds===undefined||!Number.isFinite(Number(seconds)))return '—';
  return `${Number(seconds).toFixed(2)}초`;
}

function _replayDateLabel(value){
  const date=new Date(Number(value)||Date.now());
  return date.toLocaleString('ko-KR',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
}

function _replayEventPayload(entry){
  return {
    id:entry.id,
    x:Number(entry.bp?.x||0),
    y:Number(entry.bp?.y||0),
    z:Number(entry.bp?.z||0),
    dir:entry.def?.dir||'py',
    spinAngle:Number(entry.spinAngle||0),
    launchRotY:Number(entry.launchRotY||0),
  };
}

function _recordReplayEvent(type,payload={},player='me'){
  if(!_activeReplay||_activeReplay.saved)return null;
  const event={t:Math.max(0,Date.now()-_activeReplay.startedAt),type,player,...payload};
  _activeReplay.events.push(event);
  if(_activeReplay.events.length>1800)_activeReplay.events.shift();
  return event;
}

function _sendReplayAction(event){
  if(!_activeReplay||_activeReplay.kind!=='multi'||!event)return;
  if(typeof multiSend==='function')multiSend({type:'replay_event',event:{...event,player:'opponent'}});
}

function _startReplaySession(config){
  if(_activeReplay)_finishReplaySession('abandoned');
  _activeReplay={
    id:_replayId(),
    startedAt:Date.now(),
    events:[{t:0,type:'start',player:'me'}],
    kind:config.kind||'single',
    levelIndex:Number.isFinite(config.levelIndex)?config.levelIndex:null,
    mode:config.mode||'normal',
    code:config.code||null,
    total:Number(config.total||0),
    opponent:config.opponent||null,
    perfect:true,
    combo:0,
    maxCombo:0,
    coins:0,
    saved:false,
  };
}

function _finishReplaySession(result,extra={}){
  const session=_activeReplay;
  if(!session||session.saved)return;
  const endedAt=Date.now();
  const duration=Math.max(0,(endedAt-session.startedAt)/1000);
  _recordReplayEvent('finish',{result});
  session.saved=true;
  const isMulti=session.kind==='multi';
  const record={
    id:session.id,
    replayId:session.id,
    playedAt:endedAt,
    kind:session.kind,
    mode:session.mode,
    levelIndex:session.levelIndex,
    level:session.levelIndex===null?(session.code||'멀티'):session.levelIndex+1,
    result,
    duration:Number(duration.toFixed(2)),
    perfect:Boolean(session.perfect&&result!=='abandoned'),
    combo:Number(session.maxCombo||0),
    coins:Number(session.coins||0),
    opponent:extra.opponent||session.opponent||null,
    opponentTime:extra.opponentTime??null,
    total:Number(session.total||0),
  };
  const replay={
    id:session.id,
    createdAt:session.startedAt,
    endedAt,
    kind:session.kind,
    mode:session.mode,
    levelIndex:session.levelIndex,
    code:session.code,
    total:session.total,
    opponent:record.opponent,
    duration:record.duration,
    events:session.events.slice(),
  };
  _lastCompletedReplay=record;
  _activeReplay=null;
  saveMatchRecord({db:_fbDb,user:_fbUser,record,replay})
    .then(()=>{if(_fbUser)_loadHistoryRecords();})
    .catch(error=>console.warn('[Replay] Match save failed:',error));
  return record;
}

function _finishMultiReplay(result,extra={}){
  if(!_activeReplay)return;
  _activeReplay.coins=Number(extra.coins||0);
  _finishReplaySession(result,extra);
}

function _markReplayLaunch(entry,blockedNow){
  if(!_activeReplay)return;
  if(blockedNow){
    _activeReplay.perfect=false;
    _activeReplay.combo=0;
  }else{
    _activeReplay.combo+=1;
    _activeReplay.maxCombo=Math.max(_activeReplay.maxCombo,_activeReplay.combo);
  }
  const event=_recordReplayEvent(blockedNow?'blocked':'launch',{
    ..._replayEventPayload(entry),
    combo:_activeReplay.combo,
  });
  if(phase==='multi-playing')_sendReplayAction(event);
}

async function _loadHistoryRecords(){
  _historyRecords=await loadUserHistory({db:_fbDb,user:_fbUser});
  if(document.getElementById('history-ov')?.classList.contains('on'))_renderHistory();
}

function _historySummary(records){
  const finished=records.filter(item=>item.result!=='abandoned');
  const singles=finished.filter(item=>item.kind==='single');
  const multi=finished.filter(item=>item.kind==='multi');
  const wins=multi.filter(item=>item.result==='win').length;
  const losses=multi.filter(item=>item.result==='loss').length;
  const draws=multi.filter(item=>item.result==='draw').length;
  const times=finished.map(item=>Number(item.duration)).filter(Number.isFinite).filter(item=>item>0);
  let longest=0,current=0;
  for(const item of [...finished].sort((a,b)=>Number(a.playedAt)-Number(b.playedAt))){
    if(item.kind==='multi'&&item.result==='win'){current+=1;longest=Math.max(longest,current);}
    else if(item.kind==='multi'&&item.result!=='abandoned')current=0;
  }
  for(const item of [...finished].sort((a,b)=>Number(b.playedAt)-Number(a.playedAt))){
    if(item.kind==='multi'&&item.result==='win')break;
    if(item.kind==='multi'&&item.result!=='abandoned'){current=0;break;}
  }
  return {
    total:finished.length,
    clears:singles.filter(item=>item.result==='clear').length,
    wins,losses,draws,
    best:times.length?Math.min(...times):null,
    average:times.length?times.reduce((a,b)=>a+b,0)/times.length:null,
    perfect:finished.filter(item=>item.perfect).length,
    combo:finished.reduce((best,item)=>Math.max(best,Number(item.combo)||0),0),
    coins:finished.reduce((sum,item)=>sum+(Number(item.coins)||0),0),
    streak:current,
    longest,
  };
}

function _historyResultLabel(item){
  if(item.result==='clear')return 'CLEAR';
  if(item.result==='win')return 'WIN';
  if(item.result==='draw')return 'DRAW';
  if(item.result==='abandoned')return '중단';
  return 'LOSS';
}

function _renderHistory(){
  const list=document.getElementById('history-list');
  const empty=document.getElementById('history-empty');
  const summary=_historySummary(_historyRecords);
  const records=_historyRecords
    .filter(item=>_historyFilter==='all'||(_historyFilter==='single'&&item.kind==='single')||(_historyFilter==='multi'&&item.kind==='multi'))
    .sort((a,b)=>Number(b.playedAt)-Number(a.playedAt));
  const set=(id,value)=>{const el=document.getElementById(id);if(el)el.textContent=String(value);};
  set('history-total',summary.total);set('history-clears',summary.clears);
  set('history-winloss',`${summary.wins} / ${summary.losses}${summary.draws?` / ${summary.draws}`:''}`);
  set('history-best',_replayTimeLabel(summary.best));set('history-average',_replayTimeLabel(summary.average));
  set('history-perfect',summary.perfect);set('history-combo',summary.combo);
  set('history-coins',summary.coins);set('history-streak',`${summary.streak} / ${summary.longest}`);
  if(!list||!empty)return;
  list.replaceChildren();
  empty.style.display=records.length?'none':'flex';
  for(const item of records){
    const row=document.createElement('article');
    row.className='history-item';
    const isMulti=item.kind==='multi';
    const result=_historyResultLabel(item);
    row.innerHTML=`
      <div class="history-item-top">
        <div><strong>${isMulti?'MULTI':'SINGLE'}</strong><span>${_replayDateLabel(item.playedAt)}</span></div>
        <b class="history-result ${result.toLowerCase()}">${result}</b>
      </div>
      <div class="history-item-meta">${isMulti?`${_replayModeLabel(item.mode)} · 코드 ${item.level||'—'}`:`레벨 ${item.level||item.levelIndex+1} · ${_replayModeLabel(item.mode)}`}</div>
      <div class="history-item-stats">
        <span>TIME <b>${_replayTimeLabel(item.duration)}</b></span>
        <span>${item.perfect?'PERFECT':'NO MISS X'} <b>${item.perfect?'✓':'—'}</b></span>
        <span>COMBO <b>${item.combo||0}</b></span>
        <span>COIN <b>${item.coins||0}</b></span>
      </div>
      ${isMulti&&item.opponent?`<div class="history-opponent">VS ${item.opponent}</div>`:''}
      <button class="history-replay-btn" data-replay-id="${item.replayId||item.id}">[ REPLAY ]</button>`;
    row.querySelector('.history-replay-btn').addEventListener('click',()=>_openReplay(item.replayId||item.id));
    list.appendChild(row);
  }
}

function _openHistory(){
  phase='history';
  clearPreview();
  closeMultiWs();
  showUI('history');
  _historyFilter='all';
  document.querySelectorAll('.history-filter').forEach(button=>button.classList.toggle('on',button.dataset.filter==='all'));
  _loadHistoryRecords();
  _renderHistory();
}

function _replayPositionCamera(){
  const center=new THREE.Vector3();
  arrows.forEach(entry=>center.add(entry.bp));
  if(arrows.length)center.divideScalar(arrows.length);
  const span=Math.sqrt(Math.max(1,arrows.length))*GRID;
  const portrait=innerHeight>innerWidth*1.1;
  camera.position.set(center.x,center.y+span*.5,center.z+(portrait?span*2.5+5.5:span*1.9+3.5));
  controls.target.copy(center);controls.update();
}

function _replayApplyEvent(event){
  if(!_replayPlayback)return;
  if(event.player==='opponent'){
    _replayPlayback.opponentEvents+=1;
    const count=_replayPlayback.opponentEvents;
    const total=_replayPlayback.opponentTotal||count;
    const fill=document.getElementById('replay-op-fill');
    if(fill)fill.style.width=Math.min(100,count/Math.max(1,total)*100)+'%';
    const label=document.getElementById('replay-op-count');
    if(label)label.textContent=`${count}/${total}`;
    return;
  }
  if(event.type!=='launch'&&event.type!=='blocked')return;
  const entry=arrowMap[event.id];
  if(!entry||entry.state!=='idle')return;
  entry.spinAngle=Number(event.spinAngle||entry.spinAngle||0);
  entry.launchRotY=Number(event.launchRotY||0);
  entry.dv=DV[event.dir] ? DV[event.dir].clone().applyEuler(new THREE.Euler(0,entry.spinAngle,0)).normalize() : entry.dv;
  if(event.type==='blocked'){
    entry.state='returning';entry.prog=0.22;
  }else{
    entry.state='moving';entry.prog=0;
    _replayPlayback.myEvents+=1;
    const fill=document.getElementById('replay-my-fill');
    if(fill)fill.style.width=Math.min(100,_replayPlayback.myEvents/Math.max(1,_replayPlayback.myTotal)*100)+'%';
    const label=document.getElementById('replay-my-count');
    if(label)label.textContent=`${_replayPlayback.myEvents}/${_replayPlayback.myTotal}`;
  }
}

async function _openReplay(id){
  const replay=await loadReplay({db:_fbDb,user:_fbUser,id});
  if(!replay){
    popup('리플레이를 찾을 수 없습니다.',innerWidth/2,innerHeight*.45,'#ff6b6b');
    return;
  }
  const total=Number(replay.total||replay.events?.filter(event=>event.player==='me'&&event.type==='launch').length||1);
  const level=replay.kind==='multi'?genMultiLevel(replay.code||'0000',total):getLevel(Number(replay.levelIndex)||0);
  clearPreview();closeMultiWs();clearRankBot();clearBlastRankTimer();
  phase='replay';escaped=0;selId=null;lastId=null;opening=false;
  spawnArrows(level,activeSkin);_replayPositionCamera();
  arrows.forEach(entry=>{entry.root.visible=true;entry.state='idle';entry.prog=0;});
  _replayPlayback={
    replay,
    events:[...(replay.events||[])].sort((a,b)=>Number(a.t)-Number(b.t)),
    eventIndex:0,
    elapsed:0,
    paused:false,
    speed:1,
    myEvents:0,
    opponentEvents:0,
    myTotal:Math.max(1,(replay.events||[]).filter(event=>event.player!=='opponent'&&event.type==='launch').length),
    opponentTotal:Math.max(1,(replay.events||[]).filter(event=>event.player==='opponent'&&event.type==='launch').length),
  };
  showUI('replay');
  _updateReplayControls();
}

function _updateReplayControls(){
  if(!_replayPlayback)return;
  const play=document.getElementById('replay-play');
  const elapsed=document.getElementById('replay-elapsed');
  const total=document.getElementById('replay-total');
  if(play)play.textContent=_replayPlayback.paused?'▶ 재생':'Ⅱ 일시정지';
  if(elapsed)elapsed.textContent=_replayTimeLabel(_replayPlayback.elapsed);
  if(total)total.textContent=_replayTimeLabel(Number(_replayPlayback.replay.duration)||0);
  const progress=document.getElementById('replay-progress-fill');
  if(progress)progress.style.width=Math.min(100,_replayPlayback.elapsed/Math.max(.01,Number(_replayPlayback.replay.duration)||1)*100)+'%';
  document.querySelectorAll('.replay-speed').forEach(button=>button.classList.toggle('on',Number(button.dataset.speed)===_replayPlayback.speed));
}

function _stopReplay(){
  _replayPlayback=null;
  phase='menu';clearPreview();showUI('menu');initDemo();
}

// ══════════════════════════════════════════════════
// HIT TEST
// ══════════════════════════════════════════════════
function hitTest(cx,cy){
  const r=canvas.getBoundingClientRect();
  pt2.set(((cx-r.left)/r.width)*2-1,-((cy-r.top)/r.height)*2+1);
  rc.setFromCamera(pt2,camera);
  const roots=arrows.filter(a=>a.state!=='escaped'&&a.root.visible).map(a=>a.root);
  const hits=rc.intersectObjects(roots,true);
  if(!hits.length)return null;
  let obj=hits[0].object;
  while(obj&&!obj.userData.arrowId)obj=obj.parent;
  return obj?obj.userData.arrowId:null;
}

// ══════════════════════════════════════════════════
// SELECT & LAUNCH
// ══════════════════════════════════════════════════
function selectArrow(id){
  if(phase!=='playing'&&phase!=='multi-playing')return;
  if(opening){opening=false;}
  const e=arrowMap[id];if(!e||e.state!=='idle')return;
  resetIdle();
  // ── JUST system: if already selected → launch attempt ──
  if(selId===id){launchArrow(id);return;}
  // Deselect previous
  if(selId&&selId!==id){const p=arrowMap[selId];if(p)setGlow(p,false);}
  selId=id;lastId=id;lastT=Date.now();
  setGlow(e,true);showPreview(e);
  if(phase==='playing'){
    document.getElementById('launch-btn').style.display='inline-block';
    const hb=document.getElementById('hint-bar');hb.style.opacity='1';setTimeout(()=>{hb.style.opacity='0';},2500);
  }
}
// ── COMBO SOUND SYSTEM (스킨별 콤보 사운드) ───────────────────────────────────
// 13단계: 콤보 오를수록 피치 상승 / 스킨마다 고유 음색
const _COMBO_FREQS=[130.81,146.83,164.81,174.61,196.00,220.00,246.94,261.63,293.66,329.63,369.99,415.30,466.16];
let _comboIdx=0;
// ── 갤럭시/Android 오디오 잠금 해제 ─────────────────────────────────────────
(function(){
  var _done=false;
  function _unlock(){
    if(_done)return;_done=true;
    try{
      var ac=window._unlockedACtx||(new(window.AudioContext||window.webkitAudioContext)());
      var b=ac.createBuffer(1,1,22050);var s=ac.createBufferSource();
      s.buffer=b;s.connect(ac.destination);s.start(0);
      if(ac.state==='suspended')ac.resume();
      window._unlockedACtx=ac;
    }catch(e){}
    document.querySelectorAll('audio').forEach(function(a){
      if(!a.dataset.auU){a.dataset.auU='1';
        var p=a.play();if(p)p.then(function(){a.pause();a.currentTime=0;}).catch(function(){});}
    });
  }
  ['touchstart','touchend','pointerdown','click','keydown'].forEach(function(ev){
    document.addEventListener(ev,_unlock,{once:true,passive:true,capture:true});
  });
})();
let _sfxCtx=null;
function _getSfxCtx(){
  if(!_sfxCtx){_sfxCtx=window._unlockedACtx||(new(window.AudioContext||window.webkitAudioContext)());window._unlockedACtx=_sfxCtx;}
  return _sfxCtx;
}
// 앱 포그라운드 복귀 시 오디오 컨텍스트 자동 복구
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&_sfxCtx&&_sfxCtx.state==='suspended')_sfxCtx.resume();});
window.addEventListener('focus',()=>{if(_sfxCtx&&_sfxCtx.state==='suspended')_sfxCtx.resume();});
function playComboNote(){
  try{
    const ctx=_getSfxCtx();
    if(ctx.state==='suspended'){ctx.resume().then(()=>playComboNote());return;}
    const _sv=typeof _settings!=='undefined'?Math.max(0.001,_settings.sfxVol):1;
    if(typeof _settings!=='undefined'&&_settings.sfxVol<=0)return;
    const now=ctx.currentTime;
    const comp=ctx.createDynamicsCompressor();
    comp.threshold.value=-10;comp.knee.value=8;comp.ratio.value=3;comp.attack.value=0.002;comp.release.value=0.18;
    comp.connect(ctx.destination);
    const i=_comboIdx;
    const cf=_COMBO_FREQS[i];
    const sk=typeof activeSkin!=='undefined'?activeSkin:'default';
    // 오실레이터 생성 헬퍼 (클로저 — ctx/comp/now 캡처)
    function mkO(type,freq,vol,atk,dec,dest){
      const o=ctx.createOscillator(),g=ctx.createGain();
      o.type=type;o.frequency.value=Math.max(20,freq);
      o.connect(g);g.connect(dest||comp);
      g.gain.setValueAtTime(0,now);
      g.gain.linearRampToValueAtTime(vol*_sv,now+atk);
      g.gain.exponentialRampToValueAtTime(0.0001,now+dec);
      o.start(now);o.stop(now+dec+0.06);
    }
    function sweep(type,f0,f1,vol,dur,dest){
      const o=ctx.createOscillator(),g=ctx.createGain();
      o.type=type;
      o.frequency.setValueAtTime(Math.max(20,f0),now);
      o.frequency.exponentialRampToValueAtTime(Math.max(20,f1),now+dur);
      o.connect(g);g.connect(dest||comp);
      g.gain.setValueAtTime(vol*_sv,now);
      g.gain.exponentialRampToValueAtTime(0.0001,now+dur);
      o.start(now);o.stop(now+dur+0.05);
    }
    // ── 스킨별 사운드 ─────────────────────────────────────────────────────────
    if(sk==='car'){
      // 자동차: 경적 — sawtooth+bandpass → 빵빵 경적, 콤보마다 더 높게
      const f=220+i*42;
      const flt=ctx.createBiquadFilter();flt.type='bandpass';flt.frequency.value=f;flt.Q.value=6;flt.connect(comp);
      const o=ctx.createOscillator(),g=ctx.createGain();
      o.type='sawtooth';o.frequency.value=f;o.connect(g);g.connect(flt);
      g.gain.setValueAtTime(0,now);g.gain.linearRampToValueAtTime(0.9*_sv,now+0.018);
      g.gain.setValueAtTime(0.9*_sv,now+0.2);g.gain.exponentialRampToValueAtTime(0.0001,now+0.35);
      o.start(now);o.stop(now+0.41);
      mkO('sawtooth',f*1.5,0.2,0.01,0.28);
    } else if(sk==='sword'||sk==='neon_blade'){
      // 검/네온 블레이드: 금속 칼 울림 — 비조화 배음, 콤보마다 더 높게
      const f=380+i*80;
      mkO('triangle',f,0.7,0.002,0.3);
      mkO('sine',f*2.76,0.38,0.001,0.15);
      mkO('sine',f*5.4,0.16,0.001,0.09);
      mkO('triangle',f*0.5,0.28,0.003,0.42);
      if(sk==='neon_blade'){
        // 전기 슬래시 스윕 추가
        sweep('sine',f*0.6,f*3,0.3,0.14);
      }
    } else if(sk==='rocket'){
      // 로켓: 엔진 부스터 윙윙 + 피치 스윕
      const f=80+i*30;
      [-15,-5,0,5,15].forEach(det=>{
        const o=ctx.createOscillator(),g=ctx.createGain();
        o.type='sawtooth';o.frequency.value=f;o.detune.value=det;
        o.connect(g);g.connect(comp);
        g.gain.setValueAtTime(0,now);g.gain.linearRampToValueAtTime(0.15*_sv,now+0.02);
        g.gain.exponentialRampToValueAtTime(0.0001,now+0.35);
        o.start(now);o.stop(now+0.4);
      });
      sweep('sine',Math.max(20,f*0.5),f*8,0.35,0.3);
    } else if(sk==='neon'){
      // 네온: 전기 지직 버즈 — square+디튜닝
      const f=180+i*60;
      mkO('square',f,0.55,0.004,0.2);
      const o2=ctx.createOscillator(),g2=ctx.createGain();
      o2.type='square';o2.frequency.value=f*1.012;o2.detune.value=25;
      o2.connect(g2);g2.connect(comp);
      g2.gain.setValueAtTime(0,now);g2.gain.linearRampToValueAtTime(0.28*_sv,now+0.003);
      g2.gain.exponentialRampToValueAtTime(0.0001,now+0.17);
      o2.start(now);o2.stop(now+0.23);
      mkO('sine',f*3,0.16,0.002,0.1);
    } else if(sk==='crystal'||sk==='ruby_free'||sk==='void_shard'){
      // 크리스탈/루비/공허: 유리 벨 — 긴 감쇠, 배음
      const f=cf*(sk==='void_shard'?1.2:sk==='ruby_free'?1.8:2.6);
      mkO('sine',f,0.85,0.003,0.6);
      mkO('sine',f*2.8,0.28,0.002,0.35);
      mkO('sine',f*(sk==='void_shard'?0.5:5.1),0.12,0.001,0.22);
    } else if(sk==='crystal2'||sk==='s1_mvp'){
      // 크리스탈 샤드/MVP: 날카로운 핑
      const f=cf*3;
      mkO('sine',f,0.85,0.001,0.4);
      mkO('sine',f*3.2,0.3,0.001,0.18);
      mkO('triangle',f*1.5,0.22,0.002,0.26);
    } else if(sk==='star'){
      // 별: 반짝 스파클
      const f=580+i*115;
      mkO('sine',f,0.7,0.002,0.22);
      mkO('triangle',f*1.5,0.38,0.001,0.15);
      mkO('sine',f*2,0.48,0.001,0.12);
    } else if(sk==='mushroom'){
      // 버섯: 통통 바운스 보잉~ (피치 드롭)
      const f=300+i*50;
      sweep('sine',f*2.5,f,0.7,0.28);
      mkO('sine',f*0.5,0.2,0.003,0.2);
    } else if(sk==='gold'||sk==='golden_arrow'){
      // 골드/골든 에로우: 황금 동전 챙그랑
      const f=500+i*80;
      mkO('triangle',f,0.75,0.002,0.42);
      mkO('sine',f*2,0.38,0.001,0.26);
      mkO('sine',f*3.7,0.16,0.001,0.16);
      if(sk==='golden_arrow'){mkO('sine',f*1.25,0.45,0.006,0.3);}
    } else if(sk==='silver'){
      // 실버: 은빛 차임
      const f=550+i*75;
      mkO('triangle',f,0.7,0.002,0.38);
      mkO('sine',f*2.5,0.32,0.001,0.22);
      mkO('sine',f*4,0.13,0.001,0.14);
    } else if(sk==='chrome'){
      // 크롬: 날카로운 금속 핑
      const f=600+i*88;
      mkO('triangle',f,0.8,0.001,0.28);
      mkO('sine',f*3,0.4,0.001,0.16);
      mkO('sine',f*5,0.15,0.001,0.09);
    } else if(sk==='stealth'){
      // 스텔스: 조용한 미사일 활공 스윕
      const f=120+i*35;
      sweep('sine',f,f*3,0.3,0.18);
    } else if(sk==='inferno'){
      // 인페르노: 불꽃 지직 (디튠 사인파 다발 + 팝음)
      const f=100+i*25;
      [0,10,-10,22,-22].forEach(det=>{
        const o=ctx.createOscillator(),g=ctx.createGain();
        o.type='sawtooth';o.frequency.value=f;o.detune.value=det;
        o.connect(g);g.connect(comp);
        g.gain.setValueAtTime(0,now);g.gain.linearRampToValueAtTime(0.13*_sv,now+0.01);
        g.gain.exponentialRampToValueAtTime(0.0001,now+0.3);
        o.start(now);o.stop(now+0.35);
      });
      mkO('sine',f*6,0.35,0.001,0.06);
    } else if(sk==='crosis_blessed'){
      // 크로시스 축복: 신성한 메이저 화음
      const f=320+i*40;
      mkO('sine',f,0.65,0.01,0.55);
      mkO('sine',f*1.25,0.5,0.008,0.45);
      mkO('sine',f*1.5,0.4,0.007,0.38);
      mkO('sine',f*2,0.26,0.005,0.3);
    } else if(sk==='flame'){
      // 🔥 불꽃: 지글지글 불꽃 크랙 — 디튠 쏘톱 다발 + 팍! 음
      const f=80+i*22;
      [0,14,-14,28,-28,42].forEach(det=>{
        const o=ctx.createOscillator(),g=ctx.createGain();
        o.type='sawtooth';o.frequency.value=f;o.detune.value=det;
        o.connect(g);g.connect(comp);
        g.gain.setValueAtTime(0,now);g.gain.linearRampToValueAtTime(0.14*_sv,now+0.008);
        g.gain.exponentialRampToValueAtTime(0.0001,now+0.28);
        o.start(now);o.stop(now+0.33);
      });
      // 팝 톡음
      sweep('sine',f*5,f*0.8,0.5,0.08);
      mkO('sine',f*8,0.3,0.001,0.05);
    } else if(sk==='ice'){
      // ❄️ 얼음: 유리처럼 맑고 높은 크리스탈 벨
      const f=(cf*4.5)+i*28;
      mkO('sine',f,0.85,0.001,0.55);
      mkO('sine',f*2.002,0.38,0.001,0.38);  // 약간 디튠 배음
      mkO('sine',f*4.01,0.18,0.001,0.22);
      mkO('triangle',f*0.498,0.22,0.002,0.65); // 낮은 배음 은은하게
      sweep('sine',f*6,f*12,0.12,0.07);      // 얼음 반짝 스윕
    } else if(sk==='thunder'){
      // ⚡ 번개: 날카로운 전기 지직 — 스퀘어 버스트 + 피치 드롭
      const f=200+i*60;
      mkO('square',f,0.6,0.001,0.07);
      sweep('sawtooth',f*3,f*0.3,0.7,0.12);  // 전압 방전 스윕 다운
      mkO('square',f*1.5,0.4,0.001,0.05);
      // 지직 레이어
      [0,7,-7,18,-18].forEach(det=>{
        const o=ctx.createOscillator(),g2=ctx.createGain();
        o.type='square';o.frequency.value=f*2;o.detune.value=det;
        o.connect(g2);g2.connect(comp);
        g2.gain.setValueAtTime(0.18*_sv,now);g2.gain.exponentialRampToValueAtTime(0.0001,now+0.09);
        o.start(now);o.stop(now+0.14);
      });
    } else if(sk==='dragon'){
      // 🐉 드래곤: 웅장한 포효 — 저음 드론 + 고음 하모닉
      const f=55+i*12;
      mkO('sawtooth',f,0.7,0.015,0.6);      // 저음 몸통
      mkO('sawtooth',f*2,0.45,0.010,0.5);
      mkO('triangle',f*3,0.32,0.008,0.42);
      mkO('sine',f*5.1,0.22,0.005,0.35);    // 포효 배음
      mkO('sine',f*8,0.14,0.003,0.25);
      sweep('sawtooth',f*0.5,f*1.8,0.4,0.22); // 포효 상승 글리산도
    } else if(sk==='rainbow'){
      // 🌈 무지개: 경쾌한 목금 아르페지오 — 5음계 튕기기
      const penta=[1,1.2,1.5,1.8,2.0,2.4];
      const f=cf*2.2;
      penta.forEach((ratio,idx)=>{
        const t2=now+idx*0.04;
        const o=ctx.createOscillator(),g2=ctx.createGain();
        o.type='triangle';o.frequency.value=f*ratio;
        o.connect(g2);g2.connect(comp);
        g2.gain.setValueAtTime(0,t2);g2.gain.linearRampToValueAtTime(0.42*_sv,t2+0.005);
        g2.gain.exponentialRampToValueAtTime(0.0001,t2+0.28);
        o.start(t2);o.stop(t2+0.33);
      });
      mkO('sine',f*3,0.2,0.001,0.15); // 반짝임
    } else if(sk==='ghost'){
      // 👻 유령: 섬뜩한 사인 진동 — 느린 비브라토 + 공허한 울림
      const f=cf*0.8+i*10;
      const lfo=ctx.createOscillator();const lfoG=ctx.createGain();
      lfo.frequency.value=4.5+i*0.3;lfoG.gain.value=f*0.06;
      lfo.connect(lfoG);
      const o=ctx.createOscillator(),gv=ctx.createGain();
      o.type='sine';o.frequency.value=f;
      lfoG.connect(o.frequency);
      o.connect(gv);gv.connect(comp);
      gv.gain.setValueAtTime(0,now);gv.gain.linearRampToValueAtTime(0.5*_sv,now+0.06);
      gv.gain.setValueAtTime(0.5*_sv,now+0.28);gv.gain.exponentialRampToValueAtTime(0.0001,now+0.7);
      o.start(now);o.stop(now+0.75);lfo.start(now);lfo.stop(now+0.75);
      mkO('sine',f*1.5,0.18,0.04,0.55);
      mkO('triangle',f*2.01,0.10,0.02,0.45);
    } else if(sk==='lava'){
      // 🌋 용암: 묵직한 저음 럼블 + 돌 부서지는 소리
      const f=45+i*10;
      mkO('sawtooth',f,0.75,0.02,0.5);      // 저음 진동
      mkO('sawtooth',f*2,0.42,0.015,0.4);
      // 돌 크런치: 디튠 쏘톱 빽빽히
      [0,20,-20,40,-40,60,-60].forEach(det=>{
        const o=ctx.createOscillator(),g2=ctx.createGain();
        o.type='sawtooth';o.frequency.value=f*0.75;o.detune.value=det;
        o.connect(g2);g2.connect(comp);
        g2.gain.setValueAtTime(0.1*_sv,now);g2.gain.exponentialRampToValueAtTime(0.0001,now+0.35);
        o.start(now);o.stop(now+0.4);
      });
      sweep('sawtooth',f*3,f*0.6,0.35,0.18); // 용암 글리산도 다운
    } else if(sk==='cosmic'){
      // 🌟 코스믹: 에테르 사인 스윕 — 우주적 깊이 + 스타필드 반짝
      const f=cf*1.5+i*18;
      sweep('sine',f*0.5,f*3,0.55,0.4);      // 코스믹 상승 스윕
      mkO('sine',f,0.4,0.01,0.5);
      mkO('sine',f*1.618,0.28,0.008,0.42);   // 황금비 배음
      mkO('sine',f*2.618,0.18,0.005,0.32);
      // 별 반짝임 고주파
      [8,10,13].forEach((mult,idx)=>{
        const t2=now+idx*0.06;
        const o=ctx.createOscillator(),g2=ctx.createGain();
        o.type='sine';o.frequency.value=f*mult;
        o.connect(g2);g2.connect(comp);
        g2.gain.setValueAtTime(0,t2);g2.gain.linearRampToValueAtTime(0.15*_sv,t2+0.003);
        g2.gain.exponentialRampToValueAtTime(0.0001,t2+0.15);
        o.start(t2);o.stop(t2+0.2);
      });
    } else {
      // 기본 (default + 나머지): 마림바/벨 — 원본과 동일
      const freq=cf*2;
      mkO('sine',freq,0.92,0.007,0.38);
      mkO('sine',freq*2,0.38,0.004,0.22);
      mkO('sine',freq*4,0.16,0.003,0.13);
    }
    _comboIdx++;
    if(_comboIdx>=_COMBO_FREQS.length)_comboIdx=0;
  }catch(e){console.error('[ComboSound]',e);}
}
function resetComboSound(){_comboIdx=0;endFeverMode();}
// ─────────────────────────────────────────────────────────────────────────────


// ══════════════════════════════════════════════════
// FEVER & COMBO BAR SYSTEM
// ══════════════════════════════════════════════════
let currentCombo = 0;
const FEVER_MAX_COMBO = 5;
const FEVER_DURATION = 2800; // 2.8 seconds
let feverTimer = null;
let isFever = false;

function updateComboHUD() {
  const hudEl = document.getElementById('combo-hud');
  const fillEl = document.getElementById('combo-bar-fill');
  const txtEl = document.getElementById('combo-count-txt');
  const titleEl = document.getElementById('combo-title');

  if (!hudEl || !fillEl || !txtEl) return;

  if (isFever) {
    hudEl.classList.add('active', 'fever');
    if (titleEl) titleEl.textContent = '🔥 FEVER!';
    txtEl.textContent = 'MAX!';
    fillEl.style.height = '100%';
  } else if (currentCombo > 0) {
    hudEl.classList.add('active');
    hudEl.classList.remove('fever');
    if (titleEl) titleEl.textContent = 'COMBO!';
    txtEl.textContent = 'x' + currentCombo;
    const pct = Math.min(100, Math.round((currentCombo / FEVER_MAX_COMBO) * 100));
    fillEl.style.height = pct + '%';
  } else {
    hudEl.classList.remove('active', 'fever');
    fillEl.style.height = '0%';
    txtEl.textContent = 'x0';
  }
}

function playFeverSound() {
  try {
    const ctx = _getSfxCtx();
    if (!ctx) return;
    const now = ctx.currentTime;
    [261.63, 329.63, 392.00, 523.25, 659.25, 783.99].forEach((freq, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'triangle'; o.frequency.value = freq;
      o.connect(g); g.connect(ctx.destination);
      const t = now + i * 0.05;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.35, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      o.start(t); o.stop(t + 0.4);
    });
  } catch(e) {}
}

function triggerFeverMode() {
  isFever = true;
  updateComboHUD();

  const vig = document.getElementById('fever-vignette');
  if (vig) vig.classList.add('on');

  if (typeof popup === 'function') {
    popup('🔥 FEVER TIME!! 🔥', innerWidth / 2, innerHeight * 0.32, '#FF00EA');
  }
  if (typeof _vibrate === 'function') {
    _vibrate([50, 30, 50, 30, 80]);
  }
  playFeverSound();

  if (feverTimer) clearTimeout(feverTimer);
  feverTimer = setTimeout(() => {
    endFeverMode();
  }, FEVER_DURATION);
}

function endFeverMode() {
  isFever = false;
  currentCombo = 0;
  if (feverTimer) { clearTimeout(feverTimer); feverTimer = null; }

  const vig = document.getElementById('fever-vignette');
  if (vig) vig.classList.remove('on');

  updateComboHUD();
}

function resetCombo() {
  if (isFever) return;
  currentCombo = 0;
  updateComboHUD();
}

function incrementCombo() {
  if (isFever) return;
  currentCombo++;
  updateComboHUD();

  if (currentCombo >= FEVER_MAX_COMBO) {
    triggerFeverMode();
  }
}
window.resetCombo = resetCombo;
window.endFeverMode = endFeverMode;

function launchArrow(id){
  const e=arrowMap[id||selId];if(!e||e.state!=='idle')return;
  clearPreview();setGlow(e,false);
  document.getElementById('launch-btn').style.display='none';
  selId=null;lastId=null;

  const isVertical=e.def.dir==='py'||e.def.dir==='ny';

  if(isVertical){
    // 세로 화살표: 피버 타임일 때 충돌 무시하고 강제 통과 탈출!
    if(blocked(e) && !isFever){
      e.state='returning';e.prog=0.22;e.launchRotY=0;
      resetComboSound();
      resetCombo();
      _markReplayLaunch(e,true);
      if(phase==='playing'){lives--;shk=1.0;updateHUD();flashBlock();if(lives<=0)setTimeout(()=>endGame(false),700);}
      else if(phase==='multi-playing'){shk=0.6;flashBlock();multiBlockCount++;multiLives=Math.max(0,multiLives-1);updateMultiHUD();const pen=Math.min(2,multiBlockCount);popup('실수! ❤️×'+multiLives,innerWidth/2,innerHeight*.38,'#ff6b6b');if(multiLives<=0){setTimeout(()=>multiLiveOut(),600);}}
    }else{
      e.launchRotY=0;e.state='moving';e.prog=0;
      _markReplayLaunch(e,false);
      if(isFever){
        popup('⚡ FEVER ESCAPE! ⚡',innerWidth/2,innerHeight*.38,'#00ffff');
        _vibrate(35);
      } else {
        popup('PERFECT!',innerWidth/2,innerHeight*.38,'#FFD700');
        incrementCombo();
      }
      playComboNote();
      if(typeof achieveState!=='undefined'){_achStat('totalArrows',1,true);_achStat('maxCombo',_comboIdx,false,true);_missionProg('arrows',1);}
      if(phase==='multi-playing'){multiEscape();}
    }
  }else{
    const spinA=e.spinAngle||0;
    const spinDir=DV[e.def.dir].clone().applyEuler(new THREE.Euler(0,spinA,0)).normalize();
    // 가로/깊이 화살표: 피버 타임일 때 충돌 무시하고 강제 통과 탈출!
    if(blockedInDirection(e,spinDir) && !isFever){
      e.state='returning';e.prog=0.22;e.launchRotY=spinA;
      resetComboSound();
      resetCombo();
      _markReplayLaunch(e,true);
      if(phase==='playing'){lives--;shk=1.0;updateHUD();flashBlock();if(lives<=0)setTimeout(()=>endGame(false),700);}
      else if(phase==='multi-playing'){shk=0.6;flashBlock();multiBlockCount++;multiLives=Math.max(0,multiLives-1);updateMultiHUD();const pen=Math.min(2,multiBlockCount);popup('실수! ❤️×'+multiLives,innerWidth/2,innerHeight*.38,'#ff6b6b');if(multiLives<=0){setTimeout(()=>multiLiveOut(),600);}}
    }else{
      e.dv=spinDir.clone();
      e.launchRotY=spinA;
      e.state='moving';e.prog=0;
      _markReplayLaunch(e,false);
      const cosA=Math.abs(DV[e.def.dir].dot(spinDir));
      const is90=cosA<Math.sin(JUST_WINDOW);
      if(isFever){
        popup('⚡ FEVER ESCAPE! ⚡',innerWidth/2,innerHeight*.38,'#00ffff');
        _vibrate(35);
      } else {
        popup(is90?'PERFECT! ★':'PERFECT!',innerWidth/2,innerHeight*.38,'#FFD700');
        incrementCombo();
      }
      _vibrate(24);
      playComboNote();
      if(typeof achieveState!=='undefined'){_achStat('totalArrows',1,true);_achStat('maxCombo',_comboIdx,false,true);_missionProg('arrows',1);}
      if(phase==='multi-playing'){multiEscape();}
    }
  }
}
function _vibrate(pattern){if(typeof _settings!=='undefined'&&_settings.vibration&&navigator.vibrate)navigator.vibrate(pattern);}
function flashBlock(){const el=document.getElementById('blocked-flash');el.style.opacity='1';setTimeout(()=>{el.style.opacity='0';},900);_vibrate([80,30,80]);}

// ══════════════════════════════════════════════════
// OPENING ANIM
// ══════════════════════════════════════════════════
function startOpening(){
  opening=true;openT=Date.now()/1000;
  const cen=new THREE.Vector3();
  arrows.forEach(a=>cen.add(a.bp));cen.divideScalar(arrows.length);
  arrows.forEach((a,i)=>{const sp=7+Math.random()*4;a.oStart.set(cen.x+(Math.random()-.5)*sp,cen.y+7+i*0.2,cen.z+(Math.random()-.5)*sp);a.root.position.copy(a.oStart);a.root.visible=true;});
}

// ══════════════════════════════════════════════════
// ARROW TICK
// ══════════════════════════════════════════════════
function _isJustPerfect(a){
  const angle=((a.spinAngle||0)%(Math.PI*2)+Math.PI*2)%(Math.PI*2);
  const norm=angle>Math.PI?angle-Math.PI*2:angle;
  return Math.abs(norm)<=JUST_WINDOW;
}

function tickArrow(a,dt){
  if(a.state==='escaped'){a.root.visible=false;return;}
  a.root.visible=true;
  if(a.state==='moving'){
    // Keep the rotation angle from the moment of launch so the arrow visually exits in the right direction
    a.root.rotation.y=a.launchRotY||0;
    a.prog+=dt*SPEED;
    if(a.prog>=1){a.prog=1;a.state='escaped';if(phase==='playing'){escaped++;updateHUD();checkWin();}else if(phase==='multi-playing'){escaped++;if(multiMode==='blast-rank'){_blastArrowEscaped(a);}else{updateMultiHUD();checkMultiWin();}}}
    const t=a.prog,e=t<.5?2*t*t:-1+(4-2*t)*t;
    a.root.position.copy(a.bp.clone().addScaledVector(a.dv,e*ESCAPE));
  }else if(a.state==='returning'){
    a.prog-=dt*7;if(a.prog<=0){a.prog=0;a.state='idle';}
    a.root.position.copy(a.bp.clone().addScaledVector(a.dv,a.prog*ESCAPE));
  }else{
    a.root.position.lerp(a.bp,0.2);
    // ── JUST system: continuously spin idle arrows ──
    const spinning=(phase==='playing'||phase==='multi-playing');
    if(spinning){
      a.spinAngle=(a.spinAngle||0)+SPIN_SPEED*dt;
      a.root.rotation.y=a.spinAngle;
      // ── 선택 상태: 세로 화살표(py/ny) 제외하고 궤적 미리보기도 같이 회전 ──
      if(a.id===selId&&prevMesh&&a.def.dir!=='py'&&a.def.dir!=='ny'){
        const spinDir=DV[a.def.dir].clone().applyEuler(new THREE.Euler(0,a.spinAngle,0)).normalize();
        const sp=a.bp.clone(),ep=sp.clone().addScaledVector(spinDir,4.2);
        const mid=sp.clone().lerp(ep,0.5);
        prevMesh.position.copy(mid);
        prevMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),spinDir);
      }
    }
  }
}

// ══════════════════════════════════════════════════
// DEMO MODE
// ══════════════════════════════════════════════════
function initDemo(){
  spawnArrows(getLevel(demoIdx%5),'default');
  demoT=0;controls.autoRotate=false;
  camera.position.set(1.5,2,5);controls.target.set(0,0,0);controls.update();
}
function tickDemo(dt){
  demoT+=dt;
  if(demoT>=1.4){
    demoT=0;
    const free=arrows.filter(a=>a.state==='idle'&&!blocked(a));
    if(free.length){const a=free[Math.floor(Math.random()*free.length)];a.state='moving';a.prog=0;}
    if(arrows.every(a=>a.state==='escaped')){demoIdx++;initDemo();}
  }
  arrows.forEach(a=>tickArrow(a,dt*1.1));
}

// ══════════════════════════════════════════════════
// LEVEL LOAD
// ══════════════════════════════════════════════════
function loadLevel(i){
  if(typeof _clearBossRound==='function')_clearBossRound();
  lvIdx=i;const lv=getLevel(i);
  maxLiv=4;lives=maxLiv;
  selId=null;lastId=null;escaped=0;phase='playing';
  _startReplaySession({kind:'single',levelIndex:i,mode:typeof _currentDiff!=='undefined'?_currentDiff:'normal',total:lv.length});
  controls.autoRotate=false;
  spawnArrows(lv,activeSkin);
  const sp=Math.sqrt(lv.length)*GRID;
  const cen1=new THREE.Vector3();arrows.forEach(a=>cen1.add(a.bp));cen1.divideScalar(arrows.length);
  const portrait1=innerHeight>innerWidth*1.1;
  camera.position.set(cen1.x,cen1.y+sp*.5,cen1.z+(portrait1?sp*2.5+5.5:sp*1.9+3.5));
  controls.target.copy(cen1);controls.update();
  idleT=0;hudOn=true;
  showUI('hud');
  document.getElementById('multi-hud').classList.remove('on');
  document.getElementById('launch-btn').style.display='none';
  document.getElementById('hud').style.opacity='1';
  document.getElementById('tap-restore').style.opacity='0';
  document.getElementById('exit-btn').style.display='flex';
  updateHUD();
  if(i===0){
    phase='story';
    // 스토리 대화 중에는 화살표 숨김 → 대화 완료 후 startOpening()에서 visible=true로 복구
    arrows.forEach(a=>{a.root.visible=false;});
    showStoryDialogue(0,()=>{phase='playing';startOpening();});
  }else{startOpening();}
  // ── Boss round trigger (solo play only) ──
  if(!dungeonState&&!infState&&!(typeof specialMode!=='undefined'&&specialMode)&&_bossLevelSet.has(i)){
    setTimeout(_startBossRound,1100);
  }
  if(i>=progress){progress=i;doSave();}
}

// ══════════════════════════════════════════════════
// UI SCREENS
// ══════════════════════════════════════════════════
function showUI(which){
  document.getElementById('menu').classList.add('hidden');
  document.getElementById('hud').style.display='none';
  document.getElementById('win-ov').style.display='none';
  document.getElementById('over-ov').style.display='none';
  document.getElementById('history-ov').classList.remove('on');
  document.getElementById('replay-ov').classList.remove('on');
  document.getElementById('shop').classList.remove('on');
  document.getElementById('coin-pill').style.display='none';
  document.getElementById('exit-btn').style.display='none';
  document.getElementById('multi-screen').classList.remove('on');
  document.getElementById('multi-result').classList.remove('on');
  document.getElementById('multi-mode-card').style.display='none';
  document.getElementById('rank-lobby-card').style.display='none';
  document.getElementById('rank-mode-select-card').style.display='none';
  document.getElementById('blast-rank-lobby-card').style.display='none';
  document.getElementById('multi-entry-card').style.display='none';
  document.getElementById('multi-lobby-card').style.display='none';
  document.getElementById('game-select').classList.remove('on');
  document.getElementById('flight-game').classList.remove('on');
  // Reset #ui pointer-events to CSS default (none) for normal game states
  document.getElementById('ui').style.pointerEvents='';
  // Always hide user-pill; show only on menu if logged in
  const upill=document.getElementById('user-pill');
  if(upill)upill.style.display='none';
  if(which==='hub'){
    document.getElementById('game-select').classList.add('on');
    document.getElementById('ui').style.pointerEvents='auto';
  }else if(which==='menu'){
    document.getElementById('menu').classList.remove('hidden');
    document.getElementById('coin-pill').style.display='flex';
    if(upill&&upill.dataset.loggedIn==='1')upill.style.display='flex';
  }else if(which==='hud'){
    document.getElementById('hud').style.display='block';
    document.getElementById('exit-btn').style.display='flex';
  }else if(which==='win'){
    document.getElementById('win-ov').style.display='flex';
  }else if(which==='over'){
    document.getElementById('over-ov').style.display='flex';
  }else if(which==='history'){
    document.getElementById('history-ov').classList.add('on');
    document.getElementById('ui').style.pointerEvents='auto';
  }else if(which==='replay'){
    document.getElementById('replay-ov').classList.add('on');
    document.getElementById('ui').style.pointerEvents='auto';
  }else if(which==='shop'){
    document.getElementById('shop').classList.add('on');
  }else if(which==='multi-mode'){
    document.getElementById('multi-screen').classList.add('on');
    document.getElementById('multi-mode-card').style.display='block';
    // iOS: #ui has pointer-events:none in CSS; override so child buttons receive touch events
    document.getElementById('ui').style.pointerEvents='auto';
  }else if(which==='rank-mode-select'){
    document.getElementById('multi-screen').classList.add('on');
    document.getElementById('rank-mode-select-card').style.display='block';
    document.getElementById('ui').style.pointerEvents='auto';
  }else if(which==='rank-lobby'){
    document.getElementById('multi-screen').classList.add('on');
    document.getElementById('rank-lobby-card').style.display='block';
    document.getElementById('ui').style.pointerEvents='auto';
  }else if(which==='blast-rank-lobby'){
    document.getElementById('multi-screen').classList.add('on');
    document.getElementById('blast-rank-lobby-card').style.display='block';
    document.getElementById('ui').style.pointerEvents='auto';
  }else if(which==='multi-entry'){
    document.getElementById('multi-screen').classList.add('on');
    document.getElementById('multi-entry-card').style.display='block';
    document.getElementById('ui').style.pointerEvents='auto';
  }else if(which==='multi-lobby'){
    document.getElementById('multi-screen').classList.add('on');
    document.getElementById('multi-lobby-card').style.display='block';
    document.getElementById('ui').style.pointerEvents='auto';
  }else if(which==='multi-result'){
    document.getElementById('multi-result').classList.add('on');
    // iOS: ensure buttons in multi-result receive touch events
    document.getElementById('ui').style.pointerEvents='auto';
    // Star Drop 버튼 표시 (딜레이로 결과 먼저 보여주기)
    setTimeout(function(){var b=document.getElementById('btn-crosis-gacha');if(b)b.style.display='';},400);
  }else if(which==='flight'){
    document.getElementById('flight-game').classList.add('on');
  }
}

function updateHUD(){
  document.getElementById('lives-txt').textContent='❤️'.repeat(lives)+'🖤'.repeat(Math.max(0,maxLiv-lives));
  document.getElementById('level-txt').textContent=`레벨 ${lvIdx+1}`;
  document.getElementById('hud-coin-val').textContent=coins;
  document.getElementById('pfill').style.width=(escaped/arrows.length*100)+'%';
  // 체력 1개 위험 효과
  const _dv=document.getElementById('danger-vignette');
  if(_dv){if(lives===1&&maxLiv>1){_dv.classList.add('on');if(typeof bgm!=='undefined')bgm.playbackRate=1.35;}else{_dv.classList.remove('on');if(typeof bgm!=='undefined')bgm.playbackRate=1.0;}}
}
function updateCoins(){
  document.getElementById('coin-val').textContent=coins;
  document.getElementById('hud-coin-val').textContent=coins;
  const s=document.getElementById('shop-coin-val');if(s)s.textContent=coins;
}

// ══════════════════════════════════════════════════
// WIN / OVER
// ══════════════════════════════════════════════════
function checkWin(){if(arrows.every(a=>a.state==='escaped'))endGame(true);}
function endGame(won){
  resetComboSound();
  if(typeof _clearBossRound==='function')_clearBossRound();
  const _dv2=document.getElementById('danger-vignette');if(_dv2)_dv2.classList.remove('on');
  if(typeof bgm!=='undefined')bgm.playbackRate=1.0;
  if(!won&&_activeReplay)_finishReplaySession('loss');
  // ── 던전 모드 ─────────────────────────────────────
  if(typeof dungeonState!=='undefined'&&dungeonState){
    if(won){const r=reward(dungeonState.rooms[dungeonState.room],lives,maxLiv);if(_activeReplay)_activeReplay.coins=r;_finishReplaySession('clear');dungeonOnWin(r);}
    else{dungeonBest=Math.max(dungeonBest,dungeonState.room);saveDungeonBest();dungeonState=null;
      popup('💀 던전 실패...',innerWidth/2,innerHeight*.4,'#ff6b6b');
      phase='over';clearPreview();document.getElementById('exit-btn').style.display='none';showUI('over');}
    return;
  }
  // ── 무한 모드 ─────────────────────────────────────
  if(typeof infState!=='undefined'&&infState){
    if(won){const r=reward(infState.level,lives,maxLiv);if(_activeReplay)_activeReplay.coins=r;_finishReplaySession('clear');infOnWin(r);}
    else{infState.mistakes++;popup('💥 실수! 계속...',innerWidth/2,innerHeight*.4,'#ff6b6b');
      setTimeout(()=>loadInfLevel(),900);}
    return;
  }
  // ── 특수 스테이지 ─────────────────────────────────
  if(typeof specialMode!=='undefined'&&specialMode){
    const sm=specialMode;specialMode=null;
    const st=document.getElementById('special-timer');if(st)st.style.display='none';
    if(won){
      if(sm.noMiss&&lives<maxLiv){popup('💥 완벽 클리어 실패!',innerWidth/2,innerHeight*.4,'#ff6b6b');}
      else{coins+=sm.reward;doSave();updateCoins();popup(`⚡ 특수 클리어! +${sm.reward}💰`,innerWidth/2,innerHeight*.35,'#4cc9f0');
        _achStat('perfectClears',1,true);_missionProg('nomiss',1);}
    }
    // fall through to normal win/over UI
  }
  // ── 일반 모드: 통계 & 미션 ────────────────────────
  if(won){
    _achStat('totalClears',1,true);
    _achStat('maxLevel',lvIdx+1,false,true);
    if(lives>=maxLiv)_achStat('perfectClears',1,true);
    const r0=reward(lvIdx,lives,maxLiv);
    _achStat('totalCoinsEarned',r0,true);
    saveAchievements();checkAchievements();
    _missionProg('levels',1);
    if(lives>=maxLiv)_missionProg('nomiss',1);
    _missionProg('coinsEarned',r0);
    checkTierReward();
  }
  phase=won?'win':'over';clearPreview();
  document.getElementById('exit-btn').style.display='none';
  if(typeof _addBPXP==='function'){var _bpDm={easy:0.7,normal:1,hard:1.5,extreme:2}[typeof _currentDiff!=='undefined'?_currentDiff:'normal']||1;setTimeout(function(){_addBPXP(Math.round(40*_bpDm));popup('+'+Math.round(40*_bpDm)+' BP XP',innerWidth/2,innerHeight*.42,'#7b2ff7');},450);}
  if(!won){showUI('over');return;}
  const stars=lives>=maxLiv?3:lives>0?2:1;
  const prev=clearedLevels[lvIdx]||0;
  if(stars>prev)clearedLevels[lvIdx]=stars;
  const r=reward(lvIdx,lives,maxLiv);coins+=r;doSave();updateCoins();
  if(_activeReplay){_activeReplay.coins=r;_finishReplaySession('clear');}
  if(typeof _addBPXP==='function'){var _bpDm2={easy:0.7,normal:1,hard:1.5,extreme:2}[typeof _currentDiff!=='undefined'?_currentDiff:'normal']||1;var _bpXp=Math.round(120*_bpDm2);setTimeout(function(){_addBPXP(_bpXp);popup('+'+_bpXp+' BP XP',innerWidth/2,innerHeight*.42,'#7b2ff7');},500);}
  popup(`+${r} 💰`,innerWidth/2,innerHeight*.45);
  document.getElementById('w-stars').textContent='⭐'.repeat(stars)+'☆'.repeat(3-stars);
  document.getElementById('w-coins').textContent=`+${r} 💰`;
  document.getElementById('w-sub').textContent=`레벨 ${lvIdx+1} 클리어! 생명 ${lives}/${maxLiv} 남음`;
  const _si=lvIdx+1;
  if(_si%3===0){
    // 3라운드마다 에로의 '어둠에 감염된 화살표' 스토리
    const _dIdx=Math.floor(_si/3)-1;
    setTimeout(()=>showDarkArrowStory(_dIdx,()=>showUI('win')),650);
  }else if(_STORY&&_STORY[_si]&&_STORY[_si].trigger==='clear'){
    setTimeout(()=>showStoryDialogue(_si,()=>showUI('win')),650);
  }else{showUI('win');}
}

// ══════════════════════════════════════════════════
// POPUP
// ══════════════════════════════════════════════════
function popup(txt,cx,cy,col='#FFD700'){
  const el=document.createElement('div');
  el.className='popup';el.textContent=txt;el.style.color=col;
  Object.assign(el.style,{left:cx+'px',top:cy+'px',transform:'translate(-50%,-50%)'});
  document.body.appendChild(el);
  requestAnimationFrame(()=>requestAnimationFrame(()=>{Object.assign(el.style,{transform:'translate(-50%,-220%)',opacity:'0'});}));
  setTimeout(()=>el.remove(),1500);
}

// ══════════════════════════════════════════════════
// IDLE
// ══════════════════════════════════════════════════
function resetIdle(){
  idleT=0;
  if(!hudOn&&(phase==='playing'||phase==='multi-playing')){hudOn=true;document.getElementById('hud').style.opacity='1';document.getElementById('tap-restore').style.opacity='0';controls.autoRotate=false;}
}
// Pulse arrows and show JUST window indicator
let _hintT=0;
function tickFreeHint(dt){
  _hintT+=dt;
  arrows.forEach(a=>{
    if(a.state!=='idle')return;
    if(a.id===selId)return;
    a.parts.forEach(p=>{
      if(!p.material||!p.material.emissive)return;
      // 발광/깜빡임/어두워짐 완전 제거 (발광 안 되게 0으로 고정)
      p.material.emissiveIntensity=0;
    });
    if(a.ring)a.ring.visible=false;
  });
}

function tickIdle(dt){
  if(phase!=='playing'&&phase!=='multi-playing')return;
  idleT+=dt;
  if(idleT>=5&&hudOn&&(typeof _settings==='undefined'||_settings.hudAutoHide)){hudOn=false;document.getElementById('hud').style.opacity='0';document.getElementById('tap-restore').style.opacity='1';controls.autoRotate=false;}
}

// ══════════════════════════════════════════════════
// SHOP
// ══════════════════════════════════════════════════
let shopTab='skin';
window.setShopTab=function(tab){
  shopTab=tab;
  document.getElementById('tab-skin').classList.toggle('on',tab==='skin');
  document.getElementById('tab-map').classList.toggle('on',tab==='map');
  document.getElementById('skin-grid').classList.toggle('hidden',tab!=='skin');
  document.getElementById('map-grid').classList.toggle('hidden',tab!=='map');
};
const RARITY_COLOR={common:'#aaa',rare:'#4cc9f0',epic:'#a855f7',legendary:'#FFD700'};
const RARITY_LABEL={common:'일반',rare:'✦ 희귀',epic:'✦✦ 에픽',legendary:'✦✦✦ 전설'};
function renderShopGrid(){
  updateCoins();
  const sg=document.getElementById('skin-grid');sg.innerHTML='';
  SKINS.forEach(s=>{
    const ow=owned.has(s.id),eq=activeSkin===s.id;
    const isGacha=!!s.gacha;
    const rv=s.rarity||'common';
    const rc=RARITY_COLOR[rv];
    const rl=RARITY_LABEL[rv];
    const card=document.createElement('div');
    card.className='sk'+(eq?' eq':ow?' own':isGacha&&!ow?' gacha-locked':'');
    card.innerHTML=`<span class="sk-ico">${s.emoji}</span><div class="sk-name">${s.name}</div><div class="sk-desc">${s.desc}</div><div class="sk-rarity-badge" style="color:${rc};font-size:9px;font-weight:900;margin-bottom:4px;letter-spacing:1px">${rl}</div><div class="sk-price ${s.pc}">${isGacha&&!ow?'크로시스 가챠 전용':s.price===0?'무료':s.price+' 💰'}</div>${eq?'<span class="sk-badge b-eq">장착중</span>':ow?'<span class="sk-badge b-own">보유</span>':isGacha?'<span class="sk-badge b-gacha">크로시스 가챠</span>':''}${(ow||eq)?`<button class="sk-info-btn" onclick="event.stopPropagation();openSkinDetail('${s.id}')">📅 정보</button>`:''}`;
    card.onclick=()=>skinTap(s.id);sg.appendChild(card);
  });
  const mg=document.getElementById('map-grid');mg.innerHTML='';
  MAPS.forEach(m=>{const ow=ownedMaps.has(m.id),eq=activeMap===m.id;const isGacha=!!m.gacha;const card=document.createElement('div');card.className='sk'+(eq?' eq':ow?' own':isGacha&&!ow?' gacha-locked':'');card.innerHTML=`<span class="sk-ico">${m.emoji}</span><div class="sk-name">${m.name}</div><div class="sk-desc">${m.desc}</div><div class="sk-price ${m.pc}">${isGacha&&!ow?'가챠 전용':m.price===0?'무료':m.price+' 💰'}</div>${eq?'<span class="sk-badge b-eq">장착중</span>':ow?'<span class="sk-badge b-own">보유</span>':isGacha?'<span class="sk-badge b-gacha">가챠</span>':''}`;card.onclick=()=>mapTap(m.id);mg.appendChild(card);});
}
function skinTap(id){const s=SKINS.find(x=>x.id===id);if(!s)return;if(!owned.has(id)){if(coins<s.price){popup('코인 부족 😢',innerWidth/2,innerHeight*.5,'#ff6b6b');return;}coins-=s.price;owned.add(id);recordSkinDate(id);doSave();}activeSkin=id;doSave();renderShopGrid();updateCoins();}
function openSkinDetail(id){
  const s=SKINS.find(x=>x.id===id);if(!s)return;
  const RARITY_MAP={common:{label:'일반',col:'#aaa'},rare:{label:'✦ 희귀',col:'#4cc9f0'},epic:{label:'✦✦ 에픽',col:'#a855f7'},legendary:{label:'✦✦✦ 전설',col:'#FFD700'}};
  const rv=RARITY_MAP[s.rarity||'common'];
  const ts=skinDates[id];
  const dateStr=ts?new Date(ts).toLocaleDateString('ko-KR',{year:'numeric',month:'long',day:'numeric'}):'알 수 없음';
  const el=document.getElementById('skin-detail-modal');
  document.getElementById('sdm-emoji').textContent=s.emoji;
  document.getElementById('sdm-name').textContent=s.name;
  document.getElementById('sdm-rarity').textContent=rv.label;
  document.getElementById('sdm-rarity').style.color=rv.col;
  document.getElementById('sdm-date').textContent='📅 획득일: '+dateStr;
  el.style.display='flex';
}
function mapTap(id){const m=MAPS.find(x=>x.id===id);if(!m)return;if(!ownedMaps.has(id)){if(coins<m.price){popup('코인 부족 😢',innerWidth/2,innerHeight*.5,'#ff6b6b');return;}coins-=m.price;ownedMaps.add(id);doSave();}applyMap(id);renderShopGrid();updateCoins();if(phase==='menu'||phase==='shop')initDemo();}

// ══════════════════════════════════════════════════
// LEVEL SELECT
// ══════════════════════════════════════════════════
let lsTab='all';
function openLevelSelect(){
  const el=document.getElementById('level-select');
  el.style.display='flex';el.getBoundingClientRect();el.classList.add('open');
  lsTab='all';setLsTab('all',false);renderLevelGrid();
}
function closeLevelSelect(){
  const el=document.getElementById('level-select');
  el.style.transition='transform .38s cubic-bezier(0.25,0.46,0.45,0.94)';
  el.style.transform='translateX(100%)';el.classList.remove('open');
  setTimeout(()=>{el.style.display='none';el.style.transform='';},400);
}
window.setLsTab=function(tab,render=true){
  lsTab=tab;
  ['all','clear','todo'].forEach(t=>document.getElementById('lst-'+t).classList.toggle('on',t===tab));
  document.getElementById('ls-search').value='';document.getElementById('ls-sclear').style.display='none';
  if(render)renderLevelGrid();
};
function diffLabel(i){const l=diffConfig(i).label;return l==='easy'?'<span class="diff-badge diff-easy">쉬움</span>':l==='med'?'<span class="diff-badge diff-med">보통</span>':l==='hard'?'<span class="diff-badge diff-hard">어려움</span>':'<span class="diff-badge diff-ext">극한</span>';}
function renderLevelGrid(){
  const grid=document.getElementById('ls-grid');
  const empty=document.getElementById('ls-empty');
  const search=(document.getElementById('ls-search').value||'').trim();
  const maxAvail=progress;
  const items=[];
  for(let i=0;i<=maxAvail+1;i++){
    const locked=i>maxAvail;const cleared=!locked&&(clearedLevels[i]!=null);const avail=!locked&&!cleared;
    if(lsTab==='clear'&&!cleared)continue;if(lsTab==='todo'&&(cleared||locked))continue;
    if(search){const num=parseInt(search);if(isNaN(num)||i+1!==num)continue;}
    items.push({i,locked,cleared,stars:clearedLevels[i]||0});
  }
  const totalPlay=maxAvail+1;
  const nCleared=Object.keys(clearedLevels).filter(k=>parseInt(k)<=maxAvail).length;
  document.getElementById('ls-stat').textContent=`${nCleared} / ${totalPlay} 클리어`;
  grid.innerHTML='';
  if(items.length===0){empty.style.display='flex';grid.style.display='none';}
  else{empty.style.display='none';grid.style.display='grid';}
  items.forEach(({i,locked,cleared,stars})=>{
    const n=getLevelArrowCount(i);
    const starsStr=cleared?'⭐'.repeat(stars)+'☆'.repeat(3-stars):'';
    const badgeClass=cleared?'lvcb-cl':locked?'lvcb-lk':'lvcb-av';
    const badgeTxt=cleared?'클리어':locked?'🔒잠김':'도전!';
    const cardClass=cleared?'lvc-cleared':locked?'lvc-locked':'lvc-avail';
    const card=document.createElement('div');
    card.className=`lv-card ${cardClass}`;
    card.innerHTML=`
      <span class="lvc-best">${cleared?stars+'성':''}</span>
      ${diffLabel(i)}
      <div class="lvc-top">${starsStr||(locked?'🔒':'')}</div>
      <div class="lvc-num">${i+1}</div>
      <div class="lvc-meta">Lv.${i+1} · ${n}개</div>
      <div class="lvc-badge ${badgeClass}">${badgeTxt}</div>`;
    if(!locked){card.onclick=()=>{closeLevelSelect();setTimeout(()=>loadLevel(i),420);};}
    grid.appendChild(card);
  });
}

// Swipe right to close
(()=>{
  const el=document.getElementById('level-select');
  let sx=null,sy=null,dragging=false;
  el.addEventListener('touchstart',e=>{if(e.target.closest('#ls-grid,#ls-scroll'))return;sx=e.touches[0].clientX;sy=e.touches[0].clientY;dragging=false;},{passive:true});
  el.addEventListener('touchmove',e=>{if(sx===null)return;const dx=e.touches[0].clientX-sx,dy=Math.abs(e.touches[0].clientY-sy);if(!dragging&&dy>20){sx=null;return;}if(dx>10){dragging=true;}if(dragging&&dx>0){el.style.transition='none';el.style.transform=`translateX(${dx}px)`;}},{passive:true});
  el.addEventListener('touchend',e=>{if(sx===null)return;const dx=e.changedTouches[0].clientX-sx;sx=null;if(dragging&&dx>75){closeLevelSelect();}else{el.style.transition='transform .3s';el.style.transform='translateX(0)';}dragging=false;},{passive:true});
})();

document.getElementById('ls-search').addEventListener('input',function(){document.getElementById('ls-sclear').style.display=this.value?'block':'none';renderLevelGrid();});
document.getElementById('ls-sclear').addEventListener('click',function(){document.getElementById('ls-search').value='';this.style.display='none';renderLevelGrid();});

// ══════════════════════════════════════════════════
// MULTIPLAYER  (WebSocket relay)
// ══════════════════════════════════════════════════
let multiWs=null;
let multiCode='';
let multiRole=null; // 'host'|'guest'
let multiMyEscaped=0;
let multiOpEscaped=0;
let multiTotal=0;
let multiMyFinishTime=null;
let multiOpFinishTime=null;
let multiStartTime=null;
let multiOpDone=false;
let multiOpAlive=false;
let multiMode='general';
let multiBlockCount=0;
let multiLives=5;
let rankBotTimer=null;
let rankBotTargetTime=null;
let rankBotPlan=[];
let rankBotPlanIndex=0;

const RANK_SAVE_KEY='three-d-escape-rank-v1';
const RANK_TIERS=[
  {id:'bronze',name:'브론즈',min:0,color:'#c4874d',symbol:'◆'},
  {id:'silver',name:'실버',min:120,color:'#c7d3e6',symbol:'◇'},
  {id:'gold',name:'골드',min:260,color:'#ffd060',symbol:'✦'},
  {id:'platinum',name:'플레티넘',min:420,color:'#5fe6d2',symbol:'✧'},
  {id:'diamond',name:'다이아몬드',min:580,color:'#75a7ff',symbol:'✹'},
  {id:'crossis',name:'크로시스',min:740,color:'#ef7cff',symbol:'✷'}
];
let rankState=loadRankState();
let rankHumanMatch=false;

// Render relay server — default for all non-dev hosts (GitHub Pages, etc.)
const RENDER_WS='wss://threed-escape0.onrender.com';

function getAutoWsUrl(){
  if(location.protocol==='file:')return null;
  const h=location.host;
  // Auto-detect only for hosts that are expected to provide /api/ws.
  if(h.includes('.replit.')||h.includes('.repl.co')||h.includes('.replit.app')){
    const proto=location.protocol==='https:'?'wss:':'ws:';
    return proto+'//'+h+'/api/ws';
  }
  return null;
}

function openMultiplayer(){
  phase='multi-mode';
  closeMultiWs();
  clearRankBot();
  clearBlastRankTimer();
  updateRankLobby();
  showUI('multi-mode');
}

function getQuickMatchCode(){
  const window=Math.floor(Date.now()/15000);
  return String(((window*7919+1234)%9000)+1000);
}

function startQuickMatch(){
  const code=getQuickMatchCode();
  const serverUrl=getAutoWsUrl()||RENDER_WS;
  multiMode='general';
  multiCode=code;
  multiRole=null;
  multiOpAlive=false;
  closeMultiWs();
  document.getElementById('multi-code-display').textContent=code;
  document.getElementById('multi-lobby-title').textContent='자동 매칭 중';
  document.getElementById('multi-status').innerHTML='<span class="multi-wait-dots">상대방 찾는 중<span>.</span><span>.</span><span>.</span></span><br><span style="font-size:11px;color:rgba(200,160,240,0.5)">같은 시간대 코드: '+code+'</span>';
  phase='multi-entry';
  showUI('multi-lobby');
  const ws=new WebSocket(serverUrl);
  multiWs=ws;
  ws.onopen=()=>{ws.send(JSON.stringify({type:'join',code}));};
  ws.onmessage=(ev)=>{let msg;try{msg=JSON.parse(ev.data);}catch{return;}handleMultiMsg(msg);};
  ws.onerror=()=>{popup('서버 연결 실패!',innerWidth/2,innerHeight*.45,'#ff6b6b');showUI('multi-entry');};
  ws.onclose=()=>{if(phase==='multi-playing'||phase==='multi-done'){handleOpponentDisconnect();}};
}

function startGeneralAiMatch(){
  multiMode='general-ai';
  multiCode=String(Math.floor(1000+Math.random()*9000));
  multiRole='rank-ai';
  multiOpAlive=true;
  closeMultiWs();
  clearRankBot();
  startMultiCountdown();
}

function startRankHumanMatch(){
  rankHumanMatch=true;
  multiMode='rank';
  // Use tier-aware code for same-tier matchmaking
  const code=getTierRankMatchCode(rankState,RANK_TIERS);
  const serverUrl=getAutoWsUrl()||RENDER_WS;
  multiCode=code;
  multiRole=null;
  multiOpAlive=false;
  closeMultiWs();
  document.getElementById('multi-code-display').textContent=code;
  document.getElementById('multi-lobby-title').textContent='랭크 사람 매칭 중';
  const tierName=getRankTier().name;
  document.getElementById('multi-status').innerHTML='<span class="multi-wait-dots">'+tierName+' 티어 상대 찾는 중<span>.</span><span>.</span><span>.</span></span>';
  phase='rank-lobby';
  showUI('multi-lobby');
  const ws=new WebSocket(serverUrl);
  multiWs=ws;
  ws.onopen=()=>{ws.send(JSON.stringify({type:'join',code}));};
  ws.onmessage=(ev)=>{let msg;try{msg=JSON.parse(ev.data);}catch{return;}handleMultiMsg(msg);};
  ws.onerror=()=>{popup('서버 연결 실패!',innerWidth/2,innerHeight*.45,'#ff6b6b');showUI('rank-lobby');};
  ws.onclose=()=>{if(phase==='multi-playing'||phase==='multi-done'){handleOpponentDisconnect();}};
}

function openGeneralMultiplayer(){
  multiMode='general';
  phase='multi-entry';
  clearRankBot();
  showUI('multi-entry');
  ['cd0','cd1','cd2','cd3'].forEach(id=>{document.getElementById(id).value='';});
  const urlInput=document.getElementById('multi-server-url');
  if(urlInput){urlInput.value=getAutoWsUrl()||RENDER_WS;}
}

function openRankLobby(){
  closeMultiWs();
  clearRankBot();
  clearBlastRankTimer();
  updateRankLobby();
  updateBlastRankLobby();
  phase='rank-mode-select';
  showUI('rank-mode-select');
}

function openEscapeRankLobby(){
  multiMode='rank';
  phase='rank-lobby';
  closeMultiWs();
  clearRankBot();
  updateRankLobby();
  showUI('rank-lobby');
}

function openBlastRankLobby(){
  multiMode='blast-rank';
  phase='blast-rank-lobby';
  closeMultiWs();
  clearRankBot();
  clearBlastRankTimer();
  updateBlastRankLobby();
  showUI('blast-rank-lobby');
}

// Tier bracket for same-tier human matchmaking
function getRankTierBracket(state, tiers){
  const pts=(state&&state.points)||0;
  let t=tiers[0];
  for(const x of tiers){if(pts>=x.min)t=x;}
  const ti=Math.max(0,Math.min(5,tiers.findIndex(x=>x.id===t.id)));
  return Math.floor(ti/2); // 0=bronze/silver, 1=gold/plat, 2=diamond/crossis
}

function getTierRankMatchCode(state, tiers){
  const bracket=getRankTierBracket(state,tiers);
  const w=Math.floor(Date.now()/20000);
  return String(((w*7919+1234+bracket*3001)%9000)+1000);
}

function getRankDefaults(){
  return {placements:0,placementWins:0,placementScore:0,points:0,placed:false,matches:0};
}

function loadRankState(){
  try{
    const raw=localStorage.getItem(RANK_SAVE_KEY);
    if(!raw)return getRankDefaults();
    const data=JSON.parse(raw);
    return {...getRankDefaults(),...data};
  }catch{
    return getRankDefaults();
  }
}

function saveRankState(){
  try{localStorage.setItem(RANK_SAVE_KEY,JSON.stringify(rankState));}catch{}
  if(_fbUser)fbCloudSave();
}

function getRankTier(points=rankState.points){
  let tier=RANK_TIERS[0];
  for(const t of RANK_TIERS){if(points>=t.min)tier=t;}
  return tier;
}

function getNextRankTier(points=rankState.points){
  return RANK_TIERS.find(t=>t.min>points)||null;
}

function updateRankLobby(){
  const tier=getRankTier();
  const next=getNextRankTier();
  const emblem=document.getElementById('rank-emblem');
  const kicker=document.getElementById('rank-kicker');
  const title=document.getElementById('rank-title');
  const desc=document.getElementById('rank-copy');
  const points=document.getElementById('rank-points');
  const fill=document.getElementById('rank-progress-fill');
  const start=document.getElementById('rank-start-btn');
  if(!emblem||!title)return;
  emblem.textContent=tier.symbol;
  emblem.style.background=`linear-gradient(135deg,${tier.color},#ffffff)`;
  if(rankState.placed){
    kicker.textContent='RANKED PLAY';
    title.textContent=tier.name;
    desc.textContent=next?`${next.name}까지 ${next.min-rankState.points}점 남았습니다.`:'최고 티어 크로시스에 도달했습니다.';
    points.textContent=`${rankState.points}점 · ${rankState.matches}판 플레이`;
    if(next){
      const prev=tier.min;
      fill.style.width=Math.max(5,Math.min(100,(rankState.points-prev)/(next.min-prev)*100))+'%';
    }else{
      fill.style.width='100%';
    }
    start.textContent='🤖 AI와 랭크 대결';
    // Difficulty info box
    const diffBox=document.getElementById('rank-diff-box');
    if(diffBox){
      diffBox.style.display='block';
      const ti=Math.max(0,Math.min(5,RANK_TIERS.findIndex(t=>t.id===tier.id)));
      document.getElementById('rd-arrows').textContent=RANK_ARROW_COUNTS[ti]+'개';
      const b=RANK_BOT_BASES[ti],j=RANK_BOT_JITTER[ti];
      document.getElementById('rd-aispeed').textContent=`${b-Math.floor(j/2)}~${b+Math.floor(j/2)}초`;
      const lossMin=rankState.placed?(20+ti*2):5;
      document.getElementById('rd-loss').textContent=`-${lossMin}~-24 RP`;
    }
  }else{
    kicker.textContent='RANKED PLACEMENT';
    title.textContent='배치고사';
    desc.textContent='AI와 5번 대결하면 첫 티어가 열립니다.';
    points.textContent=`배치 ${rankState.placements}/5 · 승리 ${rankState.placementWins}회`;
    fill.style.width=(rankState.placements/5*100)+'%';
    start.textContent=rankState.placements>0?'배치고사 계속':'배치고사 시작';
  }
}

function randomRankCode(){
  return String(Math.floor(1000+Math.random()*9000));
}

function startRankMatch(){
  rankHumanMatch=false;
  multiMode='rank';
  multiCode=randomRankCode();
  multiRole='rank-ai';
  multiOpAlive=true;
  closeMultiWs();
  clearRankBot();
  startMultiCountdown();
}

function clearRankBot(){
  if(rankBotTimer){clearInterval(rankBotTimer);rankBotTimer=null;}
  rankBotPlan=[];
  rankBotPlanIndex=0;
}

// Per-tier AI clear speed (seconds). Index 0=Bronze … 5=Crossis.
// The bot uses a solve plan below instead of a slow linear progress bar:
// it opens quickly, solves in short bursts, and becomes more consistent per tier.
const RANK_BOT_BASES  =[58, 51, 45, 40, 35, 31];
const RANK_BOT_JITTER =[  8,  7,  6,  5,  4,  3];

function getRankBotTargetTime(){
  if(multiMode==='general-ai'){
    // General AI: a capable opponent without rank-tier scaling.
    return Math.max(32,Math.round((52+Math.random()*10-5)*100)/100);
  }
  const tierIndex=Math.max(0,Math.min(5,RANK_TIERS.findIndex(t=>t.id===getRankTier().id)));
  if(!rankState.placed){
    // Placement matches ramp up gently so new players get a fair first game.
    const base=64-Math.min(rankState.placements,4)*3; // 64→52 over 5 games
    return Math.max(42,Math.round((base+Math.random()*10-5)*100)/100);
  }
  const base  =RANK_BOT_BASES [tierIndex];
  const jitter=RANK_BOT_JITTER[tierIndex];
  return Math.max(35,Math.round((base+Math.random()*jitter-jitter/2)*100)/100);
}

// Per-tier level sizes: Bronze=12 (3×2×2) … Crossis=60 (5×4×3)
const RANK_ARROW_COUNTS=[12, 18, 24, 36, 48, 55];

function getRankArrowCount(){
  if(!rankState.placed)return 12; // placement matches always use Bronze size
  const tierIndex=Math.max(0,Math.min(5,RANK_TIERS.findIndex(t=>t.id===getRankTier().id)));
  return RANK_ARROW_COUNTS[tierIndex];
}

function startRankBot(){
  if(multiMode!=='rank'&&multiMode!=='general-ai')return;
  clearRankBot();
  rankBotTargetTime=getRankBotTargetTime();
  rankBotPlan=[];
  rankBotPlanIndex=0;
  const step=rankBotTargetTime/Math.max(1,multiTotal);
  for(let i=0;i<multiTotal;i++){
    // Small human-like variance, while keeping the final completion time exact.
    const variance=step*(0.72+Math.random()*0.5);
    const previous=rankBotPlan[i-1]||0;
    rankBotPlan.push(Math.min(rankBotTargetTime,previous+variance));
  }
  rankBotPlan[rankBotPlan.length-1]=rankBotTargetTime;
  const started=Date.now();
  rankBotTimer=setInterval(()=>{
    if(phase!=='multi-playing'&&phase!=='multi-done'){clearRankBot();return;}
    const elapsed=(Date.now()-started)/1000;
    if(elapsed>=rankBotTargetTime){
      multiOpEscaped=multiTotal;
      multiOpFinishTime=rankBotTargetTime;
      multiOpDone=true;
      clearRankBot();
      updateMultiHUD();
      // An AI finish is a decided race. Show the result even when the player
      // has not finished yet so losses always go through RP settlement.
      if(phase==='multi-playing'){
        phase='multi-done';
        showMultiResult();
      }else if(multiMyFinishTime!==null){
        showMultiResult();
      }
      return;
    }
    while(rankBotPlanIndex<rankBotPlan.length&&elapsed>=rankBotPlan[rankBotPlanIndex]){
      rankBotPlanIndex++;
    }
    multiOpEscaped=Math.min(multiTotal-1,rankBotPlanIndex);
    updateMultiHUD();
  },120);
}

function getRankDelta(won,myT,opT){
  if(won){
    // Win: +10~30 RP based on how much faster than AI
    const speed=Math.max(0,(opT-myT)/Math.max(opT,1));
    return Math.min(30,Math.max(10,Math.round(12+speed*32)));
  }
  // Loss: if player didn't even finish, harsher penalty
  if(myT===null||myT===0){
    // AI finished, player did not → -20~-30 depending on tier
    const tierIndex=Math.max(0,Math.min(5,RANK_TIERS.findIndex(t=>t.id===getRankTier().id)));
    return -(20+tierIndex*2); // -20 (Bronze) … -30 (Crossis)
  }
  // Player finished but slower: penalty softened by how long they lasted
  const played=Math.max(0,myT);
  const endurance=Math.min(19,Math.floor(played/7)*2);
  return -Math.max(5,24-endurance);
}

function showRankResult(){
  clearRankBot();
  const myT=multiMyFinishTime;
  const opT=rankHumanMatch?(multiOpFinishTime):(multiOpFinishTime!==null?multiOpFinishTime:rankBotTargetTime);
  const won=myT!==null&&(opT===null||myT<opT);
  const delta=getRankDelta(won,myT,opT);
  // Capture state BEFORE mutation for animation
  const _oldPts=rankState.points;
  const _oldTierId=getRankTier().id;
  let title=won?'랭크 승리!':'랭크 패배';
  const oppLabel=rankHumanMatch?'상대':'AI';
  let detail=won?`${oppLabel}보다 ${(opT-myT).toFixed(2)}초 빨랐어요.`:`${oppLabel}보다 ${Math.abs((myT||opT)-opT).toFixed(2)}초 늦었어요.`;

  if(!rankState.placed){
    rankState.placements=Math.min(5,rankState.placements+1);
    if(won)rankState.placementWins++;
    rankState.placementScore+=won?(120+delta*2):Math.max(30,95+delta);
    if(rankState.placements>=5){
      rankState.points=Math.min(900,Math.round(rankState.placementWins*120+rankState.placementScore/5));
      rankState.placed=true;
      const tier=getRankTier();
      title=`${tier.name} 배정!`;
      detail=`배치고사 5판 완료 · ${rankState.points}점으로 ${tier.name} 티어가 열렸습니다.`;
    }else{
      detail+=` 배치 ${rankState.placements}/5 완료, ${5-rankState.placements}판 남았습니다.`;
    }
  }else{
    rankState.points=Math.max(0,rankState.points+delta);
    rankState.matches++;
    const signed=delta>0?`+${delta}`:String(delta);
    detail+=` 점수 ${signed}, 현재 ${rankState.points}점입니다.`;
  }
  saveRankState();
  updateRankLobby();

  // 배틀 결과 서버에 기록 (사람 vs AI, 사람 vs 사람)
  (function(){
    const myName=_settings.nickname||'나';
    const opType=rankHumanMatch?'human':'ai';
    const opName=rankHumanMatch?(window._lastOpponentName||'상대'):'AI';
    const myPtsNow=rankState.points;
    if(won){
      _recordBattleResult(myName,myPtsNow,'human',opName,Math.max(0,myPtsNow-delta),opType);
    }else{
      _recordBattleResult(opName,Math.max(0,myPtsNow+Math.abs(delta)),opType,myName,myPtsNow,'human');
    }
  })();

  // Hide rank score box initially; only show after screen opens
  const _scoreBox=document.getElementById('mr-rank-score');
  if(_scoreBox)_scoreBox.style.display='none';
  document.getElementById('mr-emoji').textContent=won?'🏆':'💔';
  document.getElementById('mr-title').textContent=title;
  document.getElementById('mr-my-time').textContent=myT!==null?myT+'초':'미완';
  document.getElementById('mr-op-time').textContent=opT!==null?opT+'초':'미완';
  document.getElementById('mr-detail').textContent=detail;
  document.getElementById('mr-again').textContent=rankState.placed?'다시 랭크':'다음 배치';
  if(typeof _addBPXP==='function'){var _bpRW=won;setTimeout(function(){var _x=_bpRW?250:100;_addBPXP(_x);popup('+'+_x+' BP XP',innerWidth/2,innerHeight*.42,'#7b2ff7');},450);}
  phase='multi-result';
  document.getElementById('multi-hud').classList.remove('on');
  document.getElementById('pbar').style.display='block';
  showUI('multi-result');
  if(rankState.placed){
    setTimeout(()=>animateRankScore(_oldPts,rankState.points,delta,_oldTierId,getRankTier()),500);
  }
}



// Animated rank score display in result screen
function animateRankScore(fromPts,toPts,delta,oldTierId,newTier){
  const box=document.getElementById('mr-rank-score');
  if(!box)return;
  box.style.display='block';
  const isUp=delta>=0;
  const deltaEl=document.getElementById('mr-rank-delta');
  deltaEl.textContent=(isUp?'+':'')+delta+' RP';
  deltaEl.className='mr-rank-delta '+(isUp?'up':'down');
  // Tier change badge
  const tierEl=document.getElementById('mr-rank-tier-change');
  if(newTier.id!==oldTierId){
    const promoted=RANK_TIERS.findIndex(t=>t.id===newTier.id)>RANK_TIERS.findIndex(t=>t.id===oldTierId);
    tierEl.textContent=promoted?`🎉 ${newTier.name} 승급!`:`↓ ${newTier.name} 강등`;
    tierEl.className=promoted?'up':'down';
    tierEl.style.display='block';
    if(promoted)setTimeout(()=>showTierPromo(newTier.symbol,newTier.name,newTier.color),600);
  }else{tierEl.style.display='none';}
  // Progress bar target
  const next=getNextRankTier(toPts);
  const prev=newTier.min;
  const pct=next?Math.max(3,Math.min(100,(toPts-prev)/(next.min-prev)*100)):100;
  // Points label
  document.getElementById('mr-rank-pts-label').textContent=
    next?`${toPts}점 · ${newTier.name}까지 ${next.min-toPts}점 남음`:`${toPts}점 · 최고 티어`;
  // Counting animation
  const duration=Math.min(1800,Math.max(800,Math.abs(delta)*30));
  const startTime=performance.now();
  const ptEl=document.getElementById('mr-rank-pts-val');
  const fillEl=document.getElementById('mr-rank-fill');
  function tick(now){
    const t=Math.min(1,(now-startTime)/duration);
    const ease=1-Math.pow(1-t,3);
    ptEl.textContent=Math.round(fromPts+(toPts-fromPts)*ease)+'점';
    if(t>=1){
      ptEl.textContent=toPts+'점';
      // Animate progress bar after count finishes
      setTimeout(()=>{ fillEl.style.width=pct+'%'; },50);
    }else{requestAnimationFrame(tick);}
  }
  ptEl.textContent=fromPts+'점';
  fillEl.style.width='0%';
  setTimeout(()=>requestAnimationFrame(tick),300);
}

function getCodeValue(){
  return ['cd0','cd1','cd2','cd3'].map(id=>document.getElementById(id).value||'_').join('');
}

function multiSend(obj){
  if(multiWs&&multiWs.readyState===WebSocket.OPEN){
    multiWs.send(JSON.stringify(obj));
  }
}

function closeMultiWs(){
  if(multiWs){
    multiWs.onclose=null;multiWs.onerror=null;multiWs.onmessage=null;
    multiWs.close();multiWs=null;
  }
}

function joinMultiRoom(){
  const code=getCodeValue();
  if(code.includes('_')||code.length!==4||isNaN(parseInt(code))){
    popup('코드 4자리를 입력하세요!',innerWidth/2,innerHeight*.5,'#ff6b6b');return;
  }
  const serverUrl=(document.getElementById('multi-server-url').value||'').trim()||getAutoWsUrl()||RENDER_WS;
  multiCode=code;
  multiRole=null;
  multiOpAlive=false;
  closeMultiWs();

  document.getElementById('multi-code-display').textContent=code;
  document.getElementById('multi-lobby-title').textContent='연결 중...';
  document.getElementById('multi-status').innerHTML='<span class="multi-wait-dots">서버 연결 중<span>.</span><span>.</span><span>.</span></span>';
  showUI('multi-lobby');

  const ws=new WebSocket(serverUrl);
  multiWs=ws;

  ws.onopen=()=>{
    ws.send(JSON.stringify({type:'join',code}));
  };

  ws.onmessage=(ev)=>{
    let msg;
    try{msg=JSON.parse(ev.data);}catch{return;}
    handleMultiMsg(msg);
  };

  ws.onerror=()=>{
    popup('서버 연결 실패! 서버 주소를 확인하세요.',innerWidth/2,innerHeight*.45,'#ff6b6b');
    showUI('multi-entry');
  };

  ws.onclose=()=>{
    if(phase==='multi-playing'||phase==='multi-done'){
      handleOpponentDisconnect();
    }
  };
}

function handleMultiMsg(msg){
  if(!msg||!msg.type)return;

  if(msg.type==='joined'){
    multiRole=msg.role;
    multiOpAlive=false;
    if(multiRole==='host'){
      document.getElementById('multi-lobby-title').textContent='방 생성됨 (HOST)';
      document.getElementById('multi-status').innerHTML='<span class="multi-wait-dots">상대방 기다리는 중<span>.</span><span>.</span><span>.</span></span>';
    } else {
      document.getElementById('multi-lobby-title').textContent='접속됨! (GUEST)';
      document.getElementById('multi-status').textContent='게임 시작 중...';
    }
  } else if(msg.type==='opponent_joined'){
    multiOpAlive=true;
    document.getElementById('multi-lobby-title').textContent='상대 접속! (HOST)';
    document.getElementById('multi-status').textContent='게임 시작 중...';
    // Tell guest to start countdown at the same time
    setTimeout(()=>{multiSend({type:'start_countdown'});startMultiCountdown();},600);
  } else if(msg.type==='start_countdown'){
    // Relayed from host to guest to sync start
    if(multiRole==='guest'){
      multiOpAlive=true;
      setTimeout(()=>startMultiCountdown(),0);
    }
  } else if(msg.type==='room_full'){
    popup('방이 꽉 찼습니다! 다른 코드를 사용하세요.',innerWidth/2,innerHeight*.45,'#ff6b6b');
    closeMultiWs();
    showUI('multi-entry');
  } else if(msg.type==='progress'){
    multiOpEscaped=msg.escaped;
    updateMultiHUD();
  } else if(msg.type==='finished'){
    multiOpFinishTime=msg.time;
    multiOpDone=true;
    updateMultiHUD();
    if(multiMyFinishTime!==null){showMultiResult();}
    else{popup('상대 완료! 서둘러!',innerWidth/2,innerHeight*.38,'#f72585');}
  } else if(msg.type==='replay_event'){
    if(_activeReplay&&msg.event)_recordReplayEvent(msg.event.type,msg.event,'opponent');
  } else if(msg.type==='again'){
    setTimeout(()=>startMultiCountdown(),400);
  } else if(msg.type==='opponent_disconnected'){
    handleOpponentDisconnect();
  }
}

function handleOpponentDisconnect(){
  popup('상대방 연결이 끊겼습니다.',innerWidth/2,innerHeight*.4,'#ff6b6b');
  if(phase==='multi-playing'||phase==='multi-done'){
    setTimeout(()=>goMenu(),2500);
  }
}

function startMultiCountdown(){
  const cnt=document.getElementById('multi-countdown');
  cnt.classList.add('on');
  const nums=['3','2','1','GO!'];
  let i=0;
  const step=()=>{
    if(i>=nums.length){
      cnt.classList.remove('on');
      startMultiGame();
      return;
    }
    document.getElementById('countdown-num').textContent=nums[i];
    document.getElementById('countdown-num').style.animation='none';
    void document.getElementById('countdown-num').offsetWidth;
    document.getElementById('countdown-num').style.animation='cntPop .6s ease-out';
    i++;
    setTimeout(step,i<nums.length?800:500);
  };
  step();
}

function startMultiGame(){
  const _rankCount=(multiMode==='blast-rank')?getRankArrowCountBlast():(multiMode==='rank'||multiMode==='general-ai')?getRankArrowCount():12;
  const lv=genMultiLevel(multiCode,_rankCount);
  multiTotal=lv.length;
  multiMyEscaped=0;multiOpEscaped=0;
  multiMyFinishTime=null;multiOpFinishTime=null;
  multiOpDone=false;multiBlockCount=0;multiLives=5;
  clearRankBot();
  multiStartTime=Date.now();
  _startReplaySession({
    kind:'multi',
    mode:multiMode,
    code:multiCode,
    total:multiTotal,
    opponent:rankHumanMatch?'상대':(multiMode==='general-ai'||multiMode==='rank'?'AI':null),
  });
  escaped=0;
  selId=null;lastId=null;
  phase='multi-playing';
  controls.autoRotate=false;
  spawnArrows(lv,activeSkin);
  const sp=Math.sqrt(lv.length)*GRID;
  const cen2=new THREE.Vector3();arrows.forEach(a=>cen2.add(a.bp));cen2.divideScalar(arrows.length);
  const portrait2=innerHeight>innerWidth*1.1;
  camera.position.set(cen2.x,cen2.y+sp*.5,cen2.z+(portrait2?sp*2.5+5.5:sp*1.9+3.5));
  controls.target.copy(cen2);controls.update();
  idleT=0;hudOn=true;
  showUI('hud');
  document.getElementById('multi-hud').classList.add('on');
  document.getElementById('launch-btn').style.display='none';
  document.getElementById('hud').style.display='block';
  document.getElementById('hud').style.opacity='1';
  document.getElementById('pbar').style.display='none';
  const isBlast=multiMode==='blast-rank';
  document.querySelector('.mp-label.op').textContent=(multiMode==='rank'||multiMode==='general-ai'||isBlast)?'AI':'상대';
  document.getElementById('lives-txt').textContent='❤️'.repeat(5)+'🖤'.repeat(0);
  document.getElementById('level-txt').textContent=(multiMode==='rank'||isBlast?'랭크 코드: ':'코드: ')+multiCode;
  document.getElementById('exit-btn').style.display='flex';
  document.getElementById('tap-restore').style.opacity='0';
  if(isBlast){_updateBlastHUD();}else{updateMultiHUD();}
  if((multiMode==='rank'&&multiRole==='rank-ai')||multiMode==='general-ai')startRankBot();
  if(isBlast)setTimeout(startBlastTimer,200); // start timer after opening anim begins
  startOpening();
}

function multiEscape(){
  multiMyEscaped++;
  if(multiMode!=='rank'&&multiMode!=='general-ai')multiSend({type:'progress',escaped:multiMyEscaped});
  updateMultiHUD();
}

function updateMultiHUD(){
  const total=multiTotal||1;
  const myPct=(multiMyEscaped/total*100).toFixed(0);
  const opPct=(multiOpEscaped/total*100).toFixed(0);
  document.getElementById('mp-my-fill').style.width=myPct+'%';
  document.getElementById('mp-op-fill').style.width=opPct+'%';
  document.getElementById('mp-my-count').textContent=multiMyEscaped+'/'+total;
  document.getElementById('mp-op-count').textContent=multiOpEscaped+'/'+total;
  document.getElementById('lives-txt').textContent='❤️'.repeat(Math.max(0,multiLives))+'🖤'.repeat(Math.max(0,5-multiLives));
}

function multiLiveOut(){
  if(phase==='multi-done'||phase!=='multi-playing')return;
  phase='multi-done';
  if(typeof clearRankBot==='function')clearRankBot();
  // A ranked loss from running out of lives must use the ranked result path.
  // Previously this only showed a generic defeat screen, so RP never changed.
  if(multiMode==='rank'){
    multiMyFinishTime=null;
    multiOpFinishTime=multiOpFinishTime!==null?multiOpFinishTime:rankBotTargetTime;
    multiOpDone=true;
    showRankResult();
    return;
  }
  _finishMultiReplay('loss',{
    opponentTime:multiOpFinishTime,
    opponent:rankHumanMatch?'상대':(multiMode==='general-ai'?'AI':null),
  });
  document.getElementById('multi-hud').classList.remove('on');
  document.getElementById('pbar').style.display='block';
  document.getElementById('mr-emoji').textContent='💔';
  document.getElementById('mr-title').textContent='패배...';
  document.getElementById('mr-my-time').textContent='탈락';
  document.getElementById('mr-op-time').textContent='—';
  document.getElementById('mr-detail').textContent='체력이 모두 소진됐습니다. 상대방이 승리했습니다!';
  document.getElementById('mr-again').textContent='다시 대결';
  showUI('multi-result');
}

function checkMultiWin(){
  if(multiMode==='blast-rank')return; // blast rank uses timer, not all-escaped condition
  if(arrows.every(a=>a.state==='escaped')){
    const elapsed=((Date.now()-multiStartTime)/1000).toFixed(2);
    multiMyFinishTime=parseFloat(elapsed);
    if((multiMode==='rank'&&!rankHumanMatch)||multiMode==='general-ai'){// AI 대결: 즉시 판정
      multiOpFinishTime=multiOpFinishTime!==null?multiOpFinishTime:rankBotTargetTime;
      multiOpEscaped=multiTotal;
      multiOpDone=true;
      updateMultiHUD();
      phase='multi-done';
      showMultiResult();
      return;
    }
    multiSend({type:'finished',time:multiMyFinishTime});
    if(multiOpDone){
      showMultiResult();
    } else {
      popup('완료! 상대방 기다리는 중...',innerWidth/2,innerHeight*.35,'#4cc9f0');
      // Auto show result after 8s if opponent doesn't respond
      setTimeout(()=>{if(phase==='multi-playing'||phase==='multi-done')showMultiResult();},8000);
    }
    phase='multi-done';
  }
}

function showMultiResult(){
  if(multiMode==='rank'){showRankResult();return;}
  if(multiMode==='blast-rank'){showBlastRankResult();return;}
  if(multiMode==='general-ai'){showGeneralAiResult();return;}
  const myT=multiMyFinishTime;
  const opT=multiOpFinishTime;
  let emoji,title,detail;
  if(myT!==null&&opT!==null){
    if(myT<opT){emoji='🏆';title='승리!';detail=`상대보다 ${(opT-myT).toFixed(2)}초 빨랐어요!`;}
    else if(myT>opT){emoji='💔';title='패배...';detail=`상대보다 ${(myT-opT).toFixed(2)}초 느렸어요. 다시 도전!`;}
    else{emoji='🤝';title='무승부!';detail='정확히 같은 시간이에요!';}
  } else if(myT!==null&&opT===null){
    emoji='🏆';title='승리!';detail='상대방이 완료하지 못했어요!';
  } else {
    emoji='💔';title='패배...';detail='상대방이 먼저 완료했어요. 다시 도전!';
  }
  const result=emoji==='🏆'?'win':emoji==='🤝'?'draw':'loss';
  const coinDelta=-Math.min(multiBlockCount*2,10);
  _finishMultiReplay(result,{
    opponentTime:opT,
    opponent:window._lastOpponentName||null,
    coins:coinDelta,
  });
  document.getElementById('mr-emoji').textContent=emoji;
  document.getElementById('mr-title').textContent=title;
  document.getElementById('mr-my-time').textContent=myT!==null?myT+'초':'미완';
  document.getElementById('mr-op-time').textContent=opT!==null?opT+'초':'미완';
  if(multiBlockCount>0){
    const pen=Math.min(multiBlockCount*2,10);
    detail+=` (실수 ${multiBlockCount}회 · 보상 -${pen} 코인 반영)`;
    coins=Math.max(0,coins-pen);doSave();updateCoins();
  }
  document.getElementById('mr-detail').textContent=detail;
  document.getElementById('mr-again').textContent='다시 대결';
  if(typeof _addBPXP==='function'){setTimeout(function(){var _eEl=document.getElementById('mr-emoji');var _bpW=_eEl&&_eEl.textContent.indexOf('🏆')>-1;var _x2=_bpW?200:80;_addBPXP(_x2);popup('+'+_x2+' BP XP',innerWidth/2,innerHeight*.42,'#7b2ff7');},450);}
  phase='multi-result';
  document.getElementById('multi-hud').classList.remove('on');
  document.getElementById('pbar').style.display='block';
  showUI('multi-result');
}

function showGeneralAiResult(){
  clearRankBot();
  const myT=multiMyFinishTime;
  const opT=rankHumanMatch?(multiOpFinishTime):(multiOpFinishTime!==null?multiOpFinishTime:rankBotTargetTime);
  let emoji,title,detail;
  if(myT!==null&&opT!==null){
    if(myT<opT){emoji='🏆';title='승리!';detail=`AI보다 ${(opT-myT).toFixed(2)}초 빨랐어요!`;}
    else{emoji='💔';title='패배...';detail=`AI보다 ${(myT-opT).toFixed(2)}초 느렸어요. 다시 도전!`;}
  }else if(myT!==null){
    emoji='🏆';title='승리!';detail='AI가 완료하기 전에 끝냈어요!';
  }else{
    emoji='💔';title='패배...';detail='AI가 먼저 완료했어요. 다시 도전!';
  }
  const coinDelta=-Math.min(multiBlockCount*2,10);
  _finishMultiReplay(emoji==='🏆'?'win':'loss',{
    opponentTime:opT,
    opponent:rankHumanMatch?(window._lastOpponentName||'상대'):'AI',
    coins:coinDelta,
  });
  if(multiBlockCount>0){
    const pen=Math.min(multiBlockCount*2,10);
    detail+=` (실수 ${multiBlockCount}회 · 보상 -${pen} 코인 반영)`;
    coins=Math.max(0,coins-pen);doSave();updateCoins();
  }
  document.getElementById('mr-emoji').textContent=emoji;
  document.getElementById('mr-title').textContent=title;
  document.getElementById('mr-my-time').textContent=myT!==null?myT+'초':'미완';
  document.getElementById('mr-op-time').textContent=opT!==null?opT+'초':'미완';
  document.getElementById('mr-detail').textContent=detail;
  document.getElementById('mr-again').textContent='다시 대결';
  if(typeof _addBPXP==='function'){setTimeout(function(){var _eEl=document.getElementById('mr-emoji');var _bpW=_eEl&&_eEl.textContent.indexOf('🏆')>-1;var _x2=_bpW?200:80;_addBPXP(_x2);popup('+'+_x2+' BP XP',innerWidth/2,innerHeight*.42,'#7b2ff7');},450);}
  phase='multi-result';
  document.getElementById('multi-hud').classList.remove('on');
  document.getElementById('pbar').style.display='block';
  showUI('multi-result');
}

// ══════════════════════════════════════════════════
// BLAST RANK MODE (화살표 폭발 랭크전)
// ══════════════════════════════════════════════════
const BLAST_RANK_SAVE_KEY='three-d-escape-blast-rank-v1';
const BLAST_TIME_LIMITS=[20,20,20,20,20,20]; // bronze→crossis 초
const BLAST_ARROW_POOLS=[10,12,16,20,25,30]; // 티어별 동시 화살표 수
// Targets are tuned against the respawning arrow pools. The old values let
// Bronze AI score only 2–3 points in a 20-second round.
const BLAST_AI_TARGETS=[[8,11],[10,14],[14,18],[18,24],[24,31],[30,38]];

let blastRankState=null;
let _blastTimerId=null;
let blastTimeLeft=0;
let blastAiInterval=null;
const _blastRespawnSet=new Set();

function _loadBlastRankState(){
  try{const d=JSON.parse(localStorage.getItem(BLAST_RANK_SAVE_KEY)||'{}');blastRankState={placements:0,placementWins:0,points:0,placed:false,matches:0,...d};}
  catch{blastRankState={placements:0,placementWins:0,points:0,placed:false,matches:0};}
}
function _saveBlastRankState(){try{localStorage.setItem(BLAST_RANK_SAVE_KEY,JSON.stringify(blastRankState));}catch{}}
_loadBlastRankState();

function _blastGetTierObj(){
  const pts=(blastRankState&&blastRankState.points)||0;
  let t=RANK_TIERS[0];
  for(const x of RANK_TIERS){if(pts>=x.min)t=x;}
  return t;
}
function _blastGetTierIndex(){
  const t=_blastGetTierObj();
  const idx=RANK_TIERS.findIndex(x=>x.id===t.id);
  return Math.max(0,Math.min(5,idx<0?0:idx));
}

function getRankArrowCountBlast(){
  return BLAST_ARROW_POOLS[_blastGetTierIndex()];
}

function updateBlastRankLobby(){
  if(!blastRankState)_loadBlastRankState();
  const state=blastRankState, placed=state.placed;
  const ti=_blastGetTierIndex(), tier=_blastGetTierObj();
  const emEl=document.getElementById('blast-rank-emblem');
  const titleEl=document.getElementById('blast-rank-title');
  const copyEl=document.getElementById('blast-rank-copy');
  const ptEl=document.getElementById('blast-rank-points');
  const progEl=document.getElementById('blast-rank-progress-fill');
  const diffBox=document.getElementById('blast-diff-box');
  if(!placed){
    emEl.textContent='💥';titleEl.textContent='배치고사';
    copyEl.textContent='AI와 5번 대결하면 첫 티어가 열립니다.';
    ptEl.textContent='배치 '+state.placements+' / 5';
    progEl.style.width=(state.placements/5*100)+'%';
    diffBox.style.display='none';
  }else{
    const nextTier=RANK_TIERS[ti+1];
    const curMin=tier.min||0, nextMin=nextTier?nextTier.min:curMin+200;
    const pct=nextTier?Math.min(100,((state.points-curMin)/(nextMin-curMin)*100).toFixed(0)):100;
    emEl.textContent=tier.symbol;titleEl.textContent=tier.name;
    copyEl.textContent=tier.desc||'';
    ptEl.textContent=state.points+' RP · '+state.matches+'전';
    progEl.style.width=pct+'%';
    diffBox.style.display='block';
    document.getElementById('bd-time').textContent=BLAST_TIME_LIMITS[ti]+'초';
    document.getElementById('bd-arrows').textContent=BLAST_ARROW_POOLS[ti]+'개 (재생성)';
    const[aiMin,aiMax]=BLAST_AI_TARGETS[ti];
    document.getElementById('bd-aiscore').textContent=aiMin+'~'+aiMax+'점';
  }
}

function startBlastRankMatch(){
  multiMode='blast-rank';
  multiCode=String(Math.floor(1000+Math.random()*9000));
  multiRole='rank-ai';
  multiOpAlive=true;
  closeMultiWs();clearRankBot();clearBlastRankTimer();
  startMultiCountdown();
}

function startBlastRankHumanMatch(){
  multiMode='blast-rank';
  const code=getTierRankMatchCode(blastRankState,RANK_TIERS);
  const serverUrl=getAutoWsUrl()||RENDER_WS;
  multiCode=code;multiRole=null;multiOpAlive=false;
  closeMultiWs();
  document.getElementById('multi-code-display').textContent=code;
  document.getElementById('multi-lobby-title').textContent='폭발 랭크 사람 매칭 중';
  const tierName=_blastGetTierObj().name;
  document.getElementById('multi-status').innerHTML='<span class="multi-wait-dots">'+tierName+' 폭발 랭크 상대 찾는 중<span>.</span><span>.</span><span>.</span></span>';
  phase='blast-rank-lobby';
  showUI('multi-lobby');
  const ws=new WebSocket(serverUrl);
  multiWs=ws;
  ws.onopen=()=>{ws.send(JSON.stringify({type:'join',code}));};
  ws.onmessage=(ev)=>{let msg;try{msg=JSON.parse(ev.data);}catch{return;}handleMultiMsg(msg);};
  ws.onerror=()=>{popup('서버 연결 실패!',innerWidth/2,innerHeight*.45,'#ff6b6b');showUI('blast-rank-lobby');};
  ws.onclose=()=>{if(phase==='multi-playing'||phase==='multi-done'){handleOpponentDisconnect();}};
}

function clearBlastRankTimer(){
  if(_blastTimerId){clearInterval(_blastTimerId);_blastTimerId=null;}
  if(blastAiInterval){clearInterval(blastAiInterval);blastAiInterval=null;}
  _blastRespawnSet.clear();
  const el=document.getElementById('blast-rank-timer');
  if(el)el.classList.remove('on','warning');
}

function _blastArrowEscaped(a){
  multiMyEscaped++;
  _updateBlastHUD();
  if(!_blastRespawnSet.has(a.id)){
    _blastRespawnSet.add(a.id);
    const delay=2000+Math.random()*2000;
    setTimeout(()=>{
      _blastRespawnSet.delete(a.id);
      if(phase!=='multi-playing'||multiMode!=='blast-rank')return;
      a.state='idle';a.prog=0;
      a.root.position.copy(a.bp);a.root.visible=true;
      escaped=Math.max(0,escaped-1);
    },delay);
  }
}

function _updateBlastHUD(){
  const cap=Math.max(multiMyEscaped,multiOpEscaped,8)+2;
  document.getElementById('mp-my-fill').style.width=Math.min(100,multiMyEscaped/cap*100)+'%';
  document.getElementById('mp-op-fill').style.width=Math.min(100,multiOpEscaped/cap*100)+'%';
  document.getElementById('mp-my-count').textContent=multiMyEscaped+'점';
  document.getElementById('mp-op-count').textContent=multiOpEscaped+'점';
}

function startBlastTimer(){
  const ti=_blastGetTierIndex();
  blastTimeLeft=BLAST_TIME_LIMITS[ti];
  const timerEl=document.getElementById('blast-rank-timer');
  timerEl.classList.add('on');timerEl.classList.remove('warning');
  function fmt(s){return Math.floor(s/60)+':'+String(s%60).padStart(2,'0');}
  timerEl.textContent='⏱ '+fmt(blastTimeLeft);
  _blastTimerId=setInterval(()=>{
    blastTimeLeft--;
    timerEl.textContent='⏱ '+fmt(blastTimeLeft);
    if(blastTimeLeft<=10)timerEl.classList.add('warning');
    if(blastTimeLeft<=0){clearBlastRankTimer();_blastEndMatch();}
  },1000);
  // AI bot for blast mode
  if(multiRole==='rank-ai'){
    const[aiMin,aiMax]=BLAST_AI_TARGETS[ti];
    const aiTarget=aiMin+Math.floor(Math.random()*(aiMax-aiMin+1));
    const interval=Math.max(400,Math.floor(BLAST_TIME_LIMITS[ti]/aiTarget*1000));
    blastAiInterval=setInterval(()=>{
      if(phase!=='multi-playing'||multiMode!=='blast-rank'){clearInterval(blastAiInterval);return;}
      multiOpEscaped++;_updateBlastHUD();
    },interval);
  }
}

function _blastEndMatch(){
  if(phase!=='multi-playing'&&phase!=='multi-done')return;
  phase='multi-done';showMultiResult();
}

function showBlastRankResult(){
  clearBlastRankTimer();
  const myScore=multiMyEscaped, opScore=multiOpEscaped;
  const win=myScore>opScore, draw=myScore===opScore;
  const state=blastRankState;
  const ti=_blastGetTierIndex();
  state.matches=(state.matches||0)+1;
  let rpChange=0;
  if(!state.placed){
    state.placements=(state.placements||0)+1;
    if(win)state.placementWins=(state.placementWins||0)+1;
    if(state.placements>=5){
      state.placed=true;
      state.points=Math.floor(state.placementWins/5*200)+50;
      const newT=_blastGetTierObj();
      popup('💥 첫 폭발 랭크 티어! '+newT.symbol+' '+newT.name,innerWidth/2,innerHeight*.3,'#f72585');
    }
  }else{
    if(win){rpChange=10+Math.min(20,Math.floor((myScore-opScore)*2));}
    else if(!draw){rpChange=-(8+Math.min(15,Math.floor((opScore-myScore)*1.5)));}
    const newPts=Math.max(0,(state.points||0)+rpChange);
    state.points=newPts;
    const newT=_blastGetTierObj();
    const tiNew=Math.max(0,Math.min(5,RANK_TIERS.findIndex(x=>x.id===newT.id)));
    if(tiNew>ti)setTimeout(()=>showTierPromo(newT.symbol,newT.name,newT.color),400);
  }
  _saveBlastRankState();
  const emoji=win?'🏆':draw?'🤝':'💔';
  const title=win?'승리!':draw?'무승부!':'패배...';
  let detail='내 점수: '+myScore+'점 · 상대: '+opScore+'점';
  if(state.placed&&rpChange!==0)detail+='\nRP '+(rpChange>0?'+':'')+rpChange;
  _finishMultiReplay(win?'win':draw?'draw':'loss',{
    opponentTime:null,
    opponent:multiRole==='rank-ai'?'AI':(window._lastOpponentName||'상대'),
  });
  document.getElementById('mr-emoji').textContent=emoji;
  document.getElementById('mr-title').textContent=title;
  document.getElementById('mr-my-time').textContent=myScore+'점';
  document.getElementById('mr-op-time').textContent=opScore+'점';
  document.getElementById('mr-detail').textContent=detail;
  document.getElementById('mr-again').textContent='다시 폭발 대결';
  if(typeof _addBPXP==='function'){setTimeout(()=>{const x=win?200:80;_addBPXP(x);popup('+'+x+' BP XP',innerWidth/2,innerHeight*.42,'#7b2ff7');},450);}
  phase='multi-result';
  document.getElementById('multi-hud').classList.remove('on');
  document.getElementById('pbar').style.display='block';
  showUI('multi-result');
}

// Code digit input handlers
(()=>{
  const digits=['cd0','cd1','cd2','cd3'];
  digits.forEach((id,i)=>{
    const el=document.getElementById(id);
    el.addEventListener('input',function(){
      this.value=this.value.replace(/[^0-9]/g,'').slice(-1);
      if(this.value&&i<digits.length-1)document.getElementById(digits[i+1]).focus();
    });
    el.addEventListener('keydown',function(e){
      if(e.key==='Backspace'&&!this.value&&i>0)document.getElementById(digits[i-1]).focus();
      if(e.key==='Enter')document.getElementById('multi-join-btn').click();
    });
  });
})();

// ══════════════════════════════════════════════════

// PAPER FLIGHT MINI GAME
const flightCanvas=document.getElementById('flight-canvas');
const flightCtx=flightCanvas.getContext('2d');
const FLIGHT_SAVE_KEY='paperFlightMiniV1';
const flight={
  w:innerWidth,h:innerHeight,dpr:1,running:false,ended:false,touching:false,
  t:0,distance:0,lastDistance:0,best:0,stars:0,earned:0,scoreStars:0,
  speedLv:1,accLv:1,energy:100,planeX:innerWidth/2,targetX:innerWidth/2,lastPlaneX:innerWidth/2,
  spawnTimer:0,ringTimer:0,cloudTimer:0,items:[],clouds:[],sparkles:[],shake:0
};
function clamp(v,a,b){return Math.max(a,Math.min(b,v));}
function flightSpeedCost(){return flight.speedLv>=10?null:70+flight.speedLv*45;}
function flightAccCost(){return flight.accLv>=10?null:65+flight.accLv*40;}
function loadFlightSave(){
  try{
    const s=JSON.parse(localStorage.getItem(FLIGHT_SAVE_KEY)||'{}');
    flight.best=s.best||0;flight.stars=s.stars||0;flight.speedLv=s.speedLv||1;flight.accLv=s.accLv||1;
  }catch(e){}
}
function saveFlight(){
  localStorage.setItem(FLIGHT_SAVE_KEY,JSON.stringify({best:flight.best,stars:flight.stars,speedLv:flight.speedLv,accLv:flight.accLv}));
  if(_fbUser)fbCloudSave();
}
function updateFlightUI(){
  document.getElementById('flight-dist').textContent=Math.floor(flight.distance)+'m';
  document.getElementById('flight-best').textContent=Math.floor(flight.best)+'m';
  document.getElementById('flight-stars').textContent=flight.stars;
  document.getElementById('flight-speed-lv').textContent='Lv.'+flight.speedLv;
  document.getElementById('flight-acc-lv').textContent='Lv.'+flight.accLv;
  const sc=flightSpeedCost(),ac=flightAccCost();
  document.getElementById('flight-speed-cost').textContent=sc===null?'MAX':sc;
  document.getElementById('flight-acc-cost').textContent=ac===null?'MAX':ac;
  document.getElementById('flight-up-speed').disabled=sc===null||flight.stars<sc||flight.running;
  document.getElementById('flight-up-accuracy').disabled=ac===null||flight.stars<ac||flight.running;
  document.getElementById('flight-energy-fill').style.width=clamp(flight.energy,0,100)+'%';
}
function resizeFlight(){
  const dpr=Math.min(devicePixelRatio||1,2);
  flight.dpr=dpr;flight.w=innerWidth;flight.h=innerHeight;
  flightCanvas.width=Math.floor(flight.w*dpr);
  flightCanvas.height=Math.floor(flight.h*dpr);
  flightCanvas.style.width=flight.w+'px';
  flightCanvas.style.height=flight.h+'px';
  flightCtx.setTransform(dpr,0,0,dpr,0,0);
  flight.planeX=clamp(flight.planeX,44,flight.w-44);
  flight.targetX=clamp(flight.targetX,44,flight.w-44);
}
function resetFlightRound(){
  resizeFlight();
  flight.running=false;flight.ended=false;flight.t=0;flight.distance=0;flight.earned=0;flight.scoreStars=0;
  flight.energy=100;flight.items.length=0;flight.sparkles.length=0;flight.clouds.length=0;flight.shake=0;
  flight.spawnTimer=.45;flight.ringTimer=.9;flight.cloudTimer=0;flight.planeX=flight.w/2;flight.targetX=flight.planeX;flight.lastPlaneX=flight.planeX;
  for(let i=0;i<8;i++)flight.clouds.push({x:Math.random()*flight.w,y:Math.random()*flight.h,r:28+Math.random()*52,s:.35+Math.random()*.7});
  updateFlightUI();renderFlight();
}
function openFlightGame(){
  closeMultiWs();clearPreview();closeLevelSelect();
  phase='flight';controls.autoRotate=false;showUI('flight');
  document.getElementById('flight-panel').classList.remove('hidden');
  document.getElementById('flight-panel-title').textContent='PAPER FLIGHT';
  document.getElementById('flight-panel-copy').textContent='속도와 정확도를 올려 더 멀리 날려보세요.';
  document.getElementById('flight-panel-start').textContent='TAKE OFF';
  resetFlightRound();
}
function startFlightRound(){
  if(phase!=='flight')openFlightGame();
  resetFlightRound();
  flight.running=true;flight.ended=false;
  document.getElementById('flight-panel').classList.add('hidden');
  document.getElementById('flight-start').textContent='RESTART';
}
function endFlightRound(){
  if(!flight.running)return;
  flight.running=false;flight.ended=true;flight.lastDistance=Math.floor(flight.distance);
  const earned=Math.max(12,Math.floor(flight.distance/38)+flight.scoreStars*6);
  flight.earned=earned;flight.stars+=earned;
  if(flight.distance>flight.best)flight.best=Math.floor(flight.distance);
  saveFlight();updateFlightUI();
  document.getElementById('flight-last').textContent=flight.lastDistance+'m';
  document.getElementById('flight-earned').textContent=earned;
  document.getElementById('flight-panel-title').textContent='FLIGHT LOG';
  document.getElementById('flight-panel-copy').textContent='새 별을 모아 다음 비행을 더 빠르고 안정적으로 만드세요.';
  document.getElementById('flight-panel-start').textContent='AGAIN';
  document.getElementById('flight-panel').classList.remove('hidden');
  document.getElementById('flight-start').textContent='TAKE OFF';
}
function buyFlightSpeed(){const c=flightSpeedCost();if(c!==null&&flight.stars>=c&&!flight.running){flight.stars-=c;flight.speedLv++;saveFlight();updateFlightUI();}}
function buyFlightAccuracy(){const c=flightAccCost();if(c!==null&&flight.stars>=c&&!flight.running){flight.stars-=c;flight.accLv++;saveFlight();updateFlightUI();}}
function flightPointerX(e){
  const r=flightCanvas.getBoundingClientRect();
  return clamp(e.clientX-r.left,38,r.width-38);
}
function addFlightSpark(x,y,color){
  for(let i=0;i<8;i++)flight.sparkles.push({x,y,vx:(Math.random()-.5)*140,vy:(Math.random()-.5)*120,life:.45+Math.random()*.25,c:color});
}
function spawnFlightItem(type){
  const margin=42;
  flight.items.push({type,x:margin+Math.random()*(flight.w-margin*2),y:-45,r:type==='ring'?27:30,hit:false,spin:Math.random()*6.28});
}
function tickFlight(dt){
  if(phase!=='flight')return;
  flight.t+=dt;
  const world=130+flight.speedLv*20;
  flight.cloudTimer-=dt;
  if(flight.cloudTimer<=0){flight.cloudTimer=.42+Math.random()*.35;flight.clouds.push({x:-60+Math.random()*(flight.w+120),y:-70,r:26+Math.random()*52,s:.28+Math.random()*.75});}
  flight.clouds.forEach(c=>c.y+=world*dt*c.s*.32);
  flight.clouds=flight.clouds.filter(c=>c.y<c.r+flight.h+90);
  if(!flight.running){flight.planeX+=(flight.targetX-flight.planeX)*Math.min(1,dt*6);return;}
  flight.distance+=(14+flight.speedLv*3.8)*dt;
  flight.energy-=dt*(5.8+flight.speedLv*.2);
  flight.spawnTimer-=dt;flight.ringTimer-=dt;
  if(flight.spawnTimer<=0){flight.spawnTimer=Math.max(.42,1.2-flight.speedLv*.05);spawnFlightItem(Math.random()<.66?'gust':'wall');}
  if(flight.ringTimer<=0){flight.ringTimer=Math.max(.58,1.7-flight.speedLv*.06);spawnFlightItem('ring');}
  const wind=(Math.sin(flight.t*1.7)+Math.sin(flight.t*3.1)*.45)*(22-flight.accLv*1.65);
  const control=5.4+flight.accLv*.75;
  flight.lastPlaneX=flight.planeX;
  flight.planeX+=(flight.targetX+wind-flight.planeX)*Math.min(1,dt*control);
  flight.planeX=clamp(flight.planeX,34,flight.w-34);
  const py=flight.h*.72;
  flight.items.forEach(it=>{
    it.y+=world*dt*(it.type==='ring'?.98:1.08);
    it.spin+=dt*2.2;
    if(!it.hit){
      const dx=it.x-flight.planeX,dy=it.y-py;
      const rr=it.type==='ring'?38:32-(flight.accLv*.75);
      if(dx*dx+dy*dy<rr*rr){
        it.hit=true;
        if(it.type==='ring'){
          flight.energy=clamp(flight.energy+11,0,100);flight.scoreStars++;addFlightSpark(it.x,it.y,'#ffd166');
        }else{
          flight.energy-=it.type==='wall'?23:16;flight.shake=.18;addFlightSpark(it.x,it.y,'#ff7a59');
        }
      }
    }
  });
  flight.items=flight.items.filter(it=>it.y<flight.h+70&&!it.hit);
  flight.sparkles.forEach(p=>{p.x+=p.vx*dt;p.y+=p.vy*dt;p.life-=dt;});
  flight.sparkles=flight.sparkles.filter(p=>p.life>0);
  if(flight.shake>0)flight.shake=Math.max(0,flight.shake-dt);
  updateFlightUI();
  if(flight.energy<=0)endFlightRound();
}
function drawCloud(c){
  flightCtx.save();flightCtx.globalAlpha=.55;flightCtx.fillStyle='#ffffff';
  flightCtx.beginPath();flightCtx.arc(c.x,c.y,c.r*.55,0,Math.PI*2);flightCtx.arc(c.x+c.r*.38,c.y+c.r*.05,c.r*.42,0,Math.PI*2);flightCtx.arc(c.x-c.r*.38,c.y+c.r*.1,c.r*.38,0,Math.PI*2);flightCtx.fill();flightCtx.restore();
}
function drawFlightPlane(x,y){
  const bank=clamp((x-flight.lastPlaneX)*.035,-.55,.55);
  flightCtx.save();flightCtx.translate(x,y);flightCtx.rotate(bank);
  flightCtx.shadowColor='rgba(15,45,63,.22)';flightCtx.shadowBlur=18;flightCtx.shadowOffsetY=14;
  flightCtx.fillStyle='#ffffff';flightCtx.beginPath();flightCtx.moveTo(0,-30);flightCtx.lineTo(27,26);flightCtx.lineTo(0,12);flightCtx.lineTo(-27,26);flightCtx.closePath();flightCtx.fill();
  flightCtx.shadowBlur=0;flightCtx.fillStyle='#d7f4ff';flightCtx.beginPath();flightCtx.moveTo(0,-30);flightCtx.lineTo(0,12);flightCtx.lineTo(27,26);flightCtx.closePath();flightCtx.fill();
  flightCtx.strokeStyle='rgba(15,45,63,.18)';flightCtx.lineWidth=2;flightCtx.beginPath();flightCtx.moveTo(0,-30);flightCtx.lineTo(0,12);flightCtx.stroke();
  flightCtx.restore();
}
function renderFlight(){
  if(!flightCtx)return;
  const sx=flight.shake?(Math.random()-.5)*10*flight.shake:0,sy=flight.shake?(Math.random()-.5)*10*flight.shake:0;
  flightCtx.save();flightCtx.clearRect(0,0,flight.w,flight.h);flightCtx.translate(sx,sy);
  const g=flightCtx.createLinearGradient(0,0,0,flight.h);g.addColorStop(0,'#bdf3ff');g.addColorStop(.55,'#f8fdff');g.addColorStop(1,'#ffd8a8');flightCtx.fillStyle=g;flightCtx.fillRect(-20,-20,flight.w+40,flight.h+40);
  flightCtx.fillStyle='rgba(6,214,160,.12)';
  for(let i=0;i<7;i++){const y=((flight.t*55+i*120)% (flight.h+140))-80;flightCtx.fillRect(0,y,flight.w,2);}
  flight.clouds.forEach(drawCloud);
  flight.items.forEach(it=>{
    flightCtx.save();flightCtx.translate(it.x,it.y);flightCtx.rotate(it.spin);
    if(it.type==='ring'){
      flightCtx.strokeStyle='#ffd166';flightCtx.lineWidth=7;flightCtx.globalAlpha=.95;flightCtx.beginPath();flightCtx.arc(0,0,it.r,0,Math.PI*2);flightCtx.stroke();flightCtx.strokeStyle='rgba(255,255,255,.7)';flightCtx.lineWidth=2;flightCtx.stroke();
    }else if(it.type==='wall'){
      flightCtx.fillStyle='#ff7a59';flightCtx.strokeStyle='#0f2d3f';flightCtx.lineWidth=3;flightCtx.beginPath();flightCtx.roundRect(-26,-22,52,44,8);flightCtx.fill();flightCtx.stroke();
    }else{
      flightCtx.strokeStyle='#1b6d74';flightCtx.lineWidth=5;flightCtx.globalAlpha=.8;for(let a=0;a<3;a++){flightCtx.beginPath();flightCtx.arc(0,0,12+a*8,Math.PI*.15,Math.PI*1.65);flightCtx.stroke();}
    }
    flightCtx.restore();
  });
  flight.sparkles.forEach(p=>{flightCtx.globalAlpha=clamp(p.life*2,0,1);flightCtx.fillStyle=p.c;flightCtx.beginPath();flightCtx.arc(p.x,p.y,3+p.life*3,0,Math.PI*2);flightCtx.fill();});
  flightCtx.globalAlpha=1;drawFlightPlane(flight.planeX,flight.h*.72);
  flightCtx.restore();
}
flightCanvas.addEventListener('pointerdown',e=>{if(phase!=='flight')return;flight.touching=true;flight.targetX=flightPointerX(e);flightCanvas.setPointerCapture?.(e.pointerId);if(!flight.running&&!flight.ended)startFlightRound();});
flightCanvas.addEventListener('pointermove',e=>{if(phase==='flight'&&flight.touching)flight.targetX=flightPointerX(e);});
flightCanvas.addEventListener('pointerup',e=>{flight.touching=false;flightCanvas.releasePointerCapture?.(e.pointerId);});
flightCanvas.addEventListener('pointercancel',()=>{flight.touching=false;});
window.addEventListener('keydown',e=>{if(phase!=='flight')return;if(e.key==='ArrowLeft'){flight.targetX=clamp(flight.targetX-48,38,flight.w-38);playComboNote();}else if(e.key==='ArrowRight'){flight.targetX=clamp(flight.targetX+48,38,flight.w-38);playComboNote();}});
loadFlightSave();
// INPUT
// ══════════════════════════════════════════════════
function onTap(cx,cy){
  resetIdle();
  if(phase!=='playing'&&phase!=='multi-playing')return;
  const id=hitTest(cx,cy);
  if(id)selectArrow(id);
}
// ── INPUT: robust tap vs drag detection ──────────────
let pDown=null,pMoved=false;
canvas.addEventListener('pointerdown',e=>{
  resetIdle(); // Fix: immediately stop auto-rotate on any press
  pDown={x:e.clientX,y:e.clientY,id:e.pointerId};
  pMoved=false;
});
canvas.addEventListener('pointermove',e=>{
  if(pDown&&pDown.id===e.pointerId){
    const dx=e.clientX-pDown.x,dy=e.clientY-pDown.y;
    if(dx*dx+dy*dy>225)pMoved=true; // >15px = drag (모바일 탭 오인식 방지)
  }
});
canvas.addEventListener('pointerup',e=>{
  if(!pDown||pDown.id!==e.pointerId)return;
  const moved=pMoved;
  pDown=null;pMoved=false;
  if(moved)return; // drag → camera rotate, not a tap
  onTap(e.clientX,e.clientY);
});
canvas.addEventListener('pointercancel',()=>{pDown=null;pMoved=false;});
// Touch events removed — pointer events handle both mouse and touch on modern browsers.
// (Keeping touchstart/touchend caused double-tap detection on mobile: both pointerup
//  and touchend fired for the same finger tap, counting as two taps in <360ms.)

// Buttons
document.getElementById('pick-escape').onclick=()=>goMenu();
document.getElementById('pick-flight').onclick=()=>openFlightGame();
document.getElementById('flight-back').onclick=()=>goHub();
document.getElementById('flight-start').onclick=()=>startFlightRound();
document.getElementById('flight-panel-start').onclick=()=>startFlightRound();
document.getElementById('flight-up-speed').onclick=()=>buyFlightSpeed();
document.getElementById('flight-up-accuracy').onclick=()=>buyFlightAccuracy();

document.getElementById('btn-start').onclick=()=>openLevelSelect();
document.getElementById('btn-cont').onclick=()=>loadLevel(progress);
document.getElementById('btn-shop').onclick=()=>{phase='shop';showUI('shop');renderShopGrid();controls.autoRotate=true;};
document.getElementById('btn-history').onclick=()=>_openHistory();
const hubBtn=document.getElementById('btn-hub');
if(hubBtn)hubBtn.onclick=()=>goHub();
document.getElementById('btn-multi').onclick=()=>openMultiplayer();
document.getElementById('general-mode-btn').onclick=()=>openGeneralMultiplayer();
document.getElementById('rank-mode-btn').onclick=()=>openRankLobby();
document.getElementById('multi-mode-back-btn').onclick=()=>goMenu();
document.getElementById('rank-start-btn').onclick=()=>startRankMatch();
document.getElementById('rank-human-btn').onclick=()=>startRankHumanMatch();
document.getElementById('multi-quickmatch-btn').onclick=()=>startQuickMatch();
document.getElementById('multi-ai-btn').onclick=()=>startGeneralAiMatch();
document.getElementById('rank-back-btn').onclick=()=>openRankLobby();
// 랭크 모드 선택 카드
document.getElementById('escape-rank-select-btn').onclick=()=>openEscapeRankLobby();
document.getElementById('blast-rank-select-btn').onclick=()=>openBlastRankLobby();
document.getElementById('rank-mode-select-back-btn').onclick=()=>openMultiplayer();
// 폭발 랭크 로비
document.getElementById('blast-rank-start-btn').onclick=()=>startBlastRankMatch();
document.getElementById('blast-rank-human-btn').onclick=()=>startBlastRankHumanMatch();
document.getElementById('blast-rank-back-btn').onclick=()=>openRankLobby();
document.getElementById('blast-lb-btn').onclick=()=>_openTierPanel('blast-rank-lobby');
// 튜토리얼
// ── 승급 오버레이 ──
function showTierPromo(symbol,name,color){
  const ov=document.getElementById('tier-promo-ov');
  const starsEl=document.getElementById('tp-stars');
  document.getElementById('tp-symbol').textContent=symbol;
  document.getElementById('tp-title').textContent=name;
  document.getElementById('tp-name').textContent='새 티어 달성!';
  const c=color||'#ffd060';
  ov.style.setProperty('--tp-color',c);
  document.querySelector('.tp-symbol').style.setProperty('--tp-color',c);
  starsEl.innerHTML='';
  const colors=[c,'#ffffff','#ffd060','#fff9c4'];
  for(let i=0;i<40;i++){
    const s=document.createElement('div');
    s.className='tp-star';
    const sz=4+Math.random()*10;
    s.style.cssText=`width:${sz}px;height:${sz}px;background:${colors[i%colors.length]};left:${10+Math.random()*80}%;top:${10+Math.random()*80}%;--d:${0.6+Math.random()*1.4}s;--tx:${(Math.random()-.5)*300}px;--ty:${(Math.random()-.5)*300}px;animation-delay:${Math.random()*.3}s`;
    starsEl.appendChild(s);
  }
  ov.classList.add('on');
  clearTimeout(ov._autoClose);
  ov._autoClose=setTimeout(()=>ov.classList.remove('on'),4000);
}
document.getElementById('tier-promo-ov').addEventListener('click',()=>{
  const ov=document.getElementById('tier-promo-ov');
  clearTimeout(ov._autoClose);
  ov.classList.remove('on');
});
document.getElementById('launch-btn').onclick=()=>{if(selId){launchArrow(selId);resetIdle();}};
document.getElementById('btn-next').onclick=()=>loadLevel(lvIdx+1);
document.getElementById('btn-retry').onclick=()=>loadLevel(lvIdx);
const replayLastResult=()=>{
  const id=_lastCompletedReplay?.replayId||_lastCompletedReplay?.id;
  if(id)_openReplay(id);
  else popup('리플레이를 준비하는 중입니다.',innerWidth/2,innerHeight*.45,'#ffcf5c');
};
document.getElementById('win-replay').onclick=replayLastResult;
document.getElementById('over-replay').onclick=replayLastResult;
document.getElementById('btn-m1').onclick=()=>goMenu();
document.getElementById('btn-m2').onclick=()=>goMenu();
document.getElementById('shop-x').onclick=()=>goMenu();
document.getElementById('coin-pill').onclick=()=>{if(phase==='menu'){phase='shop';showUI('shop');renderShopGrid();}};
document.getElementById('exit-btn').onclick=()=>{
  if(phase==='multi-playing'||phase==='multi-done'){closeMultiWs();}
  clearRankBot();clearBlastRankTimer();
  goMenu();
};
document.getElementById('ls-back').onclick=()=>closeLevelSelect();
document.getElementById('multi-join-btn').onclick=()=>joinMultiRoom();
document.getElementById('multi-back-btn').onclick=()=>goMenu();
document.getElementById('multi-lobby-back').onclick=()=>{closeMultiWs();goMenu();};
document.getElementById('mr-menu').onclick=()=>{closeMultiWs();goMenu();};
document.getElementById('mr-replay').onclick=replayLastResult;
document.getElementById('mr-again').onclick=()=>{
  if(multiMode==='rank'){startRankMatch();return;}
  if(multiMode==='blast-rank'){startBlastRankMatch();return;}
  if(multiMode==='general-ai'){startGeneralAiMatch();return;}
  multiSend({type:'again'});
  startMultiCountdown();
};
document.getElementById('history-close').onclick=()=>goMenu();
document.querySelectorAll('.history-filter').forEach(button=>{
  button.onclick=()=>{
    _historyFilter=button.dataset.filter||'all';
    document.querySelectorAll('.history-filter').forEach(item=>item.classList.toggle('on',item===button));
    _renderHistory();
  };
});
document.getElementById('replay-exit').onclick=()=>_openHistory();
document.getElementById('replay-play').onclick=()=>{
  if(_replayPlayback){_replayPlayback.paused=!_replayPlayback.paused;_updateReplayControls();}
};
document.getElementById('replay-restart').onclick=()=>{
  const id=_replayPlayback?.replay?.id;
  if(id)_openReplay(id);
};
document.querySelectorAll('.replay-speed').forEach(button=>{
  button.onclick=()=>{
    if(_replayPlayback){_replayPlayback.speed=Number(button.dataset.speed)||1;_updateReplayControls();}
  };
});

function goHub(){
  phase='hub';clearPreview();
  closeMultiWs();clearRankBot();closeLevelSelect();
  document.getElementById('multi-hud').classList.remove('on');
  document.getElementById('multi-countdown').classList.remove('on');
  document.getElementById('pbar').style.display='block';
  document.getElementById('flight-panel').classList.add('hidden');
  controls.autoRotate=false;
  updateCoins();initDemo();showUI('hub');
}
function goMenu(){
  if(_activeReplay)_finishReplaySession('abandoned');
  _replayPlayback=null;
  phase='menu';clearPreview();
  clearRankBot();clearBlastRankTimer();closeLevelSelect();
  showUI('menu');
  document.getElementById('multi-hud').classList.remove('on');
  document.getElementById('multi-countdown').classList.remove('on');
  document.getElementById('pbar').style.display='block';
  controls.autoRotate=false;
  document.getElementById('btn-cont').style.display=progress>0?'flex':'none';
  updateCoins();initDemo();
}

// ══════════════════════════════════════════════════
// MAIN LOOP
// ══════════════════════════════════════════════════
const clk=new THREE.Clock();
function loop(){
  requestAnimationFrame(loop);
  const dt=Math.min(clk.getDelta(),0.05);
  if(shk>0){shk-=dt*3;const s=shk*0.07;camera.position.x+=(Math.random()-.5)*s;camera.position.y+=(Math.random()-.5)*s;}
  if(phase==='menu'||phase==='hub'){tickDemo(dt);}
  else if(phase==='playing'||phase==='multi-playing'){
    if(opening){const el=Date.now()/1000-openT;let done=true;arrows.forEach(a=>{const t=(el-a.oDelay)/0.55;if(t<0){a.root.position.copy(a.oStart);done=false;}else if(t<1){const e=1-Math.pow(1-Math.min(t,1),3);a.root.position.lerpVectors(a.oStart,a.bp,e);done=false;}else{a.root.position.copy(a.bp);}});if(done)opening=false;}
    else{arrows.forEach(a=>tickArrow(a,dt));tickFreeHint(dt);}
    tickIdle(dt);
  }else if(phase==='replay'){
    const playback=_replayPlayback;
    if(playback&&!playback.paused){
      playback.elapsed+=dt*playback.speed;
      while(playback.eventIndex<playback.events.length&&Number(playback.events[playback.eventIndex].t||0)/1000<=playback.elapsed){
        _replayApplyEvent(playback.events[playback.eventIndex++]);
      }
      arrows.forEach(a=>tickArrow(a,dt*playback.speed));
      if(playback.eventIndex>=playback.events.length&&playback.elapsed>=Number(playback.replay.duration||0)+0.35)playback.paused=true;
      _updateReplayControls();
    }else{
      arrows.forEach(a=>tickArrow(a,0));
    }
  }else if(phase==='win'||phase==='over'||phase==='multi-result'||phase==='multi-done'){arrows.forEach(a=>tickArrow(a,dt*0.35));}
  tickFlight(dt);
  renderFlight();
  controls.update();
  renderer.render(scene,camera);
}
window.addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);resizeFlight();});

// ══════════════════════════════════════════════════
// FIREBASE AUTH + CLOUD SYNC
// ══════════════════════════════════════════════════

function fbCloudSave(){
  if(!_fbUser)return;
  setDoc(doc(_fbDb,'users',_fbUser.uid),{
    coins,
    owned:[...owned],
    activeSkin,
    progress,
    ownedMaps:[...ownedMaps],
    activeMap,
    clearedLevels,
    rankState:{...rankState},
    flightData:{best:flight.best,stars:flight.stars,speedLv:flight.speedLv,accLv:flight.accLv},
    nickname:(_settings&&_settings.nickname)||'',
    email:(_fbUser&&_fbUser.email)||'',
    updatedAt:_fbDb ? serverTimestamp() : _localServerTimestamp()
  },{merge:true}).catch(()=>{});
}

async function fbCloudLoad(){
  if(!_fbUser)return;
  try{
    const snap=await getDoc(doc(_fbDb,'users',_fbUser.uid));
    if(!snap.exists())return;
    const d=snap.data();
    if(d.coins!==undefined)coins=d.coins;
    if(d.owned)owned=new Set(d.owned);
    if(d.activeSkin)activeSkin=d.activeSkin;
    if(d.progress!==undefined)progress=d.progress;
    if(d.ownedMaps)ownedMaps=new Set(d.ownedMaps);
    if(d.activeMap)activeMap=d.activeMap;
    if(d.clearedLevels)clearedLevels=d.clearedLevels;
    if(d.rankState)rankState={...getRankDefaults(),...d.rankState};
    // 닉네임 클라우드 복원 (새 기기/재로그인 시 유지)
    if(d.nickname&&d.nickname.length>=2&&d.nickname!=='나'){
      _settings.nickname=d.nickname;
      _saveSettings();
      _refreshNickDisplay&&_refreshNickDisplay();
    }
    if(d.flightData){
      flight.best=d.flightData.best||0;flight.stars=d.flightData.stars||0;
      flight.speedLv=d.flightData.speedLv||1;flight.accLv=d.flightData.accLv||1;
    }
    // localStorage 동기화
    try{
      localStorage.setItem('e3_coins',String(coins));
      localStorage.setItem('e3_owned',JSON.stringify([...owned]));
      localStorage.setItem('e3_skin',activeSkin);
      localStorage.setItem('e3_prog',String(progress));
      localStorage.setItem('e3_mown',JSON.stringify([...ownedMaps]));
      localStorage.setItem('e3_map',activeMap);
      localStorage.setItem('e3_clv',JSON.stringify(clearedLevels));
      localStorage.setItem(RANK_SAVE_KEY,JSON.stringify(rankState));
      localStorage.setItem(FLIGHT_SAVE_KEY,JSON.stringify({best:flight.best,stars:flight.stars,speedLv:flight.speedLv,accLv:flight.accLv}));
    }catch{}
    updateCoins();
    updateFlightUI();
    applyMap(activeMap);
    document.getElementById('btn-cont').style.display=progress>0?'flex':'none';
  }catch(e){console.warn('[Auth] Cloud load failed:',e);}
}

function _setUserPill(user){
  const pill=document.getElementById('user-pill');
  const av=document.getElementById('up-avatar');
  const nm=document.getElementById('up-name');
  const badge=document.getElementById('up-badge');
  if(user){
    av.src=user.photoURL||'';
    nm.textContent=user.displayName||user.email||'사용자';
    badge.textContent='☁️ 클라우드 저장 중';
    badge.style.color='rgba(76,201,240,0.85)';
    pill.dataset.loggedIn='1';
  }else{
    av.src='';
    nm.textContent='게스트';
    badge.textContent='☁️ 저장 없음';
    badge.style.color='rgba(170,170,220,0.55)';
    pill.dataset.loggedIn='0';
  }
  // Only show pill on menu screen; showUI handles visibility elsewhere
  if(document.getElementById('menu')&&!document.getElementById('menu').classList.contains('hidden')){
    pill.style.display='flex';
  }
}

function _hideAuthOv(){
  const ov=document.getElementById('auth-ov');
  ov.style.opacity='0';
  ov.style.pointerEvents='none';
  setTimeout(()=>ov.style.display='none',420);
}

function _showAccountModal(show){
  const ov=document.getElementById('am-ov');
  ov.classList.toggle('show',show);
  if(show&&_fbUser){
    document.getElementById('am-avatar').src=_fbUser.photoURL||'';
    document.getElementById('am-name').textContent=_fbUser.displayName||'사용자';
    document.getElementById('am-email').textContent=_fbUser.email||'';
    const tier=getRankTier();
    const pts=rankState.points;
    document.getElementById('am-sync-info').innerHTML=
      `☁️ 클라우드 저장 활성화됨<br><span style="font-size:11px;opacity:.7">${tier.name} ${pts}점 · 클리어 ${progress}스테이지</span>`;
  }
}

async function _googleLogin(){
  if(!_fbAuth){
    _hideAuthOv();
    _setUserPill(null);
    return;
  }

  document.getElementById('auth-loading').style.display='block';
  document.getElementById('btn-ggl').style.opacity='0.6';

  const isAndroidNative = (typeof window.Capacitor !== 'undefined' && window.Capacitor.getPlatform() === 'android') ||
                         (/Android/i.test(navigator.userAgent) && /wv|Capacitor/i.test(navigator.userAgent));

  try{
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });

    if (isAndroidNative) {
      // In Android APK/Capacitor WebView, standard popup/redirect causes Google Error 400 (disallowed_useragent).
      // Solution: Open Google Auth via System Chrome Custom Tabs (Browser.open), which Google officially permits!
      console.log('[Auth] Android native detected. Launching System Chrome Custom Tab for Google OAuth...');
      const authDomain = window._FB_CFG && window._FB_CFG.authDomain ? window._FB_CFG.authDomain : 'threed-escape0.firebaseapp.com';
      const systemAuthUrl = 'https://' + authDomain + '/__/auth/handler';
      
      try {
        const capBrowser = (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Browser) || (window.CapacitorCustomPlatform && window.CapacitorCustomPlatform.Browser);
      if (capBrowser && capBrowser.open) {
        await capBrowser.open({ url: systemAuthUrl, windowName: '_system' });
        } else {
          window.open(systemAuthUrl, '_system');
        }
      } catch (bErr) {
        console.warn('[Auth] System browser open fallback:', bErr);
        await signInWithRedirect(_fbAuth, provider);
      }
      return;
    }

    const res = await signInWithPopup(_fbAuth, provider);
    if (res && res.user) {
      _fbUser = res.user;
      _hideAuthOv();
      _setUserPill(res.user);
      await fbCloudLoad();
    }
  }catch(e){
    console.warn('[GoogleAuth Error]', e);
    document.getElementById('auth-loading').style.display='none';
    document.getElementById('btn-ggl').style.opacity='1';

    if (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment') {
      try {
        const provider = new GoogleAuthProvider();
        await signInWithRedirect(_fbAuth, provider);
        return;
      } catch(reErr) {
        console.warn('[Auth Redirect Fallback Error]', reErr);
      }
    }

    if(e.code !== 'auth/popup-closed-by-user' && e.code !== 'auth/cancelled-popup-request') {
      alert('구글 로그인 오류: ' + (e.message || '인증 연결 실패'));
    }
  }
}

async function _doLogout(){
  await signOut(_fbAuth);
  _fbUser=null;
  _setUserPill(null);
  _showAccountModal(false);
}

function initAuth(){
  document.getElementById('btn-ggl').addEventListener('click',_googleLogin);
  document.getElementById('btn-gst').addEventListener('click',()=>{_hideAuthOv();_setUserPill(null);});
  document.getElementById('user-pill').addEventListener('click',()=>{
    if(_fbUser){_showAccountModal(true);}
    else{
      const ov=document.getElementById('auth-ov');
      ov.style.display='flex';
      ov.style.opacity='1';
      ov.style.pointerEvents='all';
    }
  });
  document.getElementById('btn-lo').addEventListener('click',_doLogout);
  document.getElementById('btn-cam').addEventListener('click',()=>_showAccountModal(false));
  document.getElementById('am-ov').addEventListener('click',(e)=>{
    if(e.target===document.getElementById('am-ov'))_showAccountModal(false);
  });

  if(!_fbAuth){
    _hideAuthOv();
    _setUserPill(null);
    return;
  }

  try {
    getRedirectResult(_fbAuth).then(async (result) => {
      if (result && result.user) {
        _fbUser = result.user;
        _hideAuthOv();
        _setUserPill(result.user);
        await fbCloudLoad();
      }
    }).catch(err => {
      console.warn('[Auth] Redirect result check error:', err);
    });
  } catch(e) {}

  const authTimeout = setTimeout(() => {
    if (!_fbUser) {
      console.warn('[Auth] Firebase Auth timeout in APK environment - enabling guest fallback option.');
      const subEl = document.querySelector('#auth-ov .auth-sub');
      if (subEl) {
        subEl.innerHTML = '네트워크 연결이 지연되고 있습니다.<br><b style="color:#ffee00">게스트로 시작</b>을 누르면 바로 오프라인 플레이할 수 있습니다.';
      }
    }
  }, 3000);

  onAuthStateChanged(_fbAuth,async(user)=>{
    clearTimeout(authTimeout);
    _fbUser=user;
    if(user){
      _hideAuthOv();
      _setUserPill(user);
      await fbCloudLoad();
      await _loadHistoryRecords();
    }else{
      _historyRecords=getLocalHistory(null);
    }
  });
}

// ══════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════
loadSave();
applyMap(activeMap);
updateCoins();
document.getElementById('btn-cont').style.display=progress>0?'flex':'none';
document.getElementById('level-select').style.display='none';
showUI('menu');
initDemo();
loop();
initAuth();

// ══════════════════════════════════════════════════
// ACHIEVEMENT SYSTEM
// ══════════════════════════════════════════════════
const ACHIEVE_DEFS=[
  {id:'first',name:'첫 번째 탈출',desc:'레벨을 처음 클리어하세요',icon:'🎉',reward:100,check:s=>s.totalClears>=1},
  {id:'lv10',name:'레벨 10 달성',desc:'10레벨까지 도달하세요',icon:'🔟',reward:200,check:s=>s.maxLevel>=10},
  {id:'lv50',name:'레벨 50 달성',desc:'50레벨까지 도달하세요',icon:'5️⃣0️⃣',reward:500,check:s=>s.maxLevel>=50},
  {id:'arrows100',name:'화살표 100개',desc:'총 100개의 화살표를 탈출시키세요',icon:'🚀',reward:150,check:s=>s.totalArrows>=100},
  {id:'arrows500',name:'화살표 500개',desc:'총 500개 탈출',icon:'🌟',reward:400,check:s=>s.totalArrows>=500},
  {id:'perfect5',name:'완벽한 클리어 5회',desc:'실수 없이 레벨 5번 클리어',icon:'⭐',reward:300,check:s=>s.perfectClears>=5},
  {id:'combo20',name:'콤보 마스터',desc:'콤보 20을 달성하세요',icon:'🎵',reward:250,check:s=>s.maxCombo>=20},
  {id:'coins1000',name:'코인 부자',desc:'누적 1000 코인 획득',icon:'💰',reward:200,check:s=>s.totalCoinsEarned>=1000},
  {id:'dungeon1',name:'던전 탐험가',desc:'랜덤 던전을 완주하세요',icon:'🌍',reward:350,check:s=>s.dungeonWins>=1},
  {id:'inf20',name:'무한 도전자',desc:'무한 모드 20레벨 달성',icon:'♾️',reward:400,check:s=>s.infBest>=20},
];
let achieveState={unlocked:{},stats:{totalClears:0,maxLevel:0,totalArrows:0,perfectClears:0,maxCombo:0,totalCoinsEarned:0,dungeonWins:0,infBest:0}};
function loadAchievements(){try{const r=localStorage.getItem('e3_achieve');if(r){const d=JSON.parse(r);achieveState={unlocked:{},stats:{...achieveState.stats},...d};}}catch{}}
function saveAchievements(){try{localStorage.setItem('e3_achieve',JSON.stringify(achieveState));}catch{}}
function checkAchievements(){
  ACHIEVE_DEFS.forEach(a=>{
    if(!achieveState.unlocked[a.id]&&a.check(achieveState.stats)){
      achieveState.unlocked[a.id]=true;coins+=a.reward;doSave();updateCoins();saveAchievements();
      popup(`🏆 업적: ${a.name} +${a.reward}💰`,innerWidth/2,innerHeight*.35,'#FFD700');
    }
  });
}
// stat helpers used in endGame & launchArrow (typeof guard for before-init calls)
function _achStat(key,val,add=false,useMax=false){
  if(!achieveState)return;
  if(useMax)achieveState.stats[key]=Math.max(achieveState.stats[key]||0,val);
  else if(add)achieveState.stats[key]=(achieveState.stats[key]||0)+val;
  else achieveState.stats[key]=val;
}
function renderAchievements(){
  const list=document.getElementById('achieve-list');if(!list)return;
  list.innerHTML=ACHIEVE_DEFS.map(a=>{
    const done=achieveState.unlocked[a.id];
    return `<div class="achieve-item${done?' unlocked':''}">
      <div class="achieve-ico" style="opacity:${done?1:.35}">${a.icon}</div>
      <div class="achieve-info">
        <div class="achieve-name" style="opacity:${done?1:.6}">${a.name}</div>
        <div class="achieve-desc">${a.desc}</div>
        ${done?'':`<div class="achieve-reward">🎁 +${a.reward} 💰</div>`}
      </div>
      <div class="achieve-badge">${done?'✅':'🔒'}</div>
    </div>`;
  }).join('');
}
loadAchievements();

// ══════════════════════════════════════════════════
// DAILY MISSION SYSTEM
// ══════════════════════════════════════════════════
const MISSION_POOL=[
  {id:'clear3',label:'레벨 3개 클리어',icon:'🎮',total:3,reward:80,key:'levels'},
  {id:'escape15',label:'화살표 15개 탈출',icon:'🚀',total:15,reward:60,key:'arrows'},
  {id:'nomiss',label:'실수 없이 레벨 클리어',icon:'🎯',total:1,reward:120,key:'nomiss'},
  {id:'coins300',label:'코인 300개 획득',icon:'💰',total:300,reward:50,key:'coinsEarned'},
  {id:'combo10',label:'콤보 10 달성',icon:'🎵',total:10,reward:100,key:'combo'},
  {id:'multi1',label:'멀티플레이 1판',icon:'⚡',total:1,reward:90,key:'multi'},
  {id:'dungeon1',label:'던전 방 1개 클리어',icon:'🌍',total:1,reward:70,key:'dungeon'},
];
let missionState={};
function _todayKey(){const d=new Date();return `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`;}
function _initDailyMissions(){
  const shuffled=[...MISSION_POOL].sort(()=>Math.random()-.5).slice(0,3);
  missionState={day:_todayKey(),missions:shuffled.map(m=>({...m,prog:0,claimed:false}))};
  _saveMissions();
}
function _loadMissions(){
  try{
    const raw=localStorage.getItem('e3_missions');
    if(!raw){_initDailyMissions();return;}
    const data=JSON.parse(raw);
    if(data.day!==_todayKey()){_initDailyMissions();}else{missionState=data;}
  }catch{_initDailyMissions();}
}
function _saveMissions(){try{localStorage.setItem('e3_missions',JSON.stringify(missionState));}catch{}}
function _missionProg(key,amount=1){
  if(!missionState.missions)return;
  let updated=false;
  missionState.missions.forEach(m=>{if(m.key===key&&!m.claimed){m.prog=Math.min(m.total,(m.prog||0)+amount);updated=true;}});
  if(updated)_saveMissions();
}
function renderMissions(){
  const list=document.getElementById('mission-list');if(!list)return;
  if(!missionState.missions){list.innerHTML='';return;}
  list.innerHTML=missionState.missions.map((m,i)=>{
    const pct=Math.min(100,Math.floor((m.prog||0)/m.total*100));
    const done=(m.prog||0)>=m.total;
    return `<div class="mission-item">
      <div class="mission-title">${m.icon} ${m.label}</div>
      <div class="mission-prog-bar"><div class="mission-prog-fill" style="width:${pct}%"></div></div>
      <div class="mission-meta">
        <div class="mission-reward">🎁 +${m.reward} 💰</div>
        ${done&&!m.claimed?`<button class="mission-claim" onclick="window._claimMission(${i})">수령</button>`:m.claimed?'<span class="ms-done">✅ 수령 완료</span>':`<span class="ms-prog">${m.prog||0}/${m.total}</span>`}
      </div></div>`;
  }).join('');
  const now=new Date(),midnight=new Date(now);midnight.setHours(24,0,0,0);
  const diff=midnight-now,h=Math.floor(diff/3600000),mn=Math.floor((diff%3600000)/60000);
  const rt=document.getElementById('mission-reset-txt');if(rt)rt.textContent=`리셋까지: ${h}시간 ${mn}분`;
}
window._claimMission=function(i){
  const m=missionState.missions[i];if(!m||m.claimed||m.prog<m.total)return;
  m.claimed=true;coins+=m.reward;doSave();updateCoins();_saveMissions();
  popup(`+${m.reward} 💰 미션 보상!`,innerWidth/2,innerHeight*.4);renderMissions();
};
_loadMissions();

// ══════════════════════════════════════════════════
// CHEST SYSTEM
// ══════════════════════════════════════════════════
const CHESTS=[
  {id:'bronze',name:'브론즈 상자',ico:'📦',cost:50,cls:'bronze',
   table:[{w:50,icon:'💰',label:'30~70 코인',rarity:'common',min:30,max:70},{w:30,icon:'💰',label:'80~120 코인',rarity:'rare',min:80,max:120},{w:15,icon:'💎',label:'150~200 코인',rarity:'epic',min:150,max:200},{w:5,icon:'👑',label:'250~350 코인',rarity:'legendary',min:250,max:350}]},
  {id:'silver',name:'실버 상자',ico:'🎁',cost:150,cls:'silver',
   table:[{w:40,icon:'💰',label:'100~160 코인',rarity:'common',min:100,max:160},{w:35,icon:'💰',label:'180~260 코인',rarity:'rare',min:180,max:260},{w:18,icon:'💎',label:'300~420 코인',rarity:'epic',min:300,max:420},{w:7,icon:'👑',label:'500~700 코인',rarity:'legendary',min:500,max:700}]},
  {id:'gold',name:'골드 상자',ico:'🏆',cost:400,cls:'gold',
   table:[{w:30,icon:'💰',label:'250~350 코인',rarity:'common',min:250,max:350},{w:35,icon:'💎',label:'400~600 코인',rarity:'rare',min:400,max:600},{w:25,icon:'✨',label:'700~1000 코인',rarity:'epic',min:700,max:1000},{w:10,icon:'🌟',label:'1200~2000 코인',rarity:'legendary',min:1200,max:2000}]},
];
const RARITY_NAMES={common:'일반',rare:'✦ 희귀',epic:'✦✦ 에픽',legendary:'✦✦✦ 전설'};
function renderChestGrid(){
  const g=document.getElementById('chest-grid');if(!g)return;
  g.innerHTML=CHESTS.map(c=>`<div class="chest-card ${c.cls}" onclick="window._openChest('${c.id}')">
    <div class="chest-ico">${c.ico}</div><div class="chest-name">${c.name}</div>
    <div class="chest-cost">💰 ${c.cost}</div></div>`).join('');
}
window._openChest=function(id){
  const c=CHESTS.find(x=>x.id===id);if(!c)return;
  if(coins<c.cost){popup('코인이 부족합니다!',innerWidth/2,innerHeight*.4,'#ff6b6b');return;}
  coins-=c.cost;
  let r=Math.random()*c.table.reduce((a,x)=>a+x.w,0),item=c.table[c.table.length-1];
  for(const t of c.table){r-=t.w;if(r<=0){item=t;break;}}
  const amount=item.min+Math.floor(Math.random()*(item.max-item.min+1));
  coins+=amount;doSave();updateCoins();
  const ov=document.getElementById('chest-open-ov');
  document.getElementById('co-chest').textContent=c.ico;
  document.getElementById('co-result').textContent=item.icon;
  document.getElementById('co-label').textContent=`+${amount} 💰 코인`;
  const rel=document.getElementById('co-rarity');rel.textContent=RARITY_NAMES[item.rarity]||'';rel.className='co-rarity '+item.rarity;
  ov.classList.add('show');
  _achStat('totalCoinsEarned',amount,true);checkAchievements();
};
document.getElementById('co-close').addEventListener('click',()=>document.getElementById('chest-open-ov').classList.remove('show'));

// ══════════════════════════════════════════════════
// SPECIAL STAGES
// ══════════════════════════════════════════════════
const SPECIAL_STAGES=[
  {id:'timeatk',name:'⚡ 타임어택',icon:'⏱️',desc:'30초 안에 모든 화살표를 탈출!',reward:200,timeLimit:30},
  {id:'nomiss',name:'🎯 퍼펙트',icon:'🎯',desc:'실수 없이 클리어하면 보상!',reward:250,noMiss:true},
  {id:'blind',name:'🌑 블라인드',icon:'🌑',desc:'막힌 화살표 표시 없이 도전!',reward:300,blind:true},
  {id:'speed',name:'🔥 스피드',icon:'🔥',desc:'더 빠른 화살표로 도전!',reward:220,speed:true},
];

// ── BOSS ROUND STATE ─────────────────────────────
let bossRound=false,bossTimer=25,bossShuffleT=0,bossInterval=null;
// Pre-generate boss level indices: first at lvIdx 3~5, then +3~5 each time
let _bossLevelSet=(function(){
  const s=new Set();let n=2+Math.floor(Math.random()*3);
  while(n<500){s.add(n);n+=3+Math.floor(Math.random()*3);}
  return s;
})();

let specialMode=null,specialTimer=0,specialRunning=false;
function renderSpecialGrid(){
  const g=document.getElementById('special-grid');if(!g)return;
  g.innerHTML=SPECIAL_STAGES.map(s=>`<div class="special-card" onclick="window._startSpecial('${s.id}')">
    <div class="special-ico">${s.icon}</div><div class="special-name">${s.name}</div>
    <div class="special-desc">${s.desc}</div><div class="special-reward">+${s.reward} 💰 성공 시</div></div>`).join('');
}
window._startSpecial=function(id){
  const s=SPECIAL_STAGES.find(x=>x.id===id);if(!s)return;
  specialMode=s;specialTimer=s.timeLimit||0;specialRunning=true;
  document.getElementById('special-ov').classList.remove('on');
  const lvl=Math.max(0,Math.min(progress||0,49));
  lvIdx=lvl;lives=4;maxLiv=4;escaped=0;phase='playing';
  selId=null;lastId=null;controls.autoRotate=false;
  spawnArrows(getLevel(lvl),activeSkin);
  const cen=new THREE.Vector3();arrows.forEach(a=>cen.add(a.bp));cen.divideScalar(arrows.length);
  camera.position.set(cen.x,cen.y+(innerHeight>innerWidth*1.1?2:1.5),cen.z+(innerHeight>innerWidth*1.1?5.5:4.5));
  controls.target.copy(cen);controls.update();
  document.getElementById('menu').classList.add('hidden');
  document.getElementById('hud').style.display='block';document.getElementById('hud').style.opacity='1';
  document.getElementById('exit-btn').style.display='block';document.getElementById('pbar').style.display='none';
  const st=document.getElementById('special-timer');
  if(st){st.style.display=s.timeLimit?'block':'none';st.textContent=s.timeLimit?`⏱️ ${s.timeLimit}초`:'⚡ 특수 스테이지';}
  startOpening();
};
// Tick special timer — hooked into main loop below
const _origLoop=loop;
(function patchLoop(){
  const clk2=new THREE.Clock();
  const _origRaf=requestAnimationFrame;
  // We'll tick specialMode inside the existing render loop by patching tickArrow timing
})();
// simpler: use setInterval for special timer
let _specialInterval=null;
function _startSpecialInterval(){
  clearInterval(_specialInterval);
  if(!specialMode||!specialMode.timeLimit)return;
  _specialInterval=setInterval(()=>{
    if(!specialMode||!specialMode.timeLimit||phase!=='playing'){clearInterval(_specialInterval);return;}
    specialTimer=Math.max(0,specialTimer-0.25);
    const st=document.getElementById('special-timer');if(st)st.textContent=`⏱️ ${Math.ceil(specialTimer)}초`;
    if(specialTimer<=0){clearInterval(_specialInterval);endGame(false);}
  },250);
}
window._startSpecial=function(id){
  const s=SPECIAL_STAGES.find(x=>x.id===id);if(!s)return;
  specialMode=s;specialTimer=s.timeLimit||0;
  document.getElementById('special-ov').classList.remove('on');
  const lvl=Math.max(0,Math.min(progress||0,49));
  lvIdx=lvl;lives=4;maxLiv=4;escaped=0;phase='playing';
  selId=null;lastId=null;controls.autoRotate=false;
  spawnArrows(getLevel(lvl),activeSkin);
  const cen=new THREE.Vector3();arrows.forEach(a=>cen.add(a.bp));cen.divideScalar(arrows.length);
  camera.position.set(cen.x,cen.y+(innerHeight>innerWidth*1.1?2:1.5),cen.z+(innerHeight>innerWidth*1.1?5.5:4.5));
  controls.target.copy(cen);controls.update();
  document.getElementById('menu').classList.add('hidden');
  document.getElementById('hud').style.display='block';document.getElementById('hud').style.opacity='1';
  document.getElementById('exit-btn').style.display='block';document.getElementById('pbar').style.display='none';
  const st=document.getElementById('special-timer');
  if(st){st.style.display=s.timeLimit?'block':'none';if(s.timeLimit)st.textContent=`⏱️ ${s.timeLimit}초`;}
  if(s.timeLimit)_startSpecialInterval();

// ══════════════════════════════════════════════════
// BOSS ROUND MECHANICS
// ══════════════════════════════════════════════════
function bossShuffleArrows(){
  // Trigger glitch effect
  _bossGlitchFx();
  // Show warn text
  const w=document.getElementById('boss-shuffle-warn');
  if(w){w.style.display='block';setTimeout(()=>{w.style.display='none';},750);}
  // Reassign idle arrow directions (guaranteed solvable via greedy algo)
  const idle=arrows.filter(a=>a.state==='idle');
  if(!idle.length)return;
  const positions=idle.map(a=>a.def.pos);
  const rand=seededRand((Date.now()^(Math.random()*999999|0))&0xFFFFFF);
  const result=new Array(idle.length);
  const remaining=new Set([...Array(idle.length).keys()]);
  const shuffled=[...Array(idle.length).keys()];
  for(let i=shuffled.length-1;i>0;i--){const j=Math.floor(rand()*(i+1));[shuffled[i],shuffled[j]]=[shuffled[j],shuffled[i]];}
  while(remaining.size>0){
    let freed=false;
    for(const pi of shuffled){
      if(!remaining.has(pi))continue;
      const pos=positions[pi];
      const pool=[...remaining].filter(qi=>qi!==pi).map(qi=>positions[qi]);
      const validDirs=DIRS_ALL.filter(d=>!isBlockedByPool(pos,d,pool));
      if(validDirs.length>0){
        result[pi]=validDirs[Math.floor(rand()*validDirs.length)];
        remaining.delete(pi);freed=true;break;
      }
    }
    if(!freed){
      // fallback: pick outermost direction
      const pi=[...remaining][0];
      result[pi]=DIRS_ALL[Math.floor(rand()*DIRS_ALL.length)];
      remaining.delete(pi);
    }
  }
  // Apply new directions + rotate 3D meshes
  idle.forEach((a,i)=>{
    const nd=result[i];
    a.def.dir=nd;
    a.dv=DV[nd].clone();
    a.inner.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),a.dv);
  });
}

function _bossGlitchFx(){
  const c=document.getElementById('boss-glitch-canvas');
  if(!c)return;
  c.width=innerWidth;c.height=innerHeight;
  c.style.display='block';
  const ctx2=c.getContext('2d');
  let frame=0,total=10;
  function draw(){
    ctx2.clearRect(0,0,c.width,c.height);
    // Horizontal scanline tears
    const n=10+Math.floor(Math.random()*12);
    for(let i=0;i<n;i++){
      const y=Math.random()*c.height;
      const h=2+Math.random()*22;
      const alpha=0.35+Math.random()*0.55;
      // Alternate between magenta, cyan, white noise
      const pick=Math.random();
      if(pick<0.33)ctx2.fillStyle=`rgba(247,37,133,${alpha})`;
      else if(pick<0.66)ctx2.fillStyle=`rgba(76,201,240,${alpha})`;
      else ctx2.fillStyle=`rgba(255,255,255,${alpha*0.6})`;
      ctx2.fillRect(0,y,c.width,h);
    }
    // Offset blocks (RGB split feel)
    for(let i=0;i<4;i++){
      const sy=Math.random()*c.height,sh=6+Math.random()*30;
      const sx=(-20+Math.random()*40);
      ctx2.fillStyle=`rgba(183,9,255,0.18)`;
      ctx2.fillRect(sx,sy,c.width,sh);
    }
    // Noise rectangles
    for(let i=0;i<8;i++){
      const nx=Math.random()*c.width,ny=Math.random()*c.height;
      const nw=30+Math.random()*160,nh=3+Math.random()*14;
      ctx2.fillStyle=`rgba(255,255,255,${0.04+Math.random()*0.12})`;
      ctx2.fillRect(nx,ny,nw,nh);
    }
    frame++;
    if(frame<total)requestAnimationFrame(draw);
    else{ctx2.clearRect(0,0,c.width,c.height);c.style.display='none';}
  }
  requestAnimationFrame(draw);
}

function _startBossRound(){
  if(phase!=='playing')return;
  bossRound=true;bossTimer=25;bossShuffleT=2+Math.random()*2;
  const hud=document.getElementById('boss-hud');if(hud)hud.classList.add('on');
  _updateBossHUD();
  // Initial glitch to announce boss
  _bossGlitchFx();
  if(bossInterval)clearInterval(bossInterval);
  bossInterval=setInterval(()=>{
    if(!bossRound||phase!=='playing'){clearInterval(bossInterval);bossInterval=null;return;}
    bossTimer=Math.max(0,bossTimer-0.25);
    bossShuffleT-=0.25;
    _updateBossHUD();
    // Boss shuffles arrows every 2~4 seconds
    if(bossShuffleT<=0){
      bossShuffleT=2+Math.random()*2;
      if(arrows.some(a=>a.state==='idle'))bossShuffleArrows();
    }
    if(bossTimer<=0){clearInterval(bossInterval);bossInterval=null;endGame(false);}
  },250);
}

function _clearBossRound(){
  bossRound=false;
  if(bossInterval){clearInterval(bossInterval);bossInterval=null;}
  const hud=document.getElementById('boss-hud');if(hud)hud.classList.remove('on');
  const c=document.getElementById('boss-glitch-canvas');if(c)c.style.display='none';
  const w=document.getElementById('boss-shuffle-warn');if(w)w.style.display='none';
}

function _updateBossHUD(){
  const bar=document.getElementById('boss-bar');
  if(bar)bar.style.width=Math.max(0,bossTimer/25*100)+'%';
  const txt=document.getElementById('boss-timer-txt');
  if(txt){
    const s=Math.ceil(bossTimer);
    txt.textContent=s+'초';
    txt.style.color=s<=10?'#ff6b6b':'#f72585';
  }
}

  startOpening();
};

// ══════════════════════════════════════════════════
// DUNGEON MODE
// ══════════════════════════════════════════════════
let dungeonState=null,dungeonBest=0;
function saveDungeonBest(){try{localStorage.setItem('e3_dungeon_best',String(dungeonBest));}catch{}}
function _loadDungeonBest(){try{dungeonBest=parseInt(localStorage.getItem('e3_dungeon_best')||'0')||0;}catch{}}
function _renderDungeonPanel(){
  const r=document.getElementById('dungeon-rooms');
  if(r)r.innerHTML=Array.from({length:5},(_,i)=>{
    const st=dungeonState;
    const cls=st?(i<st.room?'done':i===st.room?'cur':''):'';
    const txt=st&&i<st.room?'✓':String(i+1);
    return `<div class="droom ${cls}">${txt}</div>`;
  }).join('');
  const b=document.getElementById('dungeon-best');
  if(b)b.textContent=dungeonBest>0?`최고 기록: ${dungeonBest}룸 완료`:'최고 기록: —';
}
function _loadDungeonLevel(){
  if(!dungeonState)return;
  const li=dungeonState.rooms[dungeonState.room];
  lvIdx=li;lives=dungeonState.lives;maxLiv=4;escaped=0;phase='playing';
  selId=null;lastId=null;controls.autoRotate=false;
  spawnArrows(getLevel(li),activeSkin);
  const cen=new THREE.Vector3();arrows.forEach(a=>cen.add(a.bp));cen.divideScalar(arrows.length);
  camera.position.set(cen.x,cen.y+(innerHeight>innerWidth*1.1?2:1.5),cen.z+(innerHeight>innerWidth*1.1?5.5:4.5));
  controls.target.copy(cen);controls.update();
  document.getElementById('menu').classList.add('hidden');
  document.getElementById('hud').style.display='block';document.getElementById('hud').style.opacity='1';
  document.getElementById('exit-btn').style.display='block';document.getElementById('pbar').style.display='none';
  const lt=document.getElementById('level-txt');if(lt)lt.textContent=`🌍 던전 ${dungeonState.room+1}/5`;
  updateHUD();startOpening();
}
function dungeonOnWin(r){
  dungeonState.coinsEarned=(dungeonState.coinsEarned||0)+r;dungeonState.lives=lives;dungeonState.room++;
  _missionProg('dungeon',1);
  if(dungeonState.room>=5){
    const total=(dungeonState.coinsEarned||0)+500;coins+=total;doSave();updateCoins();
    dungeonBest=Math.max(dungeonBest,5);saveDungeonBest();
    _achStat('dungeonWins',1,true);saveAchievements();checkAchievements();
    dungeonState=null;popup(`🌍 던전 완주! +${total}💰`,innerWidth/2,innerHeight*.35,'#40916c');
    setTimeout(()=>goMenu(),2000);
  }else{
    dungeonBest=Math.max(dungeonBest,dungeonState.room);saveDungeonBest();
    popup(`방 ${dungeonState.room}/5 클리어! +${r}💰`,innerWidth/2,innerHeight*.4,'#4cc9f0');
    setTimeout(()=>_loadDungeonLevel(),1200);
  }
}
document.getElementById('dungeon-start').addEventListener('click',()=>{
  document.getElementById('dungeon-ov').classList.remove('on');
  dungeonState={rooms:Array.from({length:5},()=>Math.floor(Math.random()*40)),room:0,lives:4,coinsEarned:0};
  _renderDungeonPanel();_loadDungeonLevel();
});
_loadDungeonBest();

// ══════════════════════════════════════════════════
// INFINITE MODE
// ══════════════════════════════════════════════════
let infState=null,infBest=0;
function saveInfBest(){try{localStorage.setItem('e3_inf_best',String(infBest));}catch{}}
function _loadInfBest(){try{infBest=parseInt(localStorage.getItem('e3_inf_best')||'0')||0;}catch{}}
function _renderInfPanel(){
  const cl=document.getElementById('inf-cur-lv'),bl=document.getElementById('inf-best-lv'),mk=document.getElementById('inf-mistakes');
  if(cl)cl.textContent=infState?String(infState.level+1):'—';
  if(bl)bl.textContent=infBest?String(infBest):'—';
  if(mk)mk.textContent=infState?String(infState.mistakes):'—';
}
function loadInfLevel(){
  if(!infState)return;
  const lvl=infState.level%999;
  lvIdx=lvl;lives=4;maxLiv=4;escaped=0;phase='playing';
  selId=null;lastId=null;controls.autoRotate=false;
  spawnArrows(getLevel(lvl),activeSkin);
  const cen=new THREE.Vector3();arrows.forEach(a=>cen.add(a.bp));cen.divideScalar(arrows.length);
  camera.position.set(cen.x,cen.y+(innerHeight>innerWidth*1.1?2:1.5),cen.z+(innerHeight>innerWidth*1.1?5.5:4.5));
  controls.target.copy(cen);controls.update();
  document.getElementById('menu').classList.add('hidden');
  document.getElementById('hud').style.display='block';document.getElementById('hud').style.opacity='1';
  document.getElementById('exit-btn').style.display='block';document.getElementById('pbar').style.display='none';
  const lt=document.getElementById('level-txt');if(lt)lt.textContent=`♾️ 레벨 ${infState.level+1}`;
  updateHUD();startOpening();
}
function infOnWin(r){
  coins+=r;doSave();updateCoins();infState.level++;
  infBest=Math.max(infBest,infState.level);saveInfBest();
  _achStat('infBest',infState.level,false,true);saveAchievements();checkAchievements();
  popup(`+${r}💰 레벨 ${infState.level}!`,innerWidth/2,innerHeight*.4);
  setTimeout(()=>loadInfLevel(),900);
}
document.getElementById('inf-start').addEventListener('click',()=>{
  document.getElementById('inf-ov').classList.remove('on');
  infState={level:0,mistakes:0};_renderInfPanel();loadInfLevel();
});
_loadInfBest();

// ══════════════════════════════════════════════════
// TIER REWARDS & VIEW
// ══════════════════════════════════════════════════
const TIER_REWARDS_MAP={iron:30,bronze:80,silver:150,gold:250,platinum:400,diamond:600,crossis:1000};
let claimedTierRewards={};
function _loadTierRewards(){try{claimedTierRewards=JSON.parse(localStorage.getItem('e3_tier_rwds')||'{}');}catch{}}
function _saveTierRewards(){try{localStorage.setItem('e3_tier_rwds',JSON.stringify(claimedTierRewards));}catch{}}
function checkTierReward(){
  const tier=getRankTier();
  if(claimedTierRewards[tier.id])return;
  claimedTierRewards[tier.id]=true;_saveTierRewards();
  const r=TIER_REWARDS_MAP[tier.id]||0;
  if(r>0){coins+=r;doSave();updateCoins();popup(`🎖️ ${tier.name} 달성! +${r}💰`,innerWidth/2,innerHeight*.35,'#FFD700');}
}
function renderTierView(){
  const box=document.getElementById('tier-current-box'),list=document.getElementById('tier-list');if(!box||!list)return;
  const tier=getRankTier(),next=getNextRankTier();
  const pct=next?Math.max(4,Math.min(100,(rankState.points-tier.min)/(next.min-tier.min)*100)):100;
  box.innerHTML=`
    <div class="tier-emblem-big">${tier.symbol}</div>
    <div class="tier-name-big" style="color:${tier.color}">${tier.name}</div>
    <div class="tier-pts-lbl">${rankState.placed?rankState.points+'점 · '+rankState.matches+'판':rankState.placements?`배치 ${rankState.placements}/5`:'배치고사 미완료'}</div>
    <div class="tier-bar-bg2"><div class="tier-bar-fill2" style="width:${pct}%;background:linear-gradient(90deg,${tier.color},#fff)"></div></div>
    <div class="tier-bar-lbl2"><span>${tier.name}</span><span>${next?next.name:'최고 티어'}</span></div>`;
  list.innerHTML=RANK_TIERS.map(t=>{
    const isCur=t.id===tier.id,done=rankState.placed&&rankState.points>=t.min;
    return `<div class="tier-row${isCur?' cur':''}">
      <div class="tier-row-sym">${t.symbol}</div>
      <div class="tier-row-info">
        <div class="tier-row-name" style="color:${isCur?t.color:'#fff'}">${t.name}</div>
        <div class="tier-row-pts">${t.min}점 이상</div>
        <div class="tier-row-reward">🎁 달성 보상: +${TIER_REWARDS_MAP[t.id]||0}💰</div>
      </div>
      <div class="tier-row-badge">${done?'✅':isCur?'🎯':'🔒'}</div>
    </div>`;
  }).join('');
  // 랭킹 렌더 (즉시 + 60초마다 자동 갱신)
  _renderTierRanking();
  clearInterval(_tierRefreshTimer);
  _tierRefreshTimer=setInterval(_renderTierRanking,60000);
}
var _tierRefreshTimer=null;
async function _renderTierRanking(){
  const myEl=document.getElementById('tier-my-rank');
  const listEl=document.getElementById('tier-rank-list');
  if(!myEl||!listEl)return;
  const nick=(_settings&&_settings.nickname)||'나';
  const myPts=rankState.placed?rankState.points:0;

  listEl.innerHTML='<div style="text-align:center;padding:16px;color:rgba(180,180,255,.5);font-size:13px">🔄 서버 연결 중… (최대 15초)</div>';

  // 서버에서 전체 리더보드 가져오기
  let lb=[];
  try{
    const ctrl=new AbortController();
    const timer=setTimeout(()=>ctrl.abort(),15000);
    const res=await fetch(LB_SERVER+'/leaderboard',{signal:ctrl.signal});
    clearTimeout(timer);
    const json=await res.json();
    if(json.ok&&json.data&&json.data.length>0){
      lb=json.data; // 서버가 rank 필드 포함해서 내려줌
      _setLeaderboardCache(lb);
    }else{lb=_getLeaderboard();}
  }catch(e){lb=_getLeaderboard();}

  // 배치 완료 유저라면 내 항목이 없을 경우 삽입
  if(rankState.placed){
    const hasMe=lb.some(e=>e.name===nick);
    if(!hasMe){
      lb=lb.filter(e=>e.name!==nick);
      lb.push({name:nick,pts:myPts,type:'human'});
      lb.sort((a,b)=>b.pts-a.pts);
      lb=lb.map((e,i)=>({...e,rank:i+1}));
    }
  }

  // ── 내 순위 카드 ──
  const meEntry=lb.find(e=>e.name===nick);
  if(meEntry){
    const r=meEntry.rank;
    const medal=r===1?'🥇':r===2?'🥈':r===3?'🥉':`#${r}`;
    myEl.innerHTML=`<div class="rank-my-pos">
      <div class="rank-my-badge">${medal}</div>
      <div class="rank-my-info">
        <div class="rank-my-name">${nick}</div>
        <div class="rank-my-pts">${meEntry.pts}점 · ${rankState.matches}판</div>
      </div>
      <div style="font-size:12px;color:${getRankTier().color}">${getRankTier().symbol} ${getRankTier().name}</div>
    </div>`;
  }else if(!rankState.placed){
    myEl.innerHTML='<div style="color:rgba(180,180,255,.6);font-size:13px;text-align:center;padding:8px;background:rgba(255,255,255,.04);border-radius:10px">🎯 배치고사 완료 후 내 순위가 표시됩니다<br><span style="font-size:11px;opacity:.7">배치: '+rankState.placements+'/5 완료</span></div>';
  }

  // ── 전체 순위표 (점수 높은 순, 최대 20명) ──
  if(!lb.length){
    listEl.innerHTML='<div style="text-align:center;padding:20px;color:rgba(180,180,255,.4);font-size:13px">랭크 대결을 시작하면 순위가 표시됩니다!</div>';
    return;
  }
  listEl.innerHTML=lb.slice(0,20).map(e=>{
    const pos=e.rank||(lb.indexOf(e)+1);
    const posClass=pos===1?'gold':pos===2?'silver':pos===3?'bronze':'';
    const isMe=e.name===nick;
    const typeTag=e.type==='ai'?'<span style="font-size:10px;opacity:.55;margin-left:3px">🤖</span>':'<span style="font-size:10px;opacity:.55;margin-left:3px">👤</span>';
    return `<div class="rank-entry${isMe?' me':''}">
      <div class="rank-pos ${posClass}">${pos===1?'🥇':pos===2?'🥈':pos===3?'🥉':pos}</div>
      <div class="rank-name">${e.name}${typeTag}${isMe?' ✦':''}</div>
      <div class="rank-pts">${e.pts}점</div>
    </div>`;
  }).join('');
}
_loadTierRewards();

// ══════════════════════════════════════════════════
// PANEL WIRING
// ══════════════════════════════════════════════════
const _panels={chest:'chest-ov',mission:'mission-ov',achieve:'achieve-ov',special:'special-ov',dungeon:'dungeon-ov',inf:'inf-ov',tier:'tier-ov'};
function _openPanel(id){document.getElementById(id).classList.add('on');}
function _closePanel(id){document.getElementById(id).classList.remove('on');}
// Modes hub button
document.getElementById('btn-modes').addEventListener('click',()=>_openPanel('modes-ov'));
document.getElementById('modes-back').addEventListener('click',()=>_closePanel('modes-ov'));
// Hub → sub-panel navigation
document.getElementById('mh-special').addEventListener('click',()=>{_closePanel('modes-ov');renderSpecialGrid();_openPanel('special-ov');});
document.getElementById('mh-dungeon').addEventListener('click',()=>{_closePanel('modes-ov');_loadDungeonBest();_renderDungeonPanel();_openPanel('dungeon-ov');});
document.getElementById('mh-inf').addEventListener('click',()=>{_closePanel('modes-ov');_loadInfBest();_renderInfPanel();_openPanel('inf-ov');});
document.getElementById('mh-chest').addEventListener('click',()=>{_closePanel('modes-ov');renderChestGrid();_openPanel('chest-ov');});
document.getElementById('mh-mission').addEventListener('click',()=>{_closePanel('modes-ov');_loadMissions();renderMissions();_openPanel('mission-ov');});
document.getElementById('mh-achieve').addEventListener('click',()=>{_closePanel('modes-ov');renderAchievements();_openPanel('achieve-ov');});
document.getElementById('mh-tier').addEventListener('click',()=>{_closePanel('modes-ov');_openTierPanel('modes-ov');});
// Back buttons for sub-panels (return to modes hub)
document.getElementById('chest-back').addEventListener('click',()=>{_closePanel('chest-ov');_openPanel('modes-ov');});
document.getElementById('mission-back').addEventListener('click',()=>{_closePanel('mission-ov');_openPanel('modes-ov');});
document.getElementById('achieve-back').addEventListener('click',()=>{_closePanel('achieve-ov');_openPanel('modes-ov');});
document.getElementById('special-back').addEventListener('click',()=>_closePanel('special-ov'));
document.getElementById('dungeon-back').addEventListener('click',()=>{_closePanel('dungeon-ov');_openPanel('modes-ov');});
document.getElementById('inf-back').addEventListener('click',()=>{_closePanel('inf-ov');_openPanel('modes-ov');});
let _tierReturnTo='modes-ov';
function _openTierPanel(returnTo){_tierReturnTo=returnTo||'modes-ov';renderTierView();_openPanel('tier-ov');}
document.getElementById('tier-back').addEventListener('click',()=>{clearInterval(_tierRefreshTimer);_closePanel('tier-ov');if(_tierReturnTo==='blast-rank-lobby'){showUI('blast-rank-lobby');}else{_openPanel(_tierReturnTo);}});
document.getElementById('mh-tier').removeEventListener('click',null);

// ══════════════════════════════════════════════════
// SETTINGS SYSTEM
// ══════════════════════════════════════════════════
const SETTINGS_KEY='e3_settings_v1';
let _settings={bgmVol:0.5,sfxVol:1,hudAutoHide:true,vibration:true,nickname:'나',activeTitle:''};
function _loadSettings(){
  try{const d=JSON.parse(localStorage.getItem(SETTINGS_KEY)||'{}');_settings={..._settings,...d};}catch{}
  // 닉네임이 기본값('나') 이거나 비어있으면 'player NNNN' 으로 자동 생성
  if(!_settings.nickname||_settings.nickname==='나'){
    _settings.nickname='player '+Math.floor(1000+Math.random()*9000);
    _saveSettings();
  }
}
function _saveSettings(){
  try{localStorage.setItem(SETTINGS_KEY,JSON.stringify(_settings));}catch{}
}
function _applySettings(){
  bgm.volume=_settings.bgmVol;
  const bgmSlider=document.getElementById('bgm-vol-slider');
  const sfxSlider=document.getElementById('sfx-vol-slider');
  const bgmVal=document.getElementById('bgm-vol-val');
  const sfxVal=document.getElementById('sfx-vol-val');
  const hudHide=document.getElementById('set-hud-hide');
  const vibEl=document.getElementById('set-vibration');
  if(bgmSlider){bgmSlider.value=Math.round(_settings.bgmVol*100);bgmVal.textContent=Math.round(_settings.bgmVol*100)+'%';}
  if(sfxSlider){sfxSlider.value=Math.round(_settings.sfxVol*100);sfxVal.textContent=Math.round(_settings.sfxVol*100)+'%';}
  if(hudHide)hudHide.checked=_settings.hudAutoHide;
  if(vibEl)vibEl.checked=_settings.vibration;
  // 닉네임: 잠금 상태로 표시
  _refreshNickDisplay();
}
_loadSettings();
// BGM 초기 볼륨 적용
bgm.volume=_settings.bgmVol;

// 슬라이더 실시간 반응 (input + change 둘 다 등록 - iOS 호환)
function _onBgmSlider(){
  _settings.bgmVol=this.value/100;
  bgm.volume=_settings.bgmVol;
  document.getElementById('bgm-vol-val').textContent=this.value+'%';
  _saveSettings();
}
function _onSfxSlider(){
  _settings.sfxVol=this.value/100;
  document.getElementById('sfx-vol-val').textContent=this.value+'%';
  _saveSettings();
}
const _bgmSliderEl=document.getElementById('bgm-vol-slider');
const _sfxSliderEl=document.getElementById('sfx-vol-slider');
_bgmSliderEl.addEventListener('input',_onBgmSlider);
_bgmSliderEl.addEventListener('change',_onBgmSlider);
_sfxSliderEl.addEventListener('input',_onSfxSlider);
_sfxSliderEl.addEventListener('change',_onSfxSlider);

// ── 닉네임 잠금 UI ────────────────────────────────────────────────────────────
const NICK_CHANGE_COST=500;

function _refreshNickDisplay(){
  const disp=document.getElementById('nick-display');
  if(disp)disp.textContent=_settings.nickname||'나';
  // 닉네임 입력칸 숨기기
  const inp=document.getElementById('set-nickname');
  const hint=document.getElementById('nick-change-hint');
  if(inp)inp.style.display='none';
  if(hint)hint.style.display='none';
}

document.getElementById('nick-change-btn').addEventListener('click',function(){
  const inp=document.getElementById('set-nickname');
  const hint=document.getElementById('nick-change-hint');
  if(inp.style.display==='none'){
    // 코인 확인
    if(coins<NICK_CHANGE_COST){
      hint.textContent='코인이 부족합니다! (필요: '+NICK_CHANGE_COST+'💰 / 보유: '+coins+'💰)';
      hint.style.display='block';
      return;
    }
    inp.style.display='block';
    inp.value=_settings.nickname;
    inp.focus();
    hint.textContent='새 닉네임을 입력 후 저장 & 닫기를 누르세요';
    hint.style.color='rgba(180,180,255,.7)';
    hint.style.display='block';
    this.textContent='취소';
  }else{
    inp.style.display='none';
    hint.style.display='none';
    this.textContent='변경 '+NICK_CHANGE_COST+'💰';
  }
});

// 설정창 열기/닫기
document.getElementById('btn-settings').addEventListener('click',()=>{
  _applySettings();
  document.getElementById('settings-ov').classList.add('on');
});

function _closeSettings(){
  const inp=document.getElementById('set-nickname');
  const nickBtn=document.getElementById('nick-change-btn');
  // 닉네임 변경 중이었으면 코인 차감 후 저장
  if(inp&&inp.style.display!=='none'){
    const newNick=(inp.value.trim()||'').slice(0,12);
    if(newNick&&newNick!==_settings.nickname){
      if(coins>=NICK_CHANGE_COST){
        coins-=NICK_CHANGE_COST;
        doSave();updateCoins();
        _settings.nickname=newNick;
      }
    }
    inp.style.display='none';
    if(nickBtn)nickBtn.textContent='변경 '+NICK_CHANGE_COST+'💰';
  }
  _settings.hudAutoHide=document.getElementById('set-hud-hide').checked;
  _settings.vibration=document.getElementById('set-vibration').checked;
  _saveSettings();
  if(!_settings.hudAutoHide&&phase==='playing'&&!hudOn){
    hudOn=true;
    document.getElementById('hud').style.opacity='1';
    document.getElementById('tap-restore').style.opacity='0';
    controls.autoRotate=false;
  }
  if(rankState.placed)_upsertLeaderboard(_settings.nickname,rankState.points);
  // 설정창 닫을 때 반드시 포커스 해제 → 키보드가 게임 중에 올라오는 현상 방지
  if(document.activeElement&&document.activeElement!==document.body){
    document.activeElement.blur();
  }
  document.getElementById('settings-ov').classList.remove('on');
}
document.getElementById('settings-close').addEventListener('click',_closeSettings);
document.getElementById('settings-ov').addEventListener('click',function(e){
  // stopPropagation: 설정창 닫을 때 터치가 캔버스까지 전달되는 문제 방지
  e.stopPropagation();
  if(e.target===this)_closeSettings();
});

// ── 닉네임 모달 (새로 만든 버전) ────────────────────────────────────────────
window._nickCallback=null;
window._nickSubmit=function(){
  var inp=document.getElementById('nick-input');
  var err=document.getElementById('nick-err');
  var v=(inp.value||'').trim().slice(0,12);
  if(!v||v.length<2){err.textContent='2글자 이상 입력해주세요';return;}
  if(/[<>"'&]/.test(v)){err.textContent='사용할 수 없는 문자입니다';return;}
  _settings.nickname=v;
  _saveSettings();
  document.getElementById('nick-modal').style.display='none';
  _socConnect();
  _refreshNickDisplay();
  var cb=window._nickCallback;
  window._nickCallback=null;
  if(cb)cb();
};
function _setupNicknameModal(onDone){
  if(_settings.nickname&&_settings.nickname!=='나'){
    if(onDone)onDone();
    return;
  }
  var inp=document.getElementById('nick-input');
  var err=document.getElementById('nick-err');
  inp.value='';err.textContent='';
  window._nickCallback=onDone;
  var m=document.getElementById('nick-modal');
  m.style.display='flex';
  setTimeout(function(){inp.focus();},100);
}

// ══════════════════════════════════════════════════
// LEADERBOARD (서버 기반 실시간 랭킹)
// ══════════════════════════════════════════════════
const LB_SERVER='https://threed-escape0.onrender.com';
const LB_KEY='e3_leaderboard_v1'; // 오프라인 캐시용

// AI 라이벌 기본 데이터 (서버 없을 때 폴백용)
const _LB_AI_SEED=[
  {name:'ArrowMaster',pts:820,type:'ai'},
  {name:'QuickEscape', pts:710,type:'ai'},
  {name:'NeonFlight',  pts:650,type:'ai'},
  {name:'StarRider',   pts:580,type:'ai'},
  {name:'BlazePath',   pts:490,type:'ai'},
  {name:'SkyBolt',     pts:420,type:'ai'},
  {name:'CrystalRun',  pts:350,type:'ai'},
  {name:'SwiftWing',   pts:260,type:'ai'},
  {name:'LightStep',   pts:180,type:'ai'},
  {name:'NewPlayer',   pts: 80,type:'ai'},
];

function _getLeaderboard(){
  try{
    const raw=JSON.parse(localStorage.getItem(LB_KEY)||'[]');
    if(raw.length>0)return raw;
  }catch{}
  // 캐시 없으면 AI 씨드 반환
  return _LB_AI_SEED.map(e=>({...e}));
}
function _setLeaderboardCache(lb){
  try{localStorage.setItem(LB_KEY,JSON.stringify(lb));}catch{}
}

// 서버에 내 점수 저장 + 로컬 캐시 업데이트
async function _upsertLeaderboard(name,pts){
  if(!name||pts<=0)return;
  // 로컬 캐시에도 반영 (오프라인 대비)
  let lb=_getLeaderboard();
  lb=lb.filter(e=>!e.isMe);
  lb.push({name,pts,isMe:true,updated:Date.now()});
  lb.sort((a,b)=>b.pts-a.pts);
  lb=lb.slice(0,20);
  _setLeaderboardCache(lb);
  // 서버 전송
  try{
    const res=await fetch(LB_SERVER+'/leaderboard',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({name,pts})
    });
    const json=await res.json();
    if(json.ok&&json.data){
      // 서버 응답으로 캐시 갱신 (isMe 표시 추가)
      const nick=name;
      const serverLb=json.data.map(e=>({...e,isMe:e.name===nick}));
      _setLeaderboardCache(serverLb);
    }
  }catch(e){/* 오프라인 - 로컬 캐시 유지 */}
}

// 배틀 결과 서버 기록 (사람 vs AI, 사람 vs 사람, AI vs AI)
async function _recordBattleResult(winner,winnerPts,winnerType,loser,loserPts,loserType){
  try{
    await fetch(LB_SERVER+'/battle',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({winner,winnerPts,winnerType:winnerType||'human',loser,loserPts,loserType:loserType||'ai'})
    });
  }catch(e){}
}

const _origSaveRankState=saveRankState;
saveRankState=function(){
  _origSaveRankState();
  if(rankState.placed){
    _upsertLeaderboard(_settings.nickname||'나',rankState.points);
  }
};
// 초기 등록 — 로컬에 저장된 점수를 시작 시 서버에 즉시 동기화
(function(){
  const nick=(_settings&&_settings.nickname)||'';
  if(nick&&rankState.placed&&rankState.points>0){
    _upsertLeaderboard(nick,rankState.points);
  }
})();


// ══════════════════════════════════════════════════
// DIFFICULTY SYSTEM
// ══════════════════════════════════════════════════
var _currentDiff='normal';
var DIFF_CONFIG={
  easy:  {speedMult:0.75,scoreMult:0.8, lives:6,label:'쉬움',  ico:'🌱'},
  normal:{speedMult:1.0, scoreMult:1.0, lives:5,label:'보통',  ico:'⚡'},
  hard:  {speedMult:1.3, scoreMult:1.5, lives:5,label:'어려움',ico:'🔥'},
  extreme:{speedMult:1.6,scoreMult:2.0, lives:4,label:'극한',  ico:'💀'},
};
var _pendingLevelIdx=null;
window._diffSpeed=1.0;
window._diffLives=null;

function _openDiffSelect(levelIdx){
  _pendingLevelIdx=levelIdx;
  document.getElementById('diff-ov').classList.add('on');
}
function _closeDiffSelect(){
  document.getElementById('diff-ov').classList.remove('on');
}
function _applyDifficulty(){
  var cfg=DIFF_CONFIG[_currentDiff]||DIFF_CONFIG.normal;
  window._diffSpeed=cfg.speedMult;
  return cfg;
}

document.querySelectorAll('.diff-card').forEach(function(card){
  card.addEventListener('click',function(){
    document.querySelectorAll('.diff-card').forEach(function(c){c.classList.remove('selected');});
    card.classList.add('selected');
    _currentDiff=card.dataset.diff;
  });
});

document.getElementById('diff-start-btn').addEventListener('click',function(){
  _closeDiffSelect();
  var cfg=_applyDifficulty();
  window._diffLives=3;
  if(_pendingLevelIdx!==null&&_pendingLevelIdx!=='rank'){
    var idx=_pendingLevelIdx;
    _pendingLevelIdx=null;
    setTimeout(function(){loadLevel(idx);},300);
  }
});
document.getElementById('diff-back-btn').addEventListener('click',_closeDiffSelect);

// Rollback btn-cont to load current progress directly without difficulty selection
(function(){
  var btnCont = document.getElementById('btn-cont');
  if(btnCont){
    btnCont.onclick = function(){
      if(typeof loadLevel === 'function' && typeof progress !== 'undefined'){
        loadLevel(progress);
      }
    };
  }
  var btnNext = document.getElementById('btn-next');
  if(btnNext){
    btnNext.onclick = function(){
      if(typeof loadLevel === 'function' && typeof lvIdx !== 'undefined'){
        loadLevel(lvIdx + 1);
      }
    };
  }
  var btnRetry = document.getElementById('btn-retry');
  if(btnRetry){
    btnRetry.onclick = function(){
      if(typeof loadLevel === 'function' && typeof lvIdx !== 'undefined'){
        loadLevel(lvIdx);
      }
    };
  }
})();

// Difficulty-aware score multiplier: multiply coins earned by diff multiplier
var _diffScoreMult=1.0;
(function(){
  var _origLoadLevel=window.loadLevel||function(){};
  window.loadLevel=function(i){
    var cfg=DIFF_CONFIG[_currentDiff]||DIFF_CONFIG.normal;
    _diffScoreMult=cfg.scoreMult;
    if(window._diffLives&&typeof lives!=='undefined'){
      // Override lives after loadLevel runs
      setTimeout(function(){
        lives=window._diffLives;
        maxLiv=window._diffLives;
        updateHUD&&updateHUD();
      },50);
    }
    return _origLoadLevel.call(this,i);
  };
})();

// ══════════════════════════════════════════════════
// FRIEND SYSTEM
// ══════════════════════════════════════════════════
var FRIENDS_KEY='e3_friends_v1';
var RECENT_KEY='e3_recent_v1';
var MSGS_KEY='e3_msgs_v1';

function _getFriends(){try{return JSON.parse(localStorage.getItem(FRIENDS_KEY)||'[]');}catch(e){return[];}}
function _saveFriends(f){try{localStorage.setItem(FRIENDS_KEY,JSON.stringify(f));}catch(e){}}
function _getRecent(){try{return JSON.parse(localStorage.getItem(RECENT_KEY)||'[]');}catch(e){return[];}}
function _saveRecent(r){try{localStorage.setItem(RECENT_KEY,JSON.stringify(r));}catch(e){}}
function _getMsgs(){try{return JSON.parse(localStorage.getItem(MSGS_KEY)||'{}');}catch(e){return{};}}
function _saveMsgs(m){try{localStorage.setItem(MSGS_KEY,JSON.stringify(m));}catch(e){}}

var _friendTab='list';
var _msgTarget=null;

function _openFriends(){
  document.getElementById('friend-ov').classList.add('on');
  _renderFriendTab(_friendTab);
}
function _closeFriends(){
  document.getElementById('friend-ov').classList.remove('on');
  document.getElementById('msg-input-area').style.display='none';
  _msgTarget=null;
}

function _renderFriendTab(tab){
  _friendTab=tab;
  document.querySelectorAll('.friend-tab').forEach(function(t){
    t.classList.toggle('active',t.dataset.ftab===tab);
  });
  var body=document.getElementById('friend-body');
  var msgArea=document.getElementById('msg-input-area');
  msgArea.style.display='none';
  _msgTarget=null;

  if(tab==='list'){
    var friends=_getFriends();
    if(!friends.length){
      body.innerHTML='<div class="friend-empty">👥 아직 친구가 없습니다.<br>친구를 추가해보세요!</div>';
      return;
    }
    body.innerHTML=friends.map(function(f,i){
      return '<div class="friend-card">'
        +'<div class="friend-avatar">'+f.name.charAt(0).toUpperCase()+'</div>'
        +'<div class="friend-info">'
        +'<div class="friend-name">'+f.name+'</div>'
        +'<div class="friend-status">친구 · '+new Date(f.addedAt).toLocaleDateString('ko-KR')+'</div>'
        +'</div>'
        +'<div class="friend-actions">'
        +'<button class="friend-action-btn" onclick="_openMsgThread(\''+f.name+'\')">💬</button>'
        +'<button class="friend-action-btn danger" onclick="_removeFriend('+i+')">✕</button>'
        +'</div>'
        +'</div>';
    }).join('');
  } else if(tab==='add'){
    body.innerHTML='<div class="friend-search-row">'
      +'<input class="friend-search-input" id="friend-search-input" placeholder="닉네임으로 친구 추가 (정확히 입력)" maxlength="12">'
      +'<button class="friend-search-btn" id="friend-search-btn">추가</button>'
      +'</div>'
      +'<div style="color:rgba(180,180,240,.5);font-size:12px;text-align:center;padding:4px 0 8px">상대방도 자동으로 나를 친구 추가합니다 🔄</div>'
      +'<div id="friend-search-result"></div>';
    document.getElementById('friend-search-btn').onclick=async function(){
      var name=document.getElementById('friend-search-input').value.trim();
      if(!name){_friendMsg('닉네임을 입력해주세요','#f72585');return;}
      var myName=(_settings&&_settings.nickname)||'나';
      if(name===myName){_friendMsg('자기 자신은 추가할 수 없습니다','#f72585');return;}
      var friends=_getFriends();
      if(friends.find(function(f){return f.name===name;})){_friendMsg('이미 친구입니다 😊','#4cc9f0');return;}
      _friendMsg('확인 중…','#aaa');
      var exists=await _checkUserExists(name);
      if(!exists){_friendMsg('존재하지 않는 유저입니다 ❌','#f72585');return;}
      friends.push({name:name,addedAt:Date.now()});
      _saveFriends(friends);
      _socSend({type:'friend_request',to:name});
      document.getElementById('friend-search-input').value='';
      _updateFriendBadge();
      setTimeout(function(){_openMsgThread(name);},50);
    };
  } else if(tab==='recent'){
    var recent=_getRecent();
    if(!recent.length){
      body.innerHTML='<div class="friend-empty">🎮 아직 만난 플레이어가 없습니다.<br>멀티플레이를 해보세요!</div>';
      return;
    }
    var friendsList=_getFriends();
    body.innerHTML=recent.slice().reverse().map(function(r){
      var alreadyFriend=friendsList.find(function(f){return f.name===r.name;});
      return '<div class="friend-card">'
        +'<div class="friend-avatar">'+r.name.charAt(0).toUpperCase()+'</div>'
        +'<div class="friend-info">'
        +'<div class="friend-name">'+r.name+'</div>'
        +'<div class="friend-status">'+(r.mode||'멀티플레이')+' · '+new Date(r.at).toLocaleDateString('ko-KR')+'</div>'
        +'</div>'
        +'<div class="friend-actions">'
        +(alreadyFriend
          ?'<span style="color:rgba(100,220,100,.8);font-size:12px;font-weight:700">✓ 친구</span>'
          :'<button class="friend-action-btn" onclick="_addFriendByName(\''+r.name+'\')">+ 추가</button>')
        +'</div>'
        +'</div>';
    }).join('');
  } else if(tab==='msg'){
    var friendsForMsg=_getFriends();
    var msgs=_getMsgs();
    if(!friendsForMsg.length){
      body.innerHTML='<div class="friend-empty">💬 친구를 먼저 추가해주세요</div>';
      return;
    }
    body.innerHTML='<div class="bp-tier-label" style="padding:4px 0 12px">대화할 친구를 선택하세요</div>'
      +friendsForMsg.map(function(f){
        var fMsgs=msgs[f.name]||[];
        var last=fMsgs[fMsgs.length-1];
        return '<div class="friend-card" style="cursor:pointer" onclick="_openMsgThread(\''+f.name+'\')">'
          +'<div class="friend-avatar">'+f.name.charAt(0).toUpperCase()+'</div>'
          +'<div class="friend-info">'
          +'<div class="friend-name">'+f.name+'</div>'
          +'<div class="friend-status">'+(last?last.text.slice(0,24)+'…':'아직 대화 없음')+'</div>'
          +'</div>'
          +'<div style="color:rgba(180,180,240,.4);font-size:18px">›</div>'
          +'</div>';
      }).join('');
  }
}

function _friendMsg(msg,col){
  var el=document.getElementById('friend-search-result');
  if(!el)return;
  el.innerHTML='<div style="text-align:center;padding:12px;font-size:13px;font-weight:700;color:'+col+'">'+msg+'</div>';
  setTimeout(function(){if(el)el.innerHTML='';},3000);
}

function _removeFriend(idx){
  var friends=_getFriends();
  var removed=friends[idx];
  friends.splice(idx,1);
  _saveFriends(friends);
  _renderFriendTab('list');
  // 서버에 삭제 알림 전송 (상대방에게도 알림)
  if(removed&&removed.name){
    _socSend({type:'friend_delete',to:removed.name});
  }
}

async function _addFriendByName(name){
  var friends=_getFriends();
  if(friends.find(function(f){return f.name===name;})){
    _openFriends();
    setTimeout(function(){_openMsgThread(name);},50);
    return;
  }
  var exists=await _checkUserExists(name);
  if(!exists){
    _showToast('❌ 존재하지 않는 유저입니다: '+name);
    return;
  }
  friends.push({name:name,addedAt:Date.now()});
  _saveFriends(friends);
  _updateFriendBadge();
  _socSend({type:'friend_request',to:name});
  _openFriends();
  setTimeout(function(){_openMsgThread(name);},50);
}

async function _checkUserExists(name){
  try{
    var res=await fetch(LB_SERVER+'/user-exists?nickname='+encodeURIComponent(name));
    var json=await res.json();
    return json.ok&&json.exists===true;
  }catch(e){
    return true; // 서버 연결 실패 시 허용
  }
}

function _renderMsgThread(friendName,thread){
  var myName=(_settings&&_settings.nickname)||'나';
  var threadHtml=thread.map(function(m){
    var isMe=(m.from===myName||m.from==='me');
    return '<div>'
      +'<div class="msg-bubble '+(isMe?'me':'them')+'">'+_escHtml(m.text)+'</div>'
      +'<div class="msg-time" style="text-align:'+(isMe?'right':'left')+'">'+new Date(m.at).toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'})+'</div>'
      +'</div>';
  }).join('');
  if(!thread.length)threadHtml='<div class="friend-empty" style="padding:20px">아직 대화가 없습니다<br>첫 메시지를 보내보세요! 💬</div>';
  var body=document.getElementById('friend-body');
  if(!body)return;
  body.innerHTML='<div style="display:flex;align-items:center;gap:10px;padding:8px 0 16px;border-bottom:1px solid rgba(255,255,255,.1);margin-bottom:12px">'
    +'<button onclick="_renderFriendTab(\'msg\')" style="background:rgba(255,255,255,.1);border:none;color:#fff;padding:6px 12px;border-radius:20px;cursor:pointer;font-size:13px">← 뒤로</button>'
    +'<span style="font-size:15px;font-weight:700;color:#fff">'+_escHtml(friendName)+'</span>'
    +'</div>'
    +'<div class="msg-thread" id="msg-thread">'+threadHtml+'</div>';
  document.getElementById('msg-input-area').style.display='flex';
  // friend-body가 실제 스크롤 컨테이너
  setTimeout(function(){
    var b=document.getElementById('friend-body');
    if(b)b.scrollTop=b.scrollHeight;
  },80);
}

function _openMsgThread(friendName){
  _msgTarget=friendName;
  _friendTab='msg-thread';
  // 로컬 캐시로 먼저 렌더 (빠른 표시)
  var msgs=_getMsgs();
  _renderMsgThread(friendName,msgs[friendName]||[]);
  // 서버에서 최신 히스토리 요청
  _socSend({type:'dm_history_req',with:friendName});
}

function _sendMsg(){
  if(!_msgTarget)return;
  var inp=document.getElementById('msg-input');
  var text=inp.value.trim();
  if(!text)return;
  inp.value='';
  var myName=(_settings&&_settings.nickname)||'나';
  var at=Date.now();
  // 로컬 캐시에 즉시 반영
  var msgs=_getMsgs();
  if(!msgs[_msgTarget])msgs[_msgTarget]=[];
  msgs[_msgTarget].push({from:myName,text:text,at:at});
  _saveMsgs(msgs);
  _renderMsgThread(_msgTarget,msgs[_msgTarget]);
  // 서버로 실제 전송
  _socSend({type:'dm',to:_msgTarget,text:text});
}

function _escHtml(s){
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function _recordRecentPlayer(name,mode){
  var myName=(_settings&&_settings.nickname)||'나';
  if(!name||name===myName)return;
  var recent=_getRecent();
  var existing=recent.findIndex(function(r){return r.name===name;});
  if(existing>=0)recent.splice(existing,1);
  recent.push({name:name,mode:mode||'멀티플레이',at:Date.now()});
  while(recent.length>20)recent.shift();
  _saveRecent(recent);
}

function _updateFriendBadge(){
  var friends=_getFriends();
  var badge=document.getElementById('friend-badge');
  if(badge&&friends.length>0){
    badge.textContent=friends.length;
    badge.style.display='flex';
  }else if(badge){
    badge.style.display='none';
  }
}

// ══════════════════════════════════════════════════
// SOCIAL WEBSOCKET (1:1 실시간 채팅 + 양방향 친구추가)
// ══════════════════════════════════════════════════
var _socWs=null;
var _socReady=false;
var _socReconnectTimer=null;
// 연결 전 보내려던 메시지를 임시 보관 (서버 콜드스타트 대응)
var _socPendingQueue=[];

function _socConnect(){
  clearTimeout(_socReconnectTimer);
  var nick=(_settings&&_settings.nickname)||'';
  // '나' 또는 빈 닉네임이면 연결 안 함 (닉네임 설정 필요)
  if(!nick||nick==='나')return;
  var wsUrl=LB_SERVER.replace('https://','wss://').replace('http://','ws://');
  try{
    _socWs=new WebSocket(wsUrl);
    _socWs.onopen=function(){
      _socReady=true;
      _socWs.send(JSON.stringify({type:'register',nickname:nick}));
      // 연결 성공 시 밀려있던 메시지 전송
      var pending=_socPendingQueue.splice(0);
      for(var i=0;i<pending.length;i++){
        try{_socWs.send(JSON.stringify(pending[i]));}catch(e){}
      }
    };
    _socWs.onmessage=function(ev){
      var msg;try{msg=JSON.parse(ev.data);}catch{return;}
      _handleSocMsg(msg);
      if(window._onSocWsMsg)window._onSocWsMsg(msg);
    };
    _socWs.onclose=function(){
      _socReady=false;
      _socWs=null;
      // 5초 후 재연결
      _socReconnectTimer=setTimeout(_socConnect,5000);
    };
    _socWs.onerror=function(){if(_socWs)_socWs.close();};
  }catch(e){}
}

function _socSend(obj){
  if(_socWs&&_socWs.readyState===1){
    _socWs.send(JSON.stringify(obj));
    return true;
  }
  // 연결 안 됐으면 큐에 보관 (재연결 시 자동 전송)
  // dm 전송과 friend_request/delete만 큐잉 (중복 방지)
  var queueTypes=['dm','friend_request','friend_delete'];
  if(queueTypes.indexOf(obj.type)>=0){
    // 같은 내용 중복 방지
    var key=JSON.stringify(obj);
    var alreadyQueued=_socPendingQueue.some(function(q){return JSON.stringify(q)===key;});
    if(!alreadyQueued)_socPendingQueue.push(obj);
  }
  return false;
}

// Render 서버가 잠들지 않도록 9분마다 /ping 호출
setInterval(function(){
  fetch(LB_SERVER+'/ping').catch(function(){});
},9*60*1000);

function _handleSocMsg(msg){
  if(!msg||!msg.type)return;

  // 상대방이 보낸 DM 수신
  if(msg.type==='dm'){
    var msgs=_getMsgs();
    if(!msgs[msg.from])msgs[msg.from]=[];
    msgs[msg.from].push({from:msg.from,text:msg.text,at:msg.at});
    _saveMsgs(msgs);
    // 현재 해당 대화창 열려있으면 실시간 업데이트
    if(_msgTarget===msg.from&&document.getElementById('msg-thread')){
      _renderMsgThread(msg.from,msgs[msg.from]);
    }
    // 알림 토스트
    _showToast('💬 '+msg.from+': '+msg.text.slice(0,30)+(msg.text.length>30?'…':''));
    return;
  }

  // 서버 히스토리 수신 → 로컬 캐시 갱신 후 UI 업데이트
  if(msg.type==='dm_history'){
    if(!msg.messages||!msg.with)return;
    var myName=(_settings&&_settings.nickname)||'나';
    var msgs2=_getMsgs();
    // 서버 히스토리를 로컬 포맷으로 변환
    var converted=msg.messages.map(function(m){
      return{from:m.from===myName?'me':m.from,text:m.text,at:m.at};
    });
    // 서버 히스토리가 더 많으면 교체, 적으면 로컬 유지
    if(converted.length>=(msgs2[msg.with]||[]).length){
      msgs2[msg.with]=converted;
      _saveMsgs(msgs2);
    }
    if(_msgTarget===msg.with&&document.getElementById('msg-thread')){
      _renderMsgThread(msg.with,msgs2[msg.with]||[]);
    }
    return;
  }

  // 친구 요청 수신 → 자동으로 양방향 추가 + 대화하기 버튼 토스트
  if(msg.type==='friend_request_incoming'){
    var from=msg.from;
    if(!from)return;
    var friends=_getFriends();
    if(!friends.find(function(f){return f.name===from;})){
      friends.push({name:from,addedAt:Date.now()});
      _saveFriends(friends);
      _updateFriendBadge();
      // 친구 목록 탭 열려있으면 새로고침
      if(document.getElementById('friend-ov').classList.contains('on')&&_friendTab==='list'){
        _renderFriendTab('list');
      }
    }
    // 대화하기 버튼 포함 토스트
    _showFriendToast(from);
    return;
  }

  // 친구가 나를 삭제했을 때 → 내 목록에서도 제거
  if(msg.type==='friend_deleted_by'){
    var removedBy=msg.from;
    if(!removedBy)return;
    var myFriends=_getFriends();
    var before=myFriends.length;
    myFriends=myFriends.filter(function(f){return f.name!==removedBy;});
    if(myFriends.length!==before){
      _saveFriends(myFriends);
      _updateFriendBadge();
      if(document.getElementById('friend-ov').classList.contains('on')&&_friendTab==='list'){
        _renderFriendTab('list');
      }
    }
    return;
  }

  // 세션 교체 알림 (같은 닉네임으로 다른 기기 접속)
  if(msg.type==='session_replaced'){
    console.log('[soc] session replaced on another device');
    return;
  }
}

// 알림 토스트
function _showToast(text){
  var el=document.createElement('div');
  el.style.cssText='position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:rgba(30,30,60,.95);border:1px solid rgba(76,201,240,.3);color:#fff;font-size:13px;font-weight:700;padding:10px 18px;border-radius:20px;z-index:9999;max-width:300px;text-align:center;pointer-events:none;transition:opacity .4s';
  el.textContent=text;
  document.body.appendChild(el);
  setTimeout(function(){el.style.opacity='0';setTimeout(function(){el.remove();},400);},3500);
}

// 친구 요청 수신 토스트 (대화하기 버튼 포함)
function _showFriendToast(fromNick){
  var el=document.createElement('div');
  el.style.cssText='position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:rgba(20,20,55,.97);border:1px solid rgba(100,200,100,.4);color:#fff;font-size:13px;font-weight:700;padding:12px 16px;border-radius:16px;z-index:9999;max-width:300px;text-align:center;transition:opacity .4s;display:flex;flex-direction:column;gap:8px;align-items:center';
  el.innerHTML='<div>👥 <b>'+_escHtml(fromNick)+'</b> 님이 친구 추가했습니다!</div>'
    +'<button style="background:linear-gradient(135deg,#4361ee,#7209b7);border:none;color:#fff;padding:7px 18px;border-radius:20px;cursor:pointer;font-size:12px;font-weight:700">💬 대화하기</button>';
  el.querySelector('button').onclick=function(){
    el.remove();
    _openFriends();
    setTimeout(function(){_openMsgThread(fromNick);},50);
  };
  document.body.appendChild(el);
  setTimeout(function(){el.style.opacity='0';setTimeout(function(){if(el.parentNode)el.remove();},400);},6000);
}

// 닉네임 설정 저장 시 소셜 연결 (또는 재연결)
var _origSaveSettings=_saveSettings;
_saveSettings=function(){
  _origSaveSettings();
  // 닉네임 변경 시 기존 연결 닫고 재연결
  if(_socWs){_socWs.onclose=null;_socWs.close();}
  _socReady=false;_socWs=null;
  setTimeout(_socConnect,300);
};

// 초기 소셜 연결
_socConnect();

document.querySelectorAll('.friend-tab').forEach(function(tab){
  tab.addEventListener('click',function(){_renderFriendTab(tab.dataset.ftab);});
});
document.getElementById('friend-close-btn').addEventListener('click',_closeFriends);
document.getElementById('btn-friend').addEventListener('click',_openFriends);
document.getElementById('msg-send-btn').addEventListener('click',_sendMsg);
document.getElementById('msg-input').addEventListener('keydown',function(e){if(e.key==='Enter')_sendMsg();});

// ── 전역 스코프 노출 (ES module 내부 함수를 onclick에서 호출하기 위해) ──────
window._removeFriend   = _removeFriend;
window._openMsgThread  = _openMsgThread;
window._addFriendByName= _addFriendByName;
window._sendMsg        = _sendMsg;
window._renderFriendTab= _renderFriendTab;

// Add friend from multiplayer result
(function(){
  var btn=document.getElementById('mr-add-friend-btn');
  if(!btn)return;
  btn.addEventListener('click',function(){
    if(!window._lastOpponentName)return;
    _addFriendByName(window._lastOpponentName);
    btn.textContent='✓ 친구 추가됨';
    btn.disabled=true;
    btn.style.opacity='.6';
  });
})();

// ══════════════════════════════════════════════════
// BATTLE PASS SYSTEM
// ══════════════════════════════════════════════════
var BP_KEY='e3_battlepass_v3';
var BP_LEVELS=30;
var BP_SEASON=1;
// 레벨별 필요 XP (index = 현재 레벨, 값 = 다음 레벨까지 필요량)
// 레벨 0→1: 200 XP, 이후 150씩 증가
var BP_LEVEL_XP=[
  200,350,500,650,800,950,1100,1250,1400,1550,
  1700,1850,2000,2150,2300,2450,2600,2750,2900,3050,
  3200,3350,3500,3650,3800,3950,4100,4250,4400,4550
];

var BP_FREE_REWARDS=[
  {level:1, ico:'🎁', name:'환영 박스', type:'box', value:1},
  {level:3, ico:'💰', name:'코인 ×100', type:'coins', value:100},
  {level:5, ico:'🎁', name:'미스터리 박스', type:'box', value:2},
  {level:8, ico:'💰', name:'코인 ×150', type:'coins', value:150},
  {level:10, ico:'⭐', name:'스킨: 루비', type:'skin', value:'ruby_free'},
  {level:12, ico:'🎁', name:'골든 박스', type:'box', value:2},
  {level:15, ico:'💰', name:'코인 ×200', type:'coins', value:200},
  {level:18, ico:'🎁', name:'슈퍼 박스', type:'box', value:3},
  {level:20, ico:'💰', name:'코인 ×250', type:'coins', value:250},
  {level:25, ico:'🎁', name:'레전드 박스', type:'box', value:3},
  {level:28, ico:'💰', name:'코인 ×300', type:'coins', value:300},
  {level:30, ico:'🏆', name:'시즌 트로피', type:'title', value:'s1_champ'},
];

var BP_PREMIUM_REWARDS=[
  {level:1, ico:'🌟', name:'프리미엄 환영', type:'coins', value:200},
  {level:2, ico:'💰', name:'코인 ×150', type:'coins', value:150},
  {level:3, ico:'🎁', name:'골든 박스', type:'box', value:2},
  {level:4, ico:'💰', name:'코인 ×150', type:'coins', value:150},
  {level:5, ico:'🗺️', name:'맵: 네온시티', type:'map', value:'neon_city'},
  {level:6, ico:'💰', name:'코인 ×200', type:'coins', value:200},
  {level:7, ico:'🎁', name:'슈퍼 박스', type:'box', value:3},
  {level:8, ico:'💰', name:'코인 ×200', type:'coins', value:200},
  {level:9, ico:'🎁', name:'슈퍼 박스', type:'box', value:3},
  {level:10, ico:'✨', name:'스킨: 골든', type:'skin', value:'golden_arrow'},
  {level:12, ico:'💰', name:'코인 ×250', type:'coins', value:250},
  {level:14, ico:'🎁', name:'레전드 박스', type:'box', value:4},
  {level:15, ico:'🗺️', name:'맵: 우주정거장', type:'map', value:'space_station'},
  {level:17, ico:'💰', name:'코인 ×300', type:'coins', value:300},
  {level:18, ico:'🎁', name:'레전드 박스', type:'box', value:4},
  {level:20, ico:'🗡️', name:'스킨: 네온 블레이드', type:'skin', value:'neon_blade'},
  {level:22, ico:'💰', name:'코인 ×350', type:'coins', value:350},
  {level:24, ico:'🎁', name:'레전드 박스 ×2', type:'box', value:5},
  {level:25, ico:'🌑', name:'스킨: 스텔스', type:'skin', value:'stealth'},
  {level:27, ico:'💰', name:'코인 ×400', type:'coins', value:400},
  {level:28, ico:'🎁', name:'레전드 박스 ×3', type:'box', value:6},
  {level:30, ico:'👑', name:'시즌 MVP 스킨', type:'skin', value:'s1_mvp'},
];

function _loadBP(){try{return JSON.parse(localStorage.getItem(BP_KEY)||'null');}catch(e){return null;}}
function _saveBP(bp){try{localStorage.setItem(BP_KEY,JSON.stringify(bp));}catch(e){}}
function _initBP(){return {season:BP_SEASON,xp:0,level:0,premium:false,claimedFree:[],claimedPremium:[],boxes:0};}
function _getBP(){
  var bp=_loadBP();
  if(!bp||bp.season!==BP_SEASON)bp=_initBP();
  return bp;
}

function _xpNeeded(lv){
  return BP_LEVEL_XP[Math.min(lv,BP_LEVEL_XP.length-1)];
}
function _addBPXP(amount){
  var bp=_getBP();
  bp.xp+=amount;
  while(bp.level<BP_LEVELS&&bp.xp>=_xpNeeded(bp.level)){
    bp.xp-=_xpNeeded(bp.level);
    bp.level++;
    popup('🎖️ 배틀패스 Lv.'+bp.level+'!',innerWidth/2,innerHeight*.35,'#f72585');
  }
  if(bp.level>=BP_LEVELS)bp.xp=_xpNeeded(BP_LEVELS-1);
  _saveBP(bp);
  _updateBPBadge();
}

function _updateBPBadge(){
  var bp=_getBP();
  var freeUnclaimed=BP_FREE_REWARDS.filter(function(r){return r.level<=bp.level&&bp.claimedFree.indexOf(r.level)<0;});
  var premUnclaimed=bp.premium?BP_PREMIUM_REWARDS.filter(function(r){return r.level<=bp.level&&bp.claimedPremium.indexOf(r.level)<0;}):[];
  var total=freeUnclaimed.length+premUnclaimed.length;
  var badge=document.getElementById('bp-badge');
  if(badge){badge.style.display=total>0?'flex':'none';}
}

function _openBP(){
  document.getElementById('bp-ov').classList.add('on');
  _renderBP();
}
function _closeBP(){
  document.getElementById('bp-ov').classList.remove('on');
}

function _renderBP(){
  var bp=_getBP();
  var seasonStart=parseInt(localStorage.getItem('e3_bp_season_start')||'0')||Date.now();
  if(!localStorage.getItem('e3_bp_season_start'))localStorage.setItem('e3_bp_season_start',String(Date.now()));
  var daysLeft=Math.max(0,30-Math.floor((Date.now()-seasonStart)/86400000));

  document.getElementById('bp-season-label').textContent='시즌 '+bp.season;
  document.getElementById('bp-season-days').textContent='남은 기간: '+daysLeft+'일';
  document.getElementById('bp-level-label').textContent=bp.level;
  var needed=_xpNeeded(bp.level);
  var xpPct=bp.level>=BP_LEVELS?100:(bp.xp/needed*100);
  document.getElementById('bp-xp-fill').style.width=xpPct+'%';
  var xpLbl=document.getElementById('bp-xp-label');
  if(xpLbl){
    xpLbl.textContent=bp.level>=BP_LEVELS?'MAX':bp.xp+' / '+needed+' XP';
  }

  var banner=document.getElementById('bp-premium-banner');
  var priceEl=document.getElementById('bp-premium-price');
  if(bp.premium){
    banner.classList.add('owned');
    priceEl.textContent='✓ 보유중';
    banner.onclick=null;
  }else{
    banner.classList.remove('owned');
    priceEl.textContent='₩1,100';
    banner.onclick=function(){_openPremiumModal();};
  }

  var scroll=document.getElementById('bp-scroll');
  var html2='<div class="bp-tier-row" style="padding:0 0 4px">'
    +'<div class="bp-tier-num"></div>'
    +'<div style="flex:1;text-align:center;font-size:11px;font-weight:700;color:rgba(180,180,240,.6)">무료</div>'
    +'<div style="flex:1;text-align:center;font-size:11px;font-weight:700;color:#f72585">프리미엄 ★</div>'
    +'</div>';

  var hasClaim=false;
  for(var lv=1;lv<=BP_LEVELS;lv++){
    var freeR=BP_FREE_REWARDS.filter(function(r){return r.level===lv;})[0];
    var premR=BP_PREMIUM_REWARDS.filter(function(r){return r.level===lv;})[0];
    if(!freeR&&!premR)continue;

    var freeClmd=bp.claimedFree.indexOf(lv)>=0;
    var premClmd=bp.claimedPremium.indexOf(lv)>=0;
    var freeClaimable=freeR&&lv<=bp.level&&!freeClmd;
    var premClaimable=premR&&lv<=bp.level&&bp.premium&&!premClmd;
    if(freeClaimable||premClaimable)hasClaim=true;

    var freeCls='bp-reward-cell free'+(freeClmd?' claimed':freeClaimable?' claimable':'');
    var premCls='bp-reward-cell premium'+(premClmd?' claimed':premClaimable?' claimable':'')+((!bp.premium&&!premClmd)?' locked':'');

    var freeCell=freeR
      ?'<div class="'+freeCls+'" data-lv="'+lv+'" data-type="free">'
        +'<div class="bp-reward-ico">'+freeR.ico+'</div>'
        +'<div class="bp-reward-name">'+freeR.name+'</div>'
        +'</div>'
      :'<div style="flex:1"></div>';

    var premCell=premR
      ?'<div class="'+premCls+'" data-lv="'+lv+'" data-type="premium">'
        +(!bp.premium&&!premClmd?'<div class="bp-reward-new">🔒</div>':'')
        +'<div class="bp-reward-ico">'+premR.ico+'</div>'
        +'<div class="bp-reward-name">'+premR.name+'</div>'
        +'</div>'
      :'<div style="flex:1"></div>';

    html2+='<div class="bp-tier-row"><div class="bp-tier-num" style="color:rgba(180,180,240,.8)">'+lv+'</div>'+freeCell+premCell+'</div>';
  }
  if(hasClaim){
    html2+='<button class="bp-claim-btn" id="bp-claim-all-btn">✨ 모든 보상 수령</button>';
  }
  scroll.innerHTML=html2;

  scroll.querySelectorAll('.bp-reward-cell.claimable').forEach(function(cell){
    cell.addEventListener('click',function(){
      _claimBPReward(parseInt(cell.dataset.lv),cell.dataset.type);
    });
  });
  var claimAll=document.getElementById('bp-claim-all-btn');
  if(claimAll)claimAll.addEventListener('click',_claimAllBP);
}

function _claimBPReward(lv,type){
  var bp=_getBP();
  if(type==='free'){
    if(bp.claimedFree.indexOf(lv)>=0)return;
    var r=BP_FREE_REWARDS.filter(function(x){return x.level===lv;})[0];
    if(!r||lv>bp.level)return;
    bp.claimedFree.push(lv);
    _applyBPReward(r);
  }else{
    if(!bp.premium||bp.claimedPremium.indexOf(lv)>=0)return;
    var r2=BP_PREMIUM_REWARDS.filter(function(x){return x.level===lv;})[0];
    if(!r2||lv>bp.level)return;
    bp.claimedPremium.push(lv);
    _applyBPReward(r2);
  }
  _saveBP(bp);
  _renderBP();
  _updateBPBadge();
}

function _claimAllBP(){
  var bp=_getBP();
  BP_FREE_REWARDS.forEach(function(r){
    if(r.level<=bp.level&&bp.claimedFree.indexOf(r.level)<0){
      bp.claimedFree.push(r.level);
      _applyBPReward(r,true);
    }
  });
  if(bp.premium){
    BP_PREMIUM_REWARDS.forEach(function(r){
      if(r.level<=bp.level&&bp.claimedPremium.indexOf(r.level)<0){
        bp.claimedPremium.push(r.level);
        _applyBPReward(r,true);
      }
    });
  }
  _saveBP(bp);
  _renderBP();
  _updateBPBadge();
  popup('🎖️ 배틀패스 보상 수령!',innerWidth/2,innerHeight*.4,'#f72585');
}

function _applyBPReward(r,silent){
  if(r.type==='coins'){
    coins+=r.value;doSave();updateCoins();
    if(!silent)popup('+'+r.value+' 💰 (배틀패스)',innerWidth/2,innerHeight*.4,'#FFD700');
    return r.value;
  }else if(r.type==='box'){
    var boxCoins=r.value*50+Math.floor(Math.random()*r.value*30);
    coins+=boxCoins;doSave();updateCoins();
    if(!silent)popup('🎁 박스 x'+r.value+': +'+boxCoins+'💰',innerWidth/2,innerHeight*.4,'#4cc9f0');
    return boxCoins;
  }else if(r.type==='skin'){
    owned.add(r.value);doSave();
    if(!silent)popup('✨ 스킨 획득: '+r.name,innerWidth/2,innerHeight*.4,'#f72585');
    return 0;
  }else if(r.type==='map'){
    if(typeof ownedMaps!=='undefined')ownedMaps.add(r.value);doSave();
    if(!silent)popup('🗺️ 맵 획득: '+r.name,innerWidth/2,innerHeight*.4,'#4361ee');
    return 0;
  }else if(r.type==='title'){
    if(!silent)popup('🏆 칭호 획득: '+r.name,innerWidth/2,innerHeight*.4,'#FFD700');
    return 0;
  }
  return 0;
}

function _openPremiumModal(){
  document.getElementById('premium-modal').classList.add('on');
}
function _closePremiumModal(){
  document.getElementById('premium-modal').classList.remove('on');
}

document.getElementById('premium-cancel-btn').addEventListener('click',_closePremiumModal);
document.getElementById('premium-modal').addEventListener('click',function(e){
  if(e.target===document.getElementById('premium-modal'))_closePremiumModal();
});

document.getElementById('premium-buy-btn').addEventListener('click',function(){
  var confirmed=confirm('프리미엄 배틀패스를 구매하시겠습니까?\n\n가격: ₩1,100 (시즌 1)\n\n결제 후 즉시 모든 프리미엄 보상이 잠금 해제됩니다.');
  if(confirmed){
    var bp=_getBP();
    bp.premium=true;
    _saveBP(bp);
    _closePremiumModal();
    _renderBP();
    _updateBPBadge();
    popup('🌟 프리미엄 배틀패스 활성화!',innerWidth/2,innerHeight*.4,'#f72585');
  }
});

document.getElementById('btn-battlepass').addEventListener('click',_openBP);
document.getElementById('bp-close-btn').addEventListener('click',_closeBP);

// ══════════════════════════════════════════════════
// AI RANK FLUCTUATION — 앱 시작 시 1회 갱신
// ══════════════════════════════════════════════════
setTimeout(function(){
  if(typeof _simulateAIRankFluctuation==='function')_simulateAIRankFluctuation();
},2000);

// ══════════════════════════════════════════════════
// BP SKINS — SKINS 배열에 실제 스킨 정의 등록
// ══════════════════════════════════════════════════
(function(){
  var bpSkins=[
    // Lv10 무료: 루비 — 깊은 루비색 반투명 크리스탈
    {id:'ruby_free',    name:'루비',          desc:'깊은 루비 크리스탈 화살',      price:0, bp:true, emoji:'\u2764\ufe0f',  pc:'p-bp', r:0.0,  m:0.05, fc:'#cc0022', tr:true, op:0.72, crystal:true},
    // Lv10 프리미엄: 골든 에로우 — 순금 24K 황금
    {id:'golden_arrow', name:'골든 에로우',    desc:'순금 24K 황금 화살',           price:0, bp:true, emoji:'\ud83c\udfc5',  pc:'p-bp', r:0.02, m:1.0,  fc:'#FFD700'},
    // Lv20 프리미엄: 네온 블레이드 — 사이버펑크 검 형태 + 핫핑크 네온
    {id:'neon_blade',   name:'네온 블레이드',  desc:'사이버펑크 핫핑크 네온 검',    price:0, bp:true, emoji:'\u26a1',       pc:'p-bp', r:1.0,  m:0.0,  fc:'#ff00cc', neon:true, shape:'sword'},
    // Lv25 프리미엄: 스텔스 — 칠흑 무광 스텔스 기체
    {id:'stealth',      name:'스텔스',         desc:'칠흑 무광 스텔스 기체',        price:0, bp:true, emoji:'\ud83c\udf11',  pc:'p-bp', r:0.88, m:0.22, fc:'#080818'},
    // Lv30 프리미엄: 시즌 MVP — 홀로그램 크리스탈 파편
    {id:'s1_mvp',       name:'시즌 MVP',       desc:'시즌 1 챔피언 홀로그램 크리스탈', price:0, bp:true, emoji:'\ud83d\udc51', pc:'p-bp', r:0.0,  m:0.0,  shape:'crystal2', tr:true, op:0.88},
  ];
  bpSkins.forEach(function(sk){
    if(!SKINS.find(function(s){return s.id===sk.id;}))SKINS.push(sk);
  });
})();

// ══════════════════════════════════════════════════
// 가챠 전용 스킨 — 크로시스 가챠에서만 획득 가능
// ══════════════════════════════════════════════════
(function(){
  var gachaSkins=[
    // 골드+ 전용: 인페르노 — 활활 타오르는 네온 불꽃 화살
    {id:'inferno',       name:'인페르노',     desc:'🔥 가챠 전용 · 활활 타오르는 붉은 불꽃',
     price:0, gacha:true, emoji:'🔥', pc:'p-gacha', r:1.0, m:0.0, neon:true, fc:'#FF3300'},
    // 다이아몬드+ 전용: 공허 파편 — 어둠 속에서 빛나는 보라빛 파편
    {id:'void_shard',    name:'공허 파편',    desc:'💜 가챠 전용 · 심연에서 온 보라빛 크리스탈',
     price:0, gacha:true, emoji:'💜', pc:'p-gacha', r:0.0, m:0.0, tr:true, op:0.72, fc:'#6600cc', crystal:true, shape:'crystal2'},
    // 크로시스 전용: 크로시스 축복 — 신성한 금빛·흰빛의 반투명 젬
    {id:'crosis_blessed',name:'크로시스 축복',desc:'👑 가챠 전용 · 크로시스의 신성한 황금 크리스탈',
     price:0, gacha:true, emoji:'👑', pc:'p-gacha', r:0.0, m:0.15, tr:true, op:0.65, fc:'#FFD700', crystal:true},
  ];
  gachaSkins.forEach(function(sk){
    if(!SKINS.find(function(s){return s.id===sk.id;}))SKINS.push(sk);
  });
})();

// ══════════════════════════════════════════════════
// BP MAPS — 네온 시티 돔 함수
// ══════════════════════════════════════════════════
var _neonCityDome=null;
function makeNeonCityDome(){
  if(_neonCityDome)return _neonCityDome;
  var c=document.createElement('canvas');c.width=1024;c.height=512;
  var ctx=c.getContext('2d');
  // 사이버펑크 하늘 그라데이션
  var g=ctx.createLinearGradient(0,0,0,512);
  g.addColorStop(0,'#010008');g.addColorStop(0.35,'#08001a');
  g.addColorStop(0.65,'#150035');g.addColorStop(1,'#200050');
  ctx.fillStyle=g;ctx.fillRect(0,0,1024,512);
  // 별 (핑크/시안/흰색)
  var stC=['#ff99ff','#88ffff','#ffffff','#ffbbff','#bbffff','#ff66cc','#66ffff'];
  for(var i=0;i<520;i++){
    var sx=Math.random()*1024,sy=Math.random()*310;
    ctx.fillStyle=stC[Math.floor(Math.random()*stC.length)];
    ctx.globalAlpha=0.25+Math.random()*0.75;
    ctx.fillRect(sx,sy,Math.ceil(Math.random()*1.8),Math.ceil(Math.random()*1.8));
  }
  ctx.globalAlpha=1;
  // 지평선 네온 안개 밴드
  var bands=[
    {y:445,r:255,gn:0,b:160,a:0.14,h:90},
    {y:405,r:80,gn:0,b:255,a:0.10,h:70},
    {y:368,r:0,gn:220,b:255,a:0.07,h:55},
  ];
  bands.forEach(function(fb){
    var fg=ctx.createLinearGradient(0,fb.y-fb.h/2,0,fb.y+fb.h/2);
    fg.addColorStop(0,'rgba(0,0,0,0)');
    fg.addColorStop(0.5,'rgba('+fb.r+','+fb.gn+','+fb.b+','+fb.a+')');
    fg.addColorStop(1,'rgba(0,0,0,0)');
    ctx.fillStyle=fg;ctx.fillRect(0,fb.y-fb.h/2,1024,fb.h);
  });
  // 빌딩 실루엣
  var blds=[
    [0,155,75],[70,205,55],[118,252,92],[200,172,62],[255,298,115],
    [362,238,78],[432,278,98],[522,192,58],[572,262,138],[702,228,88],
    [782,188,78],[852,248,108],[952,162,48],[992,218,58]
  ];
  ctx.fillStyle='#060018';
  blds.forEach(function(b){ctx.fillRect(b[0],512-b[1],b[2],b[1]);});
  // 안테나/첨탑
  ctx.fillStyle='#040012';
  blds.forEach(function(b){
    if(b[1]>230&&Math.random()>0.5){
      var ax=b[0]+b[2]/2-2;
      ctx.fillRect(ax,512-b[1]-16,3,16);
      // 안테나 끝 빨간 점멸등
      ctx.fillStyle='rgba(255,0,0,0.8)';ctx.beginPath();ctx.arc(ax+1,512-b[1]-18,2,0,Math.PI*2);ctx.fill();
      ctx.fillStyle='#040012';
    }
  });
  // 창문 픽셀
  var wC=['#ff00ff','#00ffff','#ff8800','#ffffff','#ff0099','#00ff99','#ff44aa','#44ffff','#ffaa00'];
  blds.forEach(function(b){
    var bx=b[0],bh=b[1],bw=b[2];
    for(var wy=512-bh+8;wy<505;wy+=10){
      for(var wx=bx+4;wx<bx+bw-4;wx+=8){
        if(Math.random()>0.42){
          ctx.fillStyle=wC[Math.floor(Math.random()*wC.length)];
          ctx.globalAlpha=0.4+Math.random()*0.6;
          ctx.fillRect(wx,wy,3,4);
        }
      }
    }
  });
  ctx.globalAlpha=1;
  // 네온 간판 광원 효과
  var glows=[
    {x:138,y:268,r:255,gn:0,b:170,rad:42},{x:280,y:228,r:0,gn:220,b:255,rad:38},
    {x:450,y:240,r:255,gn:0,b:255,rad:40},{x:598,y:250,r:0,gn:255,b:255,rad:38},
    {x:718,y:212,r:255,gn:0,b:120,rad:36},{x:875,y:222,r:160,gn:0,b:255,rad:40}
  ];
  glows.forEach(function(gl){
    var rg=ctx.createRadialGradient(gl.x,gl.y,0,gl.x,gl.y,gl.rad);
    rg.addColorStop(0,'rgba('+gl.r+','+gl.gn+','+gl.b+',0.65)');
    rg.addColorStop(1,'rgba(0,0,0,0)');
    ctx.fillStyle=rg;ctx.beginPath();ctx.arc(gl.x,gl.y,gl.rad,0,Math.PI*2);ctx.fill();
  });
  // 지평선 빛 반사 (하단)
  var hr=ctx.createLinearGradient(0,490,0,512);
  hr.addColorStop(0,'rgba(120,0,200,0.18)');hr.addColorStop(1,'rgba(0,0,0,0)');
  ctx.fillStyle=hr;ctx.fillRect(0,490,1024,22);
  var tex=new THREE.CanvasTexture(c);
  var geo=new THREE.SphereGeometry(58,48,24);
  var mat=new THREE.MeshBasicMaterial({map:tex,side:THREE.BackSide,depthWrite:false,fog:false});
  _neonCityDome=new THREE.Mesh(geo,mat);_neonCityDome.renderOrder=-1;return _neonCityDome;
}

// ══════════════════════════════════════════════════
// BP MAPS — 우주정거장 돔 함수
// ══════════════════════════════════════════════════
var _spaceStationDome=null;
function makeSpaceStationDome(){
  if(_spaceStationDome)return _spaceStationDome;
  var c=document.createElement('canvas');c.width=1024;c.height=512;
  var ctx=c.getContext('2d');
  // 심우주 배경
  ctx.fillStyle='#000814';ctx.fillRect(0,0,1024,512);
  // 별 필드 (3단계 밝기)
  for(var i=0;i<1400;i++){
    var sx=Math.random()*1024,sy=Math.random()*420,br=Math.random();
    var stCol=br>0.88?'#aaccff':br>0.65?'#ffffff':'#667799';
    ctx.fillStyle=stCol;ctx.globalAlpha=0.2+br*0.8;
    var sz=br>0.92?2:1;
    ctx.fillRect(sx,sy,sz,sz);
  }
  ctx.globalAlpha=1;
  // 성운 (은은한 보라/파랑 빛)
  var nebulas=[
    {x:180,y:140,rad:150,r:70,gn:50,b:170,a:0.13},
    {x:700,y:110,rad:130,r:30,gn:70,b:190,a:0.11},
    {x:440,y:190,rad:170,r:55,gn:30,b:130,a:0.09},
    {x:890,y:200,rad:100,r:90,gn:20,b:160,a:0.08},
  ];
  nebulas.forEach(function(n){
    var ng=ctx.createRadialGradient(n.x,n.y,0,n.x,n.y,n.rad);
    ng.addColorStop(0,'rgba('+n.r+','+n.gn+','+n.b+','+n.a+')');
    ng.addColorStop(0.6,'rgba('+Math.floor(n.r*0.5)+','+Math.floor(n.gn*0.5)+','+Math.floor(n.b*0.6)+','+(n.a*0.4)+')');
    ng.addColorStop(1,'rgba(0,0,0,0)');
    ctx.fillStyle=ng;ctx.beginPath();ctx.arc(n.x,n.y,n.rad,0,Math.PI*2);ctx.fill();
  });
  // 우주정거장 실루엣
  ctx.fillStyle='#0a1520';
  // 중앙 거주 모듈
  ctx.fillRect(412,398,200,114);
  // 상단 연결부
  ctx.fillRect(452,378,126,22);
  // 솔라 패널 (좌우 날개)
  ctx.fillStyle='#08121e';
  ctx.fillRect(196,404,182,18);ctx.fillRect(648,404,182,18);
  ctx.fillRect(178,424,218,10);ctx.fillRect(626,424,218,10);
  ctx.fillRect(160,436,240,7);ctx.fillRect(626,436,240,7);
  // 연결 암(arm)
  ctx.fillStyle='#0c1a28';
  ctx.fillRect(390,406,24,14);ctx.fillRect(612,406,24,14);
  // 측면 해비타트
  ctx.fillStyle='#0a1520';
  ctx.fillRect(346,392,46,54);ctx.fillRect(634,392,46,54);
  // 안테나
  ctx.fillStyle='#0d1e30';
  ctx.fillRect(496,358,5,42);ctx.fillRect(518,354,4,46);ctx.fillRect(504,356,14,4);
  ctx.fillRect(510,348,3,10);
  // 안테나 끝 경고등
  ctx.fillStyle='rgba(255,80,0,0.75)';ctx.beginPath();ctx.arc(498,357,2,0,Math.PI*2);ctx.fill();
  ctx.fillStyle='rgba(255,80,0,0.75)';ctx.beginPath();ctx.arc(520,353,2,0,Math.PI*2);ctx.fill();
  // 포트홀(창문) 조명
  var portCols=['#aaccff','#88aaff','#66ccff','#99bbff','#cce0ff'];
  var ports=[
    [432,418],[458,418],[484,418],[510,418],[536,418],[562,418],[588,418],
    [445,438],[471,438],[497,438],[523,438],[549,438],[575,438],
    [360,408],[360,428],[646,408],[646,428]
  ];
  ports.forEach(function(p,idx){
    ctx.fillStyle=portCols[idx%portCols.length];
    ctx.globalAlpha=0.55+Math.random()*0.45;
    ctx.beginPath();ctx.arc(p[0],p[1],3,0,Math.PI*2);ctx.fill();
  });
  ctx.globalAlpha=1;
  // 엔진 추력 빛 (뒤쪽)
  var eng=ctx.createRadialGradient(512,512,0,512,512,35);
  eng.addColorStop(0,'rgba(100,180,255,0.45)');eng.addColorStop(1,'rgba(0,0,0,0)');
  ctx.fillStyle=eng;ctx.beginPath();ctx.arc(512,512,35,0,Math.PI*2);ctx.fill();
  // 우측 하단 — 멀리 있는 행성
  var pg=ctx.createRadialGradient(905,488,0,905,488,125);
  pg.addColorStop(0,'rgba(35,75,158,0.6)');
  pg.addColorStop(0.55,'rgba(18,48,120,0.38)');
  pg.addColorStop(0.85,'rgba(8,20,60,0.15)');
  pg.addColorStop(1,'rgba(0,0,0,0)');
  ctx.fillStyle=pg;ctx.beginPath();ctx.arc(905,488,125,0,Math.PI*2);ctx.fill();
  // 행성 고리
  ctx.save();ctx.translate(905,488);ctx.rotate(-0.22);
  ctx.scale(1.4,0.22);
  ctx.strokeStyle='rgba(80,130,220,0.32)';ctx.lineWidth=10;
  ctx.beginPath();ctx.arc(0,0,130,0,Math.PI*2);ctx.stroke();
  ctx.strokeStyle='rgba(100,150,240,0.18)';ctx.lineWidth=22;
  ctx.beginPath();ctx.arc(0,0,148,0,Math.PI*2);ctx.stroke();
  ctx.restore();
  // 좌측 — 작은 소행성/파편들
  ctx.fillStyle='rgba(80,90,100,0.6)';
  [[95,310],[112,325],[80,338],[135,302]].forEach(function(p){
    ctx.beginPath();ctx.arc(p[0],p[1],Math.random()*3+2,0,Math.PI*2);ctx.fill();
  });
  var tex=new THREE.CanvasTexture(c);
  var geo=new THREE.SphereGeometry(58,48,24);
  var mat=new THREE.MeshBasicMaterial({map:tex,side:THREE.BackSide,depthWrite:false,fog:false});
  _spaceStationDome=new THREE.Mesh(geo,mat);_spaceStationDome.renderOrder=-1;return _spaceStationDome;
}

// ══════════════════════════════════════════════════
// BP MAPS — MAPS 배열에 실제 맵 정의 등록
// ══════════════════════════════════════════════════
(function(){
  var bpMaps=[
    {id:'neon_city',     name:'네온 시티',   desc:'사이버펑크 도심의 밤', price:0, bp:true, emoji:'\ud83c\udf06', pc:'p-bp',
     bg:'#050010',fogColor:'#1a0030',fogNear:11,fogFar:44,
     ambient:[0xff00ff,0.42],sun:[0x00ffff,1.1],fill:[0x8800ff,0.58],starCol:0xff44ff,
     colors:['#ff00cc','#00ffff','#ff0080','#9900ff','#00ff99','#ff6600',
             '#4400ff','#ff0044','#00ccff','#ff00aa','#66ff00','#ff8800',
             '#0044ff','#ff0099','#00ff66','#aa00ff','#ff4400','#00ffaa'],
     tex:null},
    {id:'space_station', name:'우주정거장',  desc:'금속 구조물의 심우주', price:0, bp:true, emoji:'\ud83d\udef8', pc:'p-bp',
     bg:'#000814',fogColor:'#001020',fogNear:18,fogFar:62,
     ambient:[0x88aacc,0.65],sun:[0xaaccff,1.38],fill:[0x002244,0.5],starCol:0xaaccff,
     colors:['#778899','#8899aa','#99aabb','#667788','#5566aa','#6677bb',
             '#4455aa','#99aacc','#aabbdd','#5577aa','#6688bb','#7799cc',
             '#8899bb','#556699','#667788','#5566aa','#7788aa','#889999'],
     tex:null},
  ];
  bpMaps.forEach(function(m){
    if(!MAPS.find(function(x){return x.id===m.id;}))MAPS.push(m);
  });
})();

// ══════════════════════════════════════════════════
// PATCH applyMap — 새 BP 맵 분기 처리
// ══════════════════════════════════════════════════
(function(){
  var _origApplyMap=applyMap;
  applyMap=function(mapId){
    // BP 돔 제거
    if(_neonCityDome&&_neonCityDome.parent)scene.remove(_neonCityDome);
    if(_spaceStationDome&&_spaceStationDome.parent)scene.remove(_spaceStationDome);
    if(mapId==='neon_city'){
      var m=MAPS.find(function(x){return x.id===mapId;})||MAPS[0];
      if(typeof _marsDome!=='undefined'&&_marsDome&&_marsDome.parent)scene.remove(_marsDome);
      if(typeof _earthDome!=='undefined'&&_earthDome&&_earthDome.parent)scene.remove(_earthDome);
      scene.background.set('#050010');
      scene.add(makeNeonCityDome());
      starsMesh.visible=false;
      scene.fog.color.set(m.fogColor);scene.fog.near=m.fogNear;scene.fog.far=m.fogFar;
      ambLight.color.set(m.ambient[0]);ambLight.intensity=m.ambient[1];
      sunLight.color.set(m.sun[0]);sunLight.intensity=m.sun[1];
      fillLight.color.set(m.fill[0]);fillLight.intensity=m.fill[1];
      starsMesh.material.color.set(m.starCol);
      activeMap=mapId;doSave();
    }else if(mapId==='space_station'){
      var m2=MAPS.find(function(x){return x.id===mapId;})||MAPS[0];
      if(typeof _marsDome!=='undefined'&&_marsDome&&_marsDome.parent)scene.remove(_marsDome);
      if(typeof _earthDome!=='undefined'&&_earthDome&&_earthDome.parent)scene.remove(_earthDome);
      scene.background.set('#000814');
      scene.add(makeSpaceStationDome());
      starsMesh.visible=true;
      scene.fog.color.set(m2.fogColor);scene.fog.near=m2.fogNear;scene.fog.far=m2.fogFar;
      ambLight.color.set(m2.ambient[0]);ambLight.intensity=m2.ambient[1];
      sunLight.color.set(m2.sun[0]);sunLight.intensity=m2.sun[1];
      fillLight.color.set(m2.fill[0]);fillLight.intensity=m2.fill[1];
      starsMesh.material.color.set(m2.starCol);
      activeMap=mapId;doSave();
    }else{
      _origApplyMap.call(this,mapId);
    }
  };
  // 저장된 BP 맵이 있으면 재적용 (스크립트 로드 후 지연 실행)
  setTimeout(function(){
    if(activeMap==='neon_city'||activeMap==='space_station')applyMap(activeMap);
  },80);
})();

// ══════════════════════════════════════════════════
// 가챠 전용 맵 — 스카이돔 생성 함수
// ══════════════════════════════════════════════════
var _crosisRealmDome=null;
function makeCrosisRealmDome(){
  if(_crosisRealmDome)return _crosisRealmDome;
  var c=document.createElement('canvas');c.width=1024;c.height=512;
  var ctx=c.getContext('2d');
  // 배경: 칠흑 속 금빛 그라디언트
  var g=ctx.createLinearGradient(0,0,0,512);
  g.addColorStop(0,'#050300');g.addColorStop(0.35,'#0e0900');g.addColorStop(0.65,'#1a1000');g.addColorStop(1,'#0a0700');
  ctx.fillStyle=g;ctx.fillRect(0,0,1024,512);
  // 중앙 황금빛 후광
  var cg=ctx.createRadialGradient(512,220,0,512,220,280);
  cg.addColorStop(0,'rgba(255,220,50,0.22)');cg.addColorStop(0.4,'rgba(255,180,0,0.08)');cg.addColorStop(1,'rgba(0,0,0,0)');
  ctx.fillStyle=cg;ctx.fillRect(0,0,1024,512);
  // 황금 광선
  for(var i=0;i<16;i++){
    var ang=(i/16)*Math.PI*2;var len=160+Math.random()*200;
    var bw=Math.random()*3+1;
    ctx.save();ctx.translate(512,220);ctx.rotate(ang);
    var rg=ctx.createLinearGradient(0,0,0,len);
    rg.addColorStop(0,'rgba(255,215,0,0.35)');rg.addColorStop(1,'rgba(255,215,0,0)');
    ctx.fillStyle=rg;ctx.fillRect(-bw/2,0,bw,len);
    ctx.restore();
  }
  // 금빛 별 파티클
  for(var j=0;j<180;j++){
    var sx=Math.random()*1024,sy=Math.random()*512;
    var sr=Math.random()*1.8+0.3;
    var alpha=Math.random()*0.8+0.2;
    var isGold=Math.random()>0.4;
    ctx.beginPath();ctx.arc(sx,sy,sr,0,Math.PI*2);
    ctx.fillStyle=isGold?'rgba(255,215,0,'+alpha+')':'rgba(255,255,220,'+alpha+')';
    ctx.fill();
  }
  // 흰빛 네뷸라 띠
  for(var k=0;k<6;k++){
    var nx=Math.random()*1100-50,ny=80+Math.random()*300;
    var nrw=120+Math.random()*200,nrh=20+Math.random()*40;
    var ng2=ctx.createRadialGradient(nx,ny,0,nx,ny,Math.max(nrw,nrh));
    ng2.addColorStop(0,'rgba(255,245,180,0.12)');ng2.addColorStop(1,'rgba(0,0,0,0)');
    ctx.fillStyle=ng2;ctx.save();ctx.translate(nx,ny);ctx.scale(nrw/Math.max(nrw,nrh),nrh/Math.max(nrw,nrh));ctx.translate(-nx,-ny);
    ctx.beginPath();ctx.arc(nx,ny,Math.max(nrw,nrh),0,Math.PI*2);ctx.fill();ctx.restore();
  }
  var tex=new THREE.CanvasTexture(c);
  var geo=new THREE.SphereGeometry(58,48,24);
  var mat=new THREE.MeshBasicMaterial({map:tex,side:THREE.BackSide,depthWrite:false,fog:false});
  _crosisRealmDome=new THREE.Mesh(geo,mat);_crosisRealmDome.renderOrder=-1;return _crosisRealmDome;
}

var _voidDeepDome=null;
function makeVoidDeepDome(){
  if(_voidDeepDome)return _voidDeepDome;
  var c=document.createElement('canvas');c.width=1024;c.height=512;
  var ctx=c.getContext('2d');
  // 배경: 깊은 보라빛 심연
  var g=ctx.createLinearGradient(0,0,0,512);
  g.addColorStop(0,'#030008');g.addColorStop(0.4,'#080015');g.addColorStop(0.75,'#0a001a');g.addColorStop(1,'#050010');
  ctx.fillStyle=g;ctx.fillRect(0,0,1024,512);
  // 보라빛 소용돌이 네뷸라
  var spirals=[{x:300,y:180,r1:'#6600cc',r2:'#330066'},{x:700,y:280,r1:'#9900ff',r2:'#440088'},{x:512,y:120,r1:'#7700aa',r2:'#220044'}];
  spirals.forEach(function(sp){
    var cg=ctx.createRadialGradient(sp.x,sp.y,0,sp.x,sp.y,200);
    cg.addColorStop(0,'rgba(102,0,204,0.18)');cg.addColorStop(0.5,'rgba(80,0,160,0.08)');cg.addColorStop(1,'rgba(0,0,0,0)');
    ctx.fillStyle=cg;ctx.fillRect(0,0,1024,512);
  });
  // 청록빛 에너지 줄기
  for(var i=0;i<8;i++){
    var x1=Math.random()*1024,y1=Math.random()*512;
    var x2=x1+(Math.random()-0.5)*300,y2=y1+(Math.random()-0.5)*200;
    var lg=ctx.createLinearGradient(x1,y1,x2,y2);
    lg.addColorStop(0,'rgba(0,255,200,0)');
    lg.addColorStop(0.5,'rgba(0,220,180,0.22)');
    lg.addColorStop(1,'rgba(0,255,200,0)');
    ctx.strokeStyle=lg;ctx.lineWidth=1.5+Math.random()*2;
    ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.stroke();
  }
  // 보라/청록 파티클
  for(var j=0;j<220;j++){
    var sx=Math.random()*1024,sy=Math.random()*512;
    var sr=Math.random()*1.5+0.2;
    var alpha=Math.random()*0.7+0.15;
    var isTeal=Math.random()>0.55;
    ctx.beginPath();ctx.arc(sx,sy,sr,0,Math.PI*2);
    ctx.fillStyle=isTeal?'rgba(0,255,200,'+alpha+')':'rgba(160,50,255,'+alpha+')';
    ctx.fill();
  }
  // 어두운 수정 파편 실루엣
  for(var k=0;k<12;k++){
    var fx=Math.random()*1024,fy=300+Math.random()*200;
    var fh=30+Math.random()*80,fw=6+Math.random()*14;
    ctx.save();ctx.translate(fx,fy);ctx.rotate((Math.random()-0.5)*0.5);
    ctx.fillStyle='rgba(80,0,150,0.35)';
    ctx.beginPath();ctx.moveTo(0,-fh);ctx.lineTo(fw/2,0);ctx.lineTo(0,fh*0.3);ctx.lineTo(-fw/2,0);ctx.closePath();ctx.fill();
    ctx.restore();
  }
  var tex=new THREE.CanvasTexture(c);
  var geo=new THREE.SphereGeometry(58,48,24);
  var mat=new THREE.MeshBasicMaterial({map:tex,side:THREE.BackSide,depthWrite:false,fog:false});
  _voidDeepDome=new THREE.Mesh(geo,mat);_voidDeepDome.renderOrder=-1;return _voidDeepDome;
}

// ── 가챠 전용 맵 MAPS 배열 등록 ──────────────────
(function(){
  var gachaMaps=[
    {id:'crosis_realm', name:'크로시스 영역', desc:'👑 가챠 전용 · 신성한 황금빛 차원',
     price:0, gacha:true, emoji:'✨', pc:'p-gacha',
     bg:'#0a0700', fogColor:'#1a1200', fogNear:14, fogFar:55,
     ambient:[0xffd700,0.6], sun:[0xffffff,1.5], fill:[0xffd060,0.5], starCol:0xffe566,
     colors:['#FFD700','#FFFDE7','#FFF176','#FFFFFF','#FFE082','#FFD54F',
             '#FFB300','#FFCA28','#FFD740','#FFE57F','#FFECB3','#FFF8E1',
             '#FFF9C4','#FFFDE7','#FFEE58','#FFEB3B','#FDD835','#F9A825'],
     tex:null},
    {id:'void_deep', name:'공허의 심연', desc:'💜 가챠 전용 · 어둠과 청록이 공존하는 심연',
     price:0, gacha:true, emoji:'🌀', pc:'p-gacha',
     bg:'#050010', fogColor:'#100030', fogNear:12, fogFar:50,
     ambient:[0x6600cc,0.55], sun:[0x00ffcc,1.2], fill:[0x330066,0.6], starCol:0x9955ff,
     colors:['#6600cc','#00ffcc','#9400D3','#4B0082','#00CED1','#7B68EE',
             '#483D8B','#20B2AA','#800080','#008B8B','#9932CC','#00FA9A',
             '#1E90FF','#663399','#00BFFF','#8A2BE2','#40E0D0','#7B2D8B'],
     tex:null},
  ];
  gachaMaps.forEach(function(m){
    if(!MAPS.find(function(x){return x.id===m.id;}))MAPS.push(m);
  });
})();

// ── PATCH applyMap — 가챠 맵 분기 처리 ──────────
(function(){
  var _prevApplyMap=applyMap;
  applyMap=function(mapId){
    if(_crosisRealmDome&&_crosisRealmDome.parent)scene.remove(_crosisRealmDome);
    if(_voidDeepDome&&_voidDeepDome.parent)scene.remove(_voidDeepDome);
    _prevApplyMap(mapId);
    if(mapId==='crosis_realm'){
      scene.add(makeCrosisRealmDome());
      starsMesh.visible=false;
    } else if(mapId==='void_deep'){
      scene.add(makeVoidDeepDome());
      starsMesh.visible=false;
    }
  };
  setTimeout(function(){
    if(activeMap==='crosis_realm'||activeMap==='void_deep')applyMap(activeMap);
  },90);
})();

// ── PATCH skinTap / mapTap — 가챠 전용 차단 ──────
(function(){
  var _prevSkinTap2=skinTap;
  skinTap=function(id){
    var sk=SKINS.find(function(s){return s.id===id;});
    if(sk&&sk.gacha&&!owned.has(id)){
      popup('크로시스 가챠 전용 🎴  —  가챠에서 획득하세요',innerWidth/2,innerHeight*.48,'#a855f7');
      return;
    }
    return _prevSkinTap2.call(this,id);
  };
  var _prevMapTap2=mapTap;
  mapTap=function(id){
    var m=MAPS.find(function(x){return x.id===id;});
    if(m&&m.gacha&&!ownedMaps.has(id)){
      popup('크로시스 가챠 전용 🎴  —  가챠에서 획득하세요',innerWidth/2,innerHeight*.48,'#a855f7');
      return;
    }
    return _prevMapTap2.call(this,id);
  };
})();

// ══════════════════════════════════════════════════
// PATCH skinTap / mapTap — BP 미보유 시 구매 차단
// ══════════════════════════════════════════════════
(function(){
  var _origSkinTap=skinTap;
  skinTap=function(id){
    var sk=SKINS.find(function(s){return s.id===id;});
    if(sk&&sk.bp&&!owned.has(id)){
      popup('배틀패스 전용 \ud83c\udf96\ufe0f  —  배틀패스에서 획득하세요',innerWidth/2,innerHeight*.48,'#f72585');
      return;
    }
    return _origSkinTap.call(this,id);
  };
  var _origMapTap=mapTap;
  mapTap=function(id){
    var m=MAPS.find(function(x){return x.id===id;});
    if(m&&m.bp&&!ownedMaps.has(id)){
      popup('배틀패스 전용 \ud83c\udf96\ufe0f  —  배틀패스에서 획득하세요',innerWidth/2,innerHeight*.48,'#4361ee');
      return;
    }
    return _origMapTap.call(this,id);
  };
})();

// Initialize badges
_updateFriendBadge();
_updateBPBadge();

if(rankState.placed)_upsertLeaderboard(_settings.nickname||'나',rankState.points);


// ══════════════════════════════════════════════════
// ══════════════════════════════════════════════════
// 크로시스 가챠 SYSTEM
// ══════════════════════════════════════════════════
(function(){
'use strict';

// ── 티어 정의 ──────────────────────────────────────
const CG_TIERS=[
  {id:'wood',     name:'나무',      advChance:55, bg:'radial-gradient(circle at 38% 34%,#a0724a 0%,#6b3d1e 45%,#3d1f06 100%)',
   glow:'rgba(139,90,43,0.9)',   ringColor:'rgba(160,114,74,0.5)',  textColor:'#FFE0B2',
   btnBg:'linear-gradient(135deg,#6b3d1e,#cd853f)', btnText:'#FFE0B2',
   dotColor:'#8B5E3C', particles:['#8B5E3C','#CD853F','#A0724A','#DEB887','#F4A460'],
   bgTint:'rgba(63,28,8,0.97)',  ico:'🪵', label:'나무'},
  {id:'gold',     name:'골드',      advChance:40, bg:'radial-gradient(circle at 38% 34%,#fffde7 0%,#FFD700 35%,#B8860B 70%,#7a5900 100%)',
   glow:'rgba(255,215,0,1)',     ringColor:'rgba(255,215,0,0.5)',   textColor:'#FFF8DC',
   btnBg:'linear-gradient(135deg,#B8860B,#FFD700)', btnText:'#1a1a00',
   dotColor:'#FFD700', particles:['#FFD700','#FFA500','#FFEC8B','#FF8C00','#FFE066'],
   bgTint:'rgba(30,22,0,0.97)', ico:'✨', label:'골드'},
  {id:'diamond',  name:'다이아몬드', advChance:28, bg:'radial-gradient(circle at 38% 34%,#ffffff 0%,#87CEEB 30%,#FF69B4 65%,#9400D3 100%)',
   glow:'rgba(255,105,180,0.9)', ringColor:'rgba(135,206,235,0.5)', textColor:'#FFF0FF',
   btnBg:'linear-gradient(135deg,#FF69B4,#87CEEB)', btnText:'#1a0020',
   dotColor:'#FF69B4', particles:['#FF69B4','#87CEEB','#FFB6C1','#B0E0E6','#DDA0DD'],
   bgTint:'rgba(20,0,40,0.97)', ico:'💎', label:'다이아몬드'},
  {id:'trans',    name:'초월',       advChance:18, bg:'radial-gradient(circle at 38% 34%,#e0ffe0 0%,#00FF7F 30%,#006400 68%,#002200 100%)',
   glow:'rgba(0,255,127,0.9)',   ringColor:'rgba(0,255,127,0.45)',  textColor:'#E0FFE0',
   btnBg:'linear-gradient(135deg,#004D00,#00FF7F)', btnText:'#002200',
   dotColor:'#00FF7F', particles:['#00FF7F','#39FF14','#7FFF00','#00FA9A','#ADFF2F'],
   bgTint:'rgba(0,15,0,0.97)',  ico:'⚡', label:'초월'},
  {id:'crosis',   name:'크로시스',   advChance:0,  bg:'radial-gradient(circle at 38% 34%,#ffffff 0%,#fff9c4 20%,#FFD700 50%,#d4a800 80%,#7a6000 100%)',
   glow:'rgba(255,255,255,1)',   ringColor:'rgba(255,255,255,0.5)', textColor:'#FFFFF0',
   btnBg:'linear-gradient(135deg,#FFD700,#ffffff)', btnText:'#1a1200',
   dotColor:'#FFFFFF', particles:['#FFFFFF','#FFD700','#FFFDE7','#FFF176','#FFE082'],
   bgTint:'rgba(15,12,0,0.97)', ico:'👑', label:'크로시스', jackpotChance:15}
];

// ── 보상 풀 ───────────────────────────────────────
const CG_REWARD_POOLS={
  wood:[
    {w:60,type:'coins',min:50,max:200},
    {w:40,type:'coins',min:200,max:400}
  ],
  gold:[
    {w:30,type:'coins',min:300,max:600},
    {w:22,type:'coins',min:600,max:1000},
    {w:18,type:'skin', id:'neon',    name:'네온 스킨',   colors:['#39FF14','#00FFFF'],shape:'neon'},
    {w:18,type:'skin', id:'mushroom',name:'버섯 스킨',   colors:['#FF4500','#fff'],  shape:'mushroom'},
    {w:12,type:'skin', id:'inferno', name:'인페르노 스킨',colors:['#FF3300','#FF8800'],shape:'inferno',gacha_excl:true}
  ],
  diamond:[
    {w:14,type:'coins',min:700,max:1400},
    {w:13,type:'skin', id:'gold',    name:'골드 스킨',   colors:['#FFD700','#FFA500'],shape:'gold'},
    {w:12,type:'skin', id:'silver',  name:'실버 스킨',   colors:['#d0d4e0','#a0a8b8'],shape:'silver'},
    {w:11,type:'skin', id:'chrome',  name:'크롬 스킨',   colors:['#e8eeff','#c0c8ff'],shape:'chrome'},
    {w:11,type:'skin', id:'star',    name:'별 스킨',     colors:['#FFD700','#FF8C00'],shape:'star'},
    {w:9, type:'map',  id:'mars',    name:'화성 맵',     colors:['#c47a45','#FF4500'],planet:'mars'},
    {w:9, type:'map',  id:'earth',   name:'지구 맵',     colors:['#1a6ab5','#2E8B57'],planet:'earth'},
    {w:12,type:'skin', id:'void_shard',name:'공허 파편 스킨',colors:['#6600cc','#cc00ff'],shape:'void_shard',gacha_excl:true},
    {w:9, type:'map',  id:'void_deep',name:'공허의 심연 맵',colors:['#6600cc','#00ffcc'],planet:'void_deep',gacha_excl:true}
  ],
  trans:[
    {w:20,type:'coins',min:1200,max:2800},
    {w:22,type:'skin', id:'crystal', name:'크리스탈 스킨',colors:['#88ddff','#ccf0ff'],shape:'crystal'},
    {w:22,type:'skin', id:'car',     name:'자동차 스킨', colors:['#FF2020','#fff'],   shape:'car'},
    {w:20,type:'skin', id:'sword',   name:'검 스킨',     colors:['#a0a8c8','#e0e8ff'],shape:'sword'},
    {w:16,type:'map',  id:'mars',    name:'화성 맵',     colors:['#c47a45','#FF4500'],planet:'mars'},
    {w:10,type:'map',  id:'earth',   name:'지구 맵',     colors:['#1a6ab5','#2E8B57'],planet:'earth'}
  ],
  crosis:[
    {w:18,type:'coins',min:2500,max:5000},
    {w:18,type:'skin', id:'crystal2',name:'크리스탈 샤드 스킨',colors:['#4DFFFF','#0080FF'],shape:'crystal2'},
    {w:18,type:'skin', id:'rocket',  name:'로켓 스킨',   colors:['#FF4500','#FFA500'],shape:'rocket'},
    {w:15,type:'skin', id:'sword',   name:'검 스킨',     colors:['#a0a8c8','#e0e8ff'],shape:'sword'},
    {w:20,type:'skin', id:'crosis_blessed',name:'크로시스 축복 스킨',colors:['#FFD700','#FFFFFF'],shape:'crosis_blessed',gacha_excl:true},
    {w:11,type:'map',  id:'crosis_realm',  name:'크로시스 영역 맵',  colors:['#FFD700','#FFFFFF'],planet:'crosis_realm',gacha_excl:true}
  ]
};

// ── 상태 ──────────────────────────────────────────
let _cgTierIdx=0;   // 0=나무 ... 4=크로시스
let _cgRunning=false;
let _cgRound=0;
const _CG_TOTAL_ROUNDS=5;

// ── 보조 함수 ─────────────────────────────────────
function _cgRand(min,max){return Math.floor(Math.random()*(max-min+1))+min;}
function _cgPick(pool){
  const total=pool.reduce((s,r)=>s+r.w,0);
  let rand=Math.random()*total;
  for(const r of pool){rand-=r.w;if(rand<=0)return r;}
  return pool[0];
}

// ── DOM ───────────────────────────────────────────
function $id(id){return document.getElementById(id);}

// ── 배경 파티클 생성 ──────────────────────────────
function _cgSpawnBg(tier){
  const c=$id('cg-bg-particles');if(!c)return;c.innerHTML='';
  const cols=tier.particles;
  for(let i=0;i<22;i++){
    const d=document.createElement('div');
    d.className='cg-bg-dot';
    const sz=4+Math.random()*8;
    d.style.cssText=`width:${sz}px;height:${sz}px;left:${Math.random()*100}%;`+
      `top:${20+Math.random()*80}%;background:${cols[i%cols.length]};`+
      `--ft:${3+Math.random()*4}s;--fd:${-Math.random()*4}s;`;
    c.appendChild(d);
  }
}

// ── 파티클 폭발 ──────────────────────────────────
function _cgBurst(tier, win){
  const c=$id('cg-particles');if(!c)return;c.innerHTML='';
  const cols=win?tier.particles:[...tier.particles,'#fff'];
  const n=win?32:18;
  const cx=window.innerWidth/2, cy=window.innerHeight/2;
  for(let i=0;i<n;i++){
    const p=document.createElement('div');
    p.className='cg-particle';
    const ang=Math.random()*360;const dist=60+Math.random()*(win?200:130);
    const px=Math.cos(ang*Math.PI/180)*dist;
    const py=Math.sin(ang*Math.PI/180)*dist - (win?30:0);
    const sz=win?(6+Math.random()*14):(4+Math.random()*8);
    const col=cols[Math.floor(Math.random()*cols.length)];
    p.style.cssText=`width:${sz}px;height:${sz}px;`+
      `left:${cx-sz/2}px;top:${cy-sz/2}px;`+
      `background:${col};--px:${px}px;--py:${py}px;`+
      `--pd:${.5+Math.random()*.6}s;box-shadow:0 0 ${sz*2}px ${col}`;
    c.appendChild(p);
  }
  setTimeout(()=>{c.innerHTML='';},900);
}

// ── 오브/UI 티어 적용 ─────────────────────────────
function _cgApplyTier(tierIdx,animated){
  const tier=CG_TIERS[tierIdx];
  const ov=$id('cg-ov');
  if(ov){ov.style.background=tier.bgTint;}
  // 타이틀
  const lbl=$id('cg-tier-label');
  if(lbl){lbl.textContent=tier.label;lbl.style.color=tier.textColor;
    lbl.style.textShadow='0 0 24px '+tier.glow;}
  // 오브
  const orb=$id('cg-orb');
  if(orb){orb.style.background=tier.bg;orb.style.boxShadow=`0 0 70px ${tier.glow},0 0 130px ${tier.glow.replace('.9','.4')},inset 0 -12px 32px rgba(0,0,0,0.3)`;}
  // 링
  document.querySelectorAll('.cg-ring').forEach((r,i)=>{
    r.style.borderColor=tier.ringColor;});
  // 아이콘
  const ico=$id('cg-orb-ico');if(ico)ico.textContent=tier.ico;
  // 진행 도트
  document.querySelectorAll('.cg-dot').forEach((d,i)=>{
    d.classList.remove('active','done');
    if(i<tierIdx){d.classList.add('done');d.style.background=CG_TIERS[i].dotColor;d.style.borderColor=CG_TIERS[i].dotColor;d.style.opacity='.45';}
    else if(i===tierIdx){d.classList.add('active');d.style.background=tier.dotColor;d.style.borderColor=tier.dotColor;d.style.opacity='1';d.style.boxShadow='0 0 14px '+tier.glow;}
    else{d.style.background='rgba(255,255,255,.18)';d.style.borderColor='rgba(255,255,255,.25)';d.style.boxShadow='none';d.style.opacity='1';}
  });
  // 버튼
  const btn=$id('cg-try-btn');
  if(btn){
    btn.style.background=tier.btnBg;
    btn.style.color=tier.btnText;
    btn.style.boxShadow='0 0 22px '+tier.glow.replace('.9','.6');
    if(_cgRound===0){
      btn.textContent='🎲 가챠 시작!';
    }
  }
  // 힌트
  const hint=$id('cg-hint');
  if(hint){
    hint.style.color=tier.textColor;
    if(_cgRound===0) hint.textContent='5번의 기회 — 운이 좋으면 단계 상승!';
  }
  // 배경 파티클
  _cgSpawnBg(tier);
  // 오브 회전 애니메이션 (티어 업 시)
  if(animated){
    const wrap=$id('cg-orb-wrap');
    if(wrap){
      wrap.style.transition='transform .35s cubic-bezier(.22,1.6,.5,1),filter .5s';
      wrap.style.transform='scale(1.18) rotate(8deg)';
      wrap.style.filter='brightness(2.2)';
      setTimeout(()=>{wrap.style.transform='';wrap.style.filter='';},400);
    }
  }
}

// ── CSS 스킨 모델 렌더링 ──────────────────────────
function _cgRenderSkinModel(shape, colors){
  const c1=colors[0]||'#fff', c2=colors[1]||c1;
  const shapes={
    neon:`<div class="cg-gem" style="background:linear-gradient(135deg,${c1},${c2});--gc:${c1}"></div>
          <div style="position:absolute;width:12px;height:12px;border-radius:50%;background:${c1};box-shadow:0 0 20px 8px ${c1};top:8px;right:8px;animation:cgGemSpin 1.5s linear infinite"></div>`,
    mushroom:`<div style="font-size:58px;filter:drop-shadow(0 0 18px ${c1})">🍄</div>`,
    gold:`<div class="cg-gem" style="background:linear-gradient(135deg,${c1},${c2});--gc:${c1}"></div>`,
    silver:`<div class="cg-gem" style="background:linear-gradient(135deg,${c1},${c2});--gc:${c1}"></div>`,
    chrome:`<div class="cg-gem" style="background:linear-gradient(135deg,${c1}aa,${c2},${c1});--gc:${c1}"></div>`,
    crystal:`<div class="cg-gem" style="background:linear-gradient(135deg,${c1}88,${c2}88,${c1}88);--gc:${c1};border:1.5px solid ${c1}aa"></div>`,
    crystal2:`<div style="position:relative;width:70px;height:70px">
      <div style="position:absolute;top:0;left:50%;transform:translateX(-50%);width:0;height:0;border-left:18px solid transparent;border-right:18px solid transparent;border-bottom:52px solid ${c1}aa;filter:drop-shadow(0 0 12px ${c1})"></div>
      <div style="position:absolute;bottom:0;left:50%;transform:translateX(-50%);width:0;height:0;border-left:12px solid transparent;border-right:12px solid transparent;border-top:34px solid ${c2}aa;filter:drop-shadow(0 0 8px ${c2})"></div></div>`,
    star:`<div style="font-size:62px;filter:drop-shadow(0 0 22px ${c1});animation:cgGemSpin 4s linear infinite">⭐</div>`,
    car:`<div style="font-size:58px;filter:drop-shadow(0 0 18px ${c1})">🚗</div>`,
    rocket:`<div style="font-size:58px;filter:drop-shadow(0 0 18px ${c1});animation:cgIcoFloat 1.5s ease-in-out infinite">🚀</div>`,
    sword:`<div style="font-size:58px;filter:drop-shadow(0 0 18px ${c1});transform:rotate(-45deg)">⚔️</div>`,
    inferno:`<div style="font-size:62px;filter:drop-shadow(0 0 28px ${c1}) drop-shadow(0 0 14px ${c2});animation:cgIcoFloat 1.2s ease-in-out infinite">🔥</div>`,
    void_shard:`<div style="position:relative;width:70px;height:70px;filter:drop-shadow(0 0 20px ${c1})">
      <div style="position:absolute;top:0;left:50%;transform:translateX(-50%);width:0;height:0;border-left:16px solid transparent;border-right:16px solid transparent;border-bottom:50px solid ${c1}aa"></div>
      <div style="position:absolute;top:20px;left:50%;transform:translateX(-50%);width:0;height:0;border-left:10px solid transparent;border-right:10px solid transparent;border-bottom:32px solid ${c2}aa"></div>
      <div style="position:absolute;bottom:0;left:50%;transform:translateX(-50%) rotate(180deg);width:0;height:0;border-left:8px solid transparent;border-right:8px solid transparent;border-bottom:22px solid ${c1}88"></div></div>`,
    crosis_blessed:`<div style="position:relative;width:80px;height:80px;display:flex;align-items:center;justify-content:center">
      <div style="width:58px;height:58px;clip-path:polygon(50% 0%,65% 35%,100% 35%,73% 57%,82% 91%,50% 70%,18% 91%,27% 57%,0% 35%,35% 35%);background:linear-gradient(135deg,${c1}cc,${c2}cc,${c1}88);filter:drop-shadow(0 0 24px ${c1}) drop-shadow(0 0 12px ${c2});animation:cgGemSpin 3s linear infinite"></div></div>`
  };
  return shapes[shape]||`<div class="cg-gem" style="background:linear-gradient(135deg,${c1},${c2});--gc:${c1}"></div>`;
}

// ── CSS 맵 모델 렌더링 ────────────────────────────
function _cgRenderMapModel(planet, colors){
  const c1=colors[0]||'#1a6ab5', c2=colors[1]||'#2E8B57';
  if(planet==='mars'){
    return `<div class="cg-map-planet" style="background:radial-gradient(circle at 35% 35%,#e8836a 0%,${c1} 45%,#6b2900 100%);--pg:rgba(255,100,50,.6)">
      <div class="cg-planet-band" style="background:${c2};top:25%"></div>
      <div class="cg-planet-band" style="background:#c04020;top:55%;height:18%"></div></div>`;
  }
  return `<div class="cg-map-planet" style="background:radial-gradient(circle at 35% 35%,#a0d0ff 0%,${c1} 45%,#0a3060 100%);--pg:rgba(50,150,255,.6)">
    <div class="cg-planet-band" style="background:${c2};top:30%;height:22%"></div>
    <div class="cg-planet-band" style="background:#90c0ff;top:55%;height:14%"></div>
    <div style="position:absolute;top:10px;left:15px;width:22px;height:16px;border-radius:50%;background:rgba(255,255,255,.7)"></div></div>`;
  if(planet==='crosis_realm'){
    return `<div style="position:relative;display:flex;align-items:center;justify-content:center;width:100%;height:100%">
      <div class="cg-map-planet" style="background:radial-gradient(circle at 35% 35%,#fffde7 0%,#ffd700 40%,#7a5800 80%,#1a1000 100%);--pg:rgba(255,215,0,.8);box-shadow:0 0 35px rgba(255,215,0,.7),0 0 70px rgba(255,200,0,.3)">
        <div class="cg-planet-band" style="background:rgba(255,255,200,.35);top:28%;height:18%"></div>
        <div class="cg-planet-band" style="background:rgba(255,240,150,.25);top:52%;height:12%"></div>
        <div style="position:absolute;top:8px;right:10px;width:18px;height:14px;border-radius:50%;background:rgba(255,255,255,.5)"></div></div>
      <div class="cg-map-ring" style="border-color:rgba(255,215,0,.5);border-width:4px;width:130px"></div></div>`;
  }
  if(planet==='void_deep'){
    return `<div style="position:relative;display:flex;align-items:center;justify-content:center;width:100%;height:100%">
      <div class="cg-map-planet" style="background:radial-gradient(circle at 38% 32%,#330066 0%,#1a0040 45%,#050010 100%);--pg:rgba(102,0,204,.8);box-shadow:0 0 30px rgba(102,0,204,.7),0 0 60px rgba(0,255,200,.2)">
        <div class="cg-planet-band" style="background:rgba(0,255,200,.2);top:32%;height:14%"></div>
        <div class="cg-planet-band" style="background:rgba(80,0,180,.3);top:50%;height:20%"></div></div>
      <div class="cg-map-ring" style="border-color:rgba(0,255,200,.4);border-width:4px;width:128px"></div></div>`;
  }
}

// ── 보상 부여 ─────────────────────────────────────
function _cgGrantReward(reward, jackpot){
  if(reward.type==='coins'){
    let amt=_cgRand(reward.min,reward.max);
    if(jackpot) amt*=2;
    if(typeof coins!=='undefined'){coins+=amt;doSave();updateCoins();}
    return {text:(jackpot?'🎆 잭팟! ':'')+'+'+(jackpot?amt/2+'×2='+amt:amt)+' 💰', amount:amt, jackpot};
  }
  if(reward.type==='skin'){
    if(typeof owned!=='undefined'&&!owned.has(reward.id)){owned.add(reward.id);doSave();if(typeof renderShopGrid==='function')renderShopGrid();}
    return {text:'🎁 스킨 획득!', amount:0, jackpot:false};
  }
  if(reward.type==='map'){
    if(typeof ownedMaps!=='undefined'&&!ownedMaps.has(reward.id)){ownedMaps.add(reward.id);doSave();if(typeof renderShopGrid==='function')renderShopGrid();}
    return {text:'🗺️ 맵 획득!', amount:0, jackpot:false};
  }
  return {text:'보상!',amount:0,jackpot:false};
}

// ── 결과 표시 ─────────────────────────────────────
function _cgShowResult(tierIdx, reward, jackpot){
  const tier=CG_TIERS[tierIdx];
  const wrap=$id('cg-result-wrap');
  const playWrap=$id('cg-play-wrap');
  if(playWrap)playWrap.style.display='none';
  if(wrap)wrap.style.display='flex';

  const granted=_cgGrantReward(reward, jackpot);

  // 티어 라벨
  const tl=$id('cg-res-tier');
  if(tl){tl.textContent='— '+tier.label+' —';tl.style.color=tier.textColor;}
  // 이름
  const rn=$id('cg-res-name');
  if(rn){
    rn.textContent=reward.type==='coins'?(jackpot?'💫 잭팟 코인!':'💰 코인 획득!'):reward.name;
    rn.style.textShadow='0 0 24px '+tier.glow;
  }
  // 금액
  const ra=$id('cg-res-amount');if(ra)ra.textContent=granted.text;
  // 잭팟 배지
  const jb=$id('cg-jackpot-badge');if(jb)jb.style.display=jackpot?'block':'none';
  // 모델
  const mb=$id('cg-model-box');
  if(mb){
    if(reward.type==='coins'){
      const coinAmt=jackpot?_cgRand(reward.min,reward.max)*2:_cgRand(reward.min,reward.max);
      mb.innerHTML=`<div style="font-size:56px;text-align:center;filter:drop-shadow(0 0 28px #FFD700)">💰<div style="font-size:20px;font-weight:900;color:#FFD700;margin-top:-8px">×${jackpot?'2':'1'}</div></div>`;
    } else if(reward.type==='skin'){
      mb.innerHTML=`<div class="cg-skin-model">${_cgRenderSkinModel(reward.shape,reward.colors)}</div>`;
    } else if(reward.type==='map'){
      mb.innerHTML=_cgRenderMapModel(reward.planet,reward.colors);
    }
  }

  // 닫기 버튼 색상
  const cb=$id('cg-close-btn');
  if(cb){cb.style.background=tier.btnBg;cb.style.color=tier.btnText;}
}

// ── 메인 진행 (클릭 1회 = 라운드 1회) ────────────
function _cgDoTry(){
  if(_cgRunning)return;
  _cgRunning=true;
  const btn=$id('cg-try-btn');if(btn)btn.disabled=true;

  _cgRound++;
  // 라운드 카운터 표시
  const hint=$id('cg-hint');
  if(hint) hint.textContent='라운드 '+_cgRound+' / '+_CG_TOTAL_ROUNDS;

  const tier=CG_TIERS[_cgTierIdx];
  // 크로시스(4단계) 이상이면 더 오를 수 없으므로 advance 없음
  const canAdvance=(_cgTierIdx<4);
  const advance=canAdvance && (Math.random()*100<tier.advChance);
  _cgBurst(tier, advance);

  setTimeout(()=>{
    if(advance){
      _cgTierIdx++;
      _cgApplyTier(_cgTierIdx, true);
    }

    if(_cgRound<_CG_TOTAL_ROUNDS){
      // 다음 클릭을 기다림 — 버튼 재활성화
      _cgRunning=false;
      const remaining=_CG_TOTAL_ROUNDS-_cgRound;
      if(btn){
        btn.disabled=false;
        btn.textContent='🎲 눌러요! ('+remaining+'번 남음)';
      }
    } else {
      // 5라운드 완료 → 현재 단계로 보상 지급
      const finalTier=CG_TIERS[_cgTierIdx];
      const pool=CG_REWARD_POOLS[finalTier.id]||CG_REWARD_POOLS.wood;
      const reward=_cgPick(pool);
      const jackpot=(_cgTierIdx===4)&&(Math.random()*100<(finalTier.jackpotChance||0));
      _cgBurst(finalTier, true);
      setTimeout(()=>{
        _cgShowResult(_cgTierIdx, reward, jackpot);
        _cgRunning=false;
      },650);
    }
  },650);
}

// ── 가챠 열기 ─────────────────────────────────────
function showCrosisGacha(){
  _cgTierIdx=0;
  _cgRound=0;
  _cgRunning=false;
  const ov=$id('cg-ov');if(!ov)return;
  // 플레이 패널 표시, 결과 패널 숨김
  const pw=$id('cg-play-wrap');if(pw)pw.style.display='flex';
  const rw=$id('cg-result-wrap');if(rw)rw.style.display='none';
  // 파티클 초기화
  const pc=$id('cg-particles');if(pc)pc.innerHTML='';
  // 티어 0 적용
  _cgApplyTier(0, false);
  // 버튼 상태
  const btn=$id('cg-try-btn');if(btn)btn.disabled=false;
  ov.classList.add('on');
}

// ── 이벤트 바인딩 ─────────────────────────────────
document.addEventListener('DOMContentLoaded',function(){
  // 열기 버튼
  const openBtn=$id('btn-crosis-gacha');
  if(openBtn){openBtn.addEventListener('click',function(){this.style.display='none';showCrosisGacha();});}
  // 도전 버튼
  const tryBtn=$id('cg-try-btn');
  if(tryBtn){tryBtn.addEventListener('click',_cgDoTry);}
  // 닫기 버튼
  const closeBtn=$id('cg-close-btn');
  if(closeBtn){closeBtn.addEventListener('click',function(){$id('cg-ov').classList.remove('on');});}
});

})(); // end IIFE

// 크로시스 가챠 연동: showUI에서 이미 처리됨



// ══════════════════════════════════════════════════
// STORY SYSTEM — Arrow City / 에로의 모험
// ══════════════════════════════════════════════════
const _SC=[]; // player choice history (indexed by choice-event)
let _sCb=null,_sLineIdx=0,_sLines=[],_sTyping=false;
let _sFullTxt='',_sTypTimer=null,_sCurStage=0,_sChoiceShown=false;

// Story data: STORY[0] = stage 1 START dialogue
//             STORY[N] = dialogue shown AFTER clearing stage N (N≥1)
const _STORY=[
  // ── 0 · Stage 1 START — Opening
  {trigger:'start',lines:[
    "…여긴 어디지?",
    "…안 돼… 출구가 막혀 있어.",
    "…잠깐, 거기 있는 사람! 내 목소리가 들려?",
    "정말 다행이다!",
    "난 에로야.",
    "우리 도시가 이상한 힘 때문에 봉인됐어.",
    "우린 서로 부딪히면 움직일 수 없어.",
    "하지만 넌 우리를 움직여 줄 수 있는 유일한 존재야.",
    "제발… 친구들을 하나씩 출구까지 보내 줘.",
    "모두를 구하면 이 도시도 다시 살아날 거야.",
    "준비됐지?"
  ],btn:'게임 시작'},

  // ── 1 · After clearing Stage 1
  {trigger:'clear',lines:[
    "해냈어! 첫 친구를 구했어!",
    "근데… 이 균열, 보통 게 아닌 것 같아.",
    "점점 더 빠르게 퍼지고 있어. 서두르자."
  ]},

  // ── 2 · After clearing Stage 2
  {trigger:'clear',lines:[
    "두 명이나 구했어! 고마워.",
    "균열 속에서 뭔가 느껴져.",
    "살아있는 것 같아… 이상한 힘이야."
  ]},

  // ── 3 · After clearing Stage 3 — 첫 번째 선택
  {trigger:'clear',lines:[
    "세 명을 구했어!",
    "균열이 자꾸 나를 바라보는 것 같아.",
    "넌 어떻게 생각해?"
  ],choices:[
    "그냥 균열이겠지. 빨리 탈출하자!",
    "위험해. 균열을 최대한 피하자.",
    "…그 힘이 뭔지 더 알아봐야 해."
  ]},

  // ── 4 · 선택 0 분기
  {trigger:'clear',lines:c=>{
    if(c[0]===0)return["역시 네 말이 맞을 수도 있어.","하지만 균열이 자꾸 날 바라봐.","신경 쓰지 말자. 계속 가자!"];
    if(c[0]===1)return["조심해서 피해왔어. 잘했어.","균열이 우릴 감지하는 것 같아.","서두르되 조심하자."];
    return["그 힘… 어디서 오는 걸까?","균열 속에서 속삭이는 소리가 들려.","집중해야 해. 계속 가자."];
  }},

  // ── 5
  {trigger:'clear',lines:[
    "다섯 번째 친구도 구했어!",
    "이 도시 어딘가에 '봉인석'이 있어.",
    "그걸 찾아서 부수면 모두 탈출할 수 있을 거야."
  ]},

  // ── 6
  {trigger:'clear',lines:[
    "봉인석… 어떻게 생겼을까.",
    "도시 중심부 쪽에서 검은 빛이 보여.",
    "저기가 시작점일지도 몰라."
  ]},

  // ── 7
  {trigger:'clear',lines:[
    "도시가 점점 어두워지고 있어.",
    "구해낸 친구들이 안전한 곳에 모이고 있어.",
    "아직 포기하지 마. 같이 가자."
  ]},

  // ── 8
  {trigger:'clear',lines:[
    "또 한 명 더! 잘했어.",
    "균열 사이로 낯선 목소리가 들렸어.",
    "'그만둬라. 이 도시는 내 것이다.'",
    "누군가 의도적으로 균열을 만든 거야…!"
  ]},

  // ── 9
  {trigger:'clear',lines:[
    "이건 사고가 아니야.",
    "누군가 이 도시를 봉인했어.",
    "이유가 뭘까…"
  ]},

  // ── 10 · 두 번째 선택
  {trigger:'clear',lines:[
    "열 번째 친구를 구했어!",
    "균열의 주인이 나타났어. '다크 아우라'라고 해.",
    "아주 오래된 화살표래. 도시에서 버림받았다고 했어."
  ],choices:[
    "버림받았어도 이러면 안 되지!",
    "…불쌍하기도 해. 이유를 들어보자.",
    "어떤 이유든 우린 탈출해야 해."
  ]},

  // ── 11 · 선택 1 분기
  {trigger:'clear',lines:c=>{
    if(c[1]===0)return["맞아. 이유가 어떻든 도시를 봉인하면 안 돼!","다크 아우라를 막아야 해.","더 빨리 탈출할수록 다크 아우라도 약해져."];
    if(c[1]===1)return["다크 아우라가 왜 버림받았는지 생각해 봤어.","혹시… 먼저 손을 내밀 수 있을까?","모르겠어. 일단 계속 가자."];
    return["어떤 이유든 우린 앞으로 나아가야 해.","다크 아우라도 결국 한 명의 화살표야.","언젠가 이해할 수 있을 거야."];
  }},

  // ── 12
  {trigger:'clear',lines:[
    "균열이 빛을 발하기 시작했어.",
    "다크 아우라가 에너지를 모으고 있는 것 같아.",
    "시간이 없어. 더 빠르게 움직이자."
  ]},

  // ── 13
  {trigger:'clear',lines:[
    "저기 봐! 오래된 벽화가 있어.",
    "화살표들이 함께 춤을 추는 그림이야.",
    "이 도시, 원래는 정말 아름다웠을 거야."
  ]},

  // ── 14
  {trigger:'clear',lines:[
    "다크 아우라의 봉인이 더 두꺼워지고 있어.",
    "하지만 친구들이 탈출할수록 균열도 조금씩 옅어져.",
    "희망이 있어. 계속하자!"
  ]},

  // ── 15 · 세 번째 선택
  {trigger:'clear',lines:[
    "열다섯 명이나 구했어!",
    "다크 아우라가 나한테 직접 말을 걸었어.",
    "'같이 이 도시를 지배하자'고 했어."
  ],choices:[
    "절대 안 돼! 우린 모두 자유로워야 해.",
    "…그게 무슨 의미인지 물어봤어.",
    "무시해. 우린 탈출에만 집중할 거야."
  ]},

  // ── 16 · 선택 2 분기
  {trigger:'clear',lines:c=>{
    if(c[2]===0)return["단호하게 거절했어.","다크 아우라가 엄청 화가 났나봐.","균열이 더 넓어졌어. 서두르자!"];
    if(c[2]===1)return["'도시를 둘이 나누자'는 거였어.","물론 거절했어. 남은 친구들을 포기할 수 없잖아.","다크 아우라가 분노했어. 조심해."];
    return["무시하자. 흔들리면 안 돼.","다크 아우라가 약점을 찾고 있는 거야.","집중! 계속 탈출하자."];
  }},

  // ── 17
  {trigger:'clear',lines:[
    "도시 한쪽이 완전히 무너졌어.",
    "빠르게 움직여야 해.",
    "아직 삼십 명 넘게 갇혀 있어…"
  ]},

  // ── 18
  {trigger:'clear',lines:[
    "오래된 화살표 어른이 알려줬어.",
    "'다크 아우라는 원래 이 도시의 수호자였대.'",
    "수호자가 적이 됐어. 왜 그랬을까…"
  ]},

  // ── 19
  {trigger:'clear',lines:[
    "균열 속에서 낡은 지도를 발견했어!",
    "봉인석의 위치가 표시돼 있어.",
    "거기까지 가면 다크 아우라를 막을 수 있을 거야."
  ]},

  // ── 20 · 네 번째 선택
  {trigger:'clear',lines:[
    "스무 명을 구했어! 절반 가까이 됐어!",
    "봉인석 앞에 도착했어. 하지만…",
    "다크 아우라가 말했어: '봉인석을 부수면 나도 사라진다.'"
  ],choices:[
    "부수자. 도시가 더 중요해!",
    "…정말? 다른 방법이 없을까?",
    "선택은 나중에 하자. 지금은 탈출이 먼저야."
  ]},

  // ── 21 · 선택 3 분기
  {trigger:'clear',lines:c=>{
    if(c[3]===0)return["단호하게 결정했어. 도시가 먼저야.","다크 아우라가 슬픈 표정을 지었어.","그래도 앞으로 가야 해."];
    if(c[3]===1)return["다른 방법을 찾고 있어.","봉인석을 완전히 부수지 않고 약화시킬 수 있을까?","시간이 없지만 연구해보자."];
    return["일단 탈출을 계속해.","봉인석 문제는 더 생각해보자.","남은 친구들이 더 중요해."];
  }},

  // ── 22
  {trigger:'clear',lines:[
    "다크 아우라의 기억이 조각조각 보여.",
    "오래전, 도시 사람들에게 외면받던 작은 화살표.",
    "…마음이 아파."
  ]},

  // ── 23
  {trigger:'clear',lines:[
    "그래도 포기할 수 없어.",
    "다크 아우라가 선택할 기회를 줘야 해.",
    "아직 희망이 있어."
  ]},

  // ── 24
  {trigger:'clear',lines:[
    "구해낸 친구들이 힘을 합쳐 균열을 밀어내고 있어!",
    "다 함께면 할 수 있어.",
    "더 많이 구할수록 힘이 커져."
  ]},

  // ── 25 · 다섯 번째 선택 (중간 지점)
  {trigger:'clear',lines:[
    "스물다섯! 정확히 절반이야!",
    "다크 아우라가 잠시 나타나서 물었어.",
    "'넌 왜 포기하지 않는 거야?'"
  ],choices:[
    "지쳐도 포기 못해. 모두가 소중하니까.",
    "솔직히 힘들어. 하지만 여기서 멈출 수 없어.",
    "포기? 아직 할 수 있는 일이 남았는데."
  ]},

  // ── 26 · 선택 4 분기
  {trigger:'clear',lines:c=>{
    if(c[4]===0)return["다크 아우라가 잠시 말을 잃었어.","'…소중하다고?'","뭔가 달라지는 것 같아."];
    if(c[4]===1)return["솔직하게 말해줘서 고마워.","다크 아우라도 뭔가 느낀 것 같아.","계속 가자."];
    return["다크 아우라가 피식 웃었어.","'재밌는 존재네.'","균열이 살짝 옅어진 것 같아."];
  }},

  // ── 27
  {trigger:'clear',lines:[
    "봉인석에서 균열이 생기기 시작했어!",
    "친구들의 탈출 에너지가 봉인을 약하게 만들고 있어.",
    "계속하면 돼!"
  ]},

  // ── 28
  {trigger:'clear',lines:[
    "다크 아우라가 갑자기 사라졌어.",
    "어디 간 걸까… 불안해.",
    "하지만 지금은 탈출에 집중해야 해."
  ]},

  // ── 29
  {trigger:'clear',lines:[
    "도시 외곽에서 빛이 들어오기 시작했어!",
    "봉인이 조금씩 해제되고 있어.",
    "희망이 보여!"
  ]},

  // ── 30 · 여섯 번째 선택
  {trigger:'clear',lines:[
    "서른 명이나 구했어! 대단해!",
    "다크 아우라가 다시 나타났어.",
    "'나도… 사실은 이 도시가 그리웠어.' 라고 했어."
  ],choices:[
    "그렇다면 함께 도시를 구하자!",
    "믿어도 될까? 함정일 수도 있어.",
    "지금이라도 늦지 않았어. 우리 편이 되어줘."
  ]},

  // ── 31 · 선택 5 분기
  {trigger:'clear',lines:c=>{
    if(c[5]===0)return["다크 아우라가 망설이다 고개를 끄덕였어.","진짜이길 바라.","균열이 눈에 띄게 줄었어!"];
    if(c[5]===1)return["의심스러운 건 당연해.","다크 아우라도 그 마음을 알면서 기다려 주고 있어.","천천히 가자."];
    return["다크 아우라의 눈빛이 흔들렸어.","'…같이 가도 될까?' 라고 물었어.","물론이야, 라고 답했어."];
  }},

  // ── 32
  {trigger:'clear',lines:[
    "다크 아우라가 봉인을 스스로 조금 풀어줬어.",
    "정말 우리 편이 된 걸까?",
    "믿어보자. 우리에겐 아직 갈 길이 있어."
  ]},

  // ── 33
  {trigger:'clear',lines:[
    "도시 곳곳에서 빛이 복원되고 있어.",
    "오래된 벽화의 그림처럼 화살표들이 춤을 추고 있어.",
    "아름다워."
  ]},

  // ── 34
  {trigger:'clear',lines:[
    "다크 아우라가 힘을 보태줬어.",
    "균열이 절반 이하로 줄었어!",
    "이제 진짜 끝이 보여."
  ]},

  // ── 35 · 일곱 번째 선택
  {trigger:'clear',lines:[
    "서른다섯 명을 구했어.",
    "봉인석이 흔들리기 시작했어.",
    "다크 아우라가 물었어: '봉인석을 같이 부술까?'"
  ],choices:[
    "응, 같이 하자. 우리가 해낼 수 있어.",
    "아직 이른 것 같아. 더 준비하자.",
    "네가 결정해. 네 도시이기도 해."
  ]},

  // ── 36 · 선택 6 분기
  {trigger:'clear',lines:c=>{
    if(c[6]===0)return["다크 아우라와 함께 봉인석을 향해 달려갔어.","처음으로 진짜 같은 편이 된 것 같아.","이 느낌, 좋아."];
    if(c[6]===1)return["다크 아우라가 고개를 끄덕였어.","'좋아. 더 준비해.'","더 많이 구하고 함께 가자."];
    return["다크 아우라가 눈물을 흘렸어.","'이 도시를 나한테 맡겨줘서 고마워.'","이제 진짜 하나가 된 것 같아."];
  }},

  // ── 37
  {trigger:'clear',lines:[
    "이제 열 명만 더 구하면 돼.",
    "다크 아우라가 봉인 에너지를 막아주고 있어.",
    "빠르게 가자!"
  ]},

  // ── 38
  {trigger:'clear',lines:[
    "도시 하늘이 맑아지기 시작했어.",
    "균열 사이로 별빛이 보여.",
    "예전의 애로우 시티가 돌아오고 있어!"
  ]},

  // ── 39
  {trigger:'clear',lines:[
    "다크 아우라가 말했어.",
    "'미안해. 오래 기다리게 했어.'",
    "괜찮아. 지금 함께 있잖아."
  ]},

  // ── 40 · 여덟 번째 선택
  {trigger:'clear',lines:[
    "마흔 명! 거의 다 왔어!",
    "봉인석에 금이 가기 시작했어.",
    "한 번에 부술 수 있을 것 같아. 어떻게 할까?"
  ],choices:[
    "지금 당장 부수자! 기다릴 필요 없어.",
    "남은 친구들을 다 구한 다음에 부수자.",
    "다크 아우라에게 부수는 힘을 줄게."
  ]},

  // ── 41 · 선택 7 분기
  {trigger:'clear',lines:c=>{
    if(c[7]===0)return["봉인석에 큰 균열이 생겼어!","하지만 완전히 부수지는 못했어.","조금만 더 구하면 돼."];
    if(c[7]===1)return["그래. 모두를 위해 기다리자.","다크 아우라도 동의했어.","서두르자!"];
    return["다크 아우라가 봉인석에 손을 댔어.","엄청난 빛이 쏟아졌어!","거의 다 왔어. 끝까지 가자."];
  }},

  // ── 42
  {trigger:'clear',lines:["여덟 명만 남았어.","다들 힘을 합쳐서 마지막 균열을 누르고 있어.","우린 해낼 수 있어."]},

  // ── 43
  {trigger:'clear',lines:["일곱 명.","도시 전체가 진동하고 있어.","봉인석이 무너지려고 해."]},

  // ── 44
  {trigger:'clear',lines:["여섯 명.","다크 아우라가 봉인의 마지막 힘을 막아주고 있어.","힘내자. 거의 다 왔어."]},

  // ── 45
  {trigger:'clear',lines:["다섯 명.","도시의 빛이 거의 완전히 돌아왔어.","마지막 친구들, 기다려!"]},

  // ── 46
  {trigger:'clear',lines:["네 명.","균열이 마지막 한 조각만 남았어.","다크 아우라: '이제 거의 끝났어.'"]},

  // ── 47
  {trigger:'clear',lines:["세 명.","봉인석에 마지막 빛이 모이고 있어.","숨죽이지 마. 같이 호흡하자."]},

  // ── 48
  {trigger:'clear',lines:["두 명.","지금까지 정말 잘 해줬어.","마지막까지 함께해줘."]},

  // ── 49 · 아홉 번째 선택 (마지막 선택)
  {trigger:'clear',lines:[
    "한 명만 남았어.",
    "그런데 그 마지막 친구… 바로 나야, 에로.",
    "이제 내 차례야. 날 탈출시켜줄 수 있어?"
  ],choices:[
    "물론이야! 기다려, 에로!",
    "네가 마지막이었구나. 꼭 데려갈게.",
    "처음부터 끝까지 함께였잖아. 가자!"
  ]},

  // ── 50 (index 50) · 마지막 스테이지 클리어 — 엔딩
  {trigger:'clear',ending:true,
  lines:c=>{
    const last=c[8]||0;
    return[
      "…해냈어.",
      "모두를 구했어.",
      "봉인석이 산산조각 났어.",
      "균열이 사라지고 있어.",
      "애로우 시티에 빛이 돌아오고 있어.",
      "다크 아우라가 말했어: '고마워. 이제 진짜 집으로 돌아왔어.'",
      "구해낸 모든 화살표들이 하늘로 솟구치며 춤을 추기 시작했어.",
      "이 도시가 살아났어.",
      "그리고 이건 다 너 덕분이야.",
      last===0?"언제나 포기하지 않아줘서 고마워.":
      last===1?"끝까지 날 믿어줘서 고마워.":
               "처음부터 끝까지 함께해줘서 고마워.",
      "나 에로, 이 도시를 대표해서 말할게.",
      "…정말 고마워."
    ];
  },
  endingText:"애로우 시티의 모든 화살표가 자유를 되찾았습니다.\n도시에는 다시 빛이 가득 찼고,\n다크 아우라도 이제 같은 편이 되었습니다.\n\n— Chapter 1 Complete —"}
];

// ── Story engine ──────────────────────────────────
function _storyShowLine(idx){
  const el=document.getElementById('story-text');
  const tap=document.getElementById('story-tap');
  _sFullTxt=_sLines[idx];
  let ci=0;_sTyping=true;
  if(el)el.textContent='';
  if(tap)tap.classList.remove('ready');
  clearInterval(_sTypTimer);
  _sTypTimer=setInterval(()=>{
    if(el)el.textContent+=_sFullTxt[ci++];
    if(ci>=_sFullTxt.length){
      clearInterval(_sTypTimer);_sTyping=false;
      if(tap)tap.classList.add('ready');
    }
  },40);
}

function _storyTap(){
  if(_sTyping){
    clearInterval(_sTypTimer);_sTyping=false;
    const _te=document.getElementById('story-text');if(_te)_te.textContent=_sFullTxt;
    const tap=document.getElementById('story-tap');if(tap)tap.classList.add('ready');
    return;
  }
  _sLineIdx++;
  if(_sLineIdx<_sLines.length){_storyShowLine(_sLineIdx);}
  else{_storyAllDone();}
}

function _storyAllDone(){
  const e=_STORY[_sCurStage];
  const tap=document.getElementById('story-tap');
  if(tap)tap.classList.remove('ready');
  // Show choices?
  if(e&&e.choices&&!_sChoiceShown){
    _sChoiceShown=true;
    const cont=document.getElementById('story-choices');
    cont.innerHTML='';cont.style.display='flex';
    e.choices.forEach((txt,i)=>{
      const btn=document.createElement('button');
      btn.className='story-choice-btn';
      btn.textContent=['① ','② ','③ '][i]+txt;
      let _picked=false;
      function _pick(){
        if(_picked)return;_picked=true;
        _SC.push(i);cont.style.display='none';_storyClose();
      }
      btn.addEventListener('click',_pick,{once:true});
      btn.addEventListener('touchend',function(ev){ev.preventDefault();_pick();},{passive:false,once:true});
      cont.appendChild(btn);
    });
    return;
  }
  // Show start/action button?
  if(e&&e.btn){
    const mb=document.getElementById('story-main-btn');
    if(mb){
      mb.textContent=e.btn;mb.style.display='block';
      let _mbD=false;
      function _mbGo(){if(_mbD)return;_mbD=true;mb.style.display='none';_storyClose();}
      mb.onclick=_mbGo;
      mb.addEventListener('touchend',function(ev){ev.preventDefault();_mbGo();},{passive:false,once:true});
    }
    return;
  }
  // Show ending overlay?
  if(e&&e.ending){
    const ov=document.getElementById('story-ending-ov');
    if(ov){
      ov.classList.add('on');
      const et=document.getElementById('story-ending-text');
      if(et){et.textContent=e.endingText||'';}
      const cb=document.getElementById('story-ending-close');
      if(cb){cb.onclick=()=>{ov.classList.remove('on');_storyCloseBox();if(_sCb){const f=_sCb;_sCb=null;f();}};}
    }else{_storyClose();}
    return;
  }
  // Auto-close after short pause
  setTimeout(()=>_storyClose(),500);
}

function _storyCloseBox(){
  const box=document.getElementById('story-box');if(box){box.style.display='none';}
}
function _storyClose(){
  _storyCloseBox();
  const cb=_sCb;_sCb=null;
  if(cb){cb();}
}


// ═══════════════════════════════════════════════════════════════
// 어둠에 감염된 화살표 스토리 시스템 (3,6,9,12… 라운드)
// ═══════════════════════════════════════════════════════════════
const _DARK_STORY=[
  // 0 · 3라운드 — 어둠의 시작
  ["잠깐… 뭔가 이상해.",
   "저 화살표들 봐. 색이 검게 물들고 있어.",
   "이건 어둠에 감염된 화살표야.",
   "감염된 화살표끼리 서로 부딪혀야 탈출할 수 있어.",
   "혼자서는 절대 빠져나갈 수 없어. 반드시 쌍을 맞춰줘!"],
  // 1 · 6라운드 — 감염 확산
  ["감염이 더 빠르게 퍼지고 있어.",
   "이 어둠… 그냥 균열이 아니야.",
   "누군가 의도적으로 화살표들에게 어둠을 심고 있어.",
   "감염된 것들은 반드시 짝을 지어 서로 충돌시켜야 해.",
   "홀수가 되면 한 명이 영원히 갇혀버려. 꼭 짝수로 탈출시켜!"],
  // 2 · 9라운드 — 어둠의 정체
  ["어둠의 정체를 알았어.",
   "오래전 도시에서 버림받은 화살표들이야.",
   "상처받은 마음이 어둠으로 변한 거야…",
   "그래도 포기할 수 없어. 감염된 둘이 서로 충돌하면—",
   "어둠이 상쇄돼! 함께 부딪혀야 함께 자유로워져."],
  // 3 · 12라운드 — 전면 감염
  ["이제 거의 전부가 감염됐어!",
   "도시 전체가 어둠에 물들어가고 있어.",
   "하지만 봐 — 감염된 둘이 충돌하면 빛이 터져나와!",
   "어둠은 어둠끼리 만나야 사라져.",
   "포기하지 마. 모두를 짝지어줘!"],
  // 4 · 15라운드 — 희망
  ["희망이 보여!",
   "충돌할 때마다 어둠이 줄어들고 있어.",
   "감염된 화살표들도 자신이 갇혀있다는 걸 알아.",
   "그래서 서로를 기다리는 거야 — 짝을 기다리는 거야.",
   "탈출시켜줘서 고마워. 계속 가자!"],
  // 5 · 18라운드 — 어둠의 근원
  ["어둠의 근원을 찾았어.",
   "도시 가장 깊은 곳, 버려진 화살표 하나가 있어.",
   "그가 모든 어둠을 퍼뜨리고 있었던 거야.",
   "하지만… 그도 어둠의 피해자야.",
   "우리가 감염된 화살표들을 구하면 그도 변할 거야."],
  // 6 · 21라운드 — 전환점
  ["뭔가 달라지고 있어!",
   "어둠 속에서 빛이 새어나오기 시작했어.",
   "감염된 화살표들이 충돌할 때마다 도시가 조금씩 밝아져.",
   "아직 멀었어. 하지만 분명히 달라지고 있어.",
   "포기하지 마. 네가 바꾸고 있는 거야!"],
  // 7 · 24라운드 — 어둠과 대화
  ["어둠의 근원과 대화했어.",
   "'왜 이 도시를 봉인했어?' 라고 물었어.",
   "'외로웠어. 아무도 나를 보지 않았어.'",
   "감염된 화살표들이 탈출할 때마다 그도 느끼는 거야.",
   "'혼자가 아니라는 걸.'"],
  // 8 · 27라운드 — 마지막 감염
  ["이제 마지막 감염된 그룹이야.",
   "이 어둠… 곧 끝낼 수 있어.",
   "감염된 것들을 모두 짝지어 충돌시켜.",
   "둘이 만나면 어둠이 빛으로 바뀌는 거 봤지?",
   "마지막까지 집중해. 거의 다 왔어!"],
  // 9 · 30라운드 — 완전 해방
  ["믿을 수가 없어… 거의 다 해방됐어!",
   "어둠이 빛으로 바뀌고, 도시가 다시 빛나고 있어.",
   "감염됐던 화살표들이 나한테 말했어:",
   "'짝을 찾아줘서 고마워. 혼자는 탈출 못했을 거야.'",
   "우리가 해냈어. 아직 끝나지 않았지만 — 함께라면 할 수 있어!"],
];

function showDarkArrowStory(idx,callback){
  const box=document.getElementById('story-box');
  if(!box){if(callback)callback();return;}
  const entry=_DARK_STORY[idx%_DARK_STORY.length];
  if(!entry||!entry.length){if(callback)callback();return;}
  _sCb=callback;_sLineIdx=0;_sChoiceShown=false;
  _sLines=entry;
  _sCurStage=-99; // sentinel: dark story mode
  const av=document.getElementById('story-avatar');if(av)av.textContent='🏹';
  const nm=document.getElementById('story-name');if(nm)nm.textContent='에로';
  const cont=document.getElementById('story-choices');
  if(cont){cont.style.display='none';cont.innerHTML='';}
  const mb=document.getElementById('story-main-btn');
  if(mb){mb.style.display='none';mb.onclick=null;}
  const tap=document.getElementById('story-tap');if(tap)tap.classList.remove('ready');
  const txtEl=document.getElementById('story-text');if(txtEl)txtEl.textContent='';
  box.style.display='block';
  _storyShowLine(0);
}

function showStoryDialogue(stageIdx,callback){
  const box=document.getElementById('story-box');
  if(!box){if(callback){callback();}return;}
  const entry=_STORY[stageIdx];
  if(!entry){if(callback){callback();}return;}
  _sCurStage=stageIdx;_sCb=callback;_sLineIdx=0;_sChoiceShown=false;
  _sLines=typeof entry.lines==='function'?entry.lines(_SC):entry.lines;
  if(!_sLines||!_sLines.length){if(callback){callback();}return;}
  // 아바타·화자
  const av=document.getElementById('story-avatar');if(av)av.textContent='🏹';
  const nm=document.getElementById('story-name');if(nm)nm.textContent='에로';
  // 선택지·버튼 초기화
  const cont=document.getElementById('story-choices');
  if(cont){cont.style.display='none';cont.innerHTML='';}
  const mb=document.getElementById('story-main-btn');
  if(mb){mb.style.display='none';mb.onclick=null;}
  // tap 초기화
  const tap=document.getElementById('story-tap');
  if(tap)tap.classList.remove('ready');
  // 텍스트 초기화
  const txtEl=document.getElementById('story-text');if(txtEl)txtEl.textContent='';
  // 박스 표시
  box.style.display='block';
  _storyShowLine(0);
}

// Wire up tap — pointerdown works on iOS + Android + desktop
(function(){
  function _attachStory(){
    const bubble=document.getElementById('story-bubble');
    if(bubble){
      bubble.addEventListener('pointerdown',function(e){
        const ch=document.getElementById('story-choices');
        if(ch&&ch.style.display==='flex')return;
        e.preventDefault();_storyTap();
      });
    }
    // ── 건너뛰기 버튼: 스토리 즉시 종료 ──
    const skipBtn=document.getElementById('story-skip');
    if(skipBtn){
      function _doSkip(ev){ev.preventDefault();ev.stopPropagation();clearInterval(_sTypTimer);_sTyping=false;_storyClose();}
      skipBtn.addEventListener('click',_doSkip);
      skipBtn.addEventListener('touchend',_doSkip,{passive:false});
    }
  }
  if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',_attachStory);}
  else{_attachStory();}
})();



// ═══════════════════════════════════════════════════════════════
// PLAZA — Arrow City 광장 픽셀 월드
// ═══════════════════════════════════════════════════════════════
(function(){
'use strict';

// ── constants ──
const TILE=48,MW=38,MH=28,SPD=170,POS_IV=150;
// tile walkability: 0=grass 1=path 2=wall 3=fountain 4=tree 5=flowers 6=building-floor
const WALK=new Set([0,1,5,6,8]);

// ── build map (확장판 38×28) ──
function buildMap(){
  const m=Array.from({length:MH},()=>new Uint8Array(MW));
  // border trees
  for(let c=0;c<MW;c++){m[0][c]=4;m[MH-1][c]=4;}
  for(let r=0;r<MH;r++){m[r][0]=4;m[r][MW-1]=4;}
  // ── main cross paths ──
  for(let c=0;c<MW;c++){m[13][c]=1;m[14][c]=1;} // H-path
  for(let r=0;r<MH;r++){m[r][18]=1;m[r][19]=1;} // V-path
  // ── secondary paths ──
  for(let c=1;c<MW-1;c++){m[7][c]=1;m[20][c]=1;} // top/bottom avenue
  for(let r=7;r<=20;r++){m[r][9]=1;m[r][28]=1;}  // side lanes
  // ── fountain plaza (rows 11-16, cols 16-21) ──
  for(let r=11;r<=16;r++) for(let c=16;c<=21;c++) m[r][c]=3;
  // restore cross paths through fountain
  for(let c=0;c<MW;c++){m[13][c]=1;m[14][c]=1;}
  for(let r=0;r<MH;r++){m[r][18]=1;m[r][19]=1;}
  // ── buildings ──
  // shop (top-left): rows 1-6, cols 1-8
  for(let r=1;r<=6;r++) for(let c=1;c<=8;c++) m[r][c]=2;
  m[7][3]=6;m[7][4]=6;m[7][5]=6;
  // quest (top-right): rows 1-6, cols 29-36
  for(let r=1;r<=6;r++) for(let c=29;c<=36;c++) m[r][c]=2;
  m[7][30]=6;m[7][31]=6;m[7][32]=6;
  // tavern (top-center): rows 1-6, cols 13-24
  for(let r=1;r<=6;r++) for(let c=13;c<=24;c++) m[r][c]=2;
  for(let c=16;c<=21;c++) m[7][c]=6; // wide entrance
  // info (bottom-left): rows 21-27, cols 1-8
  for(let r=21;r<=27;r++) for(let c=1;c<=8;c++) m[r][c]=2;
  m[20][3]=6;m[20][4]=6;m[20][5]=6;
  // event (bottom-right): rows 21-27, cols 29-36
  for(let r=21;r<=27;r++) for(let c=29;c<=36;c++) m[r][c]=2;
  m[20][30]=6;m[20][31]=6;m[20][32]=6;
  // training (bottom-center): rows 21-27, cols 13-24
  for(let r=21;r<=27;r++) for(let c=13;c<=24;c++) m[r][c]=2;
  for(let c=16;c<=21;c++) m[20][c]=6; // wide entrance
  // ── benches near fountain (type 8) ──
  [[10,14],[10,23],[17,14],[17,23],[10,15],[17,15]].forEach(([r,c])=>{if(m[r][c]===0)m[r][c]=8;});
  // ── lamp posts (type 7) along avenues ──
  [3,6,11,14,21,23,26,31,34].forEach(c=>{
    if(m[6][c]===0||m[6][c]===5)m[6][c]=7;
    if(m[21][c]===0||m[21][c]===5)m[21][c]=7;
  });
  [3,6,10,17,24].forEach(r=>{
    if(m[r][17]===0||m[r][17]===5)m[r][17]=7;
    if(m[r][20]===0||m[r][20]===5)m[r][20]=7;
  });
  // ── scattered trees ──
  [[2,10],[2,27],[3,11],[3,26],[4,10],[4,27],[5,11],[5,26],
   [8,1],[8,36],[11,1],[11,36],[16,1],[16,36],[19,1],[19,36],
   [22,10],[22,27],[23,11],[23,26],[25,10],[25,27],
   [8,10],[8,27],[19,10],[19,27]].forEach(([r,c])=>{if(m[r][c]===0)m[r][c]=4;});
  // ── scattered flowers ──
  [[2,11],[2,26],[3,12],[3,25],[5,12],[5,25],
   [8,11],[8,26],[10,10],[10,27],[17,10],[17,27],
   [19,11],[19,26],[22,11],[22,26],[24,12],[24,25],
   [9,14],[9,23],[18,14],[18,23]].forEach(([r,c])=>{if(m[r][c]===0)m[r][c]=5;});
  return m;
}

// ── NPCs (확장판) ──
const NPCS=[
  {id:'shop', name:'🛒 상점지기', col:10, row:8, color:'#f4a460',
   lines:["어서오세요! 상점에서 스킨과 맵을 구매할 수 있어요.","코인을 모아서 다양한 아이템을 구매해 보세요!","마음에 드는 스킨이 있으시면 알려주세요 😊"],
   action:'shop'},
  {id:'ero', name:'⬆️ 에로', col:16, row:11, color:'#4fc3f7',
   lines:["안녕! 나 에로야.","우리가 함께 이 도시를 구했잖아!","1챕터는 끝났지만… 아직 진짜 사건의 범인을 못 찾았어.","언제 같이 나설 준비가 됐어?"],
   action:'story'},
  {id:'dark', name:'🌑 다크 아우라', col:22, row:16, color:'#7e57c2',
   lines:["...","이제 같은 편이야. 믿어도 돼.","범인의 흔적이 도시 외곽에 있대. 조심해.","2챕터가 시작되면… 함께 가자."],
   action:null},
  {id:'quest', name:'📋 퀘스트 마스터', col:28, row:8, color:'#ffa726',
   lines:["퀘스트를 확인해 보세요!","도전과제를 완료하면 특별한 보상이 있어요.","오늘의 미션도 놓치지 마세요!"],
   action:'quest'},
  {id:'info', name:'ℹ️ 안내원', col:5, row:19, color:'#66bb6a',
   lines:["에로우 시티 광장에 오신 걸 환영합니다!","WASD(PC) 또는 조이스틱(모바일)으로 이동하세요.","F키 또는 상호작용 버튼으로 NPC와 대화하세요.","미니맵을 보면서 광장 곳곳을 탐험해보세요!"],
   action:null},
  {id:'event', name:'🎉 이벤트 NPC', col:32, row:19, color:'#ef5350',
   lines:["특별 이벤트가 진행 중이에요!","스테이지를 더 클리어하면 2챕터가 열릴 예정이에요.","계속 도전하세요!"],
   action:null},
  {id:'tavern', name:'🍺 주점 주인', col:18, row:8, color:'#c0873e',
   lines:["어서오세요, 여행자!","이곳은 에로우 시티의 주점이에요.","한잔하면서 쉬어가세요~","피곤할 때 광장에서 충전하고 다시 도전!"],
   action:null},
  {id:'trainer', name:'⚔️ 훈련 교관', col:19, row:20, color:'#e57373',
   lines:["나는 훈련장의 교관이다!","매일 도전 과제를 완료해서 실력을 키워라.","포기하지 않는 자만이 진정한 강자가 된다.","오늘의 미션을 확인해라!"],
   action:null},
  {id:'merchant', name:'🎭 떠돌이 상인', col:10, row:14, color:'#ba68c8',
   lines:["찾고 있는 것을 발견하셨나요?","희귀한 물건들을 가지고 있답니다...","나중에 업데이트될 아이템들이 있어요!","기대해 주세요 😉"],
   action:null},
];

// ── plaza state ──
let plzActive=false,plzMap=null;
let plzCvs=null,plzCtx=null,plzMM=null,plzMMCtx=null;
let plzW=0,plzH=0;
let plzPx=0,plzPy=0,plzDir=2; // player pixel position + direction (0=up,1=right,2=down,3=left)
let plzVx=0,plzVy=0;           // velocity
let plzCamX=0,plzCamY=0;       // camera offset
let plzLast=0;
let plzKeys={};
let plzJoyX=0,plzJoyY=0;       // joystick input -1..1
let plzJoyActive=false;
let plzTouchId=null;
let plzJoyBx=0,plzJoyBy=0;     // joystick base center
let plzOtherPlayers=new Map();  // nick → {px,py,dir,skin,bubble,bubbleT}
let plzChatBubbles=[];          // [{nick,text,t}]
let plzPosBroadcastT=0;
let plzNearNpc=null;
let plzAnimT=0;
let plzWalkT=0;
let plzIsMobile=false;

// NPC dialogue state
let plzDlgOpen=false;
let plzDlgNpc=null;
let plzDlgIdx=0;

// ── building interior state ────────────────────────
let plzInside=null; // null or {bid, map, npcs, px, py, camX, camY, entranceRow, exitDir}
let plzInsideCooldown=0; // prevent instant re-exit

// ── building definitions ───────────────────────────
const BLDG_IW=14,BLDG_IH=11; // interior tile dimensions
const BWALK=new Set([0,2,5,6,7,8]); // walkable interior tiles

function _bldgMakeMap(type){
  const m=Array.from({length:BLDG_IH},()=>new Uint8Array(BLDG_IW));
  // walls all around
  for(let r=0;r<BLDG_IH;r++) for(let c=0;c<BLDG_IW;c++) m[r][c]=1;
  // floor
  for(let r=1;r<BLDG_IH-1;r++) for(let c=1;c<BLDG_IW-1;c++) m[r][c]=0;
  if(type==='shop'){
    // exit at bottom center
    m[BLDG_IH-1][6]=2;m[BLDG_IH-1][7]=2;
    // counter row
    for(let c=2;c<=11;c++) m[2][c]=3;
    // shelves
    for(let c=2;c<=5;c++) m[1][c]=4;
    for(let c=8;c<=11;c++) m[1][c]=4;
    // item stands
    m[5][3]=5;m[5][10]=5;
    m[7][4]=5;m[7][9]=5;
  } else if(type==='tavern'){
    m[BLDG_IH-1][6]=2;m[BLDG_IH-1][7]=2;
    // bar counter at top
    for(let c=2;c<=11;c++) m[2][c]=3;
    m[1][2]=4;m[1][3]=4;m[1][10]=4;m[1][11]=4;
    // tables
    [[5,3],[5,7],[5,11],[8,3],[8,7],[8,11]].forEach(([r,c])=>{if(r<BLDG_IH-1&&c<BLDG_IW-1){m[r][c]=6;}});
    // chairs around tables
    [[4,3],[6,3],[4,7],[6,7],[4,11],[6,11],[7,3],[9,3],[7,7],[9,7],[7,11],[9,11]].forEach(([r,c])=>{if(r>0&&r<BLDG_IH-1&&c>0&&c<BLDG_IW-1)m[r][c]=7;});
  } else if(type==='quest'){
    m[BLDG_IH-1][6]=2;m[BLDG_IH-1][7]=2;
    // bulletin boards
    for(let c=2;c<=5;c++) m[1][c]=8;
    for(let c=8;c<=11;c++) m[1][c]=8;
    // desk
    for(let c=5;c<=8;c++) m[3][c]=3;
    // chairs
    m[5][6]=7;m[5][7]=7;
    // waiting benches
    for(let c=2;c<=4;c++) m[8][c]=7;
    for(let c=9;c<=11;c++) m[8][c]=7;
  } else if(type==='info'){
    m[0][6]=2;m[0][7]=2; // exit at top
    // reception desk
    for(let c=4;c<=9;c++) m[3][c]=3;
    // info boards on walls
    for(let c=2;c<=4;c++) m[BLDG_IH-2][c]=8;
    for(let c=9;c<=11;c++) m[BLDG_IH-2][c]=8;
    // plant decorations
    m[2][2]=5;m[2][11]=5;m[7][2]=5;m[7][11]=5;
  } else if(type==='event'){
    m[0][6]=2;m[0][7]=2;
    // stage at top
    for(let r=1;r<=3;r++) for(let c=3;c<=10;c++) m[r][c]=9;
    // audience area
    for(let r=5;r<=8;r++) for(let c=2;c<=5;c++) m[r][c]=7;
    for(let r=5;r<=8;r++) for(let c=8;c<=11;c++) m[r][c]=7;
    // spotlight
    m[4][6]=5;m[4][7]=5;
  } else if(type==='training'){
    m[0][6]=2;m[0][7]=2;
    // training dummies
    [[2,2],[2,5],[2,8],[2,11]].forEach(([r,c])=>m[r][c]=10);
    // weights/equipment
    [[5,2],[5,5],[5,8],[5,11]].forEach(([r,c])=>m[r][c]=5);
    // sparring area
    for(let r=7;r<=9;r++) for(let c=4;c<=9;c++) m[r][c]=6;
  }
  return m;
}

const BLDG_DEFS=[
  {bid:'shop', name:'🛒 상점', mapType:'shop',
   // top buildings: entrance tiles row=7 (bottom side)
   checkEnter:(row,col)=>row===7&&col>=3&&col<=5,
   enterAtTop:false, // player comes from bottom → spawns near bottom of interior
   npcId:'shop', npcRow:3, npcCol:7, exitHint:'🛒 상점에 입장!'},
  {bid:'tavern', name:'🍺 주점', mapType:'tavern',
   checkEnter:(row,col)=>row===7&&col>=16&&col<=21,
   enterAtTop:false,
   npcId:'tavern', npcRow:3, npcCol:7, exitHint:'🍺 주점에 입장!'},
  {bid:'quest', name:'📋 퀘스트 센터', mapType:'quest',
   checkEnter:(row,col)=>row===7&&col>=30&&col<=32,
   enterAtTop:false,
   npcId:'quest', npcRow:4, npcCol:7, exitHint:'📋 퀘스트 센터에 입장!'},
  {bid:'info', name:'ℹ️ 안내소', mapType:'info',
   // bottom buildings: entrance tiles row=20 (top side)
   checkEnter:(row,col)=>row===20&&col>=3&&col<=5,
   enterAtTop:true, // player comes from top → spawns near top of interior
   npcId:'info', npcRow:4, npcCol:7, exitHint:'ℹ️ 안내소에 입장!'},
  {bid:'event', name:'🎉 이벤트 센터', mapType:'event',
   checkEnter:(row,col)=>row===20&&col>=30&&col<=32,
   enterAtTop:true,
   npcId:'event', npcRow:5, npcCol:7, exitHint:'🎉 이벤트 센터에 입장!'},
  {bid:'training', name:'⚔️ 훈련장', mapType:'training',
   checkEnter:(row,col)=>row===20&&col>=16&&col<=21,
   enterAtTop:true,
   npcId:'trainer', npcRow:5, npcCol:7, exitHint:'⚔️ 훈련장에 입장!'},
];

function _plzFindBuilding(row,col){
  for(const b of BLDG_DEFS) if(b.checkEnter(row,col)) return b;
  return null;
}

function _plzEnterBuilding(bdef){
  const m=_bldgMakeMap(bdef.mapType);
  const spawnRow=bdef.enterAtTop?2:BLDG_IH-3;
  const spawnCol=Math.floor(BLDG_IW/2);
  const npc=NPCS.find(n=>n.id===bdef.npcId)||null;
  plzInside={
    bid:bdef.bid, name:bdef.name, map:m,
    npc:npc, npcRow:bdef.npcRow, npcCol:bdef.npcCol,
    px:(spawnCol+0.5)*TILE, py:(spawnRow+0.5)*TILE,
    camX:0, camY:0,
    enterAtTop:bdef.enterAtTop,
    dir:bdef.enterAtTop?2:0,
    keys:{},joyX:0,joyY:0,
    nearNpc:false,
    dlgOpen:false,dlgIdx:0,
  };
  plzInsideCooldown=800; // ms
  if(typeof popup==='function') popup(bdef.exitHint,innerWidth/2,innerHeight*.3,'#4fc3f7');
}

function _plzExitBuilding(){
  plzInside=null;
  plzInsideCooldown=600;
}

// Social WS ref (the existing one)
function _plzSocWs(){return typeof _socWs!=='undefined'?_socWs:null;}
function _plzMyNick(){return typeof _socialNick!=='undefined'?_socialNick:(typeof activeSkin!=='undefined'?'플레이어':'???');}

// ── plaza colors (tile) ──────────────────────────────
const TCOL={
  0:'#4a8a5a', // grass
  1:'#c4b488', // path (brighter stone)
  2:'#7a5a4a', // building wall
  3:'#2ab8d8', // fountain
  4:'#2d6b3a', // tree
  5:'#4a8a5a', // flowers (special draw)
  6:'#d4c4a0', // building floor
  7:'#4a8a5a', // lamp post base (grass)
  8:'#4a8a5a', // bench (grass base)
};
const TACCENT={
  0:'#3d7a4a',
  1:'#b0a078',
  2:'#8a6a56',
  3:'#1898c8',
  4:'#1d5b2a',
  5:'#3d7a4a',
  6:'#c4b490',
  7:'#3d7a4a',
  8:'#3d7a4a',
};

// ── init plaza ────────────────────────────────────────
function plzInit(){
  plzMap=buildMap();
  plzCvs=document.getElementById('plaza-canvas');
  plzCtx=plzCvs.getContext('2d');
  plzMM=document.getElementById('plz-minimap');
  plzMMCtx=plzMM.getContext('2d');
  const messageList=document.getElementById('plaza-msgs');
  if(messageList)messageList.replaceChildren();
  plzIsMobile='ontouchstart' in window;
  // spawn player at map center
  plzPx=(18.5)*TILE; plzPy=(13.5)*TILE;
  _plzResize();
  window.addEventListener('resize',_plzResize);
  // keyboard
  window.addEventListener('keydown',_plzKeyDown);
  window.addEventListener('keyup',_plzKeyUp);
  // joystick setup
  _plzSetupJoystick();
  // button wiring
  document.getElementById('plaza-exit').onclick=closePlaza;
  document.getElementById('plz-npc-close').onclick=_plzCloseDlg;
  document.getElementById('plaza-ibtn').addEventListener('click',_plzInteract);
  document.getElementById('plz-btn-shop').onclick=()=>{closePlaza();setTimeout(()=>{phase='shop';showUI('shop');renderShopGrid();},200);};
  document.getElementById('plz-btn-quest').onclick=()=>{closePlaza();setTimeout(()=>{showUI('menu');if(typeof _openPanel==='function'&&typeof renderAchievements==='function'){_openPanel('modes-ov');renderAchievements();_openPanel('achieve-ov');}},200);};;
  document.getElementById('plaza-send').onclick=_plzSendChat;
  document.getElementById('plaza-input').addEventListener('keydown',e=>{if(e.key==='Enter'){e.stopPropagation();_plzSendChat();}});
  document.getElementById('plaza-input').addEventListener('keydown',e=>e.stopPropagation());
  // show/hide controls based on device
  if(plzIsMobile){
    document.getElementById('plaza-joystick').style.display='block';
    document.getElementById('plaza-ibtn').style.display='flex';
    document.getElementById('plz-kbhint').style.display='none';
  }
  // WS: join the communication lounge
  const ws=_plzSocWs();
  if(ws&&ws.readyState===WebSocket.OPEN){
    ws.send(JSON.stringify({type:'plaza_join'}));
  }
  // BGM
  const bgm=document.getElementById('plaza-bgm');
  if(bgm){bgm.volume=0.45;bgm.play().catch(err=>console.warn('BGM 재생 실패:', err));}
  // system message
  _plzChatMsg(null,'소통 라운지에 입장했습니다. 최근 대화가 표시됩니다.','sys');
  // start loop
  plzActive=true;
  plzLast=performance.now();
  requestAnimationFrame(_plzLoop);
}

function _plzResize(){
  plzW=plzCvs.offsetWidth;plzH=plzCvs.offsetHeight;
  plzCvs.width=plzW;plzCvs.height=plzH;
  // joystick base position
  const jb=document.getElementById('plz-jbase');
  if(jb){
    const r=jb.getBoundingClientRect();
    plzJoyBx=r.left+r.width/2;plzJoyBy=r.top+r.height/2;
  }
}

// ── main loop ─────────────────────────────────────────
function _plzLoop(ts){
  if(!plzActive)return;
  const dt=Math.min((ts-plzLast)/1000,0.05);plzLast=ts;
  plzAnimT+=dt;plzWalkT+=dt;
  plzInsideCooldown=Math.max(0,plzInsideCooldown-dt*1000);
  if(plzInside){
    _plzInsideMove(dt,ts);
    _plzDrawInterior();
  } else {
    _plzMove(dt);
    _plzCamera();
    _plzDraw();
    _plzDrawMinimap();
  }
  // decay chat bubbles
  plzChatBubbles=plzChatBubbles.filter(b=>ts-b.t<4000);
  for(const [,op] of plzOtherPlayers){if(op.bubbleT&&ts-op.bubbleT>4000)op.bubble=null;}
  requestAnimationFrame(_plzLoop);
}

// ── movement ─────────────────────────────────────────
function _plzMove(dt){
  const inp=_plzInput();
  let nx=inp.x,ny=inp.y;
  const len=Math.sqrt(nx*nx+ny*ny);
  if(len>1){nx/=len;ny/=len;}
  if(len>0.1){
    if(Math.abs(nx)>Math.abs(ny)){plzDir=nx>0?1:3;}
    else{plzDir=ny>0?2:0;}
  }
  const dx=nx*SPD*dt,dy=ny*SPD*dt;
  // collision check (tile-based)
  const r=14; // player radius
  if(!_plzWallAt(plzPx+dx-r,plzPy)&&!_plzWallAt(plzPx+dx+r,plzPy)&&
     !_plzWallAt(plzPx+dx-r,plzPy-r)&&!_plzWallAt(plzPx+dx+r,plzPy-r))
    plzPx+=dx;
  if(!_plzWallAt(plzPx,plzPy+dy+r)&&!_plzWallAt(plzPx-r,plzPy+dy+r)&&
     !_plzWallAt(plzPx+r,plzPy+dy+r))
    plzPy+=dy;
  // clamp
  plzPx=Math.max(TILE,Math.min((MW-1)*TILE,plzPx));
  plzPy=Math.max(TILE,Math.min((MH-1)*TILE,plzPy));
  // ── building entry check ──
  if(plzInsideCooldown<=0){
    const pr=Math.floor(plzPy/TILE),pc=Math.floor(plzPx/TILE);
    if(pr>=0&&pr<MH&&pc>=0&&pc<MW&&plzMap[pr][pc]===6){
      const bdef=_plzFindBuilding(pr,pc);
      if(bdef) _plzEnterBuilding(bdef);
    }
  }
}

// ── interior movement ──────────────────────────────
function _plzInsideMove(dt,ts){
  if(!plzInside)return;
  plzInsideCooldown=Math.max(0,plzInsideCooldown-dt*1000);
  const inn=plzInside;
  const inp=_plzInput();
  let nx=inp.x,ny=inp.y;
  const len=Math.sqrt(nx*nx+ny*ny);
  if(len>1){nx/=len;ny/=len;}
  if(len>0.1){
    if(Math.abs(nx)>Math.abs(ny)){inn.dir=nx>0?1:3;}
    else{inn.dir=ny>0?2:0;}
  }
  const dx=nx*SPD*dt,dy=ny*SPD*dt;
  const r2=12;
  const _iWall=(px,py)=>{
    const tc=Math.floor(px/TILE),tr=Math.floor(py/TILE);
    if(tc<0||tc>=BLDG_IW||tr<0||tr>=BLDG_IH)return true;
    return !BWALK.has(inn.map[tr][tc]);
  };
  if(!_iWall(inn.px+dx-r2,inn.py)&&!_iWall(inn.px+dx+r2,inn.py)) inn.px+=dx;
  if(!_iWall(inn.px,inn.py+dy+r2)&&!_iWall(inn.px-r2,inn.py+dy+r2)&&!_iWall(inn.px+r2,inn.py+dy+r2)) inn.py+=dy;
  inn.px=Math.max(r2,Math.min((BLDG_IW-1)*TILE-r2,inn.px));
  inn.py=Math.max(r2,Math.min((BLDG_IH-1)*TILE-r2,inn.py));
  // exit check
  if(plzInsideCooldown<=0){
    const pr=Math.floor(inn.py/TILE),pc=Math.floor(inn.px/TILE);
    if(pr>=0&&pr<BLDG_IH&&pc>=0&&pc<BLDG_IW&&inn.map[pr][pc]===2){
      _plzExitBuilding();return;
    }
  }
  // NPC proximity check
  const npcR=inn.npcRow,npcC=inn.npcCol;
  const dist=Math.hypot(inn.px/TILE-npcC,inn.py/TILE-npcR);
  inn.nearNpc=dist<2.5;
  const hint=document.getElementById('plz-inthint');
  if(hint){
    if(inn.nearNpc&&!inn.dlgOpen){hint.textContent=plzIsMobile?'상호작용':'F — '+inn.name+' NPC';hint.classList.add('show');}
    else if(inn.py<TILE*1.5&&plzInsideCooldown<=0){hint.textContent=plzIsMobile?'출구':'출구 (걸어서 나가기)';hint.classList.add('show');}
    else{hint.classList.remove('show');}
  }
}

function _plzWallAt(px,py){
  const tc=Math.floor(px/TILE),tr=Math.floor(py/TILE);
  if(tc<0||tc>=MW||tr<0||tr>=MH)return true;
  return !WALK.has(plzMap[tr][tc]);
}

function _plzInput(){
  let x=(plzJoyX||0),y=(plzJoyY||0);
  if(plzKeys['KeyA']||plzKeys['ArrowLeft'])x-=1;
  if(plzKeys['KeyD']||plzKeys['ArrowRight'])x+=1;
  if(plzKeys['KeyW']||plzKeys['ArrowUp'])y-=1;
  if(plzKeys['KeyS']||plzKeys['ArrowDown'])y+=1;
  return{x,y};
}

// ── camera ────────────────────────────────────────────
function _plzCamera(){
  const tx=plzPx-plzW/2,ty=plzPy-plzH/2;
  plzCamX+=(tx-plzCamX)*0.15;
  plzCamY+=(ty-plzCamY)*0.15;
  plzCamX=Math.max(0,Math.min(MW*TILE-plzW,plzCamX));
  plzCamY=Math.max(0,Math.min(MH*TILE-plzH,plzCamY));
}

// ── draw ──────────────────────────────────────────────
function _plzDraw(){
  const ctx=plzCtx;
  ctx.clearRect(0,0,plzW,plzH);
  // camera offset
  const ox=-Math.round(plzCamX),oy=-Math.round(plzCamY);
  // visible tile range
  const c0=Math.max(0,Math.floor(plzCamX/TILE)-1);
  const c1=Math.min(MW,Math.ceil((plzCamX+plzW)/TILE)+1);
  const r0=Math.max(0,Math.floor(plzCamY/TILE)-1);
  const r1=Math.min(MH,Math.ceil((plzCamY+plzH)/TILE)+1);
  // draw tiles
  for(let r=r0;r<r1;r++) for(let c=c0;c<c1;c++){
    _plzDrawTile(ctx,c,r,ox,oy);
  }
  // draw NPCs (behind player)
  for(const npc of NPCS){
    const sx=npc.col*TILE+ox, sy=npc.row*TILE+oy;
    if(sx>-64&&sx<plzW+64&&sy>-64&&sy<plzH+64)
      _plzDrawNpc(ctx,npc,sx+TILE/2,sy+TILE/2);
  }
  // draw other players
  for(const [nick,op] of plzOtherPlayers){
    const sx=op.px+ox,sy=op.py+oy;
    if(sx>-64&&sx<plzW+64&&sy>-64&&sy<plzH+64)
      _plzDrawChar(ctx,sx,sy,op.dir,_plzNickColor(nick),nick,op.bubble,false,op.title||null);
  }
  // draw player (내 칭호 결정)
  const px=plzPx+ox,py=plzPy+oy;
  const moving=Math.abs(_plzInput().x)+Math.abs(_plzInput().y)>0.1;
  const myNick=_plzMyNick();
  const isSedonMe=(myNick==='Sedon');
  const myTitle=isSedonMe?'👑 관리자':((typeof _settings!=='undefined'&&_settings.activeTitle)?_settings.activeTitle:null);
  _plzDrawChar(ctx,px,py,plzDir,'#4fc3f7',myNick+(moving?'':' '),null,true,myTitle);
}

function _plzDrawTile(ctx,c,r,ox,oy){
  const x=c*TILE+ox,y=r*TILE+oy;
  const t=plzMap[r][c];
  // base
  ctx.fillStyle=TCOL[t]??'#3a6a4a';
  ctx.fillRect(x,y,TILE,TILE);
  // details
  if(t===0||t===5){
    // grass texture
    ctx.fillStyle=TACCENT[0];
    ctx.fillRect(x+4,y+8,4,2);ctx.fillRect(x+18,y+20,4,2);
    ctx.fillRect(x+32,y+10,4,2);ctx.fillRect(x+10,y+36,4,2);
    if(t===5){
      // flowers
      const fc=['#ff8080','#80ff80','#ffff80','#80ffff','#ff80ff'];
      const fc2=fc[(c+r)%fc.length];
      ctx.fillStyle=fc2;
      ctx.beginPath();ctx.arc(x+12,y+12,4,0,Math.PI*2);ctx.fill();
      ctx.beginPath();ctx.arc(x+32,y+30,4,0,Math.PI*2);ctx.fill();
    }
  }else if(t===1){
    // cobblestone path
    ctx.fillStyle=TCOL[1];ctx.fillRect(x,y,TILE,TILE);
    ctx.strokeStyle=TACCENT[1];ctx.lineWidth=0.8;
    const off=(c%2)*12;
    ctx.strokeRect(x+2,y+2,TILE/2-3,TILE/2-3);
    ctx.strokeRect(x+TILE/2+1,y+2,TILE/2-3,TILE/2-3);
    ctx.strokeRect(x+2+off%12,y+TILE/2+1,TILE/2-3,TILE/2-3);
    ctx.strokeRect(x+TILE/2+1-(off%12),y+TILE/2+1,TILE/2-3,TILE/2-3);
    ctx.fillStyle='rgba(255,255,255,0.06)';
    ctx.fillRect(x+2,y+2,TILE-4,2);
    ctx.fillRect(x+2,y+2,2,TILE-4);
  }else if(t===2){
    // building wall — draw top of building
    ctx.fillStyle='#5a3a2a';
    ctx.fillRect(x,y,TILE,TILE);
    // window
    if((c+r)%3===0){
      ctx.fillStyle='rgba(255,220,100,.4)';
      ctx.fillRect(x+8,y+8,14,12);
      ctx.fillRect(x+26,y+8,14,12);
      ctx.strokeStyle='#3a2a1a';ctx.lineWidth=1;
      ctx.strokeRect(x+8,y+8,14,12);ctx.strokeRect(x+26,y+8,14,12);
    }
    // roof edge
    ctx.fillStyle='#8b4513';
    ctx.fillRect(x,y,TILE,6);
  }else if(t===3){
    // fountain water
    const ph=plzAnimT*1.5+c*0.4+r*0.4;
    const wAlpha=0.7+0.3*Math.sin(ph);
    ctx.fillStyle='#1478a8';ctx.fillRect(x,y,TILE,TILE);
    const wg=ctx.createRadialGradient(x+TILE/2,y+TILE/2,2,x+TILE/2,y+TILE/2,TILE*0.6);
    wg.addColorStop(0,'rgba(120,220,255,'+wAlpha+')');
    wg.addColorStop(0.5,'rgba(40,160,220,0.4)');
    wg.addColorStop(1,'rgba(10,80,160,0)');
    ctx.fillStyle=wg;ctx.fillRect(x,y,TILE,TILE);
    ctx.strokeStyle='rgba(180,240,255,'+(0.35+0.25*Math.sin(ph))+')';
    ctx.lineWidth=1.5;
    ctx.beginPath();ctx.arc(x+TILE/2,y+TILE/2,14+4*Math.sin(ph),0,Math.PI*2);ctx.stroke();
    ctx.strokeStyle='rgba(180,240,255,'+(0.2+0.15*Math.sin(ph+1.5))+')';
    ctx.beginPath();ctx.arc(x+TILE/2,y+TILE/2,6+2*Math.sin(ph+1),0,Math.PI*2);ctx.stroke();
    if(r===11||r===16||c===16||c===21){
      ctx.fillStyle='rgba(180,160,130,0.6)';ctx.fillRect(x,y,TILE,4);
      ctx.fillStyle='rgba(180,160,130,0.6)';ctx.fillRect(x,y+TILE-4,TILE,4);
    }
  }else if(t===4){
    // tree
    ctx.fillStyle='#1a4a2a';ctx.fillRect(x,y,TILE,TILE);
    // trunk
    ctx.fillStyle='#6b3a1a';
    ctx.fillRect(x+18,y+26,12,20);
    // canopy
    ctx.fillStyle='#2a6a3a';
    ctx.beginPath();ctx.arc(x+TILE/2,y+18,18,0,Math.PI*2);ctx.fill();
    ctx.fillStyle='#3a8a4a';
    ctx.beginPath();ctx.arc(x+TILE/2,y+14,14,0,Math.PI*2);ctx.fill();
    ctx.fillStyle='rgba(150,255,150,0.3)';
    ctx.beginPath();ctx.arc(x+TILE/2-4,y+12,8,0,Math.PI*2);ctx.fill();
  }else if(t===6){
    // building floor entrance
    ctx.fillStyle='#d4c4a0';ctx.fillRect(x,y,TILE,TILE);
    ctx.strokeStyle='#b8a880';ctx.lineWidth=0.8;
    ctx.beginPath();
    for(let i=0;i<TILE;i+=10){ctx.moveTo(x+i,y);ctx.lineTo(x+i,y+TILE);}
    ctx.stroke();
    ctx.beginPath();
    for(let j=0;j<TILE;j+=10){ctx.moveTo(x,y+j);ctx.lineTo(x+TILE,y+j);}
    ctx.stroke();
    ctx.fillStyle='rgba(100,60,20,.5)';
    ctx.fillRect(x+8,y+TILE-14,TILE-16,10);
  }else if(t===7){
    // lamp post
    ctx.fillStyle=TCOL[0];ctx.fillRect(x,y,TILE,TILE);
    ctx.fillStyle=TACCENT[0];
    ctx.fillRect(x+4,y+8,4,2);ctx.fillRect(x+28,y+20,4,2);
    ctx.fillStyle='#9a9090';
    ctx.fillRect(x+TILE/2-2,y+10,4,TILE-16);
    ctx.fillStyle='#777070';
    ctx.fillRect(x+TILE/2-5,y+TILE-10,10,5);
    ctx.fillStyle='#666060';
    ctx.fillRect(x+TILE/2-7,y+8,14,5);
    const glowA=0.4+0.15*Math.sin(plzAnimT*2.5);
    const grd=ctx.createRadialGradient(x+TILE/2,y+12,1,x+TILE/2,y+12,14);
    grd.addColorStop(0,'rgba(255,230,120,'+glowA+')');
    grd.addColorStop(1,'rgba(255,200,80,0)');
    ctx.fillStyle=grd;ctx.beginPath();ctx.arc(x+TILE/2,y+12,14,0,Math.PI*2);ctx.fill();
  }else if(t===8){
    // bench on grass
    ctx.fillStyle=TCOL[0];ctx.fillRect(x,y,TILE,TILE);
    ctx.fillStyle=TACCENT[0];
    ctx.fillRect(x+4,y+8,4,2);ctx.fillRect(x+28,y+32,3,2);
    ctx.fillStyle='#a0622a';ctx.fillRect(x+5,y+TILE/2-3,TILE-10,7);
    ctx.fillStyle='#8B4513';ctx.fillRect(x+5,y+TILE/2-12,TILE-10,5);
    ctx.fillRect(x+6,y+TILE/2-18,4,8);
    ctx.fillRect(x+TILE-10,y+TILE/2-18,4,8);
    ctx.fillStyle='#6a3010';
    ctx.fillRect(x+6,y+TILE/2+4,4,7);
    ctx.fillRect(x+TILE-10,y+TILE/2+4,4,7);
  }
  // grid lines (subtle)
  ctx.strokeStyle='rgba(0,0,0,0.08)';ctx.lineWidth=0.5;
  ctx.strokeRect(x,y,TILE,TILE);
}

function _plzDrawChar(ctx,x,y,dir,col,name,bubble,isPlayer,titleText){
  ctx.save();
  // shadow
  ctx.fillStyle='rgba(0,0,0,0.2)';
  ctx.beginPath();ctx.ellipse(x,y+14,13,5,0,0,Math.PI*2);ctx.fill();
  // body (bouncy walk)
  const bob=isPlayer?(Math.abs(_plzInput().x)+Math.abs(_plzInput().y)>0.1?Math.sin(plzWalkT*8)*2:0):0;
  // legs
  const legA=isPlayer&&(Math.abs(_plzInput().x)+Math.abs(_plzInput().y)>0.1)?Math.sin(plzWalkT*8)*5:0;
  ctx.fillStyle=col;
  ctx.fillRect(x-5+legA,y+6,5,10);
  ctx.fillRect(x-legA,y+6,5,10);
  // body
  ctx.fillRect(x-8,y-4+bob,16,14);
  // outfit detail
  ctx.fillStyle='rgba(255,255,255,0.25)';
  ctx.fillRect(x-6,y-2+bob,12,2);
  // head
  ctx.fillStyle='#f5c8a0';
  ctx.beginPath();ctx.arc(x,y-14+bob,11,0,Math.PI*2);ctx.fill();
  // hair
  ctx.fillStyle=col;
  if(dir===0||dir===1||dir===3){ctx.fillRect(x-11,y-22+bob,22,8);}
  else{ctx.fillRect(x-11,y-18+bob,22,6);}
  // eyes (dir-aware)
  ctx.fillStyle='#2a2a4a';
  if(dir!==0){// not facing up → show eyes
    ctx.beginPath();ctx.arc(x-4,y-14+bob,2.5,0,Math.PI*2);ctx.fill();
    ctx.beginPath();ctx.arc(x+4,y-14+bob,2.5,0,Math.PI*2);ctx.fill();
    ctx.fillStyle='#fff';
    ctx.beginPath();ctx.arc(x-3,y-14+bob,1,0,Math.PI*2);ctx.fill();
    ctx.beginPath();ctx.arc(x+5,y-14+bob,1,0,Math.PI*2);ctx.fill();
  }
  // player indicator
  if(isPlayer){
    ctx.fillStyle='rgba(255,255,100,0.9)';
    ctx.beginPath();ctx.arc(x,y-30+bob,4,0,Math.PI*2);ctx.fill();
  }
  // 칭호 표시 (캐릭터 머리 위)
  if(titleText){
    const isAdmin=titleText==='👑 관리자';
    const titleY=isPlayer?y-42+bob:y-42;
    ctx.font='bold 9px sans-serif';ctx.textAlign='center';
    // 칭호 배경
    const tw=ctx.measureText(titleText).width+10;
    ctx.fillStyle=isAdmin?'rgba(255,200,0,0.9)':'rgba(80,40,200,0.85)';
    ctx.beginPath();ctx.roundRect(x-tw/2,titleY-10,tw,14,4);ctx.fill();
    ctx.fillStyle=isAdmin?'#1a0a00':'#fff';
    ctx.fillText(titleText,x,titleY);
  }
  // name
  ctx.font='bold 10px sans-serif';ctx.textAlign='center';
  ctx.fillStyle='rgba(0,0,0,0.7)';
  ctx.fillText(name,x+1,y+26+bob);
  ctx.fillStyle='#f0f0f0';
  ctx.fillText(name,x,y+25+bob);
  // chat bubble
  if(bubble){
    const pad=8,bh=22;
    ctx.font='11px sans-serif';
    const bw=ctx.measureText(bubble).width+pad*2;
    const bx=x-bw/2,by=y-52+bob;
    ctx.fillStyle='rgba(255,255,255,0.95)';
    ctx.beginPath();ctx.roundRect(bx,by,bw,bh,5);ctx.fill();
    ctx.strokeStyle='rgba(150,200,150,.5)';ctx.lineWidth=1;
    ctx.strokeRect(bx,by,bw,bh);
    // tail
    ctx.fillStyle='rgba(255,255,255,0.95)';
    ctx.beginPath();ctx.moveTo(x-4,by+bh);ctx.lineTo(x+4,by+bh);ctx.lineTo(x,by+bh+7);ctx.fill();
    ctx.fillStyle='#222';
    ctx.fillText(bubble,x,by+15);
  }
  ctx.restore();
}

function _plzDrawNpc(ctx,npc,x,y){
  ctx.save();
  const t=plzAnimT;
  // shadow
  ctx.fillStyle='rgba(0,0,0,0.22)';
  ctx.beginPath();ctx.ellipse(x,y+15,14,5,0,0,Math.PI*2);ctx.fill();

  if(npc.id==='shop'){
    // 상점지기: 주황빛 앞치마, 따뜻한 가게 주인
    const bob=Math.sin(t*1.8)*1.5;
    ctx.fillStyle='#4a2c0a'; // dark pants
    ctx.fillRect(x-5,y+6,4,11);ctx.fillRect(x+1,y+6,4,11);
    ctx.fillStyle='#f4a460'; // sandy body
    ctx.fillRect(x-8,y-4+bob,16,14);
    ctx.fillStyle='#ff8c00'; // orange apron
    ctx.fillRect(x-5,y-2+bob,10,12);
    ctx.fillRect(x-3,y-8+bob,6,8);
    ctx.fillStyle='#f5c8a0'; // head
    ctx.beginPath();ctx.arc(x,y-14+bob,11,0,Math.PI*2);ctx.fill();
    ctx.fillStyle='#8b4513'; // brown hair + hat
    ctx.fillRect(x-11,y-22+bob,22,8);
    ctx.fillStyle='#f4a460';
    ctx.fillRect(x-13,y-24+bob,26,5);
    ctx.fillRect(x-8,y-30+bob,16,8);
    // rosy cheeks
    ctx.fillStyle='rgba(255,100,80,.3)';
    ctx.beginPath();ctx.arc(x-6,y-12+bob,4,0,Math.PI*2);ctx.fill();
    ctx.beginPath();ctx.arc(x+6,y-12+bob,4,0,Math.PI*2);ctx.fill();
    // eyes (smile)
    ctx.fillStyle='#3a2000';
    ctx.beginPath();ctx.arc(x-4,y-15+bob,2,0,Math.PI*2);ctx.fill();
    ctx.beginPath();ctx.arc(x+4,y-15+bob,2,0,Math.PI*2);ctx.fill();

  } else if(npc.id==='ero'){
    // 에로: 파란 후드, 에너지틱한 주인공 동료
    const bob=Math.sin(t*2.5)*2;
    const legA=Math.sin(t*4)*3;
    ctx.fillStyle='#1a3a8a';
    ctx.fillRect(x-5+legA,y+6,5,11);ctx.fillRect(x-legA,y+6,5,11);
    ctx.fillStyle='#4fc3f7'; // blue body
    ctx.fillRect(x-9,y-4+bob,18,15);
    // hood
    ctx.fillStyle='#2980b9';
    ctx.beginPath();ctx.arc(x,y-14+bob,13,0,Math.PI*2);ctx.fill();
    ctx.fillStyle='#f5c8a0';
    ctx.beginPath();ctx.arc(x,y-14+bob,10,0,Math.PI*2);ctx.fill();
    ctx.fillStyle='#2980b9';
    ctx.beginPath();ctx.arc(x,y-20+bob,12,Math.PI,0);ctx.fill();
    ctx.fillRect(x-13,y-22+bob,4,10);ctx.fillRect(x+9,y-22+bob,4,10);
    // arrow emblem
    ctx.fillStyle='rgba(255,255,100,0.9)';
    ctx.font='bold 9px sans-serif';ctx.textAlign='center';
    ctx.fillText('▲',x,y+4+bob);
    // eyes (determined)
    ctx.fillStyle='#0d2255';
    ctx.fillRect(x-5,y-17+bob,4,3);
    ctx.fillRect(x+1,y-17+bob,4,3);
    // energy glow
    const glow=0.4+0.3*Math.sin(t*3);
    ctx.shadowColor='#4fc3f7';ctx.shadowBlur=8*glow;
    ctx.fillStyle='rgba(79,195,247,'+glow+')';
    ctx.beginPath();ctx.arc(x,y-14+bob,13,0,Math.PI*2);ctx.stroke();
    ctx.shadowBlur=0;

  } else if(npc.id==='dark'){
    // 다크 아우라: 보라/검정, 신비로운 다크 히어로
    const bob=Math.sin(t*0.8)*1;
    // dark cloak flutter
    const flut=Math.sin(t*2)*4;
    ctx.fillStyle='rgba(50,0,80,0.8)';
    ctx.beginPath();
    ctx.moveTo(x-14,y-4+bob);ctx.lineTo(x+14,y-4+bob);
    ctx.lineTo(x+12+flut,y+18+bob);ctx.lineTo(x-12-flut,y+18+bob);
    ctx.closePath();ctx.fill();
    // legs
    ctx.fillStyle='#1a0030';
    ctx.fillRect(x-5,y+6+bob,5,12);ctx.fillRect(x,y+6+bob,5,12);
    // dark aura particles
    for(let i=0;i<6;i++){
      const a=t*2+i*Math.PI/3;
      const pr=18+Math.sin(t+i)*4;
      const glow=0.3+0.2*Math.sin(t*2+i);
      ctx.fillStyle='rgba(150,50,255,'+glow+')';
      ctx.beginPath();ctx.arc(x+Math.cos(a)*pr,y-14+bob+Math.sin(a)*pr,3,0,Math.PI*2);ctx.fill();
    }
    // body
    ctx.fillStyle='#2d0050';
    ctx.fillRect(x-8,y-4+bob,16,14);
    // head
    ctx.fillStyle='#c8a0c8';
    ctx.beginPath();ctx.arc(x,y-14+bob,11,0,Math.PI*2);ctx.fill();
    // hair
    ctx.fillStyle='#1a0030';
    ctx.fillRect(x-11,y-22+bob,22,10);
    // glowing eyes
    ctx.shadowColor='#9b59b6';ctx.shadowBlur=8;
    ctx.fillStyle='#9b59b6';
    ctx.beginPath();ctx.arc(x-4,y-15+bob,3,0,Math.PI*2);ctx.fill();
    ctx.beginPath();ctx.arc(x+4,y-15+bob,3,0,Math.PI*2);ctx.fill();
    ctx.fillStyle='#fff';
    ctx.beginPath();ctx.arc(x-3,y-15+bob,1.5,0,Math.PI*2);ctx.fill();
    ctx.beginPath();ctx.arc(x+5,y-15+bob,1.5,0,Math.PI*2);ctx.fill();
    ctx.shadowBlur=0;

  } else if(npc.id==='quest'){
    // 퀘스트 마스터: 공식적인 제복, 스크롤 들고 있음
    const bob=Math.sin(t*1.5)*1;
    ctx.fillStyle='#5a3a00';
    ctx.fillRect(x-5,y+6,4,11);ctx.fillRect(x+1,y+6,4,11);
    // gold-trimmed uniform
    ctx.fillStyle='#e67e22'; // orange uniform
    ctx.fillRect(x-8,y-4+bob,16,14);
    // gold trim
    ctx.fillStyle='#f1c40f';
    ctx.fillRect(x-8,y-4+bob,2,14); ctx.fillRect(x+6,y-4+bob,2,14);
    ctx.fillRect(x-8,y-4+bob,16,2);
    // shoulder pads
    ctx.fillStyle='#f39c12';
    ctx.fillRect(x-11,y-4+bob,5,6);ctx.fillRect(x+6,y-4+bob,5,6);
    ctx.fillStyle='#f5c8a0';
    ctx.beginPath();ctx.arc(x,y-14+bob,11,0,Math.PI*2);ctx.fill();
    ctx.fillStyle='#5d3a00'; // dark brown hair
    ctx.fillRect(x-11,y-22+bob,22,10);
    // cap
    ctx.fillStyle='#e67e22';
    ctx.fillRect(x-12,y-24+bob,24,4);
    ctx.fillRect(x-8,y-30+bob,16,7);
    // monocle
    ctx.strokeStyle='#f1c40f';ctx.lineWidth=2;
    ctx.beginPath();ctx.arc(x+5,y-14+bob,4,0,Math.PI*2);ctx.stroke();
    // eyes
    ctx.fillStyle='#2c1800';
    ctx.beginPath();ctx.arc(x-4,y-15+bob,2.5,0,Math.PI*2);ctx.fill();
    ctx.beginPath();ctx.arc(x+4,y-15+bob,2.5,0,Math.PI*2);ctx.fill();
    // scroll in hand
    ctx.fillStyle='#f9e4a0';
    ctx.fillRect(x+9,y-4+bob,5,10);
    ctx.fillStyle='#c8a030';
    ctx.fillRect(x+9,y-4+bob,5,2);ctx.fillRect(x+9,y+4+bob,5,2);

  } else if(npc.id==='info'){
    // 안내원: 초록 유니폼, 친근한 미소
    const bob=Math.sin(t*2)*1.5;
    ctx.fillStyle='#1b5e20';
    ctx.fillRect(x-5,y+6,4,11);ctx.fillRect(x+1,y+6,4,11);
    ctx.fillStyle='#66bb6a'; // green uniform
    ctx.fillRect(x-8,y-4+bob,16,14);
    // white collar
    ctx.fillStyle='#fff';
    ctx.fillRect(x-4,y-4+bob,8,4);
    ctx.fillStyle='#f5c8a0';
    ctx.beginPath();ctx.arc(x,y-14+bob,11,0,Math.PI*2);ctx.fill();
    ctx.fillStyle='#33691e';
    ctx.fillRect(x-11,y-22+bob,22,10);
    // beret hat
    ctx.fillStyle='#66bb6a';
    ctx.beginPath();ctx.ellipse(x,y-22+bob,13,6,0,0,Math.PI*2);ctx.fill();
    ctx.fillStyle='#fff';
    ctx.beginPath();ctx.arc(x+7,y-23+bob,3,0,Math.PI*2);ctx.fill();
    // big smile
    ctx.strokeStyle='#7a3000';ctx.lineWidth=2;
    ctx.beginPath();ctx.arc(x,y-12+bob,5,0,Math.PI);ctx.stroke();
    // eyes
    ctx.fillStyle='#2a5000';
    ctx.beginPath();ctx.arc(x-4,y-16+bob,2.5,0,Math.PI*2);ctx.fill();
    ctx.beginPath();ctx.arc(x+4,y-16+bob,2.5,0,Math.PI*2);ctx.fill();
    // info board prop
    ctx.fillStyle='#e8f5e9';
    ctx.fillRect(x-13,y-4+bob,5,9);
    ctx.fillStyle='#66bb6a';
    ctx.fillRect(x-12,y-3+bob,3,1);ctx.fillRect(x-12,y-1+bob,3,1);ctx.fillRect(x-12,y+1+bob,3,1);

  } else if(npc.id==='event'){
    // 이벤트 NPC: 형형색색의 파티 의상
    const bob=Math.sin(t*3)*2;
    const hue=Math.floor(t*60)%360;
    ctx.fillStyle='#b71c1c';
    ctx.fillRect(x-5,y+6,4,11);ctx.fillRect(x+1,y+6,4,11);
    // colorful outfit
    ctx.fillStyle=`hsl(${hue},80%,55%)`;
    ctx.fillRect(x-8,y-4+bob,8,14);
    ctx.fillStyle=`hsl(${(hue+120)%360},80%,55%)`;
    ctx.fillRect(x,y-4+bob,8,14);
    ctx.fillStyle='#f5c8a0';
    ctx.beginPath();ctx.arc(x,y-14+bob,11,0,Math.PI*2);ctx.fill();
    // party hat
    ctx.fillStyle=`hsl(${(hue+60)%360},90%,60%)`;
    ctx.beginPath();ctx.moveTo(x,y-32+bob);ctx.lineTo(x-9,y-22+bob);ctx.lineTo(x+9,y-22+bob);ctx.closePath();ctx.fill();
    ctx.fillStyle='#fff';
    ctx.beginPath();ctx.arc(x,y-32+bob,3,0,Math.PI*2);ctx.fill();
    // confetti particles
    for(let i=0;i<5;i++){
      const a=t*3+i*1.2;const r=20+i*3;
      ctx.fillStyle=`hsl(${(hue+i*72)%360},90%,60%)`;
      ctx.fillRect(x+Math.cos(a)*r-1,y-14+bob+Math.sin(a)*r-1,4,4);
    }
    // eyes (sparkling)
    ctx.fillStyle='#b71c1c';
    ctx.beginPath();ctx.arc(x-4,y-15+bob,2.5,0,Math.PI*2);ctx.fill();
    ctx.beginPath();ctx.arc(x+4,y-15+bob,2.5,0,Math.PI*2);ctx.fill();
    // mouth open in joy
    ctx.fillStyle='#7a1a00';
    ctx.beginPath();ctx.arc(x,y-11+bob,3.5,0,Math.PI);ctx.fill();

  } else if(npc.id==='tavern'){
    // 주점 주인: 갈색 가죽 앞치마, 건장한 바텐더
    const bob=Math.sin(t*1.2)*1;
    ctx.fillStyle='#3e1a00';
    ctx.fillRect(x-6,y+6,5,12);ctx.fillRect(x+1,y+6,5,12);
    // barrel-chested body
    ctx.fillStyle='#795548';
    ctx.fillRect(x-10,y-5+bob,20,15);
    // leather apron
    ctx.fillStyle='#5d3a0a';
    ctx.fillRect(x-7,y-4+bob,14,14);
    // belt
    ctx.fillStyle='#2c1a00';
    ctx.fillRect(x-7,y+5+bob,14,3);
    ctx.fillStyle='#f1c40f';
    ctx.fillRect(x-2,y+5+bob,4,3);
    ctx.fillStyle='#c8a060';
    ctx.beginPath();ctx.arc(x,y-14+bob,12,0,Math.PI*2);ctx.fill();
    ctx.fillStyle='#4a2400'; // dark hair
    ctx.fillRect(x-12,y-22+bob,24,10);
    // bushy beard
    ctx.fillStyle='#5a3000';
    ctx.beginPath();ctx.arc(x,y-8+bob,9,0,Math.PI);ctx.fill();
    // eyes
    ctx.fillStyle='#1a0a00';
    ctx.beginPath();ctx.arc(x-5,y-16+bob,2.5,0,Math.PI*2);ctx.fill();
    ctx.beginPath();ctx.arc(x+5,y-16+bob,2.5,0,Math.PI*2);ctx.fill();
    // beer mug
    ctx.fillStyle='#f9a825';
    ctx.fillRect(x+9,y-6+bob,7,10);
    ctx.fillStyle='#fff8e1';
    ctx.fillRect(x+10,y-5+bob,5,4); // foam
    ctx.strokeStyle='#f9a825';ctx.lineWidth=2;
    ctx.beginPath();ctx.arc(x+18,y+bob,5,Math.PI*0.3,Math.PI*1.7);ctx.stroke();

  } else if(npc.id==='trainer'){
    // 훈련 교관: 군복, 강인한 체형
    const bob=0;
    const march=Math.sin(t*2.5)*3;
    ctx.fillStyle='#1a2a00';
    ctx.fillRect(x-5+march,y+6,5,12);ctx.fillRect(x-march,y+6,5,12);
    // muscular body
    ctx.fillStyle='#4caf50'; // military green
    ctx.fillRect(x-10,y-5+bob,20,14);
    // armor/vest
    ctx.fillStyle='#2e7d32';
    ctx.fillRect(x-8,y-4+bob,6,10);ctx.fillRect(x+2,y-4+bob,6,10);
    // shoulder badges
    ctx.fillStyle='#f1c40f';
    ctx.beginPath();ctx.arc(x-9,y-3,4,0,Math.PI*2);ctx.fill();
    ctx.beginPath();ctx.arc(x+9,y-3,4,0,Math.PI*2);ctx.fill();
    ctx.fillStyle='#ffd700';
    ctx.font='bold 5px sans-serif';ctx.textAlign='center';
    ctx.fillText('★',x-9,y-1);ctx.fillText('★',x+9,y-1);
    ctx.fillStyle='#c8a080';
    ctx.beginPath();ctx.arc(x,y-14+bob,11,0,Math.PI*2);ctx.fill();
    ctx.fillStyle='#2e3a00'; // dark military hair
    ctx.fillRect(x-11,y-22+bob,22,8);
    // army cap
    ctx.fillStyle='#4caf50';
    ctx.fillRect(x-12,y-24+bob,24,4);
    ctx.fillRect(x-8,y-30+bob,16,7);
    ctx.fillStyle='#f1c40f';ctx.fillRect(x-3,y-26+bob,6,3);
    // stern eyes
    ctx.fillStyle='#1a2000';
    ctx.fillRect(x-6,y-17+bob,4,2);
    ctx.fillRect(x+2,y-17+bob,4,2);
    // sword on back
    ctx.strokeStyle='#aaa';ctx.lineWidth=2;
    ctx.beginPath();ctx.moveTo(x+10,y-20+bob);ctx.lineTo(x+14,y+8+bob);ctx.stroke();
    ctx.fillStyle='#8B4513';ctx.fillRect(x+8,y-8+bob,6,4);

  } else if(npc.id==='merchant'){
    // 떠돌이 상인: 미스터리한 망토, 여러 주머니
    const bob=Math.sin(t*1.5)*1.5;
    const flut=Math.sin(t*2)*5;
    // cloak
    ctx.fillStyle='#4a148c'; // deep purple
    ctx.beginPath();
    ctx.moveTo(x-12,y-4+bob);ctx.lineTo(x+12,y-4+bob);
    ctx.lineTo(x+14+flut,y+18+bob);ctx.lineTo(x-14-flut,y+18+bob);
    ctx.closePath();ctx.fill();
    ctx.fillStyle='#7b1fa2';
    ctx.fillRect(x-10,y-4+bob,4,14);
    // many pouches on belt
    ctx.fillStyle='#2c1a00';ctx.fillRect(x-10,y+4+bob,20,3);
    ['#f39c12','#e74c3c','#3498db'].forEach((c,i)=>{
      ctx.fillStyle=c;
      ctx.fillRect(x-7+i*6,y+7+bob,5,5);
    });
    // face (half-hidden)
    ctx.fillStyle='#f5c8a0';
    ctx.beginPath();ctx.arc(x,y-14+bob,11,0,Math.PI*2);ctx.fill();
    ctx.fillStyle='#4a148c';
    ctx.fillRect(x-12,y-20+bob,24,8); // hood shadow
    // mysterious grin
    ctx.strokeStyle='#7a3000';ctx.lineWidth=2;
    ctx.beginPath();ctx.arc(x,y-10+bob,5,0.2,Math.PI-0.2);ctx.stroke();
    // glowing mystery eyes
    ctx.shadowColor='#ba68c8';ctx.shadowBlur=6;
    ctx.fillStyle='#ba68c8';
    ctx.beginPath();ctx.arc(x-4,y-15+bob,2.5,0,Math.PI*2);ctx.fill();
    ctx.beginPath();ctx.arc(x+4,y-15+bob,2.5,0,Math.PI*2);ctx.fill();
    ctx.shadowBlur=0;
    // floating sparkle
    const sa=t*3;
    ctx.fillStyle='rgba(186,104,200,0.8)';
    ctx.beginPath();ctx.arc(x+Math.cos(sa)*16,y-14+bob+Math.sin(sa)*10,3,0,Math.PI*2);ctx.fill();

  } else {
    // fallback generic
    ctx.fillStyle=npc.color;
    ctx.fillRect(x-8,y-4,16,14);
    ctx.fillStyle='#f5c8a0';
    ctx.beginPath();ctx.arc(x,y-14,11,0,Math.PI*2);ctx.fill();
    ctx.fillStyle=npc.color;
    ctx.fillRect(x-11,y-22,22,10);
    ctx.fillStyle='#2a2a4a';
    ctx.beginPath();ctx.arc(x-4,y-14,2.5,0,Math.PI*2);ctx.fill();
    ctx.beginPath();ctx.arc(x+4,y-14,2.5,0,Math.PI*2);ctx.fill();
  }

  // exclamation mark (if not in dialogue)
  const inDlg=(plzDlgOpen&&plzDlgNpc===npc)||(plzInside&&plzInside.dlgOpen&&plzInside.npc===npc);
  if(!inDlg){
    const pulse=0.7+0.3*Math.sin(plzAnimT*3);
    ctx.fillStyle='rgba(255,50,50,'+pulse+')';
    ctx.beginPath();ctx.arc(x,y-36,10,0,Math.PI*2);ctx.fill();
    ctx.fillStyle='#fff';ctx.font='bold 13px sans-serif';ctx.textAlign='center';
    ctx.fillText('!',x,y-31);
  }
  // name tag
  ctx.font='bold 10px sans-serif';ctx.textAlign='center';
  ctx.fillStyle='rgba(0,0,0,0.75)';ctx.fillText(npc.name,x+1,y+30);
  ctx.fillStyle='#ffe';ctx.fillText(npc.name,x,y+29);
  ctx.restore();
}

// ── interior tile colors ──────────────────────────
const ITCOL={
  0:'#d4c4a0', // floor
  1:'#5a3a2a', // wall
  2:'#a0d4ff', // exit door
  3:'#8b6914', // counter
  4:'#9b5900', // shelf
  5:'#5a9a3a', // plant/decor
  6:'#c4b488', // table (stone)
  7:'#7a5020', // chair/bench
  8:'#3a4a9a', // bulletin board
  9:'#9a6a4a', // stage
  10:'#aaaaaa', // training dummy
};

function _plzDrawInterior(){
  const inn=plzInside;
  if(!inn)return;
  const ctx=plzCtx;
  ctx.clearRect(0,0,plzW,plzH);

  // background fill
  ctx.fillStyle='#2a1a0a';
  ctx.fillRect(0,0,plzW,plzH);

  // ceiling gradient
  const ceilGrad=ctx.createLinearGradient(0,0,0,plzH*0.3);
  ceilGrad.addColorStop(0,'rgba(80,50,20,0.6)');
  ceilGrad.addColorStop(1,'rgba(0,0,0,0)');
  ctx.fillStyle=ceilGrad;ctx.fillRect(0,0,plzW,plzH);

  const totalW=BLDG_IW*TILE,totalH=BLDG_IH*TILE;
  // center camera on player
  inn.camX=inn.px-plzW/2;
  inn.camY=inn.py-plzH/2;
  inn.camX=Math.max(0,Math.min(totalW-plzW,inn.camX));
  inn.camY=Math.max(0,Math.min(totalH-plzH,inn.camY));
  const ox=-Math.round(inn.camX),oy=-Math.round(inn.camY);

  const c0=Math.max(0,Math.floor(inn.camX/TILE)-1);
  const c1=Math.min(BLDG_IW,Math.ceil((inn.camX+plzW)/TILE)+1);
  const r0=Math.max(0,Math.floor(inn.camY/TILE)-1);
  const r1=Math.min(BLDG_IH,Math.ceil((inn.camY+plzH)/TILE)+1);

  for(let r=r0;r<r1;r++) for(let c=c0;c<c1;c++){
    _plzDrawInteriorTile(ctx,inn.map,c,r,ox,oy);
  }

  // draw NPC inside
  if(inn.npc){
    const nx=inn.npcCol*TILE+TILE/2+ox;
    const ny=inn.npcRow*TILE+TILE/2+oy;
    _plzDrawNpc(ctx,inn.npc,nx,ny);
  }

  // draw player
  const myNick=_plzMyNick();
  const px=inn.px+ox,py=inn.py+oy;
  _plzDrawChar(ctx,px,py,inn.dir,'#4fc3f7',myNick,null,true,null);

  // HUD overlay: building name
  ctx.fillStyle='rgba(0,0,0,0.55)';
  ctx.fillRect(0,0,plzW,36);
  ctx.font='bold 14px sans-serif';ctx.textAlign='center';
  ctx.fillStyle='#ffe';
  ctx.fillText(inn.name,plzW/2,24);
  // exit hint at bottom
  ctx.font='12px sans-serif';
  ctx.fillStyle='rgba(200,240,200,0.7)';
  ctx.fillText('🚪 출구로 걸어가거나 F 키를 누르세요',plzW/2,plzH-16);

  // dialogue box (reuse existing)
  if(inn.dlgOpen&&inn.dlgNpc){
    const dl=document.getElementById('plaza-npc-dlg');
    if(dl&&!dl.classList.contains('on')){
      document.getElementById('plz-npc-name').textContent=inn.dlgNpc.name;
      document.getElementById('plz-npc-text').textContent=inn.dlgNpc.lines[inn.dlgIdx]||'...';
      dl.classList.add('on');
    }
  }
}

function _plzDrawInteriorTile(ctx,map,c,r,ox,oy){
  const x=c*TILE+ox,y=r*TILE+oy;
  const t=map[r][c];
  ctx.fillStyle=ITCOL[t]??'#d4c4a0';
  ctx.fillRect(x,y,TILE,TILE);

  if(t===0){
    // wooden floor planks
    ctx.strokeStyle='rgba(0,0,0,0.15)';ctx.lineWidth=1;
    const off=(r%2)*16;
    ctx.beginPath();ctx.moveTo(x+off,y);ctx.lineTo(x+off,y+TILE);ctx.stroke();
    ctx.beginPath();ctx.moveTo(x+off+16,y);ctx.lineTo(x+off+16,y+TILE);ctx.stroke();
    ctx.beginPath();ctx.moveTo(x+off+32,y);ctx.lineTo(x+off+32,y+TILE);ctx.stroke();
    ctx.fillStyle='rgba(255,255,255,0.05)';ctx.fillRect(x,y,TILE,2);
  } else if(t===1){
    // wall with shading
    ctx.fillStyle='#4a2e1a';ctx.fillRect(x,y+TILE-6,TILE,6);
    ctx.fillStyle='rgba(255,255,255,0.07)';ctx.fillRect(x,y,TILE,4);
    if((c+r)%4===0){
      ctx.fillStyle='rgba(255,200,100,0.12)';
      ctx.fillRect(x+8,y+8,14,16);ctx.fillRect(x+26,y+8,14,16);
    }
  } else if(t===2){
    // door
    ctx.fillStyle='#60aaee';ctx.fillRect(x,y,TILE,TILE);
    const pulse=0.6+0.4*Math.sin(plzAnimT*3);
    ctx.fillStyle='rgba(100,200,255,'+pulse+')';
    ctx.fillRect(x+6,y+4,TILE-12,TILE-8);
    ctx.strokeStyle='rgba(200,240,255,0.8)';ctx.lineWidth=2;
    ctx.strokeRect(x+6,y+4,TILE-12,TILE-8);
    ctx.font='16px sans-serif';ctx.textAlign='center';
    ctx.fillStyle='rgba(255,255,255,0.9)';
    ctx.fillText('🚪',x+TILE/2,y+TILE/2+6);
    ctx.font='bold 9px sans-serif';
    ctx.fillStyle='#fff';ctx.fillText('출구',x+TILE/2,y+TILE-4);
  } else if(t===3){
    // counter/desk
    ctx.fillStyle='#a07820';ctx.fillRect(x,y+TILE-10,TILE,10);
    ctx.fillStyle='#c8a030';ctx.fillRect(x,y,TILE,TILE-10);
    ctx.fillStyle='rgba(255,255,255,0.2)';ctx.fillRect(x+2,y+2,TILE-4,3);
  } else if(t===4){
    // shelf
    ctx.fillStyle='#7a4500';ctx.fillRect(x,y,TILE,TILE);
    ctx.fillStyle='#5a3200';ctx.fillRect(x,y,TILE,4);
    ctx.fillStyle='#5a3200';ctx.fillRect(x,y+TILE/2-2,TILE,4);
    // items on shelf
    ['#e74c3c','#3498db','#2ecc71'].forEach((c2,i)=>{
      ctx.fillStyle=c2;ctx.fillRect(x+4+i*14,y+6,10,18);
    });
  } else if(t===5){
    // plant/decor
    ctx.fillStyle=ITCOL[0];ctx.fillRect(x,y,TILE,TILE);
    ctx.fillStyle='#5a3200';ctx.fillRect(x+18,y+28,12,16);
    ctx.fillStyle='#2a8a2a';
    ctx.beginPath();ctx.arc(x+TILE/2,y+22,14,0,Math.PI*2);ctx.fill();
    ctx.fillStyle='#3aaa3a';
    ctx.beginPath();ctx.arc(x+TILE/2,y+18,10,0,Math.PI*2);ctx.fill();
  } else if(t===6){
    // table
    ctx.fillStyle='#b8a060';ctx.fillRect(x+4,y+4,TILE-8,TILE-8);
    ctx.fillStyle='#8a6020';ctx.fillRect(x,y,TILE,4);ctx.fillRect(x,y,4,TILE);
    ctx.fillRect(x+TILE-4,y,4,TILE);ctx.fillRect(x,y+TILE-4,TILE,4);
  } else if(t===7){
    // chair/bench
    ctx.fillStyle=ITCOL[0];ctx.fillRect(x,y,TILE,TILE);
    ctx.fillStyle='#8b4513';ctx.fillRect(x+8,y+12,TILE-16,12);
    ctx.fillStyle='#6a3010';ctx.fillRect(x+10,y+8,4,14);ctx.fillRect(x+TILE-14,y+8,4,14);
  } else if(t===8){
    // bulletin board
    ctx.fillStyle='#3a4a9a';ctx.fillRect(x,y,TILE,TILE);
    ctx.fillStyle='#5a6aba';ctx.fillRect(x+2,y+2,TILE-4,TILE-4);
    // papers
    ['rgba(255,255,220,0.9)','rgba(255,200,200,0.9)','rgba(200,255,200,0.9)'].forEach((c2,i)=>{
      ctx.fillStyle=c2;ctx.fillRect(x+4+i*14,y+6,10,16);
    });
  } else if(t===9){
    // stage
    ctx.fillStyle='#9a6a4a';ctx.fillRect(x,y,TILE,TILE);
    ctx.fillStyle='rgba(255,200,100,0.2)';ctx.fillRect(x,y,TILE,TILE);
    ctx.strokeStyle='rgba(255,200,100,0.5)';ctx.lineWidth=1;
    ctx.strokeRect(x+2,y+2,TILE-4,TILE-4);
  } else if(t===10){
    // training dummy
    ctx.fillStyle=ITCOL[0];ctx.fillRect(x,y,TILE,TILE);
    ctx.fillStyle='#c0392b';
    ctx.beginPath();ctx.arc(x+TILE/2,y+10,9,0,Math.PI*2);ctx.fill();
    ctx.fillRect(x+TILE/2-5,y+18,10,18);
    ctx.fillRect(x+TILE/2-14,y+22,28,8);
    ctx.fillStyle='#7f8c8d';ctx.fillRect(x+TILE/2-3,y+36,6,6);
    ctx.fillRect(x+TILE/2-3,y+42,6,4);
  }
  ctx.strokeStyle='rgba(0,0,0,0.08)';ctx.lineWidth=0.4;ctx.strokeRect(x,y,TILE,TILE);
}

// ── minimap ───────────────────────────────────────────
function _plzDrawMinimap(){
  const ctx=plzMMCtx,cw=70,ch=54;
  const sx=cw/MW,sy=ch/MH;
  ctx.clearRect(0,0,cw,ch);
  for(let r=0;r<MH;r++) for(let c=0;c<MW;c++){
    const t=plzMap[r][c];
    ctx.fillStyle=TCOL[t]??'#3a6a4a';
    ctx.fillRect(c*sx,r*sy,sx+.5,sy+.5);
  }
  // other players
  for(const [,op] of plzOtherPlayers){
    ctx.fillStyle='#ffff80';
    ctx.fillRect(op.px/TILE*sx-1,op.py/TILE*sy-1,3,3);
  }
  // player dot
  ctx.fillStyle='#4fc3f7';
  ctx.beginPath();ctx.arc(plzPx/TILE*sx,plzPy/TILE*sy,2.5,0,Math.PI*2);ctx.fill();
  // viewport rect
  ctx.strokeStyle='rgba(255,255,255,0.5)';ctx.lineWidth=1;
  ctx.strokeRect(plzCamX/TILE*sx,plzCamY/TILE*sy,(plzW/TILE)*sx,(plzH/TILE)*sy);
}

// ── NPC check ─────────────────────────────────────────
function _plzCheckNpc(){
  const pr=plzPy/TILE,pc=plzPx/TILE;
  let nearest=null,nearDist=2.5;
  for(const npc of NPCS){
    const d=Math.hypot(npc.col-pc,npc.row-pr);
    if(d<nearDist){nearDist=d;nearest=npc;}
  }
  plzNearNpc=nearest;
  const hint=document.getElementById('plz-inthint');
  if(!hint)return;
  // check if standing near building entrance
  const tr=Math.floor(plzPy/TILE),tc=Math.floor(plzPx/TILE);
  const onEntrance=(tr>=0&&tr<MH&&tc>=0&&tc<MW&&plzMap[tr][tc]===6);
  if(onEntrance&&!plzDlgOpen&&plzInsideCooldown<=0){
    const bdef=_plzFindBuilding(tr,tc);
    if(bdef){
      hint.textContent=plzIsMobile?'입장':'F — '+bdef.name+' 입장';
      hint.classList.add('show');return;
    }
  }
  if(nearest&&!plzDlgOpen){
    hint.textContent=plzIsMobile?'상호작용 버튼':'F — '+nearest.name;
    hint.classList.add('show');
  }else{hint.classList.remove('show');}
}

function _plzInteract(){
  // inside a building
  if(plzInside){
    const inn=plzInside;
    if(inn.dlgOpen){
      // advance interior dialogue
      inn.dlgIdx++;
      if(inn.dlgIdx>=(inn.dlgNpc?inn.dlgNpc.lines.length:0)){
        inn.dlgOpen=false;inn.dlgNpc=null;inn.dlgIdx=0;
        document.getElementById('plaza-npc-dlg').classList.remove('on');
      } else {
        document.getElementById('plz-npc-text').textContent=inn.dlgNpc.lines[inn.dlgIdx];
        const moreLines=inn.dlgIdx<inn.dlgNpc.lines.length-1;
        document.getElementById('plz-npc-close').textContent=moreLines?'계속':'닫기';
      }
      return;
    }
    if(inn.nearNpc&&inn.npc){
      // open interior NPC dialogue
      inn.dlgOpen=true;inn.dlgNpc=inn.npc;inn.dlgIdx=0;
      const dl=document.getElementById('plaza-npc-dlg');
      document.getElementById('plz-npc-name').textContent=inn.npc.name;
      document.getElementById('plz-npc-text').textContent=inn.npc.lines[0]||'...';
      document.getElementById('plz-npc-close').textContent=inn.npc.lines.length>1?'계속':'닫기';
      dl.classList.add('on');
      return;
    }
    // F also exits when near the door
    const pr=Math.floor(inn.py/TILE),pc=Math.floor(inn.px/TILE);
    if(pr>=0&&pr<BLDG_IH&&pc>=0&&pc<BLDG_IW&&inn.map[pr][pc]===2){
      _plzExitBuilding();return;
    }
    // if near bottom/top walls (within 1.5 tiles of exit), exit
    if(inn.enterAtTop&&inn.py>=(BLDG_IH-2)*TILE){_plzExitBuilding();return;}
    if(!inn.enterAtTop&&inn.py<=1.5*TILE){_plzExitBuilding();return;}
    return;
  }
  if(plzDlgOpen){_plzAdvanceDlg();return;}
  if(!plzNearNpc)return;
  _plzOpenNpc(plzNearNpc);
}

function _plzOpenNpcById(id){
  const npc=NPCS.find(n=>n.id===id);
  if(npc)_plzOpenNpc(npc);
}

function _plzOpenNpc(npc){
  if(npc.action==='shop'){closePlaza();setTimeout(()=>{phase='shop';showUI('shop');renderShopGrid();},200);return;}
  if(npc.action==='quest'){closePlaza();setTimeout(()=>{showUI('menu');if(typeof _openPanel==='function'&&typeof renderAchievements==='function'){_openPanel('modes-ov');renderAchievements();_openPanel('achieve-ov');}},200);return;}
  // 잠금 NPC 체크 (에로, 이벤트 NPC, 다크 아우라)
  if(npc.locked){
    const myNick=_plzMyNick();
    const isSedon=(myNick==='Sedon');
    const isLv50=(typeof progress!=='undefined'&&progress>=49);
    if(!isSedon&&!isLv50){
      if(typeof popup==='function')popup('🔒 50스테이지 클리어 후 대화할 수 있어요!',innerWidth/2,innerHeight*.38,'#ff9800');
      return;
    }
  }
  plzDlgNpc=npc;plzDlgIdx=0;plzDlgOpen=true;
  document.getElementById('plz-npc-name').textContent=npc.name;
  document.getElementById('plz-npc-text').textContent=npc.lines[0]||(npc.name+' (준비 중)');
  document.getElementById('plaza-npc-dlg').classList.add('on');
}
function _plzAdvanceDlg(){
  if(!plzDlgNpc)return;
  plzDlgIdx++;
  if(plzDlgIdx>=plzDlgNpc.lines.length){_plzCloseDlg();return;}
  document.getElementById('plz-npc-text').textContent=plzDlgNpc.lines[plzDlgIdx];
  document.getElementById('plz-npc-close').textContent=plzDlgIdx<plzDlgNpc.lines.length-1?'계속':'닫기';
}
function _plzCloseDlg(){
  if(plzInside&&plzInside.dlgOpen){
    plzInside.dlgOpen=false;plzInside.dlgNpc=null;plzInside.dlgIdx=0;
    document.getElementById('plaza-npc-dlg').classList.remove('on');
    return;
  }
  plzDlgOpen=false;plzDlgNpc=null;
  document.getElementById('plaza-npc-dlg').classList.remove('on');
}

// ── keyboard ─────────────────────────────────────────
function _plzKeyDown(e){
  if(!plzActive)return;
  if(document.activeElement===document.getElementById('plaza-input'))return;
  plzKeys[e.code]=true;
  if(e.code==='KeyF'){e.preventDefault();_plzInteract();}
}
function _plzKeyUp(e){plzKeys[e.code]=false;}

// ── joystick ─────────────────────────────────────────
function _plzSetupJoystick(){
  const jbase=document.getElementById('plz-jbase');
  const jknob=document.getElementById('plz-jknob');
  const jarea=document.getElementById('plaza-joystick');
  if(!jbase||!jknob)return;
  const MAX=32;
  function upd(cx,cy){
    const r=jbase.getBoundingClientRect();
    const bx=r.left+r.width/2,by=r.top+r.height/2;
    let dx=cx-bx,dy=cy-by;
    const len=Math.sqrt(dx*dx+dy*dy);
    if(len>MAX){dx=dx/len*MAX;dy=dy/len*MAX;}
    jknob.style.transform='translate('+(dx)+'px,'+(dy)+'px)';
    plzJoyX=dx/MAX;plzJoyY=dy/MAX;
  }
  jarea.addEventListener('touchstart',e=>{
    const t=e.changedTouches[0];
    plzTouchId=t.identifier;plzJoyActive=true;
    upd(t.clientX,t.clientY);e.preventDefault();
  },{passive:false});
  window.addEventListener('touchmove',e=>{
    if(!plzJoyActive)return;
    for(const t of e.changedTouches){
      if(t.identifier===plzTouchId){upd(t.clientX,t.clientY);break;}
    }
    e.preventDefault();
  },{passive:false});
  window.addEventListener('touchend',e=>{
    for(const t of e.changedTouches){
      if(t.identifier===plzTouchId){
        plzJoyActive=false;plzJoyX=0;plzJoyY=0;plzTouchId=null;
        jknob.style.transform='translate(0,0)';break;
      }
    }
  });
}

// ── chat ──────────────────────────────────────────────
function _plzChatMsg(from,text,type){
  const msgs=document.getElementById('plaza-msgs');if(!msgs)return;
  const d=document.createElement('div');
  d.className='plz-msg'+(type==='sys'?' plz-msg-sys':from===_plzMyNick()?' plz-msg-me':'');
  if(from){
    const name=document.createElement('span');
    name.className='plz-msg-name';
    name.textContent=from;
    d.appendChild(name);
    if(from==='Sedon'){
      const badge=document.createElement('span');
      badge.className='plz-admin-badge';
      badge.textContent='관리자';
      d.appendChild(badge);
    }
    const body=document.createElement('span');
    body.textContent=text;
    d.appendChild(body);
  }else d.textContent=text;
  msgs.appendChild(d);
  while(msgs.children.length>50)msgs.firstChild.remove();
  msgs.scrollTop=msgs.scrollHeight;
}
function _plzSendChat(){
  const inp=document.getElementById('plaza-input');
  const text=(inp?.value||'').trim();if(!text)return;
  inp.value='';
  // The server broadcasts back to the sender as well, so the local
  // message is rendered exactly once and stays consistent with everyone else.
  const ws=_plzSocWs();
  if(ws&&ws.readyState===WebSocket.OPEN){
    ws.send(JSON.stringify({type:'plaza_chat',text}));
  }else{
    _plzChatMsg(null,'서버 연결 중이라 메시지를 보내지 못했습니다.','sys');
  }
}

// ── WebSocket incoming ────────────────────────────────
function _plzOnWsMsg(msg){
  if(!plzActive)return;
  if(msg.type==='plaza_chat'){
    _plzChatMsg(msg.from,msg.text);
    // set bubble on other player
    const op=plzOtherPlayers.get(msg.from);
    if(op){op.bubble=msg.text.length>20?msg.text.slice(0,20)+'…':msg.text;op.bubbleT=performance.now();}
    if(msg.from===_plzMyNick()){
      plzChatBubbles.push({nick:msg.from,text:msg.text,t:performance.now()});
    }
  }else if(msg.type==='plaza_history'){
    for(const entry of (msg.messages||[]))_plzChatMsg(entry.from,entry.text);
  }else if(msg.type==='plaza_pos'){
    let op=plzOtherPlayers.get(msg.from);
    if(!op){op={px:msg.x,py:msg.y,dir:msg.d||2,bubble:null,bubbleT:null,title:msg.title||null};plzOtherPlayers.set(msg.from,op);}
    else{op.px=msg.x;op.py=msg.y;op.dir=msg.d||2;if(msg.title!==undefined)op.title=msg.title||null;}
    document.getElementById('plz-pc').textContent=plzOtherPlayers.size+1;
  }else if(msg.type==='plaza_join'){
    _plzChatMsg(null,msg.from+' 님이 소통 라운지에 입장했습니다.','sys');
  }else if(msg.type==='plaza_leave'){
    _plzChatMsg(null,msg.from+' 님이 소통 라운지를 떠났습니다.','sys');
    plzOtherPlayers.delete(msg.from);
    document.getElementById('plz-pc').textContent=plzOtherPlayers.size+1;
  }
}

// ── position broadcast ────────────────────────────────
function _plzBroadcastPos(ts){
  if(ts-plzPosBroadcastT<POS_IV)return;
  plzPosBroadcastT=ts;
  const ws=_plzSocWs();
  if(ws&&ws.readyState===WebSocket.OPEN){
    const myNick=_plzMyNick();
    const isSedonMe=(myNick==='Sedon');
    const myTitle=isSedonMe?'👑 관리자':((typeof _settings!=='undefined'&&_settings.activeTitle)?_settings.activeTitle:'');
    ws.send(JSON.stringify({type:'plaza_pos',x:Math.round(plzPx),y:Math.round(plzPy),d:plzDir,title:myTitle}));
  }
}

// ── nick color ────────────────────────────────────────
const NCOLORS=['#ef5350','#42a5f5','#66bb6a','#ffa726','#ab47bc','#26c6da','#ec407a','#8d6e63'];
function _plzNickColor(nick){
  let h=0;for(let i=0;i<nick.length;i++)h=(h*31+nick.charCodeAt(i))&0xffff;
  return NCOLORS[h%NCOLORS.length];
}

// ── open / close plaza ────────────────────────────────
function openPlaza(){
  // 광장은 모두 입장 가능. Sedon 계정은 관리자 권한으로 입장.
  document.getElementById('plaza-screen').classList.add('on');
  plzInit();
}
window.openPlaza=openPlaza;

function closePlaza(){
  plzActive=false;
  document.getElementById('plaza-screen').classList.remove('on');
  window.removeEventListener('keydown',_plzKeyDown);
  window.removeEventListener('keyup',_plzKeyUp);
  window.removeEventListener('resize',_plzResize);
  // WS leave
  const ws=_plzSocWs();
  if(ws&&ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'plaza_leave'}));
  // stop BGM
  const bgm=document.getElementById('plaza-bgm');
  if(bgm){bgm.pause();bgm.currentTime=0;}
  plzOtherPlayers.clear();
  plzKeys={};plzJoyX=0;plzJoyY=0;
}
window.closePlaza=closePlaza;

// ── hook into existing social WS message handler ──────
(function(){
  const origOnSocMsg=window._onSocWsMsg;
  window._onSocWsMsg=function(msg){
    if(origOnSocMsg)origOnSocMsg(msg);
    _plzOnWsMsg(msg);
  };
})();

})(); // end plaza IIFE


// 광장 버튼: 모든 사용자에게 항상 표시
(function(){
  function _checkPlazaBtn(){
    const btn=document.getElementById('btn-plaza');
    if(btn)btn.style.display='block';
  }
  document.addEventListener('DOMContentLoaded',()=>{
    const btn=document.getElementById('btn-plaza');
    if(btn){
      btn.style.display='block';
      btn.addEventListener('click',()=>{if(typeof openPlaza==='function')openPlaza();});
    }
  });
  window._checkPlazaBtn=_checkPlazaBtn;
  // 페이지 로드 직후에도 표시
  setTimeout(_checkPlazaBtn,500);
})();


document.getElementById('sdm-close')?.addEventListener('click',()=>{document.getElementById('skin-detail-modal').style.display='none';});
