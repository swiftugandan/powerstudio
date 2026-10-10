/** The overview map (docs/design/CAD.md, section 8): the whole drawing in miniature in a corner of the diagram, with
 * the view as a rectangle. Click or drag in it to move the view there.
 *
 * Built once per diagram build: the busbars and routes of the display list (orthogonal segments, so each is a run of
 * pixels) are rasterised into a small bitmap in their own colours, which takes a few milliseconds even for a national
 * network. Moving the view only moves the rectangle. */

import { h } from './dom.js';
import { SHAPE_STRIDE, SHAPE_SEGMENT } from '../render/displaylist.js';

/** @typedef {{ x0: number, y0: number, x1: number, y1: number }} Rect */

/** The map's size in CSS pixels. */
const W = 220, H = 140;
/** Busbars from which the map shows unless switched off: below this the whole drawing fits on screen anyway. */
export const OVERVIEW_FROM = 200;

export class Overview {
  /** @param {import('./viewport.js').Viewport} vp */
  constructor(vp) {
    this.vp = vp;
    this.canvas = h('canvas', { class: 'vp-overview-map', 'aria-hidden': 'true' });
    this.view = h('div', { class: 'vp-overview-view' });
    this.el = h('div', { class: 'vp-overview', role: 'img', 'aria-label': 'Overview of the whole diagram; click to move the view there', hidden: true }, this.canvas, this.view);
    /** The drawing's extent and the scale from world units to map pixels. */
    this.frame = { x0: 0, y0: 0, scale: 1, ox: 0, oy: 0 };
    this.dragging = false;
    this.el.addEventListener('pointerdown', e => { this.dragging = true; this.el.setPointerCapture(e.pointerId); this.moveTo(e); });
    this.el.addEventListener('pointermove', e => { if (this.dragging) this.moveTo(e); });
    this.el.addEventListener('pointerup', () => { this.dragging = false; });
    this.el.addEventListener('pointercancel', () => { this.dragging = false; });
  }

  /** Whether the map shows. @param {boolean} on */
  show(on) {
    this.el.hidden = !on;
    if (on) this.place();
  }

  get visible() { return !this.el.hidden; }

  /**
   * Draws the drawing into the map. @param {import('../render/displaylist.js').DisplayList} list @param {Rect} extent
   * @param {[number, number, number, number]} background
   */
  draw(list, extent, background) {
    const dpr = window.devicePixelRatio || 1, w = Math.round(W * dpr), hh = Math.round(H * dpr);
    this.canvas.width = w; this.canvas.height = hh;
    const ew = Math.max(extent.x1 - extent.x0, 1), eh = Math.max(extent.y1 - extent.y0, 1);
    const scale = Math.min((w - 8) / ew, (hh - 8) / eh), ox = (w - ew * scale) / 2, oy = (hh - eh * scale) / 2;
    this.frame = { x0: extent.x0, y0: extent.y0, scale: scale / dpr, ox: ox / dpr, oy: oy / dpr };
    const ctx = /** @type {CanvasRenderingContext2D} */ (this.canvas.getContext('2d'));
    const img = ctx.createImageData(w, hh), px = new Uint32Array(img.data.buffer);
    const bg = rgba(background);
    px.fill(bg);
    // Routes first (layer 1), then busbars over them (layer 2); symbols, labels and texts are left out.
    for (const layer of [list.layers[1], list.layers[2]]) {
      const s = layer.shapes;
      for (let i = 0; i < s.length; i += SHAPE_STRIDE) {
        if (s[i] !== SHAPE_SEGMENT) continue;
        const c = rgba([s[i + 8], s[i + 9], s[i + 10], 1]);
        const x0 = Math.round(ox + (s[i + 1] - extent.x0) * scale), y0 = Math.round(oy + (s[i + 2] - extent.y0) * scale);
        const x1 = Math.round(ox + (s[i + 3] - extent.x0) * scale), y1 = Math.round(oy + (s[i + 4] - extent.y0) * scale);
        const thick = layer === list.layers[2] ? Math.max(1, Math.round(dpr)) : 1;
        for (let t = 0; t < thick; t++) {
          if (y0 === y1) run(px, w, hh, Math.min(x0, x1), Math.max(x0, x1), y0 + t, c, true);
          else if (x0 === x1) run(px, w, hh, Math.min(y0, y1), Math.max(y0, y1), x0 + t, c, false);
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    this.place();
  }

  /** Moves the view rectangle to where the camera looks. */
  place() {
    if (!this.visible) return;
    const c = this.vp.camera, a = c.toWorld(0, 0), b = c.toWorld(c.width, c.height), f = this.frame;
    const x = f.ox + (a.x - f.x0) * f.scale, y = f.oy + (a.y - f.y0) * f.scale, w = (b.x - a.x) * f.scale, hgt = (b.y - a.y) * f.scale;
    // The rectangle stays inside the map: a view larger than the drawing shows as the whole map.
    const x0 = Math.max(0, x), y0 = Math.max(0, y), x1 = Math.min(W, x + w), y1 = Math.min(H, y + hgt);
    Object.assign(this.view.style, { left: `${x0}px`, top: `${y0}px`, width: `${Math.max(4, x1 - x0)}px`, height: `${Math.max(4, y1 - y0)}px` });
  }

  /** Centres the view on the point of the map under the pointer. @param {PointerEvent} e */
  moveTo(e) {
    const r = this.el.getBoundingClientRect(), f = this.frame, c = this.vp.camera;
    c.cx = f.x0 + (e.clientX - r.left - f.ox) / f.scale;
    c.cy = f.y0 + (e.clientY - r.top - f.oy) / f.scale;
    this.vp.invalidate('view');
  }
}

/** A colour as a little-endian RGBA pixel. @param {ArrayLike<number>} c */
function rgba(c) {
  const v = (/** @type {number} */ k) => Math.max(0, Math.min(255, Math.round(c[k] * 255)));
  return ((v(3) << 24) | (v(2) << 16) | (v(1) << 8) | v(0)) >>> 0;
}

/** Fills a horizontal or vertical run of pixels. @param {Uint32Array} px @param {number} w @param {number} h
 * @param {number} from @param {number} to @param {number} at @param {number} c @param {boolean} horizontal */
function run(px, w, h, from, to, at, c, horizontal) {
  if (horizontal) {
    if (at < 0 || at >= h) return;
    for (let x = Math.max(0, from); x <= Math.min(w - 1, to); x++) px[at * w + x] = c;
  } else {
    if (at < 0 || at >= w) return;
    for (let y = Math.max(0, from); y <= Math.min(h - 1, to); y++) px[y * w + at] = c;
  }
}
