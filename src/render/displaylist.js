/** A backend-neutral list of drawing primitives in world coordinates.
 *
 * Both renderers (WebGPU and Canvas 2D) and the SVG export draw exactly this list, so what a user sees does not depend
 * on which backend is active. Primitives are grouped in layers drawn bottom to top; within a layer shapes come first,
 * then filled triangles, then text. */

/** @typedef {[number, number, number, number]} RGBA */
/** @typedef {{ x: number, y: number, text: string, size: number, color: RGBA, align: number, font: 'sans' | 'mono', weight: 400 | 600, minPx: number }} TextItem */

/** Floats per shape instance: kind, 7 geometry values, fill RGBA, stroke RGBA, stroke width, dash, the smallest zoom
 * at which the shape shows (0 for always), 1 spare. */
export const SHAPE_STRIDE = 20;
export const SHAPE_SEGMENT = 0, SHAPE_CIRCLE = 1, SHAPE_RECT = 2;
/** Offset of a shape's minimum zoom within its stride. */
export const SHAPE_MIN_ZOOM = 18;

/** A growable array of 32-bit floats: a national diagram holds millions, which plain arrays filled by spreading build
 * and copy slowly. */
export class Floats {
  constructor(capacity = 1024) {
    this.a = new Float32Array(capacity);
    this.n = 0;
  }

  /** Makes room for `k` more values. @param {number} k */
  reserve(k) {
    if (this.n + k <= this.a.length) return;
    let m = this.a.length * 2;
    while (m < this.n + k) m *= 2;
    const b = new Float32Array(m);
    b.set(this.a.subarray(0, this.n));
    this.a = b;
  }

  /** The values written so far (a view, valid until the next write). */
  view() { return this.a.subarray(0, this.n); }
}

export class Layer {
  constructor() {
    this.shapeData = new Floats();
    /** x, y, r, g, b, a per vertex */
    this.triData = new Floats(256);
    /** @type {TextItem[]} */
    this.texts = [];
  }

  /** Shape instances, SHAPE_STRIDE floats each. */
  get shapes() { return this.shapeData.view(); }

  /** Triangle vertices, 6 floats each. */
  get tris() { return this.triData.view(); }
}

export class DisplayList {
  /** @param {number} layers */
  constructor(layers = 3) {
    this.layers = Array.from({ length: layers }, () => new Layer());
    this.current = this.layers[0];
    /** The smallest zoom at which the shapes written next show; texts use their own minimum size instead. */
    this.minZoom = 0;
  }

  /** @param {number} i */
  layer(i) { this.current = this.layers[i]; return this; }

  /** One shape instance. @param {number} kind @param {number[]} g seven geometry values @param {RGBA} fill
   * @param {RGBA} stroke @param {number} strokeWidth @param {number} dash */
  shape(kind, g, fill, stroke, strokeWidth, dash) {
    const f = this.current.shapeData;
    f.reserve(SHAPE_STRIDE);
    const a = f.a, i = f.n;
    a[i] = kind;
    for (let k = 0; k < 7; k++) a[i + 1 + k] = g[k];
    a[i + 8] = fill[0]; a[i + 9] = fill[1]; a[i + 10] = fill[2]; a[i + 11] = fill[3];
    a[i + 12] = stroke[0]; a[i + 13] = stroke[1]; a[i + 14] = stroke[2]; a[i + 15] = stroke[3];
    a[i + 16] = strokeWidth; a[i + 17] = dash; a[i + SHAPE_MIN_ZOOM] = this.minZoom; a[i + 19] = 0;
    f.n += SHAPE_STRIDE;
  }

  /** A segment with round caps. Width is in world units; dash is the dash length in world units (0 for solid).
   * @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1 @param {number} width @param {RGBA} color @param {number} [dash] */
  segment(x0, y0, x1, y1, width, color, dash = 0) {
    this.shape(SHAPE_SEGMENT, [x0, y0, x1, y1, width, 0, 0], color, NONE, 0, dash);
  }

  /** @param {Array<{ x: number, y: number }>} pts @param {number} width @param {RGBA} color @param {number} [dash] */
  polyline(pts, width, color, dash = 0) {
    for (let i = 0; i < pts.length - 1; i++) this.segment(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, width, color, dash);
  }

  /** @param {number} cx @param {number} cy @param {number} r @param {RGBA} fill @param {RGBA} stroke @param {number} strokeWidth */
  circle(cx, cy, r, fill, stroke, strokeWidth) {
    this.shape(SHAPE_CIRCLE, [cx, cy, r, 0, 0, 0, 0], fill, stroke, strokeWidth, 0);
  }

  /** @param {number} x @param {number} y @param {number} w @param {number} h @param {RGBA} fill @param {RGBA} stroke @param {number} strokeWidth @param {number} [radius] */
  rect(x, y, w, h, fill, stroke, strokeWidth, radius = 0) {
    this.shape(SHAPE_RECT, [x, y, w, h, radius, 0, 0], fill, stroke, strokeWidth, 0);
  }

  /** @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1 @param {number} x2 @param {number} y2 @param {RGBA} c */
  triangle(x0, y0, x1, y1, x2, y2, c) {
    const f = this.current.triData;
    f.reserve(18);
    const a = f.a;
    let i = f.n;
    for (const [x, y] of [[x0, y0], [x1, y1], [x2, y2]]) {
      a[i] = x; a[i + 1] = y; a[i + 2] = c[0]; a[i + 3] = c[1]; a[i + 4] = c[2]; a[i + 5] = c[3];
      i += 6;
    }
    f.n = i;
  }

  /**
   * Text anchored at (x, y) on its vertical centre; align 0 = left, 0.5 = centre, 1 = right. Text smaller than minPx
   * on screen is skipped by the renderers, so labels disappear cleanly when zoomed out.
   * @param {number} x @param {number} y @param {string} text @param {number} size @param {RGBA} color
   * @param {{ align?: number, font?: 'sans' | 'mono', weight?: 400 | 600, minPx?: number }} [opt]
   */
  text(x, y, text, size, color, opt = {}) {
    if (!text) return;
    this.current.texts.push({ x, y, text, size, color, align: opt.align ?? 0, font: opt.font ?? 'sans', weight: opt.weight ?? 400, minPx: opt.minPx ?? 5 });
  }
}

/** A fully transparent colour, for shapes without a stroke. @type {RGBA} */
const NONE = [0, 0, 0, 0];

/** Parses a CSS colour (#rgb, #rrggbb, #rrggbbaa or rgb()/rgba()) into linear 0–1 RGBA. @param {string} css @returns {RGBA} */
export function parseColor(css) {
  const s = css.trim();
  if (s.startsWith('#')) {
    const h = s.slice(1);
    const full = h.length <= 4 ? [...h].map(c => c + c).join('') : h;
    const n = (/** @type {number} */ i) => parseInt(full.slice(i, i + 2), 16) / 255;
    return [n(0), n(2), n(4), full.length >= 8 ? n(6) : 1];
  }
  const m = /rgba?\(([^)]+)\)/.exec(s);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return [p[0] / 255, p[1] / 255, p[2] / 255, p.length > 3 ? p[3] : 1];
  }
  return [1, 0, 1, 1];
}

/** @param {RGBA} c @param {number} a @returns {RGBA} */
export const withAlpha = (c, a) => [c[0], c[1], c[2], c[3] * a];

/** Linear blend of two colours. @param {RGBA} a @param {RGBA} b @param {number} t @returns {RGBA} */
export const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
