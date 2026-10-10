/** Label placement for the single-line diagram (docs/design/CAD.md, section 5).
 *
 * Every text on the diagram is a label: busbar, element and branch names and every result box. A label has an owner
 * element, a slot, a size and an ordered list of candidate positions, the first of which is its default. The placer
 * takes the labels in priority order and gives each the first candidate that overlaps nothing, or else the cheapest
 * by the cost below, searching rings around the anchor (with a leader line back to it) when every candidate collides.
 * Greedy placement over candidates is the practical answer to a problem that is NP-hard in general (Christensen,
 * Marks and Shieber 1995); it is deterministic and runs in one pass, which the stepped scene build needs.
 *
 * A label the user dragged is pinned: it sits at its default position plus the offset stored in the owner's `labels`
 * field, and the placer treats it as fixed. */

/**
 * @typedef {{ x: number, y: number }} Point
 * @typedef {{ x0: number, y0: number, x1: number, y1: number }} Rect
 * @typedef {'name' | 'box' | 'endA' | 'endB' | 'mid'} Slot
 * @typedef {{ x: number, y: number, leader?: boolean }} Candidate the top-left corner of a position
 * @typedef {{ owner: string, slot: Slot, w: number, h: number, group: number, alert: boolean, minZoom: number,
 *   pin: [number, number] | null, x: number, y: number, defX: number, defY: number, leader: Point[] | null }} LabelRequest
 *   `group` orders labels of equal standing; `minZoom` is the zoom from which the label shows. The placer fills in the
 *   rest: the top-left corner it chose (`x`, `y`), that of the default position (`defX`, `defY`), from which pinned
 *   offsets count, and the leader from the anchor, if any. The scene adds its own fields, saying where the label
 *   belongs and how it is drawn. A national diagram has half a million labels, so a request is one flat record that
 *   carries its own placement: no closures and no further objects per label, which keeps garbage collection short
 * @typedef {{ disentangle: boolean, candidates: (r: LabelRequest, placed: Map<string, Rect>) => Candidate[],
 *   anchor: (r: LabelRequest, at: Rect) => Point }} PlaceOptions
 *   `candidates` lists a label's positions, the default first, given the names placed so far; `anchor` gives the point
 *   a leader from a position ends at
 * @typedef {{ owner: string, slot: Slot, rect: Rect, def: Point, minZoom: number }} PlacedLabel
 */

/** What an overlap costs per unit² of the thing overlapped. */
export const COST = Object.freeze({ label: 1e6, solid: 50, line: 1 });
/** What touching a label costs besides its area: any overlap with text is the failure placement exists to avoid, so
 * even a sliver costs more than any leader, ring or overlap with a line. */
const LABEL_HIT = 1e9;
/** What each step down the candidate list costs, and each unit of distance from the default position. */
const RANK = 2, DISTANCE = 1;
/** Radii of the rings searched when every candidate collides, in world units, and the directions on each. */
const RINGS = [40, 80, 120];
const DIRECTIONS = Array.from({ length: 8 }, (_, k) => ({ x: Math.round(Math.cos(k * Math.PI / 4) * 1e6) / 1e6, y: Math.round(Math.sin(k * Math.PI / 4) * 1e6) / 1e6 }));
/** A pinned label further than this from its default position gets a leader line. */
const LEADER_GAP = 20;
/** Distance between the points at which a leader line is tested against what it crosses, and their size. */
const LEADER_STEP = 4, LEADER_PROBE = 1.5;
/** How much more a leader's overlap with a bar, symbol or route counts than a label's: a leader along one hides in it. */
const LEADER_WEIGHT = 10;

/** Collision queries between two pauses of the stepped build (a few milliseconds of work). */
const WORK = 40000;

/** The most cells a grid may have (16 MB of cell heads); a larger drawing gets larger cells. */
const MAX_CELLS = 1 << 22;

/**
 * A uniform grid of rectangles over the drawing, each with a value (the cost per unit² of overlapping it, or an
 * index). The cells are a dense array over the drawing's extent and each is a linked list through typed arrays, so a
 * national diagram's million obstacles need no hashing and cost the garbage collector almost nothing. Rectangles
 * beyond the extent go into its edge cells, which keeps every answer exact.
 */
export class SpatialHash {
  /** @param {Rect} extent what the grid covers @param {number} [cell] the smallest cell size, in world units */
  constructor(extent, cell = 64) {
    const w = Math.max(extent.x1 - extent.x0, 1), h = Math.max(extent.y1 - extent.y0, 1);
    this.cell = Math.max(cell, Math.sqrt((w * h) / MAX_CELLS));
    this.ox = extent.x0; this.oy = extent.y0;
    this.nx = Math.max(1, Math.ceil(w / this.cell)); this.ny = Math.max(1, Math.ceil(h / this.cell));
    /** The first entry of each cell, or −1. */
    this.head = new Int32Array(this.nx * this.ny).fill(-1);
    this.n = 0;
    this.box = new Float64Array(4096);
    this.value = new Float64Array(1024);
    this.mark = new Int32Array(1024);
    this.entries = 0;
    this.item = new Int32Array(2048);
    this.next = new Int32Array(2048);
    this.stamp = 0;
    /** Queries answered, a measure of the work done. */
    this.queries = 0;
  }

  /** The column of an x coordinate, clamped to the grid. @param {number} x */
  col(x) { return Math.min(this.nx - 1, Math.max(0, Math.floor((x - this.ox) / this.cell))); }

  /** The row of a y coordinate, clamped to the grid. @param {number} y */
  row(y) { return Math.min(this.ny - 1, Math.max(0, Math.floor((y - this.oy) / this.cell))); }

  /** @param {Rect} r @param {number} value */
  add(r, value) {
    const k = this.n++;
    if (k === this.value.length) {
      this.box = grow(this.box, 8 * k); this.value = grow(this.value, 2 * k); this.mark = grow(this.mark, 2 * k);
    }
    this.box[4 * k] = r.x0; this.box[4 * k + 1] = r.y0; this.box[4 * k + 2] = r.x1; this.box[4 * k + 3] = r.y1;
    this.value[k] = value;
    for (let j = this.row(r.y0), j1 = this.row(r.y1); j <= j1; j++) {
      for (let i = this.col(r.x0), i1 = this.col(r.x1); i <= i1; i++) {
        const cell = j * this.nx + i, e = this.entries++;
        if (e === this.item.length) { this.item = grow(this.item, 2 * e); this.next = grow(this.next, 2 * e); }
        this.item[e] = k;
        this.next[e] = this.head[cell];
        this.head[cell] = e;
      }
    }
  }

  /** A segment of the given width, as its bounding rectangle (routes are orthogonal, so it is exact for them).
   * @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1 @param {number} width @param {number} w */
  segment(x0, y0, x1, y1, width, w) {
    const h = width / 2;
    this.add({ x0: Math.min(x0, x1) - h, y0: Math.min(y0, y1) - h, x1: Math.max(x0, x1) + h, y1: Math.max(y0, y1) + h }, w);
  }

  /** A thin stroke, as small squares along it. @param {Point} a @param {Point} b @param {number} w */
  stroke(a, b, w) {
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / LEADER_STEP));
    for (let i = 0; i <= n; i++) {
      const x = a.x + (b.x - a.x) * i / n, y = a.y + (b.y - a.y) * i / n;
      this.add({ x0: x - LEADER_PROBE, y0: y - LEADER_PROBE, x1: x + LEADER_PROBE, y1: y + LEADER_PROBE }, w);
    }
  }

  /**
   * What a stroke from a to b would cross, stopping once it reaches `limit`; `factor` weights what is not a label.
   * @param {Point} a @param {Point} b @param {number} [limit] @param {number} [factor]
   */
  strokeCost(a, b, limit = Infinity, factor = 1) {
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / LEADER_STEP));
    let total = 0;
    for (let i = 0; i <= n && total < limit; i++) {
      const x = a.x + (b.x - a.x) * i / n, y = a.y + (b.y - a.y) * i / n;
      // A leader passes under labels, so it pays for them by area only: less than a label lying on another.
      total += this.cost({ x0: x - LEADER_PROBE, y0: y - LEADER_PROBE, x1: x + LEADER_PROBE, y1: y + LEADER_PROBE }, limit - total, factor, 0);
    }
    return total;
  }

  /**
   * The cost of a rectangle's overlaps (area times value), stopping once it reaches `limit`; `factor` weights what is
   * not a label, and `hit` is the price of touching a label at all. @param {Rect} r @param {number} [limit]
   * @param {number} [factor] @param {number} [hit]
   */
  cost(r, limit = Infinity, factor = 1, hit = LABEL_HIT) {
    const stamp = ++this.stamp, box = this.box;
    this.queries++;
    let total = 0;
    for (let j = this.row(r.y0), j1 = this.row(r.y1); j <= j1; j++) {
      for (let i = this.col(r.x0), i1 = this.col(r.x1); i <= i1; i++) {
        for (let e = this.head[j * this.nx + i]; e >= 0; e = this.next[e]) {
          const k = this.item[e];
          if (this.mark[k] === stamp) continue;
          this.mark[k] = stamp;
          const ox = Math.min(r.x1, box[4 * k + 2]) - Math.max(r.x0, box[4 * k]), oy = Math.min(r.y1, box[4 * k + 3]) - Math.max(r.y0, box[4 * k + 1]);
          if (ox <= 0 || oy <= 0) continue;
          const v = this.value[k];
          total += v >= COST.label ? ox * oy * v + hit : ox * oy * v * factor;
          if (total >= limit) return total;
        }
      }
    }
    return total;
  }

  /** The values of the rectangles that contain a point. @param {Point} p @returns {number[]} */
  at(p) {
    const out = [], box = this.box;
    for (let e = this.head[this.row(p.y) * this.nx + this.col(p.x)]; e >= 0; e = this.next[e]) {
      const k = this.item[e];
      if (p.x >= box[4 * k] && p.x <= box[4 * k + 2] && p.y >= box[4 * k + 1] && p.y <= box[4 * k + 3]) out.push(this.value[k]);
    }
    return out;
  }
}

/** A typed array twice as long, holding the old one's values. @template {Float64Array | Int32Array} T @param {T} a @param {number} n @returns {T} */
function grow(a, n) {
  const b = /** @type {T} */ (new /** @type {any} */ (a.constructor)(n));
  b.set(a);
  return b;
}

/** Where every placed label is, for hit testing and the drawing's extent. */
export class LabelIndex {
  /** @param {Rect} extent the drawing's */
  constructor(extent) {
    /** The labels in the order they were drawn. @type {LabelRequest[]} */
    this.placed = [];
    this.grid = new SpatialHash(extent);
  }

  /** @param {LabelRequest} r a placed label */
  add(r) {
    this.grid.add({ x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h }, this.placed.length);
    this.placed.push(r);
  }

  /** @param {LabelRequest} r @returns {PlacedLabel} */
  static entry(r) {
    return { owner: r.owner, slot: r.slot, rect: { x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h }, def: { x: r.defX, y: r.defY }, minZoom: r.minZoom };
  }

  /** Every placed label. @returns {PlacedLabel[]} */
  get items() { return this.placed.map(LabelIndex.entry); }

  /** The topmost label shown at this zoom that contains a point, if any. @param {Point} p @param {number} zoom */
  at(p, zoom) {
    let top = -1;
    for (const i of this.grid.at(p)) if (i > top && zoom >= this.placed[i].minZoom) top = i;
    return top < 0 ? null : LabelIndex.entry(this.placed[top]);
  }

  /** The rectangle every label lies in, or null without labels. @returns {Rect | null} */
  extent() {
    if (!this.placed.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of this.placed) { x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h); }
    return { x0, y0, x1, y1 };
  }
}

/** @param {number} x @param {number} y @param {number} w @param {number} h @returns {Rect} */
const rectAt = (x, y, w, h) => ({ x0: x, y0: y, x1: x + w, y1: y + h });

/** The gap between two rectangles (0 when they touch or overlap). @param {Rect} a @param {Rect} b */
function gap(a, b) {
  const dx = Math.max(0, a.x0 - b.x1, b.x0 - a.x1), dy = Math.max(0, a.y0 - b.y1, b.y0 - a.y1);
  return Math.hypot(dx, dy);
}

/** The point of a rectangle nearest to p. @param {Rect} r @param {Point} p @returns {Point} */
export function nearestOn(r, p) {
  return { x: Math.min(Math.max(p.x, r.x0), r.x1), y: Math.min(Math.max(p.y, r.y0), r.y1) };
}

/**
 * The leader from an anchor to a label: straight where the anchor lies level with or above a side of the label,
 * otherwise an elbow that leaves the anchor at right angles and enters the label's nearer side at its middle, so
 * leaders stay orthogonal like the diagram. @param {Point} a @param {Rect} r @returns {Point[]}
 */
export function leaderPath(a, r) {
  const n = nearestOn(r, a);
  if (n.x === a.x || n.y === a.y) return [a, n];
  const cy = (r.y0 + r.y1) / 2, x = a.x < r.x0 ? r.x0 : r.x1;
  return [a, { x: a.x, y: cy }, { x, y: cy }];
}

/** @param {Point[]} path */
const pathLength = path => path.reduce((s, p, i) => (i ? s + Math.abs(p.x - path[i - 1].x) + Math.abs(p.y - path[i - 1].y) : 0), 0);

/** The key of a label in the map of placed labels. @param {string} owner @param {Slot} slot */
export const labelKey = (owner, slot) => `${owner}\u0000${slot}`;

/**
 * Ring positions around an anchor, nearest first, each a rectangle of w × h whose nearest edge lies at the ring's
 * radius from the anchor. @param {Point} a @param {number} w @param {number} h @returns {Candidate[]}
 */
function rings(a, w, h) {
  /** @type {Candidate[]} */
  const out = [];
  for (const r of RINGS) {
    for (const u of DIRECTIONS) {
      const cx = a.x + u.x * (r + (w / 2) * Math.abs(u.x)), cy = a.y + u.y * (r + (h / 2) * Math.abs(u.y));
      out.push({ x: cx - w / 2, y: cy - h / 2, leader: true });
    }
  }
  return out;
}

/**
 * Places the labels: pinned ones first, at their stored offsets; then violations; then by group and request order.
 * With `disentangle` off every unpinned label takes its default position. Obstacles (bars, symbols, routes) are in
 * `hash` already; placed labels join it. Writes each label's placement into its request and returns the requests in
 * the order placed. Pauses after a few milliseconds of work.
 * @param {LabelRequest[]} requests @param {SpatialHash} hash @param {PlaceOptions} opt
 * @returns {Generator<void, LabelRequest[], void>}
 */
export function* placeLabels(requests, hash, opt) {
  // Buckets by standing, each in request order: a stable sort in linear time, for half a million labels.
  /** @type {LabelRequest[][]} */
  const buckets = [];
  for (let i = 0; i < requests.length; i++) {
    const r = requests[i], b = r.pin ? 0 : r.alert ? 1 : 2 + r.group;
    (buckets[b] ??= []).push(r);
    if (i % 65536 === 65535) yield;
  }
  /** Names placed so far, which other labels' positions may follow. @type {Map<string, Rect>} */
  const placed = new Map();
  /** @type {LabelRequest[]} */
  const out = [];
  let paused = hash.queries, done = 0;
  for (const bucket of buckets) {
    for (const r of bucket ?? []) {
      // Pauses follow the work done, not the count: a crowded stretch searches many positions per label.
      if (hash.queries - paused > WORK || ++done % 4096 === 0) { yield; paused = hash.queries; }
      place(r, hash, opt, placed);
      out.push(r);
    }
  }
  return out;
}

/** Places one label. @param {LabelRequest} r @param {SpatialHash} hash @param {PlaceOptions} opt @param {Map<string, Rect>} placed */
function place(r, hash, opt, placed) {
  const cands = opt.candidates(r, placed);
  const def = cands[0] ?? { x: 0, y: 0 };
  let best = def, leader = false;
  if (r.pin) {
    best = { x: def.x + r.pin[0], y: def.y + r.pin[1] };
    leader = gap(rectAt(best.x, best.y, r.w, r.h), rectAt(def.x, def.y, r.w, r.h)) > LEADER_GAP;
  } else if (opt.disentangle) {
    let bestCost = Infinity;
    const all = cands.length ? [...cands, ...rings(opt.anchor(r, rectAt(def.x, def.y, r.w, r.h)), r.w, r.h)] : [];
    for (let k = 0; k < all.length; k++) {
      const c = all[k], rect = rectAt(c.x, c.y, r.w, r.h);
      // A leader runs from the label to its anchor: its length counts as distance, what it crosses as overlap.
      const path = c.leader ? leaderPath(opt.anchor(r, rect), rect) : null;
      const fixed = RANK * k + DISTANCE * (Math.hypot(c.x - def.x, c.y - def.y) + (path ? pathLength(path) : 0));
      if (fixed >= bestCost) continue;
      let overlap = hash.cost(rect, bestCost - fixed);
      if (overlap === 0 && k < cands.length) { best = c; leader = false; break; }
      if (path) for (let i = 1; i < path.length && fixed + overlap < bestCost; i++) overlap += hash.strokeCost(path[i - 1], path[i], bestCost - fixed - overlap, LEADER_WEIGHT);
      if (fixed + overlap < bestCost) { bestCost = fixed + overlap; best = c; leader = !!c.leader; }
    }
  }
  const rect = rectAt(best.x, best.y, r.w, r.h);
  r.x = best.x; r.y = best.y; r.defX = def.x; r.defY = def.y;
  r.leader = leader ? leaderPath(opt.anchor(r, rect), rect) : null;
  hash.add(rect, COST.label);
  // Labels placed later keep clear of a leader as of a symbol.
  if (r.leader) for (let i = 1; i < r.leader.length; i++) hash.stroke(r.leader[i - 1], r.leader[i], COST.solid);
  if (r.slot === 'name') placed.set(labelKey(r.owner, r.slot), rect);
}
