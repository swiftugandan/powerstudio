import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, engine, studies } from './helpers.mjs';
import { CONTROLLERS, CLASSES, completeController, checkValue, fieldOf } from '../src/core/catalog.js';
import { importFiles } from '../src/engine/exchange.js';
import { normalizeDocument } from '../src/core/document.js';

test('the catalogue lists the engine’s control models with the same parameters and typical values', () => {
  const lib = engine.call({ op: 'library' }).header;
  assert.deepEqual(CONTROLLERS.map(c => c.model), lib.controllers.map((/** @type {any} */ c) => c.model));
  for (const c of CONTROLLERS) {
    const rust = lib.controllers.find((/** @type {any} */ x) => x.model === c.model);
    assert.equal(c.slot, rust.slot, c.model);
    assert.deepEqual(c.params.map(p => p.key), rust.params, `${c.model} parameter order`);
    assert.deepEqual(c.params.map(p => p.default), rust.defaults, `${c.model} typical values`);
    assert.deepEqual(c.params.map(p => !!p.integer), rust.params.map((/** @type {string} */ _, /** @type {number} */ k) => k < rust.integers), `${c.model} integer parameters`);
  }
  // The round-rotor fields' defaults are the engine's typical round rotor.
  for (const [key, value] of Object.entries(lib.roundRotor)) assert.equal(fieldOf('gen', key)?.default, value, key);
});

test('a control is checked against its model and completed with typical values', () => {
  const f = /** @type {import('../src/core/catalog.js').FieldSpec} */ (fieldOf('gen', 'exciter'));
  assert.equal(checkValue(f, null), '');
  assert.equal(checkValue(f, { model: 'SEXS', K: 50 }), '');
  assert.match(checkValue(f, { model: 'TGOV1' }), /not an exciter model/);
  assert.match(checkValue(f, { model: 'SEXS', K: 'x' }), /must be a number/);
  const sexs = completeController({ model: 'SEXS', K: 50 });
  assert.equal(sexs.K, 50);
  assert.equal(sexs.TB, CONTROLLERS[0].params.find(p => p.key === 'TB')?.default);
  assert.ok(CLASSES.gen.fields.some(x => x.key === 'governor' && x.type === 'controller'));
});

/** ANDES's published IEEE 14-bus case, RAW and DYR, from `.cache/reference`; null when it has not been fetched. */
function ieee14() {
  const cases = JSON.parse(readFileSync(join(root, 'tests/oracle/dyn-cases.json'), 'utf8'));
  const c = cases.cases.find((/** @type {any} */ x) => x.name === 'ieee14');
  try {
    return ['raw', 'dyr'].map(k => ({ name: `ieee14.${k}`, bytes: new Uint8Array(readFileSync(join(root, '.cache/reference', c[k]))) }));
  } catch {
    return null;
  }
}

test('a RAW file with its DYR file opens with every machine’s models, and simulates', { skip: ieee14() ? false : 'run node scripts/fetch-reference.mjs' }, () => {
  const files = /** @type {Array<{ name: string, bytes: Uint8Array }>} */ (ieee14());
  const { summary, doc } = importFiles(engine, files);
  const dyr = summary.report.classes.filter((/** @type {any} */ c) => c.class.startsWith('DYR '));
  for (const model of ['GENROU', 'ESST3A', 'EXST1', 'TGOV1', 'IEEEG1', 'IEEEST', 'ST2CUT']) {
    assert.ok(dyr.some((/** @type {any} */ c) => c.class === `DYR ${model}` && c.status === 'mapped'), model);
  }
  // ANDES's own event records are not PSS/E data: skipped, and said so.
  assert.ok(summary.report.notes.some((/** @type {string} */ n) => /could not be read and was skipped: line \d+: Line 'Toggle'/.test(n)), summary.report.notes.join('\n'));
  const gens = doc.elements.filter((/** @type {any} */ e) => e.cls === 'gen');
  assert.equal(gens.length, 5);
  for (const g of gens) {
    assert.equal(g.machineModel, 'roundRotor', g.id);
    assert.ok(g.exciter && g.governor, g.id);
  }
  assert.equal(gens.find((/** @type {any} */ g) => g.id === 'B3-G1').stabiliser.model, 'IEEEST');
  // The editor's import gate takes the engine's document as it is.
  assert.deepEqual(normalizeDocument(JSON.parse(JSON.stringify(doc))).issues, []);

  doc.study.rms = { ...doc.study.rms, tEnd: 3, dt: 0.005, events: [{ t: 1, kind: 'fault', target: 'B9', x: 0.05 }, { t: 1.1, kind: 'clear', target: 'B9' }] };
  const r = studies.rms(doc);
  assert.ok(r.stable, r.message);
  assert.equal(r.events.filter(e => e.applied).length, 2);
  assert.match(r.events[0].note, /through 0 \+ j0.05 Ω/);
  const g1 = r.machines.find(m => m.id === 'B1-G1');
  assert.ok(g1 && g1.efd.length === r.t.length && g1.pm.length === r.t.length);
  // The exciter answers the fault: the field voltage rises while it lasts.
  const k = r.t.findIndex(t => t > 1.08);
  assert.ok(g1.efd[k] > g1.efd[0] + 0.05, `field voltage ${g1.efd[0]} → ${g1.efd[k]}`);
});
