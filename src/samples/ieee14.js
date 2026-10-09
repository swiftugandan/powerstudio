/** The IEEE 14-bus test system as an engineering model.
 *
 * Series impedances, charging, loads, setpoints and transformer ratios are the per-unit data of MATPOWER's case14
 * (from the University of Washington archive of the IEEE Common Data Format), converted exactly: a load flow of this
 * document matches MATPOWER to machine precision (tests/loadflow.test.mjs). Nominal voltages, line lengths, ratings,
 * transformer sizes and every machine's short-circuit and dynamic data are not part of the IEEE data. They are assumed,
 * typical values, chosen so that the short-circuit, contingency and stability studies have something realistic to
 * work on. The document description says so too. */

import { makeElement } from '../core/catalog.js';
import { emptyDocument } from '../core/document.js';

/** @typedef {import('../core/document.js').PowerDocument} PowerDocument */

const SB = 100;
const HV = 132, LV = 33, TV = 11;

/** @returns {PowerDocument} */
export function ieee14() {
  const doc = emptyDocument('IEEE 14-bus system');
  doc.description = 'Load flow data of the IEEE 14-bus test system (MATPOWER case14). Line lengths, ratings, transformer sizes and machine data are assumed typical values, not part of the IEEE data.';
  /** @type {Array<[number, string, number, number, number, number]>} id, name, kV, x, y, bar length */
  const buses = [
    [1, 'Bus 1', HV, -600, -300, 120], [2, 'Bus 2', HV, -600, 40, 260], [3, 'Bus 3', HV, -420, 360, 200],
    [4, 'Bus 4', HV, -280, 140, 240], [5, 'Bus 5', HV, -280, -160, 200], [6, 'Bus 6', LV, 120, -160, 220],
    [7, 'Bus 7', LV, 120, 140, 120], [8, 'Bus 8', TV, 360, 140, 100], [9, 'Bus 9', LV, 120, 340, 280],
    [10, 'Bus 10', LV, 420, 340, 120], [11, 'Bus 11', LV, 420, -20, 120], [12, 'Bus 12', LV, 420, -300, 120],
    [13, 'Bus 13', LV, 640, -160, 140], [14, 'Bus 14', LV, 640, 500, 120],
  ];
  const kv = new Map(buses.map(b => [b[0], b[2]]));
  for (const [n, name, vn, x, y, len] of buses) {
    doc.elements.push(makeElement('bus', `B${n}`, { name, vn, x, y, len, vmin: 0.94, vmax: 1.06, zone: vn === HV ? 'Transmission' : 'Subtransmission' }));
  }
  /** Line from per-unit data: r, x, b on 100 MVA, a length and a rating. Per-km values reproduce the totals exactly.
   * @type {Array<[number, number, number, number, number, number, number]>} from, to, r, x, b, km, kA */
  const lines = [
    [1, 2, 0.01938, 0.05917, 0.0528, 25.8, 0.9], [1, 5, 0.05403, 0.22304, 0.0492, 97.2, 0.6],
    [2, 3, 0.04699, 0.19797, 0.0438, 86.2, 0.5], [2, 4, 0.05811, 0.17632, 0.034, 76.8, 0.45],
    [2, 5, 0.05695, 0.17388, 0.0346, 75.7, 0.45], [3, 4, 0.06701, 0.17103, 0.0128, 74.5, 0.45],
    [4, 5, 0.01335, 0.04211, 0, 18.3, 0.6], [6, 11, 0.09498, 0.1989, 0, 6.2, 0.4], [6, 12, 0.12291, 0.25581, 0, 8.0, 0.4],
    [6, 13, 0.06615, 0.13027, 0, 4.1, 0.6], [9, 10, 0.03181, 0.0845, 0, 2.6, 0.4], [9, 14, 0.12711, 0.27038, 0, 8.4, 0.4],
    [10, 11, 0.08205, 0.19207, 0, 6.0, 0.4], [12, 13, 0.22092, 0.19988, 0, 6.2, 0.3], [13, 14, 0.17093, 0.34802, 0, 10.8, 0.3],
  ];
  lines.forEach(([f, t, r, x, b, km, ka], k) => {
    const zb = /** @type {number} */ (kv.get(f)) ** 2 / SB;
    doc.elements.push(makeElement('line', `L${k + 1}`, {
      name: `Line ${f}-${t}`, from: `B${f}`, to: `B${t}`, length: km, parallel: 1,
      r1: r * zb / km, x1: x * zb / km, b1: b / zb / km * 1e6, r0: 3 * r * zb / km, x0: 3 * x * zb / km, b0: 0.6 * b / zb / km * 1e6, ratedA: ka,
    }));
  });
  /** Transformers: the MATPOWER reactance on 100 MVA becomes uk on the assumed rating; the off-nominal ratio sits in
   * the rated HV voltage. Buses 4, 7, 8 and 9 hold the IEEE system's three-winding transformer as three two-winding
   * units around its star point (bus 7), exactly as the IEEE data does.
   * The IEEE data has no phase shifts, so every vector group has clock number 0; the tertiary is a delta winding.
   * @type {Array<[number, number, number, number, number, string, string]>} hv, lv, x, ratio, MVA, vector group, name */
  const trafos = [
    [4, 7, 0.20912, 0.978, 60, 'YNyn0', 'Transformer 4-7 (HV winding)'], [4, 9, 0.55618, 0.969, 30, 'YNyn0', 'Transformer 4-9'],
    [5, 6, 0.25202, 0.932, 60, 'YNyn0', 'Transformer 5-6'], [7, 8, 0.17615, 1, 30, 'Dd0', 'Transformer 7-8 (tertiary winding)'],
    [7, 9, 0.11001, 1, 60, 'YNyn0', 'Transformer 7-9 (LV winding)'],
  ];
  trafos.forEach(([h, l, x, ratio, sn, vectorGroup, name], k) => {
    const uk = x * 100 * sn / SB;
    doc.elements.push(makeElement('trafo', `T${k + 1}`, {
      name, hv: `B${h}`, lv: `B${l}`, sn, vnHV: /** @type {number} */ (kv.get(h)) * ratio, vnLV: kv.get(l), uk, ur: 0, uk0: uk, ur0: 0,
      i0: 0, pfe: 0, vectorGroup, tapStep: 1.25, tapPos: 0, tapNeutral: 0, tapMin: -9, tapMax: 9,
    }));
  });
  /** @type {Array<[number, string, number, number, number, number, number, number, number, number, number, number]>}
   * bus, mode, P MW, V p.u., Qmin, Qmax, S MVA, x″d, x′d, H s, cos φ, Ur kV */
  const gens = [
    [1, 'Reference', 232.4, 1.06, -40, 100, 615, 0.23, 0.2995, 5.148, 0.85, HV],
    [2, 'PV', 40, 1.045, -40, 50, 60, 0.13, 0.185, 6.54, 0.85, HV],
    [3, 'PV', 0, 1.01, 0, 40, 60, 0.13, 0.185, 5.06, 0.0001, HV],
    [6, 'PV', 0, 1.07, -6, 24, 25, 0.12, 0.185, 5.06, 0.0001, LV],
    [8, 'PV', 0, 1.09, -6, 24, 25, 0.12, 0.185, 5.06, 0.0001, TV],
  ];
  gens.forEach(([b, mode, p, vset, qmin, qmax, sn, xdss, xdt, h, cos, vn], k) => {
    doc.elements.push(makeElement('gen', `G${k + 1}`, {
      name: p > 0 ? `Generator ${b}` : `Condenser ${b}`, bus: `B${b}`, mode, p, q: 0, vset, qmin, qmax, sn, vn,
      cosphi: cos, xdss, rs: 0.003, xdt, h, damping: 0,
    }));
  });
  /** @type {Array<[number, number, number]>} */
  const loads = [[2, 21.7, 12.7], [3, 94.2, 19], [4, 47.8, -3.9], [5, 7.6, 1.6], [6, 11.2, 7.5], [9, 29.5, 16.6],
    [10, 9, 5.8], [11, 3.5, 1.8], [12, 6.1, 1.6], [13, 13.5, 5.8], [14, 14.9, 5]];
  loads.forEach(([b, p, q]) => doc.elements.push(makeElement('load', `D${b}`, { name: `Load ${b}`, bus: `B${b}`, p, q, side: 'below' })));
  doc.elements.push(makeElement('shunt', 'S9', { name: 'Capacitor 9', bus: 'B9', q: 19, p: 0, vn: LV, side: 'below' }));
  placeConnections(doc);
  doc.study.loadflow.tolerance = 0.001;
  doc.study.rms = { tEnd: 3, dt: 0.001, events: [
    { t: 0.1, kind: 'fault', target: 'B4' },
    { t: 0.18, kind: 'clear', target: 'B4' },
    { t: 0.18, kind: 'trip', target: 'L7' },
  ] };
  return doc;
}

/** Hand-placed connection points for the IEEE 14 drawing. @param {PowerDocument} doc */
function placeConnections(doc) {
  // [position at the first end, at the second end, route offset]; an offset of 60 between busbars on the same row
  // draws a straight link between their ends.
  /** @type {Record<string, [number, number, number]>} */
  const branchPos = {
    L1: [0, 0, 0], L2: [0.4, -0.4, 0], L3: [0.15, -0.3, 0], L4: [0.42, -0.4, 0], L5: [0.3, -0.3, 0], L6: [0.3, -0.15, 0],
    L7: [0, 0, 0], L8: [0.3, -0.3, 0], L9: [0.2, -0.3, 0], L10: [0.5, -0.5, 60], L11: [0.5, -0.5, 60], L12: [0.45, -0.4, 0],
    L13: [0.3, 0.3, 0], L14: [0.4, -0.3, 0], L15: [0, 0, 0],
    T1: [0.5, -0.5, 60], T2: [0.4, -0.45, 0], T3: [0.5, -0.5, 60], T4: [0.5, -0.5, 60], T5: [0, -0.2, 0],
  };
  /** @type {Record<string, [number, 'above' | 'below']>} */
  const singlePos = {
    G1: [-0.1, 'above'], G2: [-0.42, 'above'], G3: [-0.35, 'below'], G4: [-0.2, 'above'], G5: [0, 'above'],
    D2: [-0.15, 'below'], D3: [0.35, 'below'], D4: [0.1, 'below'], D5: [0.25, 'below'], D6: [-0.1, 'below'], D9: [0.08, 'below'],
    D10: [-0.2, 'below'], D11: [-0.35, 'below'], D12: [0.2, 'below'], D13: [0.3, 'below'], D14: [0.3, 'below'], S9: [-0.35, 'below'],
  };
  for (const el of doc.elements) {
    const bp = branchPos[el.id];
    if (bp && el.cls === 'line') { el.fromPos = bp[0]; el.toPos = bp[1]; el.bend = bp[2]; }
    if (bp && el.cls === 'trafo') { el.hvPos = bp[0]; el.lvPos = bp[1]; el.bend = bp[2]; }
    const sp = singlePos[el.id];
    if (sp) { el.pos = sp[0]; el.side = sp[1]; }
  }
}
