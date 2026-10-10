/** Automatic single-line diagram layout for networks that arrive without one (imports, "Arrange").
 *
 * Busbars are placed by a deterministic force-directed method (Fruchterman and Reingold, 1991) started from a
 * breadth-first layering, then snapped to the drawing grid and pushed apart until no two bars overlap. Branch ends and
 * single-port elements are then spread along each bar so that connections do not sit on top of each other.
 *
 * Above LARGE busbars, a national network, the force layout is multilevel (Walshaw, "A multilevel algorithm for
 * force-directed graph drawing", 2000): the network is coarsened by matching neighbouring busbars into groups, level
 * after level, the coarsest graph is laid out in full, and each finer level starts from its groups' positions and is
 * refined briefly, with repulsion cut off beyond a few ideal edge lengths and found through a grid of cells
 * (Fruchterman and Reingold's own grid variant). The coarse levels set the shape of the whole network, so regions
 * stay together and branches stay short. Overlaps are then removed row by row: each bar keeps the row nearest its
 * height and, along the row, the position nearest its computed one that keeps a margin to its neighbours (a least
 * squares fit under ordering constraints, solved by pool-adjacent-violators). Smaller networks keep the exact
 * all-pairs method. */

import { busesOf } from './document.js';
import { DRAWING_KEYS } from './store.js';

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
  const { x, y } = n > LARGE ? multilevel(n, edges) : small(doc, index, edges);

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

/**
 * The layout of a network of up to LARGE busbars: breadth-first layers from the sources give a stable, readable
 * start, then the force layout runs with every pair repelling.
 * @param {PowerDocument} doc @param {Map<string, number>} index @param {Array<[number, number]>} edges
 * @returns {{ x: Float64Array, y: Float64Array }}
 */
function small(doc, index, edges) {
  const n = index.size;
  const adj = Array.from({ length: n }, () => /** @type {number[]} */ ([]));
  for (const [a, b] of edges) { adj[a].push(b); adj[b].push(a); }
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
  relax({ n, edges, weight: null }, x, y, { k: 1, iterations: Math.min(600, 150 + 4 * n), temp: Math.sqrt(n) / 2, exact: true });
  return { x, y };
}

/** @typedef {{ n: number, edges: Array<[number, number]>, weight: Float64Array | null }} Graph A graph to lay out,
 * with the weight of each edge (the branches it stands for) at coarse levels. */

/**
 * Fruchterman and Reingold's force layout on `x` and `y` in place: ideal edge length `k`, `iterations` steps from
 * temperature `temp` cooling linearly. With `exact` every pair repels; otherwise only pairs within three edge lengths,
 * found through a grid of cells.
 * @param {Graph} g @param {Float64Array} x @param {Float64Array} y
 * @param {{ k: number, iterations: number, temp: number, exact: boolean }} opt
 */
function relax(g, x, y, opt) {
  const { n, edges, weight } = g, { k, iterations } = opt;
  const dx = new Float64Array(n), dy = new Float64Array(n);
  let temp = opt.temp;
  /** @param {number} i @param {number} j */
  const repel = (i, j) => {
    let ex = x[i] - x[j], ey = y[i] - y[j];
    let d2 = ex * ex + ey * ey;
    if (d2 < 1e-9) { ex = 1e-3 * (i - j) * k; ey = 1e-3 * k; d2 = ex * ex + ey * ey; }
    const f = (k * k) / d2;
    dx[i] += ex * f; dy[i] += ey * f; dx[j] -= ex * f; dy[j] -= ey * f;
  };
  // Repulsion beyond this distance is left out on large graphs.
  const reach = 3 * k;
  for (let it = 0; it < iterations; it++) {
    dx.fill(0); dy.fill(0);
    if (opt.exact) {
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) repel(i, j);
    } else {
      const c = grid(x, y, reach);
      for (let i = 0; i < n; i++) {
        const cx = c.col[i], cy = c.row[i];
        for (let a = Math.max(0, cx - 1); a <= Math.min(c.cols - 1, cx + 1); a++) {
          for (let b = Math.max(0, cy - 1); b <= Math.min(c.rows - 1, cy + 1); b++) {
            const cell = a + b * c.cols;
            for (let p = c.start[cell]; p < c.start[cell + 1]; p++) {
              const j = c.order[p];
              if (j > i && Math.abs(x[i] - x[j]) < reach && Math.abs(y[i] - y[j]) < reach) repel(i, j);
            }
          }
        }
      }
    }
    edges.forEach(([a, b], e) => {
      const ex = x[a] - x[b], ey = y[a] - y[b], d = Math.hypot(ex, ey) || 1e-6, f = (d / k) * (weight ? weight[e] : 1);
      dx[a] -= ex * f; dy[a] -= ey * f; dx[b] += ex * f; dy[b] += ey * f;
    });
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(dx[i], dy[i]) || 1, step = Math.min(d, temp);
      x[i] += dx[i] / d * step; y[i] += dy[i] / d * step;
    }
    temp = Math.max(temp * (1 - 1 / iterations), 0.01 * k);
  }
}

/** Groups at the coarsest level of a multilevel layout. */
const COARSEST = 64;

/**
 * A multilevel force layout of a large graph, with ideal edge length 1 at the finest level. Each level's ideal edge
 * length grows with the square root of its groups' average size, so every level covers the same area and a finer level
 * starts where its groups were.
 * @param {number} n @param {Array<[number, number]>} edges @returns {{ x: Float64Array, y: Float64Array }}
 */
function multilevel(n, edges) {
  const finest = dedupe(edges, n);
  /** @type {Graph[]} */
  const levels = [{ n, edges: finest.edges, weight: finest.weight }];
  /** @type {Int32Array[]} */
  const parents = [];
  for (;;) {
    const g = levels[levels.length - 1];
    if (g.n <= COARSEST) break;
    const { parent, coarse } = coarsen(g);
    // A graph that no longer shrinks (a star's leaves can only join its hub one at a time) stops here.
    if (coarse.n > 0.95 * g.n) break;
    parents.push(parent);
    levels.push(coarse);
  }
  const top = levels[levels.length - 1];
  const kOf = (/** @type {Graph} */ g) => Math.sqrt(n / g.n);
  // The coarsest graph starts on a circle (deterministic) and is laid out in full.
  let x = new Float64Array(top.n), y = new Float64Array(top.n);
  const r = Math.sqrt(n) / 2;
  for (let i = 0; i < top.n; i++) { x[i] = r * Math.cos(2 * Math.PI * i / top.n); y[i] = r * Math.sin(2 * Math.PI * i / top.n); }
  relax(top, x, y, { k: kOf(top), iterations: 400, temp: r, exact: top.n <= LARGE });
  for (let l = levels.length - 2; l >= 0; l--) {
    const g = levels[l], parent = parents[l], k = kOf(g);
    const fx = new Float64Array(g.n), fy = new Float64Array(g.n);
    // Each busbar starts at its group's position, spread a little by a golden-angle offset.
    for (let i = 0; i < g.n; i++) {
      fx[i] = x[parent[i]] + 0.2 * k * Math.cos(2.399963 * i);
      fy[i] = y[parent[i]] + 0.2 * k * Math.sin(2.399963 * i);
    }
    x = fx; y = fy;
    relax(g, x, y, { k, iterations: l === 0 ? 40 : 60, temp: 2 * k, exact: g.n <= LARGE });
  }
  return { x, y };
}

/** Merges parallel edges into one with their count as its weight, and drops loops.
 * @param {Array<[number, number]>} edges @param {number} n */
function dedupe(edges, n) {
  /** @type {Map<number, number>} */
  const seen = new Map();
  /** @type {Array<[number, number]>} */
  const out = [];
  /** @type {number[]} */
  const weight = [];
  for (const [a, b] of edges) {
    if (a === b) continue;
    const key = Math.min(a, b) * n + Math.max(a, b), at = seen.get(key);
    if (at === undefined) { seen.set(key, out.length); out.push([Math.min(a, b), Math.max(a, b)]); weight.push(1); }
    else weight[at]++;
  }
  return { edges: out, weight: Float64Array.from(weight) };
}

/**
 * One level coarser: each vertex, lightest first, joins its unmatched neighbour on its heaviest edge; a vertex whose
 * neighbours are all taken joins the smallest of their groups, so the leaves around a hub (a substation's units and
 * feeders) gather instead of stalling the coarsening. Groups stop growing at eight vertices.
 * @param {Graph} g @returns {{ parent: Int32Array, coarse: Graph }}
 */
function coarsen(g) {
  const { n, edges } = g, weight = g.weight ?? new Float64Array(edges.length).fill(1);
  /** @type {Array<Array<[number, number]>>} neighbour and edge weight */
  const adj = Array.from({ length: n }, () => /** @type {Array<[number, number]>} */ ([]));
  edges.forEach(([a, b], e) => { adj[a].push([b, weight[e]]); adj[b].push([a, weight[e]]); });
  const parent = new Int32Array(n).fill(-1);
  /** @type {number[]} */
  const size = [];
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => adj[a].length - adj[b].length || a - b);
  const cap = 8;
  for (const u of order) {
    if (parent[u] >= 0) continue;
    let best = -1, bestW = -1;
    for (const [v, w] of adj[u]) if (parent[v] < 0 && v !== u && w > bestW) { best = v; bestW = w; }
    if (best >= 0) { parent[u] = parent[best] = size.length; size.push(2); continue; }
    let group = -1;
    for (const [v] of adj[u]) if (parent[v] >= 0 && size[parent[v]] < cap && (group < 0 || size[parent[v]] < size[group])) group = parent[v];
    if (group >= 0) { parent[u] = group; size[group]++; } else { parent[u] = size.length; size.push(1); }
  }
  /** @type {Array<[number, number]>} */
  const coarseEdges = [];
  for (const [a, b] of edges) if (parent[a] !== parent[b]) coarseEdges.push([parent[a], parent[b]]);
  const merged = dedupe(coarseEdges, size.length);
  // The weights add up the branches each coarse edge stands for.
  const total = new Map();
  edges.forEach(([a, b], e) => {
    const p = parent[a], q = parent[b];
    if (p === q) return;
    const key = Math.min(p, q) * size.length + Math.max(p, q);
    total.set(key, (total.get(key) ?? 0) + weight[e]);
  });
  merged.edges.forEach(([p, q], e) => { merged.weight[e] = total.get(p * size.length + q) ?? 1; });
  return { parent, coarse: { n: size.length, edges: merged.edges, weight: merged.weight } };
}

/**
 * Points sorted into square cells of side `size` (counting sort into typed arrays): cell `c` holds
 * `order[start[c]]` to `order[start[c + 1] - 1]`. The cells grow when the points are spread so far that there would be
 * more than four cells per point.
 * @param {Float64Array} x @param {Float64Array} y @param {number} size
 */
function grid(x, y, size) {
  const n = x.length;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) { x0 = Math.min(x0, x[i]); x1 = Math.max(x1, x[i]); y0 = Math.min(y0, y[i]); y1 = Math.max(y1, y[i]); }
  let side = size;
  while (((x1 - x0) / side + 1) * ((y1 - y0) / side + 1) > 4 * n + 16) side *= 2;
  const cols = Math.floor((x1 - x0) / side) + 1, rows = Math.floor((y1 - y0) / side) + 1;
  const col = new Int32Array(n), row = new Int32Array(n), start = new Int32Array(cols * rows + 1), order = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    col[i] = Math.floor((x[i] - x0) / side);
    row[i] = Math.floor((y[i] - y0) / side);
    start[col[i] + row[i] * cols + 1]++;
  }
  for (let c = 0; c < cols * rows; c++) start[c + 1] += start[c];
  const fill = start.slice(0, cols * rows);
  for (let i = 0; i < n; i++) order[fill[col[i] + row[i] * cols]++] = i;
  return { cols, rows, col, row, start, order };
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
 * Removes overlaps on a large network while keeping each bar near where the force layout put it. The drawing is first
 * spread, if need be, until it has room for every bar with its margin; each bar then takes the row (four margins apart)
 * nearest its height, and along the row the positions nearest the computed ones that keep a margin between
 * neighbours: the least-squares fit under those ordering constraints, which pool-adjacent-violators solves in one pass.
 * @param {Element[]} buses @param {number} margin
 */
function packRows(buses, margin) {
  const pitch = 4 * margin;
  const num = (/** @type {unknown} */ v) => /** @type {number} */ (v);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, need = 0;
  for (const b of buses) {
    x0 = Math.min(x0, num(b.x)); x1 = Math.max(x1, num(b.x)); y0 = Math.min(y0, num(b.y)); y1 = Math.max(y1, num(b.y));
    need += (num(b.len) + margin) * pitch;
  }
  // A quarter more room than the bars need, so rows are rarely full and bars move little along them.
  const have = Math.max(x1 - x0, 1) * Math.max(y1 - y0, 1), grow = Math.max(1, Math.sqrt((1.25 * need) / have));
  /** @type {Map<number, Element[]>} */
  const rows = new Map();
  for (const b of buses) {
    b.x = (num(b.x) - x0) * grow;
    const r = Math.round(((num(b.y) - y0) * grow) / pitch);
    b.y = r * pitch;
    push(rows, r, b);
  }
  for (const row of rows.values()) {
    row.sort((a, b) => num(a.x) - num(b.x) || (a.id < b.id ? -1 : 1));
    // Offsets that keep neighbours a margin apart, then the nearest non-decreasing fit of the remaining freedom.
    const m = row.length, offset = new Float64Array(m), target = new Float64Array(m);
    for (let i = 1; i < m; i++) offset[i] = offset[i - 1] + num(row[i - 1].len) / 2 + margin + num(row[i].len) / 2;
    for (let i = 0; i < m; i++) target[i] = num(row[i].x) - offset[i];
    const fit = isotonic(target);
    let right = -Infinity;
    row.forEach((b, i) => {
      const half = num(b.len) / 2;
      b.x = Math.max(snap(fit[i] + offset[i]), Math.ceil((right + half) / GRID) * GRID);
      right = num(b.x) + half + margin;
    });
  }
}

/**
 * The non-decreasing sequence nearest `t` in least squares (pool-adjacent-violators).
 * @param {Float64Array} t @returns {Float64Array}
 */
function isotonic(t) {
  const n = t.length, mean = new Float64Array(n), count = new Int32Array(n);
  let top = 0;
  for (let i = 0; i < n; i++) {
    mean[top] = t[i]; count[top] = 1; top++;
    while (top > 1 && mean[top - 2] > mean[top - 1]) {
      const c = count[top - 2] + count[top - 1];
      mean[top - 2] = (mean[top - 2] * count[top - 2] + mean[top - 1] * count[top - 1]) / c;
      count[top - 2] = c;
      top--;
    }
  }
  const out = new Float64Array(n);
  for (let b = 0, i = 0; b < top; b++) for (let k = 0; k < count[b]; k++) out[i++] = mean[b];
  return out;
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

/** A document laid out from its JSON text. @param {string} json @returns {import('../core/document.js').PowerDocument} */
export function laidOut(json) {
  const doc = JSON.parse(json);
  autoLayout(doc);
  return doc;
}

/** Every element's drawing fields, with its identifier. @param {import('../core/document.js').PowerDocument} doc */
export function drawingOf(doc) {
  return doc.elements.map(el => {
    /** @type {Record<string, unknown>} */
    const out = { id: el.id };
    for (const k of DRAWING_KEYS) if (k in el) out[k] = el[k];
    return out;
  });
}
