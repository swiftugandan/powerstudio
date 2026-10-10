#!/usr/bin/env node
/** Downloads the reference models the engine tests read (the *-cases.json files in tests/oracle list them) into
 * .cache/reference/, checking each against its pinned SHA-256. Files already present and intact are kept. They are
 * not redistributed with the repository; docs/research/sources.md gives their licences. */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, '.cache', 'reference');
const lists = ['cgmes-cases.json', 'psse-cases.json', 'matpower-cases.json', 'dyn-cases.json'];
/** @type {Record<string, {file: string, url: string, sha256: string}>} */
const archives = Object.assign({}, ...lists.map((f) => JSON.parse(readFileSync(join(root, 'tests', 'oracle', f), 'utf8')).archives));
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
  console.log(`${(bytes.length / 2 ** 20).toFixed(2)} MiB, checksum verified`);
}
if (failed) process.exit(1);
