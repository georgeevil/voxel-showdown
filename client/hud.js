// DOM HUD: vitals, hotbar, materials, storm info, kill feed, chat, banners, crosshair
// feedback. Values are cached so the DOM is only touched when something changed.
import { HOTBAR_SLOTS, WEAPONS, WEAPON_IDS, PIECES, PIECE_COST, MATS, MAT_BLOCK, BLOCKS, PLAYER, STATE, STORM_PHASES } from '../shared/constants.js';
import { G } from './state.js';

const $ = (id) => document.getElementById(id);
const svg = (body) => `<svg viewBox="0 0 32 24" fill="currentColor" aria-hidden="true">${body}</svg>`;
const ICONS = {
  pickaxe: svg('<path d="M7 3h13l6 5v4l-5-4h-4l-9 13-3-2 9-13H7z"/>'),
  rifle: svg('<path d="M1 9h6v2h14V9h3v2h7v2h-9v2h-4l-1 6h-4l1-6h-4l-2 5H5l1-5H1z"/>'),
  shotgun: svg('<path d="M1 9h9l2 1h19v3H20v3h-8v-3h-2l-3 6H3l2-6H1z"/>'),
  sniper: svg('<path d="M10 4h10v3h-2v2h13v2H20v2h-3l-1 5h-3l1-5H9l-3 6H2l2-7H1V9h13V7h-4z"/>'),
  bazooka: svg('<path d="M1 7l4 1h17l3-2h6v10h-6l-3-2h-5l-1 6h-4l1-6H5l-4 1z"/>'),
  sword: svg('<path d="M27 2l3 1 1 3-13 11 2 3-2 2-3-3-5 5-4-4 5-5-3-3 2-2 3 2z"/>'),
  wall: svg('<path d="M3 3h26v18H3zm2 2v6h10V5zm12 0v6h10V5zM5 13v6h6v-6zm8 0v6h14v-6z" fill-rule="evenodd"/>'),
  floor: svg('<path d="M8 8h22l-6 10H2z"/>'),
  ramp: svg('<path d="M2 21h28V3z"/>'),
  block: svg('<path d="M16 2l11 5v10l-11 5-11-5V7zm0 3L9 8l7 3 7-3z" fill-rule="evenodd"/>'),
};
// same hue as the avatar's shirt (see idColor in avatars.js)
function idCss(id) {
  const s = String(id);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return `hsl(${(h >>> 0) % 360} 68% 56%)`;
}
const hex = (n) => '#' + n.toString(16).padStart(6, '0');
const mmss = (s) => { s = Math.max(0, Math.ceil(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export class Hud {
  constructor() {
    this.root = $('hud');
    this.e = {};
    for (const id of ['fx-water', 'fx-storm', 'fx-damage', 'fx-scope', 'crosshair', 'hitmark', 'dmgnum', 'hurt-dir', 'reload', 'reload-fill',
      'prompt', 'storm-box', 'storm-text', 'storm-time', 'alive', 'kills', 'killfeed', 'banner', 'banner-main', 'banner-sub', 'toast',
      'spectate', 'chat', 'chat-log', 'chat-input', 'sh-fill', 'sh-num', 'hp-fill', 'hp-num', 'mode', 'hotbar', 'mats', 'debug',
      'loading', 'loading-text', 'conn', 'lives', 'lives-stat', 'target-label', 'gains', 'board']) this.e[id] = $(id);
    this.cache = Object.create(null);
    this.slots = [];
    for (let i = 0; i < HOTBAR_SLOTS; i++) {
      const s = el('div', 'slot');
      s.append(el('span', 'key', String(i + 1)), el('span', 'ico'), el('span', 'sub'));
      this.e.hotbar.append(s);
      this.slots.push({ root: s, ico: s.children[1], sub: s.children[2] });
    }
    this.matEls = [];
    for (const m of MATS) {
      const d = el('div', 'mat');
      const sw = el('div', 'sw');
      sw.style.background = hex(BLOCKS[MAT_BLOCK[m]].color);
      d.append(sw, el('div', 'n', '0'), el('div', 'l', m));
      this.e.mats.append(d);
      this.matEls.push({ root: d, n: d.children[1], last: 0 });
    }
    this.dmg = 0; this.hit = 0; this.dmgSum = 0; this.dmgT = 0; this.hurtT = 0; this.kick = 0;
    this.bannerT = 0; this.toastT = 0; this.reloadStart = 0; this.reloadDur = 0; this.wasReloading = false;
    this.slowT = 1;
    this.debugOn = false;
    this.boardOn = true; this.boardT = 1; this.boardSig = '';
  }

  show(on) { this.root.classList.toggle('hidden', !on); }

  set(key, node, prop, value) {
    if (this.cache[key] === value) return;
    this.cache[key] = value;
    if (prop === 'text') node.textContent = value;
    else if (prop === 'html') node.innerHTML = value; // only ever fed constant strings from this file
    else if (prop === 'class') node.className = value;
    else node.style[prop] = value;
  }

  // ---- events ----
  hitmark(dmg, head, kill) {
    this.hit = 1;
    this.set('hitcls', this.e.hitmark, 'class', kill ? 'kill' : head ? 'head' : '');
    if (this.dmgT <= 0) this.dmgSum = 0;
    this.dmgSum += dmg || 0;
    this.dmgT = 0.9;
    this.e.dmgnum.textContent = String(Math.round(this.dmgSum));
    this.set('dmgcls', this.e.dmgnum, 'class', head ? 'head' : '');
  }

  hurt(amount, relAngle) {
    this.dmg = Math.min(1, this.dmg + 0.35 + (amount || 0) / 60);
    if (relAngle !== null && relAngle !== undefined) {
      this.hurtT = 1.2;
      this.e['hurt-dir'].style.transform = `rotate(${relAngle.toFixed(3)}rad)`;
    }
  }

  crossKick(a) { this.kick = Math.min(26, this.kick + a); }

  banner(main, sub = '', secs = 2.5, cls = '') {
    this.e['banner-main'].textContent = main;
    this.e['banner-sub'].textContent = sub;
    const b = this.e.banner;
    b.className = cls;
    void b.offsetWidth; // restart the pop animation
    b.className = cls + ' pop';
    b.style.opacity = '1';
    this.bannerT = secs;
  }

  toast(text, secs = 3.5) {
    this.e.toast.textContent = text;
    this.e.toast.style.opacity = '1';
    this.toastT = secs;
  }

  // what the pickaxe is pointed at and what it yields ('' hides it)
  targetLabel(name, yields, mat) {
    const k = name ? name + '|' + yields : '';
    if (this.cache.tlabel === k) return;
    this.cache.tlabel = k;
    const t = this.e['target-label'];
    t.style.opacity = name ? '1' : '0';
    if (!name) return;
    t.textContent = '';
    const sw = el('i', 'sw');
    sw.style.background = mat ? hex(BLOCKS[MAT_BLOCK[mat]].color) : '#7d8590';
    t.append(sw, el('b', '', name), el('span', mat ? 'y' : 'y none', yields));
  }

  // floating "+4 wood" next to the crosshair
  gain(mat, n) {
    const g = this.e.gains;
    while (g.children.length >= 4) g.firstChild.remove();
    const d = el('div', 'gain ' + mat);
    const sw = el('i', 'sw');
    sw.style.background = hex(BLOCKS[MAT_BLOCK[mat]].color);
    d.append(sw, document.createTextNode('+' + n + ' ' + mat));
    g.append(d);
    setTimeout(() => d.remove(), 1300);
  }

  prompt(key, text) {
    const k = key ? key + text : '';
    if (this.cache.prompt === k) return;
    this.cache.prompt = k;
    const p = this.e.prompt;
    p.style.opacity = key ? '1' : '0';
    if (key) { p.textContent = ''; p.append(el('kbd', '', key), document.createTextNode(' ' + text)); }
  }

  feed(killer, victim, weapon, mine) {
    const d = el('div', mine ? 'mine' : '');
    d.append(el('b', '', killer), el('em', '', weapon), el('b', '', victim));
    const kf = this.e.killfeed;
    kf.append(d);
    while (kf.children.length > 5) kf.firstChild.remove();
    setTimeout(() => d.remove(), 6000);
  }

  chatLine(name, text, color) {
    const d = el('div');
    if (name) { const b = el('b', '', name); if (color) b.style.color = color; d.append(b); }
    d.append(document.createTextNode(text));
    const log = this.e['chat-log'];
    log.append(d);
    while (log.children.length > 30) log.firstChild.remove();
    setTimeout(() => d.classList.add('old'), 9000);
  }

  openChat() {
    G.chatting = true;
    this.e.chat.classList.add('open');
    this.e['chat-input'].value = '';
    this.e['chat-input'].focus();
  }
  closeChat() {
    G.chatting = false;
    this.e.chat.classList.remove('open');
    this.e['chat-input'].blur();
  }

  setLoading(on, text) {
    this.set('loading', this.e.loading, 'display', on ? 'flex' : 'none');
    if (text) this.set('loadingText', this.e['loading-text'], 'text', text);
  }
  setConn(lost) { this.set('conn', this.e.conn, 'display', lost ? 'block' : 'none'); }
  setSpectate(text) {
    this.set('spec', this.e.spectate, 'display', text ? 'block' : 'none');
    if (text) this.set('spectext', this.e.spectate, 'text', text);
  }
  setDebug(text) {
    this.set('dbg', this.e.debug, 'display', this.debugOn ? 'block' : 'none');
    if (this.debugOn) this.e.debug.textContent = text;
  }

  // ---- per-frame ----
  // o: { now, scope, outside, underwater, build (BuildMode), spread, showCross }
  frame(dt, o) {
    const e = this.e, you = G.you;
    this.dmg = Math.max(0, this.dmg - dt * 1.4);
    const low = you.alive && you.hp < 30 ? 0.28 + Math.sin(o.now * 0.006) * 0.1 : 0;
    this.set('dmgO', e['fx-damage'], 'opacity', Math.max(this.dmg, low).toFixed(2));
    this.set('stormO', e['fx-storm'], 'opacity', o.outside ? '1' : '0');
    this.set('waterO', e['fx-water'], 'opacity', o.underwater ? '1' : '0');
    this.set('scopeO', e['fx-scope'], 'opacity', o.scope > 0.85 ? '1' : '0');

    this.kick = Math.max(0, this.kick - dt * 60);
    const gap = Math.round(5 + this.kick + o.spread);
    if (this.cache.gapv !== gap) { this.cache.gapv = gap; e.crosshair.style.setProperty('--gap', gap + 'px'); }
    this.set('crossD', e.crosshair, 'display', o.showCross && o.scope < 0.85 ? 'block' : 'none');
    this.set('crossC', e.crosshair, 'class', o.build.active ? (o.build.valid ? 'build' : 'build bad') : '');

    if (this.hit > 0 || this.cache.hitO !== '0') {
      this.hit = Math.max(0, this.hit - dt * 3.2);
      this.set('hitO', e.hitmark, 'opacity', this.hit.toFixed(2));
      e.hitmark.style.transform = `rotate(45deg) scale(${(1 + this.hit * 0.5).toFixed(2)})`;
    }
    if (this.dmgT > 0 || this.cache.dnO !== '0') {
      this.dmgT = Math.max(0, this.dmgT - dt);
      this.set('dnO', e.dmgnum, 'opacity', Math.min(1, this.dmgT * 3).toFixed(2));
    }
    if (this.hurtT > 0 || this.cache.hdO !== '0') {
      this.hurtT = Math.max(0, this.hurtT - dt);
      this.set('hdO', e['hurt-dir'], 'opacity', Math.min(1, this.hurtT * 2).toFixed(2));
    }
    if (this.bannerT > 0) { this.bannerT -= dt; if (this.bannerT <= 0) e.banner.style.opacity = '0'; }
    if (this.toastT > 0) { this.toastT -= dt; if (this.toastT <= 0) e.toast.style.opacity = '0'; }

    // reload progress (timed locally from the moment the server says we are reloading)
    if (you.reloading && !this.wasReloading) {
      this.reloadStart = o.now;
      this.reloadDur = (WEAPONS[WEAPON_IDS[you.slot]] || WEAPONS.rifle).reload * 1000 || 1;
    }
    this.wasReloading = you.reloading;
    this.set('relO', e.reload, 'opacity', you.reloading && you.alive ? '1' : '0');
    if (you.reloading) e['reload-fill'].style.width = Math.min(100, ((o.now - this.reloadStart) / this.reloadDur) * 100).toFixed(1) + '%';

    this.slowT += dt;
    if (this.slowT >= 0.1) { this.slowT = 0; this.slow(o); }
  }

  // side panel: every player with kills and whether they are still in
  board() {
    const box = this.e.board;
    const live = G.state === STATE.PLAYING || G.state === STATE.ENDED;
    if (!this.boardOn || G.players.size === 0) { if (this.boardSig !== '') { this.boardSig = ''; box.style.display = 'none'; } return; }
    const rows = [];
    for (const p of G.players.values()) {
      const me = p.id === G.id;
      const alive = me ? G.you.alive : p.alive !== false;
      const kills = (me ? G.you.kills : p.kills) | 0, lives = (me ? G.you.lives : p.lives) | 0;
      const back = me ? G.you.respawnIn > 0 : !alive && lives > 0;
      rows.push({ p, me, alive, kills, lives, back, mate: !me && !!G.team && p.team === G.team, foe: !!G.team && !!p.team && p.team !== G.team });
    }
    rows.sort((a, b) => (a.foe - b.foe) || (b.alive - a.alive) || (b.kills - a.kills) || (a.p.id - b.p.id));
    let sig = G.state;
    for (const r of rows) sig += '|' + r.p.id + r.p.name + r.alive + r.kills + r.lives + r.back + r.mate + r.foe;
    if (sig === this.boardSig) return;
    this.boardSig = sig;
    box.style.display = 'block';
    box.textContent = '';
    const teams = live && !!G.team;
    box.append(el('div', 'head', teams ? 'Your team · kills' : live ? 'Players · kills' : 'Players'));
    let foeHead = false;
    for (const r of rows.slice(0, 14)) {
      if (teams && r.foe && !foeHead) { foeHead = true; box.append(el('div', 'head foes', 'Bots')); }
      const d = el('div', 'row' + (r.me ? ' me' : '') + (r.mate ? ' mate' : '') + (live && !r.alive ? ' out' : ''));
      const dot = el('i');
      dot.style.background = idCss(r.p.id);
      const status = !live ? (r.p.bot ? 'bot' : '') : r.alive ? '♥'.repeat(Math.min(3, 1 + r.lives)) : r.back || r.lives > 0 ? 'down' : 'out';
      d.append(dot, el('span', 'nm', r.p.name), el('span', 'st', status), el('b', '', live ? String(r.kills) : ''));
      box.append(d);
    }
    if (rows.length > 14) box.append(el('div', 'more', '+' + (rows.length - 14) + ' more'));
  }

  slow(o) {
    const e = this.e, you = G.you, build = o.build;
    this.boardT += 0.1;
    if (this.boardT >= 0.5 || this.boardSig === '' === this.boardOn) { this.boardT = 0; this.board(); }
    const hp = Math.max(0, Math.round(you.hp)), sh = Math.max(0, Math.round(you.sh));
    this.set('hpw', e['hp-fill'], 'width', Math.min(100, (hp / PLAYER.MAX_HP) * 100) + '%');
    this.set('hpn', e['hp-num'], 'text', String(hp));
    this.set('hpc', e['hp-fill'].parentNode, 'class', hp < 30 ? 'bar health low' : 'bar health');
    this.set('shw', e['sh-fill'], 'width', Math.min(100, (sh / PLAYER.MAX_SHIELD) * 100) + '%');
    this.set('shn', e['sh-num'], 'text', String(sh));
    this.set('alive', e.alive, 'text', String(G.alive));
    this.set('kills', e.kills, 'text', String(you.kills));
    const showLives = G.livesMode && (G.state === STATE.PLAYING || G.state === STATE.COUNTDOWN);
    this.set('livesC', e['lives-stat'], 'class', showLives ? 'stat lives' : 'stat lives hidden');
    if (showLives) {
      const have = you.lives + (you.alive || you.respawnIn > 0 ? 1 : 0);
      this.set('livesT', e.lives, 'text', have > 0 ? '♥'.repeat(Math.min(5, have)) : '—');
    }

    this.set('hbc', e.hotbar, 'class', build.active ? 'build' : '');
    for (let i = 0; i < HOTBAR_SLOTS; i++) {
      const s = this.slots[i];
      if (build.active && i >= PIECES.length) {
        this.set('slc' + i, s.root, 'class', 'slot gone'); // only four build pieces
      } else if (build.active) {
        const p = PIECES[i];
        this.set('ico' + i, s.ico, 'html', ICONS[p]);
        this.set('sub' + i, s.sub, 'text', `${p} · ${PIECE_COST[p]}`);
        this.set('slc' + i, s.root, 'class', 'slot' + (build.piece === i ? ' sel' : ''));
      } else {
        const id = WEAPON_IDS[i], w = WEAPONS[id], owned = you.owned[i];
        this.set('ico' + i, s.ico, 'html', ICONS[id]);
        this.set('sub' + i, s.sub, 'text', !owned ? '—' : w.mag > 0 ? `${you.ammo[i]} / ${you.reserve[i]}` : id === 'pickaxe' ? 'Harvest' : 'Melee');
        const dry = owned && w.mag > 0 && you.ammo[i] <= 0;
        this.set('slc' + i, s.root, 'class', 'slot' + (you.slot === i ? ' sel' : '') + (owned ? '' : ' empty') + (dry ? ' dry' : ''));
      }
    }
    this.set('mode', e.mode, 'display', build.active ? 'block' : 'none');
    if (build.active) this.set('modet', e.mode, 'text', `BUILD · ${build.pieceName} in ${build.matName} · R rotate · G material · Q exit`);
    for (let i = 0; i < MATS.length; i++) {
      const m = this.matEls[i], v = you.mats[MATS[i]] | 0;
      if (v !== m.last) {
        m.n.textContent = String(v);
        if (v > m.last) { m.root.classList.remove('bump'); void m.root.offsetWidth; m.root.classList.add('bump'); }
        m.last = v;
      }
      const sel = build.active && build.mat === i;
      if (this.cache['matc' + i] !== sel) { this.cache['matc' + i] = sel; m.root.classList.toggle('sel', sel); }
    }

    // storm / match status line
    const st = G.storm;
    let text = 'Storm asleep', time = '', closing = false;
    if (G.state === STATE.COUNTDOWN) { text = 'Match starts'; time = mmss(G.timer); }
    else if (G.state === STATE.ENDED) { text = 'Back to lobby'; time = mmss(G.timer); }
    else if (G.state === STATE.PLAYING) {
      const n = STORM_PHASES.length, ph = Math.min(n, (st.phase | 0) + 1);
      if (st.shrinking) { text = `Storm closing\nphase ${ph} of ${n}`; time = mmss(st.timer); closing = true; }
      else if (st.r <= 0.5 || (st.phase | 0) >= n) { text = 'Storm everywhere'; }
      else { text = `Storm calm\nphase ${ph} of ${n}`; time = mmss(st.timer); }
    }
    this.set('stt', e['storm-text'], 'text', text);
    this.set('sttime', e['storm-time'], 'text', time);
    this.set('stc', e['storm-box'], 'class', closing ? 'closing' : '');
  }
}
