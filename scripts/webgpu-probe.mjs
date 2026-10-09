#!/usr/bin/env node
/** Diagnostic: opens the built app in Chromium with several flag sets and reports, for each, which backend the app
 * chose and whether the diagram actually reached the screen (share of 132 kV blue pixels in a screenshot).
 * Usage: node scripts/webgpu-probe.mjs [url]   (defaults to file://…/dist/PowerStudio.html) */
import { chromium } from '@playwright/test';
import { resolve } from 'node:path';
import { decodePNG, share } from '../tests/browser/png.mjs';

const url = process.argv[2] ?? `file://${resolve('dist/PowerStudio.html')}?sample=ieee14`;
const sets = [
  ['shell, no flags', {}],
  ['chromium, unsafe-webgpu', { channel: 'chromium', args: ['--enable-unsafe-webgpu'] }],
  ['chromium, swiftshader adapter', { channel: 'chromium', args: ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader'] }],
  ['chromium, swiftshader + Vulkan', { channel: 'chromium', args: ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader', '--enable-features=Vulkan'] }],
  ['chromium, swiftshader + Vulkan, no surface', { channel: 'chromium', args: ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader', '--enable-features=Vulkan', '--disable-vulkan-surface'] }],
  ['chromium, angle swiftshader + unsafe-swiftshader', { channel: 'chromium', args: ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] }],
  ['chromium, angle vulkan + swiftshader adapter', { channel: 'chromium', args: ['--enable-unsafe-webgpu', '--use-angle=vulkan', '--enable-features=Vulkan', '--disable-vulkan-surface', '--use-webgpu-adapter=swiftshader'] }],
  ...(process.env.DISPLAY ? [
    ['headed, unsafe-webgpu', { channel: 'chromium', headless: false, args: ['--enable-unsafe-webgpu'] }],
    ['headed, swiftshader + Vulkan', { channel: 'chromium', headless: false, args: ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader', '--enable-features=Vulkan'] }],
    ['headed, angle swiftshader', { channel: 'chromium', headless: false, args: ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--use-webgpu-adapter=swiftshader'] }],
    ['headed, angle vulkan, no surface', { channel: 'chromium', headless: false, args: ['--enable-unsafe-webgpu', '--use-angle=vulkan', '--enable-features=Vulkan', '--disable-vulkan-surface', '--use-webgpu-adapter=swiftshader'] }],
  ] : []),
];
console.log('| Flags | Backend | Detail or reason | Blue pixel share | Console errors |');
console.log('| --- | --- | --- | --- | --- |');
for (const [label, opts] of sets) {
  let row;
  try {
    const browser = await chromium.launch(/** @type {any} */ (opts));
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    /** @type {string[]} */
    const errors = [];
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(url);
    await page.waitForFunction(() => /** @type {any} */ (window).powerstudio?.ready === true, null, { timeout: 20000 });
    await page.waitForTimeout(1500);
    const f = await page.evaluate(() => ({ b: /** @type {any} */ (window).powerstudio.backend, d: /** @type {any} */ (window).powerstudio.backendDetail, r: /** @type {any} */ (window).powerstudio.fallbackReason }));
    const img = decodePNG(await page.locator('#viewport').screenshot());
    row = [label, f.b, f.d || f.r || '', share(img, [31, 92, 192]).toFixed(4), errors.length ? errors.join('; ').slice(0, 120) : ''];
    await browser.close();
  } catch (error) {
    row = [label, 'launch failed', String(error).split('\n')[0].slice(0, 120), '', ''];
  }
  console.log(`| ${row.join(' | ')} |`);
}
