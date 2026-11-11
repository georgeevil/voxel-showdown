// Name prompt + lobby / pause menu overlay. Visible whenever the pointer is not locked.
import { MAX_BOTS, STATE, BOT_LEVELS, BOT_LEVEL_IDS, HEADS, THEMES, THEME_IDS } from '../shared/constants.js';
import { G, saveSettings } from './state.js';
import { idColor } from './avatars.js';

const $ = (id) => document.getElementById(id);

export class Lobby {
  constructor({ net, input, audio }) {
    this.net = net; this.input = input; this.audio = audio;
    this.overlay = $('overlay');
    this.nameInput = $('name-input');
    this.bots = $('bots');
    this.bots.max = String(MAX_BOTS);
    this.sig = '';

    let saved = '';
    try { saved = localStorage.getItem('vs_name') || ''; } catch { /* private mode */ }
    const q = new URLSearchParams(location.search);
    const qn = (q.get('name') || '').slice(0, 16);
    this.nameInput.value = qn || saved;

    $('name-form').addEventListener('submit', (e) => { e.preventDefault(); this.join(); });
    this.bots.addEventListener('input', () => { $('bots-val').textContent = this.bots.value; });
    $('bots-val').textContent = this.bots.value;
    $('start-btn').addEventListener('click', () => {
      audio.unlock(); audio.ui();
      net.send({ t: 'start', bots: Math.max(0, Math.min(MAX_BOTS, this.bots.value | 0)), difficulty: G.settings.difficulty, theme: G.settings.theme, mode: G.settings.mode });
      input.lock();
    });
    $('resume-btn').addEventListener('click', () => { audio.unlock(); audio.ui(); input.lock(); });
    this.overlay.addEventListener('mousedown', (e) => {
      if (e.target === this.overlay && G.joined) { audio.unlock(); input.lock(); }
    });

    // bot skill and head pickers (segmented buttons)
    if (!BOT_LEVELS[G.settings.difficulty]) G.settings.difficulty = 'normal';
    if (G.settings.head < 0) { G.settings.head = Math.floor(Math.random() * HEADS.length); saveSettings(); }
    const seg = (box, items, current, pick) => {
      const btns = items.map(([value, label]) => {
        const b = document.createElement('button');
        b.type = 'button'; b.textContent = label;
        b.classList.toggle('on', value === current());
        b.addEventListener('click', () => { pick(value); audio.unlock(); audio.ui(); for (const [i, o] of btns.entries()) o.classList.toggle('on', items[i][0] === current()); });
        box.append(b);
        return b;
      });
    };
    seg($('difficulty'), BOT_LEVEL_IDS.map((id) => [id, BOT_LEVELS[id].name]), () => G.settings.difficulty, (v) => { G.settings.difficulty = v; saveSettings(); });
    if (G.settings.theme !== 'random' && !THEMES[G.settings.theme]) G.settings.theme = 'random';
    seg($('theme'), [['random', 'Random'], ...THEME_IDS.map((id) => [id, THEMES[id].name])], () => G.settings.theme, (v) => { G.settings.theme = v; saveSettings(); });
    seg($('mode-pick'), [['team', 'Team vs bots'], ['solo', 'Everyone for themselves']], () => G.settings.mode, (v) => { G.settings.mode = v; saveSettings(); });
    seg($('heads'), HEADS.map((n, i) => [i, n]), () => G.settings.head, (v) => {
      G.settings.head = v; saveSettings();
      net.head = v;
      if (G.joined) net.send({ t: 'head', i: v });
    });

    seg($('gfx'), [['auto', 'Auto'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], () => G.settings.gfx, (v) => {
      G.settings.gfx = v; saveSettings();
      window.dispatchEvent(new Event('vs-gfx'));
    });

    this.sens = $('sens'); this.touchpad = $('touchpad');
    this.syncSettings();
    this.sens.addEventListener('input', () => {
      G.settings.sens = Math.max(0.3, Math.min(3, +this.sens.value || 1));
      $('sens-val').textContent = G.settings.sens.toFixed(1) + '×';
      saveSettings();
    });
    this.touchpad.addEventListener('change', () => {
      G.settings.touchpad = this.touchpad.checked; G.settings.touchpadChosen = true;
      saveSettings();
    });

    let coarse = false;
    try { coarse = matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches; } catch { /* old browser */ }
    if (coarse) $('touch-note').classList.remove('hidden');

    this.loadInfo();
    if (q.get('autojoin') === '1') this.join();
    else setTimeout(() => { try { this.nameInput.focus(); } catch { /* ignore */ } }, 50);
  }

  syncSettings() {
    this.sens.value = String(G.settings.sens);
    $('sens-val').textContent = G.settings.sens.toFixed(1) + '×';
    this.touchpad.checked = !!G.settings.touchpad;
  }

  async loadInfo() {
    try {
      const res = await fetch('/api/info', { cache: 'no-store' });
      if (!res.ok) return;
      const info = await res.json();
      const urls = Array.isArray(info && info.urls) ? info.urls.filter((u) => typeof u === 'string') : [];
      if (!urls.length) return;
      const box = $('lan-urls');
      box.textContent = '';
      for (const u of urls.slice(0, 4)) { const c = document.createElement('code'); c.textContent = u; box.append(c); }
      $('lan').classList.remove('hidden');
    } catch { /* offline or server without /api/info: just hide the hint */ }
  }

  join() {
    let name = this.nameInput.value.trim().slice(0, 16);
    if (!name) name = 'Player' + Math.floor(100 + Math.random() * 900);
    try { localStorage.setItem('vs_name', name); } catch { /* ignore */ }
    G.name = name;
    this.audio.unlock();
    $('join-btn').disabled = true;
    $('join-status').textContent = this.net.open ? 'Joining…' : 'Connecting to the server…';
    this.net.join(name, G.settings.head); // if the socket is not open yet, Net re-sends on open
  }

  // the server refused the join (e.g. full): let the user try again
  joinFailed(text) {
    $('join-btn').disabled = false;
    $('join-status').textContent = text;
  }

  onWelcome() {
    $('name-form').classList.add('hidden');
    $('menu').classList.remove('hidden');
    this.refresh(true);
  }

  showWebglError() { $('webgl-note').classList.remove('hidden'); }

  setVisible(on) { this.overlay.classList.toggle('hidden', !on); }

  refresh(force) {
    if (!G.joined) return;
    let sig = G.state + '|' + G.you.alive;
    for (const p of G.players.values()) sig += '|' + p.id + ':' + p.name;
    if (!force && sig === this.sig) return;
    this.sig = sig;
    const ul = $('players');
    ul.textContent = '';
    for (const p of G.players.values()) {
      const li = document.createElement('li');
      const dot = document.createElement('i');
      dot.style.background = '#' + idColor(p.id).getHexString();
      const nm = document.createElement('span');
      nm.textContent = p.name;
      li.append(dot, nm);
      if (p.id === G.id || p.bot) { const s = document.createElement('small'); s.textContent = p.id === G.id ? 'you' : 'bot'; li.append(s); }
      ul.append(li);
    }
    const lobby = G.state === STATE.LOBBY;
    const label = { [STATE.LOBBY]: 'Lobby', [STATE.COUNTDOWN]: 'Match starting', [STATE.PLAYING]: 'Match in progress', [STATE.ENDED]: 'Match over' }[G.state] || 'Lobby';
    $('match-status').textContent = `${label} · ${G.players.size} on the island`;
    $('start-btn').disabled = !lobby;
    $('start-btn').textContent = lobby ? 'Start match' : 'Match running';
    $('resume-btn').textContent = lobby ? 'Enter island' : G.you.alive ? 'Resume' : 'Spectate';
    $('menu-hint').textContent = lobby
      ? 'Roam the lobby island freely: harvest, build, find chests. Anyone can start the match.'
      : 'The game keeps running while this menu is open.';
  }
}
