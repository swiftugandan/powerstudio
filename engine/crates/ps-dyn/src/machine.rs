//! Synchronous machines: the classical model (PSS/E GENCLS) and the round-rotor model (PSS/E GENROU).
//!
//! Both are written on the system base (reactances converted from the machine's rating, inertia and damping scaled
//! by rating over system base) in the machine's own d-q frame, which turns with the rotor angle δ: a network
//! quantity `X` reads `X·e^(−j(δ − π/2)) = Xd + jXq` in it. The stator is algebraic and neglects the speed's effect on
//! its voltages, so the air-gap torque equals the electrical power plus the stator losses. The swing equation is
//! `M·dω/dt = Tm − Te − D·(ω − 1)` with `M = 2H` and `dδ/dt = ωb·(ω − 1)`.
//!
//! The round rotor has transient and subtransient circuits on both axes (`e′q`, `e′d`, `ψ″d`-side `e″d`, `e″q`) with
//! X″d = X″q, and quadratic saturation of the air-gap flux applied to the d axis and, scaled by
//! `(Xq − Xl)/(Xd − Xl)`, to the q axis. Its initial state follows the closed form of OpenIPSL's GENROU, which ANDES
//! uses, so both start from the same point.

use ps_num::C64;
use std::f64::consts::FRAC_PI_2;

use crate::block::{Layout, Saturation};
use crate::scalar::Scalar;

/// Machine data on the system base.
#[derive(Debug, Clone)]
pub struct Machine {
    /// `2H`, s.
    pub m: f64,
    /// Damping.
    pub d: f64,
    /// Stator resistance.
    pub ra: f64,
    /// Base angular speed, rad/s.
    pub wb: f64,
    /// The rotor model.
    pub rotor: Rotor,
    /// Index of the rotor angle in the unit's variables.
    pub delta: usize,
    /// Index of the speed.
    pub omega: usize,
    /// Initial field voltage, p.u. (machine base).
    pub vf0: f64,
    /// Initial mechanical torque, p.u. (system base).
    pub tm0: f64,
}

/// How the rotor is modelled.
#[derive(Debug, Clone)]
pub enum Rotor {
    /// A voltage behind the transient reactance.
    Classical {
        /// Transient reactance X′d.
        x: f64,
    },
    /// The round rotor.
    Round(Box<Round>),
}

/// Round-rotor data and variable indices.
#[derive(Debug, Clone)]
pub struct Round {
    /// Reactances on the system base.
    pub xd: f64,
    /// q-axis synchronous reactance.
    pub xq: f64,
    /// d-axis transient reactance.
    pub xd1: f64,
    /// q-axis transient reactance.
    pub xq1: f64,
    /// Subtransient reactance (both axes).
    pub xd2: f64,
    /// Leakage reactance.
    pub xl: f64,
    /// Air-gap saturation.
    pub sat: Saturation,
    gd1: f64,
    gq1: f64,
    gd2: f64,
    gq2: f64,
    gqd: f64,
    /// Indices of e′q, e′d, e″d, e″q.
    pub e1q: usize,
    /// e′d.
    pub e1d: usize,
    /// e″d.
    pub e2d: usize,
    /// e″q.
    pub e2q: usize,
}

/// Round-rotor data as given: system-base reactances and seconds.
#[derive(Debug, Clone, Copy)]
pub struct RoundData {
    /// Xd.
    pub xd: f64,
    /// Xq.
    pub xq: f64,
    /// X′d.
    pub xd1: f64,
    /// X′q.
    pub xq1: f64,
    /// X″d = X″q.
    pub xd2: f64,
    /// Xl.
    pub xl: f64,
    /// T′d0.
    pub td10: f64,
    /// T″d0.
    pub td20: f64,
    /// T′q0.
    pub tq10: f64,
    /// T″q0.
    pub tq20: f64,
    /// S(1.0).
    pub s10: f64,
    /// S(1.2).
    pub s12: f64,
}

/// What the machine's stator gives its controls and the network, for given states and terminal voltage.
#[derive(Debug, Clone, Copy)]
pub struct Stator<S> {
    /// Terminal voltage in the d-q frame.
    pub vd: S,
    /// q component.
    pub vq: S,
    /// Stator current in the d-q frame (system base).
    pub id: S,
    /// q component.
    pub iq: S,
    /// Air-gap torque, p.u. on the system base.
    pub te: S,
    /// Electrical power out of the terminals.
    pub pe: S,
    /// Reactive power out of the terminals.
    pub qe: S,
    /// Field current in the PSS/E per-unit system (Xad·Ifd).
    pub xadifd: S,
    /// Terminal voltage magnitude.
    pub vt: S,
    /// Speed, p.u.
    pub omega: S,
    /// Current injected into the network, real part.
    pub ir: S,
    /// Imaginary part.
    pub ii: S,
    xaqi1q: S,
}

impl Machine {
    /// A classical machine; adds its variables to the layout.
    pub fn classical(layout: &mut Layout, m: f64, d: f64, ra: f64, x: f64, wb: f64) -> Self {
        let (delta, omega) = (layout.add("machine", "delta", 1.0), layout.add("machine", "omega", m));
        Self {
            m,
            d,
            ra,
            wb,
            rotor: Rotor::Classical { x },
            delta,
            omega,
            vf0: 0.0,
            tm0: 0.0,
        }
    }

    /// A round-rotor machine; adds its variables to the layout.
    pub fn round(layout: &mut Layout, m: f64, d: f64, ra: f64, r: RoundData, wb: f64) -> Self {
        let (delta, omega) = (layout.add("machine", "delta", 1.0), layout.add("machine", "omega", m));
        let e1q = layout.add("machine", "e1q", r.td10);
        let e1d = layout.add("machine", "e1d", r.tq10);
        let e2d = layout.add("machine", "e2d", r.td20);
        let e2q = layout.add("machine", "e2q", r.tq20);
        let round = Round {
            xd: r.xd,
            xq: r.xq,
            xd1: r.xd1,
            xq1: r.xq1,
            xd2: r.xd2,
            xl: r.xl,
            sat: Saturation::new(1.0, r.s10, 1.2, r.s12),
            gd1: (r.xd2 - r.xl) / (r.xd1 - r.xl),
            gq1: (r.xd2 - r.xl) / (r.xq1 - r.xl),
            gd2: (r.xd1 - r.xd2) / (r.xd1 - r.xl).powi(2),
            gq2: (r.xq1 - r.xd2) / (r.xq1 - r.xl).powi(2),
            gqd: (r.xq - r.xl) / (r.xd - r.xl),
            e1q,
            e1d,
            e2d,
            e2q,
        };
        Self {
            m,
            d,
            ra,
            wb,
            rotor: Rotor::Round(Box::new(round)),
            delta,
            omega,
            vf0: 0.0,
            tm0: 0.0,
        }
    }

    /// The stator for the unit's variables `x`, terminal voltage `v = (Vr, Vi)` and field voltage `vf`.
    pub fn stator<S: Scalar>(&self, x: &[S], v: [S; 2], vf: S) -> Stator<S> {
        let (delta, omega) = (x[self.delta], x[self.omega]);
        let (s, c) = (delta.sin(), delta.cos());
        let vd = v[0] * s - v[1] * c;
        let vq = v[0] * c + v[1] * s;
        // Flux behind the subtransient (or transient) reactance, and that reactance.
        let (psi2d, psi2q, x2, sat) = match &self.rotor {
            Rotor::Classical { x } => (vf, S::cst(0.0), *x, None),
            Rotor::Round(r) => {
                let psi2d = x[r.e1q] * r.gd1 + x[r.e2d] * (r.gd2 * (r.xd1 - r.xl));
                let psi2q = x[r.e1d] * r.gq1 + x[r.e2q] * (1.0 - r.gq1);
                let psi2 = (psi2d.sq() + psi2q.sq()).sqrt();
                let se = if psi2.v() > 0.0 {
                    r.sat.product(psi2) / psi2
                } else {
                    S::cst(0.0)
                };
                (psi2d, psi2q, r.xd2, Some((r, se)))
            }
        };
        // x2·Id + ra·Iq = ψ″d − vq; −ra·Id + x2·Iq = vd − ψ″q.
        let det = x2 * x2 + self.ra * self.ra;
        let (a, b) = (psi2d - vq, vd - psi2q);
        let id = (a * x2 - b * self.ra) / det;
        let iq = (a * self.ra + b * x2) / det;
        let te = (iq * self.ra + vq) * iq + (id * self.ra + vd) * id;
        let (xadifd, xaqi1q) = match sat {
            None => (S::cst(self.vf0), S::cst(0.0)),
            Some((r, se)) => (
                x[r.e1q] + (id * r.gd1 - x[r.e2d] * r.gd2 + x[r.e1q] * r.gd2) * (r.xd - r.xd1) + se * psi2d,
                x[r.e1d] + (x[r.e1d] * r.gq2 - x[r.e2q] * r.gq2 - iq * r.gq1) * (r.xq - r.xq1) + se * psi2q * r.gqd,
            ),
        };
        Stator {
            vd,
            vq,
            id,
            iq,
            te,
            pe: vd * id + vq * iq,
            qe: vq * id - vd * iq,
            xadifd,
            vt: (v[0].sq() + v[1].sq()).sqrt(),
            omega,
            ir: id * s + iq * c,
            ii: iq * s - id * c,
            xaqi1q,
        }
    }

    /// The right-hand sides of the machine's variables for mechanical torque `tm` and field voltage `vf`.
    pub fn derivatives<S: Scalar>(&self, x: &[S], st: &Stator<S>, vf: S, tm: S, f: &mut [S]) {
        f[self.delta] = (x[self.omega] - 1.0) * self.wb;
        f[self.omega] = tm - st.te - (x[self.omega] - 1.0) * self.d;
        if let Rotor::Round(r) = &self.rotor {
            f[r.e1q] = vf - st.xadifd;
            f[r.e1d] = -st.xaqi1q;
            f[r.e2d] = x[r.e1q] - x[r.e2d] - st.id * (r.xd1 - r.xl);
            f[r.e2q] = x[r.e1d] - x[r.e2q] + st.iq * (r.xq1 - r.xl);
        }
    }

    /// Sets the initial state for terminal voltage `v` and power out of the terminals `s` (system base), and records
    /// the initial field voltage and torque.
    pub fn init(&mut self, x: &mut [f64], v: C64, s: C64) -> Result<(), String> {
        let i = (s / v).conj();
        if !(i.re.is_finite() && i.im.is_finite()) {
            return Err("its terminal voltage is zero".into());
        }
        x[self.omega] = 1.0;
        match &self.rotor {
            Rotor::Classical { x: xd1 } => {
                let e = v + i * C64::new(self.ra, *xd1);
                let delta = e.arg();
                x[self.delta] = delta;
                // The d-q frame: X·e^(−j(δ − π/2)).
                let rot = C64::from_polar(1.0, FRAC_PI_2 - delta);
                let (vdq, idq) = (v * rot, i * rot);
                self.vf0 = (vdq.im + self.ra * idq.im) + xd1 * idq.re;
                self.tm0 = (vdq.im + self.ra * idq.im) * idq.im + (vdq.re + self.ra * idq.re) * idq.re;
            }
            Rotor::Round(r) => {
                let zs = C64::new(self.ra, r.xd2);
                let psi20 = i * zs + v;
                let (psi_abs, psi_arg) = (psi20.abs(), psi20.arg());
                let se0 = if r.sat.b > 0.0 && psi_abs >= r.sat.a {
                    r.sat.product(psi_abs) / psi_abs
                } else {
                    0.0
                };
                let a = psi_abs * (1.0 + se0 * r.gqd);
                let b = i.abs() * (r.xd2 - r.xq);
                let theta = psi_arg - i.arg();
                let delta = (b * theta.cos() / (b * theta.sin() - a)).atan() + psi_arg;
                let tdq = C64::from_polar(1.0, -delta);
                let psi_dq = psi20 * tdq;
                let i_dq = (i * tdq).conj();
                let (psi2d0, psi2q0) = (psi_dq.re, -psi_dq.im);
                let (id0, iq0) = (i_dq.im, i_dq.re);
                let vd0 = psi2q0 + r.xd2 * iq0 - self.ra * id0;
                let vq0 = psi2d0 - r.xd2 * id0 - self.ra * iq0;
                self.tm0 = (vq0 + self.ra * iq0) * iq0 + (vd0 + self.ra * id0) * id0;
                self.vf0 = (se0 + 1.0) * psi2d0 + (r.xd - r.xd2) * id0;
                x[self.delta] = delta;
                x[r.e1q] = id0 * (r.xd1 - r.xd) - se0 * psi2d0 + self.vf0;
                x[r.e1d] = iq0 * (r.xq - r.xq1) - se0 * r.gqd * psi2q0;
                x[r.e2d] = id0 * (r.xl - r.xd) - se0 * psi2d0 + self.vf0;
                x[r.e2q] = -iq0 * (r.xl - r.xq) - se0 * r.gqd * psi2q0;
            }
        }
        if !(self.vf0.is_finite() && self.tm0.is_finite()) {
            return Err("its initial state could not be computed".into());
        }
        Ok(())
    }
}
