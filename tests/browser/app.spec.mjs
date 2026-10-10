/** End-to-end tests of the built app (dist/PowerStudio.html) on an HTTP origin. */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { decodePNG, share } from './png.mjs';
import { cgmesCase } from '../cgmes-files.mjs';

const golden = JSON.parse(readFileSync(new URL('../oracle/golden/matpower-case30.json', import.meta.url), 'utf8'));

/** @param {import('@playwright/test').Page} page @param {string} [query] */
async function open(page, query = 'sample=ieee14') {
  await page.goto(`/PowerStudio.html?${query}`);
  await page.waitForFunction(() => /** @type {any} */ (window).powerstudio?.ready === true);
  await page.locator('.toast').evaluateAll(ts => ts.forEach(t => t.remove()));
}

/** @param {import('@playwright/test').Page} page @param {string} text */
async function palette(page, text) {
  await page.keyboard.press('ControlOrMeta+K');
  await page.locator('.palette input').fill(text);
  await page.keyboard.press('Enter');
}

/** @param {import('@playwright/test').Page} page */
async function loadFlow(page) {
  await page.keyboard.press('Alt+L');
  await expect(page.locator('.dock-toolbar .pill.ok')).toContainText('Converged');
}

// WebGPU is required in the webgpu project unless PS_WEBGPU=optional says the environment cannot provide it (GitHub's
// Ubuntu runners: Chromium's WebGPU instance does not survive there; see docs/TEST-REPORT.md).
const webgpuRequired = process.env.PS_WEBGPU !== 'optional';

test('draws the diagram with the backend it reports, and that backend is the expected one', async ({ page }, info) => {
  await open(page);
  await page.waitForFunction(() => /** @type {any} */ (window).powerstudio.frames > 0);
  // The frame as the active renderer produced it (for WebGPU, read back from the GPU) shows the network:
  // 132 kV busbars are blue and 33 kV ones green in the light theme.
  const url = await page.evaluate(() => /** @type {any} */ (window).powerstudio.snapshot());
  const frame = decodePNG(Buffer.from(url.split(',')[1], 'base64'));
  expect(share(frame, [31, 92, 192])).toBeGreaterThan(0.0008);
  expect(share(frame, [23, 128, 74])).toBeGreaterThan(0.0008);
  // The facts after drawing: a device that failed on the way has been replaced by Canvas 2D by now.
  const facts = await page.evaluate(() => ({ backend: /** @type {any} */ (window).powerstudio.backend, reason: /** @type {any} */ (window).powerstudio.fallbackReason }));
  info.annotations.push({ type: 'backend', description: `${facts.backend}${facts.reason ? ` (${facts.reason})` : ''}` });
  const badge = page.locator('.vp-badge');
  await expect(badge).toHaveAttribute('data-backend', facts.backend);
  await expect(badge).toContainText(facts.backend === 'webgpu' ? 'WebGPU' : 'Canvas 2D');
  if (info.project.name === 'webgpu' && webgpuRequired) {
    expect(facts.backend, `WebGPU was expected in this project; fallback reason: ${facts.reason}`).toBe('webgpu');
  } else if (info.project.name === 'canvas') {
    expect(facts.backend).toBe('canvas2d');
    expect(facts.reason).toContain('WebGPU');
  }
  // And the same picture reached the screen.
  await page.waitForTimeout(100);
  const img = decodePNG(await page.locator('#viewport').screenshot());
  expect(share(img, [31, 92, 192])).toBeGreaterThan(0.0008);
  expect(share(img, [23, 128, 74])).toBeGreaterThan(0.0008);
});

test('runs a load flow from the keyboard and matches MATPOWER case14', async ({ page }) => {
  await open(page);
  await loadFlow(page);
  await expect(page.locator('.dock-toolbar .pill.ok')).toContainText('Converged in 2 iterations');
  const row = page.locator('table.grid tbody tr[data-id="B14"]');
  await expect(row).toContainText('1.0355');
  await expect(row).toContainText('−16.034');
  await expect(page.locator('.dock-toolbar .summary')).toContainText('Losses 13.393 MW');
});

test('edits a value in the inspector, recalculates, and undo and redo restore it', async ({ page }) => {
  await open(page);
  await loadFlow(page);
  await page.locator('.tree-row[data-id="D14"]').click();
  const p = page.locator('#inspector-panel input[data-key="p"]');
  await expect(p).toHaveValue('14.9');
  await p.fill('30');
  await p.press('Enter');
  // Recalculate on edit refreshes the load flow by itself.
  await expect(page.locator('.dock-toolbar .summary')).not.toContainText('Load 259.00 MW');
  await expect(page.locator('.dock-toolbar .summary')).toContainText('Load 274.10 MW');
  await page.locator('#viewport canvas.viewport-canvas').click({ position: { x: 20, y: 20 } });
  await page.keyboard.press('ControlOrMeta+Z');
  await expect(page.locator('.dock-toolbar .summary')).toContainText('Load 259.00 MW');
  await page.keyboard.press('ControlOrMeta+Shift+Z');
  await expect(page.locator('.dock-toolbar .summary')).toContainText('Load 274.10 MW');
});

test('draws a network from scratch with the insert tools and solves it', async ({ page }) => {
  await open(page);
  await palette(page, 'New network');
  await expect(page.locator('#doc-name')).toHaveValue('Untitled network');
  const box = /** @type {{ x: number, y: number, width: number, height: number }} */ (await page.locator('#viewport').boundingBox());
  const c = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const a = { x: c.x - 160, y: c.y }, b = { x: c.x + 160, y: c.y };
  await page.locator('#viewport canvas.viewport-canvas').focus();
  await page.keyboard.press('B');
  await page.mouse.click(a.x, a.y);
  await page.mouse.click(b.x, b.y);
  await page.keyboard.press('L');
  await page.mouse.click(a.x, a.y);
  await page.mouse.click(b.x, b.y);
  await page.keyboard.press('E');
  await page.mouse.click(a.x, a.y - 2);
  await page.keyboard.press('D');
  await page.mouse.click(b.x, b.y + 2);
  await page.keyboard.press('Escape');
  await expect(page.locator('.tree-row[data-cls="bus"] .meta')).toHaveText('2');
  await expect(page.locator('.tree-row[data-cls="line"] .meta')).toHaveText('1');
  await expect(page.locator('.tree-row[data-cls="extgrid"] .meta')).toHaveText('1');
  await expect(page.locator('.tree-row[data-cls="load"] .meta')).toHaveText('1');
  await loadFlow(page);
  await expect(page.locator('.dock-toolbar .summary')).toContainText('Load 2.00 MW');
});

test('copies, pastes, switches out of service, nudges and selects with a marquee', async ({ page }) => {
  await open(page);
  await loadFlow(page);
  const canvas = page.locator('#viewport canvas.viewport-canvas');
  // Marquee over the whole view selects the network.
  const box = /** @type {{ x: number, y: number, width: number, height: number }} */ (await page.locator('#viewport').boundingBox());
  await page.mouse.move(box.x + 4, box.y + 4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
  await page.mouse.move(box.x + box.width - 4, box.y + box.height - 4, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator('#statusbar')).toContainText('51 selected');
  // Copy and paste duplicates the whole network, connections included.
  await page.keyboard.press('ControlOrMeta+C');
  await page.keyboard.press('ControlOrMeta+V');
  await expect(page.locator('.tree-row[data-cls="bus"] .meta')).toHaveText('28');
  await expect(page.locator('.tree-row[data-cls="line"] .meta')).toHaveText('30');
  await page.keyboard.press('ControlOrMeta+Z');
  await expect(page.locator('.tree-row[data-cls="bus"] .meta')).toHaveText('14');
  // Switching Line 1-2 out of service re-solves the network with it open.
  await page.locator('.tree-row[data-id="L1"]').click();
  await canvas.focus();
  await page.keyboard.press('Shift+O');
  await expect(page.locator('.tree-row[data-id="L1"]')).toHaveClass(/off/);
  await expect(page.locator('.dock-toolbar .summary')).not.toContainText('Losses 13.393 MW');
  await page.keyboard.press('Shift+O');
  await expect(page.locator('.tree-row[data-id="L1"]')).not.toHaveClass(/off/);
  await expect(page.locator('.dock-toolbar .summary')).toContainText('Losses 13.393 MW');
  // Arrow keys move the selected busbar on the grid, but not while the model tree has focus.
  await page.locator('.tree-row[data-id="B4"]').click();
  await page.keyboard.press('ArrowDown');
  await canvas.focus();
  await page.locator('#inspector-panel summary', { hasText: 'Diagram' }).click();
  const x = page.locator('#inspector-panel input[data-key="x"]');
  await expect(x).toHaveValue('-280');
  await canvas.focus();
  await page.keyboard.press('ArrowRight');
  await expect(x).toHaveValue('-260');
});

test('arranges the diagram in the worker as one undoable step', async ({ page }) => {
  await open(page);
  await page.locator('.tree-row[data-id="B4"]').click();
  await page.locator('#inspector-panel summary', { hasText: 'Diagram' }).click();
  const x = page.locator('#inspector-panel input[data-key="x"]');
  await expect(x).toHaveValue('-280');
  await palette(page, 'Lay out diagram');
  await expect(page.locator('#app')).toContainText('Laid out the diagram.');
  await expect(x).not.toHaveValue('-280');
  await page.locator('#viewport canvas.viewport-canvas').focus();
  await page.keyboard.press('ControlOrMeta+Z');
  await expect(x).toHaveValue('-280');
});

test('resizes, reroutes and reconnects with the diagram handles', async ({ page }) => {
  await open(page);
  /** @param {number} x @param {number} y */
  const at = (x, y) => page.evaluate(([px, py]) => /** @type {any} */ (window).powerstudio.toPage(px, py), [x, y]);
  /** @param {{ x: number, y: number }} from @param {{ x: number, y: number }} to */
  const drag = async (from, to) => { await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(to.x, to.y, { steps: 6 }); await page.mouse.up(); };
  await page.locator('#viewport canvas.viewport-canvas').focus();
  await page.keyboard.press('F');
  await page.keyboard.press('=');
  await page.keyboard.press('=');
  const diagram = page.locator('#inspector-panel summary', { hasText: 'Diagram' });
  // Bus 4 sits at (-280, 140) with length 240: drag its right end 60 units further.
  await page.locator('.tree-row[data-id="B4"]').click();
  await page.locator('#viewport canvas.viewport-canvas').focus();
  await diagram.click();
  await drag(await at(-160, 140), await at(-100, 140));
  await expect(page.locator('#inspector-panel input[data-key="len"]')).toHaveValue('300');
  await expect(page.locator('#inspector-panel input[data-key="x"]')).toHaveValue('-250');
  // Transformer 4-9 runs down from Bus 4 to y = 240 and across; drag its middle segment down by 40.
  await page.locator('.tree-row[data-id="T2"]').click();
  const bus4 = { x: -250, len: 300 };
  const hvX = bus4.x + 0.4 * bus4.len, lvX = 120 + -0.45 * 280;
  await drag(await at((hvX + lvX) / 2, 240), await at((hvX + lvX) / 2, 280));
  await expect(page.locator('#inspector-panel input[data-key="bend"]')).toHaveValue('40');
  // Drag the LV end of Transformer 4-9 from Bus 9 onto Bus 7: it reconnects.
  await drag(await at(lvX, 340), await at(150, 140));
  await expect(page.locator('#inspector-panel select[data-key="lv"]')).toHaveValue('B7');
  await page.keyboard.press('ControlOrMeta+Z');
  await expect(page.locator('#inspector-panel select[data-key="lv"]')).toHaveValue('B9');
  // Slide Load 4 along Bus 4 by dragging its symbol.
  await page.locator('.tree-row[data-id="D4"]').click();
  const d4x = -250 + 0.1 * 300;
  await drag(await at(d4x, 140 + 44 + 15), await at(d4x + 60, 140 + 44 + 15));
  await expect(page.locator('#inspector-panel input[data-key="pos"]')).toHaveValue('0.3');
});

/** @param {import('@playwright/test').Page} page @returns {Promise<Array<{ owner: string, slot: string, x0: number, y0: number, x1: number, y1: number, defX: number, defY: number }>>} */
const labelsOf = page => page.evaluate(() => /** @type {any} */ (window).powerstudio.labels);

/** Pairs of labels that overlap. @param {Awaited<ReturnType<typeof labelsOf>>} ls */
function overlapping(ls) {
  const out = [];
  for (let i = 0; i < ls.length; i++) for (let j = i + 1; j < ls.length; j++) {
    const a = ls[i], b = ls[j];
    if (a.x0 < b.x1 - 1e-6 && b.x0 < a.x1 - 1e-6 && a.y0 < b.y1 - 1e-6 && b.y0 < a.y1 - 1e-6) out.push(`${a.owner}.${a.slot} × ${b.owner}.${b.slot}`);
  }
  return out;
}

test('places names and result boxes clear of each other in the browser\'s fonts, or in fixed places on request', async ({ page }) => {
  for (const sample of ['ieee14', 'riverside']) {
    await open(page, `sample=${sample}`);
    await loadFlow(page);
    await expect.poll(async () => (await labelsOf(page)).filter(l => l.slot === 'endA').length).toBeGreaterThan(5);
    expect(overlapping(await labelsOf(page))).toEqual([]);
  }
  // Switched off, every label sits in its default place.
  await page.locator('#viewport canvas.viewport-canvas').focus();
  await page.keyboard.press('Shift+L');
  await expect.poll(async () => (await labelsOf(page)).every(l => l.x0 === l.defX && l.y0 === l.defY)).toBe(true);
  await page.keyboard.press('Shift+L');
  await expect.poll(async () => overlapping(await labelsOf(page)).length).toBe(0);
});

test('the widths used where no fonts are (tests, the website) are never narrower than the browser\'s', async ({ page }) => {
  const { conservativeMeasure } = await import('../../src/render/metrics.js');
  const { ieee14 } = await import('../../src/samples/ieee14.js');
  const { riverside } = await import('../../src/samples/riverside.js');
  const names = [...ieee14().elements, ...riverside().elements].map(e => e.name).filter(Boolean);
  const boxes = ['1.020 p.u.  -146.97°', '-152.6 MW', '-17.6 Mvar', 'P 232.4 MW', 'Ik″ 12.34 kA', 'ip  31.20 kA', '100.0 % (Line 1-2)', 'δ 12.3°', 'min 0.950 p.u.'];
  /** @type {Array<{ font: 'sans' | 'mono', weight: 400 | 600, size: number, text: string }>} */
  const cases = [...names.flatMap(text => [{ font: /** @type {const} */ ('sans'), weight: /** @type {const} */ (600), size: 14, text }, { font: /** @type {const} */ ('sans'), weight: /** @type {const} */ (400), size: 12, text }]),
    ...boxes.map(text => ({ font: /** @type {const} */ ('mono'), weight: /** @type {const} */ (400), size: 11, text }))];
  await open(page);
  const measured = await page.evaluate(cases => {
    const fonts = { sans: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif', mono: 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace' };
    const ctx = /** @type {CanvasRenderingContext2D} */ (document.createElement('canvas').getContext('2d'));
    return cases.map(c => { ctx.font = `${c.weight} ${c.size}px ${fonts[c.font]}`; return ctx.measureText(c.text).width; });
  }, cases);
  cases.forEach((c, i) => expect(conservativeMeasure(c.font, c.weight, c.size, c.text), `${c.font} ${c.weight}: ${c.text}`).toBeGreaterThanOrEqual(measured[i]));
});

test('drags a result box to a place of its own, undoes it, and lets the diagram place it again', async ({ page }) => {
  await open(page);
  await loadFlow(page);
  await page.locator('#viewport canvas.viewport-canvas').focus();
  await page.keyboard.press('F');
  // Close enough that result boxes show (their text 6.5 px or more): about 100 %.
  /** @param {number} x @param {number} y */
  const at = (x, y) => page.evaluate(([px, py]) => /** @type {any} */ (window).powerstudio.toPage(px, py), [x, y]);
  // The camera's zoom, read from where two diagram points land (the readout follows a frame later).
  const zoom = async () => ((await at(100, 0)).x - (await at(0, 0)).x) / 100;
  while (await zoom() < 0.9) await page.keyboard.press('=');
  const box = async () => /** @type {NonNullable<Awaited<ReturnType<typeof labelsOf>>[number]>} */ ((await labelsOf(page)).find(l => l.owner === 'B4' && l.slot === 'box'));
  await expect.poll(async () => !!(await box())).toBe(true);
  const before = await box();
  const from = await at((before.x0 + before.x1) / 2, (before.y0 + before.y1) / 2), to = await at((before.x0 + before.x1) / 2 + 60, (before.y0 + before.y1) / 2 + 80);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
  // Pressing the label selected its busbar; the inspector says the label was placed by hand.
  await expect(page.locator('#inspector-panel')).toContainText('1 placed by hand');
  // Moved with the pointer, to within a pixel's rounding at this zoom.
  await expect.poll(async () => Math.abs((await box()).x0 - before.x0 - 60)).toBeLessThanOrEqual(2);
  expect(Math.abs((await box()).y0 - before.y0 - 80)).toBeLessThanOrEqual(2);
  expect(overlapping(await labelsOf(page))).toEqual([]);
  await page.keyboard.press('ControlOrMeta+Z');
  await expect.poll(async () => (await box()).x0).toBe(before.x0);
  await page.keyboard.press('ControlOrMeta+Shift+Z');
  await expect.poll(async () => Math.abs((await box()).x0 - before.x0 - 60)).toBeLessThanOrEqual(2);
  await palette(page, 'Reset label positions');
  await expect.poll(async () => (await box()).x0).toBe(before.x0);
  await expect(page.locator('#inspector-panel')).toContainText('Placed automatically');
});

test('shows every row and label of the ribbon on every tab', async ({ page }) => {
  await open(page);
  for (const tab of ['Home', 'Insert', 'Calculate', 'Arrange', 'View', 'Help']) {
    await page.getByRole('tab', { name: tab, exact: true }).click();
    const panels = await page.evaluate(() => [...document.querySelectorAll('.ribbon-panel')].filter(p => /** @type {HTMLElement} */ (p).offsetParent)
      .map(p => ({ client: p.clientHeight, scroll: p.scrollHeight })));
    for (const p of panels) expect(p.scroll, tab).toBeLessThanOrEqual(p.client);
  }
});

/** Opens the IEEE 14-bus sample zoomed in on the diagram; returns helpers that aim at and drag diagram points.
 * @param {import('@playwright/test').Page} page */
async function onDiagram(page) {
  await open(page);
  await page.locator('#viewport canvas.viewport-canvas').focus();
  await page.keyboard.press('F');
  await page.keyboard.press('=');
  /** @param {number} x @param {number} y */
  const at = (x, y) => page.evaluate(([px, py]) => /** @type {any} */ (window).powerstudio.toPage(px, py), [x, y]);
  /** @param {{ x: number, y: number }} from @param {{ x: number, y: number }} to @param {() => Promise<void>} [midway] */
  const drag = async (from, to, midway) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    if (midway) await midway();
    await page.mouse.up();
  };
  const field = (/** @type {string} */ key) => page.locator(`#inspector-panel input[data-key="${key}"]`);
  const select = async (/** @type {string} */ id) => { await page.locator(`.tree-row[data-id="${id}"]`).click(); await page.locator('#inspector-panel summary', { hasText: 'Diagram' }).click(); };
  return { at, drag, field, select };
}

test('snaps a dragged busbar into line with another, places it freely with Alt, and Escape cancels a drag', async ({ page }) => {
  const { at, drag, field, select } = await onDiagram(page);
  // Bus 3 (centre x −420, length 200) dragged left by 208: its start comes to 2 units of Bus 2's start (x −730) and
  // lines up with it, where the grid alone would have put the centre at −620.
  await select('B3');
  await drag(await at(-400, 360), await at(-608, 360), async () => { await expect(page.locator('.statusbar')).toContainText('Δx −210'); });
  await expect(field('x')).toHaveValue('-630');
  await page.keyboard.press('ControlOrMeta+Z');
  await expect(field('x')).toHaveValue('-420');
  await page.keyboard.down('Alt');
  await drag(await at(-400, 360), await at(-608, 360));
  await page.keyboard.up('Alt');
  // Free: where the pointer let go, to the unit (a pixel covers a little over a unit at this zoom), not snapped.
  await expect.poll(async () => Math.abs(Number(await field('x').inputValue()) + 628)).toBeLessThanOrEqual(2);
  expect(Number(await field('x').inputValue()) % 10).not.toBe(0);
  await page.keyboard.press('ControlOrMeta+Z');
  // Escape during a drag puts the busbar back and leaves nothing to redo.
  await drag(await at(-400, 360), await at(-300, 420), async () => { await page.keyboard.press('Escape'); });
  await expect(field('x')).toHaveValue('-420');
  await expect(field('y')).toHaveValue('360');
});

test('aligns and distributes busbars from the Arrange tab, each as one undoable step', async ({ page }) => {
  const { field, select } = await onDiagram(page);
  // Bus 4 first: the others line up with it.
  await page.locator('.tree-row[data-id="B4"]').click();
  await page.locator('.tree-row[data-id="B2"]').click({ modifiers: ['ControlOrMeta'] });
  await page.locator('.tree-row[data-id="B3"]').click({ modifiers: ['ControlOrMeta'] });
  await page.getByRole('tab', { name: 'Arrange', exact: true }).click();
  await page.locator('[data-cmd="arrange.alignCentre"]').click();
  await select('B2');
  await expect(field('x')).toHaveValue('-280');
  await page.keyboard.press('ControlOrMeta+Z');
  await expect(field('x')).toHaveValue('-600');
  // Bus 5 (y −160), Bus 4 (140) and Bus 3 (360): distributed, Bus 4 sits halfway.
  await page.locator('.tree-row[data-id="B5"]').click();
  await page.locator('.tree-row[data-id="B4"]').click({ modifiers: ['ControlOrMeta'] });
  await page.locator('.tree-row[data-id="B3"]').click({ modifiers: ['ControlOrMeta'] });
  await page.locator('[data-cmd="arrange.distributeV"]').click();
  await select('B4');
  await expect(field('y')).toHaveValue('100');
  // Rotate turns it vertical; the grid step sets how far the arrow keys move it.
  await page.locator('#viewport canvas.viewport-canvas').focus();
  await page.keyboard.press('R');
  await expect(page.locator('#inspector-panel select[data-key="orient"]')).toHaveValue('v');
  await page.getByRole('tab', { name: 'View', exact: true }).click();
  await page.locator('[data-cmd="view.grid40"]').click();
  await page.locator('#viewport canvas.viewport-canvas').focus();
  await page.keyboard.press('ArrowRight');
  await expect(field('x')).toHaveValue('-240');
});

test('selects by window or crossing, and clicking again where elements stack reaches the one beneath', async ({ page }) => {
  const { at, drag } = await onDiagram(page);
  const selected = (/** @type {string} */ id) => page.locator(`.tree-row[data-id="${id}"]`);
  // Bus 4 runs from x −400 to −160 at y 140. Rightwards over its right half: not wholly inside, not selected.
  await drag(await at(-240, 120), await at(-150, 150));
  await expect(selected('B4')).toHaveAttribute('aria-selected', 'false');
  // Leftwards over the same area: it touches the bar, so the bar is selected.
  await drag(await at(-150, 120), await at(-240, 150));
  await expect(selected('B4')).toHaveAttribute('aria-selected', 'true');
  // Load 4's stub leaves Bus 4 at x −256: the first click takes the load, the second the busbar under it.
  const spot = await at(-256, 143);
  await page.mouse.click(spot.x, spot.y);
  await expect(selected('D4')).toHaveAttribute('aria-selected', 'true');
  await page.mouse.click(spot.x, spot.y);
  await expect(selected('B4')).toHaveAttribute('aria-selected', 'true');
  await expect(selected('D4')).toHaveAttribute('aria-selected', 'false');
});

test('shapes a route by dragging a segment, straightens it, and routes a new line around a busbar in its way', async ({ page }) => {
  const { at, drag, select } = await onDiagram(page);
  const routeRow = page.locator('#inspector-panel .field-summary', { hasText: /Automatic|Shaped by hand/ });
  // Transformer 4-9 leaves Bus 4 at x −250 + 0.4 × 240 = −184 and runs down to y 240: drag that first segment right.
  await select('T2');
  await expect(routeRow).toContainText('Automatic');
  await drag(await at(-184, 190), await at(-144, 190));
  await expect(routeRow).toContainText('Shaped by hand');
  await page.keyboard.press('ControlOrMeta+Z');
  await expect(routeRow).toContainText('Automatic');
  await page.keyboard.press('ControlOrMeta+Shift+Z');
  await routeRow.getByRole('button', { name: 'Straighten' }).click();
  await expect(routeRow).toContainText('Automatic');
  // A line from Bus 5 down to Bus 3 would cross Bus 4 on the way: it is drawn around it.
  await page.locator('#viewport canvas.viewport-canvas').focus();
  await page.keyboard.press('L');
  const from = await at(-250, -160), to = await at(-350, 360);
  await page.mouse.click(from.x, from.y);
  await page.mouse.click(to.x, to.y);
  await page.keyboard.press('Escape');
  await page.locator('#inspector-panel summary', { hasText: 'Diagram' }).click();
  await expect(routeRow).toContainText('Shaped by hand');
  // A fresh layout makes every route automatic again, in one step.
  await palette(page, 'Lay out diagram');
  await expect(page.locator('#app')).toContainText('Laid out the diagram.');
  await expect(routeRow).toContainText('Automatic');
});

test('the overview map shows the whole diagram and moves the view; zoom to selection frames the selection', async ({ page }) => {
  const { at } = await onDiagram(page);
  const map = page.locator('.vp-overview');
  // Fourteen busbars fit on screen, so the map starts hidden; M shows it.
  await expect(map).toBeHidden();
  await page.keyboard.press('M');
  await expect(map).toBeVisible();
  // It shows the busbars and routes: the map is not blank.
  const inked = await page.evaluate(() => {
    const c = /** @type {HTMLCanvasElement} */ (document.querySelector('.vp-overview-map')), d = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d')).getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] !== d[0] || d[i + 1] !== d[1] || d[i + 2] !== d[2]) n++;
    return n / (d.length / 4);
  });
  expect(inked).toBeGreaterThan(0.01);
  // Clicking the map's top-left corner moves the view there.
  const point = await at(0, 0), box = /** @type {{ x: number, y: number, width: number, height: number }} */ (await map.boundingBox());
  await page.mouse.click(box.x + 20, box.y + 20);
  await expect.poll(async () => (await at(0, 0)).x).not.toBe(point.x);
  // Zoom to selection fits Bus 8 (100 units long) closer than the whole diagram.
  const zoom = async () => Number((await page.locator('.vp-zoom').textContent())?.replace(/[^0-9]/g, ''));
  const fitted = await zoom();
  await page.locator('.tree-row[data-id="B8"]').click();
  await page.locator('#viewport canvas.viewport-canvas').focus();
  await page.keyboard.press('Shift+F');
  await expect.poll(zoom).toBeGreaterThan(fitted);
  const centre = await at(360, 140), vp = /** @type {{ x: number, y: number, width: number, height: number }} */ (await page.locator('#viewport').boundingBox());
  expect(Math.abs(centre.x - (vp.x + vp.width / 2))).toBeLessThan(vp.width * 0.1);
  await page.keyboard.press('M');
  await expect(map).toBeHidden();
});

test('keeps work in the browser across a reload', async ({ page }) => {
  await open(page, 'sample=riverside');
  const name = page.locator('#doc-name');
  await name.fill('Riverside after reload');
  await name.press('Enter');
  await expect(page.locator('#save-state')).toContainText('Saved');
  await expect(page.locator('#save-state')).toHaveAttribute('title', /Saved in this browser/);
  await page.goto('/PowerStudio.html');
  await page.waitForFunction(() => /** @type {any} */ (window).powerstudio?.ready === true);
  await expect(page.locator('#doc-name')).toHaveValue('Riverside after reload');
  await expect(page.locator('.tree-row[data-cls="bus"] .meta')).toHaveText('9');
});

test('opens a network saved by version 0.1 after upgrading the browser storage', async ({ page }) => {
  // Version 0.1 stored each document whole in one object store; the upgrade adds the list's metadata store.
  const doc = JSON.parse(readFileSync(new URL('../oracle/inputs/ieee14.json', import.meta.url), 'utf8'));
  doc.name = 'Saved by 0.1';
  // A page of the same origin that does not start the app.
  await page.goto('/not-the-app');
  await page.evaluate(doc => new Promise((resolve, reject) => {
    const req = indexedDB.open('powerstudio', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('documents', { keyPath: 'id' }).createIndex('updated', 'updated');
    req.onsuccess = () => {
      const tx = req.result.transaction('documents', 'readwrite');
      tx.objectStore('documents').put({ id: 'doc-v01', name: doc.name, updated: Date.now(), elements: doc.elements.length, doc });
      tx.oncomplete = () => { req.result.close(); resolve(null); };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  }), doc);
  await page.goto('/PowerStudio.html');
  await page.waitForFunction(() => /** @type {any} */ (window).powerstudio?.ready === true);
  await expect(page.locator('#doc-name')).toHaveValue('Saved by 0.1');
  await expect(page.locator('.tree-row[data-cls="bus"] .meta')).toHaveText('14');
  await page.keyboard.press('Alt+L');
  await expect(page.locator('.dock-toolbar .pill.ok')).toContainText('Converged');
  // It is now a project with one study case holding its settings.
  await expect(page.locator('#case-chip')).toContainText('Base case');
});

test('records a planned change in a variant, turns it off and on, logs the run, and keeps it all after a reload', async ({ page }) => {
  await open(page);
  const lineLength = page.locator('table.sheet tbody tr[data-id="L1"] td[data-key="length"]');
  const showLines = async () => {
    await page.locator('.dock-tab[data-tab="data"]').click();
    await page.locator('.sheet-toolbar select').selectOption('line');
  };
  await showLines();
  const original = await lineLength.textContent();
  // A new variant joins the active study case and records changes to the equipment.
  await palette(page, 'Manage project');
  await page.getByRole('button', { name: 'New variant' }).click();
  await page.locator('.backstage nav .back').click();
  await expect(page.locator('#case-chip')).toContainText('Variant 1');
  await lineLength.dblclick();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('99');
  await page.keyboard.press('Enter');
  await expect(lineLength).toHaveText('99');
  // Without the variant the line is as built; with it, as planned.
  await palette(page, 'Manage project');
  await expect(page.locator('.part-row')).toContainText('1 change');
  const variant = page.locator('.case-card.active .case-variant input');
  await variant.uncheck();
  await page.locator('.backstage nav .back').click();
  // A variant out of the case is no longer recorded in.
  await expect(page.locator('#case-chip')).not.toContainText('Variant 1');
  await showLines();
  await expect(lineLength).toHaveText(/** @type {string} */ (original));
  await palette(page, 'Manage project');
  await variant.check();
  await page.locator('.backstage nav .back').click();
  await showLines();
  await expect(lineLength).toHaveText('99');
  // A load flow the user starts goes in the run log with the case and the variant.
  await loadFlow(page);
  await palette(page, 'Manage project');
  await expect(page.locator('table.runs tbody tr').first()).toContainText('Load flow');
  await expect(page.locator('table.runs tbody tr').first()).toContainText('Base case · Variant 1');
  // Everything is stored: the variant, the case's choice of it, and the run.
  await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+S');
  await expect(page.locator('#save-state')).toHaveAttribute('data-state', 'saved');
  // The app reopens the last project (the sample address would open a fresh copy).
  await page.goto('/PowerStudio.html');
  await page.waitForFunction(() => /** @type {any} */ (window).powerstudio?.ready === true);
  await showLines();
  await expect(lineLength).toHaveText('99');
  await palette(page, 'Manage project');
  await expect(variant).toBeChecked();
  await expect(page.locator('table.runs tbody tr')).toHaveCount(1);
  // The project file carries all of it to a new project.
  await page.keyboard.press('Escape');
  const download = page.waitForEvent('download');
  await palette(page, 'Export project');
  const file = await (await download).path();
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+Shift+O');
  await (await chooser).setFiles({ name: 'copy.powerstudio-project.json', mimeType: 'application/json', buffer: readFileSync(file) });
  await expect(page.locator('#app')).toContainText('Imported');
  await showLines();
  await expect(lineLength).toHaveText('99');
  await palette(page, 'Manage project');
  await expect(page.locator('.part-row')).toContainText('1 change');
  await expect(page.locator('table.runs tbody tr')).toHaveCount(1);
});

test('compares a load flow with a recorded run and filters to what changed', async ({ page }) => {
  await open(page);
  await loadFlow(page);
  // A heavier load, then a second load flow the user starts.
  await page.locator('.dock-tab[data-tab="data"]').click();
  await page.locator('.sheet-toolbar select').selectOption('load');
  const p = page.locator('table.sheet tbody tr[data-id="D2"] td[data-key="p"]');
  await p.click();
  await page.keyboard.type('60');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Alt+L');
  await page.locator('.dock-tab[data-tab="loadflow"]').click();
  await page.locator('.dock-toolbar .seg button', { hasText: /^Branches/ }).click();
  const compare = page.locator('select.compare');
  await expect(compare.locator('option')).toHaveCount(3);
  await compare.selectOption({ index: 2 });
  await expect(page.locator('table.grid th[data-key="dloading"]')).toBeVisible();
  const all = await page.locator('table.grid tbody tr[data-id]').count();
  await page.locator('.dock-toolbar .seg button', { hasText: 'Changed' }).click();
  const changed = await page.locator('table.grid tbody tr[data-id]').count();
  expect(changed).toBeGreaterThan(0);
  expect(changed).toBeLessThanOrEqual(all);
  // Filters by loading need no comparison.
  await page.locator('.dock-toolbar .seg button', { hasText: 'Above 100 %' }).click();
  await expect(page.locator('table.grid tbody tr[data-id]')).toHaveCount(0);
});

test('short circuit, contingency and stability run from the palette and the ribbon', async ({ page }) => {
  await open(page);
  await palette(page, 'short circuit');
  await expect(page.locator('.dock-tab[data-tab="shortcircuit"]')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('table.grid tbody tr[data-id="B8"]')).toContainText('27.350');
  await page.locator('.ribbon-tab[data-tab="calculate"]').click();
  await page.locator('.ribbon-panel [data-cmd="calc.contingency"]').click();
  await expect(page.locator('.dock-toolbar .pill.bad')).toContainText('10 contingencies with new violations');
  await page.locator('.ribbon-panel [data-cmd="calc.rms"]').click();
  await expect(page.locator('.dock-toolbar .pill.ok')).toContainText('All machines stay in synchronism');
  await expect(page.locator('.plot canvas')).toBeVisible();
});

test('a machine and its transformer made a power station unit change the short-circuit and breaking currents', async ({ page }) => {
  await open(page, 'sample=riverside');
  await page.keyboard.press('Alt+S');
  const hilltop = page.locator('table.grid tbody tr[data-id="B5"]');
  await expect(hilltop).toContainText('3.920');
  await expect(page.locator('table.grid thead th[data-key="ib"]')).toHaveAttribute('title', 'Breaking current at 0.10 s');
  await page.locator('.tree-row[data-id="G1"]').click();
  // Only transformers with an end at the machine's busbar are offered.
  const unit = page.locator('#inspector-panel select[data-key="unitTrafo"]');
  await expect(unit.locator('option')).toHaveText(['None', 'CHP unit transformer']);
  await unit.selectOption('T3');
  await page.locator('#viewport canvas.viewport-canvas').click({ position: { x: 20, y: 20 } });
  await page.keyboard.press('Alt+S');
  await expect(hilltop).toContainText('3.912');
  await expect(hilltop.locator('td').nth(4)).toHaveText('3.651');
});

test('defines a two-line contingency and a remedial action, and the analysis reports both', async ({ page }) => {
  await open(page);
  await palette(page, 'Contingencies');
  const dlg = page.locator('.dialog');
  await expect(dlg.locator('h2')).toHaveText('Contingencies and remedial actions');
  await dlg.getByRole('button', { name: 'Add contingency' }).click();
  const add = dlg.getByLabel('Add an element to this contingency');
  for (const id of ['L1', 'L2']) { await add.fill(id); await add.press('Tab'); }
  await expect(dlg.locator('.cont-table .chip')).toHaveText(['Line 1-2', 'Line 1-5']);
  await dlg.getByLabel('Contingency name').fill('Both lines from bus 1');
  await dlg.getByRole('button', { name: 'Add remedial action' }).click();
  const rule = dlg.locator('.rule');
  await rule.getByLabel('Remedial action name').fill('Shed load at bus 3');
  const outage = rule.getByLabel('Add the outage of an element');
  await outage.fill('L1');
  await outage.press('Tab');
  await expect(rule.locator('.chip')).toHaveText(['Outage of Line 1-2']);
  await rule.getByLabel('Condition branch').fill('Line 1-5');
  await rule.getByLabel('Condition branch').press('Tab');
  await expect(rule.getByLabel('Condition branch')).toHaveValue('Line 1-5');
  await rule.getByLabel('Action', { exact: true }).selectOption('loadShed');
  await rule.getByLabel('Action element').fill('D3');
  await rule.getByLabel('Action element').press('Tab');
  await rule.getByLabel('Share shed').fill('80');
  await rule.getByLabel('Share shed').press('Tab');
  await dlg.getByRole('button', { name: 'Apply' }).click();
  await expect(dlg).toHaveCount(0);
  await page.keyboard.press('Alt+N');
  await expect(page.locator('.dock-toolbar .summary')).toContainText('Contingencies 21');
  await expect(page.locator('.dock-toolbar .summary')).toContainText('Remedial actions on 1');
  await expect(page.locator('table.grid tbody tr[data-id="C1"]')).toContainText('Both lines from bus 1');
  await expect(page.locator('table.grid tbody tr[data-id="C1"]')).toContainText('2 elements');
  await expect(page.locator('table.grid tbody tr[data-id="L1"]')).toContainText('after action');
  await expect(page.locator('table.grid tbody tr[data-id="L1"]')).toContainText('Shed load at bus 3');
  // Undo takes the definitions back out of the study case.
  await page.keyboard.press('ControlOrMeta+Z');
  await palette(page, 'Contingencies');
  await expect(dlg.locator('.cont-empty')).toHaveText(['No contingencies of your own yet.', 'No remedial actions yet.']);
});

/** The data sheet's load table, with its P and Q cells. @param {import('@playwright/test').Page} page */
async function loadSheet(page) {
  await open(page);
  await page.locator('.dock-tab[data-tab="data"]').click();
  await page.locator('.sheet-toolbar select').selectOption('load');
  return {
    p: page.locator('table.sheet tbody tr[data-id] td[data-key="p"]'),
    q: page.locator('table.sheet tbody tr[data-id] td[data-key="q"]'),
  };
}

test('edits loads in the data sheet: several rows at once, and undo', async ({ page }) => {
  const { p } = await loadSheet(page);
  const before = await p.allTextContents();
  // Three rows selected with Shift and arrows, then typing edits all three.
  await p.nth(0).click();
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.type('4');
  await page.keyboard.press('Enter');
  await expect(p.nth(2)).toHaveText('4');
  expect((await p.allTextContents()).slice(0, 4)).toEqual(['4', '4', '4', before[3]]);
  // The edit is one undo step.
  await page.keyboard.press('ControlOrMeta+Z');
  await expect(p.nth(0)).toHaveText(before[0]);
});

test('pastes a block into the data sheet, refuses a block with text, and undoes the paste', async ({ page, browserName }) => {
  // Firefox removes the data from a paste event a page makes itself, as a security rule; a paste by the user carries
  // it. The test can only make its own events, so it runs where those carry data.
  test.skip(browserName === 'firefox', 'Firefox drops clipboardData from synthetic paste events');
  const { p, q } = await loadSheet(page);
  const before = await p.allTextContents();
  // A block pasted from a spreadsheet fills from the active cell.
  await p.nth(1).click();
  const paste = (/** @type {string} */ text) => page.evaluate(t => {
    const data = new DataTransfer();
    data.setData('text/plain', t);
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
  }, text);
  await paste('7\t3\n8\t2\n');
  await expect(q.nth(2)).toHaveText('2');
  expect(await p.nth(1).textContent()).toBe('7');
  // A block with a value that is not a number changes nothing.
  await paste('5\nabc\n');
  await expect(page.locator('.toast').filter({ hasText: 'Nothing was pasted' })).toBeVisible();
  expect(await p.nth(1).textContent()).toBe('7');
  // The paste is one undo step.
  await page.keyboard.press('ControlOrMeta+Z');
  await expect(p.nth(1)).toHaveText(before[1]);
});

test('imports a MATPOWER case and solves it to the MATPOWER solution', async ({ page }) => {
  await open(page);
  await page.locator('.ribbon-tab[data-tab="file"]').click();
  await page.locator('.backstage nav [data-page="import"]').click();
  const chooser = page.waitForEvent('filechooser');
  await page.locator('.backstage .card', { hasText: 'MATPOWER case' }).click();
  await (await chooser).setFiles('tests/fixtures/case30.m');
  await expect(page.locator('.dialog .import-status .pill')).toHaveText('Exact');
  await page.locator('.dialog .btn.primary', { hasText: 'Open network' }).click();
  await expect(page.locator('#doc-name')).toHaveValue('case30');
  await expect(page.locator('.tree-row[data-cls="bus"] .meta')).toHaveText('30');
  await loadFlow(page);
  const k = golden.bus.indexOf(30);
  await expect(page.locator('table.grid tbody tr[data-id="B30"]')).toContainText(golden.vm[k].toFixed(4));
});

test('imports a PSS/E RAW file, shows what it read, and solves it to the MATPOWER solution', async ({ page }) => {
  const case14 = JSON.parse(readFileSync(new URL('../oracle/golden/matpower-case14.json', import.meta.url), 'utf8'));
  await open(page);
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+Shift+O');
  await (await chooser).setFiles('tests/fixtures/case14.raw');
  const dialog = page.locator('.dialog');
  await expect(dialog.locator('h2')).toHaveText('Import case14.raw');
  await expect(dialog.locator('.import-lead')).toContainText('PSS/E RAW version 33 · 14 nodes · 20 branches');
  await expect(dialog.locator('.import-status .pill')).toHaveText('Exact');
  await dialog.locator('summary', { hasText: 'What was read' }).click();
  await expect(dialog.locator('.import-classes')).toContainText('BUS DATA');
  await dialog.locator('.btn.primary', { hasText: 'Open network' }).click();
  await expect(page.locator('#doc-name')).toHaveValue('case14');
  await loadFlow(page);
  const k = case14.bus.indexOf(14);
  await expect(page.locator('table.grid tbody tr[data-id="B14"]')).toContainText(case14.vm[k].toFixed(4));
});

test('imports a CGMES model, edits its operating point and exports it as SSH and SV', async ({ page }) => {
  const files = cgmesCase('microgrid-be-2');
  test.skip(!files, 'the CGMES conformity archive is not in .cache/reference');
  await open(page);
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+Shift+O');
  await (await chooser).setFiles(/** @type {Array<{ name: string, bytes: Uint8Array }>} */ (files).map(f => ({ name: f.name.split('/').pop() ?? f.name, mimeType: 'application/zip', buffer: Buffer.from(f.bytes) })));
  await page.locator('.dialog .btn.primary').click();
  await expect(page.locator('#app')).toContainText('Imported');
  await page.locator('.dock-tab[data-tab="data"]').click();
  await page.locator('.sheet-toolbar select').selectOption('load');
  const p = page.locator('table.sheet tbody tr[data-id] td[data-key="p"]').first();
  await p.click();
  await page.keyboard.type('12');
  await page.keyboard.press('Enter');
  await expect(p).toHaveText('12');
  const download = page.waitForEvent('download');
  await palette(page, 'Export CGMES');
  const zip = readFileSync(/** @type {string} */ (await (await download).path()));
  expect(zip.readUInt32LE(0)).toBe(0x04034b50);
  const names = zip.toString('latin1').match(/[\w.-]+_PowerStudio\.xml/g) ?? [];
  expect(names.some(n => n.includes('SSH'))).toBe(true);
  expect(names.some(n => n.includes('SV'))).toBe(true);
  await expect(page.locator('.dock-tab[data-tab="output"]')).toBeVisible();
  await page.locator('.dock-tab[data-tab="output"]').click();
  await expect(page.locator('.log')).toContainText('1 changed value in SSH');
});

/** ANDES's published IEEE 14-bus RAW and DYR files from `.cache/reference`, or null when they have not been fetched. */
function ieee14Dynamic() {
  const cases = JSON.parse(readFileSync(new URL('../oracle/dyn-cases.json', import.meta.url), 'utf8'));
  const c = cases.cases.find((/** @type {any} */ x) => x.name === 'ieee14');
  try {
    return ['raw', 'dyr'].map(k => ({ name: `ieee14.${k}`, mimeType: 'text/plain', buffer: readFileSync(new URL(`../../.cache/reference/${c[k]}`, import.meta.url)) }));
  } catch {
    return null;
  }
}

for (const width of [1440, 390]) {
  test(`opens RAW and DYR files, edits a machine's exciter and simulates it (${width} px)`, async ({ page }) => {
    const files = ieee14Dynamic();
    test.skip(!files, 'ANDES\u2019s IEEE 14-bus files are not in .cache/reference');
    await page.setViewportSize({ width, height: width > 600 ? 900 : 844 });
    await open(page);
    const chooser = page.waitForEvent('filechooser');
    await page.keyboard.press('ControlOrMeta+Shift+O');
    await (await chooser).setFiles(/** @type {any} */ (files));
    await page.locator('.dialog .btn.primary', { hasText: 'Open network' }).click();
    await expect(page.locator('#app')).toContainText('Imported');
    await page.locator('.toast').evaluateAll(ts => ts.forEach(t => t.remove()));
    if (width < 600) await page.locator('[data-cmd="view.sheetLeft"]').click();
    await page.locator('.tree-row', { hasText: 'B3-G1' }).click().catch(async () => {
      // The machines' group starts closed on a large tree: open it first.
      await page.locator('.tree-row[data-cls="gen"]').click();
      await page.locator('.tree-row', { hasText: 'B3-G1' }).click();
    });
    if (width < 600) await page.locator('[data-cmd="view.sheetRight"]').click();
    const exciter = page.locator('#inspector-panel select[data-key="exciter"]');
    await expect(exciter).toHaveValue('ESST3A');
    await expect(page.locator('#inspector-panel select[data-key="stabiliser"]')).toHaveValue('IEEEST');
    await page.locator('#inspector-panel .control-params summary', { hasText: 'ESST3A' }).click();
    const km = page.locator('#inspector-panel input[data-key="exciter.KM"]');
    await km.fill('9');
    await km.press('Enter');
    await expect(page.locator('#inspector-panel input[data-key="exciter.KM"]')).toHaveValue('9');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.keyboard.press('Alt+R');
    await expect(page.locator('.dock-toolbar .pill.ok')).toContainText('synchronism');
    await page.locator('.rms-quantity').selectOption('efd');
    await expect(page.locator('.plot-side')).toContainText('B3-G1');
  });
}

test('prints a study report with the run records and each result', async ({ page }) => {
  await open(page);
  await loadFlow(page);
  await page.keyboard.press('Alt+N');
  await expect(page.locator('.dock-tab[data-tab="contingency"]')).toHaveAttribute('aria-selected', 'true');
  await page.evaluate(() => { /** @type {any} */ (window).print = () => { /** @type {any} */ (window).printed = document.getElementById('print-root')?.textContent; }; });
  await palette(page, 'Print study report');
  await page.waitForFunction(() => typeof (/** @type {any} */ (window).printed) === 'string');
  const text = await page.evaluate(() => /** @type {any} */ (window).printed);
  for (const part of ['Study report', 'Run records', 'Load flow', 'Contingency analysis', 'Settings', 'Diagram']) expect(text).toContain(part);
  expect(text).toContain('Converged in 2');
  await expect(page.locator('#print-root .report-table td.num').first()).toBeAttached();
});

test('exports a PowerStudio file that imports again unchanged', async ({ page }) => {
  await open(page, 'sample=riverside');
  const download = page.waitForEvent('download');
  await page.keyboard.press('ControlOrMeta+Shift+S');
  const file = await (await download).path();
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  expect(doc.format).toBe('powerstudio');
  expect(doc.elements).toHaveLength(28);
  const chooser = page.waitForEvent('filechooser');
  await palette(page, 'Import file');
  await (await chooser).setFiles(file);
  await expect(page.locator('#doc-name')).toHaveValue('Riverside distribution');
  await expect(page.locator('.log')).toContainText('with 28 elements');
});

test('exports an encrypted project that opens only with its passphrase', async ({ page }) => {
  await open(page, 'sample=riverside');
  await palette(page, 'Export encrypted project');
  const dlg = page.locator('.dialog');
  await dlg.getByLabel('Passphrase', { exact: true }).fill('short');
  await dlg.getByLabel('Type it again').fill('short');
  await dlg.getByRole('button', { name: 'Encrypt and export' }).click();
  await expect(dlg.locator('.field-error')).toContainText('at least 12 characters');
  await dlg.getByLabel('Passphrase', { exact: true }).fill('river cable ring CHP');
  await dlg.getByLabel('Type it again').fill('river cable ring CHP');
  const download = page.waitForEvent('download');
  await dlg.getByRole('button', { name: 'Encrypt and export' }).click();
  const file = await (await download).path();
  const text = readFileSync(file, 'utf8');
  expect(JSON.parse(text).format).toBe('powerstudio-encrypted');
  expect(text).not.toContain('Riverside');
  // Opening it asks for the passphrase, refuses a wrong one, and opens the project with the right one.
  const chooser = page.waitForEvent('filechooser');
  await palette(page, 'Import file');
  await (await chooser).setFiles(file);
  await dlg.getByLabel('Passphrase', { exact: true }).fill('river cable ring');
  await dlg.getByRole('button', { name: 'Open' }).click();
  await expect(dlg.locator('.lead')).toContainText('The passphrase is not right');
  await dlg.getByLabel('Passphrase', { exact: true }).fill('river cable ring CHP');
  await page.keyboard.press('Enter');
  await expect(page.locator('#doc-name')).toHaveValue('Riverside distribution');
  await expect(page.locator('.log')).toContainText('with 28 elements');
});

test('switches theme and redraws the diagram in the dark palette', async ({ page }) => {
  await open(page);
  await page.locator('#viewport canvas.viewport-canvas').focus();
  await page.keyboard.press('Shift+T');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.waitForTimeout(200);
  const img = decodePNG(await page.locator('#viewport').screenshot());
  expect(share(img, [16, 21, 27], 12)).toBeGreaterThan(0.5); // --dg-bg in the dark theme
});

test('can be told to draw with Canvas 2D', async ({ page }) => {
  await open(page);
  await palette(page, 'Canvas 2D only');
  await expect(page.locator('.vp-badge')).toHaveAttribute('data-backend', 'canvas2d');
  const img = decodePNG(await page.locator('#viewport').screenshot());
  expect(share(img, [31, 92, 192])).toBeGreaterThan(0.0008);
});

test('makes no network requests beyond loading the page, and forbids them by policy', async ({ page }) => {
  /** @type {string[]} */
  const urls = [];
  page.on('request', r => urls.push(r.url()));
  await open(page);
  await loadFlow(page);
  await page.keyboard.press('Alt+N');
  await expect(page.locator('.dock-tab[data-tab="contingency"]')).toHaveAttribute('aria-selected', 'true');
  const external = urls.filter(u => !u.startsWith('http://127.0.0.1:8771/PowerStudio.html') && !u.startsWith('blob:') && !u.startsWith('data:'));
  expect(external).toEqual([]);
  await expect(page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute('content', /connect-src 'none'/);
});

test('writes HTML only through its own Trusted Types policy, where the browser enforces them', async ({ page, browserName }) => {
  /** @type {string[]} */
  const violations = [];
  page.on('console', m => { if (/Trusted Type|trusted-types/i.test(m.text())) violations.push(m.text()); });
  await open(page);
  await loadFlow(page);
  await page.keyboard.press('Alt+S');
  await expect(page.locator('.dock-tab[data-tab="shortcircuit"]')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute('content', /require-trusted-types-for 'script'; trusted-types powerstudio powerstudio-worker/);
  // The app itself broke no rule on the way.
  expect(violations).toEqual([]);
  const enforced = await page.evaluate(() => 'trustedTypes' in window);
  test.skip(!enforced, `${browserName} has no Trusted Types; the policy is in place for when it does`);
  // Raw HTML is refused, and no further policy can be made.
  const refused = await page.evaluate(() => {
    const out = { html: false, policy: false };
    try { document.createElement('div').innerHTML = '<b>raw</b>'; } catch { out.html = true; }
    try { /** @type {any} */ (window).trustedTypes.createPolicy('another', { createHTML: (/** @type {string} */ s) => s }); } catch { out.policy = true; }
    return out;
  });
  expect(refused).toEqual({ html: true, policy: true });
});

test('fits a phone screen without sideways scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.locator('[data-cmd="view.sheetLeft"]').click();
  await expect(page.locator('#tree-panel')).toBeVisible();
  await page.locator('.tree-row[data-id="B4"]').click();
  await page.locator('[data-cmd="view.sheetRight"]').click();
  await expect(page.locator('#inspector-panel .insp-head .name')).toHaveText('Bus 4');
});
