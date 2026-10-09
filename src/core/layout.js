/** Automatic single-line diagram layout for networks that arrive without one (imports, "Arrange").
 *
 * Busbars are placed by a deterministic force-directed method (Fruchterman and Reingold, 1991) started from a
 * breadth-first layering, then snapped to the drawing grid and pushed apart until no two bars overlap. Branch ends and
 * single-port elements are then spread along each bar so that connections do not sit on top of each other.
 *
 * Above LARGE busbars the two steps that compare every pair of bars change: repulsion is cut off beyond a few ideal
 * edge lengths and found through a grid of cells (Fruchterman and Reingold's own grid variant), and instead of pushing
 * overlapping bars apart pass by pass, the bars are packed into rows: taken top to bottom from the force layout, rows of
 * equal length sized so the drawing is about half again as wide as it is tall, each row in its left-to-right order.
 * Neighbours stay near each other and no two bars can overlap. Smaller networks keep the exact all-pairs method. */

import { busesOf } from './document.js';

/** @typedef {import('./document.js').PowerDocument} PowerDocument @typedef {import('./catalog.js').Element} Element */

export const GRID = 20;
const SPACING = 240;
/** Busbars above which the layout uses cell grids instead of all pairs. */
const LARGE = 400;

/** Arranges every busbar and connection in the document in place. @param {PowerDocument} doc */
export function autoLayout(doc) {
  const buses = doc.elements.filter(e => e.cls === 'bus');
  const n = buses.length;
  if (!n) return;
  const index = new Map(buses.map((b, i) => [b.id, i]));
  /** @type {Array<[number, number]>} */
  const edges = [];
  for (const el of doc.elements) {
    if (el.cls !== 'line' && el.cls !== 'trafo') continue;
    const [a, b] = busesOf(el).map(id => /** @type {number} */ (index.get(id)));
    if (a !== b) edges.push([a, b]);
  }
  const adj = Array.from({ length: n }, () => /** @type {number[]} */ ([]));
  for (const [a, b] of edges) { adj[a].push(b); adj[b].push(a); }

  // Breadth-first layers from the best-connected source give a stable, readable start.
  const sources = new Set(doc.elements.filter(e => e.cls === 'extgrid' || (e.cls === 'gen' && e.mode === 'Reference')).map(e => index.get(/** @type {string} */ (e.bus))));
  const layer = new Int32Array(n).fill(-1);
  /** @type {number[][]} */
  const layers = [];
  const order = [...sources].filter(s => s !== undefined);
  for (;;) {
    let start = order.find(s => layer[s] === -1);
    if (start === undefined) start = layer.indexOf(-1);
    if (start < 0) break;
    layer[start] = layers.length;
    const queue = [start];
    for (let head = 0; head < queue.length; head++) {
      const i = queue[head];
      (layers[layer[i]] ??= []).push(i);
      for (const j of adj[i]) if (layer[j] === -1) { layer[j] = layer[i] + 1; queue.push(j); }
    }
  }
  const x = new Float64Array(n), y = new Float64Array(n);
  layers.forEach((members, l) => members.forEach((i, k) => { x[i] = k - (members.length - 1) / 2; y[i] = l; }));

  // Fruchterman–Reingold with ideal edge length 1 and linear cooling.
  const area = Math.max(n, 1), k = Math.sqrt(area / n), iterations = n > LARGE ? 300 : Math.min(600, 150 + 4 * n);
  const dx = new Float64Array(n), dy = new Float64Array(n);
  let temp = Math.sqrt(n) / 2;
  /** @param {number} i @param {number} j */
  const repel = (i, j) => {
    let ex = x[i] - x[j], ey = y[i] - y[j];
    let d2 = ex * ex + ey * ey;
    if (d2 < 1e-9) { ex = 1e-3 * (i - j); ey = 1e-3; d2 = ex * ex + ey * ey; }
    const f = (k * k) / d2;
    dx[i] += ex * f; dy[i] += ey * f; dx[j] -= ex * f; dy[j] -= ey * f;
  };
  // Repulsion beyond this distance is left out on large networks.
  const reach = 3 * k;
  for (let it = 0; it < iterations; it++) {
    dx.fill(0); dy.fill(0);
    if (n <= LARGE) {
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) repel(i, j);
    } else {
      const cells = cellsOf(x, y, reach, reach);
      for (let i = 0; i < n; i++) {
        neighbours(cells, x[i], y[i], reach, reach, j => {
          if (j > i && Math.abs(x[i] - x[j]) < reach && Math.abs(y[i] - y[j]) < reach) repel(i, j);
        });
      }
    }
    for (const [a, b] of edges) {
      const ex = x[a] - x[b], ey = y[a] - y[b], d = Math.hypot(ex, ey) || 1e-6, f = d / k;
      dx[a] -= ex * f; dy[a] -= ey * f; dx[b] += ex * f; dy[b] += ey * f;
    }
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(dx[i], dy[i]) || 1, step = Math.min(d, temp);
      x[i] += dx[i] / d * step; y[i] += dy[i] / d * step;
    }
    temp = Math.max(temp * (1 - 1 / iterations), 0.01);
  }

  // Scale so the median edge has the target spacing, stretch vertically a little for vertical branch routes.
  const attached = new Map(buses.map(b => [b.id, 0]));
  for (const el of doc.elements) if (el.cls !== 'bus') for (const id of busesOf(el)) attached.set(id, (attached.get(id) ?? 0) + 1);
  const lens = buses.map(b => snap(Math.max(100, 34 * ((attached.get(b.id) ?? 0) + 1), 0)));
  const lengths = edges.map(([a, b]) => Math.hypot(x[a] - x[b], y[a] - y[b])).sort((p, q) => p - q);
  const median = lengths.length ? lengths[lengths.length >> 1] : 1;
  const scale = SPACING / (median || 1);
  buses.forEach((b, i) => {
    b.x = snap(x[i] * scale * 1.2);
    b.y = snap(y[i] * scale * 0.9);
    b.len = lens[i];
    b.orient = 'h';
  });
  separate(buses);
  arrangeConnections(doc);
}

/** A cell's key: its column and row packed into one number. @param {number} cx @param {number} cy */
const cellKey = (cx, cy) => (cx + 1048576) * 2097152 + (cy + 1048576);

/**
 * Points bucketed into cells of `w` × `h`.
 * @param {ArrayLike<number>} x @param {ArrayLike<number>} y @param {number} w @param {number} h
 * @returns {Map<number, number[]>}
 */
function cellsOf(x, y, w, h) {
  /** @type {Map<number, number[]>} */
  const cells = new Map();
  for (let i = 0; i < x.length; i++) push(cells, cellKey(Math.floor(x[i] / w), Math.floor(y[i] / h)), i);
  return cells;
}

/**
 * Calls `visit` for every point in the cell of (px, py) and the eight around it.
 * @param {Map<number, number[]>} cells @param {number} px @param {number} py @param {number} w @param {number} h
 * @param {(j: number) => void} visit
 */
function neighbours(cells, px, py, w, h, visit) {
  const cx = Math.floor(px / w), cy = Math.floor(py / h);
  for (let a = cx - 1; a <= cx + 1; a++) {
    for (let b = cy - 1; b <= cy + 1; b++) {
      const list = cells.get(cellKey(a, b));
      if (list) for (const j of list) visit(j);
    }
  }
}

/** @param {number} v */
export const snap = v => Math.round(v / GRID) * GRID;

/** Pushes busbars apart until no two bars (with a margin) overlap. @param {Element[]} buses */
function separate(buses) {
  const margin = 60;
  if (buses.length > LARGE) { packRows(buses, margin); return; }
  for (let pass = 0; pass < 200; pass++) {
    let moved = false;
    for (let i = 0; i < buses.length; i++) for (let j = i + 1; j < buses.length; j++) {
      const a = buses[i], b = buses[j];
      const ax = /** @type {number} */ (a.x), bx = /** @type {number} */ (b.x), ay = /** @type {number} */ (a.y), by = /** @type {number} */ (b.y);
      const overlapX = (/** @type {number} */ (a.len) + /** @type {number} */ (b.len)) / 2 + margin - Math.abs(ax - bx);
      const overlapY = 2 * margin - Math.abs(ay - by);
      if (overlapX <= 0 || overlapY <= 0) continue;
      moved = true;
      if (overlapX < overlapY * 2) {
        const s = snap(overlapX / 2 + GRID / 2) || GRID, dir = ax <= bx ? -1 : 1;
        a.x = ax + dir * s; b.x = bx - dir * s;
      } else {
        const s = snap(overlapY / 2 + GRID / 2) || GRID, dir = ay <= by ? -1 : 1;
        a.y = ay + dir * s; b.y = by - dir * s;
      }
    }
    if (!moved) break;
  }
}

/**
 * Packs bars into rows four margins apart, top to bottom in the order the force layout left them, each row about the
 * same length and along it in their left-to-right order with a margin between bars. The row count makes the drawing
 * about 1.6 times as wide as it is tall.
 * @param {Element[]} buses @param {number} margin
 */
function packRows(buses, margin) {
  const pitch = 4 * margin;
  const order = [...buses].sort((a, b) => /** @type {number} */ (a.y) - /** @type {number} */ (b.y) || /** @type {number} */ (a.x) - /** @type {number} */ (b.x) || (a.id < b.id ? -1 : 1));
  const width = (/** @type {Element} */ b) => /** @type {number} */ (b.len) + margin;
  const total = order.reduce((sum, b) => sum + width(b), 0);
  const rows = Math.max(1, Math.round(Math.sqrt(total / (1.6 * pitch))));
  const target = total / rows;
  /** @type {Element[][]} */
  const packed = [[]];
  let length = 0;
  for (const b of order) {
    if (length >= target && packed.length < rows) { packed.push([]); length = 0; }
    packed[packed.length - 1].push(b);
    length += width(b);
  }
  packed.forEach((row, r) => {
    row.sort((a, b) => /** @type {number} */ (a.x) - /** @type {number} */ (b.x) || (a.id < b.id ? -1 : 1));
    let right = 0;
    for (const b of row) {
      const half = /** @type {number} */ (b.len) / 2;
      b.x = Math.ceil((right + half) / GRID) * GRID;
      b.y = r * pitch;
      right = /** @type {number} */ (b.x) + half + margin;
    }
  });
}

/**
 * Spreads branch ends and single-port elements along their bars. Branch ends go towards the far bus; generators and
 * grids go above the bar, loads and shunts below, each in the free slots nearest the bar's centre.
 * @param {PowerDocument} doc
 */
export function arrangeConnections(doc) {
  const buses = new Map(doc.elements.filter(e => e.cls === 'bus').map(b => [b.id, b]));
  /** @type {Map<string, Array<{ el: Element, key: string, want: number, side: 'above' | 'below' }>>} */
  const slots = new Map();
  for (const el of doc.elements) {
    if (el.cls === 'bus') continue;
    if (el.cls === 'line' || el.cls === 'trafo') {
      const [ka, kb] = el.cls === 'line' ? ['from', 'to'] : ['hv', 'lv'];
      const a = buses.get(/** @type {string} */ (el[ka])), b = buses.get(/** @type {string} */ (el[kb]));
      if (!a || !b) continue;
      const posKey = el.cls === 'line' ? ['fromPos', 'toPos'] : ['hvPos', 'lvPos'];
      for (const [self, other, key] of /** @type {const} */ ([[a, b, posKey[0]], [b, a, posKey[1]]])) {
        const want = (/** @type {number} */ (other.x) - /** @type {number} */ (self.x)) / Math.max(/** @type {number} */ (self.len), 1);
        const side = /** @type {number} */ (other.y) < /** @type {number} */ (self.y) ? 'above' : 'below';
        push(slots, self.id, { el, key, want, side });
      }
      el.bend = 0;
    } else {
      const side = el.cls === 'gen' || el.cls === 'extgrid' ? 'above' : 'below';
      el.side = side;
      push(slots, /** @type {string} */ (el.bus), { el, key: 'pos', want: 0, side });
    }
  }
  for (const [busId, list] of slots) {
    const bus = /** @type {Element} */ (buses.get(busId));
    const len = /** @type {number} */ (bus.len);
    for (const side of /** @type {const} */ (['above', 'below'])) {
      const items = list.filter(s => s.side === side).sort((p, q) => p.want - q.want);
      if (!items.length) continue;
      // Even spacing across the bar keeps a gap of at least one grid step between connections.
      const usable = Math.max(len - 2 * GRID, GRID), step = items.length > 1 ? usable / (items.length - 1) : 0;
      items.forEach((s, k) => {
        const along = items.length > 1 ? -usable / 2 + k * step : clamp(s.want, -0.35, 0.35) * len;
        s.el[s.key] = round3(along / len);
      });
    }
  }
}

/** @template K, V @param {Map<K, V[]>} m @param {K} k @param {V} v */
function push(m, k, v) { const a = m.get(k); if (a) a.push(v); else m.set(k, [v]); }
/** @param {number} v @param {number} lo @param {number} hi */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
/** @param {number} v */
const round3 = v => Math.round(v * 1000) / 1000;
