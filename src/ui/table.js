/** Sortable result tables with row selection and CSV export.
 *
 * A table of more than VIRTUAL rows is virtual: it sorts every row but puts only those in view (and a margin) into the
 * page, between two spacer rows, and repaints as its scroll container moves. Its column widths are measured on the
 * first paint and then fixed, so they do not shift while scrolling. Smaller tables render whole. The header row sticks
 * at `--sticky-top`, which the container sets below its own sticky content. */

import { h, esc } from './dom.js';

/** Rows above which a table is virtual, and rows drawn beyond the visible ones on each side. */
const VIRTUAL = 500, OVERSCAN = 40;

/** Compares text naturally ("B2" before "B10"); one collator is far faster than `localeCompare` per pair. */
const collator = new Intl.Collator(undefined, { numeric: true });

/**
 * @template R
 * @typedef {{ key: string, label: string, unit?: string, num?: boolean, value: (r: R) => number | string,
 *   text?: (r: R) => string, cls?: (r: R) => string, bar?: (r: R) => { pct: number, color: string } | null, title?: (r: R) => string,
 *   help?: string }} Column
 * `title` is a cell's tooltip; `help` the header's.
 */

/**
 * Renders a table. Clicking a header sorts by it (again to reverse); clicking a row reports its id.
 * @template R
 * @param {{ columns: Column<R>[], rows: R[], id: (r: R) => string, selected: Set<string>, sort: { key: string, dir: 1 | -1 },
 *   onSort: (key: string) => void, onRow: (id: string, e: MouseEvent) => void, scroller?: HTMLElement }} spec
 */
export function dataTable(spec) {
  const { columns, id, selected, sort } = spec;
  const col = columns.find(c => c.key === sort.key) ?? columns[0];
  // Sort keys are read once per row, then the rows are ordered by index.
  const keys = spec.rows.map(r => col.value(r));
  const order = keys.map((_, i) => i).sort((a, b) => {
    const x = keys[a], y = keys[b];
    if (typeof x === 'number' && typeof y === 'number') {
      const fx = Number.isFinite(x), fy = Number.isFinite(y);
      if (!fx || !fy) return fx === fy ? 0 : fx ? -1 : 1; // missing values last
      return (x - y) * sort.dir;
    }
    return collator.compare(String(x), String(y)) * sort.dir;
  });
  const rows = order.map(i => spec.rows[i]);
  const head = h('tr', {}, ...columns.map(c => h('th', {
    class: c.num ? 'num' : '', scope: 'col', 'data-key': c.key, tabindex: '0', title: c.help,
    'aria-sort': c.key === sort.key ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined,
    html: `${esc(c.label)}${c.unit ? `<span class="unit">${esc(c.unit)}</span>` : ''}${c.key === sort.key ? `<span class="arrow">${sort.dir === 1 ? '▲' : '▼'}</span>` : ''}`,
  })));
  const body = h('tbody');
  /** @param {R} r */
  const rowOf = r => {
    const rid = id(r);
    const tr = h('tr', { 'data-id': rid, 'aria-selected': String(selected.has(rid)) });
    for (const c of columns) {
      const v = c.value(r);
      const text = c.text ? c.text(r) : typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '—') : String(v);
      const td = h('td', { class: `${c.num ? 'num' : ''} ${c.cls?.(r) ?? ''}`.trim(), title: c.title?.(r) });
      const bar = c.bar?.(r);
      if (bar) td.append(h('span', { class: 'bar' }, h('i', { style: `width:${Math.max(0, Math.min(100, bar.pct))}%;background:${bar.color}` })));
      td.append(text);
      tr.append(td);
    }
    return tr;
  };
  const table = h('table', { class: 'grid' }, h('thead', {}, head), body);
  const scroller = spec.scroller;
  if (!scroller || rows.length <= VIRTUAL) {
    for (const r of rows) body.append(rowOf(r));
  } else {
    // Virtual: spacer rows stand for the rows out of view; widths are fixed after the first paint.
    let rowHeight = 27, fixed = false;
    const spacer = (/** @type {number} */ n) => h('tr', { class: 'grid-spacer', 'aria-hidden': 'true' }, h('td', { colspan: String(columns.length), style: `height:${n * rowHeight}px` }));
    const paint = () => {
      if (!table.isConnected) { scroller.removeEventListener('scroll', onScroll); return; }
      const offset = body.offsetTop, top = Math.max(0, scroller.scrollTop - offset), view = scroller.clientHeight || 400;
      const from = Math.max(0, Math.floor(top / rowHeight) - OVERSCAN), to = Math.min(rows.length, Math.ceil((top + view) / rowHeight) + OVERSCAN);
      body.replaceChildren(spacer(from));
      for (let k = from; k < to; k++) body.append(rowOf(rows[k]));
      body.append(spacer(rows.length - to));
      if (!fixed) {
        const first = /** @type {HTMLElement | null} */ (body.querySelector('tr[data-id]'));
        if (first?.offsetHeight) {
          fixed = true;
          rowHeight = first.offsetHeight;
          const widths = [...head.children].map(th => /** @type {HTMLElement} */ (th).getBoundingClientRect().width);
          table.prepend(h('colgroup', {}, ...widths.map(w => h('col', { style: `width:${w}px` }))));
          table.classList.add('fixed');
          paint();
        }
      }
    };
    let pending = false;
    const onScroll = () => { if (pending) return; pending = true; requestAnimationFrame(() => { pending = false; paint(); }); };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    for (let k = 0; k < Math.min(rows.length, 80); k++) body.append(rowOf(rows[k]));
    body.append(spacer(rows.length - Math.min(rows.length, 80)));
    requestAnimationFrame(paint);
  }
  head.addEventListener('click', e => { const th = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('th')); if (th?.dataset.key) spec.onSort(th.dataset.key); });
  head.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); const th = /** @type {HTMLElement} */ (e.target); if (th.dataset.key) spec.onSort(th.dataset.key); } });
  body.addEventListener('click', e => { const tr = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('tr')); if (tr?.dataset.id) spec.onRow(tr.dataset.id, e); });
  return table;
}

/** CSV text for a table's columns and rows (RFC 4180 quoting, values unformatted). @template R
 * @param {Column<R>[]} columns @param {R[]} rows */
export function toCSV(columns, rows) {
  /** @param {unknown} v */
  const q = v => { const s = typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const header = columns.map(c => q(c.unit ? `${c.label} (${c.unit})` : c.label)).join(',');
  return [header, ...rows.map(r => columns.map(c => q(c.value(r))).join(','))].join('\r\n') + '\r\n';
}
