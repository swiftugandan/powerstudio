//! What every model is built from: a layout of its variables, and the standard transfer-function blocks.
//!
//! The simulation solves `T·dx/dt = f(x)` for every variable `x`, where `T` is the variable's time constant. A
//! variable with `T = 0` is algebraic: its equation is `f(x) = 0`. A lag whose time constant is zero therefore turns
//! into its gain without any special case, as in PSS/E and ANDES.
//!
//! The blocks follow the forms of IEEE 421.5 and the PSS/E model library:
//!
//! - lag `K/(1 + sT)`: state `y`, `T·y′ = K·u − y`;
//! - lead-lag `K(1 + sT1)/(1 + sT2)`: state `x`, `T2·x′ = u − x`, output `K·(T1/T2·(u − x) + x)`, and `K·u` when
//!   `T2 = 0`;
//! - washout `sK/(1 + sT)`: state `x`, `T·x′ = u − x`, output `K·(u − x)/T`;
//! - washout or lag (`sT5/(1 + sT6)` of PSS/E stabilisers): a washout with gain `T5`, or the lag `1/(1 + sT6)` when
//!   `T5 = 0`;
//! - quadratic saturation `S(x) = B·(x − A)²/x` above `A`, with `A` and `B` from two points `(E1, S(E1))` and
//!   `(E2, S(E2))`.

use crate::scalar::Scalar;

/// A model's variables: their names (for messages and tests) and time constants.
#[derive(Debug, Clone, Default)]
pub struct Layout {
    /// Time constant of each variable, s; zero for an algebraic variable.
    pub t: Vec<f64>,
    /// Name of each variable, `model.variable`.
    pub names: Vec<String>,
}

impl Layout {
    /// Adds a variable and returns its index.
    pub fn add(&mut self, model: &str, name: &str, t: f64) -> usize {
        self.t.push(t.max(0.0));
        self.names.push(format!("{model}.{name}"));
        self.t.len() - 1
    }

    /// Number of variables.
    pub fn len(&self) -> usize {
        self.t.len()
    }

    /// Whether there are none.
    pub fn is_empty(&self) -> bool {
        self.t.is_empty()
    }
}

/// The right-hand side of a lag's state: `K·u − y`.
pub fn lag<S: Scalar>(u: S, y: S, k: f64) -> S {
    u * k - y
}

/// A lead-lag's output for input `u` and state `x`.
pub fn lead_lag<S: Scalar>(u: S, x: S, t1: f64, t2: f64, k: f64) -> S {
    if t2 > 0.0 { ((u - x) * (t1 / t2) + x) * k } else { u * k }
}

/// A washout's output for input `u` and state `x`; zero when the gain is.
pub fn washout<S: Scalar>(u: S, x: S, t: f64, k: f64) -> S {
    if k == 0.0 { S::cst(0.0) } else { (u - x) * (k / t) }
}

/// Widens `[lo, hi]` to hold `v`, and says so: a model whose operating point lies beyond its own limit starts with
/// that limit moved to the operating point, as PSS/E and ANDES do.
pub fn widen(v: f64, lo: &mut f64, hi: &mut f64, what: &str, notes: &mut Vec<String>) {
    if v > *hi {
        notes.push(format!(
            "{what} {v:.4} at the operating point is above its upper limit {hi:.4}; the limit is raised to it."
        ));
        *hi = v;
    } else if v < *lo {
        notes.push(format!(
            "{what} {v:.4} at the operating point is below its lower limit {lo:.4}; the limit is lowered to it."
        ));
        *lo = v;
    }
}

/// A washout-or-lag's output: `K·(u − x)/T` when `K > 0`, the lag state `x` otherwise.
pub fn washout_or_lag<S: Scalar>(u: S, x: S, t: f64, k: f64) -> S {
    if k > 0.0 { washout(u, x, t, k) } else { x }
}

/// Quadratic saturation from two points.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Saturation {
    /// Where saturation starts.
    pub a: f64,
    /// Its gain.
    pub b: f64,
}

impl Saturation {
    /// The curve through `(e1, s1)` and `(e2, s2)`. Saturation is off when `s1` or `s2` is zero.
    pub fn new(e1: f64, s1: f64, e2: f64, s2: f64) -> Self {
        if s1 == 0.0 || s2 == 0.0 || e1 == e2 || e1 <= 0.0 || e2 <= 0.0 {
            return Self { a: e1.max(e2), b: 0.0 };
        }
        let ratio = (s1 * e1 / (s2 * e2)).sqrt();
        if ratio == 1.0 {
            return Self { a: e1.max(e2), b: 0.0 };
        }
        Self {
            a: e2 - (e1 - e2) / (ratio - 1.0),
            b: s2 * e2 * (ratio - 1.0).powi(2) / (e1 - e2).powi(2),
        }
    }

    /// `S(x)·x = B·(x − A)²` above `A`, zero below.
    pub fn product<S: Scalar>(&self, x: S) -> S {
        if self.b > 0.0 && x.v() > self.a {
            (x - self.a).sq() * self.b
        } else {
            S::cst(0.0)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saturation_passes_through_both_points() {
        let s = Saturation::new(3.9825, 0.5, 5.31, 1.049);
        for (e, want) in [(3.9825, 0.5), (5.31, 1.049)] {
            assert!((s.product(e) / e - want).abs() < 1e-12, "S({e})");
        }
        assert_eq!(Saturation::new(0.0, 0.0, 1.0, 1.0).product(2.0), 0.0);
    }

    #[test]
    fn a_lead_lag_without_lag_is_its_gain() {
        assert_eq!(lead_lag(2.0, 5.0, 1.0, 0.0, 3.0), 6.0);
        assert_eq!(lead_lag(2.0, 2.0, 1.0, 4.0, 3.0), 6.0);
    }
}
