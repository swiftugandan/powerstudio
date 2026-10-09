//! Complex sparse systems (admittance matrices) solved through their real equivalent
//! `[Re −Im; Im Re] [x_re; x_im] = [b_re; b_im]`, which keeps one real solver for everything.

use ps_num::C64;

use crate::{CscBuilder, FaerLu, SolveError, SparseSolver};

/// A factorised complex sparse matrix.
#[derive(Debug)]
pub struct ComplexLu {
    n: usize,
    solver: FaerLu,
    rhs: Vec<f64>,
}

impl ComplexLu {
    /// Assembles and factorises an `n × n` complex matrix from coordinate entries (duplicates add). Every diagonal
    /// entry is part of the pattern even when no entry names it.
    pub fn factor(n: usize, entries: &[(usize, usize, C64)]) -> Result<Self, SolveError> {
        let mut b = CscBuilder::new(2 * n, 2 * n);
        b.reserve(4 * (entries.len() + n));
        let mut vals = Vec::with_capacity(4 * (entries.len() + n));
        let mut push = |b: &mut CscBuilder, r: usize, c: usize, v: f64| {
            b.push(r, c);
            vals.push(v);
        };
        for i in 0..n {
            push(&mut b, i, i, 0.0);
            push(&mut b, i + n, i + n, 0.0);
        }
        for &(i, j, y) in entries {
            if i >= n || j >= n {
                return Err(SolveError::Shape(format!(
                    "entry ({i}, {j}) lies outside a {n} × {n} matrix"
                )));
            }
            push(&mut b, i, j, y.re);
            push(&mut b, i, j + n, -y.im);
            push(&mut b, i + n, j, y.im);
            push(&mut b, i + n, j + n, y.re);
        }
        let (pattern, slot) = b.build();
        let mut values = vec![0.0; pattern.nnz()];
        for (h, v) in vals.into_iter().enumerate() {
            values[slot[h]] += v;
        }
        let mut solver = FaerLu::new();
        solver.analyse(&pattern)?;
        solver.factor(&values)?;
        Ok(Self {
            n,
            solver,
            rhs: vec![0.0; 2 * n],
        })
    }

    /// Order of the system.
    pub fn n(&self) -> usize {
        self.n
    }

    /// Solves `A x = b`. A result that is not finite means the matrix is numerically singular.
    pub fn solve(&mut self, b: &[C64]) -> Result<Vec<C64>, SolveError> {
        let n = self.n;
        if b.len() != n {
            return Err(SolveError::Shape(format!(
                "the right-hand side has {} entries, not {n}",
                b.len()
            )));
        }
        for (i, v) in b.iter().enumerate() {
            self.rhs[i] = v.re;
            self.rhs[i + n] = v.im;
        }
        self.solver.solve(&mut self.rhs)?;
        let x: Vec<C64> = (0..n).map(|i| C64::new(self.rhs[i], self.rhs[i + n])).collect();
        if x.iter().any(|v| !v.is_finite()) {
            return Err(SolveError::Singular { column: 0 });
        }
        Ok(x)
    }

    /// Column `k` of the inverse: the solution for a unit current injected at `k`.
    pub fn column(&mut self, k: usize) -> Result<Vec<C64>, SolveError> {
        let mut e = vec![C64::ZERO; self.n];
        if let Some(v) = e.get_mut(k) {
            *v = C64::ONE;
        }
        self.solve(&e)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn solves_a_complex_system() -> Result<(), SolveError> {
        // [[2+j, -1], [-1, 3-2j]] x = [1, j]
        let a = [
            (0, 0, C64::new(2.0, 1.0)),
            (0, 1, C64::new(-1.0, 0.0)),
            (1, 0, C64::new(-1.0, 0.0)),
            (1, 1, C64::new(3.0, -2.0)),
        ];
        let mut lu = ComplexLu::factor(2, &a)?;
        let b = [C64::new(1.0, 0.0), C64::new(0.0, 1.0)];
        let x = lu.solve(&b)?;
        for (i, bi) in b.iter().enumerate() {
            let mut r = *bi;
            for &(r_, c, y) in &a {
                if r_ == i {
                    r -= y * x[c];
                }
            }
            assert!(r.abs() < 1e-14);
        }
        Ok(())
    }
}
