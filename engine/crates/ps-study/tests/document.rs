//! The editor's document from an imported model (`ps_io::powerstudio_write`): every reference model is converted
//! and the document's load flow is compared with the model's, node by node, through `exchange::editor_fidelity`.
//! Where the document can express a model exactly the two agree to rounding; the bars below are what each kind of
//! source needs, with the reason.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use common::*;
use ps_model::Model;

fn check(name: &str, m: &Model, bar: f64, failures: &mut Vec<String>) {
    let converted = ps_io::powerstudio_write::to_document(m);
    let f = ps_study::exchange::editor_fidelity(m, &converted);
    eprintln!(
        "SUMMARY {name}: V {:.1e} p.u. (at {}), angle {:.1e}°, editor start converges {}; {} note(s)",
        f.max_dv,
        f.worst,
        f.max_da,
        f.editor_converges,
        converted.notes.len()
    );
    for n in &converted.notes {
        eprintln!("  {n}");
    }
    if !f.solved || f.max_dv > bar || f.max_da > bar * 100.0 {
        failures.push(format!(
            "{name}: V {:.1e} at {}, angle {:.1e}",
            f.max_dv, f.worst, f.max_da
        ));
    }
}

#[test]
fn documents_reproduce_their_models() {
    let mut failures = Vec::new();
    for case in ["case14", "case30", "case118"] {
        let parsed = ps_io::matpower::parse(&read(&format!("tests/fixtures/{case}.m"))).unwrap();
        check(
            case,
            &ps_io::matpower_model::to_model(&parsed).model,
            1e-9,
            &mut failures,
        );
    }
    let matpower = json("tests/oracle/matpower-cases.json");
    for case in matpower["cases"].as_array().unwrap() {
        let file = matpower["archives"][case["archive"].as_str().unwrap()]["file"]
            .as_str()
            .unwrap();
        let text = std::fs::read_to_string(repo(&format!(".cache/reference/{file}"))).unwrap();
        let model = ps_io::matpower_model::to_model(&ps_io::matpower::parse(&text).unwrap()).model;
        check(case["name"].as_str().unwrap(), &model, 1e-9, &mut failures);
    }
    let psse = json("tests/oracle/psse-cases.json");
    for case in psse["cases"].as_array().unwrap() {
        if case["loadflow"] == false {
            continue;
        }
        check(
            case["name"].as_str().unwrap(),
            &psse_import(case).model,
            1e-9,
            &mut failures,
        );
    }
    let cgmes = json("tests/oracle/cgmes-cases.json");
    for case in cgmes["cases"].as_array().unwrap() {
        if case["loadflow"] == false {
            continue;
        }
        let model = ps_io::cgmes::import(&cgmes_files(case)).unwrap().model;
        check(case["name"].as_str().unwrap(), &model, 1e-9, &mut failures);
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
