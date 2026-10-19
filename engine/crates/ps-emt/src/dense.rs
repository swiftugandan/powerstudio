//! Small dense matrices: the 1 × 1 and 3 × 3 blocks of coupled elements, their inverses, and the transformations
//! between phase and sequence or modal quantities.

use ps_num::C64;

/// A square real matrix, row-major.
#[derive(Debug, Clone, PartialEq)]
pub struct Mat {
    /// Order.
    pub m: usize,
    /// Entries, row by row.
    pub a: Vec<f64>,
}

impl Mat {
    /// The zero matrix of order `m`.
    pub fn zeros(m: usize) -> Self {
        Self { m, a: vec![0.0; m * m] }
    }

    /// A diagonal matrix.
    pub fn diag(d: &[f64]) -> Self {
        let mut out = Self::zeros(d.len());
        for (i, &x) in d.iter().enumerate() {
            out.a[i * d.len() + i] = x;
        }
        out
    }

    /// The 3 × 3 phase matrix of a balanced element from its zero- and positive-sequence values: `(x0 + 2·x1)/3` on
    /// the diagonal and `(x0 − x1)/3` off it.
    pub fn sequence(x0: f64, x1: f64) -> Self {
        let (s, m) = ((x0 + 2.0 * x1) / 3.0, (x0 - x1) / 3.0);
        Self {
            m: 3,
            a: vec![s, m, m, m, s, m, m, m, s],
        }
    }

    /// Entry `(i, j)`.
    pub fn at(&self, i: usize, j: usize) -> f64 {
        self.a[i * self.m + j]
    }

    /// `self + k·o`.
    pub fn plus(&self, k: f64, o: &Mat) -> Mat {
        Mat {
            m: self.m,
            a: self.a.iter().zip(&o.a).map(|(x, y)| x + k * y).collect(),
        }
    }

    /// `k·self`.
    pub fn scaled(&self, k: f64) -> Mat {
        Mat {
            m: self.m,
            a: self.a.iter().map(|x| k * x).collect(),
        }
    }

    /// `out = self·x`.
    pub fn mul_vec(&self, x: &[f64], out: &mut [f64]) {
        for (i, o) in out.iter_mut().enumerate().take(self.m) {
            *o = (0..self.m).map(|j| self.a[i * self.m + j] * x[j]).sum();
        }
    }

    /// The product `self·o`.
    pub fn mul(&self, o: &Mat) -> Mat {
        let m = self.m;
        let mut out = Mat::zeros(m);
        for i in 0..m {
            for j in 0..m {
                out.a[i * m + j] = (0..m).map(|k| self.a[i * m + k] * o.a[k * m + j]).sum();
            }
        }
        out
    }

    /// Whether every entry is zero.
    pub fn is_zero(&self) -> bool {
        self.a.iter().all(|&x| x == 0.0)
    }

    /// The inverse, by Gauss-Jordan elimination with partial pivoting; `None` when singular.
    pub fn inverse(&self) -> Option<Mat> {
        let c: Vec<C64> = self.a.iter().map(|&x| C64::new(x, 0.0)).collect();
        cinverse(self.m, &c).map(|inv| Mat {
            m: self.m,
            a: inv.iter().map(|z| z.re).collect(),
        })
    }
}

/// The inverse of a complex `m × m` matrix (row-major), by Gauss-Jordan elimination with partial pivoting; `None`
/// when singular.
pub fn cinverse(m: usize, a: &[C64]) -> Option<Vec<C64>> {
    let mut w = a.to_vec();
    let mut inv = vec![C64::ZERO; m * m];
    for i in 0..m {
        inv[i * m + i] = C64::ONE;
    }
    let scale = a.iter().fold(0.0_f64, |s, z| s.max(z.abs()));
    for col in 0..m {
        let pivot = (col..m).max_by(|&x, &y| w[x * m + col].abs().total_cmp(&w[y * m + col].abs()))?;
        if w[pivot * m + col].abs() <= scale * 1e-14 || w[pivot * m + col].abs() == 0.0 {
            return None;
        }
        if pivot != col {
            for k in 0..m {
                w.swap(pivot * m + k, col * m + k);
                inv.swap(pivot * m + k, col * m + k);
            }
        }
        let d = w[col * m + col].inv();
        for k in 0..m {
            w[col * m + k] = w[col * m + k] * d;
            inv[col * m + k] = inv[col * m + k] * d;
        }
        for r in (0..m).filter(|&r| r != col) {
            let f = w[r * m + col];
            if f == C64::ZERO {
                continue;
            }
            for k in 0..m {
                w[r * m + k] = w[r * m + k] - f * w[col * m + k];
                inv[r * m + k] = inv[r * m + k] - f * inv[col * m + k];
            }
        }
    }
    Some(inv)
}

/// The power-invariant Clarke transformation, rows zero, α and β: modal quantities are `Q·x` for phase quantities
/// `x`, and `Qᵀ` takes them back (Q is orthogonal). It diagonalises the phase matrices of transposed lines.
pub fn clarke() -> Mat {
    let (s3, s6, s2) = (3.0_f64.sqrt(), 6.0_f64.sqrt(), 2.0_f64.sqrt());
    Mat {
        m: 3,
        a: vec![
            1.0 / s3,
            1.0 / s3,
            1.0 / s3,
            2.0 / s6,
            -1.0 / s6,
            -1.0 / s6,
            0.0,
            1.0 / s2,
            -1.0 / s2,
        ],
    }
}

/// The real 3 × 3 matrix that delays the positive sequence by `alpha` radians, advances the negative sequence by
/// as much and passes the zero sequence: the voltage a phase-shifting transformer of angle `alpha` gives.
pub fn rotation(alpha: f64) -> Mat {
    let mut out = Mat::zeros(3);
    for i in 0..3 {
        for j in 0..3 {
            let d = (i as f64 - j as f64) * 2.0 * std::f64::consts::PI / 3.0;
            out.a[i * 3 + j] = (1.0 + 2.0 * (alpha + d).cos()) / 3.0;
        }
    }
    out
}

/// The phase phasors of a balanced positive-sequence set whose phase a is `x`: b lags it by 120°, c leads by 120°.
pub fn balanced(x: C64) -> [C64; 3] {
    let a = C64::from_polar(1.0, 2.0 * std::f64::consts::PI / 3.0);
    [x, x * a.conj(), x * a]
}

/// The positive-sequence component of three phase phasors.
pub fn positive(x: &[C64]) -> C64 {
    let a = C64::from_polar(1.0, 2.0 * std::f64::consts::PI / 3.0);
    (x[0] + a * x[1] + a * a * x[2]).scale(1.0 / 3.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inverse_of_a_sequence_matrix_is_the_sequence_matrix_of_inverses() {
        let m = Mat::sequence(3.0, 1.0);
        let inv = m.inverse().unwrap_or_else(|| Mat::zeros(3));
        let want = Mat::sequence(1.0 / 3.0, 1.0);
        for (x, y) in inv.a.iter().zip(&want.a) {
            assert!((x - y).abs() < 1e-14, "{x} {y}");
        }
    }

    #[test]
    fn clarke_is_orthogonal_and_diagonalises_sequence_matrices() {
        let q = clarke();
        let qt = Mat {
            m: 3,
            a: (0..9).map(|k| q.at(k % 3, k / 3)).collect(),
        };
        let d = q.mul(&Mat::sequence(5.0, 2.0)).mul(&qt);
        let want = Mat::diag(&[5.0, 2.0, 2.0]);
        for (x, y) in d.a.iter().zip(&want.a) {
            assert!((x - y).abs() < 1e-14, "{x} {y}");
        }
    }

    #[test]
    fn rotation_delays_positive_and_passes_zero_sequence() {
        let alpha = 0.3;
        let r = rotation(alpha);
        let v = balanced(C64::new(0.9, 0.2));
        let out: Vec<C64> = (0..3)
            .map(|i| (0..3).fold(C64::ZERO, |s, j| s + v[j].scale(r.at(i, j))))
            .collect();
        let want = balanced(C64::new(0.9, 0.2) * C64::from_polar(1.0, -alpha));
        for (x, y) in out.iter().zip(&want) {
            assert!((*x - *y).abs() < 1e-14);
        }
        let zero = [C64::ONE; 3];
        for i in 0..3 {
            let s = (0..3).fold(C64::ZERO, |s, j| s + zero[j].scale(r.at(i, j)));
            assert!((s - C64::ONE).abs() < 1e-14);
        }
    }
}
