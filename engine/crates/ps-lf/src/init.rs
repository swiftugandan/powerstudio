//! Starting voltage magnitudes for a cold start.

use ps_num::C64;
use ps_sparse::{CscBuilder, FaerLu, SparseSolver};

use crate::PuNetwork;

/// Voltage magnitudes at no load: every bus whose voltage no control fixes takes the average of its neighbours'
/// voltages, weighted by the branches' series susceptance 1/|x| and scaled by their off-nominal ratios, with the fixed
/// buses at their targets (OpenLoadFlow's `VoltageMagnitudeInitializer`). Off-nominal transformer ratios set voltage
/// levels far from 1 p.u. in large models; starting there instead of at 1 p.u. keeps Newton's first steps small.
/// Parallel branches add their susceptances and average their ratios. `None` when the system cannot be solved.
pub(crate) fn magnitudes(net: &PuNetwork, fixed: &[Option<f64>]) -> Option<Vec<f64>> {
    let n = net.buses.len();
    // Per bus: (neighbour, summed susceptance, summed ratio, branch count).
    let mut adj: Vec<Vec<(usize, f64, f64, f64)>> = vec![Vec::new(); n];
    for br in &net.branches {
        if br.f == br.t {
            continue;
        }
        let t = C64::from_polar(br.ratio, br.shift);
        let ys = -(br.yft * t.conj());
        let x = ys.inv().im.abs().max(1e-8);
        let b = 1.0 / x;
        for (i, j, r) in [(br.f, br.t, br.ratio), (br.t, br.f, 1.0 / br.ratio)] {
            match adj[i].iter_mut().find(|e| e.0 == j) {
                Some(e) => {
                    e.1 += b;
                    e.2 += r;
                    e.3 += 1.0;
                }
                None => adj[i].push((j, b, r, 1.0)),
            }
        }
    }
    let mut col = vec![usize::MAX; n];
    let mut m = 0;
    for i in 0..n {
        if fixed[i].is_none() && !adj[i].is_empty() {
            col[i] = m;
            m += 1;
        }
    }
    let mut vm: Vec<f64> = (0..n).map(|i| fixed[i].unwrap_or(1.0)).collect();
    if m == 0 {
        return Some(vm);
    }
    let mut builder = CscBuilder::new(m, m);
    let mut vals = Vec::new();
    let mut rhs = vec![0.0; m];
    for i in 0..n {
        let ci = col[i];
        if ci == usize::MAX {
            continue;
        }
        builder.push(ci, ci);
        vals.push(1.0);
        let bs: f64 = adj[i].iter().map(|e| e.1).sum();
        for &(j, b, r, k) in &adj[i] {
            let a = b * (r / k) / bs;
            if col[j] == usize::MAX {
                rhs[ci] += a * vm[j];
            } else {
                builder.push(ci, col[j]);
                vals.push(-a);
            }
        }
    }
    let (pattern, slot) = builder.build();
    let mut values = vec![0.0; pattern.nnz()];
    for (h, v) in vals.into_iter().enumerate() {
        values[slot[h]] += v;
    }
    let mut lu = FaerLu::new();
    lu.analyse(&pattern).ok()?;
    lu.factor(&values).ok()?;
    lu.solve(&mut rhs).ok()?;
    if rhs.iter().any(|v| !v.is_finite() || *v <= 0.0) {
        return None;
    }
    for i in 0..n {
        if col[i] != usize::MAX {
            vm[i] = rhs[col[i]];
        }
    }
    Some(vm)
}
