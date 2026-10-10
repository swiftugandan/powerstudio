//! Contingency analysis against PowSyBl's security analysis (OpenLoadFlow, goldens from `scripts/oracle/security.py`):
//! every single-element outage of the PSS/E reference cases, and of the 2,000-bus ACTIVSg grid, solved with every
//! control off. For each outage, the ten branches whose active power changes most are compared at both ends, and
//! the five buses whose voltage changes most. An outage OpenLoadFlow does not solve is skipped; the test prints
//! which, and how many outages took the fast path (the base network with its ordering reused).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use common::*;
use ps_model::study::{Contingency, LoadFlowSettings, StudyCase};
use ps_study::contingency;
use serde_json::Value;

const V_TOL: f64 = 1e-6;
const POWER_TOL: f64 = 1e-3;

fn study() -> StudyCase {
    StudyCase {
        loadflow: LoadFlowSettings {
            tolerance: 1e-8,
            max_iter: 50,
            ..LoadFlowSettings::plain()
        },
        ..StudyCase::default()
    }
}

fn compare(name: &str, model: &ps_model::Model, start: bool, golden: &Value, rows: &mut Vec<String>) {
    let mut model = model.clone();
    if !start {
        for n in &mut model.nodes {
            n.v0 = 0.0;
        }
    }
    let want = golden["contingencies"].as_object().unwrap();
    let list: Vec<Contingency> = want
        .keys()
        .map(|id| Contingency {
            id: id.clone(),
            name: String::new(),
            elements: vec![id.clone()],
        })
        .collect();
    let got = contingency::detailed(&model, &study(), &list).unwrap();
    let mut w = Worst::default();
    let (mut skipped, mut reused) = (0, 0);
    for d in &got {
        let g = &want[&d.id];
        // OpenLoadFlow did not solve it, or it cut the slack bus off (each tool then picks its own reference).
        if g["status"] != "CONVERGED" || g["slack_cut"] == true {
            skipped += 1;
            continue;
        }
        reused += usize::from(d.reused);
        if !d.converged {
            w.check("converged", &format!("{}: {}", d.id, d.message), 0.0, 1.0);
            continue;
        }
        for (b, v) in g["branches"].as_object().into_iter().flatten() {
            match d.flows.get(b) {
                Some(f) => {
                    for k in 0..4 {
                        w.check(
                            ["p1", "q1", "p2", "q2"][k],
                            &format!("{} after {}", b, d.id),
                            f[k],
                            f64_of(&v[k]),
                        );
                    }
                }
                None => w.check("branch solved", &format!("{} after {}", b, d.id), 0.0, 1.0),
            }
        }
        for (bus, v) in g["buses"].as_object().into_iter().flatten() {
            let id = bus
                .strip_prefix("BUS-")
                .map_or_else(|| bus.clone(), |n| format!("B{n}"));
            match d.voltages.get(&id) {
                Some(&(vm, _)) => w.check("V", &format!("{} after {}", id, d.id), vm, f64_of(v)),
                None => w.check("bus solved", &format!("{} after {}", id, d.id), 0.0, 1.0),
            }
        }
    }
    let flow = ["p1", "q1", "p2", "q2"].iter().map(|k| w.max(k)).fold(0.0, f64::max);
    let bad =
        w.max("V") > V_TOL || flow > POWER_TOL || w.rows.iter().any(|r| r.0.contains("solved") || r.0 == "converged");
    let worst: Vec<String> = w
        .rows
        .iter()
        .map(|r| format!("{} {:.1e} at {}", r.0, r.1, r.2))
        .collect();
    rows.push(format!(
        "{} {name}: {} outages ({reused} on the base network, {skipped} skipped); {}",
        if bad { "FAIL" } else { "ok  " },
        got.len(),
        worst.join("; ")
    ));
}

fn f64_of(v: &Value) -> f64 {
    v.as_f64().unwrap_or(f64::NAN)
}

#[test]
fn outages_agree_with_powsybl_security_analysis() {
    let mut rows = Vec::new();
    let cases = json("tests/oracle/psse-cases.json");
    for case in cases["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        if case["loadflow"] == false || !repo(&format!("tests/oracle/golden/security-{name}.json")).exists() {
            continue;
        }
        let golden = golden(&format!("security-{name}"));
        compare(
            name,
            &psse_import(case).model,
            case["start"] == "raw",
            &golden,
            &mut rows,
        );
    }
    let mp = json("tests/oracle/matpower-cases.json");
    for entry in mp["cases"].as_array().unwrap() {
        let name = entry["name"].as_str().unwrap();
        if !repo(&format!("tests/oracle/golden/security-{name}.json")).exists() {
            continue;
        }
        let file = mp["archives"][entry["archive"].as_str().unwrap()]["file"]
            .as_str()
            .unwrap();
        let text = std::fs::read_to_string(repo(&format!(".cache/reference/{file}"))).unwrap();
        let model = ps_io::matpower_model::to_model(&ps_io::matpower::parse(&text).unwrap()).model;
        compare(
            name,
            &model,
            entry["start"] == "case",
            &golden(&format!("security-{name}")),
            &mut rows,
        );
    }
    for r in &rows {
        eprintln!("{r}");
    }
    let failed = rows.iter().filter(|r| r.starts_with("FAIL")).count();
    assert_eq!(failed, 0, "{failed} of {} cases differ from PowSyBl", rows.len());
}
