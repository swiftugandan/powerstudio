#!/usr/bin/env node
/** Summarises test-results/browser-report.json as Markdown: pass and fail counts per project, and the rendering
 * backend each project actually used (recorded by the first browser test as an annotation). */
import { readFileSync } from 'node:fs';

let report;
try { report = JSON.parse(readFileSync('test-results/browser-report.json', 'utf8')); }
catch { console.log('No browser test report was written.'); process.exit(0); }

/** @type {Map<string, { passed: number, failed: number, skipped: number, backend: Set<string> }>} */
const projects = new Map();
/** @param {any} suite */
function walk(suite) {
  for (const spec of suite.specs ?? []) {
    for (const t of spec.tests ?? []) {
      const p = projects.get(t.projectName) ?? { passed: 0, failed: 0, skipped: 0, backend: new Set() };
      projects.set(t.projectName, p);
      const status = t.results?.[t.results.length - 1]?.status;
      if (status === 'passed') p.passed++; else if (status === 'skipped') p.skipped++; else p.failed++;
      for (const a of t.annotations ?? []) if (a.type === 'backend') p.backend.add(a.description);
    }
  }
  for (const s of suite.suites ?? []) walk(s);
}
for (const s of report.suites ?? []) walk(s);
console.log('### Browser tests\n');
console.log('| Project | Passed | Failed | Skipped | Backend in use |');
console.log('| --- | --- | --- | --- | --- |');
for (const [name, p] of projects) console.log(`| ${name} | ${p.passed} | ${p.failed} | ${p.skipped} | ${[...p.backend].join(', ') || '—'} |`);
console.log(`\nTotal duration: ${((report.stats?.duration ?? 0) / 1000).toFixed(1)} s`);
