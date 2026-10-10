//! Newton-Raphson load flow in polar coordinates on a sparse Jacobian, with the controls as outer loops.
//!
//! One Newton solve runs first. The enabled outer loops then check the solution in a fixed order (OpenLoadFlow's):
//! distributed slack, reactive power limits, phase shifter flow control, transformer voltage control and shunt voltage
//! control. A loop that changes something re-solves before the next one is checked, and the round repeats until a
//! full round changes nothing, so the discrete outcome (taps, sections, machines held at a limit) follows that order.

use ps_num::{C64, clock};
use ps_sparse::{FaerLu, SparseSolver};

use crate::control::{self, Status};
use crate::dc::dc_angles;
use crate::equations::{Group, Layout, NONE, Schedule, Structure, jacobian, mismatch};
use crate::flows::bus_injections;
use crate::network::nominal_angles;
use crate::{BusKind, MachineMode, PuNetwork, UnitKind, Ybus};

/// How an island's active power imbalance is shared.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Balance {
    /// The reference machine (or external grid) takes all of it.
    #[default]
    Reference,
    /// Participating machines in proportion to their maximum active power.
    MaxP,
    /// Participating machines in proportion to their present active power.
    TargetP,
    /// Participating machines in proportion to their participation factors.
    Factor,
    /// Participating machines in proportion to their remaining margin in the direction needed.
    Margin,
    /// Loads in proportion to their active power.
    Load,
}

/// Load flow settings.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Options {
    /// Largest acceptable power mismatch, p.u.
    pub tolerance: f64,
    /// Newton iterations per solve.
    pub max_iter: usize,
    /// Hold machines at their reactive power limits (and release them when the voltage allows).
    pub enforce_q_limits: bool,
    /// Start the angles from a DC load flow instead of the buses' starting values.
    pub dc_start: bool,
    /// Start from the buses' `vm0` and `va0` (a previous solution) instead of setpoints.
    pub warm_start: bool,
    /// How each island's imbalance is shared.
    pub balance: Balance,
    /// Largest imbalance left on the reference after distribution, p.u.
    pub slack_tolerance: f64,
    /// Machines regulate the bus their data names; otherwise each holds its own terminal voltage.
    pub remote_voltage: bool,
    /// Loads follow their voltage characteristics; otherwise every load is constant power.
    pub zip_loads: bool,
    /// Ratio tap changers regulate voltage.
    pub tap_control: bool,
    /// Switched shunts regulate voltage.
    pub shunt_control: bool,
    /// Phase shifters regulate active power flow.
    pub phase_control: bool,
    /// Largest number of outer loop changes.
    pub max_outer: usize,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            tolerance: 1e-5,
            max_iter: 30,
            enforce_q_limits: false,
            dc_start: true,
            warm_start: false,
            balance: Balance::Reference,
            slack_tolerance: 1e-5,
            remote_voltage: false,
            zip_loads: false,
            tap_control: false,
            shunt_control: false,
            phase_control: false,
            max_outer: 30,
        }
    }
}

/// One Newton iteration's progress.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct IterationLog {
    /// Iteration number, counted across all solves.
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

/// What one outer loop did.
#[derive(Debug, Clone, PartialEq)]
pub struct ControlLog {
    /// Which control.
    pub control: Control,
    /// Times it changed something.
    pub changes: usize,
}

/// The outer loops.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Control {
    /// Distributed slack.
    Slack,
    /// Reactive power limits.
    ReactiveLimits,
    /// Phase shifter flow control.
    PhaseShifters,
    /// Transformer voltage control.
    Taps,
    /// Shunt voltage control.
    Shunts,
}

/// A load flow solution.
#[derive(Debug, Clone, PartialEq)]
pub struct Solution {
    /// Whether the mismatch fell below the tolerance and every control settled.
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
    /// Bus kinds as finally solved.
    pub kind: Vec<BusKind>,
    /// Whether the final equations held each bus's voltage magnitude (a control's target).
    pub v_held: Vec<bool>,
    /// Machine outputs, in network order.
    pub machines: Vec<UnitOutput>,
    /// Grid outputs, in network order.
    pub grids: Vec<UnitOutput>,
    /// Load consumption at the solved voltages (after any load-based slack distribution), p.u.
    pub loads: Vec<(f64, f64)>,
    /// Per-iteration progress.
    pub log: Vec<IterationLog>,
    /// Machines finally held at a reactive limit: (machine index, −1 lower / +1 upper).
    pub held: Vec<(usize, i8)>,
    /// Final position index of each tap changer, per tap branch and axis.
    pub taps: Vec<Vec<usize>>,
    /// Final sections of each controlled shunt.
    pub shunt_sections: Vec<usize>,
    /// The network as finally solved (taps and sections applied), for flows.
    pub net: PuNetwork,
    /// Active power each island's distribution moved, p.u., by island (islands without one are left out).
    pub distributed: Vec<f64>,
    /// What each outer loop did.
    pub controls: Vec<ControlLog>,
    /// Controls that could not do what was asked, in plain words.
    pub notes: Vec<String>,
    /// When the load flow did not converge: the buses with the largest remaining mismatch, largest first, as
    /// (bus, active mismatch, reactive mismatch) in p.u.
    pub worst: Vec<(usize, f64, f64)>,
    /// Time spent, milliseconds.
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

/// The state the outer loops change between Newton solves.
#[derive(Debug, Clone)]
pub(crate) struct Work {
    /// The network with the present taps and sections.
    pub net: PuNetwork,
    /// Present active power target of each machine, p.u.
    pub target_p: Vec<f64>,
    /// Initial targets, p.u.
    pub initial_p: Vec<f64>,
    /// Present active power of each load at 1 p.u., p.u.
    pub load_p: Vec<f64>,
    /// Reactive output of each controller bus held at a limit: (total of its voltage-controlling units, −1/+1).
    pub frozen: Vec<Option<(f64, i8)>>,
    /// Times each bus went from voltage control to a reactive limit.
    pub switches: Vec<u8>,
    /// Whether each machine may take part in a distributed slack.
    pub participating: Vec<bool>,
    /// Machines that hold their reactive power instead of a voltage: with reactive limits on, a range under 1 Mvar
    /// cannot regulate (OpenLoadFlow's reactive range check).
    pub fixed_q: Vec<bool>,
    /// Island of each bus.
    pub island: Vec<usize>,
    /// Number of islands.
    pub islands: usize,
    /// Active power moved per island, p.u.
    pub distributed: Vec<f64>,
    /// Notes for the solution.
    pub notes: Vec<String>,
    /// Movement history of the discrete controls.
    pub discrete: crate::discrete::DiscreteState,
    /// Outer loop changes so far.
    pub outer: usize,
}

/// The present state of the network: voltages and the solver's last factorisation.
pub(crate) struct Solver {
    pub y: Ybus,
    pub st: Structure,
    pub lay: Layout,
    pub lu: FaerLu,
    pub vm: Vec<f64>,
    pub va: Vec<f64>,
    pub sch: Schedule,
    /// Whether `lu` holds the factors of the Jacobian at (close to) the present voltages.
    pub factored: bool,
}

/// What a solve can lend later solves of a network with the same equations and admittance pattern: the Jacobian's
/// layout and its ordering and symbolic factorisation. Contingency analysis solves thousands of outages that keep the
/// pattern (a branch's admittances set to zero leave its entries in place) and pays for the ordering once.
#[derive(Default)]
pub struct Cache {
    entry: Option<CacheEntry>,
    /// Solves that reused the analysis.
    pub hits: usize,
    /// Solves that analysed afresh.
    pub misses: usize,
}

struct CacheEntry {
    st: Structure,
    row_ptr: Vec<usize>,
    col: Vec<usize>,
    lay: Layout,
    lu: FaerLu,
}

impl Cache {
    /// The layout and an analysed solver for these equations, from the cache when they match, otherwise analysed and
    /// kept.
    fn get(&mut self, y: &Ybus, st: &Structure) -> (Layout, FaerLu, Result<(), ps_sparse::SolveError>) {
        if let Some(e) = &self.entry
            && e.st == *st
            && e.row_ptr == y.row_ptr
            && e.col == y.col
        {
            self.hits += 1;
            return (e.lay.clone(), e.lu.analysed_copy(), Ok(()));
        }
        self.misses += 1;
        let lay = Layout::new(y, st);
        let mut lu = FaerLu::new();
        let analysed = lu.analyse(&lay.pattern);
        if analysed.is_ok() {
            self.entry = Some(CacheEntry {
                st: st.clone(),
                row_ptr: y.row_ptr.clone(),
                col: y.col.clone(),
                lay: lay.clone(),
                lu: lu.analysed_copy(),
            });
        }
        (lay, lu, analysed)
    }
}

/// Solves the load flow.
pub fn solve(net: &PuNetwork, opt: &Options) -> Solution {
    solve_cached(net, opt, &mut Cache::default())
}

/// Solves the load flow, reusing (and filling) `cache`.
pub fn solve_cached(net: &PuNetwork, opt: &Options, cache: &mut Cache) -> Solution {
    let t0 = clock::now_ms();
    let n = net.buses.len();
    let mut timing = crate::newton::Timing::default();
    let mut work = Work::new(net, opt);
    let mut log = Vec::new();
    let mut iterations = 0;

    if n == 0 {
        return work.finish(
            None,
            opt,
            false,
            "No energised busbars: the network has no external grid or generator.".into(),
            0,
            0.0,
            log,
            Vec::new(),
            timing,
            t0,
        );
    }

    // Starting point: setpoints, with the nominal angles (every transformer phase shift applied outward from the
    // references) or, for a warm start, the previous solution. A DC load flow then refines cold-start angles.
    let mut seed = vec![0.0; n];
    for g in &net.machines {
        if g.mode == MachineMode::Reference {
            seed[g.bus] = g.angle;
        }
    }
    for g in &net.grids {
        seed[g.bus] = g.angle;
    }
    let vm: Vec<f64> = net
        .buses
        .iter()
        .map(|b| if opt.warm_start { b.vm0 } else { 1.0 })
        .collect();
    let mut va: Vec<f64> = if opt.warm_start {
        aligned_start(net, &seed)
    } else {
        nominal_angles(net, &seed)
    };
    for g in &net.machines {
        if g.mode == MachineMode::Reference {
            va[g.bus] = g.angle;
        }
    }
    for g in &net.grids {
        va[g.bus] = g.angle;
    }
    let reference = work.reference();
    let sch = work.schedule(opt);
    if opt.dc_start && !opt.warm_start {
        let ta = clock::now_ms();
        let kind: Vec<BusKind> = reference
            .iter()
            .map(|&r| if r { BusKind::Reference } else { BusKind::Pq })
            .collect();
        let p: Vec<f64> = (0..n)
            .map(|i| sch.p_gen[i] - sch.p_load[i].iter().sum::<f64>())
            .collect();
        if let Some(theta) = dc_angles(&work.net, &kind, &p, &va) {
            va = theta;
        }
        timing.analyse_ms += clock::now_ms() - ta;
    }
    let groups = work.groups(opt, &vm);
    let st = Structure::new(n, &reference, &groups);
    // A cold start takes its magnitudes from the no-load voltage profile the controls and transformer ratios set.
    let mut vm = vm;
    if !opt.warm_start
        && let Some(init) = crate::init::magnitudes(&work.net, &st.v_fixed)
    {
        vm = init;
    }
    let y = Ybus::build(&work.net, &[]);
    let ta = clock::now_ms();
    let (lay, lu, analysed) = cache.get(&y, &st);
    timing.analyse_ms += clock::now_ms() - ta;
    let mut s = Solver {
        y,
        st,
        lay,
        lu,
        vm,
        va,
        sch,
        factored: false,
    };
    s.apply_fixed();
    if let Err(e) = analysed {
        return work.finish(
            Some(&s),
            opt,
            false,
            format!("The Jacobian could not be ordered: {e}."),
            0,
            f64::INFINITY,
            log,
            Vec::new(),
            timing,
            t0,
        );
    }

    let (mut converged, mut worst, mut message) = s.newton(opt, &mut log, &mut iterations, &mut timing);
    let mut controls: Vec<ControlLog> = Vec::new();
    let loops = control::enabled(opt);
    for &c in &loops {
        controls.push(ControlLog { control: c, changes: 0 });
    }
    let mut outer = 0usize;
    let mut last_unstable: Option<Control> = None;
    if converged && !loops.is_empty() {
        loop {
            let before = iterations;
            for (li, &c) in loops.iter().enumerate() {
                if Some(c) == last_unstable || !converged || outer >= opt.max_outer {
                    break;
                }
                loop {
                    let status = control::check(c, &mut work, &mut s, opt);
                    match status {
                        Status::Stable => break,
                        Status::Unstable => {
                            controls[li].changes += 1;
                            last_unstable = Some(c);
                            outer += 1;
                            work.outer = outer;
                            s.refresh(&mut work, opt, &mut timing);
                            (converged, worst, message) = s.newton(opt, &mut log, &mut iterations, &mut timing);
                            if !converged || outer >= opt.max_outer {
                                break;
                            }
                        }
                    }
                }
            }
            if iterations == before || !converged || outer >= opt.max_outer {
                break;
            }
        }
        if converged && outer >= opt.max_outer {
            converged = false;
            message = format!(
                "The controls did not settle within {} changes: {}.",
                opt.max_outer,
                control::unsettled(&controls)
            );
        }
    }
    work.finish(
        Some(&s),
        opt,
        converged,
        message,
        iterations,
        worst,
        log,
        controls,
        timing,
        t0,
    )
}

impl Work {
    fn new(net: &PuNetwork, opt: &Options) -> Self {
        let n = net.buses.len();
        let sb = net.base_mva.max(1e-9);
        let (island, islands) = islands(net);
        let participating = net
            .machines
            .iter()
            .map(|g| {
                // OpenLoadFlow's checks: a plausible maximum, the target within the active limits, a usable range.
                g.participates
                    && g.kind != UnitKind::Converter
                    && g.p_max <= 10_000.0 / sb
                    && g.p >= g.p_min
                    && g.p <= g.p_max
                    && g.p_max - g.p_min >= 1e-4 / sb
                    && match opt.balance {
                        Balance::MaxP => g.p_max != 0.0,
                        Balance::Factor => g.factor > 0.0,
                        _ => true,
                    }
            })
            .collect();
        let fixed_q = net
            .machines
            .iter()
            .map(|g| {
                let range = g.q_max - g.q_min;
                opt.enforce_q_limits && g.mode != MachineMode::Pq && (range < 1.0 / sb || range.is_nan())
            })
            .collect();
        Self {
            fixed_q,
            target_p: net.machines.iter().map(|g| g.p).collect(),
            initial_p: net.machines.iter().map(|g| g.p).collect(),
            load_p: net.loads.iter().map(|l| l.p).collect(),
            net: net.clone(),
            frozen: vec![None; n],
            switches: vec![0; n],
            participating,
            island,
            islands,
            distributed: vec![0.0; islands],
            notes: Vec::new(),
            discrete: crate::discrete::DiscreteState::new(&net.taps, net.shunt_controls.len()),
            outer: 0,
        }
    }

    /// Buses whose angle is fixed: those with an external grid or a reference machine.
    pub(crate) fn reference(&self) -> Vec<bool> {
        let mut r = vec![false; self.net.buses.len()];
        for g in &self.net.machines {
            if g.mode == MachineMode::Reference {
                r[g.bus] = true;
            }
        }
        for g in &self.net.grids {
            r[g.bus] = true;
        }
        r
    }

    /// The bus a machine's voltage control acts on.
    pub(crate) fn reg_bus(&self, m: usize, opt: &Options) -> usize {
        let g = &self.net.machines[m];
        if opt.remote_voltage { g.reg_bus } else { g.bus }
    }

    /// Whether a machine controls voltage now (not held at a limit).
    pub(crate) fn controls_voltage(&self, m: usize) -> bool {
        let g = &self.net.machines[m];
        g.mode != MachineMode::Pq && !self.fixed_q[m] && self.frozen[g.bus].is_none()
    }

    /// Whether a machine holds its scheduled reactive power.
    pub(crate) fn holds_q(&self, m: usize) -> bool {
        self.net.machines[m].mode == MachineMode::Pq || self.fixed_q[m]
    }

    /// The voltage control groups for the present state. Controller buses share a group's reactive power in
    /// proportion to their keys (OpenLoadFlow's `GeneratorVoltageControl` reactive keys): the sum of the reactive
    /// ranges of every machine at the bus, or, when any machine of the group has a range under 1 Mvar or over
    /// 10,000 Mvar, the number of voltage-controlling machines at the bus. The first controller bus sets the target.
    pub(crate) fn groups(&self, opt: &Options, _vm: &[f64]) -> Vec<Group> {
        let n = self.net.buses.len();
        let sb = self.net.base_mva.max(1e-9);
        // Per controller bus: regulated bus, target, range key and count of controlling units.
        let mut ctl: Vec<Option<(usize, f64, f64, f64)>> = vec![None; n];
        let mut range = vec![0.0; n];
        let mut plausible = vec![true; n];
        for g in &self.net.machines {
            let r = g.q_max - g.q_min;
            range[g.bus] += r;
            if !(1.0 / sb..=10_000.0 / sb).contains(&r) {
                plausible[g.bus] = false;
            }
        }
        for g in &self.net.grids {
            ctl[g.bus] = Some((g.bus, g.v_set, 1.0, 1.0));
        }
        for (m, g) in self.net.machines.iter().enumerate() {
            if !self.controls_voltage(m) {
                continue;
            }
            let reg = self.reg_bus(m, opt);
            match &mut ctl[g.bus] {
                Some((_, _, _, count)) => *count += 1.0,
                None => ctl[g.bus] = Some((reg, g.v_set, range[g.bus], 1.0)),
            }
        }
        let mut by_reg: Vec<Option<usize>> = vec![None; n];
        let mut groups: Vec<Group> = Vec::new();
        let mut uniform: Vec<bool> = Vec::new();
        for c in 0..n {
            let Some((reg, target, key, _)) = ctl[c] else { continue };
            let k = match by_reg[reg] {
                Some(k) => k,
                None => {
                    groups.push(Group {
                        bus: reg,
                        target,
                        controllers: Vec::new(),
                    });
                    uniform.push(false);
                    by_reg[reg] = Some(groups.len() - 1);
                    groups.len() - 1
                }
            };
            uniform[k] |= !plausible[c];
            groups[k].controllers.push((c, 0.0, key));
        }
        for (g, uniform) in groups.iter_mut().zip(uniform) {
            if uniform {
                for c in &mut g.controllers {
                    c.2 = ctl[c.0].map_or(1.0, |x| x.3);
                }
            }
        }
        groups
    }

    /// A machine's reactive limits at the present voltage of its bus, p.u.
    pub(crate) fn q_limits(&self, m: usize, vm: &[f64]) -> (f64, f64) {
        let g = &self.net.machines[m];
        let s = if g.kind == UnitKind::Svc {
            vm[g.bus] * vm[g.bus]
        } else {
            1.0
        };
        (g.q_min * s, g.q_max * s)
    }

    /// The schedule for the present targets, limits and loads.
    pub(crate) fn schedule(&self, opt: &Options) -> Schedule {
        let n = self.net.buses.len();
        let mut p_gen = vec![0.0; n];
        let mut q_fixed = vec![0.0; n];
        for (m, g) in self.net.machines.iter().enumerate() {
            if g.mode != MachineMode::Reference {
                p_gen[g.bus] += self.target_p[m];
            }
            if self.holds_q(m) {
                q_fixed[g.bus] += g.q;
            }
        }
        for (b, f) in self.frozen.iter().enumerate() {
            if let Some((q, _)) = f {
                q_fixed[b] += q;
            }
        }
        let mut p_load = vec![[0.0; 3]; n];
        let mut q_load = vec![[0.0; 3]; n];
        for (k, l) in self.net.loads.iter().enumerate() {
            // Slack distribution moves a load's active power only (OpenLoadFlow's default).
            let (p, q) = (self.load_p[k], l.q);
            let (pz, qz) = if opt.zip_loads {
                (l.p_zip, l.q_zip)
            } else {
                ([0.0, 0.0, 1.0], [0.0, 0.0, 1.0])
            };
            for j in 0..3 {
                p_load[l.bus][j] += p * pz[j];
                q_load[l.bus][j] += q * qz[j];
            }
        }
        Schedule {
            p_gen,
            q_fixed,
            p_load,
            q_load,
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn finish(
        mut self,
        s: Option<&Solver>,
        opt: &Options,
        converged: bool,
        message: String,
        iterations: usize,
        worst: f64,
        log: Vec<IterationLog>,
        controls: Vec<ControlLog>,
        mut timing: Timing,
        t0: f64,
    ) -> Solution {
        let n = self.net.buses.len();
        let (vm, va) = s.map_or((Vec::new(), Vec::new()), |s| (s.vm.clone(), s.va.clone()));
        let (machines, grids, held) = if n > 0 {
            self.dispatch(opt, &vm, &va)
        } else {
            Default::default()
        };
        let mut kind = vec![BusKind::Pq; n];
        for (m, g) in self.net.machines.iter().enumerate() {
            if g.mode == MachineMode::Reference {
                kind[g.bus] = BusKind::Reference;
            } else if self.controls_voltage(m) && kind[g.bus] == BusKind::Pq {
                kind[g.bus] = BusKind::Pv;
            }
        }
        for g in &self.net.grids {
            kind[g.bus] = BusKind::Reference;
        }
        // The buses whose voltage magnitude the final equations held: a reference whose machines all reached a limit
        // keeps its angle but not its voltage.
        let v_held = s.map_or_else(
            || vec![false; n],
            |s| s.st.v_fixed.iter().map(Option::is_some).collect(),
        );
        let sch = self.schedule(opt);
        let loads = self
            .net
            .loads
            .iter()
            .enumerate()
            .map(|(k, l)| {
                let v = vm.get(l.bus).copied().unwrap_or(1.0);
                let scaled = crate::PuLoad {
                    p: self.load_p[k],
                    ..*l
                };
                let (pl, ql, _, _) = scaled.at(v, opt.zip_loads);
                (pl, ql)
            })
            .collect();
        let _ = sch;
        timing.total_ms = clock::now_ms() - t0;
        let distributed = (0..self.islands)
            .filter(|&k| self.distributed[k] != 0.0)
            .map(|k| self.distributed[k])
            .collect();
        let taps = self
            .net
            .taps
            .iter()
            .map(|t| t.axes.iter().map(|a| a.index).collect())
            .collect();
        let shunt_sections = self.net.shunt_controls.iter().map(|c| c.index).collect();
        let notes = std::mem::take(&mut self.notes);
        // The buses that hold the mismatch, when Newton itself stopped short.
        let worst_buses = match s {
            Some(s) if !converged && n > 0 && worst > opt.tolerance => s.worst_buses(10),
            _ => Vec::new(),
        };
        Solution {
            converged,
            message: if converged { "Converged.".into() } else { message },
            iterations,
            mismatch: worst,
            vm,
            va,
            kind,
            v_held,
            machines,
            grids,
            loads,
            log,
            held,
            taps,
            shunt_sections,
            net: self.net,
            distributed,
            controls,
            notes,
            worst: worst_buses,
            timing,
        }
    }

    /// Machine and grid outputs. References and grids take their bus's active power balance. The reactive balance of
    /// a bus goes to its external grids if it has any; otherwise its voltage-controlling machines share it by
    /// MATPOWER's rule (`split_reactive`), and machines of a bus held at a limit sit at their own limits.
    fn dispatch(&self, opt: &Options, vm: &[f64], va: &[f64]) -> (Vec<UnitOutput>, Vec<UnitOutput>, Vec<(usize, i8)>) {
        let net = &self.net;
        let n = net.buses.len();
        let y = Ybus::build(net, &[]);
        let s = bus_injections(&y, vm, va);
        let sch = self.schedule(opt);
        let mut p_bal = vec![0.0; n];
        let mut q_bal = vec![0.0; n];
        for i in 0..n {
            let (pl, ql, _, _) = sch.load(i, vm[i]);
            p_bal[i] = s[i].re + pl;
            q_bal[i] = s[i].im + ql;
        }
        let mut machines: Vec<UnitOutput> = net
            .machines
            .iter()
            .enumerate()
            .map(|(m, g)| UnitOutput {
                id: g.id,
                p: self.target_p[m],
                q: 0.0,
                at_limit: 0,
            })
            .collect();
        let mut held = Vec::new();
        for (m, g) in net.machines.iter().enumerate() {
            if g.mode != MachineMode::Reference {
                p_bal[g.bus] -= self.target_p[m];
            }
            if self.holds_q(m) {
                q_bal[g.bus] -= g.q;
                machines[m].q = g.q;
            } else if let Some((_, lim)) = self.frozen[g.bus] {
                let (lo, hi) = self.q_limits(m, vm);
                let q = if lim > 0 { hi } else { lo };
                q_bal[g.bus] -= q;
                machines[m].q = q;
                machines[m].at_limit = lim;
                held.push((m, lim));
            }
        }
        let mut refs: Vec<Vec<usize>> = vec![Vec::new(); n];
        let mut grid_at: Vec<Vec<usize>> = vec![Vec::new(); n];
        let mut pv_at: Vec<Vec<usize>> = vec![Vec::new(); n];
        for (m, g) in net.machines.iter().enumerate() {
            if g.mode == MachineMode::Reference {
                refs[g.bus].push(m);
            }
            if self.controls_voltage(m) {
                pv_at[g.bus].push(m);
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
            if !grid_at[b].is_empty() {
                // External grids are unlimited sources: with any reference machines there, they share the bus's balance.
                let share = 1.0 / (refs[b].len() + grid_at[b].len()) as f64;
                for &m in &refs[b] {
                    machines[m].p = p_bal[b] * share;
                }
                for &m in refs[b].iter().chain(pv_at[b].iter().filter(|m| !refs[b].contains(m))) {
                    machines[m].q = if refs[b].contains(&m) { q_bal[b] * share } else { 0.0 };
                }
                for &k in &grid_at[b] {
                    grids[k].p = p_bal[b] * share;
                    grids[k].q = q_bal[b] * share;
                }
                continue;
            }
            if !refs[b].is_empty() {
                let k = refs[b].len() as f64;
                if opt.balance == Balance::Reference {
                    for &m in &refs[b] {
                        machines[m].p = p_bal[b] / k;
                    }
                } else {
                    let residual = p_bal[b] - refs[b].iter().map(|&m| self.target_p[m]).sum::<f64>();
                    for &m in &refs[b] {
                        machines[m].p = self.target_p[m] + residual / k;
                    }
                }
            }
            if pv_at[b].is_empty() {
                continue;
            }
            let limits: Vec<(f64, f64)> = pv_at[b].iter().map(|&m| self.q_limits(m, vm)).collect();
            for (&m, q) in pv_at[b].iter().zip(split_reactive(q_bal[b], &limits)) {
                machines[m].q = q;
            }
        }
        (machines, grids, held)
    }
}

impl Solver {
    /// Sets every bus a control fixes to its target.
    pub(crate) fn apply_fixed(&mut self) {
        for (i, v) in self.st.v_fixed.iter().enumerate() {
            if let Some(v) = v {
                self.vm[i] = *v;
            }
        }
    }

    /// Rebuilds what the outer loops changed: the admittances, the schedule and, when the voltage controls changed,
    /// the equations and their ordering.
    pub(crate) fn refresh(&mut self, work: &mut Work, opt: &Options, timing: &mut Timing) {
        self.y = Ybus::build(&work.net, &[]);
        self.sch = work.schedule(opt);
        let groups = work.groups(opt, &self.vm);
        let st = Structure::new(work.net.buses.len(), &work.reference(), &groups);
        let ta = clock::now_ms();
        if st != self.st || self.lay.pattern.nnz() == 0 {
            self.lay = Layout::new(&self.y, &st);
            self.st = st;
            self.lu = FaerLu::new();
            // An ordering failure shows up as a failed factorisation in the next solve.
            let _ = self.lu.analyse(&self.lay.pattern);
        }
        timing.analyse_ms += clock::now_ms() - ta;
        self.factored = false;
        self.apply_fixed();
    }

    /// Newton iterations with a backtracking line search. Returns (converged, worst mismatch, message).
    pub(crate) fn newton(
        &mut self,
        opt: &Options,
        log: &mut Vec<IterationLog>,
        iterations: &mut usize,
        timing: &mut Timing,
    ) -> (bool, f64, String) {
        let n = self.y.n;
        let dim = self.st.dim;
        let mut v: Vec<C64> = (0..n).map(|i| C64::from_polar(self.vm[i], self.va[i])).collect();
        let mut cur = vec![C64::ZERO; n];
        let mut f = vec![0.0; dim];
        let mut values = vec![0.0; self.lay.pattern.nnz()];
        let mut worst = mismatch(&self.y, &self.st, &self.sch, &v, &self.vm, &mut cur, &mut f);
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
            jacobian(&self.y, &self.st, &self.lay, &self.sch, &v, &self.vm, &cur, &mut values);
            let tf = clock::now_ms();
            let mut dx = f.clone();
            let solved = self.lu.factor(&values).and_then(|_| self.lu.solve(&mut dx));
            timing.factor_solve_ms += clock::now_ms() - tf;
            self.factored = solved.is_ok();
            if let Err(e) = solved {
                return (
                    false,
                    worst,
                    format!("The Jacobian is singular ({e}): check for isolated machines or zero impedances."),
                );
            }
            if dx.iter().any(|d| !d.is_finite()) {
                self.factored = false;
                return (
                    false,
                    worst,
                    "The Jacobian is singular: check for isolated machines or zero impedances.".into(),
                );
            }
            // Full step first. While it does not reduce the squared mismatch g = ‖F‖² enough (Armijo's condition), take
            // the step that minimises the quadratic through g(0), its slope −2·g(0) along the Newton direction and
            // g(μ), within [μ/10, μ/2], at most eight times.
            let g0: f64 = f.iter().map(|x| x * x).sum();
            let mut step = 1.0;
            let (va0, vm0) = (self.va.clone(), self.vm.clone());
            let mut accepted = f64::INFINITY;
            for attempt in 0..9 {
                for i in 0..n {
                    let (ca, cm) = (self.st.col_a[i], self.st.col_m[i]);
                    if ca != NONE {
                        self.va[i] = va0[i] - step * dx[ca];
                    }
                    if cm != NONE {
                        self.vm[i] = vm0[i] - step * dx[cm];
                    }
                    v[i] = C64::from_polar(self.vm[i], self.va[i]);
                }
                accepted = mismatch(&self.y, &self.st, &self.sch, &v, &self.vm, &mut trial_cur, &mut trial_f);
                let g: f64 = trial_f.iter().map(|x| x * x).sum();
                if g.is_finite() && g <= (1.0 - 2e-4 * step) * g0 || attempt == 8 {
                    break;
                }
                let curvature = g - g0 + 2.0 * step * g0;
                let best = if curvature > 0.0 && g.is_finite() {
                    step * step * g0 / curvature
                } else {
                    step / 2.0
                };
                step = best.clamp(step / 10.0, step / 2.0);
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

    /// The `k` buses with the largest mismatch at the present voltages: (bus, active, reactive), p.u. A bus's
    /// reactive mismatch counts only where its reactive power is scheduled.
    fn worst_buses(&self, k: usize) -> Vec<(usize, f64, f64)> {
        let n = self.y.n;
        let v: Vec<C64> = (0..n).map(|i| C64::from_polar(self.vm[i], self.va[i])).collect();
        let mut cur = vec![C64::ZERO; n];
        let mut f = vec![0.0; self.st.dim];
        mismatch(&self.y, &self.st, &self.sch, &v, &self.vm, &mut cur, &mut f);
        let mut rows: Vec<(usize, f64, f64)> = (0..n)
            .map(|i| {
                let p = if self.st.col_a[i] != NONE {
                    f[self.st.col_a[i]]
                } else {
                    0.0
                };
                let q = self.st.q_uses[i].iter().find(|u| u.1 == 1.0).map_or(0.0, |u| f[u.0]);
                (i, p, q)
            })
            .filter(|r| r.1.is_finite() && r.2.is_finite())
            .collect();
        rows.sort_by(|a, b| b.1.hypot(b.2).total_cmp(&a.1.hypot(a.2)));
        rows.truncate(k);
        rows
    }

    /// Bus injections at the present voltages, p.u.
    pub(crate) fn injections(&self) -> Vec<C64> {
        bus_injections(&self.y, &self.vm, &self.va)
    }
}

/// Island of every bus (connected by branches) and the number of islands.
fn islands(net: &PuNetwork) -> (Vec<usize>, usize) {
    let n = net.buses.len();
    let mut parent: Vec<usize> = (0..n).collect();
    fn find(p: &mut [usize], mut x: usize) -> usize {
        while p[x] != x {
            p[x] = p[p[x]];
            x = p[x];
        }
        x
    }
    for br in &net.branches {
        let (a, b) = (find(&mut parent, br.f), find(&mut parent, br.t));
        if a != b {
            parent[a.max(b)] = a.min(b);
        }
    }
    let mut id = vec![usize::MAX; n];
    let mut count = 0;
    let mut out = vec![0; n];
    for i in 0..n {
        let r = find(&mut parent, i);
        if id[r] == usize::MAX {
            id[r] = count;
            count += 1;
        }
        out[i] = id[r];
    }
    (out, count)
}

/// Splits a bus's reactive output `q` among machines with limits `(q_min, q_max)` as MATPOWER does (`pfsoln.m`): each
/// gets q_min + k·(q_max − q_min) with one k for the bus, so all sit at the same fraction of their range. Infinite
/// limits are replaced by a finite proxy M (the bus's equal shares plus its finite limits, in magnitude); a bus whose
/// machines have no range at all shares the excess over the minimum equally.
pub(crate) fn split_reactive(q: f64, limits: &[(f64, f64)]) -> Vec<f64> {
    let n = limits.len() as f64;
    let equal = q / n;
    let proxy: f64 = limits
        .iter()
        .map(|&(lo, hi)| {
            let finite = |x: f64| if x.is_finite() { x.abs() } else { 0.0 };
            equal.abs() + finite(lo) + finite(hi)
        })
        .sum();
    let bounded = |x: f64| if x.is_infinite() { proxy.copysign(x) } else { x };
    let limits: Vec<(f64, f64)> = limits.iter().map(|&(lo, hi)| (bounded(lo), bounded(hi))).collect();
    let (lo_sum, hi_sum) = limits.iter().fold((0.0, 0.0), |(a, b), &(lo, hi)| (a + lo, b + hi));
    if (hi_sum - lo_sum).abs() < 10.0 * f64::EPSILON {
        return limits.iter().map(|&(lo, _)| lo + (q - lo_sum) / n).collect();
    }
    let k = (q - lo_sum) / (hi_sum - lo_sum);
    limits.iter().map(|&(lo, hi)| lo + k * (hi - lo)).collect()
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
