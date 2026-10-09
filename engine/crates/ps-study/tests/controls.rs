//! Load flows with controls on, against PowSyBl OpenLoadFlow (goldens from `scripts/oracle/controls.py`): every
//! solvable PSS/E reference case and two ACTIVSg grids, each with distributed slack, reactive limits, remote voltage
//! control and voltage-dependent loads, alone and together. A variant OpenLoadFlow did not solve is skipped; the
//! test prints which.
//!
//! Voltages are compared at every bus, angles relative to the first slack bus, and the active and reactive output of
//! every generator (PSS/E) or of the generators of each bus (MATPOWER). Without distributed slack OpenLoadFlow reports a slack machine's active power as its target, so
//! those machines are then compared by reactive power only.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use common::*;
use ps_model::study::{Balance, LoadFlowSettings};
use ps_study::{LoadFlowRun, loadflow};
use serde_json::Value;

/// Bars from the design: voltages to 1e-6 p.u., outputs to 1e-3 MW or Mvar.
const V_TOL: f64 = 1e-6;
const ANGLE_TOL: f64 = 1e-4;
const POWER_TOL: f64 = 1e-3;

fn settings(controls: &Value) -> LoadFlowSettings {
    let mut s = LoadFlowSettings {
        tolerance: 1e-8,
        max_iter: 50,
        ..LoadFlowSettings::plain()
    };
    for c in controls.as_array().unwrap() {
        match c.as_str().unwrap() {
            "slack" => {
                s.balance = Balance::MaxP;
                s.slack_tolerance = 1e-4;
            }
            "qlim" => s.enforce_q_limits = true,
            "remote" => s.remote_voltage = true,
            "zip" => s.voltage_dependent_loads = true,
            "taps" => s.tap_control = true,
            "shunts" => s.shunt_control = true,
            "phase" => s.phase_control = true,
            other => panic!("unknown control {other}"),
        }
    }
    s
}

fn warm(m: &ps_model::Model, yes: bool) -> Option<Vec<Option<(f64, f64)>>> {
    yes.then(|| {
        m.nodes
            .iter()
            .map(|n| (n.v0 > 0.0).then(|| (n.v0, n.angle0.to_radians())))
            .collect()
    })
}

fn psse_case(case: &Value, rows: &mut Vec<String>, skipped: &mut Vec<String>) {
    let name = case["name"].as_str().unwrap();
    let g = golden(&format!("controls-{name}"));
    let base = psse_import(case).model;
    for (variant, want) in g["variants"].as_object().unwrap() {
        if want["status"][0] != "CONVERGED" {
            skipped.push(format!("{name} {variant} (OpenLoadFlow: {})", want["status"][0]));
            continue;
        }
        // Stress variants raise the voltage targets of regulating two-winding tap changers and shunts.
        let mut m = base.clone();
        if let Some(k) = want["stress"].as_f64() {
            for t in &mut m.transformers2 {
                for c in t
                    .ratio_taps
                    .iter_mut()
                    .filter_map(|r| r.control.as_mut())
                    .filter(|c| c.enabled)
                {
                    c.target_kv *= k;
                }
            }
            for c in m
                .shunts
                .iter_mut()
                .filter_map(|s| s.control.as_mut())
                .filter(|c| c.enabled)
            {
                c.target_kv *= k;
            }
        }
        let m = m;
        let (calc, sol, report) = loadflow::solve(
            &m,
            &LoadFlowRun {
                settings: settings(&want["controls"]),
                start: warm(&m, case["start"] == "raw"),
                ..Default::default()
            },
        );
        let mut w = Worst::default();
        if !report.converged {
            w.check("converged", &report.message, 0.0, 1.0);
        } else {
            let bus = |id: &str| {
                m.nodes
                    .iter()
                    .position(|n| n.id == id)
                    .and_then(|i| calc.topo.bus_of(ps_model::NodeRef(i as u32)))
            };
            let buses = want["buses"].as_object().unwrap();
            let slack = buses
                .keys()
                .find(|k| bus(k).is_some_and(|b| sol.kind[b] == ps_lf::BusKind::Reference));
            let (mine0, theirs0) =
                slack.map_or((0.0, 0.0), |k| (sol.va[bus(k).unwrap()].to_degrees(), f(&buses[k][1])));
            for (id, v) in buses {
                match bus(id) {
                    Some(b) => {
                        w.check("V", id, sol.vm[b], f(&v[0]));
                        w.check("angle", id, sol.va[b].to_degrees() - mine0, f(&v[1]) - theirs0);
                    }
                    None => w.check("bus solved", id, 0.0, 1.0),
                }
            }
            let distributed = want["controls"].as_array().unwrap().iter().any(|c| c == "slack");
            let at_slack = |id: &str| {
                m.generators
                    .iter()
                    .find(|g| g.id == id)
                    .and_then(|g| calc.topo.bus_of(g.node))
                    .is_some_and(|b| sol.kind[b] == ps_lf::BusKind::Reference)
            };
            for (id, pq) in want["generators"].as_object().unwrap() {
                match report.gens.iter().find(|u| u.id == *id) {
                    // PowSyBl reports generation with the load sign convention.
                    Some(u) => {
                        if distributed || !at_slack(id) {
                            w.check("P", id, -u.p, f(&pq[0]));
                        }
                        w.check("Q", id, -u.q, f(&pq[1]));
                    }
                    None if pq[0].is_null() => {}
                    None => w.check("generator solved", id, 0.0, 1.0),
                }
            }
            // Final positions, from the lowest one ("T-4-8-1#ONE": the changer on winding 1).
            for (key, kind) in [("ratio_taps", "ratio"), ("phase_taps", "phase")] {
                for (k, pos) in want[key].as_object().into_iter().flatten() {
                    let (id, side) = k.split_once('#').unwrap();
                    let end = match side {
                        "TWO" => 2,
                        "THREE" => 3,
                        _ => 1,
                    };
                    // A two-winding transformer has one changer of each kind; a three-winding one's side is its winding.
                    let found = report
                        .taps
                        .iter()
                        .find(|t| t.id == id && t.kind == kind && (t.cls == "trafo" || t.winding == end));
                    match found {
                        Some(t) => w.check("tap", k, f64::from(t.position - t.low), f(pos)),
                        None => w.check("tap regulated", k, 0.0, 1.0),
                    }
                }
            }
            for (id, n) in want["shunts"].as_object().into_iter().flatten() {
                match report.sections.iter().find(|x| x.id == *id) {
                    Some(x) => w.check("sections", id, f64::from(x.sections), f(n)),
                    None => w.check("shunt regulated", id, 0.0, 1.0),
                }
            }
        }
        rows.push(row(name, variant, &w));
    }
}

fn matpower_case(name: &str, file: &str, start: &str, rows: &mut Vec<String>) {
    let path = repo(&format!(".cache/reference/{file}"));
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{}: {e}. Run node scripts/fetch-reference.mjs first.", path.display()));
    let m = ps_io::matpower_model::to_model(&ps_io::matpower::parse(&text).unwrap()).model;
    let g = golden(&format!("controls-{name}"));
    let numbers: Vec<i64> = g["bus"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_i64().unwrap())
        .collect();
    for (variant, want) in g["variants"].as_object().unwrap() {
        let (calc, sol, report) = loadflow::solve(
            &m,
            &LoadFlowRun {
                settings: settings(&want["controls"]),
                start: warm(&m, start == "case"),
                ..Default::default()
            },
        );
        let mut w = Worst::default();
        if !report.converged {
            w.check("converged", &report.message, 0.0, 1.0);
        } else {
            let bus = |k: usize| {
                let id = format!("B{}", numbers[k]);
                m.nodes
                    .iter()
                    .position(|n| n.id == id)
                    .and_then(|i| calc.topo.bus_of(ps_model::NodeRef(i as u32)))
            };
            let slack = (0..numbers.len()).find(|&k| bus(k).is_some_and(|b| sol.kind[b] == ps_lf::BusKind::Reference));
            let (mine0, theirs0) = slack.map_or((0.0, 0.0), |k| {
                (sol.va[bus(k).unwrap()].to_degrees(), f(&want["va"][k]))
            });
            for k in 0..numbers.len() {
                let Some(b) = bus(k) else { continue };
                w.check("V", &numbers[k].to_string(), sol.vm[b], f(&want["vm"][k]));
                w.check(
                    "angle",
                    &numbers[k].to_string(),
                    sol.va[b].to_degrees() - mine0,
                    f(&want["va"][k]) - theirs0,
                );
            }
            // Outputs by bus: OpenLoadFlow splits a bus's output among its machines by its own rules (an equal split
            // where limits are implausible), so the machines of a bus are compared by their total.
            let distributed = want["controls"].as_array().unwrap().iter().any(|c| c == "slack");
            let mut totals: std::collections::BTreeMap<usize, [f64; 4]> = Default::default();
            for u in &report.gens {
                // Generators are in the case's row order; the report leaves out those switched off.
                let k = m.generators.iter().position(|g| g.id == u.id).unwrap();
                let Some(b) = calc.topo.bus_of(m.generators[k].node) else {
                    continue;
                };
                let t = totals.entry(b).or_default();
                t[0] += -u.p;
                t[1] += -u.q;
                t[2] += f(&want["p"][k]);
                t[3] += f(&want["q"][k]);
            }
            for (b, t) in totals {
                let id = calc.bus_id(&m, b);
                if distributed || sol.kind[b] != ps_lf::BusKind::Reference {
                    w.check("P", &id, t[0], t[2]);
                }
                w.check("Q", &id, t[1], t[3]);
            }
        }
        rows.push(row(name, variant, &w));
    }
}

fn row(name: &str, variant: &str, w: &Worst) -> String {
    let bad = w.max("V") > V_TOL
        || w.max("angle") > ANGLE_TOL
        || w.max("P") > POWER_TOL
        || w.max("Q") > POWER_TOL
        || w.max("tap") > 0.0
        || w.max("sections") > 0.0
        || w.rows
            .iter()
            .any(|r| r.0.contains("solved") || r.0.contains("regulated") || r.0 == "converged");
    let worst: Vec<String> = w
        .rows
        .iter()
        .map(|r| format!("{} {:.1e} at {}", r.0, r.1, r.2))
        .collect();
    format!(
        "{} {name} {variant}: {}",
        if bad { "FAIL" } else { "ok  " },
        worst.join("; ")
    )
}

#[test]
fn controls_agree_with_openloadflow() {
    let mut rows = Vec::new();
    let mut skipped = Vec::new();
    let cases = json("tests/oracle/psse-cases.json");
    for case in cases["cases"].as_array().unwrap() {
        if case["loadflow"] == false {
            continue;
        }
        psse_case(case, &mut rows, &mut skipped);
    }
    let mp = json("tests/oracle/matpower-cases.json");
    for entry in mp["cases"].as_array().unwrap() {
        let name = entry["name"].as_str().unwrap();
        if repo(&format!("tests/oracle/golden/controls-{name}.json")).exists() {
            let file = mp["archives"][entry["archive"].as_str().unwrap()]["file"]
                .as_str()
                .unwrap();
            matpower_case(name, file, entry["start"].as_str().unwrap(), &mut rows);
        }
    }
    for r in &rows {
        eprintln!("{r}");
    }
    for s in &skipped {
        eprintln!("skipped {s}");
    }
    let failed: Vec<&String> = rows.iter().filter(|r| r.starts_with("FAIL")).collect();
    assert!(
        failed.is_empty(),
        "{} of {} variants differ from OpenLoadFlow",
        failed.len(),
        rows.len()
    );
}

/// A phase shifter regulating active power: IEEE 14 with a phase tap changer (±16 positions of 1°) added to the
/// transformer between buses 4 and 7 and asked for 20 MW more than it carries. The flow ends within half the dead
/// band of its target, or the changer at a limit. No reference case has a regulating two-winding phase shifter that
/// PowSyBl keeps (its PSS/E import drops most of them), so this checks the control against its own definition.
#[test]
fn a_phase_shifter_holds_its_flow() {
    let cases = json("tests/oracle/psse-cases.json");
    let case = cases["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "ieee14-33")
        .unwrap();
    let mut m = psse_import(case).model;
    let solve = |m: &ps_model::Model, on: bool| {
        loadflow::run(
            m,
            &LoadFlowRun {
                settings: LoadFlowSettings {
                    tolerance: 1e-8,
                    phase_control: on,
                    ..LoadFlowSettings::plain()
                },
                ..Default::default()
            },
        )
    };
    let before = solve(&m, false);
    let flow = |r: &ps_study::LoadFlowReport| r.branches.iter().find(|b| b.id == "T-4-7-1").unwrap().p_from;
    let target = flow(&before) + 20.0;
    let t = m.transformers2.iter_mut().find(|t| t.id == "T-4-7-1").unwrap();
    t.phase_tap = Some(ps_model::PhaseTap {
        end: 1,
        low: -16,
        high: 16,
        neutral: 0,
        step_deg: 1.0,
        position: 0,
        control: Some(ps_model::FlowControl {
            enabled: true,
            target_mw: target,
            deadband_mw: 2.0,
        }),
        table: Vec::new(),
    });
    let after = solve(&m, true);
    assert!(after.converged, "{}", after.message);
    let tap = after
        .taps
        .iter()
        .find(|t| t.id == "T-4-7-1" && t.kind == "phase")
        .unwrap();
    let p = flow(&after);
    eprintln!("target {target:.3} MW, flow {p:.3} MW at position {}", tap.position);
    assert_ne!(tap.position, 0, "the phase shifter did not move");
    // One step moves the flow by several MW, so the band is met to within half a step's effect.
    let one_step = {
        let mut m2 = m.clone();
        let pt = m2
            .transformers2
            .iter_mut()
            .find(|t| t.id == "T-4-7-1")
            .unwrap()
            .phase_tap
            .as_mut()
            .unwrap();
        pt.position = tap.position + 1;
        pt.control = None;
        (flow(&solve(&m2, false)) - p).abs()
    };
    assert!(
        (p - target).abs() <= (1.0f64).max(one_step / 2.0) + 1e-6,
        "flow {p} vs target {target}, step {one_step}"
    );
}
