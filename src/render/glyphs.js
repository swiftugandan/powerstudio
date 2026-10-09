/** Signed-distance-field glyph atlas for the WebGPU text pipeline.
 *
 * Glyphs are rasterised on demand with the browser's own fonts (Canvas 2D fillText), turned into a signed distance
 * field with the exact Euclidean distance transform of Felzenszwalb and Huttenlocher (2012), and packed into a single
 * channel atlas on shelves. One field serves every text size: the shader thresholds it at 0.5 with a width of one
 * screen pixel. */

export const FONTS = {
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
};

const PX = 42;          // rasterisation size
const PAD = 7;          // empty border around each glyph
const RADIUS = 7;       // distance (px) mapped to the full 0–1 range on each side of the edge
const LINE = Math.ceil(PX * 1.3);
const SIZE = 2048;

/** @typedef {{ u0: number, v0: number, u1: number, v1: number, advance: number, w: number, h: number }} Glyph */

export class GlyphAtlas {
  constructor() {
    this.size = SIZE;
    this.data = new Uint8Array(SIZE * SIZE);
    /** @type {Map<string, Glyph>} */
    this.glyphs = new Map();
    this.shelfX = 0;
    this.shelfY = 0;
    this.shelfH = 0;
    /** Rows of the atlas changed since the last upload, as [y0, y1). */
    this.dirty = { y0: SIZE, y1: 0 };
    this.version = 0;
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(PX * 3, LINE + 2 * PAD) : document.createElement('canvas');
    canvas.width = PX * 3; canvas.height = LINE + 2 * PAD;
    this.ctx = /** @type {OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D} */ (canvas.getContext('2d', { willReadFrequently: true }));
  }

  /** Quad size in em and vertical placement for laying out text. */
  static get metrics() { return { line: LINE / PX, pad: PAD / PX, px: PX }; }

  /** @param {'sans' | 'mono'} font @param {number} weight @param {string} ch @returns {Glyph} */
  glyph(font, weight, ch) {
    const key = `${font}${weight}${ch}`;
    let g = this.glyphs.get(key);
    if (!g) {
      g = this.rasterise(font, weight, ch);
      this.glyphs.set(key, g);
    }
    return g;
  }

  /** @param {'sans' | 'mono'} font @param {number} weight @param {string} ch @returns {Glyph} */
  rasterise(font, weight, ch) {
    const ctx = this.ctx;
    ctx.font = `${weight} ${PX}px ${FONTS[font]}`;
    const advance = ctx.measureText(ch).width;
    const w = Math.min(Math.ceil(advance) + 2 * PAD, PX * 3), h = LINE + 2 * PAD;
    if (this.shelfX + w > SIZE) { this.shelfX = 0; this.shelfY += this.shelfH; this.shelfH = 0; }
    if (this.shelfY + h > SIZE) this.reset();
    const x = this.shelfX, y = this.shelfY;
    this.shelfX += w; this.shelfH = Math.max(this.shelfH, h);

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#000';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(ch, PAD, PAD + LINE / 2);
    const alpha = ctx.getImageData(0, 0, w, h).data;
    const field = sdf(alpha, w, h);
    for (let row = 0; row < h; row++) this.data.set(field.subarray(row * w, row * w + w), (y + row) * SIZE + x);
    this.dirty.y0 = Math.min(this.dirty.y0, y); this.dirty.y1 = Math.max(this.dirty.y1, y + h);
    return { u0: x / SIZE, v0: y / SIZE, u1: (x + w) / SIZE, v1: (y + h) / SIZE, advance: advance / PX, w: w / PX, h: h / PX };
  }

  /** Starts over when the atlas is full; glyphs in use are rasterised again on the next layout. */
  reset() {
    this.glyphs.clear();
    this.data.fill(0);
    this.shelfX = this.shelfY = this.shelfH = 0;
    this.dirty = { y0: 0, y1: SIZE };
    this.version++;
  }

  /** Width of a string in em. @param {'sans' | 'mono'} font @param {number} weight @param {string} text */
  measure(font, weight, text) {
    let w = 0;
    for (const ch of text) w += this.glyph(font, weight, ch).advance;
    return w;
  }
}

/**
 * Signed distance field from an RGBA coverage image: 0.5 on the edge, rising inside the glyph.
 * Partially covered pixels seed sub-pixel distances, as in Mapbox's TinySDF.
 * @param {Uint8ClampedArray} rgba @param {number} w @param {number} h @returns {Uint8Array}
 */
export function sdf(rgba, w, h) {
  const n = w * h, INF = 1e20;
  const outer = new Float64Array(n), inner = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = rgba[i * 4 + 3] / 255;
    // outer: squared distance to the glyph (0 inside it); inner: squared distance to the background (0 outside).
    if (a >= 1) { outer[i] = 0; inner[i] = INF; }
    else if (a <= 0) { outer[i] = INF; inner[i] = 0; }
    else { const d = 0.5 - a; outer[i] = d > 0 ? d * d : 0; inner[i] = d < 0 ? d * d : 0; }
  }
  edt(outer, w, h); edt(inner, w, h);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const d = Math.sqrt(outer[i]) - Math.sqrt(inner[i]);
    out[i] = Math.max(0, Math.min(255, Math.round(255 * (0.5 - d / (2 * RADIUS)))));
  }
  return out;
}

/** Exact squared Euclidean distance transform in place, columns then rows. @param {Float64Array} g @param {number} w @param {number} h */
function edt(g, w, h) {
  const len = Math.max(w, h), f = new Float64Array(len), d = new Float64Array(len), v = new Int32Array(len), z = new Float64Array(len + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = g[y * w + x];
    edt1d(f, d, v, z, h);
    for (let y = 0; y < h; y++) g[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = g[y * w + x];
    edt1d(f, d, v, z, w);
    for (let x = 0; x < w; x++) g[y * w + x] = d[x];
  }
}

/** One-dimensional distance transform by lower envelope of parabolas.
 * @param {Float64Array} f @param {Float64Array} d @param {Int32Array} v @param {Float64Array} z @param {number} n */
function edt1d(f, d, v, z, n) {
  let k = 0;
  v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}
