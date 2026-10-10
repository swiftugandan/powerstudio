//! Studies on the canonical model.
//!
//! Each study takes a [`ps_model::Model`] and its settings, runs the calculation through topology processing and the
//! per-unit network, and reports results by element identifier in engineering units. The report types serialise to
//! the JSON the browser app reads; their field names are part of the engine's interface (docs/ENGINE.md).

pub mod api;
pub mod contingency;
pub mod exchange;
pub mod limits;
pub mod loadflow;
pub mod progress;
pub mod rms;

pub use loadflow::{LoadFlowReport, LoadFlowRun};
pub use progress::{Progress, Silent};
pub use ps_sc as shortcircuit;

use ps_model::{Class, Model};
use ps_topology::Outages;

/// Resolves element identifiers to outages. Unknown identifiers are returned so the caller can report them.
pub fn outages_by_id<'a>(model: &Model, ids: impl IntoIterator<Item = &'a str>) -> (Outages, Vec<String>) {
    let index = model.index();
    let mut out = Outages::none();
    let mut unknown = Vec::new();
    for id in ids {
        let hit = Class::ALL.iter().find_map(|&c| index.get(c, id).map(|row| (c, row)));
        match hit {
            Some((c, row)) => out.insert(c, row),
            None => unknown.push(id.to_string()),
        }
    }
    (out, unknown)
}
