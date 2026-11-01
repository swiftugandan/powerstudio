/** The PSS/E RAW export dialog: the version to write, then what the engine wrote and how the file read back, before
 * it is saved. The engine writes the file as soon as the dialog opens and again when the version changes, so the check
 * the user sees is always the one of the file they save. */

import { h } from './dom.js';
import { modal } from './feedback.js';
import { count, fileSize, fixed, scientific } from './format.js';
import { RAW_VERSIONS } from '../engine/exchange.js';

/**
 * @typedef {import('../engine/reports.js').RawExportSummary} RawExportSummary
 * @typedef {{ summary: RawExportSummary, text: string }} RawExport
 * @typedef {33 | 35} RawVersion
 */

/** What each version is for, under the switch. */
const VERSION_HINT = /** @type {Record<RawVersion, string>} */ ({
  33: 'Version 33 is the one most tools read.',
  35: 'Version 35 for PSS/E 35 and later. It adds the system-wide data section.',
});

/** How the written file read back, as a status line. @param {RawExportSummary} s */
export function rawCheckLine(s) {
  const c = s.check;
  if (!c.read) return { kind: 'bad', pill: 'Failed', text: `The written file does not read back as RAW: ${c.message}` };
  if (!s.solved) {
    return { kind: 'warn', pill: 'Check', text: `The network’s load flow does not converge (${s.message}), so the file starts from flat voltages and its solution could not be checked. It reads back as a RAW file.` };
  }
  if (!c.solved) return { kind: 'bad', pill: 'Differs', text: `The file reads back but ${c.message.replace(/^the written file /, 'it ')}.` };
  if (c.missing > 0) return { kind: 'bad', pill: 'Differs', text: `${count(c.missing, 'busbar')} of the network ${c.missing === 1 ? 'has' : 'have'} no voltage when the file is solved, first at ${c.worst}.` };
  if (c.maxDv <= 1e-6 && c.maxDa <= 1e-4) {
    const all = c.compared === 1 ? 'its busbar keeps its voltage' : `all ${count(c.compared, 'busbar')} keep their voltage`;
    const within = c.maxDv === 0 && c.maxDa === 0 ? 'exactly' : `within ${scientific(Math.max(c.maxDv, 1e-15))} p.u.`;
    return { kind: 'ok', pill: 'Verified', text: `Read back and solved again, the file reproduces the network’s load flow: ${all} ${within}` };
  }
  return { kind: 'warn', pill: 'Check', text: `Read back and solved again, the file differs from the network’s load flow by up to ${fixed(c.maxDv, 4)} p.u. (${fixed(c.maxDa, 2)}°), at ${c.worst}. The notes below say what the file approximates.` };
}

/**
 * Asks for a RAW version, writes the file with `write` and shows how it read back. Resolves with the export to save,
 * or null when the user closes the dialog.
 * @param {{ name: string, write: (rev: RawVersion) => Promise<RawExport> }} spec
 * @returns {Promise<RawExport | null>}
 */
export function exportRawDialog(spec) {
  /** @type {RawVersion} */
  let rev = RAW_VERSIONS[0];
  /** @type {RawExport | null} */
  let current = null;
  let token = 0;

  const seg = h('div', { class: 'seg', role: 'group', 'aria-labelledby': 'raw-version-label' });
  const hint = h('p', { class: 'export-hint', id: 'raw-version-hint' });
  const result = h('div', { class: 'export-result', 'aria-live': 'polite' });
  const body = h('div', { class: 'import export-raw' },
    h('p', { text: 'The network as the active study case composes it, as a bus-branch PSS/E RAW file for tools that read RAW, such as PSS/E, PowerFactory and PowSyBl. Its voltages are those of a load flow with taps, shunt sections and reactive outputs where they are, without the study case’s controls.' }),
    h('div', { class: 'export-version' }, h('span', { class: 'label', id: 'raw-version-label', text: 'Version' }), seg),
    hint, result,
    h('p', { class: 'import-note', text: 'Not written: dynamic models (DYR), sequence data for short circuit, the diagram, study case settings and results other than voltages.' }));

  /** @param {boolean} on */
  const ready = on => {
    const save = /** @type {HTMLButtonElement | null} */ (body.closest('.dialog')?.querySelector('.dialog-foot .primary') ?? null);
    if (save) save.disabled = !on;
  };

  const showVersion = () => {
    seg.replaceChildren(...RAW_VERSIONS.map(v => h('button', { type: 'button', 'aria-pressed': String(v === rev), 'aria-describedby': 'raw-version-hint', text: String(v),
      onclick: () => { if (v !== rev) { rev = v; showVersion(); void run(); } } })));
    hint.textContent = VERSION_HINT[rev];
  };

  /** @param {RawExport} x */
  const showResult = x => {
    const s = x.summary, line = rawCheckLine(s);
    /** @param {string} title @param {string[]} items @param {boolean} open */
    const list = (title, items, open) => items.length
      ? h('details', { class: 'import-section', open }, h('summary', { text: `${title} (${items.length})` }), h('ul', {}, ...items.slice(0, 200).map(t => h('li', { text: t }))))
      : null;
    result.replaceChildren(
      h('p', { class: 'import-lead', text: `PSS/E ${s.rev} · ${count(s.buses, 'bus', 'buses')} · ${fileSize(new Blob([x.text]).size)}${s.solved ? ` · load flow in ${count(s.iterations, 'iteration')}` : ''}` }),
      h('div', { class: `import-status ${line.kind}`, role: 'status' }, h('span', { class: `pill ${line.kind}`, text: line.pill }), h('span', { text: line.text })),
      ...[list('What the file approximates', s.notes, line.kind !== 'ok'), list('Issues in the network', s.issues, false)].filter(e => e !== null));
  };

  const run = async () => {
    const mine = ++token;
    current = null;
    ready(false);
    result.replaceChildren(h('div', { class: 'import-status', role: 'status' }, h('span', { class: 'pill neutral', text: 'Writing' }), h('span', { text: `Writing version ${rev} and reading it back…` })));
    try {
      const x = await spec.write(rev);
      if (mine !== token) return;
      current = x;
      showResult(x);
      ready(x.summary.check.read);
    } catch (error) {
      if (mine !== token) return;
      result.replaceChildren(h('div', { class: 'import-status bad', role: 'alert' }, h('span', { class: 'pill bad', text: 'Failed' }), h('span', { text: `The RAW file could not be written: ${error instanceof Error ? error.message : error}` })));
    }
  };

  showVersion();
  const chosen = modal({ title: `Export ${spec.name} as PSS/E RAW`, body, wide: true,
    actions: [{ label: 'Cancel', value: null }, { label: 'Save file', primary: true, run: () => current }] });
  // The version switch takes the focus: the save button waits for the file.
  /** @type {HTMLElement | null} */ (seg.querySelector('[aria-pressed="true"]'))?.focus();
  void run();
  return chosen.then(v => { token++; return v ?? null; });
}
