#!/usr/bin/env node
/** Times the engine's load flow inside a Web Worker in Chromium, the environment the design's scale bar names.
 * Files are served from the repository through Playwright's request routing, so no server is needed.
 * Usage: node scripts/browser-bench.mjs <case.m relative to the repository>... [--warm] [--repeat n] */
import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const warm = args.includes('--warm');
const ri = args.indexOf('--repeat');
const repeat = ri >= 0 ? Number(args[ri + 1]) : 3;
const cases = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--repeat');
const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.html': 'text/html' };

const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage();
await page.route('http://bench.local/**', async route => {
  const path = new URL(route.request().url()).pathname;
  const body = path === '/' ? '<!doctype html><title>bench</title>' : await readFile(join(root, decodeURIComponent(path)));
  await route.fulfill({ body, contentType: types[/** @type {keyof typeof types} */ (extname(path) || '.html')] ?? 'text/plain' });
});
await page.goto('http://bench.local/');
console.log(JSON.stringify({ browser: browser.version(), warm, repeat }));
const results = await page.evaluate(({ cases, repeat, warm }) => new Promise((resolve, reject) => {
  const worker = new Worker('/scripts/bench/worker.mjs', { type: 'module' });
  /** @type {unknown[]} */
  const out = [];
  worker.onmessage = e => { if (e.data.done) resolve(out); else if (e.data.error) reject(new Error(e.data.error)); else out.push(e.data); };
  worker.onerror = e => reject(new Error(e.message));
  worker.postMessage({ cases, repeat, warm });
}), { cases, repeat, warm });
for (const r of /** @type {unknown[]} */ (results)) console.log(JSON.stringify(r));
await browser.close();
