import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The anchors GitHub gives a Markdown file's headings: lower case, punctuation dropped, spaces as hyphens.
 * @param {string} file @returns {Set<string>} */
function anchors(file) {
  const out = new Set();
  for (const [, text] of readFileSync(file, 'utf8').matchAll(/^#{1,6} (.+)$/gm)) {
    out.add(text.trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-'));
  }
  return out;
}

test('every link in the getting-started guide reaches a file and, where it names one, a heading', () => {
  const guide = 'docs/GETTING-STARTED.md';
  const links = [...readFileSync(guide, 'utf8').matchAll(/\]\(([^)\s]+)\)/g)].map(m => m[1]).filter(l => !/^https?:/.test(l));
  assert.ok(links.some(l => l.startsWith('USER-GUIDE.md#')), 'the guide links into the user guide');
  for (const link of links) {
    const [path, anchor] = link.split('#');
    const file = path ? join(dirname(guide), path) : guide;
    assert.ok(existsSync(file), `${link}: ${file} does not exist`);
    if (anchor) assert.ok(anchors(file).has(anchor), `${link}: ${file} has no heading for #${anchor}`);
  }
});

test('the README, the user guide and the Help tab lead to the getting-started guide', () => {
  assert.match(readFileSync('README.md', 'utf8'), /\]\(docs\/GETTING-STARTED\.md\)/);
  assert.match(readFileSync('docs/USER-GUIDE.md', 'utf8'), /\]\(GETTING-STARTED\.md\)/);
  assert.match(readFileSync('src/app.js', 'utf8'), /id: 'help\.start'.*docs\/GETTING-STARTED\.md/s);
});
