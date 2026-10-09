/** The command registry. Ribbon buttons, the command palette, context menus and keyboard shortcuts all run commands
 * by id, so each action is defined once with its label, icon, shortcut and enabled state. */

import { eventKey, isTyping } from './keys.js';

/**
 * @typedef {{ id: string, label: string, icon?: string, keys?: string[], group: string, hint?: string,
 *   run: () => unknown, enabled?: () => boolean, pressed?: () => boolean, palette?: boolean, global?: boolean, keywords?: string }} Command
 */

export class Commands {
  constructor() {
    /** @type {Map<string, Command>} */
    this.all = new Map();
    /** @type {Map<string, string>} key combo → command id */
    this.keymap = new Map();
    /** @type {Set<() => void>} */
    this.listeners = new Set();
  }

  /** @param {Command} cmd */
  add(cmd) {
    this.all.set(cmd.id, cmd);
    for (const k of cmd.keys ?? []) this.keymap.set(k, cmd.id);
  }

  /** @param {string} id */
  get(id) { return this.all.get(id); }

  /** @param {string} id */
  isEnabled(id) { const c = this.all.get(id); return !!c && (c.enabled?.() ?? true); }

  /** Runs a command if it is enabled. @param {string} id */
  run(id) {
    const c = this.all.get(id);
    if (!c || !(c.enabled?.() ?? true)) return false;
    const r = c.run();
    if (r instanceof Promise) r.finally(() => this.changed());
    this.changed();
    return true;
  }

  /** Tells listeners (ribbon, palette) that enabled or pressed states may have changed. */
  changed() { for (const fn of this.listeners) fn(); }

  /** Routes a keydown to a command. Single keys and Shift+key never fire while typing; Mod and Alt combos do only
   * when the command is marked global. @param {KeyboardEvent} e */
  handleKey(e) {
    const combo = eventKey(e);
    const id = this.keymap.get(combo);
    if (!id) return false;
    const cmd = /** @type {Command} */ (this.all.get(id));
    const typing = isTyping(e.target);
    const modified = combo.includes('Mod+') || combo.includes('Alt+');
    if (typing && !(modified && cmd.global) && combo !== 'Escape') return false;
    if (typing && combo === 'Escape') return false;
    e.preventDefault();
    this.run(id);
    return true;
  }
}
