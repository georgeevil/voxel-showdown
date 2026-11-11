// Small promise-based WebSocket test client for the Voxel Showdown protocol.
import WebSocket from 'ws';

export class Bot {
  constructor() {
    this.ws = null;
    this.messages = [];   // every parsed message received, in order
    this.raw = [];        // frames that failed to parse
    this.id = null;
    this.welcome = null;
    this.closed = false;
    this._waiters = [];
    this._mark = 0;
  }

  connect(port, host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://${host}:${port}/ws`);
      this.ws = ws;
      const timer = setTimeout(() => { ws.terminate(); reject(new Error('ws connect timeout')); }, 5000);
      ws.once('open', () => { clearTimeout(timer); resolve(this); });
      ws.once('error', (e) => { clearTimeout(timer); reject(e); });
      ws.on('error', () => {});
      ws.on('close', () => { this.closed = true; });
      ws.on('message', (data) => {
        let m;
        try { m = JSON.parse(data.toString()); } catch { this.raw.push(data); return; }
        if (!m || typeof m !== 'object') { this.raw.push(data); return; }
        this.messages.push(m);
        for (const w of this._waiters.slice()) {
          if (w.match(m)) w.done(m);
        }
      });
    });
  }

  // Sends `join` and resolves with the `welcome` message.
  async join(name = 'Tester', timeoutMs = 5000) {
    this.send({ t: 'join', name });
    const w = await this.waitFor('welcome', null, timeoutMs);
    this.id = w.id;
    this.welcome = w;
    return w;
  }

  send(msg) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(typeof msg === 'string' || Buffer.isBuffer(msg) ? msg : JSON.stringify(msg));
    return true;
  }

  // Forget everything received so far for the purpose of waitFor / find / all.
  mark() { this._mark = this.messages.length; return this._mark; }

  all(t, predicate) {
    const out = [];
    for (let i = this._mark; i < this.messages.length; i++) {
      const m = this.messages[i];
      if (m.t === t && (!predicate || predicate(m))) out.push(m);
    }
    return out;
  }

  find(t, predicate) { return this.all(t, predicate)[0] || null; }
  last(t, predicate) { const a = this.all(t, predicate); return a[a.length - 1] || null; }

  // Resolves with the first message of type t (since the last mark()) matching predicate,
  // including ones that already arrived. Rejects after timeoutMs.
  waitFor(t, predicate, timeoutMs = 3000) {
    const hit = this.find(t, predicate);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const w = {
        match: (m) => m.t === t && (!predicate || predicate(m)),
        done: (m) => { clearTimeout(timer); this._drop(w); resolve(m); },
      };
      const timer = setTimeout(() => {
        this._drop(w);
        const seen = [...new Set(this.messages.slice(this._mark).map((m) => m.t))].join(',');
        reject(new Error(`timeout (${timeoutMs} ms) waiting for '${t}'; types seen since mark: [${seen}]`));
      }, timeoutMs);
      this._waiters.push(w);
    });
  }

  _drop(w) {
    const i = this._waiters.indexOf(w);
    if (i >= 0) this._waiters.splice(i, 1);
  }

  close() {
    return new Promise((resolve) => {
      const ws = this.ws;
      if (!ws || ws.readyState === WebSocket.CLOSED) return resolve();
      const timer = setTimeout(() => { try { ws.terminate(); } catch {} resolve(); }, 1000);
      ws.once('close', () => { clearTimeout(timer); resolve(); });
      try { ws.close(); } catch { clearTimeout(timer); resolve(); }
    });
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Repeatedly calls game.tickOnce(dt) (so no real-time waiting on the server loop is
// needed) until promiseFactory()'s promise settles.
export async function pump(game, promise, dt = 0.05, everyMs = 5) {
  let live = true;
  let tickError = null;
  const iv = setInterval(() => {
    if (!live) return;
    try { game.tickOnce(dt); } catch (e) { tickError = e; }
  }, everyMs);
  try {
    const v = await promise;
    if (tickError) throw tickError;
    return v;
  } finally {
    live = false;
    clearInterval(iv);
  }
}
