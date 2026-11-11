// Shared mutable client state. Every module reads from here; only main.js and the
// net handlers write to it.
import { STATE, STORM_START_RADIUS, WORLD, HOTBAR_SLOTS, WEAPON_IDS, START_WEAPONS } from '../shared/constants.js';

const N = HOTBAR_SLOTS;

export const G = {
  id: null,
  joined: false,
  name: '',
  state: STATE.LOBBY,
  timer: 0,
  winner: null,
  winnerName: '',
  players: new Map(), // id -> { id, name, bot }
  you: {
    hp: 100, sh: 0, alive: true,
    mats: { wood: 0, stone: 0, metal: 0 },
    owned: WEAPON_IDS.map((id) => START_WEAPONS.includes(id)),
    ammo: WEAPON_IDS.map(() => 0),
    reserve: WEAPON_IDS.map(() => 0),
    slot: 0, reloading: false, kills: 0,
    lives: 0, respawnIn: 0,
  },
  storm: {
    x: WORLD.SX / 2, z: WORLD.SZ / 2, r: STORM_START_RADIUS,
    tx: WORLD.SX / 2, tz: WORLD.SZ / 2, tr: STORM_START_RADIUS,
    phase: 0, timer: 0, shrinking: false,
  },
  alive: 0,
  world: null,
  locked: false,     // pointer lock held
  chatting: false,   // chat input focused
  spectating: null,  // id being watched while dead
  mode: 'solo',      // 'team' = humans together against the bots
  team: 0,           // my team this match (0 = none)
  winnerTeam: 0,
  livesMode: false,  // this match hands out respawns (set when the server reports lives)
  settings: loadSettings(),
};

function loadSettings() {
  const s = { sens: 1, touchpad: false, touchpadChosen: false, head: -1, difficulty: 'normal', gfx: 'auto', theme: 'random', mode: 'team' };
  try {
    const j = JSON.parse(localStorage.getItem('vs_settings') || '{}');
    if (typeof j.sens === 'number' && j.sens >= 0.2 && j.sens <= 4) s.sens = j.sens;
    if (typeof j.touchpad === 'boolean') { s.touchpad = j.touchpad; s.touchpadChosen = true; }
    if (Number.isInteger(j.head) && j.head >= 0 && j.head < 8) s.head = j.head;
    if (typeof j.difficulty === 'string') s.difficulty = j.difficulty;
    if (['auto', 'low', 'medium', 'high'].includes(j.gfx)) s.gfx = j.gfx;
    if (typeof j.theme === 'string') s.theme = j.theme;
    if (j.mode === 'solo' || j.mode === 'team') s.mode = j.mode;
  } catch { /* private mode or bad JSON */ }
  return s;
}
export function saveSettings() {
  try { localStorage.setItem('vs_settings', JSON.stringify({ sens: G.settings.sens, touchpad: G.settings.touchpad, head: G.settings.head, difficulty: G.settings.difficulty, gfx: G.settings.gfx, theme: G.settings.theme, mode: G.settings.mode })); } catch { /* ignore */ }
}

const isNum = (v) => typeof v === 'number' && v === v;

export function applyYou(m) {
  if (!m || typeof m !== 'object') return;
  const y = G.you;
  if (isNum(m.hp)) y.hp = m.hp;
  if (isNum(m.sh)) y.sh = m.sh;
  if (typeof m.alive === 'boolean') y.alive = m.alive;
  if (m.mats && typeof m.mats === 'object') {
    for (const k of ['wood', 'stone', 'metal']) if (isNum(m.mats[k])) y.mats[k] = m.mats[k];
  }
  if (Array.isArray(m.owned)) for (let i = 0; i < N; i++) y.owned[i] = !!m.owned[i];
  if (Array.isArray(m.ammo)) for (let i = 0; i < N; i++) y.ammo[i] = isNum(m.ammo[i]) ? m.ammo[i] : 0;
  if (Array.isArray(m.reserve)) for (let i = 0; i < N; i++) y.reserve[i] = isNum(m.reserve[i]) ? m.reserve[i] : 0;
  if (isNum(m.slot)) y.slot = Math.max(0, Math.min(N - 1, m.slot | 0));
  if (typeof m.reloading === 'boolean') y.reloading = m.reloading;
  if (isNum(m.kills)) y.kills = m.kills;
  if (isNum(m.lives)) { y.lives = m.lives; if (m.lives > 0) G.livesMode = true; }
  if (isNum(m.respawnIn)) y.respawnIn = m.respawnIn;
}

export function applyStorm(s) {
  if (!s || typeof s !== 'object') return;
  const st = G.storm;
  for (const k of ['x', 'z', 'r', 'tx', 'tz', 'tr', 'phase', 'timer']) if (isNum(s[k])) st[k] = s[k];
  if (typeof s.shrinking === 'boolean') st.shrinking = s.shrinking;
}

export function playerName(id) {
  if (id === null || id === undefined) return 'the storm';
  const p = G.players.get(id);
  return p ? p.name : 'someone';
}

export const isVec3 = (v) => Array.isArray(v) && v.length >= 3 && isNum(v[0]) && isNum(v[1]) && isNum(v[2]);
export { isNum };
