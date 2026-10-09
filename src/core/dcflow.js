/** DC load flow: voltage angles from active power alone, with |V| = 1 and losses neglected.
 *
 * Each branch carries P = (θf − θt − φ) / x, where x is its series reactance in per unit and φ its phase shift. The
 * load flow uses it as a starting point; on meshed networks with phase-shifting transformers it brings Newton-Raphson
 * within its quadratic convergence region where a flat start may not. */

import { luFactor, luSolve, SingularMatrixError } from './linalg.js';

/**
 * @param {import('./network.js').Network} net
 * @param {{ type: Uint8Array, p: Float64Array }} spec bus types (3 = reference) and scheduled active power
 * @returns {Float64Array | null} angles in radians, or null when the reduced susceptance matrix is singular
 */
export function dcAngles(net, spec) {
  const n = net.nb;
  const unknown = new Int32Array(n).fill(-1);
  let m = 0;
  for (let i = 0; i < n; i++) if (spec.type[i] !== 3) unknown[i] = m++;
  const theta = new Float64Array(n);
  for (const g of net.grids) theta[g.bus] = g.angle * Math.PI / 180;
  for (const g of net.gens) if (g.mode === 'Reference') theta[g.bus] = g.angle * Math.PI / 180;
  if (m === 0) return theta;
  const B = new Float64Array(m * m), P = new Float64Array(m);
  for (let i = 0; i < n; i++) if (unknown[i] >= 0) P[unknown[i]] = spec.p[i];
  for (const br of net.branches) {
    // Series admittance ys = −yft·conj(t); its reactance gives the branch's DC susceptance.
    const tr = Math.cos(br.shift * Math.PI / 180), ti = Math.sin(br.shift * Math.PI / 180);
    const ysr = -(br.yft.re * tr + br.yft.im * ti), ysi = -(br.yft.im * tr - br.yft.re * ti);
    const d = ysr * ysr + ysi * ysi;
    const x = -ysi / d; // Im(1/ys), with the tap ratio folded in: close enough for a starting point
    if (!(Math.abs(x) > 1e-12)) continue;
    const b = 1 / x, phi = br.shift * Math.PI / 180;
    const f = unknown[br.f], t = unknown[br.t];
    if (f >= 0) { B[f * m + f] += b; P[f] += b * phi; }
    if (t >= 0) { B[t * m + t] += b; P[t] -= b * phi; }
    if (f >= 0 && t >= 0) { B[f * m + t] -= b; B[t * m + f] -= b; }
    if (f >= 0 && t < 0) P[f] += b * theta[br.t];
    if (t >= 0 && f < 0) P[t] += b * theta[br.f];
  }
  try {
    const x = luSolve(luFactor(B, m), P);
    for (let i = 0; i < n; i++) if (unknown[i] >= 0) theta[i] = x[unknown[i]];
    return theta;
  } catch (error) {
    if (error instanceof SingularMatrixError) return null;
    throw error;
  }
}
