// Pooled particles (instanced cubes) and bullet tracers (instanced stretched boxes).
// No allocations per frame: everything lives in preallocated typed arrays.
import * as THREE from 'three';

const PCAP = 640;
const TCAP = 96;
const PS = 8; // px py pz vx vy vz life size
const TS = 10; // ox oy oz dx dy dz len head speed width

export class Effects {
  constructor(scene) {
    const box = new THREE.BoxGeometry(1, 1, 1);
    this.pm = new THREE.InstancedMesh(box, new THREE.MeshBasicMaterial({ color: 0xffffff }), PCAP);
    this.pm.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(PCAP * 3), 3);
    this.pm.count = 0;
    this.pm.frustumCulled = false;
    scene.add(this.pm);
    this.pd = new Float32Array(PCAP * PS);
    this.pn = 0;

    this.tm = new THREE.InstancedMesh(box, new THREE.MeshBasicMaterial({
      color: 0xfff0b8, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    }), TCAP);
    this.tm.count = 0;
    this.tm.frustumCulled = false;
    this.tm.renderOrder = 5;
    scene.add(this.tm);
    this.td = new Float32Array(TCAP * TS);
    this.tn = 0;
  }

  // col: linear rgb array. Spawns `count` chips around (x,y,z).
  burst(x, y, z, col, count, speed = 4, size = 0.12, spread = 0.35) {
    const d = this.pd, c = this.pm.instanceColor.array;
    for (let i = 0; i < count; i++) {
      const k = this.pn < PCAP ? this.pn++ : (Math.random() * PCAP) | 0;
      const o = k * PS;
      d[o] = x + (Math.random() - 0.5) * spread * 2;
      d[o + 1] = y + (Math.random() - 0.5) * spread * 2;
      d[o + 2] = z + (Math.random() - 0.5) * spread * 2;
      d[o + 3] = (Math.random() - 0.5) * speed;
      d[o + 4] = Math.random() * speed * 0.9 + 1;
      d[o + 5] = (Math.random() - 0.5) * speed;
      d[o + 6] = 0.45 + Math.random() * 0.5;
      d[o + 7] = size * (0.6 + Math.random() * 0.8);
      const sh = 0.75 + Math.random() * 0.4;
      c[k * 3] = col[0] * sh; c[k * 3 + 1] = col[1] * sh; c[k * 3 + 2] = col[2] * sh;
    }
    this.pm.instanceColor.needsUpdate = true;
  }

  tracer(ox, oy, oz, ex, ey, ez, width = 0.035, speed = 260) {
    let dx = ex - ox, dy = ey - oy, dz = ez - oz;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!(len > 0.5) || !(len < 1000)) return;
    dx /= len; dy /= len; dz /= len;
    const k = this.tn < TCAP ? this.tn++ : (Math.random() * TCAP) | 0;
    const o = k * TS, d = this.td;
    d[o] = ox; d[o + 1] = oy; d[o + 2] = oz;
    d[o + 3] = dx; d[o + 4] = dy; d[o + 5] = dz;
    d[o + 6] = len; d[o + 7] = Math.min(len, 1.5); d[o + 8] = speed; d[o + 9] = width;
  }

  update(dt, world) {
    // ---- particles ----
    const d = this.pd, m = this.pm.instanceMatrix.array, c = this.pm.instanceColor.array;
    let n = this.pn;
    for (let i = 0; i < n; i++) {
      const o = i * PS;
      d[o + 6] -= dt;
      if (d[o + 6] <= 0) {
        n--;
        if (i !== n) {
          const l = n * PS;
          for (let k = 0; k < PS; k++) d[o + k] = d[l + k];
          c[i * 3] = c[n * 3]; c[i * 3 + 1] = c[n * 3 + 1]; c[i * 3 + 2] = c[n * 3 + 2];
          this.pm.instanceColor.needsUpdate = true;
        }
        i--;
        continue;
      }
      d[o + 4] -= 22 * dt;
      const nx = d[o] + d[o + 3] * dt, ny = d[o + 1] + d[o + 4] * dt, nz = d[o + 2] + d[o + 5] * dt;
      if (world && world.get(Math.floor(nx), Math.floor(ny), Math.floor(nz)) !== 0) {
        d[o + 4] *= -0.3; d[o + 3] *= 0.5; d[o + 5] *= 0.5;
        if (world.get(Math.floor(d[o]), Math.floor(d[o + 1] + d[o + 4] * dt), Math.floor(d[o + 2])) !== 0) d[o + 4] = 0;
      } else {
        d[o] = nx; d[o + 1] = ny; d[o + 2] = nz;
      }
      const s = d[o + 7] * Math.min(1, d[o + 6] * 5), q = i * 16;
      m[q] = s; m[q + 1] = 0; m[q + 2] = 0; m[q + 3] = 0;
      m[q + 4] = 0; m[q + 5] = s; m[q + 6] = 0; m[q + 7] = 0;
      m[q + 8] = 0; m[q + 9] = 0; m[q + 10] = s; m[q + 11] = 0;
      m[q + 12] = d[o]; m[q + 13] = d[o + 1]; m[q + 14] = d[o + 2]; m[q + 15] = 1;
    }
    this.pn = n;
    this.pm.count = n;
    if (n > 0) this.pm.instanceMatrix.needsUpdate = true;

    // ---- tracers ----
    const t = this.td, tm = this.tm.instanceMatrix.array;
    let tn = this.tn;
    for (let i = 0; i < tn; i++) {
      const o = i * TS;
      t[o + 7] += t[o + 8] * dt;
      const len = t[o + 6], head = Math.min(t[o + 7], len);
      const tail = Math.max(0, t[o + 7] - Math.min(14, len * 0.6));
      if (tail >= len) {
        tn--;
        if (i !== tn) { const l = tn * TS; for (let k = 0; k < TS; k++) t[o + k] = t[l + k]; }
        i--;
        continue;
      }
      const dx = t[o + 3], dy = t[o + 4], dz = t[o + 5], w = t[o + 9];
      // basis: z = d, x = up x d (or world x when d is vertical), y = d x x
      let xx = dz, xy = 0, xz = -dx;
      let xl = Math.sqrt(xx * xx + xz * xz);
      if (xl < 1e-4) { xx = 1; xz = 0; xl = 1; }
      xx /= xl; xz /= xl;
      const yx = dy * xz - dz * xy, yy = dz * xx - dx * xz, yz = dx * xy - dy * xx;
      const seg = head - tail, mid = (head + tail) * 0.5, q = i * 16;
      tm[q] = xx * w; tm[q + 1] = xy * w; tm[q + 2] = xz * w; tm[q + 3] = 0;
      tm[q + 4] = yx * w; tm[q + 5] = yy * w; tm[q + 6] = yz * w; tm[q + 7] = 0;
      tm[q + 8] = dx * seg; tm[q + 9] = dy * seg; tm[q + 10] = dz * seg; tm[q + 11] = 0;
      tm[q + 12] = t[o] + dx * mid; tm[q + 13] = t[o + 1] + dy * mid; tm[q + 14] = t[o + 2] + dz * mid; tm[q + 15] = 1;
    }
    this.tn = tn;
    this.tm.count = tn;
    if (tn > 0) this.tm.instanceMatrix.needsUpdate = true;
  }
}
