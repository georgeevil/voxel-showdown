import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, sync, fresh, sleep, findReachable, norm, sub } from './helpers/server.js';
import { World, pieceCells } from '../shared/world.js';
import {
  B, STATE, PLAYER, START_MATS, MAT_BLOCK, PIECE_COST, WEAPONS, WEAPON_IDS, BLOCKS,
  BUILD_RANGE, MAT_MAX, HOTBAR_SLOTS, STORM_START_RADIUS, WORLD,
} from '../shared/constants.js';

const T = { timeout: 20000 };

describe('protocol: lobby', T, () => {
  let ctx, game, a, b;
  before(async () => {
    ctx = await boot();
    game = ctx.game;
    a = await ctx.client('Alice');
    b = await ctx.client('Bob');
  }, T);
  after(async () => { if (ctx) await ctx.close(); }, T);

  test('game test hooks exist', T, () => {
    assert.equal(game.state, STATE.LOBBY);
    assert.ok(game.world instanceof World || typeof game.world.get === 'function');
    assert.ok(game.players instanceof Map);
    for (const fn of ['setState', 'grant', 'tickOnce']) assert.equal(typeof game[fn], 'function', fn);
    const pl = ctx.player(a.id);
    for (const k of ['p', 'hp', 'sh', 'alive', 'mats', 'owned', 'ammo', 'reserve']) {
      assert.ok(k in pl, `player.${k} missing`);
    }
  });

  test('join -> welcome with id, seed, edits, state, players, you', T, () => {
    const w = a.welcome;
    assert.ok(w.id !== undefined && w.id !== null);
    assert.ok(Number.isInteger(w.seed), `seed ${w.seed}`);
    assert.equal(w.seed | 0, game.world.seed);
    assert.ok(Array.isArray(w.edits));
    assert.equal(w.state, STATE.LOBBY);
    assert.ok(Array.isArray(w.players));
    const me = w.players.find((p) => p.id === w.id);
    assert.ok(me, 'welcome.players should include the joining player');
    assert.equal(me.name, 'Alice');
    assert.equal(me.bot, false);
    const you = w.you;
    assert.ok(you && typeof you === 'object', 'welcome.you');
    assert.equal(you.hp, PLAYER.MAX_HP);
    assert.equal(you.sh, 0);
    assert.equal(you.alive, true);
    assert.deepEqual(Object.keys(you.mats).sort(), ['metal', 'stone', 'wood']);
    assert.deepEqual(you.owned, [true, false, false, false]);
    assert.equal(you.ammo.length, HOTBAR_SLOTS);
    assert.equal(you.reserve.length, HOTBAR_SLOTS);
    assert.equal(you.slot, 0);
    assert.equal(you.reloading, false);
    assert.equal(you.kills, 0);
  });

  test('the welcome seed regenerates the server world (plus edits)', T, () => {
    const local = new World(a.welcome.seed);
    for (const [x, y, z, bl] of a.welcome.edits) local.set(x, y, z, bl);
    assert.equal(Buffer.compare(Buffer.from(local.data), Buffer.from(game.world.data)), 0);
  });

  test('second client: welcome lists both, first client gets joined', T, async () => {
    assert.notEqual(a.id, b.id);
    const ids = b.welcome.players.map((p) => p.id);
    assert.ok(ids.includes(a.id) && ids.includes(b.id), `players ${JSON.stringify(b.welcome.players)}`);
    const j = await a.waitFor('joined', (m) => m.id === b.id);
    assert.equal(j.name, 'Bob');
    assert.equal(j.bot, false);
  });

  test('players spawn on land, not inside blocks', T, () => {
    for (const bot of [a, b]) {
      const pl = ctx.player(bot.id);
      const [x, y, z] = pl.p;
      assert.ok(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z));
      assert.ok(y >= WORLD.SEA, `spawn y ${y}`);
      assert.ok(game.world.isSolid(Math.floor(x), Math.ceil(y) - 1, Math.floor(z)) || game.world.isSolid(Math.floor(x), Math.floor(y) - 1, Math.floor(z)), `no ground under spawn ${pl.p}`);
      assert.equal(game.world.get(Math.floor(x), Math.floor(y + 0.01), Math.floor(z)), B.AIR);
      const c = bot.find('correct');
      assert.ok(c, 'spawn position should be sent as `correct`');
      assert.equal(c.p.length, 3);
    }
  });

  test('two clients see each other in snap', T, async () => {
    a.mark(); b.mark();
    for (const bot of [a, b]) {
      const s = await ctx.waitTick(bot, 'snap', (m) => m.players.length >= 2);
      const ids = s.players.map((p) => p.id);
      assert.ok(ids.includes(a.id) && ids.includes(b.id));
      for (const p of s.players) {
        assert.equal(p.p.length, 3);
        for (const k of ['yaw', 'pitch', 'hp', 'sh', 'slot']) assert.equal(typeof p[k], 'number', `snap player.${k}`);
        assert.equal(p.alive, true);
        assert.equal(p.hp, PLAYER.MAX_HP);
      }
      assert.equal(s.state, STATE.LOBBY);
      assert.equal(s.alive, 2);
      for (const k of ['x', 'z', 'r', 'tx', 'tz', 'tr', 'phase', 'timer']) assert.equal(typeof s.storm[k], 'number', `storm.${k}`);
      assert.equal(typeof s.storm.shrinking, 'boolean');
      assert.equal(s.storm.r, STORM_START_RADIUS);
      assert.equal(s.storm.x, WORLD.SX / 2);
      assert.equal(s.storm.z, WORLD.SZ / 2);
    }
  });

  test('pos updates are relayed in snap, rounded to 2 decimals', T, async () => {
    const pl = ctx.player(a.id);
    const p0 = [...pl.p];
    const p1 = [p0[0], p0[1] + 0.123456, p0[2]]; // a small hop: no horizontal move, not inside blocks
    a.send({ t: 'pos', p: p1, yaw: 1.23456, pitch: -0.54321 });
    await sync(a);
    const s = await ctx.snap(b);
    const sa = s.players.find((p) => p.id === a.id);
    assert.ok(Math.abs(sa.p[1] - p1[1]) < 0.006, `y ${sa.p[1]} vs ${p1[1]}`);
    assert.ok(Math.abs(sa.yaw - 1.23456) < 0.006);
    assert.ok(Math.abs(sa.pitch + 0.54321) < 0.006);
    for (const v of sa.p) assert.ok(Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, `position ${v} not rounded to 2 decimals`);
    assert.ok(Math.abs(pl.p[1] - p1[1]) < 0.006, 'server-side position updated');
    a.send({ t: 'pos', p: p0, yaw: 0, pitch: 0 });
    await sync(a);
  });

  test('teleporting pos is rejected with correct', T, async () => {
    const pl = ctx.player(a.id);
    const p0 = [...pl.p];
    a.mark();
    a.send({ t: 'pos', p: [p0[0] + 40, p0[1] + 20, p0[2] + 40], yaw: 0, pitch: 0 });
    const c = await a.waitFor('correct');
    assert.ok(Math.hypot(c.p[0] - p0[0], c.p[2] - p0[2]) < 0.02, `corrected to ${c.p}, expected ${p0}`);
    assert.ok(Math.hypot(pl.p[0] - p0[0], pl.p[2] - p0[2]) < 0.02, 'server position must not change');
  });

  test('pos inside solid blocks is rejected with correct', T, async () => {
    const pl = ctx.player(a.id);
    const p0 = [...pl.p];
    a.mark();
    a.send({ t: 'pos', p: [p0[0], p0[1] - 1.5, p0[2]], yaw: 0, pitch: 0 });
    await a.waitFor('correct');
    assert.ok(Math.abs(pl.p[1] - p0[1]) < 0.02);
  });

  test('ping -> pong', T, async () => {
    a.mark();
    a.send({ t: 'ping', ts: 424242 });
    const m = await a.waitFor('pong');
    assert.equal(m.ts, 424242);
  });

  test('chat is broadcast with id and name, capped at 120 chars', T, async () => {
    a.mark(); b.mark();
    a.send({ t: 'chat', text: 'hello island' });
    for (const bot of [a, b]) {
      const m = await bot.waitFor('chat');
      assert.equal(m.id, a.id);
      assert.equal(m.name, 'Alice');
      assert.equal(m.text, 'hello island');
    }
    await sleep(1100); // chat rate limit is 2/s
    b.mark();
    a.send({ t: 'chat', text: 'x'.repeat(500) });
    const long = await b.waitFor('chat');
    assert.ok(long.text.length <= 120, `chat length ${long.text.length}`);
    assert.ok(long.text.length > 0);
  });

  test('chat is rate limited to about 2 per second', T, async () => {
    await sleep(1100);
    b.mark();
    for (let i = 0; i < 12; i++) a.send({ t: 'chat', text: `spam ${i}` });
    await sync(a);
    await sync(b);
    const got = b.all('chat').length;
    assert.ok(got >= 1 && got <= 4, `received ${got} of 12 chat messages sent in one burst`);
  });

  test('build: blocks broadcast to everyone, materials deducted', T, async () => {
    const pl = ctx.player(a.id);
    pl.mats.wood = 20;
    const eye = ctx.eye(a.id);
    // anchor a few cells in front of and above the player, where everything is air
    let anchor = null;
    outer: for (let up = 3; up <= 5; up++) {
      for (const [dx, dz] of [[0, -3], [3, 0], [0, 3], [-3, 0]]) {
        const c = [Math.floor(eye[0]) + dx, Math.floor(eye[1]) + up, Math.floor(eye[2]) + dz];
        if (Math.hypot(c[0] + 0.5 - eye[0], c[1] + 0.5 - eye[1], c[2] + 0.5 - eye[2]) > BUILD_RANGE - 0.5) continue;
        if (pieceCells('wall', ...c, 0).every(([x, y, z]) => game.world.get(x, y, z) === B.AIR)) { anchor = c; break outer; }
      }
    }
    assert.ok(anchor, 'no free air near the spawn point for the build test');
    const cells = pieceCells('wall', ...anchor, 0);
    a.mark(); b.mark();
    a.send({ t: 'build', piece: 'wall', x: anchor[0], y: anchor[1], z: anchor[2], facing: 0, mat: 'wood' });
    for (const bot of [a, b]) {
      const m = await bot.waitFor('blocks');
      assert.equal(m.edits.length, cells.length);
      const got = new Set(m.edits.map((e) => e.join(',')));
      for (const c of cells) assert.ok(got.has([...c, MAT_BLOCK.wood].join(',')), `missing edit for ${c}`);
    }
    for (const [x, y, z] of cells) assert.equal(game.world.get(x, y, z), B.PLANKS);
    const you = await a.waitFor('you', (m) => m.mats.wood === 20 - PIECE_COST.wall);
    assert.equal(you.mats.wood, 14);
    assert.equal(pl.mats.wood, 14);
    assert.equal(b.find('you'), null, 'other players must not receive my `you`');

    // building the same piece again changes nothing and costs nothing
    a.mark(); b.mark();
    a.send({ t: 'build', piece: 'wall', x: anchor[0], y: anchor[1], z: anchor[2], facing: 0, mat: 'wood' });
    await sync(a); await sync(b);
    assert.equal(b.find('blocks'), null, 'no cells placeable -> no blocks message');
    assert.equal(pl.mats.wood, 14, 'no cells placeable -> nothing deducted');
  });

  test('build is refused without enough material, out of range, or with a bad piece/material', T, async () => {
    const pl = ctx.player(a.id);
    const eye = ctx.eye(a.id);
    const near = [Math.floor(eye[0]), Math.floor(eye[1]) + 4, Math.floor(eye[2])];
    const snapshot = Buffer.from(game.world.data);
    a.mark(); b.mark();
    pl.mats.wood = PIECE_COST.floor - 1;
    pl.mats.stone = 0;
    pl.mats.metal = 50;
    a.send({ t: 'build', piece: 'floor', x: near[0], y: near[1], z: near[2], facing: 1, mat: 'wood' });   // too poor
    a.send({ t: 'build', piece: 'floor', x: near[0], y: near[1], z: near[2], facing: 1, mat: 'stone' });  // none
    a.send({ t: 'build', piece: 'block', x: near[0] + 30, y: near[1], z: near[2], facing: 0, mat: 'metal' }); // too far
    a.send({ t: 'build', piece: 'castle', x: near[0], y: near[1], z: near[2], facing: 0, mat: 'metal' });
    a.send({ t: 'build', piece: 'block', x: near[0], y: near[1], z: near[2], facing: 0, mat: 'gold' });
    a.send({ t: 'build', piece: 'block', x: near[0], y: near[1], z: near[2], facing: 0, mat: '__proto__' });
    a.send({ t: 'build', piece: 'block', x: 'a', y: null, z: {}, facing: 0, mat: 'metal' });
    await sync(a); await sync(b);
    assert.equal(b.find('blocks'), null, `unexpected edits ${JSON.stringify(b.find('blocks'))}`);
    assert.equal(Buffer.compare(snapshot, Buffer.from(game.world.data)), 0, 'world changed');
    assert.deepEqual({ ...pl.mats }, { wood: PIECE_COST.floor - 1, stone: 0, metal: 50 });
  });

  test('build does not place cells inside a living player', T, async () => {
    const pl = ctx.player(a.id);
    pl.mats.metal = 50;
    const other = ctx.player(b.id);
    const cell = [Math.floor(other.p[0]), Math.floor(other.p[1] + 0.5), Math.floor(other.p[2])];
    // stand A right next to B so the cell is in range
    const saved = [...pl.p];
    ctx.place(a.id, [other.p[0], other.p[1] + 3, other.p[2]]);
    a.mark(); b.mark();
    a.send({ t: 'build', piece: 'block', x: cell[0], y: cell[1], z: cell[2], facing: 0, mat: 'metal' });
    await sync(a); await sync(b);
    assert.equal(game.world.get(...cell), B.AIR, 'a block was placed inside another player');
    assert.equal(pl.mats.metal, 50);
    ctx.place(a.id, saved);
  });

  test('harvesting a tree with the pickaxe breaks the log and grants wood', T, async () => {
    const spot = findReachable(game.world, B.LOG, PLAYER.REACH);
    assert.ok(spot, 'no reachable LOG block in the world');
    const pl = ctx.place(a.id, spot.feet);
    pl.mats.wood = 10;
    a.send({ t: 'slot', i: 0 });
    const hits = Math.ceil(BLOCKS[B.LOG].hp / WEAPONS.pickaxe.blockDmg);
    const gap = 1000 / WEAPONS.pickaxe.rate + 40;
    a.mark(); b.mark();
    let broke = null, shots = 0;
    for (let i = 0; i < hits + 3 && !broke; i++) {
      a.send({ t: 'fire', o: spot.eye, d: spot.dir });
      shots++;
      await sync(a); await sync(b);
      broke = b.find('blocks', (m) => m.edits.some((e) => e.join(',') === [...spot.cell, B.AIR].join(',')));
      if (!broke) { ctx.advance(gap / 1000); await sleep(gap); }
    }
    assert.ok(broke, `log at ${spot.cell} not broken after ${shots} pickaxe hits`);
    assert.equal(shots, hits, `LOG (hp ${BLOCKS[B.LOG].hp}) should break in exactly ${hits} pickaxe hits`);
    assert.equal(game.world.get(...spot.cell), B.AIR);
    const you = await a.waitFor('you', (m) => m.mats.wood > 10);
    assert.equal(you.mats.wood, 14, 'pickaxe on LOG grants +4 wood');
    assert.equal(pl.mats.wood, 14);
    const shot = await b.waitFor('shot', (m) => m.id === a.id);
    assert.equal(shot.w, 'pickaxe');
    assert.equal(shot.ends.length, 1);
    assert.equal(shot.hitPlayer, false);
    assert.equal(shot.o.length, 3);
  });

  test('pickaxe fire rate is enforced', T, async () => {
    const spot = findReachable(game.world, B.STONE, PLAYER.REACH);
    assert.ok(spot, 'no reachable STONE block');
    ctx.place(a.id, spot.feet);
    ctx.advance(1); await sleep(400);
    b.mark();
    for (let i = 0; i < 6; i++) a.send({ t: 'fire', o: spot.eye, d: spot.dir }); // 150 dmg if all landed, hp 60
    await sync(a); await sync(b);
    const swings = b.all('shot', (m) => m.id === a.id).length;
    assert.ok(swings >= 1 && swings <= 2, `${swings} of 6 same-instant pickaxe swings were accepted`);
    assert.equal(game.world.get(...spot.cell), B.STONE);
  });

  test('pickaxe cannot reach beyond REACH, fire origin must be near the eye', T, async () => {
    const spot = findReachable(game.world, B.STONE, PLAYER.REACH);
    const pl = ctx.place(a.id, spot.feet);
    pl.mats.stone = 0;
    // far origin right next to the block: must be refused (o not within 2.5 of the eye)
    const far = findReachable(game.world, B.LOG, PLAYER.REACH);
    assert.ok(far && Math.hypot(far.eye[0] - spot.eye[0], far.eye[2] - spot.eye[2]) > 4, 'need a second distant tree');
    b.mark();
    for (let i = 0; i < 4; i++) {
      ctx.advance(0.4); await sleep(380);
      a.send({ t: 'fire', o: far.eye, d: far.dir });
      await sync(a);
    }
    await sync(b);
    assert.equal(game.world.get(...far.cell), B.LOG, 'fire with a remote origin damaged a block');
    assert.equal(b.find('blocks'), null);
  });

  test('bedrock and chests are indestructible', T, async () => {
    const chest = findReachable(game.world, B.CHEST, PLAYER.REACH, game.world.chests);
    assert.ok(chest, 'no reachable chest');
    ctx.place(a.id, chest.feet);
    b.mark();
    for (let i = 0; i < 4; i++) {
      ctx.advance(0.4); await sleep(380);
      a.send({ t: 'fire', o: chest.eye, d: chest.dir });
      await sync(a);
    }
    await sync(b);
    assert.equal(game.world.get(...chest.cell), B.CHEST);
    assert.equal(b.find('blocks'), null);
  });

  test('interact opens a chest: chest removed, loot granted to the opener', T, async () => {
    const chest = findReachable(game.world, B.CHEST, PLAYER.REACH, game.world.chests);
    const pl = ctx.place(a.id, chest.feet);
    const before = { mats: { ...pl.mats }, owned: [...pl.owned] };
    a.mark(); b.mark();
    // too far away first
    const [cx, cy, cz] = chest.cell;
    ctx.place(b.id, [cx > 80 ? cx - 40 : cx + 40, 44, cz + 0.5]);
    b.send({ t: 'interact', x: cx, y: cy, z: cz });
    await sync(b);
    if (Math.hypot(ctx.player(b.id).p[0] - cx, ctx.player(b.id).p[2] - cz) > PLAYER.REACH + 3) {
      assert.equal(game.world.get(cx, cy, cz), B.CHEST, 'chest opened from out of range');
    }
    a.send({ t: 'interact', x: cx, y: cy, z: cz });
    const loot = await a.waitFor('loot');
    assert.equal(typeof loot.text, 'string');
    assert.ok(loot.text.length > 0);
    const ed = await b.waitFor('blocks', (m) => m.edits.some((e) => e.join(',') === [cx, cy, cz, B.AIR].join(',')));
    assert.ok(ed);
    assert.equal(game.world.get(cx, cy, cz), B.AIR);
    assert.equal(b.find('loot'), null, 'loot goes to the opener only');
    const you = await a.waitFor('you', (m) => m.owned.filter(Boolean).length === 2);
    const slot = you.owned.findIndex((o, i) => o && !before.owned[i]);
    assert.ok(slot >= 1, 'first chest must grant a not-yet-owned weapon');
    const w = WEAPONS[WEAPON_IDS[slot]];
    assert.equal(you.ammo[slot], w.mag, 'weapon starts with a full magazine');
    assert.equal(you.reserve[slot], 2 * w.mag, '+2 magazines of reserve');
    const gained = ['wood', 'stone', 'metal'].map((m) => you.mats[m] - before.mats[m]);
    assert.deepEqual([...gained].sort((x, y) => x - y), [0, 0, 20], `material gain ${gained}`);
    assert.ok(you.sh === 0 || you.sh === 50, `shield ${you.sh}`);
    // opening it again does nothing
    a.mark();
    a.send({ t: 'interact', x: cx, y: cy, z: cz });
    await sync(a);
    assert.equal(a.find('loot'), null);
  });

  test('slot: can select owned slots only', T, async () => {
    const pl = ctx.player(a.id);
    const owned = pl.owned.findIndex((o, i) => i > 0 && o);
    const unowned = pl.owned.findIndex((o) => !o);
    assert.ok(owned > 0 && unowned > 0);
    a.mark();
    a.send({ t: 'slot', i: owned });
    const you = await a.waitFor('you', (m) => m.slot === owned);
    assert.equal(you.slot, owned);
    for (const i of [unowned, -1, 4, 99, 1.5, '1', null]) a.send({ t: 'slot', i });
    await sync(a);
    const s = await ctx.snap(b);
    assert.equal(s.players.find((p) => p.id === a.id).slot, owned);
    a.send({ t: 'slot', i: 0 });
    await sync(a);
  });

  test('no damage in the lobby', T, async () => {
    game.grant(a.id, 'rifle');
    const pa = ctx.player(a.id), pb = ctx.player(b.id);
    const saveA = [...pa.p], saveB = [...pb.p];
    ctx.place(a.id, [80.5, 44, 85.5]);
    ctx.place(b.id, [80.5, 44, 80.5]);
    a.send({ t: 'slot', i: 1 });
    const eye = ctx.eye(a.id);
    const d = norm(sub([80.5, 44.9, 80.5], eye));
    b.mark();
    for (let i = 0; i < 4; i++) {
      a.send({ t: 'fire', o: eye, d });
      await sync(a);
      ctx.advance(0.2); await sleep(170);
    }
    await sync(b);
    assert.equal(pb.hp, PLAYER.MAX_HP);
    assert.equal(b.find('hurt'), null);
    ctx.place(a.id, saveA); ctx.place(b.id, saveB);
    a.send({ t: 'slot', i: 0 });
    await sync(a);
  });

  test('late joiner receives all edits in welcome', T, async () => {
    const c = await ctx.client('Carol');
    assert.ok(c.welcome.edits.length >= 13, `only ${c.welcome.edits.length} edits`);
    const local = new World(c.welcome.seed);
    for (const [x, y, z, bl] of c.welcome.edits) local.set(x, y, z, bl);
    assert.equal(Buffer.compare(Buffer.from(local.data), Buffer.from(game.world.data)), 0, 'seed + edits must reproduce the server world');
    assert.equal(c.welcome.players.length, 3);
    const keys = c.welcome.edits.map((e) => e.slice(0, 3).join(','));
    assert.equal(new Set(keys).size, keys.length, 'edits should hold one entry per cell');
    await c.close();
    await a.waitFor('left', (m) => m.id === c.id);
  });

  test('names are trimmed to 16 chars and made unique', T, async () => {
    const c = await ctx.client('  Alice  ');
    const d = await ctx.client('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    const e = await ctx.client('');
    const names = d.welcome.players.map((p) => p.name);
    const cn = c.welcome.players.find((p) => p.id === c.id).name;
    const dn = d.welcome.players.find((p) => p.id === d.id).name;
    assert.notEqual(cn, 'Alice', 'duplicate name must be made unique');
    assert.ok(cn.length <= 16 && cn.trim() === cn && cn.length > 0, `name "${cn}"`);
    assert.ok(dn.length <= 16 && dn.startsWith('ABCDEFGH'), `name "${dn}"`);
    assert.equal(new Set(names).size, names.length, `names not unique: ${names}`);
    const en = e.welcome.players.find((p) => p.id === e.id).name;
    assert.ok(typeof en === 'string' && en.length > 0 && en.length <= 16, `empty name became "${en}"`);
    await Promise.all([c.close(), d.close(), e.close()]);
    await a.waitFor('left', (m) => m.id === e.id);
  });

  test('disconnect -> left broadcast, player removed', T, async () => {
    const c = await ctx.client('Dave');
    await a.waitFor('joined', (m) => m.id === c.id);
    assert.ok(game.players.has(c.id));
    a.mark();
    await c.close();
    const l = await a.waitFor('left', (m) => m.id === c.id);
    assert.equal(l.id, c.id);
    assert.equal(game.players.has(c.id), false);
    const s = await ctx.snap(a);
    assert.ok(!s.players.some((p) => p.id === c.id));
  });
});

describe('protocol: robustness', T, () => {
  let ctx, game, a;
  before(async () => {
    ctx = await boot();
    game = ctx.game;
    a = await ctx.client('Robust');
  }, T);
  after(async () => { if (ctx) await ctx.close(); }, T);

  const junk = [
    'not json', '', '{', '[]', 'null', '42', '"str"', 'true', '{"t":123}', '{"t":null}', '{}',
    '{"t":"nope"}', '{"t":"__proto__"}', '{"t":"constructor"}', '{"t":"toString"}',
    { t: 'join', name: 'again' }, { t: 'join' }, { t: 'join', name: { a: 1 } },
    { t: 'pos' }, { t: 'pos', p: 'x' }, { t: 'pos', p: [1, 2] }, { t: 'pos', p: [NaN, null, 'a'], yaw: 'q', pitch: {} },
    { t: 'pos', p: [1e308, 1e308, 1e308], yaw: 1e308, pitch: -1e308 }, { t: 'pos', p: null }, { t: 'pos', p: { 0: 1, 1: 2, 2: 3 } },
    { t: 'slot' }, { t: 'slot', i: 99 }, { t: 'slot', i: -1 }, { t: 'slot', i: 'x' }, { t: 'slot', i: 1e99 },
    { t: 'fire' }, { t: 'fire', o: 1, d: 2 }, { t: 'fire', o: [], d: [] }, { t: 'fire', o: [0, 0, 0], d: [0, 0, 0] },
    { t: 'fire', o: [null, null, null], d: ['a', 'b', 'c'] }, { t: 'fire', o: [1e308, 0, 0], d: [1e308, 1e308, 1e308] },
    { t: 'reload' }, { t: 'reload', x: 1 },
    { t: 'build' }, { t: 'build', piece: {}, x: 1, y: 2, z: 3 }, { t: 'build', piece: 'wall', x: 1e9, y: -1e9, z: 0.5, facing: 77, mat: 'wood' },
    { t: 'build', piece: 'wall', x: null, y: null, z: null, facing: null, mat: null }, { t: 'build', piece: 'toString', mat: 'constructor', x: 1, y: 1, z: 1, facing: 0 },
    { t: 'interact' }, { t: 'interact', x: 'a', y: [], z: {} }, { t: 'interact', x: -5, y: 1e9, z: 3.3 },
    { t: 'chat' }, { t: 'chat', text: 5 }, { t: 'chat', text: null }, { t: 'chat', text: { toString: 1 } },
    { t: 'ping' }, { t: 'ping', ts: 'x' },
    { t: 'snap', players: [] }, { t: 'welcome' },
  ];

  test('garbage before join is ignored', T, async () => {
    const r = await ctx.raw();
    for (const m of junk.filter((j) => !(j && j.t === 'join'))) r.send(m);
    r.send(Buffer.from([0, 1, 2, 255, 254]));
    await sleep(100);
    game.tickOnce(0.05);
    assert.equal(r.closed, false, 'connection should survive junk');
    assert.equal(r.find('welcome'), null, 'no welcome before join');
    const w = await r.join('AfterJunk');
    assert.ok(w.id !== undefined);
    await r.close();
    await a.waitFor('left', (m) => m.id === w.id);
  });

  test('malformed messages after join do not crash the server or the tick', T, async () => {
    const stateBefore = game.state;
    assert.equal(stateBefore, STATE.LOBBY);
    const n = game.players.size;
    a.mark();
    for (const m of junk) a.send(m);
    a.send(Buffer.from([0xff, 0xfe, 0x00, 0x7b]));
    a.send('x'.repeat(3000));
    a.send(JSON.stringify({ t: 'chat', text: 'y'.repeat(3000) }));
    await sync(a);
    for (let i = 0; i < 20; i++) game.tickOnce(0.05);
    assert.equal(game.players.size, n, 'a second join on the same socket must not add a player');
    assert.equal(game.state, stateBefore, 'junk start messages must not start a match');
    const pl = ctx.player(a.id);
    for (const v of pl.p) assert.ok(Number.isFinite(v), `player position corrupted: ${pl.p}`);
    assert.equal(pl.alive, true);
    // server is still fully functional
    const s = await ctx.snap(a);
    for (const p of s.players) for (const v of p.p) assert.ok(Number.isFinite(v));
    const b = await ctx.client('Fresh');
    assert.ok(b.welcome);
    await b.close();
  });

  test('an oversized frame cannot take the server down', T, async () => {
    const c = await ctx.client('Big');
    c.send('x'.repeat(200000));
    c.send(JSON.stringify({ t: 'chat', text: 'z'.repeat(200000) }));
    await sleep(100);
    game.tickOnce(0.05);
    await sync(a); // the server still answers other clients (it may drop the offender)
    await c.close();
    await sleep(30);
    assert.equal(game.players.has(c.id), false);
  });

  test('a client that connects and never joins is not a player', T, async () => {
    const n = game.players.size;
    const r = await ctx.raw();
    await sleep(50);
    game.tickOnce(0.05);
    assert.equal(game.players.size, n);
    a.mark();
    await r.close();
    await sleep(50);
    assert.equal(a.find('left'), null, 'no `left` for a connection that never joined');
  });

  test('abrupt socket termination is handled', T, async () => {
    const c = await ctx.client('Rude');
    a.mark();
    c.ws.terminate();
    await a.waitFor('left', (m) => m.id === c.id);
    for (let i = 0; i < 5; i++) game.tickOnce(0.05);
    assert.equal(game.players.has(c.id), false);
  });

  test('build is rate limited (15/s)', T, async () => {
    const pl = ctx.player(a.id);
    pl.mats.wood = MAT_MAX;
    const eye = ctx.eye(a.id);
    const base = [Math.floor(eye[0]), Math.floor(eye[1]) + 3, Math.floor(eye[2])];
    await sleep(1100);
    a.mark();
    let sent = 0;
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let dy = 0; dy < 2; dy++) {
      a.send({ t: 'build', piece: 'block', x: base[0] + dx, y: base[1] + dy, z: base[2] + dz, facing: 0, mat: 'wood' });
      sent++;
    }
    await sync(a);
    const placed = MAT_MAX - pl.mats.wood;
    assert.equal(sent, 50);
    assert.ok(placed >= 1, 'at least one build should succeed');
    assert.ok(placed <= 20, `${placed} of ${sent} builds in one burst got through`);
  });

  test('start with a missing or non-numeric bot count does not throw or add bots', T, async () => {
    const r = await ctx.client('Starter');
    r.send({ t: 'start', bots: 'many' });
    r.send({ t: 'start', bots: -5 });
    r.send({ t: 'start', bots: NaN });
    r.send({ t: 'start', bots: 2.7 });
    await sync(r);
    for (let i = 0; i < 10; i++) game.tickOnce(0.05);
    const bots = [...game.players.values()].filter((p) => p.bot).length;
    assert.ok(bots <= 2, `${bots} bots`);
    game.setState(STATE.LOBBY);
    await r.close();
  });

  test('materials are capped at MAT_MAX', T, async () => {
    const spot = findReachable(game.world, B.LOG, PLAYER.REACH);
    assert.ok(spot);
    const pl = ctx.place(a.id, spot.feet);
    pl.mats.wood = MAT_MAX - 1;
    a.send({ t: 'slot', i: 0 });
    for (let i = 0; i < 5 && game.world.get(...spot.cell) === B.LOG; i++) {
      ctx.advance(0.4); await sleep(380);
      a.send({ t: 'fire', o: spot.eye, d: spot.dir });
      await sync(a);
    }
    assert.equal(game.world.get(...spot.cell), B.AIR);
    assert.equal(pl.mats.wood, MAT_MAX);
  });
});
