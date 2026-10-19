/** A ranked bar chart on Canvas 2D for the load-flow and short-circuit results: one bar per element, grown from a
 * baseline (zero, or 1 p.u. for voltages), with reference lines, a limit band, the values of a compared run, a hover
 * read-out and keyboard navigation. It draws in the same visual language as the stability plot (`plot.js`): the same
 * tokens, ticks, font and read-out.
 *
 * More bars than pixel columns are binned: each column shows the bar of its element furthest from the baseline, so a
 * peak or a dip is never lost however many elements there are. */

import { fixed } from './format.js';
import { setHtml, esc, h } from './dom.js';
import { ticks } from './plot.js';

/**
 * @typedef {import('../render/displaylist.js').RGBA} RGBA
 * @typedef {{ id: string, name: string, value: number, color: RGBA, lo?: number, hi?: number, ref?: number, detail?: string[] }} Bar
 *   `lo` and `hi` are the element's own limits; `ref` its value in a compared run; `detail` more lines for the read-out.
 * @typedef {{ value: number, label: string, tone: 'warn' | 'bad' | 'muted' }} RefLine
 * @typedef {{ bars: Bar[], label: string, unit: string, digits: number, base: number, lines?: RefLine[], refName?: string,
 *   limitName?: string, title: string, selected: Set<string> }} ChartData
 */

/** Widest bar, in CSS pixels; fewer elements than that fills leave space either side. */
const MAX_BAR = 44;
/** Columns narrower than this bin several elements each. */
const MIN_COLUMN = 2;

/**
 * Which element each pixel column shows when there are more elements than columns: of the elements falling in a
 * column, the one furthest from the baseline (missing values never win).
 * @param {ArrayLike<number>} values @param {number} base @param {number} columns @returns {Int32Array} element index per column, -1 for none
 */
export function binExtremes(values, base, columns) {
  const n = values.length, out = new Int32Array(Math.max(0, columns)).fill(-1);
  if (!n || columns <= 0) return out;
  for (let i = 0; i < n; i++) {
    const c = Math.min(columns - 1, Math.floor(i * columns / n)), v = values[i];
    if (!Number.isFinite(v)) continue;
    const k = out[c];
    if (k < 0 || Math.abs(v - base) > Math.abs(values[k] - base)) out[c] = i;
  }
  return out;
}

/**
 * The value range the axis covers: the bars, the baseline, the reference lines, the limits and the compared values,
 * with a margin. A range with no extent gets one, so a single value still draws.
 * @param {ChartData} d @returns {{ lo: number, hi: number }}
 */
export function valueRange(d) {
  let lo = d.base, hi = d.base;
  const take = (/** @type {number | undefined} */ v) => { if (v !== undefined && Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } };
  for (const b of d.bars) { take(b.value); take(b.ref); take(b.lo); take(b.hi); }
  for (const l of d.lines ?? []) take(l.value);
  const pad = (hi - lo) * 0.08 || Math.max(Math.abs(hi) * 0.05, 0.01);
  // A baseline at the edge of the range stays there: bars grow from the axis rather than from inside the margin.
  return { lo: lo === d.base && d.base === 0 ? 0 : lo - pad, hi: hi + pad };
}

/** The shared limits of every bar, when they all have the same ones. @param {Bar[]} bars */
export function commonLimits(bars) {
  if (!bars.length) return null;
  const { lo, hi } = bars[0];
  if (lo === undefined || hi === undefined) return null;
  return bars.every(b => b.lo === lo && b.hi === hi) ? { lo, hi } : null;
}

/** @param {RGBA} c @param {number} [alpha] */
const css = (c, alpha = 1) => `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${c[3] * alpha})`;

export class BarChart {
  /** @param {HTMLElement} host */
  constructor(host) {
    this.host = host;
    // The canvas takes the keyboard: arrows move between bars, Enter selects one. The live region reads them out.
    this.canvas = h('canvas', { tabindex: '0', role: 'application', 'aria-roledescription': 'bar chart' });
    this.tip = h('div', { class: 'plot-tip', hidden: true });
    this.live = h('div', { class: 'visually-hidden', 'aria-live': 'polite' });
    host.append(this.canvas, this.tip, this.live);
    /** @type {ChartData | null} */
    this.data = null;
    /** Called with a bar's element when it is clicked or chosen with the keyboard. @type {((id: string, e: MouseEvent | KeyboardEvent) => void) | null} */
    this.onPick = null;
    /** The bar the keyboard is on, and the one under the pointer. */
    this.focus = -1;
    this.hoverAt = -1;
    this.box = { l: 64, r: 14, t: 12, b: 28 };
    /** Pixel columns to elements, when binned. @type {Int32Array | null} */
    this.bins = null;
    new ResizeObserver(() => this.draw()).observe(host);
    this.canvas.addEventListener('pointermove', e => this.hover(e));
    this.canvas.addEventListener('pointerleave', () => { this.hoverAt = -1; this.tip.hidden = true; this.draw(); });
    this.canvas.addEventListener('click', e => { const i = this.indexAt(e.clientX); if (i >= 0 && this.data) { this.focus = i; this.onPick?.(this.data.bars[i].id, e); } });
    this.canvas.addEventListener('keydown', e => this.key(e));
    // A click focuses the canvas too, and picks its own bar; only the keyboard arriving starts on the first bar.
    this.canvas.addEventListener('focus', () => { if (this.focus < 0 && this.data?.bars.length && this.keyboard()) this.moveTo(0); else this.draw(); });
    this.canvas.addEventListener('blur', () => { this.tip.hidden = true; this.draw(); });
  }

  /** @param {ChartData} data @param {string} [focusId] the element the keyboard stays on */
  set(data, focusId) {
    this.data = data;
    const at = focusId ? data.bars.findIndex(b => b.id === focusId) : -1;
    this.focus = at >= 0 ? at : Math.min(this.focus, data.bars.length - 1);
    this.canvas.setAttribute('aria-label', `${data.title}. Arrow keys move between bars, Enter selects one.`);
    this.draw();
  }

  /** Whether the canvas has the focus from the keyboard. */
  keyboard() { return this.canvas.matches(':focus-visible'); }

  /** The element the keyboard is on. */
  focusedId() { return this.data && this.focus >= 0 ? this.data.bars[this.focus]?.id : undefined; }

  /** @param {KeyboardEvent} e */
  key(e) {
    const n = this.data?.bars.length ?? 0;
    if (!n) return;
    const page = Math.max(1, Math.round(n / 10));
    const to = { ArrowRight: this.focus + 1, ArrowDown: this.focus + 1, ArrowLeft: this.focus - 1, ArrowUp: this.focus - 1,
      PageDown: this.focus + page, PageUp: this.focus - page, Home: 0, End: n - 1 }[e.key];
    if (to !== undefined) { e.preventDefault(); this.moveTo(Math.max(0, Math.min(n - 1, to))); return; }
    if ((e.key === 'Enter' || e.key === ' ') && this.focus >= 0 && this.data) { e.preventDefault(); this.onPick?.(this.data.bars[this.focus].id, e); }
  }

  /** Puts the keyboard on a bar and reads it out. @param {number} i */
  moveTo(i) {
    const d = this.data;
    if (!d) return;
    this.focus = i;
    const b = d.bars[i];
    this.live.textContent = `${b.name}: ${this.format(b.value)}, ${i + 1} of ${d.bars.length}`;
    this.draw();
    this.showTip(i, this.columnX(i));
  }

  /** @param {number} v */
  format(v) { const d = /** @type {ChartData} */ (this.data); return Number.isFinite(v) ? `${fixed(v, d.digits)} ${d.unit}`.trim() : '—'; }

  /** The plot area's width, and each element's column width in it. */
  geometry() {
    const r = this.canvas.getBoundingClientRect(), w = Math.max(1, r.width - this.box.l - this.box.r);
    return { r, w, col: w / Math.max(1, this.data?.bars.length ?? 1) };
  }

  /** The centre of an element's column, in CSS pixels from the canvas's left edge. @param {number} i */
  columnX(i) { return columnCentre(i, this.box.l, this.geometry().w, this.data?.bars.length ?? 1); }

  /** The element under a pointer, or -1. @param {number} clientX */
  indexAt(clientX) {
    const d = this.data;
    if (!d || !d.bars.length) return -1;
    const { r, w, col } = this.geometry(), x = clientX - r.left - this.box.l;
    if (x < 0 || x >= w) return -1;
    if (col >= MIN_COLUMN) return Math.min(d.bars.length - 1, Math.floor(x / col));
    const k = this.bins?.[Math.floor(x)] ?? -1;
    return k >= 0 ? k : Math.min(d.bars.length - 1, Math.floor(x / w * d.bars.length));
  }

  /** @param {PointerEvent} e */
  hover(e) {
    const i = this.indexAt(e.clientX);
    if (i !== this.hoverAt) { this.hoverAt = i; this.draw(); }
    if (i < 0) { this.tip.hidden = true; return; }
    this.showTip(i, e.clientX - this.canvas.getBoundingClientRect().left);
  }

  /** The read-out of one bar, beside x. @param {number} i @param {number} x */
  showTip(i, x) {
    const d = this.data;
    if (!d) return;
    const b = d.bars[i];
    const rows = [`<div class="row"><b>${esc(b.name)}</b></div>`, `<div class="row"><i style="background:${css(b.color)}"></i>${esc(d.label)}: ${esc(this.format(b.value))}</div>`];
    if (b.ref !== undefined) {
      const diff = b.value - b.ref;
      rows.push(`<div class="row">${esc(d.refName ?? 'Compared')}: ${esc(this.format(b.ref))}${Number.isFinite(diff) ? ` (${diff >= 0 ? '+' : ''}${esc(fixed(diff, d.digits))})` : ''}</div>`);
    }
    if (b.lo !== undefined && b.hi !== undefined) rows.push(`<div class="row">${esc(d.limitName ?? 'Limits')}: ${esc(fixed(b.lo, d.digits))} … ${esc(this.format(b.hi))}</div>`);
    for (const line of b.detail ?? []) rows.push(`<div class="row">${esc(line)}</div>`);
    setHtml(this.tip, rows.join(''));
    this.tip.hidden = false;
    const W = this.canvas.getBoundingClientRect().width, tw = this.tip.offsetWidth;
    this.tip.style.left = `${Math.max(4, x + 14 + tw > W ? x - tw - 14 : x + 14)}px`;
    this.tip.style.top = '10px';
  }

  draw() {
    const rect = this.host.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, rect.width), H = Math.max(1, rect.height);
    if (this.canvas.width !== Math.round(W * dpr) || this.canvas.height !== Math.round(H * dpr)) { this.canvas.width = Math.round(W * dpr); this.canvas.height = Math.round(H * dpr); }
    const ctx = /** @type {CanvasRenderingContext2D} */ (this.canvas.getContext('2d'));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cs = getComputedStyle(document.documentElement), tok = (/** @type {string} */ n) => cs.getPropertyValue(n).trim();
    const ink = tok('--text-2'), text = tok('--text'), grid = tok('--border'), bg = tok('--surface'), accent = tok('--accent'), soft = tok('--accent-soft'), hoverBg = tok('--hover');
    const tones = { warn: tok('--warn'), bad: tok('--danger'), muted: tok('--text-3') };
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    const d = this.data;
    if (!d || !d.bars.length) return;
    const font = tok('--font');
    ctx.font = `11px ${font}`;
    const n = d.bars.length;
    // The reference lines and the limit band are named in the right margin, which is as wide as their names.
    const band = commonLimits(d.bars);
    const marks = [...(d.lines ?? []).map(x => ({ value: x.value, label: x.label, color: tones[x.tone] })),
      ...(band ? [{ value: (band.lo + band.hi) / 2, label: d.limitName ?? 'Limits', color: tones.muted }] : [])];
    this.box.r = marks.length ? Math.ceil(Math.max(...marks.map(m => ctx.measureText(m.label).width))) + 14 : 14;
    const { l, r, t } = this.box, w = Math.max(1, W - l - r);
    const col = w / n, binned = col < MIN_COLUMN;
    // Names under the bars when there is room for them, slanted, as many as fit side by side.
    const showNames = H >= 170 && !binned;
    let longest = 0;
    if (showNames) for (const x of d.bars) longest = Math.max(longest, ctx.measureText(x.name).width);
    longest = Math.min(110, longest);
    this.box.b = showNames ? Math.min(Math.round(H * 0.4), Math.ceil(16 + longest * Math.SQRT1_2)) : 22;
    const hh = Math.max(1, H - t - this.box.b);
    const range = valueRange(d);
    const Y = (/** @type {number} */ v) => t + (range.hi - v) / (range.hi - range.lo) * hh;
    this.bins = binned ? binExtremes(d.bars.map(x => x.value), d.base, Math.floor(w)) : null;
    // Value axis: rounded ticks with grid lines, and its title.
    const yt = ticks(range.lo, range.hi, Math.max(2, Math.floor(hh / 34)));
    const digits = yt.step < 0.01 ? 4 : yt.step < 0.1 ? 3 : yt.step < 1 ? 2 : yt.step < 10 ? 1 : 0;
    ctx.lineWidth = 1; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const v of yt.values) {
      const y = Math.round(Y(v)) + 0.5;
      ctx.strokeStyle = grid; ctx.beginPath(); ctx.moveTo(l, y); ctx.lineTo(l + w, y); ctx.stroke();
      ctx.fillStyle = ink; ctx.fillText(fixed(v, digits), l - 6, y);
    }
    ctx.save();
    ctx.translate(12, t + hh / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.fillStyle = ink;
    ctx.fillText(d.unit ? `${d.label} (${d.unit})` : d.label, 0, 0);
    ctx.restore();
    // The shared limit band, shaded, when every element has the same limits.
    if (band) {
      ctx.fillStyle = soft;
      const y0 = Y(band.hi), y1 = Y(band.lo);
      ctx.fillRect(l, y0, w, y1 - y0);
    }
    // The selection, the hovered column and the keyboard's bar sit behind the bars.
    const span = (/** @type {number} */ i) => binned ? { x: l + Math.floor(i * w / n), cw: 1 } : { x: l + i * col, cw: col };
    if (!binned) {
      for (let i = 0; i < n; i++) if (d.selected.has(d.bars[i].id)) { const s = span(i); ctx.fillStyle = soft; ctx.fillRect(s.x, t, s.cw, hh); }
      if (this.hoverAt >= 0) { const s = span(this.hoverAt); ctx.fillStyle = hoverBg; ctx.fillRect(s.x, t, s.cw, hh); }
    }
    ctx.save();
    ctx.beginPath(); ctx.rect(l, t, w, hh); ctx.clip();
    const y0 = Y(d.base);
    if (binned) {
      const bins = /** @type {Int32Array} */ (this.bins);
      for (let c = 0; c < bins.length; c++) {
        const k = bins[c];
        if (k < 0) continue;
        const y = Y(d.bars[k].value);
        ctx.fillStyle = css(d.bars[k].color);
        ctx.fillRect(l + c, Math.min(y, y0), 1, Math.max(1, Math.abs(y - y0)));
      }
    } else {
      const bw = Math.min(MAX_BAR, col > 8 ? col * 0.72 : Math.max(1, col - 1));
      for (let i = 0; i < n; i++) {
        const bar = d.bars[i];
        if (!Number.isFinite(bar.value)) continue;
        const x = l + i * col + (col - bw) / 2, y = Y(bar.value);
        ctx.fillStyle = css(bar.color);
        ctx.fillRect(x, Math.min(y, y0), bw, Math.max(1, Math.abs(y - y0)));
        // Each element's own limits as ticks, when they differ between elements and the bars are wide enough.
        if (!band && bw >= 6 && bar.lo !== undefined && bar.hi !== undefined) {
          ctx.strokeStyle = ink; ctx.lineWidth = 1.5;
          for (const v of [bar.lo, bar.hi]) { const yy = Math.round(Y(v)) + 0.5; ctx.beginPath(); ctx.moveTo(x - 2, yy); ctx.lineTo(x + bw + 2, yy); ctx.stroke(); }
        }
        // The compared run's value, as a line across the bar.
        if (bar.ref !== undefined && Number.isFinite(bar.ref)) {
          const yr = Math.round(Y(bar.ref)) + 0.5;
          ctx.strokeStyle = text; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x - 3, yr); ctx.lineTo(x + bw + 3, yr); ctx.stroke();
        }
      }
    }
    ctx.restore();
    // The baseline, then the reference lines with their labels at the right end.
    ctx.strokeStyle = ink; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(l, Math.round(y0) + 0.5); ctx.lineTo(l + w, Math.round(y0) + 0.5); ctx.stroke();
    for (const line of d.lines ?? []) {
      const y = Math.round(Y(line.value)) + 0.5;
      ctx.strokeStyle = tones[line.tone]; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(l, y); ctx.lineTo(l + w, y); ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    for (const m of spread(marks.map(x => ({ ...x, y: Y(x.value) })), 13, t + 6, t + hh - 6)) { ctx.fillStyle = m.color; ctx.fillText(m.label, l + w + 6, m.y); }
    // Selected elements: a mark under the axis, which reads in a binned chart too.
    ctx.fillStyle = accent;
    for (let i = 0; i < n; i++) {
      if (!d.selected.has(d.bars[i].id)) continue;
      const x = columnCentre(i, l, w, n);
      ctx.beginPath(); ctx.moveTo(x - 5, t + hh + 6); ctx.lineTo(x + 5, t + hh + 6); ctx.lineTo(x, t + hh); ctx.fill();
    }
    // Names, slanted, every k-th when they would overlap.
    if (showNames && !binned) {
      const every = Math.max(1, Math.ceil(14 / col));
      ctx.fillStyle = ink; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      const room = (this.box.b - 16) * Math.SQRT2 + 1;
      for (let i = 0; i < n; i += every) {
        const x = l + (i + 0.5) * col;
        ctx.save(); ctx.translate(x, t + hh + 9); ctx.rotate(-Math.PI / 4);
        ctx.fillText(clip(ctx, d.bars[i].name, room), 0, 0);
        ctx.restore();
      }
    } else if (binned) {
      ctx.fillStyle = ink; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      const most = d.base === 0 ? 'the highest value' : `the value furthest from ${fixed(d.base, 2)} ${d.unit}`;
      ctx.fillText(`${n} elements: each column shows ${most} among its elements`, l, t + hh + 7);
    }
    // The keyboard's bar, while the chart has the focus.
    if (this.focus >= 0 && this.focus < n && this.keyboard()) {
      const s = span(this.focus);
      ctx.strokeStyle = accent; ctx.lineWidth = 2; ctx.strokeRect(Math.round(s.x) + 1, t + 1, Math.max(2, Math.round(s.cw) - 2), hh - 2);
    }
    ctx.strokeStyle = grid; ctx.lineWidth = 1; ctx.strokeRect(l + 0.5, t + 0.5, w - 1, hh - 1);
  }
}

/** The centre of an element's column, binned or not. @param {number} i @param {number} l @param {number} w @param {number} n */
function columnCentre(i, l, w, n) { const col = w / n; return col >= MIN_COLUMN ? l + (i + 0.5) * col : l + Math.floor(i * w / n) + 0.5; }

/**
 * Labels at heights `y`, moved apart to at least `gap` from each other within [top, bottom], in order.
 * @template {{ y: number }} T @param {T[]} items @param {number} gap @param {number} top @param {number} bottom @returns {T[]}
 */
export function spread(items, gap, top, bottom) {
  const out = items.map(x => ({ ...x })).sort((a, b) => a.y - b.y);
  for (let i = 0; i < out.length; i++) out[i].y = Math.max(out[i].y, top, i ? out[i - 1].y + gap : -Infinity);
  for (let i = out.length - 1; i >= 0; i--) out[i].y = Math.min(out[i].y, i < out.length - 1 ? out[i + 1].y - gap : bottom, bottom);
  return out;
}

/** Text cut to a width with an ellipsis. @param {CanvasRenderingContext2D} ctx @param {string} s @param {number} width */
function clip(ctx, s, width) {
  if (ctx.measureText(s).width <= width) return s;
  let lo = 0, hi = s.length;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ctx.measureText(`${s.slice(0, m)}…`).width <= width) lo = m; else hi = m; }
  return `${s.slice(0, lo)}…`;
}
