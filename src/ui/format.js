/** Number formatting for engineering values: fixed decimals, a true minus sign, thin grouping. */

const MINUS = '−';

/** @param {number} v @param {number} [digits] */
export function fixed(v, digits = 2) {
  if (!Number.isFinite(v)) return '—';
  const s = Math.abs(v) < 0.5 * 10 ** -digits ? (0).toFixed(digits) : v.toFixed(digits);
  return s.startsWith('-') ? MINUS + s.slice(1) : s;
}

/** Value for an input field: full precision without float noise. @param {number} v */
export function editable(v) {
  if (!Number.isFinite(v)) return '';
  return String(Number(v.toPrecision(12)));
}

/** Parses user input, accepting a Unicode minus and a decimal comma. @param {string} s */
export function parseNumber(s) {
  const t = s.trim().replace(MINUS, '-').replace(',', '.');
  if (!t) return NaN;
  return Number(t);
}

/** @param {number} ms */
export function duration(ms) {
  return ms < 1000 ? `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

/** @param {number} t epoch ms */
export function clock(t) {
  const d = new Date(t);
  return d.toTimeString().slice(0, 8);
}

/** @param {number} t epoch ms */
export function relative(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
}

/** A count with its noun, grouped: "1,234 busbars". @param {number} n @param {string} one @param {string} [many] */
export function count(n, one, many = `${one}s`) {
  return `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`;
}

const SUPER = '⁻⁰¹²³⁴⁵⁶⁷⁸⁹';

/** A small difference in scientific notation: "3.2 × 10⁻¹⁴". @param {number} x */
export function scientific(x) {
  if (!Number.isFinite(x)) return '—';
  if (x === 0) return '0';
  const [m, e] = x.toExponential(1).split('e');
  return `${m} × 10${[...String(Number(e))].map(c => SUPER['-0123456789'.indexOf(c)]).join('')}`;
}

/** A file size: "512 bytes", "2.4 KB", "18.1 MB". @param {number} bytes */
export function fileSize(bytes) {
  if (bytes < 1000) return `${bytes} bytes`;
  if (bytes < 1e6) return `${(bytes / 1e3).toFixed(1)} KB`;
  return `${(bytes / 1e6).toFixed(1)} MB`;
}
