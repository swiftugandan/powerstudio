//! A generating unit: a machine with its exciter, governor and stabiliser, evaluated together.
//!
//! The unit's variables are the machine's, then each control's, then the field voltage as an algebraic variable when
//! an exciter sets it (so the exciter may read the stator currents the field voltage drives, as ESST3A does, without
//! an ordering problem). One evaluation computes, in this order: the stator for the terminal voltage, the governor's
//! mechanical power, the stabiliser's signal, the exciter's field voltage, and the machine's right-hand sides.

use ps_num::C64;

use crate::block::Layout;
use crate::exciter::Exciter;
use crate::governor::Governor;
use crate::machine::{Machine, Stator};
use crate::scalar::Scalar;
use crate::stabiliser::Stabiliser;

/// A machine and its controls.
#[derive(Debug, Clone)]
pub struct Unit {
    /// The machine.
    pub machine: Machine,
    /// Its exciter.
    pub exciter: Option<Exciter>,
    /// Its governor.
    pub governor: Option<Governor>,
    /// Its stabiliser (acting through the exciter).
    pub stabiliser: Option<Stabiliser>,
    /// The field voltage variable, when an exciter sets it.
    pub vf: Option<usize>,
    /// The unit's variables.
    pub layout: Layout,
}

/// What one evaluation reports besides the right-hand sides.
#[derive(Debug, Clone, Copy)]
pub struct Output<S> {
    /// The stator.
    pub stator: Stator<S>,
    /// Field voltage.
    pub vf: S,
    /// Mechanical power, system base.
    pub tm: S,
}

impl Unit {
    /// Writes the right-hand side of every variable, and the limits of anti-windup variables, for the unit's
    /// variables `x` and terminal voltage `v`. Returns the stator (with the current injected into the network), field
    /// voltage and mechanical power.
    pub fn eval<S: Scalar>(&self, x: &[S], v: [S; 2], f: &mut [S], lim: &mut [Option<(f64, f64)>]) -> Output<S> {
        let vf = self.vf.map_or(S::cst(self.machine.vf0), |k| x[k]);
        let stator = self.machine.stator(x, v, vf);
        let tm = match &self.governor {
            Some(g) => g.eval(x, f, lim, stator.omega),
            None => S::cst(self.machine.tm0),
        };
        let vs = match &self.stabiliser {
            Some(s) => s.eval(x, f, &stator, tm),
            None => S::cst(0.0),
        };
        if let (Some(e), Some(k)) = (&self.exciter, self.vf) {
            f[k] = e.eval(x, f, lim, &stator, vs) - x[k];
        }
        self.machine.derivatives(x, &stator, vf, tm, f);
        Output { stator, vf, tm }
    }

    /// Sets every variable's initial value for terminal voltage `v` and power out of the terminals `s` (system base),
    /// and each control's reference. Notes record limits widened to the operating point.
    pub fn init(&mut self, v: C64, s: C64, notes: &mut Vec<String>) -> Result<Vec<f64>, String> {
        let mut x = vec![0.0; self.layout.len()];
        self.machine.init(&mut x, v, s)?;
        let vf0 = self.machine.vf0;
        if let Some(k) = self.vf {
            x[k] = vf0;
        }
        let stator = self.machine.stator(&x, [v.re, v.im], vf0);
        let tm0 = self.machine.tm0;
        if let Some(g) = &mut self.governor {
            g.init(&mut x, tm0, notes)?;
        }
        let vs0 = match &mut self.stabiliser {
            Some(st) => st.init(&mut x, &stator, tm0),
            None => 0.0,
        };
        if let Some(e) = &mut self.exciter {
            e.init(&mut x, vf0, &stator, vs0, notes)?;
        }
        Ok(x)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::panic)]
mod tests {
    use super::*;
    use crate::exciter::Rating;
    use crate::machine::RoundData;
    use crate::scalar::Dual;
    use ps_model::{Controller, ControllerKind, Slot};

    /// A round-rotor unit on the system base with one control of `kind` (and SEXS when it is a stabiliser), each
    /// with its typical data.
    fn unit(kind: ControllerKind) -> Unit {
        let mut layout = Layout::default();
        let data = RoundData {
            xd: 1.8,
            xq: 1.7,
            xd1: 0.3,
            xq1: 0.55,
            xd2: 0.25,
            xl: 0.2,
            td10: 8.0,
            td20: 0.03,
            tq10: 0.4,
            tq20: 0.05,
            s10: 0.09,
            s12: 0.38,
        };
        let machine = Machine::round(&mut layout, 13.0, 1.0, 0.003, data, 2.0 * std::f64::consts::PI * 50.0);
        let control = |k: ControllerKind| Controller {
            kind: k,
            values: k.defaults().to_vec(),
        };
        let governor =
            (kind.slot() == Slot::Governor).then(|| Governor::new(&control(kind), &mut layout, 1.0).unwrap());
        let stabiliser =
            (kind.slot() == Slot::Stabiliser).then(|| Stabiliser::new(&control(kind), &mut layout, 1.0).unwrap());
        let exc = if kind.slot() == Slot::Exciter {
            kind
        } else {
            ControllerKind::Sexs
        };
        let exciter = Some(Exciter::new(&control(exc), &mut layout, Rating { sn_sb: 1.0 }).unwrap());
        let vf = Some(layout.add("machine", "vf", 0.0));
        Unit {
            machine,
            exciter,
            governor,
            stabiliser,
            vf,
            layout,
        }
    }

    /// The right-hand sides and the injected current, as one vector, at local variables `x` and voltage `v`.
    fn residual(u: &Unit, x: &[f64], v: [f64; 2]) -> Vec<f64> {
        let mut f = vec![0.0; x.len()];
        let mut lim = vec![None; x.len()];
        let out = u.eval(x, v, &mut f, &mut lim);
        f.extend([out.stator.ir, out.stator.ii]);
        f
    }

    #[test]
    fn every_model_starts_in_equilibrium() {
        for kind in ControllerKind::ALL {
            let mut u = unit(kind);
            let v = ps_num::C64::from_polar(1.02, 0.1);
            let x = u.init(v, ps_num::C64::new(0.7, 0.2), &mut Vec::new()).unwrap();
            let f = residual(&u, &x, [v.re, v.im]);
            for (k, fk) in f[..x.len()].iter().enumerate() {
                assert!(
                    fk.abs() < 1e-9,
                    "{}: {} has right-hand side {fk:e} at the start",
                    kind.name(),
                    u.layout.names[k]
                );
            }
        }
    }

    #[test]
    fn dual_number_jacobians_match_finite_differences() {
        for kind in ControllerKind::ALL {
            let mut u = unit(kind);
            let v0 = ps_num::C64::from_polar(1.02, 0.1);
            let mut x = u.init(v0, ps_num::C64::new(0.7, 0.2), &mut Vec::new()).unwrap();
            // Away from equilibrium, inside every limit.
            for (k, xk) in x.iter_mut().enumerate() {
                *xk += 1e-3 * ((k as f64 * 0.7).sin());
            }
            let v = [v0.re * 0.99, v0.im * 1.01];
            let m = x.len();
            let base: Vec<f64> = x.iter().copied().chain(v).collect();
            for col in 0..m + 2 {
                let duals: Vec<Dual> = base.iter().enumerate().map(|(i, &b)| Dual::var(b, i == col)).collect();
                let mut f = vec![Dual::default(); m];
                let mut lim = vec![None; m];
                let out = u.eval(&duals[..m], [duals[m], duals[m + 1]], &mut f, &mut lim);
                let exact: Vec<f64> = f
                    .iter()
                    .map(|d| d.d)
                    .chain([out.stator.ir.d, out.stator.ii.d])
                    .collect();
                let h = 1e-6 * base[col].abs().max(1.0);
                let at = |s: f64| {
                    let mut p = base.clone();
                    p[col] += s;
                    residual(&u, &p[..m], [p[m], p[m + 1]])
                };
                let (hi, lo) = (at(h), at(-h));
                for row in 0..m + 2 {
                    let fd = (hi[row] - lo[row]) / (2.0 * h);
                    let scale = fd.abs().max(exact[row].abs()).max(1.0);
                    assert!(
                        (fd - exact[row]).abs() < 1e-6 * scale,
                        "{}: ∂{}/∂{} is {} by dual numbers and {fd} by finite differences",
                        kind.name(),
                        if row < m {
                            u.layout.names[row].as_str()
                        } else {
                            ["Ir", "Ii"][row - m]
                        },
                        if col < m {
                            u.layout.names[col].as_str()
                        } else {
                            ["Vr", "Vi"][col - m]
                        },
                        exact[row]
                    );
                }
            }
        }
    }
}
