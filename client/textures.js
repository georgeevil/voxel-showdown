// Procedural detail atlas for block faces. Each tile is a 16x16 multiplier pattern drawn
// on a canvas (the block's base colour still comes from vertex colours), so resources
// read clearly at a glance: bark stripes on trunks, cracks in stone, bright nuggets in
// ore, seams on planks, mortar on brick, rivets on metal.
// Layout: 16 tiles per row, tile index = block id; row 0 = side faces, row 1 = top/bottom.
import * as THREE from 'three';
import { B } from '../shared/constants.js';
import { blockHex } from './theme.js';

export const TILE = 16;
export const ATLAS_COLS = 16;

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// each painter fills px(x, y, r, g, b) with multipliers in 0..1
const noise = (lo, hi) => (px, r) => { for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) { const v = lo + r() * (hi - lo); px(x, y, v, v, v); } };

const s2l = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const lin = (hex, k = 1) => [s2l(((hex >> 16) & 255) / 255) * k, s2l(((hex >> 8) & 255) / 255) * k, s2l((hex & 255) / 255) * k];

const PAINT = {
  default: noise(0.88, 1),
  // grass side, full colour: dirt with a ragged grass fringe along the top edge
  [B.GRASS]: (px, r) => {
    for (let x = 0; x < TILE; x++) {
      const fringe = 3 + ((r() * 3) | 0);
      for (let y = 0; y < TILE; y++) {
        const c = y < fringe ? lin(blockHex(B.GRASS), 0.86 + r() * 0.14) : lin(blockHex(B.DIRT), (0.8 + r() * 0.2) * (r() < 0.07 ? 0.7 : 1));
        px(x, y, c[0], c[1], c[2]);
      }
    }
  },
  [B.GRASS + 100]: (px, r) => { noise(0.86, 1)(px, r); for (let i = 0; i < 10; i++) { const x = (r() * 16) | 0, y = (r() * 16) | 0; px(x, y, 0.72, 0.78, 0.7); } },
  [B.SAND]: noise(0.9, 1),
  [B.DIRT]: (px, r) => { noise(0.82, 1)(px, r); for (let i = 0; i < 8; i++) { const x = (r() * 16) | 0, y = (r() * 16) | 0; px(x, y, 0.62, 0.62, 0.62); } },
  [B.STONE]: (px, r) => {
    noise(0.84, 1)(px, r);
    for (let c = 0; c < 3; c++) { // cracks
      let x = (r() * 16) | 0, y = (r() * 16) | 0;
      for (let i = 0; i < 7; i++) { px(x & 15, y & 15, 0.6, 0.6, 0.62); if (r() < 0.6) x++; else y++; if (r() < 0.25) y--; }
    }
    for (let i = 0; i < 6; i++) px((r() * 16) | 0, (r() * 16) | 0, 1, 1, 1);
  },
  [B.LOG]: (px, r) => { // vertical bark ridges
    for (let x = 0; x < TILE; x++) {
      const ridge = [1, 0.92, 0.66, 0.84][x % 4];
      for (let y = 0; y < TILE; y++) { const v = ridge * (0.9 + r() * 0.1) * (r() < 0.06 ? 0.7 : 1); px(x, y, v, v * 0.97, v * 0.93); }
    }
  },
  [B.LOG + 100]: (px, r) => { // cut end: growth rings
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      const d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
      const v = d > 7 ? 0.5 : (Math.floor(d) % 2 ? 0.78 : 1) * (0.94 + r() * 0.06);
      px(x, y, v, v, v);
    }
  },
  [B.LEAVES]: (px, r) => { for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) { const q = r(); const v = q < 0.14 ? 0.52 : q < 0.4 ? 0.78 : q > 0.9 ? 1 : 0.9; px(x, y, v, v, v * 0.95); } },
  [B.PLANKS]: (px, r) => {
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      const row = y >> 2, seam = y % 4 === 3, butt = (x + row * 5) % 16 === 0;
      const v = seam || butt ? 0.62 : 0.9 + r() * 0.1 - ((x + row * 3) % 7 === 0 ? 0.08 : 0);
      px(x, y, v, v, v);
    }
  },
  [B.BRICK]: (px, r) => {
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      const row = y >> 2, mortar = y % 4 === 3 || (x + (row % 2) * 4) % 8 === 7;
      const v = mortar ? 0.66 : 0.88 + r() * 0.12;
      px(x, y, v, v, v);
    }
  },
  [B.METAL]: (px, r) => {
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      const edge = x === 0 || y === 0 || x === 15 || y === 15;
      const rivet = (x === 2 || x === 13) && (y === 2 || y === 13);
      const v = edge ? 0.62 : rivet ? 1 : (y % 2 ? 0.9 : 0.84) + r() * 0.04 + (x + y === 15 ? 0.1 : 0);
      px(x, y, v, v, Math.min(1, v * 1.03));
    }
  },
  [B.ORE]: (px, r) => { // dark rock with bright metallic nuggets (base vertex colour is pale)
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) { const v = 0.36 + r() * 0.1; px(x, y, v, v, v * 1.05); }
    for (const [cx, cy] of [[3, 3], [10, 2], [6, 8], [12, 11], [2, 12]]) {
      for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) {
        if ((dx === 0 || dx === 2) && (dy === 0 || dy === 2) && r() < 0.7) continue;
        const hi = dx === 1 && dy === 1;
        px((cx + dx) & 15, (cy + dy) & 15, hi ? 0.85 : 0.45, hi ? 1 : 0.85, 1);
      }
    }
  },
  [B.CHEST]: (px) => {
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      const edge = x === 0 || y === 0 || x === 15 || y === 15;
      const strap = x === 3 || x === 12 || y === 5;
      const lock = x >= 7 && x <= 8 && y >= 5 && y <= 7;
      const v = lock ? 0.25 : edge ? 0.5 : strap ? 0.62 : 1;
      px(x, y, v, v, v);
    }
  },
  [B.BEDROCK]: noise(0.6, 1),
};

export function makeAtlas() {
  const cv = document.createElement('canvas');
  cv.width = TILE * ATLAS_COLS; cv.height = TILE * 2;
  const tex = new THREE.CanvasTexture(cv);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace; // plain multipliers
  paintAtlas(tex);
  return tex;
}

// (re)paint for the current theme (the grass side tile carries theme colours)
export function paintAtlas(tex) {
  const cv = tex.image;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(cv.width, cv.height);
  img.data.fill(255);
  for (let id = 0; id < ATLAS_COLS; id++) {
    for (let row = 0; row < 2; row++) {
      const paint = (row === 1 && PAINT[id + 100]) || PAINT[id] || PAINT.default;
      const r = rng(id * 31 + row * 977 + 5);
      paint((x, y, cr, cg, cb) => {
        const o = ((row * TILE + y) * cv.width + id * TILE + x) * 4;
        img.data[o] = Math.max(0, Math.min(255, cr * 255)); img.data[o + 1] = Math.max(0, Math.min(255, cg * 255)); img.data[o + 2] = Math.max(0, Math.min(255, cb * 255));
      }, r);
    }
  }
  ctx.putImageData(img, 0, 0);
  tex.needsUpdate = true;
}
