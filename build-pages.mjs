#!/usr/bin/env node
/** Builds the GitHub Pages site into _site/: the marketing page at /, the app at /app/, the single-file download
 * PowerStudio.html with its SHA-256, the workspace screenshot and build-info.json. The page's figures and its diagram
 * are computed by the engine here, so the page says what the app does. */

import { readFile, writeFile, mkdir, rm, cp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildApp } from './build.mjs';
import { studies, agreement, diagramSvg } from './scripts/site-data.mjs';
import { APP_VERSION, REPO_URL, SITE_URL } from './src/core/version.js';
import { icon } from './src/ui/icons.js';

const root = dirname(fileURLToPath(import.meta.url));
const out = join(root, '_site');

/** @param {number} v @param {number} d */
const num = (v, d = 0) => v.toLocaleString('en-GB', { minimumFractionDigits: d, maximumFractionDigits: d });
/** Powers of ten as 1 × 10⁻¹² style text. @param {number} v */
const sci = v => {
  if (v === 0) return '0';
  const e = Math.floor(Math.log10(v)), m = v / 10 ** e;
  const sup = String(e).replace(/-/g, '⁻').replace(/\d/g, d => '⁰¹²³⁴⁵⁶⁷⁸⁹'[Number(d)]);
  return `${m.toFixed(1)} × 10${sup}`;
};

const LOGO = '<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="1" y="1" width="30" height="30" rx="8" fill="#36c0cb"/><path d="M8 10.5h16" stroke="#052a2e" stroke-width="3" stroke-linecap="round"/><path d="M12 10.5v4M20 10.5v4" stroke="#052a2e" stroke-width="2" stroke-linecap="round"/><path d="M7.5 21.5c1.9-3.6 3.8-3.6 5.6 0s3.7 3.6 5.6 0 3.7-3.6 5.6 0" fill="none" stroke="#052a2e" stroke-width="2.2" stroke-linecap="round"/></svg>';

export async function buildSite() {
  const app = await buildApp();
  const sha = createHash('sha256').update(app).digest('hex');
  const s = studies(), a = agreement();
  const favicon = `data:image/svg+xml,${encodeURIComponent((await readFile(join(root, 'favicon.svg'), 'utf8')).trim())}`;
  /** @type {Record<string, string>} */
  const values = {
    version: APP_VERSION, repo: REPO_URL, siteUrl: SITE_URL, favicon, logo: LOGO,
    appSize: `${Math.round(Buffer.byteLength(app) / 1024)} KB`,
    diagram: diagramSvg('dark'),
    diagramCaption: `Drawn when this page was built, from the same display list the app renders: every busbar voltage, branch loading and machine output is the engine's result (${num(s.loadflow.generation, 1)} MW generated, ${num(s.loadflow.losses, 3)} MW lost).`,
    lfIterations: String(s.loadflow.iterations), lfLosses: num(s.loadflow.losses, 3),
    scIkss: num(s.shortcircuit.ikss, 2), scBus: s.shortcircuit.bus,
    n1Bad: String(s.contingency.bad), n1Total: String(s.contingency.total), n1Outage: s.contingency.outage, n1Loaded: s.contingency.loaded, n1Loading: num(s.contingency.loading, 0),
    rmsVerdict: s.rms.stable ? 'Stays in step' : 'Loses step',
    rmsDetail: `${s.rms.machines} machines through a fault at ${s.rms.faultBus} cleared in ${num(s.rms.clearing * 1000, 0)} ms${s.rms.tripped ? ` by tripping ${s.rms.tripped}` : ''}`,
    agreeMatpower: sci(a.matpower), agreeLf: sci(a.pandapowerLf), agreeScSym: sci(a.scSymmetric), agreeScEarth: sci(a.scEarth),
    iconLoadflow: icon('loadflow', 20), iconShortcircuit: icon('shortcircuit', 20), iconContingency: icon('contingency', 20), iconRms: icon('rms', 20),
  };
  let page = await readFile(join(root, 'site', 'index.html'), 'utf8');
  page = page.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    if (!(key in values)) throw new Error(`site/index.html uses unknown placeholder ${match}`);
    return values[key];
  });
  await rm(out, { recursive: true, force: true });
  await mkdir(join(out, 'app'), { recursive: true });
  await writeFile(join(out, 'index.html'), page);
  await writeFile(join(out, 'app', 'index.html'), app);
  await writeFile(join(out, 'PowerStudio.html'), app);
  await writeFile(join(out, 'PowerStudio.html.sha256'), `${sha}  PowerStudio.html\n`);
  await cp(join(root, 'docs', 'screenshots', '01-load-flow.png'), join(out, 'workspace.png'));
  await cp(join(root, 'favicon.svg'), join(out, 'favicon.svg'));
  await writeFile(join(out, 'build-info.json'), JSON.stringify({ name: 'powerstudio', version: APP_VERSION, appSha256: sha, sourceRevision: process.env.GITHUB_SHA ?? null }, null, 2) + '\n');
  await writeFile(join(out, '.nojekyll'), '');
  return { sha, page };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { sha } = await buildSite();
  console.log(`Built _site/ (marketing page, app at /app/, PowerStudio.html sha256 ${sha})`);
}
