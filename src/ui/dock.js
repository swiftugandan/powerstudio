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

/** @typedef {{ time: number, level: 'info' | 'ok' | 'warn' | 'error', text: string, detail?: string }} LogEntry
 * @typedef {'output' | 'loadflow' | 'shortcircuit' | 'contingency' | 'rms'} DockTab */

const TABS = /** @type {Array<[DockTab, string, string]>} */ ([
  ['output', 'Output', 'info'], ['loadflow', 'Load flow', 'loadflow'], ['shortcircuit', 'Short circuit', 'shortcircuit'],
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
    /** @type {DockTab} */
    this.tab = /** @type {DockTab} */ (app.prefs.dockTab) in { output: 1, loadflow: 1, shortcircuit: 1, contingency: 1, rms: 1 } ? /** @type {DockTab} */ (app.prefs.dockTab) : 'output';
    /** @type {Record<string, { key: string, dir: 1 | -1 }>} */
    this.sorts = {};
    this.lfView = 'buses';
    this.scView = 'buses';
    this.rmsVar = 'delta';
    /** @type {Set<string>} */
    this.rmsHidden = new Set();
    /** @type {{ columns: any[], rows: any[], name: string } | null} */
    this.current = null;
    this.tabs = h('div', { class: 'dock-tabs', role: 'tablist', 'aria-label': 'Results' });
    this.body = h('div', { class: 'dock-body', role: 'tabpanel' });
    // Table headers stick below the result's toolbars, whose height changes as they wrap.
    this.headSize = new ResizeObserver(entries => {
      for (const e of entries) this.body.style.setProperty('--sticky-top', `${/** @type {HTMLElement} */ (e.target).offsetHeight}px`);
    });
    host.append(this.tabs, this.body);
    this.tabs.addEventListener('click', e => {
      const b = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-tab]'));
      if (b) this.show(/** @type {DockTab} */ (b.dataset.tab));
    });
    /** @type {Plot | null} */
    this.plot = null;
  }

  /** @param {LogEntry['level']} level @param {string} text @param {string} [detail] */
  write(level, text, detail) {
    this.log.push({ time: Date.now(), level, text, detail });
    if (this.log.length > 500) this.log.shift();
    if (this.tab === 'output') this.render(); else this.renderTabs();
  }

  /** @param {DockTab} tab */
  show(tab) {
    this.tab = tab;
    this.app.prefs.dockTab = tab;
    this.app.savePrefs();
    if (this.app.prefs.dock === false) this.app.setPanel('dock', true);
    if (tab !== 'output' && tab !== this.app.overlayKind && this.app.results[tab]) this.app.setOverlay(tab);
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
      } else if (app.results[id]) badge = `<span class="count">${app.resultsStale(id) ? 'old' : '✓'}</span>`;
      return h('button', { type: 'button', role: 'tab', class: 'dock-tab', 'data-tab': id, 'aria-selected': String(this.tab === id), html: `${icon(ic, 15)}<span>${label}</span>${badge}` });
    });
    const tools = [h('span', { class: 'dock-spacer' }),
      h('button', { type: 'button', class: 'icon-btn sm', title: 'Export table as CSV', 'aria-label': 'Export table as CSV', 'data-cmd': 'results.csv', html: icon('csv', 16) }),
      h('button', { type: 'button', class: 'icon-btn sm', title: app.prefs.dock ? 'Hide results' : 'Show results', 'aria-label': 'Toggle results panel', 'data-cmd': 'view.dock', html: icon('panelBottom', 16) })];
    this.tabs.replaceChildren(...btns, ...tools);
  }

  render() {
    this.renderTabs();
    this.body.classList.remove('column');
    this.current = null;
    const app = this.app;
    const scroll = this.body.scrollTop;
    if (this.tab !== 'rms') this.plot = null;
    if (this.tab === 'output') this.renderLog();
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

  /** @param {DockTab} tab */
  renderEmpty(tab) {
    const what = { loadflow: ['loadflow', 'No load flow yet', 'calc.loadflow', 'Run load flow'], shortcircuit: ['shortcircuit', 'No short-circuit calculation yet', 'calc.shortcircuit', 'Run short circuit'],
      contingency: ['contingency', 'No contingency analysis yet', 'calc.contingency', 'Run N-1 analysis'], rms: ['rms', 'No stability simulation yet', 'calc.rms', 'Run simulation'], output: ['info', '', '', ''] }[tab];
    const keys = this.app.commands.get(what[2])?.keys?.[0];
    this.body.replaceChildren(h('div', { class: 'dock-empty' }, h('div', { class: 'inner' }, h('span', { html: icon(what[0], 26) }), h('div', { text: what[1] }),
      h('button', { type: 'button', class: 'btn primary', 'data-cmd': what[2], html: `${icon('play', 14)}<span>${what[3]}</span>${keys ? '' : ''}` }))));
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
    for (const [v, label] of items) seg.append(h('button', { type: 'button', 'aria-pressed': String(v === value), text: label, onclick: () => { set(v); this.render(); } }));
    return seg;
  }

  /** @param {any[]} columns @param {any[]} rows @param {string} name @param {string} sortKey @param {string} def @param {1 | -1} [dir] */
  table(columns, rows, name, sortKey, def, dir = 1) {
    this.current = { columns, rows, name };
    return dataTable({ columns, rows, id: r => r.id, selected: this.app.selection, sort: this.sortFor(sortKey, def, dir), onSort: this.onSort(sortKey), onRow: (id, e) => this.pick(id, e), scroller: this.body });
  }

  /** @param {string} id */
  nameOf(id) { return this.app.store.get(id)?.name || id; }

  staleNote() { return this.tab !== 'output' && this.app.resultsStale(this.tab) ? h('span', { class: 'pill warn', html: `${icon('warning', 13)}Calculated before the last edit` }) : null; }

  renderLoadFlow() {
    const app = this.app, { result: r, ms } = /** @type {{ result: import('../engine/reports.js').LoadFlowResult, ms: number }} */ (app.results.loadflow);
    const pill = r.converged ? h('span', { class: 'pill ok', html: `${icon('check', 13)}Converged in ${r.iterations} iteration${r.iterations === 1 ? '' : 's'}` }) : h('span', { class: 'pill bad', html: `${icon('error', 13)}${esc(r.message)}` });
    const shared = r.distributed ? `<span>Shared imbalance <b>${fixed(r.distributed, 2)} MW</b></span>` : '';
    const summary = h('div', { class: 'summary', html: `<span>Generation <b>${fixed(r.totals.generation, 2)} MW</b></span><span>Load <b>${fixed(r.totals.load, 2)} MW</b></span><span>Losses <b>${fixed(r.totals.losses, 3)} MW</b></span>${shared}<span>Mismatch <b>${r.mismatch.toExponential(1)} MVA</b></span><span>Time <b>${duration(ms)}</b></span>` });
    const regulated = r.taps.length + r.sections.length;
    const views = /** @type {Array<[string, string]>} */ ([['buses', `Busbars ${r.buses.length}`], ['branches', `Branches ${r.branches.length}`], ['units', `Machines and loads ${r.gens.length + r.grids.length + r.loads.length + r.shunts.length}`]]);
    if (regulated) views.push(['controls', `Controls ${regulated}`]);
    const view = this.lfView === 'controls' && !regulated ? 'buses' : this.lfView;
    const seg = this.segmented(views, view, v => { this.lfView = v; });
    const bar = this.toolbar(pill, this.staleNote() ?? h('span'), summary, h('span', { class: 'grow' }), seg);
    let table;
    if (view === 'controls') {
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
      table = this.table([
        { key: 'name', label: 'Busbar', value: (/** @type {any} */ b) => this.nameOf(b.id) },
        { key: 'type', label: 'Type', value: (/** @type {any} */ b) => b.type },
        { key: 'kv', label: 'U', unit: 'kV', num: true, value: (/** @type {any} */ b) => b.kv, text: (/** @type {any} */ b) => fixed(b.kv, 3) },
        { key: 'vm', label: 'u', unit: 'p.u.', num: true, value: (/** @type {any} */ b) => b.vm, text: (/** @type {any} */ b) => fixed(b.vm, 4),
          cls: (/** @type {any} */ b) => { const e = busEl(b.id); return e && (b.vm < /** @type {number} */ (e.vmin) || b.vm > /** @type {number} */ (e.vmax)) ? 'bad' : ''; } },
        { key: 'va', label: 'Angle', unit: '°', num: true, value: (/** @type {any} */ b) => b.va, text: (/** @type {any} */ b) => fixed(b.va, 3) },
        { key: 'p', label: 'P injected', unit: 'MW', num: true, value: (/** @type {any} */ b) => b.p, text: (/** @type {any} */ b) => fixed(b.p, 3) },
        { key: 'q', label: 'Q injected', unit: 'Mvar', num: true, value: (/** @type {any} */ b) => b.q, text: (/** @type {any} */ b) => fixed(b.q, 3) },
      ], r.buses, 'load-flow-busbars', 'lf-buses', 'name');
    } else if (view === 'branches') {
      table = this.table([
        { key: 'name', label: 'Branch', value: (/** @type {any} */ b) => this.nameOf(b.id) },
        { key: 'cls', label: 'Type', value: (/** @type {any} */ b) => CLASSES[/** @type {'line' | 'trafo'} */ (b.cls)].label },
        { key: 'loading', label: 'Loading', unit: '%', num: true, value: (/** @type {any} */ b) => b.loading, text: (/** @type {any} */ b) => fixed(b.loading, 1),
          bar: (/** @type {any} */ b) => Number.isFinite(b.loading) ? { pct: b.loading, color: loadCss(b.loading) } : null, cls: (/** @type {any} */ b) => b.loading > 100 ? 'bad' : '' },
        { key: 'pFrom', label: 'P from', unit: 'MW', num: true, value: (/** @type {any} */ b) => b.pFrom, text: (/** @type {any} */ b) => fixed(b.pFrom, 3) },
        { key: 'qFrom', label: 'Q from', unit: 'Mvar', num: true, value: (/** @type {any} */ b) => b.qFrom, text: (/** @type {any} */ b) => fixed(b.qFrom, 3) },
        { key: 'pTo', label: 'P to', unit: 'MW', num: true, value: (/** @type {any} */ b) => b.pTo, text: (/** @type {any} */ b) => fixed(b.pTo, 3) },
        { key: 'qTo', label: 'Q to', unit: 'Mvar', num: true, value: (/** @type {any} */ b) => b.qTo, text: (/** @type {any} */ b) => fixed(b.qTo, 3) },
        { key: 'iFrom', label: 'I max', unit: 'kA', num: true, value: (/** @type {any} */ b) => Math.max(b.iFrom, b.iTo), text: (/** @type {any} */ b) => fixed(Math.max(b.iFrom, b.iTo), 4) },
        { key: 'pLoss', label: 'Losses', unit: 'kW', num: true, value: (/** @type {any} */ b) => b.pLoss * 1000, text: (/** @type {any} */ b) => fixed(b.pLoss * 1000, 1) },
      ], r.branches, 'load-flow-branches', 'lf-branches', 'loading', -1);
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
    const notes = [...r.warnings, ...(r.deenergized.length ? [`De-energised: ${r.deenergized.map(id => this.nameOf(id)).join(', ')}`] : [])];
    this.mount([bar, notes.length ? h('div', { class: 'dock-toolbar', html: notes.map(n => `<span class="pill warn">${icon('warning', 13)}${esc(n)}</span>`).join('') }) : null], table);
  }

  renderShortCircuit() {
    const app = this.app, { result: r, ms } = /** @type {{ result: import('../engine/reports.js').ShortCircuitResult, ms: number }} */ (app.results.shortcircuit);
    const where = r.location ? `at ${this.nameOf(r.location)}` : 'at every busbar';
    const pill = h('span', { class: 'pill neutral', text: `${enumLabel('fault', r.fault)} · ${r.mode === 'max' ? 'maximum' : 'minimum'} · κ method ${r.kappaMethod}` });
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
        { key: 'ith', label: 'Ith', unit: 'kA', num: true, value: (/** @type {any} */ b) => b.ith, text: (/** @type {any} */ b) => fixed(b.ith, 3) },
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
    const pill = failed || viol ? h('span', { class: 'pill bad', html: `${icon('warning', 13)}${viol} outage${viol === 1 ? '' : 's'} with new violations${failed ? `, ${failed} not solvable` : ''}` }) : h('span', { class: 'pill ok', html: `${icon('check', 13)}Secure under every single outage` });
    const summary = h('div', { class: 'summary', html: `<span>Outages <b>${r.cases.length}</b></span><span>Loading limit <b>${r.limit} %</b></span><span>Base case max <b>${fixed(r.base.maxLoading, 1)} %</b></span><span>Time <b>${duration(ms)}</b></span>` });
    const bar = this.toolbar(pill, this.staleNote() ?? h('span'), summary);
    const describe = (/** @type {import('../engine/reports.js').ContingencyCase} */ c) => c.violations.map(v => v.kind === 'loading' ? `${this.nameOf(v.id)} ${fixed(v.value, 0)} %` : `${this.nameOf(v.id)} ${fixed(v.value, 3)} p.u.`).join(', ');
    const table = this.table([
      { key: 'name', label: 'Outage', value: (/** @type {any} */ c) => this.nameOf(c.id) },
      { key: 'cls', label: 'Type', value: (/** @type {any} */ c) => CLASSES[/** @type {import('../core/catalog.js').ElementClass} */ (c.cls)].label },
      { key: 'state', label: 'Result', value: (/** @type {any} */ c) => (!c.converged ? 'Not solvable' : c.violations.length ? `${c.violations.length} violation${c.violations.length === 1 ? '' : 's'}` : 'Secure'),
        cls: (/** @type {any} */ c) => (!c.converged || c.violations.some((/** @type {any} */ v) => !v.inBase) ? 'bad' : c.violations.length ? 'warn' : '') },
      { key: 'maxLoading', label: 'Max loading', unit: '%', num: true, value: (/** @type {any} */ c) => c.maxLoading, text: (/** @type {any} */ c) => fixed(c.maxLoading, 1), bar: (/** @type {any} */ c) => Number.isFinite(c.maxLoading) ? { pct: c.maxLoading, color: loadCss(c.maxLoading) } : null },
      { key: 'maxLoadingId', label: 'Most loaded', value: (/** @type {any} */ c) => (c.maxLoadingId ? this.nameOf(c.maxLoadingId) : '') },
      { key: 'minV', label: 'Min u', unit: 'p.u.', num: true, value: (/** @type {any} */ c) => c.minV, text: (/** @type {any} */ c) => fixed(c.minV, 4) },
      { key: 'maxV', label: 'Max u', unit: 'p.u.', num: true, value: (/** @type {any} */ c) => c.maxV, text: (/** @type {any} */ c) => fixed(c.maxV, 4) },
      { key: 'lost', label: 'Lost busbars', value: (/** @type {any} */ c) => c.lostBuses.map((/** @type {string} */ b) => this.nameOf(b)).join(', ') },
      { key: 'viol', label: 'Violations', value: (/** @type {any} */ c) => describe(c), title: (/** @type {any} */ c) => describe(c) },
    ], r.cases, 'contingency', 'n1', 'state', 1);
    this.mount([bar], table);
  }

  renderRms() {
    const app = this.app, { result: r, ms } = /** @type {{ result: import('../engine/reports.js').RmsResult, ms: number }} */ (app.results.rms);
    const pill = r.stable ? h('span', { class: 'pill ok', html: `${icon('check', 13)}${esc(r.message)}` }) : h('span', { class: 'pill bad', html: `${icon('warning', 13)}${esc(r.message)}` });
    const vars = /** @type {Array<[string, string]>} */ ([['delta', 'Rotor angle'], ['speed', 'Speed'], ['pe', 'Electrical power'], ['v', 'Busbar voltage']]);
    const seg = this.segmented(vars, this.rmsVar, v => { this.rmsVar = v; });
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
    let unit;
    if (this.rmsVar === 'v') { source = r.busIds.map((id, k) => ({ id, name: this.nameOf(id), data: r.voltages[k] })); unit = 'p.u.'; }
    else {
      const machines = r.machines.filter(m => this.rmsVar !== 'delta' || app.store.get(m.id)?.cls === 'gen' || r.angleReference === 'grid');
      source = machines.filter(m => this.rmsVar === 'delta' || app.store.get(m.id)?.cls === 'gen').map(m => ({ id: m.id, name: m.name, data: this.rmsVar === 'delta' ? m.delta : this.rmsVar === 'speed' ? m.speed : m.pe }));
      unit = this.rmsVar === 'delta' ? '°' : this.rmsVar === 'speed' ? 'Hz' : 'MW';
    }
    side.append(h('h4', { text: this.rmsVar === 'v' ? 'Busbars' : 'Machines' }));
    source.forEach((s, i) => {
      const cb = h('input', { type: 'checkbox' });
      cb.checked = !this.rmsHidden.has(s.id);
      cb.addEventListener('change', () => { if (cb.checked) this.rmsHidden.delete(s.id); else this.rmsHidden.add(s.id); this.renderRms(); });
      side.append(h('label', {}, cb, h('span', { class: 'sw', style: `background:${seriesColor(i, dark)}` }), h('span', { text: s.name })));
    });
    side.append(h('h4', { text: 'Events' }));
    for (const e of r.events) side.append(h('div', { style: 'padding:3px 12px;color:var(--text-2)', html: `<b style="font-variant-numeric:tabular-nums">${fixed(e.t, 3)} s</b> ${esc(e.note)}` }));
    this.plot = new Plot(plotHost);
    this.plot.onCursor = i => app.setRmsIndex(i);
    this.plot.set({
      t: r.t, unit, label: /** @type {Record<string, string>} */ ({ delta: 'Rotor angle', speed: 'Speed', pe: 'Electrical power', v: 'Voltage' })[this.rmsVar], events: r.events.filter(e => e.applied).map(e => e.t), cursor: app.rmsIndex < 0 ? r.t.length - 1 : app.rmsIndex,
      series: source.map((s, i) => ({ name: s.name, color: seriesColor(i, dark), data: s.data })).filter((_, i) => !this.rmsHidden.has(source[i].id)),
    });
    const rows = source.map(s => ({ id: s.id, name: s.name, min: minOf(s.data), max: maxOf(s.data), end: s.data[s.data.length - 1] }));
    this.current = { name: `stability-${this.rmsVar}`, rows: [...r.t].map((t, i) => ({ t, ...Object.fromEntries(source.map(s => [s.name, s.data[i]])) })),
      columns: [{ key: 't', label: 'Time', unit: 's', value: (/** @type {any} */ x) => x.t }, ...source.map(s => ({ key: s.name, label: s.name, unit, value: (/** @type {any} */ x) => x[s.name] }))] };
    void rows;
  }

  /** CSV of the table on screen. */
  csv() {
    if (!this.current) return null;
    return { name: this.current.name, text: toCSV(this.current.columns, this.current.rows) };
  }
}
