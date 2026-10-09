/** Sortable result tables with row selection and CSV export. */

import { h, esc } from './dom.js';

/**
 * @template R
 * @typedef {{ key: string, label: string, unit?: string, num?: boolean, value: (r: R) => number | string,
 *   text?: (r: R) => string, cls?: (r: R) => string, bar?: (r: R) => { pct: number, color: string } | null, title?: (r: R) => string }} Column
 */

/**
 * Renders a table. Clicking a header sorts by it (again to reverse); clicking a row reports its id.
 * @template R
 * @param {{ columns: Column<R>[], rows: R[], id: (r: R) => string, selected: Set<string>, sort: { key: string, dir: 1 | -1 },
 *   onSort: (key: string) => void, onRow: (id: string, e: MouseEvent) => void, stickyTop?: number }} spec
 */
export function dataTable(spec) {
  const { columns, id, selected, sort } = spec;
  const col = columns.find(c => c.key === sort.key) ?? columns[0];
  const rows = [...spec.rows].sort((a, b) => {
    const x = col.value(a), y = col.value(b);
    if (typeof x === 'number' && typeof y === 'number') {
      const fx = Number.isFinite(x), fy = Number.isFinite(y);
      if (!fx || !fy) return fx === fy ? 0 : fx ? -1 : 1; // missing values last
      return (x - y) * sort.dir;
    }
    return String(x).localeCompare(String(y), undefined, { numeric: true }) * sort.dir;
  });
  const head = h('tr', {}, ...columns.map(c => h('th', {
    class: c.num ? 'num' : '', scope: 'col', 'data-key': c.key, tabindex: '0',
    'aria-sort': c.key === sort.key ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined,
    html: `${esc(c.label)}${c.unit ? `<span class="unit">${esc(c.unit)}</span>` : ''}${c.key === sort.key ? `<span class="arrow">${sort.dir === 1 ? '▲' : '▼'}</span>` : ''}`,
  })));
  const body = h('tbody');
  for (const r of rows) {
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
    body.append(tr);
  }
  const table = h('table', { class: 'grid', style: spec.stickyTop ? `--sticky-top:${spec.stickyTop}px` : undefined }, h('thead', {}, head), body);
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
