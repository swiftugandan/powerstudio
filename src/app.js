/** The application: owns the document store, selection, tools, results and preferences, defines every command, and
 * keeps the ribbon, model tree, viewport, inspector, results dock and status bar in step. */

import { DocumentStore } from './core/store.js';
import { emptyDocument, nextId, normalizeSteps, validateForCalculation, busesOf } from './core/document.js';
import { makeElement, CLASSES } from './core/catalog.js';
import { snap } from './core/layout.js';
import { SAMPLES } from './samples/index.js';
import { projectFromDocument, projectFromParts, composeSteps, route, partTexts, allParts, activeCase, PROJECT_FORMAT, projectFileHead, projectFromFile } from './core/project.js';
import { Commands } from './ui/commands.js';
import { Ribbon } from './ui/ribbon.js';
import { ModelTree } from './ui/tree.js';
import { Inspector } from './ui/inspector.js';
import { Dock } from './ui/dock.js';
import { Viewport } from './ui/viewport.js';
import { EngineClient, CancelledError } from './ui/engine-client.js';
import { engineDigest } from './engine/module.js';
import { adapt } from './engine/reports.js';
import { savePrefs, newDocId, serialise } from './ui/persistence.js';
import { applyTheme, readPalette } from './ui/theme.js';
import { buildOverlay } from './ui/overlay.js';
import { openPalette } from './ui/palette.js';
import { openBackstage, closeBackstage } from './ui/backstage.js';
import { openStudyDialog } from './ui/study.js';
import { openContingencyDialog } from './ui/contingency-editor.js';
import { importDialog } from './ui/import-dialog.js';
import { IMPORT_TYPES } from './engine/exchange.js';
import { toast, contextMenu } from './ui/feedback.js';
import { h, esc, byId, download, fileName, yieldToBrowser } from './ui/dom.js';
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
    /** The open project, and its parts edited since the last save. @type {import('./core/project.js').Project} */
    this.project = projectFromDocument(this.store.doc);
    /** @type {Set<import('./core/project.js').Part>} */
    this.dirtyParts = new Set();
    /** Where the next load flow starts: the last converged solution, or an imported network's voltages (see calc).
     * @type {import('./engine/reports.js').StartVoltages | null} */
    this.start = null;
    /** Whether an Arrange is laying the diagram out in the worker. */
    this.arranging = false;
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
    /** An edit came during a calculation: recalculate the load flow once it ends. */
    this.autoPending = false;
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

  /**
   * Opens a project: the editor gets its active study case's composition, built in slices so a national network does
   * not hold the page. A `fresh` project (new, a sample, an import) has every part to save.
   * @param {import('./core/project.js').Project} project @param {string} id @param {{ fresh?: boolean }} [opt]
   */
  async open(project, id, opt = {}) {
    this.flushSave();
    const doc = await this.composed(project);
    this.project = project;
    this.dirtyParts = new Set(opt.fresh ? allParts(project) : []);
    this.load(doc, id);
  }

  /**
   * Puts a composed document in the editor, clearing results, selection and history.
   * @param {PowerDocument} doc @param {string} id @param {{ keepView?: boolean }} [opt]
   */
  load(doc, id, opt = {}) {
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
    this.start = null;
    if (!opt.keepView) this.viewport.fit();
    this.updateProjectBar();
    this.refreshLegend();
    this.dock.render();
    if (!this.dirtyParts.size) this.markSaved();
    this.commands.changed();
  }

  async newDocument() {
    await this.open(projectFromDocument(emptyDocument('Untitled network')), newDocId(), { fresh: true });
    await this.save();
    this.log('info', 'New network. Insert busbars from the Insert tab or press B.');
    this.ribbon.select('insert');
  }

  /** @param {string} sampleId @param {{ quiet?: boolean }} [opt] */
  async openSample(sampleId, opt = {}) {
    const s = SAMPLES.find(x => x.id === sampleId);
    if (!s) return;
    await this.open(projectFromDocument(s.create()), newDocId(), { fresh: true });
    await this.save();
    if (!opt.quiet) this.log('info', `Opened the sample “${s.title}”. It is a copy; the original is always available from File.`);
  }

  // ----- Project -----

  /** Puts the active study case's composition in the editor again, after its scenario or variants changed: results and
   * undo history clear, the view stays. */
  async recompose() {
    const doc = await this.composed(this.project);
    this.load(doc, this.docId, { keepView: true });
    this.scheduleSave();
  }

  /** The active study case's composition. One that applies variants or a scenario passes the import gate, which checks
   * the elements and values they bring as it checks any document's. @param {import('./core/project.js').Project} p */
  async composed(p) {
    const doc = await this.sliced(composeSteps(p));
    const c = activeCase(p);
    if (!c.variants.length && !c.scenario) return doc;
    const { doc: checked, issues } = await this.normalize(doc);
    for (const i of issues) this.log('warn', `Study case “${c.name}”: ${i}`);
    return checked;
  }

  /** Makes a study case active. @param {string} id */
  async switchCase(id) {
    const p = this.project;
    if (id === p.activeCase || !p.cases.some(c => c.id === id)) return;
    p.activeCase = id;
    if (!activeCase(p).variants.includes(p.recording)) p.recording = '';
    this.dirtyParts.add('manifest');
    await this.recompose();
    this.log('info', `Study case “${activeCase(p).name}”.`);
  }

  /** Where edits to the equipment go: the base model ('') or a variant of the active study case. Undo history clears,
   * so an undo never lands somewhere else than its edit did. @param {string} id */
  setRecording(id) {
    const p = this.project;
    p.recording = activeCase(p).variants.includes(id) ? id : '';
    this.store.clearHistory();
    this.dirtyParts.add('manifest');
    this.scheduleSave();
    this.commands.changed();
    this.updateProjectBar();
  }

  /** After the project page changed the project: saves the parts it names, and recomposes when the active case's
   * composition changed. @param {Iterable<import('./core/project.js').Part>} parts @param {boolean} recompose */
  async projectChanged(parts, recompose) {
    for (const part of parts) this.dirtyParts.add(part);
    if (!activeCase(this.project).variants.includes(this.project.recording)) this.project.recording = '';
    if (recompose) await this.recompose(); else this.scheduleSave();
    this.updateProjectBar();
  }

  /** Shows the active study case, and the variant edits are recorded in, in the title bar. */
  updateProjectBar() {
    const p = this.project, c = activeCase(p), chip = byId('case-chip');
    const recording = p.variants.find(v => v.id === p.recording);
    chip.classList.toggle('recording', !!recording);
    chip.title = `Study case: ${c.name}${recording ? `. Changes to the equipment go to the variant “${recording.name}”.` : ''}`;
    chip.innerHTML = `${icon(recording ? 'record' : 'layers', 14)}<span class="case">${esc(c.name)}</span>${recording ? `<span class="rec">${esc(recording.name)}</span>` : ''}${icon('chevronDown', 12)}`;
  }

  /** The title bar's menu: the study cases, where edits go, and the project page. */
  projectMenu() {
    const p = this.project, c = activeCase(p), r = byId('case-chip').getBoundingClientRect();
    /** @type {Array<'separator' | { label: string, icon?: string, hint?: string, run: () => void }>} */
    const items = p.cases.map(sc => ({ label: sc.name, icon: sc.id === c.id ? 'check' : undefined, hint: sc.id === c.id ? 'Active' : '', run: () => { void this.switchCase(sc.id); } }));
    const variants = p.variants.filter(v => c.variants.includes(v.id));
    if (variants.length) {
      items.push('separator', { label: 'Changes go to the base model', icon: p.recording ? undefined : 'check', run: () => this.setRecording('') },
        ...variants.map(v => ({ label: `Changes go to “${v.name}”`, icon: p.recording === v.id ? 'check' : undefined, run: () => this.setRecording(v.id) })));
    }
    items.push('separator', { label: 'Manage project…', icon: 'layers', run: () => openBackstage(this, 'project') });
    contextMenu(r.left, r.bottom + 4, items);
  }

  /** The import gate (`normalizeDocument`), run in slices of about 25 ms so a national network does not hold the page.
   * @param {unknown} input @returns {Promise<{ doc: import('./core/document.js').PowerDocument, issues: string[] }>} */
  normalize(input) { return this.sliced(normalizeSteps(input)); }

  /** Runs a generator to its end in slices of about 25 ms, yielding to the browser between them.
   * @template T @param {Generator<void, T, void>} steps @returns {Promise<T>} */
  async sliced(steps) {
    for (;;) {
      const t0 = performance.now();
      let r = steps.next();
      while (!r.done && performance.now() - t0 < 25) r = steps.next();
      if (r.done) return r.value;
      await yieldToBrowser();
    }
  }

  /** @param {string} id @param {{ quiet?: boolean }} [opt] */
  async openStored(id, opt = {}) {
    try {
      const rec = await this.library.get(id);
      if (!rec) return false;
      const { doc, issues } = await this.normalize(rec.doc);
      await this.open(projectFromParts(doc, await this.library.parts(id)), id);
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

  /** Saves the document. A national network serialises over several tasks, and starts again if it changes meanwhile;
   * `now` serialises at once (the page is closing). @param {{ now?: boolean }} [opt] */
  async save(opt = {}) {
    clearTimeout(this.saveTimer);
    this.saveTimer = 0;
    const project = this.project, revision = this.store.revision, id = this.docId, elements = this.store.doc.elements.length;
    const parts = this.dirtyParts;
    if (!parts.size) return;
    this.dirtyParts = new Set();
    // Parts a later change makes dirty again are saved by the save that change schedules.
    const keep = () => { for (const p of parts) this.dirtyParts.add(p); };
    try {
      if (parts.has('base')) {
        const base = project.base;
        const json = opt.now ? JSON.stringify(base) : await serialise(base, () => this.project === project && this.store.revision === revision, yieldToBrowser);
        if (json === null) { keep(); return; }
        await this.library.put(id, base.name, elements, json);
      }
      const rest = partTexts(project, parts);
      if (rest.length) await this.library.putParts(id, rest);
      if (this.store.revision === revision && !this.dirtyParts.size) this.markSaved();
    } catch (error) {
      keep();
      this.setSaveState('pending', 'Not saved');
      this.log('error', `Saving in this browser failed: ${error instanceof Error ? error.message : error}. Export the project to keep it.`);
    }
  }

  scheduleSave() {
    this.setSaveState('pending', 'Saving…');
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.save(), 400);
  }

  flushSave() { if (this.saveTimer || this.dirtyParts.size) this.save({ now: true }); }

  markSaved() {
    this.setSaveState('saved', this.library.persistent ? 'Saved' : 'This session only',
      this.library.persistent ? 'Saved in this browser. Nothing is uploaded.' : 'This browser does not allow storage here, so the project lasts for this session. Export it to keep it.');
  }

  /** @param {'saved' | 'pending'} state @param {string} text @param {string} [title] */
  setSaveState(state, text, title = text) {
    const el = byId('save-state');
    el.dataset.state = state;
    el.title = title;
    el.innerHTML = `<span class="dot"></span><span>${text}</span>`;
  }

  /** Imports files the user picks. @param {string} accept */
  importFile(accept) {
    const input = h('input', { type: 'file', accept, multiple: true, style: 'display:none' });
    input.addEventListener('change', () => { const files = [...(input.files ?? [])]; if (files.length) this.importFiles(files); input.remove(); });
    document.body.append(input);
    input.click();
  }

  /**
   * Imports files: a PowerStudio document opens directly; other tools' files (CGMES XML files or archives, a PSS/E
   * RAW file, a MATPOWER case) go through the engine, and the import dialog shows what it found before the network
   * opens.
   * @param {File[]} files
   */
  async importFiles(files) {
    const label = files.length === 1 ? files[0].name : `${files.length} files`;
    try {
      // A PowerStudio document: by its extension, or by its content when the name has none.
      const head = files.length === 1 ? (await files[0].slice(0, 64).text()).trimStart() : '';
      if (files.length === 1 && (/\.json$/i.test(files[0].name) || head.startsWith('{'))) {
        let json;
        try { json = JSON.parse(await files[0].text()); } catch { throw new Error('The file is not valid JSON.'); }
        const isProject = json?.format === PROJECT_FORMAT;
        const { doc, issues } = await this.normalize(isProject ? json.base : json);
        const id = newDocId();
        await this.open(isProject ? projectFromFile(json, doc) : projectFromDocument(doc), id, { fresh: true });
        await this.save();
        if (isProject) for (const run of Array.isArray(json.runs) ? json.runs : []) if (run && typeof run.run === 'string') await this.library.addRun(id, run);
        this.log('ok', `Imported “${label}” as “${doc.name}” with ${doc.elements.length} elements.`);
        for (const i of issues) this.log('warn', i);
        toast(issues.length ? 'warn' : 'ok', issues.length ? `${issues.length} note${issues.length === 1 ? '' : 's'} in the Output panel.` : `${doc.elements.length} elements.`, { title: `Imported ${label}` });
        return;
      }
      this.setStatusMessage(`Reading ${label}…`);
      const named = await Promise.all(files.map(async f => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
      const { summary, doc: raw } = await this.engine.importFiles(named);
      this.setStatusMessage('');
      if (!(await importDialog(summary, files.map(f => f.name)))) { this.log('info', `Import of “${label}” cancelled.`); return; }
      // The engine's document passes the same gate as any file; it should need no changes.
      const { doc, issues } = await this.normalize(raw);
      await this.open(projectFromDocument(doc), newDocId(), { fresh: true });
      this.start = summary.fidelity.start.busIds.length ? summary.fidelity.start : null;
      await this.save();
      const z = summary.size;
      this.log('ok', `Imported “${label}” as “${doc.name}”: ${z.nodes} nodes and ${z.branches} branches as ${doc.elements.length} elements.`);
      for (const n of [...summary.study, ...summary.report.notes, ...summary.conversion]) this.log('info', n);
      for (const v of summary.validation) this.log(v.severity === 'error' ? 'error' : 'warn', `${v.id}: ${v.message}`);
      for (const i of issues) this.log('warn', i);
      toast('ok', `${doc.elements.length.toLocaleString('en-GB')} elements. The import notes are in the Output panel.`, { title: `Imported ${label}` });
    } catch (error) {
      this.setStatusMessage('');
      console.error(error instanceof Error ? error.stack : error);
      const msg = error instanceof Error ? error.message : String(error);
      this.log('error', `Import of “${label}” failed: ${msg}`);
      toast('error', msg, { title: 'Import failed' });
    }
  }

  installDrop() {
    window.addEventListener('dragover', e => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
    window.addEventListener('drop', e => {
      const files = [...(e.dataTransfer?.files ?? [])];
      if (!files.length) return;
      e.preventDefault();
      this.importFiles(files);
    });
  }

  /** Exports the whole project, with its run log, as one file that imports back as a new project. */
  async exportProject() {
    const p = this.project, runs = await this.library.runs(this.docId);
    const base = await serialise(p.base, () => this.project === p, yieldToBrowser);
    if (base === null) return;
    const head = JSON.stringify(projectFileHead(p, runs));
    download(new Blob([head.slice(0, -1), ',"base":', base, '}\n'], { type: 'application/json' }), fileName(p.base.name, '.powerstudio-project.json'));
    this.log('ok', `Exported the project “${p.base.name}”: ${p.cases.length} study case${p.cases.length === 1 ? '' : 's'}, ${p.scenarios.length} scenario${p.scenarios.length === 1 ? '' : 's'}, ${p.variants.length} variant${p.variants.length === 1 ? '' : 's'} and ${runs.length} run${runs.length === 1 ? '' : 's'}.`);
  }

  exportJSON() {
    const text = JSON.stringify(this.store.doc, null, 2) + '\n';
    download(new Blob([text], { type: 'application/json' }), fileName(this.store.doc.name, '.powerstudio.json'));
    this.log('ok', `Exported “${this.store.doc.name}” as a PowerStudio file.`);
  }

  // ----- Changes -----

  /** @param {import('./core/store.js').Change} change */
  onChange(change) {
    // The calculation workers keep their own copies of the document.
    if (change.source === 'load') this.engine.setDocument(this.store.doc); else this.engine.applyOps(change.ops);
    if (change.source === 'load') { this.dock.sheet.reset(); this.dock.projectOpened(); }
    // Every edit lands in its part of the project: the base, a variant, the scenario or the study case.
    else for (const part of route(this.project, change.ops)) this.dirtyParts.add(part);
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
      // The data sheet keeps its toolbar (and a filter being typed) unless elements came or went.
      if (this.dock.tab === 'data' && !change.structural) this.dock.sheet.refresh();
      else if (this.dock.tab !== 'output') this.dock.render();
      if (change.source !== 'load') this.maybeAutoLoadFlow();
    }
    this.updateStatus();
    this.commands.changed();
    if (change.source !== 'load') this.scheduleSave();
    if (change.source === 'undo' || change.source === 'redo') this.setStatusMessage(`${change.source === 'undo' ? 'Undid' : 'Redid'}: ${change.label}`);
  }

  maybeAutoLoadFlow() {
    if (!this.prefs.autoLoadFlow || !this.results.loadflow) return;
    // An edit during a calculation recalculates once that calculation ends.
    if (this.running || this.arranging) { this.autoPending = true; return; }
    clearTimeout(this.autoTimer);
    // A calculation the user starts within the delay must not be replaced by this one.
    this.autoTimer = window.setTimeout(() => { if (!this.running && !this.arranging) this.calc('loadflow', { auto: true }); }, 250);
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
    this.viewport.invalidate('overlay');
    if (this.dock.tab === 'data') this.dock.sheet.selectionChanged();
    else if (this.dock.tab !== 'output' && this.dock.tab !== 'rms') this.dock.render();
    this.updateStatus();
    this.commands.changed();
    if (this.selection.size === 1 && this.root.dataset.sheet === 'left') this.root.dataset.sheet = '';
  }

  /** @param {string} id */
  setHover(id) { this.hover = id; this.viewport.invalidate('overlay'); }

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
      // The elements whose loss (alone or with others) leaves new violations or no solution.
      for (const c of this.results.contingency.result.cases) if (!c.converged || c.violations.some((/** @type {any} */ v) => !v.inBase)) for (const id of c.elements) out.set(id, 'var(--res-high)');
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

  /** Lays the whole diagram out again from the topology, as one undoable step. The layout runs in the calculation
   * worker, so a national network does not hold the page; an edit made meanwhile wins, and the layout is dropped. */
  async arrange() {
    const revision = this.store.revision, unchanged = () => this.store.revision === revision;
    this.arranging = true;
    this.commands.changed();
    this.setStatusMessage('Arranging the diagram…');
    try {
      const drawing = await this.engine.layout(this.store.doc, unchanged);
      if (!drawing || !unchanged()) { toast('info', 'The network changed while it was being arranged. Arrange it again to lay out the new state.'); return; }
      this.store.transact('Arrange diagram', tx => {
        for (const d of drawing) {
          const el = this.store.get(/** @type {string} */ (d.id));
          if (el) for (const [k, v] of Object.entries(d)) if (k !== 'id' && el[k] !== v) tx.set(el.id, k, v);
        }
      });
      this.viewport.fit();
      this.setStatusMessage('Arranged the diagram.');
    } catch (error) {
      this.log('error', `Could not arrange the diagram: ${error instanceof Error ? error.message : error}`);
    } finally {
      this.arranging = false;
      this.commands.changed();
      if (this.autoPending) { this.autoPending = false; if (this.resultsStale('loadflow')) this.maybeAutoLoadFlow(); }
    }
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
      // A load flow starts from the last converged one (its voltages and the machines it held at a reactive limit),
      // or an imported network's voltages, so a re-solve after an edit takes a few iterations. One that does not
      // converge from there is tried once more from the usual start before it is reported.
      const progress = (/** @type {number} */ done, /** @type {number} */ total) => this.showProgress(done, total);
      // A calculation the user starts goes in the project's run log; recalculations on edit do not.
      const record = !opt.auto;
      let start = kind === 'loadflow' ? this.start : null;
      let { result, ms, record: hashes, bytes } = await this.engine.run(kind, doc, start ? { start } : {}, progress, { record });
      if (start && !result.converged) {
        this.start = start = null;
        const cold = await this.engine.run(kind, doc, {}, progress, { record });
        ({ result, record: hashes, bytes } = cold);
        ms += cold.ms;
      }
      if (hashes) void this.recordRun(kind, result, ms, hashes, start, bytes);
      if (kind === 'loadflow' && result.converged) this.start = startOf(result);
      this.results[kind] = { result, ms, revision };
      // The calculation is over once its result is stored: other commands work while the result is shown.
      this.finishCalc();
      this.report(kind, result, ms, !!opt.auto);
      if (kind === 'rms') this.rmsIndex = result.t.length - 1;
      // The result's colours, its table and the panels each take their own task, so a national network's result
      // does not hold the page in one.
      await yieldToBrowser();
      if (!opt.auto || this.overlayKind === kind || this.overlayKind === 'none') this.setOverlay(kind);
      await yieldToBrowser();
      if (!opt.auto) this.dock.show(kind); else if (this.dock.tab === kind) this.dock.render(); else this.dock.renderTabs();
      await yieldToBrowser();
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
      if (this.running === kind) this.finishCalc();
    }
  }

  /** Marks the running calculation as over, and runs the load flow an edit asked for meanwhile. */
  finishCalc() {
    this.running = '';
    this.hideProgress();
    this.commands.changed();
    this.updateStatus();
    if (this.autoPending) { this.autoPending = false; if (this.resultsStale('loadflow')) this.maybeAutoLoadFlow(); }
  }

  /**
   * Appends a calculation to the project's run log (docs/design/NATIONAL-GRADE.md, section 9.2): what ran, on which
   * engine, the hashes of its inputs and its report, and its outcome. A load flow solved from a previous solution
   * names that start's hash too, since the result depends on it to within the tolerance.
   * @param {CalcKind} kind @param {any} r @param {number} ms @param {import('./ui/engine-client.js').Hashes} hashes
   * @param {import('./engine/reports.js').StartVoltages | null} start @param {Uint8Array} bytes the report, kept compressed
   * so the run can be compared with others
   */
  async recordRun(kind, r, ms, hashes, start, bytes) {
    const p = this.project, c = activeCase(p), now = new Date();
    try {
      const outcome = kind === 'loadflow' ? { converged: r.converged, iterations: r.iterations, lossesMw: r.totals.losses, warnings: r.warnings.length }
        : kind === 'shortcircuit' ? { buses: r.buses.length, maxIkssKa: Math.max(0, ...r.buses.map((/** @type {any} */ b) => b.ikss)) }
          : kind === 'contingency' ? { cases: r.cases.length, violating: r.cases.filter((/** @type {any} */ x) => x.converged && x.violations.length).length, unsolvable: r.cases.filter((/** @type {any} */ x) => !x.converged).length }
            : { stable: r.stable, steps: r.steps };
      /** @type {import('./ui/persistence.js').RunRecord} */
      const rec = {
        run: `${now.toISOString()}-${Math.random().toString(16).slice(2, 6)}`, time: now.toISOString(), kind,
        studyCase: c.name, scenario: p.scenarios.find(x => x.id === c.scenario)?.name ?? '',
        variants: p.variants.filter(v => c.variants.includes(v.id)).map(v => v.name),
        engine: { version: hashes.engine, wasmSha256: await engineDigest() },
        inputs: { modelSha256: hashes.model ?? '', studySha256: hashes.study ?? '', startSha256: start ? await sha256(JSON.stringify(start)) : '' },
        outcome, resultsSha256: hashes.results, durationMs: Math.round(ms),
      };
      const id = this.docId;
      await this.library.addRun(id, rec);
      const report = await new Response(new Blob([/** @type {Uint8Array<ArrayBuffer>} */ (bytes)]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
      await this.library.putResult(id, rec.run, kind, report);
      this.dock.runsChanged();
    } catch (error) {
      this.log('warn', `The run was not added to the run log: ${error instanceof Error ? error.message : error}`);
    }
  }

  /** A recorded run's results, read back from its stored report, or null when none is stored.
   * @param {string} run @param {CalcKind} kind */
  async runResult(run, kind) {
    const blob = await this.library.getResult(this.docId, run);
    if (!blob) return null;
    const text = await new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).text();
    return adapt(kind, JSON.parse(text));
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
      if (!auto) this.logWarnings(lf.warnings, 'the load flow results list them all');
      if (!auto && lf.deenergized.length) {
        const shown = lf.deenergized.slice(0, 20).map(name).join(', ');
        this.log('warn', `De-energised busbars: ${shown}${lf.deenergized.length > 20 ? `, and ${lf.deenergized.length - 20} more (listed under the load flow's warnings)` : ''}.`);
      }
    } else if (kind === 'shortcircuit') {
      /** @type {import('./engine/reports.js').ShortCircuitResult} */
      const sc = r;
      const top = sc.buses.reduce((m, b) => (b.ikss > m.ikss ? b : m), { ikss: -Infinity, id: '' });
      this.log('ok', `Short circuit (${enumLabel('fault', sc.fault).toLowerCase()}, ${sc.mode === 'max' ? 'maximum' : 'minimum'}) at ${sc.location ? name(sc.location) : `${sc.buses.length} busbars`} in ${duration(ms)}.${top.id ? ` Highest Ik″ ${fixed(top.ikss, 2)} kA at ${name(top.id)}.` : ''}`);
      this.logWarnings(sc.warnings, 'the short-circuit results list them all');
    } else if (kind === 'contingency') {
      /** @type {import('./engine/reports.js').ContingencyResult} */
      const n1 = r;
      const bad = n1.cases.filter(c => c.converged && c.violations.some(v => !v.inBase)).length, failed = n1.cases.filter(c => !c.converged).length;
      const screened = n1.effort.screened ? `, ${n1.effort.screened} cleared by screening` : '';
      this.log(bad || failed ? 'warn' : 'ok', `Contingency analysis of ${n1.cases.length} contingencies in ${duration(ms)}${screened}: ${bad} with new violations${failed ? `, ${failed} without a solution` : ''}.`);
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
      el.innerHTML = `<span class="title">Voltage levels</span>${kvs.slice(0, 6).map(kv => `<span class="sw" data-kv="${kv}"><i style="background:${css(cls(kv))}"></i>${kv} kV</span>`).join('')}`
        + '<span class="lod" hidden>Lower levels show as you zoom in</span>';
      this.viewport.showLevels();
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

  /** Logs a calculation's warnings: the first twenty, and how many more there are. @param {string[]} warnings @param {string} where */
  logWarnings(warnings, where) {
    for (const w of warnings.slice(0, 20)) this.log('warn', w);
    if (warnings.length > 20) this.log('warn', `And ${warnings.length - 20} more warnings; ${where}.`);
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
    // The first worker does one thing at a time: a calculation or an Arrange.
    const idle = () => !this.running && !this.arranging;
    const tool = (/** @type {Tool} */ t, /** @type {string} */ label, /** @type {string} */ ic, /** @type {string} */ key, /** @type {string} */ hint) =>
      c.add({ id: `tool.${t}`, label, icon: ic, keys: [key], group: t === 'select' || t === 'pan' ? 'Tool' : 'Insert', hint, run: () => this.setTool(this.tool === t && t !== 'select' ? 'select' : t), pressed: () => this.tool === t });
    // File
    c.add({ id: 'file.backstage', label: 'File menu', icon: 'open', group: 'File', run: () => openBackstage(this) });
    c.add({ id: 'file.new', label: 'New network', icon: 'new', group: 'File', run: () => this.newDocument() });
    c.add({ id: 'file.open', label: 'Open saved network', icon: 'open', keys: ['Mod+O'], global: true, group: 'File', run: () => openBackstage(this, 'open') });
    c.add({ id: 'file.save', label: 'Save now', icon: 'save', keys: ['Mod+S'], global: true, group: 'File', hint: 'Networks save automatically; this saves immediately', run: async () => { await this.save(); toast('ok', this.library.persistent ? 'Saved in this browser.' : 'Kept for this session. Export to keep a copy.'); } });
    c.add({ id: 'file.import', label: 'Import file', icon: 'import', keys: ['Mod+Shift+O'], global: true, group: 'File', hint: 'Import a PowerStudio file, a CGMES model, a PSS/E RAW file or a MATPOWER case', run: () => this.importFile(`.json,${IMPORT_TYPES}`) });
    c.add({ id: 'file.exportProject', label: 'Export project', keywords: 'backup archive variants scenarios runs', icon: 'layers', group: 'File', hint: 'The whole project with its run log, as one file', run: () => { void this.exportProject(); } });
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
    c.add({ id: 'project.menu', label: 'Study case', icon: 'layers', group: 'File', hint: 'Choose the study case and where changes go', run: () => this.projectMenu() });
    c.add({ id: 'project.open', label: 'Manage project', keywords: 'study case scenario variant run log', icon: 'layers', group: 'File', run: () => openBackstage(this, 'project') });
    c.add({ id: 'layout.arrange', label: 'Arrange', icon: 'layout', group: 'Edit', hint: 'Lay the diagram out again from the network topology',
      enabled: () => !this.running && !this.arranging, run: () => { void this.arrange(); } });
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
    c.add({ id: 'calc.contingency', keywords: 'n-1 outage security', label: 'Contingency', icon: 'contingency', keys: ['Alt+N'], global: true, group: 'Calculate', hint: 'Every branch out in turn, and the contingencies of the study case', enabled: idle, run: () => this.calc('contingency') });
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
    studyToggle('contingency.gens', 'Generator outages', 'gen', 'contingency', 'gens', true, false);
    studyToggle('contingency.busbars', 'Busbar faults', 'bus', 'contingency', 'busbars', true, false);
    studyToggle('contingency.screening', 'Screen outages first', 'loadflow', 'contingency', 'screening', true, false);
    c.add({ id: 'contingency.edit', keywords: 'remedial action special protection double circuit n-2 list', label: 'Contingencies', icon: 'settings', group: 'Study case',
      hint: 'Contingencies of several elements, and remedial actions', run: () => openContingencyDialog(this) });
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

/** Where the next load flow starts, from a converged one: its busbar voltages and its machines at a reactive limit.
 * @param {import('./engine/reports.js').LoadFlowResult} r @returns {import('./engine/reports.js').StartVoltages} */
function startOf(r) {
  /** @type {Array<{ id: string, limit: 'min' | 'max' }>} */
  const held = [];
  for (const u of [...r.gens, ...r.svcs]) if (u.atLimit) held.push({ id: u.id, limit: u.atLimit });
  return { busIds: r.buses.map(b => b.id), vm: r.buses.map(b => b.vm), va: r.buses.map(b => b.va), held };
}

/** SHA-256 of a text, as 64 hexadecimal digits ('' where WebCrypto is unavailable). @param {string} text */
async function sha256(text) {
  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  } catch { return ''; }
}
