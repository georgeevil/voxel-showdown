// Thin WebSocket wrapper: JSON messages with a `t` field, handler table, auto-reconnect.
export const r2 = (v) => Math.round(v * 100) / 100;
export const r4 = (v) => Math.round(v * 10000) / 10000;

export class Net {
  constructor() {
    this.ws = null;
    this.open = false;
    this.handlers = Object.create(null);
    this.ping = 0;
    this.name = null;      // set once joined; re-sent on reconnect
    this.onStatus = null;  // (open:boolean) => void
    this.sent = 0;
    this.received = 0;
    this._pingTimer = 0;
    this._retry = 0;
    this.on('pong', (m) => {
      if (typeof m.ts === 'number') this.ping = Math.max(0, Math.round(performance.now() - m.ts));
    });
  }

  on(t, fn) { this.handlers[t] = fn; }

  connect() {
    let ws;
    try {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws`);
    } catch {
      this._scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.open = true;
      if (this.name !== null) this.send({ t: 'join', name: this.name, head: this.head });
      if (this.onStatus) this.onStatus(true);
      clearInterval(this._pingTimer);
      this._pingTimer = setInterval(() => this.send({ t: 'ping', ts: performance.now() }), 2000);
    };
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;
      this.received++;
      const h = this.handlers[m.t];
      if (!h) return; // unknown message types are ignored
      try { h(m); } catch (err) { console.warn('[net] handler failed for', m.t, err); }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.open = false;
      clearInterval(this._pingTimer);
      if (this.onStatus) this.onStatus(false);
      this._scheduleRetry();
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  _scheduleRetry() {
    clearTimeout(this._retry);
    this._retry = setTimeout(() => this.connect(), 1500);
  }

  send(obj) {
    if (!this.open || !this.ws || this.ws.readyState !== 1) return false;
    try { this.ws.send(JSON.stringify(obj)); this.sent++; return true; } catch { return false; }
  }

  join(name, head) {
    this.name = name;
    this.head = head;
    return this.send({ t: 'join', name, head });
  }
}
