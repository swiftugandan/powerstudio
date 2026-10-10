//! The correction and decay factors of IEC 60909-0, as pandapower implements them (pandapower's
//! `shortcircuit/ppc_conversion.py`, `build_branch.py` and `kappa.py`, and the μ factor of its unfinished breaking
//! current, `currents.py`). docs/ENGINE.md, "Short circuit", lists each factor with its clause.

use ps_model::study::LvTolerance;
use ps_model::{AsyncMotor, Generator, Transformer2, Transformer3};

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

/// A three-winding transformer with each winding pair's impedance multiplied by its own KT (IEC 60909-0, 6.3.3):
/// the star impedances are summed to pair impedances on winding 1's voltage, each pair corrected with its reactance
/// on the smaller of its two ratings, and the corrected pairs turned back into a star.
pub fn three_winding_corrected(t: &Transformer3, cmax: f64) -> Transformer3 {
    let k1 = t.windings[0].rated_kv;
    let refer = |w: usize| (k1 / t.windings[w].rated_kv).powi(2);
    let star: Vec<(f64, f64)> = (0..3)
        .map(|w| (t.windings[w].r * refer(w), t.windings[w].x * refer(w)))
        .collect();
    let pair = |a: usize, b: usize| {
        let (r, x) = (star[a].0 + star[b].0, star[a].1 + star[b].1);
        let s = t.windings[a].rated_mva.min(t.windings[b].rated_mva);
        let kt = 0.95 * cmax / (1.0 + 0.6 * x / (k1 * k1 / s));
        (r * kt, x * kt)
    };
    let (z12, z13, z23) = (pair(0, 1), pair(0, 2), pair(1, 2));
    let half = |a: (f64, f64), b: (f64, f64), c: (f64, f64)| (0.5 * (a.0 + b.0 - c.0), 0.5 * (a.1 + b.1 - c.1));
    let corrected = [half(z12, z13, z23), half(z12, z23, z13), half(z13, z23, z12)];
    let mut out = t.clone();
    for (w, (r, x)) in corrected.into_iter().enumerate() {
        out.windings[w].r = r / refer(w);
        out.windings[w].x = x / refer(w);
    }
    out
}

/// sin φrG of a machine's rated power factor.
fn sin_phi(g: &Generator) -> f64 {
    (1.0 - g.sc.cos_phi * g.sc.cos_phi).max(0.0).sqrt()
}

/// Generator impedance correction factor KG = Un/(UrG·(1 + pG)) · cmax / (1 + x″d·sin φrG) (IEC 60909-0, 6.6.1).
pub fn generator_correction(g: &Generator, un: f64, cmax: f64) -> f64 {
    un / (g.rated_kv * (1.0 + g.sc.pg / 100.0)) * cmax / (1.0 + g.sc.xdss * sin_phi(g))
}

/// The correction factors of a power station unit (IEC 60909-0, 6.7): for faults outside the unit, KS with an
/// on-load tap changer, KSO without, applied to both the machine and its transformer; for faults at the machine's
/// terminals, the machine's own factor, the transformer uncorrected.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct UnitFactors {
    /// KS or KSO.
    pub outside: f64,
    /// The machine's factor for a fault at its terminals.
    pub terminals: f64,
}

/// The factors of a power station unit: machine `g` and transformer `t` with rated voltage `ur_hv` on the network
/// side and `ur_lv` on the machine's, connected to a network of nominal voltage `un_q` kV.
pub fn unit_correction(g: &Generator, t: &Transformer2, ur_hv: f64, ur_lv: f64, un_q: f64, cmax: f64) -> UnitFactors {
    let (ur_g, xd, pg) = (g.rated_kv, g.sc.xdss, g.sc.pg / 100.0);
    let zb = t.rated_kv1 * t.rated_kv1 / t.rated_mva;
    let x_t = t.x / zb;
    if t.on_load_taps {
        UnitFactors {
            outside: (un_q * un_q / (ur_g * ur_g)) * (ur_lv * ur_lv / (ur_hv * ur_hv)) * cmax
                / (1.0 + (xd - x_t).abs() * sin_phi(g)),
            terminals: cmax / (1.0 + xd * sin_phi(g)),
        }
    } else {
        let pt = t.tap_range_pct / 100.0;
        UnitFactors {
            outside: (un_q / (ur_g * (1.0 + pg))) * (ur_lv / ur_hv) * (1.0 - pt) * cmax / (1.0 + xd * sin_phi(g)),
            terminals: cmax / ((1.0 + pg) * (1.0 + xd * sin_phi(g))),
        }
    }
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

/// The minimum time delays, s, at which IEC 60909-0 gives μ and q in closed form.
const DELAYS: [f64; 4] = [0.02, 0.05, 0.1, 0.25];

/// A factor given at each of `DELAYS`, at minimum time delay `t_min`: linear between the delays, the first below them
/// and the last above (IEC 60909-0, 9.1.1, which allows linear interpolation between the curves).
fn at_delay(t_min: f64, at: impl Fn(usize) -> f64) -> f64 {
    if t_min <= DELAYS[0] {
        return at(0);
    }
    for k in 1..DELAYS.len() {
        if t_min <= DELAYS[k] {
            let w = (t_min - DELAYS[k - 1]) / (DELAYS[k] - DELAYS[k - 1]);
            return at(k - 1) * (1.0 - w) + at(k) * w;
        }
    }
    at(DELAYS.len() - 1)
}

/// The decay factor μ of a machine's breaking current for the ratio of its initial short-circuit current to its
/// rated current, at minimum time delay `t_min` s (IEC 60909-0, 9.1.1; the coefficients of pandapower's
/// `currents.py`): 1 when the ratio is 2 or less, and at most 1.
pub fn mu(ratio: f64, t_min: f64) -> f64 {
    if ratio <= 2.0 {
        return 1.0;
    }
    const C: [(f64, f64, f64); 4] = [
        (0.84, 0.26, 0.26),
        (0.71, 0.51, 0.30),
        (0.62, 0.72, 0.32),
        (0.56, 0.94, 0.38),
    ];
    at_delay(t_min, |k| C[k].0 + C[k].1 * (-C[k].2 * ratio).exp()).min(1.0)
}

/// The decay factor q of an asynchronous motor's breaking current, from m, its rated power per pair of poles in MW,
/// at minimum time delay `t_min` s (IEC 60909-0, 9.1.2; the coefficients as Phase to Phase's Vision documents them).
/// At most 1; 1 when the poles are not known, which assumes no decay of the motor's own current and so errs high.
pub fn q_factor(m: &AsyncMotor, t_min: f64) -> f64 {
    if m.pole_pairs == 0 || m.rated_mw <= 0.0 {
        return 1.0;
    }
    const C: [(f64, f64); 4] = [(1.03, 0.12), (0.79, 0.12), (0.57, 0.12), (0.26, 0.10)];
    let ln_m = (m.rated_mw / f64::from(m.pole_pairs)).ln();
    at_delay(t_min, |k| C[k].0 + C[k].1 * ln_m).clamp(0.0, 1.0)
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
            unrated: false,
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
        g.sc.pg = 5.0;
        assert!((generator_correction(&g, 10.0, 1.1) - 10.0 / (10.5 * 1.05) * 1.1 / (1.0 + 0.2 * 0.6)).abs() < 1e-12);
        assert_eq!(voltage_factor(20.0, LvTolerance::Ten), (1.1, 1.0));
        assert_eq!(voltage_factor(0.4, LvTolerance::Six), (1.05, 0.95));
        // μ is 1 up to twice the rated current and falls with the ratio and the delay; between the tabulated delays
        // it is linear.
        assert_eq!(mu(2.0, 0.1), 1.0);
        assert!((mu(5.0, 0.1) - (0.62 + 0.72 * (-1.6_f64).exp())).abs() < 1e-12);
        assert!(mu(8.0, 0.1) < mu(4.0, 0.1) && mu(4.0, 0.25) < mu(4.0, 0.02));
        assert!((mu(5.0, 0.075) - 0.5 * (mu(5.0, 0.05) + mu(5.0, 0.1))).abs() < 1e-12);
        assert_eq!(mu(5.0, 1.0), mu(5.0, 0.25));
        // q from the power per pole pair: 5 MW with one pair at 0.1 s; capped at 1; 1 without pole pairs.
        let motor = |mw: f64, pairs: u32| AsyncMotor {
            rated_mw: mw,
            pole_pairs: pairs,
            ..Default::default()
        };
        assert!((q_factor(&motor(5.0, 1), 0.1) - (0.57 + 0.12 * 5_f64.ln())).abs() < 1e-12);
        assert_eq!(q_factor(&motor(500.0, 1), 0.02), 1.0);
        assert_eq!(q_factor(&motor(5.0, 0), 0.1), 1.0);
    }

    #[test]
    fn a_three_winding_unit_with_equal_pairs_keeps_its_star_shape() {
        // Equal windings: every pair has the same reactance, so the correction scales the star uniformly.
        let w = ps_model::Winding3 {
            rated_kv: 110.0,
            rated_mva: 50.0,
            r: 1.0,
            x: 10.0,
            ..Default::default()
        };
        let t = Transformer3 {
            windings: [w, w, w],
            ..Default::default()
        };
        let c = three_winding_corrected(&t, 1.1);
        let x_pair = 20.0 / (110.0_f64 * 110.0 / 50.0);
        let kt = 0.95 * 1.1 / (1.0 + 0.6 * x_pair);
        for k in 0..3 {
            assert!((c.windings[k].x - 10.0 * kt).abs() < 1e-12 && (c.windings[k].r - kt).abs() < 1e-12);
        }
    }
}
