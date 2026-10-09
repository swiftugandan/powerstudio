//! Branch flows and bus injections from a solved state.

use ps_num::C64;

use crate::{PuNetwork, Ybus};

/// Flows at both ends of a branch.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BranchFlow {
    /// Caller's identifier of the branch.
    pub id: usize,
    /// Complex power entering at the from end, p.u.
    pub s_from: C64,
    /// Complex power entering at the to end, p.u.
    pub s_to: C64,
    /// Current magnitude at the from end, kA.
    pub i_from_ka: f64,
    /// Current magnitude at the to end, kA.
    pub i_to_ka: f64,
}

/// Bus power injections `S = V·conj(Y·V)`, p.u.
pub fn bus_injections(y: &Ybus, vm: &[f64], va: &[f64]) -> Vec<C64> {
    let v: Vec<C64> = vm.iter().zip(va).map(|(&m, &a)| C64::from_polar(m, a)).collect();
    let mut cur = vec![C64::ZERO; y.n];
    y.mul(&v, &mut cur);
    v.iter().zip(&cur).map(|(&vi, &ii)| vi * ii.conj()).collect()
}

/// Flows on every branch for a solved state.
pub fn branch_flows(net: &PuNetwork, vm: &[f64], va: &[f64]) -> Vec<BranchFlow> {
    let sb = net.base_mva;
    net.branches
        .iter()
        .map(|b| {
            let vf = C64::from_polar(vm[b.f], va[b.f]);
            let vt = C64::from_polar(vm[b.t], va[b.t]);
            let i_f = b.yff * vf + b.yft * vt;
            let i_t = b.ytf * vf + b.ytt * vt;
            // |I| in kA = |I p.u.| · S_base / (√3 · U_base).
            let kf = sb / (3.0_f64.sqrt() * net.buses[b.f].base_kv);
            let kt = sb / (3.0_f64.sqrt() * net.buses[b.t].base_kv);
            BranchFlow {
                id: b.id,
                s_from: vf * i_f.conj(),
                s_to: vt * i_t.conj(),
                i_from_ka: i_f.abs() * kf,
                i_to_ka: i_t.abs() * kt,
            }
        })
        .collect()
}
