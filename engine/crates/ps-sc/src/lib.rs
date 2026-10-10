//! Short-circuit currents by the method of the equivalent voltage source at the fault location, following
//! IEC 60909-0. This is an IEC 60909-style calculation, not a certified one: docs/ENGINE.md, "Short circuit", lists
//! the clauses it implements, the simplifications it makes and the references it is checked against.
//!
//! For each faulted bus k the only source is c·Un/√3 at k; machines, motors and grids become impedances, corrected
//! by the standard's factors. The Thévenin impedance Zkk is read from the solution of Y·z = e_k for the positive and,
//! for earth faults, the zero sequence network; the negative-sequence network equals the positive one. A power station
//! unit (a machine with its own transformer) meets a fault outside it with both impedances corrected by KS or KSO, and
//! a fault at the machine's terminals through a network of its own, where the machine has its terminal factor and its
//! transformer none.

pub mod factors;

use std::collections::{HashMap, HashSet};

pub use factors::{
    fictitious_resistance_ratio, generator_correction, kappa_of, mu, q_factor, three_winding_corrected,
    transformer_correction, unit_correction, voltage_factor,
};

use ps_model::study::{FaultType, KappaMethod, ScMode, ShortCircuitSettings};
use ps_model::{Class, Feeder, Line, Model, NodeRef, Transformer2, Winding};
use ps_net::{
    BuildOptions, Calc, Seq, TransformerOptions, line_pu, tap_factor, transformer2_pu, transformer3_winding_pu,
    two_port,
};
use ps_num::C64;
use ps_sparse::ComplexLu;
use ps_topology::{Outages, active};
use serde::Serialize;

const SQRT3: f64 = 1.732_050_807_568_877_2;
/// Temperature coefficient of the conductors' resistance, 1/K (IEC 60909-0, 6.4).
const ALPHA: f64 = 0.004;

/// Results at one faulted bus.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct FaultResult {
    /// Identifier of the bus's first node.
    pub id: String,
    /// Initial symmetrical short-circuit current Ik″, kA.
    pub ikss: f64,
    /// Peak current ip, kA.
    pub ip: f64,
    /// Symmetrical breaking current Ib at the minimum time delay, kA (Ik″ for an unbalanced fault).
    pub ib: f64,
    /// Thermal equivalent current Ith for the study case's duration, kA.
    pub ith: f64,
    /// Initial short-circuit power Sk″, MVA.
    pub skss: f64,
    /// Peak factor κ.
    pub kappa: f64,
    /// R/X of the positive-sequence Thévenin impedance.
    pub rx: f64,
    /// Voltage factor used.
    pub c: f64,
    /// Positive-sequence Thévenin resistance, Ω.
    pub r1: f64,
    /// Positive-sequence Thévenin reactance, Ω.
    pub x1: f64,
    /// Zero-sequence Thévenin resistance, Ω (earth faults only).
    pub r0: Option<f64>,
    /// Zero-sequence Thévenin reactance, Ω (earth faults only).
    pub x0: Option<f64>,
}

/// Fault current carried by one branch (three-phase fault at a single location).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BranchContribution {
    /// Element identifier.
    pub id: String,
    /// Current at the from end, kA.
    pub i_from: f64,
    /// Current at the to end, kA.
    pub i_to: f64,
}

/// The short-circuit report.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShortCircuitReport {
    /// Fault type.
    pub fault: FaultType,
    /// Maximum or minimum currents.
    pub mode: ScMode,
    /// Peak factor method.
    pub kappa_method: KappaMethod,
    /// Minimum time delay of the breaking currents, s.
    pub t_min: f64,
    /// Duration of the short circuit for the thermal equivalent currents, s.
    pub t_k: f64,
    /// Fault resistance in each faulted phase, Ω.
    pub fault_r: f64,
    /// Fault reactance in each faulted phase, Ω.
    pub fault_x: f64,
    /// Results per faulted bus.
    pub buses: Vec<FaultResult>,
    /// The single fault location, or empty.
    pub location: String,
    /// Branch currents for a three-phase fault at a single location.
    pub contributions: Vec<BranchContribution>,
    /// Nodes without supply.
    pub deenergized: Vec<String>,
    /// What the calculation decided or simplified.
    pub warnings: Vec<String>,
}

/// A power station unit: a machine and its transformer.
#[derive(Debug, Clone, Copy)]
struct Unit {
    machine: usize,
    trafo: usize,
    /// The machine's bus.
    bus: usize,
    factors: factors::UnitFactors,
}

/// Which network a fault is calculated on: the network as it meets faults outside every power station unit, or the
/// network for a fault at the terminals of unit `k`'s machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Variant {
    Normal,
    Terminals(usize),
}

/// A machine or motor as the breaking current sees it: its bus, its admittance in the fault network, its rated
/// current in kA at its bus, and for a motor its q factor.
struct Rotating {
    bus: usize,
    y: C64,
    rated_ka: f64,
    q: f64,
}

struct Builder<'a> {
    model: &'a Model,
    calc: &'a Calc,
    st: &'a ShortCircuitSettings,
    sb: f64,
    f: f64,
    vbase: Vec<f64>,
    c_bus: Vec<f64>,
    cmax_bus: Vec<f64>,
    max: bool,
    units: Vec<Unit>,
    /// The windings of three-winding transformers that a document carries as two-winding transformers to a star
    /// busbar, with their impedances corrected per winding pair (maximum currents only).
    star_windings: HashMap<usize, Transformer2>,
    /// The lines that hold part of such a winding's impedance, corrected with it.
    star_lines: HashMap<usize, Line>,
    /// Lines that stand for part of a transformer's impedance, which conductor temperature does not change.
    transformer_lines: HashSet<usize>,
    /// The two-winding transformers that are windings of a document's star.
    star_members: HashSet<usize>,
}

type Entries = Vec<(usize, usize, C64)>;

impl Builder<'_> {
    fn on(&self, class: Class, row: usize) -> bool {
        active(self.model, &Outages::none(), class, row)
    }

    fn unit_of_trafo(&self, k: usize) -> Option<(usize, &Unit)> {
        self.units.iter().enumerate().find(|(_, u)| u.trafo == k)
    }

    /// Line `k`, with its pair correction when it holds part of a document star's winding.
    fn line(&self, k: usize) -> &Line {
        self.star_lines.get(&k).unwrap_or(&self.model.lines[k])
    }

    /// Two-winding transformer `k`, with its pair correction when it is a winding of a document's star.
    fn trafo2(&self, k: usize) -> &Transformer2 {
        self.star_windings.get(&k).unwrap_or(&self.model.transformers2[k])
    }

    /// The correction factor of transformer `k` in a variant (a star's winding carries its own).
    fn trafo_correction(&self, k: usize, b: usize, variant: Variant) -> f64 {
        if self.star_windings.contains_key(&k) {
            return 1.0;
        }
        match self.unit_of_trafo(k) {
            Some((u, unit)) => {
                if variant == Variant::Terminals(u) {
                    1.0
                } else {
                    unit.factors.outside
                }
            }
            None if self.max => transformer_correction(&self.model.transformers2[k], self.cmax_bus[b]),
            None => 1.0,
        }
    }

    /// The machines and motors with their admittances in a variant's positive-sequence network.
    fn rotating(&self, variant: Variant, peak: bool, freq_scale: f64) -> Vec<Rotating> {
        let mut out = Vec::new();
        let (sb, vbase) = (self.sb, &self.vbase);
        for (k, g) in self.model.generators.iter().enumerate() {
            let Some(i) = self.calc.topo.bus_of(g.node) else {
                continue;
            };
            // A machine that stands for a network is a feeder, stamped with the external grids.
            if !self.on(Class::Generator, k) || g.sc.feeder.is_some() {
                continue;
            }
            let zb = vbase[i] * vbase[i] / sb;
            let zr = g.rated_kv * g.rated_kv / g.rated_mva;
            let x = g.sc.xdss * zr / zb;
            let r = if peak {
                fictitious_resistance_ratio(g) * x
            } else {
                g.sc.rs * zr / zb
            };
            let factor = match self.units.iter().enumerate().find(|(_, u)| u.machine == k) {
                Some((u, unit)) if variant == Variant::Terminals(u) => unit.factors.terminals,
                Some((_, unit)) => unit.factors.outside,
                None => generator_correction(g, vbase[i], self.cmax_bus[i]),
            };
            let z = C64::new(r * factor, x * factor * freq_scale);
            out.push(Rotating {
                bus: i,
                y: z.inv(),
                rated_ka: g.rated_mva / (SQRT3 * g.rated_kv),
                q: 1.0,
            });
        }
        // Asynchronous motors feed maximum currents only (IEC 60909-0, 6.8).
        if self.max {
            for (k, l) in self.model.loads.iter().enumerate() {
                let (Some(m), Some(i)) = (l.motor, self.calc.topo.bus_of(l.node)) else {
                    continue;
                };
                if !self.on(Class::Load, k) || m.ilr <= 0.0 || m.rated_mw <= 0.0 {
                    continue;
                }
                let s = m.rated_mva();
                let z = (1.0 / m.ilr) * m.rated_kv * m.rated_kv / s / (vbase[i] * vbase[i] / sb);
                let x = z / (1.0 + m.rx * m.rx).sqrt();
                out.push(Rotating {
                    bus: i,
                    y: C64::new(m.rx * x, x * freq_scale).inv(),
                    rated_ka: s / (SQRT3 * m.rated_kv),
                    q: q_factor(&m, self.st.t_min),
                });
            }
        }
        out
    }

    /// A sequence network as coordinate entries.
    fn assemble(&self, seq: Seq, variant: Variant, peak: bool) -> Entries {
        let fc = if self.f == 60.0 { 24.0 } else { 20.0 };
        let freq_scale = if peak { fc / self.f } else { 1.0 };
        let (sb, vbase, model, calc) = (self.sb, &self.vbase, self.model, self.calc);
        let n = calc.net.buses.len();
        let mut e: Entries = Vec::new();
        let sx = |z: C64| C64::new(z.re, z.im * freq_scale);
        let stamp = |e: &mut Entries, a: usize, b: usize, p: (C64, C64, C64, C64)| {
            e.extend([(a, a, p.0), (a, b, p.1), (b, a, p.2), (b, b, p.3)]);
        };
        // Lines: capacitances neglected in the positive sequence (IEC 60909-0, 6.4) and kept in the zero sequence;
        // for minimum currents the resistance at the conductors' end temperature, except in the lines that hold part
        // of a transformer's impedance.
        let warmed = 1.0 + ALPHA * (self.st.line_temperature - 20.0);
        for k in 0..model.lines.len() {
            let l = self.line(k);
            let warm = if self.max || self.transformer_lines.contains(&k) {
                1.0
            } else {
                warmed
            };
            let (Some(a), Some(b)) = (calc.topo.bus_of(l.node1), calc.topo.bus_of(l.node2)) else {
                continue;
            };
            if !self.on(Class::Line, k) {
                continue;
            }
            let p = line_pu(l, vbase[a], vbase[b], sb, seq);
            let keep = |y: C64| {
                if seq == Seq::Zero {
                    C64::new(0.0, y.im * freq_scale)
                } else {
                    C64::ZERO
                }
            };
            let z = C64::new(p.z.re * warm, p.z.im);
            stamp(
                &mut e,
                a,
                b,
                two_port(sx(z), keep(p.y_from), keep(p.y_to), p.ratio, 0.0),
            );
        }
        for k in 0..model.transformers2.len() {
            let t = self.trafo2(k);
            let (Some(a), Some(b)) = (calc.topo.bus_of(t.node1), calc.topo.bus_of(t.node2)) else {
                continue;
            };
            if !self.on(Class::Transformer2, k) {
                continue;
            }
            let kt = self.trafo_correction(k, b, variant);
            let opt = TransformerOptions {
                taps: true,
                correction: kt,
                seq,
            };
            let p = transformer2_pu(t, vbase[a], vbase[b], sb, opt);
            if seq == Seq::Positive {
                stamp(&mut e, a, b, two_port(sx(p.z), C64::ZERO, C64::ZERO, p.ratio, p.shift));
                continue;
            }
            // An earthed winding's neutral earthing appears three times in the zero sequence.
            let neutral = |w: usize, bus: usize| C64::new(t.rn[w], t.xn[w]).scale(3.0 * sb / (vbase[bus] * vbase[bus]));
            let earthed = |c: Winding| matches!(c, Winding::Yn | Winding::Zn);
            // A document star's winding: its own connection decides, the star side standing for the star point.
            let conn2 = if self.star_members.contains(&k) {
                Winding::Yn
            } else {
                t.conn2
            };
            match (t.conn1, conn2) {
                (Winding::D, c2) if earthed(c2) => e.push((b, b, sx(p.z + neutral(1, b)).inv())),
                (c1, c2) if earthed(c1) && earthed(c2) => stamp(
                    &mut e,
                    a,
                    b,
                    two_port(
                        sx(p.z + neutral(0, a) + neutral(1, b)),
                        C64::ZERO,
                        C64::ZERO,
                        p.ratio,
                        0.0,
                    ),
                ),
                (c1, Winding::D) if earthed(c1) => {
                    // Zero-sequence impedance seen from the earthed winding 1, on its bus's base, tap included.
                    let tf = tap_factor(t, 1);
                    let z = C64::new(t.r0, t.x0).scale(tf * tf * sb / (vbase[a] * vbase[a]) * kt);
                    e.push((a, a, sx(z + neutral(0, a)).inv()));
                }
                _ => {}
            }
        }
        // Three-winding transformers: each winding from its bus to the star point, with KT per winding pair for
        // maximum currents. In the zero sequence an earthed star winding connects its bus to the star point, a delta
        // winding earths the star point through its impedance, and an unearthed star winding is open.
        for (k, t) in model.transformers3.iter().enumerate() {
            let Some(star) = calc.topo.star_bus.get(k).copied().flatten().map(|s| s as usize) else {
                continue;
            };
            if !self.on(Class::Transformer3, k) {
                continue;
            }
            let ends: Vec<Option<usize>> = t.windings.iter().map(|w| calc.topo.bus_of(w.node)).collect();
            let corrected = if self.max {
                let cmax = ends
                    .iter()
                    .flatten()
                    .map(|&b| self.cmax_bus[b])
                    .fold(f64::NEG_INFINITY, f64::max);
                three_winding_corrected(t, if cmax.is_finite() { cmax } else { 1.1 })
            } else {
                t.clone()
            };
            // The zero sequence through each winding's own R0, X0 (the positive values where none are given).
            let mut zero = corrected.clone();
            for w in &mut zero.windings {
                (w.r, w.x) = w.zero_sequence();
            }
            for (w, end) in ends.iter().enumerate() {
                let Some(a) = *end else { continue };
                if t.windings[w].open {
                    continue;
                }
                match seq {
                    Seq::Positive => {
                        let p = transformer3_winding_pu(&corrected, w, vbase[a], sb);
                        stamp(
                            &mut e,
                            a,
                            star,
                            two_port(sx(p.z), C64::ZERO, C64::ZERO, p.ratio, p.shift),
                        )
                    }
                    Seq::Zero => {
                        let p = transformer3_winding_pu(&zero, w, vbase[a], sb);
                        let wd = &t.windings[w];
                        let neutral = C64::new(wd.rn, wd.xn).scale(3.0 * sb / (vbase[a] * vbase[a]));
                        match wd.conn {
                            Winding::Yn | Winding::Zn => stamp(
                                &mut e,
                                a,
                                star,
                                two_port(sx(p.z + neutral), C64::ZERO, C64::ZERO, p.ratio, 0.0),
                            ),
                            Winding::D => e.push((star, star, sx(p.z).inv())),
                            _ => {}
                        }
                    }
                }
            }
        }
        // Network feeders: external grids, and machines that stand for a network (IEC 60909-0, 6.2).
        let grids = model.external_grids.iter().enumerate().filter_map(|(k, g)| {
            let feeder = Feeder {
                sk_max: g.sk_max,
                sk_min: g.sk_min,
                rx_max: g.rx_max,
                rx_min: g.rx_min,
                x0x1: g.x0x1,
                r0x0: g.r0x0,
            };
            self.on(Class::ExternalGrid, k).then_some((g.node, feeder))
        });
        let machines = model
            .generators
            .iter()
            .enumerate()
            .filter_map(|(k, g)| Some((g.node, g.sc.feeder.filter(|_| self.on(Class::Generator, k))?)));
        for (node, f) in grids.chain(machines) {
            let Some(i) = calc.topo.bus_of(node) else {
                continue;
            };
            let (sk, rx) = if self.max {
                (f.sk_max, f.rx_max)
            } else {
                (f.sk_min, f.rx_min)
            };
            if sk <= 0.0 {
                continue;
            }
            let zq = self.c_bus[i] * sb / sk;
            let xq = zq / (1.0 + rx * rx).sqrt();
            let z = match seq {
                Seq::Positive => C64::new(rx * xq, xq),
                Seq::Zero => {
                    let x0 = f.x0x1 * xq;
                    C64::new(f.r0x0 * x0, x0)
                }
            };
            e.push((i, i, sx(z).inv()));
        }
        if seq == Seq::Positive {
            e.extend(
                self.rotating(variant, peak, freq_scale)
                    .into_iter()
                    .map(|r| (r.bus, r.bus, r.y)),
            );
        } else {
            // Keeps unearthed parts of the zero sequence solvable.
            e.extend((0..n).map(|i| (i, i, C64::new(1e-10, 0.0))));
        }
        e
    }
}

/// The lines ps-io's document writer adds for the part of a transformer's impedance that a transformer element cannot
/// hold: `<id>.z`, from the busbar `<id>.mid` behind the transformer `<id>`.
fn transformer_lines(model: &Model) -> HashSet<usize> {
    let mids: HashSet<NodeRef> = model
        .nodes
        .iter()
        .enumerate()
        .filter(|(_, n)| n.id.ends_with(".mid"))
        .map(|(i, _)| NodeRef(i as u32))
        .collect();
    model
        .lines
        .iter()
        .enumerate()
        .filter(|(_, l)| l.id.ends_with(".z") && (mids.contains(&l.node1) || mids.contains(&l.node2)))
        .map(|(k, _)| k)
        .collect()
}

/// One winding of a three-winding transformer that a document carries at a star busbar: its transformer, and the
/// line that holds the part of its impedance a transformer element cannot (a negative reactance, as star
/// equivalents often have).
struct StarWinding {
    trafo: usize,
    line: Option<usize>,
}

/// A three-winding transformer as a document carries it: a star busbar `<id>.star` and two-winding transformers
/// `<id>.w1` to `<id>.w3` from each winding's busbar to the star (two when a winding is open), each perhaps through
/// a busbar `<id>.wN.mid` and a line `<id>.wN.z` (ps-io's document writer).
struct Star {
    node: NodeRef,
    windings: Vec<StarWinding>,
}

fn document_stars(model: &Model) -> Vec<Star> {
    let trafos: HashMap<&str, usize> = model
        .transformers2
        .iter()
        .enumerate()
        .map(|(k, t)| (t.id.as_str(), k))
        .collect();
    let lines: HashMap<&str, usize> = model
        .lines
        .iter()
        .enumerate()
        .map(|(k, l)| (l.id.as_str(), k))
        .collect();
    let nodes: HashMap<&str, NodeRef> = model
        .nodes
        .iter()
        .enumerate()
        .map(|(i, n)| (n.id.as_str(), NodeRef(i as u32)))
        .collect();
    let touches = |k: usize, n: NodeRef| model.transformers2[k].node1 == n || model.transformers2[k].node2 == n;
    let mut stars = Vec::new();
    for (i, node) in model.nodes.iter().enumerate() {
        let Some(prefix) = node.id.strip_suffix(".star") else {
            continue;
        };
        let star = NodeRef(i as u32);
        let windings: Vec<StarWinding> = (1..=3)
            .filter_map(|w| {
                let id = format!("{prefix}.w{w}");
                let &trafo = trafos.get(id.as_str())?;
                if touches(trafo, star) {
                    return Some(StarWinding { trafo, line: None });
                }
                let &mid = nodes.get(format!("{id}.mid").as_str())?;
                let &line = lines.get(format!("{id}.z").as_str())?;
                let l = &model.lines[line];
                let joined = (l.node1 == mid && l.node2 == star) || (l.node1 == star && l.node2 == mid);
                (touches(trafo, mid) && joined).then_some(StarWinding {
                    trafo,
                    line: Some(line),
                })
            })
            .collect();
        if windings.len() >= 2 {
            stars.push(Star { node: star, windings });
        }
    }
    stars
}

/// The windings of each document star with KT applied per winding pair, as `three_winding_corrected` does for a
/// three-winding transformer: each winding's impedances on its own side in both sequences, the pair factors from the
/// positive sequence on the smaller rating, and the results back in the transformer, or in the line where the winding
/// has one.
fn star_corrections(
    model: &Model,
    calc: &Calc,
    cmax_bus: &[f64],
    stars: &[Star],
) -> (HashMap<usize, Transformer2>, HashMap<usize, Line>) {
    let (mut trafos, mut lines) = (HashMap::new(), HashMap::new());
    for star in stars {
        let n = star.windings.len();
        // Each winding's transformer: its end away from the star, that side's rated voltage and the other side's.
        let ends: Vec<(NodeRef, f64, f64)> = star
            .windings
            .iter()
            .map(|w| {
                let t = &model.transformers2[w.trafo];
                let inner = match w.line {
                    Some(l) => {
                        let l = &model.lines[l];
                        if l.node1 == star.node { l.node2 } else { l.node1 }
                    }
                    None => star.node,
                };
                if t.node1 == inner {
                    (t.node2, t.rated_kv2, t.rated_kv1)
                } else {
                    (t.node1, t.rated_kv1, t.rated_kv2)
                }
            })
            .collect();
        let cmax = ends
            .iter()
            .filter_map(|e| calc.topo.bus_of(e.0))
            .map(|b| cmax_bus[b])
            .fold(f64::NEG_INFINITY, f64::max);
        let cmax = if cmax.is_finite() { cmax } else { 1.1 };
        // Each winding's transformer part and whole impedance, Ω on its own side, positive and zero sequence.
        let head = |m: usize, zero: bool| -> (f64, f64) {
            let t = &model.transformers2[star.windings[m].trafo];
            let refer = (ends[m].1 / t.rated_kv1).powi(2);
            let (r, x) = if zero { (t.r0, t.x0) } else { (t.r, t.x) };
            (r * refer, x * refer)
        };
        let own = |m: usize, zero: bool| -> (f64, f64) {
            let h = head(m, zero);
            match star.windings[m].line {
                Some(l) => {
                    let l = &model.lines[l];
                    let refer = (ends[m].1 / ends[m].2).powi(2);
                    let (r, x) = if zero { (l.r0, l.x0) } else { (l.r, l.x) };
                    (h.0 + r * refer, h.1 + x * refer)
                }
                None => h,
            }
        };
        // On the first winding's voltage, the star (or the one pair) corrected with the positive sequence's factors.
        let k1 = ends[0].1;
        let on_k1 = |m: usize, z: (f64, f64)| {
            let f = (k1 / ends[m].1).powi(2);
            (z.0 * f, z.1 * f)
        };
        let from_k1 = |m: usize, z: (f64, f64)| {
            let f = (ends[m].1 / k1).powi(2);
            (z.0 * f, z.1 * f)
        };
        let rating = |m: usize| model.transformers2[star.windings[m].trafo].rated_mva;
        let corrected = |zero: bool| -> Vec<(f64, f64)> {
            let positive: Vec<(f64, f64)> = (0..n).map(|m| on_k1(m, own(m, false))).collect();
            let seq: Vec<(f64, f64)> = (0..n).map(|m| on_k1(m, own(m, zero))).collect();
            let out = if n == 3 {
                let kt = factors::pair_factors(
                    [positive[0], positive[1], positive[2]],
                    [rating(0), rating(1), rating(2)],
                    k1,
                    cmax,
                );
                factors::correct_star([seq[0], seq[1], seq[2]], kt).to_vec()
            } else {
                // Two windings: one pair, one factor.
                let x_pair = positive[0].1 + positive[1].1;
                let kt = 0.95 * cmax / (1.0 + 0.6 * x_pair / (k1 * k1 / rating(0).min(rating(1))));
                seq.iter().map(|z| (z.0 * kt, z.1 * kt)).collect()
            };
            out.into_iter().enumerate().map(|(m, z)| from_k1(m, z)).collect()
        };
        let (positive, zero) = (corrected(false), corrected(true));
        for (m, w) in star.windings.iter().enumerate() {
            let t = &model.transformers2[w.trafo];
            match w.line {
                Some(l) => {
                    // The transformer keeps its part; the line takes the rest of the corrected impedance.
                    let back = (ends[m].2 / ends[m].1).powi(2);
                    let (h, h0) = (head(m, false), head(m, true));
                    let mut c = model.lines[l].clone();
                    c.r = (positive[m].0 - h.0) * back;
                    c.x = (positive[m].1 - h.1) * back;
                    c.r0 = (zero[m].0 - h0.0) * back;
                    c.x0 = (zero[m].1 - h0.1) * back;
                    lines.insert(l, c);
                    // Listed as it is, so it takes no correction of its own.
                    trafos.insert(w.trafo, t.clone());
                }
                None => {
                    let back = (t.rated_kv1 / ends[m].1).powi(2);
                    let mut c = t.clone();
                    c.r = positive[m].0 * back;
                    c.x = positive[m].1 * back;
                    c.r0 = zero[m].0 * back;
                    c.x0 = zero[m].1 * back;
                    trafos.insert(w.trafo, c);
                }
            }
        }
    }
    (trafos, lines)
}

/// The power station units the model declares: machines whose `unit_transformer` names a transformer in service
/// with one end at the machine's bus.
fn find_units(
    model: &Model,
    calc: &Calc,
    vbase: &[f64],
    cmax_bus: &[f64],
    stars: &[Star],
    warnings: &mut Vec<String>,
) -> Vec<Unit> {
    let index: HashMap<&str, usize> = model
        .transformers2
        .iter()
        .enumerate()
        .map(|(k, t)| (t.id.as_str(), k))
        .collect();
    let mut units = Vec::new();
    for (k, g) in model.generators.iter().enumerate() {
        let Some(id) = g.unit_transformer.as_deref() else {
            continue;
        };
        let (Some(&tk), Some(bus)) = (index.get(id), calc.topo.bus_of(g.node)) else {
            warnings.push(format!(
                "{}: its unit transformer {id} is not in the network; the machine is treated as on its own.",
                g.id
            ));
            continue;
        };
        if stars.iter().any(|s| s.windings.iter().any(|w| w.trafo == tk)) {
            warnings.push(format!(
                "{}: its unit transformer {id} is a winding of a three-winding transformer, which a power station unit \
                 cannot have; the machine is treated as on its own.",
                g.id
            ));
            continue;
        }
        let t = &model.transformers2[tk];
        let (a, b) = (calc.topo.bus_of(t.node1), calc.topo.bus_of(t.node2));
        // The machine's side is the transformer's low-voltage side.
        let (ur_lv, ur_hv, other) = if b == Some(bus) {
            (t.rated_kv2, t.rated_kv1, a)
        } else if a == Some(bus) {
            (t.rated_kv1, t.rated_kv2, b)
        } else {
            warnings.push(format!(
                "{}: its unit transformer {id} does not connect to its busbar; the machine is treated as on its own.",
                g.id
            ));
            continue;
        };
        let Some(other) = other else { continue };
        if let Some(first) = units.iter().find(|u: &&Unit| u.bus == bus) {
            warnings.push(format!(
                "{}: shares its busbar with {}, the machine of another power station unit; a fault there is calculated \
                 for {}'s terminals.",
                g.id, model.generators[first.machine].id, model.generators[first.machine].id
            ));
        }
        units.push(Unit {
            machine: k,
            trafo: tk,
            bus,
            factors: unit_correction(g, t, ur_hv, ur_lv, vbase[other], cmax_bus[bus]),
        });
    }
    units
}

/// Runs the short-circuit calculation at every bus or at the settings' location.
pub fn run(model: &Model, st: &ShortCircuitSettings) -> ShortCircuitReport {
    let calc = Calc::build(model, &Outages::none(), BuildOptions::default());
    let n = calc.net.buses.len();
    let sb = model.meta.base_mva;
    let f = model.meta.frequency_hz;
    let vbase: Vec<f64> = calc.net.buses.iter().map(|b| b.base_kv).collect();
    let max = st.mode == ScMode::Max;
    let c_bus: Vec<f64> = vbase
        .iter()
        .map(|&v| voltage_factor(v, st.lv_tolerance))
        .map(|(cmax, cmin)| if max { cmax } else { cmin })
        .collect();
    let cmax_bus: Vec<f64> = vbase.iter().map(|&v| voltage_factor(v, st.lv_tolerance).0).collect();
    let mut warnings: Vec<String> = calc
        .warnings
        .iter()
        .filter(|w| !w.contains("reference machine"))
        .cloned()
        .collect();
    let stars = document_stars(model);
    let units = find_units(model, &calc, &vbase, &cmax_bus, &stars, &mut warnings);
    // The pair correction is KT, which only maximum currents take.
    let (star_windings, star_lines) = if max {
        star_corrections(model, &calc, &cmax_bus, &stars)
    } else {
        (HashMap::new(), HashMap::new())
    };
    let b = Builder {
        model,
        calc: &calc,
        st,
        sb,
        f,
        vbase: vbase.clone(),
        c_bus: c_bus.clone(),
        cmax_bus,
        max,
        units,
        star_windings,
        star_lines,
        transformer_lines: transformer_lines(model),
        star_members: stars.iter().flat_map(|s| s.windings.iter().map(|w| w.trafo)).collect(),
    };
    let fc = if f == 60.0 { 24.0 } else { 20.0 };
    let factor = |entries: Entries| {
        if n == 0 {
            None
        } else {
            ComplexLu::factor(n, &entries).ok()
        }
    };
    // Factorisations per variant, made when a fault first needs them.
    let mut positive: HashMap<Variant, Option<ComplexLu>> = HashMap::new();
    let mut peak: HashMap<Variant, Option<ComplexLu>> = HashMap::new();
    let mut zero_peak: Option<Option<ComplexLu>> = None;
    let mut zero = if st.fault == FaultType::LineToEarth {
        factor(b.assemble(Seq::Zero, Variant::Normal, false))
    } else {
        None
    };
    let meshed_rx = if st.kappa == KappaMethod::B {
        branch_ratio(model)
    } else {
        0.0
    };
    let targets: Vec<usize> = if st.location.is_empty() {
        (0..n).collect()
    } else {
        let hit = model
            .index()
            .get(Class::Node, &st.location)
            .and_then(|row| calc.topo.node_bus[row])
            .map(|b| b as usize);
        if hit.is_none() {
            warnings.push(format!(
                "The fault location {} is not an energised busbar.",
                st.location
            ));
        }
        hit.into_iter().collect()
    };
    let column =
        |lu: &mut Option<ComplexLu>, k: usize| -> Option<Vec<C64>> { lu.as_mut().and_then(|lu| lu.column(k).ok()) };
    let mut singular = false;
    let mut buses = Vec::with_capacity(targets.len());
    let mut fault_column: Option<(Variant, Vec<C64>)> = None;
    for &k in &targets {
        // A fault at a unit machine's terminals is calculated on that unit's network, at the machine's rated voltage.
        let unit = b.units.iter().position(|u| u.bus == k);
        let variant = unit.map_or(Variant::Normal, Variant::Terminals);
        let voltage_scale = unit.map_or(1.0, |u| model.generators[b.units[u].machine].rated_kv / vbase[k]);
        let lu = positive
            .entry(variant)
            .or_insert_with(|| factor(b.assemble(Seq::Positive, variant, false)));
        let Some(col) = column(lu, k) else {
            singular = true;
            continue;
        };
        let z1 = col[k];
        let z0 = if st.fault == FaultType::LineToEarth {
            column(&mut zero, k).map_or(C64::new(f64::NAN, f64::NAN), |c| c[k])
        } else {
            C64::new(f64::NAN, f64::NAN)
        };
        let (vb, cc) = (vbase[k], c_bus[k]);
        let zb = vb * vb / sb;
        // The fault impedance ZF in each faulted phase, as pandapower defines it.
        let zf = C64::new(st.fault_r, st.fault_x).scale(1.0 / zb);
        // The fault loop in p.u. of the bus's base: Z1 + ZF, 2·(Z1 + ZF) and 2·Z1 + Z0 + 3·ZF (Z2 = Z1).
        let loop_of = |z1: C64, z0: C64| match st.fault {
            FaultType::ThreePhase => z1 + zf,
            FaultType::LineToLine => (z1 + zf).scale(2.0),
            FaultType::LineToEarth => z1.scale(2.0) + z0 + zf.scale(3.0),
        };
        // In ohms with Un in kV the currents come out in kA: three-phase c·Un/(√3·|loop|), line-to-line c·Un/|loop|,
        // line-to-earth √3·c·Un/|loop|.
        let zl = loop_of(z1, z0).abs() * zb;
        let ikss = voltage_scale
            * match st.fault {
                FaultType::ThreePhase => cc * vb / (SQRT3 * zl),
                FaultType::LineToLine => cc * vb / zl,
                FaultType::LineToEarth => SQRT3 * cc * vb / zl,
            };
        let kappa = match st.kappa {
            KappaMethod::C => {
                let lu = peak
                    .entry(variant)
                    .or_insert_with(|| factor(b.assemble(Seq::Positive, variant, true)));
                // R/X of the fault loop with the network at the equivalent frequency (the fault impedance as given):
                // for earth faults 2·Z1 + Z0 + 3·ZF, as the TR 60909-4 example has it.
                match column(lu, k) {
                    Some(c) if st.fault == FaultType::LineToEarth => {
                        let zl = zero_peak.get_or_insert_with(|| factor(b.assemble(Seq::Zero, Variant::Normal, true)));
                        match column(zl, k) {
                            Some(c0) => {
                                let lp = loop_of(c[k], c0[k]);
                                kappa_of(lp.re / lp.im * (fc / f))
                            }
                            None => f64::NAN,
                        }
                    }
                    Some(c) => {
                        let lp = loop_of(c[k], C64::ZERO);
                        kappa_of(lp.re / lp.im * (fc / f))
                    }
                    None => f64::NAN,
                }
            }
            KappaMethod::B => {
                let limit = if vb < 1.0 { 1.8 } else { 2.0 };
                let safety = if meshed_rx >= 0.3 { 1.15 } else { 1.0 };
                let lp = loop_of(z1, z0);
                (safety * kappa_of(lp.re / lp.im)).clamp(1.0, limit)
            }
        };
        let ip = kappa * std::f64::consts::SQRT_2 * ikss;
        let ib = if st.fault == FaultType::ThreePhase {
            voltage_scale * breaking(&b, variant, &col, k, cc, zf, voltage_scale) * sb / (SQRT3 * vb)
        } else {
            ikss
        };
        let lk = (kappa - 1.0).ln();
        let m = if kappa > 1.99 {
            0.0
        } else {
            ((4.0 * f * st.t_k * lk).exp() - 1.0) / (2.0 * f * st.t_k * lk)
        };
        let earth = st.fault == FaultType::LineToEarth;
        // Sk″ is √3·Un·Ik″ for a three-phase fault; for a line-to-line fault pandapower, whose definition the
        // reference values follow, takes Un·Ik″/√3.
        let skss = match st.fault {
            FaultType::LineToLine => vb * ikss / SQRT3,
            _ => SQRT3 * vb * ikss,
        };
        buses.push(FaultResult {
            id: calc.bus_id(model, k),
            ikss,
            ip,
            ib,
            ith: ikss * (m + 1.0).sqrt(),
            skss,
            kappa,
            rx: z1.re / z1.im,
            c: cc,
            r1: z1.re * zb,
            x1: z1.im * zb,
            r0: earth.then_some(z0.re * zb),
            x0: earth.then_some(z0.im * zb),
        });
        if targets.len() == 1 {
            fault_column = Some((variant, col));
        }
    }
    if singular {
        warnings
            .push("The positive-sequence network is singular; check for busbars without any impedance path.".into());
    }

    let mut contributions = Vec::new();
    if let (Some((variant, col)), true) = (
        fault_column.filter(|_| !st.location.is_empty()),
        st.fault == FaultType::ThreePhase,
    ) {
        let zf = C64::new(st.fault_r, st.fault_x).scale(sb / (vbase[targets[0]] * vbase[targets[0]]));
        contributions = branch_contributions(&b, variant, &col, targets[0], zf);
    }
    ShortCircuitReport {
        fault: st.fault,
        mode: st.mode,
        kappa_method: st.kappa,
        t_min: st.t_min,
        t_k: st.t_k,
        fault_r: st.fault_r,
        fault_x: st.fault_x,
        buses,
        location: st.location.clone(),
        contributions,
        deenergized: calc
            .topo
            .deenergised
            .iter()
            .map(|&i| model.nodes[i as usize].id.clone())
            .collect(),
        warnings,
    }
}

/// The symmetrical breaking current at bus `k`, p.u. of the bus's base current, for a three-phase fault on a
/// variant's network whose impedance column is `col` (IEC 60909-0, 9.1.2.2): the initial current less, for every
/// machine and motor, its share of the voltage (the drop across its own impedance over c·Un/√3) times the part of
/// its current that has decayed by the minimum time delay, (1 − μ) or (1 − μ·q).
fn breaking(b: &Builder, variant: Variant, col: &[C64], k: usize, c: f64, zf: C64, voltage_scale: f64) -> f64 {
    let i_f = C64::new(c, 0.0) / (col[k] + zf);
    let mut ib = i_f.abs();
    for r in b.rotating(variant, false, 1.0) {
        // The machine's terminal voltage in the fault network is the drop across its impedance; per unit, its
        // current is referred to the fault's voltage level through the nominal voltages.
        let dv = col[r.bus] * i_f;
        let i_m = (r.y * dv).abs();
        // At a unit machine's terminals the currents are those at its rated voltage.
        let ratio = voltage_scale * i_m * b.sb / (SQRT3 * b.vbase[r.bus]) / r.rated_ka;
        ib -= dv.abs() / c * (1.0 - mu(ratio, b.st.t_min) * r.q) * i_m;
    }
    ib
}

/// Branch currents for a three-phase fault at bus `k` on a variant's network.
fn branch_contributions(b: &Builder, variant: Variant, col: &[C64], k: usize, zf: C64) -> Vec<BranchContribution> {
    let (model, calc, sb, vbase) = (b.model, b.calc, b.sb, &b.vbase);
    // Fault current If = c / Zkk; voltage change at every bus ΔV = −Z(:,k)·If.
    let i_f = C64::new(b.c_bus[k], 0.0) / (col[k] + zf);
    let dv: Vec<C64> = col.iter().map(|&z| -(z * i_f)).collect();
    let ka = |bus: usize| sb / (SQRT3 * vbase[bus]);
    let mut out = Vec::new();
    for r in 0..model.lines.len() {
        let l = b.line(r);
        let (Some(a), Some(bb)) = (calc.topo.bus_of(l.node1), calc.topo.bus_of(l.node2)) else {
            continue;
        };
        if !b.on(Class::Line, r) {
            continue;
        }
        let lp = line_pu(l, vbase[a], vbase[bb], sb, Seq::Positive);
        let p = two_port(lp.z, C64::ZERO, C64::ZERO, lp.ratio, 0.0);
        out.push(contribution(&l.id, p, dv[a], dv[bb], ka(a), ka(bb)));
    }
    for r in 0..model.transformers2.len() {
        let t = b.trafo2(r);
        let (Some(a), Some(bb)) = (calc.topo.bus_of(t.node1), calc.topo.bus_of(t.node2)) else {
            continue;
        };
        if !b.on(Class::Transformer2, r) {
            continue;
        }
        let tp = transformer2_pu(
            t,
            vbase[a],
            vbase[bb],
            sb,
            TransformerOptions {
                correction: b.trafo_correction(r, bb, variant),
                ..Default::default()
            },
        );
        let p = two_port(tp.z, C64::ZERO, C64::ZERO, tp.ratio, tp.shift);
        out.push(contribution(&t.id, p, dv[a], dv[bb], ka(a), ka(bb)));
    }
    out
}

fn contribution(id: &str, p: (C64, C64, C64, C64), va: C64, vb: C64, ka: f64, kb: f64) -> BranchContribution {
    let i_from = p.0 * va + p.1 * vb;
    let i_to = p.2 * va + p.3 * vb;
    BranchContribution {
        id: id.to_string(),
        i_from: i_from.abs() * ka,
        i_to: i_to.abs() * kb,
    }
}

/// Largest R/X over all series branches in service, used by method B to decide on the 1.15 safety factor.
fn branch_ratio(model: &Model) -> f64 {
    let lines = model.lines.iter().filter(|l| l.in_service).map(|l| (l.r, l.x));
    let trafos = model.transformers2.iter().filter(|t| t.in_service).map(|t| (t.r, t.x));
    lines
        .chain(trafos)
        .filter(|&(_, x)| x > 0.0)
        .map(|(r, x)| r / x)
        .fold(0.0, f64::max)
}
