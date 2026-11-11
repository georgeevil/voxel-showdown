// Keyboard / mouse capture and pointer lock. Game logic subscribes through callbacks.
import { G } from './state.js';

const GAME_KEYS = new Set(['Space', 'Tab', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft', 'ShiftRight',
  'Digit1', 'Digit2', 'Digit3', 'Digit4', 'KeyQ', 'KeyE', 'KeyR', 'KeyG', 'KeyB', 'KeyM', 'F3',
  'KeyF', 'KeyC', 'KeyZ', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'KeyI', 'KeyJ', 'KeyK', 'KeyL']);
const FIRE_KEY = 'KeyF';                 // keyboard trigger: lets touchpad players aim and fire at once
const ZOOM_KEYS = new Set(['KeyC', 'KeyZ']); // toggle aim instead of holding the right button

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.dx = 0; this.dy = 0;
    this.lmb = false; this.rmb = false;
    this.lmbPressed = false; // edge, cleared by the consumer each frame
    this.onKey = null;       // (code) => void, only while playing (locked, not chatting)
    this.onAnyKey = null;    // (code, ev) => void, always
    this.onWheel = null;     // (dir) => void
    this.onLock = null;      // (locked) => void
    this.onClick = null;     // (button) => void while locked
    this.onTouchpad = null;  // () => void, once, when scrolling looks like a touchpad
    this.mouseL = false; this.mouseR = false; this.keyFire = false; this.zoomToggle = false;
    this.wheelAcc = 0; this.wheelAt = 0; this.wheelLast = 0; this.padVotes = 0; this.padSeen = false;

    window.addEventListener('keydown', (e) => {
      if (this.onAnyKey) this.onAnyKey(e.code, e);
      if (e.defaultPrevented) return;
      if (G.chatting || !G.locked) return;
      if (GAME_KEYS.has(e.code)) e.preventDefault();
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code === FIRE_KEY) {
        this.keyFire = true; this.lmbPressed = true; this._sync();
        if (this.onClick) this.onClick(0);
      } else if (ZOOM_KEYS.has(e.code)) { this.zoomToggle = !this.zoomToggle; this._sync(); }
      if (this.onKey) this.onKey(e.code);
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      if (e.code === FIRE_KEY) { this.keyFire = false; this._sync(); }
    });
    window.addEventListener('blur', () => this.reset());
    document.addEventListener('mousemove', (e) => {
      if (!G.locked) return;
      // guard against the occasional huge spurious delta some browsers report
      const mx = e.movementX || 0, my = e.movementY || 0;
      if (Math.abs(mx) > 600 || Math.abs(my) > 600) return;
      this.dx += mx; this.dy += my;
    });
    canvas.addEventListener('mousedown', (e) => {
      if (!G.locked) return;
      if (e.button === 0) { this.mouseL = true; this.lmbPressed = true; }
      if (e.button === 2) { this.mouseR = true; this.zoomToggle = false; }
      this._sync();
      if (this.onClick) this.onClick(e.button);
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouseL = false;
      if (e.button === 2) this.mouseR = false;
      this._sync();
    });
    window.addEventListener('contextmenu', (e) => { if (G.locked || e.target === canvas) e.preventDefault(); });
    window.addEventListener('wheel', (e) => {
      if (!G.locked || G.chatting) return;
      if (e.deltaY === 0) return;
      const now = performance.now();
      // A touchpad sends a stream of small pixel deltas (with momentum) where a mouse
      // wheel sends one big notch, so accumulate and act once per deliberate swipe.
      if (!this.padSeen && e.deltaMode === 0) {
        if (Math.abs(e.deltaY) < 30 || !Number.isInteger(e.deltaY)) this.padVotes++; else this.padVotes = Math.max(0, this.padVotes - 2);
        if (this.padVotes >= 6) { this.padSeen = true; if (this.onTouchpad) this.onTouchpad(); }
      }
      if (now - this.wheelLast > 220) this.wheelAcc = 0;
      this.wheelLast = now;
      this.wheelAcc += e.deltaMode === 0 ? e.deltaY : e.deltaY * 40;
      if (Math.abs(this.wheelAcc) < 60 || now - this.wheelAt < 280) return;
      const dir = this.wheelAcc > 0 ? 1 : -1;
      this.wheelAcc = 0; this.wheelAt = now;
      if (this.onWheel) this.onWheel(dir);
    }, { passive: true });
    document.addEventListener('pointerlockchange', () => {
      G.locked = document.pointerLockElement === canvas;
      if (!G.locked) this.reset();
      if (this.onLock) this.onLock(G.locked);
    });
    document.addEventListener('pointerlockerror', () => { /* user can simply click again */ });
  }

  _sync() {
    this.lmb = this.mouseL || this.keyFire;
    this.rmb = this.mouseR || this.zoomToggle;
  }

  cancelZoom() { this.zoomToggle = false; this._sync(); }

  reset() {
    this.keys.clear();
    this.mouseL = this.mouseR = this.keyFire = this.zoomToggle = false;
    this.lmb = this.rmb = this.lmbPressed = false;
    this.dx = this.dy = 0;
  }

  // Browsers refuse a re-lock for about a second after Esc; retry once inside the
  // user-activation window so a quick click on Resume still works.
  lock(retry = true) {
    const again = () => { if (retry && !G.locked) setTimeout(() => { if (!G.locked) this.lock(false); }, 1100); };
    try {
      const p = this.canvas.requestPointerLock();
      if (p && typeof p.catch === 'function') p.catch(again);
    } catch { /* not available (touch devices, automation) */ }
  }

  unlock() {
    try { if (document.pointerLockElement) document.exitPointerLock(); } catch { /* ignore */ }
  }

  down(code) { return this.keys.has(code); }
}
