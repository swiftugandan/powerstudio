//! PSS/E RAW import and load flow against PowSyBl, case by case (tests/oracle/psse-cases.json).
//!
//! The RAW files are read in place from `.cache/reference` (`node scripts/fetch-reference.mjs` downloads them); the
//! goldens come from `scripts/oracle/psse.py`, which also documents the corrections that bring PowSyBl's network in
//! line with the PSS/E definitions. Each case is compared on what was imported (set points, shunt admittances, line
//! impedances) and on the load flow (every bus voltage, flows and outputs).
//!
//! A case marked `pending` in the case list needs something PowerStudio does not model yet; its import must match and
//! its load flow is reported without failing the test.
//!
//! With distributed slack off, OpenLoadFlow reports a slack machine's active power as its target, not the power it
//! balances; machines at slack buses are compared by reactive power only. Angles are compared relative to the slack
//! bus, since PSS/E holds the swing bus at its stated angle and OpenLoadFlow at zero.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use common::*;
use ps_model::Model;
use ps_model::study::LoadFlowSettings;
use ps_study::{LoadFlowRun, loadflow};
use serde_json::Value;

/// Bars from the design: voltages to 1e-6 p.u., flows to 1e-3 MW or Mvar.
const V_TOL: f64 = 1e-6;
const ANGLE_TOL: f64 = 1e-4;
const FLOW_TOL: f64 = 1e-3;
/// Imported data, relative to the value (absolute below 1).
const DATA_TOL: f64 = 1e-9;

fn import(case: &Value) -> ps_io::psse_model::Imported {
    let cases = json("tests/oracle/psse-cases.json");
    let file = cases["archives"][case["archive"].as_str().unwrap()]["file"]
        .as_str()
        .unwrap();
    let path = repo(&format!(".cache/reference/{file}"));
    let bytes = std::fs::read(&path)
        .unwrap_or_else(|e| panic!("{}: {e}. Run node scripts/fetch-reference.mjs first.", path.display()));
    // RAW files are ASCII or Latin-1; names are the only text that can carry other bytes.
    let text: String = bytes.iter().map(|&b| char::from(b)).collect();
    ps_io::psse_model::import(&text, file).unwrap_or_else(|e| panic!("{file}: {e}"))
}

fn compare_import(m: &Model, golden: &Value, w: &mut Worst) {
    let im = &golden["imported"];
    let missing = |w: &mut Worst, what: &str, id: &str| w.check(&format!("{what} missing"), id, 1.0, 0.0);
    for (id, g) in im["lines"].as_object().unwrap() {
        if let Some(t) = m.transformers2.iter().find(|t| t.id == *id) {
            compare_line_across_voltages(m, t, g, w);
            continue;
        }
        let Some(l) = m.lines.iter().find(|l| l.id == *id) else {
            missing(w, "line", id);
            continue;
        };
        w.check("line r", id, l.r, f(&g["r"]));
        w.check("line x", id, l.x, f(&g["x"]));
        for (k, got) in [("g1", l.g1), ("b1", l.b1), ("g2", l.g2), ("b2", l.b2)] {
            w.check("line shunt", id, got, f(&g[k]));
        }
    }
    for (id, g) in im["loads"].as_object().unwrap() {
        let Some(l) = m.loads.iter().find(|l| l.id == *id) else {
            missing(w, "load", id);
            continue;
        };
        w.check("load P", id, l.p, f(&g["p0"]));
        w.check("load Q", id, l.q, f(&g["q0"]));
    }
    for (id, g) in im["generators"].as_object().unwrap() {
        let Some(u) = m.generators.iter().find(|u| u.id == *id) else {
            missing(w, "generator", id);
            continue;
        };
        w.check("generator P", id, u.p, f(&g["target_p"]));
        w.check("generator Q min", id, u.q_min, f(&g["min_q"]));
        w.check("generator Q max", id, u.q_max, f(&g["max_q"]));
        if g["regulating"].as_bool() == Some(true) {
            let at = u.regulated_node.unwrap_or(u.node);
            w.check("generator V target", id, u.v_set * m.nominal_kv(at), f(&g["target_v"]));
        }
    }
    for (id, g) in im["shunts"].as_object().unwrap() {
        let Some(s) = m.shunts.iter().find(|s| s.id == *id) else {
            missing(w, "shunt", id);
            continue;
        };
        w.check("shunt sections", id, f64::from(s.sections), f(&g["sections"]));
        w.check(
            "shunt sections installed",
            id,
            f64::from(s.max_sections),
            f(&g["max_sections"]),
        );
        let y = ps_net::shunt_admittance(s);
        w.check("shunt G", id, y.re, f(&g["g"]));
        w.check("shunt B", id, y.im, f(&g["b"]));
    }
}

/// Tap changers: step count, present step counted from the lowest, and control. Where PowSyBl moved a stated ratio
/// onto a nearby step (the golden lists them under `corrected`), it has one step fewer than PowerStudio, which keeps
/// the stated ratio as a step of its own. A fixed winding angle is a one-step phase tap in PowSyBl and a fixed phase
/// shift in PowerStudio.
///
/// Controls compare by target and dead band wherever PowSyBl defines one. Whether a control is switched on differs by
/// design: PowerStudio follows the sign of COD (negative: off), which PowSyBl does not read; PowSyBl drops a phase
/// shifter's control when CONT is 0, although PSS/E then measures the transformer's own flow; and it keeps one
/// control per transformer.
fn compare_taps(m: &Model, golden: &Value, w: &mut Worst) {
    let im = &golden["imported"];
    let snapped = &golden["corrected"]["winding_1_ratio"];
    let end_of = |key: &str| match key.rsplit('#').next() {
        Some("TWO") => 2u8,
        Some("THREE") => 3,
        _ => 1,
    };
    for (key, g) in im["ratio_taps"].as_object().unwrap() {
        let (id, end) = (key.split('#').next().unwrap_or(""), end_of(key));
        let taps = m
            .transformers2
            .iter()
            .find(|t| t.id == id)
            .map(|t| &t.ratio_taps)
            .or_else(|| m.transformers3.iter().find(|t| t.id == id).map(|t| &t.ratio_taps));
        let Some(tap) = taps.and_then(|taps| taps.iter().find(|tap| tap.end == end)) else {
            w.check("ratio tap missing", key, 1.0, 0.0);
            continue;
        };
        if snapped.get(id).is_none() {
            w.check("ratio tap steps", key, tap.table.len().max(1) as f64, f(&g["steps"]));
            w.check(
                "ratio tap position",
                key,
                f64::from(tap.position - tap.low),
                f(&g["tap"]),
            );
        }
        if g["regulating"] == true {
            match tap.control {
                Some(c) => {
                    w.check("ratio tap target", key, c.target_kv, f(&g["target_v"]));
                    w.check("ratio tap dead band", key, c.deadband_kv, f(&g["deadband"]));
                }
                None => w.check("ratio tap control missing", key, 1.0, 0.0),
            }
        }
    }
    for (key, g) in im["phase_taps"].as_object().unwrap() {
        let (id, end) = (key.split('#').next().unwrap_or(""), end_of(key));
        let t2 = m.transformers2.iter().find(|t| t.id == id);
        let t3 = m.transformers3.iter().find(|t| t.id == id);
        let tap = t2
            .and_then(|t| t.phase_tap.as_ref())
            .or_else(|| t3.and_then(|t| t.phase_taps.iter().find(|tap| tap.end == end)));
        let Some(tap) = tap else {
            let fixed = t2.is_some_and(|t| t.phase_shift_deg != 0.0)
                || t3.is_some_and(|t| t.windings[usize::from(end) - 1].phase_shift_deg != 0.0);
            if !(fixed && g["steps"] == 1) {
                w.check("phase tap missing", key, 1.0, 0.0);
            }
            continue;
        };
        w.check("phase tap steps", key, tap.table.len() as f64, f(&g["steps"]));
        w.check(
            "phase tap position",
            key,
            f64::from(tap.position - tap.low),
            f(&g["tap"]),
        );
        if g["regulating"] == true {
            match tap.control {
                Some(c) => {
                    w.check("phase tap target", key, c.target_mw, f(&g["target"]));
                    w.check("phase tap dead band", key, c.deadband_mw, f(&g["deadband"]));
                }
                None => w.check("phase tap control missing", key, 1.0, 0.0),
            }
        }
    }
}

/// A branch between buses of different base voltage. PowerStudio models it as a transformer at the ratio of the
/// bases; PowSyBl keeps a line, with the impedance scaled by vn1·vn2 and end shunts that compensate
/// (LineConverter). Both are compared in the file's per-unit values.
fn compare_line_across_voltages(m: &Model, t: &ps_model::Transformer2, g: &Value, w: &mut Worst) {
    let (sb, v1, v2) = (m.meta.base_mva, t.rated_kv1, t.rated_kv2);
    let zb1 = v1 * v1 / sb;
    let (r, x) = (f(&g["r"]), f(&g["x"]));
    w.check("line r", &t.id, t.r / zb1, r * sb / (v1 * v2));
    w.check("line x", &t.id, t.x / zb1, x * sb / (v1 * v2));
    let y = ps_num::C64::new(r, x).inv();
    let end = |shunt: f64, series: f64, vn: f64, other: f64| (shunt + (1.0 - other / vn) * series) * vn * vn / sb;
    w.check("line shunt", &t.id, t.g1 * zb1, end(f(&g["g1"]), y.re, v1, v2));
    w.check("line shunt", &t.id, t.b1 * zb1, end(f(&g["b1"]), y.im, v1, v2));
    w.check("line shunt", &t.id, t.g2 * zb1, end(f(&g["g2"]), y.re, v2, v1));
    w.check("line shunt", &t.id, t.b2 * zb1, end(f(&g["b2"]), y.im, v2, v1));
}

fn compare_loadflow(m: &Model, start: &str, golden: &Value, w: &mut Worst) {
    let settings = LoadFlowSettings {
        tolerance: 1e-9,
        max_iter: 50,
        ..Default::default()
    };
    let warm = (start == "raw").then(|| {
        m.nodes
            .iter()
            .map(|n| (n.v0 > 0.0).then(|| (n.v0, n.angle0.to_radians())))
            .collect()
    });
    let (calc, sol, report) = loadflow::solve(
        m,
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
    let lf = &golden["loadflow"];
    let slack: Vec<&str> = golden["slack"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .collect();
    // Generator identifiers start with their RAW bus ("B1-G1"), node-breaker buses included.
    let at_slack = |id: &str| id.split('-').next().is_some_and(|b| slack.contains(&b));
    let solved = |n: ps_model::NodeRef| calc.topo.bus_of(n).map(|b| (sol.vm[b], sol.va[b].to_degrees()));
    let solved_id = |id: &str| {
        m.nodes
            .iter()
            .position(|n| n.id == id)
            .and_then(|i| solved(ps_model::NodeRef(i as u32)))
    };
    // Angles relative to the first slack machine's terminal.
    let gens = lf["generators"].as_object().unwrap();
    let reference = m
        .generators
        .iter()
        .find(|u| at_slack(&u.id) && gens.contains_key(&u.id));
    let my_ref = reference.and_then(|u| solved(u.node)).map_or(0.0, |s| s.1);
    let their_ref = reference.map_or(0.0, |u| f(&gens[&u.id]["v"][1]));
    let voltage = |w: &mut Worst, what: &str, id: &str, mine: Option<(f64, f64)>, g: &Value| {
        if g.is_null() {
            return;
        }
        match mine {
            Some((vm, va)) => {
                w.check(&format!("{what} V"), id, vm, f(&g[0]));
                w.check(&format!("{what} angle"), id, va - my_ref, f(&g[1]) - their_ref);
            }
            None => w.check(&format!("{what} not solved"), id, 1.0, 0.0),
        }
    };
    for (id, g) in lf["buses"].as_object().unwrap() {
        voltage(w, "bus", id, solved_id(id), g);
    }
    let branch = |id: &str, winding: Option<u8>| report.branches.iter().find(|b| b.id == id && b.winding == winding);
    let ends = |id: &str| -> Option<Vec<ps_model::NodeRef>> {
        let line = m.lines.iter().find(|l| l.id == id).map(|l| vec![l.node1, l.node2]);
        let t2 = || {
            m.transformers2
                .iter()
                .find(|t| t.id == id)
                .map(|t| vec![t.node1, t.node2])
        };
        let t3 = || {
            m.transformers3
                .iter()
                .find(|t| t.id == id)
                .map(|t| t.windings.iter().map(|w| w.node).collect())
        };
        line.or_else(t2).or_else(t3)
    };
    for (table, what) in [("lines", "line flow"), ("transformers2", "transformer flow")] {
        for (id, g) in lf[table].as_object().unwrap() {
            for (k, n) in ends(id).unwrap_or_default().into_iter().enumerate() {
                voltage(w, "terminal", id, solved(n), &g[format!("v{}", k + 1)]);
            }
            if let Some(b) = branch(id, None) {
                for (k, got) in [("p1", b.p_from), ("q1", b.q_from), ("p2", b.p_to), ("q2", b.q_to)] {
                    w.check(what, id, got, f(&g[k]));
                }
            }
        }
    }
    for (id, g) in lf["transformers3"].as_object().unwrap() {
        for (k, n) in ends(id).unwrap_or_default().into_iter().enumerate() {
            voltage(w, "terminal", id, solved(n), &g[format!("v{}", k + 1)]);
        }
        for k in 1..=3u8 {
            if let Some(b) = branch(id, Some(k)) {
                w.check("transformer flow", id, b.p_from, f(&g[format!("p{k}")]));
                w.check("transformer flow", id, b.q_from, f(&g[format!("q{k}")]));
            }
        }
    }
    let node_of = |class: &str, id: &str| -> Option<ps_model::NodeRef> {
        match class {
            "generators" => m.generators.iter().find(|x| x.id == id).map(|x| x.node),
            "loads" => m.loads.iter().find(|x| x.id == id).map(|x| x.node),
            _ => m.shunts.iter().find(|x| x.id == id).map(|x| x.node),
        }
    };
    for class in ["generators", "loads", "shunts"] {
        for (id, g) in lf[class].as_object().unwrap() {
            if let Some(n) = node_of(class, id) {
                voltage(w, "terminal", id, solved(n), &g["v"]);
            }
        }
    }
    for (id, g) in gens {
        let Some(u) = report.gens.iter().find(|u| u.id == *id) else {
            continue;
        };
        // PowSyBl reports a generator's terminal power in load convention.
        if !at_slack(id) {
            w.check("generator output", id, -u.p, f(&g["p"]));
        }
        w.check("generator output", id, -u.q, f(&g["q"]));
    }
    for (id, g) in lf["loads"].as_object().unwrap() {
        if let Some(u) = report.loads.iter().find(|u| u.id == *id) {
            w.check("load", id, u.p, f(&g["p"]));
            w.check("load", id, u.q, f(&g["q"]));
        }
    }
    for (id, g) in lf["shunts"].as_object().unwrap() {
        if let Some(u) = report.shunts.iter().find(|u| u.id == *id) {
            w.check("shunt Q", id, -u.q, f(&g["q"]));
        }
    }
}

#[test]
fn psse_cases_match_powsybl() {
    let cases = json("tests/oracle/psse-cases.json");
    let mut failures = Vec::new();
    for case in cases["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let golden = golden(&format!("psse-{name}"));
        let imported = import(case);
        eprintln!("{name}:");
        let mut w = Worst::default();
        compare_import(&imported.model, &golden, &mut w);
        compare_taps(&imported.model, &golden, &mut w);
        if !golden["loadflow"].is_null() {
            compare_loadflow(&imported.model, case["start"].as_str().unwrap_or("dc"), &golden, &mut w);
        }
        for (what, d, at, _) in &w.rows {
            eprintln!("  {what:28} {d:9.2e}  {at}");
        }
        let flows = ["line flow", "transformer flow", "generator output", "load", "shunt Q"];
        let voltages = w.max("bus V").max(w.max("terminal V"));
        let angles = w.max("bus angle").max(w.max("terminal angle"));
        let flow = flows.iter().map(|k| w.max(k)).fold(0.0, f64::max);
        let data = w
            .rows
            .iter()
            .filter(|r| !flows.contains(&r.0.as_str()) && !r.0.ends_with(" V") && !r.0.ends_with(" angle"))
            .map(|r| r.1 / 1f64.max(r.3.abs()))
            .fold(0.0, f64::max);
        eprintln!(
            "SUMMARY {name}: V {voltages:.1e} p.u., angle {angles:.1e}°, flows {flow:.1e} MW or Mvar, data {data:.1e}"
        );
        if let Some(why) = case["pending"].as_str() {
            // Reported, not failed: the import must still match.
            eprintln!("  load flow pending: {why}");
            if data > DATA_TOL {
                failures.push(format!("{name}: data {data:.1e}"));
            }
            continue;
        }
        if voltages > V_TOL || angles > ANGLE_TOL || flow > FLOW_TOL || data > DATA_TOL {
            failures.push(format!(
                "{name}: V {voltages:.1e}, angle {angles:.1e}°, flows {flow:.1e}, data {data:.1e}"
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
