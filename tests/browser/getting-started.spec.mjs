/** Follows docs/GETTING-STARTED.md step by step on the IEEE 14-bus sample, using the names the guide uses, so the
 * guide and the app cannot drift apart unnoticed. A failure here means the guide needs the same change as the app. */
import { test, expect } from '@playwright/test';

/** @param {import('@playwright/test').Page} page @param {string} text */
async function palette(page, text) {
  await page.keyboard.press('ControlOrMeta+K');
  await page.locator('.palette input').fill(text);
  await page.keyboard.press('Enter');
}

/** @param {import('@playwright/test').Page} page @param {string} name */
async function switchCase(page, name) {
  await page.locator('#case-chip').click();
  await page.getByRole('menuitem', { name }).click();
  await expect(page.locator('#case-chip')).toContainText(name);
}

test('the getting-started guide can be followed from start to finish', async ({ page }) => {
  await page.goto('/PowerStudio.html?sample=ieee14');
  await page.waitForFunction(() => /** @type {any} */ (window).powerstudio?.ready === true);
  await page.locator('.toast').evaluateAll(ts => ts.forEach(t => t.remove()));
  const ribbon = (/** @type {string} */ tab) => page.locator(`.ribbon-tab[data-tab="${tab}"]`).click();
  const pill = page.locator('.dock-toolbar .pill');

  // 1. Open the sample: the Help tab offers the guide and the sample.
  await ribbon('help');
  await expect(page.locator('.ribbon-panel [data-cmd="help.start"]')).toContainText('Getting started');
  await page.locator('.ribbon-panel [data-cmd="sample.ieee14"]').click();
  await expect(page.locator('#case-chip')).toContainText('Base case');

  // 2. Run a load flow.
  await ribbon('home');
  await page.locator('.ribbon-panel [data-cmd="calc.loadflow"]').click();
  await expect(pill).toContainText('Converged in 2 iterations');
  for (const view of ['Busbars', 'Branches', 'Machines and loads']) await expect(page.locator('.dock-toolbar .seg button', { hasText: view })).toBeVisible();
  for (const filter of ['Near limits', 'Outside band']) await expect(page.locator('.dock-toolbar .seg button', { hasText: filter })).toBeVisible();
  await page.locator('.dock-toolbar .seg button', { hasText: /^Branches/ }).click();
  for (const filter of ['Above 90 %', 'Above 100 %']) await expect(page.locator('.dock-toolbar .seg button', { hasText: filter })).toBeVisible();

  // 3. Change element data: Load 3 on Bus 3, found by name.
  await palette(page, 'Load 3');
  const p = page.locator('#inspector-panel input[data-key="p"]');
  await expect(p).toHaveValue('94.2');
  await expect(page.locator(`#inspector-panel label[for="${await p.getAttribute('id')}"]`)).toHaveText('Active power');
  const load = page.locator('.dock-toolbar .summary');
  await expect(load).toContainText('Load 259.00 MW');
  await p.fill('120');
  await p.press('Enter');
  await expect(load).toContainText('Load 284.80 MW');
  await page.locator('#viewport canvas.viewport-canvas').click({ position: { x: 20, y: 20 } });
  await page.keyboard.press('ControlOrMeta+Z');
  await expect(load).toContainText('Load 259.00 MW');
  await expect(page.locator('.dock-tab[data-tab="data"]')).toContainText('Data');

  // 4. Winter and summer study cases.
  await page.locator('#case-chip').click();
  await page.getByRole('menuitem', { name: 'Manage project…' }).click();
  const backstage = page.locator('.backstage');
  await backstage.getByLabel('Name of study case Base case').fill('Winter peak');
  await backstage.getByLabel('Name of study case Base case').press('Enter');
  await backstage.getByRole('button', { name: 'New scenario' }).click();
  await backstage.getByLabel('Name of Scenario 1').fill('Summer minimum');
  await backstage.getByLabel('Name of Scenario 1').press('Enter');
  await backstage.getByRole('button', { name: 'New study case' }).click();
  const summer = backstage.locator('.case-card').nth(1);
  await expect(summer.locator('input.name-field')).toHaveValue('Study case 2');
  await summer.locator('input.name-field').fill('Summer minimum');
  await summer.locator('input.name-field').press('Enter');
  await backstage.getByLabel('Scenario of Summer minimum').selectOption({ label: 'Summer minimum' });
  await backstage.getByLabel('Make Summer minimum the active study case').check();
  await backstage.getByRole('button', { name: 'Back to diagram' }).click();
  await expect(page.locator('#case-chip')).toContainText('Summer minimum');
  await page.keyboard.press('ControlOrMeta+,');
  const dialog = page.locator('.dialog');
  await dialog.locator('#study-loadflow').scrollIntoViewIfNeeded();
  await dialog.getByLabel('Load scaling').fill('60');
  await dialog.getByLabel('Load scaling').press('Tab');
  await dialog.getByRole('button', { name: 'Apply' }).click();
  await palette(page, 'Generator 2');
  await page.keyboard.press('Shift+O');
  await page.keyboard.press('Alt+L');
  await expect(pill).toContainText('Converged');
  await expect(load).toContainText('Load 155.40 MW');
  // Light load lifts the 33 kV voltages above their band.
  await page.locator('.dock-toolbar .seg button', { hasText: /^Busbars/ }).click();
  await page.locator('.dock-toolbar .seg button', { hasText: 'Outside band' }).click();
  expect(await page.locator('table.grid tbody tr[data-id]').count()).toBeGreaterThan(1);
  await page.locator('.dock-toolbar .seg button', { hasText: 'All' }).click();
  // Winter peak still has all its load and every generator.
  await switchCase(page, 'Winter peak');
  await page.keyboard.press('Alt+L');
  await expect(load).toContainText('Load 259.00 MW');
  await expect(page.locator('.tree-row[data-id="G2"]')).not.toHaveClass(/out/);

  // 5. Short circuit: three-phase, maximum, every busbar; then at Bus 4 alone.
  await ribbon('calculate');
  await expect(page.locator('.ribbon-panel [data-cmd="calc.autoLoadFlow"]')).toContainText('Recalculate on edit');
  await expect(page.locator('.ribbon-panel [data-cmd="calc.autoLoadFlow"]')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('.ribbon-panel [data-cmd="sc.fault3ph"]').click();
  await page.locator('.ribbon-panel [data-cmd="sc.max"]').click();
  await page.locator('.ribbon-panel [data-cmd="calc.shortcircuit"]').click();
  await expect(page.locator('.dock-tab[data-tab="shortcircuit"]')).toHaveAttribute('aria-selected', 'true');
  for (const key of ['ikss', 'ip', 'ib', 'ith', 'skss']) await expect(page.locator(`table.grid thead th[data-key="${key}"]`)).toBeVisible();
  await page.locator('.tree-row[data-id="B4"]').click();
  await palette(page, 'Short circuit at selected busbar');
  await expect(page.locator('.dock-toolbar').first()).toContainText('Fault at Bus 4');
  await page.locator('.dock-toolbar .seg button', { hasText: /^Contributions/ }).click();
  await expect(page.locator('table.grid tbody tr[data-id="L7"]')).toBeVisible();
  await expect(page.locator('.ribbon-panel [data-cmd="sc.allBuses"]')).toContainText('Every busbar');

  // 6. Contingency, with the options the guide names.
  await expect(page.locator('.ribbon-panel [data-cmd="contingency.gens"]')).toContainText('Generator outages');
  await expect(page.locator('.ribbon-panel [data-cmd="contingency.edit"]')).toContainText('Contingencies');
  await page.locator('.ribbon-panel [data-cmd="calc.contingency"]').click();
  await expect(page.locator('.dock-tab[data-tab="contingency"]')).toHaveAttribute('aria-selected', 'true');
  await expect(pill).toContainText('10 contingencies with new violations');

  // 7. Simulation: the sample's events, then the run.
  await page.locator('.ribbon-panel [data-cmd="rms.events"]').click();
  for (const text of ['Three-phase fault at', 'Clear fault at', 'Switch out', 'Line 4-5']) await expect(page.locator('.dialog')).toContainText(text);
  await page.locator('.dialog').getByRole('button', { name: 'Cancel' }).click();
  await page.locator('.ribbon-panel [data-cmd="calc.rms"]').click();
  await expect(page.locator('.dock-tab[data-tab="rms"]')).toContainText('Stability');
  await expect(pill).toContainText('All machines stay in synchronism');
  for (const quantity of ['Rotor angle', 'Speed', 'Active power']) await expect(page.locator('.rms-quantity option', { hasText: quantity }).first()).toBeAttached();

  // 8. Export a table as CSV, and compare the summer load flow with the winter one.
  await page.locator('.dock-tab[data-tab="loadflow"]').click();
  const download = page.waitForEvent('download');
  await page.locator('.dock-tabs [data-cmd="results.csv"]').click();
  expect((await download).suggestedFilename()).toMatch(/\.csv$/);
  await switchCase(page, 'Winter peak');
  await page.keyboard.press('Alt+L');
  await expect(load).toContainText('Load 259.00 MW');
  await switchCase(page, 'Summer minimum');
  await page.keyboard.press('Alt+L');
  await expect(load).toContainText('Load 155.40 MW');
  await page.locator('.dock-toolbar .seg button', { hasText: /^Branches/ }).click();
  const compare = page.locator('select.compare');
  // The latest run is listed first.
  const winter = compare.locator('option', { hasText: 'Winter peak' }).first();
  await compare.selectOption(/** @type {string} */ (await winter.getAttribute('value')));
  await expect(page.locator('table.grid th[data-key="dloading"]')).toBeVisible();
  await page.locator('.dock-toolbar .seg button', { hasText: 'Changed' }).click();
  await expect(page.locator('table.grid tbody tr[data-id]').first()).toBeVisible();
  await page.locator('.ribbon-tab[data-tab="file"]').click();
  await page.locator('.backstage nav [data-page="export"]').click();
  for (const name of ['Project', 'Study report']) await expect(page.locator('.backstage')).toContainText(name);
});
