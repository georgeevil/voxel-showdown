import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { boot, httpGet } from './helpers/server.js';

const T = { timeout: 15000 };
const ROOT = new URL('..', import.meta.url);
const disk = (rel) => fs.readFileSync(new URL(rel, ROOT), 'utf8');

describe('HTTP static server', T, () => {
  let ctx;
  before(async () => { ctx = await boot(); }, T);
  after(async () => { if (ctx) await ctx.close(); }, T);

  const isJs = (r) => /^(text|application)\/javascript/.test(r.headers['content-type'] || '');

  test('startServer resolves { port, close, game }', T, () => {
    assert.ok(Number.isInteger(ctx.port) && ctx.port > 0 && ctx.port !== 3000, `port ${ctx.port}`);
    assert.equal(typeof ctx.srv.close, 'function');
    assert.ok(ctx.game && typeof ctx.game.tickOnce === 'function');
  });

  test('GET / serves client/index.html as text/html', T, () => {
    return httpGet(ctx.port, '/').then((r) => {
      assert.equal(r.status, 200);
      assert.match(r.headers['content-type'] || '', /^text\/html/);
      assert.equal(r.body, disk('client/index.html'));
      assert.match(r.headers['cache-control'] || '', /no-store/);
    });
  });

  test('GET /shared/constants.js is JavaScript, byte-identical, no-store', T, async () => {
    const r = await httpGet(ctx.port, '/shared/constants.js');
    assert.equal(r.status, 200);
    assert.ok(isJs(r), `content-type ${r.headers['content-type']}`);
    assert.equal(r.body, disk('shared/constants.js'));
    assert.match(r.headers['cache-control'] || '', /no-store/);
  });

  test('GET /shared/world.js and /shared/physics.js', T, async () => {
    for (const f of ['world.js', 'physics.js']) {
      const r = await httpGet(ctx.port, `/shared/${f}`);
      assert.equal(r.status, 200, f);
      assert.ok(isJs(r), `${f} content-type ${r.headers['content-type']}`);
      assert.equal(r.body, disk(`shared/${f}`));
    }
  });

  test('GET /client/* serves client files with correct MIME types', T, async () => {
    const files = fs.readdirSync(new URL('client/', ROOT)).filter((f) => /\.(js|css|html)$/.test(f));
    assert.ok(files.length > 0, 'client/ has no files yet');
    for (const f of files) {
      const r = await httpGet(ctx.port, `/client/${f}`);
      assert.equal(r.status, 200, f);
      const ct = r.headers['content-type'] || '';
      if (f.endsWith('.js')) assert.ok(isJs(r), `${f}: ${ct}`);
      if (f.endsWith('.css')) assert.match(ct, /^text\/css/, f);
      if (f.endsWith('.html')) assert.match(ct, /^text\/html/, f);
      assert.equal(r.body, disk(`client/${f}`));
    }
  });

  test('GET /vendor/three.module.js', T, async () => {
    const r = await httpGet(ctx.port, '/vendor/three.module.js');
    assert.equal(r.status, 200);
    assert.ok(isJs(r), `content-type ${r.headers['content-type']}`);
    assert.equal(r.body.length, disk('node_modules/three/build/three.module.js').length);
  });

  test('GET /vendor/three/addons/* maps to three/examples/jsm', T, async () => {
    const rel = 'controls/PointerLockControls.js';
    const r = await httpGet(ctx.port, `/vendor/three/addons/${rel}`);
    assert.equal(r.status, 200);
    assert.ok(isJs(r), `content-type ${r.headers['content-type']}`);
    assert.equal(r.body, disk(`node_modules/three/examples/jsm/${rel}`));
  });

  test('GET /api/info returns JSON { urls, port }', T, async () => {
    const r = await httpGet(ctx.port, '/api/info');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'] || '', /^application\/json/);
    const j = JSON.parse(r.body);
    assert.ok(Array.isArray(j.urls));
    assert.equal(j.port, ctx.port);
    for (const u of j.urls) assert.match(u, /^http:\/\/\d+\.\d+\.\d+\.\d+:\d+/);
  });

  test('unknown paths are 404', T, async () => {
    for (const p of ['/nope', '/client/does-not-exist.js', '/shared/', '/vendor/three/addons/nope.js']) {
      const r = await httpGet(ctx.port, p);
      assert.equal(r.status, 404, `${p} -> ${r.status}`);
    }
  });

  test('files outside the static roots are not served', T, async () => {
    for (const p of ['/package.json', '/SPEC.md', '/server/game.js', '/node_modules/ws/package.json', '/tests/http.test.js']) {
      const r = await httpGet(ctx.port, p);
      assert.notEqual(r.status, 200, `${p} should not be served`);
    }
  });

  test('path traversal is blocked', T, async () => {
    const paths = [
      '/client/../package.json',
      '/shared/../package.json',
      '/client/%2e%2e/package.json',
      '/client/..%2fpackage.json',
      '/shared/%2e%2e%2fpackage.json',
      '/client/..%5cpackage.json',
      '/shared/../server/game.js',
      '/shared/..%2fserver%2fgame.js',
      '/vendor/three/addons/../../package.json',
      '/vendor/three/addons/%2e%2e/%2e%2e/package.json',
      '/vendor/three/addons/..%2f..%2f..%2f..%2fpackage.json',
      '/client/../../../../../../etc/passwd',
      '/client/%2e%2e/%2e%2e/%2e%2e/%2e%2e/%2e%2e/etc/passwd',
      '/shared//etc/passwd',
      '/client/%00/../package.json',
      '/shared/constants.js%00.html',
    ];
    for (const p of paths) {
      const r = await httpGet(ctx.port, p);
      assert.ok(r.status >= 400 && r.status < 500, `${p} -> ${r.status}`);
      assert.ok(!r.body.includes('"dependencies"'), `${p} leaked package.json`);
      assert.ok(!r.body.includes('root:'), `${p} leaked /etc/passwd`);
      assert.ok(!r.body.includes('startServer'), `${p} leaked server source`);
    }
  });

  test('malformed percent-encoding does not crash the server', T, async () => {
    const r = await httpGet(ctx.port, '/client/%E0%A4%A');
    assert.ok(r.status >= 400 && r.status < 500, `status ${r.status}`);
    const ok = await httpGet(ctx.port, '/shared/constants.js');
    assert.equal(ok.status, 200);
  });
});
