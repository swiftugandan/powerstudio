//! Branch limits and loading.
//!
//! A branch end may carry several current limits: a permanent one and temporary ones that hold for a stated time
//! (CGMES operational limits; a drawn line's rating). The limit that applies to an overload expected to last `d`
//! seconds is the largest whose duration is at least `d`, the permanent one included; without `d`, only the permanent
//! one applies. Loading is the worst end against its own limit, so ends with different ratings are judged apart.

use ps_model::{Class, CurrentLimit, Model};
use ps_net::BranchSource;

/// The applicable current limit of each end of a calculation branch, kA; `None` for an end without one. A
/// three-winding transformer's winding branch has its winding's limits at its from end and none at the star point.
pub fn end_limits(model: &Model, src: BranchSource, duration_s: Option<f64>) -> [Option<f64>; 2] {
    let row = src.row as usize;
    let (limits, ends): (&[CurrentLimit], [u8; 2]) = match src.class {
        Class::Line => (&model.lines[row].limits, [1, 2]),
        Class::Transformer2 => (&model.transformers2[row].limits, [1, 2]),
        Class::Transformer3 => (&model.transformers3[row].limits, [src.winding, 0]),
        _ => (&[], [0, 0]),
    };
    ends.map(|end| {
        limits
            .iter()
            .filter(|l| l.end == end && l.amps > 0.0)
            .filter(|l| match (l.duration_s, duration_s) {
                (None, _) => true,
                (Some(t), Some(d)) => t >= d,
                (Some(_), None) => false,
            })
            .map(|l| l.amps / 1000.0)
            .fold(None, |m: Option<f64>, a| Some(m.map_or(a, |m| m.max(a))))
    })
}

/// Rated power of a calculation branch for loading by apparent power (transformers without current limits), MVA.
pub fn rated_mva(model: &Model, src: BranchSource) -> Option<f64> {
    let row = src.row as usize;
    let r = match src.class {
        Class::Transformer2 => model.transformers2[row].rated_mva,
        Class::Transformer3 => model.transformers3[row].windings[usize::from(src.winding.max(1)) - 1].rated_mva,
        _ => 0.0,
    };
    (r > 0.0).then_some(r)
}

/// Loading of a branch, %: the worst end's current against its limit; for a transformer without current limits, the
/// larger apparent power against its rating. `None` when the branch has no rating.
pub fn loading(limits: [Option<f64>; 2], rated_mva: Option<f64>, i_ka: [f64; 2], s_mva: [f64; 2]) -> Option<f64> {
    let by_current = limits
        .iter()
        .zip(i_ka)
        .filter_map(|(l, i)| l.map(|l| i / l * 100.0))
        .fold(None, |m: Option<f64>, x| Some(m.map_or(x, |m| m.max(x))));
    by_current.or_else(|| rated_mva.map(|r| s_mva[0].max(s_mva[1]) / r * 100.0))
}
