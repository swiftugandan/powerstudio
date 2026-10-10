/** PowerStudio's icon set: original 24 × 24 stroke icons drawn for this app, plus the brand mark. */

/** @type {Record<string, string>} path data, stroked with currentColor */
const PATHS = {
  new: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M12 11v6M9 14h6',
  open: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  save: 'M5 3h11l3 3v13a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2zM8 3v5h7V3M8 21v-6h8v6',
  import: 'M12 3v12M7 10l5 5 5-5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2',
  export: 'M12 15V3M7 8l5-5 5 5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2',
  undo: 'M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  redo: 'm15 14 5-5-5-5M20 9H10a6 6 0 0 0 0 12h3',
  cut: 'M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8.2 16.2 19 3M15.8 16.2 5 3',
  copy: 'M9 9h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1zM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1',
  paste: 'M9 4h6v3H9zM9 5.5H6a1 1 0 0 0-1 1V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V6.5a1 1 0 0 0-1-1h-3M9 12h6M9 16h4',
  duplicate: 'M9 9h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1zM14 12v6M11 15h6M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1',
  delete: 'M4 7h16M10 11v6M14 11v6M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13M9 7V4h6v3',
  select: 'M5 3l13.5 7.2-6.1 1.7-2.9 6.1z',
  pan: 'M12 3v18M3 12h18M12 3 9.5 5.5M12 3l2.5 2.5M12 21l-2.5-2.5M12 21l2.5-2.5M3 12l2.5-2.5M3 12l2.5 2.5M21 12l-2.5-2.5M21 12l-2.5 2.5',
  fit: 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5',
  zoomIn: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4M11 8v6M8 11h6',
  zoomOut: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4M8 11h6',
  bus: 'M3 8h18M7 8v9M12 8v9M17 8v9',
  line: 'M3 5h7M14 19h7M6.5 5v7h11v7',
  trafo: 'M12 13.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zM12 19.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zM12 2v2.5M12 19.5V22',
  gen: 'M12 20a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM12 2v4M8.4 13c.9-1.9 1.9-1.9 2.7 0s1.8 1.9 2.7 0 1.8-1.9 2.7 0',
  extgrid: 'M5 3h14v9H5zM5 9l6-6M5 12l9-9M9 12l9-9M13 12l6-6M12 12v9',
  load: 'M12 3v11M7 12l5 7 5-7z',
  shunt: 'M12 3v7M7 10h10M7 13.5h10M12 13.5V17M8 17h8M9.5 19.5h5M11 22h2',
  loadflow: 'M3 8h14M14 5l3 3-3 3M21 16H7M10 13l-3 3 3 3',
  shortcircuit: 'M13 2 5 14h6l-1 8 8-12h-6z',
  contingency: 'M4 6h5M15 6h5M6.5 6v12M17.5 6v12M4 18h5M15 18h5M10 10l4 4M14 10l-4 4',
  rms: 'M2 12h3l2.5-6 3.5 12 3-9 2 4h6',
  settings: 'M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1M15 4v4M9 10v4M17 16v4',
  results: 'M4 5h16v14H4zM4 10h16M4 14.5h16M10 10v9',
  names: 'M5 7V5h14v2M12 5v14M9 19h6',
  boxes: 'M3 6h8v5H3zM13 13h8v5h-8zM11 8.5h3a1.5 1.5 0 0 1 1.5 1.5v3',
  disentangle: 'M2 3h8v5H2zM14 16h8v5h-8zM6 8v3.5M18 16v-3.5M6 11.5h12',
  resetLabels: 'M3 12a9 9 0 1 0 2.6-6.4M3 4v4.5h4.5M9 10h6v4H9z',
  colour: 'M12 21a9 9 0 1 1 9-9c0 2-1.5 3-3 3h-2a2 2 0 0 0-1 3.7A1.5 1.5 0 0 1 12 21zM7.5 11.5h.01M10 7.5h.01M15 7.5h.01',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5h.01',
  keyboard: 'M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M7 14h10',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
  layout: 'M4 4h6v5H4zM14 15h6v5h-6zM10 6.5h4a2 2 0 0 1 2 2V15',
  alignLeft: 'M4 3v18M8 7h10M8 12h6M8 17h12',
  alignCentre: 'M12 3v18M6 7h12M8 12h8M5 17h14',
  alignRight: 'M20 3v18M6 7h10M10 12h6M4 17h12',
  alignTop: 'M3 4h18M7 8v10M12 8v6M17 8v12',
  alignMiddle: 'M3 12h18M7 6v12M12 8v8M17 5v14',
  alignBottom: 'M3 20h18M7 6v10M12 10v6M17 4v12',
  distributeH: 'M3 4v16M21 4v16M8 9h3v6H8zM13 9h3v6h-3z',
  distributeV: 'M4 3h16M4 21h16M9 8h6v3H9zM9 13h6v3H9z',
  sameLength: 'M5 8h14M5 16h14M3 5v6M21 5v6M3 13v6M21 13v6',
  rotate: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v4.5h-4.5M8 12h8',
  flip: 'M12 3v18M8 7l-4 5 4 5M16 7l4 5-4 5',
  spread: 'M3 12h18M6 12V7M12 12V7M18 12V7M9 12v5M15 12v5',
  selectConnected: 'M4 12h16M8 12V6M16 12V6M12 12v6M8 4.5h.01M16 4.5h.01M12 19.5h.01',
  selectClass: 'M4 5h6v6H4zM14 5h6v6h-6zM4 15h6v4H4zM14 15h6v4h-6z',
  selectLevel: 'M3 7h18M3 12h12M3 17h6',
  straighten: 'M4 18V6M20 18V6M4 12h16',
  routeAround: 'M4 20v-6h5V6h11M14 10h4v4h-4z',
  zoomSelection: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM20 20l-4.8-4.8M8 8.5h5v4H8z',
  overview: 'M3 5h18v14H3zM12 11h7v6h-7z',
  grid: 'M4 4h.01M12 4h.01M20 4h.01M4 12h.01M12 12h.01M20 12h.01M4 20h.01M12 20h.01M20 20h.01',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v6M12 7.5h.01',
  warning: 'M12 3 2 20h20zM12 10v4M12 17h.01',
  error: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9 9l6 6M15 9l-6 6',
  check: 'm5 12 4.5 4.5L19 7',
  close: 'M6 6l12 12M18 6 6 18',
  chevronRight: 'm9 6 6 6-6 6',
  chevronDown: 'm6 9 6 6 6-6',
  play: 'M7 4v16l13-8z',
  stop: 'M6 6h12v12H6z',
  csv: 'M4 4h16v16H4zM4 9h16M9 9v11M14 13l2 2 2-2M16 9v6',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 2-2 5 5M15.5 9.5h.01',
  sample: 'M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4A2 2 0 0 0 19 18l-5-9V3M7.5 14h9',
  power: 'M12 3v8M7.5 6.5a7 7 0 1 0 9 0',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  panelLeft: 'M4 4h16v16H4zM9 4v16',
  panelRight: 'M4 4h16v16H4zM15 4v16',
  panelBottom: 'M4 4h16v16H4zM4 15h16',
  locate: 'M12 19a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM12 2v3M12 19v3M2 12h3M19 12h3M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
  layers: 'M12 3 3 7.5l9 4.5 9-4.5zM3 12l9 4.5 9-4.5M3 16.5 12 21l9-4.5',
  history: 'M3.5 12a8.5 8.5 0 1 0 2.5-6M3.5 3.5V8H8M12 7.5V12l3 2',
  record: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z',
  database: 'M12 8c4.4 0 8-1.3 8-3s-3.6-3-8-3-8 1.3-8 3 3.6 3 8 3zM4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  github: 'M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21',
  menu: 'M4 7h16M4 12h16M4 17h16',
  arrange: 'M5 4v16M19 4v16M9 8h6M9 16h6M12 8v8',
};

/** @param {string} name @param {number} [size] @returns {string} SVG markup */
export function icon(name, size = 18) {
  const d = PATHS[name];
  if (!d) throw new Error(`Unknown icon ${name}`);
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
}

/** The PowerStudio mark: a busbar feeding a sine wave on a rounded tile. @param {number} [size] */
export function logo(size = 22) {
  return `<svg class="logo" width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true">`
    + '<rect x="1" y="1" width="30" height="30" rx="8" fill="var(--accent)"/>'
    + '<path d="M8 10.5h16" stroke="var(--on-accent)" stroke-width="3" stroke-linecap="round"/>'
    + '<path d="M12 10.5v4M20 10.5v4" stroke="var(--on-accent)" stroke-width="2" stroke-linecap="round"/>'
    + '<path d="M7.5 21.5c1.9-3.6 3.8-3.6 5.6 0s3.7 3.6 5.6 0 3.7-3.6 5.6 0" fill="none" stroke="var(--on-accent)" stroke-width="2.2" stroke-linecap="round"/>'
    + '</svg>';
}

/** Icon names in use, for the build's sanity checks and the icon gallery in docs. */
export const ICON_NAMES = Object.keys(PATHS);
