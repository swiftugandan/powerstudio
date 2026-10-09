#!/usr/bin/env node
/** Downloads the reference model archives the engine tests read (tests/oracle/cgmes-cases.json lists them) into
 * .cache/reference/, checking each against its pinned SHA-256. Archives already present and intact are kept. They are
 * not redistributed with the repository; docs/research/sources.md gives their licences. */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, '.cache', 'reference');
const { archives } = JSON.parse(readFileSync(join(root, 'tests', 'oracle', 'cgmes-cases.json'), 'utf8'));
mkdirSync(dir, { recursive: true });
const sha = (/** @type {Buffer} */ b) => createHash('sha256').update(b).digest('hex');
let failed = false;
for (const [name, a] of Object.entries(archives)) {
  const path = join(dir, a.file);
  if (existsSync(path) && sha(readFileSync(path)) === a.sha256) { console.log(`${name}: present`); continue; }
  process.stdout.write(`${name}: downloading ${a.url} … `);
  const response = await fetch(a.url);
  if (!response.ok) { console.log(`HTTP ${response.status}`); failed = true; continue; }
  const bytes = Buffer.from(await response.arrayBuffer());
  const got = sha(bytes);
  if (got !== a.sha256) { console.log(`checksum ${got} does not match the pinned ${a.sha256}`); failed = true; continue; }
  writeFileSync(path, bytes);
  console.log(`${(bytes.length / 2 ** 20).toFixed(1)} MiB, checksum verified`);
}
if (failed) process.exit(1);
