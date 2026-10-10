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
                ..Default::default()
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

/// What screening gets wrong on one model: outages that a full load flow flags (a violation the base case does not
/// have, or no solution) but screening judged safe, and the largest difference between a screened outage's estimate
/// and its full solution (highest loading in %, lowest and highest voltage in p.u.).
struct Screening {
    misses: Vec<String>,
    outages: usize,
    flagged: usize,
    screened: usize,
    loading_error: f64,
    voltage_error: f64,
}

fn screening(name: &str, model: &ps_model::Model, study: &ps_model::study::StudyCase) -> Option<Screening> {
    let full = contingency::run(model, study, &mut Silent).ok()?;
    let mut study = study.clone();
    study.contingency.screening = true;
    let screened = contingency::run(model, &study, &mut Silent).unwrap();
    let flagged: Vec<&str> = full
        .cases
        .iter()
        .filter(|c| c.violations.iter().any(|v| !v.in_base) || !c.converged)
        .map(|c| c.id.as_str())
        .collect();
    let mut misses = Vec::new();
    for id in &flagged {
        if let Some(sc) = screened.cases.iter().find(|c| c.id == *id && c.screened) {
            let fc = full.cases.iter().find(|c| c.id == *id).unwrap();
            let what: Vec<String> = fc
                .violations
                .iter()
                .filter(|v| !v.in_base)
                .map(|v| format!("{} {} {:.4} (limit {:.3})", v.kind, v.id, v.value, v.limit))
                .collect();
            misses.push(format!(
                "{name}: {id} [{}; estimate {:.2} %]{}",
                what.join(", "),
                sc.max_loading.unwrap_or(0.0),
                if fc.converged { "" } else { " (does not converge)" }
            ));
        }
    }
    let (mut loading_error, mut voltage_error) = (0.0_f64, 0.0_f64);
    for sc in screened.cases.iter().filter(|c| c.screened) {
        let fc = full.cases.iter().find(|c| c.id == sc.id).unwrap();
        let diff = |a: Option<f64>, b: Option<f64>| a.zip(b).map_or(0.0, |(a, b)| (a - b).abs());
        loading_error = loading_error.max(diff(sc.max_loading, fc.max_loading));
        voltage_error = voltage_error
            .max(diff(sc.min_v, fc.min_v))
            .max(diff(sc.max_v, fc.max_v));
    }
    Some(Screening {
        misses,
        outages: full.cases.len(),
        flagged: flagged.len(),
        screened: screened.effort.screened,
        loading_error,
        voltage_error,
    })
}

/// The reference models of the screening guarantee: every PSS/E reference case that solves, or the 2,000-bus ACTIVSg
/// grid.
fn screening_models(activsg: bool) -> Vec<(String, ps_model::Model)> {
    if activsg {
        let text = std::fs::read_to_string(repo(".cache/reference/case_ACTIVSg2000.m")).unwrap();
        return vec![(
            "activsg2000".into(),
            ps_io::matpower_model::to_model(&ps_io::matpower::parse(&text).unwrap()).model,
        )];
    }
    let cases = json("tests/oracle/psse-cases.json");
    cases["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|case| case["loadflow"] != false)
        .map(|case| (case["name"].as_str().unwrap().into(), psse_import(case).model))
        .collect()
}

/// Screening never misses an outage that a full load flow flags: every outage with a violation the base case does
/// not have (thermal or voltage) is solved in full. The estimates of the outages it clears stay well inside the drift
/// an element must show to count when it is already inside the margins. Prints how many outages screening judged
/// safe.
fn screening_guarantee(activsg: bool, limits: bool) {
    let mut loadflow = ps_model::study::LoadFlowSettings {
        max_iter: 50,
        ..ps_model::study::LoadFlowSettings::plain()
    };
    if limits {
        loadflow.enforce_q_limits = true;
        loadflow.voltage_dependent_loads = true;
    }
    let study = ps_model::study::StudyCase {
        loadflow,
        ..Default::default()
    };
    let label = if limits { "Q limits and ZIP loads" } else { "plain" };
    let mut misses = Vec::new();
    let (mut loading_error, mut voltage_error) = (0.0_f64, 0.0_f64);
    for (name, model) in &screening_models(activsg) {
        let Some(s) = screening(&format!("{name} ({label})"), model, &study) else {
            continue;
        };
        eprintln!(
            "{name} ({label}): {} outages, {} flagged by full AC, {} judged safe by screening; estimate error {:.1e} %, {:.1e} p.u.",
            s.outages, s.flagged, s.screened, s.loading_error, s.voltage_error
        );
        misses.extend(s.misses);
        loading_error = loading_error.max(s.loading_error);
        voltage_error = voltage_error.max(s.voltage_error);
    }
    assert!(
        misses.is_empty(),
        "screening missed {}: {}",
        misses.len(),
        misses.join("\n")
    );
    assert!(
        loading_error < contingency::SCREEN_DRIFT_LOADING / 10.0,
        "loading estimate off by {loading_error} %"
    );
    assert!(
        voltage_error < contingency::SCREEN_DRIFT_V / 10.0,
        "voltage estimate off by {voltage_error} p.u."
    );
}

/// The screening guarantee on every PSS/E reference case, with the plain settings.
#[test]
fn screening_never_misses_on_the_psse_cases() {
    screening_guarantee(false, false);
}

/// The screening guarantee on every PSS/E reference case, with reactive limits and voltage-dependent loads.
#[test]
fn screening_never_misses_on_the_psse_cases_with_limits() {
    screening_guarantee(false, true);
}

/// The screening guarantee on the 2,000-bus ACTIVSg grid, with the plain settings.
#[test]
fn screening_never_misses_on_activsg2000() {
    screening_guarantee(true, false);
}

/// The screening guarantee on the 2,000-bus ACTIVSg grid, with reactive limits and voltage-dependent loads.
#[test]
fn screening_never_misses_on_activsg2000_with_limits() {
    screening_guarantee(true, true);
}

/// Screening holds its guarantee for an element parked just inside its limit in the base case, where an outage can
/// push it over by less than the drift an element inside the margins must show: each line of IEEE 14 in turn at
/// 99.99 % of its limit, and each busbar's band in turn with an edge 0.0001 p.u. from its base voltage (lower, then
/// upper). A bus above its band in the base case must still be checked against the lower edge.
#[test]
fn screening_never_misses_an_element_parked_at_its_limit() {
    let imp = input("ieee14");
    let base = loadflow::run(
        &imp.model,
        &LoadFlowRun {
            settings: imp.study.loadflow,
            ..Default::default()
        },
    );
    let (mut misses, mut flagged, mut screened) = (Vec::new(), 0, 0);
    let mut check = |name: String, model: ps_model::Model| {
        let s = screening(&name, &model, &imp.study).unwrap();
        flagged += s.flagged;
        screened += s.screened;
        misses.extend(s.misses);
    };
    for k in 0..imp.model.lines.len() {
        let mut model = imp.model.clone();
        let line = &mut model.lines[k];
        let loading = base
            .branches
            .iter()
            .find(|b| b.id == line.id)
            .and_then(|b| b.loading)
            .unwrap();
        for l in &mut line.limits {
            l.amps *= loading / 99.99;
        }
        check(format!("{} at 99.99 %", line.id), model);
    }
    for k in 0..imp.model.nodes.len() {
        let mut model = imp.model.clone();
        let node = &mut model.nodes[k];
        let Some(b) = base.buses.iter().find(|b| b.id == node.id) else {
            continue;
        };
        node.v_min = b.vm - 1e-4;
        check(format!("{} band from {:.4}", node.id, node.v_min), model);
    }
    for k in 0..imp.model.nodes.len() {
        let mut model = imp.model.clone();
        let node = &mut model.nodes[k];
        let Some(b) = base.buses.iter().find(|b| b.id == node.id) else {
            continue;
        };
        node.v_max = b.vm + 1e-4;
        check(format!("{} band up to {:.4}", node.id, node.v_max), model);
    }
    eprintln!("{flagged} outages flagged by full AC, {screened} judged safe by screening");
    // An element within the drift of its limit sends every outage to the full solve; before that rule, 24 outages
    // here were screened that full AC flags.
    assert!(flagged > 0);
    assert!(
        misses.is_empty(),
        "screening missed {}: {}",
        misses.len(),
        misses.join("\n")
    );
}

/// Screening stays off, and the report says why, when a control the decoupled solution keeps fixed would move: here
/// the tap changers of the IEEE 300 case that regulate voltage.
#[test]
fn screening_is_off_while_tap_changers_regulate() {
    let cases = json("tests/oracle/psse-cases.json");
    let case = cases["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "ieee300")
        .unwrap();
    let model = psse_import(case).model;
    let mut study = ps_model::study::StudyCase::default();
    study.contingency.screening = true;
    study.loadflow.tap_control = true;
    let r = contingency::run(&model, &study, &mut Silent).unwrap();
    assert_eq!(r.effort.screened, 0);
    assert!(
        r.notes.iter().any(|n| n.contains("tap changers regulate")),
        "{:?}",
        r.notes
    );
    study.loadflow.tap_control = false;
    let r = contingency::run(&model, &study, &mut Silent).unwrap();
    assert!(r.effort.screened > 0 && r.notes.is_empty());
}

/// A remedial action fires on the contingency it names when its condition holds, and the case reports the state after
/// it: losing Line 1-2 overloads Line 1-5; shedding load relieves it.
#[test]
fn a_remedial_action_relieves_the_overload_it_is_for() {
    use ps_model::study::{Action, Condition, RemedialAction};
    let mut imp = input("ieee14");
    let without = contingency::run(&imp.model, &imp.study, &mut Silent).unwrap();
    let before = without.cases.iter().find(|c| c.id == "L1").unwrap().clone();
    let shed = |id: &str| Action::LoadShed {
        element: id.into(),
        percent: 60.0,
    };
    imp.study.contingency.remedial = vec![RemedialAction {
        id: "shed-east".into(),
        name: "Shed load east of bus 2".into(),
        contingencies: vec!["L1".into()],
        conditions: vec![Condition::Loading {
            element: "L2".into(),
            above: 100.0,
        }],
        actions: vec![shed("D3"), shed("D4"), shed("D2")],
    }];
    let with = contingency::run(&imp.model, &imp.study, &mut Silent).unwrap();
    let after = with.cases.iter().find(|c| c.id == "L1").unwrap();
    assert_eq!(after.remedial, ["shed-east"]);
    assert!(after.violations_before > 0);
    assert!(
        after.max_loading.unwrap() < before.max_loading.unwrap() - 20.0,
        "{after:?}"
    );
    // The rule names one contingency: the others are as before.
    for c in with.cases.iter().filter(|c| c.id != "L1") {
        assert!(c.remedial.is_empty());
        let w = without.cases.iter().find(|x| x.id == c.id).unwrap();
        assert_eq!(c.max_loading, w.max_loading, "{}", c.id);
    }
}

/// A busbar fault takes out everything connected at the busbar: on the IEEE 14 sample it equals the contingency of
/// the bus's lines, transformers and injections, and it reports the bus lost.
#[test]
fn a_busbar_fault_takes_out_everything_connected_there() {
    use ps_model::study::Contingency;
    let imp = input("ieee14");
    let model = &imp.model;
    let bus = model.index().get(ps_model::Class::Node, "B4").unwrap();
    let connected: Vec<String> = ps_model::Class::ALL
        .iter()
        .flat_map(|&k| {
            (0..model.len(k))
                .filter(move |&r| {
                    k != ps_model::Class::Node && model.element_nodes(k, r).iter().any(|n| n.index() == bus)
                })
                .map(move |r| model.id_of(k, r).unwrap_or("").to_string())
        })
        .collect();
    assert!(connected.len() >= 5, "{connected:?}");
    let mut study = imp.study.clone();
    study.contingency.lines = false;
    study.contingency.trafos = false;
    study.contingency.list = vec![
        Contingency {
            id: "fault".into(),
            name: String::new(),
            elements: vec!["B4".into()],
        },
        Contingency {
            id: "all".into(),
            name: String::new(),
            elements: connected,
        },
    ];
    let r = contingency::run(model, &study, &mut Silent).unwrap();
    let (fault, all) = (
        r.cases.iter().find(|c| c.id == "fault").unwrap(),
        r.cases.iter().find(|c| c.id == "all").unwrap(),
    );
    assert_eq!(fault.cls, "busbar");
    assert!(fault.converged);
    assert!(fault.lost_buses.contains(&"B4".to_string()), "{:?}", fault.lost_buses);
    assert_eq!(
        (fault.max_loading, fault.min_v, fault.max_v),
        (all.max_loading, all.min_v, all.max_v)
    );
}

/// In a node-breaker model a busbar fault opens the switches around the busbar section: the section is lost, while
/// the network around it solves.
#[test]
fn a_busbar_section_fault_opens_its_switches() {
    let cases = json("tests/oracle/psse-cases.json");
    let case = cases["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "ieee14-nb-35")
        .unwrap();
    let model = psse_import(case).model;
    let sections: Vec<&ps_model::Node> = model
        .nodes
        .iter()
        .filter(|n| n.kind == ps_model::NodeKind::BusbarSection)
        .collect();
    assert!(!sections.is_empty());
    let mut study = ps_model::study::StudyCase::default();
    study.contingency.lines = false;
    study.contingency.trafos = false;
    study.contingency.busbars = true;
    let r = contingency::run(&model, &study, &mut Silent).unwrap();
    let faults: Vec<_> = r.cases.iter().filter(|c| c.cls == "busbar").collect();
    assert!(!faults.is_empty());
    let mut solved = 0;
    for c in &faults {
        if c.converged {
            solved += 1;
            assert!(c.lost_buses.contains(&c.id), "{}: {:?}", c.id, c.lost_buses);
        }
        eprintln!("{}: converged {} lost {:?}", c.id, c.converged, c.lost_buses);
    }
    assert!(solved > 0);
}
