//! PSS/E RAW export, checked by reading the file back: every model the oracle tests use (PowerStudio samples,
//! MATPOWER cases, CGMES configurations, PSS/E files) is solved, written as RAW versions 33 and 35, read back and
//! solved again. Every node must keep its voltage, through the bus the writer put it on, to 1e-9 p.u. and 1e-7°.
//!
//! The writer expresses each branch from the engine's own per-unit conversion, so the two solutions agree to
//! rounding. PowSyBl reading the same files is checked separately (`scripts/oracle/export_check.py`).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use common::*;
use ps_model::Model;
use ps_model::study::LoadFlowSettings;
use ps_study::{LoadFlowRun, loadflow};

const V_TOL: f64 = 1e-9;
const ANGLE_TOL: f64 = 1e-7;

/// Solved voltage of every node (p.u., degrees), `None` where the node is not energised.
fn solve(m: &Model) -> Result<Vec<Option<(f64, f64)>>, String> {
    // 1e-8 MVA: the largest cases here cannot get much below that in double precision.
    let settings = LoadFlowSettings {
        tolerance: 1e-8,
        max_iter: 50,
        ..LoadFlowSettings::plain()
    };
    let (calc, sol, report) = loadflow::solve(
        m,
        &LoadFlowRun {
            settings,
            ..Default::default()
        },
    );
    if !report.converged {
        return Err(report.message);
    }
    Ok((0..m.nodes.len())
        .map(|k| {
            calc.topo
                .bus_of(ps_model::NodeRef(k as u32))
                .map(|b| (sol.vm[b], sol.va[b].to_degrees()))
        })
        .collect())
}

fn round_trip(name: &str, m: &Model, failures: &mut Vec<String>) {
    let before = match solve(m) {
        Ok(v) => v,
        Err(e) => {
            failures.push(format!("{name}: the original does not solve: {e}"));
            return;
        }
    };
    for rev in [33, 35] {
        let written = ps_io::psse_write::write(m, &ps_io::psse_write::Options { rev, voltages: None }).unwrap();
        let back = match ps_io::psse_model::import(&written.text, "export.raw") {
            Ok(b) => b.model,
            Err(e) => {
                failures.push(format!("{name} v{rev}: the written file does not read back: {e}"));
                continue;
            }
        };
        let after = match solve(&back) {
            Ok(v) => v,
            Err(e) => {
                failures.push(format!("{name} v{rev}: the written file does not solve: {e}"));
                continue;
            }
        };
        let node_of: std::collections::HashMap<&str, usize> =
            back.nodes.iter().enumerate().map(|(k, n)| (n.id.as_str(), k)).collect();
        let mut w = Worst::default();
        for (k, v) in before.iter().enumerate() {
            let (Some((vm, va)), Some(bus)) = (v, written.bus_of_node[k]) else {
                continue;
            };
            let id = &m.nodes[k].id;
            match node_of.get(format!("B{bus}").as_str()).and_then(|&j| after[j]) {
                Some((vm2, va2)) => {
                    w.check("V", id, vm2, *vm);
                    w.check("angle", id, va2, *va);
                }
                None => w.check("bus missing after the round trip", id, 1.0, 0.0),
            }
        }
        let (dv, da) = (w.max("V"), w.max("angle"));
        eprintln!("SUMMARY {name} v{rev}: V {dv:.1e} p.u., angle {da:.1e}°");
        if dv > V_TOL || da > ANGLE_TOL {
            for note in &written.notes {
                eprintln!("  export note: {note}");
            }
        }
        for (what, d, at, _) in w.rows.iter().filter(|r| r.1 > 0.0) {
            if (what == "V" && *d > V_TOL) || (what == "angle" && *d > ANGLE_TOL) || what.starts_with("bus") {
                failures.push(format!("{name} v{rev}: {what} {d:.1e} at {at}"));
            }
        }
    }
}

#[test]
fn raw_export_reads_back_to_the_same_solution() {
    let mut failures = Vec::new();
    for name in ["ieee14", "riverside"] {
        let input = input(name);
        round_trip(name, &input.model, &mut failures);
    }
    for case in ["case14", "case30", "case118"] {
        let parsed = ps_io::matpower::parse(&read(&format!("tests/fixtures/{case}.m"))).unwrap();
        round_trip(case, &ps_io::matpower_model::to_model(&parsed).model, &mut failures);
    }
    let matpower = json("tests/oracle/matpower-cases.json");
    for case in ["activsg2000", "pegase2869"] {
        let entry = matpower["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["name"] == case)
            .unwrap();
        let file = matpower["archives"][entry["archive"].as_str().unwrap()]["file"]
            .as_str()
            .unwrap();
        let text = std::fs::read_to_string(repo(&format!(".cache/reference/{file}"))).unwrap();
        let model = ps_io::matpower_model::to_model(&ps_io::matpower::parse(&text).unwrap()).model;
        round_trip(case, &model, &mut failures);
    }
    let cgmes = json("tests/oracle/cgmes-cases.json");
    for case in cgmes["cases"].as_array().unwrap() {
        if case["loadflow"] == false || case["start"] == "sv" {
            continue;
        }
        let name = case["name"].as_str().unwrap();
        let model = ps_io::cgmes::import(&cgmes_files(case)).unwrap().model;
        round_trip(name, &model, &mut failures);
    }
    let psse = json("tests/oracle/psse-cases.json");
    for case in psse["cases"].as_array().unwrap() {
        if case["loadflow"] == false {
            continue;
        }
        round_trip(case["name"].as_str().unwrap(), &psse_import(case).model, &mut failures);
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
