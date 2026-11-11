// World generation, voxel access, raycast and build-piece shapes.
// Runs unchanged in Node and the browser. Generation uses only mulberry32, integer
// hashing and + - * / sqrt floor, so the same seed gives the same bytes on every engine.

import { THEMES, WORLD, B, CHEST_COUNT } from './constants.js';

const { SX, SY, SZ, SEA } = WORLD;
const CX = SX / 2;
const CZ = SZ / 2;
const ISLAND_R = 70;

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- deterministic value noise (integer lattice hash, no trig / pow) ----

function hash2(ix, iz, s) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + s) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function vnoise(x, z, s) {
  const ix = Math.floor(x), iz = Math.floor(z);
  let fx = x - ix, fz = z - iz;
  fx = fx * fx * (3 - 2 * fx);
  fz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz, s), b = hash2(ix + 1, iz, s);
  const c = hash2(ix, iz + 1, s), d = hash2(ix + 1, iz + 1, s);
  const top = a + (b - a) * fx;
  const bot = c + (d - c) * fx;
  return top + (bot - top) * fz;
}

function fbm(x, z, s, octaves) {
  let sum = 0, amp = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += vnoise(x, z, (s + o * 1013) | 0) * amp;
    norm += amp;
    amp *= 0.5;
    x *= 2;
    z *= 2;
  }
  return sum / norm;
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function isGround(b) {
  return b === B.GRASS || b === B.SAND || b === B.STONE || b === B.DIRT;
}

export class World {
  constructor(seed, theme = 'meadow') {
    this.seed = seed | 0;
    this.theme = Object.hasOwn(THEMES, theme) ? theme : 'meadow';
    this.data = new Uint8Array(SX * SY * SZ);
    this.chests = [];
    this.generate();
  }

  index(x, y, z) {
    return x + z * SX + y * SX * SZ;
  }

  inBounds(x, y, z) {
    return x >= 0 && x < SX && y >= 0 && y < SY && z >= 0 && z < SZ;
  }

  get(x, y, z) {
    if (y < 0) return B.BEDROCK;
    if (x < 0 || x >= SX || y >= SY || z < 0 || z >= SZ) return B.AIR;
    return this.data[x + z * SX + y * SX * SZ];
  }

  set(x, y, z, b) {
    if (!(x >= 0 && x < SX && y >= 0 && y < SY && z >= 0 && z < SZ)) return false;
    const i = x + z * SX + y * SX * SZ;
    if (this.data[i] === b) return false;
    this.data[i] = b;
    return true;
  }

  isSolid(x, y, z) {
    return this.get(x, y, z) !== B.AIR;
  }

  surfaceY(x, z) {
    if (!(x >= 0 && x < SX && z >= 0 && z < SZ)) return -1;
    const base = x + z * SX;
    const layer = SX * SZ;
    for (let y = SY - 1; y >= 0; y--) {
      if (this.data[base + y * layer] !== B.AIR) return y;
    }
    return -1;
  }

  // n spread-out feet positions [x,y,z] on open natural ground above sea level.
  spawnPoints(n, rng) {
    if (typeof rng !== 'function') rng = mulberry32((this.seed ^ 0x9e3779b9) | 0);
    const out = [];
    const R = 60;
    const valid = (x, z) => {
      const y = this.surfaceY(x, z);
      if (y < SEA || y + 2 >= SY) return -1;
      if (!isGround(this.get(x, y, z))) return -1;
      return y;
    };
    for (let i = 0; i < n; i++) {
      let best = null, bestD = -1, found = 0;
      for (let t = 0; t < 600 && found < 24; t++) {
        const x = Math.floor(CX - R + rng() * 2 * R);
        const z = Math.floor(CZ - R + rng() * 2 * R);
        const dx = x + 0.5 - CX, dz = z + 0.5 - CZ;
        if (dx * dx + dz * dz > R * R) continue;
        const y = valid(x, z);
        if (y < 0) continue;
        found++;
        let md = 1e9;
        for (let k = 0; k < out.length; k++) {
          const ex = out[k][0] - (x + 0.5), ez = out[k][2] - (z + 0.5);
          const d = ex * ex + ez * ez;
          if (d < md) md = d;
        }
        if (md > bestD) {
          bestD = md;
          best = [x + 0.5, y + 1, z + 0.5];
        }
      }
      if (!best) best = this._fallbackSpawn(i);
      out.push(best);
    }
    return out;
  }

  _fallbackSpawn(i) {
    // Heavily edited world: take any column near the centre, standing on whatever is there.
    for (let r = 0; r < SX / 2; r++) {
      for (let k = 0; k < 8; k++) {
        const x = Math.floor(CX) + [r, -r, 0, 0, r, -r, r, -r][k] + (i % 3);
        const z = Math.floor(CZ) + [0, 0, r, -r, r, -r, -r, r][k];
        const y = this.surfaceY(x, z);
        if (y >= 0 && y + 2 < SY) return [x + 0.5, y + 1, z + 0.5];
      }
    }
    return [CX + 0.5, SY, CZ + 0.5];
  }

  // ---------------------------------------------------------------- generation

  generate() {
    const data = this.data;
    data.fill(B.AIR);
    this.chests = [];
    const rng = mulberry32(this.seed);
    const s1 = (rng() * 4294967296) | 0;
    const s2 = (rng() * 4294967296) | 0;
    const s3 = (rng() * 4294967296) | 0;
    const s4 = (rng() * 4294967296) | 0;
    const layer = SX * SZ;

    // --- height map (hgt = y of the top solid cell of each column) ---
    const hgt = new Uint8Array(layer);
    const shore = new Float32Array(layer); // normalised radial distance t (1 = waterline)
    for (let z = 0; z < SZ; z++) {
      for (let x = 0; x < SX; x++) {
        const dx = x + 0.5 - CX, dz = z + 0.5 - CZ;
        const dist = Math.sqrt(dx * dx + dz * dz);
        const rn = fbm(x / 46, z / 46, s1, 2);
        let t = (dist + (rn - 0.5) * 20) / ISLAND_R;
        if (t < dist / 76) t = dist / 76; // the map border is always open water
        let h;
        if (t < 1) {
          let m = clamp01((0.95 - t) / 0.4);
          m = m * m * (3 - 2 * m);
          const hills = clamp01((fbm(x / 34, z / 34, s2, 4) - 0.24) / 0.52);
          const elev = hills * hills * 0.65 + hills * 0.35;
          let pk = clamp01((fbm(x / 21, z / 21, s3, 3) - 0.58) / 0.26);
          pk = pk * pk;
          h = Math.floor(SEA + m * (1.2 + elev * 14.5 + pk * 9));
        } else {
          h = Math.floor(SEA - 1.01 - (t - 1) * 30);
          if (h < 3) h = 3;
        }
        if (h > SY - 14) h = SY - 14;
        hgt[x + z * SX] = h;
        shore[x + z * SX] = t;
      }
    }

    // --- columns ---
    const stoneTop = new Uint8Array(layer);
    for (let z = 0; z < SZ; z++) {
      for (let x = 0; x < SX; x++) {
        const c = x + z * SX;
        const h = hgt[c];
        const hW = hgt[(x > 0 ? x - 1 : x) + z * SX];
        const hE = hgt[(x < SX - 1 ? x + 1 : x) + z * SX];
        const hN = hgt[x + (z > 0 ? z - 1 : z) * SX];
        const hS = hgt[x + (z < SZ - 1 ? z + 1 : z) * SX];
        let slope = Math.abs(h - hW);
        if (Math.abs(h - hE) > slope) slope = Math.abs(h - hE);
        if (Math.abs(h - hN) > slope) slope = Math.abs(h - hN);
        if (Math.abs(h - hS) > slope) slope = Math.abs(h - hS);
        const jitter = hash2(x, z, s4);
        let top, sub, subDepth;
        if (h <= SEA || (h === SEA + 1 && shore[c] > 0.8 && jitter > 0.45)) {
          top = B.SAND; sub = B.SAND; subDepth = 3;
        } else if (slope >= 3 || h >= SEA + 15 + Math.floor(jitter * 3)) {
          top = B.STONE; sub = B.STONE; subDepth = 0;
          stoneTop[c] = 1;
        } else {
          if (slope >= 2) stoneTop[c] = 2; // steep grassy bank: also a candidate for ore
          top = B.GRASS; sub = B.DIRT; subDepth = 3;
        }
        data[c] = B.BEDROCK;
        for (let y = 1; y < h; y++) {
          data[c + y * layer] = y >= h - subDepth ? sub : B.STONE;
        }
        if (h >= 1) data[c + h * layer] = top;
      }
    }

    // --- ore: buried veins, plus outcrops on cliffs and peaks ---
    for (let i = 0; i < 90; i++) {
      let x = 20 + Math.floor(rng() * (SX - 40));
      let z = 20 + Math.floor(rng() * (SZ - 40));
      const h = hgt[x + z * SX];
      let y = 1 + Math.floor(rng() * (h > 3 ? h - 2 : 1));
      const len = 5 + Math.floor(rng() * 5);
      for (let k = 0; k < len; k++) {
        if (this.get(x, y, z) === B.STONE) data[this.index(x, y, z)] = B.ORE;
        const a = Math.floor(rng() * 6);
        if (a === 0) x++; else if (a === 1) x--; else if (a === 2) z++; else if (a === 3) z--;
        else if (a === 4) y++; else y--;
        if (y < 1) y = 1;
      }
    }
    const rocky = [];
    for (let z = 4; z < SZ - 4; z++) {
      for (let x = 4; x < SX - 4; x++) {
        if (stoneTop[x + z * SX]) rocky.push(x + z * SX);
      }
    }
    if (rocky.length > 0) {
      const outcrops = Math.min(60, 28 + Math.floor(rocky.length / 14));
      for (let i = 0; i < outcrops; i++) {
        const c = rocky[Math.floor(rng() * rocky.length)];
        let x = c % SX, z = Math.floor(c / SX);
        let y = hgt[c];
        const len = 6 + Math.floor(rng() * 7);
        for (let k = 0; k < len; k++) {
          const top = hgt[x + z * SX];
          if (y > top) y = top;
          if (y < top - 1) y = top - 1;
          if (y < 1) y = 1;
          const b = this.get(x, y, z);
          if (b === B.STONE || b === B.DIRT || (b === B.GRASS && stoneTop[x + z * SX])) {
            data[this.index(x, y, z)] = B.ORE;
          }
          const a = Math.floor(rng() * 6);
          if (a === 0) x++; else if (a === 1) x--; else if (a === 2) z++; else if (a === 3) z--;
          else if (a === 4) y++; else y--;
          if (x < 2) x = 2; else if (x > SX - 3) x = SX - 3;
          if (z < 2) z = 2; else if (z > SZ - 3) z = SZ - 3;
        }
      }
    }

    // --- ruined huts ---
    const zone = new Uint8Array(layer); // 1 = reserved (hut + margin), 2 = tree trunk nearby
    const huts = [];
    const hutCount = 6 + Math.floor(rng() * 4);
    for (let i = 0; i < hutCount; i++) {
      let best = null;
      for (let t = 0; t < 260; t++) {
        const w = 5 + Math.floor(rng() * 3);
        const d = 5 + Math.floor(rng() * 3);
        const x0 = 22 + Math.floor(rng() * (SX - 44 - w));
        const z0 = 22 + Math.floor(rng() * (SZ - 44 - d));
        const mx = x0 + w / 2 - CX, mz = z0 + d / 2 - CZ;
        if (mx * mx + mz * mz > 54 * 54) continue;
        let ok = true;
        for (let k = 0; k < huts.length; k++) {
          const ex = huts[k].x0 - x0, ez = huts[k].z0 - z0;
          if (ex * ex + ez * ez < 20 * 20) { ok = false; break; }
        }
        if (!ok) continue;
        let lo = 99, hi = 0, sum = 0;
        for (let z = z0; z < z0 + d; z++) {
          for (let x = x0; x < x0 + w; x++) {
            const h = hgt[x + z * SX];
            if (h < lo) lo = h;
            if (h > hi) hi = h;
            sum += h;
          }
        }
        // late tries accept rougher or lower ground so the hut count stays 6-9
        if (lo < SEA + (t < 200 ? 1 : 0) || hi - lo > (t < 120 ? 3 : 6)) continue;
        const range = hi - lo;
        if (!best || range < best.range) {
          best = { x0, z0, w, d, range, base: Math.floor(sum / (w * d) + 0.5) };
          if (range <= 1 && t >= 12) break;
        }
      }
      if (!best) continue;
      huts.push(best);
      this._buildHut(best, rng, hgt, zone);
    }

    // --- boulders ---
    for (let i = 0; i < 34; i++) {
      const x = 12 + Math.floor(rng() * (SX - 24));
      const z = 12 + Math.floor(rng() * (SZ - 24));
      const c = x + z * SX;
      const h = hgt[c];
      const r2 = rng(), r3 = rng();
      if (zone[c] || h < SEA || !isGround(data[c + h * layer])) continue;
      data[c + (h + 1) * layer] = B.STONE;
      zone[c] = 2;
      if (r2 < 0.5) data[c + (h + 2) * layer] = B.STONE;
      const nx = x + (r3 < 0.5 ? 1 : -1);
      const nc = nx + z * SX;
      if (r3 < 0.7 && !zone[nc] && hgt[nc] >= SEA && hgt[nc] <= h + 1 && hgt[nc] >= h - 1) {
        data[nc + (hgt[nc] + 1) * layer] = r3 < 0.2 ? B.ORE : B.STONE;
        zone[nc] = 2;
      }
    }

    // --- trees (~230 broadleaf on grass, ~20 palms on the beach) ---
    const TH = THEMES[this.theme];
    let trees = 0;
    for (let t = 0; t < 9000 && trees < TH.trees; t++) {
      const x = 6 + Math.floor(rng() * (SX - 12));
      const z = 6 + Math.floor(rng() * (SZ - 12));
      const r1 = rng(), r2 = rng();
      const c = x + z * SX;
      const h = hgt[c];
      if (data[c + h * layer] !== B.GRASS) continue;
      if (this._crowded(zone, x, z, 2)) continue;
      // clumping: favour patches where the forest noise is high
      if (fbm(x / 26, z / 26, s4, 2) < 0.34 + r2 * 0.3) continue;
      const H = 4 + Math.floor(r1 * 3);
      this._tree(x, h, z, H, rng);
      zone[c] = 2;
      trees++;
    }
    let palms = 0;
    for (let t = 0; t < 4000 && palms < TH.palms; t++) {
      const x = 6 + Math.floor(rng() * (SX - 12));
      const z = 6 + Math.floor(rng() * (SZ - 12));
      const r1 = rng();
      const c = x + z * SX;
      const h = hgt[c];
      if (h < SEA || data[c + h * layer] !== B.SAND) continue;
      if (this._crowded(zone, x, z, 3)) continue;
      this._palm(x, h, z, 5 + Math.floor(r1 * 2));
      zone[c] = 2;
      palms++;
    }

    // --- chests: inside huts first, the rest scattered over open ground ---
    for (let i = 0; i < huts.length && this.chests.length < CHEST_COUNT; i++) {
      const hut = huts[i];
      const want = rng() < 0.35 ? 2 : 1;
      for (let k = 0, tries = 0; k < want && tries < 30; tries++) {
        const x = hut.x0 + 1 + Math.floor(rng() * (hut.w - 2));
        const z = hut.z0 + 1 + Math.floor(rng() * (hut.d - 2));
        const y = hut.base + 1;
        if (this.get(x, y, z) !== B.AIR || this.get(x, y - 1, z) === B.AIR) continue;
        if (this.chests.length >= CHEST_COUNT) break;
        data[this.index(x, y, z)] = B.CHEST;
        this.chests.push([x, y, z]);
        k++;
      }
    }
    let spacing = 8;
    for (let t = 0; this.chests.length < CHEST_COUNT && t < 40000; t++) {
      if (t > 0 && t % 400 === 0 && spacing > 1) spacing--;
      const x = 10 + Math.floor(rng() * (SX - 20));
      const z = 10 + Math.floor(rng() * (SZ - 20));
      if (this._chestSpot(x, z, hgt, zone, spacing)) {
        const y = hgt[x + z * SX] + 1;
        data[this.index(x, y, z)] = B.CHEST;
        this.chests.push([x, y, z]);
      }
    }
    // deterministic last resort (never needed in practice) so the count is always exact
    for (let z = 10; z < SZ - 10 && this.chests.length < CHEST_COUNT; z += 3) {
      for (let x = 10; x < SX - 10 && this.chests.length < CHEST_COUNT; x += 3) {
        if (this._chestSpot(x, z, hgt, zone, 0)) {
          const y = hgt[x + z * SX] + 1;
          data[this.index(x, y, z)] = B.CHEST;
          this.chests.push([x, y, z]);
        }
      }
    }
  }

  _chestSpot(x, z, hgt, zone, spacing) {
    const c = x + z * SX;
    const h = hgt[c];
    if (h < SEA || zone[c]) return false;
    const dx = x + 0.5 - CX, dz = z + 0.5 - CZ;
    if (dx * dx + dz * dz > 66 * 66) return false;
    if (this.surfaceY(x, z) !== h) return false; // nothing overhead, nothing already placed
    if (!isGround(this.get(x, h, z))) return false;
    for (let k = 0; k < this.chests.length; k++) {
      const ex = this.chests[k][0] - x, ez = this.chests[k][2] - z;
      if (ex * ex + ez * ez < spacing * spacing) return false;
    }
    return true;
  }

  _crowded(zone, x, z, r) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const xx = x + dx, zz = z + dz;
        if (xx < 0 || xx >= SX || zz < 0 || zz >= SZ) continue;
        const v = zone[xx + zz * SX];
        if (v === 2) return true;
        if (v === 1 && dx >= -1 && dx <= 1 && dz >= -1 && dz <= 1) return true;
      }
    }
    return false;
  }

  _leaf(x, y, z) {
    if (this.inBounds(x, y, z)) {
      const i = this.index(x, y, z);
      if (this.data[i] === B.AIR) this.data[i] = B.LEAVES;
    }
  }

  _tree(x, h, z, H, rng) {
    const data = this.data;
    data[this.index(x, h, z)] = B.DIRT;
    for (let i = 1; i <= H; i++) data[this.index(x, h + i, z)] = B.LOG;
    const low = H - 2 > 3 ? H - 2 : 3;
    for (let ly = low; ly <= H + 1; ly++) {
      const r = ly > H ? 1 : 2;
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          const corner = (dx === r || dx === -r) && (dz === r || dz === -r);
          if (corner && (r === 1 ? rng() < 0.5 : rng() < 0.75)) continue;
          this._leaf(x + dx, h + ly, z + dz);
        }
      }
    }
    if (rng() < 0.5) this._leaf(x, h + H + 2, z);
  }

  _palm(x, h, z, H) {
    const data = this.data;
    for (let i = 1; i <= H; i++) data[this.index(x, h + i, z)] = B.LOG;
    const y = h + H + 1;
    this._leaf(x, y, z);
    for (let k = 1; k <= 2; k++) {
      this._leaf(x + k, y, z);
      this._leaf(x - k, y, z);
      this._leaf(x, y, z + k);
      this._leaf(x, y, z - k);
    }
    this._leaf(x + 3, y - 1, z);
    this._leaf(x - 3, y - 1, z);
    this._leaf(x, y - 1, z + 3);
    this._leaf(x, y - 1, z - 3);
    this._leaf(x + 1, y, z + 1);
    this._leaf(x - 1, y, z - 1);
    this._leaf(x + 1, y, z - 1);
    this._leaf(x - 1, y, z + 1);
  }

  _buildHut(hut, rng, hgt, zone) {
    const data = this.data;
    const layer = SX * SZ;
    const { x0, z0, w, d, base } = hut;
    const brick = rng() < 0.45;
    const wallMat = brick ? B.BRICK : B.PLANKS;
    const x1 = x0 + w - 1, z1 = z0 + d - 1;

    // reserve the plot (with a margin) so trees and loose chests stay clear
    for (let z = z0 - 2; z <= z1 + 2; z++) {
      for (let x = x0 - 2; x <= x1 + 2; x++) {
        if (x >= 0 && x < SX && z >= 0 && z < SZ) zone[x + z * SX] = 1;
      }
    }

    // level the plot: foundation up to base-1, floor at base, clear the room above
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const c = x + z * SX;
        const h = hgt[c];
        for (let y = h; y < base; y++) data[c + y * layer] = B.STONE;
        const edge = x === x0 || x === x1 || z === z0 || z === z1;
        data[c + base * layer] = edge || brick ? B.BRICK : B.PLANKS;
        for (let y = base + 1; y <= base + 7 && y < SY; y++) data[c + y * layer] = B.AIR;
        hgt[c] = base;
      }
    }

    // doorway in the middle of one side
    const side = Math.floor(rng() * 4);
    let doorX, doorZ;
    if (side === 0) { doorX = x0 + (w >> 1); doorZ = z0; }
    else if (side === 1) { doorX = x0 + (w >> 1); doorZ = z1; }
    else if (side === 2) { doorX = x0; doorZ = z0 + (d >> 1); }
    else { doorX = x1; doorZ = z0 + (d >> 1); }

    // walls: each perimeter column keeps 0..3 blocks (crumbled tops), some with windows
    const wallH = new Uint8Array(w * d);
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const edge = x === x0 || x === x1 || z === z0 || z === z1;
        if (!edge) continue;
        const corner = (x === x0 || x === x1) && (z === z0 || z === z1);
        const r = rng(), rw = rng();
        let hh = r < 0.52 ? 3 : r < 0.76 ? 2 : r < 0.92 ? 1 : 0;
        if (corner && hh < 2) hh = 2 + (r < 0.5 ? 1 : 0);
        const door = x === doorX && z === doorZ;
        const c = x + z * SX;
        for (let i = 1; i <= hh; i++) {
          if (door && i <= 2) continue;
          if (!corner && hh === 3 && i === 2 && rw < 0.3) continue; // window
          data[c + (base + i) * layer] = corner && !brick ? B.LOG : wallMat;
        }
        wallH[(x - x0) + (z - z0) * w] = hh;
      }
    }

    // roof: one side mostly survives, the other mostly caved in
    const axis = rng() < 0.5;
    const cut = 0.3 + rng() * 0.4;
    const flip = rng() < 0.5;
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const edge = x === x0 || x === x1 || z === z0 || z === z1;
        const r = rng();
        if (edge && wallH[(x - x0) + (z - z0) * w] < 3) continue;
        const f = axis ? (x - x0) / (w - 1) : (z - z0) / (d - 1);
        const kept = (f < cut) !== flip;
        if (r < (kept ? 0.86 : 0.1)) data[x + z * SX + (base + 4) * layer] = B.PLANKS;
      }
    }

    // a little rubble on the floor
    for (let i = 0; i < 2; i++) {
      const x = x0 + 1 + Math.floor(rng() * (w - 2));
      const z = z0 + 1 + Math.floor(rng() * (d - 2));
      if (rng() < 0.6) data[x + z * SX + (base + 1) * layer] = wallMat;
    }
  }
}

// ---------------------------------------------------------------- raycast

// Exact voxel DDA (Amanatides & Woo). o,d are [x,y,z], d normalised.
export function raycast(world, o, d, maxDist) {
  const ox = o[0], oy = o[1], oz = o[2];
  const dx = d[0], dy = d[1], dz = d[2];
  let x = Math.floor(ox), y = Math.floor(oy), z = Math.floor(oz);

  let block = world.get(x, y, z);
  if (block !== B.AIR) {
    return { x, y, z, nx: 0, ny: 0, nz: 0, dist: 0, block };
  }
  if (!(maxDist > 0)) return null;

  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
  if (stepX === 0 && stepY === 0 && stepZ === 0) return null;

  const tDeltaX = stepX !== 0 ? Math.abs(1 / dx) : Infinity;
  const tDeltaY = stepY !== 0 ? Math.abs(1 / dy) : Infinity;
  const tDeltaZ = stepZ !== 0 ? Math.abs(1 / dz) : Infinity;
  let tMaxX = stepX > 0 ? (x + 1 - ox) * tDeltaX : stepX < 0 ? (ox - x) * tDeltaX : Infinity;
  let tMaxY = stepY > 0 ? (y + 1 - oy) * tDeltaY : stepY < 0 ? (oy - y) * tDeltaY : Infinity;
  let tMaxZ = stepZ > 0 ? (z + 1 - oz) * tDeltaZ : stepZ < 0 ? (oz - z) * tDeltaZ : Infinity;

  // generous hard cap so a bad maxDist can never spin forever
  let guard = Math.ceil(maxDist * 3) + 8;
  if (!(guard < 4096)) guard = 4096;

  while (guard-- > 0) {
    let t, nx = 0, ny = 0, nz = 0;
    if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
      t = tMaxX; x += stepX; tMaxX += tDeltaX; nx = -stepX;
    } else if (tMaxY <= tMaxZ) {
      t = tMaxY; y += stepY; tMaxY += tDeltaY; ny = -stepY;
    } else {
      t = tMaxZ; z += stepZ; tMaxZ += tDeltaZ; nz = -stepZ;
    }
    if (t > maxDist) return null;
    block = world.get(x, y, z);
    if (block !== B.AIR) {
      return { x, y, z, nx, ny, nz, dist: t, block };
    }
  }
  return null;
}

// ---------------------------------------------------------------- build pieces

const FWD = [[0, -1], [-1, 0], [0, 1], [1, 0]]; // facing -> (fx, fz)

export function pieceCells(piece, x, y, z, facing) {
  const f = FWD[((facing % 4) + 4) % 4 | 0] || FWD[0];
  const fx = f[0], fz = f[1];
  const rx = fz === 0 ? 0 : -fz, rz = fx; // the player's right-hand side
  const out = [];
  if (piece === 'wall') {
    for (let h = 0; h < 3; h++) {
      for (let s = -2; s <= 1; s++) out.push([x + rx * s, y + h, z + rz * s]);
    }
  } else if (piece === 'floor') {
    for (let i = 0; i < 4; i++) {
      for (let s = -2; s <= 1; s++) out.push([x + fx * i + rx * s, y, z + fz * i + rz * s]);
    }
  } else if (piece === 'ramp') {
    for (let i = 0; i < 3; i++) {
      for (let s = -2; s <= 1; s++) out.push([x + fx * i + rx * s, y + i, z + fz * i + rz * s]);
    }
  } else if (piece === 'block') {
    out.push([x, y, z]);
  }
  return out;
}

// ---------------------------------------------------------------- ray vs box

// Slab test. Returns the entry distance t >= 0 (0 when the origin is inside) or null.
export function rayAABB(o, d, min, max) {
  let tmin = 0, tmax = Infinity;
  for (let a = 0; a < 3; a++) {
    const oa = o[a], da = d[a];
    if (da === 0) {
      if (!(oa >= min[a] && oa <= max[a])) return null;
    } else {
      let t1 = (min[a] - oa) / da;
      let t2 = (max[a] - oa) / da;
      if (t1 !== t1 || t2 !== t2) return null; // NaN direction/origin never hits
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
  }
  return tmin;
}
