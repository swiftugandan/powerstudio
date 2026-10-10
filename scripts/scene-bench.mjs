#!/usr/bin/env node
/** Times the diagram build in Chromium the way the viewport runs it: in steps, with the browser's own garbage
 * collector. The diagram is a synthetic national grid with a load flow's result boxes on every busbar and branch,
 * so it needs no reference files. Prints the total time, the number of steps and the longest step; the scale bar is
 * no frame over 100 ms.
 * Usage: node scripts/scene-bench.mjs [--side n] [--fixed] [--repeat n]
 * --side sets the grid's side (default 265: 70,225 busbars); --fixed switches label placement off. */
import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (/** @type {string} */ name, /** @type {number} */ fallback) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : fallback; };
const side = opt('--side', 265), repeat = opt('--repeat', 3), disentangle = !args.includes('--fixed');

const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage();
await page.route('http://bench.local/**', async route => {
  const path = new URL(route.request().url()).pathname;
  const body = path === '/' ? '<!doctype html><title>bench</title>' : await readFile(join(root, decodeURIComponent(path)));
  await route.fulfill({ body, contentType: path === '/' ? 'text/html' : 'text/javascript' });
});
await page.goto('http://bench.local/');
console.log(JSON.stringify({ browser: browser.version(), side, disentangle }));
for (let run = 0; run < repeat; run++) {
  const r = await page.evaluate(async ({ side, disentangle }) => {
    const { sceneSteps } = await import('/src/render/scene.js');
    const { canvasMeasure } = await import('/src/render/metrics.js');
    const c = [0.5, 0.5, 0.5, 1];
    const P = { bg: c, grid: c, ink: c, muted: c, select: c, hover: c, label: c, labelMuted: c, boxBg: c, boxBorder: c, boxText: c, kv: { ehv: c, hv: c, mv: c, lv: c }, fault: c, preview: c };
    // Busbars on a grid, each joined to its right and lower neighbours.
    const elements = [], ann = new Map();
    for (let r = 0; r < side; r++) for (let q = 0; q < side; q++) {
      const id = `B${r}-${q}`;
      elements.push({ id, cls: 'bus', name: `Bus ${r}-${q}`, vn: r % 3 ? 132 : 400, x: q * 360, y: r * 300, len: 160, orient: 'h', labels: {} });
      ann.set(id, { box: ['1.012 p.u.  -12.34°'] });
      if (q) { elements.push({ id: `L${r}-${q}`, cls: 'line', name: '', from: `B${r}-${q - 1}`, to: id, fromPos: 0.4, toPos: -0.4, bend: 0, labels: {} }); ann.set(`L${r}-${q}`, { ends: ['123.4 MW\n-12.3 Mvar', '-123.1 MW\n13.0 Mvar'], mid: '54.3 %' }); }
      if (r) { elements.push({ id: `V${r}-${q}`, cls: 'line', name: '', from: `B${r - 1}-${q}`, to: id, fromPos: 0.1, toPos: 0.1, bend: 0, labels: {} }); ann.set(`V${r}-${q}`, { ends: ['12.4 MW\n-2.3 Mvar', '-12.1 MW\n3.0 Mvar'], mid: '14.3 %' }); }
    }
    const steps = sceneSteps({ elements, palette: P, selection: new Set(), hover: '', overlay: { elements: ann, faultAt: '', deenergized: new Set() }, preview: null,
      labels: { names: true, branchNames: false, boxes: true, disentangle }, measure: canvasMeasure() });
    const t0 = performance.now();
    let t = t0, longest = 0, n = 0, done = false;
    // The viewport gives a build a few milliseconds a frame; here each step is timed alone, with a frame between.
    while (!done) {
      const s = performance.now();
      done = !!steps.next().done;
      longest = Math.max(longest, performance.now() - s);
      n++;
      if (n % 16 === 0) await new Promise(requestAnimationFrame);
      t = performance.now();
    }
    return { elements: elements.length, steps: n, longestMs: Math.round(longest), totalMs: Math.round(t - t0) };
  }, { side, disentangle });
  console.log(JSON.stringify(r));
}
await browser.close();
