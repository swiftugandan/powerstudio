//! Linear sensitivities of a network: power transfer distribution factors (PTDF) and line outage distribution
//! factors (LODF) from the DC model, and the voltage response to reactive injections from the decoupled B″ model.
//!
//! The DC model takes each branch's flow as (θ_f − θ_t)/x, with x its series reactance, and fixes the angle of each
//! island's reference bus; one factorisation of the reduced susceptance matrix B serves every column. The B″ model
//! holds the voltage magnitude of every bus a control fixes and solves −Im(Y)·ΔV = ΔQ for the others.

use ps_num::C64;
use ps_sparse::{CscBuilder, FaerLu, SparseSolver};

/// A factorised matrix A changed by a branch: A − U·D·Uᵀ, with U the unit columns of the branch's ends (those that
/// are unknowns) and D the branch's 2×2 contribution. Solves use the Woodbury identity on A's factors:
/// (A − U·D·Uᵀ)⁻¹·r = A⁻¹·r + W·(I − D·Uᵀ·W)⁻¹·D·Uᵀ·A⁻¹·r with W = A⁻¹·U, which holds for a singular D (a branch
/// without shunt admittance) too.
pub struct Modified {
    /// Unknown index of each end kept (one or two).
    at: Vec<usize>,
    /// A⁻¹·u for each kept end.
    w: Vec<Vec<f64>>,
    /// (I − D·Uᵀ·W)⁻¹·D, small and dense.
    k: Vec<Vec<f64>>,
}

/// Prepares the change of `lu`'s matrix by contribution `d` on the unknowns `at`. `None` when the changed matrix is
/// singular (the branch's loss splits the network).
fn modify(lu: &mut FaerLu, m: usize, at: Vec<usize>, d: Vec<Vec<f64>>) -> Option<Modified> {
    let r = at.len();
    let mut w = Vec::with_capacity(r);
    for &c in &at {
        let mut e = vec![0.0; m];
        e[c] = 1.0;
        lu.solve(&mut e).ok()?;
        w.push(e);
    }
    // S = I − D·Uᵀ·W (r × r); K = S⁻¹·D.
    let mut s = vec![vec![0.0; r]; r];
    for i in 0..r {
        for j in 0..r {
            let dw: f64 = (0..r).map(|l| d[i][l] * w[j][at[l]]).sum();
            s[i][j] = f64::from(u8::from(i == j)) - dw;
        }
    }
    let inv = match r {
        1 => vec![vec![1.0 / s[0][0]]],
        _ => {
            let det = s[0][0] * s[1][1] - s[0][1] * s[1][0];
            vec![vec![s[1][1] / det, -s[0][1] / det], vec![-s[1][0] / det, s[0][0] / det]]
        }
    };
    let k: Vec<Vec<f64>> = (0..r)
        .map(|i| (0..r).map(|j| (0..r).map(|l| inv[i][l] * d[l][j]).sum()).collect())
        .collect();
    if k.iter().flatten().any(|x| !x.is_finite()) || k.iter().flatten().any(|x| x.abs() > 1e12) {
        return None;
    }
    Some(Modified { at, w, k })
}

impl Modified {
    /// Applies the correction to `x = A⁻¹·r` in place.
    fn correct(&self, x: &mut [f64]) {
        let r = self.at.len();
        let ux: Vec<f64> = self.at.iter().map(|&c| x[c]).collect();
        let y: Vec<f64> = (0..r).map(|i| (0..r).map(|j| self.k[i][j] * ux[j]).sum()).collect();
        for (i, wi) in self.w.iter().enumerate() {
            for (xc, wc) in x.iter_mut().zip(wi) {
                *xc += wc * y[i];
            }
        }
    }
}

use crate::{MachineMode, PuNetwork};

/// The factorised DC model of a network.
pub struct DcModel {
    /// Unknown index of each bus, or `usize::MAX` for a reference.
    col: Vec<usize>,
    /// 1/x of each branch (0 for a branch without reactance).
    b: Vec<f64>,
    ends: Vec<(usize, usize)>,
    lu: FaerLu,
}

/// Series admittance of a branch, from its two-port and ideal transformer.
fn series(br: &crate::PuBranch) -> C64 {
    -(br.yft * C64::from_polar(br.ratio, br.shift).conj())
}

impl DcModel {
    /// The DC model with the network's external grids and reference machines as references. `None` when B cannot be
    /// factorised (an island without a reference).
    pub fn new(net: &PuNetwork) -> Option<Self> {
        let n = net.buses.len();
        let mut reference = vec![false; n];
        for g in &net.grids {
            reference[g.bus] = true;
        }
        for g in net.machines.iter().filter(|g| g.mode == MachineMode::Reference) {
            reference[g.bus] = true;
        }
        let mut col = vec![usize::MAX; n];
        let mut m = 0;
        for i in 0..n {
            if !reference[i] {
                col[i] = m;
                m += 1;
            }
        }
        let b: Vec<f64> = net
            .branches
            .iter()
            .map(|br| {
                let x = series(br).inv().im;
                if x.abs() > 1e-12 && x.is_finite() { 1.0 / x } else { 0.0 }
            })
            .collect();
        let ends: Vec<(usize, usize)> = net.branches.iter().map(|br| (br.f, br.t)).collect();
        let mut builder = CscBuilder::new(m, m);
        let mut vals = Vec::new();
        for i in 0..m {
            builder.push(i, i);
            vals.push(0.0);
        }
        for (k, &(f, t)) in ends.iter().enumerate() {
            let (cf, ct) = (col[f], col[t]);
            for (a, c) in [(cf, ct), (ct, cf)] {
                if a != usize::MAX {
                    builder.push(a, a);
                    vals.push(b[k]);
                    if c != usize::MAX {
                        builder.push(a, c);
                        vals.push(-b[k]);
                    }
                }
            }
        }
        let (pattern, slot) = builder.build();
        let mut values = vec![0.0; pattern.nnz()];
        for (h, v) in vals.into_iter().enumerate() {
            values[slot[h]] += v;
        }
        let mut lu = FaerLu::new();
        lu.analyse(&pattern).ok()?;
        lu.factor(&values).ok()?;
        Some(Self { col, b, ends, lu })
    }

    /// Change of every branch's flow (from end to to end) per unit of power injected at bus `from` and taken out at
    /// bus `to`: a PTDF column. A reference bus takes or gives the power itself.
    pub fn transfer(&mut self, from: usize, to: usize) -> Vec<f64> {
        let m = self.lu_order();
        let mut rhs = vec![0.0; m];
        if self.col[from] != usize::MAX {
            rhs[self.col[from]] += 1.0;
        }
        if self.col[to] != usize::MAX {
            rhs[self.col[to]] -= 1.0;
        }
        let ok = self.lu.solve(&mut rhs).is_ok();
        let theta = |i: usize| {
            if self.col[i] == usize::MAX || !ok {
                0.0
            } else {
                rhs[self.col[i]]
            }
        };
        self.ends
            .iter()
            .zip(&self.b)
            .map(|(&(f, t), b)| b * (theta(f) - theta(t)))
            .collect()
    }

    /// Line outage distribution factors of branch `k`: the change of every branch's flow per unit of `k`'s
    /// pre-outage flow (−1 at `k` itself). `None` when losing `k` splits the network (its own PTDF is 1).
    pub fn lodf(&mut self, k: usize) -> Option<Vec<f64>> {
        let (f, t) = self.ends[k];
        let ptdf = self.transfer(f, t);
        let denom = 1.0 - ptdf[k];
        if denom.abs() < 1e-9 || self.b[k] == 0.0 {
            return None;
        }
        let mut out: Vec<f64> = ptdf.iter().map(|p| p / denom).collect();
        out[k] = -1.0;
        Some(out)
    }

    /// Angle changes of every bus (radians) for injections `p` (p.u., by bus); references do not move.
    pub fn angles(&mut self, p: &[(usize, f64)]) -> Vec<f64> {
        let m = self.lu_order();
        let mut rhs = vec![0.0; m];
        for &(i, x) in p {
            if self.col[i] != usize::MAX {
                rhs[self.col[i]] += x;
            }
        }
        let ok = self.lu.solve(&mut rhs).is_ok();
        self.col
            .iter()
            .map(|&c| if c == usize::MAX || !ok { 0.0 } else { rhs[c] })
            .collect()
    }

    /// The DC model with branch `k` out, for [`DcModel::angles_with`]. `None` when its loss splits the network.
    pub fn without_branch(&mut self, k: usize) -> Option<Modified> {
        let (f, t) = self.ends[k];
        let b = self.b[k];
        let m = self.lu_order();
        let ends: Vec<(usize, usize)> = [f, t]
            .iter()
            .enumerate()
            .filter(|(_, b)| self.col[**b] != usize::MAX)
            .map(|(i, b)| (i, self.col[*b]))
            .collect();
        let full = [[b, -b], [-b, b]];
        let d = ends
            .iter()
            .map(|&(i, _)| ends.iter().map(|&(j, _)| full[i][j]).collect())
            .collect();
        modify(&mut self.lu, m, ends.iter().map(|e| e.1).collect(), d)
    }

    /// [`DcModel::angles`] on the model changed by `change`.
    pub fn angles_with(&mut self, change: &Modified, p: &[(usize, f64)]) -> Vec<f64> {
        let m = self.lu_order();
        let mut rhs = vec![0.0; m];
        for &(i, x) in p {
            if self.col[i] != usize::MAX {
                rhs[self.col[i]] += x;
            }
        }
        let ok = self.lu.solve(&mut rhs).is_ok();
        change.correct(&mut rhs);
        self.col
            .iter()
            .map(|&c| if c == usize::MAX || !ok { 0.0 } else { rhs[c] })
            .collect()
    }

    fn lu_order(&self) -> usize {
        self.col.iter().filter(|&&c| c != usize::MAX).count()
    }
}

/// The factorised B″ model: the voltage magnitude response to reactive injections, with the magnitudes of the
/// buses in `fixed` held.
pub struct VoltageModel {
    col: Vec<usize>,
    lu: FaerLu,
}

impl VoltageModel {
    /// The model for a network whose buses `fixed` hold their voltage. `None` when −Im(Y) reduced to the other
    /// buses cannot be factorised.
    pub fn new(net: &PuNetwork, fixed: &[bool]) -> Option<Self> {
        let n = net.buses.len();
        let mut col = vec![usize::MAX; n];
        let mut m = 0;
        for i in 0..n {
            if !fixed[i] {
                col[i] = m;
                m += 1;
            }
        }
        let y = crate::Ybus::build(net, &[]);
        let mut builder = CscBuilder::new(m, m);
        let mut vals = Vec::new();
        for i in 0..n {
            if col[i] == usize::MAX {
                continue;
            }
            for e in y.row_ptr[i]..y.row_ptr[i + 1] {
                let k = y.col[e];
                if col[k] != usize::MAX {
                    builder.push(col[i], col[k]);
                    vals.push(-y.val[e].im);
                }
            }
        }
        let (pattern, slot) = builder.build();
        let mut values = vec![0.0; pattern.nnz()];
        for (h, v) in vals.into_iter().enumerate() {
            values[slot[h]] += v;
        }
        let mut lu = FaerLu::new();
        lu.analyse(&pattern).ok()?;
        lu.factor(&values).ok()?;
        Some(Self { col, lu })
    }

    /// The model with a branch's admittances removed, for [`VoltageModel::response_with`]. `None` when the changed
    /// matrix is singular.
    pub fn without_branch(&mut self, br: &crate::PuBranch) -> Option<Modified> {
        let m = self.col.iter().filter(|&&c| c != usize::MAX).count();
        let full = [[-br.yff.im, -br.yft.im], [-br.ytf.im, -br.ytt.im]];
        let ends: Vec<(usize, usize)> = [br.f, br.t]
            .iter()
            .enumerate()
            .filter(|(_, b)| self.col[**b] != usize::MAX)
            .map(|(i, b)| (i, self.col[*b]))
            .collect();
        if ends.is_empty() {
            return Some(Modified {
                at: Vec::new(),
                w: Vec::new(),
                k: Vec::new(),
            });
        }
        let d = ends
            .iter()
            .map(|&(i, _)| ends.iter().map(|&(j, _)| full[i][j]).collect())
            .collect();
        modify(&mut self.lu, m, ends.iter().map(|e| e.1).collect(), d)
    }

    /// [`VoltageModel::response`] on the model changed by `change`.
    pub fn response_with(&mut self, change: &Modified, dq: &[(usize, f64)]) -> Vec<f64> {
        let m = self.col.iter().filter(|&&c| c != usize::MAX).count();
        let mut rhs = vec![0.0; m];
        for &(i, q) in dq {
            if self.col[i] != usize::MAX {
                rhs[self.col[i]] += q;
            }
        }
        let ok = self.lu.solve(&mut rhs).is_ok();
        change.correct(&mut rhs);
        self.col
            .iter()
            .map(|&c| if c == usize::MAX || !ok { 0.0 } else { rhs[c] })
            .collect()
    }

    /// Voltage change of every bus for reactive injections `dq` (p.u., by bus), p.u.; fixed buses do not change.
    pub fn response(&mut self, dq: &[(usize, f64)]) -> Vec<f64> {
        let m = self.col.iter().filter(|&&c| c != usize::MAX).count();
        let mut rhs = vec![0.0; m];
        for &(i, q) in dq {
            if self.col[i] != usize::MAX {
                rhs[self.col[i]] += q;
            }
        }
        let ok = self.lu.solve(&mut rhs).is_ok();
        self.col
            .iter()
            .map(|&c| if c == usize::MAX || !ok { 0.0 } else { rhs[c] })
            .collect()
    }
}
