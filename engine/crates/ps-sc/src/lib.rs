//! Short-circuit currents by the method of the equivalent voltage source at the fault location, following
//! IEC 60909-0. This is an IEC 60909-style calculation, not a certified one: docs/ENGINE.md, "Short circuit", lists
//! the clauses it implements, the simplifications it makes and the references it is checked against.
//!
//! For each faulted bus k the only source is c·Un/√3 at k; machines and grids become impedances. The Thévenin
//! impedance Zkk is read from the solution of Y·z = e_k for the positive and, for earth faults, the zero sequence
//! network. The negative-sequence network equals the positive one.

use ps_model::study::{FaultType, KappaMethod, LvTolerance, ScMode, ShortCircuitSettings};
use ps_model::{Class, Generator, Model, Transformer2, Winding};
use ps_net::{BuildOptions, Calc, Seq, TransformerOptions, line_pu, tap_factor, transformer2_pu, two_port};
use ps_num::C64;
use ps_sparse::ComplexLu;
use ps_topology::{Outages, active};
use serde::Serialize;

const SQRT3: f64 = 1.732_050_807_568_877_2;

/// Voltage factors (cmax, cmin) for a nominal voltage (IEC 60909-0 Table 1, as pandapower implements it).
pub fn voltage_factor(kv: f64, lv: LvTolerance) -> (f64, f64) {
    if kv < 1.0 {
        match lv {
            LvTolerance::Six => (1.05, 0.95),
            LvTolerance::Ten => (1.1, 0.9),
        }
    } else {
        (1.1, 1.0)
    }
}

/// Transformer impedance correction factor KT = 0.95·cmax / (1 + 0.6·xT) (IEC 60909-0, 6.3.3), with xT the
/// reactance in p.u. of the rating.
pub fn transformer_correction(t: &Transformer2, cmax: f64) -> f64 {
    let zb = t.rated_kv1 * t.rated_kv1 / t.rated_mva;
    0.95 * cmax / (1.0 + 0.6 * t.x / zb)
}

/// Generator impedance correction factor KG = Un/UrG · cmax / (1 + x″d·sin φrG) (IEC 60909-0, 6.6.1).
pub fn generator_correction(g: &Generator, un: f64, cmax: f64) -> f64 {
    let cos = g.sc.cos_phi;
    let sin = (1.0 - cos * cos).max(0.0).sqrt();
    un / g.rated_kv * cmax / (1.0 + g.sc.xdss * sin)
}

/// Fictitious generator resistance for the peak current, as a fraction of X″d (IEC 60909-0, 6.6.1).
pub fn fictitious_resistance_ratio(g: &Generator) -> f64 {
    if g.rated_kv <= 1.0 {
        0.15
    } else if g.rated_mva >= 100.0 {
        0.05
    } else {
        0.07
    }
}

/// κ = 1.02 + 0.98·e^(−3R/X) (IEC 60909-0, 8.1).
pub fn kappa_of(rx: f64) -> f64 {
    1.02 + 0.98 * (-3.0 * rx).exp()
}

/// Results at one faulted bus.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct FaultResult {
    /// Identifier of the bus's first node.
    pub id: String,
    /// Initial symmetrical short-circuit current Ik″, kA.
    pub ikss: f64,
    /// Peak current ip, kA.
    pub ip: f64,
    /// Thermal equivalent current Ith for 1 s, kA.
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

/// Duration for Ith, s.
const TK: f64 = 1.0;

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
    let on = |class, row| active(model, &Outages::none(), class, row);
    let fc = if f == 60.0 { 24.0 } else { 20.0 };

    // Assembles a sequence network as coordinate entries.
    let assemble = |seq: Seq, freq_scale: f64, peak: bool| -> Vec<(usize, usize, C64)> {
        let mut e: Vec<(usize, usize, C64)> = Vec::new();
        let sx = |z: C64| C64::new(z.re, z.im * freq_scale);
        let stamp = |e: &mut Vec<(usize, usize, C64)>, a: usize, b: usize, p: (C64, C64, C64, C64)| {
            e.extend([(a, a, p.0), (a, b, p.1), (b, a, p.2), (b, b, p.3)]);
        };
        for (k, l) in model.lines.iter().enumerate() {
            let (Some(a), Some(b)) = (calc.topo.bus_of(l.node1), calc.topo.bus_of(l.node2)) else {
                continue;
            };
            if !on(Class::Line, k) {
                continue;
            }
            let (z, ysh) = line_pu(l, vbase[a], sb, seq);
            // Line capacitances are neglected in the positive sequence (IEC 60909-0, 6.4) and kept in the zero sequence.
            let ysh = if seq == Seq::Zero {
                C64::new(0.0, ysh.im * freq_scale)
            } else {
                C64::ZERO
            };
            stamp(&mut e, a, b, two_port(sx(z), ysh.scale(0.5), ysh.scale(0.5), 1.0, 0.0));
        }
        for (k, t) in model.transformers2.iter().enumerate() {
            let (Some(a), Some(b)) = (calc.topo.bus_of(t.node1), calc.topo.bus_of(t.node2)) else {
                continue;
            };
            if !on(Class::Transformer2, k) {
                continue;
            }
            let kt = if max {
                transformer_correction(t, cmax_bus[b])
            } else {
                1.0
            };
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
            match (t.conn1, t.conn2) {
                (Winding::D, Winding::Yn) => e.push((b, b, sx(p.z).inv())),
                (Winding::Yn, Winding::Yn) => {
                    stamp(&mut e, a, b, two_port(sx(p.z), C64::ZERO, C64::ZERO, p.ratio, 0.0))
                }
                (Winding::Yn, Winding::D) => {
                    // Zero-sequence impedance seen from the earthed HV winding, on the HV bus's base, tap included.
                    let tf = tap_factor(t, 1);
                    let z = C64::new(t.r0, t.x0).scale(tf * tf * sb / (vbase[a] * vbase[a]) * kt);
                    e.push((a, a, sx(z).inv()));
                }
                _ => {}
            }
        }
        for (k, g) in model.external_grids.iter().enumerate() {
            let Some(i) = calc.topo.bus_of(g.node) else {
                continue;
            };
            if !on(Class::ExternalGrid, k) {
                continue;
            }
            let (sk, rx) = if max {
                (g.sk_max, g.rx_max)
            } else {
                (g.sk_min, g.rx_min)
            };
            let zq = c_bus[i] * sb / sk;
            let xq = zq / (1.0 + rx * rx).sqrt();
            let z = match seq {
                Seq::Positive => C64::new(rx * xq, xq),
                Seq::Zero => {
                    let x0 = g.x0x1 * xq;
                    C64::new(g.r0x0 * x0, x0)
                }
            };
            e.push((i, i, sx(z).inv()));
        }
        if seq == Seq::Positive {
            for (k, g) in model.generators.iter().enumerate() {
                let Some(i) = calc.topo.bus_of(g.node) else {
                    continue;
                };
                if !on(Class::Generator, k) {
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
                let kg = generator_correction(g, vbase[i], cmax_bus[i]);
                e.push((i, i, sx(C64::new(r * kg, x * kg)).inv()));
            }
        }
        if seq == Seq::Zero {
            // Keeps unearthed parts of the zero sequence solvable.
            e.extend((0..n).map(|i| (i, i, C64::new(1e-10, 0.0))));
        }
        e
    };

    let factor = |entries: Vec<(usize, usize, C64)>| {
        if n == 0 {
            None
        } else {
            ComplexLu::factor(n, &entries).ok()
        }
    };
    let mut f1 = factor(assemble(Seq::Positive, 1.0, false));
    let mut f0 = if st.fault == FaultType::LineToEarth {
        factor(assemble(Seq::Zero, 1.0, false))
    } else {
        None
    };
    let mut fpk = if st.kappa == KappaMethod::C {
        factor(assemble(Seq::Positive, fc / f, true))
    } else {
        None
    };
    if f1.is_none() && n > 0 {
        warnings
            .push("The positive-sequence network is singular; check for busbars without any impedance path.".into());
    }
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
    let zkk = |lu: &mut Option<ComplexLu>, k: usize| -> (C64, Option<Vec<C64>>) {
        match lu.as_mut().map(|lu| lu.column(k)) {
            Some(Ok(col)) => (col[k], Some(col)),
            _ => (C64::new(f64::NAN, f64::NAN), None),
        }
    };
    let mut buses = Vec::with_capacity(targets.len());
    for &k in &targets {
        let (z1, _) = zkk(&mut f1, k);
        let z0 = if st.fault == FaultType::LineToEarth {
            zkk(&mut f0, k).0
        } else {
            C64::new(f64::NAN, f64::NAN)
        };
        let (vb, cc) = (vbase[k], c_bus[k]);
        let zb = vb * vb / sb;
        // In ohms with Un in kV the currents come out in kA: three-phase c·Un/(√3·|Z1|), line-to-line
        // c·Un/|Z1 + Z2|, line-to-earth √3·c·Un/|Z1 + Z2 + Z0|, with Z2 = Z1.
        let ikss = match st.fault {
            FaultType::ThreePhase => cc * vb / (SQRT3 * z1.abs() * zb),
            FaultType::LineToLine => cc * vb / (2.0 * z1.abs() * zb),
            FaultType::LineToEarth => SQRT3 * cc * vb / ((z1.scale(2.0) + z0).abs() * zb),
        };
        let kappa = match st.kappa {
            KappaMethod::C => {
                let (zc, _) = zkk(&mut fpk, k);
                kappa_of(zc.re / zc.im * (fc / f))
            }
            KappaMethod::B => {
                let limit = if vb < 1.0 { 1.8 } else { 2.0 };
                let safety = if meshed_rx >= 0.3 { 1.15 } else { 1.0 };
                (safety * kappa_of(z1.re / z1.im)).clamp(1.0, limit)
            }
        };
        let ip = kappa * std::f64::consts::SQRT_2 * ikss;
        let lk = (kappa - 1.0).ln();
        let m = if kappa > 1.99 {
            0.0
        } else {
            ((4.0 * f * TK * lk).exp() - 1.0) / (2.0 * f * TK * lk)
        };
        let earth = st.fault == FaultType::LineToEarth;
        buses.push(FaultResult {
            id: calc.bus_id(model, k),
            ikss,
            ip,
            ith: ikss * (m + 1.0).sqrt(),
            skss: SQRT3 * vb * ikss,
            kappa,
            rx: z1.re / z1.im,
            c: cc,
            r1: z1.re * zb,
            x1: z1.im * zb,
            r0: earth.then_some(z0.re * zb),
            x0: earth.then_some(z0.im * zb),
        });
    }

    let mut contributions = Vec::new();
    if !st.location.is_empty() && targets.len() == 1 && st.fault == FaultType::ThreePhase {
        let k = targets[0];
        if let (zk, Some(col)) = zkk(&mut f1, k) {
            // Fault current If = c / Zkk; voltage change at every bus ΔV = −Z(:,k)·If.
            let i_f = C64::new(c_bus[k], 0.0) / zk;
            let dv: Vec<C64> = col.iter().map(|&z| -(z * i_f)).collect();
            let ka = |bus: usize| sb / (SQRT3 * vbase[bus]);
            for (r, l) in model.lines.iter().enumerate() {
                let (Some(a), Some(b)) = (calc.topo.bus_of(l.node1), calc.topo.bus_of(l.node2)) else {
                    continue;
                };
                if !on(Class::Line, r) {
                    continue;
                }
                let p = two_port(
                    line_pu(l, vbase[a], sb, Seq::Positive).0,
                    C64::ZERO,
                    C64::ZERO,
                    1.0,
                    0.0,
                );
                contributions.push(contribution(&l.id, p, dv[a], dv[b], ka(a), ka(b)));
            }
            for (r, t) in model.transformers2.iter().enumerate() {
                let (Some(a), Some(b)) = (calc.topo.bus_of(t.node1), calc.topo.bus_of(t.node2)) else {
                    continue;
                };
                if !on(Class::Transformer2, r) {
                    continue;
                }
                let kt = if max {
                    transformer_correction(t, cmax_bus[b])
                } else {
                    1.0
                };
                let tp = transformer2_pu(
                    t,
                    vbase[a],
                    vbase[b],
                    sb,
                    TransformerOptions {
                        correction: kt,
                        ..Default::default()
                    },
                );
                let p = two_port(tp.z, C64::ZERO, C64::ZERO, tp.ratio, tp.shift);
                contributions.push(contribution(&t.id, p, dv[a], dv[b], ka(a), ka(b)));
            }
        }
    }
    ShortCircuitReport {
        fault: st.fault,
        mode: st.mode,
        kappa_method: st.kappa,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iec_factors_follow_their_formulas() {
        assert!((kappa_of(0.0) - 2.0).abs() < 1e-12);
        assert!((kappa_of(0.1) - (1.02 + 0.98 * (-0.3_f64).exp())).abs() < 1e-12);
        // uk = 10 %, uR = 0.6 % on a 110 kV, 40 MVA rating.
        let zb = 110.0 * 110.0 / 40.0;
        let t = Transformer2 {
            rated_kv1: 110.0,
            rated_mva: 40.0,
            x: (0.01_f64 - 0.000_036).sqrt() * zb,
            ..Default::default()
        };
        assert!(
            (transformer_correction(&t, 1.1) - 0.95 * 1.1 / (1.0 + 0.6 * (0.01_f64 - 0.000_036).sqrt())).abs() < 1e-12
        );
        let mut g = Generator {
            rated_kv: 10.5,
            ..Default::default()
        };
        g.sc.xdss = 0.2;
        g.sc.cos_phi = 0.8;
        assert!((generator_correction(&g, 10.0, 1.1) - 10.0 / 10.5 * 1.1 / (1.0 + 0.2 * 0.6)).abs() < 1e-12);
        assert_eq!(voltage_factor(20.0, LvTolerance::Ten), (1.1, 1.0));
        assert_eq!(voltage_factor(0.4, LvTolerance::Six), (1.05, 0.95));
    }
}
