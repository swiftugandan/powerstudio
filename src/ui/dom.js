/** Small DOM helpers. */

/** @param {string} s */
export const esc = s => String(s).replace(/[&<>"']/g, c => /** @type {Record<string, string>} */ ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * Creates an element. Attributes starting with "on" become listeners; `html` sets innerHTML; `text` sets textContent.
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag @param {Record<string, any>} [attrs] @param {...(Node | string | null | undefined | false)} children
 * @returns {HTMLElementTagNameMap[K]}
 */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

/** @param {string} id */
export const byId = id => /** @type {HTMLElement} */ (document.getElementById(id));

/** Triggers a download of a Blob. @param {Blob} blob @param {string} filename */
export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A file name from a document name. @param {string} name @param {string} ext */
export const fileName = (name, ext) => `${(name || 'network').replace(/[^\p{L}\p{N}\- _.]+/gu, '').trim().replace(/\s+/g, '-') || 'network'}${ext}`;

/** Lets the browser handle input and draw a frame before the caller goes on. Animation frames stop in hidden tabs,
 * so a timer stands in after 100 ms. @returns {Promise<void>} */
export function yieldToBrowser() {
  return new Promise(resolve => {
    let done = false;
    const go = () => { if (!done) { done = true; resolve(); } };
    requestAnimationFrame(() => setTimeout(go, 0));
    setTimeout(go, 100);
  });
}
