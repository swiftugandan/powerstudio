//! `ps`: the PowerStudio engine on the command line. It runs the same code as the browser engine, natively.
//!
//! ```text
//! ps study <kind> <document.json> [--options <json>]   run a study on a PowerStudio document, print the report
//! ps lf <case.m> [--tol <MVA>] [--qlim] [--flat] [--warm]   load flow of a MATPOWER case, print a summary
//! ps bench <case.m> [--repeat <n>] [--warm]                 time the load flow of a MATPOWER case
//! ```
//!
//! `kind` is one of `loadflow`, `shortcircuit`, `contingency`, `contingency_plan`, `contingency_chunk` or `rms`;
//! the options are those of the browser engine (docs/ENGINE.md).

use std::process::ExitCode;

use ps_study::{LoadFlowRun, Silent, api};
use serde_json::{Value, json};

const USAGE: &str = "usage: ps study <kind> <document.json> [--options <json>]\n       ps lf <case.m> [--tol <MVA>] [--qlim] [--flat] [--warm]\n       ps bench <case.m> [--repeat <n>] [--warm]";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(out) => {
            #[allow(clippy::print_stdout)]
            {
                println!("{out}");
            }
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("ps: {e}");
            ExitCode::FAILURE
        }
    }
}

fn flag(args: &[String], name: &str) -> bool {
    args.iter().any(|a| a == name)
}

fn value<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .map(String::as_str)
}

fn read(path: &str) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))
}

fn run(args: &[String]) -> Result<String, String> {
    match args.first().map(String::as_str) {
        Some("study") => {
            let kind = args.get(1).ok_or(USAGE)?;
            let path = args.get(2).ok_or(USAGE)?;
            let opts: Value = match value(args, "--options") {
                Some(s) => serde_json::from_str(s).map_err(|e| format!("--options: {e}"))?,
                None => Value::Null,
            };
            let imp = ps_io::powerstudio::parse(&read(path)?).map_err(|e| format!("{path}: {e}"))?;
            let loaded = api::Loaded {
                model: imp.model,
                study: imp.study,
            };
            Ok(api::handle(kind, &opts, Some(&loaded), &mut Silent)?.to_string())
        }
        Some(cmd @ ("lf" | "bench")) => {
            let path = args.get(1).ok_or(USAGE)?;
            let text = read(path)?;
            let t0 = ps_num::clock::now_ms();
            let case = ps_io::matpower::parse(&text).map_err(|e| format!("{path}: {e}"))?;
            let t1 = ps_num::clock::now_ms();
            let imp = ps_io::matpower_model::to_model(&case);
            let t2 = ps_num::clock::now_ms();
            let model = &imp.model;
            let tolerance = value(args, "--tol")
                .map(str::parse)
                .transpose()
                .map_err(|e| format!("--tol: {e}"))?;
            let settings = ps_model::study::LoadFlowSettings {
                tolerance: tolerance.unwrap_or(1e-6),
                enforce_q_limits: flag(args, "--qlim"),
                dc_start: !flag(args, "--flat"),
                ..Default::default()
            };
            let warm = flag(args, "--warm");
            let start: Option<Vec<Option<(f64, f64)>>> = warm.then(|| {
                model
                    .nodes
                    .iter()
                    .map(|n| (n.v0 > 0.0).then(|| (n.v0, n.angle0.to_radians())))
                    .collect()
            });
            let lf_run = LoadFlowRun {
                settings,
                start,
                ..Default::default()
            };
            let size = json!({ "case": model.meta.name, "nodes": model.nodes.len(), "branches": model.lines.len() + model.transformers2.len(), "parse_ms": t1 - t0, "convert_ms": t2 - t1 });
            if cmd == "lf" {
                let r = ps_study::loadflow::run(model, &lf_run);
                let buses: Vec<Value> = r.buses.iter().map(|b| json!([b.id, b.vm, b.va])).collect();
                return Ok(json!({ "size": size, "converged": r.converged, "message": r.message, "iterations": r.iterations, "mismatch": r.mismatch, "timing": r.timing, "bus": buses }).to_string());
            }
            let repeat: usize = value(args, "--repeat")
                .map(str::parse)
                .transpose()
                .map_err(|e| format!("--repeat: {e}"))?
                .unwrap_or(3);
            let mut best: Option<ps_study::LoadFlowReport> = None;
            for _ in 0..repeat.max(1) {
                let r = ps_study::loadflow::run(model, &lf_run);
                if best.as_ref().is_none_or(|b| r.timing.total_ms < b.timing.total_ms) {
                    best = Some(r);
                }
            }
            let r = best.ok_or("no runs")?;
            Ok(
                json!({ "size": size, "converged": r.converged, "iterations": r.iterations, "timing_best": r.timing })
                    .to_string(),
            )
        }
        _ => Err(USAGE.into()),
    }
}
