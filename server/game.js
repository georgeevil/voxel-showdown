// Authoritative game server: match state machine, combat, building, storm, chests,
// WebSocket protocol. See SPEC.md "Server". Bots live in ./bots.js.

import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { WebSocketServer } from 'ws';
import {
  TICK_RATE, WORLD, B, BLOCKS, MATS, MAT_BLOCK, MAT_MAX, START_MATS, PIECES, PIECE_COST,
  BUILD_RANGE, PLAYER, WEAPONS, WEAPON_IDS, HOTBAR_SLOTS, HEADSHOT_MULT, STATE,
  COUNTDOWN_SECS, ENDED_SECS, MAX_PLAYERS, MAX_BOTS, STORM_START_RADIUS, STORM_PHASES,
  RESPAWN,
  BOT_LEVELS, HEADS,
  THEMES, THEME_IDS,
  START_WEAPONS,
} from '../shared/constants.js';
import { World, raycast, pieceCells, rayAABB } from '../shared/world.js';
import { handleHttp, lanUrls } from './static.js';
import { BOT_NAMES, initBot, updateBot } from './bots.js';

const HW = PLAYER.WIDTH / 2;
const CX = WORLD.SX / 2, CZ = WORLD.SZ / 2;
const HIT_PAD = 0.05;        // player hit boxes are padded a touch (positions are 50 ms stale)
const POS_INSET = 0.03;      // tolerance for 2-decimal wire rounding in the "inside solid" check
const MAX_BUFFERED = 1 << 20; // skip snapshots for sockets that are this far behind

const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const isVec3 = (a) => Array.isArray(a) && a.length === 3 && fin(a[0]) && fin(a[1]) && fin(a[2]);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function newSeed() {
  return (Math.floor(Math.random() * 0x7ffffffe) + 1) | 0;
}

export class Game {
  constructor({ quiet = true } = {}) {
    this.quiet = quiet;
    this.state = STATE.LOBBY;
    this.timer = 0;            // countdown / ended seconds left
    this.time = 0;             // simulated seconds since start (advanced by tickOnce)
    this.winner = null;
    this.winnerName = '';
    this.players = new Map();  // id -> player (humans and bots)
    this.sockets = new Set();
    this.nextId = 1;
    this.matchStartCount = 0;
    this.pendingEdits = [];
    this.logged = new Set();
    this.rand = Math.random;
    this.loadWorld(newSeed());
    this.resetStorm();
  }

  // ------------------------------------------------------------------ helpers

  logOnce(key, err) {
    if (this.logged.has(key)) return;
    this.logged.add(key);
    console.error(`[voxel-showdown] ${key}:`, err && err.stack ? err.stack : err);
  }

  loadWorld(seed, theme = 'meadow') {
    this.theme = Object.hasOwn(THEMES, theme) ? theme : 'meadow';
    this.world = new World(seed, this.theme);
    this.seed = seed;
    this.edits = new Map();     // block index -> [x,y,z,b] (all changes vs generated world)
    this.blockDmg = new Map();  // block index -> accumulated damage
    this.chestsLeft = (this.world.chests || []).map((c) => [c[0], c[1], c[2]]);
    this.pendingEdits.length = 0;
  }

  resetStorm() {
    this.storm = {
      x: CX, z: CZ, r: STORM_START_RADIUS, tx: CX, tz: CZ, tr: STORM_START_RADIUS,
      phase: 0, timer: 0, shrinking: false, done: false, fx: CX, fz: CZ, fr: STORM_START_RADIUS,
    };
  }

  send(pl, msg) {
    const ws = pl && pl.ws;
    if (!ws || ws.readyState !== 1) return;
    try { ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)); } catch { /* closing */ }
  }

  broadcast(msg, except) {
    const data = typeof msg === 'string' ? msg : JSON.stringify(msg);
    for (const pl of this.players.values()) {
      if (pl === except || !pl.ws || pl.ws.readyState !== 1) continue;
      try { pl.ws.send(data); } catch { /* closing */ }
    }
  }

  humans() {
    let n = 0;
    for (const pl of this.players.values()) if (!pl.bot) n++;
    return n;
  }

  // still in the match: alive, or knocked out with a respawn pending
  combatantCount() {
    let n = 0;
    for (const pl of this.players.values()) if (pl.alive || pl.respawnT > 0) n++;
    return n;
  }

  aliveCount() {
    let n = 0;
    for (const pl of this.players.values()) if (pl.alive) n++;
    return n;
  }

  eyeOf(pl) {
    return [pl.p[0], pl.p[1] + PLAYER.EYE, pl.p[2]];
  }

  youOf(pl) {
    return {
      hp: pl.hp, sh: pl.sh, alive: pl.alive,
      mats: { wood: pl.mats.wood, stone: pl.mats.stone, metal: pl.mats.metal },
      owned: pl.owned.slice(), ammo: pl.ammo.slice(), reserve: pl.reserve.slice(),
      slot: pl.slot, reloading: !!pl.reloading, kills: pl.kills,
      lives: pl.lives, respawnIn: Math.max(0, Math.ceil(pl.respawnT)),
    };
  }

  stateMsg() {
    return { t: 'state', state: this.state, timer: r2(Math.max(0, this.timer)), winner: this.winner, winnerName: this.winnerName };
  }

  // Send queued block edits and changed `you` blocks. Called after every message and tick.
  flush() {
    if (this.pendingEdits.length) {
      const edits = this.pendingEdits;
      this.pendingEdits = [];
      this.broadcast({ t: 'blocks', edits });
    }
    for (const pl of this.players.values()) {
      if (!pl.dirty) continue;
      pl.dirty = false;
      if (pl.ws) this.send(pl, Object.assign({ t: 'you' }, this.youOf(pl)));
    }
  }

  // ------------------------------------------------------------------ players

  makePlayer(name, bot, ws) {
    const pl = {
      id: this.nextId++, name, bot, ws: ws || null,
      p: [CX + 0.5, WORLD.SY, CZ + 0.5], v: [0, 0, 0], onGround: false,
      yaw: 0, pitch: 0,
      hp: PLAYER.MAX_HP, sh: 0, alive: true,
      mats: { ...START_MATS }, owned: [], ammo: [], reserve: [],
      slot: 0, reloading: false, reloadT: 0, kills: 0, dirty: false,
      stormAcc: 0, lives: 0, respawnT: 0, protectT: 0,
      head: Math.floor(Math.random() * HEADS.length),
      // one fire-rate bucket per hotbar slot, each starting full
      fireTokens: WEAPON_IDS.map(() => 2), fireAt: WEAPON_IDS.map(() => performance.now()),
      lastPosAt: performance.now(), lastCorrectAt: 0,
      rl: { chat: { t: 0, n: 0 }, build: { t: 0, n: 0 } },
      ai: null,
    };
    this.resetLoadout(pl);
    return pl;
  }

  resetLoadout(pl) {
    pl.hp = PLAYER.MAX_HP;
    pl.sh = 0;
    pl.mats = { ...START_MATS };
    pl.owned = WEAPON_IDS.map((id) => START_WEAPONS.includes(id)).slice(0, HOTBAR_SLOTS);
    pl.ammo = pl.owned.map(() => 0);
    pl.reserve = pl.owned.map(() => 0);
    pl.slot = 0;
    pl.reloading = false;
    pl.reloadT = 0;
    pl.kills = 0;
    pl.lives = 0; pl.respawnT = 0; pl.protectT = 0;
    pl.stormAcc = 0;
    pl.dirty = true;
  }

  uniqueName(raw) {
    let base = typeof raw === 'string' ? raw : '';
    // eslint-disable-next-line no-control-regex
    base = base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 16).trim() || 'Player';
    const taken = new Set();
    for (const pl of this.players.values()) taken.add(pl.name.toLowerCase());
    if (!taken.has(base.toLowerCase())) return base;
    for (let i = 2; i < 1000; i++) {
      const suffix = ' ' + i;
      const name = base.slice(0, 16 - suffix.length).trim() + suffix;
      if (!taken.has(name.toLowerCase())) return name;
    }
    return base;
  }

  teleport(pl, p) {
    pl.p = [p[0], p[1], p[2]];
    pl.v = [0, 0, 0];
    pl.onGround = false;
    pl.lastPosAt = performance.now();
    if (pl.ws) this.send(pl, { t: 'correct', p: [r2(p[0]), r2(p[1]), r2(p[2])] });
  }

  spawnAll(list) {
    const pts = this.world.spawnPoints(list.length, this.rand);
    for (let i = 0; i < list.length; i++) this.teleport(list[i], pts[i]);
  }

  join(ws, msg) {
    if (ws.player) return;
    if (this.humans() >= MAX_PLAYERS) {
      try { ws.send(JSON.stringify({ t: 'full' })); ws.close(1013, 'server full'); } catch { /* gone */ }
      return;
    }
    const pl = this.makePlayer(this.uniqueName(msg.name), false, ws);
    if (Number.isInteger(msg.head) && msg.head >= 0 && msg.head < HEADS.length) pl.head = msg.head;
    ws.player = pl;
    const active = this.state === STATE.PLAYING || this.state === STATE.ENDED;
    if (active) { pl.alive = false; pl.hp = 0; }
    this.players.set(pl.id, pl);
    const spawn = this.world.spawnPoints(1, this.rand)[0];
    pl.p = [spawn[0], spawn[1], spawn[2]];
    pl.dirty = false;
    const players = [];
    for (const o of this.players.values()) players.push({ id: o.id, name: o.name, bot: o.bot, head: o.head });
    this.send(pl, {
      t: 'welcome', id: pl.id, seed: this.seed, theme: this.theme, edits: Array.from(this.edits.values()),
      state: this.state, timer: r2(Math.max(0, this.timer)), players, you: this.youOf(pl),
    });
    this.teleport(pl, spawn);
    this.broadcast({ t: 'joined', id: pl.id, name: pl.name, bot: false, head: pl.head }, pl);
    if (!this.quiet) console.log(`+ ${pl.name} joined (${this.humans()} online)`);
  }

  leave(ws) {
    const pl = ws.player;
    if (!pl) return;
    ws.player = null;
    if (!this.players.delete(pl.id)) return;
    this.broadcast({ t: 'left', id: pl.id });
    if (!this.quiet) console.log(`- ${pl.name} left (${this.humans()} online)`);
    if (this.humans() === 0) {
      // nobody left to play for: drop bots and go back to an idle lobby
      this.removeBots();
      this.state = STATE.LOBBY;
      this.timer = 0;
      this.winner = null;
      this.winnerName = '';
      this.resetStorm();
      return;
    }
    this.checkMatchEnd();
  }

  removeBots() {
    for (const pl of Array.from(this.players.values())) {
      if (!pl.bot) continue;
      this.players.delete(pl.id);
      this.broadcast({ t: 'left', id: pl.id });
    }
  }

  addBots(n) {
    const names = BOT_NAMES.slice();
    for (let i = names.length - 1; i > 0; i--) {
      const j = Math.floor(this.rand() * (i + 1));
      [names[i], names[j]] = [names[j], names[i]];
    }
    for (let i = 0; i < n; i++) {
      const bot = this.makePlayer(this.uniqueName('Bot ' + names[i % names.length]), true, null);
      initBot(bot);
      this.players.set(bot.id, bot);
      this.broadcast({ t: 'joined', id: bot.id, name: bot.name, bot: true, head: bot.head });
    }
  }

  // ------------------------------------------------------------------ match flow

  beginCountdown(bots, difficulty, theme) {
    if (typeof difficulty === 'string' && Object.hasOwn(BOT_LEVELS, difficulty)) this.botLevelId = difficulty;
    this.botLevel = BOT_LEVELS[this.botLevelId || 'normal'];
    bots = clamp(Math.floor(fin(bots) ? bots : 0), 0, MAX_BOTS);
    // 'random' picks a theme; an explicit id is used as is; anything else means meadow
    this.loadWorld(newSeed(), theme === 'random' ? THEME_IDS[Math.floor(Math.random() * THEME_IDS.length)] : theme);
    this.broadcast({ t: 'world', seed: this.seed, theme: this.theme });
    this.removeBots();
    this.addBots(bots);
    const all = Array.from(this.players.values());
    for (const pl of all) {
      this.resetLoadout(pl);
      pl.alive = true;
      pl.lives = !pl.bot && bots > 0 ? RESPAWN.LIVES_WITH_BOTS : 0;
      if (pl.bot) initBot(pl);
    }
    this.spawnAll(all);
    this.resetStorm();
    this.winner = null;
    this.winnerName = '';
    this.state = STATE.COUNTDOWN;
    this.timer = COUNTDOWN_SECS;
    this.flush();
    this.broadcast(this.stateMsg());
  }

  beginPlaying() {
    this.state = STATE.PLAYING;
    this.timer = 0;
    this.winner = null;
    this.winnerName = '';
    this.matchStartCount = this.combatantCount();
    this.resetStorm();
    this.setupStormPhase(0);
    for (const pl of this.players.values()) pl.stormAcc = 0;
    this.broadcast(this.stateMsg());
  }

  endMatch(winner) {
    this.state = STATE.ENDED;
    this.timer = ENDED_SECS;
    this.winner = winner ? winner.id : null;
    this.winnerName = winner ? winner.name : '';
    for (const pl of this.players.values()) { if (pl.respawnT > 0) { pl.respawnT = 0; pl.dirty = true; } }
    this.broadcast(this.stateMsg());
    if (!this.quiet) console.log(`match over, winner: ${this.winnerName || 'nobody'}`);
  }

  toLobby() {
    this.state = STATE.LOBBY;
    this.timer = 0;
    this.winner = null;
    this.winnerName = '';
    this.resetStorm();
    const all = Array.from(this.players.values());
    for (const pl of all) {
      pl.alive = true;
      pl.hp = PLAYER.MAX_HP;
      pl.sh = 0;
      pl.stormAcc = 0;
      pl.lives = 0; pl.respawnT = 0; pl.protectT = 0;
      pl.reloading = false;
      pl.dirty = true;
    }
    this.spawnAll(all);
    this.flush();
    this.broadcast(this.stateMsg());
  }

  checkMatchEnd() {
    if (this.state !== STATE.PLAYING) return;
    let alive = 0, last = null;
    for (const pl of this.players.values()) if (pl.alive || pl.respawnT > 0) { alive++; last = pl; }
    if (this.matchStartCount >= 2 ? alive <= 1 : alive === 0) this.endMatch(alive === 1 ? last : null);
  }

  // ---- test hooks ----
  setState(state) {
    if (state === STATE.LOBBY) this.toLobby();
    else if (state === STATE.COUNTDOWN) {
      let bots = 0;
      for (const pl of this.players.values()) if (pl.bot) bots++;
      this.beginCountdown(bots, undefined, this.theme);
    } else if (state === STATE.PLAYING) this.beginPlaying();
    else if (state === STATE.ENDED) {
      let alive = 0, last = null;
      for (const pl of this.players.values()) if (pl.alive) { alive++; last = pl; }
      this.endMatch(alive === 1 ? last : null);
    } else return false;
    this.flush();
    return true;
  }

  grant(id, weaponId) {
    const pl = this.players.get(id);
    const slot = WEAPON_IDS.indexOf(weaponId);
    if (!pl || slot < 0 || slot >= HOTBAR_SLOTS) return false;
    const W = WEAPONS[weaponId];
    pl.owned[slot] = true;
    pl.ammo[slot] = W.mag;
    pl.reserve[slot] += W.mag * 2;
    pl.dirty = true;
    this.flush();
    return true;
  }

  // ------------------------------------------------------------------ storm

  setupStormPhase(i) {
    const st = this.storm, ph = STORM_PHASES[i];
    st.phase = i;
    st.shrinking = false;
    st.timer = ph.wait;
    // new centre inside the previous circle, kept over the island
    const slack = Math.max(0, st.r - ph.radius) * 0.6;
    const a = this.rand() * Math.PI * 2, d = Math.sqrt(this.rand()) * slack;
    let tx = st.x + Math.cos(a) * d, tz = st.z + Math.sin(a) * d;
    const ox = tx - CX, oz = tz - CZ, od = Math.hypot(ox, oz), maxOff = 40;
    if (od > maxOff) { tx = CX + (ox / od) * maxOff; tz = CZ + (oz / od) * maxOff; }
    st.tx = tx; st.tz = tz; st.tr = ph.radius;
  }

  updateStorm(dt) {
    const st = this.storm;
    if (!st.done) {
      st.timer -= dt;
      let guard = 0;
      while (st.timer <= 0 && !st.done && guard++ < 32) {
        const ph = STORM_PHASES[st.phase];
        if (!st.shrinking) {
          st.shrinking = true;
          st.fx = st.x; st.fz = st.z; st.fr = st.r;
          st.timer += ph.shrink;
        } else {
          st.x = st.tx; st.z = st.tz; st.r = st.tr;
          st.shrinking = false;
          if (st.phase + 1 >= STORM_PHASES.length) { st.done = true; st.timer = 0; } else {
            const carry = st.timer;
            this.setupStormPhase(st.phase + 1);
            st.timer += carry;
          }
        }
      }
      if (st.shrinking) {
        const ph = STORM_PHASES[st.phase];
        const k = clamp(1 - st.timer / Math.max(ph.shrink, 1e-6), 0, 1);
        st.x = st.fx + (st.tx - st.fx) * k;
        st.z = st.fz + (st.tz - st.fz) * k;
        st.r = st.fr + (st.tr - st.fr) * k;
      }
    }
    const dps = STORM_PHASES[st.phase].dps;
    for (const pl of Array.from(this.players.values())) {
      if (!pl.alive) continue;
      const dx = pl.p[0] - st.x, dz = pl.p[2] - st.z;
      if (dx * dx + dz * dz <= st.r * st.r) { pl.stormAcc = 0; continue; }
      pl.stormAcc += dt;
      let guard = 0;
      while (pl.stormAcc >= 1 && pl.alive && guard++ < 20) {
        pl.stormAcc -= 1;
        pl.hp = Math.max(0, pl.hp - dps);
        pl.dirty = true;
        this.send(pl, { t: 'hurt', from: null, dmg: dps, hp: pl.hp, sh: pl.sh });
        if (pl.hp <= 0) this.kill(pl, null, 'storm');
      }
      if (this.state !== STATE.PLAYING) return;
    }
  }

  // ------------------------------------------------------------------ damage

  kill(victim, killer, w) {
    if (!victim.alive) return;
    victim.alive = false;
    victim.hp = 0;
    victim.reloading = false;
    victim.dirty = true;
    if (killer && killer !== victim) {
      killer.kills++;
      for (const m of MATS) {
        killer.mats[m] = Math.min(MAT_MAX, killer.mats[m] + victim.mats[m]);
      }
      killer.dirty = true;
    }
    for (const m of MATS) victim.mats[m] = 0;
    let respawn = 0;
    if (!victim.bot && victim.lives > 0 && this.state === STATE.PLAYING) {
      victim.lives--;
      victim.respawnT = respawn = RESPAWN.DELAY;
    }
    this.broadcast({ t: 'kill', killer: killer ? killer.id : null, victim: victim.id, w, respawn, lives: victim.lives });
    this.checkMatchEnd();
  }

  // Bring a knocked-out player back: weapons and ammo are kept, materials reset.
  respawn(pl) {
    pl.respawnT = 0;
    if (this.state !== STATE.PLAYING) return;
    const st = this.storm;
    let best = null, bestScore = Infinity;
    for (const p of this.world.spawnPoints(12, this.rand)) {
      const d = Math.hypot(p[0] - st.x, p[2] - st.z);
      // prefer a point comfortably inside the circle, away from other living players
      let near = Infinity;
      for (const q of this.players.values()) {
        if (q !== pl && q.alive) near = Math.min(near, Math.hypot(p[0] - q.p[0], p[2] - q.p[2]));
      }
      const score = (d > st.r * 0.8 ? 1000 + d : 0) - Math.min(near, 30);
      if (score < bestScore) { bestScore = score; best = p; }
    }
    if (best && Math.hypot(best[0] - st.x, best[2] - st.z) > st.r) {
      // the circle is tiny: drop in at its centre
      const x = Math.floor(st.x), z = Math.floor(st.z);
      best = [x + 0.5, Math.max(this.world.surfaceY(x, z), WORLD.SEA) + 1, z + 0.5];
    }
    pl.alive = true;
    pl.hp = PLAYER.MAX_HP;
    pl.sh = 0;
    pl.mats = { ...START_MATS };
    pl.stormAcc = 0;
    pl.protectT = RESPAWN.PROTECT;
    pl.reloading = false;
    pl.dirty = true;
    if (best) this.teleport(pl, best);
    this.broadcast({ t: 'respawn', id: pl.id, lives: pl.lives });
  }

  updateRespawns(dt) {
    for (const pl of Array.from(this.players.values())) {
      if (pl.protectT > 0) pl.protectT -= dt;
      if (pl.respawnT <= 0) continue;
      const before = Math.ceil(pl.respawnT);
      pl.respawnT -= dt;
      if (pl.respawnT <= 0) this.respawn(pl);
      else if (Math.ceil(pl.respawnT) !== before) pl.dirty = true;
    }
  }

  // Returns true when the victim died.
  damage(victim, dmg, attacker, w) {
    if (this.state !== STATE.PLAYING || !victim.alive || !(dmg > 0)) return false;
    if (victim.protectT > 0) return false;
    if (attacker && attacker.bot && this.botLevel) dmg *= this.botLevel.dmg;
    dmg = Math.round(dmg);
    let left = dmg;
    if (victim.sh > 0) {
      const a = Math.min(victim.sh, left);
      victim.sh -= a;
      left -= a;
    }
    victim.hp = Math.max(0, victim.hp - left);
    victim.dirty = true;
    this.send(victim, { t: 'hurt', from: attacker ? attacker.id : null, dmg, hp: victim.hp, sh: victim.sh });
    if (victim.ai) victim.ai.hurtBy = attacker ? attacker.id : 0;
    if (victim.hp <= 0) { this.kill(victim, attacker, w); return true; }
    return false;
  }

  // ------------------------------------------------------------------ blocks

  setBlock(x, y, z, b) {
    if (!this.world.inBounds(x, y, z)) return false;
    if (!this.world.set(x, y, z, b)) return false;
    const idx = this.world.index(x, y, z);
    const e = [x, y, z, b];
    this.edits.set(idx, e);
    this.blockDmg.delete(idx);
    this.pendingEdits.push(e);
    return true;
  }

  addMat(pl, mat, n) {
    if (!mat || !(mat in pl.mats)) return;
    const v = Math.min(MAT_MAX, pl.mats[mat] + n);
    if (v !== pl.mats[mat]) { pl.mats[mat] = v; pl.dirty = true; }
  }

  damageBlock(x, y, z, block, dmg, by, pickaxe) {
    if (block === B.CHEST || block === B.BEDROCK || block === B.AIR) return;
    if (!this.world.inBounds(x, y, z)) return;
    const def = BLOCKS[block];
    if (!def) return;
    const idx = this.world.index(x, y, z);
    const total = (this.blockDmg.get(idx) || 0) + dmg;
    if (total < def.hp) { this.blockDmg.set(idx, total); return; }
    if (!this.setBlock(x, y, z, B.AIR)) return;
    if (by && def.mat) {
      const big = pickaxe && (block === B.LOG || block === B.STONE || block === B.ORE);
      this.addMat(by, def.mat, big ? 4 : 1);
    }
  }

  cellHitsPlayer(x, y, z) {
    for (const pl of this.players.values()) {
      if (!pl.alive) continue;
      const p = pl.p;
      if (p[0] + HW > x + 1e-3 && p[0] - HW < x + 1 - 1e-3 &&
          p[1] + PLAYER.HEIGHT > y + 1e-3 && p[1] < y + 1 - 1e-3 &&
          p[2] + HW > z + 1e-3 && p[2] - HW < z + 1 - 1e-3) return true;
    }
    return false;
  }

  // "inside solid" check for client positions, tolerant of wire rounding
  boxInSolid(p) {
    const w = this.world;
    const x0 = Math.floor(p[0] - HW + POS_INSET), x1 = Math.floor(p[0] + HW - POS_INSET);
    const y0 = Math.floor(p[1] + POS_INSET), y1 = Math.floor(p[1] + PLAYER.HEIGHT - POS_INSET);
    const z0 = Math.floor(p[2] - HW + POS_INSET), z1 = Math.floor(p[2] + HW - POS_INSET);
    for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
      if (w.get(x, y, z) !== B.AIR) return true;
    }
    return false;
  }

  build(pl, piece, x, y, z, facing, mat) {
    if (!pl.alive) return false;
    if (this.state !== STATE.PLAYING && this.state !== STATE.LOBBY) return false;
    if (!PIECES.includes(piece) || !MATS.includes(mat)) return false;
    if (!fin(x) || !fin(y) || !fin(z)) return false;
    x = Math.floor(x); y = Math.floor(y); z = Math.floor(z);
    facing = ((Math.floor(fin(facing) ? facing : 0) % 4) + 4) % 4;
    const cost = PIECE_COST[piece];
    if (pl.mats[mat] < cost) return false;
    const e = this.eyeOf(pl);
    if (Math.hypot(x + 0.5 - e[0], y + 0.5 - e[1], z + 0.5 - e[2]) > BUILD_RANGE + 1.5) return false;
    const block = MAT_BLOCK[mat];
    let placed = 0;
    for (const c of pieceCells(piece, x, y, z, facing)) {
      if (!this.world.inBounds(c[0], c[1], c[2])) continue;
      if (this.world.get(c[0], c[1], c[2]) !== B.AIR) continue;
      if (this.cellHitsPlayer(c[0], c[1], c[2])) continue;
      if (this.setBlock(c[0], c[1], c[2], block)) placed++;
    }
    if (!placed) return false;
    pl.mats[mat] -= cost;
    pl.dirty = true;
    return true;
  }

  // ------------------------------------------------------------------ chests

  openChest(pl, x, y, z) {
    if (!pl.alive) return false;
    if (!fin(x) || !fin(y) || !fin(z)) return false;
    x = Math.floor(x); y = Math.floor(y); z = Math.floor(z);
    if (this.world.get(x, y, z) !== B.CHEST) return false;
    const e = this.eyeOf(pl);
    // distance to the nearest point of the chest cube (what the client's ray measures),
    // with a little slack for the server's slightly stale eye position
    const dx = Math.max(x - e[0], 0, e[0] - (x + 1));
    const dy = Math.max(y - e[1], 0, e[1] - (y + 1));
    const dz = Math.max(z - e[2], 0, e[2] - (z + 1));
    if (Math.hypot(dx, dy, dz) > PLAYER.REACH + 1 + 0.5) return false;
    if (!this.setBlock(x, y, z, B.AIR)) return false;
    this.chestsLeft = this.chestsLeft.filter((c) => !(c[0] === x && c[1] === y && c[2] === z));

    const rnd = this.rand;
    const parts = [];
    const missing = [], have = [];
    for (let i = 1; i < HOTBAR_SLOTS; i++) {
      if (!pl.owned[i]) missing.push(i);
      else if (WEAPONS[WEAPON_IDS[i]].mag > 0) have.push(i); // only weapons that use ammo
    }
    if (missing.length) {
      const slot = missing[Math.floor(rnd() * missing.length)];
      const W = WEAPONS[WEAPON_IDS[slot]];
      pl.owned[slot] = true;
      pl.ammo[slot] = W.mag;
      pl.reserve[slot] += W.mag * 2;
      parts.push(`${W.name} +${W.mag * 2} ammo`);
    } else if (have.length) {
      const slot = have[Math.floor(rnd() * have.length)];
      const W = WEAPONS[WEAPON_IDS[slot]];
      pl.reserve[slot] += W.mag * 2;
      parts.push(`${W.name} ammo +${W.mag * 2}`);
    }
    if (rnd() < 0.5) {
      pl.sh = Math.min(PLAYER.MAX_SHIELD, pl.sh + 50);
      parts.push('+50 shield');
    }
    const mat = MATS[Math.floor(rnd() * MATS.length)];
    this.addMat(pl, mat, 20);
    parts.push(`+20 ${mat}`);
    pl.dirty = true;
    this.send(pl, { t: 'loot', text: parts.join(', ') });
    return true;
  }

  // ------------------------------------------------------------------ weapons

  selectSlot(pl, i) {
    if (!Number.isInteger(i) || i < 0 || i >= HOTBAR_SLOTS || !pl.owned[i] || pl.slot === i) return false;
    pl.slot = i;
    pl.reloading = false;
    pl.reloadT = 0;
    pl.dirty = true;
    return true;
  }

  startReload(pl) {
    if (!pl.alive || pl.reloading) return false;
    const W = WEAPONS[WEAPON_IDS[pl.slot]];
    if (!W || !(W.mag > 0)) return false;
    if (pl.ammo[pl.slot] >= W.mag || pl.reserve[pl.slot] <= 0) return false;
    pl.reloading = true;
    pl.reloadT = W.reload;
    pl.dirty = true;
    return true;
  }

  updateReloads(dt) {
    for (const pl of this.players.values()) {
      if (!pl.reloading) continue;
      pl.reloadT -= dt;
      if (pl.reloadT > 0) continue;
      const W = WEAPONS[WEAPON_IDS[pl.slot]];
      const n = Math.min(W.mag - pl.ammo[pl.slot], pl.reserve[pl.slot]);
      if (n > 0) { pl.ammo[pl.slot] += n; pl.reserve[pl.slot] -= n; }
      pl.reloading = false;
      pl.dirty = true;
    }
  }

  // Human fire-rate limit: per-slot token bucket refilled at the weapon's rate, so network
  // jitter never eats a legitimate shot but the long-run rate is enforced.
  takeFireToken(pl, W) {
    const now = performance.now();
    const cap = W.auto ? 2 : 1.25;
    const s = pl.slot;
    const tokens = Math.min(cap, pl.fireTokens[s] + ((now - pl.fireAt[s]) / 1000) * W.rate);
    pl.fireAt[s] = now;
    if (tokens < 1) { pl.fireTokens[s] = tokens; return false; }
    pl.fireTokens[s] = tokens - 1;
    return true;
  }

  // o: ray origin, d: aim direction (any length). `trusted` skips the human-only checks.
  fire(pl, o, d, trusted) {
    if (!pl.alive || pl.reloading) return false;
    if (!isVec3(o) || !isVec3(d)) return false;
    const len = Math.hypot(d[0], d[1], d[2]);
    if (!(len > 1e-6) || !Number.isFinite(len)) return false;
    const slot = pl.slot, wid = WEAPON_IDS[slot], W = WEAPONS[wid];
    if (!W || !pl.owned[slot]) return false;
    const eye = this.eyeOf(pl);
    // a rejected human shot was already predicted client-side: resync its ammo display
    if (Math.hypot(o[0] - eye[0], o[1] - eye[1], o[2] - eye[2]) > 2.5) { if (!trusted) pl.dirty = true; return false; }
    const melee = !!W.melee, pick = wid === 'pickaxe';
    let boom = null;
    if (W.mag > 0 && pl.ammo[slot] <= 0) { this.startReload(pl); return false; }
    if (!trusted && !this.takeFireToken(pl, W)) { pl.dirty = true; return false; }
    if (W.mag > 0) { pl.ammo[slot]--; pl.dirty = true; }

    const dir = [d[0] / len, d[1] / len, d[2] / len];
    const range = W.range;
    const pvp = this.state === STATE.PLAYING;
    const ends = [];
    const hits = new Map(); // victim -> { dmg, head }
    const mn = [0, 0, 0], mx = [0, 0, 0];

    // basis perpendicular to dir for the spread cone
    let ux, uy, uz;
    if (Math.abs(dir[1]) < 0.99) { const l = Math.hypot(dir[2], dir[0]); ux = dir[2] / l; uy = 0; uz = -dir[0] / l; } else { ux = 1; uy = 0; uz = 0; }
    const vx = dir[1] * uz - dir[2] * uy, vy = dir[2] * ux - dir[0] * uz, vz = dir[0] * uy - dir[1] * ux;

    const pellets = Math.max(1, W.pellets | 0);
    for (let i = 0; i < pellets; i++) {
      let pd = dir;
      if (W.spread > 0) {
        const a = W.spread * Math.sqrt(this.rand()), phi = this.rand() * Math.PI * 2;
        const s = Math.sin(a), c = Math.cos(a), cp = Math.cos(phi) * s, sp = Math.sin(phi) * s;
        pd = [dir[0] * c + ux * cp + vx * sp, dir[1] * c + uy * cp + vy * sp, dir[2] * c + uz * cp + vz * sp];
      }
      const hb = raycast(this.world, o, pd, range);
      let best = hb ? hb.dist : range, victim = null;
      if (pvp) {
        for (const q of this.players.values()) {
          if (q === pl || !q.alive) continue;
          const p = q.p;
          if (Math.abs(p[0] - o[0]) > best + 1 || Math.abs(p[2] - o[2]) > best + 1) continue;
          mn[0] = p[0] - HW - HIT_PAD; mn[1] = p[1]; mn[2] = p[2] - HW - HIT_PAD;
          mx[0] = p[0] + HW + HIT_PAD; mx[1] = p[1] + PLAYER.HEIGHT; mx[2] = p[2] + HW + HIT_PAD;
          const t = rayAABB(o, pd, mn, mx);
          if (t !== null && t <= best) { best = t; victim = q; }
        }
      }
      const end = [o[0] + pd[0] * best, o[1] + pd[1] * best, o[2] + pd[2] * best];
      ends.push([r2(end[0]), r2(end[1]), r2(end[2])]);
      if (W.blast) {
        // explode just short of whatever was hit, so the blast is on the near side
        const back = Math.min(0.3, best);
        boom = [end[0] - pd[0] * back, end[1] - pd[1] * back, end[2] - pd[2] * back];
      } else if (victim) {
        const head = end[1] > victim.p[1] + 1.45;
        const h = hits.get(victim) || { dmg: 0, head: false };
        h.dmg += W.dmg * (head ? HEADSHOT_MULT : 1);
        h.head = h.head || head;
        hits.set(victim, h);
      } else if (hb) {
        // re-read: an earlier pellet of this shot may already have broken it
        const cur = this.world.get(hb.x, hb.y, hb.z);
        if (cur !== B.AIR) this.damageBlock(hb.x, hb.y, hb.z, cur, W.blockDmg, pl, pick);
      }
    }

    if (boom) this.explode(boom, pl, W.blast, wid, hits);
    const shot = { t: 'shot', id: pl.id, w: wid, o: [r2(o[0]), r2(o[1]), r2(o[2])], ends, hitPlayer: hits.size > 0 };
    if (boom) shot.boom = [r2(boom[0]), r2(boom[1]), r2(boom[2])];
    this.broadcast(shot);
    for (const [victim, h] of hits) {
      const dmg = Math.round(h.dmg);
      const died = this.damage(victim, dmg, pl, wid);
      if (victim !== pl) this.send(pl, { t: 'hitmark', dmg, head: h.head, kill: died });
    }
    return true;
  }

  // Explosion at point c: breaks nearby blocks and queues damage for players in range
  // (added to `hits`, which fire() then applies). The shooter is hurt too, at a discount.
  explode(c, by, blast, wid, hits) {
    const R = blast.blockRadius, r = Math.ceil(R);
    const cx = Math.floor(c[0]), cy = Math.floor(c[1]), cz = Math.floor(c[2]);
    for (let y = cy - r; y <= cy + r; y++) {
      for (let z = cz - r; z <= cz + r; z++) {
        for (let x = cx - r; x <= cx + r; x++) {
          const d = Math.hypot(x + 0.5 - c[0], y + 0.5 - c[1], z + 0.5 - c[2]);
          if (d > R) continue;
          const cur = this.world.get(x, y, z);
          if (cur !== B.AIR) this.damageBlock(x, y, z, cur, blast.blockDmg * (1 - 0.6 * d / R), null, false);
        }
      }
    }
    for (const q of this.players.values()) {
      if (!q.alive) continue;
      const d = Math.hypot(q.p[0] - c[0], q.p[1] + 0.9 - c[1], q.p[2] - c[2]);
      if (d >= blast.radius) continue;
      const dmg = blast.dmg * (1 - d / blast.radius) * (q === by ? blast.self : 1);
      if (dmg < 1) continue;
      const h = hits.get(q) || { dmg: 0, head: false };
      h.dmg += dmg;
      hits.set(q, h);
    }
  }

  // ------------------------------------------------------------------ messages

  allow(pl, key, max) {
    const now = performance.now(), b = pl.rl[key];
    if (now - b.t >= 1000) { b.t = now; b.n = 0; }
    return ++b.n <= max;
  }

  onPos(pl, m) {
    if (!isVec3(m.p)) return;
    const now = performance.now();
    if (!pl.alive) {
      if (now - pl.lastCorrectAt > 1000) {
        pl.lastCorrectAt = now;
        this.send(pl, { t: 'correct', p: [r2(pl.p[0]), r2(pl.p[1]), r2(pl.p[2])] });
      }
      return;
    }
    const dt = clamp((now - pl.lastPosAt) / 1000, 0, 1);
    pl.lastPosAt = now;
    const p = m.p;
    const moved = Math.hypot(p[0] - pl.p[0], p[2] - pl.p[2]);
    const bad = moved > PLAYER.SPRINT * 1.6 * dt + 2 ||
      p[1] > WORLD.SY + 30 || p[1] < -60 ||
      p[0] < 0 || p[0] > WORLD.SX || p[2] < 0 || p[2] > WORLD.SZ ||
      (p[1] >= -5 && this.boxInSolid(p)); // below y=-5 is the fall rule, not a collision
    if (bad) {
      this.send(pl, { t: 'correct', p: [r2(pl.p[0]), r2(pl.p[1]), r2(pl.p[2])] });
      return;
    }
    pl.p = [p[0], p[1], p[2]];
    if (fin(m.yaw)) pl.yaw = m.yaw;
    if (fin(m.pitch)) pl.pitch = clamp(m.pitch, -1.6, 1.6);
    if (p[1] < -5) this.fell(pl);
  }

  fell(pl) {
    if (this.state === STATE.PLAYING) { this.kill(pl, null, 'fall'); return; }
    this.teleport(pl, this.world.spawnPoints(1, this.rand)[0]);
  }

  onMessage(ws, raw) {
    try {
      const text = typeof raw === 'string' ? raw : raw.toString('utf8');
      if (text.length > 4096) return;
      let m;
      try { m = JSON.parse(text); } catch { return; } // malformed JSON is simply ignored
      if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.t !== 'string') return;
      if (m.t === 'ping') {
        if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'pong', ts: fin(m.ts) ? m.ts : 0 }));
        return;
      }
      const pl = ws.player;
      if (!pl) {
        if (m.t === 'join') { this.join(ws, m); this.flush(); }
        return;
      }
      switch (m.t) {
        case 'pos': this.onPos(pl, m); break;
        case 'start':
          if (this.state === STATE.LOBBY) {
            this.beginCountdown(fin(m.bots) ? m.bots : 0, m.difficulty, m.theme);
            this.broadcast({ t: 'chat', id: null, name: '', text: `New island: ${THEMES[this.theme].name}` });
            if (fin(m.bots) && m.bots >= 1) this.broadcast({ t: 'chat', id: null, name: '', text: `${pl.name} started a match — bots: ${this.botLevel.name}` });
          }
          break;
        case 'slot': this.selectSlot(pl, m.i); break;
        case 'fire': this.fire(pl, m.o, m.d, false); break;
        case 'reload': this.startReload(pl); break;
        case 'head':
          if (Number.isInteger(m.i) && m.i >= 0 && m.i < HEADS.length && m.i !== pl.head && this.allow(pl, 'chat', 2)) {
            pl.head = m.i;
            this.broadcast({ t: 'head', id: pl.id, head: pl.head });
          }
          break;
        case 'build':
          if (this.allow(pl, 'build', 15)) this.build(pl, m.piece, m.x, m.y, m.z, m.facing, m.mat);
          break;
        case 'interact': this.openChest(pl, m.x, m.y, m.z); break;
        case 'chat': {
          if (typeof m.text !== 'string') break;
          // eslint-disable-next-line no-control-regex
          const t = m.text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120);
          if (t && this.allow(pl, 'chat', 2)) this.broadcast({ t: 'chat', id: pl.id, name: pl.name, text: t });
          break;
        }
        default: break;
      }
      this.flush();
    } catch (err) {
      this.logOnce('message handler', err);
    }
  }

  // ------------------------------------------------------------------ tick

  snapshot() {
    const st = this.storm;
    const players = [];
    let alive = 0;
    for (const pl of this.players.values()) {
      if (pl.alive) alive++;
      const p = pl.p;
      players.push({
        id: pl.id, p: [r2(p[0]), r2(p[1]), r2(p[2])], yaw: r3(pl.yaw), pitch: r3(pl.pitch),
        hp: pl.hp, sh: pl.sh, alive: pl.alive, slot: pl.slot, k: pl.kills, l: pl.lives,
      });
    }
    return JSON.stringify({
      t: 'snap', players,
      storm: {
        x: r2(st.x), z: r2(st.z), r: r2(st.r), tx: r2(st.tx), tz: r2(st.tz), tr: r2(st.tr),
        phase: st.phase, timer: r2(Math.max(0, st.timer)), shrinking: st.shrinking,
      },
      alive, state: this.state, timer: r2(Math.max(0, this.timer)),
    });
  }

  tickOnce(dt = 1 / TICK_RATE) {
    dt = fin(dt) && dt > 0 ? Math.min(dt, 1) : 1 / TICK_RATE;
    this.time += dt;

    try {
      if (this.state === STATE.COUNTDOWN) {
        this.timer -= dt;
        if (this.timer <= 0) this.beginPlaying();
      } else if (this.state === STATE.ENDED) {
        this.timer -= dt;
        if (this.timer <= 0) this.toLobby();
      }
    } catch (err) { this.logOnce('state timers', err); }

    try {
      if (this.state === STATE.PLAYING) this.updateStorm(dt);
    } catch (err) { this.logOnce('storm', err); }

    try { this.updateReloads(dt); } catch (err) { this.logOnce('reloads', err); }

    try {
      if (this.state === STATE.PLAYING) this.updateRespawns(dt);
    } catch (err) { this.logOnce('respawns', err); }

    for (const pl of Array.from(this.players.values())) {
      if (!pl.bot) continue;
      try { updateBot(this, pl, dt); } catch (err) { this.logOnce('bot update', err); }
    }

    try {
      this.flush();
      if (this.sockets.size) {
        const snap = this.snapshot(); // one stringify shared by every socket
        for (const pl of this.players.values()) {
          const ws = pl.ws;
          if (!ws || ws.readyState !== 1 || ws.bufferedAmount > MAX_BUFFERED) continue;
          try { ws.send(snap); } catch { /* closing */ }
        }
      }
    } catch (err) { this.logOnce('snapshot', err); }
  }
}

// ---------------------------------------------------------------------- server

export function startServer({ port = 0, quiet = true, tick = true } = {}) {
  return new Promise((resolve, reject) => {
    const game = new Game({ quiet });
    let boundPort = port;
    const server = http.createServer((req, res) => handleHttp(req, res, () => boundPort));
    const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024, perMessageDeflate: false });

    server.on('upgrade', (req, socket, head) => {
      let pathname = '';
      try { pathname = String(req.url || '').split('?')[0]; } catch { /* ignore */ }
      if (pathname !== '/ws') { socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });

    wss.on('connection', (ws) => {
      ws.player = null;
      game.sockets.add(ws);
      ws.on('message', (data, isBinary) => { if (!isBinary) game.onMessage(ws, data); });
      ws.on('error', () => { /* dropped by close */ });
      ws.on('close', () => {
        game.sockets.delete(ws);
        try { game.leave(ws); game.flush(); } catch (err) { game.logOnce('leave', err); }
      });
    });

    let interval = null, last = performance.now(), closed = null;
    const close = () => {
      if (closed) return closed;
      closed = new Promise((res) => {
        if (interval) clearInterval(interval);
        interval = null;
        for (const ws of wss.clients) { try { ws.terminate(); } catch { /* gone */ } }
        wss.close(() => {
          server.close(() => res());
          if (server.closeAllConnections) server.closeAllConnections();
        });
      });
      return closed;
    };

    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      server.removeListener('error', reject);
      server.on('error', (err) => game.logOnce('http server', err));
      boundPort = server.address().port;
      if (tick) {
        last = performance.now();
        interval = setInterval(() => {
          const now = performance.now();
          const dt = Math.min(0.1, Math.max(0.001, (now - last) / 1000));
          last = now;
          try { game.tickOnce(dt); } catch (err) { game.logOnce('tick', err); }
        }, 1000 / TICK_RATE);
      }
      if (!quiet) {
        console.log(`Voxel Showdown running at http://localhost:${boundPort}`);
        for (const u of lanUrls(boundPort)) console.log(`  on your network: ${u}`);
      }
      resolve({ port: boundPort, close, game, server });
    });
  });
}
