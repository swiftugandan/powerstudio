/** The File view: projects stored in this browser, samples, the open project, import and export, shortcuts and the
 * about page. */

import { h, esc } from './dom.js';
import { icon, logo } from './icons.js';
import { relative } from './format.js';
import { SAMPLES } from '../samples/index.js';
import { kbd } from './keys.js';
import { confirm } from './feedback.js';
import { APP_VERSION, REPO_URL, SITE_URL } from '../core/version.js';
import { projectPage } from './project-page.js';

const VERSION = APP_VERSION, REPO = REPO_URL;

/** @typedef {'home' | 'open' | 'project' | 'import' | 'export' | 'shortcuts' | 'about'} Page */

/** @param {import('../app.js').App} app @param {Page} [page] */
export async function openBackstage(app, page = 'home') {
  closeBackstage();
  const previous = /** @type {HTMLElement | null} */ (document.activeElement);
  const main = h('main', { tabindex: '-1' });
  const nav = h('nav', { 'aria-label': 'File' });
  const panel = h('div', { class: 'backstage', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'File' }, nav, main);
  const close = () => { closeBackstage(); document.removeEventListener('keydown', onKey, true); previous?.focus?.(); };
  /** @param {KeyboardEvent} e */
  const onKey = e => { if (e.key === 'Escape' && !document.querySelector('.scrim')) { e.preventDefault(); e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  /** @type {Array<[Page | 'back', string, string]>} */
  const pages = [['back', 'Back to diagram', 'chevronRight'], ['home', 'New', 'new'], ['open', 'Open', 'open'], ['project', 'Project', 'layers'], ['import', 'Import', 'import'], ['export', 'Export', 'export'], ['shortcuts', 'Shortcuts', 'keyboard'], ['about', 'About', 'info']];
  for (const [id, label, ic] of pages) {
    const b = h('button', { type: 'button', class: id === 'back' ? 'back' : '', 'data-page': id, html: `${id === 'back' ? icon('chevronRight', 16).replace('<svg', '<svg style="transform:rotate(180deg)"') : icon(ic, 16)}<span>${label}</span>` });
    b.addEventListener('click', () => { if (id === 'back') close(); else show(id); });
    nav.append(b);
  }
  nav.append(h('span', { class: 'spacer' }), h('div', { class: 'fine', html: `PowerStudio ${VERSION}<br>MIT licence · Not affiliated with DIgSILENT GmbH` }));
  /** @param {Page} id */
  const show = async id => {
    for (const b of nav.querySelectorAll('[data-page]')) b.setAttribute('aria-current', String(/** @type {HTMLElement} */ (b).dataset.page === id));
    main.replaceChildren(...(await render(app, id, close)));
    main.focus();
  };
  /** @type {HTMLElement} */ (document.getElementById('overlay-root')).append(panel);
  // The page is modal: the workspace behind it takes neither focus nor clicks until it closes.
  setWorkspaceInert(true);
  await show(page);
}

export function closeBackstage() {
  document.querySelector('.backstage')?.remove();
  setWorkspaceInert(false);
}

/** @param {boolean} inert */
function setWorkspaceInert(inert) {
  const app = document.getElementById('app');
  if (app) app.inert = inert;
}

/** @param {import('../app.js').App} app @param {Page} page @param {() => void} close @returns {Promise<HTMLElement[]>} */
async function render(app, page, close) {
  /** @param {string} t @param {string} d @param {string} ic @param {() => void} run @param {string} [m] */
  const card = (t, d, ic, run, m = '') => h('button', { type: 'button', class: 'card', onclick: () => { close(); run(); }, html: `<span class="t">${icon(ic, 18)}${esc(t)}</span><span class="d">${esc(d)}</span>${m ? `<span class="m">${esc(m)}</span>` : ''}` });
  if (page === 'home') {
    return [h('h1', { text: 'Start a network' }),
      h('p', { class: 'lead', text: 'Begin with an empty diagram or open a sample. Everything you make is saved in this browser as you work.' }),
      h('div', { class: 'cards' }, card('Empty network', 'A blank diagram with default study settings.', 'new', () => app.newDocument()),
        ...SAMPLES.map(s => card(s.title, s.summary, 'sample', () => app.openSample(s.id), 'Sample'))),
      h('h2', { text: 'Recent' }), await docList(app, close, 4)];
  }
  if (page === 'open') return [h('h1', { text: 'Open' }), h('p', { class: 'lead', text: app.library.persistent ? 'Networks saved in this browser. They stay on this device and are not uploaded anywhere.' : 'This browser does not allow local storage here, so networks last only for this session. Export them to keep them.' }), await docList(app, close, 200)];
  if (page === 'project') return projectPage(app);
  if (page === 'import') {
    return [h('h1', { text: 'Import' }), h('p', { class: 'lead', text: 'Bring in a network from PowerStudio or another tool. Imported networks open as new documents; nothing is overwritten. You can also drop files anywhere on the window.' }),
      h('div', { class: 'cards' },
        card('PowerStudio file or project', 'A .powerstudio.json network or a .powerstudio-project.json project exported from this app.', 'open', () => app.importFile('.json,application/json')),
        card('CGMES model', 'CGMES 2.4.15 or 3.0: the EQ, TP, SSH and SV files with the boundary set, as XML files or ZIP archives. Select them together.', 'import', () => app.importFile('.xml,.zip')),
        card('PSS/E RAW and DYR files', 'A RAW file of version 32, 33 or 35, bus-branch or node-breaker. Select its DYR file with it to bring the machines\u2019 dynamic models.', 'import', () => app.importFile('.raw,.dyr')),
        card('MATPOWER case', 'A MATPOWER version 2 .m case file.', 'import', () => app.importFile('.m,text/plain'))),
      h('p', { class: 'note', text: 'PowerStudio shows what it read, what the diagram simplifies and how closely the result matches before the network opens. Diagrams are laid out automatically.' })];
  }
  if (page === 'export') {
    return [h('h1', { text: 'Export' }), h('p', { class: 'lead', text: 'Save copies outside the browser.' }),
      h('div', { class: 'cards' },
        card('Study report', 'The active study case\u2019s results, settings and run records, laid out for print or saving as PDF.', 'results', () => app.commands.run('file.report')),
        card('Project', 'Every study case, scenario and variant with the run log, in one file. Imports back as a new project.', 'layers', () => app.commands.run('file.exportProject')),
        card('Encrypted project', 'The same file locked with a passphrase, for moving a model between machines. Only PowerStudio with the passphrase can open it.', 'layers', () => app.commands.run('file.exportEncrypted')),
        card('PowerStudio file', 'The network as the active study case composes it, with its settings, as JSON. Opens in PowerStudio on any machine.', 'save', () => app.commands.run('file.export')),
        ...(app.project.source?.format === 'cgmes' ? [card('CGMES SSH and SV', 'The active study case\u2019s operating point in the CGMES files the project came from: their SSH with the values you changed, and the SV of its load flow, in a ZIP.', 'export', () => app.commands.run('file.exportCgmes'))] : []),
        card('Diagram as SVG', 'Vector drawing of the single-line diagram with the current annotations.', 'image', () => app.commands.run('file.exportSvg')),
        card('Diagram as PNG', 'Bitmap of the whole diagram at twice screen resolution.', 'image', () => app.commands.run('file.exportPng')),
        card('Results table as CSV', 'The table currently shown in the results panel.', 'csv', () => app.commands.run('results.csv')))];
  }
  if (page === 'shortcuts') return [h('h1', { text: 'Keyboard shortcuts' }), h('p', { class: 'lead', html: `${kbd('Mod+K')} opens the command palette, which lists every command with its shortcut.` }), shortcutList(app)];
  return [h('h1', { html: `<span style="display:inline-flex;align-items:center;gap:10px">${logo(30)}PowerStudio</span>` }),
    h('div', { class: 'about', html: `
      <p><strong>Single-line diagrams, solved in your browser.</strong> PowerStudio draws a network and runs Newton-Raphson load flow, IEC 60909-style short-circuit currents, N-1 contingency analysis and electromechanical stability simulation. It runs entirely on this device: no account, no server, no tracking.</p>
      <p>Version ${VERSION}. Website: <a href="${SITE_URL}" target="_blank" rel="noopener">${SITE_URL.replace('https://', '')}</a>. Source code and documentation: <a href="${REPO}" target="_blank" rel="noopener">${REPO.replace('https://', '')}</a>. Released under the MIT licence.</p>
      <h2>Your data</h2>
      <p>Networks, projects and results are kept in this browser\u2019s storage on this device, and the page cannot send them anywhere: its security policy forbids network connections. They are as safe as this device and your account on it. Anyone who can use this browser profile can open them, and a device that is compromised is beyond what PowerStudio can protect. To move a model to another machine, export it encrypted (Export, Encrypted project); the passphrase is not stored, so a lost passphrase cannot be recovered. <a href="${REPO}/blob/main/docs/SECURITY.md" target="_blank" rel="noopener">How PowerStudio protects your data</a>.</p>
      <p class="disclaimer">PowerStudio is an independent open-source project. It is not affiliated with, endorsed by or connected to DIgSILENT GmbH or its PowerFactory software. PowerFactory is a trademark of its owner. Its short-circuit calculation follows the method of IEC 60909-0 but is not certified against the standard; check results that matter with a validated tool.</p>
      <p>The IEEE 14-bus sample uses the load flow data of MATPOWER case14 (BSD licence), which comes from the University of Washington archive of IEEE test systems. Its ratings and machine data are assumptions.</p>
      <p>Drawing: <code>${esc(app.viewport.renderer?.label ?? '')}</code>${app.viewport.renderer?.detail ? ` (${esc(app.viewport.renderer.detail)})` : ''}${app.viewport.fallbackReason ? `. ${esc(app.viewport.fallbackReason)}` : ''}.</p>` })];
}

/** @param {import('../app.js').App} app @param {() => void} close @param {number} limit */
async function docList(app, close, limit) {
  const docs = (await app.library.list()).slice(0, limit);
  if (!docs.length) return h('p', { class: 'lead', text: 'No saved networks yet.' });
  const list = h('div', { class: 'doc-list', role: 'list' });
  for (const d of docs) {
    const row = h('div', { class: `row${d.id === app.docId ? ' current' : ''}`, role: 'listitem' },
      h('span', { class: 'n', tabindex: '0', role: 'button', text: d.name || 'Untitled network', onclick: () => { close(); app.openStored(d.id); },
        onkeydown: (/** @type {KeyboardEvent} */ e) => { if (e.key === 'Enter') { close(); app.openStored(d.id); } } }),
      h('span', { class: 'm', text: relative(d.updated) }), h('span', { class: 'm', text: `${d.elements} elements` }),
      h('button', { type: 'button', class: 'icon-btn sm', title: 'Delete from this browser', 'aria-label': `Delete ${d.name}`, html: icon('delete', 15),
        onclick: async () => {
          if (!(await confirm('Delete network', `Delete “${d.name}” from this browser? This cannot be undone. Export it first if you want to keep a copy.`, 'Delete'))) return;
          await app.deleteStored(d.id);
          row.remove();
        } }));
    list.append(row);
  }
  return list;
}

/** @param {import('../app.js').App} app */
export function shortcutList(app) {
  const wrap = h('div', { class: 'shortcuts' });
  const seen = new Set();
  for (const c of app.commands.all.values()) {
    if (!c.keys?.length || seen.has(c.id)) continue;
    seen.add(c.id);
    wrap.append(h('div', { class: 'k' }, h('span', { text: `${c.group}: ${c.label}` }), h('span', { html: c.keys.map(k => kbd(k)).join('<span style="color:var(--text-3)">/</span>') })));
  }
  return wrap;
}
