import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seal, unseal, isSealed, KDF_COST } from '../src/core/sealed.js';
import { engine, golden } from './helpers.mjs';

/** @type {import('../src/core/sealed.js').DeriveKey} */
const derive = async (header, payload) => engine.call(header, payload).payload;
const project = JSON.stringify({ format: 'powerstudio-project', name: 'Übertragungsnetz', base: { elements: [1, 2, 3] } });

test('the engine derives the reference implementation’s Argon2id keys', () => {
  for (const c of golden('kdf').cases) {
    const salt = c.salt.match(/../g).map((/** @type {string} */ b) => parseInt(b, 16));
    const key = engine.call({ op: 'derive_key', salt, memoryKiB: c.memoryKiB, iterations: c.iterations, parallelism: c.parallelism },
      new TextEncoder().encode(c.passphrase)).payload;
    assert.equal(Buffer.from(key).toString('hex'), c.key, c.passphrase);
  }
});

test('a sealed project opens with its passphrase, at RFC 9106’s cost, and holds nothing readable', async () => {
  const sealed = await seal(project, 'correct horse battery staple', derive);
  assert.ok(isSealed(sealed));
  assert.deepEqual({ m: sealed.kdf.memoryKiB, t: sealed.kdf.iterations, p: sealed.kdf.parallelism }, { m: KDF_COST.memoryKiB, t: KDF_COST.iterations, p: KDF_COST.parallelism });
  assert.ok(!JSON.stringify(sealed).includes('rtragungsnetz'));
  assert.equal(await unseal(sealed, 'correct horse battery staple', derive), project);
  // The same words typed in another normalisation form open it too.
  const nfd = await seal(project, 'Prüfung der Netze', derive);
  assert.equal(await unseal(nfd, 'Prüfung der Netze'.normalize('NFD'), derive), project);
});

test('a wrong passphrase, a changed byte and a changed parameter all fail to open', async () => {
  const sealed = await seal(project, 'correct horse battery staple', derive);
  await assert.rejects(unseal(sealed, 'correct horse battery stapler', derive), /passphrase is not right/);
  const data = Buffer.from(sealed.data, 'base64');
  data[3] ^= 1;
  await assert.rejects(unseal({ ...sealed, data: data.toString('base64') }, 'correct horse battery staple', derive), /changed/);
  // A copy that claims a weaker cost is refused by the engine; one that claims a different but allowed cost fails the tag.
  await assert.rejects(unseal({ ...sealed, kdf: { ...sealed.kdf, memoryKiB: 1024 } }, 'correct horse battery staple', derive), /outside what PowerStudio accepts/);
  await assert.rejects(unseal({ ...sealed, kdf: { ...sealed.kdf, iterations: 4 } }, 'correct horse battery staple', derive), /changed/);
  await assert.rejects(seal(project, 'short', derive), /at least 12 characters/);
});
