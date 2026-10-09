/** Shared test helpers: fixture and golden loading. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');
/** @param {string} rel */
export const read = rel => readFileSync(join(root, rel), 'utf8');
/** @param {string} name */
export const golden = name => JSON.parse(read(`tests/oracle/golden/${name}.json`));
/** @param {string} name */
export const input = name => JSON.parse(read(`tests/oracle/inputs/${name}.json`));
