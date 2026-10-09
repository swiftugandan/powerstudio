//! The sparse solver agrees with the dense reference on random systems that need pivoting, and refactorises.

use ps_sparse::{Csc, CscBuilder, DenseLu, FaerLu, SparseSolver, residual_inf};

/// xorshift: deterministic pseudo-random numbers so failures reproduce.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> f64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 >> 11) as f64 / (1u64 << 53) as f64 * 2.0 - 1.0
    }
}

/// A random sparse matrix with a weak diagonal, so pivoting is needed, plus density `d`.
fn random(n: usize, d: f64, seed: u64) -> Csc {
    let mut rng = Rng(seed);
    let mut b = CscBuilder::new(n, n);
    let mut vals = Vec::new();
    for i in 0..n {
        b.push(i, i);
        vals.push(1e-3 * rng.next());
        for j in 0..n {
            if i != j && (rng.next() + 1.0) / 2.0 < d {
                b.push(i, j);
                vals.push(rng.next());
            }
        }
        // Keep it non-singular: a strong entry in a neighbouring column.
        b.push(i, (i + 1) % n);
        vals.push(2.0 + rng.next());
    }
    let (pattern, slot) = b.build();
    let mut values = vec![0.0; pattern.nnz()];
    for (h, v) in vals.into_iter().enumerate() {
        values[slot[h]] += v;
    }
    Csc { pattern, values }
}

#[test]
fn faer_matches_dense_and_solves_transposes() -> Result<(), Box<dyn std::error::Error>> {
    for (n, d, seed) in [(5, 0.3, 1), (40, 0.1, 2), (200, 0.02, 3)] {
        let a = random(n, d, seed);
        let mut rng = Rng(seed + 100);
        let b: Vec<f64> = (0..n).map(|_| rng.next()).collect();
        let mut sparse = FaerLu::new();
        sparse.analyse(&a.pattern)?;
        sparse.factor(&a.values)?;
        let mut x = b.clone();
        sparse.solve(&mut x)?;
        assert!(residual_inf(&a, &x, &b) < 1e-9, "n={n} residual");
        let mut dense = DenseLu::new();
        dense.analyse(&a.pattern)?;
        dense.factor(&a.values)?;
        let mut y = b.clone();
        dense.solve(&mut y)?;
        for i in 0..n {
            assert!(
                (x[i] - y[i]).abs() < 1e-8 * (1.0 + y[i].abs()),
                "n={n} entry {i}"
            );
        }
        // Transposed solve against the dense transpose.
        let mut xt = b.clone();
        sparse.solve_transpose(&mut xt)?;
        let mut yt = b.clone();
        dense.solve_transpose(&mut yt)?;
        for i in 0..n {
            assert!(
                (xt[i] - yt[i]).abs() < 1e-8 * (1.0 + yt[i].abs()),
                "n={n} transpose entry {i}"
            );
        }
    }
    Ok(())
}

#[test]
fn refactorising_new_values_on_the_same_pattern_reuses_the_analysis()
-> Result<(), Box<dyn std::error::Error>> {
    let a = random(120, 0.05, 7);
    let mut solver = FaerLu::new();
    solver.analyse(&a.pattern)?;
    for round in 0..4 {
        let values: Vec<f64> = a
            .values
            .iter()
            .map(|v| v * (1.0 + 0.1 * round as f64))
            .collect();
        let m = Csc {
            pattern: a.pattern.clone(),
            values,
        };
        solver.factor(&m.values)?;
        let b = vec![1.0; 120];
        let mut x = b.clone();
        solver.solve(&mut x)?;
        assert!(residual_inf(&m, &x, &b) < 1e-9, "round {round}");
    }
    Ok(())
}

#[test]
fn errors_are_reported_not_panicked() {
    let mut solver = FaerLu::new();
    let mut x = vec![1.0];
    assert!(solver.solve(&mut x).is_err());
    assert!(solver.factor(&[1.0]).is_err());
}
