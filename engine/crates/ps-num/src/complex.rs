//! A small complex number type: the engine needs a handful of operations and no generic numeric machinery.

use std::ops::{Add, AddAssign, Div, Mul, Neg, Sub, SubAssign};

/// A complex number with `f64` parts.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct C64 {
    /// Real part.
    pub re: f64,
    /// Imaginary part.
    pub im: f64,
}

impl C64 {
    /// Zero.
    pub const ZERO: Self = Self { re: 0.0, im: 0.0 };
    /// One.
    pub const ONE: Self = Self { re: 1.0, im: 0.0 };

    /// A complex number from its parts.
    pub const fn new(re: f64, im: f64) -> Self {
        Self { re, im }
    }

    /// A complex number from magnitude and angle in radians.
    pub fn from_polar(mag: f64, angle: f64) -> Self {
        Self {
            re: mag * angle.cos(),
            im: mag * angle.sin(),
        }
    }

    /// Complex conjugate.
    pub fn conj(self) -> Self {
        Self {
            re: self.re,
            im: -self.im,
        }
    }

    /// Magnitude.
    pub fn abs(self) -> f64 {
        self.re.hypot(self.im)
    }

    /// Squared magnitude.
    pub fn norm_sqr(self) -> f64 {
        self.re * self.re + self.im * self.im
    }

    /// Angle in radians.
    pub fn arg(self) -> f64 {
        self.im.atan2(self.re)
    }

    /// Reciprocal.
    pub fn inv(self) -> Self {
        let d = self.norm_sqr();
        Self {
            re: self.re / d,
            im: -self.im / d,
        }
    }

    /// Multiplication by a real number.
    pub fn scale(self, k: f64) -> Self {
        Self {
            re: self.re * k,
            im: self.im * k,
        }
    }

    /// True when both parts are finite.
    pub fn is_finite(self) -> bool {
        self.re.is_finite() && self.im.is_finite()
    }
}

impl Add for C64 {
    type Output = Self;
    fn add(self, o: Self) -> Self {
        Self {
            re: self.re + o.re,
            im: self.im + o.im,
        }
    }
}
impl AddAssign for C64 {
    fn add_assign(&mut self, o: Self) {
        self.re += o.re;
        self.im += o.im;
    }
}
impl Sub for C64 {
    type Output = Self;
    fn sub(self, o: Self) -> Self {
        Self {
            re: self.re - o.re,
            im: self.im - o.im,
        }
    }
}
impl SubAssign for C64 {
    fn sub_assign(&mut self, o: Self) {
        self.re -= o.re;
        self.im -= o.im;
    }
}
impl Mul for C64 {
    type Output = Self;
    fn mul(self, o: Self) -> Self {
        Self {
            re: self.re * o.re - self.im * o.im,
            im: self.re * o.im + self.im * o.re,
        }
    }
}
impl Div for C64 {
    type Output = Self;
    fn div(self, o: Self) -> Self {
        let d = o.norm_sqr();
        Self {
            re: (self.re * o.re + self.im * o.im) / d,
            im: (self.im * o.re - self.re * o.im) / d,
        }
    }
}
impl Neg for C64 {
    type Output = Self;
    fn neg(self) -> Self {
        Self {
            re: -self.re,
            im: -self.im,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::C64;

    #[test]
    fn arithmetic_matches_definitions() {
        let a = C64::new(1.0, 2.0);
        let b = C64::new(-3.0, 0.5);
        let p = a * b;
        assert_eq!(p, C64::new(-4.0, -5.5));
        let q = p / b;
        assert!((q - a).abs() < 1e-15);
        assert!((a * a.inv() - C64::ONE).abs() < 1e-15);
        assert!((C64::from_polar(2.0, 0.3).arg() - 0.3).abs() < 1e-15);
    }
}
