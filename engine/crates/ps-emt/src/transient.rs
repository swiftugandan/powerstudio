//! Time stepping of a [`Circuit`] by Dommel's method: every element becomes a conductance and a history current
//! source (its companion model), the nodal equations `G·v = i` are solved each step, and the histories advance.
//!
//! The trapezoidal rule integrates the inductances and capacitances. After a switching it would oscillate from step to
//! step on any voltage across an inductance or current into a capacitance that jumped, so the step after a switching
//! is taken as two backward-Euler half steps instead (critical damping adjustment). The companion conductances of the
//! two rules at those step lengths are equal, `(R + 2L/Δt)⁻¹` and `2C/Δt`, so the factorisation is kept; only the
//! histories differ.
//!
//! The circuit starts from its sinusoidal steady state ([`Circuit::steady_state`]): every history, the travelling
//! waves' included, is set from the phasors, so an undisturbed circuit stays where it is.
//!
//! Switches change only between steps. A switch asked to open at a current zero ([`Transient::open_at_zero`]) stays
//! closed until its current changes sign, as a breaker's arc goes out at a current zero, and opens at the first step
//! past it.

use ps_num::C64;
use ps_sparse::{CscBuilder, FaerLu, SparseSolver};

use crate::circuit::{Circuit, GROUND, Port, couple, port_phasors, port_values};
use crate::dense::{Mat, clarke};

/// The waveform of phasor `x` at time `t`, for angular frequency `w`.
pub fn wave(x: C64, w: f64, t: f64) -> f64 {
    std::f64::consts::SQRT_2 * (x.re * (w * t).cos() - x.im * (w * t).sin())
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Rule {
    Trapezoidal,
    /// Backward Euler over half a step.
    HalfEuler,
}

#[derive(Debug)]
struct RlState {
    /// `(R + 2L/Δt)⁻¹`.
    geq: Mat,
    /// `2L/Δt − R`.
    k: Mat,
    /// `2L/Δt`.
    l2: Mat,
    /// Port voltages (the series source's included) and currents at the last point.
    u: Vec<f64>,
    i: Vec<f64>,
    hist: Vec<f64>,
    /// Source voltages at the point being solved.
    e: Vec<f64>,
    tmp: Vec<f64>,
}

#[derive(Debug)]
struct CapState {
    /// `2C/Δt`.
    geq: Mat,
    u: Vec<f64>,
    i: Vec<f64>,
    hist: Vec<f64>,
    tmp: Vec<f64>,
}

#[derive(Debug)]
struct LineState {
    /// Per mode: the impedance seen at an end, the loss factor and the travel time in steps.
    z: [f64; 3],
    h: [f64; 3],
    d: [f64; 3],
    /// Past values per step: end 0's modal voltages and currents, then end 1's.
    buf: Vec<[f64; 12]>,
    /// History currents into the line per end and mode at the point being solved.
    hist: [[f64; 3]; 2],
}

impl LineState {
    fn at(&self, idx: i64) -> &[f64; 12] {
        let cap = self.buf.len() as i64;
        &self.buf[idx.rem_euclid(cap) as usize]
    }

    /// Entry `k` interpolated at fractional step index `x`.
    fn interp(&self, x: f64, k: usize) -> f64 {
        let k0 = x.floor();
        let f = x - k0;
        let a = self.at(k0 as i64)[k];
        if f <= 0.0 {
            a
        } else {
            (1.0 - f) * a + f * self.at(k0 as i64 + 1)[k]
        }
    }
}

/// A circuit being simulated.
#[derive(Debug)]
pub struct Transient {
    /// The circuit, whose switch and injection states the simulation reads at each step.
    pub circuit: Circuit,
    dt: f64,
    n: u64,
    v: Vec<f64>,
    rl: Vec<RlState>,
    caps: Vec<CapState>,
    lines: Vec<LineState>,
    q: Mat,
    sw_i: Vec<f64>,
    /// Switch currents at the last full step, for the current-zero test.
    sw_last: Vec<f64>,
    pending: Vec<bool>,
    lu: FaerLu,
    slot: Vec<usize>,
    values: Vec<f64>,
    factored: bool,
    damp: bool,
    rhs: Vec<f64>,
    /// Factorisations so far.
    pub factorisations: usize,
    /// The steady state the simulation started from: every node's voltage phasor.
    pub initial: Vec<C64>,
}

/// Calls `f(row, col, value)` for every entry of `G`, in an order that does not depend on the values (an open
/// switch gives zeros), so one pass builds the pattern and later passes fill it.
fn emit(
    c: &Circuit,
    rl: &[RlState],
    caps: &[CapState],
    lines: &[LineState],
    q: &Mat,
    f: &mut impl FnMut(usize, usize, f64),
) {
    for i in 0..c.nodes {
        f(i, i, c.stray);
    }
    let stamp = |ports: &[Port], g: &Mat, f: &mut dyn FnMut(usize, usize, f64)| {
        for p in 0..ports.len() {
            for r in 0..ports.len() {
                let x = g.at(p, r);
                couple(&ports[p], &ports[r], &mut |i, j, w| f(i, j, x * w));
            }
        }
    };
    for (e, s) in c.rl.iter().zip(rl) {
        stamp(&e.ports, &s.geq, f);
    }
    for (e, s) in c.caps.iter().zip(caps) {
        stamp(&e.ports, &s.geq, f);
    }
    for e in &c.res {
        stamp(&e.ports, &e.g, f);
    }
    for s in &c.switches {
        let g = if s.closed { 1.0 / s.r } else { 0.0 };
        let port: Port = vec![(s.a, 1.0), (s.b, -1.0)];
        couple(&port, &port, &mut |i, j, w| f(i, j, g * w));
    }
    for (l, s) in c.lines.iter().zip(lines) {
        for end in &l.ends {
            for i in 0..3 {
                for j in 0..3 {
                    let g: f64 = (0..3).map(|k| q.at(k, i) * q.at(k, j) / s.z[k]).sum();
                    f(end[i], end[j], g);
                }
            }
        }
    }
}

impl Transient {
    /// Prepares the simulation of `circuit` with step `dt` (s) from its steady state.
    pub fn new(circuit: Circuit, dt: f64) -> Result<Self, String> {
        if !(dt > 0.0 && dt.is_finite()) {
            return Err("The time step must be above zero.".into());
        }
        let w = circuit.omega;
        let v0 = circuit.steady_state()?;
        let k2 = 2.0 / dt;
        let mut rl = Vec::with_capacity(circuit.rl.len());
        for e in &circuit.rl {
            let m = e.ports.len();
            let geq =
                e.r.plus(k2, &e.l)
                    .inverse()
                    .ok_or("an R-L branch has a singular companion conductance")?;
            let y = Circuit::rl_admittance(e, w)?;
            let mut u = port_phasors(&e.ports, &v0);
            for (x, s) in u.iter_mut().zip(&e.emf) {
                *x += *s;
            }
            let i: Vec<C64> = (0..m)
                .map(|p| (0..m).fold(C64::ZERO, |s, r| s + y[p * m + r] * u[r]))
                .collect();
            rl.push(RlState {
                geq,
                k: e.l.scaled(k2).plus(-1.0, &e.r),
                l2: e.l.scaled(k2),
                u: u.iter().map(|&x| wave(x, w, 0.0)).collect(),
                i: i.iter().map(|&x| wave(x, w, 0.0)).collect(),
                hist: vec![0.0; m],
                e: vec![0.0; m],
                tmp: vec![0.0; m],
            });
        }
        let mut caps = Vec::with_capacity(circuit.caps.len());
        for e in &circuit.caps {
            let m = e.ports.len();
            let u = port_phasors(&e.ports, &v0);
            let i: Vec<C64> = (0..m)
                .map(|p| (0..m).fold(C64::ZERO, |s, r| s + C64::new(0.0, w * e.c.at(p, r)) * u[r]))
                .collect();
            caps.push(CapState {
                geq: e.c.scaled(k2),
                u: u.iter().map(|&x| wave(x, w, 0.0)).collect(),
                i: i.iter().map(|&x| wave(x, w, 0.0)).collect(),
                hist: vec![0.0; m],
                tmp: vec![0.0; m],
            });
        }
        let q = clarke();
        let mut lines = Vec::with_capacity(circuit.lines.len());
        for l in &circuit.lines {
            let mut z = [0.0; 3];
            let mut h = [0.0; 3];
            let mut d = [0.0; 3];
            for (k, m) in l.modes.iter().enumerate() {
                (z[k], h[k]) = m.z_h();
                d[k] = m.tau / dt;
                if d[k].is_nan() || d[k] < 1.0 - 1e-9 {
                    return Err("a travelling-wave line is shorter than one time step".into());
                }
            }
            let cap = d.iter().fold(0.0_f64, |a, &b| a.max(b)).ceil() as usize + 3;
            // Modal phasors of each end's voltages and of the currents into the line.
            let modal = |nodes: &[usize; 3]| -> [C64; 3] {
                let mut out = [C64::ZERO; 3];
                for (k, o) in out.iter_mut().enumerate() {
                    *o = (0..3).fold(C64::ZERO, |s, i| s + v0[nodes[i]].scale(q.at(k, i)));
                }
                out
            };
            let (vm0, vm1) = (modal(&l.ends[0]), modal(&l.ends[1]));
            let mut im0 = [C64::ZERO; 3];
            let mut im1 = [C64::ZERO; 3];
            for (k, m) in l.modes.iter().enumerate() {
                let (s, r) = m.two_port(w);
                im0[k] = s * vm0[k] + r * vm1[k];
                im1[k] = s * vm1[k] + r * vm0[k];
            }
            let mut buf = vec![[0.0; 12]; cap];
            for back in 0..cap as i64 {
                let t = -(back as f64) * dt;
                let mut e = [0.0; 12];
                for k in 0..3 {
                    e[k] = wave(vm0[k], w, t);
                    e[3 + k] = wave(im0[k], w, t);
                    e[6 + k] = wave(vm1[k], w, t);
                    e[9 + k] = wave(im1[k], w, t);
                }
                buf[(-back).rem_euclid(cap as i64) as usize] = e;
            }
            lines.push(LineState {
                z,
                h,
                d,
                buf,
                hist: [[0.0; 3]; 2],
            });
        }
        let sw_i: Vec<f64> = circuit
            .switches
            .iter()
            .map(|s| {
                if !s.closed {
                    return 0.0;
                }
                let at = |n: usize| if n == GROUND { C64::ZERO } else { v0[n] };
                wave((at(s.a) - at(s.b)).scale(1.0 / s.r), w, 0.0)
            })
            .collect();
        let mut builder = CscBuilder::new(circuit.nodes, circuit.nodes);
        emit(&circuit, &rl, &caps, &lines, &q, &mut |i, j, _| {
            builder.push(i, j);
        });
        let (pattern, slot) = builder.build();
        let mut lu = FaerLu::new();
        lu.analyse(&pattern)
            .map_err(|e| format!("The network's matrix could not be ordered: {e}."))?;
        let nodes = circuit.nodes;
        let nsw = circuit.switches.len();
        Ok(Self {
            v: v0.iter().map(|&x| wave(x, w, 0.0)).collect(),
            circuit,
            dt,
            n: 0,
            rl,
            caps,
            lines,
            q,
            sw_last: sw_i.clone(),
            sw_i,
            pending: vec![false; nsw],
            lu,
            values: vec![0.0; pattern.nnz()],
            slot,
            factored: false,
            damp: false,
            rhs: vec![0.0; nodes],
            factorisations: 0,
            initial: v0,
        })
    }

    /// The time of the last solved point, s.
    pub fn time(&self) -> f64 {
        self.n as f64 * self.dt
    }

    /// The step count.
    pub fn steps(&self) -> u64 {
        self.n
    }

    /// The time step, s.
    pub fn dt(&self) -> f64 {
        self.dt
    }

    /// A node's voltage at the last point.
    pub fn voltage(&self, node: usize) -> f64 {
        if node == GROUND { 0.0 } else { self.v[node] }
    }

    /// The current through switch `k` from its first node to its second at the last point.
    pub fn switch_current(&self, k: usize) -> f64 {
        self.sw_i[k]
    }

    /// The current injection `k` gives at the last point, per phase.
    pub fn injection_current(&self, k: usize) -> [f64; 3] {
        let inj = &self.circuit.injections[k];
        let t = self.time();
        if inj.on {
            inj.i.map(|x| wave(x, self.circuit.omega, t))
        } else {
            [0.0; 3]
        }
    }

    /// Whether switch `k` is closed.
    pub fn is_closed(&self, k: usize) -> bool {
        self.circuit.switches[k].closed
    }

    /// Whether switch `k` waits for a current zero to open.
    pub fn is_pending(&self, k: usize) -> bool {
        self.pending[k]
    }

    /// Closes switch `k` now.
    pub fn close(&mut self, k: usize) {
        self.pending[k] = false;
        if !self.circuit.switches[k].closed {
            self.circuit.switches[k].closed = true;
            self.factored = false;
            self.damp = true;
        }
    }

    /// Opens switch `k` now, whatever its current.
    pub fn open(&mut self, k: usize) {
        self.pending[k] = false;
        if self.circuit.switches[k].closed {
            self.circuit.switches[k].closed = false;
            self.factored = false;
            self.damp = true;
        }
    }

    /// Opens switch `k` at its next current zero.
    pub fn open_at_zero(&mut self, k: usize) {
        if self.circuit.switches[k].closed {
            self.pending[k] = true;
        }
    }

    /// Switches injection `k` on or off from the next step.
    pub fn set_injection(&mut self, k: usize, on: bool) {
        if self.circuit.injections[k].on != on {
            self.circuit.injections[k].on = on;
            self.damp = true;
        }
    }

    fn factor(&mut self) -> Result<(), String> {
        self.values.iter_mut().for_each(|x| *x = 0.0);
        let mut k = 0;
        let (values, slot) = (&mut self.values, &self.slot);
        emit(
            &self.circuit,
            &self.rl,
            &self.caps,
            &self.lines,
            &self.q,
            &mut |_, _, x| {
                values[slot[k]] += x;
                k += 1;
            },
        );
        self.lu
            .factor(&self.values)
            .map_err(|e| format!("The network's matrix could not be factorised: {e}."))?;
        self.factored = true;
        self.factorisations += 1;
        Ok(())
    }

    /// Solves the point at time `t` from the last one by `rule`; `store` keeps it as a full step.
    fn substep(&mut self, rule: Rule, t: f64, store: bool) -> Result<(), String> {
        let w = self.circuit.omega;
        self.rhs.iter_mut().for_each(|x| *x = 0.0);
        for (e, s) in self.circuit.rl.iter().zip(self.rl.iter_mut()) {
            match rule {
                Rule::Trapezoidal => {
                    s.k.mul_vec(&s.i, &mut s.tmp);
                    for (x, u) in s.tmp.iter_mut().zip(&s.u) {
                        *x += u;
                    }
                }
                Rule::HalfEuler => s.l2.mul_vec(&s.i, &mut s.tmp),
            }
            s.geq.mul_vec(&s.tmp, &mut s.hist);
            for (x, &p) in s.e.iter_mut().zip(&e.emf) {
                *x = wave(p, w, t);
            }
            // The series source and the history drive −Aᵀ·(Geq·e + hist) into the nodes.
            s.geq.mul_vec(&s.e, &mut s.tmp);
            for ((port, x), h) in e.ports.iter().zip(&s.tmp).zip(&s.hist) {
                let drive = if e.emf.is_empty() { *h } else { x + h };
                for &(node, c) in port.iter().filter(|(n, _)| *n != GROUND) {
                    self.rhs[node] -= c * drive;
                }
            }
        }
        for (e, s) in self.circuit.caps.iter().zip(self.caps.iter_mut()) {
            s.geq.mul_vec(&s.u, &mut s.tmp);
            for ((h, x), i) in s.hist.iter_mut().zip(&s.tmp).zip(&s.i) {
                *h = match rule {
                    Rule::Trapezoidal => -(x + i),
                    Rule::HalfEuler => -x,
                };
            }
            for (port, h) in e.ports.iter().zip(&s.hist) {
                for &(node, c) in port.iter().filter(|(n, _)| *n != GROUND) {
                    self.rhs[node] -= c * h;
                }
            }
        }
        let at = t / self.dt;
        for (l, s) in self.circuit.lines.iter().zip(self.lines.iter_mut()) {
            for k in 0..3 {
                let x = at - s.d[k];
                let (z, h) = (s.z[k], s.h[k]);
                let (a, b) = ((1.0 + h) / 2.0, (1.0 - h) / 2.0);
                let v0 = s.interp(x, k);
                let i0 = s.interp(x, 3 + k);
                let v1 = s.interp(x, 6 + k);
                let i1 = s.interp(x, 9 + k);
                s.hist[0][k] = -a * (v1 / z + h * i1) - b * (v0 / z + h * i0);
                s.hist[1][k] = -a * (v0 / z + h * i0) - b * (v1 / z + h * i1);
            }
            for (end, hist) in l.ends.iter().zip(&s.hist) {
                for (i, &node) in end.iter().enumerate() {
                    let phase: f64 = (0..3).map(|k| self.q.at(k, i) * hist[k]).sum();
                    self.rhs[node] -= phase;
                }
            }
        }
        for inj in self.circuit.injections.iter().filter(|x| x.on) {
            for (&node, &i) in inj.nodes.iter().zip(&inj.i) {
                self.rhs[node] += wave(i, w, t);
            }
        }
        self.v.copy_from_slice(&self.rhs);
        self.lu
            .solve(&mut self.v)
            .map_err(|e| format!("The network's equations could not be solved: {e}."))?;
        if self.v.iter().any(|x| !x.is_finite()) {
            return Err("the network's equations gave no finite solution".into());
        }
        let v = &self.v;
        for (e, s) in self.circuit.rl.iter().zip(self.rl.iter_mut()) {
            port_values(&e.ports, v, &mut s.u);
            for (u, x) in s.u.iter_mut().zip(&s.e) {
                *u += x;
            }
            s.geq.mul_vec(&s.u, &mut s.i);
            for (i, h) in s.i.iter_mut().zip(&s.hist) {
                *i += h;
            }
        }
        for (e, s) in self.circuit.caps.iter().zip(self.caps.iter_mut()) {
            port_values(&e.ports, v, &mut s.u);
            s.geq.mul_vec(&s.u, &mut s.i);
            for (i, h) in s.i.iter_mut().zip(&s.hist) {
                *i += h;
            }
        }
        for (k, sw) in self.circuit.switches.iter().enumerate() {
            let at = |n: usize| if n == GROUND { 0.0 } else { v[n] };
            self.sw_i[k] = if sw.closed { (at(sw.a) - at(sw.b)) / sw.r } else { 0.0 };
        }
        if store {
            let idx = self.n as i64 + 1;
            for (l, s) in self.circuit.lines.iter().zip(self.lines.iter_mut()) {
                let mut e = [0.0; 12];
                for (end, nodes) in l.ends.iter().enumerate() {
                    for k in 0..3 {
                        let vm: f64 = (0..3).map(|i| self.q.at(k, i) * v[nodes[i]]).sum();
                        e[6 * end + k] = vm;
                        e[6 * end + 3 + k] = vm / s.z[k] + s.hist[end][k];
                    }
                }
                let cap = s.buf.len() as i64;
                s.buf[idx.rem_euclid(cap) as usize] = e;
            }
        }
        Ok(())
    }

    /// Advances one step. Returns the switches that opened at a current zero during it.
    pub fn step(&mut self) -> Result<Vec<usize>, String> {
        if !self.factored {
            self.factor()?;
        }
        let next = (self.n + 1) as f64 * self.dt;
        if self.damp {
            self.substep(Rule::HalfEuler, (self.n as f64 + 0.5) * self.dt, false)?;
            self.substep(Rule::HalfEuler, next, true)?;
            self.damp = false;
        } else {
            self.substep(Rule::Trapezoidal, next, true)?;
        }
        self.n += 1;
        let mut opened = Vec::new();
        for k in 0..self.sw_i.len() {
            // A sign change, or no current at all; a switch closed in the last step has no previous current to compare.
            if self.pending[k] && (self.sw_i[k] * self.sw_last[k] < 0.0 || self.sw_i[k] == 0.0) {
                opened.push(k);
            }
            self.sw_last[k] = self.sw_i[k];
        }
        for &k in &opened {
            self.open(k);
        }
        Ok(opened)
    }
}
