//! Power system stabilisers: IEEEST and ST2CUT. Each adds its output `Vs` to its exciter's input.
//!
//! The input signal is chosen by MODE: 1 the speed deviation, 3 the air-gap torque (power) on the machine's base,
//! 4 the mechanical power's deviation, 5 the terminal voltage. Bus frequency (2) and the voltage's derivative (6) and
//! signals from a remote busbar are not modelled yet; [`Stabiliser::new`] refuses them. Blocks whose lag time constant
//! is zero pass their input through, as PSS/E and ANDES do: IEEEST's second-order filters when A2 (or A4) is zero,
//! each lead-lag when its lag is zero.

use ps_model::{Controller, ControllerKind};

use crate::block::{Layout, lag, lead_lag, washout_or_lag};
use crate::machine::Stator;
use crate::scalar::Scalar;

/// A stabiliser with its data and variable indices.
#[derive(Debug, Clone)]
pub enum Stabiliser {
    /// IEEEST.
    Ieeest(Ieeest),
    /// ST2CUT.
    St2cut(St2cut),
}

/// What a stabiliser measures.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Signal {
    None,
    Speed,
    Torque,
    Mechanical,
    Voltage,
}

fn signal(c: &Controller, mode: &str, busr: &str) -> Result<Signal, String> {
    if c.get(busr) != 0.0 {
        return Err(format!(
            "{} reads busbar {} for its signal; remote signals are not modelled yet",
            c.kind.name(),
            c.get(busr)
        ));
    }
    Ok(match c.get(mode) as i64 {
        0 => Signal::None,
        1 => Signal::Speed,
        3 => Signal::Torque,
        4 => Signal::Mechanical,
        5 => Signal::Voltage,
        2 => return Err(format!("{} MODE 2 (bus frequency) is not modelled yet", c.kind.name())),
        6 => {
            return Err(format!(
                "{} MODE 6 (voltage derivative) is not modelled yet",
                c.kind.name()
            ));
        }
        m => return Err(format!("{} has no MODE {m}", c.kind.name())),
    })
}

/// The measured signal.
fn measure<S: Scalar>(sig: Signal, st: &Stator<S>, tm: S, tm0: f64, sn_sb: f64) -> S {
    match sig {
        Signal::None => S::cst(0.0),
        Signal::Speed => st.omega - 1.0,
        Signal::Torque => st.te / sn_sb,
        Signal::Mechanical => tm / sn_sb - tm0 / sn_sb,
        Signal::Voltage => st.vt,
    }
}

/// The output limiter on the terminal voltage: the signal passes while the voltage stays between the limits; a limit
/// of zero is no limit.
fn gate<S: Scalar>(vss: S, vt: f64, vcl: f64, vcu: f64) -> S {
    if vt >= vcu || vt <= vcl { S::cst(0.0) } else { vss }
}

impl Stabiliser {
    /// The stabiliser a control describes, for a machine whose rating over the system base is `sn_sb`; adds its
    /// variables to the layout.
    pub fn new(c: &Controller, layout: &mut Layout, sn_sb: f64) -> Result<Self, String> {
        let name = c.kind.name();
        let p = |n: &str| c.get(n);
        Ok(match c.kind {
            ControllerKind::Ieeest => {
                let (a1, a2, a4) = (p("A1"), p("A2"), p("A4"));
                if p("T5") > 0.0 && p("T6") <= 0.0 {
                    return Err("IEEEST needs T6 above zero for its washout".into());
                }
                let f1_on = a1 != 0.0 || a2 != 0.0;
                Self::Ieeest(Ieeest {
                    signal: signal(c, "MODE", "BUSR")?,
                    a1,
                    a3: p("A3"),
                    a4,
                    a5: p("A5"),
                    a6: p("A6"),
                    t1: p("T1"),
                    t2: p("T2"),
                    t3: p("T3"),
                    t4: p("T4"),
                    t5: p("T5"),
                    t6: p("T6"),
                    ks: p("KS"),
                    lsmax: p("LSMAX"),
                    lsmin: p("LSMIN"),
                    vcu: if p("VCU") == 0.0 { 999.0 } else { p("VCU") },
                    vcl: if p("VCL") == 0.0 { -999.0 } else { p("VCL") },
                    sn_sb,
                    f1_on,
                    f2_on: a4 != 0.0,
                    f1x: layout.add(name, "F1_x", if f1_on { a2 } else { 0.0 }),
                    f1y: layout.add(name, "F1_y", if f1_on { 1.0 } else { 0.0 }),
                    f2x1: layout.add(name, "F2_x1", a4),
                    f2x2: layout.add(name, "F2_x2", if a4 != 0.0 { 1.0 } else { 0.0 }),
                    ll1: layout.add(name, "LL1_x", p("T2")),
                    ll2: layout.add(name, "LL2_x", p("T4")),
                    wo: layout.add(name, "WO_x", p("T6")),
                    tm0: 0.0,
                })
            }
            ControllerKind::St2cut => {
                if p("T3") > 0.0 && p("T4") <= 0.0 {
                    return Err("ST2CUT needs T4 above zero for its washout".into());
                }
                Self::St2cut(St2cut {
                    signal1: signal(c, "MODE", "BUSR")?,
                    signal2: signal(c, "MODE2", "BUSR2")?,
                    k1: p("K1"),
                    k2: p("K2"),
                    t3: p("T3"),
                    t4: p("T4"),
                    t: [p("T5"), p("T6"), p("T7"), p("T8"), p("T9"), p("T10")],
                    lsmax: p("LSMAX"),
                    lsmin: p("LSMIN"),
                    vcu: if p("VCU") == 0.0 { 999.0 } else { p("VCU") },
                    vcl: if p("VCL") == 0.0 { -999.0 } else { p("VCL") },
                    sn_sb,
                    l1: layout.add(name, "L1_y", p("T1")),
                    l2: layout.add(name, "L2_y", p("T2")),
                    wo: layout.add(name, "WO_x", p("T4")),
                    ll: [
                        layout.add(name, "LL1_x", p("T6")),
                        layout.add(name, "LL2_x", p("T8")),
                        layout.add(name, "LL3_x", p("T10")),
                    ],
                    tm0: 0.0,
                    vt0: 0.0,
                })
            }
            _ => return Err(format!("{name} is not a stabiliser")),
        })
    }

    /// The stabiliser's output for the unit's variables, the machine's stator and its mechanical power; writes the
    /// right-hand sides.
    pub fn eval<S: Scalar>(&self, x: &[S], f: &mut [S], st: &Stator<S>, tm: S) -> S {
        match self {
            Self::Ieeest(s) => s.eval(x, f, st, tm),
            Self::St2cut(s) => s.eval(x, f, st, tm),
        }
    }

    /// Sets the initial state at the operating point and returns the initial output.
    pub fn init(&mut self, x: &mut [f64], st: &Stator<f64>, tm0: f64) -> f64 {
        match self {
            Self::Ieeest(s) => s.init(x, st, tm0),
            Self::St2cut(s) => s.init(x, st, tm0),
        }
    }
}

/// IEEEST: second-order filter, second-order lead-lag, two lead-lags, gain, washout, output limits.
#[derive(Debug, Clone)]
pub struct Ieeest {
    signal: Signal,
    a1: f64,
    a3: f64,
    a4: f64,
    a5: f64,
    a6: f64,
    t1: f64,
    t2: f64,
    t3: f64,
    t4: f64,
    t5: f64,
    t6: f64,
    ks: f64,
    lsmax: f64,
    lsmin: f64,
    vcu: f64,
    vcl: f64,
    sn_sb: f64,
    f1_on: bool,
    f2_on: bool,
    f1x: usize,
    f1y: usize,
    f2x1: usize,
    f2x2: usize,
    ll1: usize,
    ll2: usize,
    wo: usize,
    tm0: f64,
}

impl Ieeest {
    fn eval<S: Scalar>(&self, x: &[S], f: &mut [S], st: &Stator<S>, tm: S) -> S {
        let u = measure(self.signal, st, tm, self.tm0, self.sn_sb);
        // 1/(1 + A1·s + A2·s²).
        let f1 = if self.f1_on {
            f[self.f1x] = u - x[self.f1y] - x[self.f1x] * self.a1;
            f[self.f1y] = x[self.f1x];
            x[self.f1y]
        } else {
            f[self.f1x] = -x[self.f1x];
            f[self.f1y] = u - x[self.f1y];
            u
        };
        // (1 + A5·s + A6·s²)/(1 + A3·s + A4·s²).
        let f2 = if self.f2_on {
            let r = f1 - x[self.f2x2] - x[self.f2x1] * self.a3;
            f[self.f2x1] = r;
            f[self.f2x2] = x[self.f2x1];
            x[self.f2x2] + x[self.f2x1] * self.a5 + r * (self.a6 / self.a4)
        } else {
            f[self.f2x1] = -x[self.f2x1];
            f[self.f2x2] = f1 - x[self.f2x2];
            f1
        };
        f[self.ll1] = f2 - x[self.ll1];
        let ll1 = lead_lag(f2, x[self.ll1], self.t1, self.t2, 1.0);
        f[self.ll2] = ll1 - x[self.ll2];
        let vks = lead_lag(ll1, x[self.ll2], self.t3, self.t4, 1.0) * self.ks;
        f[self.wo] = vks - x[self.wo];
        let vss = washout_or_lag(vks, x[self.wo], self.t6, self.t5).clamp(self.lsmin, self.lsmax);
        gate(vss, st.vt.v(), self.vcl, self.vcu)
    }

    fn init(&mut self, x: &mut [f64], st: &Stator<f64>, tm0: f64) -> f64 {
        self.tm0 = tm0;
        let u = measure(self.signal, st, tm0, tm0, self.sn_sb);
        x[self.f1x] = 0.0;
        x[self.f1y] = u;
        x[self.f2x1] = 0.0;
        x[self.f2x2] = u;
        x[self.ll1] = u;
        x[self.ll2] = u;
        x[self.wo] = u * self.ks;
        let vss = washout_or_lag(u * self.ks, x[self.wo], self.t6, self.t5).clamp(self.lsmin, self.lsmax);
        gate(vss, st.vt, self.vcl, self.vcu)
    }
}

/// ST2CUT: two filtered input signals, washout, three lead-lags, output limits; its output is cut off when the terminal
/// voltage leaves a band around its initial value.
#[derive(Debug, Clone)]
pub struct St2cut {
    signal1: Signal,
    signal2: Signal,
    k1: f64,
    k2: f64,
    t3: f64,
    t4: f64,
    t: [f64; 6],
    lsmax: f64,
    lsmin: f64,
    vcu: f64,
    vcl: f64,
    sn_sb: f64,
    l1: usize,
    l2: usize,
    wo: usize,
    ll: [usize; 3],
    tm0: f64,
    vt0: f64,
}

impl St2cut {
    fn eval<S: Scalar>(&self, x: &[S], f: &mut [S], st: &Stator<S>, tm: S) -> S {
        let s1 = measure(self.signal1, st, tm, self.tm0, self.sn_sb);
        let s2 = measure(self.signal2, st, tm, self.tm0, self.sn_sb);
        f[self.l1] = lag(s1, x[self.l1], self.k1);
        f[self.l2] = lag(s2, x[self.l2], self.k2);
        let input = x[self.l1] + x[self.l2];
        f[self.wo] = input - x[self.wo];
        let mut y = washout_or_lag(input, x[self.wo], self.t4, self.t3);
        for (k, &v) in self.ll.iter().enumerate() {
            f[v] = y - x[v];
            y = lead_lag(y, x[v], self.t[2 * k], self.t[2 * k + 1], 1.0);
        }
        let vss = y.clamp(self.lsmin, self.lsmax);
        gate(vss, st.vt.v(), self.vcl + self.vt0, self.vcu + self.vt0)
    }

    fn init(&mut self, x: &mut [f64], st: &Stator<f64>, tm0: f64) -> f64 {
        self.tm0 = tm0;
        self.vt0 = st.vt;
        let s1 = measure(self.signal1, st, tm0, tm0, self.sn_sb);
        let s2 = measure(self.signal2, st, tm0, tm0, self.sn_sb);
        x[self.l1] = self.k1 * s1;
        x[self.l2] = self.k2 * s2;
        let input = x[self.l1] + x[self.l2];
        x[self.wo] = input;
        let mut y = washout_or_lag(input, input, self.t4, self.t3);
        for &v in &self.ll {
            x[v] = y;
        }
        // Lead-lags pass a constant unchanged.
        y = y.clamp(self.lsmin, self.lsmax);
        gate(y, st.vt, self.vcl + self.vt0, self.vcu + self.vt0)
    }
}
