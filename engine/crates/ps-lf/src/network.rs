//! The per-unit network the load flow solves.

use ps_num::C64;

/// How a machine is controlled in the load flow.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MachineMode {
    /// Holds active power and the voltage of its bus.
    Pv,
    /// Holds active and reactive power.
    Pq,
    /// Sets the voltage angle of its island and balances it.
    Reference,
}

/// The role of a bus in the equations, derived from what is connected to it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum BusKind {
    /// Active and reactive power scheduled.
    Pq,
    /// Active power and voltage magnitude scheduled.
    Pv,
    /// Voltage magnitude and angle scheduled.
    Reference,
}

/// A calculation bus.
#[derive(Debug, Clone, PartialEq)]
pub struct PuBus {
    /// Base voltage, kV.
    pub base_kv: f64,
    /// Starting voltage magnitude for warm starts, p.u. (1 for a flat start).
    pub vm0: f64,
    /// Starting angle for warm starts, radians.
    pub va0: f64,
}

/// A branch as a two-port: `[If; It] = [yff yft; ytf ytt] [Vf; Vt]` in per unit.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PuBranch {
    /// Caller's identifier for mapping results back (an index into the caller's own table).
    pub id: usize,
    /// From bus.
    pub f: usize,
    /// To bus.
    pub t: usize,
    /// From-from admittance.
    pub yff: C64,
    /// From-to admittance.
    pub yft: C64,
    /// To-from admittance.
    pub ytf: C64,
    /// To-to admittance.
    pub ytt: C64,
    /// Phase shift of the ideal transformer at the from end, radians (the to end lags).
    pub shift: f64,
}

/// A synchronous machine or other controllable source.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PuMachine {
    /// Caller's identifier.
    pub id: usize,
    /// Bus.
    pub bus: usize,
    /// Control mode.
    pub mode: MachineMode,
    /// Scheduled active power, p.u.
    pub p: f64,
    /// Scheduled reactive power (PQ mode), p.u.
    pub q: f64,
    /// Voltage setpoint, p.u.
    pub v_set: f64,
    /// Angle setpoint (reference mode), radians.
    pub angle: f64,
    /// Reactive power limits, p.u.
    pub q_min: f64,
    /// Upper reactive power limit, p.u.
    pub q_max: f64,
}

/// An external grid: a reference source.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PuGrid {
    /// Caller's identifier.
    pub id: usize,
    /// Bus.
    pub bus: usize,
    /// Voltage setpoint, p.u.
    pub v_set: f64,
    /// Angle, radians.
    pub angle: f64,
}

/// A constant-power load.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PuLoad {
    /// Caller's identifier.
    pub id: usize,
    /// Bus.
    pub bus: usize,
    /// Active power consumed, p.u.
    pub p: f64,
    /// Reactive power consumed, p.u.
    pub q: f64,
}

/// A constant admittance to earth.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PuShunt {
    /// Caller's identifier.
    pub id: usize,
    /// Bus.
    pub bus: usize,
    /// Admittance at 1 p.u., p.u. (positive imaginary part is capacitive).
    pub y: C64,
}

/// A per-unit network ready to solve.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PuNetwork {
    /// Base power, MVA.
    pub base_mva: f64,
    /// Calculation buses.
    pub buses: Vec<PuBus>,
    /// Branches.
    pub branches: Vec<PuBranch>,
    /// Machines.
    pub machines: Vec<PuMachine>,
    /// External grids.
    pub grids: Vec<PuGrid>,
    /// Loads.
    pub loads: Vec<PuLoad>,
    /// Shunts.
    pub shunts: Vec<PuShunt>,
}

/// Two-port admittances of a series impedance `z`, total shunt admittance `ysh` split between both ends, and an ideal
/// transformer `t = ratio·e^{jθ}` at the from end (MATPOWER convention).
pub fn two_port(z: C64, ysh: C64, ratio: f64, shift: f64) -> (C64, C64, C64, C64) {
    let ys = z.inv();
    let half = ysh.scale(0.5);
    let ytt = ys + half;
    let yff = ytt.scale(1.0 / (ratio * ratio));
    let t = C64::from_polar(ratio, shift);
    let yft = -(ys / t.conj());
    let ytf = -(ys / t);
    (yff, yft, ytf, ytt)
}
