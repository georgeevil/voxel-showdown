# Voxel Showdown — build contract

An ORIGINAL game: a blocky, fully destructible voxel island where players harvest
materials, build cover, loot chests and fight until one is left while a storm circle
closes. Do not copy names, characters, art, sounds, maps or UI layouts from any existing
game. Everything is procedural (no downloaded assets); must work offline on a LAN.

Node 26, ES modules everywhere.
Dependencies are only `ws` and `three` (already installed). No bundler, no build step.

## Layout and ownership

| Path | Owner | Contents |
|---|---|---|
| `shared/constants.js` | coordinator (exists, read it first, do not edit) | all tunables |
| `shared/world.js`, `shared/physics.js` | core agent | world gen, voxel access, raycast, pieces, movement |
| `server/*.js` | server agent | HTTP static server, WebSocket game server, bots |
| `client/*` | client agent | `index.html`, `style.css`, JS modules |
| `tests/*.test.js`, `tests/helpers/*` | test agent | `node --test` unit + integration tests |

Only write inside the paths you own. If another owner's file has a bug that blocks you,
report it in your final message rather than editing it (the fixer agent may edit anything).

## Coordinates

Block (x,y,z) occupies the unit cube [x,x+1)×[y,y+1)×[z,z+1); y is up. World is
`WORLD.SX × SY × SZ`. Out of bounds reads as AIR (below y=0 reads as BEDROCK).
Player position `p` is the centre of the feet. Yaw 0 looks toward −Z, positive yaw turns
left (three.js convention, `rotation.order='YXZ'`); look direction is
`(-sin(yaw)cos(pitch), sin(pitch), -cos(yaw)cos(pitch))`.
Water is not a block: the client draws a plane at `y = WORLD.SEA - 0.2`; terrain below
sea level is sand. Walking in water is allowed and has no effect.

## shared/world.js (core agent)

```js
export function mulberry32(seed)            // -> () => float in [0,1)
export class World {
  constructor(seed)                         // generate() deterministically from integer seed
  seed; data /* Uint8Array SX*SY*SZ */; chests /* [[x,y,z],...] generated chest cells */
  index(x,y,z)                              // x + z*SX + y*SX*SZ
  inBounds(x,y,z)
  get(x,y,z)                                // block id (AIR out of bounds, BEDROCK if y<0)
  set(x,y,z,b)                              // returns true if changed; ignores out of bounds
  isSolid(x,y,z)                            // get() !== AIR
  surfaceY(x,z)                             // y of highest solid block in column, -1 if none
  spawnPoints(n, rng)                       // n spread-out [x,y,z] feet positions on land above sea, 2 air blocks above
}
export function raycast(world, o, d, maxDist)
  // voxel DDA. o,d are [x,y,z], d normalised. Returns null or
  // { x,y,z, nx,ny,nz, dist, block } (n = face normal of the entry face)
export function pieceCells(piece, x, y, z, facing)
  // piece in PIECES, facing 0..3 (0=-Z,1=-X,2=+Z,3=+X: the direction the player looks).
  // Returns [[x,y,z],...] cells, anchored at the targeted cell:
  //  wall : 4 wide × 3 high × 1 thick, perpendicular to facing, centred on anchor (extends -2..+1 sideways), y..y+2
  //  floor: 4 × 4 × 1 at height y, extending 4 cells forward from the anchor, sideways -2..+1
  //  ramp : staircase 4 wide, 3 steps; step i (0..2) is at forward offset i, height y+i (one cell thick)
  //  block: just the anchor cell
export function rayAABB(o, d, min, max)     // -> entry distance t>=0 or null
```

Generation (deterministic from seed, identical in Node and browser — use only
`mulberry32` and integer/float math, no `Math.random`): a roughly circular island of
radius ≈70 centred in the map, falling below sea level into sand at the edges; value-noise
rolling hills (land height SEA+1 … ≈SEA+16), a few stony peaks; layers: bedrock at y=0,
stone, 3 dirt, grass top (sand near shore); ORE veins exposed on hillsides; ~250 trees
(LOG trunk 4–6, LEAVES blob); 6–9 small ruined huts (PLANKS/BRICK walls with gaps) ;
`CHEST_COUNT` CHEST blocks placed on the surface (several inside huts) recorded in
`world.chests`. Generation must take < 400 ms.

## shared/physics.js (core agent)

```js
export function collides(world, p)          // AABB (WIDTH × HEIGHT) at feet pos p vs solid blocks
export function stepPlayer(world, s, input, dt)
  // s = { p:[x,y,z], v:[x,y,z], onGround:boolean }  (mutated and returned)
  // input = { fwd:-1..1, right:-1..1, yaw, jump:boolean, sprint:boolean }
  // Axis-separated sweep vs voxels, gravity, jump when onGround, auto-step-up of 1 block
  // when walking into a single-block ledge with head room (so stairs/ramps are walkable).
  // Clamp to world bounds in x/z. If p.y < -10, respawn-safe: leave to caller.
```

Used by the client for the local player and by the server for bots. dt is clamped by the
caller (≤ 0.05).

## Server (server agent)

`server/index.js` starts an HTTP + WebSocket server on `process.env.PORT || PORT`, bound
to `0.0.0.0`, and prints `http://localhost:PORT` plus every LAN IPv4 URL. It must export
nothing required, but **must also be startable in-process for tests** via
`server/game.js`:

```js
export function startServer({ port = 0, quiet = true, tick = true } = {})
  // -> Promise<{ port, close(): Promise<void>, game }>
```

Static routes: `/` → `client/index.html`; `/client/*`, `/shared/*` from disk;
`/vendor/three.module.js` → `node_modules/three/build/three.module.js`;
`/vendor/three/addons/*` → `node_modules/three/examples/jsm/*`;
`/api/info` → JSON `{ urls: [...lan urls], port }`. Correct MIME types, no path
traversal, `Cache-Control: no-store`.

WebSocket endpoint is the same host/port, path `/ws`. All messages are JSON objects
with a `t` field. Numbers in positions are rounded to 2 decimals on the wire.

### Client → server

| t | fields | meaning |
|---|---|---|
| `join` | `name` | first message; name trimmed to 16 chars, made unique |
| `pos` | `p:[x,y,z], yaw, pitch` | sent ≤ 20 Hz. Client-authoritative movement; server rejects (replies `correct`) if the move since last pos exceeds `SPRINT*1.6*dt + 2` horizontally or the box is inside solid blocks, or the player is dead |
| `start` | `bots` (0..MAX_BOTS) | any player may start from LOBBY → COUNTDOWN |
| `slot` | `i` | select hotbar slot (must be owned) |
| `fire` | `o:[x,y,z], d:[x,y,z]` | fire current weapon. Server checks alive, rate, ammo, `o` within 2.5 of the player's eye; applies spread itself; raycasts blocks and player boxes; pickaxe uses `REACH` |
| `reload` | | starts reload timer for current weapon |
| `build` | `piece, x,y,z, facing, mat` | place a piece: needs `PIECE_COST[piece]` of `mat`, anchor within `BUILD_RANGE` of eye, at least one cell placeable; fills only AIR cells not intersecting any living player's box; allowed in PLAYING and LOBBY |
| `interact` | `x,y,z` | open CHEST within `REACH+1`: chest becomes AIR, loot granted directly to the opener |
| `chat` | `text` | ≤ 120 chars, broadcast |
| `ping` | `ts` | echoed as `pong` |

### Server → client

| t | fields |
|---|---|
| `welcome` | `id, seed, edits:[[x,y,z,b],...] (all changes vs generated world), state, players:[{id,name,bot}], you:{…same as 'you'} ` |
| `joined` / `left` | `id, name, bot` / `id` |
| `snap` | 20 Hz: `players:[{id,p,yaw,pitch,hp,sh,alive,slot}]`, `storm:{x,z,r,tx,tz,tr,phase,timer,shrinking}`, `alive`, `state`, `timer` (countdown/ended seconds left) |
| `you` | sent whenever it changes: `hp, sh, alive, mats:{wood,stone,metal}, owned:[bool×4], ammo:[mag per slot], reserve:[per slot], slot, reloading:boolean, kills` |
| `blocks` | `edits:[[x,y,z,b],...]` |
| `shot` | `id, w (weapon id), o:[x,y,z], ends:[[x,y,z],...] (one per pellet, where it stopped), hitPlayer:boolean` |
| `hurt` | to the victim: `from (id or null for storm), dmg, hp, sh` |
| `hitmark` | to the shooter: `dmg, head:boolean, kill:boolean` |
| `kill` | `killer (id or null), victim, w` broadcast |
| `loot` | to the opener: `text` e.g. "Shotgun +10 ammo, +50 shield" |
| `state` | on every transition: `state, timer, winner (id or null), winnerName` |
| `world` | new match map: `seed` (client regenerates; all edits cleared) |
| `correct` | `p:[x,y,z]` teleport the local player (also used for spawn) |
| `chat` | `id, name, text` ; `pong` `ts` |

### Rules

- LOBBY: everyone alive, free roam/harvest/build on the current map, no damage, storm
  inactive (r = STORM_START_RADIUS, centred). `start` → COUNTDOWN (`COUNTDOWN_SECS`).
- On COUNTDOWN start: new seed → `world`; remove old bots, add requested bots; everyone
  reset (full hp, 0 shield, `START_MATS`, only pickaxe) and teleported (`correct`) to
  `spawnPoints`. Movement allowed, damage off until PLAYING.
- PLAYING: damage on. Shield absorbs first. Headshot ×`HEADSHOT_MULT`. Death → `kill`,
  victim becomes spectator (`alive:false`), victim's materials go to the killer. Storm
  follows `STORM_PHASES`; players outside take `dps` each second (bypasses shield).
  Falling below y < −5 kills. Players joining mid-match spectate until the next lobby.
- Match ends when ≤ 1 combatant (humans + bots) remains, provided it started with ≥ 2;
  a match started solo with 0 bots ends only when that player dies. → ENDED with winner,
  after `ENDED_SECS` → LOBBY (everyone alive again at fresh spawn points, same map).
- If all humans disconnect, reset to LOBBY and drop bots.
- Blocks: damage accumulates per block (server map), breaks at `BLOCKS[b].hp`; breaking
  grants `mat` (+1; pickaxe on LOG/STONE/ORE grants +4, LEAVES +1) capped at `MAT_MAX`.
  Bullets damage blocks with `blockDmg`. CHEST and BEDROCK are indestructible.
- Chest loot: a random not-yet-owned weapon if any (else ammo), +2 magazines reserve for
  it, 50 % chance +50 shield, +20 of a random material. Weapons start with a full mag.
- Bots: server-side players (`bot:true`, names like "Bot Kiwi") moved with
  `stepPlayer`: wander toward the storm centre, jump when blocked, sometimes open nearby
  chests, shoot at the nearest living combatant with line of sight within 45 blocks with
  deliberate inaccuracy (~35 % hit chance at mid range, reaction delay ≥ 0.6 s). They must not crash
  the tick on any world state. Bots only act during PLAYING.
- Robustness: malformed JSON / unknown `t` / wrong types are ignored without throwing;
  a single try/catch per message; rate-limit `chat` (2/s) and `build` (15/s).

## Client (client agent)

`client/index.html` uses an import map: `"three": "/vendor/three.module.js"`,
`"three/addons/": "/vendor/three/addons/"`, and imports shared code from
`/shared/*.js`. Connects to `ws(s)://${location.host}/ws`.

Required:
- Name/lobby overlay: name field (persisted in localStorage, try/catch), Join button,
  the LAN URLs from `/api/info` ("Friends on your Wi-Fi open: http://…"), player list,
  bots slider (0..MAX_BOTS), Start Match button, controls help. Overlay hides when
  playing with pointer lock; Esc shows a pause/controls panel (game keeps running).
- Rendering: three.js, chunked meshes (`WORLD.CHUNK` columns), hidden-face culling,
  vertex colours from `BLOCKS[b].color` (grass `top`), per-face shading plus cheap
  per-vertex ambient occlusion, small per-block colour jitter; sky gradient + fog, sun
  light, water plane; only re-mesh dirty chunks (and neighbours on a border edit); initial
  meshing spread over frames or fast enough (< 1.5 s) — show "Generating island…".
- Local player: pointer lock mouse look, WASD, Space jump, Shift sprint, `stepPlayer`
  with fixed sub-steps; first-person simple blocky held tool/weapon with swing/recoil.
- Remote players: blocky avatars (head, body, arms, legs; colour derived from id), name
  tags, 100 ms interpolation buffer, hidden when dead. Bots look the same.
- Combat mode (default): keys 1–4 / wheel select slot, hold LMB to fire auto weapons,
  R reload, E open chest (highlighted when targeted), RMB zoom with sniper. Client sends
  `fire` at the weapon's rate; draws tracers from `shot`, hit markers, damage vignette,
  block-break particles, crosshair, block outline on the targeted block.
- Build mode: Q or B toggles; 1–4 pick piece (wall, floor, ramp, block); R rotates facing
  offset; G or wheel cycles material; translucent ghost preview from `pieceCells`
  (green = placeable, red = not); LMB places (hold to repeat ≤ 8/s). Anchor = the AIR
  cell adjacent to the targeted face within `BUILD_RANGE`, or, when nothing is targeted,
  the cell 3 blocks ahead at foot level.
- HUD: health + shield bars, hotbar with ammo, materials, alive count, kills, storm
  timer/phase text, minimap (top-down terrain colour map built once per world, storm
  circle current + next, self arrow, no enemies), kill feed, chat (Enter), big
  banners for countdown / "Storm closing" / eliminated / winner, spectate free-cam on
  the killer or any living player when dead (click to cycle).
- Storm visual: tall translucent violet cylinder wall at the current radius, screen tint
  when outside.
- Audio: tiny WebAudio synth effects (shots, pickaxe hit, place, hurt, storm warning);
  created on first user gesture; mute toggle M.
- Touch devices are out of scope (show a "needs keyboard + mouse" note), but the page
  must not throw there.
- Expose `window.__game` = `{ state, net, player, world, debug }` for automated checks,
  and support `?name=X&autojoin=1` in the URL to skip the name prompt.
- No console errors in normal play. 60 fps target on an integrated GPU: cap pixel ratio
  at 1.5, no per-frame allocations in hot loops, no shadow maps.

## Tests (test agent)

`npm test` (`node --test tests/`). Unit: world determinism (same seed → identical data,
different seed differs), bounds, raycast hits/misses with correct face normals,
`pieceCells` shapes for all facings, `rayAABB`, physics (falls and lands, cannot walk
through a wall, steps up one block, jump height sane). Integration (in-process
`startServer({port:0})` + `ws` clients from `tests/helpers/bot.js`): static routes and
MIME types, path traversal blocked, join/welcome, two clients see each other in `snap`,
build → `blocks` broadcast + materials deducted, harvesting a tree with repeated
pickaxe `fire` breaks the block and grants wood, start with bots → countdown → playing,
rifle damage between two clients after granting a weapon through `game` test hooks,
malformed messages don't crash, late joiner gets `edits`, disconnect → `left`.
The server agent should expose on the returned `game` object: `state`, `world`,
`players` (Map id → player with `p, hp, sh, alive, mats, owned, ammo, reserve`),
`setState(state)`, `grant(id, weaponId)`, `tickOnce(dt)`.
Tests must finish in < 60 s and leave no open handles.
