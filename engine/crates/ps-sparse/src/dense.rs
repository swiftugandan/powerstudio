//! Dense LU with partial pivoting: the reference the sparse solvers are tested against.

use crate::{FactorStats, Pattern, SolveError, SparseSolver};

/// Dense LU factorisation with partial pivoting. Fine for small systems and for checking sparse solvers.
#[derive(Debug, Clone, Default)]
pub struct DenseLu {
    pattern: Option<Pattern>,
    lu: Vec<f64>,
    piv: Vec<usize>,
    n: usize,
    ready: bool,
}

impl DenseLu {
    /// A new, empty solver.
    pub fn new() -> Self {
        Self::default()
    }

    /// Factorises a row-major dense matrix directly.
    pub fn factor_dense(&mut self, a: &[f64], n: usize) -> Result<(), SolveError> {
        if a.len() != n * n {
            return Err(SolveError::Shape(format!(
                "expected {} values for a {n}×{n} matrix, got {}",
                n * n,
                a.len()
            )));
        }
        let mut lu = a.to_vec();
        let mut piv = vec![0usize; n];
        let scale = lu.iter().fold(0.0_f64, |m, v| m.max(v.abs()));
        let tiny = scale.max(1.0) * 1e-14;
        for k in 0..n {
            let mut p = k;
            let mut best = lu[k * n + k].abs();
            for i in k + 1..n {
                let v = lu[i * n + k].abs();
                if v > best {
                    best = v;
                    p = i;
                }
            }
            if best <= tiny {
                self.ready = false;
                return Err(SolveError::Singular { column: k });
            }
            piv[k] = p;
            if p != k {
                for j in 0..n {
                    lu.swap(k * n + j, p * n + j);
                }
            }
            let d = lu[k * n + k];
            for i in k + 1..n {
                let m = lu[i * n + k] / d;
                if m == 0.0 {
                    continue;
                }
                lu[i * n + k] = m;
                for j in k + 1..n {
                    lu[i * n + j] -= m * lu[k * n + j];
                }
            }
        }
        self.lu = lu;
        self.piv = piv;
        self.n = n;
        self.ready = true;
        Ok(())
    }

    fn solve_dense(&self, x: &mut [f64]) {
        let n = self.n;
        // Rows were swapped whole during factorisation, so every interchange applies before the forward pass.
        for k in 0..n {
            x.swap(k, self.piv[k]);
        }
        for k in 0..n {
            let xk = x[k];
            if xk != 0.0 {
                for i in k + 1..n {
                    x[i] -= self.lu[i * n + k] * xk;
                }
            }
        }
        for k in (0..n).rev() {
            let mut s = x[k];
            for j in k + 1..n {
                s -= self.lu[k * n + j] * x[j];
            }
            x[k] = s / self.lu[k * n + k];
        }
    }

    fn solve_dense_transpose(&self, x: &mut [f64]) {
        // Aᵀ = Uᵀ Lᵀ Pᵀ… solve Uᵀ y = b, then Lᵀ z = y, then undo the interchanges in reverse.
        let n = self.n;
        for k in 0..n {
            let mut s = x[k];
            for j in 0..k {
                s -= self.lu[j * n + k] * x[j];
            }
            x[k] = s / self.lu[k * n + k];
        }
        for k in (0..n).rev() {
            let mut s = x[k];
            for j in k + 1..n {
                s -= self.lu[j * n + k] * x[j];
            }
            x[k] = s;
        }
        for k in (0..n).rev() {
            x.swap(k, self.piv[k]);
        }
    }
}

impl SparseSolver for DenseLu {
    fn analyse(&mut self, pattern: &Pattern) -> Result<(), SolveError> {
        if pattern.nrows != pattern.ncols {
            return Err(SolveError::Shape("the system must be square".into()));
        }
        self.pattern = Some(pattern.clone());
        self.ready = false;
        Ok(())
    }

    fn factor(&mut self, values: &[f64]) -> Result<FactorStats, SolveError> {
        let p = self
            .pattern
            .as_ref()
            .ok_or(SolveError::NotReady("analyse before factor"))?;
        if values.len() != p.nnz() {
            return Err(SolveError::Shape(format!(
                "{} values for a pattern of {}",
                values.len(),
                p.nnz()
            )));
        }
        let n = p.nrows;
        let mut a = vec![0.0; n * n];
        for col in 0..n {
            for k in p.col_ptr[col]..p.col_ptr[col + 1] {
                a[p.row_idx[k] * n + col] += values[k];
            }
        }
        let nnz = p.nnz();
        self.factor_dense(&a, n)?;
        Ok(FactorStats {
            n,
            nnz,
            factor_nnz: Some(n * n),
        })
    }

    fn solve(&mut self, rhs: &mut [f64]) -> Result<(), SolveError> {
        if !self.ready {
            return Err(SolveError::NotReady("factor before solve"));
        }
        if rhs.len() != self.n {
            return Err(SolveError::Shape("right-hand side has the wrong length".into()));
        }
        self.solve_dense(rhs);
        Ok(())
    }

    fn solve_transpose(&mut self, rhs: &mut [f64]) -> Result<(), SolveError> {
        if !self.ready {
            return Err(SolveError::NotReady("factor before solve"));
        }
        if rhs.len() != self.n {
            return Err(SolveError::Shape("right-hand side has the wrong length".into()));
        }
        self.solve_dense_transpose(rhs);
        Ok(())
    }
}
