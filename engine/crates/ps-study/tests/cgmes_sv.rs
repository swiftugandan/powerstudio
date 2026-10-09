//! CGMES state variables (SV) export, checked by reading it back: each configuration is solved, its SV written, and
//! the configuration read again with the exported SV in place of its own. Every node must start from the voltage
//! PowerStudio solved (the importer takes SvVoltage as the starting point), and a load flow started there must have
//! nothing to do: no iteration, the same solution. Writing the same state twice must give the same file.
//!
//! PowSyBl reading the exported SV is checked separately (`scripts/oracle/sv_check.py`).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use common::*;
use ps_model::study::LoadFlowSettings;
use ps_study::{LoadFlowRun, loadflow};

fn is_sv(f: &ps_io::files::File) -> bool {
    let head = String::from_utf8_lossy(&f.data[..f.data.len().min(4096)]).into_owned();
    head.contains("StateVariables")
}

#[test]
fn exported_sv_reads_back_as_the_solved_state() {
    let cases = json("tests/oracle/cgmes-cases.json");
    let mut failures = Vec::new();
    for case in cases["cases"].as_array().unwrap() {
        if case["loadflow"] == false {
            continue;
        }
        let name = case["name"].as_str().unwrap();
        let files = cgmes_files(case);
        let model = ps_io::cgmes::import(&files).unwrap().model;
        let warm = (case["start"] == "sv").then(|| {
            model
                .nodes
                .iter()
                .map(|n| (n.v0 > 0.0).then(|| (n.v0, n.angle0.to_radians())))
                .collect()
        });
        let run = LoadFlowRun {
            settings: LoadFlowSettings {
                tolerance: 1e-9,
                max_iter: 50,
                ..Default::default()
            },
            start: warm,
            ..Default::default()
        };
        let (calc, sol, report) = loadflow::solve(&model, &run);
        assert!(report.converged, "{name}: {}", report.message);
        let state = ps_study::exchange::sv_state(&model, &calc, &sol, &report);
        let opt = ps_io::cgmes_sv::Options {
            created: "2026-10-09T12:00:00Z".into(),
            description: "test".into(),
        };
        let sv = ps_io::cgmes_sv::write(&files, &model, &state, &opt).unwrap();
        let again = ps_io::cgmes_sv::write(&files, &model, &state, &opt).unwrap();
        if sv.text != again.text {
            failures.push(format!("{name}: two exports of the same state differ"));
        }
        let mut swapped: Vec<ps_io::files::File> = files.into_iter().filter(|f| !is_sv(f)).collect();
        swapped.push(ps_io::files::File {
            name: "PowerStudio_SV.xml".into(),
            data: sv.text.into_bytes(),
        });
        let back = ps_io::cgmes::import(&swapped).unwrap().model;
        let mut w = Worst::default();
        for (k, v) in state.node_v.iter().enumerate() {
            let Some((vm, va)) = v else { continue };
            let node = &back.nodes[k];
            if node.v0 > 0.0 {
                w.check("V", &node.id, node.v0, *vm);
                w.check("angle", &node.id, node.angle0, *va);
            }
        }
        // Started from the exported state, the load flow must return to it.
        let start = back
            .nodes
            .iter()
            .map(|n| (n.v0 > 0.0).then(|| (n.v0, n.angle0.to_radians())))
            .collect();
        let (calc2, sol2, again) = loadflow::solve(
            &back,
            &LoadFlowRun {
                start: Some(start),
                ..run
            },
        );
        for (k, v) in state.node_v.iter().enumerate() {
            let Some((vm, va)) = v else { continue };
            if let Some(b) = calc2.topo.bus_of(ps_model::NodeRef(k as u32)) {
                w.check("restart V", &back.nodes[k].id, sol2.vm[b], *vm);
                w.check("restart angle", &back.nodes[k].id, sol2.va[b].to_degrees(), *va);
            }
        }
        let (v, a) = (w.max("V"), w.max("angle"));
        let (rv, ra) = (w.max("restart V"), w.max("restart angle"));
        eprintln!(
            "SUMMARY {name}: read back V {v:.1e} p.u., angle {a:.1e}°; restart {} iteration(s), V {rv:.1e}, angle {ra:.1e}°",
            again.iterations
        );
        if v > 1e-12 || a > 1e-9 || !again.converged || again.iterations > 0 || rv > 1e-9 || ra > 1e-7 {
            failures.push(format!(
                "{name}: read back V {v:.1e}, angle {a:.1e}; restart V {rv:.1e}, angle {ra:.1e}"
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
