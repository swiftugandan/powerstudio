/** Import of MATPOWER case files (format version 2), the de facto exchange format for benchmark networks.
 *
 * MATPOWER stores per-unit data on the system base; PowerStudio stores engineering values. The import converts each
 * row without loss so that a load flow of the imported document reproduces MATPOWER's own: lines get a length of 1 km
 * and their total impedance per km, transformers get a rated power equal to the system base and an HV rated voltage
 * that carries the off-nominal ratio. docs/ENGINE.md, "MATPOWER import", lists every mapping. */

import { makeElement, VECTOR_GROUPS } from './catalog.js';
import { emptyDocument } from './document.js';
import { autoLayout } from './layout.js';

/** @typedef {import('./document.js').PowerDocument} PowerDocument @typedef {import('./catalog.js').Element} Element */

/**
 * Parses the numeric matrices and scalars of a MATPOWER .m file.
 * @param {string} text
 * @returns {{ name: string, baseMVA: number, bus: number[][], gen: number[][], branch: number[][], busNames: string[] }}
 */
export function parseMatpower(text) {
  const clean = text.replace(/%[^\n]*/g, '');
  const fn = /function\s+mpc\s*=\s*(\w+)/.exec(clean);
  const scalar = /mpc\.baseMVA\s*=\s*([-+0-9.eE]+)\s*;/.exec(clean);
  /** @param {string} key */
  const matrix = key => {
    const m = new RegExp(`mpc\\.${key}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*;`).exec(clean);
    if (!m) return [];
    return m[1].split(/;|\n/).map(r => r.trim()).filter(Boolean).map(row => row.split(/[\s,]+/).filter(Boolean).map(v => {
      const x = Number(v);
      if (!Number.isFinite(x)) throw new Error(`MATPOWER ${key}: "${v}" is not a number.`);
      return x;
    }));
  };
  const names = /mpc\.bus_name\s*=\s*\{([\s\S]*?)\}\s*;/.exec(text);
  const busNames = names ? [...names[1].matchAll(/'([^']*)'/g)].map(m => m[1].replace(/\s+/g, ' ').trim()) : [];
  const bus = matrix('bus'), gen = matrix('gen'), branch = matrix('branch');
  if (!bus.length) throw new Error('No mpc.bus matrix found. Is this a MATPOWER case file?');
  if (bus.some(r => r.length < 13) || gen.some(r => r.length < 10) || branch.some(r => r.length < 11)) {
    throw new Error('The MATPOWER matrices have fewer columns than format version 2 requires.');
  }
  return { name: fn ? fn[1] : 'MATPOWER case', baseMVA: scalar ? Number(scalar[1]) : 100, bus, gen, branch, busNames };
}

/**
 * Converts a MATPOWER case into a PowerStudio document. Buses without a base voltage get `defaultKV`.
 * @param {string} text @param {{ defaultKV?: number }} [opt] @returns {{ doc: PowerDocument, issues: string[] }}
 */
export function importMatpower(text, opt = {}) {
  const { defaultKV = 110 } = opt;
  const mpc = parseMatpower(text);
  const doc = emptyDocument(mpc.name);
  doc.baseMVA = mpc.baseMVA;
  doc.description = `Imported from MATPOWER case ${mpc.name}.`;
  /** @type {string[]} */
  const issues = [];
  /** @type {Element[]} */
  const buses = [], others = [];
  const busId = new Map(), kv = new Map(), type = new Map();
  let zeroKV = 0;
  for (const [k, r] of mpc.bus.entries()) {
    const [num, bt, pd, qd, gs, bs, , vm, , baseKV, , vmax, vmin] = r;
    const id = `B${num}`;
    const vn = baseKV > 0 ? baseKV : defaultKV;
    if (!(baseKV > 0)) zeroKV++;
    busId.set(num, id); kv.set(num, vn); type.set(num, bt);
    buses.push(makeElement('bus', id, { name: mpc.busNames[k] || `Bus ${num}`, vn, vmin: vmin > 0 ? vmin : 0.9, vmax: vmax > 0 ? vmax : 1.1 }));
    if (bt === 4) issues.push(`Bus ${num} is marked isolated; its loads are out of service.`);
    if (pd !== 0 || qd !== 0) others.push(makeElement('load', `D${num}`, { name: `Load ${num}`, bus: id, p: pd, q: qd, inService: bt !== 4 }));
    if (gs !== 0 || bs !== 0) others.push(makeElement('shunt', `S${num}`, { name: `Shunt ${num}`, bus: id, p: gs, q: bs, vn, inService: bt !== 4 }));
    void vm;
  }
  if (zeroKV) issues.push(`${zeroKV} buses have no base voltage in the file and were given ${defaultKV} kV.`);

  const refAssigned = new Set();
  for (const [k, r] of mpc.gen.entries()) {
    const [num, pg, qg, qmax, qmin, vg, mbase, status] = r;
    const bus = busId.get(num);
    if (!bus) { issues.push(`Generator ${k + 1} refers to missing bus ${num}; skipped.`); continue; }
    const isRef = type.get(num) === 3 && status > 0 && !refAssigned.has(num);
    if (isRef) refAssigned.add(num);
    const mode = isRef ? 'Reference' : type.get(num) === 1 ? 'PQ' : 'PV';
    others.push(makeElement('gen', `G${k + 1}`, {
      name: `Gen ${k + 1}`, bus, mode, p: pg, q: qg, vset: vg, qmin, qmax, angle: isRef ? /** @type {number[]} */ (mpc.bus.find(b => b[0] === num))[8] : 0,
      sn: mbase > 0 ? mbase : mpc.baseMVA, vn: kv.get(num), inService: status > 0 && type.get(num) !== 4,
    }));
  }
  for (const [num, bt] of type) {
    if (bt === 3 && !refAssigned.has(num)) {
      issues.push(`Reference bus ${num} has no generator in service; an external grid holds its voltage.`);
      const row = /** @type {number[]} */ (mpc.bus.find(r => r[0] === num));
      others.push(makeElement('extgrid', `X${num}`, { name: `Grid ${num}`, bus: busId.get(num), vset: row[7], angle: row[8] }));
    }
  }

  const sb = mpc.baseMVA;
  let lines = 0, trafos = 0;
  for (const r of mpc.branch) {
    const [fb, tb, rr, xx, bb, rateA, , , ratio, shift, status] = r;
    const from = busId.get(fb), to = busId.get(tb);
    if (!from || !to) { issues.push(`Branch ${fb}-${tb} refers to a missing bus; skipped.`); continue; }
    const vf = /** @type {number} */ (kv.get(fb)), vt = /** @type {number} */ (kv.get(tb));
    const inService = status > 0;
    if ((ratio === 0 || ratio === 1) && shift === 0 && vf === vt) {
      const zb = vf * vf / sb;
      lines++;
      others.push(makeElement('line', `L${lines}`, {
        name: `Line ${fb}-${tb}`, from, to, inService, length: 1, parallel: 1,
        r1: rr * zb, x1: xx * zb, b1: bb / zb * 1e6, r0: 3 * rr * zb, x0: 3 * xx * zb, b0: 0.6 * bb / zb * 1e6,
        ratedA: rateA > 0 ? rateA / (Math.sqrt(3) * vf) : 0,
      }));
    } else {
      const t = ratio === 0 ? 1 : ratio;
      const clock = ((Math.round(shift / 30) % 12) + 12) % 12;
      const group = clock === 0 ? 'YNyn0' : `YNd${clock}`;
      const supported = Math.abs(shift % 30) < 1e-9 && /** @type {readonly string[]} */ (VECTOR_GROUPS).includes(group);
      if (!supported) issues.push(`Transformer ${fb}-${tb}: phase shift ${shift}° has no vector group equivalent and was dropped.`);
      if (bb !== 0) {
        // MATPOWER puts half the charging at each end, the from half behind the tap: Yff gains jb/(2τ²), Ytt gains jb/2.
        issues.push(`Transformer ${fb}-${tb}: its line charging of ${bb} p.u. became two shunts at its ends.`);
        others.push(makeElement('shunt', `S${fb}_${tb}a`, { name: `Charging ${fb}-${tb} (${fb})`, bus: from, p: 0, q: bb / 2 / (t * t) * sb, vn: vf, inService }));
        others.push(makeElement('shunt', `S${fb}_${tb}b`, { name: `Charging ${fb}-${tb} (${tb})`, bus: to, p: 0, q: bb / 2 * sb, vn: vt, inService }));
      }
      if (xx < 0) issues.push(`Transformer ${fb}-${tb}: negative reactance is not supported; its magnitude was used.`);
      trafos++;
      const z = Math.hypot(rr, xx);
      others.push(makeElement('trafo', `T${trafos}`, {
        name: `Transformer ${fb}-${tb}`, hv: from, lv: to, inService, sn: sb, vnHV: vf * t, vnLV: vt,
        uk: z * 100, ur: rr * 100, uk0: z * 100, ur0: rr * 100, i0: 0, pfe: 0, tapPos: 0, tapNeutral: 0,
        vectorGroup: supported ? group : 'YNyn0',
      }));
    }
  }
  doc.elements = [...buses, ...others];
  autoLayout(doc);
  return { doc, issues };
}
