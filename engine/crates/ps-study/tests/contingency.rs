//! Contingency analysis: each case equals a direct load flow with the element out, and chunked runs merge to the
//! sequential result.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use common::*;
use ps_study::contingency::{self, definitions};
use ps_study::{LoadFlowRun, Silent, loadflow, outages_by_id};

#[test]
fn every_outage_equals_a_load_flow_with_that_element_switched_out() {
    let mut imp = input("ieee14");
    // Both sides solve tightly, so they agree whatever path each takes to the solution.
    imp.study.loadflow.tolerance = 1e-8;
    let r = contingency::run(&imp.model, &imp.study, &mut Silent).unwrap();
    assert_eq!(r.cases.len(), 20, "fifteen lines and five transformers");
    for c in &r.cases {
        let direct = loadflow::run(
            &imp.model,
            &LoadFlowRun {
                settings: imp.study.loadflow,
                outages: outages_by_id(&imp.model, [c.id.as_str()]).0,
                start: None,
            },
        );
        assert_eq!(c.converged, direct.converged);
        let worst = direct.branches.iter().filter(|b| b.loading.is_some()).fold(
            None::<&ps_study::loadflow::BranchResult>,
            |m, b| match m {
                Some(x) if x.loading >= b.loading => Some(x),
                _ => Some(b),
            },
        );
        let worst = worst.unwrap();
        assert!(
            (c.max_loading.unwrap() - worst.loading.unwrap()).abs() < 1e-3,
            "{}: {:?} vs {:?}",
            c.id,
            c.max_loading,
            worst.loading
        );
        assert_eq!(c.max_loading_id, worst.id);
    }
}

#[test]
fn losing_line_1_2_overloads_line_1_5() {
    let imp = input("ieee14");
    let r = contingency::run(&imp.model, &imp.study, &mut Silent).unwrap();
    let c = r.cases.iter().find(|x| x.id == "L1").unwrap();
    assert_eq!(c.max_loading_id, "L2");
    assert!(c.max_loading.unwrap() > 150.0);
    assert!(
        c.violations
            .iter()
            .any(|v| v.kind == "loading" && v.id == "L2" && !v.in_base)
    );
    assert!(r.worst_loading["L2"].value >= c.max_loading.unwrap());
}

#[test]
fn cases_rank_failures_first_then_by_violations() {
    let imp = input("ieee14");
    let r = contingency::run(&imp.model, &imp.study, &mut Silent).unwrap();
    for w in r.cases.windows(2) {
        assert!(w[0].converged <= w[1].converged);
        if w[0].converged == w[1].converged {
            assert!(w[0].violations.len() >= w[1].violations.len());
        }
    }
}

#[test]
fn a_radial_outage_reports_the_nodes_it_cuts_off() {
    let imp = input("riverside");
    let r = contingency::run(&imp.model, &imp.study, &mut Silent).unwrap();
    assert_eq!(r.cases.iter().find(|x| x.id == "L6").unwrap().lost_buses, ["B7"]);
}

#[test]
fn the_study_case_selects_which_elements_fail() {
    let mut imp = input("riverside");
    imp.study.contingency.lines = false;
    imp.study.contingency.trafos = true;
    imp.study.contingency.gens = true;
    let r = contingency::run(&imp.model, &imp.study, &mut Silent).unwrap();
    let mut cls: Vec<&str> = r.cases.iter().map(|c| c.cls.as_str()).collect();
    cls.sort_unstable();
    assert_eq!(cls, ["gen", "trafo", "trafo", "trafo", "trafo"]);
}

#[test]
fn chunks_merge_to_the_sequential_result() {
    for name in ["ieee14", "riverside"] {
        let mut imp = input(name);
        imp.study.contingency.gens = true;
        let whole = contingency::run(&imp.model, &imp.study, &mut Silent).unwrap();
        let n = definitions(&imp.model, &imp.study).len();
        for parts in [2, 3, 7] {
            let size = n.div_ceil(parts);
            let chunks = (0..parts)
                .map(|p| contingency::run_chunk(&imp.model, &imp.study, p * size..(p + 1) * size, &mut Silent).unwrap())
                .collect();
            // Everything but the time taken.
            let mut merged = contingency::merge(chunks).unwrap();
            merged.timing = whole.timing;
            assert_eq!(merged, whole, "{name} in {parts} parts");
        }
    }
}

/// Screening never misses an outage that a full load flow flags: every outage with a violation the base case does
/// not have (thermal or voltage) is solved in full, on every PSS/E reference case and on the 2,000-bus ACTIVSg grid.
/// Prints how many outages screening judged safe.
#[test]
fn screening_never_misses_what_full_ac_flags() {
    use ps_model::study::LoadFlowSettings;
    let mut models: Vec<(String, ps_model::Model)> = Vec::new();
    let cases = json("tests/oracle/psse-cases.json");
    for case in cases["cases"].as_array().unwrap() {
        if case["loadflow"] != false {
            models.push((case["name"].as_str().unwrap().into(), psse_import(case).model));
        }
    }
    let text = std::fs::read_to_string(repo(".cache/reference/case_ACTIVSg2000.m")).unwrap();
    models.push((
        "activsg2000".into(),
        ps_io::matpower_model::to_model(&ps_io::matpower::parse(&text).unwrap()).model,
    ));
    let mut misses = Vec::new();
    for (name, model) in &models {
        let mut study = ps_model::study::StudyCase {
            loadflow: LoadFlowSettings {
                max_iter: 50,
                ..LoadFlowSettings::plain()
            },
            ..Default::default()
        };
        let Ok(full) = contingency::run(model, &study, &mut Silent) else {
            continue;
        };
        study.contingency.screening = true;
        let screened = contingency::run(model, &study, &mut Silent).unwrap();
        let flagged: Vec<&str> = full
            .cases
            .iter()
            .filter(|c| c.violations.iter().any(|v| !v.in_base) || !c.converged)
            .map(|c| c.id.as_str())
            .collect();
        for id in &flagged {
            if let Some(sc) = screened.cases.iter().find(|c| c.id == *id && c.screened) {
                let fc = full.cases.iter().find(|c| c.id == *id).unwrap();
                let what: Vec<String> = fc
                    .violations
                    .iter()
                    .filter(|v| !v.in_base)
                    .map(|v| format!("{} {} {:.3} (limit {:.3})", v.kind, v.id, v.value, v.limit))
                    .collect();
                misses.push(format!(
                    "{name}: {id} [{}; estimate {:.1} %]{}",
                    what.join(", "),
                    sc.max_loading.unwrap_or(0.0),
                    if fc.converged { "" } else { " (does not converge)" }
                ));
            }
        }
        eprintln!(
            "{name}: {} outages, {} flagged by full AC, {} judged safe by screening",
            full.cases.len(),
            flagged.len(),
            screened.effort.screened
        );
    }
    assert!(
        misses.is_empty(),
        "screening missed {}: {}",
        misses.len(),
        misses.join("\n")
    );
}
