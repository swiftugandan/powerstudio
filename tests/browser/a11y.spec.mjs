/** Accessibility audit: axe-core's WCAG 2.1 A and AA rules over the app's main states, in both themes and at phone
 * width. A state fails on any violation; the message lists each rule with the elements it found. */
import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';

const axePath = createRequire(import.meta.url).resolve('axe-core/axe.min.js');

// axe is injected as a script, which the built page's own Content-Security-Policy forbids.
test.use({ bypassCSP: true });

/** @param {import('@playwright/test').Page} page @param {string} query */
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

/** Runs axe on the page once its entrance animations have finished, and fails with every violation it finds. @param {import('@playwright/test').Page} page
 * @param {string} state what the page shows */
async function audit(page, state) {
  await page.evaluate(() => Promise.all(document.getAnimations().map(a => a.finished)));
  await page.addScriptTag({ path: axePath });
  const violations = await page.evaluate(async () => {
    const r = await /** @type {any} */ (window).axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } });
    return r.violations.map((/** @type {any} */ v) => ({
      id: v.id, impact: v.impact, help: v.help,
      nodes: v.nodes.slice(0, 6).map((/** @type {any} */ n) => `${n.target.join(' ')}: ${n.failureSummary.split('\n').slice(1).join(' ')}`),
    }));
  });
  const text = violations.map(v => `${state}: ${v.id} (${v.impact}) ${v.help}\n    ${v.nodes.join('\n    ')}`).join('\n');
  expect(violations, text).toEqual([]);
}

for (const theme of /** @type {const} */ (['light', 'dark'])) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme: theme });

    test('the workspace with load flow results', async ({ page }) => {
      await open(page);
      await page.keyboard.press('Alt+L');
      await expect(page.locator('.dock-toolbar .pill.ok')).toContainText('Converged');
      await page.locator('.tree-row[data-id="B4"]').click();
      await audit(page, 'workspace');
    });

    test('short-circuit results and the data sheet', async ({ page }) => {
      await open(page);
      await page.keyboard.press('Alt+S');
      await expect(page.locator('.dock-tab[data-tab="shortcircuit"]')).toHaveAttribute('aria-selected', 'true');
      await audit(page, 'short-circuit results');
      await page.locator('.dock-tab[data-tab="data"]').click();
      await audit(page, 'data sheet');
    });

    test('the study case dialog and the command palette', async ({ page }) => {
      await open(page);
      await page.keyboard.press('ControlOrMeta+Comma');
      await expect(page.locator('.dialog')).toBeVisible();
      await audit(page, 'study case dialog');
      await page.keyboard.press('Escape');
      await page.keyboard.press('ControlOrMeta+K');
      await page.locator('.palette input').fill('load');
      await audit(page, 'command palette');
    });

    test('the File page', async ({ page }) => {
      await open(page);
      await page.locator('.ribbon-tab.file-tab').click();
      await expect(page.locator('.backstage')).toBeVisible();
      await audit(page, 'File page');
    });
  });
}

test('the phone layout', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await page.keyboard.press('Alt+L');
  await audit(page, 'phone');
});

test('every keyboard stop in the workspace shows where the focus is', async ({ page }) => {
  await open(page);
  await page.keyboard.press('Alt+L');
  await expect(page.locator('.dock-toolbar .pill.ok')).toContainText('Converged');
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  const seen = new Set();
  const unmarked = [];
  for (let k = 0; k < 60; k++) {
    await page.keyboard.press('Tab');
    const stop = await page.evaluate(() => {
      const el = /** @type {HTMLElement | null} */ (document.activeElement);
      if (!el || el === document.body) return null;
      const css = getComputedStyle(el), after = getComputedStyle(el, '::after');
      const marked = (css.outlineStyle !== 'none' && parseFloat(css.outlineWidth) > 0) || css.boxShadow !== 'none'
        || (el.classList.contains('splitter') && after.content !== 'none' && after.opacity === '1');
      const name = `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}.${[...el.classList].join('.')} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 30)}"`;
      return { name, marked };
    });
    if (!stop) continue;
    if (seen.has(stop.name)) break;
    seen.add(stop.name);
    if (!stop.marked) unmarked.push(stop.name);
  }
  expect(seen.size, 'the workspace has keyboard stops').toBeGreaterThan(15);
  expect(unmarked, `stops without a visible focus mark:\n${unmarked.join('\n')}`).toEqual([]);
});
