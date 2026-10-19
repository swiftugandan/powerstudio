/** A time-series chart on Canvas 2D for the simulation results: axes with rounded ticks, one line per series, event
 * markers and a hover read-out. The stability view adds a draggable time cursor that drives the diagram; the EMT view
 * zooms the time axis instead (the wheel, a dragged range, double-click to fit). Each pixel column draws the extremes
 * of the samples in it, so a waveform of many cycles keeps its peaks at any width. */

import { fixed } from './format.js';
import { setHtml, esc } from './dom.js';

/** @typedef {{ name: string, color: string, data: Float32Array }} Series
 * @typedef {{ t: Float32Array, series: Series[], unit: string, label?: string, events: number[], cursor: number,
 *   timeUnit?: 's' | 'ms', zoomable?: boolean, window?: [number, number] | null }} PlotData `t` in seconds; `timeUnit` how
 *   the axis shows it; `zoomable` turns dragging into a zoom range instead of the time cursor; `window` the times shown. */

/** Rounded tick positions covering [lo, hi]. @param {number} lo @param {number} hi @param {number} count */
export function ticks(lo, hi, count) {
  const span = hi - lo || 1, raw = span / count, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => span / s <= count) ?? 10 * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return { values: out, step };
}

/** Decimals that show a tick step. @param {number} step */
const decimals = step => (step < 0.01 ? 4 : step < 0.1 ? 3 : step < 1 ? 2 : step < 10 ? 1 : 0);

/** The first index whose time is at least `t`. @param {Float32Array} t @param {number} v */
function lowerBound(t, v) {
  let lo = 0, hi = t.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (t[m] < v) lo = m + 1; else hi = m; }
  return lo;
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
    /** @type {PlotData | null} */
    this.data = null;
    /** @type {((index: number) => void) | null} */
    this.onCursor = null;
    /** Called with the times shown after a zoom, or null when the whole run shows. @type {((w: [number, number] | null) => void) | null} */
    this.onZoom = null;
    this.dragging = false;
    /** A zoom range being dragged, in canvas pixels. @type {{ x0: number, x1: number } | null} */
    this.range = null;
    this.box = { l: 64, r: 14, t: 12, b: 28 };
    new ResizeObserver(() => this.draw()).observe(host);
    this.canvas.addEventListener('pointermove', e => this.hover(e));
    this.canvas.addEventListener('pointerleave', () => { this.tip.hidden = true; this.draw(); });
    this.canvas.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      this.dragging = true;
      this.canvas.setPointerCapture(e.pointerId);
      if (this.data?.zoomable) { const x = this.localX(e); this.range = { x0: x, x1: x }; } else this.setCursorFrom(e);
    });
    this.canvas.addEventListener('pointerup', () => {
      this.dragging = false;
      const r = this.range;
      this.range = null;
      if (r && Math.abs(r.x1 - r.x0) > 4) this.zoomTo(this.timeAt(Math.min(r.x0, r.x1)), this.timeAt(Math.max(r.x0, r.x1)));
      else this.draw();
    });
    this.canvas.addEventListener('dblclick', () => { if (this.data?.zoomable) this.zoomTo(null); });
    this.canvas.addEventListener('wheel', e => {
      if (!this.data?.zoomable) return;
      e.preventDefault();
      this.zoomBy(Math.exp(e.deltaY * 0.002), this.timeAt(this.localX(e)));
    }, { passive: false });
  }

  /** @param {PlotData} data */
  set(data) { this.data = data; this.draw(); }

  /** The whole run's times. */
  extent() {
    const t = this.data?.t;
    return t && t.length ? /** @type {[number, number]} */ ([t[0], t[t.length - 1] || 1]) : /** @type {[number, number]} */ ([0, 1]);
  }

  /** The times shown. */
  shown() {
    const [a, b] = this.extent();
    const w = this.data?.window;
    return w ? /** @type {[number, number]} */ ([Math.max(a, w[0]), Math.min(b, w[1])]) : /** @type {[number, number]} */ ([a, b]);
  }

  /** Shows the times from `t0` to `t1`, or the whole run for null. @param {number | null} t0 @param {number} [t1] */
  zoomTo(t0, t1 = 0) {
    const d = this.data;
    if (!d) return;
    const [a, b] = this.extent();
    if (t0 === null) d.window = null;
    else {
      // At least ten samples stay in view.
      const least = d.t.length > 1 ? 10 * (b - a) / (d.t.length - 1) : 0;
      let lo = Math.max(a, t0), hi = Math.min(b, t1);
      if (hi - lo < least) { const mid = (lo + hi) / 2; lo = Math.max(a, mid - least / 2); hi = Math.min(b, lo + least); }
      d.window = lo <= a && hi >= b ? null : [lo, hi];
    }
    this.onZoom?.(d.window ?? null);
    this.draw();
  }

  /** Zooms by `factor` (below 1 zooms in) around time `at`, the middle by default. @param {number} factor @param {number} [at] */
  zoomBy(factor, at) {
    const [lo, hi] = this.shown();
    const c = at ?? (lo + hi) / 2;
    this.zoomTo(c - (c - lo) * factor, c + (hi - c) * factor);
  }

  /** @param {MouseEvent} e */
  localX(e) { return e.clientX - this.canvas.getBoundingClientRect().left; }

  /** The time at canvas x. @param {number} x */
  timeAt(x) {
    const w = this.canvas.getBoundingClientRect().width - this.box.l - this.box.r;
    const [t0, t1] = this.shown();
    return t0 + (x - this.box.l) / w * (t1 - t0);
  }

  /** @param {PointerEvent} e */
  indexAt(e) {
    const d = this.data;
    if (!d || !d.t.length) return -1;
    const t = this.timeAt(this.localX(e));
    const hi = Math.min(d.t.length - 1, lowerBound(d.t, t)), lo = Math.max(0, hi - 1);
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
    if (this.dragging && this.range) { this.range.x1 = this.localX(e); this.draw(); return; }
    if (this.dragging) this.setCursorFrom(e);
    const d = this.data, i = this.indexAt(e);
    if (!d || i < 0) return;
    this.draw(i);
    const r = this.canvas.getBoundingClientRect();
    const ms = d.timeUnit === 'ms';
    this.tip.hidden = false;
    setHtml(this.tip, `<div class="row"><b>t = ${ms ? `${fixed(d.t[i] * 1000, 3)} ms` : `${fixed(d.t[i], 3)} s`}</b></div>`
      + d.series.slice(0, 12).map(s => `<div class="row"><i style="background:${esc(s.color)}"></i>${esc(s.name)}: ${fixed(s.data[i], 3)} ${esc(d.unit)}</div>`).join(''));
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
    const [t0, t1] = this.shown();
    this.host.dataset.shown = `${t0.toFixed(6)} ${t1.toFixed(6)}`;
    // The samples in view, with one either side so lines run to the edges.
    const i0 = Math.max(0, lowerBound(d.t, t0) - 1), i1 = Math.min(d.t.length - 1, lowerBound(d.t, t1));
    let lo = Infinity, hi = -Infinity;
    for (const s of d.series) for (let i = i0; i <= i1; i++) { const v = s.data[i]; if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } }
    if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
    const pad = (hi - lo) * 0.08 || Math.max(Math.abs(hi) * 0.05, 0.01);
    lo -= pad; hi += pad;
    const span = t1 - t0 || 1;
    const X = (/** @type {number} */ v) => l + (v - t0) / span * w, Y = (/** @type {number} */ v) => t + (hi - v) / (hi - lo) * hh;
    ctx.font = `11px ${cs.getPropertyValue('--font')}`;
    ctx.lineWidth = 1;
    const yt = ticks(lo, hi, Math.max(2, Math.floor(hh / 34)));
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const v of yt.values) {
      const y = Math.round(Y(v)) + 0.5;
      ctx.strokeStyle = grid; ctx.beginPath(); ctx.moveTo(l, y); ctx.lineTo(l + w, y); ctx.stroke();
      ctx.fillStyle = ink; ctx.fillText(fixed(v, decimals(yt.step)), l - 6, y);
    }
    const scale = d.timeUnit === 'ms' ? 1000 : 1, unit = d.timeUnit === 'ms' ? 'ms' : 's';
    const xt = ticks(t0 * scale, t1 * scale, Math.max(2, Math.floor(w / 80)));
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (const v of xt.values) {
      const x = Math.round(X(v / scale)) + 0.5;
      ctx.strokeStyle = grid; ctx.beginPath(); ctx.moveTo(x, t); ctx.lineTo(x, t + hh); ctx.stroke();
      // A label at either end of the axis stays inside the canvas.
      const text = `${fixed(v, Math.min(decimals(xt.step), 3))} ${unit}`, half = ctx.measureText(text).width / 2;
      ctx.fillStyle = ink; ctx.fillText(text, Math.min(Math.max(x, half + 2), W - half - 2), t + hh + 7);
    }
    ctx.save();
    ctx.translate(12, t + hh / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = ink; ctx.fillText(d.label ? `${d.label} (${d.unit})` : d.unit, 0, 0);
    ctx.restore();
    ctx.save();
    ctx.beginPath(); ctx.rect(l, t, w, hh); ctx.clip();
    ctx.setLineDash([4, 4]); ctx.strokeStyle = warn;
    for (const et of d.events) { if (et < t0 || et > t1) continue; const x = Math.round(X(et)) + 0.5; ctx.beginPath(); ctx.moveTo(x, t); ctx.lineTo(x, t + hh); ctx.stroke(); }
    ctx.setLineDash([]);
    ctx.lineWidth = 1.6; ctx.lineJoin = 'round';
    for (const s of d.series) {
      ctx.strokeStyle = s.color; ctx.beginPath();
      // One pixel column at a time: a column with several samples draws from its first through its extremes to its
      // last, so peaks survive however many samples share a column.
      let col = NaN, first = 0, last = 0, mn = 0, mx = 0, n = 0, started = false;
      const flush = () => {
        if (!n) return;
        const x = col + 0.5;
        if (!started) { ctx.moveTo(x, Y(first)); started = true; } else ctx.lineTo(x, Y(first));
        if (n > 1) { ctx.lineTo(x, Y(mn)); ctx.lineTo(x, Y(mx)); ctx.lineTo(x, Y(last)); }
      };
      for (let i = i0; i <= i1; i++) {
        const v = s.data[i];
        if (!Number.isFinite(v)) continue;
        const c = Math.floor(X(d.t[i]));
        if (c !== col) { flush(); col = c; first = v; mn = v; mx = v; n = 0; }
        if (v < mn) mn = v;
        if (v > mx) mx = v;
        last = v; n++;
      }
      flush();
      ctx.stroke();
    }
    ctx.restore();
    const ci = d.cursor;
    if (!d.zoomable && ci >= 0 && ci < d.t.length && d.t[ci] >= t0 && d.t[ci] <= t1) {
      const x = Math.round(X(d.t[ci])) + 0.5;
      ctx.strokeStyle = accent; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x, t); ctx.lineTo(x, t + hh); ctx.stroke();
      ctx.fillStyle = accent; ctx.beginPath(); ctx.moveTo(x - 5, t); ctx.lineTo(x + 5, t); ctx.lineTo(x, t + 6); ctx.fill();
    }
    if (hoverIndex >= 0) {
      const x = Math.round(X(d.t[hoverIndex])) + 0.5;
      ctx.strokeStyle = ink; ctx.globalAlpha = 0.5; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, t); ctx.lineTo(x, t + hh); ctx.stroke(); ctx.globalAlpha = 1;
      for (const s of d.series) { ctx.fillStyle = s.color; ctx.beginPath(); ctx.arc(x, Y(s.data[hoverIndex]), 3, 0, Math.PI * 2); ctx.fill(); }
    }
    if (this.range) {
      const a = Math.max(l, Math.min(this.range.x0, this.range.x1)), z = Math.min(l + w, Math.max(this.range.x0, this.range.x1));
      ctx.fillStyle = accent; ctx.globalAlpha = 0.14; ctx.fillRect(a, t, z - a, hh); ctx.globalAlpha = 1;
      ctx.strokeStyle = accent; ctx.lineWidth = 1; ctx.strokeRect(Math.round(a) + 0.5, t + 0.5, Math.round(z - a), hh - 1);
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
