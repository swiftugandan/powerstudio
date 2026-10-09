//! The per-unit calculation network.
//!
//! Per-unit bases are the model's base power and each calculation bus's base voltage (the nominal voltage of its
//! nodes). Every branch becomes a two-port in the MATPOWER convention: an ideal transformer `t = ratio·e^{jθ}` at the
//! from end, the series impedance on the to side, and shunt admittances at each end (the from one behind the ideal
//! transformer). Load flow, short circuit and stability all assemble their matrices from these conversions, so the
//! per-unit system is defined once, here. docs/ENGINE.md derives each model.

use ps_lf::{MachineMode, PuBranch, PuBus, PuGrid, PuLoad, PuMachine, PuNetwork, PuShunt};
use ps_model::{Class, Line, MachineControl, Model, Transformer2, Transformer3};
use ps_num::{C64, DEG};
use ps_topology::{Outages, Topology, active};

/// Which sequence network a conversion is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Seq {
    /// Positive (and negative) sequence.
    Positive,
    /// Zero sequence.
    Zero,
}

/// Series impedance and total shunt admittance of a line, p.u. on the base of `base_kv`.
pub fn line_pu(l: &Line, base_kv: f64, base_mva: f64, seq: Seq) -> (C64, C64) {
    let zb = base_kv * base_kv / base_mva;
    match seq {
        Seq::Positive => (C64::new(l.r / zb, l.x / zb), C64::new(l.g * zb, l.b * zb)),
        Seq::Zero => (C64::new(l.r0 / zb, l.x0 / zb), C64::new(0.0, l.b0 * zb)),
    }
}

/// A transformer winding pair reduced to per unit.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TransformerPu {
    /// Series impedance on the to-side base, p.u.
    pub z: C64,
    /// Shunt admittance at the from end, on the to-side base (it sits behind the ideal transformer), p.u.
    pub y_from: C64,
    /// Shunt admittance at the to end, p.u.
    pub y_to: C64,
    /// Off-nominal ratio of the ideal transformer.
    pub ratio: f64,
    /// Phase shift, radians (the to end lags).
    pub shift: f64,
}

/// Options for a transformer conversion.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TransformerOptions {
    /// Apply tap positions (false gives the rated ratio).
    pub taps: bool,
    /// Multiplies the series impedance (the IEC 60909 correction factor KT).
    pub correction: f64,
    /// Sequence.
    pub seq: Seq,
}

impl Default for TransformerOptions {
    fn default() -> Self {
        Self {
            taps: true,
            correction: 1.0,
            seq: Seq::Positive,
        }
    }
}

/// The voltage factor of a ratio tap changer on a winding: 1 + (position − neutral)·step.
pub fn tap_factor(t: &Transformer2, end: u8) -> f64 {
    match t.ratio_tap {
        Some(tap) if tap.end == end => 1.0 + f64::from(tap.position - tap.neutral) * tap.step_pct / 100.0,
        _ => 1.0,
    }
}

/// Total phase shift of a two-winding transformer, degrees: vector group, fixed shift and phase tap position.
pub fn shift_deg(t: &Transformer2) -> f64 {
    let tap = t
        .phase_tap
        .map_or(0.0, |p| f64::from(p.position - p.neutral) * p.step_deg);
    f64::from(t.clock % 12) * 30.0 + t.phase_shift_deg + tap
}

/// Converts a two-winding transformer between buses of base `vh` (winding 1) and `vl` (winding 2) kV. The series
/// impedance is referred to winding 2 by the rated ratio (taps do not change it), and the taps act through the ideal
/// transformer.
pub fn transformer2_pu(t: &Transformer2, vh: f64, vl: f64, base_mva: f64, opt: TransformerOptions) -> TransformerPu {
    let (k1, k2) = (t.rated_kv1, t.rated_kv2);
    // Ω at winding 1 → p.u. on the winding-2 bus base.
    let z_scale = (k2 / k1).powi(2) * base_mva / (vl * vl);
    let (r, x) = match opt.seq {
        Seq::Positive => (t.r, t.x),
        Seq::Zero => (t.r0, t.x0),
    };
    let z = C64::new(r, x).scale(z_scale * opt.correction);
    // S referred to winding 1 → p.u. on the winding-2 bus base.
    let y_scale = (k1 / k2).powi(2) * vl * vl / base_mva;
    let (y_from, y_to) = match opt.seq {
        Seq::Positive => (C64::new(t.g1, t.b1).scale(y_scale), C64::new(t.g2, t.b2).scale(y_scale)),
        Seq::Zero => (C64::ZERO, C64::ZERO),
    };
    let (f1, f2) = if opt.taps {
        (tap_factor(t, 1), tap_factor(t, 2))
    } else {
        (1.0, 1.0)
    };
    let ratio = (k1 * f1 / (k2 * f2)) / (vh / vl);
    TransformerPu {
        z,
        y_from,
        y_to,
        ratio,
        shift: shift_deg(t) / DEG,
    }
}

/// Two-port admittances `(yff, yft, ytf, ytt)` of a converted branch.
pub fn two_port(z: C64, y_from: C64, y_to: C64, ratio: f64, shift: f64) -> (C64, C64, C64, C64) {
    let ys = z.inv();
    let t = C64::from_polar(ratio, shift);
    (
        (ys + y_from).scale(1.0 / (ratio * ratio)),
        -(ys / t.conj()),
        -(ys / t),
        ys + y_to,
    )
}

/// Where a calculation branch comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BranchSource {
    /// Class of the element.
    pub class: Class,
    /// Row of the element.
    pub row: u32,
    /// Winding (1–3) for a three-winding transformer, 0 otherwise.
    pub winding: u8,
}

/// Build settings.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BuildOptions {
    /// Multiplies every load.
    pub load_scale: f64,
}

impl Default for BuildOptions {
    fn default() -> Self {
        Self { load_scale: 1.0 }
    }
}

/// The per-unit network with the topology it was built on and the origin of each of its rows.
#[derive(Debug, Clone)]
pub struct Calc {
    /// The network the solvers take.
    pub net: PuNetwork,
    /// The topology.
    pub topo: Topology,
    /// Origin of each branch (`net.branches[i].id == i`).
    pub branches: Vec<BranchSource>,
    /// Generator row of each machine.
    pub machines: Vec<u32>,
    /// External grid row of each grid.
    pub grids: Vec<u32>,
    /// Load row of each load.
    pub loads: Vec<u32>,
    /// Shunt row of each of the first `shunts.len()` network shunts; the rest are transformer star points.
    pub shunts: Vec<u32>,
    /// What the build simplified or skipped, in plain words.
    pub warnings: Vec<String>,
}

impl Calc {
    /// Builds the calculation network for the model with the given outages.
    pub fn build(model: &Model, outages: &Outages, opt: BuildOptions) -> Calc {
        let topo = Topology::build(model, outages);
        let sb = model.meta.base_mva;
        let mut warnings = topo.warnings.clone();
        let mut net = PuNetwork {
            base_mva: sb,
            buses: topo
                .buses
                .iter()
                .map(|b| PuBus {
                    base_kv: b.base_kv,
                    vm0: 1.0,
                    va0: 0.0,
                })
                .collect(),
            ..Default::default()
        };
        // Starting values from the model's last solution, where it has one.
        for (i, b) in topo.buses.iter().enumerate() {
            if let Some(n) = b.nodes.iter().map(|&n| &model.nodes[n as usize]).find(|n| n.v0 > 0.0) {
                net.buses[i].vm0 = n.v0;
                net.buses[i].va0 = n.angle0 / DEG;
            }
        }
        let on = |class, row| active(model, outages, class, row);
        let mut branches = Vec::new();
        for (k, l) in model.lines.iter().enumerate() {
            let (Some(f), Some(t)) = (topo.bus_of(l.node1), topo.bus_of(l.node2)) else {
                continue;
            };
            if !on(Class::Line, k) {
                continue;
            }
            let (z, ysh) = line_pu(l, net.buses[f].base_kv, sb, Seq::Positive);
            push_branch(
                &mut net,
                &mut branches,
                BranchSource {
                    class: Class::Line,
                    row: k as u32,
                    winding: 0,
                },
                f,
                t,
                z,
                ysh.scale(0.5),
                ysh.scale(0.5),
                1.0,
                0.0,
            );
        }
        for (k, tr) in model.transformers2.iter().enumerate() {
            let (Some(f), Some(t)) = (topo.bus_of(tr.node1), topo.bus_of(tr.node2)) else {
                continue;
            };
            if !on(Class::Transformer2, k) {
                continue;
            }
            let p = transformer2_pu(
                tr,
                net.buses[f].base_kv,
                net.buses[t].base_kv,
                sb,
                TransformerOptions::default(),
            );
            push_branch(
                &mut net,
                &mut branches,
                BranchSource {
                    class: Class::Transformer2,
                    row: k as u32,
                    winding: 0,
                },
                f,
                t,
                p.z,
                p.y_from,
                p.y_to,
                p.ratio,
                p.shift,
            );
        }
        let mut star_shunts = Vec::new();
        for (k, tr) in model.transformers3.iter().enumerate() {
            let Some(star) = topo.star_bus[k].map(|s| s as usize) else {
                continue;
            };
            for (w, wd) in tr.windings.iter().enumerate() {
                let Some(f) = topo.bus_of(wd.node) else {
                    continue;
                };
                let p = transformer3_winding_pu(tr, w, net.buses[f].base_kv, sb);
                push_branch(
                    &mut net,
                    &mut branches,
                    BranchSource {
                        class: Class::Transformer3,
                        row: k as u32,
                        winding: w as u8 + 1,
                    },
                    f,
                    star,
                    p.z,
                    C64::ZERO,
                    C64::ZERO,
                    p.ratio,
                    p.shift,
                );
            }
            let kv1 = tr.windings[0].rated_kv;
            let y = C64::new(tr.g, tr.b).scale(kv1 * kv1 / sb);
            if y != C64::ZERO {
                star_shunts.push((star, y));
            }
        }
        let mut machines = Vec::new();
        for (k, g) in model.generators.iter().enumerate() {
            let Some(b) = topo.bus_of(g.node) else {
                continue;
            };
            if !on(Class::Generator, k) {
                continue;
            }
            let promoted = topo.promoted.contains(&(k as u32));
            let mode = match g.control {
                _ if promoted => MachineMode::Reference,
                MachineControl::Reference => MachineMode::Reference,
                MachineControl::Pv => MachineMode::Pv,
                MachineControl::Pq => MachineMode::Pq,
            };
            if g.regulated_node.is_some_and(|r| r != g.node) && mode == MachineMode::Pv {
                warnings.push(format!(
                    "{} regulates a remote node; this version holds its own terminal voltage instead.",
                    model.name_of(Class::Generator, k)
                ));
            }
            net.machines.push(PuMachine {
                id: machines.len(),
                bus: b,
                mode,
                p: g.p / sb,
                q: g.q / sb,
                v_set: g.v_set,
                angle: g.angle / DEG,
                q_min: g.q_min / sb,
                q_max: g.q_max / sb,
            });
            machines.push(k as u32);
        }
        let mut grids = Vec::new();
        for (k, g) in model.external_grids.iter().enumerate() {
            let Some(b) = topo.bus_of(g.node) else {
                continue;
            };
            if !on(Class::ExternalGrid, k) {
                continue;
            }
            net.grids.push(PuGrid {
                id: grids.len(),
                bus: b,
                v_set: g.v_set,
                angle: g.angle / DEG,
            });
            grids.push(k as u32);
        }
        let mut loads = Vec::new();
        let mut voltage_dependent = 0;
        for (k, l) in model.loads.iter().enumerate() {
            let Some(b) = topo.bus_of(l.node) else {
                continue;
            };
            if !on(Class::Load, k) {
                continue;
            }
            if l.p_zip[2] != 1.0 || l.q_zip[2] != 1.0 {
                voltage_dependent += 1;
            }
            net.loads.push(PuLoad {
                id: loads.len(),
                bus: b,
                p: l.p * opt.load_scale / sb,
                q: l.q * opt.load_scale / sb,
            });
            loads.push(k as u32);
        }
        if voltage_dependent > 0 {
            warnings.push(format!(
                "{voltage_dependent} load(s) have voltage-dependent characteristics; this version treats every load as constant power."
            ));
        }
        let mut shunts = Vec::new();
        for (k, s) in model.shunts.iter().enumerate() {
            let Some(b) = topo.bus_of(s.node) else {
                continue;
            };
            if !on(Class::Shunt, k) {
                continue;
            }
            let kv = net.buses[b].base_kv;
            let y = C64::new(s.g_per_section, s.b_per_section).scale(f64::from(s.sections) * kv * kv / sb);
            net.shunts.push(PuShunt {
                id: shunts.len(),
                bus: b,
                y,
            });
            shunts.push(k as u32);
        }
        // Star-point magnetising admittances follow the model's shunts, so `shunts` stays aligned with `net.shunts`.
        for (bus, y) in star_shunts {
            net.shunts.push(PuShunt { id: usize::MAX, bus, y });
        }
        let svcs = (0..model.svcs.len()).filter(|&k| on(Class::Svc, k)).count();
        if svcs > 0 {
            warnings.push(format!(
                "{svcs} static var compensator(s) are not yet part of the load flow and were left out."
            ));
        }
        Calc {
            net,
            topo,
            branches,
            machines,
            grids,
            loads,
            shunts,
            warnings,
        }
    }

    /// The identifier a calculation bus is reported under: its first node's, or `<transformer>.star` for a
    /// three-winding transformer's star point.
    pub fn bus_id(&self, model: &Model, b: usize) -> String {
        let bus = &self.topo.buses[b];
        match (bus.nodes.first(), bus.star_of) {
            (Some(&n), _) => model.nodes[n as usize].id.clone(),
            (None, Some(t)) => format!("{}.star", model.transformers3[t as usize].id),
            _ => String::new(),
        }
    }

    /// Sets warm-start voltages from per-node values (magnitude p.u., angle radians), taking each bus's first node
    /// that has one.
    pub fn set_start(&mut self, node_v: &[Option<(f64, f64)>]) {
        for (i, b) in self.topo.buses.iter().enumerate() {
            if let Some((vm, va)) = b.nodes.iter().find_map(|&n| node_v.get(n as usize).copied().flatten()) {
                self.net.buses[i].vm0 = vm;
                self.net.buses[i].va0 = va;
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn push_branch(
    net: &mut PuNetwork,
    sources: &mut Vec<BranchSource>,
    src: BranchSource,
    f: usize,
    t: usize,
    z: C64,
    y_from: C64,
    y_to: C64,
    ratio: f64,
    shift: f64,
) {
    let (yff, yft, ytf, ytt) = two_port(z, y_from, y_to, ratio, shift);
    net.branches.push(PuBranch {
        id: sources.len(),
        f,
        t,
        yff,
        yft,
        ytf,
        ytt,
        shift,
    });
    sources.push(src);
}

/// Converts winding `w` (0-based) of a three-winding transformer to a branch from its node (base `vk` kV) to the
/// star point (base: winding 1's rated voltage).
pub fn transformer3_winding_pu(t: &Transformer3, w: usize, vk: f64, base_mva: f64) -> TransformerPu {
    let wd = &t.windings[w];
    let k1 = t.windings[0].rated_kv;
    // Ω at winding w → p.u. on the star base (k1).
    let z = C64::new(wd.r, wd.x).scale(base_mva / (wd.rated_kv * wd.rated_kv));
    let tap = match t.ratio_tap {
        Some(tap) if usize::from(tap.end) == w + 1 => {
            1.0 + f64::from(tap.position - tap.neutral) * tap.step_pct / 100.0
        }
        _ => 1.0,
    };
    let ratio = (wd.rated_kv * tap / k1) / (vk / k1);
    // The star point is in winding 1's frame; winding w lags winding 1 by its clock, so the star lags winding w by
    // the opposite angle.
    let shift = -f64::from(wd.clock % 12) * 30.0 / DEG;
    TransformerPu {
        z,
        y_from: C64::ZERO,
        y_to: C64::ZERO,
        ratio,
        shift,
    }
}
