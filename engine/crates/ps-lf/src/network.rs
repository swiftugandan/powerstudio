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

/// What kind of unit a machine is, where the load flow treats kinds differently.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub enum UnitKind {
    /// A synchronous machine or other generating unit.
    #[default]
    Generator,
    /// A static var compensator: its reactive limits are susceptances, so they scale with the square of the voltage
    /// (`q_min` and `q_max` hold them at 1 p.u.).
    Svc,
    /// An HVDC converter station: it holds the active power its link sets and never takes part in slack distribution.
    Converter,
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
    /// Voltage setpoint, p.u. of the regulated bus's base voltage.
    pub v_set: f64,
    /// Bus whose voltage the machine regulates (its own bus for local control). Every voltage-controlling machine of
    /// a bus regulates the same bus; the network builder ensures it.
    pub reg_bus: usize,
    /// Angle setpoint (reference mode), radians.
    pub angle: f64,
    /// Reactive power limits, p.u.
    pub q_min: f64,
    /// Upper reactive power limit, p.u.
    pub q_max: f64,
    /// Lower active power limit, p.u.
    pub p_min: f64,
    /// Upper active power limit, p.u.
    pub p_max: f64,
    /// Whether the machine takes part in a distributed slack.
    pub participates: bool,
    /// Explicit participation factor (for distribution by factors), any unit; 0 for none.
    pub factor: f64,
    /// Kind of unit.
    pub kind: UnitKind,
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

/// A load. At voltage V (p.u.) it consumes `p·(z·V² + i·V + c)` with `[z, i, c] = p_zip`, and likewise for `q`;
/// `[0, 0, 1]` is constant power.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PuLoad {
    /// Caller's identifier.
    pub id: usize,
    /// Bus.
    pub bus: usize,
    /// Active power consumed at 1 p.u., p.u.
    pub p: f64,
    /// Reactive power consumed at 1 p.u., p.u.
    pub q: f64,
    /// Constant impedance, current and power shares of `p`.
    pub p_zip: [f64; 3],
    /// Constant impedance, current and power shares of `q`.
    pub q_zip: [f64; 3],
}

impl PuLoad {
    /// Active and reactive power consumed at voltage `v`, and their derivatives with respect to `v`, p.u. With
    /// `zip` false every load is constant power.
    pub fn at(&self, v: f64, zip: bool) -> (f64, f64, f64, f64) {
        if !zip {
            return (self.p, self.q, 0.0, 0.0);
        }
        let f = |s: [f64; 3]| (s[0] * v * v + s[1] * v + s[2], 2.0 * s[0] * v + s[1]);
        let ((fp, dp), (fq, dq)) = (f(self.p_zip), f(self.q_zip));
        (self.p * fp, self.q * fq, self.p * dp, self.q * dq)
    }
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

/// A branch's two-port at one tap position: the four admittances and the phase shift (as in [`PuBranch`]).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TwoPort {
    /// From-from admittance.
    pub yff: C64,
    /// From-to admittance.
    pub yft: C64,
    /// To-from admittance.
    pub ytf: C64,
    /// To-to admittance.
    pub ytt: C64,
    /// Phase shift, radians.
    pub shift: f64,
    /// Off-nominal ratio of the ideal transformer at the from end.
    pub ratio: f64,
}

/// What a tap changer regulates.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum TapTarget {
    /// The voltage magnitude of a bus, p.u., within a dead band (full width, p.u.).
    Voltage {
        /// Regulated bus.
        bus: usize,
        /// Target, p.u.
        target: f64,
        /// Dead band, full width, p.u.
        deadband: f64,
    },
    /// The active power entering the branch at its from end, p.u., within a dead band (full width, p.u.).
    Flow {
        /// Target, p.u.
        target: f64,
        /// Dead band, full width, p.u.
        deadband: f64,
    },
}

/// One tap changer of a [`PuTapBranch`]: its positions and what it regulates.
#[derive(Debug, Clone, PartialEq)]
pub struct TapAxis {
    /// Caller's identifier (the element and winding it belongs to).
    pub id: usize,
    /// Lowest position.
    pub low: i32,
    /// Number of positions.
    pub count: usize,
    /// Present position, as an index from `low`.
    pub index: usize,
    /// Whether it is a phase tap changer (its positions change the angle).
    pub phase: bool,
    /// What it regulates, if it has an active control.
    pub target: Option<TapTarget>,
}

/// A branch whose admittances depend on one or two tap changers. `table` holds the two-port for every combination of
/// positions, the first axis varying slowest.
#[derive(Debug, Clone, PartialEq)]
pub struct PuTapBranch {
    /// Branch index in [`PuNetwork::branches`].
    pub branch: usize,
    /// The tap changers (one or two).
    pub axes: Vec<TapAxis>,
    /// Two-port per combination of positions.
    pub table: Vec<TwoPort>,
}

impl PuTapBranch {
    /// The table row of the given axis indices.
    pub fn row(&self, index: &[usize]) -> usize {
        self.axes.iter().zip(index).fold(0, |acc, (a, &i)| acc * a.count + i)
    }

    /// The two-port at the axes' present positions.
    pub fn current(&self) -> TwoPort {
        let idx: Vec<usize> = self.axes.iter().map(|a| a.index).collect();
        self.table[self.row(&idx)]
    }
}

/// A shunt with sections that a voltage control switches.
#[derive(Debug, Clone, PartialEq)]
pub struct PuShuntControl {
    /// Caller's identifier.
    pub id: usize,
    /// Shunt index in [`PuNetwork::shunts`].
    pub shunt: usize,
    /// Admittance with 0, 1, … sections in service, p.u. at 1 p.u. voltage.
    pub steps: Vec<C64>,
    /// Sections in service.
    pub index: usize,
    /// Regulated bus.
    pub bus: usize,
    /// Target voltage, p.u.
    pub target: f64,
    /// Dead band, full width, p.u.
    pub deadband: f64,
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
    /// Branches with tap changers whose position can change (regulated, or listed for sensitivity and contingency
    /// studies).
    pub taps: Vec<PuTapBranch>,
    /// Shunts with voltage-controlled sections.
    pub shunt_controls: Vec<PuShuntControl>,
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

/// Nominal angle of every bus, radians: the sum of the transformer phase shifts on a path from its island's reference,
/// found breadth-first from the grids, then the reference machines. `seed` gives the references' own angles; buses no
/// reference reaches keep their seed value.
pub fn nominal_angles(net: &PuNetwork, seed: &[f64]) -> Vec<f64> {
    let n = net.buses.len();
    let mut va = seed.to_vec();
    va.resize(n, 0.0);
    let mut visited = vec![false; n];
    let mut queue = std::collections::VecDeque::new();
    let roots = net.grids.iter().map(|g| g.bus).chain(
        net.machines
            .iter()
            .filter(|g| g.mode == MachineMode::Reference)
            .map(|g| g.bus),
    );
    for b in roots {
        if b < n && !visited[b] {
            visited[b] = true;
            queue.push_back(b);
        }
    }
    let mut adj: Vec<Vec<(usize, f64)>> = vec![Vec::new(); n];
    for br in &net.branches {
        // The to end lags the from end by the phase shift.
        adj[br.f].push((br.t, -br.shift));
        adj[br.t].push((br.f, br.shift));
    }
    while let Some(i) = queue.pop_front() {
        for &(to, shift) in &adj[i] {
            if !visited[to] {
                visited[to] = true;
                va[to] = va[i] + shift;
                queue.push_back(to);
            }
        }
    }
    va
}
