/** The placing tools: a busbar where the pointer is, a single-port element on the busbar under it, and a line or
 * transformer between the two busbars clicked in turn. */

import { Tool } from './tool.js';
import { bar, attachPoint } from '../../render/geometry.js';
import { snap } from '../../core/layout.js';

/**
 * @typedef {import('./tool.js').Pointer} Pointer
 * @typedef {import('./tool.js').Point} Point
 * @typedef {'gen' | 'extgrid' | 'load' | 'shunt'} PortClass
 * @typedef {import('../../core/catalog.js').Element} Element
 */

/** Places a busbar on the grid, or in line with a busbar on screen. */
export class BusTool extends Tool {
  /** @param {import('../viewport.js').Viewport} vp */
  constructor(vp) {
    super(vp);
    /** Where the busbar would go. @type {Point | undefined} */
    this.ghost = undefined;
  }

  /** @override */
  get hint() { return 'Click to place a busbar · Alt places freely'; }

  /** Where the pointer puts the busbar, with the guides that say why. @param {Pointer} e */
  at(e) { return this.vp.snapper().point(e.p, e.alt); }

  /** @override @param {Pointer} e */
  down(e) {
    const { p } = this.at(e);
    this.vp.app.addBus(p.x, p.y);
    this.vp.setGuides([]);
    return null;
  }

  /** @override @param {Pointer} e */
  hover(e) {
    const { p, guides } = this.at(e);
    this.ghost = p;
    this.vp.setGuides(guides);
    this.vp.invalidate('overlay');
  }

  /** @override @param {Point} p @returns {import('./tool.js').Preview} */
  preview(p) { const q = this.ghost ?? { x: snap(p.x), y: snap(p.y) }; return { kind: 'ghost-bus', x: q.x, y: q.y, len: 120 }; }

  /** @override */
  cancel() { this.ghost = undefined; this.vp.setGuides([]); return false; }
}

const PORT_HINTS = /** @type {Record<PortClass, string>} */ ({
  gen: 'Click a busbar to connect a synchronous machine', extgrid: 'Click a busbar to connect an external grid',
  load: 'Click a busbar to connect a load', shunt: 'Click a busbar to connect a shunt',
});

/** Connects a machine, grid, load or shunt to the busbar clicked, on the side of the bar the click was. */
export class PortTool extends Tool {
  /** @param {import('../viewport.js').Viewport} vp @param {PortClass} cls */
  constructor(vp, cls) {
    super(vp);
    this.cls = cls;
    /** Where the element would go. @type {{ bus: string, pos: number, side: 'above' | 'below' } | null} */
    this.ghost = null;
  }

  /** @override */
  get hint() { return PORT_HINTS[this.cls]; }

  /** @override @param {Pointer} e */
  down(e) {
    const vp = this.vp, bus = vp.busAt(e.p);
    if (!bus) { vp.app.toast('info', 'Click on a busbar to connect to it.'); return null; }
    vp.app.addPort(this.cls, bus.id, vp.snapper().along(bus, e.p, e.alt).pos, vp.sideOf(bus, e.p));
    vp.setGuides([]);
    return null;
  }

  /** @override @param {Pointer} e */
  hover(e) {
    const bus = this.vp.busAt(e.p), at = bus ? this.vp.snapper().along(bus, e.p, e.alt) : null;
    this.ghost = bus && at ? { bus: bus.id, pos: at.pos, side: this.vp.sideOf(bus, e.p) } : null;
    this.vp.setGuides(at?.guides ?? []);
    this.vp.invalidate('overlay');
  }

  /** @override @returns {import('./tool.js').Preview | null} */
  preview() { return this.ghost ? { kind: 'ghost-port', cls: this.cls, ...this.ghost } : null; }

  /** @override */
  cancel() { this.ghost = null; this.vp.setGuides([]); return false; }
}

/** Connects two busbars with a line or a transformer: the first click picks one end, the second the other. */
export class ConnectTool extends Tool {
  /** @param {import('../viewport.js').Viewport} vp @param {'line' | 'trafo'} cls */
  constructor(vp, cls) {
    super(vp);
    this.cls = cls;
    /** The first end, once picked. @type {{ from: string, pos: number } | null} */
    this.pending = null;
  }

  /** @override */
  get hint() { return this.cls === 'line' ? 'Click the first busbar, then the second' : 'Click the HV busbar, then the LV busbar'; }

  /** Where on a busbar the pointer connects: the second end in line with the first, so the route runs straight.
   * @param {Element} bus @param {Pointer} e */
  along(bus, e) {
    const first = this.pending && this.vp.app.store.get(this.pending.from);
    const prefer = this.pending && first && first.id !== bus.id ? [attachPoint(first, this.pending.pos)] : [];
    return this.vp.snapper().along(bus, e.p, e.alt, prefer);
  }

  /** @override @param {Pointer} e */
  down(e) {
    const vp = this.vp, bus = vp.busAt(e.p);
    if (!bus) return null;
    const at = this.along(bus, e);
    vp.setGuides([]);
    if (!this.pending) { this.pending = { from: bus.id, pos: at.pos }; vp.invalidate('overlay'); return null; }
    if (this.pending.from === bus.id) { vp.app.toast('info', 'Pick a different busbar for the other end.'); return null; }
    const from = this.pending;
    this.pending = null;
    vp.app.addBranch(this.cls, from.from, from.pos, bus.id, at.pos);
    vp.invalidate('overlay');
    return null;
  }

  /** @override @param {Pointer} e */
  hover(e) {
    const bus = this.vp.busAt(e.p);
    this.vp.setGuides(bus ? this.along(bus, e).guides : []);
    this.vp.invalidate('overlay');
  }

  /** @override @param {Point} p @returns {import('./tool.js').Preview | null} */
  preview(p) {
    const bus = this.pending && this.vp.app.store.get(this.pending.from);
    if (!this.pending || !bus) return null;
    const g = bar(bus), len = /** @type {number} */ (bus.len);
    const from = g.horizontal ? { x: g.x0 + (this.pending.pos + 0.5) * len, y: g.y0 } : { x: g.x0, y: g.y0 + (this.pending.pos + 0.5) * len };
    return { kind: 'rubber', from, to: p };
  }

  /** @override */
  cancel() {
    this.vp.setGuides([]);
    if (!this.pending) return false;
    this.pending = null;
    this.vp.invalidate('overlay');
    return true;
  }
}
