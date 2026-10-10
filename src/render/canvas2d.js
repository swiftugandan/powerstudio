/** Canvas 2D renderer: the fallback when WebGPU is unavailable. It draws the same display list as the WebGPU
 * renderer, with the same minimum line width and the same minimum text size.
 *
 * Canvas 2D cannot draw a national network's every element each frame. Above `CACHE_FROM` shapes and labels it draws
 * the diagram into a cache covering the view and a margin around it, a few milliseconds per frame, and each frame
 * blits that cache: moved while panning, scaled while zooming until the cache is drawn again at the new zoom. The
 * badge says so. */

import { SHAPE_STRIDE, SHAPE_SEGMENT, SHAPE_CIRCLE, SHAPE_MIN_ZOOM, TRI_VERTEX } from './displaylist.js';
import { FONTS } from './glyphs.js';

/** @typedef {import('./displaylist.js').DisplayList} DisplayList @typedef {import('./camera.js').Camera} Camera
 * @typedef {import('./scene.js').Palette} Palette @typedef {import('./displaylist.js').RGBA} RGBA */

/** Shapes and labels from which the diagram is drawn through the cache. */
const CACHE_FROM = 20000;
/** Milliseconds a frame may spend drawing the cache. */
const CACHE_BUDGET_MS = 8;

/** @param {RGBA} c */
const css = c => `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${c[3]})`;

/** @typedef {{ canvas: HTMLCanvasElement | OffscreenCanvas, zoom: number, dpr: number, cx: number, cy: number, W: number,
 *   H: number, stale: boolean }} Cache */

export class Canvas2DRenderer {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.backend = /** @type {const} */ ('canvas2d');
    /** The background grid's step in world units: the snapping grid. */
    this.gridStep = 20;
    this.label = 'Canvas 2D';
    this.detail = '';
    /** Whether the diagram is large enough to draw through the cache. */
    this.cached = false;
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('The canvas could not create a 2D context.');
    this.ctx = ctx;
    /** @type {DisplayList | null} */
    this.list = null;
    /** @type {DisplayList | null} */
    this.overlay = null;
    /** The cached diagram, for large networks. @type {Cache | null} */
    this.cache = null;
    /** A cache being drawn, with the camera it is drawn for. @type {{ cache: Cache, steps: Generator<void, void, void> } | null} */
    this.pending = null;
    /** Called when a frame left cache drawing unfinished, so the viewport draws another. @type {(() => void) | null} */
    this.onPending = null;
    /** @type {((reason: string) => void) | null} */
    this.onLost = null;
  }

  /** @param {number} width @param {number} height @param {number} dpr */
  resize(width, height, dpr) {
    const w = Math.max(1, Math.round(width * dpr)), h = Math.max(1, Math.round(height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
  }

  /** The diagram. @param {DisplayList} list */
  setScene(list) { this.commit('base', list); }

  /** Nothing to prepare: Canvas 2D draws the display list as it is. @param {DisplayList} list
   * @returns {Generator<void, DisplayList, void>} */
  *packSteps(list) { return list; }

  /** @param {'base' | 'overlay'} which @param {DisplayList} list */
  commit(which, list) {
    if (which === 'overlay') { this.overlay = list; return; }
    this.list = list;
    const items = list.layers.reduce((n, l) => n + l.shapes.length / SHAPE_STRIDE + l.tris.length / (3 * TRI_VERTEX) + l.texts.length, 0);
    this.cached = items >= CACHE_FROM;
    this.detail = this.cached ? 'large network: drawn from a cache' : '';
    // The cache shows the previous diagram until the new one is drawn into it.
    if (this.cache) this.cache.stale = true;
  }

  /** The overlay: layer 0 draws under the diagram, layer 1 over it. @param {DisplayList} list */
  setOverlay(list) { this.overlay = list; }

  /** @param {Camera} camera @param {Palette} palette @param {number} dpr */
  draw(camera, palette, dpr) {
    const ctx = this.ctx, W = this.canvas.width, H = this.canvas.height, scale = camera.zoom * dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = css(palette.bg);
    ctx.fillRect(0, 0, W, H);
    // Dot grid, coarser when zoomed out (same rule as the WebGPU shader).
    let step = this.gridStep;
    if (step * scale < 12 * dpr) step *= 5;
    if (step * scale < 12 * dpr) step *= 5;
    const x0 = camera.cx - W / 2 / scale, y0 = camera.cy - H / 2 / scale;
    ctx.fillStyle = css(palette.grid);
    const r = 1.1 * dpr;
    for (let gx = Math.ceil(x0 / step) * step; gx <= x0 + W / scale; gx += step) {
      const sx = (gx - camera.cx) * scale + W / 2;
      for (let gy = Math.ceil(y0 / step) * step; gy <= y0 + H / scale; gy += step) {
        const sy = (gy - camera.cy) * scale + H / 2;
        ctx.fillRect(sx - r, sy - r, 2 * r, 2 * r);
      }
    }
    if (!this.list) return;
    const world = () => { ctx.setTransform(scale, 0, 0, scale, W / 2 - camera.cx * scale, H / 2 - camera.cy * scale); ctx.lineCap = 'round'; ctx.lineJoin = 'round'; };
    world();
    const under = this.overlay?.layers.slice(0, 1) ?? [], over = this.overlay?.layers.slice(1) ?? [];
    for (const layer of under) this.drawLayer(layer, camera.zoom, scale);
    if (this.cached) {
      this.drawCached(camera, dpr);
      world();
    } else {
      for (const layer of this.list.layers) this.drawLayer(layer, camera.zoom, scale);
    }
    for (const layer of over) this.drawLayer(layer, camera.zoom, scale);
  }

  /** Blits the cache, starting or continuing a fresh one when the zoom, the view or the diagram changed.
   * @param {Camera} camera @param {number} dpr */
  drawCached(camera, dpr) {
    const ctx = this.ctx, W = this.canvas.width, H = this.canvas.height, scale = camera.zoom * dpr;
    const fits = (/** @type {Cache} */ c) => !c.stale && c.zoom === camera.zoom && c.dpr === dpr && c.W === 2 * W && c.H === 2 * H
      && Math.abs(c.cx - camera.cx) * scale <= W / 2 && Math.abs(c.cy - camera.cy) * scale <= H / 2;
    if (!this.cache || !fits(this.cache)) {
      if (!this.pending || !fits(this.pending.cache)) this.pending = this.startCache(camera, dpr, 2 * W, 2 * H);
      const t0 = performance.now();
      let r = this.pending.steps.next();
      while (!r.done && performance.now() - t0 < CACHE_BUDGET_MS) r = this.pending.steps.next();
      if (r.done) { this.cache = this.pending.cache; this.pending = null; } else this.onPending?.();
    }
    const c = this.cache;
    if (!c) return;
    // The cache's world box on screen, at this camera.
    const k = scale / (c.zoom * c.dpr);
    const left = (c.cx - c.W / 2 / (c.zoom * c.dpr) - camera.cx) * scale + W / 2;
    const top = (c.cy - c.H / 2 / (c.zoom * c.dpr) - camera.cy) * scale + H / 2;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = k !== 1;
    ctx.drawImage(c.canvas, left, top, c.W * k, c.H * k);
  }

  /** A cache of the diagram around the view, drawn in steps. @param {Camera} camera @param {number} dpr @param {number} w
   * @param {number} h @returns {{ cache: Cache, steps: Generator<void, void, void> }} */
  startCache(camera, dpr, w, h) {
    const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
    const ctx = /** @type {CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D} */ (canvas.getContext('2d'));
    /** @type {Cache} */
    const cache = { canvas, zoom: camera.zoom, dpr, cx: camera.cx, cy: camera.cy, W: w, H: h, stale: false };
    const list = /** @type {DisplayList} */ (this.list), scale = camera.zoom * dpr, self = this;
    function* steps() {
      ctx.setTransform(scale, 0, 0, scale, w / 2 - camera.cx * scale, h / 2 - camera.cy * scale);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const layer of list.layers) yield* self.layerSteps(ctx, layer, camera.zoom, scale);
    }
    return { cache, steps: steps() };
  }

  /** @param {import('./displaylist.js').Layer} layer @param {number} zoom @param {number} scale */
  drawLayer(layer, zoom, scale) {
    const steps = this.layerSteps(this.ctx, layer, zoom, scale);
    while (!steps.next().done);
  }

  /**
   * Draws a layer, pausing after every few hundred items (for the cache).
   * @param {CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D} ctx @param {import('./displaylist.js').Layer} layer
   * @param {number} zoom @param {number} scale @returns {Generator<void, void, void>}
   */
  *layerSteps(ctx, layer, zoom, scale) {
    const s = layer.shapes;
    for (let i = 0; i < s.length; i += SHAPE_STRIDE) {
      if ((i / SHAPE_STRIDE) % 512 === 511) yield;
      if (zoom < s[i + SHAPE_MIN_ZOOM]) continue;
      const kind = s[i];
      if (kind === SHAPE_SEGMENT) {
        const color = /** @type {RGBA} */ ([...s.subarray(i + 8, i + 12)]), dash = s[i + 17];
        ctx.strokeStyle = css(color);
        ctx.lineWidth = Math.max(s[i + 5] * scale, 1) / scale;
        ctx.setLineDash(dash > 0 ? [dash, dash] : []);
        ctx.lineCap = dash > 0 ? 'butt' : 'round';
        ctx.beginPath(); ctx.moveTo(s[i + 1], s[i + 2]); ctx.lineTo(s[i + 3], s[i + 4]); ctx.stroke();
        continue;
      }
      ctx.setLineDash([]);
      const fill = /** @type {RGBA} */ ([...s.subarray(i + 8, i + 12)]), stroke = /** @type {RGBA} */ ([...s.subarray(i + 12, i + 16)]), sw = s[i + 16];
      ctx.beginPath();
      if (kind === SHAPE_CIRCLE) ctx.arc(s[i + 1], s[i + 2], s[i + 3], 0, Math.PI * 2);
      else ctx.roundRect(s[i + 1], s[i + 2], s[i + 3], s[i + 4], Math.min(s[i + 5], s[i + 3] / 2, s[i + 4] / 2));
      if (fill[3] > 0) { ctx.fillStyle = css(fill); ctx.fill(); }
      if (sw > 0 && stroke[3] > 0) { ctx.strokeStyle = css(stroke); ctx.lineWidth = Math.max(sw * scale, 1) / scale; ctx.stroke(); }
    }
    const t = layer.tris;
    const V = TRI_VERTEX;
    for (let i = 0; i < t.length; i += 3 * V) {
      if ((i / (3 * V)) % 512 === 511) yield;
      if (zoom < t[i + 6]) continue;
      ctx.fillStyle = css(/** @type {RGBA} */ ([...t.subarray(i + 2, i + 6)]));
      ctx.beginPath(); ctx.moveTo(t[i], t[i + 1]); ctx.lineTo(t[i + V], t[i + V + 1]); ctx.lineTo(t[i + 2 * V], t[i + 2 * V + 1]); ctx.closePath(); ctx.fill();
    }
    ctx.textBaseline = 'middle';
    let n = 0;
    for (const tx of layer.texts) {
      if (++n % 256 === 0) yield;
      if (tx.size * zoom < tx.minPx) continue;
      ctx.font = `${tx.weight} ${tx.size}px ${FONTS[tx.font]}`;
      ctx.textAlign = tx.align === 0 ? 'left' : tx.align === 1 ? 'right' : 'center';
      ctx.fillStyle = css(tx.color);
      ctx.fillText(tx.text, tx.x, tx.y);
    }
  }

  /** The current frame's pixels. @param {Camera} camera @param {Palette} palette @param {number} dpr
   * @returns {Promise<{ width: number, height: number, rgba: Uint8ClampedArray }>} */
  async snapshot(camera, palette, dpr) {
    this.draw(camera, palette, dpr);
    const { width, height } = this.canvas;
    return { width, height, rgba: this.ctx.getImageData(0, 0, width, height).data };
  }

  destroy() { this.list = null; this.overlay = null; this.cache = null; this.pending = null; }
}
