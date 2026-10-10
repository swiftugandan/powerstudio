//! Numbers the model equations are written over: `f64` to evaluate them, [`Dual`] to differentiate them.
//!
//! Each model writes its equations once, generic over [`Scalar`]. Evaluated with [`Dual`] numbers seeded on one
//! variable, the same code returns the equations' derivatives with respect to that variable, exactly (forward-mode
//! automatic differentiation), so no model carries a hand-written Jacobian that could disagree with its equations.
//! Comparisons and limits act on the value ([`Scalar::v`]); the derivative follows the branch taken, which is the
//! derivative of the piecewise function the limits define.

use std::ops::{Add, Div, Mul, Neg, Sub};

/// A number model equations can be written over.
pub trait Scalar:
    Copy
    + Add<Output = Self>
    + Sub<Output = Self>
    + Mul<Output = Self>
    + Div<Output = Self>
    + Neg<Output = Self>
    + Add<f64, Output = Self>
    + Sub<f64, Output = Self>
    + Mul<f64, Output = Self>
    + Div<f64, Output = Self>
{
    /// A constant.
    fn cst(v: f64) -> Self;
    /// The value.
    fn v(self) -> f64;
    /// Square root.
    fn sqrt(self) -> Self;
    /// Sine.
    fn sin(self) -> Self;
    /// Cosine.
    fn cos(self) -> Self;
    /// Square.
    fn sq(self) -> Self {
        self * self
    }
    /// The value limited to `[lo, hi]`: a constant at a limit.
    fn clamp(self, lo: f64, hi: f64) -> Self {
        if self.v() > hi {
            Self::cst(hi)
        } else if self.v() < lo {
            Self::cst(lo)
        } else {
            self
        }
    }
    /// The larger of two numbers.
    fn max(self, other: Self) -> Self {
        if other.v() > self.v() { other } else { self }
    }
    /// The smaller of two numbers.
    fn min(self, other: Self) -> Self {
        if other.v() < self.v() { other } else { self }
    }
}

impl Scalar for f64 {
    fn cst(v: f64) -> Self {
        v
    }
    fn v(self) -> f64 {
        self
    }
    fn sqrt(self) -> Self {
        f64::sqrt(self)
    }
    fn sin(self) -> Self {
        f64::sin(self)
    }
    fn cos(self) -> Self {
        f64::cos(self)
    }
}

/// A value with its derivative along one direction.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Dual {
    /// The value.
    pub v: f64,
    /// The derivative.
    pub d: f64,
}

impl Dual {
    /// A variable: value `v`, derivative 1 when it is the one differentiated against, else 0.
    pub fn var(v: f64, seeded: bool) -> Self {
        Self {
            v,
            d: if seeded { 1.0 } else { 0.0 },
        }
    }
}

impl Add for Dual {
    type Output = Self;
    fn add(self, o: Self) -> Self {
        Self {
            v: self.v + o.v,
            d: self.d + o.d,
        }
    }
}
impl Sub for Dual {
    type Output = Self;
    fn sub(self, o: Self) -> Self {
        Self {
            v: self.v - o.v,
            d: self.d - o.d,
        }
    }
}
impl Mul for Dual {
    type Output = Self;
    fn mul(self, o: Self) -> Self {
        Self {
            v: self.v * o.v,
            d: self.d * o.v + self.v * o.d,
        }
    }
}
impl Div for Dual {
    type Output = Self;
    fn div(self, o: Self) -> Self {
        Self {
            v: self.v / o.v,
            d: (self.d * o.v - self.v * o.d) / (o.v * o.v),
        }
    }
}
impl Neg for Dual {
    type Output = Self;
    fn neg(self) -> Self {
        Self { v: -self.v, d: -self.d }
    }
}
impl Add<f64> for Dual {
    type Output = Self;
    fn add(self, o: f64) -> Self {
        Self {
            v: self.v + o,
            d: self.d,
        }
    }
}
impl Sub<f64> for Dual {
    type Output = Self;
    fn sub(self, o: f64) -> Self {
        Self {
            v: self.v - o,
            d: self.d,
        }
    }
}
impl Mul<f64> for Dual {
    type Output = Self;
    fn mul(self, o: f64) -> Self {
        Self {
            v: self.v * o,
            d: self.d * o,
        }
    }
}
impl Div<f64> for Dual {
    type Output = Self;
    fn div(self, o: f64) -> Self {
        Self {
            v: self.v / o,
            d: self.d / o,
        }
    }
}

impl Scalar for Dual {
    fn cst(v: f64) -> Self {
        Self { v, d: 0.0 }
    }
    fn v(self) -> f64 {
        self.v
    }
    fn sqrt(self) -> Self {
        let s = self.v.sqrt();
        Self {
            v: s,
            d: if s > 0.0 { self.d / (2.0 * s) } else { 0.0 },
        }
    }
    fn sin(self) -> Self {
        Self {
            v: self.v.sin(),
            d: self.d * self.v.cos(),
        }
    }
    fn cos(self) -> Self {
        Self {
            v: self.v.cos(),
            d: -self.d * self.v.sin(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f<S: Scalar>(x: S) -> S {
        (x.sq() * 3.0 + x.sin()) / (x + 2.0) - x.sqrt() * x.cos()
    }

    #[test]
    fn dual_derivative_matches_central_difference() {
        for &x in &[0.3, 1.1, 2.7] {
            let d = f(Dual::var(x, true)).d;
            let h = 1e-6;
            let fd = (f(x + h) - f(x - h)) / (2.0 * h);
            assert!((d - fd).abs() < 1e-8, "{x}: {d} against {fd}");
        }
    }

    #[test]
    fn limits_give_constants_beyond_them() {
        let x = Dual::var(2.0, true);
        assert_eq!(x.clamp(0.0, 1.0), Dual { v: 1.0, d: 0.0 });
        assert_eq!(x.clamp(0.0, 3.0), x);
        assert_eq!(x.max(Dual::cst(5.0)).d, 0.0);
    }
}
