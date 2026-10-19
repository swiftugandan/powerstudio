//! A linear circuit for transient simulation: nodes, coupled R-L branches with series sources, coupled capacitances
//! and conductances, switches, travelling-wave lines and current injections. Quantities are per unit (or any
//! consistent units); phasors are RMS with the cosine as reference, so a phasor `X` is the waveform
//! `√2·|X|·cos(ωt + ∠X)`.
//!
//! An element's ports are weighted sums of node voltages: a branch between nodes p and q has the port
//! `[(p, 1), (q, −1)]`, the leg of an ideal transformer `[(h1, 1/n), (h2, −1/n), (l1, −1), (l2, 1)]`. A port's current
//! leaves its nodes in proportion to their weights, so the transformer's winding currents come out of the same port.

use ps_num::C64;
use ps_sparse::ComplexLu;

use crate::dense::{Mat, cinverse, clarke};

/// The reference node, which carries no unknown.
pub const GROUND: usize = usize::MAX;

/// A weighted sum of node voltages.
pub type Port = Vec<(usize, f64)>;

/// Coupled R-L branches with an optional source voltage in series: the port voltages `u = A·v + e` drive the
/// currents `i` through `R·i + L·di/dt = u`.
#[derive(Debug, Clone)]
pub struct Rl {
    /// Ports.
    pub ports: Vec<Port>,
    /// Resistance matrix.
    pub r: Mat,
    /// Inductance matrix (per unit: henry-like, reactance over angular frequency).
    pub l: Mat,
    /// Source voltage phasor per port; empty for none.
    pub emf: Vec<C64>,
}

/// Coupled capacitances between ports: `i = C·du/dt`.
#[derive(Debug, Clone)]
pub struct Cap {
    /// Ports.
    pub ports: Vec<Port>,
    /// Capacitance matrix.
    pub c: Mat,
}

/// Coupled conductances between ports: `i = G·u`.
#[derive(Debug, Clone)]
pub struct Res {
    /// Ports.
    pub ports: Vec<Port>,
    /// Conductance matrix.
    pub g: Mat,
}

/// A switch between two nodes (either may be [`GROUND`]): a resistance when closed, nothing when open.
#[derive(Debug, Clone)]
pub struct Switch {
    /// First node.
    pub a: usize,
    /// Second node.
    pub b: usize,
    /// Resistance when closed.
    pub r: f64,
    /// Closed.
    pub closed: bool,
}

/// One mode of a travelling-wave line.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LineMode {
    /// Surge impedance of the lossless line, `√(L/C)`.
    pub zc: f64,
    /// Total series resistance, lumped a quarter at each end and half in the middle.
    pub r: f64,
    /// Travel time, s.
    pub tau: f64,
}

impl LineMode {
    /// The impedance seen at an end, `Zc + R/4`, and the loss factor `h = (Zc − R/4)/(Zc + R/4)`.
    pub fn z_h(&self) -> (f64, f64) {
        let z = self.zc + self.r / 4.0;
        (z, (self.zc - self.r / 4.0) / z)
    }

    /// The model's admittances at angular frequency `w`: `(Yss, Ysr)`, the current into an end for unit voltage at
    /// that end and at the other end. The model is the travelling-wave line with losses lumped at its ends and middle
    /// (Dommel); its history terms in phasor form give two linear equations in the end currents.
    pub fn two_port(&self, w: f64) -> (C64, C64) {
        let (z, h) = self.z_h();
        let d = C64::from_polar(1.0, -w * self.tau);
        let (a, b) = ((1.0 + h) / 2.0, (1.0 - h) / 2.0);
        let p = C64::ONE + (d * C64::new(b * h, 0.0));
        let q = d.scale(a * h);
        let s = C64::ONE - d.scale(b);
        let u = -d.scale(a);
        let even = (s + u) / (p + q);
        let odd = (s - u) / (p - q);
        ((even + odd).scale(0.5 / z), (even - odd).scale(0.5 / z))
    }
}

/// A transposed three-phase line as travelling waves in Clarke's modal components (zero, α, β).
#[derive(Debug, Clone)]
pub struct Line {
    /// The phase nodes of each end.
    pub ends: [[usize; 3]; 2],
    /// The zero, α and β modes (α and β are the positive sequence's).
    pub modes: [LineMode; 3],
}

/// A three-phase current injected into nodes.
#[derive(Debug, Clone)]
pub struct Injection {
    /// Nodes.
    pub nodes: [usize; 3],
    /// Current phasors into the nodes.
    pub i: [C64; 3],
    /// Whether it injects.
    pub on: bool,
}

/// A circuit.
#[derive(Debug, Clone, Default)]
pub struct Circuit {
    /// Number of nodes.
    pub nodes: usize,
    /// Conductance from every node to the reference, so no part of the circuit floats (an unearthed star point, a
    /// de-energised delta winding).
    pub stray: f64,
    /// Angular frequency of the sources, rad/s.
    pub omega: f64,
    /// R-L branches.
    pub rl: Vec<Rl>,
    /// Capacitances.
    pub caps: Vec<Cap>,
    /// Conductances.
    pub res: Vec<Res>,
    /// Switches.
    pub switches: Vec<Switch>,
    /// Travelling-wave lines.
    pub lines: Vec<Line>,
    /// Current injections.
    pub injections: Vec<Injection>,
}

/// Calls `f(row, col, weight)` for every node pair two ports couple, skipping the reference.
pub(crate) fn couple(pi: &Port, pj: &Port, f: &mut impl FnMut(usize, usize, f64)) {
    for &(ni, ci) in pi {
        if ni == GROUND {
            continue;
        }
        for &(nj, cj) in pj {
            if nj != GROUND {
                f(ni, nj, ci * cj);
            }
        }
    }
}

/// `A·x` for ports `A` and node values `x`.
pub(crate) fn port_values(ports: &[Port], x: &[f64], out: &mut [f64]) {
    for (o, p) in out.iter_mut().zip(ports) {
        *o = p.iter().filter(|(n, _)| *n != GROUND).map(|&(n, c)| x[n] * c).sum();
    }
}

/// `A·x` for ports `A` and node phasors `x`.
pub(crate) fn port_phasors(ports: &[Port], x: &[C64]) -> Vec<C64> {
    ports
        .iter()
        .map(|p| {
            p.iter()
                .filter(|(n, _)| *n != GROUND)
                .fold(C64::ZERO, |s, &(n, c)| s + x[n].scale(c))
        })
        .collect()
}

impl Circuit {
    /// A new node.
    pub fn node(&mut self) -> usize {
        self.nodes += 1;
        self.nodes - 1
    }

    /// Three new nodes.
    pub fn nodes3(&mut self) -> [usize; 3] {
        [self.node(), self.node(), self.node()]
    }

    /// The phase admittance blocks of line `l` at angular frequency `w`: `(Yss, Ysr)` as 3 × 3 complex matrices.
    pub fn line_blocks(l: &Line, w: f64) -> ([C64; 9], [C64; 9]) {
        let q = clarke();
        let mut yss = [C64::ZERO; 9];
        let mut ysr = [C64::ZERO; 9];
        for (k, m) in l.modes.iter().enumerate() {
            let (s, r) = m.two_port(w);
            for i in 0..3 {
                for j in 0..3 {
                    let w = q.at(k, i) * q.at(k, j);
                    yss[i * 3 + j] += s.scale(w);
                    ysr[i * 3 + j] += r.scale(w);
                }
            }
        }
        (yss, ysr)
    }

    /// The admittance matrix of an element's ports at angular frequency `w`, `(R + jωL)⁻¹`.
    pub fn rl_admittance(e: &Rl, w: f64) -> Result<Vec<C64>, String> {
        let m = e.r.m;
        let z: Vec<C64> = (0..m * m).map(|k| C64::new(e.r.a[k], w * e.l.a[k])).collect();
        cinverse(m, &z).ok_or_else(|| "an R-L branch has a singular impedance matrix".to_string())
    }

    /// The sinusoidal steady state at the circuit's frequency: every node's voltage phasor.
    pub fn steady_state(&self) -> Result<Vec<C64>, String> {
        let w = self.omega;
        let n = self.nodes;
        let mut entries: Vec<(usize, usize, C64)> = Vec::new();
        let mut rhs = vec![C64::ZERO; n];
        for i in 0..n {
            entries.push((i, i, C64::new(self.stray, 0.0)));
        }
        let stamp = |ports: &[Port], y: &[C64], entries: &mut Vec<(usize, usize, C64)>| {
            let m = ports.len();
            for p in 0..m {
                for q in 0..m {
                    let yy = y[p * m + q];
                    couple(&ports[p], &ports[q], &mut |i, j, c| entries.push((i, j, yy.scale(c))));
                }
            }
        };
        for e in &self.rl {
            let y = Self::rl_admittance(e, w)?;
            stamp(&e.ports, &y, &mut entries);
            if !e.emf.is_empty() {
                // −Aᵀ·Y·e: the series source drives current out of the ports' positive nodes.
                let m = e.ports.len();
                for (p, port) in e.ports.iter().enumerate() {
                    let ye = (0..m).fold(C64::ZERO, |s, q| s + y[p * m + q] * e.emf[q]);
                    for &(node, c) in port.iter().filter(|(nd, _)| *nd != GROUND) {
                        rhs[node] -= ye.scale(c);
                    }
                }
            }
        }
        for e in &self.caps {
            let y: Vec<C64> = e.c.a.iter().map(|&c| C64::new(0.0, w * c)).collect();
            stamp(&e.ports, &y, &mut entries);
        }
        for e in &self.res {
            let y: Vec<C64> = e.g.a.iter().map(|&g| C64::new(g, 0.0)).collect();
            stamp(&e.ports, &y, &mut entries);
        }
        for s in self.switches.iter().filter(|s| s.closed) {
            let g = C64::new(1.0 / s.r, 0.0);
            let port: Port = vec![(s.a, 1.0), (s.b, -1.0)];
            couple(&port, &port, &mut |i, j, c| entries.push((i, j, g.scale(c))));
        }
        for l in &self.lines {
            let (yss, ysr) = Self::line_blocks(l, w);
            for (k, other) in [(0, 1), (1, 0)] {
                for i in 0..3 {
                    for j in 0..3 {
                        entries.push((l.ends[k][i], l.ends[k][j], yss[i * 3 + j]));
                        entries.push((l.ends[k][i], l.ends[other][j], ysr[i * 3 + j]));
                    }
                }
            }
        }
        for inj in self.injections.iter().filter(|x| x.on) {
            for (&node, &i) in inj.nodes.iter().zip(&inj.i) {
                rhs[node] += i;
            }
        }
        let mut lu = ComplexLu::factor(n, &entries)
            .map_err(|e| format!("the network's steady state could not be solved: {e}"))?;
        lu.solve(&rhs)
            .map_err(|e| format!("the network's steady state could not be solved: {e}"))
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    /// The ABCD matrix of a cascade, multiplied out.
    fn chain(parts: &[[C64; 4]]) -> [C64; 4] {
        parts.iter().fold([C64::ONE, C64::ZERO, C64::ZERO, C64::ONE], |m, p| {
            [
                m[0] * p[0] + m[1] * p[2],
                m[0] * p[1] + m[1] * p[3],
                m[2] * p[0] + m[3] * p[2],
                m[2] * p[1] + m[3] * p[3],
            ]
        })
    }

    #[test]
    fn lossy_two_port_is_the_cascade_of_lumped_resistances_and_lossless_halves() {
        // Dommel's lossy line is exactly R/4, half the line, R/2, half the line, R/4 (EMTP Theory Book, 4.2.2.5).
        let m = LineMode {
            zc: 0.37,
            r: 0.02,
            tau: 0.7e-3,
        };
        let w = 2.0 * std::f64::consts::PI * 50.0;
        for w in [w, 7.0 * w, 31.0 * w] {
            let phi = w * m.tau / 2.0;
            let half = [
                C64::new(phi.cos(), 0.0),
                C64::new(0.0, m.zc * phi.sin()),
                C64::new(0.0, phi.sin() / m.zc),
                C64::new(phi.cos(), 0.0),
            ];
            let res = |r: f64| [C64::ONE, C64::new(r, 0.0), C64::ZERO, C64::ONE];
            let t = chain(&[res(m.r / 4.0), half, res(m.r / 2.0), half, res(m.r / 4.0)]);
            // Y-parameters of a reciprocal symmetric two-port: Yss = D/B, Ysr = −1/B.
            let (yss, ysr) = (t[3] / t[1], -t[1].inv());
            let (s, r) = m.two_port(w);
            assert!((s - yss).abs() < 1e-12 * yss.abs(), "{s:?} {yss:?}");
            assert!((r - ysr).abs() < 1e-12 * ysr.abs(), "{r:?} {ysr:?}");
        }
    }
}
