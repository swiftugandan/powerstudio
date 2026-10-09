/** The application: owns the document store, selection, tools, results and preferences, defines every command, and
 * keeps the ribbon, model tree, viewport, inspector, results dock and status bar in step. */

import { DocumentStore } from './core/store.js';
import { emptyDocument, nextId, normalizeDocument, validateForCalculation, busesOf } from './core/document.js';
import { makeElement, CLASSES } from './core/catalog.js';
import { importMatpower } from './core/matpower.js';
import { autoLayout, snap } from './core/layout.js';
import { SAMPLES } from './samples/index.js';
import { Commands } from './ui/commands.js';
import { Ribbon } from './ui/ribbon.js';
import { ModelTree } from './ui/tree.js';
import { Inspector } from './ui/inspector.js';
import { Dock } from './ui/dock.js';
import { Viewport } from './ui/viewport.js';
import { EngineClient, CancelledError } from './ui/engine-client.js';
import { savePrefs, newDocId } from './ui/persistence.js';
import { applyTheme, readPalette } from './ui/theme.js';
import { buildOverlay } from './ui/overlay.js';
import { openPalette } from './ui/palette.js';
import { openBackstage, closeBackstage } from './ui/backstage.js';
import { openStudyDialog } from './ui/study.js';
import { toast, contextMenu } from './ui/feedback.js';
import { h, byId, download, fileName } from './ui/dom.js';
import { icon, logo } from './ui/icons.js';
import { kbd, isMac } from './ui/keys.js';
import { fixed, duration } from './ui/format.js';
import { enumLabel } from './ui/fields.js';
import { REPO_URL } from './core/version.js';

/**
 * @typedef {import('./core/catalog.js').Element} Element
 * @typedef {import('./core/document.js').PowerDocument} PowerDocument
 * @typedef {import('./ui/viewport.js').Tool} Tool
 * @typedef {'loadflow' | 'shortcircuit' | 'contingency' | 'rms'} CalcKind
 * @typedef {{ result: any, ms: number, revision: number }} StoredResult
 */

const CALC_LABEL = /** @type {Record<CalcKind, string>} */ ({ loadflow: 'Load flow', shortcircuit: 'Short circuit', contingency: 'N-1 contingency analysis', rms: 'Stability simulation' });

export class App {
  /** @param {{ workerFactory: () => Worker, prefs: import('./ui/persistence.js').Prefs, library: import('./ui/persistence.js').DocumentLibrary, renderer: 'auto' | 'webgpu' | 'canvas' }} opt */
  constructor(opt) {
    this.prefs = opt.prefs;
    this.library = opt.library;
    this.rendererPreference = opt.renderer;
    this.store = new DocumentStore(emptyDocument());
    this.docId = '';
    /** @type {Set<string>} */
    this.selection = new Set();
    this.hover = '';
    /** @type {Tool} */
    this.tool = 'select';
    /** @type {Partial<Record<CalcKind, StoredResult>>} */
    this.results = {};
    /** @type {CalcKind | 'none'} */
    this.overlayKind = 'none';
    /** @type {import('./render/scene.js').Overlay | null} */
    this.overlay = null;
    this.rmsIndex = -1;
    this.networkRevision = 0;
    /** @type {CalcKind | ''} */
    this.running = '';
    /** @type {{ elements: Element[] } | null} */
    this.clipboard = null;
    this.saveTimer = 0;
    this.autoTimer = 0;
    /** @type {Record<'tool' | 'pointer' | 'selection' | 'message' | 'progress' | 'backend', HTMLElement> | null} */
    this.status = null;
    this.palette = readPalette();
    this.engine = new EngineClient(opt.workerFactory);
    this.commands = new Commands();

    const app = byId('app');
    this.root = app;
    this.viewport = new Viewport(this, byId('viewport'));
    this.registerCommands();
    this.ribbon = new Ribbon(byId('ribbon'), this.commands, tab => { if (tab === 'file') openBackstage(this); else { this.prefs.ribbonTab = tab; this.savePrefs(); } });
    this.tree = new ModelTree(byId('tree-panel'), this);
    this.inspector = new Inspector(byId('inspector-panel'), this);
    this.dock = new Dock(byId('dock'), this);
    this.buildChrome();
    this.applyLayout();

    this.store.subscribe(change => this.onChange(change));
    document.addEventListener('click', e => {
      const b = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-cmd]'));
      if (b && !b.closest('.ribbon-tabs') && !(/** @type {HTMLButtonElement} */ (b).disabled)) this.commands.run(/** @type {string} */ (b.dataset.cmd));
    });
    document.addEventListener('keydown', e => {
      if (document.querySelector('.scrim, .palette')) return;
      this.commands.handleKey(e);
    });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.refreshTheme());
    this.installDrop();
    window.addEventListener('pagehide', () => this.flushSave());
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') this.flushSave(); });
  }

  // ----- Boot -----

  /** @param {{ sample?: string }} [opt] */
  async boot(opt = {}) {
    applyTheme(this.prefs.theme);
    this.palette = readPalette();
    await this.viewport.init(this.rendererPreference);
    await this.library.open();
    if (!this.library.persistent) this.log('warn', 'This browser does not allow local storage here. Networks last only for this session; export them to keep them.');
    const sample = SAMPLES.find(s => s.id === opt.sample);
    let opened = false;
    if (sample) { await this.openSample(sample.id, { quiet: true }); opened = true; }
    else if (this.prefs.lastDoc) opened = await this.openStored(this.prefs.lastDoc, { quiet: true });
    if (!opened) {
      const recent = (await this.library.list())[0];
      if (recent) opened = await this.openStored(recent.id, { quiet: true });
    }
    if (!opened) await this.openSample('ieee14', { quiet: true });
    this.ribbon.select(this.prefs.ribbonTab in { home: 1, insert: 1, calculate: 1, view: 1, help: 1 } ? this.prefs.ribbonTab : 'home');
    this.log('info', `PowerStudio is ready. Drawing with ${this.viewport.renderer?.label}${this.viewport.renderer?.detail ? ` (${this.viewport.renderer.detail})` : ''}.`, this.viewport.fallbackReason || undefined);
    if (!this.prefs.welcomed) {
      this.prefs.welcomed = true;
      this.savePrefs();
      toast('info', `Run a load flow with ${isMac ? '⌥L' : 'Alt+L'}, or press ${isMac ? '⌘K' : 'Ctrl+K'} to find any command.`, { title: `${this.store.doc.name} is open` });
    }
    this.root.dataset.state = 'ready';
  }

  buildChrome() {
    byId('brand').innerHTML = `${logo(24)}<span class="brand-name">PowerStudio</span><span class="brand-tag">Grid studies in the browser</span>`;
    const trigger = byId('palette-trigger');
    trigger.innerHTML = `${icon('search', 15)}<span>Search commands and elements</span>${kbd('Mod+K')}`;
    trigger.setAttribute('aria-label', 'Search commands and elements');
    const name = /** @type {HTMLInputElement} */ (byId('doc-name'));
    name.addEventListener('change', () => {
      const v = name.value.trim() || 'Untitled network';
      this.store.transact('Rename network', tx => tx.setDoc('name', v));
    });
    name.addEventListener('keydown', e => { if (e.key === 'Enter') name.blur(); if (e.key === 'Escape') { name.value = this.store.doc.name; name.blur(); } });
    byId('title-actions').append(
      h('button', { type: 'button', class: 'icon-btn mobile-only', title: 'Model', 'aria-label': 'Show model', 'data-cmd': 'view.sheetLeft', html: icon('panelLeft', 18) }),
      h('button', { type: 'button', class: 'icon-btn mobile-only', title: 'Inspector', 'aria-label': 'Show inspector', 'data-cmd': 'view.sheetRight', html: icon('panelRight', 18) }),
      h('button', { type: 'button', class: 'icon-btn desktop-only', title: 'Toggle theme', 'aria-label': 'Toggle theme', 'data-cmd': 'view.toggleTheme', html: icon('colour', 18) }),
      h('button', { type: 'button', class: 'icon-btn desktop-only', title: 'Keyboard shortcuts', 'aria-label': 'Keyboard shortcuts', 'data-cmd': 'help.shortcuts', html: icon('keyboard', 18) }),
      h('a', { class: 'icon-btn desktop-only', href: REPO_URL, target: '_blank', rel: 'noopener', title: 'Source code on GitHub', 'aria-label': 'Source code on GitHub', html: icon('github', 18) }));
    this.status = {
      tool: h('span', { class: 'cell' }), pointer: h('span', { class: 'cell mono hide-narrow', text: '—' }), selection: h('span', { class: 'cell hide-narrow' }),
      message: h('span', { class: 'cell grow' }), progress: h('span', { class: 'cell', hidden: true }), backend: h('span', { class: 'cell', title: '' }),
    };
    byId('statusbar').append(...Object.values(this.status));
    this.setupSplitters();
  }

  // ----- Documents -----

  /** Loads a document into the editor. @param {PowerDocument} doc @param {string} id */
  load(doc, id) {
    this.flushSave();
    this.docId = id;
    this.prefs.lastDoc = id;
    this.savePrefs();
    this.results = {};
    this.overlayKind = 'none';
    this.overlay = null;
    this.rmsIndex = -1;
    this.selection = new Set();
    this.setTool('select');
    this.store.load(doc);
    this.viewport.fit();
    this.refreshLegend();
    this.dock.render();
    this.markSaved();
  }

  newDocument() {
    const doc = emptyDocument('Untitled network');
    const id = newDocId();
    this.load(doc, id);
    this.save();
    this.log('info', 'New network. Insert busbars from the Insert tab or press B.');
    this.ribbon.select('insert');
  }

  /** @param {string} sampleId @param {{ quiet?: boolean }} [opt] */
  async openSample(sampleId, opt = {}) {
    const s = SAMPLES.find(x => x.id === sampleId);
    if (!s) return;
    this.load(s.create(), newDocId());
    await this.save();
    if (!opt.quiet) this.log('info', `Opened the sample “${s.title}”. It is a copy; the original is always available from File.`);
  }

  /** @param {string} id @param {{ quiet?: boolean }} [opt] */
  async openStored(id, opt = {}) {
    try {
      const rec = await this.library.get(id);
      if (!rec) return false;
      const { doc, issues } = normalizeDocument(rec.doc);
      this.load(doc, id);
      for (const i of issues) this.log('warn', i);
      if (!opt.quiet) this.log('info', `Opened “${doc.name}”.`);
      return true;
    } catch (error) {
      this.log('error', `Could not open the saved network: ${error instanceof Error ? error.message : error}`);
      return false;
    }
  }

  /** @param {string} id */
  async deleteStored(id) {
    await this.library.remove(id);
    if (id === this.docId) {
      const next = (await this.library.list())[0];
      if (next) await this.openStored(next.id); else this.newDocument();
    }
  }

  async save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = 0;
    try {
      await this.library.put(this.docId, this.store.doc);
      this.markSaved();
    } catch (error) {
      this.setSaveState('pending', 'Not saved');
      this.log('error', `Saving in this browser failed: ${error instanceof Error ? error.message : error}. Export the network to keep it.`);
    }
  }

  scheduleSave() {
    this.setSaveState('pending', 'Saving…');
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.save(), 400);
  }

  flushSave() { if (this.saveTimer) this.save(); }

  markSaved() { this.setSaveState('saved', this.library.persistent ? 'Saved in this browser' : 'Kept for this session'); }

  /** @param {'saved' | 'pending'} state @param {string} text */
  setSaveState(state, text) {
    const el = byId('save-state');
    el.dataset.state = state;
    el.innerHTML = `<span class="dot"></span><span>${text}</span>`;
  }

  /** Imports a file the user picks. @param {string} accept */
  importFile(accept) {
    const input = h('input', { type: 'file', accept, style: 'display:none' });
    input.addEventListener('change', () => { const f = input.files?.[0]; if (f) this.importFileObject(f); input.remove(); });
    document.body.append(input);
    input.click();
  }

  /** @param {File} file */
  async importFileObject(file) {
    try {
      const text = await file.text();
      let doc, issues;
      if (/\.m$/i.test(file.name) || /mpc\.bus\s*=/.test(text)) ({ doc, issues } = importMatpower(text));
      else {
        let json;
        try { json = JSON.parse(text); } catch { throw new Error('The file is neither JSON nor a MATPOWER case.'); }
        ({ doc, issues } = normalizeDocument(json));
      }
      this.load(doc, newDocId());
      await this.save();
      this.log('ok', `Imported “${file.name}” as “${doc.name}” with ${doc.elements.length} elements.`);
      for (const i of issues) this.log('warn', i);
      toast(issues.length ? 'warn' : 'ok', issues.length ? `${issues.length} note${issues.length === 1 ? '' : 's'} in the Output panel.` : `${doc.elements.length} elements.`, { title: `Imported ${file.name}` });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.log('error', `Import of “${file.name}” failed: ${msg}`);
      toast('error', msg, { title: 'Import failed' });
    }
  }

  installDrop() {
    window.addEventListener('dragover', e => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
    window.addEventListener('drop', e => {
      const f = e.dataTransfer?.files?.[0];
      if (!f) return;
      e.preventDefault();
      this.importFileObject(f);
    });
  }

  exportJSON() {
    const text = JSON.stringify(this.store.doc, null, 2) + '\n';
    download(new Blob([text], { type: 'application/json' }), fileName(this.store.doc.name, '.powerstudio.json'));
    this.log('ok', `Exported “${this.store.doc.name}” as a PowerStudio file.`);
  }

  // ----- Changes -----

  /** @param {import('./core/store.js').Change} change */
  onChange(change) {
    if (change.network || change.study) this.networkRevision++;
    for (const id of [...this.selection]) if (!this.store.get(id)) this.selection.delete(id);
    const name = /** @type {HTMLInputElement} */ (byId('doc-name'));
    if (document.activeElement !== name) name.value = this.store.doc.name;
    document.title = `${this.store.doc.name} · PowerStudio`;
    this.tree.render();
    this.inspector.schedule();
    if (this.overlayKind !== 'none') this.rebuildOverlay();
    this.viewport.invalidate();
    this.dock.renderTabs();
    if (change.network || change.study) {
      if (this.dock.tab !== 'output') this.dock.render();
      if (change.source !== 'load') this.maybeAutoLoadFlow();
    }
    this.updateStatus();
    this.commands.changed();
    if (change.source !== 'load') this.scheduleSave();
    if (change.source === 'undo' || change.source === 'redo') this.setStatusMessage(`${change.source === 'undo' ? 'Undid' : 'Redid'}: ${change.label}`);
  }

  maybeAutoLoadFlow() {
    if (!this.prefs.autoLoadFlow || !this.results.loadflow || this.running) return;
    clearTimeout(this.autoTimer);
    this.autoTimer = window.setTimeout(() => this.calc('loadflow', { auto: true }), 250);
  }

  /** Runs an edit and reports a refusal instead of throwing. @param {string} label @param {() => void} fn @returns {string} error message or '' */
  tryEdit(label, fn) {
    try { fn(); return ''; }
    catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.setStatusMessage(`${label}: ${msg}`);
      return msg;
    }
  }

  // ----- Selection, hover, tools -----

  /** @param {Iterable<string>} ids */
  setSelection(ids) {
    this.selection = new Set([...ids].filter(id => this.store.get(id)));
    this.onSelection();
  }

  /** @param {string} id */
  toggleSelection(id) {
    if (this.selection.has(id)) this.selection.delete(id); else this.selection.add(id);
    this.onSelection();
  }

  onSelection() {
    this.tree.render();
    this.inspector.schedule();
    this.viewport.invalidate();
    if (this.dock.tab !== 'output' && this.dock.tab !== 'rms') this.dock.render();
    this.updateStatus();
    this.commands.changed();
    if (this.selection.size === 1 && this.root.dataset.sheet === 'left') this.root.dataset.sheet = '';
  }

  /** @param {string} id */
  setHover(id) { this.hover = id; this.viewport.invalidate(); }

  /** @param {Tool} tool */
  setTool(tool) {
    this.tool = tool;
    this.viewport.setHint(tool);
    this.updateStatus();
    this.commands.changed();
    if (tool !== 'select') this.viewport.renderer?.canvas.focus({ preventScroll: true });
  }

  focusInspector() {
    if (!this.prefs.right) this.setPanel('right', true);
    if (innerWidth <= 760) this.root.dataset.sheet = 'right';
    requestAnimationFrame(() => this.inspector.focus());
  }

  /** Status colour per element for the model tree, from the results on show. @returns {Map<string, string>} */
  elementStatus() {
    const out = new Map();
    if (this.overlayKind === 'loadflow' && this.results.loadflow) {
      const r = this.results.loadflow.result;
      for (const b of r.branches) if (b.loading > 90) out.set(b.id, b.loading > 100 ? 'var(--res-high)' : 'var(--res-warn)');
      for (const b of r.buses) { const e = this.store.get(b.id); if (e && (b.vm < /** @type {number} */ (e.vmin) || b.vm > /** @type {number} */ (e.vmax))) out.set(b.id, b.vm < /** @type {number} */ (e.vmin) ? 'var(--res-low)' : 'var(--res-high)'); }
      for (const id of r.deenergized) out.set(id, 'var(--text-3)');
    } else if (this.overlayKind === 'contingency' && this.results.contingency) {
      for (const c of this.results.contingency.result.cases) if (!c.converged || c.violations.some((/** @type {any} */ v) => !v.inBase)) out.set(c.id, 'var(--res-high)');
    }
    return out;
  }

  // ----- Element creation -----

  /** A unique default name. @param {string} base */
  uniqueName(base) {
    const names = new Set(this.store.doc.elements.map(e => e.name));
    for (let i = 1; ; i++) { const n = `${base} ${i}`; if (!names.has(n)) return n; }
  }

  /** @param {Element} el @param {string} label */
  create(el, label) {
    if (this.tryEdit(label, () => this.store.transact(label, tx => tx.add(el)))) return;
    this.setSelection([el.id]);
    this.setStatusMessage(`${label}: ${el.name}`);
  }

  /** @param {number} x @param {number} y */
  addBus(x, y) {
    const id = nextId(this.store.index.keys(), 'bus');
    this.create(makeElement('bus', id, { name: this.uniqueName('Busbar'), vn: this.prefs.lastKV, x, y, len: 120 }), 'Add busbar');
  }

  /** @param {'line' | 'trafo'} cls @param {string} aId @param {number} aPos @param {string} bId @param {number} bPos */
  addBranch(cls, aId, aPos, bId, bPos) {
    const a = /** @type {Element} */ (this.store.get(aId)), b = /** @type {Element} */ (this.store.get(bId));
    const va = /** @type {number} */ (a.vn), vb = /** @type {number} */ (b.vn);
    const id = nextId(this.store.index.keys(), cls);
    if (cls === 'line') {
      if (Math.abs(va - vb) > 1e-9 * va) {
        toast('warn', `${a.name} is ${va} kV and ${b.name} is ${vb} kV. Connect them with a transformer.`, { title: 'Different voltages', action: { label: 'Use transformer', run: () => this.addBranch('trafo', aId, aPos, bId, bPos) } });
        return;
      }
      const cable = va <= 36;
      this.create(makeElement('line', id, { name: `${a.name} – ${b.name}`, from: aId, to: bId, fromPos: aPos, toPos: bPos, length: cable ? 3 : 20,
        ...(cable ? { r1: 0.125, x1: 0.11, b1: 125.7, r0: 0.5, x0: 0.33, b0: 125.7, ratedA: 0.42 } : {}) }), 'Add line');
      return;
    }
    const [hv, lv, hvPos, lvPos] = va >= vb ? [a, b, aPos, bPos] : [b, a, bPos, aPos];
    const vh = /** @type {number} */ (hv.vn), vl = /** @type {number} */ (lv.vn);
    const params = vl < 1 ? { sn: 0.63, uk: 6, ur: 1.0, uk0: 6, ur0: 1.0, i0: 0.3, pfe: 1, vectorGroup: 'Dyn5' }
      : vh >= 100 ? { sn: 40, uk: 12, ur: 0.4, uk0: 12, ur0: 0.4, i0: 0.05, pfe: 20, vectorGroup: 'YNyn0' }
      : { sn: 10, uk: 8, ur: 0.6, uk0: 8, ur0: 0.6, i0: 0.2, pfe: 8, vectorGroup: 'Dyn11' };
    this.create(makeElement('trafo', id, { name: `${hv.name} / ${lv.name}`, hv: hv.id, lv: lv.id, hvPos, lvPos, vnHV: vh, vnLV: vl, ...params }), 'Add transformer');
  }

  /** @param {'gen' | 'extgrid' | 'load' | 'shunt'} cls @param {string} busId @param {number} pos @param {'above' | 'below'} side */
  addPort(cls, busId, pos, side) {
    const bus = /** @type {Element} */ (this.store.get(busId)), vn = /** @type {number} */ (bus.vn);
    const id = nextId(this.store.index.keys(), cls);
    const scale = vn < 1 ? 0.02 : vn < 50 ? 0.2 : 1;
    const hasSource = this.store.doc.elements.some(e => e.cls === 'extgrid' || (e.cls === 'gen' && e.mode === 'Reference'));
    /** @type {Record<string, Record<string, unknown>>} */
    const defaults = {
      gen: { name: this.uniqueName('Generator'), mode: hasSource ? 'PV' : 'Reference', vn, p: 50 * scale, sn: 60 * scale, qmin: -30 * scale, qmax: 40 * scale },
      extgrid: { name: this.uniqueName('Grid'), skMax: vn >= 100 ? 5000 : vn >= 1 ? 500 : 20, skMin: vn >= 100 ? 4000 : vn >= 1 ? 400 : 15 },
      load: { name: this.uniqueName('Load'), p: 10 * scale, q: 3 * scale },
      shunt: { name: this.uniqueName('Shunt'), q: 10 * scale, vn },
    };
    this.create(makeElement(cls, id, { bus: busId, pos, side, ...defaults[cls] }), `Add ${CLASSES[cls].label.toLowerCase()}`);
  }

  // ----- Clipboard -----

  copy() {
    const ids = new Set(this.selection);
    for (const el of this.store.doc.elements) if (el.cls !== 'bus' && el.cls !== 'line' && el.cls !== 'trafo' && ids.has(/** @type {string} */ (el.bus))) ids.add(el.id);
    const els = this.store.doc.elements.filter(e => ids.has(e.id) && (e.cls === 'bus' || busesOf(e).every(b => ids.has(b) || (e.cls !== 'line' && e.cls !== 'trafo'))));
    if (!els.length) return 0;
    this.clipboard = { elements: structuredClone(els) };
    try { navigator.clipboard?.writeText(JSON.stringify({ powerstudio: 1, elements: els })).catch(() => {}); } catch { /* clipboard permission is optional */ }
    return els.length;
  }

  paste() {
    const clip = this.clipboard;
    if (!clip) return;
    const map = new Map(), ids = new Set(this.store.index.keys());
    /** @type {Element[]} */
    const created = [];
    for (const el of clip.elements) {
      const id = nextId(ids, el.cls);
      ids.add(id);
      map.set(el.id, id);
    }
    const pastedIds = new Set(map.values());
    for (const src of clip.elements) {
      const el = /** @type {Element} */ ({ ...structuredClone(src), id: map.get(src.id) });
      if (el.cls === 'bus') { el.x = /** @type {number} */ (el.x) + 40; el.y = /** @type {number} */ (el.y) + 40; el.name = `${src.name} (copy)`; }
      else {
        for (const k of CLASSES[el.cls].ends) el[k] = map.get(/** @type {string} */ (src[k])) ?? src[k];
        // Each end must land on a pasted busbar or on one that still exists.
        if (busesOf(el).some(b => !this.store.get(b) && !pastedIds.has(b))) continue;
      }
      created.push(el);
    }
    if (this.tryEdit('Paste', () => this.store.transact('Paste', tx => { for (const el of created) tx.add(el); }))) return;
    this.setSelection(created.map(e => e.id));
    this.setStatusMessage(`Pasted ${created.length} element${created.length === 1 ? '' : 's'}.`);
  }

  deleteSelection() {
    const ids = [...this.selection];
    if (!ids.length) return;
    const label = ids.length === 1 ? `Delete ${this.store.get(ids[0])?.name || ids[0]}` : `Delete ${ids.length} elements`;
    this.tryEdit(label, () => this.store.transact(label, tx => { for (const id of ids) tx.remove(id); }));
    this.setSelection([]);
    this.setStatusMessage(`${label}. ${kbd('Mod+Z').replace(/<[^>]+>/g, '')} undoes it.`);
  }

  toggleService() {
    const els = [...this.selection].map(id => this.store.get(id)).filter(e => e && e.cls !== 'bus');
    if (!els.length) return;
    const on = els.some(e => e?.inService === false);
    this.tryEdit('Switch', () => this.store.transact(on ? 'Switch into service' : 'Switch out of service', tx => { for (const e of els) tx.set(/** @type {Element} */ (e).id, 'inService', on); }));
  }

  /** Lays the whole diagram out again from the topology, as one undoable step. */
  arrange() {
    const doc = structuredClone(this.store.doc);
    autoLayout(doc);
    const keys = ['x', 'y', 'len', 'orient', 'fromPos', 'toPos', 'hvPos', 'lvPos', 'pos', 'side', 'bend'];
    this.store.transact('Arrange diagram', tx => { for (const el of doc.elements) for (const k of keys) if (k in el && this.store.get(el.id)?.[k] !== el[k]) tx.set(el.id, k, el[k]); });
    this.viewport.fit();
  }

  /** @param {number} dx @param {number} dy */
  nudge(dx, dy) {
    const buses = [...this.selection].map(id => this.store.get(id)).filter(e => e?.cls === 'bus');
    if (!buses.length) return;
    this.store.transact('Move busbars', tx => { for (const b of buses) { const e = /** @type {Element} */ (b); tx.set(e.id, 'x', snap(/** @type {number} */ (e.x) + dx)); tx.set(e.id, 'y', snap(/** @type {number} */ (e.y) + dy)); } }, { coalesce: 'nudge' });
  }

  // ----- Calculations -----

  /** @param {CalcKind} kind @param {{ auto?: boolean }} [opt] */
  async calc(kind, opt = {}) {
    const doc = this.store.doc;
    const problems = validateForCalculation(doc);
    if (problems.length) {
      for (const p of problems) this.log('error', p);
      if (!opt.auto) toast('error', problems[0], { title: `${CALC_LABEL[kind]} cannot run` });
      return;
    }
    if (!doc.elements.some(e => e.cls === 'bus')) { if (!opt.auto) toast('info', 'Draw a network first: insert busbars, a source and some loads.', { title: 'Nothing to calculate' }); return; }
    this.running = kind;
    this.commands.changed();
    this.showProgress(0, 1);
    const revision = this.networkRevision;
    const t0 = performance.now();
    try {
      const { result, ms } = await this.engine.run(kind, doc, {}, (done, total) => this.showProgress(done, total));
      this.results[kind] = { result, ms, revision };
      this.report(kind, result, ms, !!opt.auto);
      if (kind === 'rms') this.rmsIndex = result.t.length - 1;
      if (!opt.auto || this.overlayKind === kind || this.overlayKind === 'none') this.setOverlay(kind);
      if (!opt.auto) this.dock.show(kind); else if (this.dock.tab === kind) this.dock.render(); else this.dock.renderTabs();
      this.inspector.schedule();
      this.tree.render();
    } catch (error) {
      if (error instanceof CancelledError) this.log('warn', `${CALC_LABEL[kind]} cancelled after ${duration(performance.now() - t0)}.`);
      else {
        const msg = error instanceof Error ? error.message : String(error);
        this.log('error', `${CALC_LABEL[kind]} failed: ${msg}`);
        if (!opt.auto) toast('error', msg, { title: `${CALC_LABEL[kind]} failed` });
      }
    } finally {
      this.running = '';
      this.hideProgress();
      this.commands.changed();
      this.updateStatus();
    }
  }

  /** Logs the outcome of a calculation in plain words. @param {CalcKind} kind @param {any} r @param {number} ms @param {boolean} auto */
  report(kind, r, ms, auto) {
    const name = (/** @type {string} */ id) => this.store.get(id)?.name || id;
    if (kind === 'loadflow') {
      /** @type {import('./engine/reports.js').LoadFlowResult} */
      const lf = r;
      if (lf.converged) {
        const worst = lf.branches.reduce((m, b) => (Number.isFinite(b.loading) && b.loading > m.loading ? b : m), { loading: -Infinity, id: '' });
        const text = `Load flow converged in ${lf.iterations} iteration${lf.iterations === 1 ? '' : 's'} (${duration(ms)}). Losses ${fixed(lf.totals.losses, 3)} MW${worst.id ? `, highest loading ${fixed(worst.loading, 1)} % on ${name(worst.id)}` : ''}.`;
        if (!auto) this.log('ok', text); else this.setStatusMessage(text);
      } else this.log('error', `Load flow did not converge: ${lf.message}`);
      if (!auto) for (const w of lf.warnings) this.log('warn', w);
      if (!auto && lf.deenergized.length) this.log('warn', `De-energised busbars: ${lf.deenergized.map(name).join(', ')}.`);
    } else if (kind === 'shortcircuit') {
      /** @type {import('./engine/reports.js').ShortCircuitResult} */
      const sc = r;
      const top = sc.buses.reduce((m, b) => (b.ikss > m.ikss ? b : m), { ikss: -Infinity, id: '' });
      this.log('ok', `Short circuit (${enumLabel('fault', sc.fault).toLowerCase()}, ${sc.mode === 'max' ? 'maximum' : 'minimum'}) at ${sc.location ? name(sc.location) : `${sc.buses.length} busbars`} in ${duration(ms)}.${top.id ? ` Highest Ik″ ${fixed(top.ikss, 2)} kA at ${name(top.id)}.` : ''}`);
      for (const w of sc.warnings) this.log('warn', w);
    } else if (kind === 'contingency') {
      /** @type {import('./engine/reports.js').ContingencyResult} */
      const n1 = r;
      const bad = n1.cases.filter(c => c.converged && c.violations.some(v => !v.inBase)).length, failed = n1.cases.filter(c => !c.converged).length;
      this.log(bad || failed ? 'warn' : 'ok', `N-1 analysis of ${n1.cases.length} outages in ${duration(ms)}: ${bad} with new violations${failed ? `, ${failed} without a solution` : ''}.`);
    } else {
      /** @type {import('./engine/reports.js').RmsResult} */
      const rms = r;
      this.log(rms.stable ? 'ok' : 'warn', `Stability simulation of ${fixed(rms.t[rms.t.length - 1], 2)} s in ${duration(ms)}: ${rms.message}`);
      for (const e of rms.events) if (!e.applied) this.log('warn', `Event at ${e.t} s skipped: ${e.note}`);
    }
  }

  /** @param {CalcKind} kind */
  resultsStale(kind) {
    const r = this.results[/** @type {CalcKind} */ (kind)];
    return !!r && r.revision !== this.networkRevision;
  }

  /** @param {CalcKind | 'none'} kind */
  setOverlay(kind) {
    this.overlayKind = kind;
    this.rebuildOverlay();
    this.viewport.invalidate();
    this.inspector.schedule();
    this.tree.render();
    this.commands.changed();
  }

  rebuildOverlay() {
    const kind = this.overlayKind;
    const r = kind === 'none' ? null : this.results[kind];
    if (!r || kind === 'none') { this.overlay = null; this.refreshLegend(null); return; }
    const { overlay, legend } = buildOverlay(kind, r.result, this.store.doc, this.palette, { colouring: this.prefs.colouring, rmsIndex: this.rmsIndex });
    // Elements added since the calculation have no results; keep them out of the de-energised set.
    this.overlay = overlay;
    this.refreshLegend(legend);
  }

  /** @param {number} i */
  setRmsIndex(i) {
    this.rmsIndex = i;
    if (this.overlayKind === 'rms') { this.rebuildOverlay(); this.viewport.invalidate(); }
  }

  /** @param {import('./ui/overlay.js').Legend | null} [legend] */
  refreshLegend(legend) {
    const el = this.viewport.legend;
    const css = (/** @type {number[]} */ c) => `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${c[3]})`;
    if (legend === undefined) legend = null;
    if (!legend) {
      const kvs = [...new Set(this.store.doc.elements.filter(e => e.cls === 'bus').map(e => /** @type {number} */ (e.vn)))].sort((a, b) => b - a);
      if (!kvs.length) { el.innerHTML = ''; return; }
      const P = this.palette;
      const cls = (/** @type {number} */ kv) => (kv >= 200 ? P.kv.ehv : kv >= 60 ? P.kv.hv : kv >= 1 ? P.kv.mv : P.kv.lv);
      el.innerHTML = `<span class="title">Voltage levels</span>${kvs.slice(0, 6).map(kv => `<span class="sw"><i style="background:${css(cls(kv))}"></i>${kv} kV</span>`).join('')}`;
      return;
    }
    if (legend.kind === 'ramp') {
      el.innerHTML = `<span class="title">${legend.title}</span><span class="sw">${legend.from}<span class="ramp" style="background:linear-gradient(90deg,${legend.stops.map(css).join(',')})"></span>${legend.to}</span>`
        + (legend.extra ?? []).map(x => `<span class="sw"><i style="background:${css(x.color)}"></i>${x.label}</span>`).join('');
    } else {
      el.innerHTML = `<span class="title">${legend.title}</span>${legend.items.map(x => `<span class="sw"><i style="background:${css(x.color)}"></i>${x.label}</span>`).join('')}`;
    }
  }

  refreshTheme() {
    this.palette = readPalette();
    this.rebuildOverlay();
    this.viewport.invalidate();
    if (this.dock.tab === 'rms') this.dock.render();
    this.commands.changed();
  }

  // ----- Panels and layout -----

  applyLayout() {
    const s = this.root.style;
    s.setProperty('--left-w', `${this.prefs.leftW}px`);
    s.setProperty('--right-w', `${this.prefs.rightW}px`);
    s.setProperty('--dock-h', `${this.prefs.dockH}px`);
    this.root.dataset.left = this.prefs.left ? 'open' : 'closed';
    this.root.dataset.right = this.prefs.right ? 'open' : 'closed';
    this.root.dataset.dock = this.prefs.dock ? 'open' : 'closed';
  }

  /** @param {'left' | 'right' | 'dock'} which @param {boolean} [open] */
  setPanel(which, open) {
    this.prefs[which] = open ?? !this.prefs[which];
    this.applyLayout();
    this.savePrefs();
    this.dock.renderTabs();
    this.commands.changed();
  }

  setupSplitters() {
    for (const sp of document.querySelectorAll('.splitter')) {
      const el = /** @type {HTMLElement} */ (sp), which = /** @type {'left' | 'right' | 'bottom'} */ (el.dataset.split);
      const apply = (/** @type {number} */ v) => {
        if (which === 'left') this.prefs.leftW = Math.round(Math.min(480, Math.max(180, v)));
        else if (which === 'right') this.prefs.rightW = Math.round(Math.min(560, Math.max(240, v)));
        else this.prefs.dockH = Math.round(Math.min(innerHeight * 0.7, Math.max(120, v)));
        this.applyLayout();
      };
      el.addEventListener('pointerdown', e => {
        e.preventDefault();
        el.setPointerCapture(e.pointerId);
        el.classList.add('dragging');
        const start = { x: e.clientX, y: e.clientY, l: this.prefs.leftW, r: this.prefs.rightW, d: this.prefs.dockH };
        const move = (/** @type {PointerEvent} */ m) => {
          if (which === 'left') apply(start.l + m.clientX - start.x);
          else if (which === 'right') apply(start.r - (m.clientX - start.x));
          else apply(start.d - (m.clientY - start.y));
        };
        const up = () => { el.classList.remove('dragging'); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); this.savePrefs(); };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
      });
      el.addEventListener('keydown', e => {
        const step = e.shiftKey ? 48 : 16;
        const d = which === 'bottom' ? (e.key === 'ArrowUp' ? step : e.key === 'ArrowDown' ? -step : 0) : (e.key === 'ArrowRight' ? step : e.key === 'ArrowLeft' ? -step : 0);
        if (!d) return;
        e.preventDefault();
        if (which === 'left') apply(this.prefs.leftW + d); else if (which === 'right') apply(this.prefs.rightW - d); else apply(this.prefs.dockH + d);
        this.savePrefs();
      });
    }
  }

  savePrefs() { savePrefs(this.prefs); }

  // ----- Status bar and log -----

  /** @param {'info' | 'ok' | 'warn' | 'error'} level @param {string} text @param {string} [detail] */
  log(level, text, detail) {
    this.dock.write(level, text, detail);
    this.setStatusMessage(text);
  }

  /** @param {string} text */
  setStatusMessage(text) { if (this.status) { this.status.message.textContent = text; this.status.message.title = text; } }

  /** @param {{ x: number, y: number } | null} p */
  statusPointer(p) { if (this.status) this.status.pointer.textContent = p ? `x ${Math.round(p.x)}  y ${Math.round(p.y)}` : '—'; }

  /** @param {string} label @param {string} backend @param {string} title */
  statusBackend(label, backend, title) {
    if (!this.status) return;
    this.status.backend.innerHTML = `${icon(backend === 'webgpu' ? 'check' : 'warning', 13)}<span>${label}</span>`;
    this.status.backend.title = title;
    this.status.backend.dataset.backend = backend;
  }

  updateStatus() {
    if (!this.status) return;
    const toolNames = /** @type {Record<Tool, string>} */ ({ select: 'Select', pan: 'Pan', bus: 'Insert busbar', line: 'Insert line', trafo: 'Insert transformer', gen: 'Insert machine', extgrid: 'Insert external grid', load: 'Insert load', shunt: 'Insert shunt' });
    this.status.tool.innerHTML = `${icon(this.tool === 'select' ? 'select' : this.tool === 'pan' ? 'pan' : this.tool, 13)}<span>${toolNames[this.tool]}</span>`;
    const n = this.selection.size;
    this.status.selection.textContent = n ? `${n} selected` : `${this.store.doc.elements.length} elements`;
  }

  /** @param {number} done @param {number} total */
  showProgress(done, total) {
    if (!this.status) return;
    const p = this.status.progress;
    p.hidden = false;
    p.innerHTML = `<span>${CALC_LABEL[/** @type {CalcKind} */ (this.running)] ?? 'Calculating'}…</span><span class="progress"><i style="width:${total ? Math.round(done / total * 100) : 0}%"></i></span>`;
  }

  hideProgress() { if (this.status) this.status.progress.hidden = true; }

  /** @param {'ok' | 'info' | 'warn' | 'error'} kind @param {string} text @param {Parameters<typeof toast>[2]} [opt] */
  toast(kind, text, opt) { toast(kind, text, opt); }

  /** @param {number} x @param {number} y @param {string} id @param {{ x: number, y: number } | null} at */
  contextMenu(x, y, id, at) {
    const el = id ? this.store.get(id) : null;
    /** @type {import('./ui/feedback.js').MenuItem[]} */
    const items = [];
    if (el) {
      items.push({ label: 'Properties', icon: 'settings', run: () => this.focusInspector() });
      if (el.cls === 'bus') {
        items.push({ label: 'Short circuit at this busbar', icon: 'shortcircuit', run: () => this.faultAt(el.id) });
        items.push({ label: 'Add fault to simulation', icon: 'rms', run: () => this.addRmsFault(el.id) });
      }
      if (el.cls !== 'bus') items.push({ label: el.inService === false ? 'Switch into service' : 'Switch out of service', icon: 'power', hint: 'Shift+O', run: () => this.toggleService() });
      items.push('separator', { label: 'Copy', icon: 'copy', run: () => this.commands.run('edit.copy') }, { label: 'Duplicate', icon: 'duplicate', run: () => this.commands.run('edit.duplicate') },
        'separator', { label: 'Delete', icon: 'delete', danger: true, run: () => this.deleteSelection() });
    } else {
      items.push({ label: 'Paste', icon: 'paste', disabled: !this.clipboard, run: () => this.paste() });
      if (at) items.push({ label: 'Add busbar here', icon: 'bus', run: () => this.addBus(snap(at.x), snap(at.y)) });
      items.push('separator', { label: 'Fit diagram', icon: 'fit', run: () => this.viewport.fit() }, { label: 'Arrange automatically', icon: 'layout', run: () => this.commands.run('layout.arrange') });
    }
    contextMenu(x, y, items);
  }

  /** @param {string} busId */
  faultAt(busId) {
    this.store.transact('Fault location', tx => tx.setStudy('shortcircuit', 'location', busId));
    this.calc('shortcircuit');
  }

  /** @param {string} busId */
  addRmsFault(busId) {
    const events = [...this.store.doc.study.rms.events.filter(e => e.target !== busId || (e.kind !== 'fault' && e.kind !== 'clear')),
      { t: 0.1, kind: /** @type {const} */ ('fault'), target: busId }, { t: 0.2, kind: /** @type {const} */ ('clear'), target: busId }].sort((a, b) => a.t - b.t);
    this.store.transact('Simulation events', tx => tx.setStudy('rms', 'events', events));
    this.log('info', `The simulation now applies a three-phase fault at ${this.store.get(busId)?.name} from 0.1 s to 0.2 s. Edit events in the study case.`);
  }

  // ----- Commands -----

  registerCommands() {
    const c = this.commands;
    const sel = () => this.selection.size > 0;
    const idle = () => !this.running;
    const tool = (/** @type {Tool} */ t, /** @type {string} */ label, /** @type {string} */ ic, /** @type {string} */ key, /** @type {string} */ hint) =>
      c.add({ id: `tool.${t}`, label, icon: ic, keys: [key], group: t === 'select' || t === 'pan' ? 'Tool' : 'Insert', hint, run: () => this.setTool(this.tool === t && t !== 'select' ? 'select' : t), pressed: () => this.tool === t });
    // File
    c.add({ id: 'file.backstage', label: 'File menu', icon: 'open', group: 'File', run: () => openBackstage(this) });
    c.add({ id: 'file.new', label: 'New network', icon: 'new', group: 'File', run: () => this.newDocument() });
    c.add({ id: 'file.open', label: 'Open saved network', icon: 'open', keys: ['Mod+O'], global: true, group: 'File', run: () => openBackstage(this, 'open') });
    c.add({ id: 'file.save', label: 'Save now', icon: 'save', keys: ['Mod+S'], global: true, group: 'File', hint: 'Networks save automatically; this saves immediately', run: async () => { await this.save(); toast('ok', this.library.persistent ? 'Saved in this browser.' : 'Kept for this session. Export to keep a copy.'); } });
    c.add({ id: 'file.import', label: 'Import file', icon: 'import', keys: ['Mod+Shift+O'], global: true, group: 'File', hint: 'Import a PowerStudio file or a MATPOWER case', run: () => this.importFile('.json,.m,application/json,text/plain') });
    c.add({ id: 'file.export', label: 'Export PowerStudio file', icon: 'export', keys: ['Mod+Shift+S'], global: true, group: 'File', run: () => this.exportJSON() });
    c.add({ id: 'file.exportSvg', label: 'Export diagram as SVG', icon: 'image', group: 'File', run: () => { download(new Blob([this.viewport.exportSVG()], { type: 'image/svg+xml' }), fileName(this.store.doc.name, '.svg')); this.log('ok', 'Exported the diagram as SVG.'); } });
    c.add({ id: 'file.exportPng', label: 'Export diagram as PNG', icon: 'image', group: 'File', run: async () => { download(await this.viewport.exportPNG(), fileName(this.store.doc.name, '.png')); this.log('ok', 'Exported the diagram as PNG.'); } });
    for (const s of SAMPLES) c.add({ id: `sample.${s.id}`, label: s.title, icon: 'sample', group: 'Sample', hint: `Open the ${s.title} sample`, run: () => this.openSample(s.id) });
    // Edit
    c.add({ id: 'edit.undo', label: 'Undo', icon: 'undo', keys: ['Mod+Z'], group: 'Edit', hint: 'Undo', enabled: () => this.store.canUndo, run: () => this.store.undo() });
    c.add({ id: 'edit.redo', label: 'Redo', icon: 'redo', keys: ['Mod+Shift+Z', 'Mod+Y'], group: 'Edit', enabled: () => this.store.canRedo, run: () => this.store.redo() });
    c.add({ id: 'edit.cut', label: 'Cut', icon: 'cut', keys: ['Mod+X'], group: 'Edit', enabled: sel, run: () => { if (this.copy()) this.deleteSelection(); } });
    c.add({ id: 'edit.copy', label: 'Copy', icon: 'copy', keys: ['Mod+C'], group: 'Edit', enabled: sel, run: () => { const n = this.copy(); this.setStatusMessage(n ? `Copied ${n} element${n === 1 ? '' : 's'}.` : 'Nothing to copy: branches need both busbars selected.'); } });
    c.add({ id: 'edit.paste', label: 'Paste', icon: 'paste', keys: ['Mod+V'], group: 'Edit', enabled: () => !!this.clipboard, run: () => this.paste() });
    c.add({ id: 'edit.duplicate', label: 'Duplicate', icon: 'duplicate', keys: ['Mod+D'], group: 'Edit', enabled: sel, run: () => { if (this.copy()) this.paste(); } });
    c.add({ id: 'edit.delete', label: 'Delete', icon: 'delete', keys: ['Delete', 'Backspace'], group: 'Edit', enabled: sel, run: () => this.deleteSelection() });
    c.add({ id: 'edit.selectAll', label: 'Select all', icon: 'select', keys: ['Mod+A'], group: 'Edit', run: () => this.setSelection(this.store.doc.elements.map(e => e.id)) });
    c.add({ id: 'edit.toggleService', label: 'Switch in or out of service', icon: 'power', keys: ['Shift+O'], group: 'Edit', enabled: () => [...this.selection].some(id => this.store.get(id)?.cls !== 'bus'), run: () => this.toggleService() });
    c.add({ id: 'edit.escape', label: 'Cancel', group: 'Edit', keys: ['Escape'], palette: false, run: () => {
      if (this.running) { this.engine.cancel(); return; }
      if (this.viewport.cancelPending()) return;
      if (this.tool !== 'select') { this.setTool('select'); return; }
      if (this.root.dataset.sheet) { this.root.dataset.sheet = ''; return; }
      this.setSelection([]);
    } });
    for (const [key, dx, dy] of /** @type {Array<[string, number, number]>} */ ([['ArrowLeft', -20, 0], ['ArrowRight', 20, 0], ['ArrowUp', 0, -20], ['ArrowDown', 0, 20]])) {
      c.add({ id: `edit.nudge${key}`, label: `Move ${key.slice(5).toLowerCase()}`, group: 'Edit', keys: [key], palette: false, run: () => this.nudge(dx, dy) });
      c.add({ id: `edit.nudgeFar${key}`, label: `Move ${key.slice(5).toLowerCase()} far`, group: 'Edit', keys: [`Shift+${key}`], palette: false, run: () => this.nudge(dx * 5, dy * 5) });
    }
    c.add({ id: 'layout.arrange', label: 'Arrange', icon: 'layout', group: 'Edit', hint: 'Lay the diagram out again from the network topology', run: () => this.arrange() });
    // Tools
    tool('select', 'Select', 'select', 'V', 'Select and move elements');
    tool('pan', 'Pan', 'pan', 'H', 'Drag to move the view; you can also hold Space');
    tool('bus', 'Busbar', 'bus', 'B', 'Place busbars');
    tool('line', 'Line', 'line', 'L', 'Connect two busbars of the same voltage');
    tool('trafo', 'Transformer', 'trafo', 'T', 'Connect two voltage levels');
    tool('gen', 'Machine', 'gen', 'G', 'Synchronous machine');
    tool('extgrid', 'External grid', 'extgrid', 'E', 'Equivalent of the upstream network');
    tool('load', 'Load', 'load', 'D', 'Constant power load');
    tool('shunt', 'Shunt', 'shunt', 'C', 'Capacitor bank or reactor');
    // Calculate
    c.add({ id: 'calc.loadflow', keywords: 'power flow newton raphson voltages', label: 'Load flow', icon: 'loadflow', keys: ['Alt+L', 'Mod+Enter'], global: true, group: 'Calculate', hint: 'Run a Newton-Raphson load flow', enabled: idle, run: () => this.calc('loadflow') });
    c.add({ id: 'calc.shortcircuit', keywords: 'fault iec 60909 kurzschluss ikss', label: 'Short circuit', icon: 'shortcircuit', keys: ['Alt+S'], global: true, group: 'Calculate', hint: 'IEC 60909-style short-circuit currents', enabled: idle, run: () => this.calc('shortcircuit') });
    c.add({ id: 'calc.contingency', keywords: 'n-1 outage security', label: 'Contingency', icon: 'contingency', keys: ['Alt+N'], global: true, group: 'Calculate', hint: 'N-1 analysis: every branch out in turn', enabled: idle, run: () => this.calc('contingency') });
    c.add({ id: 'calc.rms', keywords: 'stability transient dynamic rotor angle rms', label: 'Simulation', icon: 'rms', keys: ['Alt+R'], global: true, group: 'Calculate', hint: 'Stability simulation with the study case events', enabled: idle, run: () => this.calc('rms') });
    c.add({ id: 'calc.cancel', label: 'Cancel calculation', icon: 'stop', keys: ['Mod+.'], global: true, group: 'Calculate', enabled: () => !!this.running, run: () => this.engine.cancel() });
    c.add({ id: 'calc.autoLoadFlow', label: 'Recalculate on edit', icon: 'loadflow', group: 'Calculate', hint: 'Run the load flow again after each change once it has been run', pressed: () => this.prefs.autoLoadFlow, run: () => { this.prefs.autoLoadFlow = !this.prefs.autoLoadFlow; this.savePrefs(); } });
    const studyToggle = (/** @type {string} */ id, /** @type {string} */ label, /** @type {string} */ ic, /** @type {string} */ section, /** @type {string} */ key, /** @type {unknown} */ value, /** @type {unknown} */ other) =>
      c.add({ id, label, icon: ic, group: 'Study case', pressed: () => /** @type {any} */ (this.store.doc.study)[section][key] === value,
        run: () => { const cur = /** @type {any} */ (this.store.doc.study)[section][key]; this.store.transact(label, tx => tx.setStudy(section, key, other !== undefined && cur === value ? other : value)); } });
    studyToggle('calc.qlimits', 'Respect Q limits', 'settings', 'loadflow', 'enforceQLimits', true, false);
    studyToggle('calc.dcStart', 'DC start', 'settings', 'loadflow', 'dcStart', true, false);
    studyToggle('sc.fault3ph', 'Three-phase', 'shortcircuit', 'shortcircuit', 'fault', '3ph', undefined);
    studyToggle('sc.fault2ph', 'Line to line', 'shortcircuit', 'shortcircuit', 'fault', '2ph', undefined);
    studyToggle('sc.fault1ph', 'Line to earth', 'shortcircuit', 'shortcircuit', 'fault', '1ph', undefined);
    studyToggle('sc.max', 'Maximum currents', 'plus', 'shortcircuit', 'mode', 'max', undefined);
    studyToggle('sc.min', 'Minimum currents', 'minus', 'shortcircuit', 'mode', 'min', undefined);
    c.add({ id: 'sc.allBuses', label: 'Every busbar', icon: 'bus', group: 'Study case', hint: 'Fault every busbar in turn instead of one location', pressed: () => !this.store.doc.study.shortcircuit.location,
      run: () => { const busSel = [...this.selection].find(id => this.store.get(id)?.cls === 'bus'); this.store.transact('Fault location', tx => tx.setStudy('shortcircuit', 'location', this.store.doc.study.shortcircuit.location ? '' : busSel ?? '')); } });
    c.add({ id: 'sc.atSelection', keywords: 'fault here', label: 'Short circuit at selected busbar', icon: 'shortcircuit', group: 'Calculate', enabled: () => [...this.selection].some(id => this.store.get(id)?.cls === 'bus'),
      run: () => { const id = [...this.selection].find(x => this.store.get(x)?.cls === 'bus'); if (id) this.faultAt(id); } });
    c.add({ id: 'rms.events', label: 'Events', icon: 'settings', group: 'Study case', hint: 'Edit the disturbance sequence of the simulation', run: () => openStudyDialog(this, 'rms') });
    c.add({ id: 'study.settings', label: 'Study case', icon: 'settings', keys: ['Mod+,'], global: true, group: 'Study case', hint: 'Settings of every calculation', run: () => openStudyDialog(this) });
    c.add({ id: 'results.clear', label: 'Clear results', icon: 'close', group: 'Calculate', enabled: () => Object.keys(this.results).length > 0, run: () => { this.results = {}; this.setOverlay('none'); this.dock.render(); this.log('info', 'Results cleared.'); } });
    c.add({ id: 'results.csv', label: 'Export table as CSV', icon: 'csv', group: 'Calculate', run: () => {
      const csv = this.dock.csv();
      if (!csv) { toast('info', 'Open a results table first.'); return; }
      download(new Blob([csv.text], { type: 'text/csv' }), fileName(`${this.store.doc.name}-${csv.name}`, '.csv'));
      this.log('ok', `Exported ${csv.name} as CSV.`);
    } });
    for (const k of /** @type {CalcKind[]} */ (['loadflow', 'shortcircuit', 'contingency', 'rms'])) {
      c.add({ id: `show.${k}`, label: `Show ${CALC_LABEL[k].toLowerCase()} results on the diagram`, icon: k, group: 'View', enabled: () => !!this.results[k], pressed: () => this.overlayKind === k, run: () => { this.setOverlay(k); this.dock.show(k); } });
    }
    // View
    c.add({ id: 'view.fit', label: 'Fit', icon: 'fit', keys: ['F'], group: 'View', hint: 'Fit the diagram in the window', run: () => this.viewport.fit() });
    c.add({ id: 'view.zoomIn', label: 'Zoom in', icon: 'zoomIn', keys: ['+', '='], group: 'View', run: () => this.viewport.zoomBy(1.25) });
    c.add({ id: 'view.zoomOut', label: 'Zoom out', icon: 'zoomOut', keys: ['-'], group: 'View', run: () => this.viewport.zoomBy(0.8) });
    const pref = (/** @type {string} */ id, /** @type {string} */ label, /** @type {string} */ ic, /** @type {'boxes' | 'names' | 'branchNames'} */ key, /** @type {string[]} */ keys = []) =>
      c.add({ id, label, icon: ic, keys, group: 'View', pressed: () => this.prefs[key], run: () => { this.prefs[key] = !this.prefs[key]; this.savePrefs(); this.viewport.invalidate(); } });
    pref('view.boxes', 'Result boxes', 'boxes', 'boxes', ['Shift+R']);
    pref('view.names', 'Names', 'names', 'names', ['Shift+N']);
    pref('view.branchNames', 'Line names', 'line', 'branchNames');
    c.add({ id: 'view.colourResults', label: 'Colour by results', icon: 'colour', group: 'View', pressed: () => this.prefs.colouring === 'results', run: () => { this.prefs.colouring = 'results'; this.savePrefs(); this.rebuildOverlay(); this.viewport.invalidate(); } });
    c.add({ id: 'view.colourVoltage', label: 'Colour by voltage level', icon: 'colour', group: 'View', pressed: () => this.prefs.colouring === 'voltage', run: () => { this.prefs.colouring = 'voltage'; this.savePrefs(); this.rebuildOverlay(); this.viewport.invalidate(); } });
    c.add({ id: 'view.tree', label: 'Model panel', icon: 'panelLeft', keys: ['Mod+Shift+M'], global: true, group: 'View', pressed: () => this.prefs.left, run: () => this.setPanel('left') });
    c.add({ id: 'view.inspector', label: 'Inspector', icon: 'panelRight', keys: ['Mod+Shift+I'], group: 'View', pressed: () => this.prefs.right, run: () => this.setPanel('right') });
    c.add({ id: 'view.dock', label: 'Results panel', icon: 'panelBottom', keys: ['Mod+J'], global: true, group: 'View', pressed: () => this.prefs.dock, run: () => this.setPanel('dock') });
    c.add({ id: 'view.sheetLeft', label: 'Show model', icon: 'panelLeft', group: 'View', palette: false, run: () => { this.root.dataset.sheet = this.root.dataset.sheet === 'left' ? '' : 'left'; } });
    c.add({ id: 'view.sheetRight', label: 'Show inspector', icon: 'panelRight', group: 'View', palette: false, run: () => { this.root.dataset.sheet = this.root.dataset.sheet === 'right' ? '' : 'right'; } });
    const theme = (/** @type {'system' | 'light' | 'dark'} */ t, /** @type {string} */ label, /** @type {string} */ ic) =>
      c.add({ id: `view.theme${t[0].toUpperCase()}${t.slice(1)}`, label, icon: ic, group: 'Theme', pressed: () => this.prefs.theme === t, run: () => { this.prefs.theme = t; this.savePrefs(); applyTheme(t); this.refreshTheme(); } });
    theme('system', 'Match system', 'colour');
    theme('light', 'Light', 'sun');
    theme('dark', 'Dark', 'moon');
    c.add({ id: 'view.toggleTheme', label: 'Switch light and dark', icon: 'colour', keys: ['Shift+T'], group: 'Theme', run: () => {
      const dark = document.documentElement.dataset.theme === 'dark' || (document.documentElement.dataset.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
      this.commands.run(dark ? 'view.themeLight' : 'view.themeDark');
    } });
    const renderer = (/** @type {'auto' | 'canvas'} */ r, /** @type {string} */ label, /** @type {string} */ hint) =>
      c.add({ id: `view.renderer${r === 'auto' ? 'Auto' : 'Canvas'}`, label, icon: 'image', group: 'Rendering', hint, pressed: () => this.prefs.renderer === r, run: async () => {
        this.prefs.renderer = r; this.savePrefs();
        await this.viewport.init(r);
        this.log('info', `Drawing with ${this.viewport.renderer?.label}.`, this.viewport.fallbackReason || undefined);
      } });
    renderer('auto', 'WebGPU when available', 'Use WebGPU, falling back to Canvas 2D');
    renderer('canvas', 'Canvas 2D only', 'Always draw with Canvas 2D');
    // Help
    c.add({ id: 'palette.open', label: 'Command palette', icon: 'search', keys: ['Mod+K', 'Mod+Shift+P'], global: true, group: 'Help', hint: 'Search commands and elements', run: () => openPalette(this) });
    c.add({ id: 'help.shortcuts', label: 'Keyboard shortcuts', icon: 'keyboard', keys: ['?'], group: 'Help', run: () => openBackstage(this, 'shortcuts') });
    c.add({ id: 'help.about', label: 'About PowerStudio', icon: 'info', group: 'Help', run: () => openBackstage(this, 'about') });
    void closeBackstage;
  }
}
