//! Stability study: a load flow for the initial state, then the simulation of the machines and their controls.

use ps_model::Model;
use ps_model::study::{RmsSettings, StudyCase};

pub use ps_dyn::{AppliedEvent, EventSteps, MachineTrace, Options, RmsReport, Trajectory};

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
    run_detailed(model, study, rms, max_samples, Options::default(), progress).map(|(r, _)| r)
}

/// [`run`], with solver options and the full-precision trajectory at the report's samples.
pub fn run_detailed(
    model: &Model,
    study: &StudyCase,
    rms: &RmsSettings,
    max_samples: usize,
    options: Options,
    progress: &mut dyn Progress,
) -> Result<(RmsReport, Trajectory), String> {
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
    ps_dyn::simulate_detailed(model, &calc, &sol, rms, max_samples, options, &mut |t, end| {
        progress.report(t, end)
    })
}
