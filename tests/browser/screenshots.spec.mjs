/** Captures the documentation screenshots from the running built app. Runs only when PS_SCREENSHOTS=1 and only in
 * the webgpu project, so every capture states the backend it was drawn with:
 *
 *   PS_SCREENSHOTS=1 npx playwright test screenshots --project=webgpu
 */
import { test, expect } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';

const DIR = 'docs/screenshots';
const enabled = process.env.PS_SCREENSHOTS === '1';
/** @type {Record<string, string>} */
const manifest = {};

test.describe.configure({ mode: 'serial' });
test.skip(!enabled, 'Screenshots are captured on request: PS_SCREENSHOTS=1.');
test.beforeEach(({}, info) => { test.skip(info.project.name !== 'webgpu', 'Screenshots come from the webgpu project.'); });
test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

/** @param {import('@playwright/test').Page} page @param {string} query @param {'light' | 'dark'} [scheme] */
async function open(page, query, scheme = 'light') {
  await page.emulateMedia({ colorScheme: scheme });
  await page.goto(`/PowerStudio.html?${query}`);
  await page.waitForFunction(() => /** @type {any} */ (window).powerstudio?.ready === true);
  await page.locator('.toast').evaluateAll(ts => ts.forEach(t => t.remove()));
}

/** @param {import('@playwright/test').Page} page @param {string} name @param {string} caption */
async function shot(page, name, caption) {
  // A shortcut the capture pressed leaves the diagram with its keyboard focus ring; the pictures show the app at rest.
  await page.evaluate(() => { if (document.activeElement?.classList.contains('viewport-canvas')) /** @type {HTMLElement} */ (document.activeElement).blur(); });
  await page.waitForTimeout(300);
  mkdirSync(DIR, { recursive: true });
  await page.screenshot({ path: `${DIR}/${name}.png` });
  const backend = await page.evaluate(() => `${/** @type {any} */ (window).powerstudio.backend} ${/** @type {any} */ (window).powerstudio.backendDetail}`.trim());
  manifest[name] = `${caption} Drawn with ${backend}.`;
}

/** Zooms around the centre of the viewport. @param {import('@playwright/test').Page} page @param {number} steps */
async function zoom(page, steps) {
  await page.locator('#viewport canvas.viewport-canvas').focus();
  await page.keyboard.press('F');
  for (let i = 0; i < steps; i++) await page.keyboard.press('=');
}

test('load flow on the IEEE 14-bus system', async ({ page }) => {
  await open(page, 'sample=ieee14');
  await page.keyboard.press('Alt+L');
  await expect(page.locator('.dock-toolbar .pill.ok')).toBeVisible();
  await page.locator('.tree-row[data-id="B4"]').click();
  await zoom(page, 2);
  await shot(page, '01-load-flow', 'IEEE 14-bus system after a load flow: loading colours, result boxes, busbar table and the selected busbar in the inspector.');
});

test('short circuit on the Riverside network, dark theme', async ({ page }) => {
  await open(page, 'sample=riverside', 'dark');
  await page.keyboard.press('Alt+S');
  await expect(page.locator('.dock-tab[data-tab="shortcircuit"]')).toHaveAttribute('aria-selected', 'true');
  await page.locator('.dock .seg button', { hasText: 'Contributions' }).click();
  await zoom(page, 2);
  await shot(page, '02-short-circuit-dark', 'Three-phase fault at Hilltop on the Riverside network in the dark theme, with the branch contributions.');
});

test('N-1 contingency analysis', async ({ page }) => {
  await open(page, 'sample=ieee14');
  await page.keyboard.press('Alt+N');
  await expect(page.locator('.dock-toolbar .pill.bad')).toBeVisible();
  await page.locator('table.grid tbody tr[data-id="L1"]').click();
  await zoom(page, 1);
  await shot(page, '03-contingency', 'N-1 analysis of the IEEE 14-bus system: worst post-outage loading on each branch and the ranked outage table.');
});

test('stability simulation', async ({ page }) => {
  await open(page, 'sample=ieee14');
  await page.keyboard.press('Alt+R');
  await expect(page.locator('.plot canvas')).toBeVisible();
  await page.locator('.splitter-h').focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowUp');
  await page.waitForTimeout(200);
  await shot(page, '04-stability', 'Classical-model stability simulation: a fault at Bus 4 cleared by tripping Line 4-5, rotor angles against the centre of inertia.');
});

test('command palette and study case', async ({ page }) => {
  await open(page, 'sample=ieee14');
  await page.keyboard.press('ControlOrMeta+K');
  await page.locator('.palette input').fill('fault');
  await shot(page, '05-command-palette', 'The command palette searches every command and every element.');
  await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+,');
  await expect(page.locator('.dialog')).toBeVisible();
  await shot(page, '06-study-case', 'The study case: settings of every calculation and the simulation event list.');
});

test('drawing a network with the insert tools', async ({ page }) => {
  await open(page, 'sample=riverside');
  await page.locator('.ribbon-tab[data-tab="insert"]').click();
  await page.locator('.tree-row[data-id="T3"]').click();
  await zoom(page, 3);
  await shot(page, '07-editing', 'Editing: the Insert tab, a selected transformer with its route handle, and its data in the inspector.');
});

test('Canvas 2D fallback', async ({ page }) => {
  await open(page, 'sample=ieee14&renderer=canvas');
  await page.keyboard.press('Alt+L');
  await expect(page.locator('.vp-badge')).toHaveAttribute('data-backend', 'canvas2d');
  await zoom(page, 2);
  await shot(page, '08-canvas-fallback', 'The same view drawn by the Canvas 2D fallback, forced with ?renderer=canvas.');
});

test('phone layout', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, 'sample=ieee14');
  await page.keyboard.press('Alt+L');
  await shot(page, '09-phone', 'Phone layout: panels open as sheets over the diagram.');
});

test.afterAll(() => {
  if (!enabled) return;
  writeFileSync(`${DIR}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
});
