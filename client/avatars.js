// Remote players (humans and bots): blocky avatars with name tags, drawn 100 ms in the
// past and interpolated between server snapshots.
import * as THREE from 'three';
import { G, isVec3, isNum } from './state.js';
import { WEAPONS, WEAPON_IDS } from '../shared/constants.js';

const INTERP_MS = 100;
const BUF = 12;
const geo = new THREE.BoxGeometry(1, 1, 1);
const SKIN = [0xf1c9a5, 0xd9a577, 0xb07b52, 0x8a5a3c, 0xf5d7b8];
const HELD = [0x9aa3ad, 0x2d3b48, 0x23262b, 0x39463a, 0x4d5a3a, 0xdfe7ee];

function hashId(id) {
  const s = String(id);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function idColor(id) {
  const h = hashId(id);
  return new THREE.Color().setHSL(((h % 360) / 360), 0.68, 0.56);
}

function part(parent, mat, w, h, d, x, y, z) {
  const m = new THREE.Mesh(geo, mat);
  m.scale.set(w, h, d);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

function makeTag(name) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const tex = new THREE.CanvasTexture(c);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false }));
  sprite.scale.set(2.2, 0.55, 1);
  sprite.position.y = 2.3;
  sprite.renderOrder = 6; // after the water plane (2) and storm wall (3)
  sprite.userData.canvas = c;
  drawTag(sprite, name);
  return sprite;
}
function drawTag(sprite, name, mate = false) {
  const c = sprite.userData.canvas, g = c.getContext('2d');
  g.clearRect(0, 0, 256, 64);
  g.font = '600 30px system-ui, sans-serif';
  const w = Math.min(240, g.measureText(name).width + 28);
  g.fillStyle = mate ? 'rgba(22,120,62,0.85)' : 'rgba(10,16,28,0.62)';
  g.beginPath();
  if (g.roundRect) g.roundRect(128 - w / 2, 10, w, 44, 12); else g.rect(128 - w / 2, 10, w, 44);
  g.fill();
  g.fillStyle = '#f4f7fb';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(name, 128, 33, 230);
  sprite.material.map.needsUpdate = true;
  sprite.userData.name = name;
  sprite.userData.mate = mate;
}

// Head styles (index matches HEADS in shared/constants.js). Each adds a few boxes to the
// head group on top of the plain skin cube + eyes.
function buildHead(head, style, m) {
  const P = (mat, w, h, d, x, y, z) => part(head, mat, w, h, d, x, y, z);
  P(m.skin, 0.46, 0.46, 0.46, 0, 0.23, 0);
  if (style !== 3) { // eyes + mouth
    P(m.dark, 0.09, 0.09, 0.03, -0.11, 0.29, -0.235);
    P(m.dark, 0.09, 0.09, 0.03, 0.11, 0.29, -0.235);
    P(m.dark, 0.16, 0.035, 0.03, 0, 0.13, -0.235);
  }
  switch (style) {
    case 1: // beanie with pom
      P(m.shirt, 0.5, 0.2, 0.5, 0, 0.5, 0); P(m.light, 0.52, 0.07, 0.52, 0, 0.41, 0); P(m.light, 0.14, 0.14, 0.14, 0, 0.67, 0); break;
    case 2: // helmet
      P(m.steel, 0.54, 0.26, 0.54, 0, 0.5, 0); P(m.steel, 0.06, 0.3, 0.5, -0.26, 0.27, 0.02); P(m.steel, 0.06, 0.3, 0.5, 0.26, 0.27, 0.02); P(m.shirt, 0.56, 0.05, 0.56, 0, 0.4, 0); break;
    case 3: // visor robot
      P(m.steel, 0.5, 0.5, 0.5, 0, 0.23, 0); P(m.glow, 0.42, 0.14, 0.03, 0, 0.28, -0.26); P(m.dark, 0.03, 0.22, 0.03, 0.12, 0.58, 0); P(m.glow, 0.08, 0.08, 0.08, 0.12, 0.72, 0); break;
    case 4: // mohawk
      for (let i = 0; i < 4; i++) P(m.shirt, 0.1, 0.16 + (i === 1 || i === 2 ? 0.08 : 0), 0.11, 0, 0.53 + (i === 1 || i === 2 ? 0.04 : 0), -0.17 + i * 0.115);
      break;
    case 5: // animal ears + snout
      P(m.shirt, 0.14, 0.2, 0.08, -0.15, 0.55, 0); P(m.shirt, 0.14, 0.2, 0.08, 0.15, 0.55, 0); P(m.light, 0.08, 0.12, 0.09, -0.15, 0.54, -0.01); P(m.light, 0.08, 0.12, 0.09, 0.15, 0.54, -0.01); P(m.light, 0.16, 0.1, 0.06, 0, 0.17, -0.25); break;
    case 6: // top hat
      P(m.dark, 0.62, 0.05, 0.62, 0, 0.48, 0); P(m.dark, 0.4, 0.34, 0.4, 0, 0.67, 0); P(m.shirt, 0.42, 0.07, 0.42, 0, 0.54, 0); break;
    case 7: // crown
      P(m.gold, 0.5, 0.1, 0.5, 0, 0.5, 0);
      for (const [x, z] of [[-0.2, -0.2], [0.2, -0.2], [-0.2, 0.2], [0.2, 0.2], [0, -0.2], [0, 0.2]]) P(m.gold, 0.09, 0.12, 0.09, x, 0.6, z);
      P(m.glow, 0.07, 0.07, 0.03, 0, 0.5, -0.255); break;
    default: // cap with brim
      P(m.shirt, 0.5, 0.14, 0.5, 0, 0.5, 0); P(m.shirt, 0.44, 0.04, 0.2, 0, 0.45, -0.32);
  }
}

class Avatar {
  constructor(id, name, headStyle = 0) {
    this.id = id;
    const h = hashId(id);
    const shirt = new THREE.MeshLambertMaterial({ color: idColor(id) });
    const pants = new THREE.MeshLambertMaterial({ color: new THREE.Color().setHSL((((h >> 9) % 360) / 360), 0.3, 0.26) });
    const skin = new THREE.MeshLambertMaterial({ color: SKIN[h % SKIN.length] });
    const dark = new THREE.MeshLambertMaterial({ color: 0x151a22 });
    this.heldMat = new THREE.MeshLambertMaterial({ color: HELD[0] });
    const light = new THREE.MeshLambertMaterial({ color: 0xf2efe6 });
    const steel = new THREE.MeshLambertMaterial({ color: 0x8b97a6 });
    const gold = new THREE.MeshLambertMaterial({ color: 0xf4c430 });
    const glow = new THREE.MeshBasicMaterial({ color: 0x6ff3ff });
    this.headMats = { shirt, skin, dark, light, steel, gold, glow };
    this.mats = [shirt, pants, skin, dark, this.heldMat, light, steel, gold, glow];
    const g = this.group = new THREE.Group();
    this.legL = new THREE.Group(); this.legL.position.set(-0.13, 0.75, 0); g.add(this.legL);
    this.legR = new THREE.Group(); this.legR.position.set(0.13, 0.75, 0); g.add(this.legR);
    part(this.legL, pants, 0.24, 0.75, 0.24, 0, -0.375, 0);
    part(this.legR, pants, 0.24, 0.75, 0.24, 0, -0.375, 0);
    part(g, shirt, 0.52, 0.7, 0.28, 0, 1.1, 0);
    this.armL = new THREE.Group(); this.armL.position.set(-0.36, 1.4, 0); g.add(this.armL);
    this.armR = new THREE.Group(); this.armR.position.set(0.36, 1.4, 0); g.add(this.armR);
    part(this.armL, shirt, 0.2, 0.42, 0.2, 0, -0.16, 0);
    part(this.armL, skin, 0.19, 0.26, 0.19, 0, -0.5, 0);
    part(this.armR, shirt, 0.2, 0.42, 0.2, 0, -0.16, 0);
    part(this.armR, skin, 0.19, 0.26, 0.19, 0, -0.5, 0);
    this.held = part(this.armR, this.heldMat, 0.09, 0.6, 0.09, 0, -0.78, -0.02);
    this.head = new THREE.Group(); this.head.position.set(0, 1.45, 0); g.add(this.head);
    this.headStyle = -1;
    this.setHead(headStyle);
    this.tag = makeTag(name);
    g.add(this.tag);
    g.visible = false;

    this.buf = [];
    for (let i = 0; i < BUF; i++) this.buf.push({ t: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0 });
    this.n = 0;        // snapshots stored (ring, newest at (w-1))
    this.w = 0;
    this.pos = new THREE.Vector3();
    this.yaw = 0; this.pitch = 0;
    this.alive = true; this.slot = 0; this.hp = 100; this.sh = 0; this.team = 0;
    this.walkT = 0; this.walkAmp = 0; this.fireT = 0;
  }

  setHead(style) {
    style = style | 0;
    if (style === this.headStyle) return;
    this.headStyle = style;
    this.head.clear();
    buildHead(this.head, style, this.headMats);
  }

  push(t, p, yaw, pitch) {
    const e = this.buf[this.w];
    e.t = t; e.x = p[0]; e.y = p[1]; e.z = p[2]; e.yaw = yaw; e.pitch = pitch;
    this.w = (this.w + 1) % BUF;
    if (this.n < BUF) this.n++;
  }

  sample(rt) {
    if (this.n === 0) return false;
    let a = null, b = null; // a: newest with t <= rt, b: oldest with t > rt
    for (let i = 1; i <= this.n; i++) {
      const e = this.buf[(this.w - i + BUF * 2) % BUF];
      if (e.t <= rt) { a = e; break; }
      b = e;
    }
    if (!a) a = b;
    if (!b) b = a;
    let k = b.t > a.t ? (rt - a.t) / (b.t - a.t) : 0;
    if (k < 0) k = 0; else if (k > 1) k = 1;
    // a teleport (respawn / correction) should not be smeared across the map
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    if (dx * dx + dy * dy + dz * dz > 100) k = 1;
    const px = this.pos.x, pz = this.pos.z;
    this.pos.set(a.x + dx * k, a.y + dy * k, a.z + dz * k);
    let dyaw = b.yaw - a.yaw;
    dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
    this.yaw = a.yaw + dyaw * k;
    this.pitch = a.pitch + (b.pitch - a.pitch) * k;
    this._moved = Math.hypot(this.pos.x - px, this.pos.z - pz);
    return true;
  }

  dispose() {
    for (const m of this.mats) m.dispose();
    this.tag.material.map.dispose();
    this.tag.material.dispose();
  }
}

export class Avatars {
  constructor(scene) {
    this.scene = scene;
    this.map = new Map();
  }

  get(id) { return this.map.get(id); }

  ensure(id) {
    let a = this.map.get(id);
    if (!a) {
      const info = G.players.get(id);
      a = new Avatar(id, info ? info.name : 'Player', info ? info.head | 0 : 0);
      this.map.set(id, a);
      this.scene.add(a.group);
    }
    return a;
  }

  setHead(id, style) { const a = this.map.get(id); if (a) a.setHead(style); }

  setName(id, name) {
    const a = this.map.get(id);
    if (a && a.tag.userData.name !== name) drawTag(a.tag, name);
  }

  remove(id) {
    const a = this.map.get(id);
    if (!a) return;
    this.scene.remove(a.group);
    a.dispose();
    this.map.delete(id);
  }

  clear() { for (const id of [...this.map.keys()]) this.remove(id); }

  onSnap(list, now) {
    if (!Array.isArray(list)) return;
    for (const p of list) {
      if (!p || p.id === undefined || p.id === G.id || !isVec3(p.p)) continue;
      const a = this.ensure(p.id);
      a.push(now, p.p, isNum(p.yaw) ? p.yaw : 0, isNum(p.pitch) ? p.pitch : 0);
      a.alive = p.alive !== false;
      if (isNum(p.slot)) a.slot = p.slot | 0;
      if (isNum(p.hp)) a.hp = p.hp;
      if (isNum(p.sh)) a.sh = p.sh;
      if (isNum(p.tm)) a.team = p.tm;
    }
  }

  fired(id) { const a = this.map.get(id); if (a) a.fireT = 0.18; }

  update(now, dt, cam) {
    const rt = now - INTERP_MS;
    for (const a of this.map.values()) {
      const ok = a.sample(rt);
      const g = a.group;
      g.visible = ok && a.alive;
      if (!g.visible) continue;
      g.position.copy(a.pos);
      g.rotation.y = a.yaw;
      a.head.rotation.x = a.pitch;
      const speed = dt > 0 ? a._moved / dt : 0;
      a.walkAmp += (Math.min(1, speed / 5) - a.walkAmp) * Math.min(1, dt * 10);
      a.walkT += dt * (4 + speed * 1.3);
      const sw = Math.sin(a.walkT) * 0.8 * a.walkAmp;
      a.legL.rotation.x = sw; a.legR.rotation.x = -sw;
      a.armL.rotation.x = -sw * 0.8;
      a.fireT = Math.max(0, a.fireT - dt);
      const hw = WEAPONS[WEAPON_IDS[a.slot]];
      const gun = !!hw && !hw.melee;
      // bazooka is a fat tube, the sword a long thin blade
      const hs = a.slot === 4 ? 2.2 : 1, hl = a.slot === 5 ? 1.35 : 1;
      if (a.held.userData.s !== a.slot) { a.held.userData.s = a.slot; a.held.scale.set(0.09 * hs, 0.6 * hl, 0.09 * hs); }
      const kick = a.fireT * (gun ? 1.2 : -6);
      a.armR.rotation.x = gun ? Math.PI / 2 + a.pitch + kick : sw * 0.8 + 0.25 + kick + (a.fireT > 0 ? 1.1 : 0);
      const hc = HELD[a.slot] !== undefined ? HELD[a.slot] : HELD[0];
      if (a.heldMat.color.getHex() !== hc) a.heldMat.color.setHex(hc);
      const dx = a.pos.x - cam.position.x, dz = a.pos.z - cam.position.z;
      // teammates get a green tag that stays readable from far away
      const mate = !!G.team && a.team === G.team;
      if (a.tag.userData.mate !== mate) drawTag(a.tag, a.tag.userData.name, mate);
      a.tag.visible = dx * dx + dz * dz < (mate ? 200 * 200 : 55 * 55);
    }
  }
}
