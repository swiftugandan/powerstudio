/** A time-series chart on Canvas 2D for the stability results: axes with rounded ticks, one line per series, event
 * markers, a hover read-out and a draggable time cursor that drives the diagram. */

import { fixed } from './format.js';

/** @typedef {{ name: string, color: string, data: Float32Array }} Series */

/** Rounded tick positions covering [lo, hi]. @param {number} lo @param {number} hi @param {number} count */
export function ticks(lo, hi, count) {
  const span = hi - lo || 1, raw = span / count, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => span / s <= count) ?? 10 * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return { values: out, step };
}

export class Plot {
  /** @param {HTMLElement} host */
  constructor(host) {
    this.host = host;
    this.canvas = document.createElement('canvas');
    this.tip = document.createElement('div');
    this.tip.className = 'plot-tip';
    this.tip.hidden = true;
    host.append(this.canvas, this.tip);
    /** @type {{ t: Float32Array, series: Series[], unit: string, label?: string, events: number[], cursor: number } | null} */
    this.data = null;
    /** @type {((index: number) => void) | null} */
    this.onCursor = null;
    this.dragging = false;
    this.box = { l: 64, r: 14, t: 12, b: 28 };
    new ResizeObserver(() => this.draw()).observe(host);
    this.canvas.addEventListener('pointermove', e => this.hover(e));
    this.canvas.addEventListener('pointerleave', () => { this.tip.hidden = true; this.draw(); });
    this.canvas.addEventListener('pointerdown', e => { this.dragging = true; this.canvas.setPointerCapture(e.pointerId); this.setCursorFrom(e); });
    this.canvas.addEventListener('pointerup', () => { this.dragging = false; });
  }

  /** @param {{ t: Float32Array, series: Series[], unit: string, label?: string, events: number[], cursor: number }} data */
  set(data) { this.data = data; this.draw(); }

  /** @param {PointerEvent} e */
  indexAt(e) {
    const d = this.data;
    if (!d || !d.t.length) return -1;
    const r = this.canvas.getBoundingClientRect(), w = r.width - this.box.l - this.box.r;
    const t = d.t[0] + (e.clientX - r.left - this.box.l) / w * (d.t[d.t.length - 1] - d.t[0]);
    let lo = 0, hi = d.t.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (d.t[m] < t) lo = m; else hi = m; }
    return Math.abs(d.t[lo] - t) < Math.abs(d.t[hi] - t) ? lo : hi;
  }

  /** @param {PointerEvent} e */
  setCursorFrom(e) {
    const i = this.indexAt(e);
    if (i < 0 || !this.data) return;
    this.data.cursor = i;
    this.onCursor?.(i);
    this.draw();
  }

  /** @param {PointerEvent} e */
  hover(e) {
    if (this.dragging) this.setCursorFrom(e);
    const d = this.data, i = this.indexAt(e);
    if (!d || i < 0) return;
    this.draw(i);
    const r = this.canvas.getBoundingClientRect();
    this.tip.hidden = false;
    this.tip.innerHTML = `<div class="row"><b>t = ${fixed(d.t[i], 3)} s</b></div>` + d.series.slice(0, 12).map(s => `<div class="row"><i style="background:${s.color}"></i>${s.name}: ${fixed(s.data[i], 3)} ${d.unit}</div>`).join('');
    const x = e.clientX - r.left, tw = this.tip.offsetWidth;
    this.tip.style.left = `${x + 14 + tw > r.width ? x - tw - 14 : x + 14}px`;
    this.tip.style.top = '10px';
  }

  /** @param {number} [hoverIndex] */
  draw(hoverIndex = -1) {
    const rect = this.host.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, rect.width), H = Math.max(1, rect.height);
    if (this.canvas.width !== Math.round(W * dpr) || this.canvas.height !== Math.round(H * dpr)) { this.canvas.width = Math.round(W * dpr); this.canvas.height = Math.round(H * dpr); }
    const ctx = /** @type {CanvasRenderingContext2D} */ (this.canvas.getContext('2d'));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cs = getComputedStyle(document.documentElement);
    const ink = cs.getPropertyValue('--text-2').trim(), grid = cs.getPropertyValue('--border').trim(), bg = cs.getPropertyValue('--surface').trim();
    const accent = cs.getPropertyValue('--accent').trim(), warn = cs.getPropertyValue('--warn').trim();
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    const d = this.data;
    if (!d || !d.t.length) return;
    const { l, r, t, b } = this.box, w = W - l - r, hh = H - t - b;
    const t0 = d.t[0], t1 = d.t[d.t.length - 1] || 1;
    let lo = Infinity, hi = -Infinity;
    for (const s of d.series) for (const v of s.data) { if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } }
    if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
    const pad = (hi - lo) * 0.08 || Math.max(Math.abs(hi) * 0.05, 0.01);
    lo -= pad; hi += pad;
    const X = (/** @type {number} */ v) => l + (v - t0) / (t1 - t0) * w, Y = (/** @type {number} */ v) => t + (hi - v) / (hi - lo) * hh;
    ctx.font = `11px ${cs.getPropertyValue('--font')}`;
    ctx.lineWidth = 1;
    const yt = ticks(lo, hi, Math.max(2, Math.floor(hh / 34)));
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const v of yt.values) {
      const y = Math.round(Y(v)) + 0.5;
      ctx.strokeStyle = grid; ctx.beginPath(); ctx.moveTo(l, y); ctx.lineTo(l + w, y); ctx.stroke();
      ctx.fillStyle = ink; ctx.fillText(fixed(v, yt.step < 0.01 ? 4 : yt.step < 0.1 ? 3 : yt.step < 1 ? 2 : yt.step < 10 ? 1 : 0), l - 6, y);
    }
    const xt = ticks(t0, t1, Math.max(2, Math.floor(w / 80)));
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (const v of xt.values) {
      const x = Math.round(X(v)) + 0.5;
      ctx.strokeStyle = grid; ctx.beginPath(); ctx.moveTo(x, t); ctx.lineTo(x, t + hh); ctx.stroke();
      ctx.fillStyle = ink; ctx.fillText(`${fixed(v, xt.step < 0.1 ? 2 : 1)} s`, x, t + hh + 7);
    }
    ctx.save();
    ctx.translate(12, t + hh / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = ink; ctx.fillText(d.label ? `${d.label} (${d.unit})` : d.unit, 0, 0);
    ctx.restore();
    ctx.setLineDash([4, 4]); ctx.strokeStyle = warn;
    for (const et of d.events) { const x = Math.round(X(et)) + 0.5; ctx.beginPath(); ctx.moveTo(x, t); ctx.lineTo(x, t + hh); ctx.stroke(); }
    ctx.setLineDash([]);
    ctx.save();
    ctx.beginPath(); ctx.rect(l, t, w, hh); ctx.clip();
    ctx.lineWidth = 1.6; ctx.lineJoin = 'round';
    for (const s of d.series) {
      ctx.strokeStyle = s.color; ctx.beginPath();
      // Skip points closer than half a pixel apart, keeping the extremes of each pixel column.
      let lastX = -Infinity;
      for (let i = 0; i < s.data.length; i++) {
        const x = X(d.t[i]), y = Y(s.data[i]);
        if (i === 0) ctx.moveTo(x, y); else if (x - lastX >= 0.5 || i === s.data.length - 1) ctx.lineTo(x, y); else continue;
        lastX = x;
      }
      ctx.stroke();
    }
    ctx.restore();
    const ci = d.cursor;
    if (ci >= 0 && ci < d.t.length) {
      const x = Math.round(X(d.t[ci])) + 0.5;
      ctx.strokeStyle = accent; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x, t); ctx.lineTo(x, t + hh); ctx.stroke();
      ctx.fillStyle = accent; ctx.beginPath(); ctx.moveTo(x - 5, t); ctx.lineTo(x + 5, t); ctx.lineTo(x, t + 6); ctx.fill();
    }
    if (hoverIndex >= 0) {
      const x = Math.round(X(d.t[hoverIndex])) + 0.5;
      ctx.strokeStyle = ink; ctx.globalAlpha = 0.5; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, t); ctx.lineTo(x, t + hh); ctx.stroke(); ctx.globalAlpha = 1;
      for (const s of d.series) { ctx.fillStyle = s.color; ctx.beginPath(); ctx.arc(x, Y(s.data[hoverIndex]), 3, 0, Math.PI * 2); ctx.fill(); }
    }
    ctx.strokeStyle = grid; ctx.lineWidth = 1; ctx.strokeRect(l + 0.5, t + 0.5, w - 1, hh - 1);
  }
}

/** Categorical series colours, distinct in both themes. @param {number} i @param {boolean} dark */
export function seriesColor(i, dark) {
  const light = ['#2563c9', '#d1495b', '#1b8a5a', '#b26b00', '#7b4fc9', '#0f8b9c', '#c2417f', '#5c6f1f', '#8a5a3c', '#3d4f7a'];
  const night = ['#6ea2ff', '#ff7b8a', '#4fd08f', '#f0b13c', '#b392ff', '#3ccfdf', '#ff7ab8', '#b7d45a', '#d8a07c', '#9fb3e6'];
  const p = dark ? night : light;
  return p[i % p.length];
}
