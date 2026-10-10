/** Toasts, context menus and modal dialogs. */

import { h, esc } from './dom.js';
import { icon } from './icons.js';

const root = () => /** @type {HTMLElement} */ (document.getElementById('overlay-root'));

/** @type {HTMLElement | null} */
let toastHost = null;

/** A short notification in the corner. @param {'ok' | 'info' | 'warn' | 'error'} kind @param {string} text
 * @param {{ title?: string, action?: { label: string, run: () => void }, ms?: number }} [opt] */
export function toast(kind, text, opt = {}) {
  if (!toastHost) { toastHost = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }); root().append(toastHost); }
  const iconName = kind === 'ok' ? 'check' : kind === 'error' ? 'error' : kind === 'warn' ? 'warning' : 'info';
  const el = h('div', { class: `toast ${kind}` }, h('span', { html: icon(iconName, 18) }),
    h('div', { class: 'body' }, opt.title ? h('div', { class: 'title', text: opt.title }) : null, h('div', { class: opt.title ? 'text' : '', text })));
  if (opt.action) {
    const a = opt.action;
    /** @type {HTMLElement} */ (el.querySelector('.body')).append(h('button', { type: 'button', class: 'link', text: a.label, onclick: () => { a.run(); el.remove(); } }));
  }
  toastHost.append(el);
  setTimeout(() => el.remove(), opt.ms ?? (kind === 'error' ? 8000 : 4200));
}

/** @typedef {{ label: string, icon?: string, hint?: string, run: () => void, disabled?: boolean, danger?: boolean } | 'separator'} MenuItem */

/** A context menu at a screen position. @param {number} x @param {number} y @param {MenuItem[]} items */
export function contextMenu(x, y, items) {
  closeMenus();
  const menu = h('div', { class: 'menu', role: 'menu' });
  for (const it of items) {
    if (it === 'separator') { menu.append(h('hr')); continue; }
    const b = h('button', { type: 'button', role: 'menuitem', class: it.danger ? 'danger' : '', disabled: it.disabled,
      html: `${it.icon ? icon(it.icon, 16) : '<span style="width:16px"></span>'}<span>${esc(it.label)}</span>${it.hint ? `<span class="hint">${esc(it.hint)}</span>` : ''}` });
    b.addEventListener('click', () => { closeMenus(); it.run(); });
    menu.append(b);
  }
  root().append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
  menu.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
  /** @type {HTMLElement | null} */ (menu.querySelector('button:not(:disabled)'))?.focus();
  const close = (/** @type {Event} */ e) => {
    if (e.type === 'keydown') {
      const k = /** @type {KeyboardEvent} */ (e).key;
      if (k === 'ArrowDown' || k === 'ArrowUp') {
        const bs = [...menu.querySelectorAll('button:not(:disabled)')], i = bs.indexOf(/** @type {Element} */ (document.activeElement));
        /** @type {HTMLElement} */ (bs[(i + (k === 'ArrowDown' ? 1 : bs.length - 1)) % bs.length]).focus();
        e.preventDefault();
        return;
      }
      if (k !== 'Escape') return;
    } else if (menu.contains(/** @type {Node} */ (e.target))) return;
    closeMenus();
  };
  setTimeout(() => {
    document.addEventListener('pointerdown', close, true);
    document.addEventListener('keydown', close, true);
    window.addEventListener('blur', close);
  });
  menuCleanup = () => { document.removeEventListener('pointerdown', close, true); document.removeEventListener('keydown', close, true); window.removeEventListener('blur', close); };
}

let menuCleanup = () => {};
export function closeMenus() { menuCleanup(); menuCleanup = () => {}; for (const m of document.querySelectorAll('.menu')) m.remove(); }

/**
 * A modal dialog. Resolves with the value passed to close(), or null when dismissed.
 * @template T
 * @param {{ title: string, body: HTMLElement, wide?: boolean, actions: Array<{ label: string, primary?: boolean, danger?: boolean, left?: boolean, value?: T, run?: () => T | null | undefined }> }} spec
 * @returns {Promise<T | null>}
 */
export function modal(spec) {
  return new Promise(resolve => {
    const previous = /** @type {HTMLElement | null} */ (document.activeElement);
    const scrim = h('div', { class: 'scrim' });
    const titleId = `dlg-${Math.random().toString(36).slice(2, 8)}`;
    const left = h('div', { class: 'left' });
    const foot = h('div', { class: 'dialog-foot' }, left);
    const dialog = h('div', { class: `dialog${spec.wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
      h('div', { class: 'dialog-head' }, h('h2', { id: titleId, text: spec.title }),
        h('button', { type: 'button', class: 'icon-btn sm', 'aria-label': 'Close', html: icon('close', 16), onclick: () => done(null) })),
      h('div', { class: 'dialog-body' }, spec.body), foot);
    /** @param {T | null} v */
    const done = v => { scrim.remove(); document.removeEventListener('keydown', onKey, true); previous?.focus?.(); resolve(v); };
    for (const a of spec.actions) {
      const b = h('button', { type: 'button', class: `btn${a.primary ? ' primary' : ''}${a.danger ? ' danger' : ''}`, text: a.label });
      b.addEventListener('click', () => {
        if (a.run) { const v = a.run(); if (v !== null && v !== undefined) done(v); }
        else done(a.value ?? null);
      });
      (a.left ? left : foot).append(b);
    }
    /** @param {KeyboardEvent} e */
    const onKey = e => {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); done(null); }
      if (e.key === 'Tab') {
        const f = [...dialog.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(x => !(/** @type {HTMLButtonElement} */ (x).disabled));
        const first = /** @type {HTMLElement} */ (f[0]), last = /** @type {HTMLElement} */ (f[f.length - 1]);
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey, true);
    scrim.addEventListener('pointerdown', e => { if (e.target === scrim) done(null); });
    scrim.append(dialog);
    root().append(scrim);
    /** @type {HTMLElement | null} */ (dialog.querySelector('.dialog-body input, .dialog-body select, .dialog-foot .primary'))?.focus();
  });
}

/** @param {string} title @param {string} text @param {string} confirmLabel @returns {Promise<boolean>} */
export async function confirm(title, text, confirmLabel) {
  const r = await modal({ title, body: h('p', { text }), actions: [{ label: 'Cancel', value: false }, { label: confirmLabel, primary: true, value: true }] });
  return r === true;
}

/**
 * Asks for a passphrase. With `twice`, for a new file: it must be typed again and be at least `min` characters long.
 * Resolves with the passphrase, or null when dismissed.
 * @param {{ title: string, lead: string, action: string, twice?: boolean, min?: number }} spec
 * @returns {Promise<string | null>}
 */
export function askPassphrase(spec) {
  const field = (/** @type {string} */ id, /** @type {string} */ label) => {
    const input = /** @type {HTMLInputElement} */ (h('input', { id, class: 'input', type: 'password', autocomplete: spec.twice ? 'new-password' : 'current-password', spellcheck: 'false' }));
    return { input, row: [h('label', { for: id, text: label }), h('div', { class: 'field' }, input)] };
  };
  const first = field('pass-1', 'Passphrase'), second = spec.twice ? field('pass-2', 'Type it again') : null;
  const error = h('div', { class: 'field-error', role: 'alert', hidden: true });
  const body = h('div', {}, h('p', { class: 'lead', text: spec.lead }),
    h('div', { class: 'props' }, ...first.row, ...(second ? second.row : [])), error);
  /** @returns {string | null} */
  const check = () => {
    const v = first.input.value;
    const problem = spec.twice && v.length < (spec.min ?? 0) ? `Use at least ${spec.min} characters; a few unrelated words are easiest to remember.`
      : second && v !== second.input.value ? 'The two passphrases differ.'
        : !v ? 'Type the passphrase.' : '';
    error.textContent = problem;
    error.hidden = !problem;
    return problem ? null : v;
  };
  const submit = modal({ title: spec.title, body, actions: [{ label: 'Cancel', value: null }, { label: spec.action, primary: true, run: check }] });
  // Enter in a field submits, as the primary button would.
  for (const f of [first, second]) {
    f?.input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); /** @type {HTMLButtonElement | null} */ (body.closest('.dialog')?.querySelector('.dialog-foot .primary') ?? null)?.click(); }
    });
  }
  return submit;
}
