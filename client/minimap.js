// Minimap: a top-down colour map rendered once per world into an offscreen canvas,
// then composited with the storm circles and the player's arrow a few times a second.
import { WORLD, BLOCKS, B } from '../shared/constants.js';
import { theme, blockTopHex } from './theme.js';

const { SX, SZ, SEA } = WORLD;

export class Minimap {
  constructor(canvas) {
    this.canvas = canvas;
    this.g = canvas ? canvas.getContext('2d') : null;
    this.base = document.createElement('canvas');
    this.base.width = SX; this.base.height = SZ;
    this.ready = false;
    this.acc = 0;
  }

  build(world) {
    const g = this.base.getContext('2d');
    const img = g.createImageData(SX, SZ);
    const d = img.data;
    for (let z = 0; z < SZ; z++) {
      for (let x = 0; x < SX; x++) {
        const y = world.surfaceY(x, z);
        const o = (x + z * SX) * 4;
        let r, gg, b;
        if (y < SEA) {
          const depth = Math.min(1, (SEA - Math.max(0, y)) / 9);
          const wc = theme.def.water, k = 1 - depth * 0.4;
          r = ((wc >> 16) & 255) * k; gg = ((wc >> 8) & 255) * k; b = (wc & 255) * k;
        } else {
          const id = world.get(x, y, z);
          const hex = blockTopHex(BLOCKS[id] ? id : B.GRASS);
          // light from the north-west: compare with the neighbouring column
          const yn = world.surfaceY(x - 1, z - 1);
          const sh = 0.86 + Math.max(-0.22, Math.min(0.22, (y - yn) * 0.08)) + (y - SEA) * 0.006;
          r = ((hex >> 16) & 255) * sh; gg = ((hex >> 8) & 255) * sh; b = (hex & 255) * sh;
        }
        d[o] = r; d[o + 1] = gg; d[o + 2] = b; d[o + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    this.ready = true;
    this.acc = 1;
  }

  // storm: {x,z,r,tx,tz,tr}; showStorm false in the lobby
  draw(dt, px, pz, yaw, storm, showStorm) {
    this.acc += dt;
    if (this.acc < 0.1 || !this.g || !this.ready) return;
    this.acc = 0;
    const g = this.g, W = this.canvas.width, H = this.canvas.height;
    const s = W / SX;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.imageSmoothingEnabled = false;
    g.clearRect(0, 0, W, H);
    g.drawImage(this.base, 0, 0, W, H);
    if (showStorm) {
      // dim everything outside the current circle
      g.save();
      g.beginPath();
      g.rect(0, 0, W, H);
      g.arc(storm.x * s, storm.z * s, Math.max(0, storm.r * s), 0, Math.PI * 2, true);
      g.fillStyle = 'rgba(128, 60, 220, 0.45)';
      g.fill('evenodd');
      g.restore();
      g.lineWidth = 2;
      g.strokeStyle = '#c59bff';
      g.beginPath(); g.arc(storm.x * s, storm.z * s, Math.max(0, storm.r * s), 0, Math.PI * 2); g.stroke();
      if (storm.tr < storm.r - 0.5) {
        g.setLineDash([4, 4]);
        g.lineWidth = 1.5;
        g.strokeStyle = '#ffffff';
        g.beginPath(); g.arc(storm.tx * s, storm.tz * s, Math.max(0.5, storm.tr * s), 0, Math.PI * 2); g.stroke();
        g.setLineDash([]);
        const dx = px - storm.tx, dz = pz - storm.tz;
        if (dx * dx + dz * dz > storm.tr * storm.tr) {
          g.strokeStyle = 'rgba(255,255,255,0.7)';
          g.lineWidth = 1;
          g.beginPath(); g.moveTo(px * s, pz * s); g.lineTo(storm.tx * s, storm.tz * s); g.stroke();
        }
      }
    }
    // self arrow (yaw 0 faces -Z = up on the map; positive yaw turns left)
    g.translate(px * s, pz * s);
    g.rotate(-yaw);
    g.beginPath();
    g.moveTo(0, -7); g.lineTo(5, 5); g.lineTo(0, 2.5); g.lineTo(-5, 5); g.closePath();
    g.fillStyle = '#ffffff';
    g.strokeStyle = '#0b1220';
    g.lineWidth = 1.5;
    g.fill(); g.stroke();
    g.setTransform(1, 0, 0, 1, 0, 0);
  }
}
