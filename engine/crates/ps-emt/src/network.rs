//! The three-phase circuit of a solved network.
//!
//! Every calculation bus has a node per phase. Every element connects to its bus through a three-pole breaker (a
//! switch per phase, closed or open as the element is in service) and has its own terminal nodes behind it, so the
//! element keeps its stored energy when its breaker opens. Quantities are per unit on the system base and each bus's
//! base voltage, phase to earth: a phase voltage of 1 is the nominal phase-to-earth RMS voltage.
//!
//! Branches start from the load flow's own two-ports (the final taps included): the series admittance, the shunts at
//! each end and the ideal transformer's ratio and shift are taken back out of the four admittances, so the
//! positive-sequence circuit is the load flow's network. Lines add their zero sequence from the model; transformers
//! their winding connections, from which the zero-sequence paths and the vector group's shift follow.

use std::collections::HashMap;

use ps_lf::Solution;
use ps_model::study::{EmtEvent, EmtEventKind, EmtFault, EmtSettings, LineModel};
use ps_model::{Class, Model, Winding};
use ps_net::{Calc, Seq, TransformerOptions};
use ps_num::C64;

use crate::circuit::{Cap, Circuit, GROUND, Injection, Line, LineMode, Port, Res, Rl, Switch};
use crate::dense::{Mat, balanced, rotation};

/// A closed breaker pole's resistance, and the least resistance of a fault, p.u.
pub const R_ON: f64 = 1e-5;
/// The conductance from every node to earth, p.u. (1 MΩ at 1 kV on 100 MVA is 1e-8 p.u.; this is a hundred times
/// that): it keeps unearthed star points and isolated windings defined and draws no measurable current.
pub const STRAY: f64 = 1e-6;

/// A three-pole breaker: switch indices per phase, from the bus to the element's terminal.
#[derive(Debug, Clone, Copy)]
pub struct Breaker {
    /// Switches of phases a, b and c.
    pub poles: [usize; 3],
}

/// What an event's element identifier acts on.
#[derive(Debug, Clone)]
pub enum Target {
    /// The breakers of a branch (both ends), load, shunt or source.
    Breakers(Vec<usize>),
    /// A converter-fed source's current injection.
    Injection(usize),
}

/// A bus and its phase nodes.
#[derive(Debug, Clone)]
pub struct BusNodes {
    /// Identifier.
    pub id: String,
    /// Base voltage, kV.
    pub kv: f64,
    /// Phase nodes.
    pub nodes: [usize; 3],
}

/// A branch's breakers.
#[derive(Debug, Clone)]
pub struct BranchEnds {
    /// Element identifier.
    pub id: String,
    /// Winding of a three-winding transformer (1 to 3); 0 otherwise.
    pub winding: u8,
    /// `travelling`, `pi` or `transformer`.
    pub model: &'static str,
    /// Breakers at the from and to ends.
    pub ends: [usize; 2],
    /// Base voltage at each end, kV.
    pub kv: [f64; 2],
}

/// Where a source's current is measured.
#[derive(Debug, Clone, Copy)]
pub enum SourceAt {
    /// Its breaker: the current out of the source is the negative of the breaker's.
    Breaker(usize),
    /// Its injection.
    Injection(usize),
}

/// A source.
#[derive(Debug, Clone)]
pub struct SourceNodes {
    /// Element identifier.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Where its current is measured.
    pub at: SourceAt,
    /// Base voltage, kV.
    pub kv: f64,
}

/// A fault an event applies: its switches and how they make the phase currents.
#[derive(Debug, Clone)]
pub struct FaultSwitches {
    /// The event's index in the settings.
    pub event: usize,
    /// The faulted node's identifier as the event gives it.
    pub target: String,
    /// The bus.
    pub bus: usize,
    /// Fault kind.
    pub fault: EmtFault,
    /// Per phase: the switches whose current flows out of that phase into the fault, with their signs.
    pub phases: [Vec<(usize, f64)>; 3],
    /// Every switch of the fault.
    pub switches: Vec<usize>,
}

/// The circuit of a network, with the maps from its elements to circuit parts.
#[derive(Debug)]
pub struct Network {
    /// The circuit.
    pub circuit: Circuit,
    /// Buses.
    pub buses: Vec<BusNodes>,
    /// Branches.
    pub branches: Vec<BranchEnds>,
    /// Sources.
    pub sources: Vec<SourceNodes>,
    /// Faults the events apply.
    pub faults: Vec<FaultSwitches>,
    /// Breakers.
    pub breakers: Vec<Breaker>,
    /// Element identifiers to what their events act on.
    pub targets: HashMap<String, Target>,
    /// Per switch: what it belongs to.
    pub owner: Vec<Owner>,
    /// The load flow's voltage of every bus, p.u.
    pub lf_voltage: Vec<C64>,
    /// Lines as travelling waves and as π sections.
    pub travelling: usize,
    /// Lines as π sections.
    pub pi: usize,
    /// Notes on simplifications.
    pub notes: Vec<String>,
    /// Events that could not be mapped onto the network, by index, with the reason.
    pub refused: Vec<(usize, String)>,
}

/// What a switch belongs to.
#[derive(Debug, Clone)]
pub struct Owner {
    /// The element's identifier, or the faulted node's.
    pub id: String,
    /// Phase, 0 to 2.
    pub phase: usize,
    /// For a branch's breaker, the bus at its end.
    pub end: Option<usize>,
    /// Whether it is a fault path.
    pub fault: bool,
}

/// A star's or delta's connection on one side of a transformer.
struct Side {
    conn: Winding,
    nodes: [usize; 3],
    neutral: usize,
}

impl Side {
    /// The leg voltage of winding `k` as a port over the phase nodes, with `orient` choosing a delta's phase pair
    /// (+1: k and k + 1, −1: k and k − 1) and `m` the further rotation of the phase voltages (the identity when none).
    fn leg(&self, k: usize, orient: i32, m: &Mat, scale: f64) -> Port {
        // The winding's phase coefficients before the rotation.
        let mut c = [0.0; 3];
        match self.conn {
            Winding::D => {
                c[k] = 1.0;
                c[if orient > 0 { (k + 1) % 3 } else { (k + 2) % 3 }] = -1.0;
            }
            _ => c[k] = 1.0,
        }
        let mut port: Port = (0..3)
            .map(|j| (self.nodes[j], scale * (0..3).map(|p| c[p] * m.at(p, j)).sum::<f64>()))
            .filter(|(_, w)| w.abs() > 1e-15)
            .collect();
        if self.conn != Winding::D && self.neutral != GROUND {
            port.push((self.neutral, -scale));
        }
        port
    }

    /// Phase-to-earth voltages per leg voltage: √3 for a delta, 1 for a star.
    fn w(&self) -> f64 {
        if self.conn == Winding::D { 3.0_f64.sqrt() } else { 1.0 }
    }
}

/// Builds a network's circuit.
struct Builder<'a> {
    model: &'a Model,
    calc: &'a Calc,
    w: f64,
    dt: f64,
    line_model: LineModel,
    net: Network,
}

/// Shunt admittances per port, each to its port's own reference: a conductance and a capacitance or inductance.
fn shunt_diag(c: &mut Circuit, ports: Vec<Port>, y: C64, w: f64) {
    if y.re != 0.0 {
        c.res.push(Res {
            ports: ports.clone(),
            g: Mat::diag(&vec![y.re; ports.len()]),
        });
    }
    if y.im > 0.0 {
        c.caps.push(Cap {
            c: Mat::diag(&vec![y.im / w; ports.len()]),
            ports,
        });
    } else if y.im < 0.0 {
        let m = ports.len();
        c.rl.push(Rl {
            ports,
            r: Mat::zeros(m),
            l: Mat::diag(&vec![-1.0 / (w * y.im); m]),
            emf: Vec::new(),
        });
    }
}

/// A balanced three-phase shunt with positive-sequence admittance `y1` and zero-sequence `y0`.
fn shunt_seq(c: &mut Circuit, ports: Vec<Port>, y1: C64, y0: C64, w: f64) {
    if y1.re != 0.0 || y0.re != 0.0 {
        c.res.push(Res {
            ports: ports.clone(),
            g: Mat::sequence(y0.re, y1.re),
        });
    }
    let (b1, b0) = (y1.im, y0.im);
    if b1 >= 0.0 && b0 >= 0.0 && (b1 > 0.0 || b0 > 0.0) {
        c.caps.push(Cap {
            ports,
            c: Mat::sequence(b0 / w, b1 / w),
        });
    } else if b1 < 0.0 && b0 < 0.0 {
        c.rl.push(Rl {
            ports,
            r: Mat::zeros(3),
            l: Mat::sequence(-1.0 / (w * b0), -1.0 / (w * b1)),
            emf: Vec::new(),
        });
    } else if b1 != 0.0 {
        shunt_diag(c, ports, C64::new(0.0, b1), w);
    }
}

/// Ports from the given phase nodes to earth, each weighted by `k`.
fn to_earth(nodes: [usize; 3], k: f64) -> Vec<Port> {
    nodes.iter().map(|&n| vec![(n, k)]).collect()
}

impl Builder<'_> {
    /// A breaker from `bus` to new terminal nodes; returns the terminals and the breaker.
    fn terminal(&mut self, bus: usize, closed: bool, owner: &str, branch: bool) -> ([usize; 3], usize) {
        let t = self.net.circuit.nodes3();
        let mut poles = [0; 3];
        for (k, pole) in poles.iter_mut().enumerate() {
            *pole = self.net.circuit.switches.len();
            self.net.circuit.switches.push(Switch {
                a: self.net.buses[bus].nodes[k],
                b: t[k],
                r: R_ON,
                closed,
            });
            self.net.owner.push(Owner {
                id: owner.to_string(),
                phase: k,
                end: branch.then_some(bus),
                fault: false,
            });
        }
        self.net.breakers.push(Breaker { poles });
        (t, self.net.breakers.len() - 1)
    }

    fn target(&mut self, id: &str, breaker: usize) {
        match self
            .net
            .targets
            .entry(id.to_string())
            .or_insert_with(|| Target::Breakers(Vec::new()))
        {
            Target::Breakers(list) => list.push(breaker),
            Target::Injection(_) => {}
        }
    }

    /// A line between terminals `f` and `t`: positive sequence from the load flow's two-port, zero sequence from the
    /// model (or equal to the positive sequence when the model has none).
    fn line(
        &mut self,
        f: [usize; 3],
        t: [usize; 3],
        ratio: f64,
        pos: (C64, C64, C64),
        zero: Option<(C64, C64, C64)>,
    ) -> &'static str {
        let w = self.w;
        let (z1, yf1, yt1) = pos;
        let (z0, yf0, yt0) = zero.unwrap_or(pos);
        let (b1, b0) = (yf1.im + yt1.im, yf0.im + yt0.im);
        let modes = [(z0, b0), (z1, b1), (z1, b1)].map(|(z, b)| {
            let tau = (z.im * b).sqrt() / w;
            LineMode {
                zc: (z.im / b).sqrt(),
                r: z.re,
                tau,
            }
        });
        let travelling = self.line_model == LineModel::Auto
            && (ratio - 1.0).abs() < 1e-9
            && [z0, z1].iter().all(|z| z.im > 0.0 && z.re >= 0.0)
            && b0 > 0.0
            && b1 > 0.0
            && modes.iter().all(|m| m.tau.is_finite() && m.tau >= self.dt);
        let c = &mut self.net.circuit;
        if travelling {
            c.lines.push(Line { ends: [f, t], modes });
            // Conductances stay lumped at the ends.
            if yf1.re != 0.0 || yf0.re != 0.0 {
                shunt_seq(c, to_earth(f, 1.0), C64::new(yf1.re, 0.0), C64::new(yf0.re, 0.0), w);
            }
            if yt1.re != 0.0 || yt0.re != 0.0 {
                shunt_seq(c, to_earth(t, 1.0), C64::new(yt1.re, 0.0), C64::new(yt0.re, 0.0), w);
            }
            self.net.travelling += 1;
            return "travelling";
        }
        let series: Vec<Port> = (0..3).map(|k| vec![(f[k], 1.0 / ratio), (t[k], -1.0)]).collect();
        if z1.im >= 0.0 && z0.im >= 0.0 && (z1.abs() > 0.0) {
            c.rl.push(Rl {
                ports: series,
                r: Mat::sequence(z0.re, z1.re),
                l: Mat::sequence(z0.im / w, z1.im / w),
                emf: Vec::new(),
            });
        } else if z1.im < 0.0 {
            // A series capacitor: its resistance and capacitance per phase, the zero sequence equal to the positive.
            let cap = -1.0 / (w * z1.im);
            if z1.re > 0.0 {
                let mid = c.nodes3();
                c.rl.push(Rl {
                    ports: (0..3).map(|k| vec![(f[k], 1.0 / ratio), (mid[k], -1.0)]).collect(),
                    r: Mat::diag(&[z1.re; 3]),
                    l: Mat::zeros(3),
                    emf: Vec::new(),
                });
                c.caps.push(Cap {
                    ports: (0..3).map(|k| vec![(mid[k], 1.0), (t[k], -1.0)]).collect(),
                    c: Mat::diag(&[cap; 3]),
                });
            } else {
                c.caps.push(Cap {
                    ports: series,
                    c: Mat::diag(&[cap; 3]),
                });
            }
        }
        shunt_seq(c, to_earth(f, 1.0 / ratio), yf1, yf0, w);
        shunt_seq(c, to_earth(t, 1.0), yt1, yt0, w);
        self.net.pi += 1;
        "pi"
    }

    /// A neutral point: earth for a solidly earthed star, a node behind the earthing impedance `zn` (p.u.) for an
    /// impedance-earthed one, a node of its own for an unearthed star, none for a delta.
    fn neutral(&mut self, conn: Winding, zn: C64) -> Result<usize, String> {
        let w = self.w;
        let c = &mut self.net.circuit;
        Ok(match conn {
            Winding::D => GROUND,
            Winding::Y => c.node(),
            Winding::Yn if zn.abs() == 0.0 => GROUND,
            Winding::Yn => {
                let n = c.node();
                if zn.im > 0.0 {
                    c.rl.push(Rl {
                        ports: vec![vec![(n, 1.0)]],
                        r: Mat::diag(&[zn.re]),
                        l: Mat::diag(&[zn.im / w]),
                        emf: Vec::new(),
                    });
                } else {
                    c.res.push(Res {
                        ports: vec![vec![(n, 1.0)]],
                        g: Mat::diag(&[1.0 / zn.re]),
                    });
                }
                n
            }
            Winding::Z | Winding::Zn => return Err("zigzag windings are not modelled in EMT simulations".into()),
        })
    }

    /// A transformer between terminals `f` and `t` with the load flow's two-port `(ys, y_from, y_to, ratio, shift)`.
    /// Per leg: an ideal transformer between the two windings' leg voltages, the leakage impedance on the to side
    /// and the magnetising admittances at either side. The winding connections give the vector group's shift; the
    /// structure whose shift lies nearest the two-port's is chosen, and the rest (a phase shifter's angle) rotates
    /// the from side's phase voltages.
    #[allow(clippy::too_many_arguments)]
    fn transformer(
        &mut self,
        f: [usize; 3],
        t: [usize; 3],
        conn: [Winding; 2],
        zn: [C64; 2],
        ys: C64,
        y_from: C64,
        y_to: C64,
        ratio: f64,
        shift: f64,
    ) -> Result<(), String> {
        let sf = Side {
            conn: conn[0],
            nodes: f,
            neutral: self.neutral(conn[0], zn[0])?,
        };
        let st = Side {
            conn: conn[1],
            nodes: t,
            neutral: self.neutral(conn[1], zn[1])?,
        };
        let orients = |s: &Side| if s.conn == Winding::D { vec![1, -1] } else { vec![0] };
        let wrap = |x: f64| {
            let y = (x + 180.0).rem_euclid(360.0) - 180.0;
            if y <= -180.0 + 1e-12 { y + 360.0 } else { y }
        };
        let shift_deg = shift.to_degrees();
        // (residual, from orientation, to orientation, rotation, polarity), the first of the least residual.
        let mut best: Option<(f64, i32, i32, usize, f64)> = None;
        for &of in &orients(&sf) {
            for &ot in &orients(&st) {
                for rot in 0..3 {
                    for pol in [1.0, -1.0] {
                        let lead = 30.0 * f64::from(of) - 30.0 * f64::from(ot)
                            + 120.0 * rot as f64
                            + if pol < 0.0 { 180.0 } else { 0.0 };
                        let alpha = wrap(shift_deg + lead);
                        if best.is_none_or(|b| alpha.abs() < b.0.abs() - 1e-9) {
                            best = Some((alpha, of, ot, rot, pol));
                        }
                    }
                }
            }
        }
        let Some((alpha, of, ot, rot, pol)) = best else {
            return Err("a transformer's windings could not be connected".into());
        };
        let m = rotation(alpha.to_radians());
        let id = Mat::diag(&[1.0; 3]);
        let (wf, wt) = (sf.w(), st.w());
        let n = wf / wt * ratio;
        let z = ys.inv();
        let w = self.w;
        let legs: Vec<Port> = (0..3)
            .map(|k| {
                let mut p = sf.leg(k, of, &m, 1.0 / n);
                p.extend(st.leg((k + rot) % 3, ot, &id, -pol));
                p
            })
            .collect();
        let c = &mut self.net.circuit;
        if ys.abs() > 0.0 {
            c.rl.push(Rl {
                ports: legs,
                r: Mat::diag(&[z.re * wt * wt; 3]),
                l: Mat::diag(&[z.im * wt * wt / w; 3]),
                emf: Vec::new(),
            });
        }
        let from_legs: Vec<Port> = (0..3).map(|k| sf.leg(k, of, &m, 1.0 / n)).collect();
        let to_legs: Vec<Port> = (0..3).map(|k| st.leg(k, ot, &id, 1.0)).collect();
        shunt_diag(c, from_legs, y_from.scale(1.0 / (wt * wt)), w);
        shunt_diag(c, to_legs, y_to.scale(1.0 / (wt * wt)), w);
        Ok(())
    }

    /// Converts a neutral earthing impedance in ohms at a bus of `kv` to per unit.
    fn ohms(&self, r: f64, x: f64, kv: f64) -> C64 {
        let sb = self.calc.net.base_mva;
        C64::new(ps_net::ohms_pu(r, kv, sb), ps_net::ohms_pu(x, kv, sb))
    }

    /// A branch from its two-port, between buses `fb` and `tb`, with breakers in the given state.
    #[allow(clippy::too_many_arguments)]
    fn branch(
        &mut self,
        class: Class,
        row: usize,
        winding: u8,
        fb: usize,
        tb: usize,
        two: (C64, C64, C64, f64, f64),
        closed: bool,
    ) -> Result<(), String> {
        let model = self.model;
        let id = model.id_of(class, row).unwrap_or("").to_string();
        let (ys, y_from, y_to, ratio, shift) = two;
        let (f, bf) = self.terminal(fb, closed, &id, true);
        let (t, bt) = self.terminal(tb, closed, &id, true);
        let (kvf, kvt) = (self.net.buses[fb].kv, self.net.buses[tb].kv);
        let kind = match class {
            Class::Line => {
                let l = &model.lines[row];
                let zero = if l.r0 == 0.0 && l.x0 == 0.0 {
                    None
                } else {
                    let p = ps_net::line_pu(l, kvf, kvt, self.calc.net.base_mva, Seq::Zero);
                    Some((p.z, p.y_from, p.y_to))
                };
                let pos = (ys.inv(), y_from, y_to);
                if zero.is_none() {
                    self.net.notes.push(format!(
                        "{}: no zero-sequence data; its zero sequence equals its positive sequence.",
                        label(model, class, row)
                    ));
                }
                self.line(f, t, ratio, pos, zero)
            }
            Class::Transformer2 => {
                let tr = &model.transformers2[row];
                let zn = [self.ohms(tr.rn[0], tr.xn[0], kvf), self.ohms(tr.rn[1], tr.xn[1], kvt)];
                self.transformer(f, t, [tr.conn1, tr.conn2], zn, ys, y_from, y_to, ratio, shift)
                    .map_err(|e| format!("{}: {e}.", label(model, class, row)))?;
                "transformer"
            }
            Class::Transformer3 => {
                let wd = &model.transformers3[row].windings[usize::from(winding).saturating_sub(1)];
                let zn = [self.ohms(wd.rn, wd.xn, kvf), C64::ZERO];
                // The star side of each winding's branch: an earthed star, so a delta winding shorts the zero sequence
                // at the star point and an earthed star passes it, as in the star equivalent.
                self.transformer(f, t, [wd.conn, Winding::Yn], zn, ys, y_from, y_to, ratio, shift)
                    .map_err(|e| format!("{}: {e}.", label(model, class, row)))?;
                "transformer"
            }
            _ => self.line(f, t, ratio, (ys.inv(), y_from, y_to), None),
        };
        self.target(&id, bf);
        self.target(&id, bt);
        self.net.branches.push(BranchEnds {
            id,
            winding,
            model: kind,
            ends: [bf, bt],
            kv: [kvf, kvt],
        });
        Ok(())
    }

    /// A shunt element (load, shunt, compensator) of admittance `y` per phase at `bus`, as an earthed star.
    fn shunt_element(&mut self, id: &str, bus: usize, y: C64, closed: bool) {
        if y.abs() == 0.0 {
            return;
        }
        let (t, b) = self.terminal(bus, closed, id, false);
        let w = self.w;
        shunt_diag(&mut self.net.circuit, to_earth(t, 1.0), y, w);
        self.target(id, b);
    }

    /// A source: an EMF `e` (positive sequence, p.u.) behind `z1`, with zero-sequence impedance `z0` when its neutral
    /// is earthed through its zero sequence (`None`: an unearthed star; equal to `z1`: a solidly earthed star).
    fn source(&mut self, id: &str, name: &str, bus: usize, e: C64, z1: C64, z0: Option<C64>) -> Result<(), String> {
        if z1.im.is_nan() || z1.im <= 0.0 {
            return Err(format!("{name}: its short-circuit reactance must be above zero."));
        }
        let (t, b) = self.terminal(bus, true, id, false);
        let w = self.w;
        let emf = balanced(e).to_vec();
        let c = &mut self.net.circuit;
        match z0 {
            Some(z0) if z0.im > 0.0 => c.rl.push(Rl {
                ports: (0..3).map(|k| vec![(t[k], -1.0)]).collect(),
                r: Mat::sequence(z0.re, z1.re),
                l: Mat::sequence(z0.im / w, z1.im / w),
                emf,
            }),
            _ => {
                let n = c.node();
                c.rl.push(Rl {
                    ports: (0..3).map(|k| vec![(n, 1.0), (t[k], -1.0)]).collect(),
                    r: Mat::diag(&[z1.re; 3]),
                    l: Mat::diag(&[z1.im / w; 3]),
                    emf,
                });
            }
        }
        self.target(id, b);
        let kv = self.net.buses[bus].kv;
        self.net.sources.push(SourceNodes {
            id: id.to_string(),
            name: name.to_string(),
            at: SourceAt::Breaker(b),
            kv,
        });
        Ok(())
    }
}

/// An element's display name, or its identifier.
fn label(model: &Model, class: Class, row: usize) -> String {
    let n = model.name_of(class, row);
    if n.is_empty() {
        model.id_of(class, row).unwrap_or("").to_string()
    } else {
        n.to_string()
    }
}

/// Series admittance, shunts, ratio and shift of a two-port in the MATPOWER convention.
fn untwo(yff: C64, yft: C64, ytt: C64, ratio: f64, shift: f64) -> (C64, C64, C64, f64, f64) {
    let t = C64::from_polar(ratio, shift);
    let ys = -(yft * t.conj());
    (ys, yff.scale(ratio * ratio) - ys, ytt - ys, ratio, shift)
}

/// A source's impedance from a short-circuit power and R/X at a bus, p.u., with its zero sequence from X0/X1 and
/// R0/X0 (`None` when X0/X1 is zero: no zero-sequence path).
fn network_impedance(sb: f64, sk: f64, rx: f64, x0x1: f64, r0x0: f64) -> (C64, Option<C64>) {
    let x = (sb / sk) / (1.0 + rx * rx).sqrt();
    let z0 = (x0x1 > 0.0).then(|| C64::new(r0x0 * x0x1 * x, x0x1 * x));
    (C64::new(rx * x, x), z0)
}

/// Builds the circuit of `calc` (whose network is the load flow's solved one) from the load flow `lf`.
pub fn build(model: &Model, calc: &Calc, lf: &Solution, st: &EmtSettings, dt: f64) -> Result<Network, String> {
    let net = &calc.net;
    let sb = net.base_mva;
    let w = 2.0 * std::f64::consts::PI * model.meta.frequency_hz;
    let v0: Vec<C64> = (0..net.buses.len())
        .map(|i| C64::from_polar(lf.vm[i], lf.va[i]))
        .collect();
    let mut circuit = Circuit {
        stray: STRAY,
        omega: w,
        ..Default::default()
    };
    let buses: Vec<BusNodes> = (0..net.buses.len())
        .map(|b| BusNodes {
            id: calc.bus_id(model, b),
            kv: net.buses[b].base_kv,
            nodes: circuit.nodes3(),
        })
        .collect();
    let mut b = Builder {
        model,
        calc,
        w,
        dt,
        line_model: st.line_model,
        net: Network {
            circuit,
            buses,
            branches: Vec::new(),
            sources: Vec::new(),
            faults: Vec::new(),
            breakers: Vec::new(),
            targets: HashMap::new(),
            owner: Vec::new(),
            lf_voltage: v0.clone(),
            travelling: 0,
            pi: 0,
            notes: Vec::new(),
            refused: Vec::new(),
        },
    };
    for (k, br) in net.branches.iter().enumerate() {
        let src = calc.branches[k];
        let two = untwo(br.yff, br.yft, br.ytt, br.ratio, br.shift);
        b.branch(src.class, src.row as usize, src.winding, br.f, br.t, two, true)?;
    }
    // Lines and transformers out of service between energised buses, with open breakers: a "switch in" energises
    // them.
    let topo = &calc.topo;
    for (k, l) in model.lines.iter().enumerate().filter(|(_, l)| !l.in_service) {
        if let (Some(f), Some(t)) = (topo.bus_of(l.node1), topo.bus_of(l.node2)) {
            let p = ps_net::line_pu(l, net.buses[f].base_kv, net.buses[t].base_kv, sb, Seq::Positive);
            let (yff, yft, _, ytt) = ps_net::two_port(p.z, p.y_from, p.y_to, p.ratio, 0.0);
            b.branch(Class::Line, k, 0, f, t, untwo(yff, yft, ytt, p.ratio, 0.0), false)?;
        }
    }
    for (k, tr) in model.transformers2.iter().enumerate().filter(|(_, t)| !t.in_service) {
        if let (Some(f), Some(t)) = (topo.bus_of(tr.node1), topo.bus_of(tr.node2)) {
            let p = ps_net::transformer2_pu(
                tr,
                net.buses[f].base_kv,
                net.buses[t].base_kv,
                sb,
                TransformerOptions::default(),
            );
            let (yff, yft, _, ytt) = ps_net::two_port(p.z, p.y_from, p.y_to, p.ratio, p.shift);
            b.branch(
                Class::Transformer2,
                k,
                0,
                f,
                t,
                untwo(yff, yft, ytt, p.ratio, p.shift),
                false,
            )?;
        }
    }
    // Sources.
    let mut fed = 0;
    for u in &lf.machines {
        let (class, row) = calc.unit(u.id);
        let bus = net.machines[u.id].bus;
        let v = v0[bus];
        let id = model.id_of(class, row).unwrap_or("").to_string();
        if v.abs() < 1e-6 {
            continue;
        }
        let i = (C64::new(u.p, u.q) / v).conj();
        if class != Class::Generator {
            // Static var compensators and converter stations: their load-flow susceptance.
            b.shunt_element(&id, bus, C64::new(0.0, u.q / v.norm_sqr()), true);
            continue;
        }
        let g = &model.generators[row];
        let name = label(model, class, row);
        let kv = net.buses[bus].base_kv;
        if g.sc.converter.is_some() {
            let k = b.net.circuit.injections.len();
            b.net.circuit.injections.push(Injection {
                nodes: b.net.buses[bus].nodes,
                i: balanced(i),
                on: true,
            });
            b.net.targets.insert(id.clone(), Target::Injection(k));
            b.net.sources.push(SourceNodes {
                id,
                name,
                at: SourceAt::Injection(k),
                kv,
            });
            fed += 1;
            continue;
        }
        let (z1, z0) = match g.sc.feeder {
            Some(f) => network_impedance(sb, f.sk_max, f.rx_max, f.x0x1, f.r0x0),
            None => {
                let z = |x: f64| ps_net::machine_z_pu(x, g.rated_mva, g.rated_kv, sb, kv);
                let z1 = C64::new(z(g.sc.rs), z(g.sc.xdss));
                (z1, g.sc.earthed.then_some(z1))
            }
        };
        b.source(&id, &name, bus, v + z1 * i, z1, z0)?;
    }
    if fed > 0 {
        b.net.notes.push(format!(
            "{fed} converter-fed source(s) inject a balanced current at their load-flow output, without controls."
        ));
    }
    for u in &lf.grids {
        let row = calc.grids[u.id] as usize;
        let g = &model.external_grids[row];
        let bus = net.grids[u.id].bus;
        let v = v0[bus];
        if v.abs() < 1e-6 {
            continue;
        }
        let i = (C64::new(u.p, u.q) / v).conj();
        let (z1, z0) = network_impedance(sb, g.sk_max, g.rx_max, g.x0x1, g.r0x0);
        let name = label(model, Class::ExternalGrid, row);
        b.source(&g.id.clone(), &name, bus, v + z1 * i, z1, z0)?;
    }
    // Loads at their load-flow consumption, and shunts.
    for (k, l) in net.loads.iter().enumerate() {
        let v2 = v0[l.bus].norm_sqr();
        if v2 < 1e-12 {
            continue;
        }
        let (p, q) = lf.loads.get(k).copied().unwrap_or((l.p, l.q));
        let (class, row) = calc.load_unit(k);
        let id = model.id_of(class, row).unwrap_or("").to_string();
        b.shunt_element(&id, l.bus, C64::new(p / v2, -q / v2), true);
    }
    for s in &net.shunts {
        let id = model
            .id_of(Class::Shunt, calc.shunts[s.id] as usize)
            .unwrap_or("")
            .to_string();
        b.shunt_element(&id, s.bus, s.y, true);
    }
    for l in model.loads.iter().filter(|l| !l.in_service) {
        if let Some(bus) = topo.bus_of(l.node) {
            b.shunt_element(&l.id, bus, C64::new(l.p / sb, -l.q / sb), false);
        }
    }
    for s in model.shunts.iter().filter(|s| !s.in_service) {
        if let Some(bus) = topo.bus_of(s.node) {
            let kv = net.buses[bus].base_kv;
            b.shunt_element(&s.id, bus, ps_net::shunt_admittance(s).scale(kv * kv / sb), false);
        }
    }
    // Faults.
    let index = model.index();
    for (k, ev) in st.events.iter().enumerate() {
        if ev.kind != EmtEventKind::Fault {
            continue;
        }
        let bus = index
            .get(Class::Node, &ev.target)
            .and_then(|row| topo.node_bus[row])
            .map(|x| x as usize);
        let Some(bus) = bus else {
            b.net.refused.push((k, "not an energised busbar".into()));
            continue;
        };
        add_fault(&mut b.net, k, ev, bus, sb);
    }
    Ok(b.net)
}

/// Adds the switches of fault event `k` at `bus`.
fn add_fault(net: &mut Network, k: usize, ev: &EmtEvent, bus: usize, sb: f64) {
    let kv = net.buses[bus].kv;
    let r = ps_net::ohms_pu(ev.r.unwrap_or(0.0).max(0.0), kv, sb).max(R_ON);
    let nodes = net.buses[bus].nodes;
    let fault = ev.fault.unwrap_or_default();
    let mut phases: [Vec<(usize, f64)>; 3] = Default::default();
    let mut switches = Vec::new();
    let add = |a: usize, bnode: usize, net: &mut Network| {
        net.circuit.switches.push(Switch {
            a,
            b: bnode,
            r,
            closed: false,
        });
        net.owner.push(Owner {
            id: ev.target.clone(),
            phase: 0,
            end: None,
            fault: true,
        });
        net.circuit.switches.len() - 1
    };
    match fault {
        EmtFault::ThreePhase => {
            for (p, phase) in phases.iter_mut().enumerate() {
                let s = add(nodes[p], GROUND, net);
                phase.push((s, 1.0));
                switches.push(s);
            }
        }
        EmtFault::LineToLine => {
            let s = add(nodes[1], nodes[2], net);
            phases[1].push((s, 1.0));
            phases[2].push((s, -1.0));
            switches.push(s);
        }
        EmtFault::TwoPhaseEarth => {
            for p in [1, 2] {
                let s = add(nodes[p], GROUND, net);
                phases[p].push((s, 1.0));
                switches.push(s);
            }
        }
        EmtFault::LineToEarth => {
            let s = add(nodes[0], GROUND, net);
            phases[0].push((s, 1.0));
            switches.push(s);
        }
    }
    for (p, phase) in phases.iter().enumerate() {
        for &(s, _) in phase {
            net.owner[s].phase = p;
        }
    }
    net.faults.push(FaultSwitches {
        event: k,
        target: ev.target.clone(),
        bus,
        fault,
        phases,
        switches,
    });
}
