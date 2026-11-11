import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { World, mulberry32, raycast, pieceCells, rayAABB } from '../shared/world.js';
import { WORLD, B, CHEST_COUNT, PIECES } from '../shared/constants.js';
import { emptyWorld } from './helpers/emptyworld.js';

const T = { timeout: 20000 };
const { SX, SY, SZ, SEA } = WORLD;

describe('mulberry32', T, () => {
  test('is deterministic and in [0,1)', T, () => {
    const a = mulberry32(1234), b = mulberry32(1234), c = mulberry32(1235);
    let differs = false;
    for (let i = 0; i < 1000; i++) {
      const va = a(), vb = b(), vc = c();
      assert.equal(va, vb);
      assert.ok(va >= 0 && va < 1, `value ${va} out of range`);
      if (va !== vc) differs = true;
    }
    assert.ok(differs, 'different seeds should give different streams');
  });

  test('is roughly uniform', T, () => {
    const r = mulberry32(99);
    let sum = 0;
    for (let i = 0; i < 20000; i++) sum += r();
    const mean = sum / 20000;
    assert.ok(mean > 0.47 && mean < 0.53, `mean ${mean}`);
  });
});

describe('World generation', T, () => {
  const w1 = new World(4242);

  test('same seed gives identical data and chests', T, () => {
    const w2 = new World(4242);
    assert.equal(w1.data.length, SX * SY * SZ);
    assert.ok(w1.data instanceof Uint8Array);
    assert.equal(Buffer.compare(Buffer.from(w1.data.buffer), Buffer.from(w2.data.buffer)), 0);
    assert.deepEqual(w1.chests, w2.chests);
    assert.equal(w1.seed, 4242);
  });

  test('different seed gives different data', T, () => {
    const w3 = new World(4243);
    assert.notEqual(Buffer.compare(Buffer.from(w1.data.buffer), Buffer.from(w3.data.buffer)), 0);
  });

  test('generation takes < 400 ms', T, () => {
    new World(7); // warm up the JIT
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      new World(1000 + i);
      best = Math.min(best, performance.now() - t0);
    }
    assert.ok(best < 400, `generation took ${best.toFixed(1)} ms`);
  });

  test('only known block ids are generated', T, () => {
    const known = new Set(Object.values(B));
    const seen = new Set();
    for (let i = 0; i < w1.data.length; i++) seen.add(w1.data[i]);
    for (const b of seen) assert.ok(known.has(b), `unknown block id ${b}`);
    for (const need of ['AIR', 'GRASS', 'DIRT', 'STONE', 'SAND', 'LOG', 'LEAVES', 'ORE', 'CHEST', 'BEDROCK']) {
      assert.ok(seen.has(B[need]), `world has no ${need}`);
    }
    assert.ok(seen.has(B.PLANKS) || seen.has(B.BRICK), 'world has no hut blocks');
  });

  test('island shape: land in the centre, bedrock floor, no land at the map corners', T, () => {
    const cy = w1.surfaceY(SX / 2, SZ / 2);
    assert.ok(cy >= SEA, `centre surface ${cy} should be at or above sea level ${SEA}`);
    assert.equal(w1.get(SX / 2, 0, SZ / 2), B.BEDROCK);
    for (const [x, z] of [[0, 0], [SX - 1, 0], [0, SZ - 1], [SX - 1, SZ - 1]]) {
      assert.ok(w1.surfaceY(x, z) < SEA, `corner ${x},${z} should be below sea level`);
    }
    // nothing solid in the top layer (leaves 2 blocks of head room for any spawn)
    let land = 0;
    for (let z = 0; z < SZ; z++) for (let x = 0; x < SX; x++) if (w1.surfaceY(x, z) > SEA) land++;
    assert.ok(land > 5000, `only ${land} columns above sea level`);
  });

  test('about 250 trees', T, () => {
    // count trunk bases: a LOG whose block below is not a LOG
    let trunks = 0;
    for (let y = 1; y < SY; y++) for (let z = 0; z < SZ; z++) for (let x = 0; x < SX; x++) {
      if (w1.get(x, y, z) === B.LOG && w1.get(x, y - 1, z) !== B.LOG) trunks++;
    }
    assert.ok(trunks >= 120 && trunks <= 400, `${trunks} trees`);
  });

  test('chests: CHEST_COUNT cells that are CHEST blocks resting on something', T, () => {
    assert.equal(w1.chests.length, CHEST_COUNT);
    const keys = new Set();
    for (const c of w1.chests) {
      assert.equal(c.length, 3);
      const [x, y, z] = c;
      assert.ok(w1.inBounds(x, y, z));
      assert.equal(w1.get(x, y, z), B.CHEST, `chest cell ${c} is not a CHEST`);
      assert.ok(w1.isSolid(x, y - 1, z), `chest ${c} floats`);
      keys.add(c.join(','));
    }
    assert.equal(keys.size, CHEST_COUNT, 'duplicate chest cells');
    let count = 0;
    for (let i = 0; i < w1.data.length; i++) if (w1.data[i] === B.CHEST) count++;
    assert.equal(count, CHEST_COUNT, 'CHEST blocks not recorded in world.chests');
  });
});

describe('World access', T, () => {
  test('index and inBounds', T, () => {
    const w = emptyWorld();
    assert.equal(w.index(0, 0, 0), 0);
    assert.equal(w.index(3, 0, 0), 3);
    assert.equal(w.index(0, 0, 2), 2 * SX);
    assert.equal(w.index(0, 5, 0), 5 * SX * SZ);
    assert.equal(w.index(7, 5, 2), 7 + 2 * SX + 5 * SX * SZ);
    assert.ok(w.inBounds(0, 0, 0));
    assert.ok(w.inBounds(SX - 1, SY - 1, SZ - 1));
    for (const c of [[-1, 0, 0], [0, -1, 0], [0, 0, -1], [SX, 0, 0], [0, SY, 0], [0, 0, SZ]]) {
      assert.equal(w.inBounds(...c), false, `inBounds(${c})`);
    }
  });

  test('out of bounds reads AIR, below y=0 reads BEDROCK', T, () => {
    const w = emptyWorld();
    w.data.fill(B.STONE);
    assert.equal(w.get(-1, 5, 5), B.AIR);
    assert.equal(w.get(SX, 5, 5), B.AIR);
    assert.equal(w.get(5, 5, -1), B.AIR);
    assert.equal(w.get(5, 5, SZ), B.AIR);
    assert.equal(w.get(5, SY, 5), B.AIR);
    assert.equal(w.get(5, -1, 5), B.BEDROCK);
    assert.equal(w.get(5, -100, 5), B.BEDROCK);
    assert.equal(w.isSolid(5, -1, 5), true);
    assert.equal(w.isSolid(-1, 5, 5), false);
    w.data.fill(B.AIR);
  });

  test('set returns whether it changed and ignores out of bounds', T, () => {
    const w = emptyWorld();
    assert.equal(w.set(10, 10, 10, B.BRICK), true);
    assert.equal(w.get(10, 10, 10), B.BRICK);
    assert.equal(w.data[w.index(10, 10, 10)], B.BRICK);
    assert.equal(w.isSolid(10, 10, 10), true);
    assert.equal(w.set(10, 10, 10, B.BRICK), false);
    assert.equal(w.set(10, 10, 10, B.AIR), true);
    assert.equal(w.isSolid(10, 10, 10), false);
    const before = Buffer.from(w.data);
    for (const c of [[-1, 0, 0], [SX, 0, 0], [0, -1, 0], [0, SY, 0], [0, 0, -1], [0, 0, SZ]]) {
      assert.ok(!w.set(...c, B.STONE), `set(${c}) should be ignored`);
    }
    assert.equal(Buffer.compare(before, Buffer.from(w.data)), 0, 'out-of-bounds set wrote data');
  });

  test('surfaceY', T, () => {
    const w = emptyWorld();
    assert.equal(w.surfaceY(20, 20), -1);
    w.set(20, 0, 20, B.BEDROCK);
    assert.equal(w.surfaceY(20, 20), 0);
    w.set(20, 7, 20, B.STONE);
    w.set(20, 3, 20, B.STONE);
    assert.equal(w.surfaceY(20, 20), 7);
    w.set(20, SY - 1, 20, B.LEAVES);
    assert.equal(w.surfaceY(20, 20), SY - 1);
    assert.equal(w.surfaceY(21, 20), -1);
    assert.equal(w.surfaceY(-1, 20), -1);
    assert.equal(w.surfaceY(20, SZ), -1);
  });

  test('spawnPoints: on land above sea, two air blocks above, spread out, deterministic', T, () => {
    const w = new World(31337);
    const pts = w.spawnPoints(16, mulberry32(5));
    assert.equal(pts.length, 16);
    for (const p of pts) {
      assert.equal(p.length, 3);
      const [x, y, z] = p;
      const bx = Math.floor(x), bz = Math.floor(z);
      assert.ok(Number.isInteger(y), `feet y ${y} should sit exactly on a block`);
      assert.ok(w.isSolid(bx, y - 1, bz), `spawn ${p} has no ground`);
      assert.equal(w.get(bx, y, bz), B.AIR, `spawn ${p} feet cell not air`);
      assert.equal(w.get(bx, y + 1, bz), B.AIR, `spawn ${p} head cell not air`);
      assert.ok(y - 1 >= SEA, `spawn ${p} is not above sea level`);
    }
    let minD = Infinity;
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
      minD = Math.min(minD, Math.hypot(pts[i][0] - pts[j][0], pts[i][2] - pts[j][2]));
    }
    assert.ok(minD >= 4, `spawn points too close together (${minD.toFixed(2)})`);
    assert.deepEqual(w.spawnPoints(16, mulberry32(5)), pts);
    assert.equal(w.spawnPoints(1, mulberry32(1)).length, 1);
    assert.equal(w.spawnPoints(0, mulberry32(1)).length, 0);
  });
});

describe('raycast', T, () => {
  const C = [50, 20, 50]; // lone block
  function lone() {
    const w = emptyWorld();
    w.set(...C, B.BRICK);
    return w;
  }

  const dirs = [
    { name: '+X', d: [1, 0, 0], n: [-1, 0, 0] },
    { name: '-X', d: [-1, 0, 0], n: [1, 0, 0] },
    { name: '+Y', d: [0, 1, 0], n: [0, -1, 0] },
    { name: '-Y', d: [0, -1, 0], n: [0, 1, 0] },
    { name: '+Z', d: [0, 0, 1], n: [0, 0, -1] },
    { name: '-Z', d: [0, 0, -1], n: [0, 0, 1] },
  ];
  for (const { name, d, n } of dirs) {
    test(`axis ray travelling ${name} hits the entry face`, T, () => {
      const w = lone();
      const o = [C[0] + 0.5 - d[0] * 5, C[1] + 0.5 - d[1] * 5, C[2] + 0.5 - d[2] * 5];
      const h = raycast(w, o, d, 20);
      assert.ok(h, 'expected a hit');
      assert.deepEqual([h.x, h.y, h.z], C);
      assert.deepEqual([h.nx, h.ny, h.nz].map((v) => v + 0), n);
      assert.ok(Math.abs(h.dist - 4.5) < 1e-9, `dist ${h.dist}`);
      assert.equal(h.block, B.BRICK);
    });
  }

  test('respects maxDist', T, () => {
    const w = lone();
    const o = [C[0] + 0.5, C[1] + 0.5, C[2] + 5.5];
    assert.equal(raycast(w, o, [0, 0, -1], 4.4), null); // face is 4.5 away
    assert.ok(raycast(w, o, [0, 0, -1], 4.6));
    assert.equal(raycast(w, o, [0, 0, -1], 0), null);
  });

  test('misses when aimed away or beside the block', T, () => {
    const w = lone();
    assert.equal(raycast(w, [C[0] + 0.5, C[1] + 0.5, C[2] + 5.5], [0, 0, 1], 50), null);
    assert.equal(raycast(w, [C[0] + 1.5, C[1] + 0.5, C[2] + 5.5], [0, 0, -1], 50), null);
    assert.equal(raycast(w, [C[0] + 0.5, C[1] + 1.5, C[2] + 5.5], [0, 0, -1], 50), null);
    assert.equal(raycast(emptyWorld(), [80, 30, 80], [0.6, 0, 0.8], 300), null);
  });

  test('diagonal ray reports the right face, distance and hit point', T, () => {
    const w = lone();
    const s = Math.SQRT1_2;
    // enters through the +Z face (z = 51 plane) at x = 50.3
    let o = [C[0] + 0.3 - 3, C[1] + 0.5, C[2] + 1 + 3];
    let h = raycast(w, o, [s, 0, -s], 20);
    assert.ok(h);
    assert.deepEqual([h.x, h.y, h.z], C);
    assert.deepEqual([h.nx + 0, h.ny + 0, h.nz + 0], [0, 0, 1]);
    assert.ok(Math.abs(h.dist - 3 * Math.SQRT2) < 1e-6, `dist ${h.dist}`);
    // enters through the -X face (x = 50 plane) at z = 50.7
    o = [C[0] - 3, C[1] + 0.5, C[2] + 0.7 + 3];
    h = raycast(w, o, [s, 0, -s], 20);
    assert.ok(h);
    assert.deepEqual([h.nx + 0, h.ny + 0, h.nz + 0], [-1, 0, 0]);
    // steep downward ray lands on the top face
    const d = [0.1, -0.99, 0.1];
    const len = Math.hypot(...d);
    const dn = d.map((v) => v / len);
    o = [C[0] + 0.5 - dn[0] * 4, C[1] + 1 - dn[1] * 4, C[2] + 0.5 - dn[2] * 4];
    h = raycast(w, o, dn, 20);
    assert.ok(h);
    assert.deepEqual([h.x, h.y, h.z], C);
    assert.deepEqual([h.nx + 0, h.ny + 0, h.nz + 0], [0, 1, 0]);
    assert.ok(Math.abs(h.dist - 4) < 1e-6);
  });

  test('hits the nearest of several blocks', T, () => {
    const w = lone();
    w.set(C[0], C[1], C[2] + 2, B.LOG);
    const h = raycast(w, [C[0] + 0.5, C[1] + 0.5, C[2] + 8.5], [0, 0, -1], 50);
    assert.deepEqual([h.x, h.y, h.z], [C[0], C[1], C[2] + 2]);
    assert.equal(h.block, B.LOG);
  });

  test('origin inside a solid block returns that block at distance 0', T, () => {
    const w = lone();
    const h = raycast(w, [C[0] + 0.5, C[1] + 0.5, C[2] + 0.5], [1, 0, 0], 10);
    assert.ok(h);
    assert.deepEqual([h.x, h.y, h.z], C);
    assert.equal(h.dist, 0);
  });

  test('ray leaving the world terminates, ray going down hits bedrock below y=0', T, () => {
    const w = emptyWorld();
    assert.equal(raycast(w, [5.5, 5.5, 5.5], [-1, 0, 0], 1000), null);
    assert.equal(raycast(w, [5.5, 5.5, 5.5], [0, 1, 0], 1000), null);
    const h = raycast(w, [5.5, 5.5, 5.5], [0, -1, 0], 100);
    assert.ok(h, 'below y=0 reads as BEDROCK so a downward ray should hit');
    assert.equal(h.y, -1);
    assert.equal(h.block, B.BEDROCK);
    assert.deepEqual([h.nx + 0, h.ny + 0, h.nz + 0], [0, 1, 0]);
    assert.ok(Math.abs(h.dist - 5.5) < 1e-9);
  });

  test('raycast in a generated world from the sky hits the surface', T, () => {
    const w = new World(77);
    const x = 80, z = 80;
    const sy = w.surfaceY(x, z);
    const h = raycast(w, [x + 0.5, SY + 5.5, z + 0.5], [0, -1, 0], 200);
    assert.ok(h);
    assert.deepEqual([h.x, h.y, h.z], [x, sy, z]);
    assert.deepEqual([h.nx + 0, h.ny + 0, h.nz + 0], [0, 1, 0]);
    assert.ok(Math.abs(h.dist - (SY + 5.5 - (sy + 1))) < 1e-9);
  });
});

describe('pieceCells', T, () => {
  const FWD = [[0, -1], [-1, 0], [0, 1], [1, 0]]; // facing -> forward (x,z)
  const A = [40, 15, 60];
  const key = (c) => c.join(',');
  const uniq = (cells) => new Set(cells.map(key));

  // offsets of each cell from the anchor expressed as (forward, side, up); side sign is
  // normalised so the test accepts either handedness of "sideways -2..+1".
  function local(cells, facing) {
    const [fx, fz] = FWD[facing];
    const sx = -fz, sz = fx;
    return cells.map(([x, y, z]) => {
      const dx = x - A[0], dz = z - A[2];
      return { f: dx * fx + dz * fz + 0, s: dx * sx + dz * sz + 0, u: y - A[1] };
    });
  }
  function sideRange(loc) {
    const ss = loc.map((c) => c.s);
    return [Math.min(...ss), Math.max(...ss)];
  }
  function assertSideRange(loc, label) {
    const [lo, hi] = sideRange(loc);
    assert.ok((lo === -2 && hi === 1) || (lo === -1 && hi === 2), `${label}: sideways range ${lo}..${hi}`);
  }

  for (let facing = 0; facing < 4; facing++) {
    test(`block, facing ${facing}`, T, () => {
      assert.deepEqual(pieceCells('block', ...A, facing), [A]);
    });

    test(`wall, facing ${facing}: 4 wide x 3 high x 1 thick, perpendicular to facing`, T, () => {
      const cells = pieceCells('wall', ...A, facing);
      assert.equal(cells.length, 12);
      assert.equal(uniq(cells).size, 12);
      assert.ok(uniq(cells).has(key(A)), 'contains the anchor');
      const loc = local(cells, facing);
      for (const c of loc) {
        assert.equal(c.f, 0, 'wall must be one cell thick along the facing axis');
        assert.ok(c.u >= 0 && c.u <= 2, `height offset ${c.u}`);
      }
      assertSideRange(loc, 'wall');
      for (let u = 0; u < 3; u++) assert.equal(loc.filter((c) => c.u === u).length, 4);
    });

    test(`floor, facing ${facing}: 4 x 4 x 1 extending forward`, T, () => {
      const cells = pieceCells('floor', ...A, facing);
      assert.equal(cells.length, 16);
      assert.equal(uniq(cells).size, 16);
      assert.ok(uniq(cells).has(key(A)));
      const loc = local(cells, facing);
      for (const c of loc) {
        assert.equal(c.u, 0);
        assert.ok(c.f >= 0 && c.f <= 3, `forward offset ${c.f}`);
      }
      assertSideRange(loc, 'floor');
      for (let f = 0; f < 4; f++) assert.equal(loc.filter((c) => c.f === f).length, 4);
    });

    test(`ramp, facing ${facing}: 3 steps rising forward, 4 wide`, T, () => {
      const cells = pieceCells('ramp', ...A, facing);
      assert.equal(cells.length, 12);
      assert.equal(uniq(cells).size, 12);
      assert.ok(uniq(cells).has(key(A)));
      const loc = local(cells, facing);
      for (const c of loc) {
        assert.ok(c.f >= 0 && c.f <= 2);
        assert.equal(c.u, c.f, 'step i sits at forward offset i and height y+i');
      }
      assertSideRange(loc, 'ramp');
      for (let f = 0; f < 3; f++) assert.equal(loc.filter((c) => c.f === f).length, 4);
    });
  }

  test('all pieces return integer [x,y,z] triples and the same handedness', T, () => {
    for (const piece of PIECES) {
      for (let facing = 0; facing < 4; facing++) {
        const cells = pieceCells(piece, ...A, facing);
        assert.ok(cells.length > 0, `${piece} empty`);
        for (const c of cells) {
          assert.equal(c.length, 3);
          assert.ok(c.every(Number.isInteger), `${piece} non-integer cell ${c}`);
        }
      }
    }
    // wall / floor / ramp use the same sideways extent for a given facing
    for (let facing = 0; facing < 4; facing++) {
      const r = ['wall', 'floor', 'ramp'].map((p) => sideRange(local(pieceCells(p, ...A, facing), facing)).join('..'));
      assert.equal(r[0], r[1]);
      assert.equal(r[1], r[2]);
    }
  });

  test('facing 0 wall lies along X, facing 1 wall lies along Z', T, () => {
    const w0 = pieceCells('wall', ...A, 0);
    assert.ok(w0.every((c) => c[2] === A[2]));
    assert.equal(new Set(w0.map((c) => c[0])).size, 4);
    const w1 = pieceCells('wall', ...A, 1);
    assert.ok(w1.every((c) => c[0] === A[0]));
    assert.equal(new Set(w1.map((c) => c[2])).size, 4);
  });

  test('opposite facings mirror the ramp direction', T, () => {
    const up0 = pieceCells('ramp', ...A, 0).filter((c) => c[1] === A[1] + 2);
    const up2 = pieceCells('ramp', ...A, 2).filter((c) => c[1] === A[1] + 2);
    assert.ok(up0.every((c) => c[2] === A[2] - 2), 'facing 0 climbs toward -Z');
    assert.ok(up2.every((c) => c[2] === A[2] + 2), 'facing 2 climbs toward +Z');
    const up1 = pieceCells('ramp', ...A, 1).filter((c) => c[1] === A[1] + 2);
    const up3 = pieceCells('ramp', ...A, 3).filter((c) => c[1] === A[1] + 2);
    assert.ok(up1.every((c) => c[0] === A[0] - 2), 'facing 1 climbs toward -X');
    assert.ok(up3.every((c) => c[0] === A[0] + 2), 'facing 3 climbs toward +X');
  });

  test('unknown piece returns no cells', T, () => {
    assert.deepEqual(pieceCells('castle', ...A, 0), []);
  });
});

describe('rayAABB', T, () => {
  const min = [0, 0, 0], max = [1, 2, 1];
  const near = (a, b) => Math.abs(a - b) < 1e-9;

  test('hits from outside along each axis', T, () => {
    assert.ok(near(rayAABB([-3, 1, 0.5], [1, 0, 0], min, max), 3));
    assert.ok(near(rayAABB([4, 1, 0.5], [-1, 0, 0], min, max), 3));
    assert.ok(near(rayAABB([0.5, 7, 0.5], [0, -1, 0], min, max), 5));
    assert.ok(near(rayAABB([0.5, -2, 0.5], [0, 1, 0], min, max), 2));
    assert.ok(near(rayAABB([0.5, 1, 6], [0, 0, -1], min, max), 5));
    assert.ok(near(rayAABB([0.5, 1, -6], [0, 0, 1], min, max), 6));
  });

  test('diagonal hit distance', T, () => {
    const s = Math.SQRT1_2;
    const t = rayAABB([-2, 1, -1.5], [s, 0, s], min, max);
    assert.ok(near(t, 2 * Math.SQRT2), `t=${t}`);
  });

  test('misses', T, () => {
    assert.equal(rayAABB([-3, 1, 0.5], [-1, 0, 0], min, max), null, 'pointing away');
    assert.equal(rayAABB([-3, 2.5, 0.5], [1, 0, 0], min, max), null, 'parallel above');
    assert.equal(rayAABB([-3, 1, 1.5], [1, 0, 0], min, max), null, 'parallel beside');
    const s = Math.SQRT1_2;
    assert.equal(rayAABB([-3, 1, 0.5], [s, 0, s], min, max), null, 'diagonal passing by');
    assert.equal(rayAABB([-3, 1, 0.5], [0, 1, 0], min, max), null, 'perpendicular');
  });

  test('origin inside returns 0', T, () => {
    assert.equal(rayAABB([0.5, 1, 0.5], [1, 0, 0], min, max), 0);
    assert.equal(rayAABB([0.5, 1, 0.5], [0, -1, 0], min, max), 0);
  });

  test('never returns a negative distance', T, () => {
    const rng = mulberry32(3);
    for (let i = 0; i < 2000; i++) {
      const o = [rng() * 8 - 4, rng() * 8 - 4, rng() * 8 - 4];
      let d = [rng() - 0.5, rng() - 0.5, rng() - 0.5];
      const l = Math.hypot(...d) || 1;
      d = d.map((v) => v / l);
      const t = rayAABB(o, d, min, max);
      if (t === null) continue;
      assert.ok(t >= 0);
      // the reported point lies on / in the box
      const p = o.map((v, a) => v + d[a] * t);
      for (let a = 0; a < 3; a++) assert.ok(p[a] >= min[a] - 1e-6 && p[a] <= max[a] + 1e-6, `point ${p} outside box`);
    }
  });
});
