/** Keyboard shortcut parsing, matching and display. "Mod" is Cmd on Apple platforms and Ctrl elsewhere. */

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Canonical shortcut string for a keyboard event, e.g. "Mod+Shift+Z" or "Alt+L".
 * Letters and digits come from event.code so Alt combinations work on every layout. @param {KeyboardEvent} e */
export function eventKey(e) {
  let key = e.key;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (key === ' ') key = 'Space';
  else if (key.length === 1) key = key.toUpperCase();
  const parts = [];
  if (isMac ? e.metaKey : e.ctrlKey) parts.push('Mod');
  if (e.altKey) parts.push('Alt');
  // Shift is implied by printable symbols such as "?" and "+"; only record it for letters, digits and named keys.
  if (e.shiftKey && (key.length > 1 || /[A-Z0-9]/.test(key))) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

/** Human-readable shortcut. @param {string} combo */
export function showKey(combo) {
  return combo.split('+').map(p => {
    if (p === 'Mod') return isMac ? '⌘' : 'Ctrl';
    if (p === 'Alt') return isMac ? '⌥' : 'Alt';
    if (p === 'Shift') return isMac ? '⇧' : 'Shift';
    if (p === 'Enter') return isMac ? '↩' : 'Enter';
    if (p === 'Escape') return 'Esc';
    if (p === 'Delete') return isMac ? '⌦' : 'Del';
    if (p === 'Backspace') return isMac ? '⌫' : 'Backspace';
    if (p === 'ArrowUp') return '↑';
    if (p === 'ArrowDown') return '↓';
    if (p === 'ArrowLeft') return '←';
    if (p === 'ArrowRight') return '→';
    return p;
  });
}

/** Shortcut as <kbd> markup. @param {string} combo */
export const kbd = combo => showKey(combo).map(k => `<kbd>${k}</kbd>`).join(isMac ? '' : '');

/** True when typing in a field, where single-key shortcuts must not fire. @param {EventTarget | null} t */
export function isTyping(t) {
  const el = /** @type {HTMLElement | null} */ (t);
  if (!el || !el.tagName) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}
