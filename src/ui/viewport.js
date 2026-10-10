/** The diagram viewport: owns the renderer and camera, rebuilds the scene when something changes, and hands pointer
 * input to the active tool (`src/ui/tools/`). Panning, pinching and the wheel work the same in every tool. */

import { Camera } from '../render/camera.js';
import { createRenderer } from '../render/renderer.js';
import { Canvas2DRenderer } from '../render/canvas2d.js';
import { buildScene, buildOverlay, sceneSteps } from '../render/scene.js';
import { toSVG } from '../render/svg.js';
import { hitTest, HitIndex } from '../render/hittest.js';
import { bar, bounds, positionOn, route, branchKeys } from '../render/geometry.js';
import { SelectTool, PanTool } from './tools/select.js';
import { BusTool, PortTool, ConnectTool } from './tools/place.js';
import { PanGesture } from './tools/gestures.js';
import { h, setHtml } from './dom.js';
import { icon } from './icons.js';
import { kbd } from './keys.js';
import { minOf, maxOf } from '../core/extent.js';
import { canvasMeasure } from '../render/metrics.js';

/**
 * @typedef {import('../core/catalog.js').Element} Element
 * @typedef {import('../render/hittest.js').Hit} Hit
 * @typedef {'select' | 'pan' | 'bus' | 'line' | 'trafo' | 'gen' | 'extgrid' | 'load' | 'shunt'} ToolId
 * @typedef {import('./tools/tool.js').Pointer} Pointer
 */

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
    /** The tools, by the id the app's `tool` holds. @type {Record<ToolId, import('./tools/tool.js').Tool>} */
    this.tools = {
      select: new SelectTool(this), pan: new PanTool(this), bus: new BusTool(this),
      line: new ConnectTool(this, 'line'), trafo: new ConnectTool(this, 'trafo'),
      gen: new PortTool(this, 'gen'), extgrid: new PortTool(this, 'extgrid'), load: new PortTool(this, 'load'), shunt: new PortTool(this, 'shunt'),
    };
    /** The drag under way. @type {import('./tools/tool.js').Gesture | null} */
    this.gesture = null;
    /** @type {{ x: number, y: number }} */
    this.pointer = { x: 0, y: 0 };
    this.pointerInside = false;
    this.spaceDown = false;
    /** @type {Map<number, { x: number, y: number }>} */
    this.touches = new Map();
    this.pinch = /** @type {{ d: number, zoom: number, mid: { x: number, y: number } } | null} */ (null);
    this.dragSeq = 0;
    this.frames = 0;
    /** Text widths in the fonts the renderers draw. */
    this.measure = canvasMeasure();
    /** @type {HitIndex | null} */
    this.hitIndex = null;
    this.hitRevision = -1;
    /** Where the last diagram built put its labels. @type {import('../render/labels.js').LabelIndex | null} */
    this.labelIndex = null;

    this.badge = h('div', { class: 'vp-badge', role: 'status', 'aria-live': 'polite' });
    this.legend = h('div', { class: 'vp-legend', 'aria-label': 'Legend' });
    /** The zoom from which each voltage level of a large diagram shows, and the zoom the legend last showed them for.
     * @type {Map<number, number> | null} */
    this.levels = null;
    this.legendZoom = NaN;
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
    if (renderer instanceof Canvas2DRenderer) renderer.onPending = () => this.invalidate('view');
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
    const fallback = new Canvas2DRenderer(canvas);
    fallback.onPending = () => this.invalidate('view');
    this.renderer = fallback;
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
    setHtml(this.badge, `<span class="led"></span><strong>${r.label}</strong>${r.detail ? `<span>${r.detail}</span>` : ''}`);
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
    if (this.camera.zoom !== this.legendZoom) this.showLevels();
  }

  /** Marks in the legend the voltage levels a large diagram leaves out at this zoom. */
  showLevels() {
    this.legendZoom = this.camera.zoom;
    const levels = this.levels;
    let hidden = false;
    for (const sw of /** @type {NodeListOf<HTMLElement>} */ (this.legend.querySelectorAll('.sw[data-kv]'))) {
      const off = !!levels && this.camera.zoom < (levels.get(Number(sw.dataset.kv)) ?? 0);
      sw.classList.toggle('off', off);
    }
    if (levels) for (const z of levels.values()) if (this.camera.zoom < z) { hidden = true; break; }
    const note = /** @type {HTMLElement | null} */ (this.legend.querySelector('.lod'));
    if (note) note.hidden = !hidden;
  }

  /** The diagram's display list, without the selection and previews (exports draw it as it is). */
  buildList() { return buildScene(this.sceneInput()); }

  /** Builds the diagram and hands it to the renderer, in steps. @param {import('../render/renderer.js').Renderer} r
   * @returns {Generator<void, void, void>} */
  *sceneJob(r) {
    const list = yield* sceneSteps(this.sceneInput());
    this.levels = list.levels;
    this.labelIndex = list.labels;
    this.showLevels();
    if (r instanceof Canvas2DRenderer) r.commit('base', yield* r.packSteps(list));
    else r.commit('base', yield* r.packSteps(list));
    // Canvas 2D says on the badge when it draws a large diagram from a cache.
    this.updateBadge();
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
      overlay: app.overlay, preview: this.preview(), measure: this.measure,
      labels: { names: app.prefs.names, branchNames: app.prefs.branchNames, boxes: app.prefs.boxes, disentangle: app.prefs.disentangle },
    };
  }

  /** The active tool. */
  get tool() { return this.tools[/** @type {ToolId} */ (this.app.tool)]; }

  /** What the drag under way, or else the tool under the pointer, draws. @returns {import('../render/scene.js').Preview | null} */
  preview() {
    if (this.gesture) return this.gesture.preview();
    return this.pointerInside ? this.tool.preview(this.pointer) : null;
  }

  /** Switches the hint, the cursor and the half-finished actions to a newly chosen tool. @param {ToolId} id */
  setHint(id) {
    const tool = this.tools[id];
    setHtml(this.hint, tool.hint ? `${tool.hint}${id === 'pan' ? '' : ` · ${kbd('Escape')} to finish`}` : '');
    this.host.dataset.tool = tool.mode;
    for (const t of Object.values(this.tools)) t.cancel();
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
    const list = this.buildList();
    return toSVG(list, this.extent(list), this.app.palette.bg, this.app.store.doc.name);
  }

  /**
   * The whole drawing's extent in world units: the network with its stubs and symbols, and every label where the
   * placer put it, with a margin. @param {import('../render/displaylist.js').DisplayList} [list] a built diagram
   */
  extent(list = this.buildList()) {
    const box = bounds(this.app.store.doc.elements), labels = list.labels?.extent(), pad = 40;
    return {
      x0: Math.min(box.x0, labels?.x0 ?? Infinity) - pad, y0: Math.min(box.y0, labels?.y0 ?? Infinity) - pad,
      x1: Math.max(box.x1, labels?.x1 ?? -Infinity) + pad, y1: Math.max(box.y1, labels?.y1 ?? -Infinity) + pad,
    };
  }

  /** Renders the whole diagram off screen with Canvas 2D at twice the resolution. @returns {Promise<Blob>} */
  exportPNG() {
    const list = this.buildList(), box = this.extent(list), scale = 2;
    const w = box.x1 - box.x0, hgt = box.y1 - box.y0;
    const canvas = document.createElement('canvas');
    const r = new Canvas2DRenderer(canvas);
    const cam = new Camera();
    cam.width = w; cam.height = hgt; cam.zoom = 1; cam.cx = (box.x0 + box.x1) / 2; cam.cy = (box.y0 + box.y1) / 2;
    r.resize(w, hgt, scale);
    r.setScene(list);
    // An export draws the whole diagram at once, however large.
    r.cached = false;
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

  /** @param {PointerEvent | MouseEvent} e */
  local(e) {
    const r = this.host.getBoundingClientRect();
    return { sx: e.clientX - r.left, sy: e.clientY - r.top };
  }

  /** A pointer event as the tools see it. @param {PointerEvent} e @returns {Pointer} */
  pointerOf(e) {
    const { sx, sy } = this.local(e);
    return { p: this.camera.toWorld(sx, sy), sx, sy, shift: e.shiftKey, alt: e.altKey, mod: e.ctrlKey || e.metaKey, touch: e.pointerType === 'touch' };
  }

  /** @param {PointerEvent} e */
  onDown(e) {
    const canvas = /** @type {HTMLCanvasElement} */ (e.currentTarget);
    canvas.focus({ preventScroll: true });
    const ptr = this.pointerOf(e);
    this.pointer = ptr.p;
    if (ptr.touch) {
      this.touches.set(e.pointerId, { x: ptr.sx, y: ptr.sy });
      if (this.touches.size === 2) {
        this.gesture = null;
        const [a, b] = [...this.touches.values()];
        this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), zoom: this.camera.zoom, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
        return;
      }
    }
    if (e.button === 2) return;
    canvas.setPointerCapture(e.pointerId);
    // The middle button and Space pan in every tool.
    this.gesture = e.button === 1 || this.spaceDown ? new PanGesture(this, ptr) : this.tool.down(ptr);
  }

  /** @param {PointerEvent} e */
  onMove(e) {
    const ptr = this.pointerOf(e);
    this.pointer = ptr.p;
    this.pointerInside = true;
    this.app.statusPointer(ptr.p);
    if (ptr.touch && this.touches.has(e.pointerId)) {
      this.touches.set(e.pointerId, { x: ptr.sx, y: ptr.sy });
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
    if (!this.gesture) { this.tool.hover(ptr); return; }
    try {
      this.gesture.move(ptr);
    } catch (error) {
      // An edit the store refuses ends the drag; what it had done stays, as one step.
      this.app.toast('warn', error instanceof Error ? error.message : String(error));
      this.gesture = null;
    }
  }

  /** @param {PointerEvent} e */
  onUp(e) {
    this.touches.delete(e.pointerId);
    if (this.touches.size < 2) this.pinch = null;
    const g = this.gesture;
    this.gesture = null;
    this.host.classList.remove('panning');
    g?.end(this.pointerOf(e));
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

  /** The label under a point, as last drawn, if it shows at this zoom. @param {{ x: number, y: number }} p */
  labelAt(p) { return this.labelIndex?.at(p, this.camera.zoom) ?? null; }

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

  /** Escape: drops the active tool's half-finished action; true if there was one. */
  cancelPending() { return this.tool.cancel(); }

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
    const p = this.camera.toWorld(sx, sy);
    const id = this.labelAt(p)?.owner ?? hitTest(this.app.store.doc.elements, p, this.camera.zoom, new Set(), this.index())?.id;
    if (id) { this.app.setSelection([id]); this.app.focusInspector(); }
  }

  /** @param {MouseEvent} e */
  onContext(e) {
    e.preventDefault();
    const { sx, sy } = this.local(/** @type {any} */ (e));
    const p = this.camera.toWorld(sx, sy);
    const label = this.labelAt(p);
    const id = label?.owner ?? hitTest(this.app.store.doc.elements, p, this.camera.zoom, new Set(), this.index())?.id ?? '';
    if (id && !this.app.selection.has(id)) this.app.setSelection([id]);
    this.app.contextMenu(e.clientX, e.clientY, id, p, label);
  }
}
