/** The command palette: fuzzy search over every command and every element of the network. */

import { h, esc } from './dom.js';
import { icon } from './icons.js';
import { kbd } from './keys.js';
import { CLASSES } from '../core/catalog.js';
import { CLASS_ICON } from './tree.js';

/** Subsequence match score: higher for matches at word starts and runs. Returns -1 when the query does not match.
 * @param {string} q lower-case query @param {string} text @returns {{ score: number, hits: number[] }} */
export function fuzzy(q, text) {
  const t = text.toLowerCase();
  if (!q) return { score: 0, hits: [] };
  let score = 0, ti = 0, run = 0;
  const hits = [];
  for (const ch of q) {
    const i = t.indexOf(ch, ti);
    if (i < 0) return { score: -1, hits: [] };
    const start = i === 0 || /[\s\-_./(]/.test(t[i - 1]);
    run = i === ti ? run + 1 : 0;
    score += 1 + (start ? 3 : 0) + run * 2 - Math.min(i - ti, 5) * 0.2;
    hits.push(i);
    ti = i + 1;
  }
  return { score: score - t.length * 0.01, hits };
}

/** @param {string} text @param {number[]} hits */
const mark = (text, hits) => [...text].map((c, i) => (hits.includes(i) ? `<mark>${esc(c)}</mark>` : esc(c))).join('');

/** @param {import('../app.js').App} app */
export function openPalette(app) {
  if (document.querySelector('.palette')) return;
  const previous = /** @type {HTMLElement | null} */ (document.activeElement);
  const input = h('input', { type: 'text', placeholder: 'Type a command or an element name', 'aria-label': 'Search commands and elements', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'palette-list', autocomplete: 'off', spellcheck: 'false' });
  const list = h('ul', { class: 'palette-list', id: 'palette-list', role: 'listbox' });
  const box = h('div', { class: 'palette', role: 'dialog', 'aria-label': 'Command palette' },
    h('div', { class: 'palette-input', html: icon('search', 18) }, input), list,
    h('div', { class: 'palette-foot', html: `<span>${kbd('ArrowUp')}${kbd('ArrowDown')} to move</span><span>${kbd('Enter')} to run</span><span>${kbd('Escape')} to close</span>` }));
  const scrim = h('div', { class: 'scrim', style: 'padding-top:14vh' }, box);
  /** @type {Array<{ label: string, icon: string, hint: string, group: string, run: () => void, enabled: boolean }>} */
  let items = [];
  let active = 0;
  const close = () => { scrim.remove(); previous?.focus?.(); };

  const build = () => {
    const q = input.value.trim().toLowerCase();
    /** @type {Array<{ label: string, icon: string, hint: string, group: string, run: () => void, enabled: boolean, score: number, hits: number[] }>} */
    const found = [];
    for (const c of app.commands.all.values()) {
      if (c.palette === false) continue;
      const label = `${c.group}: ${c.label}`;
      const m = fuzzy(q, label);
      if (m.score < 0) continue;
      found.push({ label, icon: c.icon ?? 'plus', hint: c.keys?.[0] ? kbd(c.keys[0]) : '', group: 'Commands', run: () => app.commands.run(c.id), enabled: c.enabled?.() ?? true, score: m.score, hits: m.hits });
    }
    if (q) {
      for (const el of app.store.doc.elements) {
        const label = `${el.name || el.id}`;
        const m = fuzzy(q, `${label} ${el.id}`);
        if (m.score < 0) continue;
        found.push({ label, icon: CLASS_ICON[el.cls], hint: esc(`${CLASSES[el.cls].label} · ${el.id}`), group: 'Elements',
          run: () => { app.setSelection([el.id]); app.viewport.reveal([el.id]); }, enabled: true, score: m.score + 0.5, hits: m.hits.filter(i => i < label.length) });
      }
    }
    found.sort((a, b) => (q ? b.score - a.score : a.group.localeCompare(b.group) || a.label.localeCompare(b.label)));
    items = found.slice(0, 60);
    active = 0;
    render(q);
  };

  /** @param {string} q */
  const render = q => {
    list.replaceChildren();
    if (!items.length) { list.append(h('li', { class: 'palette-empty', text: `Nothing matches “${q}”.` })); return; }
    let group = '';
    items.forEach((it, i) => {
      if (!q && it.group !== group) { group = it.group; list.append(h('li', { class: 'group', role: 'presentation', text: group })); }
      const li = h('li', { class: 'palette-item', role: 'option', id: `pal-${i}`, 'aria-selected': String(i === active), 'aria-disabled': String(!it.enabled),
        html: `${icon(it.icon, 16)}<span class="label">${q ? mark(it.label, items[i] && 'hits' in it ? /** @type {any} */ (it).hits : []) : esc(it.label)}</span><span class="hint">${it.hint}</span>` });
      li.addEventListener('pointermove', () => { if (active !== i) { active = i; sync(); } });
      li.addEventListener('click', () => choose(i));
      list.append(li);
    });
    input.setAttribute('aria-activedescendant', `pal-${active}`);
  };
  const sync = () => {
    for (const li of list.querySelectorAll('.palette-item')) li.setAttribute('aria-selected', String(li.id === `pal-${active}`));
    list.querySelector(`#pal-${active}`)?.scrollIntoView({ block: 'nearest' });
    input.setAttribute('aria-activedescendant', `pal-${active}`);
  };
  /** @param {number} i */
  const choose = i => {
    const it = items[i];
    if (!it || !it.enabled) return;
    close();
    it.run();
  };
  input.addEventListener('input', build);
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(items.length - 1, active + 1); sync(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); sync(); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(active); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  });
  scrim.addEventListener('pointerdown', e => { if (e.target === scrim) close(); });
  /** @type {HTMLElement} */ (document.getElementById('overlay-root')).append(scrim);
  build();
  input.focus();
}
