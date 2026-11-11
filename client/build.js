// Build mode: piece / material / rotation selection, ghost preview and placement.
import * as THREE from 'three';
import { PIECES, PIECE_COST, MATS, BUILD_RANGE, PLAYER, STATE, B } from '../shared/constants.js';
import { raycast, pieceCells } from '../shared/world.js';
import { G } from './state.js';

const HW = PLAYER.WIDTH / 2;
const MAX_CELLS = 16;

function boxHitsCell(px, py, pz, x, y, z) {
  return px + HW > x && px - HW < x + 1 && pz + HW > z && pz - HW < z + 1 && py + PLAYER.HEIGHT > y && py < y + 1;
}

export class BuildMode {
  constructor(scene, net) {
    this.net = net;
    this.active = false;
    this.piece = 0;
    this.mat = 0;
    this.rot = 0;
    this.anchor = [0, 0, 0];
    this.facing = 0;
    this.valid = false;
    this.canAfford = false;
    this.nextPlace = 0;
    this.onPlace = null; // () => void (sound / viewmodel)
    this.onDeny = null;

    this.okMat = new THREE.MeshBasicMaterial({ color: 0x5dff9a, transparent: true, opacity: 0.38, depthWrite: false });
    this.ghost = new THREE.InstancedMesh(new THREE.BoxGeometry(1.01, 1.01, 1.01), this.okMat, MAX_CELLS);
    this.ghost.count = 0;
    this.ghost.frustumCulled = false;
    this.ghost.visible = false;
    this.ghost.renderOrder = 4;
    scene.add(this.ghost);
    this._m = new THREE.Matrix4();
  }

  toggle(on) {
    this.active = on === undefined ? !this.active : on;
    if (!this.active) this.ghost.visible = false;
  }

  cycleMat(dir = 1) { this.mat = (this.mat + dir + MATS.length) % MATS.length; }
  rotate() { this.rot = (this.rot + 1) % 4; }
  get pieceName() { return PIECES[this.piece]; }
  get matName() { return MATS[this.mat]; }

  _blockedByPlayer(x, y, z, self, avatars) {
    if (G.you.alive && boxHitsCell(self[0], self[1], self[2], x, y, z)) return true;
    for (const a of avatars.map.values()) {
      if (a.alive && a.n > 0 && boxHitsCell(a.pos.x, a.pos.y, a.pos.z, x, y, z)) return true;
    }
    return false;
  }

  // eye/dir: arrays; self: feet position array. Recomputes anchor + ghost each frame.
  update(world, eye, dir, yaw, self, avatars) {
    if (!this.active || !world) { this.ghost.visible = false; return; }
    const hit = raycast(world, eye, dir, BUILD_RANGE);
    const a = this.anchor;
    if (hit && (hit.nx || hit.ny || hit.nz)) {
      a[0] = hit.x + hit.nx; a[1] = hit.y + hit.ny; a[2] = hit.z + hit.nz;
    } else {
      a[0] = Math.floor(self[0] - Math.sin(yaw) * 3);
      a[1] = Math.floor(self[1] + 0.01);
      a[2] = Math.floor(self[2] - Math.cos(yaw) * 3);
    }
    const base = Math.round(yaw / (Math.PI / 2));
    this.facing = (((base + this.rot) % 4) + 4) % 4;
    const piece = PIECES[this.piece];
    const cells = pieceCells(piece, a[0], a[1], a[2], this.facing);
    let n = 0, free = 0;
    for (let i = 0; i < cells.length && n < MAX_CELLS; i++) {
      const c = cells[i];
      if (!world.inBounds(c[0], c[1], c[2]) || world.get(c[0], c[1], c[2]) !== B.AIR) continue;
      if (!this._blockedByPlayer(c[0], c[1], c[2], self, avatars)) free++;
      this._m.makeTranslation(c[0] + 0.5, c[1] + 0.5, c[2] + 0.5);
      this.ghost.setMatrixAt(n++, this._m);
    }
    this.canAfford = (G.you.mats[MATS[this.mat]] || 0) >= PIECE_COST[piece];
    const stateOk = G.state === STATE.PLAYING || G.state === STATE.LOBBY;
    this.valid = free > 0 && this.canAfford && stateOk && G.you.alive;
    this.okMat.color.setHex(this.valid ? 0x5dff9a : 0xff5a5a);
    this.ghost.count = n;
    this.ghost.instanceMatrix.needsUpdate = true;
    this.ghost.visible = n > 0;
  }

  // Called while LMB is held; repeats at most 8 times per second.
  tryPlace(now, pressed) {
    if (!this.active || now < this.nextPlace) return false;
    if (!this.valid) {
      if (pressed && this.onDeny) this.onDeny(this.canAfford ? 'blocked' : 'mats');
      this.nextPlace = now + 125;
      return false;
    }
    this.nextPlace = now + 130;
    const a = this.anchor;
    this.net.send({ t: 'build', piece: PIECES[this.piece], x: a[0], y: a[1], z: a[2], facing: this.facing, mat: MATS[this.mat] });
    if (this.onPlace) this.onPlace();
    return true;
  }
}
