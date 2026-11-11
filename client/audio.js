// Tiny WebAudio synth: every sound is generated from oscillators and filtered noise.
// The context is created on the first user gesture. M toggles mute.
export class AudioFx {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.noiseBuf = null;
    this.muted = false;
    try { this.muted = localStorage.getItem('vs_muted') === '1'; } catch { /* private mode */ }
  }

  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return;
    }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.5;
      this.master.connect(this.ctx.destination);
      const len = this.ctx.sampleRate;
      this.noiseBuf = this.ctx.createBuffer(1, len, len);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    } catch { this.ctx = null; }
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.5;
    try { localStorage.setItem('vs_muted', this.muted ? '1' : '0'); } catch { /* ignore */ }
    return this.muted;
  }

  _out(pan) {
    if (!pan || !this.ctx.createStereoPanner) return this.master;
    const p = this.ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    p.connect(this.master);
    return p;
  }

  tone(freq, dur, type = 'sine', vol = 0.3, slideTo = 0, delay = 0, pan = 0) {
    const c = this.ctx;
    if (!c || this.muted) return;
    const t = c.currentTime + delay;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo > 0) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this._out(pan));
    o.start(t); o.stop(t + dur + 0.02);
  }

  noise(dur, vol = 0.3, freq = 1200, type = 'lowpass', q = 0.8, delay = 0, pan = 0, slideTo = 0) {
    const c = this.ctx;
    if (!c || this.muted) return;
    const t = c.currentTime + delay;
    const s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
    s.buffer = this.noiseBuf;
    s.loop = true;
    f.type = type; f.Q.value = q;
    f.frequency.setValueAtTime(freq, t);
    if (slideTo > 0) f.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(Math.max(0.0002, vol), t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(this._out(pan));
    s.start(t, Math.random() * 0.8); s.stop(t + dur + 0.02);
  }

  // gain 0..1 (distance falloff), pan -1..1
  shot(w, gain = 1, pan = 0) {
    if (gain < 0.02) return;
    if (w === 'rifle') {
      this.noise(0.11, 0.42 * gain, 2600, 'lowpass', 0.7, 0, pan, 500);
      this.tone(190, 0.09, 'square', 0.16 * gain, 60, 0, pan);
    } else if (w === 'shotgun') {
      this.noise(0.3, 0.6 * gain, 1700, 'lowpass', 0.6, 0, pan, 220);
      this.tone(120, 0.2, 'sawtooth', 0.26 * gain, 38, 0, pan);
    } else if (w === 'sniper') {
      this.noise(0.5, 0.55 * gain, 3600, 'lowpass', 0.5, 0, pan, 180);
      this.tone(240, 0.3, 'square', 0.22 * gain, 32, 0, pan);
      this.noise(0.7, 0.12 * gain, 700, 'bandpass', 1.2, 0.08, pan);
    } else {
      this.noise(0.07, 0.12 * gain, 900, 'bandpass', 1.5, 0, pan); // pickaxe whoosh
    }
  }

  pickHit(gain = 1) {
    this.noise(0.07, 0.3 * gain, 1900, 'bandpass', 2.2);
    this.tone(260 + Math.random() * 60, 0.08, 'triangle', 0.22 * gain, 120);
  }
  breakBlock(gain = 1) {
    if (gain < 0.03) return;
    this.noise(0.2, 0.34 * gain, 900, 'lowpass', 0.9, 0, 0, 200);
    this.tone(150, 0.12, 'triangle', 0.2 * gain, 60);
  }
  place(gain = 1) {
    if (gain < 0.03) return;
    this.tone(330, 0.07, 'square', 0.12 * gain, 220);
    this.noise(0.06, 0.2 * gain, 600, 'lowpass', 1);
  }
  deny() { this.tone(140, 0.1, 'square', 0.1, 100); }
  hurt() {
    this.tone(210, 0.2, 'sawtooth', 0.26, 90);
    this.noise(0.12, 0.2, 500, 'lowpass', 1);
  }
  hit(head) { this.tone(head ? 1500 : 1050, 0.06, 'triangle', 0.24, head ? 1900 : 900); }
  kill() {
    this.tone(660, 0.1, 'triangle', 0.24);
    this.tone(990, 0.2, 'triangle', 0.24, 0, 0.09);
  }
  storm() {
    this.tone(196, 0.5, 'sawtooth', 0.14, 233);
    this.tone(196, 0.5, 'sawtooth', 0.14, 233, 0.6);
    this.noise(1.6, 0.14, 400, 'bandpass', 0.7, 0, 0, 1400);
  }
  chest() { for (let i = 0; i < 4; i++) this.tone([523, 659, 784, 1047][i], 0.16, 'triangle', 0.2, 0, i * 0.07); }
  empty() { this.tone(900, 0.03, 'square', 0.08, 500); }
  reload() {
    this.noise(0.05, 0.2, 2400, 'bandpass', 3);
    this.noise(0.05, 0.22, 1500, 'bandpass', 3, 0.22);
    this.tone(520, 0.04, 'square', 0.06, 0, 0.24);
  }
  swap() { this.noise(0.05, 0.12, 3000, 'bandpass', 2); }
  step() { this.noise(0.05, 0.07, 380 + Math.random() * 200, 'lowpass', 1); }
  land(v) { this.noise(0.12, Math.min(0.3, v * 0.02), 300, 'lowpass', 1); }
  count() { this.tone(520, 0.12, 'square', 0.12); }
  go() { this.tone(520, 0.1, 'square', 0.14); this.tone(780, 0.3, 'square', 0.14, 0, 0.1); }
  win() { for (let i = 0; i < 5; i++) this.tone([523, 659, 784, 1047, 1319][i], 0.3, 'triangle', 0.2, 0, i * 0.12); }
  lose() { this.tone(330, 0.3, 'triangle', 0.2, 220); this.tone(220, 0.5, 'triangle', 0.2, 147, 0.28); }
  ui() { this.tone(700, 0.04, 'triangle', 0.1); }
}
