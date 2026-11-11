// three.js scene: sky, fog, water, clouds, chunk meshes (dirty-queue remeshing),
// storm wall, block outline, chest glints, and the first-person viewmodel pass.
import * as THREE from 'three';
import { WORLD, B } from '../shared/constants.js';
import { meshChunk, CHUNKS_X, CHUNKS_Z } from './mesher.js';
import { makeAtlas, paintAtlas } from './textures.js';
import { theme } from './theme.js';
import { refreshPalette } from './mesher.js';
import { G } from './state.js';

// Render resolution per graphics setting, as a multiple of CSS pixels. 'auto' starts
// high and main.js steps it down if the frame rate is poor.
export function gfxScale(gfx) {
  const dpr = window.devicePixelRatio || 1;
  return gfx === 'low' ? Math.min(dpr, 0.75) : gfx === 'medium' ? Math.min(dpr, 1) : Math.min(dpr, 1.5);
}

const { SX, SZ, SEA, CHUNK } = WORLD;
const HORIZON = 0xbfe3f5;
const ZENITH = 0x3f8fe0;

function softDot() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.3, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

function rippleTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#c4c4c4';
  g.fillRect(0, 0, 128, 128);
  let seed = 31;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 46; i++) {
    const x = Math.floor(rnd() * 32) * 4, y = Math.floor(rnd() * 32) * 4, w = 8 + Math.floor(rnd() * 5) * 4;
    g.fillStyle = rnd() < 0.6 ? 'rgba(255,255,255,0.55)' : 'rgba(120,120,130,0.5)';
    g.fillRect(x, y, w, 4); g.fillRect(x - 128, y, w, 4);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.NearestFilter;
  t.repeat.set(150, 150);
  return t;
}

function streakTexture() {
  // vertical streaks whose alpha fades toward the top, so the wall reads as a curtain
  // near the ground and leaves the sky mostly clear
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const g = c.getContext('2d');
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  g.fillStyle = 'rgba(255,255,255,0.4)';
  g.fillRect(0, 0, 256, 128);
  for (let i = 0; i < 70; i++) {
    g.fillStyle = `rgba(255,255,255,${0.12 + rnd() * 0.5})`;
    g.fillRect(rnd() * 256, 0, 1 + rnd() * 6, 128);
  }
  g.globalCompositeOperation = 'destination-in';
  const grad = g.createLinearGradient(0, 0, 0, 128);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(0.45, 'rgba(0,0,0,0.35)');
  grad.addColorStop(1, 'rgba(0,0,0,1)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 128);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  return t;
}

export class Renderer {
  constructor(canvas) {
    // multisampling is costly on integrated GPUs and adds little on high-density screens
    const gfx = G.settings.gfx, dpr = window.devicePixelRatio || 1;
    const antialias = gfx === 'high' || (gfx !== 'low' && dpr < 1.5);
    this.gl = new THREE.WebGLRenderer({ canvas, antialias, powerPreference: 'high-performance' });
    this.scale = gfxScale(gfx);
    this.lite = false;
    this.gpu = 'unknown';
    try {
      const c = this.gl.getContext(), ext = c.getExtension('WEBGL_debug_renderer_info');
      this.gpu = String(ext ? c.getParameter(ext.UNMASKED_RENDERER_WEBGL) : c.getParameter(c.RENDERER));
    } catch { /* keep unknown */ }
    // no hardware acceleration: Chrome falls back to a software renderer, which is very slow
    this.software = /swiftshader|llvmpipe|software|basic render/i.test(this.gpu);
    this.gl.setPixelRatio(this.scale);
    this.gl.autoClear = false;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(HORIZON);
    this.scene.fog = new THREE.Fog(HORIZON, 80, 300);
    this.camera = new THREE.PerspectiveCamera(75, 1, 0.08, 800);
    this.camera.rotation.order = 'YXZ';
    this.scene.add(this.camera);

    this.sunDir = new THREE.Vector3(0.45, 0.8, 0.35).normalize();
    this.scene.add(new THREE.HemisphereLight(0xdcefff, 0x6b6250, 1.6));
    const sun = new THREE.DirectionalLight(0xfff2d8, 2.0);
    sun.position.copy(this.sunDir);
    this.scene.add(sun);

    this._buildSky();
    this._buildWater();
    this._buildClouds();
    this._buildStorm();
    this._buildOutline();

    this.atlas = makeAtlas();
    this.chunkMat = new THREE.MeshBasicMaterial({ vertexColors: true, map: this.atlas });
    this.chunks = new Array(CHUNKS_X * CHUNKS_Z).fill(null);
    this.dirty = new Set();
    this.world = null;
    this.stats = { remeshed: 0, lastMs: 0, tris: 0 };

    // viewmodel pass (drawn after the world with a cleared depth buffer)
    this.vmScene = new THREE.Scene();
    this.vmCamera = new THREE.PerspectiveCamera(58, 1, 0.01, 10);
    this.vmScene.add(new THREE.HemisphereLight(0xffffff, 0x777788, 1.9));
    const vl = new THREE.DirectionalLight(0xffffff, 1.6);
    vl.position.set(-0.5, 1, 0.8);
    this.vmScene.add(vl);
    this.vmVisible = true;

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  // Lite mode for slow machines: shorter view distance (fog hides the cut-off), no
  // clouds, opaque water. Much less to draw and far less blending.
  setLite(on) {
    if (on === this.lite) return;
    this.lite = on;
    this.scene.fog.near = on ? 40 : 80;
    this.scene.fog.far = on ? 125 : 300;
    this.clouds.visible = !on;
    this.water.material.transparent = !on;
    this.water.material.opacity = on ? 1 : 0.78;
    this.water.material.needsUpdate = true;
    if (!on) for (const m of this.chunks) if (m) m.visible = true;
  }

  // Apply the current theme's colours. Call before setWorld() so chunks mesh with them.
  applyTheme() {
    const d = theme.def;
    refreshPalette();
    paintAtlas(this.atlas);
    this.scene.background.setHex(d.sky[0]);
    this.scene.fog.color.setHex(d.sky[0]);
    this.sky.material.uniforms.horizon.value.setHex(d.sky[0]);
    this.sky.material.uniforms.top.value.setHex(d.sky[1]);
    this.water.material.color.setHex(d.water);
    this.bed.material.color.setHex(d.bed);
  }

  setScale(s) {
    this.scale = s;
    this.gl.setPixelRatio(s);
    this.resize();
  }

  resize() {
    const w = window.innerWidth || 1, h = window.innerHeight || 1;
    this.gl.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.vmCamera.aspect = w / h;
    this.vmCamera.updateProjectionMatrix();
  }

  _buildSky() {
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
      uniforms: {
        top: { value: new THREE.Color(ZENITH) },
        horizon: { value: new THREE.Color(HORIZON) },
        sunDir: { value: this.sunDir },
      },
      vertexShader: 'varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `
        uniform vec3 top; uniform vec3 horizon; uniform vec3 sunDir; varying vec3 vDir;
        void main(){
          vec3 d = normalize(vDir);
          vec3 c = mix(horizon, top, pow(max(d.y, 0.0), 0.6));
          float s = max(dot(d, sunDir), 0.0);
          c += vec3(1.0, 0.88, 0.62) * (smoothstep(0.9985, 0.9992, s) * 1.2 + pow(s, 24.0) * 0.22);
          gl_FragColor = vec4(c, 1.0);
          #include <colorspace_fragment>
        }`,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(500, 24, 12), mat);
    this.sky.renderOrder = -10;
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);
  }

  _buildWater() {
    const geo = new THREE.PlaneGeometry(2400, 2400);
    geo.rotateX(-Math.PI / 2);
    this.water = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: 0x3a98ea, map: (this.waterTex = rippleTexture()), transparent: true, opacity: 0.78, side: THREE.DoubleSide, depthWrite: false,
    }));
    this.water.position.set(SX / 2, SEA - 0.2, SZ / 2);
    this.water.renderOrder = 2;
    this.scene.add(this.water);
    const bed = this.bed = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x9c9470 }));
    bed.position.set(SX / 2, 2.5, SZ / 2);
    this.scene.add(bed);
  }

  _buildClouds() {
    const n = 34;
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.86, fog: false }), n);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    let seed = 99;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < n; i++) {
      p.set((rnd() - 0.5) * 900, 78 + rnd() * 26, (rnd() - 0.5) * 900);
      s.set(22 + rnd() * 44, 4 + rnd() * 4, 14 + rnd() * 30);
      m.compose(p, q, s);
      mesh.setMatrixAt(i, m);
    }
    mesh.frustumCulled = false;
    this.clouds = mesh;
    this.scene.add(mesh);
  }

  _buildStorm() {
    this.stormTex = streakTexture();
    const mat = new THREE.MeshBasicMaterial({
      color: 0xa066ff, map: this.stormTex, transparent: true, opacity: 0.7,
      side: THREE.DoubleSide, depthWrite: false, fog: false,
    });
    this.storm = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 110, 72, 1, true), mat);
    this.storm.position.y = 50;
    this.storm.renderOrder = 3;
    this.storm.frustumCulled = false;
    this.storm.visible = false;
    this.scene.add(this.storm);
  }

  _buildOutline() {
    const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1.004, 1.004, 1.004));
    this.outlineMat = new THREE.LineBasicMaterial({ color: 0x0b0f18, transparent: true, opacity: 0.75 });
    this.outline = new THREE.LineSegments(edges, this.outlineMat);
    this.outline.visible = false;
    this.scene.add(this.outline);
    this.chestGlow = new THREE.Mesh(new THREE.BoxGeometry(1.08, 1.08, 1.08),
      new THREE.MeshBasicMaterial({ color: 0xffd35a, transparent: true, opacity: 0.3, depthWrite: false }));
    this.chestGlow.visible = false;
    this.chestGlow.renderOrder = 6; // after the water plane (2) and storm wall (3)
    this.scene.add(this.chestGlow);

    this.glintGeo = new THREE.BufferGeometry();
    this.glintGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(64 * 3), 3));
    this.glintGeo.setDrawRange(0, 0);
    this.glints = new THREE.Points(this.glintGeo, new THREE.PointsMaterial({
      color: 0xffd76a, size: 0.9, map: softDot(), transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, sizeAttenuation: true, fog: false,
    }));
    this.glints.frustumCulled = false;
    this.glints.renderOrder = 6;
    this.scene.add(this.glints);
  }

  // ---- world / chunks ----
  setWorld(world) {
    this.world = world;
    for (let i = 0; i < this.chunks.length; i++) this._dropChunk(i);
    this.dirty.clear();
    for (let i = 0; i < this.chunks.length; i++) this.dirty.add(i);
    this.refreshChests();
  }

  _dropChunk(i) {
    const m = this.chunks[i];
    if (!m) return;
    this.scene.remove(m);
    m.geometry.dispose();
    this.chunks[i] = null;
  }

  markDirty(x, z) {
    const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
    this._mark(cx, cz);
    const lx = x - cx * CHUNK, lz = z - cz * CHUNK;
    const dx = lx === 0 ? -1 : lx === CHUNK - 1 ? 1 : 0;
    const dz = lz === 0 ? -1 : lz === CHUNK - 1 ? 1 : 0;
    if (dx) this._mark(cx + dx, cz);
    if (dz) this._mark(cx, cz + dz);
    if (dx && dz) this._mark(cx + dx, cz + dz); // AO reaches diagonally
  }

  _mark(cx, cz) {
    if (cx < 0 || cz < 0 || cx >= CHUNKS_X || cz >= CHUNKS_Z) return;
    this.dirty.add(cx + cz * CHUNKS_X);
  }

  // Remesh the dirty chunks nearest (px,pz) within a time/count budget. Returns how many remain.
  updateChunks(px, pz, maxCount, budgetMs) {
    if (!this.world || this.dirty.size === 0) return 0;
    const t0 = performance.now();
    let done = 0;
    while (this.dirty.size > 0 && done < maxCount) {
      let best = -1, bestD = Infinity;
      for (const i of this.dirty) {
        const cx = (i % CHUNKS_X + 0.5) * CHUNK - px, cz = (Math.floor(i / CHUNKS_X) + 0.5) * CHUNK - pz;
        const d = cx * cx + cz * cz;
        if (d < bestD) { bestD = d; best = i; }
      }
      this.dirty.delete(best);
      this._remesh(best);
      done++;
      if (performance.now() - t0 > budgetMs) break;
    }
    this.stats.remeshed += done;
    this.stats.lastMs = performance.now() - t0;
    return this.dirty.size;
  }

  _remesh(i) {
    const cx = i % CHUNKS_X, cz = Math.floor(i / CHUNKS_X);
    const out = meshChunk(this.world, cx, cz);
    const old = this.chunks[i];
    if (!out) { this._dropChunk(i); return; }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(out.positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(out.colors, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(out.uvs, 2));
    geo.setIndex(new THREE.BufferAttribute(out.indices, 1));
    geo.computeBoundingSphere();
    if (old) {
      old.geometry.dispose();
      old.geometry = geo;
    } else {
      const mesh = new THREE.Mesh(geo, this.chunkMat);
      mesh.matrixAutoUpdate = false;
      this.chunks[i] = mesh;
      this.scene.add(mesh);
    }
  }

  refreshChests() {
    const w = this.world;
    if (!w) return;
    const a = this.glintGeo.attributes.position;
    let n = 0;
    for (const c of w.chests || []) {
      if (n >= 64) break;
      if (w.get(c[0], c[1], c[2]) !== B.CHEST) continue;
      a.setXYZ(n++, c[0] + 0.5, c[1] + 1.55, c[2] + 0.5);
    }
    a.needsUpdate = true;
    this.glintGeo.setDrawRange(0, n);
  }

  setOutline(hit, isChest) {
    if (!hit) { this.outline.visible = false; this.chestGlow.visible = false; return; }
    this.outline.visible = true;
    this.outline.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
    this.outlineMat.color.setHex(isChest ? 0xfff0b0 : 0x0b0f18);
    this.chestGlow.visible = !!isChest;
    if (isChest) this.chestGlow.position.copy(this.outline.position);
  }

  setStorm(x, z, r, active) {
    const s = this.storm;
    s.visible = active && r > 0.3;
    if (!s.visible) return;
    s.position.x = x; s.position.z = z;
    s.scale.set(r, 1, r);
    this.stormTex.repeat.set(Math.max(2, Math.round(r / 6)), 1);
  }

  render(time, dt) {
    const cam = this.camera;
    this.sky.position.copy(cam.position);
    this.stormTex.offset.x = (time * 0.02) % 1;
    this.waterTex.offset.set((time * 0.012) % 1, (Math.sin(time * 0.25) * 0.01 + time * 0.006) % 1);
    this.storm.material.opacity = 0.62 + Math.sin(time * 1.7) * 0.08;
    this.clouds.position.x = ((time * 1.2) % 200) - 100;
    this.glints.position.y = Math.sin(time * 2.4) * 0.12;
    this.chestGlow.material.opacity = 0.22 + Math.sin(time * 6) * 0.08;
    if (this.lite) {
      const half = CHUNK / 2, lim = (125 + CHUNK) * (125 + CHUNK);
      for (let i = 0; i < this.chunks.length; i++) {
        const m = this.chunks[i];
        if (!m) continue;
        const dx = (i % CHUNKS_X) * CHUNK + half - cam.position.x, dz = Math.floor(i / CHUNKS_X) * CHUNK + half - cam.position.z;
        m.visible = dx * dx + dz * dz < lim;
      }
    }
    this.gl.clear();
    this.gl.render(this.scene, cam);
    this.stats.tris = this.gl.info.render.triangles;
    if (this.vmVisible) {
      this.gl.clearDepth();
      this.gl.render(this.vmScene, this.vmCamera);
    }
  }
}
