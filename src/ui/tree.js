/** The model tree: the network grouped by element class, with a filter, keyboard navigation and selection sync.
 *
 * A tree of more than VIRTUAL rows is virtual: it keeps a description of every row and puts only the rows in view (and
 * a margin) into the page, so a network of hundreds of thousands of elements scrolls as lightly as a small one. Rows
 * are ROW pixels tall (`.tree-row` in style.css); spacers above and below stand for the rest. Smaller trees render
 * whole. */

import { h, esc } from './dom.js';
import { icon } from './icons.js';
import { CLASSES, CLASS_ORDER } from '../core/catalog.js';

/** Icon for each element class. */
export const CLASS_ICON = /** @type {Record<string, string>} */ ({ bus: 'bus', line: 'line', trafo: 'trafo', gen: 'gen', extgrid: 'extgrid', load: 'load', shunt: 'shunt' });

/** Row height, px (`.tree-row` height in style.css), rows above which the tree is virtual, and rows drawn beyond the
 * visible ones on each side. */
const ROW = 26, VIRTUAL = 2000, OVERSCAN = 30;

/** @typedef {{ depth: number, label: string, iconName: string, meta: string, kind: 'root' | 'group' | 'element', cls?: string, id?: string, expanded?: boolean, off?: boolean, selected?: boolean, status?: string }} RowSpec */

export class ModelTree {
  /** @param {HTMLElement} host @param {import('../app.js').App} app */
  constructor(host, app) {
    this.app = app;
    /** @type {Set<string>} */
    this.collapsed = new Set(['shunt']);
    this.filter = '';
    const search = h('input', { class: 'input', type: 'search', placeholder: 'Filter elements', 'aria-label': 'Filter elements', spellcheck: 'false' });
    search.addEventListener('input', () => { this.filter = search.value.trim().toLowerCase(); this.render(); });
    search.addEventListener('keydown', e => { if (e.key === 'ArrowDown') { e.preventDefault(); this.focusRow(0); } });
    this.search = search;
    this.list = h('ul', { class: 'tree', role: 'tree', 'aria-label': 'Network elements', 'aria-multiselectable': 'true' });
    /** @type {RowSpec[]} */
    this.rows = [];
    /** Index of the row that takes focus with Tab. */
    this.current = 0;
    this.body = h('div', { class: 'panel-body' }, this.list);
    let pending = false;
    this.body.addEventListener('scroll', () => { if (pending || this.rows.length <= VIRTUAL) return; pending = true; requestAnimationFrame(() => { pending = false; this.paint(); }); });
    host.append(
      h('div', { class: 'panel-header' }, h('span', { class: 'title', text: 'Model' }),
        h('button', { type: 'button', class: 'icon-btn sm', title: 'Study case settings', 'aria-label': 'Study case settings', 'data-cmd': 'study.settings', html: icon('settings', 16) }),
        h('button', { type: 'button', class: 'icon-btn sm', title: 'Hide panel', 'aria-label': 'Hide model panel', 'data-cmd': 'view.tree', html: icon('panelLeft', 16) })),
      h('div', { class: 'tree-search' }, search),
      this.body);
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
    /** @type {RowSpec[]} */
    const rows = [{ depth: 0, label: doc.name || 'Untitled network', iconName: 'database', meta: `${doc.elements.length}`, kind: 'root' }];
    for (const cls of CLASS_ORDER) {
      const items = doc.elements.filter(e => e.cls === cls && (!f || `${e.name} ${e.id}`.toLowerCase().includes(f)));
      if (f && !items.length) continue;
      const open = f ? true : !this.collapsed.has(cls);
      rows.push({ depth: 1, label: CLASSES[cls].plural, iconName: CLASS_ICON[cls], meta: String(items.length), kind: 'group', cls, expanded: open });
      if (!open) continue;
      for (const el of items) {
        rows.push({ depth: 2, label: el.name || el.id, iconName: CLASS_ICON[cls], meta: el.id, kind: 'element', id: el.id,
          off: el.inService === false, selected: app.selection.has(el.id), status: status.get(el.id) });
      }
    }
    // Keep the focused row's place by its key when the rows change.
    const focused = /** @type {HTMLElement | null} */ (document.activeElement)?.closest?.('.tree-row');
    const focusKey = focused && this.list.contains(focused) ? /** @type {HTMLElement} */ (focused).dataset.key : '';
    this.rows = rows;
    const selected = rows.findIndex(r => r.selected);
    this.current = Math.min(rows.length - 1, Math.max(0, selected >= 0 ? selected : this.current));
    this.paint();
    if (focusKey) {
      const k = rows.findIndex(r => keyOf(r) === focusKey);
      if (k >= 0) this.focusRow(k);
    }
  }

  /** Puts the rows in view into the page. */
  paint() {
    const n = this.rows.length;
    const top = this.body.scrollTop, height = this.body.clientHeight || 600;
    const whole = n <= VIRTUAL;
    const from = whole ? 0 : Math.max(0, Math.floor(top / ROW) - OVERSCAN), to = whole ? n : Math.min(n, Math.ceil((top + height) / ROW) + OVERSCAN);
    const spacer = (/** @type {number} */ rows) => h('li', { class: 'tree-spacer', role: 'none', style: `height:${rows * ROW}px` });
    /** @type {HTMLElement[]} */
    const items = [spacer(from)];
    for (let k = from; k < to; k++) items.push(this.row(this.rows[k], k));
    items.push(spacer(n - to));
    if (this.filter && n === 1) items.push(h('li', { class: 'tree-empty', text: `Nothing matches “${this.filter}”.` }));
    const focusedKey = /** @type {HTMLElement | null} */ (document.activeElement)?.closest?.('.tree-row')?.getAttribute('data-key') ?? '';
    this.list.replaceChildren();
    for (const li of items) this.list.append(li);
    if (focusedKey) /** @type {HTMLElement | null} */ (this.list.querySelector(`[data-key="${CSS.escape(focusedKey)}"]`))?.focus({ preventScroll: true });
  }

  /** Focuses row `k`, scrolling it into view. @param {number} k */
  focusRow(k) {
    if (!this.rows.length) return;
    this.current = Math.max(0, Math.min(this.rows.length - 1, k));
    const top = this.current * ROW, view = this.body.clientHeight || 600;
    if (top < this.body.scrollTop) this.body.scrollTop = top;
    else if (top + ROW > this.body.scrollTop + view) this.body.scrollTop = top + ROW - view;
    this.paint();
    /** @type {HTMLElement | null} */ (this.list.querySelector(`[data-index="${this.current}"]`))?.focus({ preventScroll: true });
  }

  /** @param {RowSpec} r @param {number} k */
  row(r, k) {
    const li = h('li', {
      class: `tree-row${r.off ? ' off' : ''}`, role: 'treeitem', tabindex: k === this.current ? '0' : '-1', 'data-key': keyOf(r), 'data-index': String(k),
      'aria-level': String(r.depth + 1), 'aria-setsize': String(this.rows.length), 'aria-posinset': String(k + 1),
      'aria-selected': r.kind === 'element' ? String(!!r.selected) : undefined, 'aria-expanded': r.kind === 'group' ? String(!!r.expanded) : undefined,
      style: `--depth:${r.depth}`, title: r.kind === 'element' && r.off ? 'Out of service' : undefined,
    });
    if (r.id) li.dataset.id = r.id;
    if (r.cls) li.dataset.cls = r.cls;
    li.innerHTML = `${r.kind === 'group' ? icon('chevronDown', 14).replace('class="icon"', 'class="icon twisty"') : '<span style="width:14px;flex:none"></span>'}`
      + `${icon(r.iconName, 16).replace('class="icon"', 'class="icon glyph"')}<span class="label">${esc(r.label)}</span>`
      + (r.status ? `<span class="status" style="background:${r.status}"></span>` : '')
      + `<span class="meta" title="${esc(r.meta)}">${esc(r.meta)}</span>`;
    return li;
  }

  /** @param {MouseEvent} e */
  onClick(e) {
    const row = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('.tree-row'));
    if (!row) return;
    row.focus();
    this.current = Number(row.dataset.index);
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
    const cur = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('.tree-row'));
    if (!cur) return;
    const i = Number(cur.dataset.index), page = Math.max(1, Math.floor((this.body.clientHeight || 600) / ROW) - 1);
    if (e.key === 'ArrowDown') { e.preventDefault(); this.focusRow(i + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (i === 0) this.search.focus(); else this.focusRow(i - 1); }
    else if (e.key === 'PageDown') { e.preventDefault(); this.focusRow(i + page); }
    else if (e.key === 'PageUp') { e.preventDefault(); this.focusRow(i - page); }
    else if (e.key === 'Home') { e.preventDefault(); this.focusRow(0); }
    else if (e.key === 'End') { e.preventDefault(); this.focusRow(this.rows.length - 1); }
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

/** A row's stable key: its element, class group or the root. @param {RowSpec} r */
function keyOf(r) {
  return r.kind === 'element' ? `e:${r.id}` : r.kind === 'group' ? `g:${r.cls}` : 'root';
}
