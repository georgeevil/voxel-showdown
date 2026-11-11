// Boots the real game server in-process on a random port for integration tests.
import http from 'node:http';
import { Bot, pump, sleep } from './bot.js';
import { PLAYER, B } from '../../shared/constants.js';
import { raycast } from '../../shared/world.js';
import { collides } from '../../shared/physics.js';

export async function boot(opts = {}) {
  const { startServer } = await import('../../server/game.js');
  const srv = await startServer({ port: 0, quiet: true, tick: false, ...opts });
  const bots = [];
  const ctx = {
    srv,
    port: srv.port,
    game: srv.game,
    bots,
    // connect + join a new client
    async client(name) {
      const b = new Bot();
      bots.push(b);
      await b.connect(srv.port);
      await b.join(name);
      return b;
    },
    async raw() {
      const b = new Bot();
      bots.push(b);
      await b.connect(srv.port);
      return b;
    },
    // advance the simulation by `seconds` in `dt` steps without real-time waiting
    advance(seconds, dt = 0.05) {
      const n = Math.round(seconds / dt);
      for (let i = 0; i < n; i++) srv.game.tickOnce(dt);
    },
    // wait for a message while ticking the game
    waitTick(bot, t, predicate, timeoutMs = 3000) {
      return pump(srv.game, bot.waitFor(t, predicate, timeoutMs));
    },
    // a snapshot generated now (older in-flight snaps are drained first)
    async snap(bot, predicate) {
      await sync(bot);
      bot.mark();
      srv.game.tickOnce(0.001);
      return bot.waitFor('snap', predicate, 3000);
    },
    player(id) {
      const p = srv.game.players.get(id);
      if (!p) throw new Error(`game.players has no player ${id}`);
      return p;
    },
    // teleport through the test hook (game.players exposes the live player object)
    place(id, pos) {
      const pl = ctx.player(id);
      pl.p[0] = pos[0]; pl.p[1] = pos[1]; pl.p[2] = pos[2];
      return pl;
    },
    eye(id) {
      const pl = ctx.player(id);
      return [pl.p[0], pl.p[1] + PLAYER.EYE, pl.p[2]];
    },
    async close() {
      await Promise.all(bots.map((b) => b.close()));
      await srv.close();
    },
  };
  return ctx;
}

export function norm(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

// Round-trip a ping so that everything the client sent before it has been processed
// by the server (messages on one socket are handled in order).
let pingSeq = 1;
// drain everything in flight, then start a fresh observation window
export async function fresh(...bots) {
  for (const b of bots) { await sync(b); b.mark(); }
}

export async function sync(bot, timeoutMs = 3000) {
  const ts = 1e9 + pingSeq++;
  bot.send({ t: 'ping', ts });
  await bot.waitFor('pong', (m) => m.ts === ts, timeoutMs);
}

// Finds a block of type `block` and a free standing position next to it from which the
// eye has a clear line to the block's centre within `maxDist`.
// Returns { cell:[x,y,z], feet:[x,y,z], eye:[x,y,z], dir:[x,y,z] } or null.
export function findReachable(world, block, maxDist, cells) {
  const tryCell = (x, y, z) => {
    const centre = [x + 0.5, y + 0.5, z + 0.5];
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      for (const dist of [1.5, 2.5]) {
        for (const dy of [-1, 0, -2, 1]) {
          const feet = [x + 0.5 + dx * dist, y + dy, z + 0.5 + dz * dist];
          if (feet[1] < 1 || collides(world, feet)) continue;
          if (!world.isSolid(Math.floor(feet[0]), feet[1] - 1, Math.floor(feet[2]))) continue;
          const eye = [feet[0], feet[1] + PLAYER.EYE, feet[2]];
          const dir = norm(sub(centre, eye));
          const h = raycast(world, eye, dir, maxDist);
          if (h && h.x === x && h.y === y && h.z === z && h.dist < maxDist - 0.3) {
            return { cell: [x, y, z], feet, eye, dir };
          }
        }
      }
    }
    return null;
  };
  if (cells) {
    for (const [x, y, z] of cells) {
      if (world.get(x, y, z) !== block) continue;
      const r = tryCell(x, y, z);
      if (r) return r;
    }
    return null;
  }
  const { data } = world;
  for (let i = 0; i < data.length; i++) {
    if (data[i] !== block) continue;
    const x = i % 160, z = Math.floor(i / 160) % 160, y = Math.floor(i / 25600);
    const r = tryCell(x, y, z);
    if (r) return r;
  }
  return null;
}

// Two hovering positions high above the island with a clear line between them.
export function skyDuel(world, sep = 10) {
  for (const y of [44, 42, 40, 38]) {
    for (const x of [80.5, 60.5, 100.5, 40.5, 120.5]) {
      const a = [x, y, 85.5], b = [x, y, 85.5 - sep];
      if (collides(world, a) || collides(world, b)) continue;
      const eye = [a[0], a[1] + PLAYER.EYE, a[2]];
      if (raycast(world, eye, [0, 0, -1], sep + 5)) continue;
      if (raycast(world, [a[0], a[1] + 0.9, a[2]], [0, 0, -1], sep + 5)) continue;
      return { a, b };
    }
  }
  throw new Error('no clear sky positions found');
}

export function httpGet(port, path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.setTimeout(5000, () => req.destroy(new Error('http timeout')));
    req.on('error', reject);
    req.end();
  });
}

export { Bot, pump, sleep, B };
