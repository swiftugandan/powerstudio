import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp, CSP } from '../build.mjs';

test('the build is one deterministic, self-contained HTML file that forbids network access', async () => {
  const a = await buildApp(), b = await buildApp();
  assert.equal(a, b, 'two builds of the same source are byte-identical');
  assert.ok(a.startsWith('<!doctype html>'));
  assert.ok(a.includes(`<meta http-equiv="Content-Security-Policy" content="${CSP}">`));
  assert.match(CSP, /connect-src 'none'/);
  assert.doesNotMatch(a, /<script[^>]+src=/i, 'no external scripts');
  assert.doesNotMatch(a, /<link[^>]+rel="stylesheet"/i, 'no external stylesheets');
  assert.doesNotMatch(a, /@import|url\(https?:/i, 'no remote CSS resources');
  assert.ok(a.includes('__POWERSTUDIO_WORKER_URL__'), 'the worker is inlined');
});
