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

/// A MATPOWER transformer without RATE_A has no thermal rating: the system base that stands in for its rated power
/// is not judged as one, neither in the model nor in the editor's document made from it. A rated one still is.
#[test]
fn a_transformer_without_a_rating_reports_no_loading() {
    let text = "function mpc = t\nmpc.version = '2';\nmpc.baseMVA = 100;\nmpc.bus = [\n\
        1 3 0 0 0 0 1 1.0 0 132 1 1.1 0.9;\n2 1 150 20 0 0 1 1.0 0 33 1 1.1 0.9;\n3 1 50 10 0 0 1 1.0 0 33 1 1.1 0.9;\n];\n\
        mpc.gen = [\n1 0 0 300 -300 1.0 100 1 400 0;\n];\n\
        mpc.branch = [\n1 2 0.001 0.05 0 0 0 0 1.0 0 1 -360 360;\n1 3 0.001 0.05 0 80 0 0 1.0 0 1 -360 360;\n];\n";
    let model = ps_io::matpower_model::to_model(&ps_io::matpower::parse(text).unwrap()).model;
    assert_eq!(model.transformers2.len(), 2);
    let loading = |m: &Model| {
        let r = ps_study::loadflow::run(
            m,
            &ps_study::LoadFlowRun {
                settings: ps_model::study::LoadFlowSettings::default(),
                ..Default::default()
            },
        );
        assert!(r.converged);
        ["T1", "T2"].map(|id| r.branches.iter().find(|b| b.id == id).unwrap().loading)
    };
    let [unrated, rated] = loading(&model);
    assert_eq!(unrated, None, "150 MW through a transformer without a rating");
    assert!(rated.unwrap() > 60.0, "{rated:?}");
    let doc = ps_io::powerstudio_write::to_document(&model).doc;
    let back = ps_io::powerstudio::parse(&doc.to_string()).unwrap().model;
    let [unrated, rated] = loading(&back);
    assert_eq!(unrated, None);
    assert!(rated.unwrap() > 60.0, "{rated:?}");
}

/// A case solved with reactive limits (machines at a limit in its stored solution) opens with the study case
/// respecting them, and says so: ACTIVSg2000 does; case14 written as RAW, whose machines all sit inside their limits,
/// does not.
#[test]
fn a_case_solved_with_reactive_limits_opens_with_them() {
    let open = |file: &str| {
        let data = std::fs::read(repo(file)).unwrap();
        let name = file.rsplit('/').next().unwrap().to_string();
        ps_study::exchange::import_for_editor(vec![ps_io::files::File { name, data }]).unwrap()
    };
    let r = open(".cache/reference/case_ACTIVSg2000.m");
    assert_eq!(r.doc["study"]["loadflow"]["enforceQLimits"], true);
    assert!(r.study.iter().any(|n| n.contains("respects reactive power limits")));
    let r = open("tests/fixtures/case14.raw");
    assert!(r.doc.get("study").is_none(), "{:?}", r.doc.get("study"));
}
