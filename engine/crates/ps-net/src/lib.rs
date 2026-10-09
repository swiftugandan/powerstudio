//! The per-unit calculation network.
//!
//! Per-unit bases are the model's base power and each calculation bus's base voltage (the nominal voltage of its
//! nodes). Every branch becomes a two-port in the MATPOWER convention: an ideal transformer `t = ratio·e^{jθ}` at the
//! from end, the series impedance on the to side, and shunt admittances at each end (the from one behind the ideal
//! transformer). Load flow, short circuit and stability all assemble their matrices from these conversions, so the
//! per-unit system is defined once, here. docs/ENGINE.md derives each model.

use ps_lf::{
    MachineMode, PuBranch, PuBus, PuGrid, PuLoad, PuMachine, PuNetwork, PuShunt, PuShuntControl, PuTapBranch, TapAxis,
    TapTarget, TwoPort, UnitKind,
};
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
    let mut ratio_factors = Vec::with_capacity(t.ratio_taps.len());
    for tap in &t.ratio_taps {
        if tap.table.is_empty() {
            ratio_factors.push((
                tap.end,
                1.0 + f64::from(tap.position - tap.neutral) * tap.step_pct / 100.0,
            ));
        } else if let Some(p) = tap.table.iter().find(|p| p.position == tap.position) {
            ratio_factors.push((tap.end, p.ratio));
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
    for (end, f) in ratio_factors {
        scale(end, f);
    }
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
    /// The tap changer behind each [`TapAxis::id`] of the network's tap branches.
    pub tap_sources: Vec<TapSource>,
    /// Shunt row of each network shunt control.
    pub shunt_controls: Vec<u32>,
    /// What the build simplified or skipped, in plain words.
    pub warnings: Vec<String>,
}

/// A tap changer the load flow may move.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TapSource {
    /// Class of the transformer (two- or three-winding).
    pub class: Class,
    /// Row of the transformer.
    pub row: u32,
    /// Winding the tap changer sits on (1–3).
    pub end: u8,
    /// Whether it is a phase tap changer.
    pub phase: bool,
}

/// The largest table of positions built for one branch; a pair of tap changers beyond it keeps its positions.
const MAX_TAP_TABLE: usize = 10_000;

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
        let mut grid_bus = vec![false; net.buses.len()];
        for (k, g) in model.external_grids.iter().enumerate() {
            if let Some(b) = topo.bus_of(g.node).filter(|_| on(Class::ExternalGrid, k)) {
                grid_bus[b] = true;
            }
        }
        // The bus each machine's voltage control acts on. Every voltage-controlling machine of a bus regulates the
        // bus the first one names; a control that cannot act (its bus is not energised, or an external grid holds
        // it) falls back to the machine's own terminal.
        let mut bus_reg: Vec<Option<usize>> = vec![None; net.buses.len()];
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
            let mut reg = b;
            if mode != MachineMode::Pq {
                let wanted = g.regulated_node.map(|r| topo.bus_of(r));
                match wanted {
                    Some(None) => warnings.push(format!(
                        "{} regulates a node that is not energised; it holds its own terminal voltage.",
                        model.name_of(Class::Generator, k)
                    )),
                    Some(Some(r)) if r != b && grid_bus[r] => warnings.push(format!(
                        "{} regulates a busbar an external grid holds; it holds its own terminal voltage.",
                        model.name_of(Class::Generator, k)
                    )),
                    Some(Some(r)) => reg = r,
                    None => {}
                }
                match bus_reg[b] {
                    Some(first) if first != reg => {
                        warnings.push(format!(
                            "{} regulates another busbar than the machines it shares a busbar with; it follows them.",
                            model.name_of(Class::Generator, k)
                        ));
                        reg = first;
                    }
                    _ => bus_reg[b] = Some(reg),
                }
            }
            net.machines.push(PuMachine {
                id: machines.len(),
                bus: b,
                mode,
                p: g.p / sb,
                q: g.q / sb,
                v_set: g.v_set,
                reg_bus: reg,
                angle: g.angle / DEG,
                q_min: g.q_min / sb,
                q_max: g.q_max / sb,
                p_min: g.p_min / sb,
                p_max: g.p_max / sb,
                participates: true,
                factor: g.participation,
                kind: UnitKind::Generator,
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
        for (k, l) in model.loads.iter().enumerate() {
            let Some(b) = topo.bus_of(l.node) else {
                continue;
            };
            if !on(Class::Load, k) {
                continue;
            }
            net.loads.push(PuLoad {
                id: loads.len(),
                bus: b,
                p: l.p * opt.load_scale / sb,
                q: l.q * opt.load_scale / sb,
                p_zip: l.p_zip,
                q_zip: l.q_zip,
            });
            loads.push(k as u32);
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
        // Static var compensators: a regulating one holds its voltage like a machine without active power, within
        // reactive limits its susceptance range sets (stated at 1 p.u.; the load flow scales them with the voltage
        // squared); otherwise it injects its present reactive power.
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
                reg_bus: b,
                angle: 0.0,
                q_min: c.b_min * kv * kv / sb,
                q_max: c.b_max * kv * kv / sb,
                p_min: 0.0,
                p_max: 0.0,
                participates: false,
                factor: 0.0,
                kind: UnitKind::Svc,
            });
            svcs.push(k as u32);
        }
        let tap_sources = regulating_taps(model, &topo, &mut net, &branches, &mut warnings);
        let shunt_controls = regulating_shunts(model, &topo, &mut net, &shunts, &mut warnings);
        let mut calc = Calc {
            net,
            topo,
            branches,
            machines,
            svcs,
            grids,
            loads,
            shunts,
            tap_sources,
            shunt_controls,
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

    /// Starting voltages of buses no node stands for (transformer star points, open branch ends). Stored solutions
    /// carry no voltage for them, and a flat 1 p.u. at 0° next to a winding of almost no impedance would start Newton
    /// far off. Nothing is injected there, so the voltage that balances the currents of their branches is exact
    /// whenever the neighbours' starting voltages are: a restart from a solved state needs no iteration.
    fn start_internal_buses(&mut self) {
        let net = &mut self.net;
        for (i, b) in self.topo.buses.iter().enumerate() {
            if !b.nodes.is_empty() {
                continue;
            }
            // Nothing is injected at a star point or an open branch end, so its voltage follows from its neighbours':
            // the currents its branches carry into it sum to zero (V_i = −Σ y_ij·V_j / Σ y_ii).
            let (mut num, mut den) = (C64::ZERO, C64::ZERO);
            for br in net.branches.iter().filter(|br| (br.f == i) != (br.t == i)) {
                let (other, y_self, y_other) = if br.t == i {
                    (br.f, br.ytt, br.ytf)
                } else {
                    (br.t, br.yff, br.yft)
                };
                let o = &net.buses[other];
                num += y_other * C64::from_polar(o.vm0, o.va0);
                den += y_self;
            }
            let v = -(num / den);
            if den.abs() > 1e-12 && v.abs().is_finite() && v.abs() > 0.0 {
                net.buses[i].vm0 = v.abs();
                net.buses[i].va0 = v.im.atan2(v.re);
                continue;
            }
            // Without a usable sum, the voltage behind the strongest branch.
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

/// A voltage target in per unit of its bus, with its dead band (full width; 0.1 kV when none is given), or why it
/// cannot act.
fn voltage_target(
    topo: &Topology,
    net: &PuNetwork,
    c: &ps_model::VoltageControl,
) -> Result<(usize, f64, f64), &'static str> {
    let bus = topo.bus_of(c.node).ok_or("regulates a node that is not energised")?;
    let kv = net.buses[bus].base_kv;
    let target = c.target_kv / kv;
    // OpenLoadFlow's plausibility check: above 20 kV a target outside 0.8–1.2 p.u. is a data error.
    if target.is_nan() || target <= 0.0 || (kv > 20.0 && !(0.8..=1.2).contains(&target)) {
        return Err("has an implausible voltage target");
    }
    let band = if c.deadband_kv > 0.0 { c.deadband_kv } else { 0.1 };
    Ok((bus, target, band / kv))
}

/// Two-port of a converted transformer.
fn two_port_of(p: &TransformerPu) -> TwoPort {
    let (yff, yft, ytf, ytt) = two_port(p.z, p.y_from, p.y_to, p.ratio, p.shift);
    TwoPort {
        yff,
        yft,
        ytf,
        ytt,
        shift: p.shift,
        ratio: p.ratio,
    }
}

/// Every combination of axis positions, the first axis varying slowest.
fn combinations(counts: &[usize]) -> Vec<Vec<usize>> {
    let mut out = vec![Vec::new()];
    for &c in counts {
        out = out
            .into_iter()
            .flat_map(|prefix| {
                (0..c).map(move |i| {
                    let mut v = prefix.clone();
                    v.push(i);
                    v
                })
            })
            .collect();
    }
    out
}

/// The tap changers with an active control, as tap branches with the two-port at every position. Only regulating
/// changers get tables (as OpenLoadFlow builds per-position models only for them); the others stay where they are.
fn regulating_taps(
    model: &Model,
    topo: &Topology,
    net: &mut PuNetwork,
    branches: &[BranchSource],
    warnings: &mut Vec<String>,
) -> Vec<TapSource> {
    let sb = model.meta.base_mva;
    let mut sources = Vec::new();
    let branch_of = |class: Class, row: usize, winding: u8| {
        branches
            .iter()
            .position(|b| b.class == class && b.row as usize == row && b.winding == winding)
    };
    // One axis of a tap branch: which changer, its range, its present index and target.
    struct Axis {
        ratio: Option<usize>,
        low: i32,
        count: usize,
        index: usize,
        target: TapTarget,
        source: TapSource,
    }
    let axis = |low: i32, high: i32, position: i32| {
        let count = usize::try_from(high - low + 1).unwrap_or(0);
        let index = usize::try_from(position - low).ok().filter(|&i| i < count);
        (count, index)
    };
    for (k, tr) in model.transformers2.iter().enumerate() {
        let Some(bi) = branch_of(Class::Transformer2, k, 0) else {
            continue;
        };
        let name = model.name_of(Class::Transformer2, k);
        let mut axes: Vec<Axis> = Vec::new();
        for (i, tap) in tr.ratio_taps.iter().enumerate() {
            let Some(c) = tap.control.filter(|c| c.enabled) else {
                continue;
            };
            match (voltage_target(topo, net, &c), axis(tap.low, tap.high, tap.position)) {
                (Ok((bus, target, deadband)), (count, Some(index))) if count > 1 => axes.push(Axis {
                    ratio: Some(i),
                    low: tap.low,
                    count,
                    index,
                    target: TapTarget::Voltage { bus, target, deadband },
                    source: TapSource {
                        class: Class::Transformer2,
                        row: k as u32,
                        end: tap.end,
                        phase: false,
                    },
                }),
                (Err(why), _) => warnings.push(format!("The tap changer of {name} {why}; it keeps its position.")),
                _ => {}
            }
        }
        if let Some(tap) = &tr.phase_tap
            && let Some(c) = tap.control.filter(|c| c.enabled)
            && let (count, Some(index)) = axis(tap.low, tap.high, tap.position)
            && count > 1
        {
            axes.push(Axis {
                ratio: None,
                low: tap.low,
                count,
                index,
                target: TapTarget::Flow {
                    target: c.target_mw / sb,
                    deadband: c.deadband_mw.max(0.0) / sb,
                },
                source: TapSource {
                    class: Class::Transformer2,
                    row: k as u32,
                    end: tap.end,
                    phase: true,
                },
            });
        }
        if axes.is_empty() {
            continue;
        }
        let counts: Vec<usize> = axes.iter().map(|a| a.count).collect();
        if counts.iter().product::<usize>() > MAX_TAP_TABLE {
            warnings.push(format!(
                "{name} has too many tap combinations to regulate; it keeps its positions."
            ));
            continue;
        }
        let (vf, vt) = (
            net.buses[net.branches[bi].f].base_kv,
            net.buses[net.branches[bi].t].base_kv,
        );
        let table = combinations(&counts)
            .into_iter()
            .map(|idx| {
                let mut t = tr.clone();
                for (a, &i) in axes.iter().zip(&idx) {
                    let position = a.low + i as i32;
                    match a.ratio {
                        Some(r) => t.ratio_taps[r].position = position,
                        None => {
                            if let Some(p) = &mut t.phase_tap {
                                p.position = position;
                            }
                        }
                    }
                }
                two_port_of(&transformer2_pu(&t, vf, vt, sb, TransformerOptions::default()))
            })
            .collect();
        push_tap_branch(
            net,
            &mut sources,
            bi,
            axes.into_iter().map(|a| (a.low, a.count, a.index, a.target, a.source)),
            table,
        );
    }
    for (k, tr) in model.transformers3.iter().enumerate() {
        let name = model.name_of(Class::Transformer3, k);
        for w in 0..3usize {
            let end = w as u8 + 1;
            let Some(bi) = branch_of(Class::Transformer3, k, end) else {
                continue;
            };
            let mut axes: Vec<Axis> = Vec::new();
            for (i, tap) in tr.ratio_taps.iter().enumerate().filter(|(_, t)| t.end == end) {
                let Some(c) = tap.control.filter(|c| c.enabled) else {
                    continue;
                };
                match (voltage_target(topo, net, &c), axis(tap.low, tap.high, tap.position)) {
                    (Ok((bus, target, deadband)), (count, Some(index))) if count > 1 => axes.push(Axis {
                        ratio: Some(i),
                        low: tap.low,
                        count,
                        index,
                        target: TapTarget::Voltage { bus, target, deadband },
                        source: TapSource {
                            class: Class::Transformer3,
                            row: k as u32,
                            end,
                            phase: false,
                        },
                    }),
                    (Err(why), _) => {
                        warnings.push(format!("The tap changer of {name} {why}; it keeps its position."));
                    }
                    _ => {}
                }
            }
            for (i, tap) in tr.phase_taps.iter().enumerate().filter(|(_, t)| t.end == end) {
                let Some(c) = tap.control.filter(|c| c.enabled) else {
                    continue;
                };
                let (count, Some(index)) = axis(tap.low, tap.high, tap.position) else {
                    continue;
                };
                if count > 1 {
                    axes.push(Axis {
                        // A phase changer of a winding is addressed by its index among the phase changers.
                        ratio: None,
                        low: tap.low,
                        count,
                        index,
                        target: TapTarget::Flow {
                            target: c.target_mw / sb,
                            deadband: c.deadband_mw.max(0.0) / sb,
                        },
                        source: TapSource {
                            class: Class::Transformer3,
                            row: k as u32,
                            end: i as u8 + 1,
                            phase: true,
                        },
                    });
                }
            }
            if axes.is_empty() {
                continue;
            }
            let counts: Vec<usize> = axes.iter().map(|a| a.count).collect();
            if counts.iter().product::<usize>() > MAX_TAP_TABLE {
                warnings.push(format!(
                    "{name} has too many tap combinations to regulate; it keeps its positions."
                ));
                continue;
            }
            let vk = net.buses[net.branches[bi].f].base_kv;
            let table = combinations(&counts)
                .into_iter()
                .map(|idx| {
                    let mut t = tr.clone();
                    for (a, &j) in axes.iter().zip(&idx) {
                        let position = a.low + j as i32;
                        match a.ratio {
                            Some(r) => t.ratio_taps[r].position = position,
                            None => t.phase_taps[usize::from(a.source.end) - 1].position = position,
                        }
                    }
                    let mut p = transformer3_winding_pu(&t, w, vk, sb);
                    p.y_to = C64::ZERO;
                    two_port_of(&p)
                })
                .collect();
            push_tap_branch(
                net,
                &mut sources,
                bi,
                axes.into_iter().map(|a| {
                    // Report the winding the changer sits on.
                    let source = TapSource { end, ..a.source };
                    (a.low, a.count, a.index, a.target, source)
                }),
                table,
            );
        }
    }
    sources
}

fn push_tap_branch(
    net: &mut PuNetwork,
    sources: &mut Vec<TapSource>,
    branch: usize,
    axes: impl Iterator<Item = (i32, usize, usize, TapTarget, TapSource)>,
    table: Vec<TwoPort>,
) {
    let axes = axes
        .map(|(low, count, index, target, source)| {
            sources.push(source);
            TapAxis {
                id: sources.len() - 1,
                low,
                count,
                index,
                phase: source.phase,
                target: Some(target),
            }
        })
        .collect();
    net.taps.push(PuTapBranch { branch, axes, table });
}

/// The shunts with an active voltage control, with their admittance at every number of sections.
fn regulating_shunts(
    model: &Model,
    topo: &Topology,
    net: &mut PuNetwork,
    shunts: &[u32],
    warnings: &mut Vec<String>,
) -> Vec<u32> {
    let sb = model.meta.base_mva;
    let mut rows = Vec::new();
    for (ni, &row) in shunts.iter().enumerate() {
        let s = &model.shunts[row as usize];
        let Some(c) = s.control.filter(|c| c.enabled) else {
            continue;
        };
        let (bus, target, deadband) = match voltage_target(topo, net, &c) {
            Ok(x) => x,
            Err(why) => {
                warnings.push(format!(
                    "{} {why}; it keeps its sections.",
                    model.name_of(Class::Shunt, row as usize)
                ));
                continue;
            }
        };
        let kv = net.buses[net.shunts[ni].bus].base_kv;
        let max = if s.points.is_empty() {
            s.max_sections
        } else {
            s.points.len() as u32
        };
        let steps = (0..=max)
            .map(|k| {
                let mut x = s.clone();
                x.sections = k;
                shunt_admittance(&x).scale(kv * kv / sb)
            })
            .collect();
        let index = (s.sections.min(max)) as usize;
        net.shunt_controls.push(PuShuntControl {
            id: rows.len(),
            shunt: ni,
            steps,
            index,
            bus,
            target,
            deadband,
        });
        rows.push(row);
    }
    rows
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
    let (tap, r_scale, x_scale) = match t.ratio_taps.iter().find(|tap| usize::from(tap.end) == w + 1) {
        Some(tap) if tap.table.is_empty() => (
            1.0 + f64::from(tap.position - tap.neutral) * tap.step_pct / 100.0,
            1.0,
            1.0,
        ),
        Some(tap) => match point(tap) {
            Some(p) => (p.ratio, 1.0 + p.r_pct / 100.0, 1.0 + p.x_pct / 100.0),
            None => (1.0, 1.0, 1.0),
        },
        _ => (1.0, 1.0, 1.0),
    };
    // A phase tap changer: its angle (the star lags the winding for positive values) and the table's corrections.
    let (angle, phase_ratio, pr_scale, px_scale) = match t.phase_taps.iter().find(|tap| usize::from(tap.end) == w + 1) {
        Some(tap) if tap.table.is_empty() => (f64::from(tap.position - tap.neutral) * tap.step_deg, 1.0, 1.0, 1.0),
        Some(tap) => tap
            .table
            .iter()
            .find(|p| p.position == tap.position)
            .map_or((0.0, 1.0, 1.0, 1.0), |p| {
                (p.angle_deg, p.ratio, 1.0 + p.r_pct / 100.0, 1.0 + p.x_pct / 100.0)
            }),
        None => (0.0, 1.0, 1.0, 1.0),
    };
    let z =
        C64::new(wd.r * r_scale * pr_scale, wd.x * x_scale * px_scale).scale(base_mva / (wd.rated_kv * wd.rated_kv));
    let ratio = (wd.rated_kv * tap * phase_ratio / k1) / (vk / k1);
    // The star point is in winding 1's frame; winding w lags winding 1 by its clock, so the star lags winding w by
    // the opposite angle.
    let shift = (angle - f64::from(wd.clock % 12) * 30.0 - wd.phase_shift_deg) / DEG;
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
