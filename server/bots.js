// Server-side bots. They are ordinary players (bot:true) moved with the shared
// stepPlayer and acting through the same game.fire / game.openChest paths as humans.

import { PLAYER, WEAPONS, WEAPON_IDS, STATE, B, WORLD, BOT_LEVELS } from '../shared/constants.js';
import { raycast } from '../shared/world.js';
import { stepPlayer } from '../shared/physics.js';

export const BOT_NAMES = [
  'Kiwi', 'Mango', 'Pebble', 'Fern', 'Otter', 'Maple', 'Comet', 'Biscuit',
  'Juniper', 'Pixel', 'Tango', 'Nimbus', 'Clover', 'Sprocket', 'Waffle', 'Marble',
];

const level = (game) => game.botLevel || BOT_LEVELS.normal;
const IDLE = { fwd: 0, right: 0, yaw: 0, jump: false, sprint: false };

export function initBot(bot) {
  bot.ai = {
    think: Math.random() * 0.4,   // staggered so bots don't all raycast on the same tick
    target: 0,                    // id of the current enemy (0 = none)
    nextFire: 0,
    chest: null,
    chestT: 0,
    goal: null,                   // wander goal [x,z]
    stuckT: 0,
    detourT: 0,
    detourYaw: 0,
    strafe: Math.random() < 0.5 ? -1 : 1,
    strafeT: 0,
    hurtBy: 0,
    input: { fwd: 0, right: 0, yaw: 0, jump: false, sprint: false },
  };
}

function hasLineOfSight(game, eye, q) {
  const tx = q.p[0] - eye[0], ty = q.p[1] + 1.0 - eye[1], tz = q.p[2] - eye[2];
  const d = Math.hypot(tx, ty, tz);
  if (d < 0.5) return true;
  const hit = raycast(game.world, eye, [tx / d, ty / d, tz / d], d);
  return !hit || hit.dist >= d - 0.4;
}

function think(game, bot, ai) {
  const eye = game.eyeOf(bot);
  const L = level(game), sight = L.sight;
  // nearest living combatants within sight; line-of-sight test on the closest few only
  const near = [];
  for (const q of game.players.values()) {
    if (q === bot || !q.alive || (bot.team && q.team === bot.team)) continue;
    const d = Math.hypot(q.p[0] - bot.p[0], q.p[1] - bot.p[1], q.p[2] - bot.p[2]);
    if (d <= sight) near.push([d, q]);
  }
  near.sort((a, b) => a[0] - b[0]);
  let found = 0;
  for (let i = 0; i < near.length && i < 3; i++) {
    if (hasLineOfSight(game, eye, near[i][1])) { found = near[i][1].id; break; }
  }
  if (found !== ai.target) {
    ai.target = found;
    // reaction delay before the first shot at a newly seen enemy
    if (found) ai.nextFire = Math.max(ai.nextFire, game.time + (0.6 + Math.random() * 0.6) * L.react);
  }

  // chests: always wanted while unarmed, otherwise only now and then
  ai.chestT -= 1;
  if (ai.chest && game.world.get(ai.chest[0], ai.chest[1], ai.chest[2]) !== B.CHEST) ai.chest = null;
  if (!ai.chest && ai.chestT <= 0) {
    ai.chestT = 4;
    const armed = bot.owned[1] || bot.owned[2] || bot.owned[3];
    if (!armed || Math.random() < 0.3) {
      let best = null, bd = armed ? 18 : 40;
      for (const c of game.chestsLeft) {
        const d = Math.hypot(c[0] + 0.5 - bot.p[0], c[2] + 0.5 - bot.p[2]);
        if (d < bd) { bd = d; best = c; }
      }
      ai.chest = best;
    }
  }
}

function pickWeapon(game, bot, dist) {
  // preference by range; fall back to anything with ammo, then the pickaxe
  // (slots: 1 rifle, 2 shotgun, 3 sniper, 4 bazooka, 5 sword; no bazooka up close)
  const order = dist < 12 ? [2, 1, 3] : dist > 40 ? [3, 1, 4, 2] : [1, 4, 3, 2];
  for (const s of order) {
    if (bot.owned[s] && bot.ammo[s] + bot.reserve[s] > 0) return s;
  }
  return bot.owned[5] ? 5 : 0;
}

function shoot(game, bot, ai, target, dist) {
  const slot = pickWeapon(game, bot, dist);
  if (bot.slot !== slot) { game.selectSlot(bot, slot); ai.nextFire = Math.max(ai.nextFire, game.time + 0.35); return; }
  const W = WEAPONS[WEAPON_IDS[slot]];
  if (W.melee) {
    if (dist > W.range) return;
  } else {
    if (dist > W.range) return;
    if (bot.reloading) return;
    if (bot.ammo[slot] <= 0) { game.startReload(bot); return; }
  }
  const eye = game.eyeOf(bot);
  // deliberate inaccuracy: roughly 35 % at mid range, better up close, worse far away
  const L = level(game);
  const pHit = Math.min(0.92, (W.melee ? 0.7 : Math.min(0.42, Math.max(0.12, 0.47 - 0.006 * dist))) * L.hit);
  let ax = target.p[0], ay = target.p[1] + 0.95, az = target.p[2];
  if (Math.random() < pHit) {
    ax += (Math.random() - 0.5) * 0.2; ay += (Math.random() - 0.5) * 0.5; az += (Math.random() - 0.5) * 0.2;
  } else {
    // offset sideways, perpendicular to the line of sight, so a miss really misses
    const lx = ax - eye[0], lz = az - eye[2], ll = Math.hypot(lx, lz) || 1;
    const m = (0.9 + Math.random() * 1.3) * (Math.random() < 0.5 ? -1 : 1);
    ax += (-lz / ll) * m; az += (lx / ll) * m; ay += (Math.random() - 0.3) * 1.6;
  }
  game.fire(bot, eye, [ax - eye[0], ay - eye[1], az - eye[2]], true);
  ai.nextFire = game.time + (1 / W.rate) * (1.6 + Math.random()) * L.cadence;
}

export function updateBot(game, bot, dt) {
  if (!bot.ai) initBot(bot);
  const ai = bot.ai;
  const world = game.world;
  const active = game.state === STATE.PLAYING && bot.alive;

  if (!active) {
    // still obey gravity (the floor may have been harvested from under it)
    if (bot.alive) step(game, bot, IDLE, dt);
    return;
  }

  ai.think -= dt;
  if (ai.think <= 0) {
    ai.think = 0.25 + Math.random() * 0.15;
    think(game, bot, ai);
  }

  let target = ai.target ? game.players.get(ai.target) : null;
  if (target && !target.alive) { target = null; ai.target = 0; }

  const st = game.storm;
  const px = bot.p[0], pz = bot.p[2];
  const armed = bot.owned[1] || bot.owned[2] || bot.owned[3];
  // unsafe when outside the current circle or (nearly) outside the next one
  const dNext = Math.hypot(px - st.tx, pz - st.tz);
  const dNow = Math.hypot(px - st.x, pz - st.z);
  const unsafe = dNow > st.r - 3 || (dNext > Math.max(st.tr - 4, 2) && (st.shrinking || st.timer < 20));

  // ---- where to go ----
  let gx, gz, sprint = false, wantMove = true;
  let tdist = 0;
  if (target) tdist = Math.hypot(target.p[0] - px, target.p[1] - bot.p[1], target.p[2] - pz);

  if (unsafe) {
    gx = st.tx; gz = st.tz; sprint = true;
    if (dNext < 1.5) wantMove = false;
  } else if (target && (armed || tdist < 8 || !ai.chest)) {
    const dx = target.p[0] - px, dz = target.p[2] - pz, d = Math.hypot(dx, dz) || 1;
    if (!armed) { gx = target.p[0]; gz = target.p[2]; sprint = true; if (d < 1.2) wantMove = false; } else {
      ai.strafeT -= dt;
      if (ai.strafeT <= 0) { ai.strafeT = 0.8 + Math.random() * 1.6; ai.strafe = -ai.strafe; }
      // keep a mid-range distance while circling
      const along = d > 24 ? 1 : d < 9 ? -0.8 : 0.15;
      const sx = -dz / d * ai.strafe, sz = dx / d * ai.strafe;
      gx = px + (dx / d) * along * 4 + sx * 3;
      gz = pz + (dz / d) * along * 4 + sz * 3;
    }
  } else if (ai.chest) {
    gx = ai.chest[0] + 0.5; gz = ai.chest[2] + 0.5;
    const eye = game.eyeOf(bot);
    const cd = Math.hypot(gx - eye[0], ai.chest[1] + 0.5 - eye[1], gz - eye[2]);
    if (cd <= PLAYER.REACH + 0.8) {
      game.openChest(bot, ai.chest[0], ai.chest[1], ai.chest[2]);
      ai.chest = null;
      ai.chestT = 2;
    }
  } else {
    // wander around the storm's next centre
    if (!ai.goal || Math.hypot(ai.goal[0] - px, ai.goal[1] - pz) < 4 ||
        Math.hypot(ai.goal[0] - st.tx, ai.goal[1] - st.tz) > Math.max(st.tr - 2, 1)) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * Math.min(Math.max(st.tr - 4, 0), 30);
      ai.goal = [
        Math.min(WORLD.SX - 2, Math.max(2, st.tx + Math.cos(a) * r)),
        Math.min(WORLD.SZ - 2, Math.max(2, st.tz + Math.sin(a) * r)),
      ];
    }
    gx = ai.goal[0]; gz = ai.goal[1];
    if (Math.hypot(gx - px, gz - pz) < 1) wantMove = false;
  }

  // ---- steering ----
  let mx = gx - px, mz = gz - pz;
  const ml = Math.hypot(mx, mz);
  if (ml > 1e-3) { mx /= ml; mz /= ml; } else { mx = 0; mz = 0; wantMove = false; }
  let moveYaw = Math.atan2(-mx, -mz);
  if (ai.detourT > 0) {
    ai.detourT -= dt;
    moveYaw = ai.detourYaw;
    mx = -Math.sin(moveYaw); mz = -Math.cos(moveYaw);
  }

  // look at the enemy when there is one, else where we walk
  if (target) {
    const eye = game.eyeOf(bot);
    const dx = target.p[0] - eye[0], dy = target.p[1] + 1.0 - eye[1], dz = target.p[2] - eye[2];
    bot.yaw = Math.atan2(-dx, -dz);
    bot.pitch = Math.atan2(dy, Math.hypot(dx, dz) || 1);
  } else if (wantMove) {
    bot.yaw = moveYaw;
    bot.pitch = 0;
  }

  const input = ai.input;
  const sin = Math.sin(bot.yaw), cos = Math.cos(bot.yaw);
  input.yaw = bot.yaw;
  input.fwd = wantMove ? mx * -sin + mz * -cos : 0;
  input.right = wantMove ? mx * cos + mz * -sin : 0;
  input.sprint = sprint;
  input.jump = false;

  // ---- stuck handling: jump, then side-step, then dig ----
  if (wantMove && ai.stuckT > 0.15 && bot.onGround) input.jump = true;
  const bx = bot.p[0], bz = bot.p[2];
  step(game, bot, input, dt);
  if (!bot.alive) return;
  const speed = Math.hypot(bot.p[0] - bx, bot.p[2] - bz) / dt;
  if (wantMove && speed < 1.2) ai.stuckT += dt; else ai.stuckT = Math.max(0, ai.stuckT - dt * 3);
  if (ai.stuckT > 0.9 && ai.detourT <= 0) {
    ai.detourYaw = moveYaw + (Math.random() < 0.5 ? 1 : -1) * (Math.PI / 2 + (Math.random() - 0.5) * 0.6);
    ai.detourT = 0.5 + Math.random() * 0.5;
  }
  if (ai.stuckT > 2.2 && game.time >= ai.nextFire) {
    // boxed in: chew through whatever is in the way with the pickaxe
    if (bot.slot !== 0) game.selectSlot(bot, 0);
    const eye = game.eyeOf(bot);
    const down = Math.random() < 0.5 ? -0.75 : -0.1;
    game.fire(bot, eye, [mx, down, mz], true);
    ai.nextFire = game.time + 0.4;
    if (ai.stuckT > 6) { ai.stuckT = 1; ai.goal = null; ai.chest = null; ai.chestT = 6; }
    return;
  }

  // ---- combat ----
  if (target && game.time >= ai.nextFire) shoot(game, bot, ai, target, tdist);
  else if (!target && !bot.reloading) {
    // top up between fights
    const s = bot.slot;
    if (s > 0 && bot.ammo[s] < WEAPONS[WEAPON_IDS[s]].mag * 0.4 && bot.reserve[s] > 0) game.startReload(bot);
  }
}

function step(game, bot, input, dt) {
  // sub-step so fast-forwarded ticks stay stable
  let n = Math.ceil(dt / 0.05);
  if (n < 1) n = 1; else if (n > 20) n = 20;
  const h = dt / n;
  for (let i = 0; i < n; i++) stepPlayer(game.world, bot, input, h);
  const p = bot.p;
  if (!(p[0] === p[0] && p[1] === p[1] && p[2] === p[2])) {
    // physics produced NaN: put the bot somewhere sane rather than poisoning snapshots
    const s = game.world.spawnPoints(1, Math.random)[0];
    bot.p = [s[0], s[1], s[2]]; bot.v = [0, 0, 0];
  }
  if (p[1] < -5) game.fell(bot);
}
