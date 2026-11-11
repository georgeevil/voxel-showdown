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
