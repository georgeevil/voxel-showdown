// Pure chunk mesher (no three.js, no DOM): turns one chunk column of a World into
// typed arrays. Hidden faces are culled, colours are baked per vertex (block colour x
// face shade x ambient occlusion x per-block jitter) in linear colour space.
import { WORLD, B, BLOCKS } from '../shared/constants.js';
import { blockHex, blockTopHex } from './theme.js';

const { SX, SY, SZ, CHUNK } = WORLD;
const LAYER = SX * SZ;

// sRGB hex -> linear rgb, precomputed per block id (side colour and top colour).
const s2l = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
function hexLin(hex) {
  return [s2l(((hex >> 16) & 255) / 255), s2l(((hex >> 8) & 255) / 255), s2l((hex & 255) / 255)];
}
const SIDE = new Float32Array(16 * 3);
const TOP = new Float32Array(16 * 3);
const PART = new Float32Array(16 * 3); // plain block colour, for particles
const JIT = new Float32Array(16); // jitter amplitude per block
// (re)build the colour tables for the current theme; call after setTheme()
export function refreshPalette() {
 for (const k of Object.keys(BLOCKS)) {
  const id = +k;
  const s = hexLin(blockHex(id));
  let t = hexLin(blockTopHex(id));
  if (id === B.LOG) t = hexLin(0xb08a55);     // pale cut rings
  if (id === B.CHEST) t = hexLin(0xffd35a);   // bright lid
  // ore: pale base so the atlas can draw dark rock with bright nuggets on top of it
  if (id === B.ORE) { const pale = hexLin(0xd6e4f2); s[0] = t[0] = pale[0]; s[1] = t[1] = pale[1]; s[2] = t[2] = pale[2]; }
  PART.set(hexLin(blockHex(id)), id * 3);
  // grass sides are painted in full colour by the atlas (dirt with a grass fringe)
  if (id === B.GRASS) s[0] = s[1] = s[2] = 1;
  SIDE.set(s, id * 3);
  TOP.set(t, id * 3);
  JIT[id] = id === B.CHEST || id === B.ORE ? 0 : (id === B.BRICK || id === B.PLANKS || id === B.LEAVES || id === B.STONE) ? 0.12 : 0.08;
 }
}
refreshPalette();

export function blockColorLinear(id, out) {
  out[0] = PART[id * 3]; out[1] = PART[id * 3 + 1]; out[2] = PART[id * 3 + 2];
  return out;
}

// Faces: normal n and tangents u,v with u x v = n, so corners (0,0),(1,0),(1,1),(0,1)
// in (u,v) are counter-clockwise seen from outside.
const FACES = [
  { n: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1], shade: 0.74 },
  { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0], shade: 0.60 },
  { n: [0, 1, 0], u: [0, 0, 1], v: [1, 0, 0], shade: 1.0 },
  { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1], shade: 0.42 },
  { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0], shade: 0.84 },
  { n: [0, 0, -1], u: [0, 1, 0], v: [1, 0, 0], shade: 0.52 },
];
const CU = [0, 1, 1, 0];
const CV = [0, 0, 1, 1];
const AO = [0.42, 0.62, 0.82, 1.0];

let cap = 1 << 15; // vertices
let pos = new Float32Array(cap * 3);
let col = new Float32Array(cap * 3);
let uv = new Float32Array(cap * 2);
const ATLAS_COLS = 16, UV_IN = 0.002; // must match textures.js
let idx = new Uint32Array(cap * 1.5);
function grow() {
  cap *= 2;
  const p = new Float32Array(cap * 3); p.set(pos); pos = p;
  const c = new Float32Array(cap * 3); c.set(col); col = c;
  const t = new Float32Array(cap * 2); t.set(uv); uv = t;
  const i = new Uint32Array(cap * 1.5); i.set(idx); idx = i;
}

function hash3(x, y, z) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const ao4 = new Float32Array(4);
const HW = CHUNK + 2;
const hgt = new Int16Array(HW * HW); // top solid y per column, chunk plus a 1-block border

// Meshes chunk column (cx, cz). Returns fresh typed arrays sized exactly, or null when
// the chunk has no visible faces. Scratch buffers are reused across calls.
export function meshChunk(world, cx, cz) {
  const data = world.data;
  const x0 = cx * CHUNK, z0 = cz * CHUNK;
  const x1 = Math.min(x0 + CHUNK, SX), z1 = Math.min(z0 + CHUNK, SZ);
  let nv = 0, ni = 0;

  const solid = (x, y, z) => {
    if (y < 0) return 1;
    if (x < 0 || x >= SX || y >= SY || z < 0 || z >= SZ) return 0;
    return data[x + z * SX + y * LAYER] !== 0 ? 1 : 0;
  };

  // column heights, used for soft shade under trees, roofs and overhangs
  for (let j = 0; j < HW; j++) {
    for (let k = 0; k < HW; k++) {
      const x = x0 + k - 1, z = z0 + j - 1;
      let h = -1;
      if (x >= 0 && x < SX && z >= 0 && z < SZ) {
        const base = x + z * SX;
        for (h = SY - 1; h >= 0; h--) if (data[base + h * LAYER] !== 0) break;
      }
      hgt[k + j * HW] = h;
    }
  }

  for (let y = 0; y < SY; y++) {
    for (let z = z0; z < z1; z++) {
      let i = x0 + z * SX + y * LAYER;
      for (let x = x0; x < x1; x++, i++) {
        const b = data[i];
        if (b === 0) continue;
        let jit = -1;
        for (let f = 0; f < 6; f++) {
          const F = FACES[f], n = F.n;
          const ax = x + n[0], ay = y + n[1], az = z + n[2];
          if (solid(ax, ay, az)) continue;
          if (nv + 4 > cap) grow();
          if (jit < 0) jit = 1 + (hash3(x, y, z) - 0.5) * 2 * JIT[b];
          const u = F.u, v = F.v;
          const src = f === 2 ? TOP : SIDE;
          let shade = F.shade * jit;
          if (b === B.CHEST && f !== 2 && f !== 3) shade *= 1.15;
          // sunlit tops lean warm
          const r = src[b * 3] * shade * (f === 2 ? 1.05 : 1), g = src[b * 3 + 1] * shade, bl = src[b * 3 + 2] * shade * (f === 2 ? 0.93 : 1);
          const bx = x + (n[0] > 0 ? 1 : 0), by = y + (n[1] > 0 ? 1 : 0), bz = z + (n[2] > 0 ? 1 : 0);
          for (let c = 0; c < 4; c++) {
            const su = CU[c] ? 1 : -1, sv = CV[c] ? 1 : -1;
            const s1 = solid(ax + u[0] * su, ay + u[1] * su, az + u[2] * su);
            const s2 = solid(ax + v[0] * sv, ay + v[1] * sv, az + v[2] * sv);
            const sc = solid(ax + u[0] * su + v[0] * sv, ay + u[1] * su + v[1] * sv, az + u[2] * su + v[2] * sv);
            const a = AO[s1 && s2 ? 0 : 3 - s1 - s2 - sc];
            ao4[c] = a;
            const o = (nv + c) * 3;
            const vx = bx + u[0] * CU[c] + v[0] * CV[c], vz = bz + u[2] * CU[c] + v[2] * CV[c];
            pos[o] = vx;
            pos[o + 1] = by + u[1] * CU[c] + v[1] * CV[c];
            pos[o + 2] = vz;
            // shade: of the open columns touching this corner, how many have a roof overhead
            let open = 0, roofed = 0;
            for (let q = 0; q < 4; q++) {
              const qx = vx - (q & 1), qz = vz - (q >> 1);
              const h = hgt[(qx - x0 + 1) + (qz - z0 + 1) * HW];
              if (h < ay) open++;
              else if (!solid(qx, ay, qz)) { open++; roofed++; }
            }
            const sh = open ? roofed / open : 0;
            // shadows lean cool
            col[o] = r * a * (1 - 0.42 * sh); col[o + 1] = g * a * (1 - 0.37 * sh); col[o + 2] = bl * a * (1 - 0.27 * sh);
            // atlas coords from world axes so side textures are always upright
            const wx = u[0] * CU[c] + v[0] * CV[c], wy = u[1] * CU[c] + v[1] * CV[c], wz = u[2] * CU[c] + v[2] * CV[c];
            const tu = n[1] !== 0 ? wx : wx + wz, tv = n[1] !== 0 ? wz : wy;
            const q = (nv + c) * 2;
            uv[q] = (b + UV_IN + tu * (1 - 2 * UV_IN)) / ATLAS_COLS;
            uv[q + 1] = (n[1] !== 0 ? 0 : 0.5) + (UV_IN + tv * (1 - 2 * UV_IN)) * 0.5;
          }
          if (ao4[0] + ao4[2] >= ao4[1] + ao4[3]) {
            idx[ni] = nv; idx[ni + 1] = nv + 1; idx[ni + 2] = nv + 2;
            idx[ni + 3] = nv; idx[ni + 4] = nv + 2; idx[ni + 5] = nv + 3;
          } else {
            idx[ni] = nv + 1; idx[ni + 1] = nv + 2; idx[ni + 2] = nv + 3;
            idx[ni + 3] = nv + 1; idx[ni + 4] = nv + 3; idx[ni + 5] = nv;
          }
          nv += 4; ni += 6;
        }
      }
    }
  }
  if (nv === 0) return null;
  return {
    positions: pos.slice(0, nv * 3),
    colors: col.slice(0, nv * 3),
    uvs: uv.slice(0, nv * 2),
    indices: idx.slice(0, ni),
    vertexCount: nv,
    indexCount: ni,
  };
}

export const CHUNKS_X = Math.ceil(SX / CHUNK);
export const CHUNKS_Z = Math.ceil(SZ / CHUNK);
