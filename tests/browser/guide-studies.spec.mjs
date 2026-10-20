/** Follows the study chapters of docs/guide/ on the IEEE 14-bus sample, using the guide's labels, so a change to the
 * app that the guide does not follow fails. */
import { test, expect } from '@playwright/test';

test('the study chapters of the guide match the app on the IEEE 14-bus sample', async ({ page }) => {
  await page.goto('/PowerStudio.html?sample=ieee14');
  await page.waitForFunction(() => /** @type {any} */ (window).powerstudio?.ready === true);
  await page.locator('.toast').evaluateAll(ts => ts.forEach(t => t.remove()));
  const ribbon = (/** @type {string} */ tab) => page.locator(`.ribbon-tab[data-tab="${tab}"]`).click();
  const pill = page.locator('.dock-toolbar .pill');

  // Run a load flow (docs/guide/run-a-load-flow.md).
  await ribbon('home');
  await expect(page.locator('.ribbon-panel [data-cmd="calc.loadflow"]')).toContainText('Load flow');
  await page.locator('.ribbon-panel [data-cmd="calc.loadflow"]').click();
  await expect(pill).toContainText('Converged');
  await expect(page.locator('.dock-tab[data-tab="loadflow"]')).toHaveAttribute('aria-selected', 'true');
  await page.locator('.dock-toolbar .seg button', { hasText: /^Busbars/ }).click();
  for (const key of ['vm', 'va']) await expect(page.locator(`table.grid thead th[data-key="${key}"]`)).toBeVisible();
  await expect(page.locator('table.grid thead th[data-key="vm"]')).toContainText('u');
  await page.locator('.dock-toolbar .seg button', { hasText: /^Branches/ }).click();
  await expect(page.locator('table.grid thead th[data-key="loading"]')).toBeVisible();

  // Find fault levels (docs/guide/find-fault-levels.md).
  await ribbon('calculate');
  await page.locator('.ribbon-panel [data-cmd="sc.fault3ph"]').click();
  await page.locator('.ribbon-panel [data-cmd="sc.max"]').click();
  await expect(page.locator('.ribbon-panel [data-cmd="sc.fault3ph"]')).toContainText('Three-phase');
  await expect(page.locator('.ribbon-panel [data-cmd="sc.max"]')).toContainText('Maximum currents');
  await expect(page.locator('.ribbon-panel [data-cmd="sc.min"]')).toContainText('Minimum currents');
  await expect(page.locator('.ribbon-panel [data-cmd="sc.allBuses"]')).toContainText('Every busbar');
  await page.locator('.ribbon-panel [data-cmd="calc.shortcircuit"]').click();
  await expect(page.locator('.dock-tab[data-tab="shortcircuit"]')).toHaveAttribute('aria-selected', 'true');
  for (const key of ['ikss', 'ip', 'ib', 'ith', 'skss']) await expect(page.locator(`table.grid thead th[data-key="${key}"]`)).toBeVisible();
  await page.locator('.tree-row[data-id="B4"]').click();
  await page.keyboard.press('ControlOrMeta+K');
  await page.locator('.palette input').fill('Short circuit at selected busbar');
  await page.keyboard.press('Enter');
  await expect(page.locator('.dock-toolbar').first()).toContainText('Fault at Bus 4');
  await page.locator('.dock-toolbar .seg button', { hasText: /^Contributions/ }).click();
  await expect(page.locator('table.grid tbody tr[data-id]').first()).toBeVisible();

  // Check outages (docs/guide/check-outages.md).
  await expect(page.locator('.ribbon-panel [data-cmd="contingency.gens"]')).toContainText('Generator outages');
  await expect(page.locator('.ribbon-panel [data-cmd="contingency.edit"]')).toContainText('Contingencies');
  await page.locator('.ribbon-panel [data-cmd="calc.contingency"]').click();
  await expect(page.locator('.dock-tab[data-tab="contingency"]')).toHaveAttribute('aria-selected', 'true');
  await expect(pill).toContainText('10 contingencies with new violations');

  // Check machines stay in step (docs/guide/check-stability.md).
  await page.locator('.ribbon-panel [data-cmd="rms.events"]').click();
  for (const text of ['Three-phase fault at', 'Clear fault at', 'Switch out']) await expect(page.locator('.dialog')).toContainText(text);
  await page.locator('.dialog').getByRole('button', { name: 'Cancel' }).click();
  await page.locator('.ribbon-panel [data-cmd="calc.rms"]').click();
  await expect(page.locator('.dock-tab[data-tab="rms"]')).toContainText('Stability');
  await expect(pill).toContainText('All machines stay in synchronism');

  // Look at EMT (docs/guide/look-at-emt.md).
  await expect(page.locator('.ribbon-panel [data-cmd="calc.emt"]')).toContainText('EMT');
  await page.locator('.ribbon-panel [data-cmd="emt.events"]').click();
  for (const text of ['Fault at', 'Clear fault at', 'Trip', 'Close']) await expect(page.locator('.dialog')).toContainText(text);
  await page.locator('.dialog').getByRole('button', { name: 'Cancel' }).click();
  await page.locator('.ribbon-panel [data-cmd="calc.emt"]').click();
  await expect(page.locator('.dock-tab[data-tab="emt"]')).toHaveAttribute('aria-selected', 'true');
  for (const seg of ['Waveforms', 'Busbars', 'Branches', 'Faults', 'Switching']) {
    await expect(page.locator('.dock-toolbar .seg button', { hasText: new RegExp(`^${seg}`) })).toBeVisible();
  }
});
