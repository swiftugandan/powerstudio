/** Text widths for laying out the diagram: label placement, halos and result boxes.
 *
 * The browser measures with the fonts the renderers draw (`FONTS`); Node, which has no fonts (tests, the website
 * build), uses a table that errs wide, so a layout that fits in Node also fits in a browser. */

import { FONTS } from './glyphs.js';

/** Width of a text in world units. @typedef {(font: 'sans' | 'mono', weight: number, size: number, text: string) => number} Measure */

/** Characters narrower and wider than a typical sans letter. */
const NARROW = new Set([...'iIjlft.,:;\'|!()[]{} ']);
const WIDE = new Set([...'MWmw@%&']);

/**
 * Widths that err wide: the monospaced faces in `FONTS` advance up to about 0.62 em (Menlo 0.602, SF Mono in WebKit
 * 0.618), counted here as 0.64, and these sans widths exceed the advances of the sans faces in `FONTS` for each class
 * of character. Characters beyond ASCII (°, ″, δ, −) may come
 * from a fallback font, so they count as 1.2 em in either face. A browser test checks the claim in every browser.
 * @type {Measure}
 */
export function conservativeMeasure(font, weight, size, text) {
  let em = 0;
  if (font === 'mono') {
    for (const ch of text) em += ch > '~' ? 1.2 : 0.64;
    return em * size;
  }
  for (const ch of text) em += ch > '~' ? 1.2 : NARROW.has(ch) ? 0.34 : WIDE.has(ch) ? 0.95 : ch >= 'A' && ch <= 'Z' ? 0.72 : 0.6;
  return em * size * (weight >= 600 ? 1.05 : 1);
}

/**
 * Measures with the browser's fonts through Canvas 2D, one character at a time (the renderers place text by character
 * advances too), caching each character's advance per face.
 * @returns {Measure}
 */
export function canvasMeasure() {
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas');
  const ctx = /** @type {OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  const PX = 100;
  /** Advances in em by character, one map per font and weight. @type {Map<string, Map<string, number>>} */
  const faces = new Map();
  return (font, weight, size, text) => {
    const key = `${font} ${weight}`;
    let face = faces.get(key);
    if (!face) { face = new Map(); faces.set(key, face); }
    let em = 0;
    for (const ch of text) {
      let a = face.get(ch);
      if (a === undefined) {
        ctx.font = `${weight} ${PX}px ${FONTS[font]}`;
        a = ctx.measureText(ch).width / PX;
        face.set(ch, a);
      }
      em += a;
    }
    return em * size;
  };
}
