import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { collides, stepPlayer } from '../shared/physics.js';
import { World } from '../shared/world.js';
import { WORLD, B, PLAYER } from '../shared/constants.js';
import { emptyWorld, flatWorld } from './helpers/emptyworld.js';

const T = { timeout: 20000 };
const DT = 1 / 60;
const TOP = 10; // standing surface of flatWorld()
const HW = PLAYER.WIDTH / 2;

const mk = (x, y, z) => ({ p: [x, y, z], v: [0, 0, 0], onGround: false });
const idle = { fwd: 0, right: 0, yaw: 0, jump: false, sprint: false };

function run(world, s, input, seconds, each) {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    stepPlayer(world, s, input, DT);
    if (each) each(s, i);
  }
  return s;
}
function settle(world, s) {
  run(world, s, idle, 2);
  assert.equal(s.onGround, true, 'player should have landed');
  return s;
}
function fillBox(w, x0, x1, y0, y1, z0, z1, b = B.BRICK) {
  for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) w.set(x, y, z, b);
}

describe('collides', T, () => {
  test('free in air, blocked by blocks overlapping the box', T, () => {
    const w = emptyWorld();
    assert.equal(collides(w, [50.5, 20, 50.5]), false);
    w.set(50, 20, 50, B.STONE);
    assert.equal(collides(w, [50.5, 20, 50.5]), true, 'feet cell');
    assert.equal(collides(w, [50.5, 19, 50.5]), true, 'head cell (box is 1.8 tall)');
    assert.equal(collides(w, [50.5, 18.5, 50.5]), true, 'top 0.3 of the box');
    assert.equal(collides(w, [50.5, 18.1, 50.5]), false, 'just below the block');
    assert.equal(collides(w, [50.5, 21, 50.5]), false, 'standing exactly on top');
    assert.equal(collides(w, [51.2, 20, 50.5]), true, 'box edge overlaps (0.6 wide)');
    assert.equal(collides(w, [51.31, 20, 50.5]), false, 'beside the block');
    assert.equal(collides(w, [49.69, 20, 50.5]), false, 'beside the block (other side)');
    assert.equal(collides(w, [50.5, 20, 51.31]), false);
    assert.equal(collides(w, [50.5, 20, 51.2]), true);
  });

  test('below y=0 counts as solid, outside x/z bounds is free', T, () => {
    const w = emptyWorld();
    assert.equal(collides(w, [50.5, -0.5, 50.5]), true);
    assert.equal(collides(w, [50.5, 0, 50.5]), false);
    assert.equal(collides(w, [-5, 10, -5]), false);
  });
});

describe('stepPlayer', T, () => {
  test('falls under gravity and lands exactly on the ground', T, () => {
    const w = flatWorld(TOP);
    const s = mk(80.5, TOP + 6, 80.5);
    stepPlayer(w, s, idle, DT);
    assert.ok(s.p[1] < TOP + 6, 'should start falling');
    assert.ok(s.v[1] < 0);
    assert.equal(s.onGround, false);
    let minY = Infinity;
    run(w, s, idle, 3, (st) => { minY = Math.min(minY, st.p[1]); });
    assert.equal(s.onGround, true);
    assert.ok(Math.abs(s.p[1] - TOP) < 1e-6, `resting y ${s.p[1]}`);
    assert.ok(minY >= TOP - 1e-6, `sank into the ground (${minY})`);
    assert.equal(s.v[1], 0);
    assert.equal(collides(w, s.p), false);
    assert.ok(Math.abs(s.p[0] - 80.5) < 1e-9 && Math.abs(s.p[2] - 80.5) < 1e-9, 'no horizontal drift');
  });

  test('returns the same (mutated) state object', T, () => {
    const w = flatWorld(TOP);
    const s = mk(80.5, TOP, 80.5);
    assert.equal(stepPlayer(w, s, idle, DT), s);
  });

  test('a fast fall with a large dt does not tunnel through the floor', T, () => {
    const w = emptyWorld();
    fillBox(w, 70, 90, 10, 10, 70, 90); // one-block-thick platform, top at 11
    const s = mk(80.5, 46, 80.5);
    for (let i = 0; i < 200; i++) stepPlayer(w, s, idle, 0.05);
    assert.equal(s.onGround, true);
    assert.ok(Math.abs(s.p[1] - 11) < 1e-6, `y=${s.p[1]}`);
  });

  test('stays grounded on flat ground while idle', T, () => {
    const w = flatWorld(TOP);
    const s = settle(w, mk(80.5, TOP, 80.5));
    for (let i = 0; i < 120; i++) {
      stepPlayer(w, s, idle, DT);
      assert.equal(s.onGround, true, `left the ground at step ${i}`);
      assert.ok(Math.abs(s.p[1] - TOP) < 1e-6);
    }
  });

  test('walks at about WALK speed; yaw 0 moves toward -Z', T, () => {
    const w = flatWorld(TOP);
    const s = settle(w, mk(80.5, TOP, 80.5));
    run(w, s, { ...idle, fwd: 1 }, 1); // accelerate
    const z0 = s.p[2];
    run(w, s, { ...idle, fwd: 1 }, 2);
    const speed = (z0 - s.p[2]) / 2;
    assert.ok(Math.abs(speed - PLAYER.WALK) < 0.4, `walk speed ${speed}`);
    assert.ok(Math.abs(s.p[0] - 80.5) < 1e-6, 'no sideways drift');
    assert.ok(Math.abs(s.p[1] - TOP) < 1e-6);
  });

  test('sprint is faster, about SPRINT speed', T, () => {
    const w = flatWorld(TOP);
    const s = settle(w, mk(80.5, TOP, 100.5));
    run(w, s, { ...idle, fwd: 1, sprint: true }, 1);
    const z0 = s.p[2];
    run(w, s, { ...idle, fwd: 1, sprint: true }, 2);
    const speed = (z0 - s.p[2]) / 2;
    assert.ok(Math.abs(speed - PLAYER.SPRINT) < 0.5, `sprint speed ${speed}`);
  });

  test('direction convention: right at yaw 0 is +X; yaw +90deg forward is -X; back is +Z', T, () => {
    const w = flatWorld(TOP);
    let s = settle(w, mk(80.5, TOP, 80.5));
    run(w, s, { ...idle, right: 1 }, 1);
    assert.ok(s.p[0] > 82 && Math.abs(s.p[2] - 80.5) < 1e-6, `right -> ${s.p}`);
    s = settle(w, mk(80.5, TOP, 80.5));
    run(w, s, { ...idle, fwd: 1, yaw: Math.PI / 2 }, 1);
    assert.ok(s.p[0] < 79 && Math.abs(s.p[2] - 80.5) < 1e-3, `yaw 90 fwd -> ${s.p}`);
    s = settle(w, mk(80.5, TOP, 80.5));
    run(w, s, { ...idle, fwd: -1 }, 1);
    assert.ok(s.p[2] > 82, `back -> ${s.p}`);
  });

  test('diagonal input is not faster than straight', T, () => {
    const w = flatWorld(TOP);
    const s = settle(w, mk(80.5, TOP, 80.5));
    run(w, s, { ...idle, fwd: 1, right: 1 }, 1);
    const a = [s.p[0], s.p[2]];
    run(w, s, { ...idle, fwd: 1, right: 1 }, 1);
    const speed = Math.hypot(s.p[0] - a[0], s.p[2] - a[1]);
    assert.ok(speed < PLAYER.WALK + 0.3, `diagonal speed ${speed}`);
    assert.ok(speed > PLAYER.WALK - 0.6, `diagonal speed ${speed}`);
  });

  test('stops when input is released', T, () => {
    const w = flatWorld(TOP);
    const s = settle(w, mk(80.5, TOP, 80.5));
    run(w, s, { ...idle, fwd: 1 }, 1);
    run(w, s, idle, 1.5);
    const z = s.p[2];
    run(w, s, idle, 0.5);
    assert.ok(Math.abs(s.p[2] - z) < 0.02, 'still sliding after 1.5 s');
  });

  test('cannot walk through a wall', T, () => {
    const w = flatWorld(TOP);
    fillBox(w, 70, 90, TOP, TOP + 3, 75, 75); // wall occupying z in [75,76)
    const s = settle(w, mk(80.5, TOP, 80.5));
    run(w, s, { ...idle, fwd: 1, sprint: true }, 3, (st) => {
      assert.ok(st.p[2] >= 76 + HW - 1e-6, `penetrated the wall: z=${st.p[2]}`);
      assert.equal(collides(w, st.p), false);
    });
    assert.ok(s.p[2] < 76 + HW + 0.05, `should be resting against the wall, z=${s.p[2]}`);
    assert.ok(Math.abs(s.p[1] - TOP) < 1e-6, 'must not climb a 4-high wall');
  });

  test('cannot jump-sprint through or over a 4-high wall, from any side', T, () => {
    const w = flatWorld(TOP);
    fillBox(w, 75, 85, TOP, TOP + 3, 75, 85); // solid 11x11 pillar
    const cases = [
      { start: [80.5, 90.5], yaw: 0 },            // moving -Z
      { start: [80.5, 70.5], yaw: Math.PI },      // moving +Z
      { start: [90.5, 80.5], yaw: Math.PI / 2 },  // moving -X
      { start: [70.5, 80.5], yaw: -Math.PI / 2 }, // moving +X
    ];
    for (const c of cases) {
      const s = settle(w, mk(c.start[0], TOP, c.start[1]));
      run(w, s, { fwd: 1, right: 0, yaw: c.yaw, jump: true, sprint: true }, 3, (st) => {
        assert.equal(collides(w, st.p), false, `inside blocks at ${st.p}`);
        const inside = st.p[0] > 75 - HW + 1e-3 && st.p[0] < 86 + HW - 1e-3 && st.p[2] > 75 - HW + 1e-3 && st.p[2] < 86 + HW - 1e-3;
        assert.ok(!inside, `entered the pillar footprint at ${st.p}`);
      });
    }
  });

  test('slides along a wall when moving diagonally into it', T, () => {
    const w = flatWorld(TOP);
    fillBox(w, 60, 100, TOP, TOP + 3, 75, 75);
    const s = settle(w, mk(80.5, TOP, 76.5));
    run(w, s, { ...idle, fwd: 1, right: 1 }, 2);
    assert.ok(s.p[2] >= 76 + HW - 1e-6);
    assert.ok(s.p[0] > 84, `should slide along +X, x=${s.p[0]}`);
  });

  test('auto-steps up a single block ledge', T, () => {
    const w = flatWorld(TOP);
    fillBox(w, 70, 90, TOP, TOP, 60, 75); // raised area, z < 76, one block high
    const s = settle(w, mk(80.5, TOP, 80.5));
    let maxY = 0;
    run(w, s, { ...idle, fwd: 1 }, 2, (st) => {
      assert.equal(collides(w, st.p), false);
      maxY = Math.max(maxY, st.p[1]);
    });
    assert.ok(s.p[2] < 75, `should have walked onto the ledge, z=${s.p[2]}`);
    assert.ok(Math.abs(s.p[1] - (TOP + 1)) < 1e-6, `y=${s.p[1]}`);
    assert.ok(maxY <= TOP + 1 + 1e-6, 'stepping up must not launch the player');
    assert.equal(s.onGround, true);
  });

  test('walks up a 3-step staircase (ramp piece shape) without jumping', T, () => {
    const w = flatWorld(TOP);
    for (let i = 0; i < 3; i++) fillBox(w, 78, 82, TOP + i, TOP + i, 75 - i, 75 - i);
    fillBox(w, 78, 82, TOP + 2, TOP + 2, 60, 72); // landing
    const s = settle(w, mk(80.5, TOP, 80.5));
    run(w, s, { ...idle, fwd: 1 }, 2.5);
    assert.ok(Math.abs(s.p[1] - (TOP + 3)) < 1e-6, `should be on top of the stairs, y=${s.p[1]} z=${s.p[2]}`);
    assert.ok(s.p[2] < 73);
  });

  test('does not auto-step a two-block ledge', T, () => {
    const w = flatWorld(TOP);
    fillBox(w, 70, 90, TOP, TOP + 1, 60, 75);
    const s = settle(w, mk(80.5, TOP, 80.5));
    run(w, s, { ...idle, fwd: 1 }, 2);
    assert.ok(s.p[2] >= 76 + HW - 1e-6, `z=${s.p[2]}`);
    assert.ok(Math.abs(s.p[1] - TOP) < 1e-6);
  });

  test('does not auto-step when there is no head room', T, () => {
    const w = flatWorld(TOP);
    fillBox(w, 70, 90, TOP, TOP, 60, 75);         // one-block ledge
    fillBox(w, 70, 90, TOP + 2, TOP + 2, 60, 75); // ceiling leaving only a 1-high gap above it
    const s = settle(w, mk(80.5, TOP, 80.5));
    run(w, s, { ...idle, fwd: 1 }, 2, (st) => assert.equal(collides(w, st.p), false));
    assert.ok(s.p[2] >= 76 + HW - 1e-6, `z=${s.p[2]}`);
    assert.ok(Math.abs(s.p[1] - TOP) < 1e-6);
  });

  test('jump: only from the ground, sane apex, lands again', T, () => {
    const w = flatWorld(TOP);
    const s = settle(w, mk(80.5, TOP, 80.5));
    let apex = 0, airSteps = 0, landedAt = -1;
    stepPlayer(w, s, { ...idle, jump: true }, DT);
    assert.equal(s.onGround, false);
    assert.ok(s.v[1] > 0);
    run(w, s, idle, 2, (st, i) => {
      apex = Math.max(apex, st.p[1] - TOP);
      if (!st.onGround) airSteps++;
      else if (landedAt < 0) landedAt = i;
    });
    const ideal = (PLAYER.JUMP * PLAYER.JUMP) / (2 * PLAYER.GRAVITY); // ~1.42
    assert.ok(apex > 1.05, `jump apex ${apex} must clear a 1-block ledge`);
    assert.ok(apex < 2.0, `jump apex ${apex} must not clear 2 blocks`);
    assert.ok(Math.abs(apex - ideal) < 0.2, `apex ${apex} vs ideal ${ideal}`);
    assert.equal(s.onGround, true);
    assert.ok(Math.abs(s.p[1] - TOP) < 1e-6);
    const airTime = airSteps * DT;
    assert.ok(airTime > 0.4 && airTime < 1.0, `air time ${airTime}`);
  });

  test('holding jump in mid-air does not double jump', T, () => {
    const w = flatWorld(TOP);
    const s = mk(80.5, TOP + 5, 80.5);
    stepPlayer(w, s, { ...idle, jump: true }, DT);
    assert.ok(s.v[1] < 0, 'jump while falling must be ignored');
    const s2 = settle(w, mk(80.5, TOP, 80.5));
    let apex = 0;
    let left = false, relanded = false;
    run(w, s2, { ...idle, jump: true }, 0.6, (st) => {
      if (!st.onGround) left = true;
      if (left && st.onGround) relanded = true;
      if (!relanded) apex = Math.max(apex, st.p[1] - TOP);
    });
    assert.ok(apex < 2.0, `apex with held jump ${apex}`);
  });

  test('bumps its head on a low ceiling instead of passing through it', T, () => {
    const w = flatWorld(TOP);
    fillBox(w, 70, 90, TOP + 2, TOP + 2, 70, 90); // ceiling: 2 blocks of space, box is 1.8
    const s = settle(w, mk(80.5, TOP, 80.5));
    let apex = 0;
    stepPlayer(w, s, { ...idle, jump: true }, DT);
    run(w, s, idle, 1, (st) => {
      apex = Math.max(apex, st.p[1] - TOP);
      assert.equal(collides(w, st.p), false);
    });
    assert.ok(apex <= 0.2 + 1e-6, `head went through the ceiling, apex ${apex}`);
    assert.equal(s.onGround, true);
  });

  test('walks off an edge and falls', T, () => {
    const w = emptyWorld();
    fillBox(w, 78, 82, 20, 20, 78, 82); // small platform, top at 21
    fillBox(w, 60, 100, 5, 5, 60, 100); // ground far below, top at 6
    const s = settle(w, mk(80.5, 21, 80.5));
    run(w, s, { ...idle, fwd: 1 }, 2.5);
    assert.equal(s.onGround, true);
    assert.ok(Math.abs(s.p[1] - 6) < 1e-6, `y=${s.p[1]}`);
  });

  test('is clamped to the world bounds in x and z', T, () => {
    const w = flatWorld(TOP);
    const corners = [
      { start: [1.5, 1.5], yaw: Math.PI / 4 },                           // toward -X,-Z
      { start: [WORLD.SX - 1.5, WORLD.SZ - 1.5], yaw: Math.PI + Math.PI / 4 }, // toward +X,+Z
    ];
    for (const c of corners) {
      const s = settle(w, mk(c.start[0], TOP, c.start[1]));
      run(w, s, { ...idle, fwd: 1, yaw: c.yaw, sprint: true }, 2, (st) => {
        assert.ok(st.p[0] >= HW - 1e-9 && st.p[0] <= WORLD.SX - HW + 1e-9, `x=${st.p[0]}`);
        assert.ok(st.p[2] >= HW - 1e-9 && st.p[2] <= WORLD.SZ - HW + 1e-9, `z=${st.p[2]}`);
      });
      const atEdgeX = Math.abs(s.p[0] - HW) < 1e-6 || Math.abs(s.p[0] - (WORLD.SX - HW)) < 1e-6;
      const atEdgeZ = Math.abs(s.p[2] - HW) < 1e-6 || Math.abs(s.p[2] - (WORLD.SZ - HW)) < 1e-6;
      assert.ok(atEdgeX && atEdgeZ, `should be pinned in the corner: ${s.p}`);
    }
  });

  test('a player embedded in blocks is pushed out, not stuck or tunnelled down', T, () => {
    const w = flatWorld(TOP);
    const s = settle(w, mk(80.5, TOP, 80.5));
    fillBox(w, 80, 80, TOP, TOP + 1, 80, 80); // a build lands on the player
    assert.equal(collides(w, s.p), true);
    run(w, s, idle, 1);
    assert.equal(collides(w, s.p), false);
    assert.ok(s.p[1] >= TOP - 1e-6, `fell through the floor: ${s.p}`);
    assert.equal(s.onGround, true);
  });

  test('tolerates bad input and bad dt without producing NaN', T, () => {
    const w = flatWorld(TOP);
    const s = settle(w, mk(80.5, TOP, 80.5));
    const bad = [
      undefined, null, {}, { fwd: NaN, right: 'x', yaw: undefined, jump: 1, sprint: 'yes' },
      { fwd: Infinity, right: -Infinity, yaw: NaN }, { fwd: 100, right: -100, yaw: 1e9 },
    ];
    for (const input of bad) {
      for (const dt of [DT, 0, -1, NaN, 5]) {
        stepPlayer(w, s, input, dt);
        for (const v of [...s.p, ...s.v]) assert.ok(Number.isFinite(v), `non-finite state after input ${JSON.stringify(input)} dt ${dt}`);
        assert.equal(collides(w, s.p), false);
      }
    }
  });

  test('random walk on a generated island never ends up inside blocks', T, () => {
    const w = new World(2024);
    const [sp] = w.spawnPoints(1);
    const s = mk(sp[0], sp[1], sp[2]);
    assert.equal(collides(w, s.p), false, 'spawn point collides');
    let seed = 12345;
    const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
    let input = { ...idle };
    for (let i = 0; i < 6000; i++) {
      if (i % 45 === 0) {
        input = { fwd: rnd() < 0.8 ? 1 : -1, right: Math.round(rnd() * 2 - 1), yaw: rnd() * Math.PI * 2, jump: rnd() < 0.4, sprint: rnd() < 0.5 };
      }
      stepPlayer(w, s, input, i % 3 === 0 ? 0.05 : DT);
      assert.equal(collides(w, s.p), false, `inside blocks at step ${i}: ${s.p}`);
      assert.ok(s.p[1] >= 0, `fell out of the world at step ${i}: ${s.p}`);
    }
  });
});
