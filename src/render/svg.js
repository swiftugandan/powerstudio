/** SVG export of a display list: the same primitives the renderers draw, as vector graphics. */

import { SHAPE_STRIDE, SHAPE_SEGMENT, SHAPE_CIRCLE, SHAPE_MIN_ZOOM, TRI_VERTEX } from './displaylist.js';
import { FONTS } from './glyphs.js';

/** @typedef {import('./displaylist.js').RGBA} RGBA */

/** @param {RGBA} c */
const col = c => `rgb(${Math.round(c[0] * 255)} ${Math.round(c[1] * 255)} ${Math.round(c[2] * 255)} / ${+c[3].toFixed(3)})`;
/** @param {number} v */
const n = v => +v.toFixed(2);
/** @param {string} s */
const escText = s => s.replace(/[&<>]/g, c => /** @type {Record<string, string>} */ ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

/**
 * The diagram as at 100 % zoom: result boxes, halos and labels that show from a larger zoom are left out, as on screen.
 * @param {import('./displaylist.js').DisplayList} list @param {{ x0: number, y0: number, x1: number, y1: number }} box
 * @param {RGBA} background @param {string} title @returns {string}
 */
export function toSVG(list, box, background, title) {
  const zoom = 1;
  const w = box.x1 - box.x0, h = box.y1 - box.y0;
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${n(box.x0)} ${n(box.y0)} ${n(w)} ${n(h)}" width="${n(w)}" height="${n(h)}">`,
    `<title>${escText(title)}</title>`, `<rect x="${n(box.x0)}" y="${n(box.y0)}" width="${n(w)}" height="${n(h)}" fill="${col(background)}"/>`];
  for (const layer of list.layers) {
    const s = layer.shapes;
    for (let i = 0; i < s.length; i += SHAPE_STRIDE) {
      if (zoom < s[i + SHAPE_MIN_ZOOM]) continue;
      const kind = s[i];
      if (kind === SHAPE_SEGMENT) {
        const dash = s[i + 17];
        out.push(`<line x1="${n(s[i + 1])}" y1="${n(s[i + 2])}" x2="${n(s[i + 3])}" y2="${n(s[i + 4])}" stroke="${col(/** @type {RGBA} */ ([...s.subarray(i + 8, i + 12)]))}" stroke-width="${n(s[i + 5])}" stroke-linecap="${dash ? 'butt' : 'round'}"${dash ? ` stroke-dasharray="${n(dash)} ${n(dash)}"` : ''}/>`);
        continue;
      }
      const fill = /** @type {RGBA} */ ([...s.subarray(i + 8, i + 12)]), stroke = /** @type {RGBA} */ ([...s.subarray(i + 12, i + 16)]), sw = s[i + 16];
      const paint = `fill="${fill[3] > 0 ? col(fill) : 'none'}" stroke="${sw > 0 && stroke[3] > 0 ? col(stroke) : 'none'}" stroke-width="${n(sw)}"`;
      if (kind === SHAPE_CIRCLE) out.push(`<circle cx="${n(s[i + 1])}" cy="${n(s[i + 2])}" r="${n(s[i + 3])}" ${paint}/>`);
      else out.push(`<rect x="${n(s[i + 1])}" y="${n(s[i + 2])}" width="${n(s[i + 3])}" height="${n(s[i + 4])}" rx="${n(s[i + 5])}" ${paint}/>`);
    }
    const t = layer.tris;
    const V = TRI_VERTEX;
    for (let i = 0; i < t.length; i += 3 * V) {
      if (zoom < t[i + 6]) continue;
      out.push(`<polygon points="${n(t[i])},${n(t[i + 1])} ${n(t[i + V])},${n(t[i + V + 1])} ${n(t[i + 2 * V])},${n(t[i + 2 * V + 1])}" fill="${col(/** @type {RGBA} */ ([...t.subarray(i + 2, i + 6)]))}"/>`);
    }
    for (const tx of layer.texts) {
      if (tx.size * zoom < tx.minPx) continue;
      const anchor = tx.align === 0 ? 'start' : tx.align === 1 ? 'end' : 'middle';
      out.push(`<text x="${n(tx.x)}" y="${n(tx.y)}" font-family='${FONTS[tx.font]}' font-size="${tx.size}" font-weight="${tx.weight}" text-anchor="${anchor}" dominant-baseline="central" fill="${col(tx.color)}">${escText(tx.text)}</text>`);
    }
  }
  out.push('</svg>');
  return out.join('\n');
}
