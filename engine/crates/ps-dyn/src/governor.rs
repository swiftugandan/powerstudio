//! Turbines and governors: TGOV1, IEEEG1 and HYGOV, on the machine's base (the PSS/E convention); their mechanical
//! power is converted to the system base on output.
//!
//! The speed reference is 1 p.u. and the load reference is set at initialisation so each model starts at the
//! machine's initial mechanical power. IEEEG1 drives only its own machine: the low-pressure share of a cross-compound
//! unit (K2, K4, K6, K8) needs its second machine, so the fractions are normalised to their sum as in ANDES and only the
//! high-pressure share reaches the machine.

use ps_model::{Controller, ControllerKind};

use crate::block::{Layout, lag, lead_lag, widen};
use crate::scalar::Scalar;

/// A governor with its data, variable indices and load reference.
#[derive(Debug, Clone)]
pub enum Governor {
    /// TGOV1.
    Tgov1(Tgov1),
    /// IEEEG1.
    Ieeeg1(Ieeeg1),
    /// HYGOV.
    Hygov(Hygov),
}

fn p(c: &Controller, name: &str) -> f64 {
    c.get(name)
}

fn nonzero(c: &Controller, name: &str) -> Result<f64, String> {
    let v = p(c, name);
    if v != 0.0 {
        Ok(v)
    } else {
        Err(format!("{} needs {name} other than zero", c.kind.name()))
    }
}

fn positive(c: &Controller, name: &str) -> Result<f64, String> {
    let v = p(c, name);
    if v > 0.0 {
        Ok(v)
    } else {
        Err(format!("{} needs {name} above zero", c.kind.name()))
    }
}

impl Governor {
    /// The governor a control describes, for a machine whose rating over the system base is `sn_sb`; adds its
    /// variables to the layout.
    pub fn new(c: &Controller, layout: &mut Layout, sn_sb: f64) -> Result<Self, String> {
        let name = c.kind.name();
        Ok(match c.kind {
            ControllerKind::Tgov1 => Self::Tgov1(Tgov1 {
                r: nonzero(c, "R")?,
                vmax: p(c, "VMAX"),
                vmin: p(c, "VMIN"),
                t2: p(c, "T2"),
                t3: p(c, "T3"),
                dt: p(c, "DT"),
                sn_sb,
                lag: layout.add(name, "LAG_y", p(c, "T1")),
                ll: layout.add(name, "LL_x", p(c, "T3")),
                pref: 0.0,
            }),
            ControllerKind::Ieeeg1 => {
                let k: Vec<f64> = (1..=8).map(|i| p(c, &format!("K{i}"))).collect();
                let sum: f64 = k.iter().sum();
                if sum == 0.0 {
                    return Err("IEEEG1 needs at least one of K1 to K8 other than zero".into());
                }
                Self::Ieeeg1(Ieeeg1 {
                    k: p(c, "K"),
                    t1: p(c, "T1"),
                    t2: p(c, "T2"),
                    t3: positive(c, "T3")?,
                    uo: p(c, "UO"),
                    uc: p(c, "UC"),
                    pmax: p(c, "PMAX"),
                    pmin: p(c, "PMIN"),
                    hp: [k[0] / sum, k[2] / sum, k[4] / sum, k[6] / sum],
                    sn_sb,
                    ll: layout.add(name, "LL_x", p(c, "T1")),
                    iaw: layout.add(name, "IAW_y", 1.0),
                    l: [
                        layout.add(name, "L4_y", p(c, "T4")),
                        layout.add(name, "L5_y", p(c, "T5")),
                        layout.add(name, "L6_y", p(c, "T6")),
                        layout.add(name, "L7_y", p(c, "T7")),
                    ],
                    pref: 0.0,
                })
            }
            ControllerKind::Hygov => {
                let r = nonzero(c, "R")?;
                let rr = nonzero(c, "r")?;
                Self::Hygov(Hygov {
                    r,
                    gr: 1.0 / rr,
                    velm: p(c, "VELM"),
                    gmax: p(c, "GMAX"),
                    gmin: p(c, "GMIN"),
                    at: nonzero(c, "AT")?,
                    dturb: p(c, "DTURB"),
                    qnl: p(c, "QNL"),
                    sn_sb,
                    lg: layout.add(name, "LG_y", p(c, "TF")),
                    gate: layout.add(name, "gtpos", rr * positive(c, "TR")?),
                    tgate: rr * p(c, "TR"),
                    lag: layout.add(name, "LAG_y", p(c, "TG")),
                    q: layout.add(name, "q", positive(c, "TW")?),
                    pref: 0.0,
                })
            }
            _ => return Err(format!("{name} is not a governor")),
        })
    }

    /// The mechanical power (system base) for the unit's variables and the machine's speed; writes the governor's
    /// right-hand sides and anti-windup limits.
    pub fn eval<S: Scalar>(&self, x: &[S], f: &mut [S], lim: &mut [Option<(f64, f64)>], omega: S) -> S {
        match self {
            Self::Tgov1(g) => g.eval(x, f, lim, omega),
            Self::Ieeeg1(g) => g.eval(x, f, lim, omega),
            Self::Hygov(g) => g.eval(x, f, lim, omega),
        }
    }

    /// Sets the initial state for initial mechanical power `tm0` (system base) and the load reference that holds it.
    pub fn init(&mut self, x: &mut [f64], tm0: f64, notes: &mut Vec<String>) -> Result<(), String> {
        match self {
            Self::Tgov1(g) => g.init(x, tm0, notes),
            Self::Ieeeg1(g) => g.init(x, tm0, notes),
            Self::Hygov(g) => g.init(x, tm0, notes),
        }
    }
}

/// TGOV1: droop, valve lag with position limits, and a reheater lead-lag.
#[derive(Debug, Clone)]
pub struct Tgov1 {
    r: f64,
    vmax: f64,
    vmin: f64,
    t2: f64,
    t3: f64,
    dt: f64,
    sn_sb: f64,
    lag: usize,
    ll: usize,
    pref: f64,
}

impl Tgov1 {
    fn eval<S: Scalar>(&self, x: &[S], f: &mut [S], lim: &mut [Option<(f64, f64)>], omega: S) -> S {
        let wd = omega - 1.0;
        let pd = S::cst(self.pref) - wd / self.r;
        f[self.lag] = lag(pd, x[self.lag], 1.0);
        lim[self.lag] = Some((self.vmin, self.vmax));
        f[self.ll] = x[self.lag] - x[self.ll];
        (lead_lag(x[self.lag], x[self.ll], self.t2, self.t3, 1.0) - wd * self.dt) * self.sn_sb
    }

    fn init(&mut self, x: &mut [f64], tm0: f64, notes: &mut Vec<String>) -> Result<(), String> {
        let pm = tm0 / self.sn_sb;
        widen(pm, &mut self.vmin, &mut self.vmax, "TGOV1 valve position", notes);
        x[self.lag] = pm;
        x[self.ll] = pm;
        self.pref = pm;
        Ok(())
    }
}

/// IEEEG1: speed relay lead-lag, servo with rate and position limits, and four turbine stages.
#[derive(Debug, Clone)]
pub struct Ieeeg1 {
    k: f64,
    t1: f64,
    t2: f64,
    t3: f64,
    uo: f64,
    uc: f64,
    pmax: f64,
    pmin: f64,
    hp: [f64; 4],
    sn_sb: f64,
    ll: usize,
    iaw: usize,
    l: [usize; 4],
    pref: f64,
}

impl Ieeeg1 {
    fn eval<S: Scalar>(&self, x: &[S], f: &mut [S], lim: &mut [Option<(f64, f64)>], omega: S) -> S {
        let wd = -omega + 1.0;
        f[self.ll] = wd - x[self.ll];
        let ll = lead_lag(wd, x[self.ll], self.t2, self.t1, self.k);
        let vs = ((ll - x[self.iaw]) + self.pref) / self.t3;
        f[self.iaw] = vs.clamp(self.uc, self.uo);
        lim[self.iaw] = Some((self.pmin, self.pmax));
        let mut input = x[self.iaw];
        let mut out = S::cst(0.0);
        for (k, &l) in self.l.iter().enumerate() {
            f[l] = input - x[l];
            input = x[l];
            out = out + x[l] * self.hp[k];
        }
        out * self.sn_sb
    }

    fn init(&mut self, x: &mut [f64], tm0: f64, notes: &mut Vec<String>) -> Result<(), String> {
        let pm = tm0 / self.sn_sb;
        let share: f64 = self.hp.iter().sum();
        if (share - 1.0).abs() > 1e-6 {
            notes.push(format!(
                "IEEEG1's high-pressure fractions sum to {share:.3} of K1 to K8; the low-pressure share has no second machine, so the machine does not start in equilibrium."
            ));
        }
        widen(pm, &mut self.pmin, &mut self.pmax, "IEEEG1 valve position", notes);
        x[self.ll] = 0.0;
        x[self.iaw] = pm;
        for &l in &self.l {
            x[l] = pm;
        }
        self.pref = pm;
        Ok(())
    }
}

/// HYGOV: filtered droop with temporary droop compensation, gate servo with rate and position limits, and a
/// non-elastic water column.
#[derive(Debug, Clone)]
pub struct Hygov {
    r: f64,
    gr: f64,
    velm: f64,
    gmax: f64,
    gmin: f64,
    at: f64,
    dturb: f64,
    qnl: f64,
    sn_sb: f64,
    lg: usize,
    gate: usize,
    tgate: f64,
    lag: usize,
    q: usize,
    pref: f64,
}

impl Hygov {
    fn eval<S: Scalar>(&self, x: &[S], f: &mut [S], lim: &mut [Option<(f64, f64)>], omega: S) -> S {
        let wd = omega - 1.0;
        let lg = x[self.lg];
        // Desired gate: the integral of the filtered error plus its proportional part.
        let dg = x[self.gate] + lg * self.gr;
        let pd = S::cst(self.pref) - wd - dg * self.r;
        f[self.lg] = lag(pd, lg, 1.0);
        // The gate's rate is limited to ±VELM, less the proportional part's contribution.
        let (lo, hi) = (-self.velm - self.gr * lg.v(), self.velm - self.gr * lg.v());
        f[self.gate] = lg.clamp(lo * self.tgate, hi * self.tgate);
        lim[self.gate] = Some((self.gmin, self.gmax));
        f[self.lag] = lag(dg, x[self.lag], 1.0);
        let (q, c) = (x[self.q], x[self.lag]);
        let h = q.sq() / c.sq();
        f[self.q] = -h + 1.0;
        ((q - self.qnl) * h * self.at - wd * c * self.dturb) * self.sn_sb
    }

    fn init(&mut self, x: &mut [f64], tm0: f64, notes: &mut Vec<String>) -> Result<(), String> {
        let q0 = tm0 / self.sn_sb / self.at + self.qnl;
        widen(q0, &mut self.gmin, &mut self.gmax, "HYGOV gate position", notes);
        x[self.lg] = 0.0;
        x[self.gate] = q0;
        x[self.lag] = q0;
        x[self.q] = q0;
        self.pref = self.r * q0;
        Ok(())
    }
}
