// Local player: mouse look, fixed-step movement through shared stepPlayer, camera rig.
import { PLAYER, WORLD } from '../shared/constants.js';
import { stepPlayer } from '../shared/physics.js';

const H = 1 / 120; // fixed physics step
const PITCH_LIMIT = Math.PI / 2 - 0.01;

export class LocalPlayer {
  constructor() {
    this.s = { p: [WORLD.SX / 2, WORLD.SY, WORLD.SZ / 2], v: [0, 0, 0], onGround: false };
    this.prev = [0, 0, 0];
    this.pos = [0, 0, 0];   // render-interpolated feet position
    this.yaw = 0; this.pitch = 0;
    this.kick = 0;          // recoil pitch offset, recovers to 0
    this.kickVel = 0;
    this.acc = 0;
    this.inp = { fwd: 0, right: 0, yaw: 0, jump: false, sprint: false };
    this.bobT = 0; this.bobAmp = 0;
    this.dip = 0;           // landing dip
    this.stepUp = 0;        // visual offset that smooths the 1-block auto step-up
    this.stepDist = 0;
    this.speed = 0;         // horizontal speed (for viewmodel / fov)
    this.hasPos = false;
    this.onLand = null;     // (impactSpeed) => void
    this.onStep = null;
    this.teleport(this.s.p);
    this.hasPos = false;
  }

  teleport(p) {
    const s = this.s;
    s.p[0] = p[0]; s.p[1] = p[1]; s.p[2] = p[2];
    s.v[0] = s.v[1] = s.v[2] = 0;
    s.onGround = false;
    for (let i = 0; i < 3; i++) { this.prev[i] = p[i]; this.pos[i] = p[i]; }
    this.acc = 0; this.stepUp = 0; this.dip = 0;
    this.hasPos = true;
  }

  look(dx, dy, sens) {
    this.yaw -= dx * sens;
    this.pitch -= dy * sens;
    if (this.pitch > PITCH_LIMIT) this.pitch = PITCH_LIMIT;
    if (this.pitch < -PITCH_LIMIT) this.pitch = -PITCH_LIMIT;
    if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
    if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
  }

  recoil(amount) { this.kickVel += amount * 14; }

  // simulate=false freezes the body (dead / not joined); control=false ignores the keys.
  update(dt, world, input, simulate, control) {
    const s = this.s, inp = this.inp;
    const ctl = input && control && simulate;
    // WASD or the arrow keys
    inp.fwd = ctl ? (input.down('KeyW') || input.down('ArrowUp') ? 1 : 0) - (input.down('KeyS') || input.down('ArrowDown') ? 1 : 0) : 0;
    inp.right = ctl ? (input.down('KeyD') || input.down('ArrowRight') ? 1 : 0) - (input.down('KeyA') || input.down('ArrowLeft') ? 1 : 0) : 0;
    if (ctl && (input.moveX || input.moveY)) { // touch stick
      inp.fwd = Math.max(-1, Math.min(1, inp.fwd + input.moveY));
      inp.right = Math.max(-1, Math.min(1, inp.right + input.moveX));
    }
    inp.jump = !!(ctl && input.down('Space'));
    inp.sprint = !!(ctl && (input.down('ShiftLeft') || input.down('ShiftRight') || input.touchSprint) && inp.fwd > 0);
    inp.yaw = this.yaw;

    // recoil spring
    this.kick += this.kickVel * dt;
    this.kickVel -= this.kickVel * Math.min(1, dt * 18);
    this.kick -= this.kick * Math.min(1, dt * 7);

    if (!world || !simulate || !this.hasPos) return;
    this.acc += Math.min(dt, 0.1);
    while (this.acc >= H) {
      this.prev[0] = s.p[0]; this.prev[1] = s.p[1]; this.prev[2] = s.p[2];
      const wasGround = s.onGround, vy = s.v[1];
      stepPlayer(world, s, inp, H);
      if (!wasGround && s.onGround && vy < -7) {
        this.dip = Math.min(0.32, -vy * 0.014);
        if (this.onLand) this.onLand(-vy);
      }
      const dy = s.p[1] - this.prev[1];
      if (dy > 0.45 && dy < 1.2 && wasGround) this.stepUp = Math.min(1.0, this.stepUp + dy);
      if (s.onGround) {
        const dx = s.p[0] - this.prev[0], dz = s.p[2] - this.prev[2];
        this.stepDist += Math.sqrt(dx * dx + dz * dz);
        if (this.stepDist > 2.3) { this.stepDist = 0; if (this.onStep) this.onStep(); }
      }
      this.acc -= H;
    }
    const a = this.acc / H;
    for (let i = 0; i < 3; i++) this.pos[i] = this.prev[i] + (s.p[i] - this.prev[i]) * a;
    this.stepUp -= this.stepUp * Math.min(1, dt * 14);
    this.speed = Math.sqrt(s.v[0] * s.v[0] + s.v[2] * s.v[2]);
    const moving = s.onGround ? Math.min(1, this.speed / PLAYER.WALK) : 0;
    this.bobAmp += (moving - this.bobAmp) * Math.min(1, dt * 10);
    this.bobT += dt * (6 + this.speed * 1.1);
    this.dip -= this.dip * Math.min(1, dt * 9);
  }

  eye(out) {
    out[0] = this.pos[0];
    out[1] = this.pos[1] + PLAYER.EYE;
    out[2] = this.pos[2];
    return out;
  }

  dir(out) {
    const p = this.pitch + this.kick, cp = Math.cos(p);
    out[0] = -Math.sin(this.yaw) * cp;
    out[1] = Math.sin(p);
    out[2] = -Math.cos(this.yaw) * cp;
    return out;
  }

  applyCamera(cam) {
    const bob = Math.sin(this.bobT) * 0.035 * this.bobAmp;
    cam.position.set(this.pos[0], this.pos[1] + PLAYER.EYE - this.dip - this.stepUp + bob, this.pos[2]);
    cam.rotation.set(this.pitch + this.kick, this.yaw, Math.cos(this.bobT * 0.5) * 0.004 * this.bobAmp);
  }
}
