import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Licences a shipped component may carry: permissive ones that ask for no more than the notice the app keeps. */
const PERMITTED = new Set(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'Zlib', '0BSD', 'Unlicense', 'ISC', 'Unicode-3.0']);

test('the bill of materials lists every engine component with a permitted licence and a pinned hash', () => {
  const out = join(mkdtempSync(join(tmpdir(), 'powerstudio-sbom-')), 'sbom.json');
  execFileSync('node', ['scripts/sbom.mjs', out], { stdio: 'ignore' });
  const sbom = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(sbom.bomFormat, 'CycloneDX');
  assert.equal(sbom.specVersion, '1.6');
  assert.match(sbom.serialNumber, /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const shipped = sbom.components.filter((/** @type {any} */ c) => c.scope === 'required');
  assert.ok(shipped.some((/** @type {any} */ c) => c.name === 'ps-wasm') && shipped.some((/** @type {any} */ c) => c.name === 'faer'));
  for (const c of shipped) {
    const expression = c.licenses?.[0]?.expression ?? '';
    // An expression offers a choice ("MIT OR Apache-2.0"); one permitted choice is enough.
    const choices = expression.split(/\s+OR\s+/).map((/** @type {string} */ s) => s.replace(/[()]/g, '').trim());
    assert.ok(choices.some((/** @type {string} */ l) => PERMITTED.has(l)), `${c.name} ${c.version}: licence "${expression}"`);
    if (c.type === 'library') assert.match(c.hashes?.[0]?.content ?? '', /^[0-9a-f]{64}$/, `${c.name}: no pinned checksum`);
  }
});
