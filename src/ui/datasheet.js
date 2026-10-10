/** The data manager: every element of one class as a spreadsheet, the way engineers edit national models.
 *
 * Columns come from the catalogue's field specs (`src/core/catalog.js`), as in the inspector, and every change goes
 * through `store.transact` with the same validation, so undo, autosave and the calculation workers follow. Rows are
 * filtered by text and sorted by any column, and the table is virtual: only the rows in view are in the page.
 *
 * Editing: double-click a cell, press Enter or F2, or start typing; Enter or Tab commits, Escape cancels. With several
 * rows selected (Shift or Ctrl/Cmd and click, Shift and arrows, Ctrl/Cmd+A), Enter, F2 or typing edits that column of
 * all of them. Copy (Ctrl or Cmd+C) gives the selected rows, or the active cell, as
 * tab-separated text; paste (Ctrl or Cmd+V) fills cells from the active one, all or nothing. Selecting rows selects
 * the elements on the diagram. */

import { h } from './dom.js';
import { CLASSES, CLASS_ORDER } from '../core/catalog.js';
import { enumLabel } from './fields.js';
import { editable, parseNumber } from './format.js';

/** @typedef {import('../core/catalog.js').Element} Element @typedef {import('../core/catalog.js').FieldSpec} FieldSpec
 * @typedef {import('../core/catalog.js').ElementClass} ElementClass */

/** Rows drawn beyond the visible ones on each side. */
const OVERSCAN = 30;
const collator = new Intl.Collator(undefined, { numeric: true });
/** The identifier column: shown first, never edited. @type {FieldSpec} */
const ID = { key: 'id', label: 'Identifier', type: 'string', group: 'basic', default: '' };

export class DataSheet {
  /** @param {import('../app.js').App} app */
  constructor(app) {
    this.app = app;
    /** @type {ElementClass} */
    this.cls = 'bus';
    this.filter = '';
    this.onlySelected = false;
    /** @type {{ key: string, dir: 1 | -1 }} */
    this.sort = { key: 'id', dir: 1 };
    /** The active cell, by row id and column key. */
    this.active = { id: '', key: 'name' };
    /** The row a shift-click extends a range from. */
    this.anchor = '';
    /** @type {Element[]} rows in view order */
    this.rows = [];
    /** @type {FieldSpec[]} */
    this.columns = [];
    /** @type {HTMLTableElement | null} */
    this.table = null;
    /** @type {HTMLElement | null} */
    this.scroller = null;
    /** @type {(() => void) | null} */
    this.paint = null;
    /** The cell being edited. @type {{ id: string, key: string, input: HTMLInputElement | HTMLSelectElement } | null} */
    this.editing = null;
    /** @type {HTMLElement | null} */
    this.countLabel = null;
    /** @type {HTMLElement | null} */
    this.sheet = null;
    /** Column widths and row height of each class's sheet, measured on its first paint and kept, so columns do not
     * move as rows are edited, filtered or scrolled. @type {Map<string, { widths: number[], rowHeight: number }>} */
    this.measured = new Map();
    // The clipboard events go to the page when nothing is selected in it, so they are taken there while the sheet has
    // the focus.
    const mine = () => !!this.table && document.activeElement === this.table;
    document.addEventListener('copy', e => { if (mine()) this.onCopy(e); });
    document.addEventListener('paste', e => { if (mine()) this.onPaste(e); });
  }

  /** The selection changed on the diagram or in the tree. */
  selectionChanged() { if (this.onlySelected) this.refresh(); else this.restyle(); }

  /** Marks the selected rows and the active cell on the rows in the page, in place: replacing the cells between the
   * two clicks of a double-click would lose it. */
  restyle() {
    const body = this.table?.tBodies[0];
    if (!body) return;
    const sel = this.app.selection;
    for (const tr of /** @type {NodeListOf<HTMLElement>} */ (body.querySelectorAll('tr[data-id]'))) {
      const id = /** @type {string} */ (tr.dataset.id);
      tr.setAttribute('aria-selected', String(sel.has(id)));
      for (const td of /** @type {NodeListOf<HTMLElement>} */ (tr.querySelectorAll('td[data-key]'))) {
        td.classList.toggle('active', id === this.active.id && td.dataset.key === this.active.key);
      }
    }
  }

  /** The toolbar and the sheet, for the dock to mount; `scroller` is the element that scrolls them.
   * @param {HTMLElement} scroller @returns {{ toolbar: HTMLElement, sheet: HTMLElement }} */
  render(scroller) {
    this.scroller = scroller;
    const doc = this.app.store.doc;
    const counts = new Map(CLASS_ORDER.map(c => [c, 0]));
    for (const el of doc.elements) counts.set(el.cls, (counts.get(el.cls) ?? 0) + 1);
    const cls = /** @type {HTMLSelectElement} */ (h('select', { class: 'input', 'aria-label': 'Element class' },
      ...CLASS_ORDER.map(c => h('option', { value: c, text: `${CLASSES[c].plural} (${(counts.get(c) ?? 0).toLocaleString('en-GB')})` }))));
    cls.value = this.cls;
    cls.addEventListener('change', () => { this.cls = /** @type {ElementClass} */ (cls.value); this.sort = { key: 'id', dir: 1 }; this.app.dock.render(); });
    const filter = /** @type {HTMLInputElement} */ (h('input', { class: 'input sheet-filter', type: 'search', placeholder: 'Filter by name or identifier', 'aria-label': 'Filter rows', value: this.filter }));
    let timer = 0;
    filter.addEventListener('input', () => { clearTimeout(timer); timer = window.setTimeout(() => { this.filter = filter.value; this.refresh(); }, 150); });
    const only = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox', class: 'check', id: 'sheet-only' }));
    only.checked = this.onlySelected;
    only.addEventListener('change', () => { this.onlySelected = only.checked; this.refresh(); });
    this.countLabel = h('span', { class: 'sheet-count' });
    const toolbar = h('div', { class: 'dock-toolbar sheet-toolbar' }, cls, filter,
      h('label', { class: 'sheet-only', for: 'sheet-only' }, only, h('span', { text: 'Selected on the diagram' })), this.countLabel,
      h('span', { class: 'grow' }), h('span', { class: 'sheet-hint', text: 'Double-click or type to edit · select rows, then type, to edit them together · paste from a spreadsheet' }));
    this.columns = [ID, ...CLASSES[this.cls].fields.filter(f => f.group !== 'graphic' && f.key !== 'id')];
    const sheet = h('div', { class: 'sheet-wrap' });
    this.sheet = sheet;
    this.refresh();
    return { toolbar, sheet };
  }

  /** Recomputes the rows (after an edit, a filter or a sort) and repaints, keeping the scroll position. */
  refresh() {
    const sel = this.app.selection, f = this.filter.trim().toLowerCase();
    let rows = this.app.store.doc.elements.filter(e => e.cls === this.cls);
    if (this.onlySelected) rows = rows.filter(e => sel.has(e.id));
    if (f) rows = rows.filter(e => e.id.toLowerCase().includes(f) || String(e.name).toLowerCase().includes(f));
    const col = this.columns.find(c => c.key === this.sort.key) ?? ID;
    const keys = rows.map(r => sortKey(col, r));
    const order = keys.map((_, i) => i).sort((a, b) => {
      const x = keys[a], y = keys[b];
      return (typeof x === 'number' && typeof y === 'number' ? x - y : collator.compare(String(x), String(y))) * this.sort.dir;
    });
    this.rows = order.map(i => rows[i]);
    if (this.countLabel) this.countLabel.textContent = `${this.rows.length.toLocaleString('en-GB')} row${this.rows.length === 1 ? '' : 's'}`;
    this.build();
  }

  /** Builds the table and its virtual body. */
  build() {
    const host = this.sheet, scroller = this.scroller;
    if (!host || !scroller) return;
    const cols = this.columns;
    const head = h('tr', {}, ...cols.map(c => h('th', {
      scope: 'col', 'data-key': c.key, tabindex: '-1', class: `${isNumeric(c) ? 'num' : ''}${c === ID ? ' sticky' : ''}`,
      title: c.help, 'aria-sort': c.key === this.sort.key ? (this.sort.dir === 1 ? 'ascending' : 'descending') : undefined,
    }, h('span', { text: c.label }), c.unit ? h('span', { class: 'unit', text: c.unit }) : null,
    c.key === this.sort.key ? h('span', { class: 'arrow', text: this.sort.dir === 1 ? '▲' : '▼' }) : null)));
    const body = h('tbody');
    const hadFocus = !!this.table && document.activeElement === this.table;
    const table = /** @type {HTMLTableElement} */ (h('table', { class: 'grid sheet', role: 'grid', tabindex: '0', 'aria-label': `${CLASSES[this.cls].plural}`, 'aria-rowcount': String(this.rows.length + 1) },
      h('thead', {}, head), body));
    this.table = table;
    const known = this.measured.get(this.cls);
    let rowHeight = known?.rowHeight ?? 27, fixed = !!known;
    if (known) {
      table.prepend(h('colgroup', {}, ...known.widths.map(w => h('col', { style: `width:${w}px` }))));
      table.classList.add('fixed');
    }
    const spacer = (/** @type {number} */ n) => h('tr', { class: 'grid-spacer', 'aria-hidden': 'true' }, h('td', { colspan: String(cols.length), style: `height:${n * rowHeight}px` }));
    const paint = () => {
      if (!table.isConnected) { scroller.removeEventListener('scroll', onScroll); return; }
      const top = Math.max(0, scroller.scrollTop - body.offsetTop), view = scroller.clientHeight || 400;
      const from = Math.max(0, Math.floor(top / rowHeight) - OVERSCAN), to = Math.min(this.rows.length, Math.ceil((top + view) / rowHeight) + OVERSCAN);
      body.replaceChildren(spacer(from));
      for (let k = from; k < to; k++) body.append(this.rowOf(this.rows[k], k));
      body.append(spacer(this.rows.length - to));
      if (!fixed) {
        const first = /** @type {HTMLElement | null} */ (body.querySelector('tr[data-id]'));
        if (first?.offsetHeight) {
          fixed = true;
          rowHeight = first.offsetHeight;
          const widths = [...head.children].map(th => Math.max(/** @type {HTMLElement} */ (th).getBoundingClientRect().width, 64));
          this.measured.set(this.cls, { widths, rowHeight });
          table.prepend(h('colgroup', {}, ...widths.map(w => h('col', { style: `width:${w}px` }))));
          table.classList.add('fixed');
          paint();
        }
      }
    };
    let pending = false;
    const onScroll = () => { if (pending) return; pending = true; requestAnimationFrame(() => { pending = false; paint(); }); };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    this.paint = paint;
    for (let k = 0; k < Math.min(this.rows.length, 60); k++) body.append(this.rowOf(this.rows[k], k));
    body.append(spacer(this.rows.length - Math.min(this.rows.length, 60)));
    head.addEventListener('click', e => {
      const th = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('th'));
      const key = th?.dataset.key;
      if (!key) return;
      this.sort = { key, dir: this.sort.key === key ? /** @type {1 | -1} */ (-this.sort.dir) : 1 };
      this.refresh();
    });
    body.addEventListener('mousedown', e => this.onPointer(e));
    body.addEventListener('dblclick', e => {
      const cell = cellOf(e);
      if (cell) this.edit(cell.id, cell.key);
    });
    table.addEventListener('keydown', e => this.onKey(e));
    host.replaceChildren(table);
    // A refresh paints the rows in view at once; a new sheet once it is in the page. The focus stays on the sheet.
    if (table.isConnected) paint(); else requestAnimationFrame(paint);
    if (hadFocus) queueMicrotask(() => table.focus({ preventScroll: true }));
  }

  /** One row. @param {Element} el @param {number} index */
  rowOf(el, index) {
    const sel = this.app.selection.has(el.id);
    const tr = h('tr', { 'data-id': el.id, 'aria-selected': String(sel), 'aria-rowindex': String(index + 2) });
    for (const c of this.columns) {
      const applies = !c.when || c.when(el);
      const active = this.active.id === el.id && this.active.key === c.key;
      tr.append(h('td', {
        'data-key': c.key, class: `${isNumeric(c) ? 'num' : ''}${c === ID ? ' sticky' : ''}${applies ? '' : ' na'}${active ? ' active' : ''}`,
        text: applies ? this.display(c, el[c.key]) : '—', title: applies ? undefined : 'Does not apply to this element',
      }));
    }
    return tr;
  }

  /** A value as the sheet shows it. @param {FieldSpec} c @param {unknown} v */
  display(c, v) {
    if (c.type === 'number' || c.type === 'integer') return editable(/** @type {number} */ (v));
    if (c.type === 'bool') return v ? 'Yes' : 'No';
    if (c.type === 'enum') return enumLabel(c.key, String(v));
    if (c.type === 'bus') return v ? (this.app.store.get(String(v))?.name || String(v)) : (c.optional ?? '');
    return String(v ?? '');
  }

  /** Reads text typed or pasted into a cell as a field value. Throws with a plain message when it is not one.
   * @param {FieldSpec} c @param {string} text */
  parse(c, text) {
    const t = text.trim();
    if (c.type === 'number' || c.type === 'integer') {
      const v = parseNumber(t);
      if (!Number.isFinite(v)) throw new Error(`${c.label} must be a number.`);
      return v;
    }
    if (c.type === 'bool') {
      if (/^(yes|true|1|on|y)$/i.test(t)) return true;
      if (/^(no|false|0|off|n)$/i.test(t)) return false;
      throw new Error(`${c.label} must be yes or no.`);
    }
    if (c.type === 'enum') {
      const o = (c.options ?? []).find(x => x === t || enumLabel(c.key, x).toLowerCase() === t.toLowerCase());
      if (o === undefined) throw new Error(`${c.label} must be one of: ${(c.options ?? []).map(x => enumLabel(c.key, x)).join(', ')}.`);
      return o;
    }
    if (c.type === 'bus') {
      if (!t && c.optional !== undefined) return '';
      const store = this.app.store;
      if (store.get(t)?.cls === 'bus') return t;
      const named = store.doc.elements.filter(e => e.cls === 'bus' && e.name === t);
      if (named.length === 1) return named[0].id;
      throw new Error(named.length > 1 ? `Several busbars are called ${t}; use the identifier.` : `No busbar is called ${t}.`);
    }
    return c.key === 'name' ? t : text;
  }

  /** The rows an edit of row `id` applies to: the selected rows of this sheet when it is one of them.
   * @param {string} id @returns {string[]} */
  targets(id) {
    const sel = this.app.selection;
    if (!sel.has(id) || sel.size < 2) return [id];
    return this.rows.filter(r => sel.has(r.id)).map(r => r.id);
  }

  /** Writes a value into the cells of several rows, as one undoable edit. Returns an error message or ''.
   * @param {FieldSpec} c @param {string[]} ids @param {unknown} value */
  write(c, ids, value) {
    const store = this.app.store;
    const label = ids.length > 1 ? `Edit ${c.label.toLowerCase()} of ${ids.length} elements` : `Edit ${c.label.toLowerCase()}`;
    return this.app.tryEdit(label, () => store.transact(label, tx => {
      for (const id of ids) {
        const el = store.get(id);
        if (el && (!c.when || c.when(el))) tx.set(id, c.key, value);
      }
    }));
  }

  /** Opens the editor on a cell. @param {string} id @param {string} key @param {string} [typed] the first character */
  edit(id, key, typed) {
    const c = this.columns.find(x => x.key === key), el = this.app.store.get(id);
    if (!c || c === ID || !el || (c.when && !c.when(el))) return;
    if (c.type === 'bool') { this.write(c, this.targets(id), !el[key]); return; }
    const td = /** @type {HTMLElement | null} */ (this.table?.querySelector(`tr[data-id="${CSS.escape(id)}"] td[data-key="${CSS.escape(key)}"]`));
    if (!td) return;
    /** @type {HTMLInputElement | HTMLSelectElement} */
    let input;
    if (c.type === 'enum') {
      input = h('select', { class: 'sheet-editor', 'aria-label': c.label }, ...(c.options ?? []).map(o => h('option', { value: o, text: enumLabel(c.key, o) })));
      input.value = String(el[key]);
    } else {
      input = h('input', { class: 'sheet-editor', 'aria-label': c.label, spellcheck: 'false', autocomplete: 'off' });
      input.value = typed ?? this.display(c, el[key]);
    }
    td.replaceChildren(input);
    td.classList.add('editing');
    this.editing = { id, key, input };
    input.focus();
    if (input instanceof HTMLInputElement && typed === undefined) input.select();
    input.addEventListener('keydown', ev => {
      const e = /** @type {KeyboardEvent} */ (ev);
      e.stopPropagation();
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        // After an edit of several rows the selection stays, so the next column can be edited for them too.
        const keep = e.key === 'Tab' || this.app.selection.size > 1;
        if (this.commit()) this.move(e.key === 'Enter' ? 1 : 0, e.key === 'Tab' ? (e.shiftKey ? -1 : 1) : 0, false, keep);
      }
      if (e.key === 'Escape') { e.preventDefault(); this.cancel(); }
    });
    input.addEventListener('blur', () => { if (this.editing?.input === input) this.commit(); });
    if (input instanceof HTMLSelectElement) input.addEventListener('change', () => this.commit());
  }

  /** Commits the open editor; false when the value was refused (the editor stays, marked). */
  commit() {
    const e = this.editing;
    if (!e) return true;
    const c = /** @type {FieldSpec} */ (this.columns.find(x => x.key === e.key));
    let msg = '';
    try {
      const value = this.parse(c, e.input.value);
      const el = this.app.store.get(e.id);
      if (el && Object.is(el[e.key], value) && this.targets(e.id).length === 1) { this.cancel(); return true; }
      this.editing = null;
      msg = this.write(c, this.targets(e.id), value);
      if (msg) this.editing = e;
    } catch (error) {
      msg = error instanceof Error ? error.message : String(error);
    }
    if (msg) {
      e.input.classList.add('invalid');
      e.input.title = msg;
      this.app.setStatusMessage(msg);
      return false;
    }
    this.table?.focus();
    return true;
  }

  cancel() {
    this.editing = null;
    this.paint?.();
    this.table?.focus();
  }

  /** @param {MouseEvent} e */
  onPointer(e) {
    const cell = cellOf(e);
    if (!cell || this.editing?.id === cell.id && this.editing.key === cell.key) return;
    if (this.editing) this.commit();
    const app = this.app, ids = this.rows.map(r => r.id);
    if (e.shiftKey && this.anchor) {
      const a = ids.indexOf(this.anchor), b = ids.indexOf(cell.id);
      if (a >= 0 && b >= 0) app.setSelection(ids.slice(Math.min(a, b), Math.max(a, b) + 1));
    } else if (e.metaKey || e.ctrlKey) {
      const next = new Set(app.selection);
      if (next.has(cell.id)) next.delete(cell.id); else next.add(cell.id);
      app.setSelection([...next]);
      this.anchor = cell.id;
    } else {
      app.setSelection([cell.id]);
      this.anchor = cell.id;
    }
    // The press itself gives the sheet the keyboard focus, for arrows, copy and paste.
    this.active = { id: cell.id, key: cell.key };
    this.restyle();
  }

  /** Moves the active cell by rows and columns, selecting its row (extending the range with Shift); `keep` leaves the
   * selection as it is (moving on after an edit of several rows).
   * @param {number} dr @param {number} dc @param {boolean} [extend] @param {boolean} [keep] */
  move(dr, dc, extend = false, keep = false) {
    const ri = Math.max(0, this.rows.findIndex(r => r.id === this.active.id));
    const ci = Math.max(0, this.columns.findIndex(c => c.key === this.active.key));
    const r = Math.min(this.rows.length - 1, Math.max(0, ri + dr)), c = Math.min(this.columns.length - 1, Math.max(0, ci + dc));
    const row = this.rows[r];
    if (!row) return;
    this.active = { id: row.id, key: this.columns[c].key };
    if (dr && !keep) {
      if (extend && this.anchor) {
        const ids = this.rows.map(x => x.id), a = ids.indexOf(this.anchor);
        this.app.setSelection(ids.slice(Math.min(a, r), Math.max(a, r) + 1));
      } else {
        this.app.setSelection([row.id]);
        this.anchor = row.id;
      }
    }
    this.reveal(r);
    this.restyle();
  }

  /** Scrolls row `r` into view. @param {number} r */
  reveal(r) {
    const s = this.scroller, first = /** @type {HTMLElement | null} */ (this.table?.querySelector('tbody tr[data-id]'));
    if (!s || !this.table) return;
    const rowH = first?.offsetHeight || 27, head = this.table.tHead?.offsetHeight ?? 0, body = /** @type {HTMLElement} */ (this.table.tBodies[0]);
    const top = body.offsetTop + r * rowH, sticky = parseFloat(getComputedStyle(s).getPropertyValue('--sticky-top')) || 0;
    if (top - head - sticky < s.scrollTop) s.scrollTop = top - head - sticky;
    else if (top + rowH > s.scrollTop + s.clientHeight) s.scrollTop = top + rowH - s.clientHeight;
  }

  /** @param {KeyboardEvent} e */
  onKey(e) {
    if (this.editing) return;
    const mod = e.metaKey || e.ctrlKey;
    const moves = /** @type {Record<string, [number, number]>} */ ({ ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], PageUp: [-20, 0], PageDown: [20, 0] });
    if (moves[e.key]) { e.preventDefault(); e.stopPropagation(); this.move(...moves[e.key], e.shiftKey); return; }
    if (e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); this.move(0, e.shiftKey ? -1 : 1); return; }
    if (e.key === 'Enter' || e.key === 'F2') { e.preventDefault(); e.stopPropagation(); this.edit(this.active.id, this.active.key); return; }
    // Delete and Backspace clear the cell for typing; they never delete elements from here.
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); this.edit(this.active.id, this.active.key, ''); return; }
    if (mod && (e.key === 'c' || e.key === 'v' || e.key === 'a')) {
      // Copy and paste go through the clipboard events; the network-wide shortcuts do not apply here.
      e.stopPropagation();
      if (e.key === 'a') { e.preventDefault(); this.app.setSelection(this.rows.map(r => r.id)); }
      return;
    }
    if (!mod && !e.altKey && e.key.length === 1 && this.active.id) {
      e.preventDefault(); e.stopPropagation();
      this.edit(this.active.id, this.active.key, e.key);
    }
  }

  /** @param {ClipboardEvent} e */
  onCopy(e) {
    if (this.editing) return;
    e.preventDefault();
    const sel = this.app.selection, picked = this.rows.filter(r => sel.has(r.id));
    const tsv = (/** @type {string} */ s) => s.replace(/[\t\n\r]+/g, ' ');
    let text;
    if (picked.length > 1) {
      text = [this.columns.map(c => c.label).join('\t'), ...picked.map(r => this.columns.map(c => tsv(this.display(c, r[c.key]))).join('\t'))].join('\n');
    } else {
      const el = this.app.store.get(this.active.id), c = this.columns.find(x => x.key === this.active.key);
      text = el && c ? this.display(c, el[c.key]) : '';
    }
    e.clipboardData?.setData('text/plain', text);
    this.app.setStatusMessage(picked.length > 1 ? `Copied ${picked.length} rows.` : 'Copied the cell.');
  }

  /** Pastes tab-separated text from the active cell rightwards and downwards: every value must fit, or nothing changes.
   * @param {ClipboardEvent} e */
  onPaste(e) {
    if (this.editing) return;
    e.preventDefault();
    const text = e.clipboardData?.getData('text/plain') ?? '';
    const grid = text.replace(/\r/g, '').replace(/\n$/, '').split('\n').map(line => line.split('\t'));
    if (!grid.length || !this.active.id) return;
    // A header row copied from this sheet is skipped.
    if (grid[0].every((v, i) => this.columns[i]?.label === v)) grid.shift();
    const r0 = this.rows.findIndex(r => r.id === this.active.id), c0 = this.columns.findIndex(c => c.key === this.active.key);
    /** @type {Array<{ id: string, c: FieldSpec, value: unknown }>} */
    const writes = [];
    try {
      grid.forEach((line, dr) => line.forEach((v, dc) => {
        const row = this.rows[r0 + dr], c = this.columns[c0 + dc];
        if (!row) throw new Error(`The pasted block runs past the last row.`);
        if (!c) throw new Error(`The pasted block runs past the last column.`);
        const who = row.name || row.id;
        if (c === ID) { if (v.trim() && v.trim() !== row.id) throw new Error(`${who}: identifiers cannot be changed here.`); return; }
        if (c.when && !c.when(row)) return;
        try { writes.push({ id: row.id, c, value: this.parse(c, v) }); }
        catch (error) { throw new Error(`${who}: ${error instanceof Error ? error.message : error}`); }
      }));
    } catch (error) {
      this.app.toast('error', error instanceof Error ? error.message : String(error), { title: 'Nothing was pasted' });
      return;
    }
    const store = this.app.store;
    const msg = this.app.tryEdit('Paste', () => store.transact(`Paste ${writes.length} values`, tx => { for (const w of writes) tx.set(w.id, w.c.key, w.value); }));
    if (msg) this.app.toast('error', msg, { title: 'Nothing was pasted' });
    else this.app.setStatusMessage(`Pasted ${writes.length} value${writes.length === 1 ? '' : 's'}.`);
  }

  /** The sheet as CSV, for the export command. */
  csv() {
    /** @param {string} s */
    const q = s => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const header = this.columns.map(c => q(c.unit ? `${c.label} (${c.unit})` : c.label)).join(',');
    return { name: CLASSES[this.cls].plural.toLowerCase(), text: [header, ...this.rows.map(r => this.columns.map(c => q(this.display(c, r[c.key]))).join(','))].join('\r\n') + '\r\n' };
  }
}

/** @param {FieldSpec} c */
const isNumeric = c => c.type === 'number' || c.type === 'integer';

/** The value a column sorts a row by. @param {FieldSpec} c @param {Element} el */
function sortKey(c, el) {
  const v = el[c.key];
  if (isNumeric(c)) return typeof v === 'number' ? v : -Infinity;
  if (c.type === 'bool') return v ? 1 : 0;
  return String(v ?? '');
}

/** The cell under a pointer event. @param {Event} e */
function cellOf(e) {
  const td = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('td[data-key]'));
  const tr = /** @type {HTMLElement | null} */ (td?.closest('tr[data-id]') ?? null);
  return td && tr ? { id: /** @type {string} */ (tr.dataset.id), key: /** @type {string} */ (td.dataset.key) } : null;
}
