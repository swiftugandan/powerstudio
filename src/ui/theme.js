/** Theme handling and the diagram palette, read from the CSS tokens so the canvas follows the active theme. */

import { parseColor } from '../render/displaylist.js';

/** @param {'system' | 'light' | 'dark'} theme */
export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
}

/** The theme actually showing. */
export function effectiveTheme() {
  const t = document.documentElement.dataset.theme;
  if (t === 'light' || t === 'dark') return t;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** @returns {import('../render/scene.js').Palette & { res: Record<'ok' | 'warn' | 'high' | 'low', import('../render/displaylist.js').RGBA> }} */
export function readPalette() {
  const cs = getComputedStyle(document.documentElement);
  const c = (/** @type {string} */ name) => parseColor(cs.getPropertyValue(name) || '#ff00ff');
  return {
    bg: c('--dg-bg'), grid: c('--dg-grid'), ink: c('--dg-ink'), muted: c('--dg-muted'), select: c('--dg-select'), hover: c('--dg-hover'),
    label: c('--dg-label'), labelMuted: c('--dg-label-muted'), boxBg: c('--dg-box-bg'), boxBorder: c('--dg-box-border'), boxText: c('--dg-box-text'),
    kv: { ehv: c('--kv-ehv'), hv: c('--kv-hv'), mv: c('--kv-mv'), lv: c('--kv-lv') }, fault: c('--dg-fault'), preview: c('--dg-preview'),
    res: { ok: c('--res-ok'), warn: c('--res-warn'), high: c('--res-high'), low: c('--res-low') },
  };
}
