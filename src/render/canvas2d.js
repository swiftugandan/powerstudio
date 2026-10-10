/** Canvas 2D renderer: the fallback when WebGPU is unavailable. It draws the same display list as the WebGPU
 * renderer, with the same minimum line width and the same minimum text size. */

import { SHAPE_STRIDE, SHAPE_SEGMENT, SHAPE_CIRCLE, SHAPE_MIN_ZOOM } from './displaylist.js';
import { FONTS } from './glyphs.js';

/** @typedef {import('./displaylist.js').DisplayList} DisplayList @typedef {import('./camera.js').Camera} Camera
 * @typedef {import('./scene.js').Palette} Palette @typedef {import('./displaylist.js').RGBA} RGBA */

/** @param {RGBA} c */
const css = c => `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${c[3]})`;

export class Canvas2DRenderer {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.backend = /** @type {const} */ ('canvas2d');
    this.label = 'Canvas 2D';
    this.detail = '';
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('The canvas could not create a 2D context.');
    this.ctx = ctx;
    /** @type {DisplayList | null} */
    this.list = null;
    /** @type {DisplayList | null} */
    this.overlay = null;
    /** @type {((reason: string) => void) | null} */
    this.onLost = null;
  }

  /** @param {number} width @param {number} height @param {number} dpr */
  resize(width, height, dpr) {
    const w = Math.max(1, Math.round(width * dpr)), h = Math.max(1, Math.round(height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
  }

  /** The diagram. @param {DisplayList} list */
  setScene(list) { this.list = list; }

  /** Nothing to prepare: Canvas 2D draws the display list as it is. @param {DisplayList} list
   * @returns {Generator<void, DisplayList, void>} */
  *packSteps(list) { return list; }

  /** @param {'base' | 'overlay'} which @param {DisplayList} list */
  commit(which, list) { if (which === 'base') this.list = list; else this.overlay = list; }

  /** The overlay: layer 0 draws under the diagram, layer 1 over it. @param {DisplayList} list */
  setOverlay(list) { this.overlay = list; }

  /** @param {Camera} camera @param {Palette} palette @param {number} dpr */
  draw(camera, palette, dpr) {
    const ctx = this.ctx, W = this.canvas.width, H = this.canvas.height, scale = camera.zoom * dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = css(palette.bg);
    ctx.fillRect(0, 0, W, H);
    // Dot grid, coarser when zoomed out (same rule as the WebGPU shader).
    let step = 20;
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
    ctx.setTransform(scale, 0, 0, scale, W / 2 - camera.cx * scale, H / 2 - camera.cy * scale);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const under = this.overlay?.layers.slice(0, 1) ?? [], over = this.overlay?.layers.slice(1) ?? [];
    for (const layer of [...under, ...this.list.layers, ...over]) this.drawLayer(layer, camera.zoom, scale);
  }

  /** @param {import('./displaylist.js').Layer} layer @param {number} zoom @param {number} scale */
  drawLayer(layer, zoom, scale) {
    const ctx = this.ctx;
    const s = layer.shapes;
    for (let i = 0; i < s.length; i += SHAPE_STRIDE) {
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
    for (let i = 0; i < t.length; i += 18) {
      ctx.fillStyle = css(/** @type {RGBA} */ ([...t.subarray(i + 2, i + 6)]));
      ctx.beginPath(); ctx.moveTo(t[i], t[i + 1]); ctx.lineTo(t[i + 6], t[i + 7]); ctx.lineTo(t[i + 12], t[i + 13]); ctx.closePath(); ctx.fill();
    }
    ctx.textBaseline = 'middle';
    for (const tx of layer.texts) {
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

  destroy() { this.list = null; this.overlay = null; }
}
