/** Automatic single-line diagram layout for networks that arrive without one (MATPOWER imports, "Arrange").
 *
 * Busbars are placed by a deterministic force-directed method (Fruchterman and Reingold, 1991) started from a
 * breadth-first layering, then snapped to the drawing grid and pushed apart until no two bars overlap. Branch ends and
 * single-port elements are then spread along each bar so that connections do not sit on top of each other. */

import { busesOf } from './document.js';

/** @typedef {import('./document.js').PowerDocument} PowerDocument @typedef {import('./catalog.js').Element} Element */

export const GRID = 20;
const SPACING = 240;

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
    while (queue.length) {
      const i = /** @type {number} */ (queue.shift());
      (layers[layer[i]] ??= []).push(i);
      for (const j of adj[i]) if (layer[j] === -1) { layer[j] = layer[i] + 1; queue.push(j); }
    }
  }
  const x = new Float64Array(n), y = new Float64Array(n);
  layers.forEach((members, l) => members.forEach((i, k) => { x[i] = k - (members.length - 1) / 2; y[i] = l; }));

  // Fruchterman–Reingold with ideal edge length 1 and linear cooling.
  const area = Math.max(n, 1), k = Math.sqrt(area / n), iterations = Math.min(600, 150 + 4 * n);
  const dx = new Float64Array(n), dy = new Float64Array(n);
  let temp = Math.sqrt(n) / 2;
  for (let it = 0; it < iterations; it++) {
    dx.fill(0); dy.fill(0);
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      let ex = x[i] - x[j], ey = y[i] - y[j];
      let d2 = ex * ex + ey * ey;
      if (d2 < 1e-9) { ex = 1e-3 * (i - j); ey = 1e-3; d2 = ex * ex + ey * ey; }
      const f = (k * k) / d2;
      dx[i] += ex * f; dy[i] += ey * f; dx[j] -= ex * f; dy[j] -= ey * f;
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
  const lengths = edges.map(([a, b]) => Math.hypot(x[a] - x[b], y[a] - y[b])).sort((p, q) => p - q);
  const median = lengths.length ? lengths[lengths.length >> 1] : 1;
  const scale = SPACING / (median || 1);
  buses.forEach((b, i) => {
    b.x = snap(x[i] * scale * 1.2);
    b.y = snap(y[i] * scale * 0.9);
    b.len = snap(Math.max(100, 34 * (attachedCount(doc, b.id) + 1), 0));
    b.orient = 'h';
  });
  separate(buses);
  arrangeConnections(doc);
}

/** @param {PowerDocument} doc @param {string} busId */
function attachedCount(doc, busId) {
  let c = 0;
  for (const el of doc.elements) if (el.cls !== 'bus' && busesOf(el).includes(busId)) c++;
  return c;
}

/** @param {number} v */
export const snap = v => Math.round(v / GRID) * GRID;

/** Pushes busbars apart until no two bars (with a margin) overlap. @param {Element[]} buses */
function separate(buses) {
  const margin = 60;
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

/** @param {Map<string, any[]>} m @param {string} k @param {any} v */
function push(m, k, v) { const a = m.get(k); if (a) a.push(v); else m.set(k, [v]); }
/** @param {number} v @param {number} lo @param {number} hi */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
/** @param {number} v */
const round3 = v => Math.round(v * 1000) / 1000;
