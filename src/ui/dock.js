/** The results dock: the output log and one tab per calculation, each with a summary bar and sortable tables. */

import { h, esc } from './dom.js';
import { icon } from './icons.js';
import { fixed, clock, duration } from './format.js';
import { dataTable, toCSV } from './table.js';
import { Plot, seriesColor } from './plot.js';
import { CLASSES } from '../core/catalog.js';
import { effectiveTheme } from './theme.js';
import { enumLabel } from './fields.js';
import { minOf, maxOf } from '../core/extent.js';
import { DataSheet } from './datasheet.js';

/** @typedef {{ time: number, level: 'info' | 'ok' | 'warn' | 'error', text: string, detail?: string }} LogEntry
 * @typedef {'output' | 'data' | 'loadflow' | 'shortcircuit' | 'contingency' | 'rms'} DockTab
 * @typedef {import('../engine/reports.js').CalcKind} CalcKind */

/** Whether a tab shows a calculation's results. @param {DockTab} t @returns {t is CalcKind} */
const isResult = t => t !== 'output' && t !== 'data';

const TABS = /** @type {Array<[DockTab, string, string]>} */ ([
  ['output', 'Output', 'info'], ['data', 'Data', 'database'], ['loadflow', 'Load flow', 'loadflow'], ['shortcircuit', 'Short circuit', 'shortcircuit'],
  ['contingency', 'Contingency', 'contingency'], ['rms', 'Stability', 'rms'],
]);

/** @param {number} pct @returns {string} */
const loadCss = pct => (!Number.isFinite(pct) ? 'var(--text-3)' : pct > 100 ? 'var(--res-high)' : pct > 90 ? 'var(--res-warn)' : pct > 60 ? 'color-mix(in srgb, var(--res-ok), var(--res-warn))' : 'var(--res-ok)');

export class Dock {
  /** @param {HTMLElement} host @param {import('../app.js').App} app */
  constructor(host, app) {
    this.app = app;
    /** @type {LogEntry[]} */
    this.log = [];
    /** Pending animation frame of a log render. */
    this.logFrame = 0;
    /** @type {DockTab} */
    this.tab = /** @type {DockTab} */ (app.prefs.dockTab) in { output: 1, data: 1, loadflow: 1, shortcircuit: 1, contingency: 1, rms: 1 } ? /** @type {DockTab} */ (app.prefs.dockTab) : 'output';
    /** @type {Record<string, { key: string, dir: 1 | -1 }>} */
    this.sorts = {};
    this.lfView = 'buses';
    this.scView = 'buses';
    this.n1View = 'cases';
    /** Which rows the result tables show: all, near the limits, beyond them, or changed from a compared run. */
    this.rowFilter = 'all';
    /** A recorded load flow the current one is compared with. @type {{ run: string, result: import('../engine/reports.js').LoadFlowResult } | null} */
    this.compare = null;
    /** The project's recorded runs, once read (null until then). @type {import('./persistence.js').RunRecord[] | null} */
    this.runList = null;
    this.runListLoading = false;
    /** Whether the next render starts the table at the top (the rows it shows changed). */
    this.fromTop = false;
    this.rmsVar = 'delta';
    /** @type {Set<string>} */
    this.rmsHidden = new Set();
    /** @type {{ columns: any[], rows: any[], name: string } | null} */
    this.current = null;
    // The header: the tabs, which alone make the tab list, and the panel's tools beside them.
    this.tabs = h('div', { class: 'dock-tabs' });
    this.tabList = h('div', { class: 'dock-tablist', role: 'tablist', 'aria-label': 'Results' });
    this.body = h('div', { class: 'dock-body', role: 'tabpanel', id: 'dock-panel', tabindex: '-1' });
    // Table headers stick below the result's toolbars, whose height changes as they wrap.
    this.headSize = new ResizeObserver(entries => {
      for (const e of entries) this.body.style.setProperty('--sticky-top', `${/** @type {HTMLElement} */ (e.target).offsetHeight}px`);
    });
    host.append(this.tabs, this.body);
    this.tabs.addEventListener('click', e => {
      const b = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-tab]'));
      if (b) this.show(/** @type {DockTab} */ (b.dataset.tab));
    });
    // Arrow keys, Home and End move between tabs, as the tab pattern has them; the tab list is one tab stop.
    this.tabList.addEventListener('keydown', e => {
      const ids = TABS.map(([id]) => id), at = ids.indexOf(this.tab);
      const to = e.key === 'ArrowRight' ? (at + 1) % ids.length : e.key === 'ArrowLeft' ? (at - 1 + ids.length) % ids.length
        : e.key === 'Home' ? 0 : e.key === 'End' ? ids.length - 1 : -1;
      if (to < 0) return;
      e.preventDefault();
      this.show(/** @type {DockTab} */ (ids[to]));
      /** @type {HTMLElement | null} */ (this.tabList.querySelector(`[data-tab="${ids[to]}"]`))?.focus();
    });
    /** @type {Plot | null} */
    this.plot = null;
    this.sheet = new DataSheet(app);
  }

  /** Adds a line to the output log. Many lines in a row (a calculation's warnings) render once, on the next frame.
   * @param {LogEntry['level']} level @param {string} text @param {string} [detail] */
  write(level, text, detail) {
    this.log.push({ time: Date.now(), level, text, detail });
    if (this.log.length > 500) this.log.shift();
    if (this.logFrame) return;
    this.logFrame = requestAnimationFrame(() => {
      this.logFrame = 0;
      if (this.tab === 'output') this.render(); else this.renderTabs();
    });
  }

  /** @param {DockTab} tab */
  show(tab) {
    this.tab = tab;
    this.app.prefs.dockTab = tab;
    this.app.savePrefs();
    if (this.app.prefs.dock === false) this.app.setPanel('dock', true);
    if (isResult(tab) && tab !== this.app.overlayKind && this.app.results[tab]) this.app.setOverlay(tab);
    this.render();
  }

  renderTabs() {
    const app = this.app;
    const btns = TABS.map(([id, label, ic]) => {
      let badge = '';
      if (id === 'output') {
        const warn = this.log.filter(l => l.level === 'warn' || l.level === 'error').length;
        if (warn) badge = `<span class="count warn">${warn}</span>`;
      } else if (id === 'contingency' && app.results.contingency) {
        const bad = app.results.contingency.result.cases.filter((/** @type {any} */ c) => !c.converged || c.violations.length).length;
        badge = `<span class="count ${bad ? 'bad' : ''}">${bad}</span>`;
      } else if (isResult(id) && app.results[id]) badge = `<span class="count">${app.resultsStale(id) ? 'old' : '✓'}</span>`;
      const on = this.tab === id;
      return h('button', { type: 'button', role: 'tab', class: 'dock-tab', id: `dock-tab-${id}`, 'data-tab': id, 'aria-selected': String(on),
        'aria-controls': 'dock-panel', tabindex: on ? '0' : '-1', html: `${icon(ic, 15)}<span>${label}</span>${badge}` });
    });
    this.body.setAttribute('aria-labelledby', `dock-tab-${this.tab}`);
    const tools = [h('span', { class: 'dock-spacer' }),
      h('button', { type: 'button', class: 'icon-btn sm', title: 'Export table as CSV', 'aria-label': 'Export table as CSV', 'data-cmd': 'results.csv', html: icon('csv', 16) }),
      h('button', { type: 'button', class: 'icon-btn sm', title: app.prefs.dock ? 'Hide results' : 'Show results', 'aria-label': 'Toggle results panel', 'data-cmd': 'view.dock', html: icon('panelBottom', 16) })];
    // Focus stays on the tab the keyboard moved to when the tabs are drawn again.
    const focused = this.tabList.contains(document.activeElement);
    this.tabList.replaceChildren(...btns);
    this.tabs.replaceChildren(this.tabList, ...tools);
    if (focused) /** @type {HTMLElement | null} */ (this.tabList.querySelector('[aria-selected="true"]'))?.focus();
  }

  render() {
    this.renderTabs();
    this.body.classList.remove('column');
    this.current = null;
    const app = this.app;
    const scroll = this.fromTop ? 0 : this.body.scrollTop;
    this.fromTop = false;
    if (this.tab !== 'rms') this.plot = null;
    if (this.tab === 'output') this.renderLog();
    else if (this.tab === 'data') { const { toolbar, sheet } = this.sheet.render(this.body); this.mount([toolbar], sheet); }
    else if (!app.results[this.tab]) this.renderEmpty(this.tab);
    else if (this.tab === 'loadflow') this.renderLoadFlow();
    else if (this.tab === 'shortcircuit') this.renderShortCircuit();
    else if (this.tab === 'contingency') this.renderContingency();
    else if (this.tab === 'rms') { this.renderRms(); return; }
    this.body.scrollTop = scroll;
  }

  renderLog() {
    const list = h('ol', { class: 'log', 'aria-live': 'polite' });
    for (const l of this.log) {
      const ic = l.level === 'ok' ? 'check' : l.level === 'warn' ? 'warning' : l.level === 'error' ? 'error' : 'info';
      list.append(h('li', { class: l.level }, h('time', { text: clock(l.time) }), h('span', { html: icon(ic, 15) }),
        h('span', { class: 'msg', html: `${esc(l.text)}${l.detail ? ` <span class="detail">${esc(l.detail)}</span>` : ''}` })));
    }
    this.body.replaceChildren(list);
    this.body.scrollTop = this.body.scrollHeight;
  }

  /** @param {CalcKind} tab */
  renderEmpty(tab) {
    const what = { loadflow: ['loadflow', 'No load flow yet', 'calc.loadflow', 'Run load flow'], shortcircuit: ['shortcircuit', 'No short-circuit calculation yet', 'calc.shortcircuit', 'Run short circuit'],
      contingency: ['contingency', 'No contingency analysis yet', 'calc.contingency', 'Run N-1 analysis'], rms: ['rms', 'No stability simulation yet', 'calc.rms', 'Run simulation'] }[tab];
    this.body.replaceChildren(h('div', { class: 'dock-empty' }, h('div', { class: 'inner' }, h('span', { html: icon(what[0], 26) }), h('div', { text: what[1] }),
      h('button', { type: 'button', class: 'btn primary', 'data-cmd': what[2], html: `${icon('play', 14)}<span>${what[3]}</span>` }))));
  }

  /** @param {string} key @param {string} def @param {1 | -1} [dir] */
  sortFor(key, def, dir = 1) { return this.sorts[key] ??= { key: def, dir }; }

  /** @param {string} table */
  onSort(table) {
    return (/** @type {string} */ key) => {
      const s = this.sorts[table];
      if (s.key === key) s.dir = /** @type {1 | -1} */ (-s.dir); else { s.key = key; s.dir = 1; }
      this.render();
    };
  }

  /** @param {string} id @param {MouseEvent} e */
  pick(id, e) {
    const app = this.app;
    if (!app.store.get(id)) return;
    if (e.shiftKey || e.metaKey || e.ctrlKey) app.toggleSelection(id);
    else { app.setSelection([id]); app.viewport.reveal([id]); }
  }

  /** Shows a result: its toolbars in one header that stays in view, then its content. @param {Array<HTMLElement | null>} toolbars @param {HTMLElement} content */
  mount(toolbars, content) {
    const head = h('div', { class: 'dock-head' }, ...toolbars.filter(t => t !== null));
    this.headSize.disconnect();
    this.body.replaceChildren(head, content);
    this.headSize.observe(head);
  }

  /** A toolbar with a summary and an optional segmented switch. @param {HTMLElement[]} parts */
  toolbar(...parts) { return h('div', { class: 'dock-toolbar' }, ...parts); }

  /** @param {Array<[string, string]>} items @param {string} value @param {(v: string) => void} set */
  segmented(items, value, set) {
    const seg = h('div', { class: 'seg', role: 'group' });
    // Another view or filter shows other rows: they start at the top.
    for (const [v, label] of items) seg.append(h('button', { type: 'button', 'aria-pressed': String(v === value), text: label, onclick: () => { set(v); this.fromTop = true; this.render(); } }));
    return seg;
  }

  /** @param {any[]} columns @param {any[]} rows @param {string} name @param {string} sortKey @param {string} def @param {1 | -1} [dir] */
  table(columns, rows, name, sortKey, def, dir = 1) {
    this.current = { columns, rows, name };
    return dataTable({ columns, rows, id: r => r.id, selected: this.app.selection, sort: this.sortFor(sortKey, def, dir), onSort: this.onSort(sortKey), onRow: (id, e) => this.pick(id, e), scroller: this.body });
  }

  /** @param {string} id */
  nameOf(id) { return this.app.store.get(id)?.name || id; }

  /** The run log changed: its list is read again when next shown. */
  runsChanged() {
    this.runList = null;
    if (this.tab === 'loadflow') this.render();
  }

  /** Another project opened: no run to compare with yet. */
  projectOpened() {
    this.runList = null;
    this.compare = null;
  }

  /**
   * Which rows to show: a segmented control of named filters, falling back to all when the current one does not apply.
   * @param {Array<[string, string, (row: any) => boolean]>} filters @param {any[]} rows
   */
  filtered(filters, rows) {
    const all = /** @type {Array<[string, string, (row: any) => boolean]>} */ ([['all', 'All', () => true], ...filters]);
    const chosen = all.find(f => f[0] === this.rowFilter) ?? all[0];
    const seg = this.segmented(all.map(([v, label]) => [v, label]), chosen[0], v => { this.rowFilter = v; });
    seg.setAttribute('aria-label', 'Rows to show');
    return { seg, rows: chosen[0] === 'all' ? rows : rows.filter(chosen[2]) };
  }

  /** The control that chooses a recorded load flow to compare with, or null when the project has none. */
  compareControl() {
    const app = this.app;
    if (this.runList === null) {
      if (!this.runListLoading) {
        this.runListLoading = true;
        app.library.runs(app.docId).then(list => { this.runList = list; }, () => { this.runList = []; })
          .finally(() => { this.runListLoading = false; if (this.tab === 'loadflow') this.render(); });
      }
      return null;
    }
    const runs = this.runList.filter(r => r.kind === 'loadflow').reverse();
    if (!runs.length) return null;
    const when = (/** @type {string} */ t) => new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const select = /** @type {HTMLSelectElement} */ (h('select', { class: 'input compare', 'aria-label': 'Compare with a recorded run' },
      h('option', { value: '', text: 'Compare with a recorded run…' }),
      ...runs.map(r => h('option', { value: r.run, text: `${when(r.time)} · ${[r.studyCase, r.scenario, ...r.variants].filter(Boolean).join(' · ')}` }))));
    select.value = this.compare?.run ?? '';
    select.addEventListener('change', async () => {
      const run = select.value;
      if (!run) { this.compare = null; this.render(); return; }
      select.disabled = true;
      try {
        const result = await app.runResult(run, 'loadflow');
        if (!result) { app.toast('info', 'The results of that run were not stored.'); this.compare = null; }
        else this.compare = { run, result: /** @type {import('../engine/reports.js').LoadFlowResult} */ (result) };
      } catch (error) {
        app.toast('error', error instanceof Error ? error.message : String(error), { title: 'The run could not be read' });
        this.compare = null;
      }
      this.fromTop = true;
      this.render();
    });
    return select;
  }

  staleNote() { return isResult(this.tab) && this.app.resultsStale(this.tab) ? h('span', { class: 'pill warn', html: `${icon('warning', 13)}Calculated before the last edit` }) : null; }

  renderLoadFlow() {
    const app = this.app, { result: r, ms } = /** @type {{ result: import('../engine/reports.js').LoadFlowResult, ms: number }} */ (app.results.loadflow);
    const pill = r.converged ? h('span', { class: 'pill ok', html: `${icon('check', 13)}Converged in ${r.iterations} iteration${r.iterations === 1 ? '' : 's'}` }) : h('span', { class: 'pill bad', html: `${icon('error', 13)}${esc(r.message)}` });
    const shared = r.distributed ? `<span>Shared imbalance <b>${fixed(r.distributed, 2)} MW</b></span>` : '';
    const summary = h('div', { class: 'summary', html: `<span>Generation <b>${fixed(r.totals.generation, 2)} MW</b></span><span>Load <b>${fixed(r.totals.load, 2)} MW</b></span><span>Losses <b>${fixed(r.totals.losses, 3)} MW</b></span>${shared}<span>Mismatch <b>${r.mismatch.toExponential(1)} MVA</b></span><span>Time <b>${duration(ms)}</b></span>` });
    const regulated = r.taps.length + r.sections.length;
    const views = /** @type {Array<[string, string]>} */ ([['buses', `Busbars ${r.buses.length}`], ['branches', `Branches ${r.branches.length}`], ['units', `Machines and loads ${r.gens.length + r.grids.length + r.loads.length + r.shunts.length}`]]);
    if (regulated) views.push(['controls', `Controls ${regulated}`]);
    if (r.areas.length) views.push(['areas', `Areas ${r.areas.length}`]);
    const warnings = r.warnings.length + r.deenergized.length;
    const listed = warnings > 3 || r.warnings.some(w => w.length > 200) || r.deenergized.length > 20;
    if (listed) views.push(['warnings', `Warnings ${warnings}`]);
    const view = (this.lfView === 'controls' && !regulated) || (this.lfView === 'areas' && !r.areas.length) || (this.lfView === 'warnings' && !listed) ? 'buses' : this.lfView;
    const seg = this.segmented(views, view, v => { this.lfView = v; });
    const bar = this.toolbar(pill, this.staleNote() ?? h('span'), summary, h('span', { class: 'grow' }), seg);
    /** @type {HTMLElement | null} */
    let filters = null;
    let table;
    if (view === 'warnings') {
      /** @typedef {{ id: string, kind: string, text: string }} WarningRow */
      const rows = /** @type {WarningRow[]} */ ([
        ...r.warnings.map((w, i) => ({ id: `w${i}`, kind: 'Warning', text: w })),
        ...r.deenergized.map(id => ({ id, kind: 'De-energised busbar', text: this.nameOf(id) })),
      ]);
      table = this.table([
        { key: 'kind', label: 'Kind', value: (/** @type {WarningRow} */ w) => w.kind },
        { key: 'text', label: 'Detail', value: (/** @type {WarningRow} */ w) => w.text, title: (/** @type {WarningRow} */ w) => w.text },
      ], rows, 'load-flow-warnings', 'lf-warnings', 'kind');
    } else if (view === 'areas') {
      const lf = app.store.doc.study.loadflow;
      const set = (/** @type {import('../engine/reports.js').AreaResult} */ a) => a.controlled || a.target !== 0 || a.tolerance !== 0;
      const status = (/** @type {import('../engine/reports.js').AreaResult} */ a) => {
        const off = a.export - a.target;
        if (!a.controlled) return lf.areas.some(x => x.zone === a.name && x.slack) && !lf.areaInterchange ? 'Off in the study case' : 'Not controlled';
        return Math.abs(off) <= a.tolerance + 1e-6 ? 'Within tolerance' : `${fixed(Math.abs(off), 1)} MW ${off < 0 ? 'short' : 'over'}`;
      };
      table = this.table([
        { key: 'name', label: 'Area', value: (/** @type {any} */ a) => a.name },
        { key: 'export', label: 'Net export', unit: 'MW', num: true, value: (/** @type {any} */ a) => a.export, text: (/** @type {any} */ a) => fixed(a.export, 2) },
        { key: 'target', label: 'Target', unit: 'MW', num: true, value: (/** @type {any} */ a) => (set(a) ? a.target : NaN), text: (/** @type {any} */ a) => (set(a) ? fixed(a.target, 2) : '—') },
        { key: 'tolerance', label: 'Tolerance', unit: 'MW', num: true, value: (/** @type {any} */ a) => (set(a) ? a.tolerance : NaN), text: (/** @type {any} */ a) => (set(a) ? fixed(a.tolerance, 1) : '—') },
        { key: 'status', label: 'Interchange', value: (/** @type {any} */ a) => status(a),
          cls: (/** @type {any} */ a) => (a.controlled && Math.abs(a.export - a.target) > a.tolerance + 1e-6 ? 'warn' : '') },
      ], r.areas, 'loadflow', 'areas', 'name', 1);
    } else if (view === 'controls') {
      /** @typedef {{ id: string, kind: string, before: number, after: number, low: number, high: number }} ControlRow */
      const rows = /** @type {ControlRow[]} */ ([
        ...r.taps.map(t => ({ id: t.id, kind: t.kind === 'phase' ? 'Phase shifter' : 'Tap changer', before: t.start, after: t.position, low: t.low, high: t.high })),
        ...r.sections.map(x => ({ id: x.id, kind: 'Switched shunt', before: x.start, after: x.sections, low: 0, high: x.max })),
      ]);
      const note = (/** @type {ControlRow} */ c) => (c.after === c.low ? (c.kind === 'Switched shunt' ? 'All sections out' : 'At its lowest position') : c.after === c.high ? (c.kind === 'Switched shunt' ? 'All sections in' : 'At its highest position') : '');
      table = this.table([
        { key: 'name', label: 'Element', value: (/** @type {ControlRow} */ c) => this.nameOf(c.id) },
        { key: 'kind', label: 'Control', value: (/** @type {ControlRow} */ c) => c.kind },
        { key: 'before', label: 'Before', num: true, value: (/** @type {ControlRow} */ c) => c.before, text: (/** @type {ControlRow} */ c) => String(c.before) },
        { key: 'after', label: 'After', num: true, value: (/** @type {ControlRow} */ c) => c.after, text: (/** @type {ControlRow} */ c) => String(c.after) },
        { key: 'moved', label: 'Moved', num: true, value: (/** @type {ControlRow} */ c) => c.after - c.before, text: (/** @type {ControlRow} */ c) => (c.after === c.before ? '—' : `${c.after > c.before ? '+' : ''}${c.after - c.before}`) },
        { key: 'range', label: 'Range', value: (/** @type {ControlRow} */ c) => `${c.low} … ${c.high}` },
        { key: 'note', label: 'Note', value: note, cls: (/** @type {ControlRow} */ c) => (note(c) ? 'warn' : '') },
      ], rows, 'load-flow-controls', 'lf-controls', 'name');
    } else if (view === 'buses') {
      const busEl = (/** @type {string} */ id) => app.store.get(id);
      const other = this.compare ? new Map(this.compare.result.buses.map(b => [b.id, b])) : null;
      const du = (/** @type {any} */ b) => { const o = other?.get(b.id); return o ? b.vm - o.vm : NaN; };
      const dva = (/** @type {any} */ b) => { const o = other?.get(b.id); return o ? b.va - o.va : NaN; };
      const band = (/** @type {any} */ b) => { const e = busEl(b.id); return e ? { lo: /** @type {number} */ (e.vmin), hi: /** @type {number} */ (e.vmax) } : null; };
      const shown = this.filtered([
        ['near', 'Near limits', b => { const x = band(b); return !!x && (b.vm < x.lo + 0.01 || b.vm > x.hi - 0.01); }],
        ['out', 'Outside band', b => { const x = band(b); return !!x && (b.vm < x.lo || b.vm > x.hi); }],
        ...(other ? /** @type {Array<[string, string, (b: any) => boolean]>} */ ([['changed', 'Changed', b => !(Math.abs(du(b)) <= 1e-4 && Math.abs(dva(b)) <= 0.01)]]) : []),
      ], r.buses);
      filters = shown.seg;
      table = this.table([
        { key: 'name', label: 'Busbar', value: (/** @type {any} */ b) => this.nameOf(b.id) },
        { key: 'type', label: 'Type', value: (/** @type {any} */ b) => b.type },
        { key: 'kv', label: 'U', unit: 'kV', num: true, value: (/** @type {any} */ b) => b.kv, text: (/** @type {any} */ b) => fixed(b.kv, 3) },
        { key: 'vm', label: 'u', unit: 'p.u.', num: true, value: (/** @type {any} */ b) => b.vm, text: (/** @type {any} */ b) => fixed(b.vm, 4),
          cls: (/** @type {any} */ b) => { const e = busEl(b.id); return e && (b.vm < /** @type {number} */ (e.vmin) || b.vm > /** @type {number} */ (e.vmax)) ? 'bad' : ''; } },
        ...(other ? [{ key: 'du', label: 'Δu', unit: 'p.u.', num: true, value: du, text: (/** @type {any} */ b) => signed(du(b), 4), cls: (/** @type {any} */ b) => (Math.abs(du(b)) > 0.01 ? 'warn' : '') }] : []),
        { key: 'va', label: 'Angle', unit: '°', num: true, value: (/** @type {any} */ b) => b.va, text: (/** @type {any} */ b) => fixed(b.va, 3) },
        ...(other ? [{ key: 'dva', label: 'ΔAngle', unit: '°', num: true, value: dva, text: (/** @type {any} */ b) => signed(dva(b), 3) }] : []),
        { key: 'p', label: 'P injected', unit: 'MW', num: true, value: (/** @type {any} */ b) => b.p, text: (/** @type {any} */ b) => fixed(b.p, 3) },
        { key: 'q', label: 'Q injected', unit: 'Mvar', num: true, value: (/** @type {any} */ b) => b.q, text: (/** @type {any} */ b) => fixed(b.q, 3) },
      ], shown.rows, 'load-flow-busbars', 'lf-buses', 'name');
    } else if (view === 'branches') {
      const other = this.compare ? new Map(this.compare.result.branches.map(b => [b.id, b])) : null;
      const dl = (/** @type {any} */ b) => { const o = other?.get(b.id); return o && Number.isFinite(b.loading) && Number.isFinite(o.loading) ? b.loading - o.loading : NaN; };
      const dp = (/** @type {any} */ b) => { const o = other?.get(b.id); return o ? b.pFrom - o.pFrom : NaN; };
      const shown = this.filtered([
        ['near', 'Above 90 %', b => b.loading >= 90],
        ['out', 'Above 100 %', b => b.loading > 100],
        ...(other ? /** @type {Array<[string, string, (b: any) => boolean]>} */ ([['changed', 'Changed', b => !(Math.abs(dl(b)) <= 0.05 && Math.abs(dp(b)) <= 0.01)]]) : []),
      ], r.branches);
      filters = shown.seg;
      table = this.table([
        { key: 'name', label: 'Branch', value: (/** @type {any} */ b) => this.nameOf(b.id) },
        { key: 'cls', label: 'Type', value: (/** @type {any} */ b) => CLASSES[/** @type {'line' | 'trafo'} */ (b.cls)].label },
        { key: 'loading', label: 'Loading', unit: '%', num: true, value: (/** @type {any} */ b) => b.loading, text: (/** @type {any} */ b) => fixed(b.loading, 1),
          bar: (/** @type {any} */ b) => Number.isFinite(b.loading) ? { pct: b.loading, color: loadCss(b.loading) } : null, cls: (/** @type {any} */ b) => b.loading > 100 ? 'bad' : '' },
        ...(other ? [{ key: 'dloading', label: 'ΔLoading', unit: '%', num: true, value: dl, text: (/** @type {any} */ b) => signed(dl(b), 1), cls: (/** @type {any} */ b) => (dl(b) > 5 ? 'warn' : '') }] : []),
        { key: 'pFrom', label: 'P from', unit: 'MW', num: true, value: (/** @type {any} */ b) => b.pFrom, text: (/** @type {any} */ b) => fixed(b.pFrom, 3) },
        ...(other ? [{ key: 'dp', label: 'ΔP from', unit: 'MW', num: true, value: dp, text: (/** @type {any} */ b) => signed(dp(b), 3) }] : []),
        { key: 'qFrom', label: 'Q from', unit: 'Mvar', num: true, value: (/** @type {any} */ b) => b.qFrom, text: (/** @type {any} */ b) => fixed(b.qFrom, 3) },
        { key: 'pTo', label: 'P to', unit: 'MW', num: true, value: (/** @type {any} */ b) => b.pTo, text: (/** @type {any} */ b) => fixed(b.pTo, 3) },
        { key: 'qTo', label: 'Q to', unit: 'Mvar', num: true, value: (/** @type {any} */ b) => b.qTo, text: (/** @type {any} */ b) => fixed(b.qTo, 3) },
        { key: 'iFrom', label: 'I max', unit: 'kA', num: true, value: (/** @type {any} */ b) => Math.max(b.iFrom, b.iTo), text: (/** @type {any} */ b) => fixed(Math.max(b.iFrom, b.iTo), 4) },
        { key: 'pLoss', label: 'Losses', unit: 'kW', num: true, value: (/** @type {any} */ b) => b.pLoss * 1000, text: (/** @type {any} */ b) => fixed(b.pLoss * 1000, 1) },
      ], shown.rows, 'load-flow-branches', 'lf-branches', 'loading', -1);
    } else {
      const rows = [
        ...r.gens.map(u => ({ ...u, kind: 'gen' })), ...r.grids.map(u => ({ ...u, kind: 'extgrid' })),
        ...r.loads.map(u => ({ ...u, kind: 'load' })), ...r.shunts.map(u => ({ ...u, kind: 'shunt', atLimit: undefined })),
      ];
      table = this.table([
        { key: 'name', label: 'Element', value: (/** @type {any} */ u) => this.nameOf(u.id) },
        { key: 'kind', label: 'Type', value: (/** @type {any} */ u) => CLASSES[/** @type {import('../core/catalog.js').ElementClass} */ (u.kind)].label },
        { key: 'p', label: 'P', unit: 'MW', num: true, value: (/** @type {any} */ u) => u.p, text: (/** @type {any} */ u) => fixed(u.p, 3) },
        { key: 'q', label: 'Q', unit: 'Mvar', num: true, value: (/** @type {any} */ u) => u.q, text: (/** @type {any} */ u) => fixed(u.q, 3) },
        { key: 'limit', label: 'Note', value: (/** @type {any} */ u) => (u.atLimit === 'max' ? 'At upper Q limit' : u.atLimit === 'min' ? 'At lower Q limit' : ''), cls: (/** @type {any} */ u) => (u.atLimit ? 'warn' : '') },
      ], rows, 'load-flow-units', 'lf-units', 'kind');
    }
    // A few short notes show as pills; more go to the Warnings view.
    const notes = [...r.warnings, ...(r.deenergized.length ? [`De-energised: ${r.deenergized.map(id => this.nameOf(id)).join(', ')}`] : [])];
    const pills = notes.length > 0 && notes.length <= 3 && notes.every(n => n.length <= 200);
    // Filters for the busbar and branch tables, and the comparison with a recorded run.
    const compare = this.compareControl();
    const second = filters || compare ? this.toolbar(filters ?? h('span'), h('span', { class: 'grow' }), compare ?? h('span')) : null;
    this.mount([bar, second, pills ? h('div', { class: 'dock-toolbar', html: notes.map(n => `<span class="pill warn">${icon('warning', 13)}${esc(n)}</span>`).join('') }) : null], table);
  }

  renderShortCircuit() {
    const app = this.app, { result: r, ms } = /** @type {{ result: import('../engine/reports.js').ShortCircuitResult, ms: number }} */ (app.results.shortcircuit);
    const where = r.location ? `at ${this.nameOf(r.location)}` : 'at every busbar';
    const zf = r.faultR || r.faultX ? ` · ZF ${fixed(r.faultR, 2)} + j${fixed(r.faultX, 2)} Ω` : '';
    const pill = h('span', { class: 'pill neutral', text: `${enumLabel('fault', r.fault)} · ${r.mode === 'max' ? 'maximum' : 'minimum'} · κ method ${r.kappaMethod}${zf}` });
    const summary = h('div', { class: 'summary', html: `<span>Fault <b>${esc(where)}</b></span><span>Busbars <b>${r.buses.length}</b></span><span>Time <b>${duration(ms)}</b></span>` });
    const items = /** @type {Array<[string, string]>} */ ([['buses', 'Busbars']]);
    if (r.contributions.length) items.push(['contrib', `Contributions ${r.contributions.length}`]);
    const view = r.contributions.length ? this.scView : 'buses';
    const bar = this.toolbar(pill, this.staleNote() ?? h('span'), summary, h('span', { class: 'grow' }), this.segmented(items, view, v => { this.scView = v; }));
    let table;
    if (view === 'buses') {
      const one = r.fault === '1ph';
      table = this.table([
        { key: 'name', label: 'Busbar', value: (/** @type {any} */ b) => this.nameOf(b.id) },
        { key: 'un', label: 'Un', unit: 'kV', num: true, value: (/** @type {any} */ b) => Number(app.store.get(b.id)?.vn ?? NaN), text: (/** @type {any} */ b) => fixed(Number(app.store.get(b.id)?.vn ?? NaN), 2) },
        { key: 'ikss', label: 'Ik″', unit: 'kA', num: true, value: (/** @type {any} */ b) => b.ikss, text: (/** @type {any} */ b) => fixed(b.ikss, 3) },
        { key: 'ip', label: 'ip', unit: 'kA', num: true, value: (/** @type {any} */ b) => b.ip, text: (/** @type {any} */ b) => fixed(b.ip, 3) },
        ...(r.fault === '3ph' && r.mode === 'max' ? [{ key: 'ib', label: 'Ib', unit: 'kA', num: true, help: `Breaking current at ${fixed(r.tMin, 2)} s`, value: (/** @type {any} */ b) => b.ib, text: (/** @type {any} */ b) => fixed(b.ib, 3) }] : []),
        { key: 'ith', label: 'Ith', unit: 'kA', num: true, help: `Thermal equivalent current over ${fixed(r.tK, 2)} s`, value: (/** @type {any} */ b) => b.ith, text: (/** @type {any} */ b) => fixed(b.ith, 3) },
        { key: 'skss', label: 'Sk″', unit: 'MVA', num: true, value: (/** @type {any} */ b) => b.skss, text: (/** @type {any} */ b) => fixed(b.skss, 1) },
        { key: 'kappa', label: 'κ', num: true, value: (/** @type {any} */ b) => b.kappa, text: (/** @type {any} */ b) => fixed(b.kappa, 3) },
        { key: 'rx', label: 'R/X', num: true, value: (/** @type {any} */ b) => b.rx, text: (/** @type {any} */ b) => fixed(b.rx, 3) },
        { key: 'z1', label: '|Z1|', unit: 'Ω', num: true, value: (/** @type {any} */ b) => Math.hypot(b.r1, b.x1), text: (/** @type {any} */ b) => fixed(Math.hypot(b.r1, b.x1), 4) },
        ...(one ? [{ key: 'z0', label: '|Z0|', unit: 'Ω', num: true, value: (/** @type {any} */ b) => Math.hypot(b.r0, b.x0), text: (/** @type {any} */ b) => (Math.hypot(b.r0, b.x0) > 1e6 ? 'open' : fixed(Math.hypot(b.r0, b.x0), 4)) }] : []),
        { key: 'c', label: 'c', num: true, value: (/** @type {any} */ b) => b.c, text: (/** @type {any} */ b) => fixed(b.c, 2) },
      ], r.buses, 'short-circuit-busbars', 'sc-buses', 'ikss', -1);
    } else {
      table = this.table([
        { key: 'name', label: 'Branch', value: (/** @type {any} */ c) => this.nameOf(c.id) },
        { key: 'iFrom', label: 'I from', unit: 'kA', num: true, value: (/** @type {any} */ c) => c.iFrom, text: (/** @type {any} */ c) => fixed(c.iFrom, 3) },
        { key: 'iTo', label: 'I to', unit: 'kA', num: true, value: (/** @type {any} */ c) => c.iTo, text: (/** @type {any} */ c) => fixed(c.iTo, 3) },
      ], r.contributions, 'short-circuit-contributions', 'sc-contrib', 'iFrom', -1);
    }
    const notes = r.warnings.map(w => `<span class="pill warn">${icon('warning', 13)}${esc(w)}</span>`).join('');
    this.mount([bar, notes ? h('div', { class: 'dock-toolbar', html: notes }) : null], r.buses.length ? table : h('div', { class: 'dock-empty', text: 'No busbar could be faulted. See the warnings above.' }));
  }

  renderContingency() {
    const app = this.app, { result: r, ms } = /** @type {{ result: import('../engine/reports.js').ContingencyResult, ms: number }} */ (app.results.contingency);
    const failed = r.cases.filter(c => !c.converged).length, viol = r.cases.filter(c => c.converged && c.violations.some(v => !v.inBase)).length;
    const pill = failed || viol ? h('span', { class: 'pill bad', html: `${icon('warning', 13)}${viol} contingenc${viol === 1 ? 'y' : 'ies'} with new violations${failed ? `, ${failed} not solvable` : ''}` }) : h('span', { class: 'pill ok', html: `${icon('check', 13)}Secure under every contingency` });
    const e = r.effort, acted = r.cases.filter(c => c.remedial.length).length;
    const work = e.screened ? `<span title="Outages the quick decoupled solution cleared, and those solved by a full load flow">Screened <b>${e.screened}</b> of <b>${r.cases.length}</b></span>` : '';
    const summary = h('div', { class: 'summary', html: `<span>Contingencies <b>${r.cases.length}</b></span>${work}${acted ? `<span>Remedial actions on <b>${acted}</b></span>` : ''}<span>Loading limit <b>${r.limit} %</b></span><span>Base case max <b>${fixed(r.base.maxLoading, 1)} %</b></span><span>Time <b>${duration(ms)}</b></span>` });
    const views = /** @type {Array<[string, string]>} */ ([['cases', `Contingencies ${r.cases.length}`], ['branches', `Branches ${Object.keys(r.worstLoading).length}`], ['buses', `Busbars ${Object.keys(r.worstVoltage).length}`]]);
    const view = views.some(v => v[0] === this.n1View) ? this.n1View : 'cases';
    const bar = this.toolbar(pill, this.staleNote() ?? h('span'), summary, h('span', { class: 'grow' }), this.segmented(views, view, v => { this.n1View = v; }));
    const notes = r.notes.map(n => h('div', { class: 'dock-note', html: `${icon('info', 14)}<span>${esc(n)}</span>` }));
    if (view !== 'cases') { this.renderWorst(r, view, bar, notes); return; }
    const describe = (/** @type {import('../engine/reports.js').ContingencyCase} */ c) => c.violations.map(v => v.kind === 'loading' ? `${this.nameOf(v.id)} ${fixed(v.value, 0)} %` : `${this.nameOf(v.id)} ${fixed(v.value, 3)} p.u.`).join(', ');
    const own = new Map(app.store.doc.study.contingency.list.map(c => [c.id, c.name || c.id]));
    const ruleName = new Map(app.store.doc.study.contingency.remedial.map(x => [x.id, x.name || x.id]));
    const kindOf = (/** @type {import('../engine/reports.js').ContingencyCase} */ c) =>
      c.cls === 'multiple' ? `${c.elements.length} elements` : c.cls === 'busbar' ? 'Busbar fault' : /** @type {Record<string, { label: string } | undefined>} */ (CLASSES)[c.cls]?.label ?? c.cls;
    const state = (/** @type {import('../engine/reports.js').ContingencyCase} */ c) => {
      if (!c.converged) return 'Not solvable';
      const v = c.violations.length ? `${c.violations.length} violation${c.violations.length === 1 ? '' : 's'}` : 'Secure';
      return c.screened ? `${v} (screened)` : c.remedial.length ? `${v} after action` : v;
    };
    const shownCases = this.filtered([['viol', 'With violations', c => !c.converged || c.violations.length > 0]], r.cases);
    const table = this.table([
      { key: 'name', label: 'Contingency', value: (/** @type {any} */ c) => own.get(c.id) ?? this.nameOf(c.id) },
      { key: 'cls', label: 'Type', value: (/** @type {any} */ c) => kindOf(c) },
      { key: 'state', label: 'Result', value: (/** @type {any} */ c) => state(c),
        cls: (/** @type {any} */ c) => (!c.converged || c.violations.some((/** @type {any} */ v) => !v.inBase) ? 'bad' : c.violations.length ? 'warn' : '') },
      { key: 'maxLoading', label: 'Max loading', unit: '%', num: true, value: (/** @type {any} */ c) => c.maxLoading, text: (/** @type {any} */ c) => fixed(c.maxLoading, 1), bar: (/** @type {any} */ c) => Number.isFinite(c.maxLoading) ? { pct: c.maxLoading, color: loadCss(c.maxLoading) } : null },
      { key: 'maxLoadingId', label: 'Most loaded', value: (/** @type {any} */ c) => (c.maxLoadingId ? this.nameOf(c.maxLoadingId) : '') },
      { key: 'minV', label: 'Min u', unit: 'p.u.', num: true, value: (/** @type {any} */ c) => c.minV, text: (/** @type {any} */ c) => fixed(c.minV, 4) },
      { key: 'maxV', label: 'Max u', unit: 'p.u.', num: true, value: (/** @type {any} */ c) => c.maxV, text: (/** @type {any} */ c) => fixed(c.maxV, 4) },
      { key: 'lost', label: 'Lost busbars', value: (/** @type {any} */ c) => c.lostBuses.map((/** @type {string} */ b) => this.nameOf(b)).join(', ') },
      { key: 'viol', label: 'Violations', value: (/** @type {any} */ c) => describe(c), title: (/** @type {any} */ c) => describe(c) },
      ...(acted ? [{ key: 'remedial', label: 'Remedial actions', value: (/** @type {any} */ c) => c.remedial.map((/** @type {string} */ id) => ruleName.get(id) ?? id).join(', '),
        title: (/** @type {any} */ c) => (c.remedial.length ? `${c.violationsBefore} violation${c.violationsBefore === 1 ? '' : 's'} before the actions` : '') }] : []),
    ], shownCases.rows, 'contingency', 'n1', 'state', 1);
    this.mount([bar, this.toolbar(shownCases.seg), ...notes], table);
  }

  /**
   * The worst post-contingency state of each branch or busbar, and the outage that causes it.
   * @param {import('../engine/reports.js').ContingencyResult} r @param {string} view @param {HTMLElement} bar @param {HTMLElement[]} notes
   */
  renderWorst(r, view, bar, notes) {
    const own = new Map(this.app.store.doc.study.contingency.list.map(c => [c.id, c.name || c.id]));
    const name = (/** @type {string} */ id) => own.get(id) ?? this.nameOf(id);
    if (view === 'branches') {
      const rows = Object.entries(r.worstLoading).map(([id, w]) => ({ id, value: w.value, outage: w.outage }));
      const shown = this.filtered([['near', 'Above 90 %', b => b.value >= 90], ['out', 'Above 100 %', b => b.value > 100]], rows);
      const table = this.table([
        { key: 'name', label: 'Branch', value: (/** @type {any} */ b) => this.nameOf(b.id) },
        { key: 'value', label: 'Worst loading', unit: '%', num: true, value: (/** @type {any} */ b) => b.value, text: (/** @type {any} */ b) => fixed(b.value, 1),
          bar: (/** @type {any} */ b) => ({ pct: b.value, color: loadCss(b.value) }), cls: (/** @type {any} */ b) => (b.value > r.limit ? 'bad' : '') },
        { key: 'outage', label: 'Under the outage of', value: (/** @type {any} */ b) => name(b.outage) },
      ], shown.rows, 'contingency-worst-loading', 'n1-branches', 'value', -1);
      this.mount([bar, this.toolbar(shown.seg), ...notes], table);
      return;
    }
    const band = (/** @type {string} */ id) => this.app.store.get(id);
    const rows = Object.entries(r.worstVoltage).map(([id, w]) => ({ id, ...w }));
    const outside = (/** @type {any} */ b) => { const e = band(b.id); return !!e && (b.min < /** @type {number} */ (e.vmin) || b.max > /** @type {number} */ (e.vmax)); };
    const shown = this.filtered([['out', 'Outside band', outside]], rows);
    const table = this.table([
      { key: 'name', label: 'Busbar', value: (/** @type {any} */ b) => this.nameOf(b.id) },
      { key: 'min', label: 'Lowest u', unit: 'p.u.', num: true, value: (/** @type {any} */ b) => b.min, text: (/** @type {any} */ b) => fixed(b.min, 4),
        cls: (/** @type {any} */ b) => { const e = band(b.id); return e && b.min < /** @type {number} */ (e.vmin) ? 'bad' : ''; } },
      { key: 'minOutage', label: 'Under the outage of', value: (/** @type {any} */ b) => (b.minOutage ? name(b.minOutage) : '') },
      { key: 'max', label: 'Highest u', unit: 'p.u.', num: true, value: (/** @type {any} */ b) => b.max, text: (/** @type {any} */ b) => fixed(b.max, 4),
        cls: (/** @type {any} */ b) => { const e = band(b.id); return e && b.max > /** @type {number} */ (e.vmax) ? 'bad' : ''; } },
      { key: 'maxOutage', label: 'Under the outage of', value: (/** @type {any} */ b) => (b.maxOutage ? name(b.maxOutage) : '') },
    ], shown.rows, 'contingency-worst-voltage', 'n1-buses', 'min', 1);
    this.mount([bar, this.toolbar(shown.seg), ...notes], table);
  }

  renderRms() {
    const app = this.app, { result: r, ms } = /** @type {{ result: import('../engine/reports.js').RmsResult, ms: number }} */ (app.results.rms);
    const pill = r.stable ? h('span', { class: 'pill ok', html: `${icon('check', 13)}${esc(r.message)}` }) : h('span', { class: 'pill bad', html: `${icon('warning', 13)}${esc(r.message)}` });
    const quantity = RMS_QUANTITIES.find(q => q.key === this.rmsVar) ?? RMS_QUANTITIES[0];
    const seg = h('select', { class: 'input rms-quantity', 'aria-label': 'Quantity shown' }, ...RMS_QUANTITIES.map(q => h('option', { value: q.key, text: q.label })));
    seg.value = quantity.key;
    seg.addEventListener('change', () => { this.rmsVar = seg.value; this.renderRms(); });
    const summary = h('div', { class: 'summary', html: `<span>Angles against <b>${r.angleReference === 'grid' ? 'the external grid' : 'the centre of inertia'}</b></span><span>Steps <b>${r.steps}</b></span><span>Time <b>${duration(ms)}</b></span>` });
    const bar = this.toolbar(pill, this.staleNote() ?? h('span'), summary, h('span', { class: 'grow' }), seg);
    const wrap = h('div', { class: 'plot-wrap' });
    this.body.classList.add('column');
    const plotHost = h('div', { class: 'plot' });
    const side = h('div', { class: 'plot-side' });
    wrap.append(plotHost, side);
    this.mount([bar], wrap);
    const dark = effectiveTheme() === 'dark';
    /** @type {Array<{ id: string, name: string, data: Float32Array }>} */
    let source;
    const unit = quantity.unit;
    if (quantity.key === 'v') source = r.busIds.map((id, k) => ({ id, name: this.nameOf(id), data: r.voltages[k] }));
    else {
      // External grids have an angle and powers but no field or turbine; their angle is the reference when there is one.
      const key = /** @type {'delta' | 'speed' | 'pe' | 'q' | 'efd' | 'pm'} */ (quantity.key);
      source = r.machines.filter(m => m[key].length && (key !== 'delta' || app.store.get(m.id)?.cls === 'gen' || r.angleReference === 'grid'))
        .map(m => ({ id: m.id, name: m.name || m.id, data: m[key] }));
    }
    side.append(h('h4', { text: quantity.key === 'v' ? 'Busbars' : 'Machines' }));
    source.forEach((s, i) => {
      const cb = h('input', { type: 'checkbox' });
      cb.checked = !this.rmsHidden.has(s.id);
      cb.addEventListener('change', () => { if (cb.checked) this.rmsHidden.delete(s.id); else this.rmsHidden.add(s.id); this.renderRms(); });
      side.append(h('label', {}, cb, h('span', { class: 'sw', style: `background:${seriesColor(i, dark)}` }), h('span', { text: s.name })));
    });
    side.append(h('h4', { text: 'Events' }));
    for (const e of r.events) side.append(h('div', { style: 'padding:3px 12px;color:var(--text-2)', html: `<b style="font-variant-numeric:tabular-nums">${fixed(e.t, 3)} s</b> ${esc(e.note)}` }));
    if (r.notes?.length) {
      side.append(h('h4', { text: 'Notes' }));
      for (const n of r.notes) side.append(h('div', { class: 'plot-note', text: n }));
    }
    this.plot = new Plot(plotHost);
    this.plot.onCursor = i => app.setRmsIndex(i);
    this.plot.set({
      t: r.t, unit, label: quantity.label, events: r.events.filter(e => e.applied).map(e => e.t), cursor: app.rmsIndex < 0 ? r.t.length - 1 : app.rmsIndex,
      series: source.map((s, i) => ({ name: s.name, color: seriesColor(i, dark), data: s.data })).filter((_, i) => !this.rmsHidden.has(source[i].id)),
    });
    const rows = source.map(s => ({ id: s.id, name: s.name, min: minOf(s.data), max: maxOf(s.data), end: s.data[s.data.length - 1] }));
    this.current = { name: `stability-${quantity.key}`, rows: [...r.t].map((t, i) => ({ t, ...Object.fromEntries(source.map(s => [s.name, s.data[i]])) })),
      columns: [{ key: 't', label: 'Time', unit: 's', value: (/** @type {any} */ x) => x.t }, ...source.map(s => ({ key: s.name, label: s.name, unit, value: (/** @type {any} */ x) => x[s.name] }))] };
    void rows;
  }

  /** CSV of the table on screen. */
  csv() {
    if (this.tab === 'data') return this.sheet.csv();
    if (!this.current) return null;
    return { name: this.current.name, text: toCSV(this.current.columns, this.current.rows) };
  }
}

/** What the stability view can plot. */
const RMS_QUANTITIES = /** @type {const} */ ([
  { key: 'delta', label: 'Rotor angle', unit: '°' }, { key: 'speed', label: 'Speed', unit: 'Hz' },
  { key: 'pe', label: 'Active power', unit: 'MW' }, { key: 'q', label: 'Reactive power', unit: 'Mvar' },
  { key: 'efd', label: 'Field voltage', unit: 'p.u.' }, { key: 'pm', label: 'Mechanical power', unit: 'MW' },
  { key: 'v', label: 'Busbar voltage', unit: 'p.u.' },
]);

/** A difference with its sign, or a dash when one run lacks the element. @param {number} v @param {number} digits */
function signed(v, digits) {
  if (!Number.isFinite(v)) return '—';
  const t = fixed(v, digits);
  return v > 0 && Number(t) !== 0 ? `+${t}` : t;
}
