/** The diagram viewport: owns the renderer and camera, rebuilds the scene when something changes, and turns pointer
 * input into editing actions (select, move, resize, reroute, reconnect, place, connect, pan and zoom). */

import { Camera } from '../render/camera.js';
import { createRenderer } from '../render/renderer.js';
import { Canvas2DRenderer } from '../render/canvas2d.js';
import { buildScene, buildOverlay, sceneSteps } from '../render/scene.js';
import { toSVG } from '../render/svg.js';
import { hitTest, inRect, HitIndex } from '../render/hittest.js';
import { bar, bounds, positionOn, route, branchKeys, bendHandle } from '../render/geometry.js';
import { snap } from '../core/layout.js';
import { h } from './dom.js';
import { icon } from './icons.js';
import { kbd } from './keys.js';
import { minOf, maxOf } from '../core/extent.js';

/**
 * @typedef {import('../core/catalog.js').Element} Element
 * @typedef {import('../render/hittest.js').Hit} Hit
 * @typedef {'select' | 'pan' | 'bus' | 'line' | 'trafo' | 'gen' | 'extgrid' | 'load' | 'shunt'} Tool
 * @typedef {{ kind: 'pan', sx: number, sy: number, cx: number, cy: number }
 *   | { kind: 'move', start: { x: number, y: number }, orig: Map<string, { x: number, y: number }>, key: string, moved: boolean }
 *   | { kind: 'slide', id: string, key: string }
 *   | { kind: 'bus-end', id: string, end: 0 | 1, x0: number, x1: number, key: string }
 *   | { kind: 'bend', id: string, axis: 'x' | 'y', orig: number, start: { x: number, y: number }, key: string }
 *   | { kind: 'branch-end', id: string, end: 'A' | 'B', key: string }
 *   | { kind: 'marquee', x0: number, y0: number, x1: number, y1: number, additive: boolean }} Drag
 */

const HINTS = /** @type {Record<Tool, string>} */ ({
  select: '', pan: 'Drag to move the view',
  bus: 'Click to place a busbar', line: 'Click the first busbar, then the second', trafo: 'Click the HV busbar, then the LV busbar',
  gen: 'Click a busbar to connect a synchronous machine', extgrid: 'Click a busbar to connect an external grid',
  load: 'Click a busbar to connect a load', shunt: 'Click a busbar to connect a shunt',
});

/** Milliseconds a frame may spend building the diagram, leaving the rest of the frame for input and drawing. */
const BUILD_BUDGET_MS = 8;

export class Viewport {
  /** @param {import('../app.js').App} app @param {HTMLElement} host */
  constructor(app, host) {
    this.app = app;
    this.host = host;
    this.camera = new Camera();
    /** @type {import('../render/renderer.js').Renderer | null} */
    this.renderer = null;
    this.fallbackReason = '';
    this.dpr = window.devicePixelRatio || 1;
    /** The diagram must be rebuilt (its content, results, labels or palette changed). */
    this.sceneDirty = true;
    /** The overlay must be rebuilt (selection, hover or a tool's preview changed). */
    this.overlayDirty = true;
    /** The diagram being built over several frames, if a build is under way. @type {Generator<void, void, void> | null} */
    this.job = null;
    this.frame = 0;
    /** @type {Drag | null} */
    this.drag = null;
    /** @type {{ cls: 'line' | 'trafo', from: string, pos: number } | null} */
    this.pending = null;
    /** @type {{ x: number, y: number }} */
    this.pointer = { x: 0, y: 0 };
    this.pointerInside = false;
    this.spaceDown = false;
    /** @type {Map<number, { x: number, y: number }>} */
    this.touches = new Map();
    this.pinch = /** @type {{ d: number, zoom: number, mid: { x: number, y: number } } | null} */ (null);
    this.dragSeq = 0;
    this.frames = 0;
    /** @type {HitIndex | null} */
    this.hitIndex = null;
    this.hitRevision = -1;

    this.badge = h('div', { class: 'vp-badge', role: 'status', 'aria-live': 'polite' });
    this.legend = h('div', { class: 'vp-legend', 'aria-label': 'Legend' });
    this.hint = h('div', { class: 'vp-hint', 'aria-live': 'polite' });
    this.zoomLabel = h('div', { class: 'vp-zoom', title: 'Zoom' });
    const tools = h('div', { class: 'vp-tools' },
      h('button', { type: 'button', class: 'icon-btn', 'data-cmd': 'view.zoomIn', title: 'Zoom in', 'aria-label': 'Zoom in', html: icon('plus', 16) }),
      h('button', { type: 'button', class: 'icon-btn', 'data-cmd': 'view.zoomOut', title: 'Zoom out', 'aria-label': 'Zoom out', html: icon('minus', 16) }),
      h('button', { type: 'button', class: 'icon-btn', 'data-cmd': 'view.fit', title: 'Fit diagram', 'aria-label': 'Fit diagram', html: icon('fit', 16) }));
    host.append(this.legend, this.hint, this.badge, this.zoomLabel, tools);
  }

  /** Creates the renderer. @param {'auto' | 'webgpu' | 'canvas'} preference */
  async init(preference) {
    this.renderer?.destroy();
    const { renderer, fallbackReason } = await createRenderer(this.host, preference);
    this.renderer = renderer;
    this.fallbackReason = fallbackReason;
    renderer.onLost = reason => this.recover(reason);
    this.attach(renderer.canvas);
    this.resize();
    this.updateBadge();
    this.invalidate();
    if (!this.observer) {
      this.observer = new ResizeObserver(() => this.resize());
      this.observer.observe(this.host);
      matchMedia(`(resolution: ${this.dpr}dppx)`).addEventListener?.('change', () => { this.dpr = window.devicePixelRatio || 1; this.resize(); });
    }
  }

  /** The GPU device was lost: continue on Canvas 2D on a fresh canvas. @param {string} reason */
  async recover(reason) {
    if (this.renderer?.backend !== 'webgpu') return;
    this.app.log('warn', `The WebGPU device was lost (${reason}). Drawing continues with Canvas 2D.`);
    this.renderer?.destroy();
    this.host.querySelector('canvas')?.remove();
    const canvas = h('canvas', { class: 'viewport-canvas', tabindex: '0', 'aria-label': 'Single-line diagram' });
    this.host.prepend(canvas);
    this.renderer = new Canvas2DRenderer(canvas);
    this.fallbackReason = `WebGPU device lost: ${reason}`;
    this.attach(canvas);
    this.resize();
    this.updateBadge();
    this.invalidate();
  }

  get backend() { return this.renderer?.backend ?? 'none'; }

  updateBadge() {
    const r = this.renderer;
    if (!r) return;
    this.badge.dataset.backend = r.backend;
    this.badge.innerHTML = `<span class="led"></span><strong>${r.label}</strong>${r.detail ? `<span>${r.detail}</span>` : ''}`;
    this.badge.title = r.backend === 'webgpu' ? `Rendering with WebGPU${r.detail ? ` (${r.detail})` : ''}.` : `Rendering with Canvas 2D. ${this.fallbackReason}`;
    this.app.statusBackend(r.label, r.backend, this.badge.title);
  }

  resize() {
    const rect = this.host.getBoundingClientRect();
    this.camera.width = Math.max(1, rect.width);
    this.camera.height = Math.max(1, rect.height);
    this.dpr = window.devicePixelRatio || 1;
    this.renderer?.resize(this.camera.width, this.camera.height, this.dpr);
    this.invalidate('view');
  }

  /**
   * Schedules a frame. 'scene' rebuilds the diagram and the overlay, 'overlay' only what changes with the selection,
   * the hover and a tool's preview, 'view' nothing (the camera moved).
   * @param {'scene' | 'overlay' | 'view'} [what]
   */
  invalidate(what = 'scene') {
    if (what === 'scene') this.sceneDirty = true;
    if (what !== 'view') this.overlayDirty = true;
    if (!this.frame) this.frame = requestAnimationFrame(() => this.render());
  }

  render() {
    this.frame = 0;
    const r = this.renderer;
    if (!r) return;
    if (this.sceneDirty) {
      this.sceneDirty = false;
      this.job = this.sceneJob(r);
    }
    // The build runs for a few milliseconds a frame; until it ends, the previous diagram stays on screen.
    if (this.job) {
      const t0 = performance.now();
      let step = this.job.next();
      while (!step.done && performance.now() - t0 < BUILD_BUDGET_MS) step = this.job.next();
      if (step.done) this.job = null; else this.invalidate('view');
    }
    if (this.overlayDirty) {
      this.overlayDirty = false;
      r.setOverlay(buildOverlay(this.sceneInput()));
    }
    r.draw(this.camera, this.app.palette, this.dpr);
    this.frames++;
    this.host.dataset.frames = String(this.frames);
    this.zoomLabel.textContent = `${Math.round(this.camera.zoom * 100)} %`;
  }

  /** The diagram's display list, without the selection and previews (exports draw it as it is). */
  buildList() { return buildScene(this.sceneInput()); }

  /** Builds the diagram and hands it to the renderer, in steps. @param {import('../render/renderer.js').Renderer} r
   * @returns {Generator<void, void, void>} */
  *sceneJob(r) {
    const list = yield* sceneSteps(this.sceneInput());
    if (r instanceof Canvas2DRenderer) r.commit('base', yield* r.packSteps(list));
    else r.commit('base', yield* r.packSteps(list));
  }

  /** Finishes a diagram build under way at once (before a snapshot). */
  flush() {
    if (this.sceneDirty || this.overlayDirty) this.render();
    while (this.job && !this.job.next().done);
    this.job = null;
  }

  /** @returns {import('../render/scene.js').SceneInput} */
  sceneInput() {
    const app = this.app;
    return {
      elements: app.store.doc.elements, palette: app.palette, selection: app.selection, hover: app.hover,
      overlay: app.overlay, preview: this.preview(), labels: { names: app.prefs.names, branchNames: app.prefs.branchNames, boxes: app.prefs.boxes },
    };
  }

  /** The preview for the current tool and pointer. @returns {import('../render/scene.js').Preview | null} */
  preview() {
    const d = this.drag, app = this.app;
    if (d?.kind === 'marquee') return { kind: 'marquee', x0: d.x0, y0: d.y0, x1: d.x1, y1: d.y1 };
    if (!this.pointerInside) return null;
    const p = this.pointer, tool = app.tool;
    if (tool === 'bus') return { kind: 'ghost-bus', x: snap(p.x), y: snap(p.y), len: 120 };
    if ((tool === 'line' || tool === 'trafo') && this.pending) {
      const bus = app.store.get(this.pending.from);
      if (bus) {
        const g = bar(bus), len = /** @type {number} */ (bus.len);
        const from = g.horizontal ? { x: g.x0 + (this.pending.pos + 0.5) * len, y: g.y0 } : { x: g.x0, y: g.y0 + (this.pending.pos + 0.5) * len };
        return { kind: 'rubber', from, to: p };
      }
    }
    if (tool === 'gen' || tool === 'extgrid' || tool === 'load' || tool === 'shunt') {
      const hit = this.busAt(p);
      if (hit) return { kind: 'ghost-port', cls: tool, bus: hit.id, pos: this.snapPos(hit, p), side: this.sideOf(hit, p) };
    }
    return null;
  }

  /** @param {Tool} tool */
  setHint(tool) {
    const text = HINTS[tool];
    this.hint.innerHTML = text ? `${text}${tool === 'pan' ? '' : ` · ${kbd('Escape')} to finish`}` : '';
    this.host.dataset.tool = tool === 'select' ? 'select' : tool === 'pan' ? 'pan' : 'place';
    this.pending = null;
    this.invalidate('overlay');
  }

  // ----- Camera -----

  fit() {
    this.camera.fit(bounds(this.app.store.doc.elements));
    this.invalidate('view');
  }

  /** @param {number} f */
  zoomBy(f) {
    this.camera.zoomAt(f, this.camera.width / 2, this.camera.height / 2);
    this.invalidate('view');
  }

  /** Brings elements into view, zooming out if needed. @param {string[]} ids */
  reveal(ids) {
    const els = ids.map(id => this.app.store.get(id)).filter(e => !!e);
    const pts = [];
    for (const el of els) {
      if (el.cls === 'bus') { const g = bar(el); pts.push({ x: g.x0, y: g.y0 }, { x: g.x1, y: g.y1 }); }
      else if (el.cls === 'line' || el.cls === 'trafo') {
        const k = branchKeys(el), a = this.app.store.get(/** @type {string} */ (el[k.a])), b = this.app.store.get(/** @type {string} */ (el[k.b]));
        if (a && b) for (const p of route(el, a, b)) pts.push(p);
      } else {
        const b = this.app.store.get(/** @type {string} */ (el.bus));
        if (b) pts.push({ x: /** @type {number} */ (b.x), y: /** @type {number} */ (b.y) + (el.side === 'above' ? -70 : 70) });
      }
    }
    if (!pts.length) return;
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    const box = { x0: minOf(xs), y0: minOf(ys), x1: maxOf(xs), y1: maxOf(ys) };
    const c = this.camera, tl = c.toScreen(box.x0, box.y0), br = c.toScreen(box.x1, box.y1);
    const inside = tl.x > 40 && tl.y > 40 && br.x < c.width - 40 && br.y < c.height - 40;
    if (inside) return;
    const zoom = c.zoom;
    c.fit({ x0: box.x0 - 120, y0: box.y0 - 120, x1: box.x1 + 120, y1: box.y1 + 120 });
    c.zoom = Math.min(zoom, c.zoom);
    this.invalidate('view');
  }

  /** The frame as the active renderer produced it (WebGPU: read back from the GPU), as a PNG data URL.
   * @returns {Promise<string>} */
  async snapshotPNG() {
    const r = this.renderer;
    if (!r) return '';
    this.flush();
    let frame;
    try {
      frame = await r.snapshot(this.camera, this.app.palette, this.dpr);
    } catch (error) {
      if (r.backend !== 'webgpu') throw error;
      // A GPU that fails a read-back is gone, whether or not the device-lost event has arrived yet.
      await this.recover(error instanceof Error ? error.message : String(error));
      return this.snapshotPNG();
    }
    const canvas = document.createElement('canvas');
    canvas.width = frame.width; canvas.height = frame.height;
    /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d')).putImageData(new ImageData(new Uint8ClampedArray(frame.rgba), frame.width, frame.height), 0, 0);
    return canvas.toDataURL('image/png');
  }

  // ----- Export -----

  exportSVG() {
    const box = bounds(this.app.store.doc.elements);
    const pad = 40;
    const b = { x0: box.x0 - pad - 160, y0: box.y0 - pad, x1: box.x1 + pad + 160, y1: box.y1 + pad };
    return toSVG(this.buildList(), b, this.app.palette.bg, this.app.store.doc.name);
  }

  /** Renders the whole diagram off screen with Canvas 2D at twice the resolution. @returns {Promise<Blob>} */
  exportPNG() {
    const box = bounds(this.app.store.doc.elements);
    const pad = 40, scale = 2;
    const w = box.x1 - box.x0 + 2 * pad + 320, hgt = box.y1 - box.y0 + 2 * pad;
    const canvas = document.createElement('canvas');
    const r = new Canvas2DRenderer(canvas);
    const cam = new Camera();
    cam.width = w; cam.height = hgt; cam.zoom = 1; cam.cx = (box.x0 + box.x1) / 2; cam.cy = (box.y0 + box.y1) / 2;
    r.resize(w, hgt, scale);
    r.setScene(this.buildList());
    r.draw(cam, { ...this.app.palette, grid: [0, 0, 0, 0] }, scale);
    return new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('PNG encoding failed.'))), 'image/png'));
  }

  // ----- Input -----

  /** @param {HTMLCanvasElement} canvas */
  attach(canvas) {
    canvas.addEventListener('pointerdown', e => this.onDown(e));
    canvas.addEventListener('pointermove', e => this.onMove(e));
    canvas.addEventListener('pointerup', e => this.onUp(e));
    canvas.addEventListener('pointercancel', e => this.onUp(e));
    canvas.addEventListener('pointerleave', () => { this.pointerInside = false; if (this.app.hover) this.app.setHover(''); this.app.statusPointer(null); this.invalidate('overlay'); });
    canvas.addEventListener('pointerenter', () => { this.pointerInside = true; });
    canvas.addEventListener('wheel', e => this.onWheel(e), { passive: false });
    canvas.addEventListener('dblclick', e => this.onDouble(e));
    canvas.addEventListener('contextmenu', e => this.onContext(e));
    canvas.addEventListener('keydown', e => { if (e.code === 'Space' && !e.repeat) { this.spaceDown = true; this.host.classList.add('panning-ready'); } });
    canvas.addEventListener('keyup', e => { if (e.code === 'Space') { this.spaceDown = false; this.host.classList.remove('panning-ready'); } });
  }

  /** @param {PointerEvent} e */
  local(e) {
    const r = this.host.getBoundingClientRect();
    return { sx: e.clientX - r.left, sy: e.clientY - r.top };
  }

  /** @param {PointerEvent} e */
  onDown(e) {
    const canvas = /** @type {HTMLCanvasElement} */ (e.currentTarget);
    canvas.focus({ preventScroll: true });
    const { sx, sy } = this.local(e);
    const p = this.camera.toWorld(sx, sy);
    this.pointer = p;
    if (e.pointerType === 'touch') {
      this.touches.set(e.pointerId, { x: sx, y: sy });
      if (this.touches.size === 2) {
        this.drag = null;
        const [a, b] = [...this.touches.values()];
        this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), zoom: this.camera.zoom, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
        return;
      }
    }
    if (e.button === 2) return;
    canvas.setPointerCapture(e.pointerId);
    const app = this.app, tool = app.tool;
    if (e.button === 1 || tool === 'pan' || this.spaceDown) {
      this.drag = { kind: 'pan', sx, sy, cx: this.camera.cx, cy: this.camera.cy };
      this.host.classList.add('panning');
      return;
    }
    if (tool !== 'select') { this.place(p); return; }
    const hit = hitTest(app.store.doc.elements, p, this.camera.zoom, app.selection, this.index());
    const key = `drag-${++this.dragSeq}`;
    if (!hit) {
      if (e.pointerType === 'touch') { this.drag = { kind: 'pan', sx, sy, cx: this.camera.cx, cy: this.camera.cy }; if (!e.shiftKey) app.setSelection([]); return; }
      this.drag = { kind: 'marquee', x0: p.x, y0: p.y, x1: p.x, y1: p.y, additive: e.shiftKey || e.metaKey || e.ctrlKey };
      if (!this.drag.additive) app.setSelection([]);
      return;
    }
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    if (hit.part === 'body') {
      if (additive) { app.toggleSelection(hit.id); return; }
      if (!app.selection.has(hit.id)) app.setSelection([hit.id]);
    }
    const el = /** @type {Element} */ (app.store.get(hit.id));
    if (hit.part === 'end0' || hit.part === 'end1') {
      const g = bar(el);
      this.drag = { kind: 'bus-end', id: el.id, end: hit.part === 'end0' ? 0 : 1, x0: g.horizontal ? g.x0 : g.y0, x1: g.horizontal ? g.x1 : g.y1, key };
    } else if (hit.part === 'bend') {
      const k = branchKeys(el), a = app.store.get(/** @type {string} */ (el[k.a])), b = app.store.get(/** @type {string} */ (el[k.b]));
      const hb = a && b ? bendHandle(route(el, a, b)) : null;
      this.drag = { kind: 'bend', id: el.id, axis: /** @type {'x' | 'y'} */ (hb?.axis ?? 'y'), orig: /** @type {number} */ (el.bend) || 0, start: p, key };
    } else if (hit.part === 'endA' || hit.part === 'endB') {
      this.drag = { kind: 'branch-end', id: el.id, end: hit.part === 'endA' ? 'A' : 'B', key };
    } else if (el.cls === 'gen' || el.cls === 'extgrid' || el.cls === 'load' || el.cls === 'shunt') {
      this.drag = app.selection.size === 1 ? { kind: 'slide', id: el.id, key } : this.moveDrag(p, key);
    } else if (el.cls === 'line' || el.cls === 'trafo') {
      const k = branchKeys(el), a = app.store.get(/** @type {string} */ (el[k.a])), b = app.store.get(/** @type {string} */ (el[k.b]));
      const hb = a && b ? bendHandle(route(el, a, b)) : null;
      this.drag = app.selection.size === 1 && hb ? { kind: 'bend', id: el.id, axis: /** @type {'x' | 'y'} */ (hb.axis), orig: /** @type {number} */ (el.bend) || 0, start: p, key } : this.moveDrag(p, key);
    } else {
      this.drag = this.moveDrag(p, key);
    }
  }

  /** A drag that moves every selected busbar (connections follow). @param {{ x: number, y: number }} p @param {string} key @returns {Drag} */
  moveDrag(p, key) {
    /** @type {Map<string, { x: number, y: number }>} */
    const orig = new Map();
    for (const id of this.app.selection) {
      const el = this.app.store.get(id);
      if (el?.cls === 'bus') orig.set(id, { x: /** @type {number} */ (el.x), y: /** @type {number} */ (el.y) });
    }
    return { kind: 'move', start: p, orig, key, moved: false };
  }

  /** @param {PointerEvent} e */
  onMove(e) {
    const { sx, sy } = this.local(e);
    const p = this.camera.toWorld(sx, sy);
    this.pointer = p;
    this.pointerInside = true;
    this.app.statusPointer(p);
    if (e.pointerType === 'touch' && this.touches.has(e.pointerId)) {
      this.touches.set(e.pointerId, { x: sx, y: sy });
      if (this.pinch && this.touches.size === 2) {
        const [a, b] = [...this.touches.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y), mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const target = Math.min(8, Math.max(0.01, this.pinch.zoom * d / Math.max(this.pinch.d, 1)));
        this.camera.zoomAt(target / this.camera.zoom, mid.x, mid.y);
        this.camera.cx -= (mid.x - this.pinch.mid.x) / this.camera.zoom;
        this.camera.cy -= (mid.y - this.pinch.mid.y) / this.camera.zoom;
        this.pinch.mid = mid;
        this.invalidate('view');
        return;
      }
    }
    const d = this.drag, app = this.app;
    if (!d) {
      if (app.tool === 'select') {
        const hit = hitTest(app.store.doc.elements, p, this.camera.zoom, app.selection, this.index());
        this.host.dataset.hover = !hit ? '' : hit.part === 'body' ? 'element' : 'handle';
        if ((hit?.id ?? '') !== app.hover) app.setHover(hit?.id ?? '');
      } else {
        this.invalidate('overlay');
      }
      return;
    }
    if (d.kind === 'pan') {
      this.camera.cx = d.cx - (sx - d.sx) / this.camera.zoom;
      this.camera.cy = d.cy - (sy - d.sy) / this.camera.zoom;
      this.invalidate('view');
      return;
    }
    if (d.kind === 'marquee') { d.x1 = p.x; d.y1 = p.y; this.invalidate('overlay'); return; }
    const store = app.store;
    try {
      if (d.kind === 'move') {
        const dx = p.x - d.start.x, dy = p.y - d.start.y;
        if (!d.moved && Math.hypot(dx, dy) * this.camera.zoom < 3) return;
        d.moved = true;
        store.transact(d.orig.size > 1 ? 'Move busbars' : 'Move busbar', tx => {
          for (const [id, o] of d.orig) { tx.set(id, 'x', snap(o.x + dx)); tx.set(id, 'y', snap(o.y + dy)); }
        }, { coalesce: d.key });
      } else if (d.kind === 'slide') {
        const el = /** @type {Element} */ (store.get(d.id)), bus = store.get(/** @type {string} */ (el.bus));
        if (!bus) return;
        store.transact('Move connection', tx => { tx.set(d.id, 'pos', this.snapPos(bus, p)); tx.set(d.id, 'side', this.sideOf(bus, p)); }, { coalesce: d.key });
      } else if (d.kind === 'bus-end') {
        const el = /** @type {Element} */ (store.get(d.id)), horizontal = el.orient !== 'v';
        const v = snap(horizontal ? p.x : p.y);
        const lo = d.end === 0 ? Math.min(v, d.x1 - 40) : d.x0, hi = d.end === 1 ? Math.max(v, d.x0 + 40) : d.x1;
        store.transact('Resize busbar', tx => { tx.set(d.id, 'len', hi - lo); tx.set(d.id, horizontal ? 'x' : 'y', (lo + hi) / 2); }, { coalesce: d.key });
      } else if (d.kind === 'bend') {
        const delta = d.axis === 'y' ? p.y - d.start.y : p.x - d.start.x;
        store.transact('Reroute', tx => tx.set(d.id, 'bend', Math.round((d.orig + delta) / 10) * 10), { coalesce: d.key });
      } else if (d.kind === 'branch-end') {
        const el = /** @type {Element} */ (store.get(d.id)), k = branchKeys(el);
        const bus = this.busAt(p);
        const [busKey, posKey] = d.end === 'A' ? [k.a, k.pa] : [k.b, k.pb];
        if (bus && bus.id === el[busKey]) store.transact('Move connection', tx => tx.set(d.id, posKey, this.snapPos(bus, p)), { coalesce: d.key });
        this.invalidate();
      }
    } catch (error) {
      app.toast('warn', error instanceof Error ? error.message : String(error));
      this.drag = null;
    }
  }

  /** @param {PointerEvent} e */
  onUp(e) {
    this.touches.delete(e.pointerId);
    if (this.touches.size < 2) this.pinch = null;
    const d = this.drag;
    this.drag = null;
    this.host.classList.remove('panning');
    if (!d) return;
    const app = this.app;
    if (d.kind === 'marquee') {
      const ids = inRect(app.store.doc.elements, d);
      if (Math.hypot(d.x1 - d.x0, d.y1 - d.y0) * this.camera.zoom > 3) app.setSelection(d.additive ? [...app.selection, ...ids] : ids);
      this.invalidate('overlay');
    } else if (d.kind === 'branch-end') {
      const { p } = { p: this.pointer };
      const el = app.store.get(d.id);
      const bus = this.busAt(p);
      if (el && bus) {
        const k = branchKeys(el);
        const [busKey, posKey] = d.end === 'A' ? [k.a, k.pa] : [k.b, k.pb];
        if (bus.id !== el[busKey]) {
          try { app.store.transact('Reconnect', tx => { tx.set(d.id, busKey, bus.id); tx.set(d.id, posKey, this.snapPos(bus, p)); }); app.log('info', `${el.name || el.id} now connects to ${bus.name || bus.id}.`); }
          catch (error) { app.toast('warn', error instanceof Error ? error.message : String(error)); }
        }
      }
    }
  }

  /** The hit index of the document as it is now, built again after an edit. */
  index() {
    const store = this.app.store;
    if (!this.hitIndex || this.hitRevision !== store.revision) {
      this.hitIndex = new HitIndex(store.doc.elements);
      this.hitRevision = store.revision;
    }
    return this.hitIndex;
  }

  /** Busbar under a point, if any. @param {{ x: number, y: number }} p */
  busAt(p) {
    const tol = 10 / this.camera.zoom;
    for (const el of this.index().near(p, tol + 8)) {
      if (el.cls !== 'bus') continue;
      const g = bar(el);
      const inside = g.horizontal
        ? p.x >= g.x0 - tol && p.x <= g.x1 + tol && Math.abs(p.y - g.y0) < 8 + tol
        : p.y >= g.y0 - tol && p.y <= g.y1 + tol && Math.abs(p.x - g.x0) < 8 + tol;
      if (inside) return el;
    }
    return null;
  }

  /** Position along a bar on a 10-unit grid. @param {Element} bus @param {{ x: number, y: number }} p */
  snapPos(bus, p) {
    const len = /** @type {number} */ (bus.len);
    const along = Math.round(positionOn(bus, p) * len / 10) * 10;
    return Math.round(Math.max(-0.5, Math.min(0.5, along / len)) * 1000) / 1000;
  }

  /** @param {Element} bus @param {{ x: number, y: number }} p @returns {'above' | 'below'} */
  sideOf(bus, p) {
    return bus.orient === 'v' ? (p.x < /** @type {number} */ (bus.x) ? 'above' : 'below') : (p.y < /** @type {number} */ (bus.y) ? 'above' : 'below');
  }

  /** Placement tools. @param {{ x: number, y: number }} p */
  place(p) {
    const app = this.app, tool = app.tool;
    if (tool === 'bus') { app.addBus(snap(p.x), snap(p.y)); return; }
    const bus = this.busAt(p);
    if (!bus) { if (tool !== 'line' && tool !== 'trafo') app.toast('info', 'Click on a busbar to connect to it.'); return; }
    if (tool === 'line' || tool === 'trafo') {
      if (!this.pending) { this.pending = { cls: tool, from: bus.id, pos: this.snapPos(bus, p) }; this.invalidate('overlay'); return; }
      if (this.pending.from === bus.id) { app.toast('info', 'Pick a different busbar for the other end.'); return; }
      const from = this.pending;
      this.pending = null;
      app.addBranch(tool, from.from, from.pos, bus.id, this.snapPos(bus, p));
      this.invalidate('overlay');
      return;
    }
    app.addPort(/** @type {'gen' | 'extgrid' | 'load' | 'shunt'} */ (tool), bus.id, this.snapPos(bus, p), this.sideOf(bus, p));
  }

  cancelPending() {
    if (!this.pending) return false;
    this.pending = null;
    this.invalidate('overlay');
    return true;
  }

  /** @param {WheelEvent} e */
  onWheel(e) {
    e.preventDefault();
    const { sx, sy } = this.local(/** @type {any} */ (e));
    const mouseWheel = e.deltaMode === 1 || (e.deltaX === 0 && Math.abs(e.deltaY) >= 50 && Number.isInteger(e.deltaY));
    if (e.ctrlKey || e.metaKey || mouseWheel) {
      const scale = e.deltaMode === 1 ? 0.05 : e.ctrlKey ? 0.01 : 0.0018;
      this.camera.zoomAt(Math.exp(-e.deltaY * scale), sx, sy);
    } else {
      this.camera.cx += e.deltaX / this.camera.zoom;
      this.camera.cy += e.deltaY / this.camera.zoom;
    }
    this.invalidate('view');
  }

  /** @param {MouseEvent} e */
  onDouble(e) {
    const { sx, sy } = this.local(/** @type {any} */ (e));
    const hit = hitTest(this.app.store.doc.elements, this.camera.toWorld(sx, sy), this.camera.zoom, new Set(), this.index());
    if (hit) { this.app.setSelection([hit.id]); this.app.focusInspector(); }
  }

  /** @param {MouseEvent} e */
  onContext(e) {
    e.preventDefault();
    const { sx, sy } = this.local(/** @type {any} */ (e));
    const p = this.camera.toWorld(sx, sy);
    const hit = hitTest(this.app.store.doc.elements, p, this.camera.zoom, new Set(), this.index());
    if (hit && !this.app.selection.has(hit.id)) this.app.setSelection([hit.id]);
    this.app.contextMenu(e.clientX, e.clientY, hit?.id ?? '', p);
  }
}
