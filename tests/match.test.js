import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, sync, fresh, sleep, skyDuel, norm, sub } from './helpers/server.js';
import { World } from '../shared/world.js';
import { collides } from '../shared/physics.js';
import {
  B, STATE, PLAYER, START_MATS, WEAPONS, HEADSHOT_MULT, COUNTDOWN_SECS, ENDED_SECS,
  MAX_BOTS, STORM_PHASES, STORM_START_RADIUS, WORLD,
} from '../shared/constants.js';

const T = { timeout: 30000 };
const RIFLE_GAP = 1000 / WEAPONS.rifle.rate + 30;

describe('match flow with bots', T, () => {
  let ctx, game, a, b;
  const errors = [];
  const origError = console.error;
  before(async () => {
    console.error = (...args) => { errors.push(args.map(String).join(' ')); };
    ctx = await boot();
    game = ctx.game;
    a = await ctx.client('Host');
    b = await ctx.client('Guest');
  }, T);
  after(async () => {
    console.error = origError;
    if (ctx) await ctx.close();
  }, T);

  let oldSeed;

  test('start with bots -> world, bots joined, everyone reset and teleported, countdown', T, async () => {
    oldSeed = game.world.seed;
    ctx.player(a.id).mats.wood = 123;
    game.grant(a.id, 'sniper');
    await fresh(a, b);
    b.send({ t: 'start', bots: 3 }); // any player may start
    for (const bot of [a, b]) {
      const st = await bot.waitFor('state', (m) => m.state === STATE.COUNTDOWN);
      assert.ok(Math.abs(st.timer - COUNTDOWN_SECS) < 0.01, `countdown timer ${st.timer}`);
      assert.equal(st.winner, null);
      const w = await bot.waitFor('world');
      assert.ok(Number.isInteger(w.seed));
      assert.notEqual(w.seed, oldSeed, 'a new match needs a new seed');
      assert.equal(w.seed | 0, game.world.seed);
      const joined = bot.all('joined', (m) => m.bot !== false);
      assert.equal(joined.length, 3, `expected 3 bot joins, got ${joined.length}`);
      for (const j of joined) {
        assert.equal(j.bot, true);
        assert.match(j.name, /^Bot \S+/);
      }
      assert.equal(new Set(joined.map((j) => j.name)).size, 3, 'bot names must be unique');
      const c = await bot.waitFor('correct');
      const pl = ctx.player(bot.id);
      assert.ok(Math.hypot(c.p[0] - pl.p[0], c.p[1] - pl.p[1], c.p[2] - pl.p[2]) < 0.02);
      const you = bot.last('you');
      assert.ok(you, 'reset loadout should be sent as `you`');
      assert.deepEqual(you.mats, START_MATS);
      assert.deepEqual(you.owned, [true, false, false, false]);
      assert.equal(you.hp, PLAYER.MAX_HP);
      assert.equal(you.sh, 0);
      assert.equal(you.alive, true);
    }
    assert.equal(game.state, STATE.COUNTDOWN);
    assert.equal(game.players.size, 5);
    // the world message must come before the spawn teleport so the client regenerates first
    const order = a.messages.slice(a._mark).map((m) => m.t);
    assert.ok(order.indexOf('world') < order.indexOf('correct'), `message order ${order}`);
    // fresh world: no edits, every spawn on free ground, spread out
    const regen = new World(game.world.seed);
    assert.equal(Buffer.compare(Buffer.from(regen.data), Buffer.from(game.world.data)), 0);
    const pts = [...game.players.values()].map((p) => p.p);
    for (const p of pts) assert.equal(collides(game.world, p), false, `spawn ${p} inside blocks`);
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
      assert.ok(Math.hypot(pts[i][0] - pts[j][0], pts[i][2] - pts[j][2]) > 3, 'spawns should be spread out');
    }
  });

  test('start is ignored outside the lobby; bots do nothing during countdown', T, async () => {
    const seed = game.world.seed;
    const botsBefore = [...game.players.values()].filter((p) => p.bot).map((p) => [p.id, ...p.p]);
    a.mark();
    a.send({ t: 'start', bots: 5 });
    await sync(a);
    ctx.advance(1);
    assert.equal(game.world.seed, seed);
    assert.equal(game.players.size, 5);
    assert.equal(a.find('world'), null);
    assert.equal(game.state, STATE.COUNTDOWN);
    for (const [id, x, , z] of botsBefore) {
      const p = ctx.player(id).p;
      assert.ok(Math.hypot(p[0] - x, p[2] - z) < 0.01, 'bots only act during PLAYING');
    }
    const s = await ctx.snap(a);
    assert.equal(s.state, STATE.COUNTDOWN);
    assert.ok(s.timer > 0 && s.timer < COUNTDOWN_SECS, `snap timer ${s.timer}`);
    assert.equal(s.players.length, 5);
    assert.equal(s.alive, 5);
  });

  test('countdown -> playing', T, async () => {
    await fresh(a, b);
    ctx.advance(COUNTDOWN_SECS + 0.2);
    for (const bot of [a, b]) {
      const st = await bot.waitFor('state', (m) => m.state === STATE.PLAYING);
      assert.equal(st.winner, null);
    }
    assert.equal(game.state, STATE.PLAYING);
    const s = await ctx.snap(a);
    assert.equal(s.state, STATE.PLAYING);
    assert.equal(s.storm.phase, 0);
    assert.equal(s.storm.shrinking, false);
    assert.equal(s.storm.r, STORM_START_RADIUS);
    assert.equal(s.storm.tr, STORM_PHASES[0].radius);
    assert.ok(s.storm.timer > STORM_PHASES[0].wait - 3 && s.storm.timer <= STORM_PHASES[0].wait);
    assert.ok(Math.hypot(s.storm.tx - WORLD.SX / 2, s.storm.tz - WORLD.SZ / 2) <= STORM_START_RADIUS, 'next circle inside the previous one');
  });

  test('a player joining mid-match spectates and gets the current seed', T, async () => {
    const c = await ctx.client('Latecomer');
    assert.equal(c.welcome.state, STATE.PLAYING);
    assert.equal(c.welcome.seed | 0, game.world.seed);
    assert.equal(c.welcome.you.alive, false);
    assert.equal(ctx.player(c.id).alive, false);
    assert.equal(c.welcome.players.filter((p) => p.bot).length, 3);
    const s = await ctx.snap(c);
    assert.equal(s.players.find((p) => p.id === c.id).alive, false);
    assert.equal(s.alive, 5, 'spectators do not count as alive');
    // spectators cannot act
    c.mark();
    const eye = ctx.eye(c.id);
    c.send({ t: 'build', piece: 'block', x: Math.floor(eye[0]), y: Math.floor(eye[1]) + 3, z: Math.floor(eye[2]), facing: 0, mat: 'wood' });
    c.send({ t: 'fire', o: eye, d: [0, -1, 0] });
    await sync(c);
    assert.equal(c.find('blocks'), null);
    assert.equal(c.find('shot'), null);
    assert.equal(game.state, STATE.PLAYING, 'a spectator joining must not end the match');
    await c.close();
    await sleep(30);
    assert.equal(game.state, STATE.PLAYING, 'a spectator leaving must not end the match');
  });

  test('60 simulated seconds with bots: no errors, bots move, state stays sane', T, async () => {
    const start = new Map([...game.players.values()].filter((p) => p.bot).map((p) => [p.id, [...p.p]]));
    assert.equal(start.size, 3);
    let moved = 0;
    for (let i = 0; i < 1200; i++) {
      game.tickOnce(0.05);
      if (i % 100 === 99) await sleep(1); // let sockets drain
      for (const pl of game.players.values()) {
        for (const v of pl.p) assert.ok(Number.isFinite(v), `non-finite position for ${pl.name}`);
        assert.ok(pl.hp >= 0 && pl.hp <= PLAYER.MAX_HP);
        assert.ok(pl.sh >= 0 && pl.sh <= PLAYER.MAX_SHIELD);
        if (pl.bot && pl.alive && game.state === STATE.PLAYING) {
          assert.equal(collides(game.world, pl.p), false, `bot ${pl.name} is inside blocks at ${pl.p} (tick ${i})`);
          assert.ok(pl.p[1] >= 0, `bot fell out of the world: ${pl.p}`);
        }
      }
      assert.ok(Object.values(STATE).includes(game.state));
    }
    for (const [id, p0] of start) {
      const pl = game.players.get(id);
      if (pl && Math.hypot(pl.p[0] - p0[0], pl.p[2] - p0[2]) > 2) moved++;
    }
    assert.ok(moved >= 1 || game.state !== STATE.PLAYING, 'no bot moved in 60 s of play');
    assert.deepEqual(errors, [], 'server logged errors during the bot match');
    const s = await ctx.snap(a);
    assert.ok(s.players.length >= 2);
  });

  test('all humans disconnect -> lobby, bots dropped', T, async () => {
    await a.close();
    await b.close();
    await sleep(60);
    assert.equal(game.state, STATE.LOBBY);
    assert.equal(game.players.size, 0);
    game.tickOnce(0.05);
    const c = await ctx.client('Next');
    assert.equal(c.welcome.state, STATE.LOBBY);
    assert.equal(c.welcome.players.length, 1);
    assert.equal(c.welcome.you.alive, true);
    assert.deepEqual(errors, []);
  });

  test('bots is clamped to MAX_BOTS', T, async () => {
    const c = ctx.bots[ctx.bots.length - 1];
    c.mark();
    c.send({ t: 'start', bots: 999 });
    await c.waitFor('state', (m) => m.state === STATE.COUNTDOWN);
    assert.equal([...game.players.values()].filter((p) => p.bot).length, MAX_BOTS);
    ctx.advance(COUNTDOWN_SECS + 0.1);
    ctx.advance(10); // a full lobby of bots fighting must not throw
    assert.deepEqual(errors, []);
  });
});

describe('combat between two clients', T, () => {
  let ctx, game, a, b, pa, pb, eye;
  const SEP = 5;
  before(async () => {
    ctx = await boot();
    game = ctx.game;
    a = await ctx.client('Shooter');
    b = await ctx.client('Target');
    game.setState(STATE.PLAYING);
    pa = ctx.player(a.id); pb = ctx.player(b.id);
    const spots = skyDuel(game.world, SEP);
    ctx.place(a.id, spots.a);
    ctx.place(b.id, spots.b);
    eye = ctx.eye(a.id);
  }, T);
  after(async () => { if (ctx) await ctx.close(); }, T);

  const aimAt = (h) => norm(sub([pb.p[0], pb.p[1] + h, pb.p[2]], eye));
  async function shoot(h = 0.9) {
    await sleep(RIFLE_GAP);
    a.mark(); b.mark();
    a.send({ t: 'fire', o: eye, d: aimAt(h) });
    await sync(a);
    await sync(b);
  }

  test('setState(PLAYING) is broadcast', T, async () => {
    assert.equal(game.state, STATE.PLAYING);
    const st = await a.waitFor('state', (m) => m.state === STATE.PLAYING);
    assert.ok(st);
  });

  test('grant gives the weapon with a full mag and reserve; pickaxe does melee only', T, async () => {
    a.mark();
    assert.notEqual(game.grant(a.id, 'rifle'), false);
    const you = await a.waitFor('you', (m) => m.owned[1]);
    assert.equal(you.ammo[1], WEAPONS.rifle.mag);
    assert.ok(you.reserve[1] > 0);
    assert.equal(pa.owned[1], true);
    // still holding the pickaxe: out of reach at 5 blocks
    a.send({ t: 'fire', o: eye, d: aimAt(0.9) });
    await sync(a); await sync(b);
    assert.equal(pb.hp, PLAYER.MAX_HP);
    a.send({ t: 'slot', i: 1 });
    const y2 = await a.waitFor('you', (m) => m.slot === 1);
    assert.equal(y2.slot, 1);
  });

  test('rifle body shot: hurt, hitmark, shot broadcast, ammo used', T, async () => {
    await shoot(0.9);
    const hurt = b.find('hurt');
    assert.ok(hurt, 'target received no `hurt`');
    assert.deepEqual(hurt, { t: 'hurt', from: a.id, dmg: WEAPONS.rifle.dmg, hp: PLAYER.MAX_HP - WEAPONS.rifle.dmg, sh: 0 });
    const hm = a.find('hitmark');
    assert.deepEqual(hm, { t: 'hitmark', dmg: WEAPONS.rifle.dmg, head: false, kill: false });
    assert.equal(b.find('hitmark'), null);
    assert.equal(a.find('hurt'), null);
    for (const bot of [a, b]) {
      const shot = bot.find('shot');
      assert.ok(shot, 'shot must be broadcast to everyone');
      assert.equal(shot.id, a.id);
      assert.equal(shot.w, 'rifle');
      assert.equal(shot.hitPlayer, true);
      assert.equal(shot.ends.length, 1);
      const end = shot.ends[0];
      assert.ok(Math.abs(end[2] - (pb.p[2] + PLAYER.WIDTH / 2)) < 0.12, `tracer should stop at the target, ended at ${end}`);
      assert.ok(Math.hypot(shot.o[0] - eye[0], shot.o[1] - eye[1], shot.o[2] - eye[2]) < 0.02);
    }
    assert.equal(pb.hp, 78);
    assert.equal(a.last('you').ammo[1], WEAPONS.rifle.mag - 1);
    assert.equal(b.last('you').hp, 78);
    const s = await ctx.snap(a);
    assert.equal(s.players.find((p) => p.id === b.id).hp, 78);
  });

  test('headshot multiplier', T, async () => {
    pb.hp = 100;
    await shoot(1.65);
    const dmg = Math.round(WEAPONS.rifle.dmg * HEADSHOT_MULT);
    assert.deepEqual(a.find('hitmark'), { t: 'hitmark', dmg, head: true, kill: false });
    assert.equal(b.find('hurt').dmg, dmg);
    assert.equal(pb.hp, 100 - dmg);
  });

  test('shield absorbs damage first', T, async () => {
    pb.hp = 100; pb.sh = 30;
    await shoot(0.9);
    assert.deepEqual(b.find('hurt'), { t: 'hurt', from: a.id, dmg: 22, hp: 100, sh: 8 });
    await shoot(0.9);
    assert.deepEqual(b.find('hurt'), { t: 'hurt', from: a.id, dmg: 22, hp: 86, sh: 0 });
    assert.equal(pb.hp, 86);
    assert.equal(pb.sh, 0);
  });

  test('a block in the way stops the bullet and takes block damage', T, async () => {
    const cell = [Math.floor(eye[0]), Math.floor(eye[1]), Math.floor(eye[2]) - 2];
    assert.equal(game.world.get(...cell), B.AIR);
    game.world.set(...cell, B.PLANKS);
    const hp0 = pb.hp;
    await shoot(1.5);
    assert.equal(pb.hp, hp0, 'bullet passed through a block');
    assert.equal(b.find('hurt'), null);
    assert.equal(a.find('hitmark'), null);
    const shot = b.find('shot');
    assert.equal(shot.hitPlayer, false);
    assert.ok(Math.abs(shot.ends[0][2] - (cell[2] + 1)) < 0.02, `tracer end ${shot.ends[0]}`);
    // PLANKS hp 50, rifle blockDmg 12 -> breaks on the 5th hit and grants +1 wood (not a pickaxe)
    const wood0 = pa.mats.wood;
    let n = 1;
    while (game.world.get(...cell) !== B.AIR && n < 8) { await shoot(1.5); n++; }
    assert.equal(n, Math.ceil(50 / WEAPONS.rifle.blockDmg));
    assert.equal(pb.hp, hp0);
    assert.equal(pa.mats.wood, wood0 + 1);
    assert.ok(b.find('blocks', (m) => m.edits.some((e) => e.join(',') === [...cell, B.AIR].join(','))));
  });

  test('fire rate is enforced for the rifle', T, async () => {
    await sleep(400);
    const hp0 = pb.hp;
    pb.hp = 100;
    a.mark(); b.mark();
    for (let i = 0; i < 12; i++) a.send({ t: 'fire', o: eye, d: aimAt(0.9) });
    await sync(a); await sync(b);
    const shots = b.all('shot').length;
    assert.ok(shots >= 1 && shots <= 3, `${shots} of 12 same-instant shots were accepted (rate ${WEAPONS.rifle.rate}/s)`);
    pb.hp = hp0;
  });

  test('reload: timer, refill from reserve, cannot fire while reloading or with an empty mag', T, async () => {
    pa.ammo[1] = 0;
    pa.reserve[1] = 40;
    const hp0 = pb.hp;
    await shoot(0.9); // empty mag: no shot (may auto-start a reload)
    assert.equal(b.find('shot'), null, 'fired with an empty magazine');
    assert.equal(pb.hp, hp0);
    a.send({ t: 'reload' });
    const y = await a.waitFor('you', (m) => m.reloading === true);
    assert.equal(y.ammo[1], 0);
    ctx.advance(WEAPONS.rifle.reload - 0.5);
    await shoot(0.9);
    assert.equal(b.find('shot'), null, 'fired while reloading');
    a.mark();
    ctx.advance(0.7);
    const y2 = await a.waitFor('you', (m) => m.reloading === false);
    assert.equal(y2.ammo[1], WEAPONS.rifle.mag);
    assert.equal(y2.reserve[1], 40 - WEAPONS.rifle.mag);
    // partial refill when the reserve is short
    pa.ammo[1] = 25; pa.reserve[1] = 3;
    a.send({ t: 'reload' });
    await sync(a);
    a.mark();
    ctx.advance(WEAPONS.rifle.reload + 0.1);
    const y3 = await a.waitFor('you', (m) => m.reloading === false);
    assert.equal(y3.ammo[1], 28);
    assert.equal(y3.reserve[1], 0);
    // full mag: reload is a no-op
    pa.ammo[1] = WEAPONS.rifle.mag; pa.reserve[1] = 60;
    a.send({ t: 'reload' });
    await sync(a);
    assert.equal(pa.reloading, false);
    assert.equal(pb.hp, hp0);
  });

  test('kill: broadcast, victim spectates, killer takes materials, match ends with a winner', T, async () => {
    pb.hp = 30; pb.sh = 0;
    pb.mats.wood = 40; pb.mats.stone = 7; pb.mats.metal = 0;
    pa.mats.wood = 30; pa.mats.stone = 0; pa.mats.metal = 2;
    await shoot(0.9);
    assert.equal(pb.hp, 8);
    assert.equal(game.state, STATE.PLAYING);
    await shoot(0.9);
    assert.deepEqual(a.find('hitmark'), { t: 'hitmark', dmg: 22, head: false, kill: true });
    for (const bot of [a, b]) {
      assert.deepEqual(bot.find('kill'), { t: 'kill', killer: a.id, victim: b.id, w: 'rifle', respawn: 0, lives: 0 });
      const st = await bot.waitFor('state', (m) => m.state === STATE.ENDED);
      assert.equal(st.winner, a.id);
      assert.equal(st.winnerName, 'Shooter');
      assert.ok(Math.abs(st.timer - ENDED_SECS) < 0.01);
    }
    assert.equal(b.find('hurt').hp, 0);
    const by = await b.waitFor('you', (m) => m.alive === false);
    assert.equal(by.hp, 0);
    assert.deepEqual(by.mats, { wood: 0, stone: 0, metal: 0 });
    const ay = await a.waitFor('you', (m) => m.kills === 1);
    assert.deepEqual(ay.mats, { wood: 70, stone: 7, metal: 2 });
    assert.equal(pb.alive, false);
    assert.equal(game.state, STATE.ENDED);
    const s = await ctx.snap(a);
    assert.equal(s.state, STATE.ENDED);
    assert.equal(s.alive, 1);
    assert.equal(s.players.find((p) => p.id === b.id).alive, false);
    assert.ok(s.timer > 0 && s.timer <= ENDED_SECS);
  });

  test('dead players cannot move, fire or build', T, async () => {
    const p0 = [...pb.p];
    b.mark(); a.mark();
    b.send({ t: 'pos', p: [p0[0] + 0.5, p0[1], p0[2]], yaw: 0, pitch: 0 });
    b.send({ t: 'fire', o: ctx.eye(b.id), d: [0, 0, 1] });
    b.send({ t: 'build', piece: 'block', x: Math.floor(p0[0]), y: Math.floor(p0[1]) - 2, z: Math.floor(p0[2]), facing: 0, mat: 'wood' });
    await sync(b); await sync(a);
    assert.deepEqual(pb.p, p0);
    assert.ok(b.find('correct'), 'dead player pos should be answered with `correct`');
    assert.equal(a.find('shot'), null);
    assert.equal(a.find('blocks'), null);
  });

  test('ended -> lobby after ENDED_SECS: everyone alive again at a fresh spawn, same map', T, async () => {
    const seed = game.world.seed;
    await fresh(a, b);
    ctx.advance(ENDED_SECS - 1);
    assert.equal(game.state, STATE.ENDED);
    ctx.advance(1.2);
    for (const bot of [a, b]) {
      const st = await bot.waitFor('state', (m) => m.state === STATE.LOBBY);
      assert.equal(st.winner, null);
      const c = await bot.waitFor('correct');
      const pl = ctx.player(bot.id);
      assert.ok(Math.hypot(c.p[0] - pl.p[0], c.p[2] - pl.p[2]) < 0.02);
      assert.equal(collides(game.world, pl.p), false);
      assert.ok(game.world.isSolid(Math.floor(pl.p[0]), Math.floor(pl.p[1]) - 1, Math.floor(pl.p[2])), 'respawn on the ground');
    }
    assert.equal(game.world.seed, seed);
    assert.equal(a.find('world'), null, 'same map: no world message');
    const by = await b.waitFor('you', (m) => m.alive === true);
    assert.equal(by.hp, PLAYER.MAX_HP);
    assert.equal(pb.alive, true);
    const s = await ctx.snap(a);
    assert.equal(s.state, STATE.LOBBY);
    assert.equal(s.alive, 2);
    assert.equal(s.storm.r, STORM_START_RADIUS);
  });

  test('disconnect of one of two combatants ends the match for the other', T, async () => {
    game.setState(STATE.PLAYING);
    a.mark();
    await b.close();
    const st = await a.waitFor('state', (m) => m.state === STATE.ENDED);
    assert.equal(st.winner, a.id);
  });
});

describe('storm and solo match', T, () => {
  let ctx, game, a, pa;
  before(async () => {
    ctx = await boot();
    game = ctx.game;
    a = await ctx.client('Solo');
  }, T);
  after(async () => { if (ctx) await ctx.close(); }, T);

  test('solo start with 0 bots does not end immediately', T, async () => {
    a.send({ t: 'start', bots: 0 });
    await a.waitFor('state', (m) => m.state === STATE.COUNTDOWN);
    ctx.advance(COUNTDOWN_SECS + 0.1);
    await a.waitFor('state', (m) => m.state === STATE.PLAYING);
    ctx.advance(5);
    assert.equal(game.state, STATE.PLAYING);
    assert.equal(game.players.size, 1);
    pa = ctx.player(a.id);
    assert.equal(pa.alive, true);
    assert.equal(pa.hp, PLAYER.MAX_HP);
  });

  test('storm waits, shrinks to the phase radius, and hurts players outside (bypassing shield)', T, async () => {
    ctx.place(a.id, [2.5, 40, 2.5]); // far corner of the map, hovering
    pa.sh = 50;
    const ph = STORM_PHASES[0];
    // still inside the start circle during the wait
    ctx.advance(ph.wait - 8, 0.5);
    assert.equal(pa.hp, PLAYER.MAX_HP, 'no storm damage while inside the circle');
    let s = await ctx.snap(a);
    assert.equal(s.storm.phase, 0);
    assert.equal(s.storm.shrinking, false);
    assert.equal(s.storm.r, STORM_START_RADIUS);
    const target = [s.storm.tx, s.storm.tz, s.storm.tr];
    assert.equal(target[2], ph.radius);
    // halfway through the shrink
    while (game.storm ? !(game.storm.shrinking) : false) ctx.advance(0.5, 0.5);
    ctx.advance(ph.shrink / 2, 0.5);
    s = await ctx.snap(a);
    assert.equal(s.storm.shrinking, true);
    assert.ok(s.storm.r < STORM_START_RADIUS - 5 && s.storm.r > ph.radius + 5, `mid-shrink radius ${s.storm.r}`);
    assert.deepEqual([s.storm.tx, s.storm.tz, s.storm.tr], target, 'target circle must not change while shrinking');
    // finish the shrink
    ctx.advance(ph.shrink / 2 + 3, 0.5);
    s = await ctx.snap(a);
    assert.equal(s.storm.phase, 1);
    assert.ok(Math.abs(s.storm.r - ph.radius) < 0.5, `radius after phase 0: ${s.storm.r}`);
    assert.ok(Math.hypot(s.storm.x - target[0], s.storm.z - target[1]) < 0.5, 'storm ends centred on its target');
    assert.equal(s.storm.tr, STORM_PHASES[1].radius);
    assert.ok(Math.hypot(s.storm.tx - s.storm.x, s.storm.tz - s.storm.z) <= s.storm.r - s.storm.tr + 0.01, 'next circle lies inside the current one');
    // the corner is > 70 from any allowed centre, so the player has been taking damage
    assert.ok(pa.hp < PLAYER.MAX_HP, 'player outside the storm took no damage');
    assert.ok(pa.hp > 40, `phase 0 is 1 dps, hp is ${pa.hp}`);
    assert.equal(pa.sh, 50, 'storm damage bypasses shield');
    const hurt = a.messages.find((m) => m.t === 'hurt');
    assert.ok(hurt);
    assert.equal(hurt.from, null);
    assert.equal(hurt.dmg, ph.dps);
    assert.equal(hurt.sh, 50);
  });

  test('storm damage scales with the phase and kills; solo match ends when the player dies', T, async () => {
    await fresh(a);
    const hp0 = pa.hp;
    ctx.advance(10, 0.5);
    await sync(a);
    const hurts = a.all('hurt');
    assert.ok(hurts.length >= 9 && hurts.length <= 11, `${hurts.length} storm ticks in 10 s`);
    assert.ok(hurts.every((h) => h.dmg === STORM_PHASES[1].dps && h.from === null));
    assert.equal(pa.hp, hp0 - hurts.length * STORM_PHASES[1].dps);
    a.mark();
    for (let i = 0; i < 400 && game.state === STATE.PLAYING; i++) game.tickOnce(0.5);
    const k = await a.waitFor('kill');
    assert.equal(k.killer, null);
    assert.equal(k.victim, a.id);
    const st = await a.waitFor('state', (m) => m.state === STATE.ENDED);
    assert.equal(st.winner, null);
    assert.equal(pa.alive, false);
    assert.equal(pa.hp, 0);
    const y = await a.waitFor('you', (m) => m.alive === false);
    assert.equal(y.hp, 0);
  });

  test('storm runs through every phase down to radius 0 without errors', T, async () => {
    const errors = [];
    const orig = console.error;
    console.error = (...x) => errors.push(x.join(' '));
    try {
      ctx.advance(ENDED_SECS + 1, 0.5);
      assert.equal(game.state, STATE.LOBBY);
      await fresh(a);
      a.send({ t: 'start', bots: 0 });
      await a.waitFor('state', (m) => m.state === STATE.COUNTDOWN);
      ctx.advance(COUNTDOWN_SECS + 0.1);
      const total = STORM_PHASES.reduce((n, p) => n + p.wait + p.shrink, 0);
      let lastR = Infinity;
      const pl = ctx.player(a.id);
      for (let t = 0; t < total + 20; t += 0.5) {
        pl.hp = PLAYER.MAX_HP; // keep the match alive
        game.tickOnce(0.5);
        if (Math.round(t * 2) % 10 !== 0) continue;
        const s = await ctx.snap(a);
        assert.ok(s.storm.r <= lastR + 1e-6, `storm grew from ${lastR} to ${s.storm.r}`);
        assert.ok(s.storm.r >= 0);
        assert.ok(s.storm.phase >= 0 && s.storm.phase < STORM_PHASES.length);
        lastR = s.storm.r;
      }
      assert.equal((await ctx.snap(a)).storm.r, 0);
      assert.deepEqual(errors, []);
    } finally {
      console.error = orig;
    }
  });
});
