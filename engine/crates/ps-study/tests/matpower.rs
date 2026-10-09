//! Large MATPOWER cases against PowSyBl (tests/oracle/matpower-cases.json): the ACTIVSg synthetic grids up to 70,000
//! buses and the PEGASE European cases. The cases are read in place from `.cache/reference`
//! (`node scripts/fetch-reference.mjs` downloads them); the goldens come from `scripts/oracle/matpower.py` and hold
//! arrays in the case's row order: every bus voltage, every generator output and, except for the two largest grids,
//! every branch flow.
//!
//! With distributed slack off, OpenLoadFlow reports a slack machine's active power as its target; machines at slack
//! buses are compared by reactive power only. Angles are compared relative to the first slack bus.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use common::*;
use ps_model::study::LoadFlowSettings;
use ps_study::{LoadFlowRun, loadflow};

/// Bars from the design: voltages to 1e-6 p.u., flows to 1e-3 MW or Mvar.
const V_TOL: f64 = 1e-6;
const ANGLE_TOL: f64 = 1e-4;
const FLOW_TOL: f64 = 1e-3;

fn compare(name: &str, file: &str, start: &str, w: &mut Worst) {
    let path = repo(&format!(".cache/reference/{file}"));
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{}: {e}. Run node scripts/fetch-reference.mjs first.", path.display()));
    let model = ps_io::matpower_model::to_model(&ps_io::matpower::parse(&text).unwrap()).model;
    let g = golden(&format!("matpower-{name}"));
    let warm = (start == "case").then(|| {
        model
            .nodes
            .iter()
            .map(|n| (n.v0 > 0.0).then(|| (n.v0, n.angle0.to_radians())))
            .collect()
    });
    // OpenLoadFlow's threshold, 1e-10 p.u. per equation, is 1e-8 MVA on these cases' 100 MVA base; the largest
    // cases cannot get much below that in double precision.
    let settings = LoadFlowSettings {
        tolerance: 1e-8,
        max_iter: 50,
        ..LoadFlowSettings::plain()
    };
    let (calc, sol, report) = loadflow::solve(
        &model,
        &LoadFlowRun {
            settings,
            start: warm,
            ..Default::default()
        },
    );
    if !report.converged {
        w.check("load flow converged", &report.message, 0.0, 1.0);
        return;
    }
    let numbers: Vec<i64> = g["buses"]["number"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_i64().unwrap())
        .collect();
    let solved = |number: i64| {
        let id = format!("B{number}");
        let i = model.nodes.iter().position(|n| n.id == id)?;
        calc.topo
            .bus_of(ps_model::NodeRef(i as u32))
            .map(|b| (sol.vm[b], sol.va[b].to_degrees()))
    };
    let slack = g["slack"][0].as_i64().unwrap();
    let k_slack = numbers.iter().position(|&n| n == slack).unwrap();
    let (my_ref, their_ref) = (solved(slack).map_or(0.0, |s| s.1), f(&g["buses"]["va"][k_slack]));
    for (k, &number) in numbers.iter().enumerate() {
        let id = format!("B{number}");
        match solved(number) {
            Some((vm, va)) => {
                w.check("bus V", &id, vm, f(&g["buses"]["vm"][k]));
                w.check("bus angle", &id, va - my_ref, f(&g["buses"]["va"][k]) - their_ref);
            }
            None => w.check("bus not solved", &id, 1.0, 0.0),
        }
    }
    let branches: std::collections::HashMap<&str, &ps_study::loadflow::BranchResult> =
        report.branches.iter().map(|b| (b.id.as_str(), b)).collect();
    let rows = g["branches"]["p1"].as_array().map_or(0, Vec::len);
    for row in 1..=rows {
        let (line, trafo) = (format!("L{row}"), format!("T{row}"));
        let Some(b) = branches.get(line.as_str()).or_else(|| branches.get(trafo.as_str())) else {
            continue;
        };
        for (k, got) in [("p1", b.p_from), ("q1", b.q_from), ("p2", b.p_to), ("q2", b.q_to)] {
            w.check("branch flow", &b.id, got, f(&g["branches"][k][row - 1]));
        }
    }
    let units: std::collections::HashMap<&str, &ps_study::loadflow::UnitResult> =
        report.gens.iter().map(|u| (u.id.as_str(), u)).collect();
    // Generators are named by their row in the case (G12 for row 12). PowSyBl reports a generator's terminal power in
    // load convention.
    let row = |id: &str| id[1..].parse::<usize>().unwrap() - 1;
    let mut by_node: std::collections::BTreeMap<u32, Vec<&ps_model::Generator>> = std::collections::BTreeMap::new();
    for gen_ in &model.generators {
        let Some(u) = units.get(gen_.id.as_str()) else {
            continue;
        };
        if model.nodes[gen_.node.index()].id != format!("B{slack}") {
            w.check(
                "generator output",
                &gen_.id,
                -u.p,
                f(&g["generators"]["p"][row(&gen_.id)]),
            );
        }
        if gen_.in_service {
            by_node.entry(gen_.node.0).or_default().push(gen_);
        }
    }
    // Reactive power: both tools agree on each bus's total. Among several machines on a bus PowerStudio follows
    // MATPOWER's rule (the same fraction of each machine's range); OpenLoadFlow's K_EQUAL_PROPORTION is the same rule,
    // but it splits equally when a machine's limits are implausible (beyond ±1000 Mvar, or a range outside 1 to
    // 10,000 Mvar). Machines are compared one by one where the rules coincide, and by bus total elsewhere.
    let plausible = |x: &ps_model::Generator| {
        let range = x.q_max - x.q_min;
        x.q_min.abs() < 1000.0 && x.q_max.abs() < 1000.0 && range > 1.0 && range < 10_000.0
    };
    for (node, machines) in &by_node {
        let mine = |x: &ps_model::Generator| units.get(x.id.as_str()).map_or(f64::NAN, |u| -u.q);
        let theirs = |x: &ps_model::Generator| f(&g["generators"]["q"][row(&x.id)]);
        if machines.len() == 1 || machines.iter().all(|x| plausible(x)) {
            for x in machines {
                w.check("generator output", &x.id, mine(x), theirs(x));
            }
        } else {
            let id = &model.nodes[*node as usize].id;
            let total = |v: &dyn Fn(&ps_model::Generator) -> f64| machines.iter().map(|x| v(x)).sum::<f64>();
            w.check("generator output", id, total(&mine), total(&theirs));
        }
    }
}

#[test]
fn large_matpower_cases_match_powsybl() {
    let cases = json("tests/oracle/matpower-cases.json");
    let mut failures = Vec::new();
    for case in cases["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let file = cases["archives"][case["archive"].as_str().unwrap()]["file"]
            .as_str()
            .unwrap();
        let mut w = Worst::default();
        let t0 = std::time::Instant::now();
        compare(name, file, case["start"].as_str().unwrap_or("dc"), &mut w);
        eprintln!("{name} ({:.1} s):", t0.elapsed().as_secs_f64());
        for (what, d, at, _) in &w.rows {
            eprintln!("  {what:24} {d:9.2e}  {at}");
        }
        let (v, a) = (w.max("bus V"), w.max("bus angle"));
        let flow = w.max("branch flow").max(w.max("generator output"));
        let other = w.max("bus not solved").max(w.max("load flow converged"));
        eprintln!("SUMMARY {name}: V {v:.1e} p.u., angle {a:.1e}°, flows {flow:.1e} MW or Mvar");
        if v > V_TOL || a > ANGLE_TOL || flow > FLOW_TOL || other > 0.0 {
            failures.push(format!(
                "{name}: V {v:.1e}, angle {a:.1e}°, flows {flow:.1e}, unsolved {other}"
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
