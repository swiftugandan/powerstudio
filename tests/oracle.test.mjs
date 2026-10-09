import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { oracleInputs, serialize, inputsDir } from '../scripts/export-oracle-inputs.mjs';

test('the oracle inputs match the current samples, so the goldens describe what ships', () => {
  for (const [id, doc] of oracleInputs()) {
    const committed = readFileSync(join(inputsDir, `${id}.json`), 'utf8');
    assert.equal(committed, serialize(doc), `tests/oracle/inputs/${id}.json is stale: run node scripts/export-oracle-inputs.mjs, then the oracle (docs/TESTING.md)`);
  }
});
