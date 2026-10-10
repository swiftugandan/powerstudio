/** The ribbon: tabs of grouped command buttons. Buttons carry only a data-cmd attribute; one delegated listener runs
 * them, and enabled and pressed states are refreshed from the command registry. */

import { h, esc } from './dom.js';
import { icon } from './icons.js';
import { showKey } from './keys.js';

/** @typedef {{ cmd: string, size: 'large' } | { stack: string[] }} Item
 * @typedef {{ label: string, items: Item[] }} Group
 * @typedef {{ id: string, label: string, file?: boolean, groups?: Group[] }} Tab */

/** @type {Tab[]} */
export const TABS = [
  { id: 'file', label: 'File', file: true },
  { id: 'home', label: 'Home', groups: [
    { label: 'History', items: [{ cmd: 'edit.undo', size: 'large' }, { cmd: 'edit.redo', size: 'large' }] },
    { label: 'Clipboard', items: [{ cmd: 'edit.paste', size: 'large' }, { stack: ['edit.cut', 'edit.copy', 'edit.duplicate'] }] },
    { label: 'Edit', items: [{ cmd: 'edit.delete', size: 'large' }, { stack: ['edit.toggleService', 'edit.selectAll', 'layout.arrange'] }] },
    { label: 'Tools', items: [{ cmd: 'tool.select', size: 'large' }, { cmd: 'tool.pan', size: 'large' }] },
    { label: 'Calculate', items: [{ cmd: 'calc.loadflow', size: 'large' }, { cmd: 'calc.shortcircuit', size: 'large' }, { cmd: 'calc.contingency', size: 'large' }, { cmd: 'calc.rms', size: 'large' }] },
    { label: 'Navigate', items: [{ cmd: 'view.fit', size: 'large' }, { stack: ['view.zoomIn', 'view.zoomOut', 'palette.open'] }] },
  ] },
  { id: 'insert', label: 'Insert', groups: [
    { label: 'Nodes', items: [{ cmd: 'tool.bus', size: 'large' }] },
    { label: 'Branches', items: [{ cmd: 'tool.line', size: 'large' }, { cmd: 'tool.trafo', size: 'large' }] },
    { label: 'Sources', items: [{ cmd: 'tool.gen', size: 'large' }, { cmd: 'tool.extgrid', size: 'large' }] },
    { label: 'Consumers', items: [{ cmd: 'tool.load', size: 'large' }, { cmd: 'tool.shunt', size: 'large' }] },
    { label: 'Networks', items: [{ cmd: 'file.import', size: 'large' }, { cmd: 'layout.arrange', size: 'large' }] },
  ] },
  { id: 'calculate', label: 'Calculate', groups: [
    { label: 'Steady state', items: [{ cmd: 'calc.loadflow', size: 'large' }, { stack: ['calc.autoLoadFlow', 'calc.qlimits', 'calc.dcStart'] }] },
    { label: 'Faults', items: [{ cmd: 'calc.shortcircuit', size: 'large' }, { stack: ['sc.fault3ph', 'sc.fault2ph', 'sc.fault1ph'] }, { stack: ['sc.max', 'sc.min', 'sc.allBuses'] }] },
    { label: 'Security', items: [{ cmd: 'calc.contingency', size: 'large' }, { stack: ['contingency.edit', 'contingency.gens', 'contingency.screening'] }] },
    { label: 'Dynamics', items: [{ cmd: 'calc.rms', size: 'large' }, { stack: ['rms.events', 'calc.cancel'] }] },
    { label: 'Study case', items: [{ cmd: 'study.settings', size: 'large' }, { stack: ['results.clear', 'results.csv'] }] },
  ] },
  { id: 'view', label: 'View', groups: [
    { label: 'Navigate', items: [{ cmd: 'view.fit', size: 'large' }, { stack: ['view.zoomIn', 'view.zoomOut'] }] },
    { label: 'Annotations', items: [{ stack: ['view.boxes', 'view.names', 'view.branchNames'] }] },
    { label: 'Colouring', items: [{ stack: ['view.colourResults', 'view.colourVoltage'] }] },
    { label: 'Panels', items: [{ stack: ['view.tree', 'view.inspector', 'view.dock'] }] },
    { label: 'Theme', items: [{ stack: ['view.themeSystem', 'view.themeLight', 'view.themeDark'] }] },
    { label: 'Rendering', items: [{ stack: ['view.rendererAuto', 'view.rendererCanvas'] }] },
  ] },
  { id: 'help', label: 'Help', groups: [
    { label: 'Learn', items: [{ cmd: 'help.shortcuts', size: 'large' }, { cmd: 'palette.open', size: 'large' }] },
    { label: 'Samples', items: [{ cmd: 'sample.ieee14', size: 'large' }, { cmd: 'sample.riverside', size: 'large' }] },
    { label: 'About', items: [{ cmd: 'help.about', size: 'large' }] },
  ] },
];

export class Ribbon {
  /** @param {HTMLElement} host @param {import('./commands.js').Commands} commands @param {(tab: string) => void} onTab */
  constructor(host, commands, onTab) {
    this.host = host;
    this.commands = commands;
    this.onTab = onTab;
    this.tab = 'home';
    this.tabs = h('div', { class: 'ribbon-tabs', role: 'tablist', 'aria-label': 'Ribbon' });
    this.panel = h('div', { class: 'ribbon-panel', role: 'tabpanel' });
    host.append(this.tabs, this.panel);
    for (const t of TABS) {
      this.tabs.append(h('button', { type: 'button', role: 'tab', class: `ribbon-tab${t.file ? ' file-tab' : ''}`, id: `tab-${t.id}`, 'data-tab': t.id, 'aria-selected': 'false', text: t.label }));
    }
    this.tabs.addEventListener('click', e => {
      const b = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-tab]'));
      if (b) this.select(/** @type {string} */ (b.dataset.tab));
    });
    this.tabs.addEventListener('keydown', e => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const ids = TABS.filter(t => !t.file).map(t => t.id), i = ids.indexOf(this.tab);
      const next = ids[(i + (e.key === 'ArrowRight' ? 1 : ids.length - 1)) % ids.length];
      this.select(next);
      /** @type {HTMLElement} */ (this.tabs.querySelector(`[data-tab="${next}"]`)).focus();
    });
    commands.listeners.add(() => this.refresh());
  }

  /** @param {string} id */
  select(id) {
    const tab = TABS.find(t => t.id === id);
    if (!tab) return;
    if (tab.file) { this.onTab('file'); return; }
    this.tab = id;
    for (const b of this.tabs.querySelectorAll('[data-tab]')) b.setAttribute('aria-selected', String(/** @type {HTMLElement} */ (b).dataset.tab === id));
    this.panel.setAttribute('aria-labelledby', `tab-${id}`);
    this.panel.replaceChildren(...(tab.groups ?? []).map(g => this.group(g)));
    this.refresh();
    this.onTab(id);
  }

  /** @param {Group} g */
  group(g) {
    const items = h('div', { class: 'ribbon-group-items' });
    for (const it of g.items) {
      if ('cmd' in it) items.append(this.button(it.cmd, true));
      else items.append(h('div', { class: 'rb-stack' }, ...it.stack.map(c => this.button(c, false))));
    }
    return h('div', { class: 'ribbon-group', role: 'group', 'aria-label': g.label }, items, h('div', { class: 'ribbon-group-label', text: g.label }));
  }

  /** @param {string} id @param {boolean} large */
  button(id, large) {
    const c = this.commands.get(id);
    if (!c) throw new Error(`Ribbon refers to unknown command ${id}`);
    const keys = c.keys?.[0] ? ` (${showKey(c.keys[0]).join(' ')})` : '';
    return h('button', {
      type: 'button', class: large ? 'rb-large' : 'rb-small', 'data-cmd': id, title: `${c.hint ?? c.label}${keys}`,
      html: `${icon(c.icon ?? 'plus', large ? 20 : 15)}<span>${esc(c.label)}</span>`,
    });
  }

  refresh() {
    for (const b of this.panel.querySelectorAll('[data-cmd]')) {
      const el = /** @type {HTMLButtonElement} */ (b), c = this.commands.get(/** @type {string} */ (el.dataset.cmd));
      if (!c) continue;
      el.disabled = !(c.enabled?.() ?? true);
      if (c.pressed) el.setAttribute('aria-pressed', String(c.pressed()));
    }
  }
}
