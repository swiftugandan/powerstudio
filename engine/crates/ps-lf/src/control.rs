//! The outer loops: each checks a converged Newton solution and changes the network's controls where it must.
//!
//! The rules follow PowSyBl OpenLoadFlow 2.3, so the two tools reach the same discrete state on the same data
//! (docs/research/sources.md cites the classes):
//!
//! * **Distributed slack** (`DistributedSlackOuterLoop`, `GenerationActivePowerDistributionStep`): the imbalance left
//!   on an island's reference, plus everything distributed before, is shared again from the machines' initial
//!   targets, in proportion to the chosen factor; a machine that reaches a limit (or would change sign) is held there
//!   and the rest is shared again among the others.
//! * **Reactive limits** (`ReactiveLimitsOuterLoop`): limits apply per controller bus, the sum of its voltage-
//!   controlling units' limits. A bus beyond a limit is held at it; at least one controller bus stays in voltage
//!   control; a held bus returns to voltage control when its voltage passes the target in the direction the limit
//!   was resisting, at most three times.

use crate::MachineMode;
use crate::newton::{Balance, Control, ControlLog, Options, Solver, Work};

/// The outcome of one check.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Status {
    /// Nothing to change.
    Stable,
    /// Something changed: solve again.
    Unstable,
}

/// Smallest active power worth moving, p.u. (OpenLoadFlow's `P_RESIDUE_EPS`).
const P_RESIDUE: f64 = 1e-5;

/// Times a bus may go from a reactive limit back to voltage control.
const MAX_PQ_PV: u8 = 3;

/// The enabled outer loops, in the order they run.
pub(crate) fn enabled(opt: &Options) -> Vec<Control> {
    let mut out = Vec::new();
    if opt.balance != Balance::Reference {
        out.push(Control::Slack);
    }
    if opt.enforce_q_limits {
        out.push(Control::ReactiveLimits);
    }
    if opt.phase_control {
        out.push(Control::PhaseShifters);
    }
    if opt.tap_control {
        out.push(Control::Taps);
    }
    if opt.shunt_control {
        out.push(Control::Shunts);
    }
    out
}

/// Checks one control on the present solution.
pub(crate) fn check(c: Control, work: &mut Work, s: &mut Solver, opt: &Options) -> Status {
    match c {
        Control::Slack => slack(work, s, opt),
        Control::ReactiveLimits => reactive_limits(work, s, opt),
        Control::PhaseShifters => crate::discrete::phase_shifters(work, s, opt),
        Control::Taps => crate::discrete::taps(work, s, opt),
        Control::Shunts => crate::discrete::shunts(work, s, opt),
    }
}

/// The loops that were still changing when the limit on changes was reached, in words.
pub(crate) fn unsettled(controls: &[ControlLog]) -> String {
    let names: Vec<&str> = controls
        .iter()
        .filter(|c| c.changes > 0)
        .map(|c| match c.control {
            Control::Slack => "slack distribution",
            Control::ReactiveLimits => "reactive power limits",
            Control::PhaseShifters => "phase shifters",
            Control::Taps => "tap changers",
            Control::Shunts => "switched shunts",
        })
        .collect();
    if names.is_empty() {
        "no control changed".into()
    } else {
        names.join(", ")
    }
}

/// Distributed slack: shares each island's imbalance as configured.
fn slack(work: &mut Work, s: &mut Solver, opt: &Options) -> Status {
    let inj = s.injections();
    let k = work.islands;
    let mut has_grid = vec![false; k];
    for g in &work.net.grids {
        has_grid[work.island[g.bus]] = true;
    }
    // The imbalance each island's reference buses carry beyond their machines' targets.
    let mut mismatch = vec![0.0; k];
    let mut has_ref = vec![false; k];
    let mut ref_bus = vec![false; work.net.buses.len()];
    for g in &work.net.machines {
        if g.mode == MachineMode::Reference {
            ref_bus[g.bus] = true;
        }
    }
    for (b, &r) in ref_bus.iter().enumerate() {
        if r {
            let (pl, _, _, _) = s.sch.load(b, s.vm[b]);
            mismatch[work.island[b]] += inj[b].re + pl;
            has_ref[work.island[b]] = true;
        }
    }
    for (m, g) in work.net.machines.iter().enumerate() {
        if ref_bus[g.bus] {
            mismatch[work.island[g.bus]] -= work.target_p[m];
        }
    }
    let mut moved = false;
    for isl in 0..k {
        let m = mismatch[isl];
        if !has_ref[isl] || has_grid[isl] || m.abs() <= opt.slack_tolerance.max(P_RESIDUE) {
            continue;
        }
        let (remaining, any) = if opt.balance == Balance::Load {
            distribute_on_loads(work, isl, m)
        } else {
            distribute_on_machines(work, isl, m, opt.balance)
        };
        moved |= any;
        if remaining.abs() > P_RESIDUE {
            let note = format!(
                "The participating units of an island could not take {:.2} MW of its imbalance; the reference \
                 carries it.",
                remaining * work.net.base_mva
            );
            if !work.notes.contains(&note) {
                work.notes.push(note);
            }
        }
    }
    if moved { Status::Unstable } else { Status::Stable }
}

/// Shares `mismatch` (plus everything shared before) among the island's participating machines from their initial
/// targets. Returns what could not be placed and whether any target moved.
fn distribute_on_machines(work: &mut Work, isl: usize, mismatch: f64, balance: Balance) -> (f64, bool) {
    let net = &work.net;
    let members: Vec<usize> = (0..net.machines.len())
        .filter(|&m| work.island[net.machines[m].bus] == isl)
        .filter(|&m| work.participating[m] || net.machines[m].mode == MachineMode::Reference)
        .collect();
    let before: Vec<f64> = members.iter().map(|&m| work.target_p[m]).collect();
    let mut remaining = mismatch;
    for &m in &members {
        remaining += work.target_p[m] - work.initial_p[m];
        work.target_p[m] = work.initial_p[m];
    }
    let total = remaining;
    let factor = |m: usize, t: f64| -> f64 {
        let g = &net.machines[m];
        match balance {
            Balance::MaxP => g.p_max,
            Balance::TargetP => t.abs(),
            Balance::Factor => g.factor,
            Balance::Margin => {
                let (lo, hi) = if t < 0.0 {
                    (g.p_min, g.p_max.min(0.0))
                } else {
                    (g.p_min.max(0.0), g.p_max)
                };
                if mismatch > 0.0 {
                    (hi - t).max(0.0)
                } else {
                    (t - lo).max(0.0)
                }
            }
            _ => 0.0,
        }
    };
    let mut elements: Vec<(usize, f64)> = members
        .iter()
        .filter(|&&m| work.participating[m])
        .map(|&m| (m, factor(m, work.target_p[m])))
        .filter(|&(_, f)| f != 0.0)
        .collect();
    while !elements.is_empty() && remaining.abs() > P_RESIDUE {
        let norm: f64 = elements.iter().map(|e| e.1).sum();
        if norm <= 0.0 {
            break;
        }
        let mut done = 0.0;
        elements.retain(|&(m, f)| {
            let g = &net.machines[m];
            let t = work.target_p[m];
            let (mut lo, mut hi) = (g.p_min, g.p_max);
            if t < 0.0 {
                hi = hi.min(0.0);
            } else {
                lo = lo.max(0.0);
            }
            let mut new = t + remaining * f / norm;
            let mut keep = true;
            if remaining > 0.0 && new > hi {
                new = hi;
                keep = false;
            } else if remaining < 0.0 && new < lo {
                new = lo;
                keep = false;
            }
            done += new - t;
            work.target_p[m] = new;
            keep
        });
        remaining -= done;
    }
    work.distributed[isl] = total - remaining;
    let moved: f64 = members
        .iter()
        .zip(&before)
        .map(|(&m, b)| (work.target_p[m] - b).abs())
        .sum();
    (remaining, moved > P_RESIDUE * 0.9)
}

/// Shares `mismatch` among the island's loads in proportion to their initial active power.
fn distribute_on_loads(work: &mut Work, isl: usize, mismatch: f64) -> (f64, bool) {
    let net = &work.net;
    let members: Vec<usize> = (0..net.loads.len())
        .filter(|&k| work.island[net.loads[k].bus] == isl && net.loads[k].p != 0.0)
        .collect();
    let norm: f64 = members.iter().map(|&k| net.loads[k].p.abs()).sum();
    if norm <= 0.0 {
        return (mismatch, false);
    }
    let mut done = 0.0;
    for &k in &members {
        let d = mismatch * net.loads[k].p.abs() / norm;
        work.load_p[k] -= d;
        done += d;
    }
    work.distributed[isl] += done;
    (mismatch - done, done.abs() > P_RESIDUE * 0.9)
}

/// Reactive power limits per controller bus, with release back to voltage control.
fn reactive_limits(work: &mut Work, s: &mut Solver, opt: &Options) -> Status {
    let n = work.net.buses.len();
    let inj = s.injections();
    let eps = opt.tolerance;
    let mut grid_bus = vec![false; n];
    for g in &work.net.grids {
        grid_bus[g.bus] = true;
    }
    // Controlling machines of each bus.
    let mut units: Vec<Vec<usize>> = vec![Vec::new(); n];
    for (m, g) in work.net.machines.iter().enumerate() {
        if g.mode != MachineMode::Pq && !work.fixed_q[m] && !grid_bus[g.bus] {
            units[g.bus].push(m);
        }
    }
    let mut to_pq: Vec<(usize, f64, i8)> = Vec::new();
    let mut to_pv: Vec<usize> = Vec::new();
    let mut refreeze: Vec<(usize, f64)> = Vec::new();
    let mut remaining = grid_bus.iter().filter(|&&g| g).count();
    for b in 0..n {
        if units[b].is_empty() {
            continue;
        }
        let (lo, hi) = units[b].iter().fold((0.0, 0.0), |(a, c), &m| {
            let (l, h) = work.q_limits(m, &s.vm);
            (a + l, c + h)
        });
        match work.frozen[b] {
            None => {
                let (_, ql, _, _) = s.sch.load(b, s.vm[b]);
                let q = inj[b].im + ql - s.sch.q_fixed[b];
                if q < lo - eps {
                    to_pq.push((b, lo, -1));
                } else if q > hi + eps {
                    to_pq.push((b, hi, 1));
                } else {
                    remaining += 1;
                }
            }
            Some((q, lim)) => {
                let first = units[b][0];
                let reg = work.reg_bus(first, opt);
                let target = work.net.machines[first].v_set;
                let v = s.vm[reg];
                let free = work.switches[b] < MAX_PQ_PV;
                if lim < 0 {
                    if v < target && free {
                        to_pv.push(b);
                    } else if (lo - q).abs() > eps {
                        refreeze.push((b, lo));
                    }
                } else if v > target && free {
                    to_pv.push(b);
                } else if (hi - q).abs() > eps {
                    refreeze.push((b, hi));
                }
            }
        }
    }
    if !to_pq.is_empty() && remaining == 0 {
        // Keep the strongest controller in voltage control: the highest regulated voltage level, then the largest
        // active power, then the first bus.
        let key = |&(b, _, _): &(usize, f64, i8)| {
            let first = units[b][0];
            let reg = work.reg_bus(first, opt);
            let p: f64 = units[b].iter().map(|&m| work.target_p[m]).sum();
            (-work.net.buses[reg].base_kv, -p, b)
        };
        if let Some(k) = (0..to_pq.len()).min_by(|&x, &y| {
            key(&to_pq[x])
                .partial_cmp(&key(&to_pq[y]))
                .unwrap_or(std::cmp::Ordering::Equal)
        }) {
            to_pq.remove(k);
        }
    }
    let changed = !to_pq.is_empty() || !to_pv.is_empty() || !refreeze.is_empty();
    for (b, q, lim) in to_pq {
        work.frozen[b] = Some((q, lim));
        work.switches[b] = work.switches[b].saturating_add(1);
    }
    for b in to_pv {
        work.frozen[b] = None;
    }
    for (b, q) in refreeze {
        if let Some(f) = &mut work.frozen[b] {
            f.0 = q;
        }
    }
    if changed { Status::Unstable } else { Status::Stable }
}
