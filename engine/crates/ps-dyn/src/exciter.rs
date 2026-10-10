//! Excitation systems: SEXS, IEEET1, EXDC2, ESDC2A, EXST1, ESST1A and ESST3A, in the PSS/E model library's per-unit system
//! (field voltage and current on the machine's base, so `Xad·Ifd` = 1 at no-load rated voltage).
//!
//! Every model sums its voltage reference, the measured terminal voltage and the stabiliser's signal `Vs` at its
//! input, and returns the field voltage. The reference is set at initialisation so the model starts in equilibrium.
//! Where a published form leaves a choice open the forms of ANDES are followed, since ANDES is the reference these
//! models are tested against: EXDC2 multiplies its output by the speed, ESDC2A and IEEET1 read a VRMAX of zero as no
//! upper limit, and the ESDC2A and IEEET1 regulator limits scale with the terminal voltage only for ESDC2A.

use ps_model::{Controller, ControllerKind};

use crate::block::{Layout, Saturation, lag, lead_lag, washout, widen};
use crate::machine::Stator;
use crate::scalar::Scalar;

/// An exciter with its data, variable indices and voltage reference.
#[derive(Debug, Clone)]
pub enum Exciter {
    /// SEXS.
    Sexs(Sexs),
    /// IEEET1.
    Ieeet1(Ieeet1),
    /// EXDC2 and ESDC2A.
    Dc2(Dc2),
    /// EXST1.
    St1(St1),
    /// ESST1A.
    St1a(St1a),
    /// ESST3A.
    St3a(St3a),
}

/// Machine data an exciter needs: the rating over the system base, to read stator currents on the machine's base.
#[derive(Debug, Clone, Copy)]
pub struct Rating {
    /// Machine rating over system base.
    pub sn_sb: f64,
}

/// Reads a parameter by name.
fn p(c: &Controller, name: &str) -> f64 {
    c.get(name)
}

/// A time constant that must be above zero.
fn positive(c: &Controller, name: &str) -> Result<f64, String> {
    let v = p(c, name);
    if v > 0.0 {
        Ok(v)
    } else {
        Err(format!("{} needs {name} above zero", c.kind.name()))
    }
}

/// A gain that must not be zero.
fn nonzero(c: &Controller, name: &str) -> Result<f64, String> {
    let v = p(c, name);
    if v != 0.0 {
        Ok(v)
    } else {
        Err(format!("{} needs {name} other than zero", c.kind.name()))
    }
}

impl Exciter {
    /// The exciter a control describes; adds its variables to the layout.
    pub fn new(c: &Controller, layout: &mut Layout, rating: Rating) -> Result<Self, String> {
        let name = c.kind.name();
        Ok(match c.kind {
            ControllerKind::Sexs => {
                let tb = p(c, "TB");
                Self::Sexs(Sexs {
                    ta: p(c, "TA/TB") * tb,
                    tb,
                    k: nonzero(c, "K")?,
                    emin: p(c, "EMIN"),
                    emax: p(c, "EMAX"),
                    ll: layout.add(name, "LL_x", tb),
                    law: layout.add(name, "LAW_y", p(c, "TE")),
                    vref: 0.0,
                })
            }
            ControllerKind::Ieeet1 => {
                let vrmax = p(c, "VRMAX");
                Self::Ieeet1(Ieeet1 {
                    ka: nonzero(c, "KA")?,
                    vrmax: if vrmax == 0.0 { 999.0 } else { vrmax },
                    vrmin: p(c, "VRMIN"),
                    ke: p(c, "KE"),
                    kf: p(c, "KF"),
                    tf: p(c, "TF"),
                    sat: Saturation::new(p(c, "E1"), p(c, "SE1"), p(c, "E2"), p(c, "SE2")),
                    lg: layout.add(name, "LG_y", p(c, "TR")),
                    la: layout.add(name, "LA_y", p(c, "TA")),
                    int: layout.add(name, "INT_y", positive(c, "TE")?),
                    wf: layout.add(name, "WF_x", p(c, "TF")),
                    vref: 0.0,
                })
            }
            ControllerKind::Exdc2 | ControllerKind::Esdc2a => {
                let esdc2a = c.kind == ControllerKind::Esdc2a;
                let vrmax = p(c, "VRMAX");
                Self::Dc2(Dc2 {
                    esdc2a,
                    ka: nonzero(c, "KA")?,
                    tb: p(c, "TB"),
                    tc: p(c, "TC"),
                    vrmax: if esdc2a && vrmax == 0.0 { 999.0 } else { vrmax },
                    vrmin: p(c, "VRMIN"),
                    ke: p(c, "KE"),
                    kf: p(c, "KF"),
                    tf1: p(c, "TF1"),
                    sat: Saturation::new(p(c, "E1"), p(c, "SE1"), p(c, "E2"), p(c, "SE2")),
                    lg: layout.add(name, "LG_y", p(c, "TR")),
                    ll: layout.add(name, "LL_x", p(c, "TB")),
                    la: layout.add(name, "LA_y", p(c, "TA")),
                    vp: layout.add(name, "VP", positive(c, "TE")?),
                    wf: layout.add(name, "WF_x", p(c, "TF1")),
                    vref: 0.0,
                })
            }
            ControllerKind::Exst1 => Self::St1(St1 {
                vimax: p(c, "VIMAX"),
                vimin: p(c, "VIMIN"),
                tc: p(c, "TC"),
                tb: p(c, "TB"),
                ka: nonzero(c, "KA")?,
                vrmax: p(c, "VRMAX"),
                vrmin: p(c, "VRMIN"),
                kc: p(c, "KC"),
                kf: p(c, "KF"),
                tf: p(c, "TF"),
                lg: layout.add(name, "LG_y", p(c, "TR")),
                ll: layout.add(name, "LL_x", p(c, "TB")),
                lr: layout.add(name, "LR_y", p(c, "TA")),
                wf: layout.add(name, "WF_x", p(c, "TF")),
                vref: 0.0,
            }),
            ControllerKind::Esst1a => Self::St1a(St1a {
                vimax: p(c, "VIMAX"),
                vimin: p(c, "VIMIN"),
                tc: p(c, "TC"),
                tb: p(c, "TB"),
                tc1: p(c, "TC1"),
                tb1: p(c, "TB1"),
                ka: nonzero(c, "KA")?,
                vamax: p(c, "VAMAX"),
                vamin: p(c, "VAMIN"),
                vrmax: p(c, "VRMAX"),
                vrmin: p(c, "VRMIN"),
                kc: p(c, "KC"),
                kf: p(c, "KF"),
                tf: p(c, "TF"),
                klr: p(c, "KLR"),
                ilr: p(c, "ILR"),
                lg: layout.add(name, "LG_y", p(c, "TR")),
                ll: layout.add(name, "LL_x", p(c, "TB")),
                ll1: layout.add(name, "LL1_x", p(c, "TB1")),
                va: layout.add(name, "VA", p(c, "TA")),
                wf: layout.add(name, "WF_x", p(c, "TF")),
                vref: 0.0,
            }),
            ControllerKind::Esst3a => {
                let (kp, theta) = (p(c, "KP"), p(c, "THETAP").to_radians());
                Self::St3a(St3a {
                    vimax: p(c, "VIMAX"),
                    vimin: p(c, "VIMIN"),
                    km: nonzero(c, "KM")?,
                    tc: p(c, "TC"),
                    tb: p(c, "TB"),
                    ka: nonzero(c, "KA")?,
                    vrmax: p(c, "VRMAX"),
                    vrmin: p(c, "VRMIN"),
                    kg: p(c, "KG"),
                    kpr: kp * theta.cos(),
                    kpi: kp * theta.sin(),
                    ki: p(c, "KI"),
                    vbmax: p(c, "VBMAX"),
                    kc: p(c, "KC"),
                    xl: p(c, "XL"),
                    vgmax: p(c, "VGMAX"),
                    vmmax: p(c, "VMMAX"),
                    vmmin: p(c, "VMMIN"),
                    sb_sn: 1.0 / rating.sn_sb,
                    lg: layout.add(name, "LG_y", p(c, "TR")),
                    ll: layout.add(name, "LL_x", p(c, "TB")),
                    vr: layout.add(name, "VR", p(c, "TA")),
                    vm: layout.add(name, "VM", p(c, "TM")),
                    vref: 0.0,
                })
            }
            _ => return Err(format!("{name} is not an exciter")),
        })
    }

    /// The field voltage for the unit's variables, the machine's stator and the stabiliser's signal; writes the
    /// right-hand sides of the exciter's variables and the limits of those with anti-windup limits.
    pub fn eval<S: Scalar>(&self, x: &[S], f: &mut [S], lim: &mut [Option<(f64, f64)>], st: &Stator<S>, vs: S) -> S {
        match self {
            Self::Sexs(e) => e.eval(x, f, lim, st, vs),
            Self::Ieeet1(e) => e.eval(x, f, lim, st, vs),
            Self::Dc2(e) => e.eval(x, f, lim, st, vs),
            Self::St1(e) => e.eval(x, f, st, vs),
            Self::St1a(e) => e.eval(x, f, lim, st, vs),
            Self::St3a(e) => e.eval(x, f, lim, st, vs),
        }
    }

    /// Sets the initial state for field voltage `vf0`, the stator at the operating point and the stabiliser's
    /// initial signal, and the voltage reference that holds it. Limits the operating point lies beyond are widened to
    /// it, with a note.
    pub fn init(
        &mut self,
        x: &mut [f64],
        vf0: f64,
        st: &Stator<f64>,
        vs0: f64,
        notes: &mut Vec<String>,
    ) -> Result<(), String> {
        match self {
            Self::Sexs(e) => e.init(x, vf0, st, vs0, notes),
            Self::Ieeet1(e) => e.init(x, vf0, st, vs0, notes),
            Self::Dc2(e) => e.init(x, vf0, st, vs0, notes),
            Self::St1(e) => e.init(x, vf0, st, vs0, notes),
            Self::St1a(e) => e.init(x, vf0, st, vs0, notes),
            Self::St3a(e) => e.init(x, vf0, st, vs0, notes),
        }
    }
}

/// SEXS: lead-lag, then a lag with anti-windup limits.
#[derive(Debug, Clone)]
pub struct Sexs {
    ta: f64,
    tb: f64,
    k: f64,
    emin: f64,
    emax: f64,
    ll: usize,
    law: usize,
    vref: f64,
}

impl Sexs {
    fn eval<S: Scalar>(&self, x: &[S], f: &mut [S], lim: &mut [Option<(f64, f64)>], st: &Stator<S>, vs: S) -> S {
        let vi = -st.vt + self.vref + vs;
        f[self.ll] = vi - x[self.ll];
        let ll = lead_lag(vi, x[self.ll], self.ta, self.tb, 1.0);
        f[self.law] = lag(ll, x[self.law], self.k);
        lim[self.law] = Some((self.emin, self.emax));
        x[self.law]
    }

    fn init(
        &mut self,
        x: &mut [f64],
        vf0: f64,
        st: &Stator<f64>,
        vs0: f64,
        notes: &mut Vec<String>,
    ) -> Result<(), String> {
        widen(vf0, &mut self.emin, &mut self.emax, "SEXS field voltage", notes);
        let vi = vf0 / self.k;
        x[self.ll] = vi;
        x[self.law] = vf0;
        self.vref = vi + st.vt - vs0;
        Ok(())
    }
}

/// IEEET1: transducer, regulator with anti-windup limits, exciter with saturation and a rate feedback from the
/// field voltage.
#[derive(Debug, Clone)]
pub struct Ieeet1 {
    ka: f64,
    vrmax: f64,
    vrmin: f64,
    ke: f64,
    kf: f64,
    tf: f64,
    sat: Saturation,
    lg: usize,
    la: usize,
    int: usize,
    wf: usize,
    vref: f64,
}

impl Ieeet1 {
    fn eval<S: Scalar>(&self, x: &[S], f: &mut [S], lim: &mut [Option<(f64, f64)>], st: &Stator<S>, vs: S) -> S {
        let vout = x[self.int];
        f[self.lg] = st.vt - x[self.lg];
        let wf = washout(vout, x[self.wf], self.tf, self.kf);
        f[self.wf] = vout - x[self.wf];
        let vi = -x[self.lg] + self.vref + vs;
        f[self.la] = lag(vi - wf, x[self.la], self.ka);
        lim[self.la] = Some((self.vrmin, self.vrmax));
        let vfe = vout * self.ke + self.sat.product(vout);
        f[self.int] = x[self.la] - vfe;
        vout
    }

    fn init(
        &mut self,
        x: &mut [f64],
        vf0: f64,
        st: &Stator<f64>,
        vs0: f64,
        notes: &mut Vec<String>,
    ) -> Result<(), String> {
        let vr0 = self.ke * vf0 + self.sat.product(vf0);
        widen(vr0, &mut self.vrmin, &mut self.vrmax, "IEEET1 regulator output", notes);
        x[self.lg] = st.vt;
        x[self.wf] = vf0;
        x[self.la] = vr0;
        x[self.int] = vf0;
        self.vref = st.vt + vr0 / self.ka - vs0;
        Ok(())
    }
}

/// EXDC2 and ESDC2A: transducer, lead-lag, regulator with anti-windup limits, separately excited DC exciter with
/// saturation, and a rate feedback from the exciter's output.
#[derive(Debug, Clone)]
pub struct Dc2 {
    esdc2a: bool,
    ka: f64,
    tb: f64,
    tc: f64,
    vrmax: f64,
    vrmin: f64,
    ke: f64,
    kf: f64,
    tf1: f64,
    sat: Saturation,
    lg: usize,
    ll: usize,
    la: usize,
    vp: usize,
    wf: usize,
    vref: f64,
}

impl Dc2 {
    fn eval<S: Scalar>(&self, x: &[S], f: &mut [S], lim: &mut [Option<(f64, f64)>], st: &Stator<S>, vs: S) -> S {
        let vp = x[self.vp];
        f[self.lg] = st.vt - x[self.lg];
        let wf = washout(vp, x[self.wf], self.tf1, self.kf);
        f[self.wf] = vp - x[self.wf];
        let vi = -x[self.lg] - wf + self.vref + vs;
        f[self.ll] = vi - x[self.ll];
        let ll = lead_lag(vi, x[self.ll], self.tc, self.tb, 1.0);
        f[self.la] = lag(ll, x[self.la], self.ka);
        // ESDC2A's regulator limits scale with the terminal voltage.
        let scale = if self.esdc2a { st.vt.v() } else { 1.0 };
        lim[self.la] = Some((self.vrmin * scale, self.vrmax * scale));
        f[self.vp] = x[self.la] - vp * self.ke - self.sat.product(vp);
        if self.esdc2a { vp } else { vp * st.omega }
    }

    fn init(
        &mut self,
        x: &mut [f64],
        vf0: f64,
        st: &Stator<f64>,
        vs0: f64,
        notes: &mut Vec<String>,
    ) -> Result<(), String> {
        let vr0 = self.ke * vf0 + self.sat.product(vf0);
        let scale = if self.esdc2a { st.vt } else { 1.0 };
        let (mut lo, mut hi) = (self.vrmin * scale, self.vrmax * scale);
        let what = if self.esdc2a { "ESDC2A" } else { "EXDC2" };
        widen(vr0, &mut lo, &mut hi, &format!("{what} regulator output"), notes);
        (self.vrmin, self.vrmax) = (lo / scale, hi / scale);
        x[self.lg] = st.vt;
        x[self.wf] = vf0;
        x[self.vp] = vf0;
        x[self.la] = vr0;
        x[self.ll] = vr0 / self.ka;
        self.vref = st.vt + vr0 / self.ka - vs0;
        Ok(())
    }
}

/// EXST1: transducer, input limits, lead-lag, regulator, rate feedback, and output limits that fall with the field
/// current.
#[derive(Debug, Clone)]
pub struct St1 {
    vimax: f64,
    vimin: f64,
    tc: f64,
    tb: f64,
    ka: f64,
    vrmax: f64,
    vrmin: f64,
    kc: f64,
    kf: f64,
    tf: f64,
    lg: usize,
    ll: usize,
    lr: usize,
    wf: usize,
    vref: f64,
}

impl St1 {
    fn eval<S: Scalar>(&self, x: &[S], f: &mut [S], st: &Stator<S>, vs: S) -> S {
        let lr = x[self.lr];
        f[self.lg] = st.vt - x[self.lg];
        let wf = washout(lr, x[self.wf], self.tf, self.kf);
        f[self.wf] = lr - x[self.wf];
        let vi = (-x[self.lg] - wf + self.vref + vs).clamp(self.vimin, self.vimax);
        f[self.ll] = vi - x[self.ll];
        let ll = lead_lag(vi, x[self.ll], self.tc, self.tb, 1.0);
        f[self.lr] = lag(ll, lr, self.ka);
        let ifd = st.xadifd * self.kc;
        let (lo, hi) = (S::cst(self.vrmin) - ifd, S::cst(self.vrmax) - ifd);
        if lr.v() > hi.v() {
            hi
        } else if lr.v() < lo.v() {
            lo
        } else {
            lr
        }
    }

    fn init(
        &mut self,
        x: &mut [f64],
        vf0: f64,
        st: &Stator<f64>,
        vs0: f64,
        notes: &mut Vec<String>,
    ) -> Result<(), String> {
        let vi = vf0 / self.ka;
        widen(vi, &mut self.vimin, &mut self.vimax, "EXST1 input", notes);
        let ifd = self.kc * st.xadifd;
        let (mut lo, mut hi) = (self.vrmin - ifd, self.vrmax - ifd);
        widen(vf0, &mut lo, &mut hi, "EXST1 field voltage", notes);
        (self.vrmin, self.vrmax) = (lo + ifd, hi + ifd);
        x[self.lg] = st.vt;
        x[self.wf] = vf0;
        x[self.lr] = vf0;
        x[self.ll] = vi;
        self.vref = st.vt + vi - vs0;
        Ok(())
    }
}

/// ESST1A: transducer, input limits, two lead-lags, regulator with anti-windup limits, a field current limiter, output
/// limits that scale with the terminal voltage and fall with the field current, and a rate feedback. Under- and
/// over-excitation limiters are not modelled, so UEL and VOS change nothing: the stabiliser's signal enters at the
/// input.
#[derive(Debug, Clone)]
pub struct St1a {
    vimax: f64,
    vimin: f64,
    tc: f64,
    tb: f64,
    tc1: f64,
    tb1: f64,
    ka: f64,
    vamax: f64,
    vamin: f64,
    vrmax: f64,
    vrmin: f64,
    kc: f64,
    kf: f64,
    tf: f64,
    klr: f64,
    ilr: f64,
    lg: usize,
    ll: usize,
    ll1: usize,
    va: usize,
    wf: usize,
    vref: f64,
}

impl St1a {
    /// The field current limiter's output, KLR·(Ifd − ILR) above zero.
    fn limiter<S: Scalar>(&self, xadifd: S) -> S {
        ((xadifd - self.ilr) * self.klr).max(S::cst(0.0))
    }

    fn eval<S: Scalar>(&self, x: &[S], f: &mut [S], lim: &mut [Option<(f64, f64)>], st: &Stator<S>, vs: S) -> S {
        f[self.lg] = st.vt - x[self.lg];
        // The rate feedback reads the regulator's output before the output limits.
        let vas = x[self.va] - self.limiter(st.xadifd);
        let wf = washout(vas, x[self.wf], self.tf, self.kf);
        f[self.wf] = vas - x[self.wf];
        let vi = (-x[self.lg] - wf + self.vref + vs).clamp(self.vimin, self.vimax);
        f[self.ll] = vi - x[self.ll];
        let ll = lead_lag(vi, x[self.ll], self.tc, self.tb, 1.0);
        f[self.ll1] = ll - x[self.ll1];
        let ll1 = lead_lag(ll, x[self.ll1], self.tc1, self.tb1, 1.0);
        f[self.va] = lag(ll1, x[self.va], self.ka);
        lim[self.va] = Some((self.vamin, self.vamax));
        let hi = st.vt * self.vrmax - st.xadifd * self.kc;
        let lo = st.vt * self.vrmin;
        if vas.v() > hi.v() {
            hi
        } else if vas.v() < lo.v() {
            lo
        } else {
            vas
        }
    }

    fn init(
        &mut self,
        x: &mut [f64],
        vf0: f64,
        st: &Stator<f64>,
        vs0: f64,
        notes: &mut Vec<String>,
    ) -> Result<(), String> {
        let va = vf0 + self.limiter(st.xadifd);
        widen(
            va,
            &mut self.vamin,
            &mut self.vamax,
            "ESST1A regulator output VA",
            notes,
        );
        let (mut lo, mut hi) = (st.vt * self.vrmin, st.vt * self.vrmax - self.kc * st.xadifd);
        widen(vf0, &mut lo, &mut hi, "ESST1A field voltage", notes);
        (self.vrmin, self.vrmax) = (lo / st.vt, (hi + self.kc * st.xadifd) / st.vt);
        let vi = va / self.ka;
        widen(vi, &mut self.vimin, &mut self.vimax, "ESST1A input", notes);
        x[self.lg] = st.vt;
        x[self.wf] = vf0;
        x[self.ll] = vi;
        x[self.ll1] = vi;
        x[self.va] = va;
        self.vref = st.vt + vi - vs0;
        Ok(())
    }
}

/// ESST3A: potential- and compound-source static exciter with an inner field voltage regulator.
#[derive(Debug, Clone)]
pub struct St3a {
    vimax: f64,
    vimin: f64,
    km: f64,
    tc: f64,
    tb: f64,
    ka: f64,
    vrmax: f64,
    vrmin: f64,
    kg: f64,
    kpr: f64,
    kpi: f64,
    ki: f64,
    vbmax: f64,
    kc: f64,
    xl: f64,
    vgmax: f64,
    vmmax: f64,
    vmmin: f64,
    sb_sn: f64,
    lg: usize,
    ll: usize,
    vr: usize,
    vm: usize,
    vref: f64,
}

impl St3a {
    /// The source voltage VB for the stator's state: VE = |KP·e^(jθP)·V + j(KI + KP·e^(jθP)·XL)·I| reduced by the
    /// rectifier's loading FEX(IN), IN = KC·Ifd/VE, and limited to VBMAX. Currents on the machine's base.
    fn vb<S: Scalar>(&self, st: &Stator<S>) -> S {
        let (id, iq) = (st.id * self.sb_sn, st.iq * self.sb_sn);
        let (ar, ai) = (st.vd * self.kpr - st.vq * self.kpi, st.vq * self.kpr + st.vd * self.kpi);
        let (cr, ci) = (-self.kpi * self.xl, self.ki + self.kpr * self.xl);
        let (br, bi) = (id * cr - iq * ci, iq * cr + id * ci);
        let ve = ((ar + br).sq() + (ai + bi).sq()).sqrt();
        let i_n = st.xadifd * self.kc / ve;
        let fex = if i_n.v() <= 0.0 {
            S::cst(1.0)
        } else if i_n.v() <= 0.433 {
            S::cst(1.0) - i_n * 0.577
        } else if i_n.v() <= 0.75 {
            (S::cst(0.75) - i_n.sq()).sqrt()
        } else if i_n.v() <= 1.0 {
            (S::cst(1.0) - i_n) * 1.732
        } else {
            S::cst(0.0)
        };
        (ve * fex).min(S::cst(self.vbmax))
    }

    fn eval<S: Scalar>(&self, x: &[S], f: &mut [S], lim: &mut [Option<(f64, f64)>], st: &Stator<S>, vs: S) -> S {
        f[self.lg] = st.vt - x[self.lg];
        let vi = (-x[self.lg] + self.vref + vs).clamp(self.vimin, self.vimax);
        f[self.ll] = vi - x[self.ll];
        let ll = lead_lag(vi, x[self.ll], self.tc, self.tb, 1.0);
        f[self.vr] = lag(ll, x[self.vr], self.ka);
        lim[self.vr] = Some((self.vrmin, self.vrmax));
        let vb = self.vb(st);
        let vout = vb * x[self.vm];
        let vg = (vout * self.kg).min(S::cst(self.vgmax));
        f[self.vm] = lag(x[self.vr] - vg, x[self.vm], self.km);
        lim[self.vm] = Some((self.vmmin, self.vmmax));
        vout
    }

    fn init(
        &mut self,
        x: &mut [f64],
        vf0: f64,
        st: &Stator<f64>,
        vs0: f64,
        notes: &mut Vec<String>,
    ) -> Result<(), String> {
        let vb = self.vb(st);
        if vb <= 0.0 {
            return Err("ESST3A's source voltage VB is zero at the operating point".into());
        }
        let vm = vf0 / vb;
        widen(
            vm,
            &mut self.vmmin,
            &mut self.vmmax,
            "ESST3A inner regulator output VM",
            notes,
        );
        let vg = (self.kg * vf0).min(self.vgmax);
        let vr = vm / self.km + vg;
        widen(
            vr,
            &mut self.vrmin,
            &mut self.vrmax,
            "ESST3A regulator output VR",
            notes,
        );
        let vi = vr / self.ka;
        widen(vi, &mut self.vimin, &mut self.vimax, "ESST3A input", notes);
        x[self.lg] = st.vt;
        x[self.ll] = vi;
        x[self.vr] = vr;
        x[self.vm] = vm;
        self.vref = st.vt + vi - vs0;
        Ok(())
    }
}
