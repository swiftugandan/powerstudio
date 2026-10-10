/** Riverside: a fictional 110/20/0.4 kV distribution network for short-circuit and voltage studies.
 *
 * Two 40 MVA primary transformers feed a 20 kV busbar with a cable ring and an overhead feeder. A 10 MVA combined
 * heat and power unit sits behind its own transformer at Hilltop, and a 630 kVA secondary substation supplies a
 * 0.4 kV busbar. The equipment data are typical catalogue values for this kind of network; the network itself is
 * invented. */

import { makeElement } from '../core/catalog.js';
import { emptyDocument } from '../core/document.js';

/** @typedef {import('../core/document.js').PowerDocument} PowerDocument */

/** @returns {PowerDocument} */
export function riverside() {
  const doc = emptyDocument('Riverside distribution');
  doc.description = 'A fictional 110/20/0.4 kV distribution network with a meshed 20 kV cable ring, an overhead feeder, a CHP unit and a secondary substation. Equipment data are typical catalogue values.';
  const E = /** @type {(cls: import('../core/catalog.js').ElementClass, id: string, v: Record<string, unknown>) => void} */
    ((cls, id, v) => { doc.elements.push(makeElement(cls, id, v)); });

  E('bus', 'B1', { name: 'Riverside 110 kV', vn: 110, x: 0, y: -380, len: 240, vmin: 0.95, vmax: 1.1, zone: '110 kV' });
  E('bus', 'B2', { name: 'Riverside 20 kV', vn: 20, x: 0, y: -140, len: 480, vmin: 0.97, vmax: 1.05, zone: '20 kV' });
  E('bus', 'B3', { name: 'Mill Lane', vn: 20, x: -360, y: 120, len: 160, vmin: 0.95, vmax: 1.05, zone: '20 kV' });
  E('bus', 'B4', { name: 'Station Road', vn: 20, x: -360, y: 380, len: 160, vmin: 0.95, vmax: 1.05, zone: '20 kV' });
  E('bus', 'B5', { name: 'Hilltop', vn: 20, x: 400, y: 120, len: 180, vmin: 0.95, vmax: 1.05, zone: '20 kV' });
  E('bus', 'B6', { name: 'Hilltop CHP 6.3 kV', vn: 6.3, x: 680, y: 120, len: 120, vmin: 0.95, vmax: 1.05, zone: 'Generation' });
  E('bus', 'B7', { name: 'Brook Farm', vn: 20, x: 400, y: 380, len: 160, vmin: 0.95, vmax: 1.05, zone: '20 kV' });
  E('bus', 'B8', { name: 'Market Street 0.4 kV', vn: 0.4, x: 0, y: 380, len: 160, vmin: 0.9, vmax: 1.1, zone: '0.4 kV' });
  E('bus', 'B9', { name: 'Market Street 20 kV', vn: 20, x: 0, y: 120, len: 160, vmin: 0.95, vmax: 1.05, zone: '20 kV' });

  E('extgrid', 'X1', { name: 'Grid infeed', bus: 'B1', vset: 1.02, angle: 0, skMax: 3000, skMin: 2000, rxMax: 0.1, rxMin: 0.12, x0x1: 1.0, r0x0: 0.1, pos: 0, side: 'above' });

  const primary = { sn: 40, vnHV: 110, vnLV: 20, uk: 12, ur: 0.4, i0: 0.05, pfe: 20, vectorGroup: 'YNyn0', uk0: 12, ur0: 0.4,
    tapStep: 1.25, tapPos: 0, tapNeutral: 0, tapMin: -9, tapMax: 9 };
  E('trafo', 'T1', { ...primary, name: 'Primary transformer 1', hv: 'B1', lv: 'B2', hvPos: -0.3, lvPos: -0.15 });
  E('trafo', 'T2', { ...primary, name: 'Primary transformer 2', hv: 'B1', lv: 'B2', hvPos: 0.3, lvPos: 0.15 });
  E('trafo', 'T3', { name: 'CHP unit transformer', hv: 'B5', lv: 'B6', sn: 12.5, vnHV: 20, vnLV: 6.3, uk: 8, ur: 0.6, i0: 0.2, pfe: 8,
    vectorGroup: 'YNd5', uk0: 8, ur0: 0.6, tapStep: 2.5, tapPos: 0, tapNeutral: 0, tapMin: -2, tapMax: 2, hvPos: 0.5, lvPos: -0.5, bend: 60 });
  E('trafo', 'T4', { name: 'Market Street transformer', hv: 'B9', lv: 'B8', sn: 0.63, vnHV: 20, vnLV: 0.4, uk: 6, ur: 1.03, i0: 0.3, pfe: 1.0,
    vectorGroup: 'Dyn5', uk0: 6, ur0: 1.03, tapStep: 2.5, tapPos: 0, tapNeutral: 0, tapMin: -2, tapMax: 2, hvPos: 0, lvPos: 0 });

  // 20 kV XLPE cable, 3 × 1 × 240 mm² Al: R′ 0.125 Ω/km, X′ 0.11 Ω/km, C′ 0.4 µF/km → B′ = 2π·50·0.4 = 125.7 µS/km.
  const cable = { r1: 0.125, x1: 0.11, b1: 125.66, r0: 0.5, x0: 0.33, b0: 125.66, ratedA: 0.42, parallel: 1 };
  // 20 kV overhead line, Al/St 95/15: R′ 0.306 Ω/km, X′ 0.35 Ω/km, B′ 3.3 µS/km.
  const overhead = { r1: 0.306, x1: 0.35, b1: 3.3, r0: 0.46, x0: 1.25, b0: 1.5, ratedA: 0.33, parallel: 1 };
  E('line', 'L1', { ...cable, name: 'Cable Riverside–Mill Lane', from: 'B2', to: 'B3', length: 4.2, fromPos: -0.45, toPos: 0.3 });
  E('line', 'L2', { ...cable, name: 'Cable Mill Lane–Station Road', from: 'B3', to: 'B4', length: 2.6, fromPos: -0.2, toPos: -0.2 });
  E('line', 'L3', { ...cable, name: 'Cable Station Road–Market Street', from: 'B4', to: 'B9', length: 3.1, fromPos: 0.3, toPos: -0.35 });
  E('line', 'L4', { ...cable, name: 'Cable Market Street–Riverside', from: 'B9', to: 'B2', length: 1.8, fromPos: 0.3, toPos: 0 });
  E('line', 'L5', { ...overhead, name: 'Overhead line Riverside–Hilltop', from: 'B2', to: 'B5', length: 9.5, fromPos: 0.45, toPos: -0.3 });
  E('line', 'L6', { ...overhead, name: 'Overhead line Hilltop–Brook Farm', from: 'B5', to: 'B7', length: 6.4, fromPos: 0, toPos: 0 });

  E('gen', 'G1', { name: 'Hilltop CHP', bus: 'B6', mode: 'PV', p: 8, q: 0, vset: 1.02, qmin: -4, qmax: 6, sn: 10, vn: 6.3, cosphi: 0.8,
    xdss: 0.14, rs: 0.006, xdt: 0.22, h: 2.8, damping: 0, pos: 0, side: 'above' });
  E('load', 'D1', { name: 'Mill Lane load', bus: 'B3', p: 6.5, q: 2.1, pos: 0.2, side: 'below' });
  E('load', 'D2', { name: 'Station Road load', bus: 'B4', p: 4.8, q: 1.6, pos: 0.25, side: 'below' });
  E('load', 'D3', { name: 'Hilltop village', bus: 'B5', p: 3.2, q: 1.0, pos: 0.3, side: 'below' });
  E('load', 'D4', { name: 'Brook Farm load', bus: 'B7', p: 2.4, q: 0.9, pos: 0.25, side: 'below' });
  E('load', 'D5', { name: 'Market Street shops', bus: 'B8', p: 0.42, q: 0.14, pos: 0, side: 'below' });
  E('load', 'D6', { name: 'Industrial estate', bus: 'B2', p: 9.0, q: 3.6, pos: -0.42, side: 'above' });
  E('shunt', 'S1', { name: 'Capacitor bank', bus: 'B2', q: 3, p: 0, vn: 20, pos: 0.42, side: 'above' });

  doc.study.shortcircuit.location = 'B5';
  doc.study.rms = { ...doc.study.rms, tEnd: 2, dt: 0.005, events: [
    { t: 0.1, kind: 'fault', target: 'B5' },
    { t: 0.25, kind: 'clear', target: 'B5' },
  ] };
  return doc;
}
