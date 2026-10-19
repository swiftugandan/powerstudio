//! Electromagnetic transient study: a load flow for the operating point, then the three-phase simulation.

use ps_model::Model;
use ps_model::study::{EmtSettings, StudyCase};

pub use ps_emt::{EmtReport, Options};

use crate::loadflow::{self, LoadFlowRun};
use crate::progress::Progress;

/// Samples kept per trace unless the caller asks otherwise.
pub const DEFAULT_SAMPLES: usize = 10_000;

/// Runs the simulation with the study case's load flow settings and the given EMT settings.
pub fn run(
    model: &Model,
    study: &StudyCase,
    emt: &EmtSettings,
    max_samples: usize,
    options: Options,
    progress: &mut dyn Progress,
) -> Result<EmtReport, String> {
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
    ps_emt::simulate(model, &calc, &sol, emt, max_samples, options, &mut |t, end| {
        progress.report(t, end)
    })
}
