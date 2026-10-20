import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { anchor, GUIDE_CHAPTERS } from '../scripts/render-guide.mjs';

/** @param {string} file @returns {Set<string>} */
function anchors(file) {
  const out = new Set();
  for (const [, text] of readFileSync(file, 'utf8').matchAll(/^#{1,6} (.+)$/gm)) out.add(anchor(text));
  return out;
}

/** @param {string} file */
function localLinks(file) {
  return [...readFileSync(file, 'utf8').matchAll(/\]\(([^)\s]+)\)/g)].map(m => m[1]).filter(l => !/^https?:/.test(l));
}

test('docs/guide holds every chapter and every link reaches a file and, where named, a heading', () => {
  const dir = 'docs/guide';
  assert.ok(existsSync(join(dir, 'README.md')));
  for (const [slug] of GUIDE_CHAPTERS) {
    assert.ok(existsSync(join(dir, `${slug}.md`)), `missing ${slug}.md`);
  }
  const files = readdirSync(dir).filter(f => f.endsWith('.md')).map(f => join(dir, f));
  let links = 0;
  for (const file of files) {
    for (const link of localLinks(file)) {
      links++;
      const [path, frag] = link.split('#');
      const target = path ? join(dirname(file), path) : file;
      assert.ok(existsSync(target), `${file}: ${link} → ${target} does not exist`);
      if (frag) assert.ok(anchors(target).has(frag), `${file}: ${link} → ${target} has no heading for #${frag}`);
    }
  }
  assert.ok(links > 40, `expected many guide links, found ${links}`);
});

test('the old single-file guides are gone and nothing still points at them', () => {
  for (const gone of ['docs/GETTING-STARTED.md', 'docs/USER-GUIDE.md', 'docs/BENCHMARK-KIT.md']) {
    assert.equal(existsSync(gone), false, `${gone} should be deleted`);
  }
  for (const file of ['README.md', 'CLAUDE.md', 'src/app.js', 'docs/TESTING.md', 'docs/ARCHITECTURE.md']) {
    const text = readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /GETTING-STARTED\.md|USER-GUIDE\.md|BENCHMARK-KIT\.md/);
  }
});

test('the README, Help commands and site lead to the guide', () => {
  assert.match(readFileSync('README.md', 'utf8'), /\]\(docs\/guide\/README\.md\)/);
  assert.match(readFileSync('README.md', 'utf8'), /\]\(docs\/guide\/get-started\.md\)/);
  const app = readFileSync('src/app.js', 'utf8');
  assert.match(app, /id: 'help\.start'[\s\S]*SITE_URL\}guide\/get-started\.html/);
  assert.match(app, /id: 'help\.guide'[\s\S]*label: 'Guide'[\s\S]*SITE_URL\}guide\//);
  assert.match(readFileSync('site/index.html', 'utf8'), /href="\.\/guide\/"/);
});
