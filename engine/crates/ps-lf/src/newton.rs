//! Newton-Raphson load flow in polar coordinates on a sparse Jacobian.

use ps_num::{C64, clock};
use ps_sparse::{CscBuilder, FaerLu, Pattern, SparseSolver};

use crate::dc::dc_angles;
use crate::flows::bus_injections;
use crate::network::nominal_angles;
use crate::{BusKind, MachineMode, PuNetwork, Ybus};

/// Load flow settings.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Options {
    /// Largest acceptable power mismatch, p.u.
    pub tolerance: f64,
    /// Newton iterations per solve (each reactive-limit round starts its own count).
    pub max_iter: usize,
    /// Hold machines at their reactive power limits.
    pub enforce_q_limits: bool,
    /// Start the angles from a DC load flow instead of the buses' starting values.
    pub dc_start: bool,
    /// Start from the buses' `vm0` and `va0` (a previous solution) instead of setpoints.
    pub warm_start: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            tolerance: 1e-5,
            max_iter: 30,
            enforce_q_limits: false,
            dc_start: true,
            warm_start: false,
        }
    }
}

/// One Newton iteration's progress.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct IterationLog {
    /// Iteration number, counted across reactive-limit rounds.
    pub iteration: usize,
    /// Largest mismatch after it, p.u.
    pub mismatch: f64,
    /// Step length used (1 is a full Newton step; less when the line search cut it back).
    pub step: f64,
}

/// Output of a machine or grid after the solve.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct UnitOutput {
    /// Caller's identifier.
    pub id: usize,
    /// Active power, p.u.
    pub p: f64,
    /// Reactive power, p.u.
    pub q: f64,
    /// Held at a reactive limit: -1 lower, +1 upper, 0 none.
    pub at_limit: i8,
}

/// A load flow solution.
#[derive(Debug, Clone, PartialEq)]
pub struct Solution {
    /// Whether the mismatch fell below the tolerance.
    pub converged: bool,
    /// Plain-language outcome.
    pub message: String,
    /// Newton iterations in total.
    pub iterations: usize,
    /// Final largest mismatch, p.u.
    pub mismatch: f64,
    /// Voltage magnitudes, p.u.
    pub vm: Vec<f64>,
    /// Voltage angles, radians.
    pub va: Vec<f64>,
    /// Bus kinds as finally solved (after reactive-limit switching).
    pub kind: Vec<BusKind>,
    /// Machine outputs, in network order.
    pub machines: Vec<UnitOutput>,
    /// Grid outputs, in network order.
    pub grids: Vec<UnitOutput>,
    /// Per-iteration progress.
    pub log: Vec<IterationLog>,
    /// Machines fixed at a reactive limit, in the order the outer loop fixed them: (machine index, −1 lower / +1 upper).
    pub held: Vec<(usize, i8)>,
    /// Time spent, milliseconds: building and ordering, factorising, everything else.
    pub timing: Timing,
}

/// Where the time of a solve went.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Timing {
    /// Ordering and symbolic factorisation, ms.
    pub analyse_ms: f64,
    /// Numeric factorisations and solves, ms.
    pub factor_solve_ms: f64,
    /// Total, ms.
    pub total_ms: f64,
}

struct Schedule {
    kind: Vec<BusKind>,
    p: Vec<f64>,
    q: Vec<f64>,
}

/// Bus kinds and scheduled injections, given the machines held at a reactive limit (`fixed[m]` is its held output).
fn schedule(net: &PuNetwork, fixed: &[Option<(f64, i8)>]) -> Schedule {
    let n = net.buses.len();
    let mut kind = vec![BusKind::Pq; n];
    let mut p = vec![0.0; n];
    let mut q = vec![0.0; n];
    for l in &net.loads {
        p[l.bus] -= l.p;
        q[l.bus] -= l.q;
    }
    for (m, g) in net.machines.iter().enumerate() {
        match g.mode {
            MachineMode::Reference => kind[g.bus] = BusKind::Reference,
            MachineMode::Pq => {
                p[g.bus] += g.p;
                q[g.bus] += g.q;
            }
            MachineMode::Pv => {
                p[g.bus] += g.p;
                if let Some((qf, _)) = fixed[m] {
                    q[g.bus] += qf;
                } else if kind[g.bus] == BusKind::Pq {
                    kind[g.bus] = BusKind::Pv;
                }
            }
        }
    }
    for g in &net.grids {
        kind[g.bus] = BusKind::Reference;
    }
    Schedule { kind, p, q }
}

/// The Jacobian's fixed structure for one set of bus kinds: unknown numbering and, for every Ybus entry, where its
/// four derivative blocks land in the value array.
struct JacobianLayout {
    pattern: Pattern,
    /// Unknown (θ) column of each bus, or `usize::MAX` for reference buses.
    col_a: Vec<usize>,
    /// Unknown (|V|) column of each bus, or `usize::MAX` for buses with a held voltage.
    col_m: Vec<usize>,
    /// Per Ybus entry: value slots of ∂P/∂θ, ∂P/∂|V|, ∂Q/∂θ, ∂Q/∂|V| (`usize::MAX` when absent).
    slots: Vec<[usize; 4]>,
}

const NONE: usize = usize::MAX;

fn layout(y: &Ybus, kind: &[BusKind]) -> JacobianLayout {
    let n = y.n;
    let mut col_a = vec![NONE; n];
    let mut col_m = vec![NONE; n];
    let mut dim = 0;
    for i in 0..n {
        if kind[i] != BusKind::Reference {
            col_a[i] = dim;
            dim += 1;
        }
    }
    for i in 0..n {
        if kind[i] == BusKind::Pq {
            col_m[i] = dim;
            dim += 1;
        }
    }
    let mut b = CscBuilder::new(dim, dim);
    b.reserve(4 * y.nnz());
    let mut handles = vec![[NONE; 4]; y.nnz()];
    for i in 0..n {
        let (ra, rm) = (col_a[i], col_m[i]);
        if ra == NONE && rm == NONE {
            continue;
        }
        for e in y.row_ptr[i]..y.row_ptr[i + 1] {
            let k = y.col[e];
            let (ca, cm) = (col_a[k], col_m[k]);
            let h = &mut handles[e];
            if ra != NONE {
                if ca != NONE {
                    h[0] = b.push(ra, ca);
                }
                if cm != NONE {
                    h[1] = b.push(ra, cm);
                }
            }
            if rm != NONE {
                if ca != NONE {
                    h[2] = b.push(rm, ca);
                }
                if cm != NONE {
                    h[3] = b.push(rm, cm);
                }
            }
        }
    }
    let (pattern, slot) = b.build();
    let slots = handles
        .into_iter()
        .map(|h| h.map(|x| if x == NONE { NONE } else { slot[x] }))
        .collect();
    JacobianLayout {
        pattern,
        col_a,
        col_m,
        slots,
    }
}

/// Mismatches `F = S(V) − S_spec` on the unknowns' rows, the bus currents and the largest mismatch.
fn mismatch(y: &Ybus, lay: &JacobianLayout, sch: &Schedule, v: &[C64], cur: &mut [C64], f: &mut [f64]) -> f64 {
    y.mul(v, cur);
    let mut worst = 0.0_f64;
    for i in 0..y.n {
        let s = v[i] * cur[i].conj();
        if lay.col_a[i] != NONE {
            let d = s.re - sch.p[i];
            f[lay.col_a[i]] = d;
            worst = worst.max(d.abs());
        }
        if lay.col_m[i] != NONE {
            let d = s.im - sch.q[i];
            f[lay.col_m[i]] = d;
            worst = worst.max(d.abs());
        }
    }
    worst
}

/// Fills the Jacobian values: ∂S/∂θk = j·Vi·conj(δik·Ii − Yik·Vk), ∂S/∂|Vk| = Vi·conj(Yik·Vk/|Vk|) + δik·conj(Ii)·Vi/|Vi|.
fn jacobian(y: &Ybus, lay: &JacobianLayout, v: &[C64], vm: &[f64], cur: &[C64], values: &mut [f64]) {
    values.fill(0.0);
    for i in 0..y.n {
        if lay.col_a[i] == NONE && lay.col_m[i] == NONE {
            continue;
        }
        let vi = v[i];
        for e in y.row_ptr[i]..y.row_ptr[i + 1] {
            let k = y.col[e];
            let s = lay.slots[e];
            let yik = y.val[e];
            let mut a = -(yik * v[k]);
            let unit_k = v[k].scale(1.0 / vm[k]);
            let mut dm = vi * (yik * unit_k).conj();
            if k == i {
                a += cur[i];
                dm += cur[i].conj() * unit_k;
            }
            let da = C64::new(0.0, 1.0) * vi * a.conj();
            if s[0] != NONE {
                values[s[0]] += da.re;
            }
            if s[1] != NONE {
                values[s[1]] += dm.re;
            }
            if s[2] != NONE {
                values[s[2]] += da.im;
            }
            if s[3] != NONE {
                values[s[3]] += dm.im;
            }
        }
    }
}

/// Solves the load flow.
pub fn solve(net: &PuNetwork, opt: &Options) -> Solution {
    let t0 = clock::now_ms();
    let n = net.buses.len();
    let y = Ybus::build(net, &[]);
    let mut fixed: Vec<Option<(f64, i8)>> = vec![None; net.machines.len()];
    let mut timing = Timing::default();

    // Starting point: setpoints, with the nominal angles (every transformer phase shift applied outward from the
    // references) or, for a warm start, the previous solution. A DC load flow then refines cold-start angles.
    let mut vm: Vec<f64> = net
        .buses
        .iter()
        .map(|b| if opt.warm_start { b.vm0 } else { 1.0 })
        .collect();
    let mut seed = vec![0.0; n];
    for g in &net.machines {
        if g.mode == MachineMode::Reference {
            seed[g.bus] = g.angle;
        }
    }
    for g in &net.grids {
        seed[g.bus] = g.angle;
    }
    let mut va: Vec<f64> = if opt.warm_start {
        // A stored solution may be referenced to another angle; shift each island so its reference sits at its own
        // angle before Newton starts.
        aligned_start(net, &seed)
    } else {
        nominal_angles(net, &seed)
    };
    let sch0 = schedule(net, &fixed);
    for g in &net.machines {
        if g.mode != MachineMode::Pq {
            vm[g.bus] = g.v_set;
        }
        if g.mode == MachineMode::Reference {
            va[g.bus] = g.angle;
        }
    }
    for g in &net.grids {
        vm[g.bus] = g.v_set;
        va[g.bus] = g.angle;
    }
    if opt.dc_start && !opt.warm_start && n > 0 {
        let ta = clock::now_ms();
        if let Some(theta) = dc_angles(net, &sch0.kind, &sch0.p, &va) {
            va = theta;
        }
        timing.analyse_ms += clock::now_ms() - ta;
    }

    let mut log = Vec::new();
    let mut iterations = 0;
    let mut converged = false;
    let mut message = String::from("No energised busbars: the network has no external grid or generator.");
    let mut held = Vec::new();
    let mut worst = 0.0;
    let mut kind = sch0.kind.clone();
    if n > 0 {
        for round in 0..20 {
            let sch = schedule(net, &fixed);
            kind.clone_from(&sch.kind);
            let out = newton(&y, &sch, &mut vm, &mut va, opt, &mut log, &mut iterations, &mut timing);
            converged = out.0;
            worst = out.1;
            message = out.2;
            if !converged || !opt.enforce_q_limits {
                break;
            }
            let units = dispatch(net, &y, &vm, &va, &fixed);
            let mut any = false;
            for (m, g) in net.machines.iter().enumerate() {
                if g.mode != MachineMode::Pv || fixed[m].is_some() || sch.kind[g.bus] == BusKind::Reference {
                    continue;
                }
                let q = units.0[m].q;
                if q > g.q_max + 1e-9 {
                    fixed[m] = Some((g.q_max, 1));
                    held.push((m, 1));
                    any = true;
                } else if q < g.q_min - 1e-9 {
                    fixed[m] = Some((g.q_min, -1));
                    held.push((m, -1));
                    any = true;
                }
            }
            if !any {
                break;
            }
            if round == 19 {
                converged = false;
                message = "Reactive power limits did not settle after 20 rounds.".into();
            }
        }
    }
    let (machines, grids) = if n > 0 {
        dispatch(net, &y, &vm, &va, &fixed)
    } else {
        (Vec::new(), Vec::new())
    };
    timing.total_ms = clock::now_ms() - t0;
    Solution {
        converged,
        message,
        iterations,
        mismatch: worst,
        vm,
        va,
        kind,
        machines,
        grids,
        log,
        held,
        timing,
    }
}

/// Newton iterations with a backtracking line search. Returns (converged, worst mismatch, message).
fn newton(
    y: &Ybus,
    sch: &Schedule,
    vm: &mut [f64],
    va: &mut [f64],
    opt: &Options,
    log: &mut Vec<IterationLog>,
    iterations: &mut usize,
    timing: &mut Timing,
) -> (bool, f64, String) {
    let n = y.n;
    let ta = clock::now_ms();
    let lay = layout(y, &sch.kind);
    let dim = lay.pattern.nrows;
    let mut solver = FaerLu::new();
    if let Err(e) = solver.analyse(&lay.pattern) {
        return (false, f64::INFINITY, format!("The Jacobian could not be ordered: {e}."));
    }
    timing.analyse_ms += clock::now_ms() - ta;
    let mut v: Vec<C64> = (0..n).map(|i| C64::from_polar(vm[i], va[i])).collect();
    let mut cur = vec![C64::ZERO; n];
    let mut f = vec![0.0; dim];
    let mut values = vec![0.0; lay.pattern.nnz()];
    let mut worst = mismatch(y, &lay, sch, &v, &mut cur, &mut f);
    log.push(IterationLog {
        iteration: *iterations,
        mismatch: worst,
        step: 0.0,
    });
    if dim == 0 || worst < opt.tolerance {
        return (true, worst, "Converged.".into());
    }
    let mut trial_f = vec![0.0; dim];
    let mut trial_cur = vec![C64::ZERO; n];
    for _ in 0..opt.max_iter {
        jacobian(y, &lay, &v, vm, &cur, &mut values);
        let tf = clock::now_ms();
        let mut dx = f.clone();
        let solved = solver.factor(&values).and_then(|_| solver.solve(&mut dx));
        timing.factor_solve_ms += clock::now_ms() - tf;
        if let Err(e) = solved {
            return (
                false,
                worst,
                format!("The Jacobian is singular ({e}): check for isolated machines or zero impedances."),
            );
        }
        if dx.iter().any(|d| !d.is_finite()) {
            return (
                false,
                worst,
                "The Jacobian is singular: check for isolated machines or zero impedances.".into(),
            );
        }
        // Full step first; halve it while the mismatch grows markedly (at most four times).
        let mut step = 1.0;
        let (va0, vm0) = (va.to_vec(), vm.to_vec());
        let mut accepted = f64::INFINITY;
        for _ in 0..5 {
            for i in 0..n {
                if lay.col_a[i] != NONE {
                    va[i] = va0[i] - step * dx[lay.col_a[i]];
                }
                if lay.col_m[i] != NONE {
                    vm[i] = vm0[i] - step * dx[lay.col_m[i]];
                }
                v[i] = C64::from_polar(vm[i], va[i]);
            }
            accepted = mismatch(y, &lay, sch, &v, &mut trial_cur, &mut trial_f);
            if accepted.is_finite() && (accepted < worst * 1.5 || step < 0.1) {
                break;
            }
            step *= 0.5;
        }
        std::mem::swap(&mut f, &mut trial_f);
        std::mem::swap(&mut cur, &mut trial_cur);
        worst = accepted;
        *iterations += 1;
        log.push(IterationLog {
            iteration: *iterations,
            mismatch: worst,
            step,
        });
        if !worst.is_finite() || worst > 1e8 {
            return (false, worst, "The load flow diverged.".into());
        }
        if worst < opt.tolerance {
            return (true, worst, "Converged.".into());
        }
    }
    (
        false,
        worst,
        format!("No convergence after {} iterations.", opt.max_iter),
    )
}

/// Machine and grid outputs. References and grids take their bus's balance; PV machines share the remaining reactive
/// balance in proportion to their reactive range (MATPOWER's rule).
fn dispatch(
    net: &PuNetwork,
    y: &Ybus,
    vm: &[f64],
    va: &[f64],
    fixed: &[Option<(f64, i8)>],
) -> (Vec<UnitOutput>, Vec<UnitOutput>) {
    let n = y.n;
    let s = bus_injections(y, vm, va);
    let mut p_bal: Vec<f64> = s.iter().map(|x| x.re).collect();
    let mut q_bal: Vec<f64> = s.iter().map(|x| x.im).collect();
    for l in &net.loads {
        p_bal[l.bus] += l.p;
        q_bal[l.bus] += l.q;
    }
    let mut machines: Vec<UnitOutput> = net
        .machines
        .iter()
        .map(|g| UnitOutput {
            id: g.id,
            p: g.p,
            q: 0.0,
            at_limit: 0,
        })
        .collect();
    for (m, g) in net.machines.iter().enumerate() {
        if g.mode == MachineMode::Reference {
            continue;
        }
        p_bal[g.bus] -= g.p;
        if g.mode == MachineMode::Pq {
            q_bal[g.bus] -= g.q;
            machines[m].q = g.q;
        } else if let Some((q, lim)) = fixed[m] {
            q_bal[g.bus] -= q;
            machines[m].q = q;
            machines[m].at_limit = lim;
        }
    }
    let mut refs: Vec<Vec<usize>> = vec![Vec::new(); n];
    let mut grid_at: Vec<Vec<usize>> = vec![Vec::new(); n];
    let mut pv_at: Vec<Vec<usize>> = vec![Vec::new(); n];
    for (m, g) in net.machines.iter().enumerate() {
        match g.mode {
            MachineMode::Reference => refs[g.bus].push(m),
            MachineMode::Pv if fixed[m].is_none() => pv_at[g.bus].push(m),
            _ => {}
        }
    }
    for (k, g) in net.grids.iter().enumerate() {
        grid_at[g.bus].push(k);
    }
    let mut grids: Vec<UnitOutput> = net
        .grids
        .iter()
        .map(|g| UnitOutput {
            id: g.id,
            p: 0.0,
            q: 0.0,
            at_limit: 0,
        })
        .collect();
    for b in 0..n {
        let slack = refs[b].len() + grid_at[b].len();
        if slack > 0 {
            let share = 1.0 / slack as f64;
            for &m in &refs[b] {
                machines[m].p = p_bal[b] * share;
                machines[m].q = q_bal[b] * share;
            }
            for &k in &grid_at[b] {
                grids[k].p = p_bal[b] * share;
                grids[k].q = q_bal[b] * share;
            }
        } else if !pv_at[b].is_empty() {
            let ranges: Vec<f64> = pv_at[b]
                .iter()
                .map(|&m| (net.machines[m].q_max - net.machines[m].q_min).max(0.0))
                .collect();
            let total: f64 = ranges.iter().sum();
            for (j, &m) in pv_at[b].iter().enumerate() {
                let share = if total > 0.0 {
                    ranges[j] / total
                } else {
                    1.0 / pv_at[b].len() as f64
                };
                machines[m].q = q_bal[b] * share;
            }
        }
    }
    (machines, grids)
}

/// Starting angles of a warm start, shifted island by island so each reference bus starts at its set angle.
fn aligned_start(net: &PuNetwork, seed: &[f64]) -> Vec<f64> {
    let n = net.buses.len();
    let mut va: Vec<f64> = net.buses.iter().map(|b| b.va0).collect();
    let mut adj: Vec<Vec<usize>> = vec![Vec::new(); n];
    for br in &net.branches {
        adj[br.f].push(br.t);
        adj[br.t].push(br.f);
    }
    let roots = net.grids.iter().map(|g| g.bus).chain(
        net.machines
            .iter()
            .filter(|g| g.mode == MachineMode::Reference)
            .map(|g| g.bus),
    );
    let mut offset = vec![None; n];
    for r in roots {
        if offset[r].is_some() {
            continue;
        }
        let shift = seed[r] - va[r];
        let mut stack = vec![r];
        offset[r] = Some(shift);
        while let Some(i) = stack.pop() {
            for &k in &adj[i] {
                if offset[k].is_none() {
                    offset[k] = Some(shift);
                    stack.push(k);
                }
            }
        }
    }
    for (a, o) in va.iter_mut().zip(offset) {
        *a += o.unwrap_or(0.0);
    }
    va
}
