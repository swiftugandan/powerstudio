//! The simulation: every unit's variables and every bus voltage solved together, step by step.
//!
//! The system is `T·dx/dt = f(x)` over all unit variables and the network's current balance
//! `0 = I_units(x, V) − Y·V` in rectangular coordinates, two equations per bus. Each step of the implicit trapezoidal
//! rule solves `T·(x − x₀) − h/2·(f(x) + f(x₀)) = 0` for the variables with a time constant and `f(x) = 0` for the
//! others, by Newton's method on a sparse Jacobian. The Jacobian's pattern is fixed for the whole simulation (a
//! switched-out branch keeps its entries at zero), so the sparse LU is ordered once; the factorisation is reused from
//! step to step while Newton's method converges quickly and refreshed when it slows down, after an event, or when a
//! step fails, in which case the step is also halved.
//!
//! Anti-windup limits act on the iterate: a variable at its limit whose right-hand side pushes it further is held at
//! the limit and its equation becomes `x = limit`, until the right-hand side turns back. After four iterations a
//! variable that was held stays held for the rest of the step, so the iteration cannot chatter between the two. This
//! is the rule ANDES uses.
//!
//! At an event the network changes, the states keep their values, and the algebraic variables are solved again
//! before the next step starts from the new point.

use std::f64::consts::PI;

use ps_lf::Solution;
use ps_model::study::{EventKind, RmsSettings, SimEvent};
use ps_model::{Class, Model, RotorModel, Slot};
use ps_net::Calc;
use ps_num::{C64, DEG};
use ps_sparse::{CscBuilder, FaerLu, SparseSolver};
use serde::Serialize;

use crate::block::Layout;
use crate::exciter::{Exciter, Rating};
use crate::governor::Governor;
use crate::machine::{Machine, RoundData};
use crate::scalar::Dual;
use crate::stabiliser::Stabiliser;
use crate::unit::Unit;

/// Admittance of a bolted fault, p.u.
const FAULT_Y: f64 = 1e6;
/// Newton's method has converged when no variable moves by more than this.
const TOL: f64 = 1e-9;
/// Iterations per step before the Jacobian is refreshed, and in all.
const SLOW: usize = 4;
const MAX_ITER: usize = 25;
/// Iterations after which a held limit stays held for the step.
const LOCK: usize = 4;
/// How many times a step may be halved.
const HALVINGS: usize = 6;
/// Values the report may hold in all (samples times traces), and the samples each trace keeps at least: a 10,000-bus
/// network keeps a few hundred samples of every voltage rather than a report too large to send.
const VALUE_BUDGET: usize = 6_000_000;
const MIN_SAMPLES: usize = 300;

/// Traces of one machine or grid.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct MachineTrace {
    /// Element identifier.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Rotor angle against the reference, degrees.
    pub delta: Vec<f32>,
    /// Speed, Hz.
    pub speed: Vec<f32>,
    /// Electrical power, MW.
    pub pe: Vec<f32>,
    /// Reactive power, Mvar.
    pub q: Vec<f32>,
    /// Field voltage, p.u.; empty for an external grid.
    pub efd: Vec<f32>,
    /// Mechanical power, MW; empty for an external grid.
    pub pm: Vec<f32>,
}

/// An event and what became of it.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AppliedEvent {
    /// The event as given.
    #[serde(flatten)]
    pub event: SimEvent,
    /// Whether it changed the network.
    pub applied: bool,
    /// What it did, in plain words.
    pub note: String,
}

/// The simulation report.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RmsReport {
    /// Sample times, s.
    pub t: Vec<f32>,
    /// Machine and grid traces.
    pub machines: Vec<MachineTrace>,
    /// Bus identifiers, in bus order.
    pub bus_ids: Vec<String>,
    /// Voltage magnitude traces per bus, p.u.
    pub voltages: Vec<Vec<f32>>,
    /// Events in time order.
    pub events: Vec<AppliedEvent>,
    /// Whether every machine stayed in synchronism.
    pub stable: bool,
    /// When synchronism was lost, s.
    pub loss_of_synchronism: Option<f64>,
    /// `grid` when angles are measured against an external grid, `coi` for the centre of inertia.
    pub angle_reference: &'static str,
    /// Integration steps.
    pub steps: usize,
    /// Notes on the models: limits widened to the operating point, simplifications.
    pub notes: Vec<String>,
    /// Outcome in plain words.
    pub message: String,
}

/// Full-precision traces in the engine's own units, for comparison with a reference simulator.
#[derive(Debug, Clone, Default)]
pub struct Trajectory {
    /// Times, s.
    pub t: Vec<f64>,
    /// Per unit, in unit order (machines, then grids): rotor angle (rad, network frame), speed (p.u.), electrical
    /// and reactive power (p.u. system base), field voltage (p.u.) and mechanical power (p.u. system base).
    pub units: Vec<UnitTrajectory>,
    /// Identifier per unit.
    pub unit_ids: Vec<String>,
    /// Voltage magnitude per bus, p.u.
    pub voltages: Vec<Vec<f64>>,
    /// Identifier per bus.
    pub bus_ids: Vec<String>,
    /// Every unit's variables after initialisation, by unit and variable name.
    pub init: Vec<Vec<(String, f64)>>,
    /// The angle of the centre of inertia of the machines in service, rad, net of transformer phase shifts.
    pub coi: Vec<f64>,
}

/// One unit's traces.
#[derive(Debug, Clone, Default)]
pub struct UnitTrajectory {
    /// Rotor angle, rad.
    pub delta: Vec<f64>,
    /// Speed, p.u.
    pub omega: Vec<f64>,
    /// Electrical power, p.u.
    pub pe: Vec<f64>,
    /// Reactive power, p.u.
    pub qe: Vec<f64>,
    /// Field voltage, p.u.
    pub vf: Vec<f64>,
    /// Mechanical power, p.u.
    pub tm: Vec<f64>,
}

/// How a simulation steps across an event.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum EventSteps {
    /// The network changes, the algebraic variables are solved again with the states held, and the next step starts
    /// from that consistent point.
    #[default]
    Consistent,
    /// As ANDES 2.0 does: steps land 0.1 ms before and after each event, and the step after an event averages the
    /// derivatives after it with those before it. Its first-order error decays with the machines' subtransient time
    /// constants; it exists only so the engine can be compared with ANDES without it.
    Andes,
}

/// Solver options a caller may set; the defaults are what the app uses.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Options {
    /// How steps cross events.
    pub event_steps: EventSteps,
}

/// ANDES's step either side of an event, s.
const ANDES_EVENT_STEP: f64 = 1e-4;

/// A machine in the simulation.
struct Slotted {
    id: String,
    name: String,
    bus: usize,
    /// First variable.
    at: usize,
    unit: Unit,
    on: bool,
}

/// An external grid: a constant voltage behind its short-circuit impedance.
struct GridSource {
    id: String,
    name: String,
    bus: usize,
    y: C64,
    e: C64,
    on: bool,
}

/// A contribution to the admittance matrix, and what switches it.
#[derive(Clone, Copy, PartialEq)]
enum Owner {
    Always,
    Branch(usize),
    Load(usize),
    Fault(usize),
    Grid(usize),
}

struct YPart {
    pos: usize,
    y: C64,
    owner: Owner,
}

/// The assembled system.
struct System<'a> {
    model: &'a Model,
    calc: &'a Calc,
    index: ps_model::IdIndex,
    units: Vec<Slotted>,
    grids: Vec<GridSource>,
    nb: usize,
    /// Unit variables in all; bus `b`'s voltage is at `nx + 2b` (real) and `nx + 2b + 1` (imaginary).
    nx: usize,
    t: Vec<f64>,
    // Admittance matrix: positions (i, j), their current values, and the parts that make them.
    ypos: Vec<(usize, usize)>,
    yval: Vec<C64>,
    parts: Vec<YPart>,
    branch_ids: Vec<String>,
    load_ids: Vec<String>,
    load_scale: Vec<f64>,
    load_out: Vec<bool>,
    branch_out: Vec<bool>,
    fault_y: Vec<C64>,
    // Jacobian: pattern handles per Y position (4) and per unit block ((m + 2)²).
    yh: Vec<[usize; 4]>,
    uh: Vec<Vec<usize>>,
    nnz: usize,
    values: Vec<f64>,
    lu: FaerLu,
    factored: bool,
    /// The step length and holds the factorisation was built for.
    factored_for: (Option<f64>, Vec<i8>),
    // Anti-windup state per variable: 1 held at the upper limit, −1 at the lower, 0 free.
    held: Vec<i8>,
}

/// Work of one residual evaluation.
struct Eval {
    f: Vec<f64>,
    lim: Vec<Option<(f64, f64)>>,
    inj: Vec<f64>,
}

impl<'a> System<'a> {
    fn n(&self) -> usize {
        self.nx + 2 * self.nb
    }

    fn v_at(&self, z: &[f64], b: usize) -> [f64; 2] {
        [z[self.nx + 2 * b], z[self.nx + 2 * b + 1]]
    }

    /// Recomputes the admittance matrix's values from the parts in service.
    fn refresh_y(&mut self) {
        self.yval.iter_mut().for_each(|v| *v = C64::ZERO);
        for p in &self.parts {
            let on = match p.owner {
                Owner::Always => true,
                Owner::Branch(k) => !self.branch_out[k],
                Owner::Load(k) => !self.load_out[k],
                Owner::Fault(b) => {
                    self.yval[p.pos] += self.fault_y[b];
                    false
                }
                Owner::Grid(k) => self.grids[k].on,
            };
            if on {
                let y = match p.owner {
                    Owner::Load(k) => p.y.scale(self.load_scale[k]),
                    _ => p.y,
                };
                self.yval[p.pos] += y;
            }
        }
        self.factored = false;
    }

    /// Evaluates every right-hand side and the network's current balance. `held` limits are applied to `z` first.
    fn eval(&self, z: &[f64], e: &mut Eval) {
        e.f.iter_mut().for_each(|v| *v = 0.0);
        e.lim.iter_mut().for_each(|v| *v = None);
        e.inj.iter_mut().for_each(|v| *v = 0.0);
        for s in &self.units {
            let m = s.unit.layout.len();
            if !s.on {
                continue;
            }
            let x = &z[s.at..s.at + m];
            let v = self.v_at(z, s.bus);
            let out = s.unit.eval(x, v, &mut e.f[s.at..s.at + m], &mut e.lim[s.at..s.at + m]);
            e.inj[2 * s.bus] += out.stator.ir;
            e.inj[2 * s.bus + 1] += out.stator.ii;
        }
        for g in self.grids.iter().filter(|g| g.on) {
            let i = g.y * g.e;
            e.inj[2 * g.bus] += i.re;
            e.inj[2 * g.bus + 1] += i.im;
        }
        // Network: I_units − Y·V.
        for (k, &(i, j)) in self.ypos.iter().enumerate() {
            let y = self.yval[k];
            let (vr, vi) = (z[self.nx + 2 * j], z[self.nx + 2 * j + 1]);
            e.inj[2 * i] -= y.re * vr - y.im * vi;
            e.inj[2 * i + 1] -= y.im * vr + y.re * vi;
        }
    }

    /// Updates the anti-windup holds for the iterate's right-hand sides and pins held variables to their limits.
    /// Returns whether a variable moved.
    fn hold(&mut self, z: &mut [f64], e: &Eval, iter: usize) -> bool {
        let mut moved = false;
        for k in 0..self.nx {
            let Some((lo, hi)) = e.lim[k] else {
                self.held[k] = 0;
                continue;
            };
            let f = e.f[k];
            let now = if z[k] >= hi && f >= 0.0 {
                1
            } else if z[k] <= lo && f <= 0.0 {
                -1
            } else {
                0
            };
            self.held[k] = if iter > LOCK && self.held[k] != 0 {
                self.held[k]
            } else {
                now
            };
            let pin = match self.held[k] {
                1 => hi,
                -1 => lo,
                _ => continue,
            };
            moved |= z[k] != pin;
            z[k] = pin;
        }
        moved
    }

    /// The residual of a step of length `h` from `(z0, f0)`, or of the algebraic equations alone when `h` is `None`
    /// (states held at `z0`).
    fn residual(&self, z: &[f64], z0: &[f64], f0: &[f64], h: Option<f64>, e: &Eval, r: &mut [f64]) {
        for k in 0..self.nx {
            r[k] = if self.held[k] != 0 {
                0.0
            } else if self.t[k] > 0.0 {
                match h {
                    Some(h) => self.t[k] * (z[k] - z0[k]) - 0.5 * h * (e.f[k] + f0[k]),
                    None => z[k] - z0[k],
                }
            } else {
                e.f[k]
            };
        }
        for s in self.units.iter().filter(|s| !s.on) {
            for i in s.at..s.at + s.unit.layout.len() {
                r[i] = z[i] - z0[i];
            }
        }
        r[self.nx..].copy_from_slice(&e.inj);
    }

    /// Builds the Jacobian's values and factorises it.
    fn factor(&mut self, z: &[f64], h: Option<f64>) -> Result<(), String> {
        self.values.iter_mut().for_each(|v| *v = 0.0);
        for (k, _) in self.ypos.iter().enumerate() {
            let y = self.yval[k];
            let [a, b, c, d] = self.yh[k];
            // ∂(−Y·V)/∂V: real rows −G·Vr + B·Vi, imaginary rows −B·Vr − G·Vi.
            self.values[a] -= y.re;
            self.values[b] += y.im;
            self.values[c] -= y.im;
            self.values[d] -= y.re;
        }
        for (u, s) in self.units.iter().enumerate() {
            let m = s.unit.layout.len();
            let w = m + 2;
            let handles = &self.uh[u];
            if !s.on {
                for i in 0..m {
                    self.values[handles[i * w + i]] += 1.0;
                }
                continue;
            }
            let base: Vec<f64> = (0..m).map(|i| z[s.at + i]).chain(self.v_at(z, s.bus)).collect();
            let mut f = vec![Dual::default(); m];
            let mut lim = vec![None; m];
            for col in 0..w {
                let xd: Vec<Dual> = base.iter().enumerate().map(|(i, &v)| Dual::var(v, i == col)).collect();
                f.iter_mut().for_each(|v| *v = Dual::default());
                let out = s.unit.eval(&xd[..m], [xd[m], xd[m + 1]], &mut f, &mut lim);
                for row in 0..m {
                    let k = s.at + row;
                    let df = f[row].d;
                    let jv = if self.held[k] != 0 {
                        if row == col { 1.0 } else { 0.0 }
                    } else if self.t[k] > 0.0 {
                        match h {
                            Some(h) => (if row == col { self.t[k] } else { 0.0 }) - 0.5 * h * df,
                            None => {
                                if row == col {
                                    1.0
                                } else {
                                    0.0
                                }
                            }
                        }
                    } else {
                        df
                    };
                    self.values[handles[row * w + col]] += jv;
                }
                self.values[handles[m * w + col]] += out.stator.ir.d;
                self.values[handles[(m + 1) * w + col]] += out.stator.ii.d;
            }
        }
        self.lu
            .factor(&self.values)
            .map_err(|e| format!("The simulation's matrix could not be factorised: {e}."))?;
        self.factored = true;
        self.factored_for = (h, self.held.clone());
        Ok(())
    }

    /// Solves one step (or, with `h` `None`, the algebraic equations at fixed states) by Newton's method, starting
    /// from `z`. Returns the right-hand sides at the solution, held variables' set to zero.
    fn newton(
        &mut self,
        z: &mut [f64],
        z0: &[f64],
        f0: &[f64],
        h: Option<f64>,
        e: &mut Eval,
    ) -> Result<Vec<f64>, String> {
        let n = self.n();
        let mut r = vec![0.0; n];
        let mut fresh = false;
        for iter in 0..MAX_ITER {
            self.eval(z, e);
            if self.hold(z, e, iter) {
                self.eval(z, e);
            }
            let stale = self.factored_for.0 != h || self.factored_for.1 != self.held;
            if !self.factored || stale || (iter >= SLOW && !fresh) {
                self.factor(z, h)?;
                fresh = true;
            }
            self.residual(z, z0, f0, h, e, &mut r);
            if r.iter().any(|v| !v.is_finite()) {
                return Err("the equations could not be evaluated".into());
            }
            self.lu
                .solve(&mut r)
                .map_err(|e| format!("The simulation's equations could not be solved: {e}."))?;
            let mut worst = 0.0_f64;
            for (zi, dz) in z.iter_mut().zip(&r) {
                *zi -= dz;
                worst = worst.max(dz.abs());
            }
            if worst <= TOL {
                self.eval(z, e);
                let mut f = e.f.clone();
                for (k, fk) in f.iter_mut().enumerate().take(self.nx) {
                    if self.held[k] != 0 {
                        *fk = 0.0;
                    }
                }
                for s in self.units.iter().filter(|s| !s.on) {
                    f[s.at..s.at + s.unit.layout.len()].iter_mut().for_each(|v| *v = 0.0);
                }
                return Ok(f);
            }
            if !worst.is_finite() {
                break;
            }
        }
        self.factored = false;
        Err("Newton's method did not converge".into())
    }

    fn node_bus(&self, id: &str) -> Option<usize> {
        self.index
            .get(Class::Node, id)
            .and_then(|row| self.calc.topo.node_bus[row])
            .map(|b| b as usize)
    }

    fn name_of(&self, id: &str) -> String {
        Class::ALL
            .iter()
            .find_map(|&c| self.index.get(c, id).map(|row| self.model.name_of(c, row).to_string()))
            .unwrap_or_else(|| id.to_string())
    }

    /// Applies one event; returns whether the system changed.
    fn apply(&mut self, ev: &mut AppliedEvent) -> bool {
        let target = ev.event.target.clone();
        let name = self.name_of(&target);
        match ev.event.kind {
            EventKind::Fault => match self.node_bus(&target) {
                Some(b) => {
                    let (r, x) = (ev.event.r.unwrap_or(0.0), ev.event.x.unwrap_or(0.0));
                    let kv = self.calc.net.buses[b].base_kv;
                    let z = C64::new(
                        ps_net::ohms_pu(r, kv, self.calc.net.base_mva),
                        ps_net::ohms_pu(x, kv, self.calc.net.base_mva),
                    );
                    self.fault_y[b] = if z.abs() > 0.0 {
                        z.inv()
                    } else {
                        C64::new(0.0, -FAULT_Y)
                    };
                    ev.applied = true;
                    ev.note = if z.abs() > 0.0 {
                        format!("Three-phase fault at {name} through {r} + j{x} Ω.")
                    } else {
                        format!("Three-phase fault at {name}.")
                    };
                }
                None => ev.note = format!("{name} is not an energised busbar."),
            },
            EventKind::Clear => match self.node_bus(&target).filter(|&b| self.fault_y[b] != C64::ZERO) {
                Some(b) => {
                    self.fault_y[b] = C64::ZERO;
                    ev.applied = true;
                    ev.note = format!("Fault at {name} cleared.");
                }
                None => ev.note = format!("No fault at {name} to clear."),
            },
            EventKind::Trip | EventKind::Close => {
                let out = ev.event.kind == EventKind::Trip;
                if let Some(s) = self.units.iter_mut().find(|s| s.id == target) {
                    if out && s.on {
                        s.on = false;
                        ev.applied = true;
                        ev.note = format!("{name} tripped.");
                    } else {
                        ev.note = if out {
                            format!("{name} is already out of service.")
                        } else {
                            format!("{name} cannot be switched back in during a simulation.")
                        };
                    }
                } else if let Some(k) = self.grids.iter().position(|g| g.id == target) {
                    let on = !out;
                    if self.grids[k].on != on {
                        self.grids[k].on = on;
                        ev.applied = true;
                        ev.note = format!("{name} switched {}.", if out { "out" } else { "in" });
                    } else {
                        ev.note = format!("{name} is already {}.", if out { "out" } else { "in" });
                    }
                } else if let Some(k) = self.branch_ids.iter().position(|b| *b == target) {
                    if self.branch_out[k] != out {
                        self.branch_out[k] = out;
                        ev.applied = true;
                        ev.note = format!("{name} switched {}.", if out { "out" } else { "in" });
                    } else {
                        ev.note = format!("{name} is already {}.", if out { "out" } else { "in" });
                    }
                } else if let Some(k) = self.load_ids.iter().position(|l| *l == target) {
                    if self.load_out[k] != out {
                        self.load_out[k] = out;
                        ev.applied = true;
                        ev.note = format!("{name} switched {}.", if out { "out" } else { "in" });
                    } else {
                        ev.note = format!("{name} is already {}.", if out { "out" } else { "in" });
                    }
                } else {
                    ev.note = format!("{name} is not in service.");
                }
            }
            EventKind::Loadstep => match self.load_ids.iter().position(|l| *l == target) {
                Some(k) => {
                    self.load_scale[k] = ev.event.value.unwrap_or(100.0) / 100.0;
                    ev.applied = true;
                    ev.note = format!(
                        "{name} set to {:.0} % of its initial power.",
                        self.load_scale[k] * 100.0
                    );
                }
                None => ev.note = format!("{name} is not a load in service."),
            },
        }
        ev.applied
    }
}

/// Builds a generator's unit from its dynamic data.
fn build_unit(model: &Model, row: usize, sb: f64, bus_kv: f64, fn_hz: f64) -> Result<Unit, String> {
    let g = &model.generators[row];
    let d = &g.dynamics;
    let (sn, vn) = (g.rated_mva, g.rated_kv);
    let sn_sb = sn / sb;
    let z = |x: f64| ps_net::machine_z_pu(x, sn, vn, sb, bus_kv);
    let mut layout = Layout::default();
    let (m, damp, ra, wb) = (2.0 * d.h * sn_sb, d.d * sn_sb, z(g.sc.rs), 2.0 * PI * fn_hz);
    let machine = match d.rotor_model {
        RotorModel::Classical => Machine::classical(&mut layout, m, damp, ra, z(d.xdt), wb),
        RotorModel::RoundRotor => {
            let r = &d.rotor;
            let data = RoundData {
                xd: z(r.xd),
                xq: z(r.xq),
                xd1: z(d.xdt),
                xq1: z(r.xqt),
                xd2: z(g.sc.xdss),
                xl: z(r.xl),
                td10: r.td0t,
                td20: r.td0s,
                tq10: r.tq0t,
                tq20: r.tq0s,
                s10: r.s10,
                s12: r.s12,
            };
            if !(data.xd >= data.xd1 && data.xd1 >= data.xd2 && data.xd2 > data.xl && data.xq1 > data.xl) {
                return Err("its round-rotor data need Xd ≥ X′d ≥ X″d > Xl and X′q > Xl".into());
            }
            Machine::round(&mut layout, m, damp, ra, data, wb)
        }
    };
    if m <= 0.0 {
        return Err("its inertia constant must be above zero".into());
    }
    let governor = d
        .controls
        .slot(Slot::Governor)
        .map(|c| Governor::new(c, &mut layout, sn_sb))
        .transpose()?;
    let stabiliser = d
        .controls
        .slot(Slot::Stabiliser)
        .filter(|_| d.controls.exciter.is_some())
        .map(|c| Stabiliser::new(c, &mut layout, sn_sb))
        .transpose()?;
    let exciter = d
        .controls
        .slot(Slot::Exciter)
        .map(|c| Exciter::new(c, &mut layout, Rating { sn_sb }))
        .transpose()?;
    let vf = exciter.as_ref().map(|_| layout.add("machine", "vf", 0.0));
    Ok(Unit {
        machine,
        exciter,
        governor,
        stabiliser,
        vf,
        layout,
    })
}

/// Records samples.
struct Recorder {
    every: usize,
    traj: Trajectory,
}

impl Recorder {
    fn record(&mut self, sys: &System, z: &[f64], t: f64, nominal: &[f64]) {
        self.traj.t.push(t);
        let (mut sum, mut ms) = (0.0, 0.0);
        for s in sys.units.iter().filter(|s| s.on) {
            sum += s.unit.machine.m * (z[s.at + s.unit.machine.delta] - nominal[s.bus]);
            ms += s.unit.machine.m;
        }
        self.traj.coi.push(if ms > 0.0 { sum / ms } else { 0.0 });
        let mut f = vec![0.0; 64];
        let mut lim = vec![None; 64];
        for (k, s) in sys.units.iter().enumerate() {
            let m = s.unit.layout.len();
            if f.len() < m {
                f.resize(m, 0.0);
                lim.resize(m, None);
            }
            let x = &z[s.at..s.at + m];
            let out = s.unit.eval(x, sys.v_at(z, s.bus), &mut f[..m], &mut lim[..m]);
            let tr = &mut self.traj.units[k];
            tr.delta.push(x[s.unit.machine.delta]);
            tr.omega.push(x[s.unit.machine.omega]);
            let on = if s.on { 1.0 } else { 0.0 };
            tr.pe.push(out.stator.pe * on);
            tr.qe.push(out.stator.qe * on);
            tr.vf.push(out.vf);
            tr.tm.push(out.tm * on);
        }
        for (k, g) in sys.grids.iter().enumerate() {
            let tr = &mut self.traj.units[sys.units.len() + k];
            let v = sys.v_at(z, g.bus);
            let v = C64::new(v[0], v[1]);
            let s = if g.on { v * (g.y * (g.e - v)).conj() } else { C64::ZERO };
            tr.delta.push(g.e.arg());
            tr.omega.push(1.0);
            tr.pe.push(s.re);
            tr.qe.push(s.im);
        }
        for b in 0..sys.nb {
            let v = sys.v_at(z, b);
            self.traj.voltages[b].push((v[0] * v[0] + v[1] * v[1]).sqrt());
        }
    }
}

/// Simulates the settings' events from a solved load flow of `calc`. `max_samples` bounds the samples kept, as does
/// the report's budget of values on a large network;
/// `progress` receives (simulated time, end time). Returns the report and the full-precision trajectory at the same
/// samples.
pub fn simulate_detailed(
    model: &Model,
    calc: &Calc,
    lf: &Solution,
    st: &RmsSettings,
    max_samples: usize,
    options: Options,
    progress: &mut dyn FnMut(f64, f64),
) -> Result<(RmsReport, Trajectory), String> {
    let net = &calc.net;
    let nb = net.buses.len();
    let sb = net.base_mva;
    let f_hz = model.meta.frequency_hz;
    let (t_end, dt) = (st.t_end, st.dt);
    if !(dt > 0.0 && t_end > 0.0) {
        return Err("The simulation time and step size must be above zero.".into());
    }
    let v0: Vec<C64> = (0..nb).map(|i| C64::from_polar(lf.vm[i], lf.va[i])).collect();
    let mut notes = Vec::new();

    // Units: every generator with its controls. Static var compensators and converter stations are held at their
    // load-flow output as admittances below.
    let mut units: Vec<Slotted> = Vec::new();
    let mut z0: Vec<f64> = Vec::new();
    let mut init: Vec<Vec<(String, f64)>> = Vec::new();
    for u in lf.machines.iter().filter(|u| calc.unit(u.id).0 == Class::Generator) {
        let row = calc.machines[u.id] as usize;
        let bus = net.machines[u.id].bus;
        let name = model.name_of(Class::Generator, row).to_string();
        let id = model.generators[row].id.clone();
        let label = if name.is_empty() { id.clone() } else { name.clone() };
        let mut unit =
            build_unit(model, row, sb, net.buses[bus].base_kv, f_hz).map_err(|e| format!("{label}: {e}."))?;
        let mut unit_notes = Vec::new();
        let x = unit
            .init(v0[bus], C64::new(u.p, u.q), &mut unit_notes)
            .map_err(|e| format!("{label} could not be initialised: {e}."))?;
        notes.extend(unit_notes.into_iter().map(|n| format!("{label}: {n}")));
        init.push(unit.layout.names.iter().cloned().zip(x.iter().copied()).collect());
        units.push(Slotted {
            id,
            name,
            bus,
            at: z0.len(),
            unit,
            on: true,
        });
        z0.extend(x);
    }
    if units.is_empty() {
        return Err("The network has no synchronous machine to simulate.".into());
    }
    let grids: Vec<GridSource> = lf
        .grids
        .iter()
        .map(|u| {
            let row = calc.grids[u.id] as usize;
            let g = &model.external_grids[row];
            let bus = net.grids[u.id].bus;
            let x = (sb / g.sk_max) / (1.0 + g.rx_max * g.rx_max).sqrt();
            let y = C64::new(g.rx_max * x, x).inv();
            let i = (C64::new(u.p, u.q) / v0[bus]).conj();
            GridSource {
                id: g.id.clone(),
                name: model.name_of(Class::ExternalGrid, row).to_string(),
                bus,
                y,
                e: v0[bus] + i / y,
                on: true,
            }
        })
        .collect();
    let nx = z0.len();
    let mut t: Vec<f64> = units.iter().flat_map(|s| s.unit.layout.t.iter().copied()).collect();
    t.resize(nx + 2 * nb, 0.0);

    // The admittance matrix's parts.
    let mut ypos: Vec<(usize, usize)> = Vec::new();
    let mut pos_of = std::collections::HashMap::new();
    let mut at = |i: usize, j: usize, ypos: &mut Vec<(usize, usize)>| -> usize {
        *pos_of.entry((i, j)).or_insert_with(|| {
            ypos.push((i, j));
            ypos.len() - 1
        })
    };
    let mut parts: Vec<YPart> = Vec::new();
    for (k, br) in net.branches.iter().enumerate() {
        for (i, j, y) in [
            (br.f, br.f, br.yff),
            (br.f, br.t, br.yft),
            (br.t, br.f, br.ytf),
            (br.t, br.t, br.ytt),
        ] {
            parts.push(YPart {
                pos: at(i, j, &mut ypos),
                y,
                owner: Owner::Branch(k),
            });
        }
    }
    for s in &net.shunts {
        parts.push(YPart {
            pos: at(s.bus, s.bus, &mut ypos),
            y: s.y,
            owner: Owner::Always,
        });
    }
    // Loads become constant admittances at their initial voltage, y = (P − jQ)/|V|²; static var compensators and
    // converter stations the susceptance that gives their load-flow output.
    let mut load_ids = Vec::new();
    for l in &net.loads {
        let v2 = v0[l.bus].norm_sqr();
        let (class, row) = calc.load_unit(l.id);
        parts.push(YPart {
            pos: at(l.bus, l.bus, &mut ypos),
            y: C64::new(l.p / v2, -l.q / v2),
            owner: Owner::Load(load_ids.len()),
        });
        load_ids.push(model.id_of(class, row).unwrap_or("").to_string());
    }
    for u in lf.machines.iter().filter(|u| calc.unit(u.id).0 != Class::Generator) {
        let bus = net.machines[u.id].bus;
        let (class, row) = calc.unit(u.id);
        parts.push(YPart {
            pos: at(bus, bus, &mut ypos),
            y: C64::new(0.0, u.q / v0[bus].norm_sqr()),
            owner: Owner::Load(load_ids.len()),
        });
        load_ids.push(model.id_of(class, row).unwrap_or("").to_string());
    }
    for (k, g) in grids.iter().enumerate() {
        parts.push(YPart {
            pos: at(g.bus, g.bus, &mut ypos),
            y: g.y,
            owner: Owner::Grid(k),
        });
    }
    for b in 0..nb {
        parts.push(YPart {
            pos: at(b, b, &mut ypos),
            y: C64::ZERO,
            owner: Owner::Fault(b),
        });
    }

    // The Jacobian's pattern.
    let n = nx + 2 * nb;
    let mut builder = CscBuilder::new(n, n);
    let yh: Vec<[usize; 4]> = ypos
        .iter()
        .map(|&(i, j)| {
            let (r, c) = (nx + 2 * i, nx + 2 * j);
            [
                builder.push(r, c),
                builder.push(r, c + 1),
                builder.push(r + 1, c),
                builder.push(r + 1, c + 1),
            ]
        })
        .collect();
    let uh: Vec<Vec<usize>> = units
        .iter()
        .map(|s| {
            let m = s.unit.layout.len();
            let index = |k: usize| if k < m { s.at + k } else { nx + 2 * s.bus + (k - m) };
            let mut h = Vec::with_capacity((m + 2) * (m + 2));
            for row in 0..m + 2 {
                for col in 0..m + 2 {
                    h.push(builder.push(index(row), index(col)));
                }
            }
            h
        })
        .collect();
    let (pattern, slot) = builder.build();
    let yh = yh.into_iter().map(|h| h.map(|k| slot[k])).collect();
    let uh = uh
        .into_iter()
        .map(|h| h.into_iter().map(|k| slot[k]).collect())
        .collect();
    let mut lu = FaerLu::new();
    lu.analyse(&pattern)
        .map_err(|e| format!("The simulation's matrix could not be ordered: {e}."))?;

    let branch_ids: Vec<String> = calc
        .branches
        .iter()
        .map(|b| model.id_of(b.class, b.row as usize).unwrap_or("").to_string())
        .collect();
    let mut sys = System {
        model,
        calc,
        index: model.index(),
        nb,
        nx,
        t,
        yval: vec![C64::ZERO; ypos.len()],
        ypos,
        parts,
        branch_out: vec![false; branch_ids.len()],
        branch_ids,
        load_scale: vec![1.0; load_ids.len()],
        load_out: vec![false; load_ids.len()],
        load_ids,
        fault_y: vec![C64::ZERO; nb],
        yh,
        uh,
        nnz: pattern.nnz(),
        values: vec![0.0; pattern.nnz()],
        lu,
        factored: false,
        factored_for: (None, Vec::new()),
        held: vec![0; nx],
        units,
        grids,
    };
    debug_assert_eq!(sys.values.len(), sys.nnz);
    sys.refresh_y();

    let mut z: Vec<f64> = z0;
    for v in &v0 {
        z.push(v.re);
        z.push(v.im);
    }
    let mut e = Eval {
        f: vec![0.0; nx],
        lim: vec![None; nx],
        inj: vec![0.0; 2 * nb],
    };

    let mut events: Vec<AppliedEvent> = st
        .events
        .iter()
        .map(|ev| AppliedEvent {
            event: ev.clone(),
            applied: false,
            note: String::new(),
        })
        .collect();
    events.sort_by(|a, b| a.event.t.partial_cmp(&b.event.t).unwrap_or(std::cmp::Ordering::Equal));
    let steps_planned = (t_end / dt - 1e-9).ceil().max(1.0) as usize;
    let n_units = sys.units.len() + sys.grids.len();
    // Each machine and grid has six traces, each bus one.
    let traces = nb + 6 * n_units;
    let samples = max_samples.min((VALUE_BUDGET / traces.max(1)).max(MIN_SAMPLES)).max(1);
    let every = (steps_planned + 1 + 2 * events.len()).div_ceil(samples).max(1);
    let mut rec = Recorder {
        every,
        traj: Trajectory {
            units: vec![UnitTrajectory::default(); n_units],
            unit_ids: sys
                .units
                .iter()
                .map(|s| s.id.clone())
                .chain(sys.grids.iter().map(|g| g.id.clone()))
                .collect(),
            voltages: vec![Vec::new(); nb],
            bus_ids: (0..nb).map(|b| calc.bus_id(model, b)).collect(),
            init,
            ..Default::default()
        },
    };
    let nominal = ps_lf::nominal_angles(net, &vec![0.0; nb]);

    // Events at t = 0 apply before the first sample.
    let mut next = 0;
    let due =
        |events: &[AppliedEvent], next: usize, t: f64| next < events.len() && events[next].event.t <= t + dt * 1e-6;
    let apply_due = |sys: &mut System, events: &mut [AppliedEvent], next: &mut usize, t: f64| -> bool {
        let mut changed = false;
        while due(events, *next, t) {
            changed |= sys.apply(&mut events[*next]);
            *next += 1;
        }
        if changed {
            sys.refresh_y();
        }
        changed
    };
    let mut f0 = {
        let zs = z.clone();
        apply_due(&mut sys, &mut events, &mut next, 0.0);
        sys.newton(&mut z, &zs, &[], None, &mut e)
            .map_err(|err| format!("The initial state could not be solved: {err}."))?
    };
    rec.record(&sys, &z, 0.0, &nominal);
    let mut time = 0.0;
    let mut steps = 0;
    let mut loss_of_synchronism = None;
    let mut since = 0;
    let andes = options.event_steps == EventSteps::Andes;
    while time < t_end - dt * 1e-9 {
        let mut target = events.get(next).map_or(t_end, |ev| ev.event.t.min(t_end)).max(time);
        if andes {
            let near = |te: f64, side: f64| {
                let at = te + side * ANDES_EVENT_STEP;
                (time < at - 1e-12).then_some(at)
            };
            if let Some(at) = events.get(next).and_then(|ev| near(ev.event.t, -1.0)) {
                target = target.min(at);
            }
            if let Some(at) = next.checked_sub(1).and_then(|k| near(events[k].event.t, 1.0)) {
                target = target.min(at);
            }
        }
        let mut h = dt.min(target - time);
        if h <= dt * 1e-9 {
            h = dt.min(t_end - time);
        }
        // A step, halved when Newton's method fails.
        let zs = z.clone();
        let mut halvings = 0;
        let f_new = loop {
            let mut trial = zs.clone();
            match sys.newton(&mut trial, &zs, &f0, Some(h), &mut e) {
                Ok(f) => {
                    z = trial;
                    break f;
                }
                Err(err) if halvings < HALVINGS => {
                    let _ = err;
                    halvings += 1;
                    h /= 2.0;
                    sys.factored = false;
                }
                Err(err) => {
                    return Err(format!(
                        "The simulation stopped at {time:.4} s: {err} even with the step cut to {h:.2e} s."
                    ));
                }
            }
        };
        f0 = f_new;
        time += h;
        steps += 1;
        since += 1;
        if (target - time).abs() <= dt * 1e-9 {
            time = target;
        }
        if due(&events, next, time) {
            rec.record(&sys, &z, time, &nominal); // the value just before the event
            if apply_due(&mut sys, &mut events, &mut next, time) && !andes {
                let zs = z.clone();
                f0 = sys.newton(&mut z, &zs, &f0, None, &mut e).map_err(|err| {
                    format!("The network after the events at {time:.4} s could not be solved: {err}.")
                })?;
            }
            rec.record(&sys, &z, time, &nominal);
            since = 0;
        } else if since >= rec.every || time >= t_end - dt * 1e-9 {
            rec.record(&sys, &z, time, &nominal);
            since = 0;
        }
        if loss_of_synchronism.is_none() && separation(&sys, &z, &nominal) > PI {
            loss_of_synchronism = Some(time);
        }
        if steps & 255 == 0 {
            progress(time, t_end);
        }
    }
    progress(time, t_end);

    let traj = rec.traj;
    let report = report(
        &sys,
        &traj,
        &nominal,
        events,
        steps,
        loss_of_synchronism,
        notes,
        f_hz,
        sb,
    );
    Ok((report, traj))
}

/// Simulates the settings' events from a solved load flow of `calc`; see [`simulate_detailed`].
pub fn simulate(
    model: &Model,
    calc: &Calc,
    lf: &Solution,
    st: &RmsSettings,
    max_samples: usize,
    progress: &mut dyn FnMut(f64, f64),
) -> Result<RmsReport, String> {
    simulate_detailed(model, calc, lf, st, max_samples, Options::default(), progress).map(|(r, _)| r)
}

/// The report from the recorded trajectory.
#[allow(clippy::too_many_arguments)]
fn report(
    sys: &System,
    traj: &Trajectory,
    nominal: &[f64],
    events: Vec<AppliedEvent>,
    steps: usize,
    loss_of_synchronism: Option<f64>,
    notes: Vec<String>,
    f_hz: f64,
    sb: f64,
) -> RmsReport {
    let has_grid = !sys.grids.is_empty();
    // Angles against the grid when there is one, else against the centre of inertia of the machines in service.
    let reference: Vec<f64> = if has_grid {
        vec![0.0; traj.t.len()]
    } else {
        traj.coi.clone()
    };
    let bus_of: Vec<usize> = sys
        .units
        .iter()
        .map(|s| s.bus)
        .chain(sys.grids.iter().map(|g| g.bus))
        .collect();
    let names: Vec<(&str, &str)> = sys
        .units
        .iter()
        .map(|s| (s.id.as_str(), s.name.as_str()))
        .chain(sys.grids.iter().map(|g| (g.id.as_str(), g.name.as_str())))
        .collect();
    let machines = traj
        .units
        .iter()
        .enumerate()
        .map(|(u, tr)| {
            let machine = u < sys.units.len();
            let f32s = |v: &[f64], scale: f64| v.iter().map(|x| (x * scale) as f32).collect::<Vec<f32>>();
            MachineTrace {
                id: names[u].0.to_string(),
                name: names[u].1.to_string(),
                delta: tr
                    .delta
                    .iter()
                    .zip(&reference)
                    .map(|(d, r)| ((d - nominal[bus_of[u]] - r) * DEG) as f32)
                    .collect(),
                speed: f32s(&tr.omega, f_hz),
                pe: f32s(&tr.pe, sb),
                q: f32s(&tr.qe, sb),
                efd: if machine { f32s(&tr.vf, 1.0) } else { Vec::new() },
                pm: if machine { f32s(&tr.tm, sb) } else { Vec::new() },
            }
        })
        .collect();
    RmsReport {
        t: traj.t.iter().map(|&t| t as f32).collect(),
        machines,
        bus_ids: traj.bus_ids.clone(),
        voltages: traj
            .voltages
            .iter()
            .map(|v| v.iter().map(|&x| x as f32).collect())
            .collect(),
        events,
        stable: loss_of_synchronism.is_none(),
        loss_of_synchronism,
        angle_reference: if has_grid { "grid" } else { "coi" },
        steps,
        notes,
        message: match loss_of_synchronism {
            None => "All machines stay in synchronism.".into(),
            Some(t) => format!("Loss of synchronism at {t:.3} s."),
        },
    }
}

/// Largest rotor angle difference between sources in service, grids included, net of transformer phase shifts.
fn separation(sys: &System, z: &[f64], nominal: &[f64]) -> f64 {
    let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
    for s in sys.units.iter().filter(|s| s.on) {
        let a = z[s.at + s.unit.machine.delta] - nominal[s.bus];
        lo = lo.min(a);
        hi = hi.max(a);
    }
    for g in sys.grids.iter().filter(|g| g.on) {
        let a = g.e.arg() - nominal[g.bus];
        lo = lo.min(a);
        hi = hi.max(a);
    }
    hi - lo
}
