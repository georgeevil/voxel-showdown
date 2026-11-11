import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, fresh } from './helpers/server.js';
import { STATE, PLAYER, RESPAWN, START_MATS, COUNTDOWN_SECS } from '../shared/constants.js';

const T = { timeout: 30000 };

describe('respawn lives in matches with bots', T, () => {
  let ctx, game, a;
  before(async () => { ctx = await boot(); game = ctx.game; a = await ctx.client('Solo'); }, T);
  after(async () => { if (ctx) await ctx.close(); }, T);

  test('human gets lives with bots, respawns after the delay, protected briefly, then is out for good', T, async () => {
    await fresh(a);
    a.send({ t: 'start', bots: 2 });
    await a.waitFor('state', (m) => m.state === STATE.COUNTDOWN);
    const pa = ctx.player(a.id);
    assert.equal(pa.lives, RESPAWN.LIVES_WITH_BOTS);
    for (const pl of game.players.values()) if (pl.bot) assert.equal(pl.lives, 0, 'bots never get lives');
    ctx.advance(COUNTDOWN_SECS + 0.2, 0.1);
    assert.equal(game.state, STATE.PLAYING);
    game.grant(a.id, 'rifle');
    const bot = [...game.players.values()].find((p) => p.bot);

    for (let life = RESPAWN.LIVES_WITH_BOTS; life >= 1; life--) {
      pa.protectT = 0;
      a.mark();
      game.kill(pa, bot, 'rifle');
      game.flush();
      const k = await a.waitFor('kill', (m) => m.victim === a.id);
      assert.equal(k.respawn, RESPAWN.DELAY);
      assert.equal(k.lives, life - 1);
      assert.equal(pa.alive, false);
      assert.equal(game.state, STATE.PLAYING, 'a pending respawn keeps the match going');
      // keep the bots from finishing each other / the storm from mattering: tick only the respawn clock
      game.updateRespawns(RESPAWN.DELAY + 0.1);
      game.flush();
      const r = await a.waitFor('respawn', (m) => m.id === a.id);
      assert.equal(r.lives, life - 1);
      assert.equal(pa.alive, true);
      assert.equal(pa.hp, PLAYER.MAX_HP);
      assert.deepEqual(pa.mats, START_MATS);
      assert.equal(pa.owned[1], true, 'weapons are kept across a respawn');
      const st = game.storm;
      assert.ok(Math.hypot(pa.p[0] - st.x, pa.p[2] - st.z) <= st.r, 'respawn point is inside the storm circle');
      assert.equal(game.damage(pa, 50, bot, 'rifle'), false);
      assert.equal(pa.hp, PLAYER.MAX_HP, 'spawn protection blocks damage');
    }

    pa.protectT = 0;
    a.mark();
    game.kill(pa, bot, 'rifle');
    game.flush();
    const k = await a.waitFor('kill', (m) => m.victim === a.id);
    assert.equal(k.respawn, 0);
    assert.equal(pa.alive, false);
    assert.equal(pa.respawnT, 0);
  });

  test('no lives without bots', T, async () => {
    game.setState(STATE.LOBBY);
    await fresh(a);
    a.send({ t: 'start', bots: 0 });
    await a.waitFor('state', (m) => m.state === STATE.COUNTDOWN);
    assert.equal(ctx.player(a.id).lives, 0);
  });
});

describe('sword and bazooka', T, () => {
  let ctx, game, a, b;
  before(async () => { ctx = await boot(); game = ctx.game; a = await ctx.client('Rocketeer'); b = await ctx.client('Target'); }, T);
  after(async () => { if (ctx) await ctx.close(); }, T);

  test('everyone starts with the sword; it hits hard up close and does not reach far', T, async () => {
    const pa = ctx.player(a.id), pb = ctx.player(b.id);
    const SWORD = 5;
    assert.equal(pa.owned[SWORD], true);
    game.setState(STATE.PLAYING);
    const y = 46; // open sky, nothing in the way
    pa.p = [80.5, y, 80.5]; pb.p = [80.5, y, 78.5]; // 2 blocks apart
    game.selectSlot(pa, SWORD);
    assert.equal(game.fire(pa, game.eyeOf(pa), [0, -0.3, -1], true), true);
    assert.equal(pb.hp, PLAYER.MAX_HP - 45);
    pb.p = [80.5, y, 74.5]; // 6 blocks: out of reach
    game.fire(pa, game.eyeOf(pa), [0, -0.3, -1], true);
    assert.equal(pb.hp, PLAYER.MAX_HP - 45);
  });

  test('bazooka blast breaks blocks, hurts players nearby and the shooter less', T, async () => {
    const pa = ctx.player(a.id), pb = ctx.player(b.id);
    pa.hp = pb.hp = PLAYER.MAX_HP;
    game.grant(a.id, 'bazooka');
    game.selectSlot(pa, 4);
    // build a small target wall in the sky and stand the victim next to it
    const y = 44;
    for (let dx = -1; dx <= 1; dx++) for (let dy = 0; dy <= 2; dy++) game.setBlock(80 + dx, y + dy, 70, 7);
    pa.p = [80.5, y, 80.5]; pb.p = [82.5, y, 71.5];
    a.mark();
    assert.equal(game.fire(pa, game.eyeOf(pa), [0, 0, -1], true), true);
    game.flush();
    const shot = await a.waitFor('shot', (m) => m.w === 'bazooka');
    assert.ok(Array.isArray(shot.boom), 'shot carries the blast point');
    assert.equal(game.world.get(80, y + 1, 70), 0, 'wall block at the impact is gone');
    assert.ok(pb.hp < PLAYER.MAX_HP, 'player beside the blast is hurt');
    assert.equal(pa.hp, PLAYER.MAX_HP, 'shooter 10 blocks away is untouched');
    assert.equal(pa.ammo[4], 0, 'one rocket per magazine');
    // point blank into the ground hurts the shooter, at the reduced rate
    pa.ammo[4] = 1; pa.reloading = false;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) game.setBlock(60 + dx, 40, 60 + dz, 3);
    pa.p = [60.5, 41, 60.5];
    game.fire(pa, game.eyeOf(pa), [0, -1, 0], true);
    assert.ok(pa.hp < PLAYER.MAX_HP && pa.hp > PLAYER.MAX_HP - 60, `self damage is reduced, hp ${pa.hp}`);
  });
});

describe('team mode: humans together against the bots', T, () => {
  let ctx, game, a, b;
  before(async () => { ctx = await boot(); game = ctx.game; a = await ctx.client('KidOne'); b = await ctx.client('KidTwo'); }, T);
  after(async () => { if (ctx) await ctx.close(); }, T);

  test('teams are assigned, no friendly fire, and the match ends when one side is gone', T, async () => {
    await fresh(a, b);
    a.send({ t: 'start', bots: 0, mode: 'team' }); // 0 bots is bumped to 1: a team match needs an enemy
    const st0 = await a.waitFor('state', (m) => m.state === STATE.COUNTDOWN);
    assert.equal(st0.mode, 'team');
    const pa = ctx.player(a.id), pb = ctx.player(b.id);
    const bots = [...game.players.values()].filter((p) => p.bot);
    assert.equal(bots.length, 1);
    assert.equal(pa.team, 1); assert.equal(pb.team, 1); assert.equal(bots[0].team, 2);
    game.setState(STATE.PLAYING);
    const bot = bots[0];
    bot.p = [20.5, 46, 20.5]; // park the bot far away in the sky so it cannot interfere
    // friendly fire: a rifle shot straight at a teammate does nothing
    game.grant(a.id, 'rifle'); game.selectSlot(pa, 1);
    pa.p = [80.5, 46, 80.5]; pb.p = [80.5, 46, 76.5];
    assert.equal(game.fire(pa, game.eyeOf(pa), [0, -0.15, -1], true), true);
    assert.equal(pb.hp, PLAYER.MAX_HP, 'teammate takes no damage');
    assert.equal(game.damage(pb, 30, pa, 'rifle'), false);
    assert.equal(pb.hp, PLAYER.MAX_HP);
    // enemies still take damage
    bot.protectT = 0;
    game.damage(bot, 30, pa, 'rifle');
    assert.ok(bot.hp < PLAYER.MAX_HP, 'bot takes damage');
    // one human fully out (no lives left): the match goes on while a teammate stands
    pb.lives = 0; pb.protectT = 0;
    game.kill(pb, bot, 'rifle');
    assert.equal(game.state, STATE.PLAYING);
    // last bot down: the players win as a team
    a.mark();
    game.kill(bot, pa, 'rifle');
    game.flush();
    const end = await a.waitFor('state', (m) => m.state === STATE.ENDED);
    assert.equal(end.winnerTeam, 1);
    assert.equal(end.winner, null);
    assert.equal(end.winnerName, 'The players');
  });
});
