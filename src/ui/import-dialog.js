/** The import dialog: what the engine read from another tool's files, what the editor's network simplifies, how
 * closely that network reproduces the imported model's load flow, and the model's validation, before the network
 * opens. */

import { h } from './dom.js';
import { modal } from './feedback.js';
import { fixed } from './format.js';

/** @typedef {import('../engine/reports.js').ImportSummary} ImportSummary */

const FORMAT = /** @type {Record<ImportSummary['format'], string>} */ ({ cgmes: 'CGMES', psse: 'PSS/E RAW', matpower: 'MATPOWER' });

/** A CGMES version or RAW version from the files' profiles, for the title line. @param {ImportSummary} s */
function formatName(s) {
  const profiles = s.report.files.flatMap(f => f.profiles);
  if (s.format === 'cgmes') return profiles.some(p => p.includes('/3.0') || p.includes('-EU')) ? 'CGMES 3.0' : 'CGMES 2.4.15';
  return profiles[0] ?? FORMAT[s.format];
}

/** @param {number} n @param {string} one @param {string} [many] */
const count = (n, one, many = `${one}s`) => `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`;

/** A number in scientific notation for differences. @param {number} x */
const sci = x => (x === 0 ? '0' : x.toExponential(1).replace('e', ' × 10^').replace('^+', '^').replace(/\^(-?\d+)/, (_, e) => toSuper(e)));
/** @param {string} e */
const toSuper = e => [...e].map(c => '⁻⁰¹²³⁴⁵⁶⁷⁸⁹'['-0123456789'.indexOf(c)]).join('');

/** How closely the editor's network reproduces the model, as a status line. @param {ImportSummary['fidelity']} f */
function fidelityLine(f) {
  if (!f.solved) return { kind: 'warn', text: 'The imported model’s load flow does not converge, so the editor’s network could not be checked against it.' };
  if (!Number.isFinite(f.maxDv)) return { kind: 'bad', text: 'The editor’s network does not reach the imported model’s solution.' };
  if (f.maxDv <= 1e-6 && f.maxDa <= 1e-4) return { kind: 'ok', text: `The editor’s network reproduces the imported load flow: voltages agree within ${sci(Math.max(f.maxDv, 1e-15))} p.u.` };
  return { kind: 'warn', text: `The editor’s network differs from the imported load flow by up to ${fixed(f.maxDv, 4)} p.u. (${fixed(f.maxDa, 2)}°), at ${f.worst}. The notes below say what it simplifies.` };
}

/**
 * Shows what an import found. Resolves true to open the network.
 * @param {ImportSummary} s @param {string[]} names @returns {Promise<boolean>}
 */
export async function importDialog(s, names) {
  const z = s.size;
  const summary = [count(z.nodes, 'node'), count(z.branches, 'branch', 'branches'), count(z.sources, 'source'), count(z.loads, 'load')];
  if (z.switches) summary.push(count(z.switches, 'switch', 'switches'));
  const f = fidelityLine(s.fidelity);
  const errors = s.validation.filter(i => i.severity === 'error');
  const warnings = s.validation.filter(i => i.severity === 'warning');
  const body = h('div', { class: 'import' },
    h('p', { class: 'import-lead', text: `${formatName(s)} · ${summary.join(' · ')} · read in ${fixed(s.ms / 1000, 2)} s` }),
    h('div', { class: `import-status ${f.kind}`, role: 'status' }, h('span', { class: `pill ${f.kind}`, text: f.kind === 'ok' ? 'Exact' : f.kind === 'warn' ? 'Check' : 'Differs' }), h('span', { text: f.text })),
  );
  if (s.fidelity.solved && !s.fidelity.editorConverges) {
    body.append(h('p', { class: 'import-note', text: 'This network needs a good starting point: its load flows start from the imported voltages, then from their own last solution.' }));
  }
  /** @param {string} title @param {string[]} items @param {boolean} open */
  const list = (title, items, open) => items.length
    ? h('details', { class: 'import-section', open }, h('summary', { text: `${title} (${items.length})` }), h('ul', {}, ...items.map(t => h('li', { text: t }))))
    : null;
  if (errors.length || warnings.length) {
    body.append(h('details', { class: 'import-section', open: errors.length > 0 },
      h('summary', { text: `Validation (${errors.length} error${errors.length === 1 ? '' : 's'}, ${warnings.length} warning${warnings.length === 1 ? '' : 's'})` }),
      h('ul', {}, ...[...errors, ...warnings].slice(0, 200).map(i => h('li', { class: i.severity }, h('span', { class: `pill ${i.severity === 'error' ? 'bad' : 'warn'}`, text: i.severity === 'error' ? 'Error' : 'Warning' }), ` ${i.id}: ${i.message}`)))));
  }
  const conv = list('Simplified for the editor', s.conversion, false);
  if (conv) body.append(conv);
  const notes = list('Notes from the import', s.report.notes, false);
  if (notes) body.append(notes);
  if (s.report.classes.length) {
    const table = h('table', { class: 'import-classes' },
      h('thead', {}, h('tr', {}, h('th', { text: 'Class' }), h('th', { class: 'num', text: 'Count' }), h('th', { text: 'Use' }), h('th', { text: 'What it became' }))),
      h('tbody', {}, ...s.report.classes.map(c => h('tr', { class: c.status === 'not used' ? 'unused' : '' },
        h('td', { text: c.class }), h('td', { class: 'num', text: c.count.toLocaleString('en-GB') }),
        h('td', {}, h('span', { class: `pill ${c.status === 'not used' ? 'neutral' : 'ok'}`, text: c.status === 'not used' ? 'Not used' : c.status === 'used' ? 'Used' : 'Mapped' })),
        h('td', { text: c.detail })))));
    body.append(h('details', { class: 'import-section' }, h('summary', { text: `What was read (${s.report.files.length} file${s.report.files.length === 1 ? '' : 's'}, ${s.report.classes.length} classes)` }), table));
  }
  const title = names.length === 1 ? `Import ${names[0]}` : `Import ${names.length} files`;
  const r = await modal({ title, body, wide: true, actions: [{ label: 'Cancel', value: false }, { label: 'Open network', primary: true, value: true }] });
  return r === true;
}
