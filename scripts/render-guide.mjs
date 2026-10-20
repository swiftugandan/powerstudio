/** Renders docs/guide/*.md to HTML pages that share the marketing site's look. Used by build-pages.mjs. */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** @param {string} s */
function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** GitHub-style heading anchor. @param {string} text */
export function anchor(text) {
  return text.trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-');
}

/**
 * Resolve a Markdown href for the published guide: chapter .md → .html; docs outside the guide → GitHub.
 * @param {string} href @param {string} repo
 */
function resolveHref(href, repo) {
  if (/^https?:/.test(href) || href.startsWith('#') || href.startsWith('mailto:')) return href;
  const m = /^(.*?)(\.md)(#.*)?$/.exec(href);
  if (!m) return href;
  const [, path, , hash = ''] = m;
  if (path.startsWith('../') || path.startsWith('../../')) {
    const cleaned = path.replace(/^\.\.\/\.\.\//, '').replace(/^\.\.\//, 'docs/');
    return `${repo}/blob/main/${cleaned}.md${hash}`;
  }
  return `${path}.html${hash}`;
}

/** Inline Markdown: links, bold, code, italics. @param {string} text @param {string} repo */
function inline(text, repo) {
  let s = esc(text);
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => `<a href="${esc(resolveHref(href, repo))}">${label}</a>`);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(?<!\w)_([^_]+)_(?!\w)/g, '<em>$1</em>');
  return s;
}

/**
 * Minimal CommonMark subset: headings, paragraphs, lists, tables, fenced code, blockquotes, hr.
 * @param {string} md @param {string} [repo]
 */
export function mdToHtml(md, repo = '') {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  /** @type {string[]} */
  const out = [];
  let i = 0;
  const flushPara = (/** @type {string[]} */ buf) => {
    if (!buf.length) return;
    out.push(`<p>${inline(buf.join(' '), repo)}</p>`);
    buf.length = 0;
  };
  /** @type {string[]} */
  let para = [];
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flushPara(para);
      i++;
      /** @type {string[]} */
      const code = [];
      while (i < lines.length && !/^```/.test(lines[i])) { code.push(lines[i]); i++; }
      i++;
      out.push(`<pre><code>${esc(code.join('\n'))}\n</code></pre>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      flushPara(para);
      /** @type {string[]} */
      const q = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { q.push(lines[i].replace(/^>\s?/, '')); i++; }
      out.push(`<blockquote>${mdToHtml(q.join('\n'), repo)}</blockquote>`);
      continue;
    }
    if (/^(\|?.+\|.+\|)\s*$/.test(line) && i + 1 < lines.length && /^\|?\s*[-:| ]+\|/.test(lines[i + 1])) {
      flushPara(para);
      /** @type {string[][]} */
      const rows = [];
      while (i < lines.length && /\|/.test(lines[i]) && !/^\s*$/.test(lines[i])) {
        if (!/^\|?\s*[-:| ]+\|\s*$/.test(lines[i])) {
          rows.push(lines[i].replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim()));
        }
        i++;
      }
      const [head, ...body] = rows;
      out.push('<table><thead><tr>' + head.map(c => `<th scope="col">${inline(c, repo)}</th>`).join('') + '</tr></thead>');
      out.push('<tbody>' + body.map(r => `<tr>${r.map(c => `<td>${inline(c, repo)}</td>`).join('')}</tr>`).join('') + '</tbody></table>');
      continue;
    }
    const hm = /^(#{1,6})\s+(.+)$/.exec(line);
    if (hm) {
      flushPara(para);
      const level = hm[1].length;
      const text = hm[2].trim();
      const id = anchor(text);
      out.push(`<h${level} id="${id}">${inline(text, repo)}</h${level}>`);
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushPara(para);
      out.push('<hr>');
      i++;
      continue;
    }
    const ul = /^[-*]\s+(.+)$/.exec(line);
    if (ul) {
      flushPara(para);
      out.push('<ul>');
      while (i < lines.length) {
        const m = /^[-*]\s+(.+)$/.exec(lines[i]);
        if (!m) break;
        out.push(`<li>${inline(m[1], repo)}</li>`);
        i++;
      }
      out.push('</ul>');
      continue;
    }
    const ol = /^(\d+)\.\s+(.+)$/.exec(line);
    if (ol) {
      flushPara(para);
      out.push('<ol>');
      while (i < lines.length) {
        const m = /^(\d+)\.\s+(.+)$/.exec(lines[i]);
        if (!m) break;
        out.push(`<li>${inline(m[2], repo)}</li>`);
        i++;
      }
      out.push('</ol>');
      continue;
    }
    if (/^\s*$/.test(line)) {
      flushPara(para);
      i++;
      continue;
    }
    para.push(line.trim());
    i++;
  }
  flushPara(para);
  return out.join('\n');
}

/** Chapters in reading order (filename without .md). */
export const GUIDE_CHAPTERS = [
  ['get-started', 'Get started'],
  ['build-your-network', 'Build your network'],
  ['enter-element-data', 'Enter element data'],
  ['import-a-model', 'Import a model from another tool'],
  ['set-up-study-cases', 'Set up study cases, scenarios and variants'],
  ['run-a-load-flow', 'Run a load flow'],
  ['find-fault-levels', 'Find fault levels'],
  ['check-outages', 'Check the network survives outages'],
  ['check-stability', 'Check machines stay in step'],
  ['look-at-emt', 'Look at the first cycles of a fault or switching'],
  ['work-with-results', 'Work with results'],
  ['save-share-protect', 'Save, share and protect your work'],
  ['check-against-your-tool', 'Check PowerStudio against your own tool'],
  ['reference', 'Reference'],
];

/**
 * @param {string} guideDir absolute path to docs/guide
 * @param {{ logo: string, version: string, siteUrl: string, favicon: string, repo: string }} meta
 */
export function renderGuidePages(guideDir, meta) {
  const files = new Set(readdirSync(guideDir).filter(f => f.endsWith('.md')));
  if (!files.has('README.md')) throw new Error('docs/guide/README.md is missing');
  for (const [slug] of GUIDE_CHAPTERS) {
    if (!files.has(`${slug}.md`)) throw new Error(`docs/guide/${slug}.md is missing`);
  }
  const css = GUIDE_CSS;
  /** @type {Array<{ path: string, html: string }>} */
  const pages = [];
  const tocBody = mdToHtml(readFileSync(join(guideDir, 'README.md'), 'utf8'), meta.repo);
  pages.push({ path: 'index.html', html: wrapPage('PowerStudio guide', tocBody, meta, css, null) });
  for (let n = 0; n < GUIDE_CHAPTERS.length; n++) {
    const [slug, title] = GUIDE_CHAPTERS[n];
    const prev = n > 0 ? GUIDE_CHAPTERS[n - 1] : null;
    const next = n < GUIDE_CHAPTERS.length - 1 ? GUIDE_CHAPTERS[n + 1] : null;
    const body = mdToHtml(readFileSync(join(guideDir, `${slug}.md`), 'utf8'), meta.repo);
    const nav = chapterNav(prev, next);
    pages.push({ path: `${slug}.html`, html: wrapPage(title, body + nav, meta, css, slug) });
  }
  return pages;
}

/** @param {[string, string] | null} prev @param {[string, string] | null} next */
function chapterNav(prev, next) {
  const parts = ['<nav class="chapter-nav" aria-label="Chapter">'];
  if (prev) parts.push(`<a class="prev" href="./${prev[0]}.html">Previous: ${esc(prev[1])}</a>`);
  else parts.push('<span></span>');
  parts.push('<a href="./">Contents</a>');
  if (next) parts.push(`<a class="next" href="./${next[0]}.html">Next: ${esc(next[1])}</a>`);
  else parts.push('<span></span>');
  parts.push('</nav>');
  return parts.join('');
}

/**
 * @param {string} title @param {string} body
 * @param {{ logo: string, version: string, siteUrl: string, favicon: string, repo: string }} meta
 * @param {string} css @param {string | null} slug
 */
function wrapPage(title, body, meta, css, slug) {
  const full = slug ? `${title} · PowerStudio guide` : 'PowerStudio guide';
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(full)}</title>
<meta name="description" content="How to use PowerStudio: draw or import a network, then run load flow, short circuit, contingency, stability and EMT studies.">
<link rel="icon" href="${meta.favicon}" type="image/svg+xml">
<style>${css}</style>
</head>
<body>
<header class="top night">
  <div class="wrap">
    <a class="brand" href="../">${meta.logo}<span>PowerStudio</span></a>
    <nav class="links" aria-label="Site">
      <a href="./">Guide</a>
      <a href="../app/">App</a>
      <a href="${esc(meta.repo)}">GitHub</a>
    </nav>
  </div>
</header>
<main class="wrap guide">
  <p class="kicker">Guide · ${esc(meta.version)}</p>
  <article class="prose">
${body}
  </article>
</main>
<footer class="night">
  <div class="wrap">
    <p>PowerStudio ${esc(meta.version)} · <a href="./">Guide contents</a> · <a href="../app/">Open the app</a></p>
  </div>
</footer>
</body>
</html>
`;
}

const GUIDE_CSS = `
:root {
  --font: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  --night: #0d1116; --night-line: #262d37; --on-night: #e5e9ef; --on-night-muted: #a3adba;
  --teal: #0b7a83; --teal-bright: #36c0cb; --on-teal: #052a2e;
  --paper: #f6f7f9; --sheet: #ffffff; --ink: #18212e; --muted: #546072; --line: #dde1e7; --soft: #eef1f4;
  --ok: #1d7f45; --warn: #a15c00; --bad: #c0352b;
}
@media (prefers-color-scheme: dark) {
  :root { --paper: #10151b; --sheet: #161b22; --ink: #e5e9ef; --muted: #a3adba; --line: #2a313c; --soft: #1c222b; --teal: #36c0cb; --ok: #4cc283; --warn: #e7a83d; --bad: #f06a5f; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); color: var(--ink); font: 17px/1.6 var(--font); -webkit-font-smoothing: antialiased; }
a { color: var(--teal); }
:focus-visible { outline: 2px solid var(--teal-bright); outline-offset: 3px; border-radius: 4px; }
.wrap { max-width: 760px; margin: 0 auto; padding: 0 24px; }
.night { background: var(--night); color: var(--on-night); }
header.top .wrap { display: flex; align-items: center; gap: 24px; height: 64px; max-width: 1180px; }
.brand { display: flex; align-items: center; gap: 10px; text-decoration: none; color: var(--on-night); font-size: 18px; font-weight: 650; }
.brand svg { width: 28px; height: 28px; }
nav.links { margin-left: auto; display: flex; gap: 22px; font-size: 15px; }
nav.links a { color: var(--on-night-muted); text-decoration: none; }
nav.links a:hover { color: var(--on-night); }
.kicker { margin: 36px 0 8px; color: var(--teal); font-weight: 650; font-size: 15px; }
.prose h1 { margin: 0 0 18px; font-size: clamp(28px, 4vw, 40px); line-height: 1.15; letter-spacing: -0.02em; }
.prose h2 { margin: 40px 0 12px; font-size: 24px; line-height: 1.25; letter-spacing: -0.015em; }
.prose h3 { margin: 28px 0 10px; font-size: 19px; }
.prose p, .prose li { max-width: 42em; }
.prose p { margin: 0 0 14px; }
.prose ul, .prose ol { margin: 0 0 16px; padding-left: 1.35em; }
.prose li { margin: 0 0 6px; }
.prose table { width: 100%; border-collapse: collapse; margin: 0 0 20px; font-size: 15px; }
.prose th, .prose td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
.prose th { font-weight: 650; }
.prose code { font-family: var(--mono); font-size: 0.9em; background: var(--soft); padding: 0.1em 0.35em; border-radius: 4px; }
.prose pre { background: var(--sheet); border: 1px solid var(--line); border-radius: 8px; padding: 14px 16px; overflow: auto; margin: 0 0 18px; }
.prose pre code { background: none; padding: 0; font-size: 13.5px; }
.prose blockquote { margin: 0 0 18px; padding: 12px 16px; border-left: 4px solid var(--teal-bright); background: var(--soft); }
.prose hr { border: 0; border-top: 1px solid var(--line); margin: 32px 0; }
.prose .warning, .prose p strong:first-child { }
.chapter-nav { display: grid; grid-template-columns: 1fr auto 1fr; gap: 12px; align-items: center; margin: 48px 0 64px; padding-top: 24px; border-top: 1px solid var(--line); font-size: 15px; }
.chapter-nav .next { text-align: right; }
footer.night { margin-top: 24px; }
footer .wrap { max-width: 1180px; padding: 28px 24px; font-size: 14.5px; color: var(--on-night-muted); }
footer a { color: var(--on-night); }
@media (max-width: 640px) {
  .chapter-nav { grid-template-columns: 1fr; }
  .chapter-nav .next { text-align: left; }
}
`;
