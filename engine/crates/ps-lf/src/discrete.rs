//! Discrete controls: tap changers that regulate voltage, phase shifters that regulate flow and switched shunts that
//! regulate voltage. Each moves whole positions or sections, by OpenLoadFlow's incremental rules (docs/research/
//! sources.md cites the classes), so the two tools land on the same positions:
//!
//! * The needed change comes from a sensitivity at the converged state (the Jacobian solved against the derivative
//!   of the mismatches with respect to the control), and the new position is the one whose value is closest to the
//!   present value plus that change. Ties keep the present position.
//! * A tap changer whose regulated voltage barely responds (|dV/dρ| < 0.05) is left alone until another control
//!   has acted. A single tap changer on a bus moves at most three positions per round; several on one bus move one
//!   position each per pass until the voltage is within the dead band.
//! * Shunts of a bus move one section per pass, at most four per round; the bus's shunts with the largest present
//!   susceptance move first.
//! * After three reversals a control may only move in the direction of its next move.
//! * A regulated voltage aims at the bus's highest-priority target: a machine's before a tap changer's before a
//!   shunt's. A voltage a machine holds does not respond to taps, so they leave it alone.

use ps_num::C64;

use crate::control::Status;
use crate::equations::{NONE, jacobian};
use crate::newton::{Options, Solver, Work};
use crate::{PuBranch, TapTarget};

/// Insensitivity threshold of tap changers, p.u. voltage per p.u. ratio.
const MIN_SENSITIVITY: f64 = 0.05;
/// Positions a single tap changer may move per round.
const MAX_TAP_SHIFT: usize = 3;
/// Sections a shunt may move per round, less one (OpenLoadFlow allows one more than its setting).
const MAX_SECTION_SHIFT: usize = 3;
/// Reversals before a control's direction is locked.
const MAX_DIRECTION_CHANGE: u8 = 3;
/// Smallest flow sensitivity worth acting on, p.u. per radian.
const SENSI_EPS: f64 = 1e-6;

/// Movement history of one discrete control.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub(crate) struct Motion {
    /// Direction of the last move: +1 up, −1 down, 0 none yet.
    last: i8,
    /// Reversals so far.
    changes: u8,
    /// Locked direction once reversals reach the limit: +1, −1 or 0 for either.
    allowed: i8,
    /// Marked as not responding (tap changers only).
    insensitive: bool,
}

impl Motion {
    fn record(&mut self, dir: i8) {
        if self.changes < MAX_DIRECTION_CHANGE {
            if self.last != 0 && self.last != dir {
                self.changes += 1;
            }
            self.last = dir;
        } else {
            self.allowed = dir;
        }
    }

    /// Index range a move may reach from `cur` among `count` positions starting at `min`.
    fn range(&self, cur: usize, min: usize, count: usize) -> (usize, usize) {
        match self.allowed {
            1 => (cur, count - 1),
            -1 => (min, cur),
            _ => (min, count - 1),
        }
    }
}

/// The state the discrete controls keep between rounds.
#[derive(Debug, Clone, Default)]
pub(crate) struct DiscreteState {
    /// Per tap branch, per axis.
    pub taps: Vec<Vec<Motion>>,
    /// Per controlled shunt.
    pub shunts: Vec<Motion>,
    /// Outer round when the tap loop last ran.
    pub tap_round: Option<usize>,
}

impl DiscreteState {
    pub fn new(work_taps: &[crate::PuTapBranch], shunts: usize) -> Self {
        Self {
            taps: work_taps
                .iter()
                .map(|t| vec![Motion::default(); t.axes.len()])
                .collect(),
            shunts: vec![Motion::default(); shunts],
            tap_round: None,
        }
    }
}

/// The closest position to `want` among `values` within `range` and `shift` of `cur`; the present position wins a
/// tie, then the lowest index.
fn closest(values: &[f64], cur: usize, want: f64, (lo, hi): (usize, usize), shift: usize) -> usize {
    let mut best = cur;
    let mut dist = (want - values[cur]).abs();
    for i in lo..=hi {
        if i.abs_diff(cur) > shift {
            continue;
        }
        let d = (want - values[i]).abs();
        if d < dist {
            best = i;
            dist = d;
        }
    }
    best
}

impl Solver {
    /// Factorises the Jacobian at the present voltages, for sensitivities.
    fn factor_here(&mut self) -> bool {
        let n = self.y.n;
        let v: Vec<C64> = (0..n).map(|i| C64::from_polar(self.vm[i], self.va[i])).collect();
        let mut cur = vec![C64::ZERO; n];
        self.y.mul(&v, &mut cur);
        let mut values = vec![0.0; self.lay.pattern.nnz()];
        jacobian(&self.y, &self.st, &self.lay, &self.sch, &v, &self.vm, &cur, &mut values);
        use ps_sparse::SparseSolver;
        self.factored = self.lu.factor(&values).is_ok();
        self.factored
    }

    /// `J⁻¹·rhs`, or `None` when the system cannot be solved.
    fn solve_rhs(&mut self, mut rhs: Vec<f64>) -> Option<Vec<f64>> {
        use ps_sparse::SparseSolver;
        self.lu.solve(&mut rhs).ok()?;
        rhs.iter().all(|x| x.is_finite()).then_some(rhs)
    }

    fn voltage(&self, i: usize) -> C64 {
        C64::from_polar(self.vm[i], self.va[i])
    }

    /// Adds the power changes `ds_f` and `ds_t` at a branch's ends to the mismatch rows (their derivative).
    fn add_rows(&self, rhs: &mut [f64], f: usize, t: usize, ds_f: C64, ds_t: C64) {
        for (bus, ds) in [(f, ds_f), (t, ds_t)] {
            if self.st.col_a[bus] != NONE {
                rhs[self.st.col_a[bus]] += ds.re;
            }
            for &(r, c) in &self.st.q_uses[bus] {
                rhs[r] += c * ds.im;
            }
        }
    }

    /// Change of the state per unit change of a parameter whose mismatch derivative is `rhs`: −J⁻¹·∂F/∂p.
    fn response(&mut self, rhs: Vec<f64>) -> Option<Vec<f64>> {
        self.solve_rhs(rhs).map(|x| x.into_iter().map(|v| -v).collect())
    }

    /// dV/dr1 of bus `bus` for the branch's from-end ratio in OpenLoadFlow's sense (r1 = 1/ratio).
    fn ratio_sensitivity(&mut self, br: &PuBranch, ratio: f64, bus: usize) -> f64 {
        if self.st.col_m[bus] == NONE {
            return 0.0;
        }
        let (vf, vt) = (self.voltage(br.f), self.voltage(br.t));
        // ∂I/∂ρ with ρ the ratio at the from end, then ρ = 1/r1.
        let di_f = -(br.yff * vf).scale(2.0 / ratio) - (br.yft * vt).scale(1.0 / ratio);
        let di_t = -(br.ytf * vf).scale(1.0 / ratio);
        let k = -ratio * ratio;
        let mut rhs = vec![0.0; self.st.dim];
        self.add_rows(
            &mut rhs,
            br.f,
            br.t,
            (vf * di_f.conj()).scale(k),
            (vt * di_t.conj()).scale(k),
        );
        self.response(rhs).map_or(0.0, |dx| dx[self.st.col_m[bus]])
    }

    /// dV/dB of bus `bus` for a susceptance added at bus `at`.
    fn shunt_sensitivity(&mut self, at: usize, bus: usize) -> f64 {
        if self.st.col_m[bus] == NONE {
            return 0.0;
        }
        let mut rhs = vec![0.0; self.st.dim];
        // A susceptance B at `at` injects Q = B·V²; the mismatch counts power leaving the bus.
        let v2 = self.vm[at] * self.vm[at];
        for &(r, c) in &self.st.q_uses[at] {
            rhs[r] += -c * v2;
        }
        self.response(rhs).map_or(0.0, |dx| dx[self.st.col_m[bus]])
    }

    /// Active power entering a branch at its from end, p.u.
    fn flow_from(&self, br: &PuBranch) -> f64 {
        let (vf, vt) = (self.voltage(br.f), self.voltage(br.t));
        (vf * (br.yff * vf + br.yft * vt).conj()).re
    }

    /// dP/dα of the flow entering a branch at its from end, per radian of its own phase shift.
    fn phase_sensitivity(&mut self, br: &PuBranch) -> f64 {
        let (vf, vt) = (self.voltage(br.f), self.voltage(br.t));
        let j = C64::new(0.0, 1.0);
        let ds_f = vf * (j * br.yft * vt).conj();
        let ds_t = vt * (-(j * br.ytf * vf)).conj();
        let mut rhs = vec![0.0; self.st.dim];
        self.add_rows(&mut rhs, br.f, br.t, ds_f, ds_t);
        let Some(dx) = self.response(rhs) else { return 0.0 };
        // The flow's own change, then through the state.
        let i_f = br.yff * vf + br.yft * vt;
        let (uf, ut) = (vf.scale(1.0 / self.vm[br.f]), vt.scale(1.0 / self.vm[br.t]));
        let d_af = j * vf * i_f.conj() - j * vf * (br.yff * vf).conj();
        let d_at = -(j * vf * (br.yft * vt).conj());
        let d_mf = uf * i_f.conj() + vf * (br.yff * uf).conj();
        let d_mt = vf * (br.yft * ut).conj();
        let mut d = ds_f.re;
        for (col, g) in [
            (self.st.col_a[br.f], d_af),
            (self.st.col_a[br.t], d_at),
            (self.st.col_m[br.f], d_mf),
            (self.st.col_m[br.t], d_mt),
        ] {
            if col != NONE {
                d += g.re * dx[col];
            }
        }
        d
    }
}

impl Work {
    /// The voltage target of a regulated bus by priority: a machine's (held at a limit or not), else `own`.
    fn priority_target(&self, bus: usize, own: f64, opt: &Options) -> f64 {
        for g in &self.net.grids {
            if g.bus == bus {
                return g.v_set;
            }
        }
        for (m, g) in self.net.machines.iter().enumerate() {
            if g.mode != crate::MachineMode::Pq && !self.fixed_q[m] && self.reg_bus(m, opt) == bus {
                return g.v_set;
            }
        }
        own
    }

    /// Applies a tap branch's present positions to its branch.
    fn apply_taps(&mut self, k: usize) {
        let t = &self.net.taps[k];
        let tp = t.current();
        let br = &mut self.net.branches[t.branch];
        br.yff = tp.yff;
        br.yft = tp.yft;
        br.ytf = tp.ytf;
        br.ytt = tp.ytt;
        br.shift = tp.shift;
    }
}

/// Transformer voltage control.
pub(crate) fn taps(work: &mut Work, s: &mut Solver, opt: &Options) -> Status {
    // Insensitive tap changers are retried once another control has acted.
    if work.discrete.tap_round.is_some_and(|r| work.outer > r + 1) {
        for m in work.discrete.taps.iter_mut().flatten() {
            m.insensitive = false;
        }
    }
    work.discrete.tap_round = Some(work.outer);
    let n = work.net.buses.len();
    // Controllers by regulated bus, with the bus's target and dead band (the first controller's target; the
    // smallest dead band).
    let mut by_bus: Vec<Vec<(usize, usize)>> = vec![Vec::new(); n];
    let mut own: Vec<(f64, f64)> = vec![(0.0, f64::INFINITY); n];
    for (k, t) in work.net.taps.iter().enumerate() {
        for (a, ax) in t.axes.iter().enumerate() {
            if let Some(TapTarget::Voltage { bus, target, deadband }) = ax.target
                && !ax.phase
            {
                if by_bus[bus].is_empty() {
                    own[bus].0 = target;
                }
                own[bus].1 = own[bus].1.min(deadband);
                by_bus[bus].push((k, a));
            }
        }
    }
    let mut out: Vec<(usize, f64, f64)> = Vec::new();
    for b in 0..n {
        if by_bus[b].is_empty() {
            continue;
        }
        let target = work.priority_target(b, own[b].0, opt);
        let diff = target - s.vm[b];
        let half = own[b].1 / 2.0;
        if diff.abs() > half {
            out.push((b, diff, half));
        }
    }
    if out.is_empty() || !s.factor_here() {
        return Status::Stable;
    }
    // Sensitivities of every candidate, at the converged state, before any move.
    let mut sens: std::collections::HashMap<(usize, usize), f64> = Default::default();
    for &(b, _, _) in &out {
        for &(k, a) in &by_bus[b] {
            if work.discrete.taps[k][a].insensitive {
                continue;
            }
            let t = &work.net.taps[k];
            let br = work.net.branches[t.branch];
            let x = s.ratio_sensitivity(&br, t.current().ratio, b);
            if x.abs() < MIN_SENSITIVITY {
                work.discrete.taps[k][a].insensitive = true;
            } else {
                sens.insert((k, a), x);
            }
        }
    }
    let mut moved = false;
    for (b, diff, half) in out {
        let ctrls: Vec<(usize, usize, f64)> = by_bus[b]
            .iter()
            .filter_map(|&(k, a)| sens.get(&(k, a)).map(|&x| (k, a, x)))
            .collect();
        if ctrls.len() == 1 {
            let (k, a, x) = ctrls[0];
            moved |= move_tap(work, k, a, diff / x, MAX_TAP_SHIFT).is_some();
        } else if ctrls.len() > 1 {
            let mut remaining = diff;
            let mut changed = true;
            while changed {
                changed = false;
                for &(k, a, x) in &ctrls {
                    if remaining.abs() <= half {
                        continue;
                    }
                    if let Some(dr1) = move_tap(work, k, a, remaining / x, 1) {
                        remaining -= dr1 * x;
                        changed = true;
                        moved = true;
                    }
                }
            }
        }
    }
    if moved { Status::Unstable } else { Status::Stable }
}

/// Moves tap axis `a` of tap branch `k` towards a change of `dr1` in r1 (= 1/ratio), within `shift` positions.
/// Returns the change of r1 made, or `None` when it stays.
fn move_tap(work: &mut Work, k: usize, a: usize, dr1: f64, shift: usize) -> Option<f64> {
    let t = &work.net.taps[k];
    let ax = &t.axes[a];
    let mut idx: Vec<usize> = t.axes.iter().map(|x| x.index).collect();
    let r1: Vec<f64> = (0..ax.count)
        .map(|i| {
            idx[a] = i;
            1.0 / t.table[t.row(&idx)].ratio
        })
        .collect();
    let cur = ax.index;
    let motion = work.discrete.taps[k][a];
    let new = closest(&r1, cur, r1[cur] + dr1, motion.range(cur, 0, ax.count), shift);
    if new == cur {
        return None;
    }
    let made = r1[new] - r1[cur];
    work.net.taps[k].axes[a].index = new;
    work.discrete.taps[k][a].record(if new > cur { 1 } else { -1 });
    work.apply_taps(k);
    Some(made)
}

/// Phase shifter flow control.
pub(crate) fn phase_shifters(work: &mut Work, s: &mut Solver, _opt: &Options) -> Status {
    let mut wanted: Vec<(usize, usize, f64, f64)> = Vec::new();
    for (k, t) in work.net.taps.iter().enumerate() {
        for (a, ax) in t.axes.iter().enumerate() {
            if let Some(TapTarget::Flow { target, deadband }) = ax.target
                && ax.phase
            {
                let p = s.flow_from(&work.net.branches[t.branch]);
                let half = deadband.max(1.0 / work.net.base_mva) / 2.0;
                if (p - target).abs() > half {
                    wanted.push((k, a, target - p, 0.0));
                }
            }
        }
    }
    if wanted.is_empty() || !s.factor_here() {
        return Status::Stable;
    }
    for w in &mut wanted {
        let br = work.net.branches[work.net.taps[w.0].branch];
        w.3 = s.phase_sensitivity(&br);
    }
    let mut moved = false;
    for (k, a, dp, x) in wanted {
        if x.abs() <= SENSI_EPS {
            continue;
        }
        let t = &work.net.taps[k];
        let ax = &t.axes[a];
        let mut idx: Vec<usize> = t.axes.iter().map(|x| x.index).collect();
        let shift: Vec<f64> = (0..ax.count)
            .map(|i| {
                idx[a] = i;
                t.table[t.row(&idx)].shift
            })
            .collect();
        let cur = ax.index;
        let motion = work.discrete.taps[k][a];
        let new = closest(
            &shift,
            cur,
            shift[cur] + dp / x,
            motion.range(cur, 0, ax.count),
            usize::MAX,
        );
        if new != cur {
            work.net.taps[k].axes[a].index = new;
            work.discrete.taps[k][a].record(if new > cur { 1 } else { -1 });
            work.apply_taps(k);
            moved = true;
        }
    }
    if moved { Status::Unstable } else { Status::Stable }
}

/// Shunt voltage control.
pub(crate) fn shunts(work: &mut Work, s: &mut Solver, opt: &Options) -> Status {
    let n = work.net.buses.len();
    let mut by_bus: Vec<Vec<usize>> = vec![Vec::new(); n];
    let mut own: Vec<(f64, f64)> = vec![(0.0, f64::INFINITY); n];
    for (c, sc) in work.net.shunt_controls.iter().enumerate() {
        if by_bus[sc.bus].is_empty() {
            own[sc.bus].0 = sc.target;
        }
        own[sc.bus].1 = own[sc.bus].1.min(sc.deadband);
        by_bus[sc.bus].push(c);
    }
    let mut out: Vec<(usize, f64, f64)> = Vec::new();
    for b in 0..n {
        if by_bus[b].is_empty() {
            continue;
        }
        // A tap changer's target outranks a shunt's.
        let tap_target = work
            .net
            .taps
            .iter()
            .flat_map(|t| t.axes.iter())
            .find_map(|ax| match ax.target {
                Some(TapTarget::Voltage { bus, target, .. }) if bus == b && !ax.phase => Some(target),
                _ => None,
            });
        let target = work.priority_target(b, tap_target.unwrap_or(own[b].0), opt);
        let diff = target - s.vm[b];
        let half = own[b].1 / 2.0;
        if diff.abs() > half {
            out.push((b, diff, half));
        }
    }
    if out.is_empty() || !s.factor_here() {
        return Status::Stable;
    }
    let mut moved = false;
    for (b, diff, half) in out {
        // The controlled shunts by the bus they sit at: each such group shares one sensitivity.
        let mut sites: Vec<(usize, Vec<usize>)> = Vec::new();
        for &c in &by_bus[b] {
            let at = work.net.shunts[work.net.shunt_controls[c].shunt].bus;
            match sites.iter_mut().find(|x| x.0 == at) {
                Some(x) => x.1.push(c),
                None => sites.push((at, vec![c])),
            }
        }
        let present_b = |w: &Work, cs: &[usize]| {
            cs.iter()
                .map(|&c| w.net.shunt_controls[c].steps[w.net.shunt_controls[c].index].im)
                .sum::<f64>()
                .abs()
        };
        sites.sort_by(|x, y| {
            present_b(work, &y.1)
                .partial_cmp(&present_b(work, &x.1))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let range_of = |w: &Work, c: usize| {
            let st = &w.net.shunt_controls[c].steps;
            let (a, z) = (st[0].im, st[st.len() - 1].im);
            (a.max(z) - a.min(z)).abs()
        };
        let sens: Vec<f64> = sites.iter().map(|(at, _)| s.shunt_sensitivity(*at, b)).collect();
        let mut remaining = diff;
        let mut shifts: std::collections::HashMap<usize, usize> = Default::default();
        let mut changed = true;
        while changed {
            changed = false;
            for ((_, cs), &x) in sites.iter().zip(&sens) {
                let mut cs = cs.clone();
                cs.sort_by(|&p, &q| {
                    range_of(work, q)
                        .partial_cmp(&range_of(work, p))
                        .unwrap_or(std::cmp::Ordering::Equal)
                });
                for c in cs {
                    if remaining.abs() <= half {
                        continue;
                    }
                    let done = shifts.get(&c).copied().unwrap_or(0);
                    if done > MAX_SECTION_SHIFT || x == 0.0 || !x.is_finite() {
                        continue;
                    }
                    let sc = &work.net.shunt_controls[c];
                    let bvals: Vec<f64> = sc.steps.iter().map(|y| y.im).collect();
                    let cur = sc.index;
                    let db = remaining / x;
                    let motion = work.discrete.shunts[c];
                    // The present section's distance is the requested change itself.
                    let new = closest(&bvals, cur, bvals[cur] + db, motion.range(cur, 0, bvals.len()), 1);
                    if new != cur {
                        shifts.insert(c, done + 1);
                        work.discrete.shunts[c].record(if new > cur { 1 } else { -1 });
                        remaining -= (bvals[new] - bvals[cur]) * x;
                        let sc = &mut work.net.shunt_controls[c];
                        sc.index = new;
                        let y = sc.steps[new];
                        let k = sc.shunt;
                        work.net.shunts[k].y = y;
                        changed = true;
                        moved = true;
                    }
                }
            }
        }
    }
    if moved { Status::Unstable } else { Status::Stable }
}
