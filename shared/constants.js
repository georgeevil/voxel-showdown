// Shared by the Node server and the browser client. Plain ES module, no imports,
// no Node or DOM APIs. This file is the contract: do not rename or remove exports.

export const PORT = 3000;
export const TICK_RATE = 20; // server simulation + snapshot rate (Hz)

// ---- World ----
export const WORLD = { SX: 160, SY: 48, SZ: 160, SEA: 12, CHUNK: 16 };

export const B = {
  AIR: 0, GRASS: 1, DIRT: 2, STONE: 3, SAND: 4, LOG: 5, LEAVES: 6,
  PLANKS: 7, BRICK: 8, METAL: 9, ORE: 10, CHEST: 11, BEDROCK: 12,
};

// hp = damage needed to break. mat = material granted to whoever breaks it.
// color = base RGB hex used by the client for vertex colors.
export const BLOCKS = {
  [B.GRASS]:   { name: 'grass',   hp: 30,  mat: null,    color: 0x5fae45, top: 0x6fc24f },
  [B.DIRT]:    { name: 'dirt',    hp: 30,  mat: null,    color: 0x8a5a3b },
  [B.STONE]:   { name: 'stone',   hp: 60,  mat: 'stone', color: 0x8c8f96 },
  [B.SAND]:    { name: 'sand',    hp: 20,  mat: null,    color: 0xe2d29a },
  [B.LOG]:     { name: 'log',     hp: 40,  mat: 'wood',  color: 0x6b4a2b },
  [B.LEAVES]:  { name: 'leaves',  hp: 10,  mat: 'wood',  color: 0x2f8f3a },
  [B.PLANKS]:  { name: 'planks',  hp: 50,  mat: 'wood',  color: 0xc79a5a },
  [B.BRICK]:   { name: 'brick',   hp: 90,  mat: 'stone', color: 0xb5b0a5 },
  [B.METAL]:   { name: 'metal',   hp: 140, mat: 'metal', color: 0x6f8296 },
  [B.ORE]:     { name: 'ore',     hp: 80,  mat: 'metal', color: 0x4f6b8a },
  [B.CHEST]:   { name: 'chest',   hp: 1e9, mat: null,    color: 0xf2b632 },
  [B.BEDROCK]: { name: 'bedrock', hp: 1e9, mat: null,    color: 0x2b2b30 },
};

// ---- Materials & building ----
export const MATS = ['wood', 'stone', 'metal'];
export const MAT_BLOCK = { wood: B.PLANKS, stone: B.BRICK, metal: B.METAL };
export const MAT_MAX = 500;
export const START_MATS = { wood: 30, stone: 0, metal: 0 };
export const PIECES = ['wall', 'floor', 'ramp', 'block'];
export const PIECE_COST = { wall: 6, floor: 6, ramp: 6, block: 1 };
export const BUILD_RANGE = 7; // max distance (blocks) from eye to the piece anchor

// ---- Player ----
export const PLAYER = {
  WIDTH: 0.6, HEIGHT: 1.8, EYE: 1.62,
  WALK: 5.5, SPRINT: 8.0, JUMP: 8.6, GRAVITY: 26, STEP: 0.0,
  MAX_HP: 100, MAX_SHIELD: 100,
  REACH: 4.5, // pickaxe + interact range
};

// ---- Weapons ----
// slot 0 is always the pickaxe. dmg = per pellet vs players. blockDmg = per pellet vs blocks.
// rate = shots/second. spread = radians (max cone half-angle). reload = seconds.
export const WEAPONS = {
  pickaxe: { name: 'Pickaxe', dmg: 20, blockDmg: 25, rate: 3,   mag: 0,  reload: 0,   pellets: 1, spread: 0,     range: 4.5, auto: true, melee: true },
  rifle:   { name: 'Rifle',   dmg: 22, blockDmg: 12, rate: 7,   mag: 30, reload: 2.0, pellets: 1, spread: 0.018, range: 120, auto: true  },
  shotgun: { name: 'Shotgun', dmg: 11, blockDmg: 8,  rate: 1.1, mag: 5,  reload: 2.4, pellets: 9, spread: 0.075, range: 40,  auto: false },
  sniper:  { name: 'Sniper',  dmg: 95, blockDmg: 60, rate: 0.7, mag: 3,  reload: 2.8, pellets: 1, spread: 0.001, range: 200, auto: false },
  // The rocket is instant. Where it lands it explodes: `blast.dmg` at the centre falling
  // to 0 at `blast.radius` (the shooter takes `self` of that), and blocks within
  // `blockRadius` take up to `blockDmg`.
  bazooka: { name: 'Bazooka', dmg: 0,  blockDmg: 0,  rate: 0.6, mag: 1,  reload: 2.6, pellets: 1, spread: 0.004, range: 90,  auto: false,
             blast: { radius: 4.5, dmg: 110, blockRadius: 2.7, blockDmg: 170, self: 0.5 } },
  sword:   { name: 'Sword',   dmg: 45, blockDmg: 6,  rate: 2.2, mag: 0,  reload: 0,   pellets: 1, spread: 0,     range: 3.4, auto: true, melee: true },
};
export const WEAPON_IDS = ['pickaxe', 'rifle', 'shotgun', 'sniper', 'bazooka', 'sword'];
export const START_WEAPONS = ['pickaxe', 'sword']; // everyone has these from the start
export const HOTBAR_SLOTS = 6; // slot i holds WEAPON_IDS[i] if owned
export const HEADSHOT_MULT = 1.6; // hit point above (feet y + 1.45)

// ---- Match ----
export const STATE = { LOBBY: 'lobby', COUNTDOWN: 'countdown', PLAYING: 'playing', ENDED: 'ended' };
export const COUNTDOWN_SECS = 5;
export const ENDED_SECS = 10;
export const MAX_PLAYERS = 16;
export const MAX_BOTS = 10;
export const CHEST_COUNT = 40;

// Storm: starts covering the whole map, then for each phase waits `wait` seconds and
// shrinks over `shrink` seconds to `radius` (blocks) around a new centre chosen inside
// the previous circle. `dps` applies to players outside the circle during that phase.
export const STORM_START_RADIUS = 125;
export const STORM_PHASES = [
  { wait: 50, shrink: 35, radius: 70, dps: 1 },
  { wait: 35, shrink: 30, radius: 40, dps: 2 },
  { wait: 25, shrink: 25, radius: 20, dps: 4 },
  { wait: 20, shrink: 20, radius: 8,  dps: 7 },
  { wait: 15, shrink: 20, radius: 0,  dps: 10 },
];

// Extra lives for human players in matches that include bots. A knocked-out player comes
// back after DELAY seconds at a safe spot inside the storm circle, protected from damage
// for PROTECT seconds. Bots never respawn; matches without bots have no respawns.
export const RESPAWN = { LIVES_WITH_BOTS: 2, DELAY: 4, PROTECT: 3 };

// Bot difficulty, chosen in the lobby by whoever starts the match.
// hit = accuracy multiplier, react = reaction-delay multiplier, cadence = pause between
// shots multiplier (lower is faster), sight = how far bots notice enemies (blocks),
// dmg = multiplier on damage dealt by bots.
export const BOT_LEVELS = {
  easy:   { name: 'Easy',   hit: 0.45, react: 1.8,  cadence: 1.7,  sight: 28, dmg: 0.6 },
  normal: { name: 'Normal', hit: 1.0,  react: 1.0,  cadence: 1.0,  sight: 45, dmg: 1.0 },
  hard:   { name: 'Hard',   hit: 1.5,  react: 0.55, cadence: 0.7,  sight: 55, dmg: 1.0 },
  brutal: { name: 'Brutal', hit: 2.1,  react: 0.3,  cadence: 0.45, sight: 70, dmg: 1.2 },
};
export const BOT_LEVEL_IDS = ['easy', 'normal', 'hard', 'brutal'];

// Character head styles (index is sent on the wire as `head`).
export const HEADS = ['Cap', 'Beanie', 'Helmet', 'Visor', 'Mohawk', 'Ears', 'Top hat', 'Crown'];

// Island themes. `trees` / `palms` change generation (so the theme is part of the world,
// together with the seed); everything else is how the client colours it. `colors`
// overrides BLOCKS[id].color by block name, `top` overrides the grass top colour.
export const THEMES = {
  meadow:   { name: 'Meadow',   trees: 230, palms: 20, colors: {}, top: null,
              sky: [0xbfe3f5, 0x3f8fe0], water: 0x3a98ea, bed: 0x9c9470 },
  desert:   { name: 'Desert',   trees: 45,  palms: 70,
              colors: { grass: 0xd9b56a, dirt: 0xb98a4e, sand: 0xf0dca0, leaves: 0x8aa24a, log: 0x8a6a3a, stone: 0xb59a7a }, top: 0xe3c27a,
              sky: [0xf6e6c4, 0x4f9fe6], water: 0x2fb5c9, bed: 0xd6c48a },
  snow:     { name: 'Snow',     trees: 200, palms: 0,
              colors: { grass: 0xdfe8f0, dirt: 0x7a6a5e, sand: 0xc4d2de, leaves: 0x2f6b4f, log: 0x4a3626, stone: 0x9aa3b0 }, top: 0xffffff,
              sky: [0xe3ecf4, 0x7aa7d6], water: 0x5f8fb8, bed: 0x8fa0ae },
  autumn:   { name: 'Autumn',   trees: 260, palms: 10,
              colors: { grass: 0x9aa644, leaves: 0xd9682a, log: 0x5a3d25 }, top: 0xb0b54a,
              sky: [0xf7dcb6, 0x5f93cf], water: 0x3f86c8, bed: 0x9c9470 },
  volcanic: { name: 'Volcanic', trees: 80,  palms: 0,
              colors: { grass: 0x4a4448, dirt: 0x2e2a2c, sand: 0x2a2628, leaves: 0xa3361c, log: 0x1f1a1a, stone: 0x3b3940 }, top: 0x5a525c,
              sky: [0xd98a5a, 0x3a2a44], water: 0xff6a1a, bed: 0x7a2a10 },
};
export const THEME_IDS = ['meadow', 'desert', 'snow', 'autumn', 'volcanic'];
