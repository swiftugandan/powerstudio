import { test } from 'node:test';
import assert from 'node:assert/strict';
import { luFactor, luSolve, cluFactor, cluSolve, SingularMatrixError } from '../src/core/linalg.js';

/** Deterministic pseudo-random numbers (xorshift) so failures reproduce. */
function rng(seed) { let s = seed >>> 0; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) / 4294967296) * 2 - 1; }; }

test('real LU solves systems that need row interchanges at every step', () => {
  for (const n of [1, 2, 5, 17, 60]) {
    const r = rng(n), A = new Float64Array(n * n), b = new Float64Array(n);
    // A small diagonal forces pivoting; later pivots move rows whose multipliers are already stored.
    for (let i = 0; i < n; i++) { b[i] = r(); for (let j = 0; j < n; j++) A[i * n + j] = i === j ? 1e-3 * r() : r(); }
    const x = luSolve(luFactor(A, n), b);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let j = 0; j < n; j++) s += A[i * n + j] * x[j];
      assert.ok(Math.abs(s - b[i]) < 1e-9, `n=${n} row ${i} residual ${s - b[i]}`);
    }
  }
});

test('complex LU solves systems that need row interchanges', () => {
  for (const n of [1, 3, 9, 40]) {
    const r = rng(100 + n), re = new Float64Array(n * n), im = new Float64Array(n * n), br = new Float64Array(n), bi = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      br[i] = r(); bi[i] = r();
      for (let j = 0; j < n; j++) { re[i * n + j] = i === j ? 1e-3 * r() : r(); im[i * n + j] = r(); }
    }
    const x = cluSolve(cluFactor(re, im, n), br, bi);
    for (let i = 0; i < n; i++) {
      let sr = 0, si = 0;
      for (let j = 0; j < n; j++) { const a = re[i * n + j], c = im[i * n + j]; sr += a * x.re[j] - c * x.im[j]; si += a * x.im[j] + c * x.re[j]; }
      assert.ok(Math.hypot(sr - br[i], si - bi[i]) < 1e-9, `n=${n} row ${i}`);
    }
  }
});

test('singular matrices are reported, not solved', () => {
  assert.throws(() => luFactor(Float64Array.from([1, 2, 2, 4]), 2), SingularMatrixError);
  assert.throws(() => cluFactor(Float64Array.from([1, 1, 1, 1]), new Float64Array(4), 2), SingularMatrixError);
});
