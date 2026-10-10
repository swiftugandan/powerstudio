/** Documents saved by every released version open in this one unchanged and solve as they did. Each release adds its
 * own documents to tests/fixtures/<version>/ (written by that version's code from its samples), with the voltages the
 * oracle computed for them then. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { normalizeDocument } from '../src/core/document.js';
import { studies } from './helpers.mjs';

const root = new URL('./fixtures/', import.meta.url);
const releases = readdirSync(root).filter(d => /^v\d+\.\d+\.\d+$/.test(d));

test('every released version has fixtures', () => {
  for (const v of ['v0.1.0', 'v1.0.0']) assert.ok(releases.includes(v), releases.join(', '));
});

for (const release of releases) {
  const dir = new URL(`${release}/`, root);
  for (const file of readdirSync(dir).filter(f => f.endsWith('.json') && !f.endsWith('.loadflow.json'))) {
    const name = file.replace(/\.json$/, '');
    test(`${release} ${name}: opens with nothing to report and solves to that release's voltages`, () => {
      const raw = JSON.parse(readFileSync(new URL(file, dir), 'utf8'));
      const { doc, issues } = normalizeDocument(raw);
      assert.deepEqual(issues, []);
      assert.equal(doc.elements.length, raw.elements.length);
      // Every value the old document held is still there, unchanged.
      for (const el of raw.elements) {
        const now = /** @type {Record<string, unknown>} */ (doc.elements.find(e => e.id === el.id));
        for (const [k, v] of Object.entries(el)) assert.deepEqual(now[k], v, `${el.id}.${k}`);
      }
      const want = JSON.parse(readFileSync(new URL(`${name}.loadflow.json`, dir), 'utf8')).bus;
      // To the oracle's tolerance; the document's own (0.001 MVA) leaves differences of 1e-5°.
      const r = studies.loadflow(doc, { tolerance: 1e-9 });
      assert.ok(r.converged, r.message);
      for (const b of r.buses) {
        const [vm, va] = want[b.id];
        assert.ok(Math.abs(b.vm - vm) < 1e-8 && Math.abs(b.va - va) < 1e-6, `${b.id}: ${b.vm} ∠${b.va}° against ${vm} ∠${va}°`);
      }
    });
  }
}
