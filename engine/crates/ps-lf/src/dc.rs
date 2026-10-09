//! DC load flow: angles from active power alone, with |V| = 1 and losses neglected.

use ps_sparse::{CscBuilder, FaerLu, SparseSolver};

use crate::{BusKind, PuNetwork};

/// Angles (radians) from a DC load flow. Each branch carries `P = (θf − θt − φ)/x`, with `x` its series reactance and
/// `φ` its phase shift; reference buses keep the angles given in `fixed`. Returns `None` when the reduced susceptance
/// matrix is singular (a bus with no reactive path to a reference).
pub fn dc_angles(net: &PuNetwork, kind: &[BusKind], p: &[f64], fixed: &[f64]) -> Option<Vec<f64>> {
    let n = net.buses.len();
    let mut unknown = vec![usize::MAX; n];
    let mut m = 0;
    for i in 0..n {
        if kind[i] != BusKind::Reference {
            unknown[i] = m;
            m += 1;
        }
    }
    let mut theta: Vec<f64> = (0..n)
        .map(|i| {
            if kind[i] == BusKind::Reference {
                fixed[i]
            } else {
                0.0
            }
        })
        .collect();
    if m == 0 {
        return Some(theta);
    }
    let mut rhs: Vec<f64> = (0..n)
        .filter(|&i| unknown[i] != usize::MAX)
        .map(|i| p[i])
        .collect();
    let mut b = CscBuilder::new(m, m);
    let mut vals = Vec::with_capacity(4 * net.branches.len() + m);
    for i in 0..m {
        b.push(i, i);
        vals.push(0.0);
    }
    for br in &net.branches {
        // Series admittance ys = −yft·conj(t) with the unit phasor of the shift; its reactance drives the DC flow.
        let t = ps_num::C64::from_polar(1.0, br.shift);
        let ys = -(br.yft * t.conj());
        let x = ys.inv().im;
        if x.abs() < 1e-12 {
            continue;
        }
        let bb = 1.0 / x;
        let (f, t) = (unknown[br.f], unknown[br.t]);
        if f != usize::MAX {
            b.push(f, f);
            vals.push(bb);
            rhs[f] += bb * br.shift;
            if t == usize::MAX {
                rhs[f] += bb * theta[br.t];
            }
        }
        if t != usize::MAX {
            b.push(t, t);
            vals.push(bb);
            rhs[t] -= bb * br.shift;
            if f == usize::MAX {
                rhs[t] += bb * theta[br.f];
            }
        }
        if f != usize::MAX && t != usize::MAX {
            b.push(f, t);
            vals.push(-bb);
            b.push(t, f);
            vals.push(-bb);
        }
    }
    let (pattern, slot) = b.build();
    let mut values = vec![0.0; pattern.nnz()];
    for (h, v) in vals.into_iter().enumerate() {
        values[slot[h]] += v;
    }
    let mut solver = FaerLu::new();
    solver.analyse(&pattern).ok()?;
    solver.factor(&values).ok()?;
    solver.solve(&mut rhs).ok()?;
    if rhs.iter().any(|v| !v.is_finite()) {
        return None;
    }
    for i in 0..n {
        if unknown[i] != usize::MAX {
            theta[i] = rhs[unknown[i]];
        }
    }
    Some(theta)
}
