/** Dense linear algebra for the solvers: real and complex LU factorisation with partial pivoting.
 *
 * Matrices are row-major Float64Arrays. Complex matrices keep real and imaginary parts in two arrays of the same
 * shape. The networks PowerStudio handles in the browser stay below a few hundred buses, where a dense LU is fast
 * and simpler to trust than a sparse one (see docs/ENGINE.md, "Numerical methods"). */

/**
 * @typedef {{ n: number, lu: Float64Array, piv: Int32Array }} RealLU
 * @typedef {{ n: number, re: Float64Array, im: Float64Array, piv: Int32Array }} ComplexLU
 */

/** Factorises a square matrix in place (a copy is made). Throws when the matrix is singular to working precision.
 * @param {Float64Array} a row-major n×n @param {number} n @returns {RealLU} */
export function luFactor(a, n) {
  const lu = Float64Array.from(a), piv = new Int32Array(n);
  let scale = 0;
  for (let i = 0; i < n * n; i++) scale = Math.max(scale, Math.abs(lu[i]));
  const tiny = Math.max(scale, 1) * 1e-14;
  for (let k = 0; k < n; k++) {
    let p = k, best = Math.abs(lu[k * n + k]);
    for (let i = k + 1; i < n; i++) {
      const v = Math.abs(lu[i * n + k]);
      if (v > best) { best = v; p = i; }
    }
    if (best <= tiny) throw new SingularMatrixError(k);
    piv[k] = p;
    if (p !== k) for (let j = 0; j < n; j++) { const t = lu[k * n + j]; lu[k * n + j] = lu[p * n + j]; lu[p * n + j] = t; }
    const d = lu[k * n + k];
    for (let i = k + 1; i < n; i++) {
      const m = lu[i * n + k] / d;
      if (m === 0) continue;
      lu[i * n + k] = m;
      const ri = i * n, rk = k * n;
      for (let j = k + 1; j < n; j++) lu[ri + j] -= m * lu[rk + j];
    }
  }
  return { n, lu, piv };
}

/** Solves A x = b with a factorisation from luFactor. @param {RealLU} f @param {Float64Array} b @returns {Float64Array} */
export function luSolve(f, b) {
  const { n, lu, piv } = f, x = Float64Array.from(b);
  // Rows were swapped whole during factorisation, so every interchange applies to b before the forward pass.
  for (let k = 0; k < n; k++) { const p = piv[k]; if (p !== k) { const t = x[k]; x[k] = x[p]; x[p] = t; } }
  for (let k = 0; k < n; k++) {
    const xk = x[k];
    if (xk !== 0) for (let i = k + 1; i < n; i++) x[i] -= lu[i * n + k] * xk;
  }
  for (let k = n - 1; k >= 0; k--) {
    let s = x[k];
    for (let j = k + 1; j < n; j++) s -= lu[k * n + j] * x[j];
    x[k] = s / lu[k * n + k];
  }
  return x;
}

/** Factorises a complex square matrix. @param {Float64Array} re @param {Float64Array} im @param {number} n @returns {ComplexLU} */
export function cluFactor(re, im, n) {
  const a = Float64Array.from(re), b = Float64Array.from(im), piv = new Int32Array(n);
  let scale = 0;
  for (let i = 0; i < n * n; i++) scale = Math.max(scale, Math.hypot(a[i], b[i]));
  const tiny = Math.max(scale, 1) * 1e-14;
  for (let k = 0; k < n; k++) {
    let p = k, best = Math.hypot(a[k * n + k], b[k * n + k]);
    for (let i = k + 1; i < n; i++) {
      const v = Math.hypot(a[i * n + k], b[i * n + k]);
      if (v > best) { best = v; p = i; }
    }
    if (best <= tiny) throw new SingularMatrixError(k);
    piv[k] = p;
    if (p !== k) for (let j = 0; j < n; j++) {
      const kj = k * n + j, pj = p * n + j;
      let t = a[kj]; a[kj] = a[pj]; a[pj] = t;
      t = b[kj]; b[kj] = b[pj]; b[pj] = t;
    }
    const dr = a[k * n + k], di = b[k * n + k], den = dr * dr + di * di;
    for (let i = k + 1; i < n; i++) {
      const ik = i * n + k, xr = a[ik], xi = b[ik];
      if (xr === 0 && xi === 0) continue;
      const mr = (xr * dr + xi * di) / den, mi = (xi * dr - xr * di) / den;
      a[ik] = mr; b[ik] = mi;
      const ri = i * n, rk = k * n;
      for (let j = k + 1; j < n; j++) {
        const ur = a[rk + j], ui = b[rk + j];
        if (ur === 0 && ui === 0) continue;
        a[ri + j] -= mr * ur - mi * ui;
        b[ri + j] -= mr * ui + mi * ur;
      }
    }
  }
  return { n, re: a, im: b, piv };
}

/** Solves A x = b for complex A and b. @param {ComplexLU} f @param {Float64Array} br @param {Float64Array} bi
 * @returns {{ re: Float64Array, im: Float64Array }} */
export function cluSolve(f, br, bi) {
  const { n, re: a, im: b, piv } = f, xr = Float64Array.from(br), xi = Float64Array.from(bi);
  for (let k = 0; k < n; k++) {
    const p = piv[k];
    if (p !== k) {
      let t = xr[k]; xr[k] = xr[p]; xr[p] = t;
      t = xi[k]; xi[k] = xi[p]; xi[p] = t;
    }
  }
  for (let k = 0; k < n; k++) {
    const vr = xr[k], vi = xi[k];
    if (vr === 0 && vi === 0) continue;
    for (let i = k + 1; i < n; i++) {
      const lr = a[i * n + k], li = b[i * n + k];
      xr[i] -= lr * vr - li * vi;
      xi[i] -= lr * vi + li * vr;
    }
  }
  for (let k = n - 1; k >= 0; k--) {
    let sr = xr[k], si = xi[k];
    for (let j = k + 1; j < n; j++) {
      const ur = a[k * n + j], ui = b[k * n + j];
      sr -= ur * xr[j] - ui * xi[j];
      si -= ur * xi[j] + ui * xr[j];
    }
    const dr = a[k * n + k], di = b[k * n + k], den = dr * dr + di * di;
    xr[k] = (sr * dr + si * di) / den;
    xi[k] = (si * dr - sr * di) / den;
  }
  return { re: xr, im: xi };
}

export class SingularMatrixError extends Error {
  /** @param {number} column */
  constructor(column) {
    super(`The system matrix is singular at column ${column + 1}.`);
    this.name = 'SingularMatrixError';
    this.column = column;
  }
}
