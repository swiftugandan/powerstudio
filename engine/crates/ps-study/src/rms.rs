//! Stability study: a load flow for the initial state, then the classical-model simulation.

use ps_model::Model;
use ps_model::study::{RmsSettings, StudyCase};

pub use ps_dyn::classical::{AppliedEvent, MachineTrace, RmsReport};

use crate::loadflow::{self, LoadFlowRun};
use crate::progress::Progress;

/// Samples kept per trace unless the caller asks otherwise.
pub const DEFAULT_SAMPLES: usize = 4000;

/// Runs the simulation with the study case's load flow settings and the given simulation settings.
pub fn run(
    model: &Model,
    study: &StudyCase,
    rms: &RmsSettings,
    max_samples: usize,
    progress: &mut dyn Progress,
) -> Result<RmsReport, String> {
    let (mut calc, sol, report) = loadflow::solve(
        model,
        &LoadFlowRun {
            settings: study.loadflow,
            ..Default::default()
        },
    );
    if !report.converged {
        return Err(format!("The initial load flow does not converge: {}", report.message));
    }
    // The simulation starts from the network as solved: final taps and sections, and each load's consumption at its
    // solved voltage.
    calc.net = sol.net.clone();
    for (l, &(p, q)) in calc.net.loads.iter_mut().zip(&sol.loads) {
        l.p = p;
        l.q = q;
    }
    ps_dyn::classical::simulate(model, &calc, &sol, rms, max_samples, &mut |t, end| {
        progress.report(t, end)
    })
}
