//! Load flow against the oracles: PYPOWER (MATPOWER's algorithm) for the MATPOWER cases, pandapower for the 0.1
//! sample documents. Tolerances are the 0.1 engine's.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use common::*;
use ps_study::{LoadFlowRun, loadflow};

fn run_doc(name: &str, enforce: bool, tol: f64) -> (ps_model::Model, ps_study::LoadFlowReport) {
    let imp = input(name);
    let mut settings = imp.study.loadflow;
    settings.tolerance = tol;
    settings.enforce_q_limits = enforce;
    let r = loadflow::run(
        &imp.model,
        &LoadFlowRun {
            settings,
            ..Default::default()
        },
    );
    (imp.model, r)
}

#[test]
fn matpower_cases_reproduce_pypower() {
    for case in ["case14", "case30", "case118"] {
        let parsed = ps_io::matpower::parse(&read(&format!("tests/fixtures/{case}.m"))).unwrap();
        let imp = ps_io::matpower_model::to_model(&parsed);
        let settings = ps_model::study::LoadFlowSettings {
            tolerance: 1e-8 * imp.model.meta.base_mva,
            ..Default::default()
        };
        let r = loadflow::run(
            &imp.model,
            &LoadFlowRun {
                settings,
                ..Default::default()
            },
        );
        assert!(r.converged, "{case}: {}", r.message);
        let g = golden(&format!("matpower-{case}"));
        let (mut dv, mut da) = (0.0_f64, 0.0_f64);
        for (k, b) in g["bus"].as_array().unwrap().iter().enumerate() {
            let id = format!("B{}", b.as_i64().unwrap());
            let x = r
                .buses
                .iter()
                .find(|y| y.id == id)
                .unwrap_or_else(|| panic!("{case}: bus {id} missing"));
            dv = dv.max((x.vm - f(&g["vm"][k])).abs());
            da = da.max((x.va - f(&g["va"][k])).abs());
        }
        assert!(dv < 1e-9 && da < 1e-7, "{case}: |ΔV| {dv}, |Δθ| {da}°");
    }
}

#[test]
fn sample_documents_match_pandapower() {
    for (name, enforce) in [
        ("ieee14", false),
        ("riverside", false),
        ("riverside", true),
        ("ieee14-qlim", true),
    ] {
        let (_, r) = run_doc(name, enforce, 1e-9);
        assert!(r.converged, "{name}: {}", r.message);
        let reference = &golden(name)["loadflow"][if enforce { "qlim" } else { "base" }];
        for b in &r.buses {
            let want = &reference["bus"][&b.id];
            assert!(
                (b.vm - f(&want[0])).abs() < 1e-9,
                "{name} {} vm {} vs {}",
                b.id,
                b.vm,
                want[0]
            );
            assert!((b.va - f(&want[1])).abs() < 1e-7, "{name} {} va", b.id);
        }
        for br in &r.branches {
            let want = &reference[if br.cls == "line" { "line" } else { "trafo" }][&br.id];
            for (k, v) in [br.p_from, br.q_from, br.p_to, br.q_to].iter().enumerate() {
                assert!(
                    (v - f(&want[k])).abs() < 1e-6,
                    "{name} {} flow {k}: {v} vs {}",
                    br.id,
                    want[k]
                );
            }
            if br.cls == "line" {
                assert!(
                    (br.i_from.max(br.i_to) - f(&want[4])).abs() < 1e-9,
                    "{name} {} current",
                    br.id
                );
            }
        }
        for g in &r.gens {
            assert!((g.p - f(&reference["gen"][&g.id][0])).abs() < 1e-6, "{name} {} P", g.id);
            assert!((g.q - f(&reference["gen"][&g.id][1])).abs() < 1e-6, "{name} {} Q", g.id);
        }
    }
}

#[test]
fn reactive_limits_cascade_as_pandapower_finds() {
    let (_, r) = run_doc("ieee14-qlim", true, 0.001);
    let mut held: Vec<(&str, f64)> = r
        .gens
        .iter()
        .filter(|g| g.at_limit.is_some())
        .map(|g| (g.id.as_str(), g.q))
        .collect();
    held.sort_by(|a, b| a.0.cmp(b.0));
    let ids: Vec<&str> = held.iter().map(|h| h.0).collect();
    assert_eq!(ids, ["G2", "G4", "G5"]);
    let q = |id: &str| held.iter().find(|h| h.0 == id).map_or(f64::NAN, |h| h.1);
    assert!((q("G4") - 8.0).abs() < 1e-9 && (q("G5") - 10.0).abs() < 1e-9 && (q("G2") - 50.0).abs() < 1e-9);
    assert!(r.warnings.iter().any(|w| w.contains("reactive power limit")));
}

#[test]
fn every_bus_balances_and_totals_add_up() {
    for name in ["ieee14", "riverside"] {
        let (m, r) = run_doc(name, false, 1e-9);
        // Sum the branch flows leaving each bus plus its shunts; that must equal generation minus load there.
        let node_bus: std::collections::HashMap<&str, usize> =
            r.bus_ids.iter().enumerate().map(|(i, id)| (id.as_str(), i)).collect();
        let mut net_p = vec![0.0; r.buses.len()];
        let mut net_q = vec![0.0; r.buses.len()];
        let node_id = |n: ps_model::NodeRef| m.nodes[n.index()].id.as_str();
        for br in &r.branches {
            let (a, b) = match br.cls {
                "line" => {
                    let l = m.lines.iter().find(|l| l.id == br.id).unwrap();
                    (node_id(l.node1), node_id(l.node2))
                }
                _ => {
                    let t = m.transformers2.iter().find(|t| t.id == br.id).unwrap();
                    (node_id(t.node1), node_id(t.node2))
                }
            };
            net_p[node_bus[a]] += br.p_from;
            net_q[node_bus[a]] += br.q_from;
            net_p[node_bus[b]] += br.p_to;
            net_q[node_bus[b]] += br.q_to;
        }
        for s in &r.shunts {
            let sh = m.shunts.iter().find(|x| x.id == s.id).unwrap();
            net_p[node_bus[node_id(sh.node)]] += s.p;
            net_q[node_bus[node_id(sh.node)]] -= s.q;
        }
        let mut sched_p = vec![0.0; r.buses.len()];
        let mut sched_q = vec![0.0; r.buses.len()];
        for u in r.gens.iter() {
            let g = m.generators.iter().find(|g| g.id == u.id).unwrap();
            sched_p[node_bus[node_id(g.node)]] += u.p;
            sched_q[node_bus[node_id(g.node)]] += u.q;
        }
        for u in r.grids.iter() {
            let g = m.external_grids.iter().find(|g| g.id == u.id).unwrap();
            sched_p[node_bus[node_id(g.node)]] += u.p;
            sched_q[node_bus[node_id(g.node)]] += u.q;
        }
        for u in r.loads.iter() {
            let l = m.loads.iter().find(|l| l.id == u.id).unwrap();
            sched_p[node_bus[node_id(l.node)]] -= u.p;
            sched_q[node_bus[node_id(l.node)]] -= u.q;
        }
        for i in 0..r.buses.len() {
            assert!(
                (net_p[i] - sched_p[i]).abs() < 1e-6,
                "{name} {} P {} vs {}",
                r.bus_ids[i],
                net_p[i],
                sched_p[i]
            );
            assert!(
                (net_q[i] - sched_q[i]).abs() < 1e-6,
                "{name} {} Q {} vs {}",
                r.bus_ids[i],
                net_q[i],
                sched_q[i]
            );
        }
        assert!((r.totals.generation - r.totals.load - r.totals.losses).abs() < 1e-6);
    }
}

#[test]
fn flat_and_dc_starts_agree_and_a_warm_start_takes_one_iteration() {
    let imp = input("ieee14");
    let run = |dc: bool| {
        let settings = ps_model::study::LoadFlowSettings {
            tolerance: 1e-10,
            dc_start: dc,
            ..imp.study.loadflow
        };
        loadflow::run(
            &imp.model,
            &LoadFlowRun {
                settings,
                ..Default::default()
            },
        )
    };
    let (a, b) = (run(false), run(true));
    for (x, y) in a.buses.iter().zip(&b.buses) {
        assert!((x.vm - y.vm).abs() < 1e-10 && (x.va - y.va).abs() < 1e-8);
    }
    let rv = input("riverside");
    let settings = ps_model::study::LoadFlowSettings {
        tolerance: 1e-8,
        ..rv.study.loadflow
    };
    let (calc, sol, base) = loadflow::solve(
        &rv.model,
        &LoadFlowRun {
            settings,
            ..Default::default()
        },
    );
    let mut start = vec![None; rv.model.nodes.len()];
    for (b, bus) in calc.topo.buses.iter().enumerate() {
        for &n in &bus.nodes {
            start[n as usize] = Some((sol.vm[b], sol.va[b]));
        }
    }
    assert!(base.converged);
    let warm = loadflow::run(
        &rv.model,
        &LoadFlowRun {
            settings,
            start: Some(start),
            ..Default::default()
        },
    );
    assert!(warm.converged && warm.iterations <= 1, "iterations {}", warm.iterations);
}

#[test]
fn outages_deenergise_and_unsourced_islands_get_a_reference() {
    let imp = input("riverside");
    let settings = imp.study.loadflow;
    let out = |id: &str| ps_study::outages_by_id(&imp.model, [id]).0;
    let r = loadflow::run(
        &imp.model,
        &LoadFlowRun {
            settings,
            outages: out("L6"),
            ..Default::default()
        },
    );
    assert!(r.converged);
    assert_eq!(r.deenergized, ["B7"]);
    assert!(!r.buses.iter().any(|b| b.id == "B7"));
    let r = loadflow::run(
        &imp.model,
        &LoadFlowRun {
            settings,
            outages: out("L5"),
            ..Default::default()
        },
    );
    assert!(r.converged, "{}", r.message);
    assert!(r.warnings.iter().any(|w| w.contains("Hilltop CHP")));
    assert!(r.deenergized.is_empty());
}

#[test]
fn load_scaling_multiplies_every_load() {
    let imp = input("ieee14");
    let settings = ps_model::study::LoadFlowSettings {
        load_scale: 110.0,
        ..imp.study.loadflow
    };
    let r = loadflow::run(
        &imp.model,
        &LoadFlowRun {
            settings,
            ..Default::default()
        },
    );
    assert!((r.totals.load - 259.0 * 1.1).abs() < 1e-9);
}
