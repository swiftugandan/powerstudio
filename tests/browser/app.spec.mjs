/** End-to-end tests of the built app (dist/PowerStudio.html) on an HTTP origin. */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { decodePNG, share } from './png.mjs';

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
  await page.locator('#viewport canvas').click({ position: { x: 20, y: 20 } });
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
  await page.locator('#viewport canvas').focus();
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
  const canvas = page.locator('#viewport canvas');
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
  await palette(page, 'Arrange');
  await expect(page.locator('#app')).toContainText('Arranged the diagram.');
  await expect(x).not.toHaveValue('-280');
  await page.locator('#viewport canvas').focus();
  await page.keyboard.press('ControlOrMeta+Z');
  await expect(x).toHaveValue('-280');
});

test('resizes, reroutes and reconnects with the diagram handles', async ({ page }) => {
  await open(page);
  /** @param {number} x @param {number} y */
  const at = (x, y) => page.evaluate(([px, py]) => /** @type {any} */ (window).powerstudio.toPage(px, py), [x, y]);
  /** @param {{ x: number, y: number }} from @param {{ x: number, y: number }} to */
  const drag = async (from, to) => { await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(to.x, to.y, { steps: 6 }); await page.mouse.up(); };
  await page.locator('#viewport canvas').focus();
  await page.keyboard.press('F');
  await page.keyboard.press('=');
  await page.keyboard.press('=');
  const diagram = page.locator('#inspector-panel summary', { hasText: 'Diagram' });
  // Bus 4 sits at (-280, 140) with length 240: drag its right end 60 units further.
  await page.locator('.tree-row[data-id="B4"]').click();
  await page.locator('#viewport canvas').focus();
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

test('edits loads in the data sheet: several rows at once, a pasted block, a refused paste, and undo', async ({ page }) => {
  await open(page);
  await page.locator('.dock-tab[data-tab="data"]').click();
  await page.locator('.sheet-toolbar select').selectOption('load');
  const p = page.locator('table.sheet tbody tr[data-id] td[data-key="p"]');
  const q = page.locator('table.sheet tbody tr[data-id] td[data-key="q"]');
  const before = await p.allTextContents();
  // Three rows selected with Shift and arrows, then typing edits all three.
  await p.nth(0).click();
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.type('4');
  await page.keyboard.press('Enter');
  await expect(p.nth(2)).toHaveText('4');
  expect((await p.allTextContents()).slice(0, 4)).toEqual(['4', '4', '4', before[3]]);
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
  // Each edit is one undo step.
  await page.keyboard.press('ControlOrMeta+Z');
  await expect(p.nth(1)).toHaveText('4');
  await page.keyboard.press('ControlOrMeta+Z');
  await expect(p.nth(0)).toHaveText(before[0]);
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

test('switches theme and redraws the diagram in the dark palette', async ({ page }) => {
  await open(page);
  await page.locator('#viewport canvas').focus();
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
