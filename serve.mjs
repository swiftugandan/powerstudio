#!/usr/bin/env node
/** Development server for the modular source (or, with SERVE_ROOT, any built folder such as dist/). GET and HEAD only, bound to 127.0.0.1, confined to this folder,
 * with a restrictive Content Security Policy. No build step is needed. */
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.env.SERVE_ROOT ? resolve(process.env.SERVE_ROOT) : dirname(fileURLToPath(import.meta.url));
// The built file carries its own Content-Security-Policy meta tag; the source tree gets this header instead.
const sendCsp = !process.env.SERVE_ROOT;
const port = Number(process.env.PORT || 8770), host = process.env.HOST || '127.0.0.1';
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2', '.png': 'image/png', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};
const csp = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

const server = http.createServer(async (req, res) => {
  try {
    if (!['GET', 'HEAD'].includes(req.method ?? '')) { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    let file = resolve(root, '.' + path);
    if (file !== root && !file.startsWith(root + sep)) { res.writeHead(403); return res.end('Forbidden'); }
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer', 'Cross-Origin-Opener-Policy': 'same-origin', ...(sendCsp ? { 'Content-Security-Policy': csp } : {}),
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch (error) {
    const missing = /** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT';
    res.writeHead(missing ? 404 : 400, { 'Content-Type': 'text/plain' });
    res.end(missing ? 'Not found' : 'Bad request');
  }
});
server.listen(port, host, () => console.log(`PowerStudio: http://${host}:${port}/\nPress Ctrl+C to stop.`));
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
