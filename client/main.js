// Entry point: wires the modules together, handles server messages and runs the frame loop.
import * as THREE from 'three';
import { WORLD, STATE, WEAPONS, PLAYER, B, BLOCKS, HOTBAR_SLOTS } from '../shared/constants.js';
import { World, raycast } from '../shared/world.js';
import { setTheme, theme } from './theme.js';
import { G, applyYou, applyStorm, playerName, isVec3, isNum, saveSettings } from './state.js';
import { Net, r2, r4 } from './net.js';
import { Renderer, gfxScale } from './renderer.js';
import { blockColorLinear } from './mesher.js';
import { Input } from './input.js';
import { LocalPlayer } from './player.js';
import { ViewModel } from './viewmodel.js';
import { Effects } from './effects.js';
import { Avatars, idColor } from './avatars.js';
import { BuildMode } from './build.js';
import { Combat } from './combat.js';
import { AudioFx } from './audio.js';
import { Hud } from './hud.js';
import { Minimap } from './minimap.js';
import { Lobby } from './lobby.js';
import { TouchControls } from './touch.js';

const BASE_FOV = 75;
const SENS = 0.0023;
const canvas = document.getElementById('game');
const net = new Net();
const audio = new AudioFx();
const input = new Input(canvas);
const player = new LocalPlayer();
const hud = new Hud();
const minimap = new Minimap(document.getElementById('minimap'));

let renderer = null;
try { renderer = new Renderer(canvas); } catch (err) { console.warn('WebGL unavailable:', err); }
const scene = renderer ? renderer.scene : new THREE.Scene();
const cam = renderer ? renderer.camera : new THREE.PerspectiveCamera(BASE_FOV, 1, 0.1, 800);
const vm = new ViewModel(renderer ? renderer.vmScene : new THREE.Scene());
const fx = new Effects(scene);
const avatars = new Avatars(scene);
const build = new BuildMode(scene, net);
const combat = new Combat({ net, player, input, audio, hud, vm, fx, build });
const lobby = new Lobby({ net, input, audio });
if (!renderer) lobby.showWebglError();
const touch = new TouchControls(input, canvas);

const eye = [0, 0, 0], dir = [0, 0, -1], tmpCol = [0, 0, 0], tmpO = [0, 0, 0], tmpD = [0, 0, 0];
const storm = { x: WORLD.SX / 2, z: WORLD.SZ / 2, r: 125 }; // smoothed for drawing
let needPos = false, loading = false, lastPosSent = 0, lastCount = -1, wasShrinking = false;
let last = performance.now(), time = 0, fps = 60, fpsAcc = 0, fpsN = 0;

const debug = {
  fps: 60, ping: 0, dirtyChunks: 0, triangles: 0, loading: false, matchState: G.state,
  look(yaw, pitch) { player.yaw = yaw; player.pitch = pitch; },
  teleport(p) { if (isVec3(p)) player.teleport(p); },
};
window.__game = { state: G, net, player, debug, get world() { return G.world; }, renderer, combat, build, avatars };

// ------------------------------------------------------------------ world
function setWorld(seed, edits, themeId) {
  setTheme(typeof themeId === 'string' ? themeId : 'meadow');
  if (renderer) renderer.applyTheme();
  const w = new World(seed | 0, theme.id);
  G.world = w;
  if (Array.isArray(edits)) {
    for (const e of edits) {
      if (Array.isArray(e) && e.length >= 4 && isNum(e[3]) && e[3] >= 0 && e[3] <= 255) w.set(e[0] | 0, e[1] | 0, e[2] | 0, e[3] | 0);
    }
  }
  if (renderer) renderer.setWorld(w);
  minimap.build(w);
  loading = true;
  hud.setLoading(true, 'Generating island…');
}

function distGain(x, y, z, range) {
  const dx = x - cam.position.x, dy = y - cam.position.y, dz = z - cam.position.z;
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return d > range ? 0 : 1 / (1 + (d * d) / (range * 2.2));
}
// bearing of a world point relative to where the camera looks (positive = to the left)
function relAngle(x, z) {
  const a = Math.atan2(-(x - cam.position.x), -(z - cam.position.z)) - cam.rotation.y;
  return Math.atan2(Math.sin(a), Math.cos(a));
}

function applyEdits(edits) {
  const w = G.world;
  if (!Array.isArray(edits) || !w) return;
  let bursts = 0, chest = false, breakGain = 0, placeGain = 0;
  for (const e of edits) {
    if (!Array.isArray(e) || e.length < 4) continue;
    const x = e[0] | 0, y = e[1] | 0, z = e[2] | 0, b = e[3] | 0;
    if (b < 0 || b > 255) continue;
    const old = w.get(x, y, z);
    if (!w.set(x, y, z, b)) continue;
    if (renderer) renderer.markDirty(x, z);
    if (old === B.CHEST || b === B.CHEST) chest = true;
    if (b === B.AIR) {
      if (bursts++ < 10 && BLOCKS[old]) {
        if (old === B.CHEST) { tmpCol[0] = 1; tmpCol[1] = 0.7; tmpCol[2] = 0.15; } else blockColorLinear(old, tmpCol);
        fx.burst(x + 0.5, y + 0.5, z + 0.5, tmpCol, old === B.LEAVES ? 6 : 11, 4.5, 0.13, 0.4);
      }
      breakGain = Math.max(breakGain, distGain(x, y, z, 40));
    } else if (old === B.AIR) {
      placeGain = Math.max(placeGain, distGain(x, y, z, 30));
    }
  }
  if (chest && renderer) renderer.refreshChests();
  if (breakGain > 0) audio.breakBlock(breakGain);
  if (placeGain > 0) audio.place(placeGain);
}

// ------------------------------------------------------------------ match state
function setState(state, m) {
  if (typeof state !== 'string') return;
  const prev = G.state;
  G.state = state;
  debug.matchState = state;
  if (m) {
    if (isNum(m.timer)) G.timer = m.timer;
    G.winner = m.winner !== undefined ? m.winner : null;
    G.winnerName = typeof m.winnerName === 'string' ? m.winnerName : '';
  }
  if (prev === state) return;
  lastCount = -1;
  if (state === STATE.COUNTDOWN) {
    build.toggle(false);
    G.livesMode = false;
    hud.banner('Get ready', 'Dropping onto a fresh island', 2, '');
  } else if (state === STATE.PLAYING) {
    hud.banner('Fight!', 'Last one standing wins', 2.2, '');
    audio.go();
    wasShrinking = false;
  } else if (state === STATE.ENDED) {
    const mine = G.winner !== null && G.winner === G.id;
    const name = G.winnerName || (G.winner !== null ? playerName(G.winner) : '');
    hud.banner(mine ? 'Victory!' : name ? `${name} wins` : 'Match over', mine ? 'You outlasted everyone' : 'Back to the lobby shortly', 7, mine ? 'win' : '');
    if (mine) audio.win(); else audio.lose();
  } else if (state === STATE.LOBBY) {
    G.spectating = null;
    G.livesMode = false;
    if (prev !== STATE.LOBBY) hud.banner('Lobby', 'Roam freely — press Esc to start a match', 3, '');
  }
  lobby.refresh(true);
}

// ------------------------------------------------------------------ network
net.onStatus = (open) => { hud.setConn(!open && G.joined); };

net.on('full', () => {
  net.name = null; // stop auto re-joining on reconnect
  lobby.joinFailed('Server is full (16 players). Try again shortly.');
});

let warnedSoftware = false;
net.on('welcome', (m) => {
  if (renderer && renderer.software && !warnedSoftware) {
    warnedSoftware = true;
    setTimeout(() => hud.toast('This browser is drawing without the graphics chip, so it will be slow. In Chrome: Settings → System → turn on graphics acceleration, then relaunch.', 12), 1500);
  }
  G.id = m.id;
  G.joined = true;
  G.players.clear();
  avatars.clear();
  if (Array.isArray(m.players)) {
    for (const p of m.players) if (p && p.id !== undefined) G.players.set(p.id, { id: p.id, name: String(p.name ?? 'Player'), bot: !!p.bot, head: p.head | 0 });
  }
  if (!G.players.has(G.id)) G.players.set(G.id, { id: G.id, name: G.name || 'You', bot: false });
  setWorld(isNum(m.seed) ? m.seed : 1, m.edits, m.theme);
  applyYou(m.you);
  vm.show(G.you.slot);
  needPos = true;
  if (m.you && isVec3(m.you.p)) { player.teleport(m.you.p); needPos = false; }
  G.state = '';
  setState(typeof m.state === 'string' ? m.state : STATE.LOBBY, null);
  hud.show(true);
  hud.setConn(false);
  lobby.onWelcome();
});

net.on('joined', (m) => {
  if (m.id === undefined) return;
  const name = String(m.name ?? 'Player');
  G.players.set(m.id, { id: m.id, name, bot: !!m.bot, head: m.head | 0 });
  avatars.setHead(m.id, m.head | 0);
  avatars.setName(m.id, name);
  if (!m.bot && m.id !== G.id) hud.chatLine('', `${name} joined the island`);
  lobby.refresh();
});

net.on('head', (m) => {
  const p = G.players.get(m.id);
  if (!p || !isNum(m.head)) return;
  p.head = m.head | 0;
  avatars.setHead(m.id, p.head);
});

net.on('left', (m) => {
  const p = G.players.get(m.id);
  if (p && !p.bot) hud.chatLine('', `${p.name} left`);
  G.players.delete(m.id);
  avatars.remove(m.id);
  lobby.refresh();
});

net.on('snap', (m) => {
  const now = performance.now();
  avatars.onSnap(m.players, now);
  if (needPos && Array.isArray(m.players)) {
    for (const p of m.players) {
      if (p && p.id === G.id && isVec3(p.p)) { player.teleport(p.p); needPos = false; break; }
    }
  }
  if (Array.isArray(m.players)) {
    for (const p of m.players) {
      const e = p && G.players.get(p.id);
      if (!e) continue;
      e.alive = p.alive !== false;
      if (isNum(p.k)) e.kills = p.k;
      if (isNum(p.l)) e.lives = p.l;
    }
  }
  applyStorm(m.storm);
  if (isNum(m.alive)) G.alive = m.alive;
  if (isNum(m.timer)) G.timer = m.timer;
  if (typeof m.state === 'string' && m.state !== G.state) setState(m.state, null);
});

net.on('you', (m) => {
  const slot = G.you.slot;
  const wasAlive = G.you.alive;
  const y = G.you.mats, w0 = y.wood, s0 = y.stone, m0 = y.metal;
  applyYou(m);
  if (wasAlive && G.you.alive) {
    if (y.wood > w0) hud.gain('wood', y.wood - w0);
    if (y.stone > s0) hud.gain('stone', y.stone - s0);
    if (y.metal > m0) hud.gain('metal', y.metal - m0);
  }
  if (performance.now() < combat.slotLockUntil) G.you.slot = slot;
  if (!G.you.owned[G.you.slot]) G.you.slot = 0;
  if (!wasAlive && G.you.alive) G.spectating = null;
  if (wasAlive && !G.you.alive) build.toggle(false);
  lobby.refresh();
});

net.on('blocks', (m) => applyEdits(m.edits));

net.on('world', (m) => {
  if (!isNum(m.seed)) return;
  setWorld(m.seed, m.edits, m.theme);
});

net.on('correct', (m) => {
  if (!isVec3(m.p)) return;
  player.teleport(m.p);
  needPos = false;
});

net.on('shot', (m) => {
  if (!isVec3(m.o)) return;
  const mine = m.id === G.id;
  const w = typeof m.w === 'string' && WEAPONS[m.w] ? m.w : 'rifle';
  const ends = Array.isArray(m.ends) ? m.ends : [];
  let ox = m.o[0], oy = m.o[1], oz = m.o[2];
  if (mine && G.you.alive) {
    const e = cam.matrixWorld.elements; // columns: right, up, back
    ox = cam.position.x + e[0] * 0.2 - e[4] * 0.16 - e[8] * 0.75;
    oy = cam.position.y + e[1] * 0.2 - e[5] * 0.16 - e[9] * 0.75;
    oz = cam.position.z + e[2] * 0.2 - e[6] * 0.16 - e[10] * 0.75;
  } else {
    oy -= 0.22;
    avatars.fired(m.id);
  }
  const gain = mine ? 0 : distGain(m.o[0], m.o[1], m.o[2], WEAPONS[w].melee ? 18 : 150);
  if (w === 'sword') { if (gain > 0.05) audio.shot('sword', gain); return; }
  if (isVec3(m.boom)) {
    // rocket: fat smoke trail, then a fireball with debris, a thump and a shake when close
    const b = m.boom;
    fx.tracer(ox, oy, oz, b[0], b[1], b[2], 0.12, 150);
    FIRE[0] = 1; FIRE[1] = 0.45; FIRE[2] = 0.06;
    fx.burst(b[0], b[1], b[2], FIRE, 26, 9, 0.3, 0.7);
    FIRE[0] = 1; FIRE[1] = 0.85; FIRE[2] = 0.3;
    fx.burst(b[0], b[1], b[2], FIRE, 14, 5, 0.22, 0.4);
    FIRE[0] = 0.12; FIRE[1] = 0.12; FIRE[2] = 0.13;
    fx.burst(b[0], b[1] + 0.4, b[2], FIRE, 18, 4, 0.34, 1.1);
    const bg = distGain(b[0], b[1], b[2], 170);
    audio.boom(bg, -Math.sin(relAngle(b[0], b[2])) * 0.8);
    if (bg > 0.35) player.kickVel += (bg - 0.3) * 1.2;
    if (!mine) audio.shot('bazooka', gain, -Math.sin(relAngle(m.o[0], m.o[2])) * 0.8);
    return;
  }
  if (w === 'pickaxe') {
    if (gain > 0.05 && ends.length && isVec3(ends[0]) && G.world) {
      const e0 = ends[0];
      tmpO[0] = m.o[0]; tmpO[1] = m.o[1]; tmpO[2] = m.o[2];
      let dx = e0[0] - tmpO[0], dy = e0[1] - tmpO[1], dz = e0[2] - tmpO[2];
      const len = Math.hypot(dx, dy, dz) || 1;
      const id = G.world.get(Math.floor(e0[0] + (dx / len) * 0.1), Math.floor(e0[1] + (dy / len) * 0.1), Math.floor(e0[2] + (dz / len) * 0.1));
      if (id !== B.AIR && BLOCKS[id]) {
        fx.burst(e0[0], e0[1], e0[2], blockColorLinear(id, tmpCol), 4, 3, 0.09, 0.08);
        audio.pickHit(gain);
      }
    }
    return;
  }
  const wide = w === 'sniper';
  for (let i = 0; i < ends.length && i < 16; i++) {
    const e = ends[i];
    if (!isVec3(e)) continue;
    fx.tracer(ox, oy, oz, e[0], e[1], e[2], wide ? 0.06 : 0.03, wide ? 420 : 260);
    if (!G.world) continue;
    let dx = e[0] - m.o[0], dy = e[1] - m.o[1], dz = e[2] - m.o[2];
    const len = Math.hypot(dx, dy, dz) || 1;
    dx /= len; dy /= len; dz /= len;
    const id = G.world.get(Math.floor(e[0] + dx * 0.1), Math.floor(e[1] + dy * 0.1), Math.floor(e[2] + dz * 0.1));
    if (id !== B.AIR && BLOCKS[id]) fx.burst(e[0] - dx * 0.06, e[1] - dy * 0.06, e[2] - dz * 0.06, blockColorLinear(id, tmpCol), 3, 3, 0.07, 0.04);
  }
  if (!mine) audio.shot(w, gain, -Math.sin(relAngle(m.o[0], m.o[2])) * 0.8);
});

net.on('hurt', (m) => {
  let ang = null;
  const a = m.from !== null && m.from !== undefined ? avatars.get(m.from) : null;
  if (a && a.n > 0) ang = -relAngle(a.pos.x, a.pos.z);
  hud.hurt(isNum(m.dmg) ? m.dmg : 10, ang);
  if (isNum(m.hp)) G.you.hp = m.hp;
  if (isNum(m.sh)) G.you.sh = m.sh;
  audio.hurt();
  player.kickVel += (Math.random() - 0.3) * 0.25;
});

net.on('hitmark', (m) => {
  hud.hitmark(isNum(m.dmg) ? m.dmg : 0, !!m.head, !!m.kill);
  if (m.kill) audio.kill(); else audio.hit(!!m.head);
});

net.on('kill', (m) => {
  const stormKill = m.killer === null || m.killer === undefined; // no killer: storm or a fall
  const fall = stormKill && m.w === 'fall';
  const kn = fall ? 'The void' : stormKill ? 'The storm' : playerName(m.killer);
  const vn = playerName(m.victim);
  const wn = fall ? 'claimed' : stormKill ? 'swallowed' : m.killer === m.victim ? 'blew up' : (WEAPONS[m.w] ? WEAPONS[m.w].name : 'eliminated');
  hud.feed(kn, vn, wn, m.killer === G.id || m.victim === G.id);
  if (m.victim === G.id) {
    G.you.alive = false;
    G.spectating = stormKill || m.killer === G.id ? null : m.killer;
    const why = fall ? 'You fell off the island' : stormKill ? 'The storm got you' : `by ${kn}`;
    if (isNum(m.respawn) && m.respawn > 0) {
      const left = isNum(m.lives) ? m.lives : 0;
      G.you.respawnIn = Math.ceil(m.respawn);
      hud.banner('Knocked out', `${why} — back in ${Math.ceil(m.respawn)}s · ${left === 0 ? 'last life' : left + ' extra ' + (left === 1 ? 'life' : 'lives') + ' left'}`, m.respawn, 'bad');
    } else hud.banner('Eliminated', why, 4, 'bad');
    audio.lose();
    build.toggle(false);
  } else if (m.killer === G.id) {
    hud.toast(`Eliminated ${vn}`, 2.5);
  }
});

net.on('respawn', (m) => {
  if (m.id === G.id) {
    G.you.alive = true; G.you.respawnIn = 0; G.spectating = null;
    hud.banner('Back in the fight', 'Shielded for a moment — your weapons are kept', 2.5, '');
    audio.go();
  } else if (m.id !== undefined) hud.chatLine('', `${playerName(m.id)} is back in the fight`);
});

net.on('loot', (m) => {
  if (typeof m.text === 'string') hud.toast(m.text.slice(0, 120), 4);
  audio.chest();
});

net.on('state', (m) => setState(m.state, m));

net.on('chat', (m) => {
  if (typeof m.text !== 'string') return;
  const color = m.id !== undefined && m.id !== null ? '#' + idColor(m.id).getHexString() : '';
  hud.chatLine(String(m.name ?? playerName(m.id)).slice(0, 20), m.text.slice(0, 160), color);
});

// ------------------------------------------------------------------ input
input.onAnyKey = (code, ev) => {
  audio.unlock();
  const typing = ev.target && ev.target.tagName === 'INPUT';
  if (G.chatting) {
    if (code === 'Enter' || code === 'NumpadEnter') {
      const text = hud.e['chat-input'].value.trim().slice(0, 120);
      if (text) net.send({ t: 'chat', text });
      hud.closeChat();
      ev.preventDefault();
    } else if (code === 'Escape') hud.closeChat();
    return;
  }
  if (typing) return;
  if ((code === 'Enter' || code === 'NumpadEnter') && G.joined && G.locked) { hud.openChat(); ev.preventDefault(); return; }
  if (code === 'KeyM') hud.toast(audio.toggleMute() ? 'Sound off' : 'Sound on', 1.5);
  if (code === 'Tab' && G.joined) { hud.boardOn = !hud.boardOn; ev.preventDefault(); }
  if (code === 'F3' || code === 'KeyP') { hud.debugOn = !hud.debugOn; ev.preventDefault(); }
};

input.onKey = (code) => {
  const now = performance.now();
  if (!G.you.alive) return;
  if (code.startsWith('Digit')) {
    const i = +code.slice(5) - 1;
    if (build.active) { if (i >= 0 && i < 4) { build.piece = i; audio.ui(); } } else if (i >= 0 && i < HOTBAR_SLOTS) { input.cancelZoom(); combat.selectSlot(i, now); }
  } else if (code === 'KeyQ' || code === 'KeyB') {
    input.cancelZoom();
    build.toggle();
    audio.swap();
  } else if (code === 'KeyR') {
    if (build.active) { build.rotate(); audio.ui(); } else combat.reload();
  } else if (code === 'KeyG') {
    if (build.active) { build.cycleMat(1); audio.ui(); }
  } else if (code === 'KeyE') combat.interact();
};

input.onWheel = (d) => {
  if (!G.you.alive) return;
  if (build.active) { build.cycleMat(d); audio.ui(); } else { input.cancelZoom(); combat.cycleSlot(d, performance.now()); }
};

// Scrolling looked like a touchpad: turn on touchpad help unless the player already chose.
input.onTouchpad = () => {
  if (G.settings.touchpadChosen) return;
  G.settings.touchpad = true; G.settings.touchpadChosen = true;
  saveSettings();
  lobby.syncSettings();
  hud.toast('Touchpad mode on: F fires, C toggles aim, aim assist helps — change it in the Esc menu', 6);
};

input.onClick = (button) => {
  audio.unlock();
  if (button === 0 && G.joined && !G.you.alive) cycleSpectate();
};

input.onLock = (locked) => {
  lobby.setVisible(!locked);
  if (!locked) hud.closeChat();
  lobby.refresh(true);
};

build.onPlace = () => { vm.swingNow(); };
build.onDeny = (why) => { audio.deny(); hud.toast(why === 'mats' ? `Not enough ${build.matName}` : 'Cannot build there', 1.2); };
player.onLand = (v) => audio.land(v);
player.onStep = () => audio.step();
hud.e['chat-input'].addEventListener('blur', () => { if (G.chatting) hud.closeChat(); });

// ------------------------------------------------------------------ spectating
function spectateTarget() {
  let a = G.spectating !== null ? avatars.get(G.spectating) : null;
  if (a && a.alive && a.n > 0) return a;
  for (const c of avatars.map.values()) if (c.alive && c.n > 0) { G.spectating = c.id; return c; }
  return null;
}
function cycleSpectate() {
  const ids = [];
  for (const c of avatars.map.values()) if (c.alive && c.n > 0) ids.push(c.id);
  if (!ids.length) return;
  G.spectating = ids[(ids.indexOf(G.spectating) + 1) % ids.length];
}
function spectateCamera() {
  const a = spectateTarget();
  player.dir(dir);
  if (!a) { cam.rotation.set(player.pitch, player.yaw, 0); return null; }
  tmpO[0] = a.pos.x; tmpO[1] = a.pos.y + 1.7; tmpO[2] = a.pos.z;
  tmpD[0] = -dir[0]; tmpD[1] = -dir[1]; tmpD[2] = -dir[2];
  let dist = 6;
  const hit = G.world ? raycast(G.world, tmpO, tmpD, dist + 0.3) : null;
  if (hit) dist = Math.max(0.4, hit.dist - 0.3);
  cam.position.set(tmpO[0] + tmpD[0] * dist, tmpO[1] + tmpD[1] * dist, tmpO[2] + tmpD[2] * dist);
  cam.rotation.set(player.pitch, player.yaw, 0);
  return a;
}

// ------------------------------------------------------------------ auto quality
// Graphics 'auto': if the frame rate stays low for ~2.5 s, render at a lower resolution.
// It only steps down (the display's refresh cap hides any headroom for stepping up).
let slowN = 0, hitches = 0, jsMs = 0;
function autoQuality() {
  if (!renderer || G.settings.gfx !== 'auto' || loading || document.hidden || !G.joined) { slowN = 0; return; }
  slowN = fps < 42 ? slowN + 1 : 0;
  if (slowN < 4 || (renderer.scale <= 0.5 && renderer.lite)) return;
  slowN = 0;
  // far too slow: jump straight to the lightest settings instead of creeping down
  renderer.setScale(fps < 28 ? 0.5 : Math.max(0.5, renderer.scale - 0.25));
  if (renderer.scale < 1) applyLite(true);
  hud.toast('Switched to lighter graphics to keep the game smooth (Esc → Graphics to change)', 4);
}
function applyLite(on) {
  if (renderer) renderer.setLite(on);
  document.body.classList.toggle('perf-low', on);
}
window.addEventListener('vs-gfx', () => {
  if (!renderer) return;
  renderer.setScale(gfxScale(G.settings.gfx));
  applyLite(G.settings.gfx === 'low');
});
applyLite(G.settings.gfx === 'low');

// ------------------------------------------------------------------ aim assist
// Touchpad mode only, guns only: when the crosshair is already close to a visible enemy,
// gently pull toward them while the player is aiming or firing. Never snaps or tracks
// through walls.
let assistOn = false;
const ASSIST_CONE = 0.13; // radians
function aimAssist(dt, canAct, mdx, mdy) {
  assistOn = false;
  if (!(G.settings.touchpad || input.touchMode) || !canAct || build.active || G.you.slot === 0 || !G.world || G.state !== STATE.PLAYING) return;
  let best = null, bestAng = ASSIST_CONE, bx = 0, by = 0, bz = 0, bd = 0;
  for (const c of avatars.map.values()) {
    if (!c.alive || !(c.n > 0)) continue;
    const dx = c.pos.x - eye[0], dy = c.pos.y + 1.1 - eye[1], dz = c.pos.z - eye[2];
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d < 1.5 || d > 70) continue;
    const ang = Math.acos(Math.min(1, (dx * dir[0] + dy * dir[1] + dz * dir[2]) / d));
    if (ang < bestAng) { bestAng = ang; best = c; bx = dx; by = dy; bz = dz; bd = d; }
  }
  if (!best) return;
  tmpD[0] = bx / bd; tmpD[1] = by / bd; tmpD[2] = bz / bd;
  const hit = raycast(G.world, eye, tmpD, bd);
  if (hit && hit.dist < bd - 0.6) return; // behind cover
  assistOn = true;
  const active = input.lmb ? 5 : (mdx !== 0 || mdy !== 0 || input.rmb) ? 2.2 : 0;
  if (!active) return;
  const k = Math.min(1, dt * active);
  let ey = Math.atan2(-bx, -bz) - player.yaw;
  ey = Math.atan2(Math.sin(ey), Math.cos(ey));
  const ep = Math.asin(Math.max(-1, Math.min(1, by / bd))) - (player.pitch + player.kick);
  player.yaw += ey * k;
  player.pitch += ep * k;
  player.dir(dir);
}

// ------------------------------------------------------------------ frame loop
function frame() {
  requestAnimationFrame(frame);
  const now = performance.now();
  const dt = Math.min(0.1, Math.max(0.0001, (now - last) / 1000));
  last = now; time += dt;
  fpsAcc += dt; fpsN++;
  if (fpsAcc >= 0.5) { fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; autoQuality(); }
  if (dt > 0.05) hitches++;
  const jsT0 = now;

  const you = G.you, world = G.world;
  const inGame = G.joined && player.hasPos;
  const alive = inGame && you.alive;
  const canAct = alive && G.locked && !G.chatting;

  const mdx = input.dx, mdy = input.dy;
  input.dx = 0; input.dy = 0;
  if (G.locked) {
    const fovK = cam.fov / BASE_FOV;
    // aim assist slows the pointer a little while the crosshair is near a target
    player.look(mdx, mdy, SENS * G.settings.sens * fovK * (assistOn ? 0.6 : 1));
    if (!G.chatting) {
      // I J K L: steady keyboard aiming for touchpads
      const kx = (input.down('KeyL') ? 1 : 0) - (input.down('KeyJ') ? 1 : 0);
      const ky = (input.down('KeyK') ? 1 : 0) - (input.down('KeyI') ? 1 : 0);
      if (kx || ky) player.look(kx, ky, 1.9 * dt * fovK);
    }
  }
  player.update(dt, world, input, alive, canAct);

  let specName = '';
  if (!inGame) {
    // title screen: slow orbit around the island
    const a = time * 0.06;
    cam.position.set(WORLD.SX / 2 + Math.cos(a) * 105, 58, WORLD.SZ / 2 + Math.sin(a) * 105);
    cam.rotation.set(-0.42, Math.PI / 2 - a, 0);
  } else if (alive) {
    player.applyCamera(cam);
  } else {
    const a = spectateCamera();
    if (you.respawnIn > 0 && G.state === STATE.PLAYING) {
      if (you.respawnIn !== respN) { respN = you.respawnIn; respText = `Respawning in ${respN}…`; }
      specName = respText;
    } else if (a) {
      if (a.id !== specId) { specId = a.id; specText = `Spectating ${playerName(a.id)} — click for the next player`; }
      specName = specText;
    } else specName = 'Eliminated — waiting for the next match';
  }
  cam.updateMatrixWorld();
  player.eye(eye); player.dir(dir);
  // aim from where the camera actually is (landing dip / step-up smoothing), so the
  // crosshair, block outline, build ghost and shots all agree
  if (alive) { eye[0] = cam.position.x; eye[1] = cam.position.y; eye[2] = cam.position.z; }

  aimAssist(dt, canAct, mdx, mdy);
  touch.update(build.active, combat.chest);
  combat.update(now, dt, eye, dir, canAct);
  if (alive) build.update(world, eye, dir, player.yaw, player.pos, avatars); else build.ghost.visible = false;
  const scoped = combat.weaponId === 'sniper' && !build.active;
  const zoomFov = scoped ? 18 : 56;
  const fov = BASE_FOV + (player.inp.sprint && player.speed > 6 ? 6 : 0) + (zoomFov - BASE_FOV) * (alive ? combat.zoom : 0);
  const nf = cam.fov + (fov - cam.fov) * Math.min(1, dt * 16);
  if (Math.abs(nf - cam.fov) > 0.01) { cam.fov = nf; cam.updateProjectionMatrix(); }

  vm.show(build.active ? vm.buildIndex : you.slot);
  if (build.active) vm.setBuildMat(build.mat);
  vm.update(dt, mdx, mdy, player.bobT, player.bobAmp, !player.s.onGround, alive ? combat.zoom : 0);
  avatars.update(now, dt, cam);
  fx.update(dt, world);

  // storm (smoothed between snapshots)
  const st = G.storm, k = Math.min(1, dt * 10);
  storm.x += (st.x - storm.x) * k; storm.z += (st.z - storm.z) * k; storm.r += (st.r - storm.r) * k;
  const stormOn = G.state === STATE.PLAYING || G.state === STATE.ENDED;
  if (G.state === STATE.PLAYING && st.shrinking && !wasShrinking) {
    hud.banner('Storm closing', 'Move inside the white circle', 3, 'storm');
    audio.storm();
  }
  wasShrinking = st.shrinking;
  const sdx = cam.position.x - storm.x, sdz = cam.position.z - storm.z;
  const outside = inGame && stormOn && sdx * sdx + sdz * sdz > storm.r * storm.r;

  if (G.state === STATE.COUNTDOWN && G.joined) {
    const n = Math.ceil(G.timer);
    if (n !== lastCount && n > 0 && n <= 5) { lastCount = n; hud.banner(String(n), 'Get ready', 1.2, 'count'); audio.count(); }
  }

  if (G.joined) {
    hud.prompt(combat.chest && alive && !input.touchMode ? 'E' : '', 'Open chest');
    const tb = alive && !build.active && you.slot === 0 && combat.target && !combat.chest ? TARGET_INFO[combat.target.block] : null;
    if (tb) hud.targetLabel(tb[0], tb[1], tb[2]); else hud.targetLabel('');
    hud.setSpectate(inGame && !you.alive ? specName : '');
    hudOpts.now = now; hudOpts.scope = scoped && alive ? combat.zoom : 0; hudOpts.outside = outside;
    hudOpts.underwater = cam.position.y < WORLD.SEA - 0.2; hudOpts.build = build;
    hudOpts.spread = combat.spread; hudOpts.showCross = alive;
    hud.frame(dt, hudOpts);
    minimap.draw(dt, alive ? player.pos[0] : cam.position.x, alive ? player.pos[2] : cam.position.z, player.yaw, Object.assign(mmStorm, st, storm), stormOn);
    if (hud.debugOn) {
      hud.setDebug(`fps ${fps.toFixed(0)}  frame ${(1000 / Math.max(fps, 1)).toFixed(0)} ms  ping ${net.ping} ms\nrender ${renderer ? Math.round(innerWidth * renderer.scale) + 'x' + Math.round(innerHeight * renderer.scale) + ' (' + renderer.scale.toFixed(2) + 'x, ' + G.settings.gfx + ')' : 'off'}  hitches ${hitches}\ngame code ${jsMs.toFixed(1)} ms of each frame${renderer && renderer.lite ? '  lite' : ''}\ngpu ${renderer ? renderer.gpu.slice(0, 60) : '-'}${renderer && renderer.software ? '  << SOFTWARE RENDERING' : ''}\ntris ${debug.triangles}  dirty ${debug.dirtyChunks}\npos ${player.pos[0].toFixed(1)} ${player.pos[1].toFixed(1)} ${player.pos[2].toFixed(1)}\nstate ${G.state}  players ${G.players.size}`);
    } else hud.setDebug('');
  }

  if (alive && net.open && now - lastPosSent >= 50) {
    lastPosSent = now;
    const p = player.s.p;
    net.send({ t: 'pos', p: [r2(p[0]), r2(p[1]), r2(p[2])], yaw: r4(player.yaw), pitch: r4(player.pitch) });
  }

  if (renderer) {
    const left = renderer.updateChunks(cam.position.x, cam.position.z, loading ? 16 : 3, loading ? 14 : 5);
    if (loading && left === 0) { loading = false; hud.setLoading(false); }
    renderer.setOutline(alive ? combat.target : null, combat.chest);
    renderer.setStorm(storm.x, storm.z, storm.r, stormOn);
    renderer.vmVisible = alive && !(scoped && combat.zoom > 0.85);
    renderer.render(time, dt);
    debug.dirtyChunks = left;
    debug.triangles = renderer.stats.tris;
  }
  debug.fps = fps; debug.ping = net.ping; debug.loading = loading;
  jsMs += (performance.now() - jsT0 - jsMs) * 0.05;
}
const mmStorm = {};
const FIRE = [1, 0.5, 0.1];
// block id -> [name, what the pickaxe yields, material]
const TARGET_INFO = {
  [B.LOG]: ['Tree trunk', '+4 wood', 'wood'], [B.LEAVES]: ['Leaves', '+1 wood', 'wood'], [B.PLANKS]: ['Wood wall', '+1 wood', 'wood'],
  [B.STONE]: ['Stone', '+4 stone', 'stone'], [B.BRICK]: ['Stone wall', '+1 stone', 'stone'],
  [B.ORE]: ['Metal ore', '+4 metal', 'metal'], [B.METAL]: ['Metal wall', '+1 metal', 'metal'],
  [B.GRASS]: ['Grass', 'no resources', null], [B.DIRT]: ['Dirt', 'no resources', null], [B.SAND]: ['Sand', 'no resources', null],
  [B.BEDROCK]: ['Bedrock', 'unbreakable', null],
};
const hudOpts = { now: 0, scope: 0, outside: false, underwater: false, build: null, spread: 0, showCross: false };
let specId = -1, specText = '', respN = -1, respText = '';

// ------------------------------------------------------------------ boot
setWorld(20240607, null); // backdrop island for the title screen; replaced on welcome
lobby.setVisible(true);
net.connect();
requestAnimationFrame(frame);
