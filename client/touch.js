// Touch controls for tablets and phones: a floating thumb stick on the left, drag
// anywhere else to look, and on-screen buttons. Switched on by the first touch, so
// laptops with touch screens keep working with keyboard and mouse until touched.
// Touch has no pointer lock, so Input keeps a "virtual lock" (see Input.lock).
import { G } from './state.js';

const LOOK_GAIN = 2.3;   // touch pixels are worth more than mouse counts
const STICK_R = 56;      // px of travel for full speed

function btn(root, cls, label) {
  const b = document.createElement('div');
  b.className = 'tbtn ' + cls;
  b.textContent = label;
  root.append(b);
  return b;
}

export class TouchControls {
  constructor(input, canvas) {
    this.input = input;
    this.stickId = null; this.lookId = null; this.fireId = null;
    this.sx = 0; this.sy = 0; this.lx = 0; this.ly = 0;

    const root = this.root = document.createElement('div');
    root.id = 'touch';
    this.base = document.createElement('div'); this.base.className = 'stick-base';
    this.knob = document.createElement('div'); this.knob.className = 'stick-knob';
    this.base.append(this.knob);
    root.append(this.base);
    const fire = btn(root, 'fire', 'FIRE');
    const jump = btn(root, 'jump', 'JUMP');
    const aim = btn(root, 'aim', 'AIM');
    const reload = btn(root, 'reload', 'RELOAD');
    const use = btn(root, 'use', 'OPEN');
    const build = btn(root, 'build', 'BUILD');
    const mat = btn(root, 'mat', 'MATERIAL');
    const menu = btn(root, 'menu', '☰');
    document.body.append(root);
    this.reloadBtn = reload;

    // first touch anywhere switches touch mode on
    window.addEventListener('touchstart', () => this.enable(), { passive: true, once: true });

    const opt = { passive: false };
    // ---- move + look on the game view ----
    canvas.addEventListener('touchstart', (e) => {
      e.preventDefault();
      if (!G.locked) return;
      for (const t of e.changedTouches) {
        if (this.stickId === null && t.clientX < window.innerWidth * 0.4) {
          this.stickId = t.identifier; this.sx = t.clientX; this.sy = t.clientY;
          this.base.style.left = t.clientX + 'px'; this.base.style.top = t.clientY + 'px';
          this.base.classList.add('on');
          this.knob.style.transform = 'translate(-50%, -50%)';
        } else if (this.lookId === null) {
          this.lookId = t.identifier; this.lx = t.clientX; this.ly = t.clientY;
        }
      }
    }, opt);
    const move = (e) => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        if (t.identifier === this.stickId) {
          let dx = t.clientX - this.sx, dy = t.clientY - this.sy;
          const d = Math.hypot(dx, dy);
          if (d > STICK_R) { dx *= STICK_R / d; dy *= STICK_R / d; }
          this.knob.style.transform = `translate(calc(-50% + ${dx.toFixed(0)}px), calc(-50% + ${dy.toFixed(0)}px))`;
          const dead = 0.18;
          const ax = dx / STICK_R, ay = -dy / STICK_R;
          input.moveX = Math.abs(ax) < dead ? 0 : ax;
          input.moveY = Math.abs(ay) < dead ? 0 : ay;
          input.touchSprint = d >= STICK_R * 0.97 && ay > 0.6;
        } else if (t.identifier === this.lookId || t.identifier === this.fireId) {
          if (G.locked) { input.dx += (t.clientX - this.lx) * LOOK_GAIN; input.dy += (t.clientY - this.ly) * LOOK_GAIN; }
          this.lx = t.clientX; this.ly = t.clientY;
        }
      }
    };
    const end = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === this.stickId) this.releaseStick();
        if (t.identifier === this.lookId) this.lookId = null;
        if (t.identifier === this.fireId) { this.fireId = null; input.keyFire = false; input._sync(); fire.classList.remove('down'); }
      }
    };
    canvas.addEventListener('touchmove', move, opt);
    canvas.addEventListener('touchend', end, opt);
    canvas.addEventListener('touchcancel', end, opt);

    // ---- fire: hold to shoot, and keep aiming with the same thumb ----
    fire.addEventListener('touchstart', (e) => {
      e.preventDefault();
      if (!G.locked || this.fireId !== null) return;
      const t = e.changedTouches[0];
      this.fireId = t.identifier;
      if (this.lookId === null) { this.lx = t.clientX; this.ly = t.clientY; }
      input.keyFire = true; input.lmbPressed = true; input._sync();
      fire.classList.add('down');
      if (input.onClick) input.onClick(0);
    }, opt);
    fire.addEventListener('touchmove', move, opt);
    fire.addEventListener('touchend', end, opt);
    fire.addEventListener('touchcancel', end, opt);

    // ---- hold button: jump ----
    jump.addEventListener('touchstart', (e) => { e.preventDefault(); if (G.locked) input.keys.add('Space'); jump.classList.add('down'); }, opt);
    const jumpUp = (e) => { e.preventDefault(); input.keys.delete('Space'); jump.classList.remove('down'); };
    jump.addEventListener('touchend', jumpUp, opt);
    jump.addEventListener('touchcancel', jumpUp, opt);

    // ---- tap buttons ----
    const tap = (el, fn) => el.addEventListener('touchstart', (e) => { e.preventDefault(); e.stopPropagation(); fn(); }, opt);
    tap(aim, () => { input.zoomToggle = !input.zoomToggle; input._sync(); aim.classList.toggle('down', input.zoomToggle); });
    tap(reload, () => input.press('KeyR'));
    tap(use, () => input.press('KeyE'));
    tap(build, () => input.press('KeyQ'));
    tap(mat, () => input.press('KeyG'));
    tap(menu, () => input.unlock());
    document.querySelectorAll('#hotbar .slot').forEach((s, i) => tap(s, () => input.press('Digit' + (i + 1))));
    const board = document.getElementById('board');
    if (board) tap(board, () => input.pressAny('Tab'));
    this.aimBtn = aim;
  }

  enable() {
    if (this.input.touchMode) return;
    this.input.touchMode = true;
    document.body.classList.add('touch');
  }

  releaseStick() {
    this.stickId = null;
    this.input.moveX = 0; this.input.moveY = 0; this.input.touchSprint = false;
    this.base.classList.remove('on');
  }

  // called every frame by main.js
  update(buildActive, chestTargeted) {
    if (!this.input.touchMode) return;
    if (!G.locked && (this.stickId !== null || this.lookId !== null)) { this.releaseStick(); this.lookId = null; }
    const sig = (buildActive ? 'b' : 'c') + (chestTargeted ? '1' : '0') + (this.input.zoomToggle ? 'z' : '');
    if (sig === this.sig) return;
    this.sig = sig;
    this.root.classList.toggle('building', buildActive);
    this.root.classList.toggle('chest', chestTargeted);
    this.reloadBtn.textContent = buildActive ? 'ROTATE' : 'RELOAD';
    this.aimBtn.classList.toggle('down', this.input.zoomToggle);
  }
}
