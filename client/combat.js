// Combat mode: targeting, firing cadence, reload, slot selection, chest interaction, zoom.
import { WEAPONS, WEAPON_IDS, PLAYER, B } from '../shared/constants.js';
import { raycast } from '../shared/world.js';
import { G } from './state.js';
import { r2, r4 } from './net.js';
import { blockColorLinear } from './mesher.js';

const RECOIL = { rifle: 0.011, shotgun: 0.05, sniper: 0.075 };
const KICK = { rifle: 1, shotgun: 2.6, sniper: 3 };
const tmpCol = [0, 0, 0];

export class Combat {
  constructor({ net, player, input, audio, hud, vm, fx, build }) {
    Object.assign(this, { net, player, input, audio, hud, vm, fx, build });
    this.target = null;       // raycast result under the crosshair (<= 8 blocks)
    this.chest = false;       // target is an openable chest
    this.zoom = 0;            // 0..1
    this.nextFire = 0;
    this.queuedUntil = 0;     // buffered click for semi-auto weapons
    this.nextAutoReload = 0;
    this.slotLockUntil = 0;   // ignore server slot echoes briefly after a local switch
    this.spread = 0;
  }

  get weaponId() { return WEAPON_IDS[G.you.slot] || 'pickaxe'; }

  selectSlot(i, now) {
    const you = G.you;
    if (i < 0 || i > 3) return;
    if (!you.owned[i]) { this.audio.deny(); return; }
    if (i === you.slot) return;
    you.slot = i;
    you.reloading = false;
    this.slotLockUntil = now + 350;
    this.net.send({ t: 'slot', i });
    this.vm.show(i);
    this.audio.swap();
    this.nextFire = Math.max(this.nextFire, now + 220);
  }

  cycleSlot(dir, now) {
    const you = G.you;
    for (let k = 1; k <= 4; k++) {
      const i = (you.slot + dir * k + 8) % 4;
      if (you.owned[i]) { this.selectSlot(i, now); return; }
    }
  }

  reload() {
    const you = G.you, w = WEAPONS[this.weaponId];
    if (!w || w.mag <= 0 || you.reloading || !you.alive) return;
    if (you.ammo[you.slot] >= w.mag || you.reserve[you.slot] <= 0) return;
    this.net.send({ t: 'reload' });
    this.audio.reload();
  }

  interact() {
    const t = this.target;
    if (!this.chest || !t || !G.you.alive) return;
    this.net.send({ t: 'interact', x: t.x, y: t.y, z: t.z });
  }

  // eye, dir: arrays. canAct: pointer locked, alive, not chatting.
  update(now, dt, eye, dir, canAct) {
    const you = G.you, world = G.world, input = this.input;
    const id = this.weaponId, w = WEAPONS[id];

    this.target = world && you.alive ? raycast(world, eye, dir, 8) : null;
    const t = this.target;
    this.chest = !!(t && t.block === B.CHEST && t.dist <= PLAYER.REACH + 1);
    if (t && !this.chest && (t.dist > PLAYER.REACH || this.build.active)) this.target = null;

    const wantZoom = canAct && input.rmb && you.slot > 0 && !this.build.active && !you.reloading;
    this.zoom += ((wantZoom ? 1 : 0) - this.zoom) * Math.min(1, dt * 14);
    const moving = this.player.speed > 1 ? 4 : 0;
    this.spread += ((w.spread * 180 + moving + (this.player.s.onGround ? 0 : 5)) * (1 - this.zoom * 0.6) - this.spread) * Math.min(1, dt * 12);

    if (!canAct) { input.lmbPressed = false; return; }
    const pressed = input.lmbPressed;
    input.lmbPressed = false;

    if (this.build.active) {
      if (input.lmb) this.build.tryPlace(now, pressed);
      return;
    }
    if (pressed) this.queuedUntil = now + 220;

    const hasMag = w.mag > 0;
    if (hasMag && !you.reloading && you.ammo[you.slot] <= 0 && you.reserve[you.slot] > 0 && now > this.nextAutoReload && now > this.nextFire) {
      this.nextAutoReload = now + 600;
      this.reload();
    }
    const want = w.auto ? input.lmb : now < this.queuedUntil;
    if (!want || now < this.nextFire) return;
    if (hasMag && you.reloading) return;
    if (hasMag && you.ammo[you.slot] <= 0) {
      if (pressed) this.audio.empty();
      this.queuedUntil = 0;
      return;
    }
    this.queuedUntil = 0;
    this.nextFire = now + 1000 / w.rate + 6;
    this.net.send({ t: 'fire', o: [r2(eye[0]), r2(eye[1]), r2(eye[2])], d: [r4(dir[0]), r4(dir[1]), r4(dir[2])] });

    if (id === 'pickaxe') {
      this.vm.swingNow();
      this.audio.shot('pickaxe');
      if (t && t.dist <= PLAYER.REACH && t.block !== B.AIR) {
        const hx = eye[0] + dir[0] * t.dist + t.nx * 0.05, hy = eye[1] + dir[1] * t.dist + t.ny * 0.05, hz = eye[2] + dir[2] * t.dist + t.nz * 0.05;
        this.fx.burst(hx, hy, hz, blockColorLinear(t.block, tmpCol), 5, 3.5, 0.09, 0.08);
        this.audio.pickHit();
        this.hud.crossKick(5);
      }
    } else {
      you.ammo[you.slot] = Math.max(0, you.ammo[you.slot] - 1);
      this.vm.fire(KICK[id] || 1);
      this.player.recoil((RECOIL[id] || 0.01) * (0.85 + Math.random() * 0.3));
      this.audio.shot(id);
      this.hud.crossKick(id === 'rifle' ? 6 : 16);
    }
  }
}
