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

/// A line between buses of base `vf` and `vt` kV, in the same form as a transformer: impedance and shunts on the
/// to-side base, and the ratio vt/vf that keeps the voltage continuous in kV when the two bases differ (a line from
/// a 225 kV busbar to a 220 kV boundary point). With equal bases the ratio is 1. The zero sequence splits its
/// charging equally.
pub fn line_pu(l: &Line, vf: f64, vt: f64, base_mva: f64, seq: Seq) -> TransformerPu {
    let zb = vt * vt / base_mva;
    let (z, y_from, y_to) = match seq {
        Seq::Positive => (
            C64::new(l.r / zb, l.x / zb),
            C64::new(l.g1 * zb, l.b1 * zb),
            C64::new(l.g2 * zb, l.b2 * zb),
        ),
        Seq::Zero => {
            let half = C64::new(0.0, l.b0 * zb / 2.0);
            (C64::new(l.r0 / zb, l.x0 / zb), half, half)
        }
    };
    TransformerPu {
        z,
        y_from,
        y_to,
        ratio: vt / vf,
        shift: 0.0,
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

/// What a transformer's tap changers do at their present positions.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TapEffect {
    /// Voltage factor of winding 1 (1 at rated voltage).
    pub f1: f64,
    /// Voltage factor of winding 2.
    pub f2: f64,
    /// Phase shift, degrees (winding 2 lagging).
    pub angle_deg: f64,
    /// Multiplier of the series resistance.
    pub r_scale: f64,
    /// Multiplier of the series reactance.
    pub x_scale: f64,
    /// Multiplier of the magnetising conductance.
    pub g_scale: f64,
    /// Multiplier of the magnetising susceptance.
    pub b_scale: f64,
}

/// The combined effect of a two-winding transformer's ratio and phase tap changers.
///
/// The series impedance sits between the two windings' tap changers (the convention of PowSyBl's CGMES conversion,
/// and of MATPOWER and pandapower, which only tap winding 1). A changer on winding 1 therefore changes only the ratio;
/// one on winding 2 also refers the impedance across itself, scaling it by f² and the winding-1 magnetising
/// admittance by 1/f². A stepped ratio changer scales its winding by 1 + (position − neutral)·step; a stepped phase
/// changer shifts by (position − neutral)·step. Tables give ratio, angle and impedance corrections per position, and
/// the corrections of both changers multiply. A position missing from its table leaves that changer neutral
/// (validation reports it).
pub fn tap_effect(t: &Transformer2) -> TapEffect {
    let mut e = TapEffect {
        f1: 1.0,
        f2: 1.0,
        angle_deg: 0.0,
        r_scale: 1.0,
        x_scale: 1.0,
        g_scale: 1.0,
        b_scale: 1.0,
    };
    let mut correct = |p: &ps_model::TapPoint| {
        e.r_scale *= 1.0 + p.r_pct / 100.0;
        e.x_scale *= 1.0 + p.x_pct / 100.0;
        e.g_scale *= 1.0 + p.g_pct / 100.0;
        e.b_scale *= 1.0 + p.b_pct / 100.0;
    };
    let mut factor = 1.0;
    let mut ratio_end = 1;
    if let Some(tap) = &t.ratio_tap {
        ratio_end = tap.end;
        if tap.table.is_empty() {
            factor = 1.0 + f64::from(tap.position - tap.neutral) * tap.step_pct / 100.0;
        } else if let Some(p) = tap.table.iter().find(|p| p.position == tap.position) {
            factor = p.ratio;
            correct(p);
        }
    }
    let (mut phase_factor, mut angle, mut phase_end) = (1.0, 0.0, 1);
    if let Some(tap) = &t.phase_tap {
        phase_end = tap.end;
        if tap.table.is_empty() {
            angle = f64::from(tap.position - tap.neutral) * tap.step_deg;
        } else if let Some(p) = tap.table.iter().find(|p| p.position == tap.position) {
            angle = p.angle_deg;
            phase_factor = p.ratio;
            correct(p);
        }
    }
    let mut scale = |end: u8, f: f64| if end == 2 { e.f2 *= f } else { e.f1 *= f };
    scale(ratio_end, factor);
    scale(phase_end, phase_factor);
    // A positive angle makes the other winding lag the tap changer's; the model's sense is winding 2 lagging.
    e.angle_deg = if phase_end == 2 { -angle } else { angle };
    let f2 = e.f2 * e.f2;
    e.r_scale *= f2;
    e.x_scale *= f2;
    e.g_scale /= f2;
    e.b_scale /= f2;
    e
}

/// The voltage factor the tap changers give winding `end` (1 or 2).
pub fn tap_factor(t: &Transformer2, end: u8) -> f64 {
    let e = tap_effect(t);
    if end == 2 { e.f2 } else { e.f1 }
}

/// Phase shift of a two-winding transformer without its tap changers, degrees: vector group and fixed shift.
pub fn fixed_shift_deg(t: &Transformer2) -> f64 {
    f64::from(t.clock % 12) * 30.0 + t.phase_shift_deg
}

/// Converts a two-winding transformer between buses of base `vh` (winding 1) and `vl` (winding 2) kV. The series
/// impedance is referred to winding 2 by the rated ratio (taps change it only through table corrections), and the
/// taps act through the ideal transformer.
pub fn transformer2_pu(t: &Transformer2, vh: f64, vl: f64, base_mva: f64, opt: TransformerOptions) -> TransformerPu {
    let (k1, k2) = (t.rated_kv1, t.rated_kv2);
    let tap = if opt.taps {
        tap_effect(t)
    } else {
        TapEffect {
            f1: 1.0,
            f2: 1.0,
            angle_deg: 0.0,
            r_scale: 1.0,
            x_scale: 1.0,
            g_scale: 1.0,
            b_scale: 1.0,
        }
    };
    // Ω at winding 1 → p.u. on the winding-2 bus base.
    let z_scale = (k2 / k1).powi(2) * base_mva / (vl * vl);
    let (r, x) = match opt.seq {
        Seq::Positive => (t.r * tap.r_scale, t.x * tap.x_scale),
        Seq::Zero => (t.r0, t.x0),
    };
    let z = C64::new(r, x).scale(z_scale * opt.correction);
    // S referred to winding 1 → p.u. on the winding-2 bus base.
    let y_scale = (k1 / k2).powi(2) * vl * vl / base_mva;
    let (y_from, y_to) = match opt.seq {
        Seq::Positive => (
            C64::new(t.g1 * tap.g_scale, t.b1 * tap.b_scale).scale(y_scale),
            C64::new(t.g2, t.b2).scale(y_scale),
        ),
        Seq::Zero => (C64::ZERO, C64::ZERO),
    };
    let ratio = (k1 * tap.f1 / (k2 * tap.f2)) / (vh / vl);
    TransformerPu {
        z,
        y_from,
        y_to,
        ratio,
        shift: (fixed_shift_deg(t) + tap.angle_deg) / DEG,
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

/// Admittance of a shunt's sections in service, S at its nominal voltage: the per-section value times the sections,
/// or for a non-linear bank the sum of its first sections.
pub fn shunt_admittance(s: &ps_model::Shunt) -> C64 {
    if s.points.is_empty() {
        C64::new(s.g_per_section, s.b_per_section).scale(f64::from(s.sections))
    } else {
        s.points
            .iter()
            .take(s.sections as usize)
            .fold(C64::ZERO, |acc, &(g, b)| acc + C64::new(g, b))
    }
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
    /// Generator row of each of the first `machines.len()` network machines; static var compensators follow.
    pub machines: Vec<u32>,
    /// Static var compensator row of each network machine after the generators.
    pub svcs: Vec<u32>,
    /// External grid row of each grid.
    pub grids: Vec<u32>,
    /// Load row of each load.
    pub loads: Vec<u32>,
    /// Shunt row of each network shunt.
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
            let ends = (
                topo.end_bus(Class::Line, k, 1, l.node1, l.open[0]),
                topo.end_bus(Class::Line, k, 2, l.node2, l.open[1]),
            );
            let (Some(f), Some(t)) = ends else { continue };
            if !on(Class::Line, k) {
                continue;
            }
            let p = line_pu(l, net.buses[f].base_kv, net.buses[t].base_kv, sb, Seq::Positive);
            let src = BranchSource {
                class: Class::Line,
                row: k as u32,
                winding: 0,
            };
            push_branch(&mut net, &mut branches, src, f, t, p.z, p.y_from, p.y_to, p.ratio, 0.0);
        }
        for (k, tr) in model.transformers2.iter().enumerate() {
            let ends = (
                topo.end_bus(Class::Transformer2, k, 1, tr.node1, tr.open[0]),
                topo.end_bus(Class::Transformer2, k, 2, tr.node2, tr.open[1]),
            );
            let (Some(f), Some(t)) = ends else { continue };
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
            let src = BranchSource {
                class: Class::Transformer2,
                row: k as u32,
                winding: 0,
            };
            push_branch(
                &mut net,
                &mut branches,
                src,
                f,
                t,
                p.z,
                p.y_from,
                p.y_to,
                p.ratio,
                p.shift,
            );
        }
        for (k, tr) in model.transformers3.iter().enumerate() {
            let Some(star) = topo.star_bus[k].map(|s| s as usize) else {
                continue;
            };
            for (w, wd) in tr.windings.iter().enumerate().filter(|(_, wd)| !wd.open) {
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
                    p.y_from,
                    C64::ZERO,
                    p.ratio,
                    p.shift,
                );
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
            let y = shunt_admittance(s).scale(kv * kv / sb);
            net.shunts.push(PuShunt {
                id: shunts.len(),
                bus: b,
                y,
            });
            shunts.push(k as u32);
        }
        // Static var compensators: a regulating one holds its voltage like a machine without active power (its
        // susceptance range sets reactive limits at 1 p.u.); otherwise it injects its present reactive power.
        let mut svcs = Vec::new();
        for (k, c) in model.svcs.iter().enumerate() {
            let Some(b) = topo.bus_of(c.node) else { continue };
            if !on(Class::Svc, k) {
                continue;
            }
            let kv = net.buses[b].base_kv;
            let mode = if c.regulating { MachineMode::Pv } else { MachineMode::Pq };
            net.machines.push(PuMachine {
                id: machines.len() + svcs.len(),
                bus: b,
                mode,
                p: 0.0,
                q: c.q / sb,
                v_set: c.v_set,
                angle: 0.0,
                q_min: c.b_min * kv * kv / sb,
                q_max: c.b_max * kv * kv / sb,
            });
            svcs.push(k as u32);
        }
        let mut calc = Calc {
            net,
            topo,
            branches,
            machines,
            svcs,
            grids,
            loads,
            shunts,
            warnings,
        };
        calc.start_internal_buses();
        calc
    }

    /// The identifier a calculation bus is reported under: its first node's, `<transformer>.star` for a three-winding
    /// transformer's star point, or `<branch>.end1`/`.end2` for an open branch end.
    pub fn bus_id(&self, model: &Model, b: usize) -> String {
        let bus = &self.topo.buses[b];
        match (bus.nodes.first(), bus.star_of, bus.open_end_of) {
            (Some(&n), _, _) => model.nodes[n as usize].id.clone(),
            (None, Some(t), _) => format!("{}.star", model.transformers3[t as usize].id),
            (None, None, Some((class, row, end))) => {
                format!("{}.end{end}", model.id_of(class, row as usize).unwrap_or(""))
            }
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
        self.start_internal_buses();
    }

    /// Starting voltages of buses no node stands for (transformer star points, open branch ends): the voltage behind
    /// the ideal transformer of their most tightly coupled branch, seen from its other end. Stored solutions carry no
    /// voltage for them, and a flat 1 p.u. at 0° next to a winding of almost no impedance would start Newton far off.
    fn start_internal_buses(&mut self) {
        let net = &mut self.net;
        for (i, b) in self.topo.buses.iter().enumerate() {
            if !b.nodes.is_empty() {
                continue;
            }
            let best = net
                .branches
                .iter()
                .filter(|br| (br.f == i) != (br.t == i))
                .max_by(|x, y| {
                    x.yft
                        .abs()
                        .partial_cmp(&y.yft.abs())
                        .unwrap_or(std::cmp::Ordering::Equal)
                });
            let Some(br) = best else { continue };
            // yft = −ys / conj(t), so |t| and the shift follow from the two-port: t = ratio·e^{jθ}.
            let ratio = (br.ytt.abs() / br.yff.abs()).sqrt();
            let ratio = if ratio.is_finite() && ratio > 0.0 { ratio } else { 1.0 };
            let (vm, va) = if br.t == i {
                (net.buses[br.f].vm0 / ratio, net.buses[br.f].va0 - br.shift)
            } else {
                (net.buses[br.t].vm0 * ratio, net.buses[br.t].va0 + br.shift)
            };
            net.buses[i].vm0 = vm;
            net.buses[i].va0 = va;
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
    let point = |tap: &ps_model::RatioTap| tap.table.iter().find(|p| p.position == tap.position).copied();
    let (tap, r_scale, x_scale) = match &t.ratio_tap {
        Some(tap) if usize::from(tap.end) == w + 1 && tap.table.is_empty() => (
            1.0 + f64::from(tap.position - tap.neutral) * tap.step_pct / 100.0,
            1.0,
            1.0,
        ),
        Some(tap) if usize::from(tap.end) == w + 1 => match point(tap) {
            Some(p) => (p.ratio, 1.0 + p.r_pct / 100.0, 1.0 + p.x_pct / 100.0),
            None => (1.0, 1.0, 1.0),
        },
        _ => (1.0, 1.0, 1.0),
    };
    let z = C64::new(wd.r * r_scale, wd.x * x_scale).scale(base_mva / (wd.rated_kv * wd.rated_kv));
    let ratio = (wd.rated_kv * tap / k1) / (vk / k1);
    // The star point is in winding 1's frame; winding w lags winding 1 by its clock, so the star lags winding w by
    // the opposite angle.
    let shift = -f64::from(wd.clock % 12) * 30.0 / DEG;
    // The winding's magnetising admittance sits at its network side behind the ratio, on the star base.
    let y_from = C64::new(wd.g, wd.b).scale(wd.rated_kv * wd.rated_kv / base_mva);
    TransformerPu {
        z,
        y_from,
        y_to: C64::ZERO,
        ratio,
        shift,
    }
}
