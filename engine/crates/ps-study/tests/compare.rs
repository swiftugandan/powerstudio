//! The operator benchmark kit's comparison (docs/BENCHMARK-KIT.md): PowSyBl's load flow of the IEEE 14-bus PSS/E case
//! (the oracle golden), written as an operator's tool would export it, compares within tolerance; a changed value and
//! a bus the model lacks are reported.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use std::collections::HashMap;

use common::*;
use ps_study::compare::{Tolerances, compare, markdown, parse_csv};

/// The golden's load flow as the kit's tables: buses by PSS/E number, branches by `from-to-circuit`, angles shifted
/// by 30° (another tool's reference angle).
fn tables(golden: &serde_json::Value, shift_bus: Option<(&str, f64)>) -> Vec<ps_study::compare::Table> {
    let lf = &golden["loadflow"];
    let mut buses = String::from("bus,u_pu,angle_deg\n");
    for (id, v) in lf["buses"].as_object().unwrap() {
        let number = id.trim_start_matches('B');
        let mut u = f(&v[0]);
        if let Some((_, du)) = shift_bus.filter(|(b, _)| *b == number) {
            u += du;
        }
        buses.push_str(&format!("{number},{u},{}\n", f(&v[1]) + 30.0));
    }
    let mut branches = String::from("branch,p_from_mw,q_from_mvar,p_to_mw,q_to_mvar\n");
    for class in ["lines", "transformers2"] {
        for (id, b) in lf[class].as_object().unwrap() {
            let short = id.trim_start_matches("L-").trim_start_matches("T-");
            branches.push_str(&format!(
                "{short},{},{},{},{}\n",
                f(&b["p1"]),
                f(&b["q1"]),
                f(&b["p2"]),
                f(&b["q2"])
            ));
        }
    }
    vec![
        parse_csv("loadflow_buses", &buses).unwrap(),
        parse_csv("loadflow_branches", &branches).unwrap(),
    ]
}

#[test]
fn another_tools_load_flow_compares_within_tolerance_and_differences_are_reported() {
    let cases = json("tests/oracle/psse-cases.json");
    let case = cases["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "ieee14-33")
        .unwrap();
    let model = psse_import(case).model;
    let golden = golden("psse-ieee14-33");
    let mut study = ps_model::study::StudyCase::default();
    study.loadflow = ps_model::study::LoadFlowSettings {
        tolerance: 1e-8,
        max_iter: 50,
        ..ps_model::study::LoadFlowSettings::plain()
    };
    let none = HashMap::new();
    let tol = Tolerances::default();

    let same = compare(&model, &none, &tables(&golden, None), &study, &tol).unwrap();
    let text = markdown(&model, &same);
    assert!(same.passed, "{text}");
    assert_eq!(same.quantities.len(), 6);
    assert!(same.quantities.iter().all(|q| q.compared >= 14), "{text}");
    assert!(same.notes[0].contains("-30.0000°"), "{:?}", same.notes);

    // One bus 0.01 p.u. off, and a bus the model does not have.
    let mut changed = tables(&golden, Some(("9", 0.01)));
    changed[0].rows.push(vec!["999".into(), "1.0".into(), "0".into()]);
    let r = compare(&model, &none, &changed, &study, &tol).unwrap();
    assert!(!r.passed);
    let v = &r.quantities[0];
    assert_eq!((v.beyond, v.worst[0].id.as_str()), (1, "9"));
    assert_eq!(r.unmatched, ["loadflow_buses: 999"]);
    let text = markdown(&model, &r);
    assert!(
        text.contains("| 9 |") && text.contains("References that name nothing in the model (1)"),
        "{text}"
    );
}
