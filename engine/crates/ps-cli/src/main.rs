//! `ps`: the PowerStudio engine on the command line. It runs the same code as the browser engine, natively.
//!
//! ```text
//! ps study <kind> <document.json> [--options <json>]   run a study on a PowerStudio document, print the report
//! ps lf <case.m> [--tol <MVA>] [--qlim] [--flat] [--warm]   load flow of a MATPOWER case, print a summary
//! ps bench <case.m> [--repeat <n>] [--warm]                 time the load flow of a MATPOWER case
//! ps inspect <file|folder|archive>... [--props]              list the CIM classes in CGMES files
//! ps cgmes <file|folder|archive>... [--lf] [--warm] [--model] import CGMES, print the import report (and a load flow)
//! ```
//!
//! `kind` is one of `loadflow`, `shortcircuit`, `contingency`, `contingency_plan`, `contingency_chunk` or `rms`;
//! the options are those of the browser engine (docs/ENGINE.md).

use std::process::ExitCode;

use ps_study::{LoadFlowRun, Silent, api};
use serde_json::{Value, json};

const USAGE: &str = "usage: ps study <kind> <document.json> [--options <json>]\n       ps lf <case.m> [--tol <MVA>] [--qlim] [--flat] [--warm]\n       ps bench <case.m> [--repeat <n>] [--warm]\n       ps inspect <file|folder|archive>... [--props]\n       ps cgmes <file|folder|archive>... [--lf] [--warm] [--model]";

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
        Some("cgmes") => {
            let paths: Vec<String> = args[1..].iter().filter(|a| !a.starts_with("--")).cloned().collect();
            let t0 = ps_num::clock::now_ms();
            let files = ps_io::files::read_paths(&paths).map_err(|e| e.to_string())?;
            let imp = ps_io::cgmes::import(&files).map_err(|e| e.to_string())?;
            let import_ms = ps_num::clock::now_ms() - t0;
            let m = &imp.model;
            let size = json!({
                "nodes": m.nodes.len(), "switches": m.switches.len(), "lines": m.lines.len(), "transformers2": m.transformers2.len(),
                "transformers3": m.transformers3.len(), "generators": m.generators.len(), "loads": m.loads.len(),
                "shunts": m.shunts.len(), "svcs": m.svcs.len(), "import_ms": import_ms,
            });
            let mut out = json!({ "size": size, "report": imp.report, "issues": m.validate() });
            if flag(args, "--model") {
                out["model"] = serde_json::to_value(m).map_err(|e| e.to_string())?;
            }
            if flag(args, "--lf") {
                let warm = flag(args, "--warm");
                let start: Option<Vec<Option<(f64, f64)>>> = warm.then(|| {
                    m.nodes
                        .iter()
                        .map(|n| (n.v0 > 0.0).then(|| (n.v0, n.angle0.to_radians())))
                        .collect()
                });
                let settings = ps_model::study::LoadFlowSettings {
                    tolerance: 1e-6,
                    ..Default::default()
                };
                let r = ps_study::loadflow::run(
                    m,
                    &LoadFlowRun {
                        settings,
                        start,
                        ..Default::default()
                    },
                );
                out["loadflow"] = serde_json::to_value(&r).map_err(|e| e.to_string())?;
            }
            Ok(out.to_string())
        }
        Some("inspect") => {
            let paths: Vec<String> = args[1..].iter().filter(|a| !a.starts_with("--")).cloned().collect();
            let t0 = ps_num::clock::now_ms();
            let files = ps_io::files::read_paths(&paths).map_err(|e| e.to_string())?;
            let mut graph = ps_io::rdf::Graph::new();
            let mut bytes = 0;
            for f in files.iter().filter(|f| f.name.to_ascii_lowercase().ends_with(".xml")) {
                graph.read(&f.name, &f.data).map_err(|e| e.to_string())?;
                bytes += f.data.len();
            }
            let ms = ps_num::clock::now_ms() - t0;
            let mut classes = serde_json::Map::new();
            for (class, count) in graph.class_counts() {
                let mut entry = json!({ "count": count });
                if flag(args, "--props") {
                    let mut props: Vec<String> = graph
                        .of_class(&class)
                        .flat_map(|o| o.props.iter().map(|(p, _)| graph.name(*p).to_string()))
                        .collect();
                    props.sort();
                    props.dedup();
                    entry["props"] = json!(props);
                }
                classes.insert(class, entry);
            }
            let headers: Vec<Value> = graph
                .headers
                .iter()
                .map(|h| json!({ "file": h.file, "profiles": h.profiles }))
                .collect();
            Ok(json!({ "files": headers, "bytes": bytes, "objects": graph.objects.len(), "read_ms": ms, "classes": classes }).to_string())
        }
        _ => Err(USAGE.into()),
    }
}
