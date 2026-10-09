/** The model tree: the network grouped by element class, with a filter, keyboard navigation and selection sync. */

import { h, esc } from './dom.js';
import { icon } from './icons.js';
import { CLASSES, CLASS_ORDER } from '../core/catalog.js';

/** Icon for each element class. */
export const CLASS_ICON = /** @type {Record<string, string>} */ ({ bus: 'bus', line: 'line', trafo: 'trafo', gen: 'gen', extgrid: 'extgrid', load: 'load', shunt: 'shunt' });

export class ModelTree {
  /** @param {HTMLElement} host @param {import('../app.js').App} app */
  constructor(host, app) {
    this.app = app;
    /** @type {Set<string>} */
    this.collapsed = new Set(['shunt']);
    this.filter = '';
    const search = h('input', { class: 'input', type: 'search', placeholder: 'Filter elements', 'aria-label': 'Filter elements', spellcheck: 'false' });
    search.addEventListener('input', () => { this.filter = search.value.trim().toLowerCase(); this.render(); });
    search.addEventListener('keydown', e => { if (e.key === 'ArrowDown') { e.preventDefault(); /** @type {HTMLElement | null} */ (this.list.querySelector('.tree-row'))?.focus(); } });
    this.search = search;
    this.list = h('ul', { class: 'tree', role: 'tree', 'aria-label': 'Network elements', 'aria-multiselectable': 'true' });
    host.append(
      h('div', { class: 'panel-header' }, h('span', { class: 'title', text: 'Model' }),
        h('button', { type: 'button', class: 'icon-btn sm', title: 'Study case settings', 'aria-label': 'Study case settings', 'data-cmd': 'study.settings', html: icon('settings', 16) }),
        h('button', { type: 'button', class: 'icon-btn sm', title: 'Hide panel', 'aria-label': 'Hide model panel', 'data-cmd': 'view.tree', html: icon('panelLeft', 16) })),
      h('div', { class: 'tree-search' }, search),
      h('div', { class: 'panel-body' }, this.list));
    this.list.addEventListener('click', e => this.onClick(e));
    this.list.addEventListener('dblclick', e => {
      const row = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-id]'));
      if (row) { app.viewport.reveal([/** @type {string} */ (row.dataset.id)]); app.focusInspector(); }
    });
    this.list.addEventListener('keydown', e => this.onKey(e));
    this.list.addEventListener('contextmenu', e => {
      const row = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-id]'));
      if (!row) return;
      e.preventDefault();
      const id = /** @type {string} */ (row.dataset.id);
      if (!app.selection.has(id)) app.setSelection([id]);
      app.contextMenu(e.clientX, e.clientY, id, null);
    });
  }

  render() {
    const app = this.app, doc = app.store.doc, f = this.filter;
    const status = app.elementStatus();
    const rows = [];
    rows.push(this.row({ depth: 0, label: doc.name || 'Untitled network', iconName: 'database', meta: `${doc.elements.length}`, kind: 'root' }));
    for (const cls of CLASS_ORDER) {
      const items = doc.elements.filter(e => e.cls === cls && (!f || `${e.name} ${e.id}`.toLowerCase().includes(f)));
      if (f && !items.length) continue;
      const open = f ? true : !this.collapsed.has(cls);
      rows.push(this.row({ depth: 1, label: CLASSES[cls].plural, iconName: CLASS_ICON[cls], meta: String(items.length), kind: 'group', cls, expanded: open }));
      if (!open) continue;
      for (const el of items) {
        rows.push(this.row({ depth: 2, label: el.name || el.id, iconName: CLASS_ICON[cls], meta: el.id, kind: 'element', id: el.id,
          off: el.inService === false, selected: app.selection.has(el.id), status: status.get(el.id) }));
      }
    }
    if (f && rows.length === 1) rows.push(h('li', { class: 'tree-empty', text: `Nothing matches “${f}”.` }));
    const focused = /** @type {HTMLElement | null} */ (document.activeElement)?.closest?.('.tree-row');
    const focusKey = focused ? /** @type {HTMLElement} */ (focused).dataset.key : '';
    this.list.replaceChildren(...rows);
    const first = /** @type {HTMLElement | null} */ (this.list.querySelector('[aria-selected="true"]') ?? this.list.querySelector('.tree-row'));
    if (first) first.tabIndex = 0;
    if (focusKey) /** @type {HTMLElement | null} */ (this.list.querySelector(`[data-key="${focusKey}"]`))?.focus();
  }

  /** @param {{ depth: number, label: string, iconName: string, meta: string, kind: 'root' | 'group' | 'element', cls?: string, id?: string, expanded?: boolean, off?: boolean, selected?: boolean, status?: string }} r */
  row(r) {
    const key = r.kind === 'element' ? `e:${r.id}` : r.kind === 'group' ? `g:${r.cls}` : 'root';
    const li = h('li', {
      class: `tree-row${r.off ? ' off' : ''}`, role: 'treeitem', tabindex: '-1', 'data-key': key, 'aria-level': String(r.depth + 1),
      'aria-selected': r.kind === 'element' ? String(!!r.selected) : undefined, 'aria-expanded': r.kind === 'group' ? String(!!r.expanded) : undefined,
      style: `--depth:${r.depth}`, title: r.kind === 'element' && r.off ? 'Out of service' : undefined,
    });
    if (r.id) li.dataset.id = r.id;
    if (r.cls) li.dataset.cls = r.cls;
    li.innerHTML = `${r.kind === 'group' ? icon('chevronDown', 14).replace('class="icon"', 'class="icon twisty"') : '<span style="width:14px;flex:none"></span>'}`
      + `${icon(r.iconName, 16).replace('class="icon"', 'class="icon glyph"')}<span class="label">${esc(r.label)}</span>`
      + (r.status ? `<span class="status" style="background:${r.status}"></span>` : '')
      + `<span class="meta">${esc(r.meta)}</span>`;
    return li;
  }

  /** @param {MouseEvent} e */
  onClick(e) {
    const row = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('.tree-row'));
    if (!row) return;
    row.focus();
    if (row.dataset.cls && !row.dataset.id) { this.toggle(row.dataset.cls); return; }
    if (row.dataset.key === 'root') { this.app.setSelection([]); return; }
    const id = /** @type {string} */ (row.dataset.id);
    if (e.shiftKey || e.metaKey || e.ctrlKey) this.app.toggleSelection(id);
    else { this.app.setSelection([id]); this.app.viewport.reveal([id]); }
  }

  /** @param {string} cls */
  toggle(cls) {
    if (this.collapsed.has(cls)) this.collapsed.delete(cls); else this.collapsed.add(cls);
    this.render();
  }

  /** @param {KeyboardEvent} e */
  onKey(e) {
    const rows = /** @type {HTMLElement[]} */ ([...this.list.querySelectorAll('.tree-row')]);
    const cur = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('.tree-row'));
    if (!cur) return;
    const i = rows.indexOf(cur);
    const go = (/** @type {number} */ j) => { const r = rows[Math.max(0, Math.min(rows.length - 1, j))]; for (const x of rows) x.tabIndex = -1; r.tabIndex = 0; r.focus(); };
    if (e.key === 'ArrowDown') { e.preventDefault(); go(i + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (i === 0) this.search.focus(); else go(i - 1); }
    else if (e.key === 'Home') { e.preventDefault(); go(0); }
    else if (e.key === 'End') { e.preventDefault(); go(rows.length - 1); }
    else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && cur.dataset.cls && !cur.dataset.id) {
      e.preventDefault();
      const open = !this.collapsed.has(cur.dataset.cls);
      if ((e.key === 'ArrowLeft') === open) this.toggle(cur.dataset.cls);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (cur.dataset.id) { this.app.setSelection([cur.dataset.id]); this.app.viewport.reveal([cur.dataset.id]); if (e.key === 'Enter') this.app.focusInspector(); }
      else if (cur.dataset.cls) this.toggle(cur.dataset.cls);
    }
  }
}
