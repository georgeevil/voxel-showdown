// Static file routes + /api/info for the game server. No dependencies beyond Node.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
};

// [url prefix, directory on disk]
const MOUNTS = [
  ['/client/', path.join(ROOT, 'client')],
  ['/shared/', path.join(ROOT, 'shared')],
  ['/vendor/three/addons/', path.join(ROOT, 'node_modules', 'three', 'examples', 'jsm')],
];
const THREE_MODULE = path.join(ROOT, 'node_modules', 'three', 'build', 'three.module.js');
// three.module.js imports its sibling ./three.core.js in recent releases
const THREE_BUILD = path.join(ROOT, 'node_modules', 'three', 'build');

export function lanUrls(port) {
  const urls = [];
  try {
    const ifs = os.networkInterfaces();
    for (const name of Object.keys(ifs)) {
      for (const a of ifs[name] || []) {
        if ((a.family === 'IPv4' || a.family === 4) && !a.internal) urls.push(`http://${a.address}:${port}`);
      }
    }
  } catch { /* no interfaces */ }
  return urls;
}

function send(res, status, body, type, head) {
  res.writeHead(status, {
    'Content-Type': type || 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(head ? undefined : body);
}

function sendFile(res, file, head) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found', null, head);
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': st.size,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    if (head) return res.end();
    const stream = fs.createReadStream(file);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });
}

// Resolve `rel` under `base`; null when it would escape.
function safeJoin(base, rel) {
  const file = path.resolve(base, rel);
  if (file !== base && !file.startsWith(base + path.sep)) return null;
  return file;
}

export function handleHttp(req, res, getPort) {
  try {
    const head = req.method === 'HEAD';
    if (req.method !== 'GET' && !head) return send(res, 405, 'Method not allowed');

    const raw = String(req.url || '/').split('?')[0].split('#')[0];
    let p;
    try { p = decodeURIComponent(raw); } catch { return send(res, 400, 'Bad request', null, head); }
    if (p.includes('\0') || p.includes('\\')) return send(res, 400, 'Bad request', null, head);
    if (p.split('/').includes('..')) return send(res, 403, 'Forbidden', null, head);

    if (p === '/' || p === '/index.html') return sendFile(res, path.join(ROOT, 'client', 'index.html'), head);
    if (p === '/api/info') {
      const port = getPort();
      return send(res, 200, JSON.stringify({ urls: lanUrls(port), port }), MIME['.json'], head);
    }
    if (p === '/favicon.ico') {
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (p === '/vendor/three.module.js') return sendFile(res, THREE_MODULE, head);
    if (p.startsWith('/vendor/') && !p.startsWith('/vendor/three/') && /^\/vendor\/three\.[a-z.]+\.js$/.test(p)) {
      const f = safeJoin(THREE_BUILD, p.slice('/vendor/'.length));
      return f ? sendFile(res, f, head) : send(res, 403, 'Forbidden', null, head);
    }
    for (const [prefix, dir] of MOUNTS) {
      if (p.startsWith(prefix)) {
        const f = safeJoin(dir, p.slice(prefix.length));
        if (!f) return send(res, 403, 'Forbidden', null, head);
        return sendFile(res, f, head);
      }
    }
    return send(res, 404, 'Not found', null, head);
  } catch {
    try { send(res, 500, 'Server error'); } catch { /* socket gone */ }
  }
}
