// Player movement shared by the client (local player) and the server (bots).
// Axis-separated swept AABB against the voxel grid, with internal sub-stepping so
// no single move exceeds 0.4 blocks (no tunnelling at any dt the callers use).

import { WORLD, PLAYER, B } from './constants.js';

const HW = PLAYER.WIDTH / 2;
const HEIGHT = PLAYER.HEIGHT;
const EPS = 1e-5;   // inset used by the overlap test (absorbs float noise)
const SKIN = 1e-3;  // gap left between the box and a wall / ceiling after a hit
const MAX_SUB = 0.4;
const MAX_FALL = 60;
const GROUND_ACCEL = 18;
const AIR_ACCEL = 5;

// AABB (WIDTH x HEIGHT) standing at feet position p vs solid blocks.
export function collides(world, p) {
  const x0 = Math.floor(p[0] - HW + EPS), x1 = Math.floor(p[0] + HW - EPS);
  const y0 = Math.floor(p[1] + EPS), y1 = Math.floor(p[1] + HEIGHT - EPS);
  const z0 = Math.floor(p[2] - HW + EPS), z1 = Math.floor(p[2] + HW - EPS);
  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        if (world.get(x, y, z) !== B.AIR) return true;
      }
    }
  }
  return false;
}

function moveHorizontal(world, s, a, d) {
  if (d === 0) return;
  const p = s.p;
  const old = p[a];
  p[a] = old + d;
  if (!collides(world, p)) return;

  // auto step-up: grounded, exactly one block, needs head room above the old spot too
  if (s.onGround) {
    const y0 = p[1];
    p[1] = Math.floor(y0 + 1e-4) + 1;
    if (!collides(world, p)) {
      p[a] = old;
      const headRoom = !collides(world, p);
      p[a] = old + d;
      if (headRoom) return;
    }
    p[1] = y0;
  }

  // blocked: rest against the face of the cell that was entered
  if (d > 0) p[a] = Math.floor(old + d + HW - EPS) - HW - SKIN;
  else p[a] = Math.floor(old + d - HW + EPS) + 1 + HW + SKIN;
  if (collides(world, p)) p[a] = old;
  s.v[a] = 0;
}

function moveVertical(world, s, d) {
  if (d === 0) return;
  const p = s.p;
  const old = p[1];
  p[1] = old + d;
  if (!collides(world, p)) {
    s.onGround = false;
    return;
  }
  if (d < 0) {
    p[1] = Math.floor(old + d + EPS) + 1; // exactly on top of the block landed on
    if (collides(world, p)) p[1] = old;
    s.onGround = true;
  } else {
    p[1] = Math.floor(old + d + HEIGHT - EPS) - HEIGHT - SKIN;
    if (collides(world, p)) p[1] = old;
  }
  s.v[1] = 0;
}

function num(v) {
  v = +v;
  return v === v ? v : 0; // NaN -> 0
}

export function stepPlayer(world, s, input, dt) {
  if (!(dt > 0)) return s;
  if (dt > 0.1) dt = 0.1;
  const p = s.p, v = s.v;
  input = input || {};

  // wish velocity from input (yaw 0 looks toward -Z, positive yaw turns left)
  let f = num(input.fwd), r = num(input.right);
  if (f > 1) f = 1; else if (f < -1) f = -1;
  if (r > 1) r = 1; else if (r < -1) r = -1;
  const len = Math.sqrt(f * f + r * r);
  if (len > 1) { f /= len; r /= len; }
  const yaw = num(input.yaw);
  const sin = Math.sin(yaw), cos = Math.cos(yaw);
  const speed = input.sprint ? PLAYER.SPRINT : PLAYER.WALK;
  const wx = (-sin * f + cos * r) * speed;
  const wz = (-cos * f - sin * r) * speed;

  // embedded in blocks (a build or an edit landed on us): pop up to the first free spot
  if (collides(world, p)) {
    const y0 = p[1];
    let freed = false;
    for (let y = Math.floor(y0) + 1; y <= WORLD.SY + 1; y++) {
      p[1] = y;
      if (!collides(world, p)) { freed = true; break; }
    }
    if (!freed) p[1] = y0;
    v[1] = 0;
    s.onGround = false;
  }

  let k = (s.onGround ? GROUND_ACCEL : AIR_ACCEL) * dt;
  if (k > 1) k = 1;
  v[0] += (wx - v[0]) * k;
  v[2] += (wz - v[2]) * k;

  if (input.jump && s.onGround) {
    v[1] = PLAYER.JUMP;
    s.onGround = false;
  }
  v[1] -= PLAYER.GRAVITY * dt;
  if (v[1] < -MAX_FALL) v[1] = -MAX_FALL;

  let big = Math.abs(v[0]);
  if (Math.abs(v[1]) > big) big = Math.abs(v[1]);
  if (Math.abs(v[2]) > big) big = Math.abs(v[2]);
  let n = Math.ceil((big * dt) / MAX_SUB);
  if (n < 1) n = 1;
  const h = dt / n;
  for (let i = 0; i < n; i++) {
    moveHorizontal(world, s, 0, v[0] * h);
    moveHorizontal(world, s, 2, v[2] * h);
    moveVertical(world, s, v[1] * h);
  }

  // world bounds in x/z
  if (p[0] < HW) { p[0] = HW; if (v[0] < 0) v[0] = 0; }
  else if (p[0] > WORLD.SX - HW) { p[0] = WORLD.SX - HW; if (v[0] > 0) v[0] = 0; }
  if (p[2] < HW) { p[2] = HW; if (v[2] < 0) v[2] = 0; }
  else if (p[2] > WORLD.SZ - HW) { p[2] = WORLD.SZ - HW; if (v[2] > 0) v[2] = 0; }

  return s;
}
