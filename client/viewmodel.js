// First-person held item: blocky tools built from boxes, with swing, recoil, sway,
// bob and a quick swap animation. Lives in the renderer's viewmodel scene.
import * as THREE from 'three';
import { BLOCKS, MAT_BLOCK, MATS } from '../shared/constants.js';

const geo = new THREE.BoxGeometry(1, 1, 1);
const mats = new Map();
function mat(color) {
  let m = mats.get(color);
  if (!m) { m = new THREE.MeshLambertMaterial({ color }); mats.set(color, m); }
  return m;
}
function box(parent, w, h, d, color, x, y, z) {
  const m = new THREE.Mesh(geo, mat(color));
  m.scale.set(w, h, d);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

function makePickaxe() {
  const g = new THREE.Group();
  box(g, 0.05, 0.56, 0.05, 0x8a5a2e, 0, 0.05, 0);
  box(g, 0.09, 0.09, 0.4, 0x9aa3ad, 0, 0.33, 0);
  box(g, 0.07, 0.07, 0.1, 0xc8d0d8, 0, 0.31, -0.24);
  box(g, 0.07, 0.07, 0.1, 0xc8d0d8, 0, 0.31, 0.24);
  box(g, 0.065, 0.08, 0.065, 0x3a2a1a, 0, -0.2, 0);
  g.rotation.set(0.35, 0.3, -0.3);
  g.position.set(0.02, -0.06, -0.12);
  g.scale.setScalar(0.62);
  return g;
}
function makeRifle() {
  const g = new THREE.Group();
  box(g, 0.07, 0.1, 0.46, 0x2d3b48, 0, 0, -0.05);
  box(g, 0.035, 0.035, 0.3, 0x161b22, 0, 0.015, -0.42);
  box(g, 0.06, 0.09, 0.22, 0x5e4630, 0, -0.02, 0.28);
  box(g, 0.05, 0.16, 0.07, 0x1b232c, 0, -0.12, -0.06);
  box(g, 0.05, 0.12, 0.06, 0x3c2e22, 0, -0.1, 0.12);
  box(g, 0.025, 0.04, 0.05, 0xffb000, 0, 0.07, -0.2);
  g.userData.muzzle = -0.6;
  return g;
}
function makeShotgun() {
  const g = new THREE.Group();
  box(g, 0.075, 0.075, 0.6, 0x23262b, 0, 0.02, -0.2);
  box(g, 0.09, 0.07, 0.2, 0x8a5a2e, 0, -0.045, -0.26);
  box(g, 0.075, 0.11, 0.2, 0x3a3f46, 0, -0.01, 0.12);
  box(g, 0.065, 0.1, 0.24, 0x8a5a2e, 0, -0.04, 0.32);
  g.userData.muzzle = -0.54;
  return g;
}
function makeSniper() {
  const g = new THREE.Group();
  box(g, 0.06, 0.085, 0.5, 0x39463a, 0, 0, 0);
  box(g, 0.03, 0.03, 0.5, 0x14181c, 0, 0.012, -0.48);
  box(g, 0.05, 0.05, 0.08, 0x14181c, 0, 0.012, -0.74);
  box(g, 0.055, 0.055, 0.24, 0x101418, 0, 0.085, -0.04);
  box(g, 0.065, 0.065, 0.03, 0x3fd6ff, 0, 0.085, -0.17);
  box(g, 0.055, 0.1, 0.26, 0x4c3a28, 0, -0.03, 0.34);
  box(g, 0.045, 0.12, 0.05, 0x14181c, 0, -0.1, 0.1);
  g.userData.muzzle = -0.82;
  return g;
}

export class ViewModel {
  constructor(scene) {
    this.root = new THREE.Group();
    scene.add(this.root);
    this.items = [makePickaxe(), makeRifle(), makeShotgun(), makeSniper()];
    this.buildItem = new THREE.Group();
    this.buildCube = box(this.buildItem, 0.17, 0.17, 0.17, 0xffffff, 0, 0, -0.1);
    this.buildCube.material = new THREE.MeshLambertMaterial({ color: 0xffffff });
    this.buildCube.rotation.set(0.3, 0.6, 0);
    box(this.buildItem, 0.2, 0.02, 0.26, 0xdce8f5, 0, -0.11, -0.08);
    this.items.push(this.buildItem);
    this.arm = box(this.root, 0.1, 0.1, 0.42, 0xd9a577, 0.03, -0.16, 0.3);
    this.arm.rotation.x = 0.35;
    for (const it of this.items) { it.visible = false; this.root.add(it); }
    this.flash = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: 0xffe08a, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.flash.visible = false;
    this.root.add(this.flash);

    this.current = -1;
    this.swap = 1;      // 1 = lowered, 0 = ready
    this.swing = 0;     // 1 -> 0
    this.kickZ = 0; this.kickR = 0;
    this.swayX = 0; this.swayY = 0;
    this.flashT = 0;
    this.show(0);
  }

  // index 0..3 weapon slots, 4 = build tool
  show(i) {
    if (i === this.current) return;
    this.current = i;
    for (let k = 0; k < this.items.length; k++) this.items[k].visible = k === i;
    this.swap = 1;
    this.flash.visible = false;
  }

  setBuildMat(matIdx) {
    const def = BLOCKS[MAT_BLOCK[MATS[matIdx]]];
    if (def) this.buildCube.material.color.setHex(def.color);
  }

  swingNow() { this.swing = 1; }

  fire(strength) {
    this.kickZ = Math.min(0.16, this.kickZ + 0.05 * strength);
    this.kickR = Math.min(0.5, this.kickR + 0.12 * strength);
    const it = this.items[this.current];
    if (it && it.userData.muzzle !== undefined) {
      this.flashT = 0.05;
      this.flash.visible = true;
      this.flash.position.set(0, 0.015, it.userData.muzzle - 0.05);
      const s = 0.09 + Math.random() * 0.07;
      this.flash.scale.set(s, s, s * 1.6);
      this.flash.rotation.z = Math.random() * Math.PI;
    }
  }

  update(dt, mouseDx, mouseDy, bobT, bobAmp, airborne, zoom) {
    const k = Math.min(1, dt * 12);
    this.swap -= this.swap * Math.min(1, dt * 11);
    this.swing = Math.max(0, this.swing - dt * 4.2);
    this.kickZ -= this.kickZ * Math.min(1, dt * 14);
    this.kickR -= this.kickR * Math.min(1, dt * 12);
    const tx = Math.max(-0.05, Math.min(0.05, -mouseDx * 0.0012));
    const ty = Math.max(-0.05, Math.min(0.05, mouseDy * 0.0012));
    this.swayX += (tx - this.swayX) * k;
    this.swayY += (ty - this.swayY) * k;
    if (this.flashT > 0) { this.flashT -= dt; if (this.flashT <= 0) this.flash.visible = false; }

    const sw = Math.sin((1 - this.swing) * Math.PI) * (this.swing > 0 ? 1 : 0);
    const r = this.root;
    const aim = zoom; // 0..1, pulls the item toward the centre line
    r.position.set(
      0.27 * (1 - aim * 0.85) + this.swayX + Math.cos(bobT * 0.5) * 0.012 * bobAmp,
      -0.25 + aim * 0.06 + this.swayY - this.swap * 0.4 + Math.sin(bobT) * 0.012 * bobAmp - (airborne ? 0.015 : 0) - sw * 0.1,
      -0.5 + this.kickZ - sw * 0.16,
    );
    r.rotation.set(this.kickR * 0.6 - sw * 1.15 + this.swap * 0.6, this.swayX * 1.5 + sw * 0.25, this.swayX * -1.2 + sw * 0.2);
  }
}
