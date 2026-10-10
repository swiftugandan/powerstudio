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

/// The Jacobian's shape for a network: unknowns and rows that do not change as the voltage controls change state, so
/// one ordering and symbolic factorisation serves every state (machines reaching or leaving their reactive limits).
///
/// Every bus that is not a reference has an angle column and an active power row; every bus has a magnitude column and
/// a reactive row, both numbered `n_p + i`. A bus's reactive row holds its reactive balance, or, for a controller
/// bus, the voltage equation of its group (`V = target`, when it is the group's first controller) or the sharing
/// equation of its group (otherwise). The shape provides for every state the potential groups allow: each bus's
/// `G_i` may appear in its own row and in the rows of the other controllers of its groups, and each controller's row
/// may hold its group's voltage equation. Entries a state does not use stay in the pattern as zeros.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Shape {
    /// Angle column (and active power row) of each bus, or [`NONE`] for references.
    pub col_a: Vec<usize>,
    /// Number of angle columns.
    pub n_p: usize,
    /// For each bus, the reactive rows its `G_i` may appear in, sorted.
    pub g_rows: Vec<Vec<usize>>,
    /// The rows that may hold a voltage equation, with the bus whose magnitude they fix, sorted.
    pub v_rows: Vec<(usize, usize)>,
}

impl Shape {
    /// The shape for the given references and the voltage control groups every state of the controls stays within
    /// (each machine that may control voltage in it).
    pub fn new(n: usize, reference: &[bool], potential: &[Group]) -> Self {
        let mut col_a = vec![NONE; n];
        let mut n_p = 0;
        for i in 0..n {
            if !reference[i] {
                col_a[i] = n_p;
                n_p += 1;
            }
        }
        let mut g_rows: Vec<Vec<usize>> = (0..n).map(|i| vec![n_p + i]).collect();
        let mut v_rows = Vec::new();
        for g in potential {
            for &(c, _, _) in &g.controllers {
                v_rows.push((n_p + c, g.bus));
                for &(d, _, _) in &g.controllers {
                    g_rows[c].push(n_p + d);
                }
            }
        }
        for rows in &mut g_rows {
            rows.sort_unstable();
            rows.dedup();
        }
        v_rows.sort_unstable();
        v_rows.dedup();
        Self {
            col_a,
            n_p,
            g_rows,
            v_rows,
        }
    }

    /// Order of the system.
    pub fn dim(&self) -> usize {
        self.n_p + self.g_rows.len()
    }

    /// Whether a state's equations fit this shape.
    pub fn covers(&self, st: &Structure) -> bool {
        st.col_a == self.col_a
            && st
                .q_uses
                .iter()
                .zip(&self.g_rows)
                .all(|(uses, rows)| uses.iter().all(|(r, _)| rows.binary_search(r).is_ok()))
            && st
                .v_eq
                .iter()
                .all(|&(r, b, _)| self.v_rows.binary_search(&(r, b)).is_ok())
    }

    /// A shape covering this one and a state's equations as well.
    pub fn widened(&self, st: &Structure) -> Self {
        let mut out = self.clone();
        for (rows, uses) in out.g_rows.iter_mut().zip(&st.q_uses) {
            rows.extend(uses.iter().map(|u| u.0));
            rows.sort_unstable();
            rows.dedup();
        }
        out.v_rows.extend(st.v_eq.iter().map(|&(r, b, _)| (r, b)));
        out.v_rows.sort_unstable();
        out.v_rows.dedup();
        out
    }
}

/// The equations for one state of the controls, within a [`Shape`].
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Structure {
    /// Angle column of each bus, or [`NONE`] for references. Active power rows use the same numbering.
    pub col_a: Vec<usize>,
    /// Magnitude column of each bus, or [`NONE`] when a control fixes it (its column then belongs to the voltage
    /// equation, which keeps it at the target).
    pub col_m: Vec<usize>,
    /// Fixed magnitude of each bus whose magnitude is not an unknown.
    pub v_fixed: Vec<Option<f64>>,
    /// For each bus, the reactive rows that use its `G_i`, with their coefficients.
    pub q_uses: Vec<Vec<(usize, f64)>>,
    /// Constant term of each reactive row (indexed from the first reactive row).
    pub q_const: Vec<f64>,
    /// Voltage equations: row, bus and target magnitude, p.u.
    pub v_eq: Vec<(usize, usize, f64)>,
    /// Number of active power rows (= angle unknowns).
    pub n_p: usize,
    /// Order of the system.
    pub dim: usize,
}

impl Structure {
    /// The equations for the given voltage control groups, numbered as `shape` numbers them.
    pub fn new(shape: &Shape, groups: &[Group]) -> Self {
        let n = shape.g_rows.len();
        let n_p = shape.n_p;
        let mut v_fixed = vec![None; n];
        let mut controller = vec![false; n];
        for g in groups {
            v_fixed[g.bus] = Some(g.target);
            for &(c, _, _) in &g.controllers {
                controller[c] = true;
            }
        }
        let col_m: Vec<usize> = (0..n)
            .map(|i| if v_fixed[i].is_none() { n_p + i } else { NONE })
            .collect();
        let mut q_uses: Vec<Vec<(usize, f64)>> = vec![Vec::new(); n];
        let mut q_const = vec![0.0; n];
        let mut v_eq = Vec::new();
        for i in 0..n {
            if !controller[i] {
                q_uses[i].push((n_p + i, 1.0));
            }
        }
        for g in groups {
            let Some(&(c0, a0, b0)) = g.controllers.first() else {
                continue;
            };
            v_eq.push((n_p + c0, g.bus, g.target));
            for &(c, a, b) in &g.controllers[1..] {
                q_uses[c].push((n_p + c, 1.0 / b));
                q_uses[c0].push((n_p + c, -1.0 / b0));
                q_const[c] = -a / b + a0 / b0;
            }
        }
        Self {
            col_a: shape.col_a.clone(),
            col_m,
            v_fixed,
            q_uses,
            q_const,
            v_eq,
            n_p,
            dim: shape.dim(),
        }
    }
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

/// The Jacobian's pattern for a shape and, for every Ybus entry, where each of its derivative terms lands.
#[derive(Clone)]
pub(crate) struct Layout {
    /// The sparsity pattern.
    pub pattern: Pattern,
    /// Start of each Ybus entry's slots in `slots`.
    start: Vec<usize>,
    /// Value slots: per Ybus entry, the active power row's angle and magnitude slots, then those of each reactive row
    /// the bus's `G_i` may appear in.
    slots: Vec<usize>,
    /// Per bus: slot of the active row's own magnitude column and of each such reactive row's (for load derivatives).
    diag: Vec<Vec<usize>>,
    /// The reactive rows of each bus, as the shape lists them (to find a use's slots).
    g_rows: Vec<Vec<usize>>,
    /// Slot of each potential voltage equation's entry, by (row, bus).
    v_slots: Vec<((usize, usize), usize)>,
}

impl Layout {
    pub fn new(y: &Ybus, shape: &Shape) -> Self {
        let n = y.n;
        let dim = shape.dim();
        let col_m = |i: usize| shape.n_p + i;
        let mut b = CscBuilder::new(dim, dim);
        b.reserve(6 * y.nnz());
        let mut start = Vec::with_capacity(y.nnz() + 1);
        let mut handles = Vec::with_capacity(4 * y.nnz());
        let push = |b: &mut CscBuilder, r: usize, c: usize| if r == NONE || c == NONE { NONE } else { b.push(r, c) };
        for i in 0..n {
            let rp = shape.col_a[i];
            for e in y.row_ptr[i]..y.row_ptr[i + 1] {
                let k = y.col[e];
                let (ca, cm) = (shape.col_a[k], col_m(k));
                start.push(handles.len());
                handles.push(push(&mut b, rp, ca));
                handles.push(push(&mut b, rp, cm));
                for &r in &shape.g_rows[i] {
                    handles.push(push(&mut b, r, ca));
                    handles.push(push(&mut b, r, cm));
                }
            }
        }
        start.push(handles.len());
        let mut diag_h: Vec<Vec<usize>> = Vec::with_capacity(n);
        for i in 0..n {
            let mut d = vec![push(&mut b, shape.col_a[i], col_m(i))];
            for &r in &shape.g_rows[i] {
                d.push(push(&mut b, r, col_m(i)));
            }
            diag_h.push(d);
        }
        let v_h: Vec<((usize, usize), usize)> = shape
            .v_rows
            .iter()
            .map(|&(r, bus)| ((r, bus), push(&mut b, r, col_m(bus))))
            .collect();
        let (pattern, slot) = b.build();
        let map = |h: usize| if h == NONE { NONE } else { slot[h] };
        Self {
            pattern,
            start,
            slots: handles.into_iter().map(map).collect(),
            diag: diag_h.into_iter().map(|d| d.into_iter().map(map).collect()).collect(),
            g_rows: shape.g_rows.clone(),
            v_slots: v_h.into_iter().map(|(k, h)| (k, map(h))).collect(),
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
    for &(r, bus, target) in &st.v_eq {
        f[r] = vm[bus] - target;
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
    // Where each of a bus's reactive uses sits among the rows its shape provides.
    let mut pos: Vec<usize> = Vec::new();
    for i in 0..y.n {
        let vi = v[i];
        let uses = &st.q_uses[i];
        pos.clear();
        pos.extend(
            uses.iter()
                .map(|(r, _)| lay.g_rows[i].binary_search(r).unwrap_or(usize::MAX)),
        );
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
            if st.col_m[k] != NONE {
                put(h[1], dm.re);
            }
            for (&p, &(_, c)) in pos.iter().zip(uses) {
                if p == usize::MAX {
                    continue;
                }
                put(h[2 + 2 * p], c * da.im);
                if st.col_m[k] != NONE {
                    put(h[3 + 2 * p], c * dm.im);
                }
            }
        }
        let (_, _, dp, dq) = sch.load(i, vm[i]);
        if (dp != 0.0 || dq != 0.0) && st.col_m[i] != NONE {
            let d = &lay.diag[i];
            put(d[0], dp);
            for (&p, &(_, c)) in pos.iter().zip(uses) {
                if p != usize::MAX {
                    put(d[1 + p], c * dq);
                }
            }
        }
    }
    // A voltage equation's only entry: its magnitude.
    for &(r, bus, _) in &st.v_eq {
        if let Ok(k) = lay.v_slots.binary_search_by(|e| e.0.cmp(&(r, bus))) {
            put(lay.v_slots[k].1, 1.0);
        }
    }
}
