import { test } from 'node:test';
import assert from 'node:assert/strict';
import { binExtremes, valueRange, commonLimits, spread } from '../src/ui/chart.js';
import { sortRows } from '../src/ui/table.js';

/** @param {number} value @param {Partial<import('../src/ui/chart.js').Bar>} [more] */
const bar = (value, more = {}) => ({ id: `b${value}`, name: `B${value}`, value, color: /** @type {[number, number, number, number]} */ ([0, 0, 0, 1]), ...more });

test('a binned column shows its element furthest from the baseline, missing values never', () => {
  // Six elements in three columns: each column takes the larger deviation from 1.
  assert.deepEqual([...binExtremes([1.02, 0.95, NaN, 1.01, 1.0, 1.08], 1, 3)], [1, 3, 5]);
  // A column whose elements all lack a value is empty.
  assert.deepEqual([...binExtremes([NaN, NaN, 5, 1], 0, 2)], [-1, 2]);
  // More columns than elements leave columns empty instead of repeating an element.
  assert.deepEqual([...binExtremes([3, 4], 0, 4)], [0, -1, 1, -1]);
  assert.equal(binExtremes([], 0, 10).length, 10);
  assert.equal(binExtremes([1], 0, 0).length, 0);
});

test('a peak survives binning however many elements there are', () => {
  const values = new Float64Array(70_000).fill(1);
  values[43_210] = 0.82;
  const bins = binExtremes(values, 1, 600);
  assert.ok([...bins].includes(43_210));
});

test('the value range covers bars, limits, compared values and lines, and keeps a zero baseline on the axis', () => {
  const r = valueRange({ bars: [bar(40), bar(76, { ref: 80 })], label: '', unit: '%', digits: 1, base: 0, title: '', selected: new Set(),
    lines: [{ value: 100, label: '100 %', tone: 'bad' }] });
  assert.equal(r.lo, 0);
  assert.ok(r.hi > 100 && r.hi < 110);
  const v = valueRange({ bars: [bar(1.02, { lo: 0.94, hi: 1.06 }), bar(1.09, { lo: 0.94, hi: 1.06 })], label: '', unit: 'p.u.', digits: 4, base: 1,
    title: '', selected: new Set() });
  assert.ok(v.lo < 0.94 && v.hi > 1.09);
  // A single value still has an extent.
  const one = valueRange({ bars: [bar(0)], label: '', unit: '', digits: 0, base: 0, title: '', selected: new Set() });
  assert.ok(one.hi > one.lo);
});

test('a shared limit band is found only when every bar has the same limits', () => {
  assert.deepEqual(commonLimits([bar(1, { lo: 0.9, hi: 1.1 }), bar(2, { lo: 0.9, hi: 1.1 })]), { lo: 0.9, hi: 1.1 });
  assert.equal(commonLimits([bar(1, { lo: 0.9, hi: 1.1 }), bar(2, { lo: 0.95, hi: 1.05 })]), null);
  assert.equal(commonLimits([bar(1)]), null);
  assert.equal(commonLimits([]), null);
});

test('margin labels move apart and stay inside the plot', () => {
  const out = spread([{ y: 10, k: 'a' }, { y: 12, k: 'b' }, { y: 100, k: 'c' }], 13, 6, 94);
  assert.deepEqual(out.map(x => x.k), ['a', 'b', 'c']);
  assert.equal(out[2].y, 94);
  assert.ok(out[1].y - out[0].y >= 13);
  assert.ok(out[0].y >= 6);
});

test('the chart orders its rows as the table does: by the sort column, missing values last', () => {
  const columns = [{ key: 'name', label: 'Name', value: (/** @type {any} */ r) => r.name }, { key: 'v', label: 'V', num: true, value: (/** @type {any} */ r) => r.v }];
  const rows = [{ name: 'B10', v: 2 }, { name: 'B2', v: NaN }, { name: 'B1', v: 5 }];
  assert.deepEqual(sortRows(columns, rows, { key: 'name', dir: 1 }).map(r => r.name), ['B1', 'B2', 'B10']);
  assert.deepEqual(sortRows(columns, rows, { key: 'v', dir: -1 }).map(r => r.name), ['B1', 'B10', 'B2']);
  assert.deepEqual(sortRows(columns, rows, { key: 'v', dir: 1 }).map(r => r.name), ['B10', 'B1', 'B2']);
});
