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
