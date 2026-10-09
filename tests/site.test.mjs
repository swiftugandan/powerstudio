import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSite } from '../build-pages.mjs';
import { buildApp } from '../build.mjs';
import { APP_VERSION } from '../src/core/version.js';

test('the site serves the build unchanged at /app/ and as the download, and the page is complete', async () => {
  const { sha, page } = await buildSite();
  const app = await buildApp();
  assert.equal(readFileSync('_site/app/index.html', 'utf8'), app);
  assert.equal(readFileSync('_site/PowerStudio.html', 'utf8'), app);
  assert.equal(readFileSync('_site/PowerStudio.html.sha256', 'utf8'), `${sha}  PowerStudio.html\n`);
  assert.doesNotMatch(page, /\{\{\w+\}\}/, 'every placeholder is filled');
  assert.match(page, /not affiliated with, endorsed by or connected to DIgSILENT GmbH/);
  assert.match(page, /IEC 60909-style/);
  assert.match(page, /<svg [^>]*aria-label="Single-line diagram of the IEEE 14-bus system/);
  // The page loads nothing from other origins: no scripts at all, and only local images and styles.
  assert.doesNotMatch(page, /<script/i);
  assert.doesNotMatch(page, /<(?:img|link)[^>]+(?:src|href)="https?:/i);
  assert.doesNotMatch(page, /url\(https?:/i);
});

test('package.json and the app agree on the version', () => {
  assert.equal(JSON.parse(readFileSync('package.json', 'utf8')).version, APP_VERSION);
});
