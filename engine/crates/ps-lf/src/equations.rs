//! The equations Newton-Raphson solves for one state of the controls, and their Jacobian.
//!
//! Unknowns are the angle of every bus that is not a reference and the voltage magnitude of every bus whose voltage
//! no control fixes. A voltage control fixes the magnitude of the bus it regulates and frees the magnitude of every
//! controller bus that regulates another bus. Rows are, in order:
//!
//! * active power at every bus that is not a reference;
//! * reactive power at every bus that has no active voltage controller;
//! * for each group of controller buses regulating one bus, one row per controller after the first, sharing the
//!   group's reactive power so that every controller sits at the same fraction of its reactive range.
//!
//! The reactive rows are written in terms of `G_i = Q_inj,i + Q_load,i(V) − Q_fixed,i`, the reactive power bus `i`
//! needs from its voltage-controlling units: zero at a bus without one, shared by key within a group.

use ps_num::C64;
use ps_sparse::{CscBuilder, Pattern};

use crate::Ybus;

/// No unknown or row.
pub(crate) const NONE: usize = usize::MAX;

/// Load and generation schedule of one Newton solve.
#[derive(Debug, Clone)]
pub(crate) struct Schedule {
    /// Active generation fixed at each bus (every machine but references), p.u.
    pub p_gen: Vec<f64>,
    /// Reactive generation fixed at each bus (PQ units and units held at a limit), p.u.
    pub q_fixed: Vec<f64>,
    /// Load at each bus as `[z, i, c]` coefficients: `P = z·V² + i·V + c`.
    pub p_load: Vec<[f64; 3]>,
    /// Reactive load coefficients, likewise.
    pub q_load: Vec<[f64; 3]>,
}

impl Schedule {
    /// Active and reactive load at bus `i` for voltage `v`, with their derivatives.
    #[inline]
    pub fn load(&self, i: usize, v: f64) -> (f64, f64, f64, f64) {
        let (p, q) = (self.p_load[i], self.q_load[i]);
        (
            p[0] * v * v + p[1] * v + p[2],
            q[0] * v * v + q[1] * v + q[2],
            2.0 * p[0] * v + p[1],
            2.0 * q[0] * v + q[1],
        )
    }
}

/// The unknowns and rows for one state of the controls.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Structure {
    /// Angle column of each bus, or [`NONE`] for references. Active power rows use the same numbering.
    pub col_a: Vec<usize>,
    /// Magnitude column of each bus, or [`NONE`] when a control fixes it.
    pub col_m: Vec<usize>,
    /// Fixed magnitude of each bus whose magnitude is not an unknown.
    pub v_fixed: Vec<Option<f64>>,
    /// For each bus, the reactive rows that use its `G_i`, with their coefficients.
    pub q_uses: Vec<Vec<(usize, f64)>>,
    /// Constant term of each reactive row (indexed from the first reactive row).
    pub q_const: Vec<f64>,
    /// Number of active power rows (= angle unknowns).
    pub n_p: usize,
    /// Order of the system.
    pub dim: usize,
}

/// One voltage control group: the bus it regulates, its target and its controller buses with their reactive keys
/// (`G_c = a + k·b` with one `k` for the group).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Group {
    /// Regulated bus.
    pub bus: usize,
    /// Target magnitude, p.u.
    pub target: f64,
    /// Controller buses with their key offset `a` and slope `b`.
    pub controllers: Vec<(usize, f64, f64)>,
}

impl Structure {
    /// The structure for the given references (angle fixed) and voltage control groups. Buses not in any group keep
    /// an unknown magnitude unless `v_fixed_extra` fixes it.
    pub fn new(n: usize, reference: &[bool], groups: &[Group]) -> Self {
        let mut col_a = vec![NONE; n];
        let mut n_p = 0;
        for i in 0..n {
            if !reference[i] {
                col_a[i] = n_p;
                n_p += 1;
            }
        }
        let mut v_fixed = vec![None; n];
        let mut controller = vec![false; n];
        for g in groups {
            v_fixed[g.bus] = Some(g.target);
            for &(c, _, _) in &g.controllers {
                controller[c] = true;
            }
        }
        let mut col_m = vec![NONE; n];
        let mut dim = n_p;
        for i in 0..n {
            if v_fixed[i].is_none() {
                col_m[i] = dim;
                dim += 1;
            }
        }
        let mut q_uses: Vec<Vec<(usize, f64)>> = vec![Vec::new(); n];
        let mut q_const = Vec::new();
        let mut row = n_p;
        for i in 0..n {
            if !controller[i] {
                q_uses[i].push((row, 1.0));
                q_const.push(0.0);
                row += 1;
            }
        }
        for g in groups {
            let Some(&(c0, a0, b0)) = g.controllers.first() else {
                continue;
            };
            for &(c, a, b) in &g.controllers[1..] {
                q_uses[c].push((row, 1.0 / b));
                q_uses[c0].push((row, -1.0 / b0));
                q_const.push(-a / b + a0 / b0);
                row += 1;
            }
        }
        debug_assert_eq!(row, dim, "rows and unknowns must balance");
        Self {
            col_a,
            col_m,
            v_fixed,
            q_uses,
            q_const,
            n_p,
            dim,
        }
    }
}

/// The Jacobian's pattern for a structure and, for every Ybus entry, where each of its derivative terms lands.
#[derive(Clone)]
pub(crate) struct Layout {
    /// The sparsity pattern.
    pub pattern: Pattern,
    /// Start of each Ybus entry's slots in `slots`.
    start: Vec<usize>,
    /// Value slots: per Ybus entry, the active power row's angle and magnitude slots, then each reactive use's.
    slots: Vec<usize>,
    /// Per bus: slot of the active row's own magnitude column and of each reactive use's (for load derivatives).
    diag: Vec<Vec<usize>>,
}

impl Layout {
    pub fn new(y: &Ybus, st: &Structure) -> Self {
        let n = y.n;
        let mut b = CscBuilder::new(st.dim, st.dim);
        b.reserve(6 * y.nnz());
        let mut start = Vec::with_capacity(y.nnz() + 1);
        let mut handles = Vec::with_capacity(4 * y.nnz());
        let push = |b: &mut CscBuilder, r: usize, c: usize| if r == NONE || c == NONE { NONE } else { b.push(r, c) };
        for i in 0..n {
            let rp = st.col_a[i];
            for e in y.row_ptr[i]..y.row_ptr[i + 1] {
                let k = y.col[e];
                let (ca, cm) = (st.col_a[k], st.col_m[k]);
                start.push(handles.len());
                handles.push(push(&mut b, rp, ca));
                handles.push(push(&mut b, rp, cm));
                for &(r, _) in &st.q_uses[i] {
                    handles.push(push(&mut b, r, ca));
                    handles.push(push(&mut b, r, cm));
                }
            }
        }
        start.push(handles.len());
        let mut diag_h: Vec<Vec<usize>> = Vec::with_capacity(n);
        for i in 0..n {
            let cm = st.col_m[i];
            let mut d = vec![push(&mut b, st.col_a[i], cm)];
            for &(r, _) in &st.q_uses[i] {
                d.push(push(&mut b, r, cm));
            }
            diag_h.push(d);
        }
        let (pattern, slot) = b.build();
        let map = |h: usize| if h == NONE { NONE } else { slot[h] };
        Self {
            pattern,
            start,
            slots: handles.into_iter().map(map).collect(),
            diag: diag_h.into_iter().map(|d| d.into_iter().map(map).collect()).collect(),
        }
    }
}

/// Mismatches of every row for voltages `v`, writing the bus currents to `cur`. Returns the largest.
pub(crate) fn mismatch(
    y: &Ybus,
    st: &Structure,
    sch: &Schedule,
    v: &[C64],
    vm: &[f64],
    cur: &mut [C64],
    f: &mut [f64],
) -> f64 {
    y.mul(v, cur);
    f[st.n_p..].copy_from_slice(&st.q_const);
    for i in 0..y.n {
        let s = v[i] * cur[i].conj();
        let (pl, ql, _, _) = sch.load(i, vm[i]);
        if st.col_a[i] != NONE {
            f[st.col_a[i]] = s.re + pl - sch.p_gen[i];
        }
        let g = s.im + ql - sch.q_fixed[i];
        for &(r, c) in &st.q_uses[i] {
            f[r] += c * g;
        }
    }
    f.iter().fold(0.0_f64, |m, x| m.max(x.abs()))
}

/// Fills the Jacobian: ∂S_i/∂θ_k = j·V_i·conj(δ_ik·I_i − Y_ik·V_k), ∂S_i/∂|V_k| = V_i·conj(Y_ik·V_k/|V_k|) +
/// δ_ik·conj(I_i)·V_i/|V_i|, plus the loads' voltage derivatives on the diagonal.
pub(crate) fn jacobian(
    y: &Ybus,
    st: &Structure,
    lay: &Layout,
    sch: &Schedule,
    v: &[C64],
    vm: &[f64],
    cur: &[C64],
    values: &mut [f64],
) {
    values.fill(0.0);
    let mut put = |slot: usize, x: f64| {
        if slot != NONE {
            values[slot] += x;
        }
    };
    for i in 0..y.n {
        let vi = v[i];
        let uses = &st.q_uses[i];
        for e in y.row_ptr[i]..y.row_ptr[i + 1] {
            let k = y.col[e];
            let yik = y.val[e];
            let mut a = -(yik * v[k]);
            let unit_k = v[k].scale(1.0 / vm[k]);
            let mut dm = vi * (yik * unit_k).conj();
            if k == i {
                a += cur[i];
                dm += cur[i].conj() * unit_k;
            }
            let da = C64::new(0.0, 1.0) * vi * a.conj();
            let h = &lay.slots[lay.start[e]..lay.start[e + 1]];
            put(h[0], da.re);
            put(h[1], dm.re);
            for (u, &(_, c)) in uses.iter().enumerate() {
                put(h[2 + 2 * u], c * da.im);
                put(h[3 + 2 * u], c * dm.im);
            }
        }
        let (_, _, dp, dq) = sch.load(i, vm[i]);
        if dp != 0.0 || dq != 0.0 {
            let d = &lay.diag[i];
            put(d[0], dp);
            for (u, &(_, c)) in uses.iter().enumerate() {
                put(d[1 + u], c * dq);
            }
        }
    }
}
