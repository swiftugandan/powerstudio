/** Snapping for the diagram's drags (docs/design/CAD.md, section 6.1).
 *
 * A drag proposes a position; the snapper returns where it lands and the guides that say why. In order of
 * precedence: alignment with the busbars on screen (a moved bar's start, centre or end lines up with another bar's,
 * on either axis, within a few screen pixels), the preferred points a gesture offers (a connection lined up with the
 * far end of its branch, the bar's centre), then the grid. With Alt held, nothing snaps and positions are whole units.
 * No DOM access, so Node tests run it directly. */

import { bar, attachPoint } from '../render/geometry.js';

/**
 * @typedef {import('../core/catalog.js').Element} Element
 * @typedef {{ x: number, y: number }} Point
 * @typedef {{ x0: number, y0: number, x1: number, y1: number }} Rect
 * @typedef {{ kind: 'line', x0: number, y0: number, x1: number, y1: number } | { kind: 'point', x: number, y: number }} Guide
 *   a dashed alignment line, or a marker on a point snapped to
 * @typedef {{ v: number, at: number }} Line a reference line at `v` on one axis, through a bar at `at` on the other
 */

/** The grid steps a user can choose, in world units. */
export const GRIDS = Object.freeze([10, 20, 40]);
/** How close, in screen pixels, a position must come to a line or point to snap to it. */
export const TOLERANCE_PX = 6;
/** How far an alignment guide reaches past the bars it joins. */
const OVERHANG = 24;

/** @param {number} v @param {number} step */
const toGrid = (v, step) => Math.round(v / step) * step;

/** The start, centre and end lines of a bar on each axis, and the point a guide through it passes. @param {Element} bus */
function linesOf(bus) {
  const g = bar(bus), cx = (g.x0 + g.x1) / 2, cy = (g.y0 + g.y1) / 2;
  return { xs: [...new Set([g.x0, cx, g.x1])], ys: [...new Set([g.y0, cy, g.y1])], cx, cy };
}

/** The line nearest to any of `values` within `tol`, as the shift that reaches it and the line. @param {Line[]} lines
 * @param {number[]} values @param {number} tol @returns {{ shift: number, line: Line, from: number } | null} */
function nearest(lines, values, tol) {
  /** @type {{ shift: number, line: Line, from: number } | null} */
  let best = null;
  for (const v of values) {
    // Lines are sorted: look only at those within the tolerance.
    let lo = 0, hi = lines.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (lines[m].v < v - tol) lo = m + 1; else hi = m; }
    for (let i = lo; i < lines.length && lines[i].v <= v + tol; i++) {
      const shift = lines[i].v - v;
      if (!best || Math.abs(shift) < Math.abs(best.shift) - 1e-9) best = { shift, line: lines[i], from: v };
    }
  }
  return best;
}

export class Snapper {
  /**
   * @param {Element[]} buses the busbars that may be snapped to: those on screen, without the ones being moved
   * @param {{ grid: number, zoom: number }} opt the grid step and the zoom (tolerances are in screen pixels)
   */
  constructor(buses, opt) {
    this.grid = opt.grid;
    this.tol = TOLERANCE_PX / opt.zoom;
    /** Vertical lines (constant x) and horizontal lines (constant y). @type {Line[]} */
    this.xs = [];
    /** @type {Line[]} */
    this.ys = [];
    for (const b of buses) {
      const l = linesOf(b);
      for (const v of l.xs) this.xs.push({ v, at: l.cy });
      for (const v of l.ys) this.ys.push({ v, at: l.cx });
    }
    this.xs.sort((a, b) => a.v - b.v);
    this.ys.sort((a, b) => a.v - b.v);
  }

  /**
   * A rigid move of busbars by (dx, dy): the first bar's centre lands on the grid unless a bar's start, centre or end
   * lines up with another bar's. @param {Element[]} moving the bars as they were before the drag, the one under the
   * pointer first @param {number} dx @param {number} dy @param {boolean} free Alt: no snapping
   * @returns {{ dx: number, dy: number, guides: Guide[] }}
   */
  move(moving, dx, dy, free) {
    if (free || !moving.length) return { dx: Math.round(dx), dy: Math.round(dy), guides: [] };
    const lines = moving.map(linesOf), first = /** @type {Element} */ (moving[0]);
    /** @type {Guide[]} */
    const guides = [];
    const ax = nearest(this.xs, lines.flatMap(l => l.xs.map(v => v + dx)), this.tol);
    const ay = nearest(this.ys, lines.flatMap(l => l.ys.map(v => v + dy)), this.tol);
    const sx = ax ? dx + ax.shift : toGrid(/** @type {number} */ (first.x) + dx, this.grid) - /** @type {number} */ (first.x);
    const sy = ay ? dy + ay.shift : toGrid(/** @type {number} */ (first.y) + dy, this.grid) - /** @type {number} */ (first.y);
    if (ax) {
      const ats = [ax.line.at, ...lines.map(l => l.cy + sy)];
      guides.push({ kind: 'line', x0: ax.line.v, y0: Math.min(...ats) - OVERHANG, x1: ax.line.v, y1: Math.max(...ats) + OVERHANG });
    }
    if (ay) {
      const ats = [ay.line.at, ...lines.map(l => l.cx + sx)];
      guides.push({ kind: 'line', x0: Math.min(...ats) - OVERHANG, y0: ay.line.v, x1: Math.max(...ats) + OVERHANG, y1: ay.line.v });
    }
    return { dx: sx, dy: sy, guides };
  }

  /**
   * A bar end dragged to `v` along the bar's axis: it lines up with another bar's start, centre or end, or lands on
   * the grid. @param {Element} bus @param {number} v @param {boolean} free @returns {{ v: number, guides: Guide[] }}
   */
  end(bus, v, free) {
    if (free) return { v: Math.round(v), guides: [] };
    const horizontal = bus.orient !== 'v', g = bar(bus);
    const hit = nearest(horizontal ? this.xs : this.ys, [v], this.tol);
    if (!hit) return { v: toGrid(v, this.grid), guides: [] };
    const across = horizontal ? g.y0 : g.x0, lo = Math.min(across, hit.line.at) - OVERHANG, hi = Math.max(across, hit.line.at) + OVERHANG;
    return {
      v: hit.line.v,
      guides: [horizontal ? { kind: 'line', x0: hit.line.v, y0: lo, x1: hit.line.v, y1: hi } : { kind: 'line', x0: lo, y0: hit.line.v, x1: hi, y1: hit.line.v }],
    };
  }

  /**
   * A point for a new busbar's centre: in line with a bar on screen on either axis, or on the grid.
   * @param {Point} p @param {boolean} free @returns {{ p: Point, guides: Guide[] }}
   */
  point(p, free) {
    if (free) return { p: { x: Math.round(p.x), y: Math.round(p.y) }, guides: [] };
    const ax = nearest(this.xs, [p.x], this.tol), ay = nearest(this.ys, [p.y], this.tol);
    const x = ax ? ax.line.v : toGrid(p.x, this.grid), y = ay ? ay.line.v : toGrid(p.y, this.grid);
    /** @type {Guide[]} */
    const guides = [];
    if (ax) guides.push({ kind: 'line', x0: x, y0: Math.min(y, ax.line.at) - OVERHANG, x1: x, y1: Math.max(y, ax.line.at) + OVERHANG });
    if (ay) guides.push({ kind: 'line', x0: Math.min(x, ay.line.at) - OVERHANG, y0: y, x1: Math.max(x, ay.line.at) + OVERHANG, y1: y });
    return { p: { x, y }, guides };
  }

  /**
   * A position along a bar (−0.5 … 0.5) for a connection dragged to `p`: one of the preferred points (a point in line
   * with the far end of the connection's branch, then the bar's centre) when within reach, else a 10-unit step.
   * @param {Element} bus @param {Point} p @param {boolean} free @param {Point[]} [prefer] points in world units
   * @returns {{ pos: number, guides: Guide[] }}
   */
  along(bus, p, free, prefer = []) {
    const len = /** @type {number} */ (bus.len), horizontal = bus.orient !== 'v';
    const origin = horizontal ? /** @type {number} */ (bus.x) : /** @type {number} */ (bus.y);
    const d = Math.max(-len / 2, Math.min(len / 2, (horizontal ? p.x : p.y) - origin));
    const pos = (/** @type {number} */ along) => Math.round(Math.max(-0.5, Math.min(0.5, along / len)) * 1000) / 1000;
    if (free) return { pos: pos(Math.round(d)), guides: [] };
    for (const q of [...prefer, attachPoint(bus, 0)]) {
      const qd = (horizontal ? q.x : q.y) - origin;
      if (Math.abs(qd) > len / 2 + 1e-9 || Math.abs(qd - d) > this.tol) continue;
      const on = attachPoint(bus, qd / len), far = q.x !== on.x || q.y !== on.y;
      return { pos: pos(qd), guides: far ? [{ kind: 'line', x0: on.x, y0: on.y, x1: q.x, y1: q.y }, { kind: 'point', x: on.x, y: on.y }] : [{ kind: 'point', x: on.x, y: on.y }] };
    }
    return { pos: pos(Math.round(d / 10) * 10), guides: [] };
  }
}

/**
 * The busbars a snapper should consider: those inside a world rectangle (the view), without some.
 * @param {Element[]} elements @param {Rect} view @param {Set<string>} [without] @returns {Element[]}
 */
export function busesIn(elements, view, without = new Set()) {
  const out = [];
  for (const el of elements) {
    if (el.cls !== 'bus' || without.has(el.id)) continue;
    const g = bar(el);
    if (g.x1 >= view.x0 && g.x0 <= view.x1 && g.y1 >= view.y0 && g.y0 <= view.y1) out.push(el);
  }
  return out;
}
