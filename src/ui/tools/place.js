/** The placing tools: a busbar where the pointer is, a single-port element on the busbar under it, and a line or
 * transformer between the two busbars clicked in turn. */

import { Tool } from './tool.js';
import { bar } from '../../render/geometry.js';
import { snap } from '../../core/layout.js';

/**
 * @typedef {import('./tool.js').Pointer} Pointer
 * @typedef {import('./tool.js').Point} Point
 * @typedef {'gen' | 'extgrid' | 'load' | 'shunt'} PortClass
 */

/** Places a busbar on the grid. */
export class BusTool extends Tool {
  /** @override */
  get hint() { return 'Click to place a busbar'; }

  /** @override @param {Pointer} e */
  down(e) { this.vp.app.addBus(snap(e.p.x), snap(e.p.y)); return null; }

  /** @override @param {Point} p @returns {import('./tool.js').Preview} */
  preview(p) { return { kind: 'ghost-bus', x: snap(p.x), y: snap(p.y), len: 120 }; }
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
  }

  /** @override */
  get hint() { return PORT_HINTS[this.cls]; }

  /** @override @param {Pointer} e */
  down(e) {
    const vp = this.vp, bus = vp.busAt(e.p);
    if (!bus) { vp.app.toast('info', 'Click on a busbar to connect to it.'); return null; }
    vp.app.addPort(this.cls, bus.id, vp.snapPos(bus, e.p), vp.sideOf(bus, e.p));
    return null;
  }

  /** @override @param {Point} p @returns {import('./tool.js').Preview | null} */
  preview(p) {
    const bus = this.vp.busAt(p);
    return bus ? { kind: 'ghost-port', cls: this.cls, bus: bus.id, pos: this.vp.snapPos(bus, p), side: this.vp.sideOf(bus, p) } : null;
  }
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

  /** @override @param {Pointer} e */
  down(e) {
    const vp = this.vp, bus = vp.busAt(e.p);
    if (!bus) return null;
    if (!this.pending) { this.pending = { from: bus.id, pos: vp.snapPos(bus, e.p) }; vp.invalidate('overlay'); return null; }
    if (this.pending.from === bus.id) { vp.app.toast('info', 'Pick a different busbar for the other end.'); return null; }
    const from = this.pending;
    this.pending = null;
    vp.app.addBranch(this.cls, from.from, from.pos, bus.id, vp.snapPos(bus, e.p));
    vp.invalidate('overlay');
    return null;
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
    if (!this.pending) return false;
    this.pending = null;
    this.vp.invalidate('overlay');
    return true;
  }
}
