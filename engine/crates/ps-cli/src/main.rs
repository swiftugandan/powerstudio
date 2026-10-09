//! `ps`: the PowerStudio engine on the command line. It runs the same code as the browser engine, natively.
//!
//! ```text
//! ps study <kind> <document.json> [--options <json>]   run a study on a PowerStudio document, print the report
//! ps lf <case.m> [--tol <MVA>] [--qlim] [--flat] [--warm]   load flow of a MATPOWER case, print a summary
//! ps bench <case.m> [--repeat <n>] [--warm]                 time the load flow of a MATPOWER case
//! ps inspect <file|folder|archive>... [--props]              list the CIM classes in CGMES files
//! ps cgmes <file|folder|archive>... [--lf] [--warm] [--model] import CGMES, print the import report (and a load flow)
//! ps cgmes <file|folder|archive>... --sv <out.xml> [--warm] [--solution <file>]
//!                                                             solve and write the state variables (SV) profile, and
//!                                                             the state by element and node as JSON
//! ps psse <case.raw> [--lf] [--warm] [--model]                import PSS/E RAW (versions 33 and 35), the same way
//! ps export <input>... --raw <33|35> [--out <file>] [--solution <file>]
//!                                                             write any model PowerStudio reads as PSS/E RAW, and
//!                                                             the engine's load flow by RAW bus number
//! ```
//!
//! `kind` is one of `loadflow`, `shortcircuit`, `contingency`, `contingency_plan`, `contingency_chunk` or `rms`;
//! the options are those of the browser engine (docs/ENGINE.md).

use std::process::ExitCode;

use ps_study::{LoadFlowRun, Silent, api};
use serde_json::{Value, json};

const USAGE: &str = "usage: ps study <kind> <document.json> [--options <json>]\n       ps lf <case.m> [--tol <MVA>] [--qlim] [--flat] [--warm]\n       ps bench <case.m> [--repeat <n>] [--warm]\n       ps inspect <file|folder|archive>... [--props]\n       ps cgmes <file|folder|archive>... [--lf] [--warm] [--model] [--sv <out.xml>]\n       ps psse <case.raw> [--lf] [--warm] [--model]\n       ps export <input>... --raw <33|35> [--out <file>] [--solution <file>]";

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

/// Prints an imported model's size, report and validation, with `--model` the model and with `--lf` a load flow
/// (`--warm` starts it from the voltages in the files).
fn imported(
    m: &ps_model::Model,
    report: &ps_io::report::ImportReport,
    import_ms: f64,
    args: &[String],
) -> Result<String, String> {
    let size = json!({
        "nodes": m.nodes.len(), "switches": m.switches.len(), "lines": m.lines.len(), "transformers2": m.transformers2.len(),
        "transformers3": m.transformers3.len(), "generators": m.generators.len(), "loads": m.loads.len(),
        "shunts": m.shunts.len(), "svcs": m.svcs.len(), "import_ms": import_ms,
    });
    let mut out = json!({ "size": size, "report": report, "issues": m.validate() });
    if flag(args, "--model") {
        out["model"] = serde_json::to_value(m).map_err(|e| e.to_string())?;
    }
    if flag(args, "--lf") {
        let start: Option<Vec<Option<(f64, f64)>>> = flag(args, "--warm").then(|| {
            m.nodes
                .iter()
                .map(|n| (n.v0 > 0.0).then(|| (n.v0, n.angle0.to_radians())))
                .collect()
        });
        let settings = ps_model::study::LoadFlowSettings {
            tolerance: 1e-6,
            ..ps_model::study::LoadFlowSettings::plain()
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

/// The current time in UTC, ISO 8601 to the second.
fn iso_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs()) as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// Arguments that are not flags or flag values.
fn positional(args: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    let mut skip = true; // the command itself
    for a in args {
        if skip {
            skip = false;
        } else if a.starts_with("--") {
            skip = matches!(
                a.as_str(),
                "--raw" | "--out" | "--solution" | "--sv" | "--options" | "--tol" | "--repeat"
            );
        } else {
            out.push(a.clone());
        }
    }
    out
}

/// A model from any format PowerStudio reads, by file extension: `.json` (PowerStudio), `.m` (MATPOWER), `.raw`
/// (PSS/E); anything else is read as CGMES (XML files, folders or zip archives).
fn load_any(paths: &[String]) -> Result<ps_model::Model, String> {
    let first = paths.first().ok_or(USAGE)?;
    let ext = std::path::Path::new(first)
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    match ext.as_deref() {
        Some("json") => Ok(ps_io::powerstudio::parse(&read(first)?)
            .map_err(|e| format!("{first}: {e}"))?
            .model),
        Some("m") => {
            let case = ps_io::matpower::parse(&read(first)?).map_err(|e| format!("{first}: {e}"))?;
            Ok(ps_io::matpower_model::to_model(&case).model)
        }
        Some("raw") => {
            let bytes = std::fs::read(first).map_err(|e| format!("{first}: {e}"))?;
            Ok(ps_io::psse_model::import(&ps_io::psse::decode(&bytes), first)
                .map_err(|e| format!("{first}: {e}"))?
                .model)
        }
        _ => {
            let files = ps_io::files::read_paths(paths).map_err(|e| e.to_string())?;
            Ok(ps_io::cgmes::import(&files).map_err(|e| e.to_string())?.model)
        }
    }
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
                ..ps_model::study::LoadFlowSettings::plain()
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
            let paths = positional(args);
            let t0 = ps_num::clock::now_ms();
            let files = ps_io::files::read_paths(&paths).map_err(|e| e.to_string())?;
            let imp = ps_io::cgmes::import(&files).map_err(|e| e.to_string())?;
            if let Some(path) = value(args, "--sv") {
                // State variables of the model's load flow, for the files it was read from.
                let settings = ps_model::study::LoadFlowSettings {
                    tolerance: 1e-8,
                    max_iter: 50,
                    ..ps_model::study::LoadFlowSettings::plain()
                };
                let start: Option<Vec<Option<(f64, f64)>>> = flag(args, "--warm").then(|| {
                    imp.model
                        .nodes
                        .iter()
                        .map(|n| (n.v0 > 0.0).then(|| (n.v0, n.angle0.to_radians())))
                        .collect()
                });
                let (calc, sol, report) = ps_study::loadflow::solve(
                    &imp.model,
                    &LoadFlowRun {
                        settings,
                        start,
                        ..Default::default()
                    },
                );
                if !report.converged {
                    return Err(format!("the load flow does not converge: {}", report.message));
                }
                let state = ps_study::exchange::sv_state(&imp.model, &calc, &sol, &report);
                if let Some(out) = value(args, "--solution") {
                    // The state by element: voltage (p.u. of each end's node, degrees) and power into each terminal.
                    let mut elements = serde_json::Map::new();
                    for (id, flows) in &state.flows {
                        elements.insert(id.clone(), json!(flows));
                    }
                    let nodes: serde_json::Map<String, Value> = imp
                        .model
                        .nodes
                        .iter()
                        .zip(&state.node_v)
                        .filter_map(|(n, v)| Some((n.id.clone(), json!(v.as_ref()?))))
                        .collect();
                    let solution = json!({ "flows": elements, "nodes": nodes });
                    std::fs::write(out, solution.to_string()).map_err(|e| format!("{out}: {e}"))?;
                }
                let opt = ps_io::cgmes_sv::Options {
                    created: iso_now(),
                    description: "Load flow by PowerStudio".into(),
                };
                let sv = ps_io::cgmes_sv::write(&files, &imp.model, &state, &opt)?;
                std::fs::write(path, &sv.text).map_err(|e| format!("{path}: {e}"))?;
                for note in &sv.notes {
                    eprintln!("note: {note}");
                }
                return Ok(json!({ "written": path, "counts": sv.counts }).to_string());
            }
            imported(&imp.model, &imp.report, ps_num::clock::now_ms() - t0, args)
        }
        Some("psse") => {
            let path = args.get(1).ok_or(USAGE)?;
            let t0 = ps_num::clock::now_ms();
            let text = ps_io::psse::decode(&std::fs::read(path).map_err(|e| format!("{path}: {e}"))?);
            let name = std::path::Path::new(path)
                .file_name()
                .map_or(path.as_str(), |n| n.to_str().unwrap_or(path));
            let imp = ps_io::psse_model::import(&text, name).map_err(|e| format!("{path}: {e}"))?;
            imported(&imp.model, &imp.report, ps_num::clock::now_ms() - t0, args)
        }
        Some("export") => {
            let inputs: Vec<String> = positional(args);
            let model = load_any(&inputs)?;
            let rev: u32 = value(args, "--raw")
                .ok_or(USAGE)?
                .parse()
                .map_err(|e| format!("--raw: {e}"))?;
            let written = ps_io::psse_write::write(&model, &ps_io::psse_write::Options { rev, voltages: None })?;
            for note in &written.notes {
                eprintln!("note: {note}");
            }
            if let Some(path) = value(args, "--solution") {
                // The engine's own load flow of the model, by RAW bus number: [V p.u., angle degrees].
                let settings = ps_model::study::LoadFlowSettings {
                    tolerance: 1e-8,
                    max_iter: 50,
                    ..ps_model::study::LoadFlowSettings::plain()
                };
                let (calc, sol, report) = ps_study::loadflow::solve(
                    &model,
                    &LoadFlowRun {
                        settings,
                        ..Default::default()
                    },
                );
                let mut buses = serde_json::Map::new();
                for (k, bus) in written.bus_of_node.iter().enumerate() {
                    let (Some(bus), Some(b)) = (bus, calc.topo.bus_of(ps_model::NodeRef(k as u32))) else {
                        continue;
                    };
                    buses.insert(bus.to_string(), json!([sol.vm[b], sol.va[b].to_degrees()]));
                }
                let out = json!({ "converged": report.converged, "message": report.message, "buses": buses });
                std::fs::write(path, out.to_string()).map_err(|e| format!("{path}: {e}"))?;
            }
            match value(args, "--out") {
                Some(path) => {
                    std::fs::write(path, &written.text).map_err(|e| format!("{path}: {e}"))?;
                    Ok(format!("{path}: {} bytes", written.text.len()))
                }
                None => Ok(written.text),
            }
        }
        Some("inspect") => {
            let paths = positional(args);
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
