//! CGMES import and load flow against PowSyBl, configuration by configuration (tests/oracle/cgmes-cases.json).
//!
//! The ENTSO-E archives are read in place from `.cache/reference` (`node scripts/fetch-reference.mjs` downloads
//! them); the goldens come from `scripts/oracle/cgmes.py`. Each case is compared twice: what was imported (the data
//! PowSyBl converted, element by element) and the load flow (voltages at every element terminal, flows and outputs).
//!
//! Two conventions differ and are bridged here rather than in the engine:
//! * PowSyBl models a line to a boundary point as a dangling line whose whole shunt admittance sits at the network
//!   end; PowerStudio keeps the π model with half at each end. Before the load flow comparison this test moves the
//!   boundary end's shunt to the network end, so the rest of the solution can be compared exactly.
//! * With distributed slack off, OpenLoadFlow reports the slack machine's active power as its target, not the power
//!   it balances; slack machines are compared by reactive power only.
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

/// PowSyBl's dangling-line convention: a boundary line's shunt admittance all at its network end.
fn boundary_shunts_at_network_end(m: &Model) -> Model {
    let mut m = m.clone();
    let boundary = |n: ps_model::NodeRef, m: &Model| m.nodes[n.index()].kind == ps_model::NodeKind::Boundary;
    let ends: Vec<(bool, bool)> = m
        .lines
        .iter()
        .map(|l| (boundary(l.node1, &m), boundary(l.node2, &m)))
        .collect();
    for (l, (b1, b2)) in m.lines.iter_mut().zip(ends) {
        if b2 && !b1 {
            (l.g1, l.b1, l.g2, l.b2) = (l.g1 + l.g2, l.b1 + l.b2, 0.0, 0.0);
        } else if b1 && !b2 {
            (l.g2, l.b2, l.g1, l.b1) = (l.g1 + l.g2, l.b1 + l.b2, 0.0, 0.0);
        }
    }
    m
}

fn compare_import(m: &Model, golden: &Value, w: &mut Worst) {
    let im = &golden["imported"];
    let line = |id: &str| m.lines.iter().find(|l| l.id == id);
    let missing = |w: &mut Worst, what: &str, id: &str| w.check(&format!("{what} missing"), id, 1.0, 0.0);
    for (id, g) in im["lines"].as_object().unwrap() {
        let Some(l) = line(id) else {
            missing(w, "line", id);
            continue;
        };
        w.check("line r", id, l.r, f(&g["r"]));
        w.check("line x", id, l.x, f(&g["x"]));
        w.check("line b", id, l.b1 + l.b2, f(&g["b1"]) + f(&g["b2"]));
        w.check("line g", id, l.g1 + l.g2, f(&g["g1"]) + f(&g["g2"]));
    }
    for (id, g) in im["dangling"].as_object().unwrap() {
        let Some(l) = line(id) else {
            missing(w, "boundary line", id);
            continue;
        };
        w.check("line r", id, l.r, f(&g["r"]));
        w.check("line x", id, l.x, f(&g["x"]));
        w.check("line b", id, l.b1 + l.b2, f(&g["b"]));
    }
    for (id, g) in im["transformers2"].as_object().unwrap() {
        let Some(t) = m.transformers2.iter().find(|t| t.id == *id) else {
            missing(w, "transformer", id);
            continue;
        };
        let refer = (t.rated_kv2 / t.rated_kv1).powi(2);
        let tap = ps_net::tap_effect(t);
        w.check("transformer rated U1", id, t.rated_kv1, f(&g["rated_u1"]));
        w.check("transformer rated U2", id, t.rated_kv2, f(&g["rated_u2"]));
        // PowSyBl refers the impedance to side 2 and keeps the tap corrections apart.
        w.check("transformer r", id, t.r * refer, f(&g["r"]));
        w.check("transformer x", id, t.x * refer, f(&g["x"]));
        w.check(
            "transformer r at tap",
            id,
            t.r * refer * tap.r_scale,
            f(&g["r_at_current_tap"]),
        );
        w.check(
            "transformer x at tap",
            id,
            t.x * refer * tap.x_scale,
            f(&g["x_at_current_tap"]),
        );
        // PowSyBl's ratio is U2/U1 at the present taps, rated ratio included; its angle makes side 2 lead.
        w.check(
            "transformer ratio",
            id,
            (t.rated_kv2 * tap.f2) / (t.rated_kv1 * tap.f1),
            f(&g["rho"]),
        );
        w.check("transformer angle", id, -tap.angle_deg, f(&g["alpha"]));
    }
    for (id, g) in im["loads"].as_object().unwrap() {
        if let Some(l) = m.loads.iter().find(|l| l.id == *id) {
            w.check("load P", id, l.p, f(&g["p0"]));
            w.check("load Q", id, l.q, f(&g["q0"]));
        }
    }
    for (id, g) in im["generators"].as_object().unwrap() {
        let Some(gen_) = m.generators.iter().find(|x| x.id == *id) else {
            continue;
        };
        w.check("generator P", id, gen_.p, f(&g["target_p"]));
        let regulated = gen_.regulated_node.unwrap_or(gen_.node);
        if g["regulating"].as_bool() == Some(true) {
            w.check(
                "generator V target",
                id,
                gen_.v_set * m.nominal_kv(regulated),
                f(&g["target_v"]),
            );
        }
    }
    for (id, g) in im["shunts"].as_object().unwrap() {
        let Some(s) = m.shunts.iter().find(|s| s.id == *id) else {
            missing(w, "shunt", id);
            continue;
        };
        w.check("shunt sections", id, f64::from(s.sections), f(&g["sections"]));
        w.check("shunt B", id, ps_net::shunt_admittance(s).im, f(&g["b"]));
    }
    for (id, open) in im["switches"].as_object().unwrap() {
        let Some(s) = m.switches.iter().find(|s| s.id == *id) else {
            continue;
        };
        w.check(
            "switch open",
            id,
            f64::from(u8::from(s.open)),
            f64::from(u8::from(open.as_bool() == Some(true))),
        );
    }
}

fn compare_loadflow(m: &Model, start: &str, golden: &Value, w: &mut Worst) {
    let settings = LoadFlowSettings {
        tolerance: 1e-9,
        max_iter: 50,
        ..LoadFlowSettings::plain()
    };
    let warm = (start == "sv").then(|| {
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
    let node_v = |n: ps_model::NodeRef| calc.topo.bus_of(n).map(|b| (sol.vm[b], sol.va[b].to_degrees()));
    let voltage = |w: &mut Worst, what: &str, id: &str, n: ps_model::NodeRef, g: &Value| {
        if g.is_null() {
            return;
        }
        if let Some((vm, va)) = node_v(n) {
            w.check(&format!("{what} V"), id, vm, f(&g[0]));
            w.check(&format!("{what} angle"), id, va, f(&g[1]));
        }
    };
    let lf = &golden["loadflow"];
    let branch = |id: &str| report.branches.iter().find(|b| b.id == id);
    for (id, g) in lf["lines"].as_object().unwrap() {
        let l = m.lines.iter().find(|l| l.id == *id).unwrap();
        voltage(w, "line end", id, l.node1, &g["v1"]);
        voltage(w, "line end", id, l.node2, &g["v2"]);
        if let Some(b) = branch(id) {
            for (k, got) in [("p1", b.p_from), ("q1", b.q_from), ("p2", b.p_to), ("q2", b.q_to)] {
                w.check("line flow", id, got, f(&g[k]));
            }
        }
    }
    for (id, g) in lf["dangling"].as_object().unwrap() {
        let l = m.lines.iter().find(|l| l.id == *id).unwrap();
        let network_end_first = m.nodes[l.node2.index()].kind == ps_model::NodeKind::Boundary;
        let node = if network_end_first { l.node1 } else { l.node2 };
        voltage(w, "boundary line", id, node, &g["v"]);
        if let Some(b) = branch(id) {
            let (p, q) = if network_end_first {
                (b.p_from, b.q_from)
            } else {
                (b.p_to, b.q_to)
            };
            w.check("boundary line flow", id, p, f(&g["p"]));
            w.check("boundary line flow", id, q, f(&g["q"]));
        }
    }
    for (id, g) in lf["transformers2"].as_object().unwrap() {
        let t = m.transformers2.iter().find(|t| t.id == *id).unwrap();
        voltage(w, "transformer end", id, t.node1, &g["v1"]);
        voltage(w, "transformer end", id, t.node2, &g["v2"]);
        if let Some(b) = branch(id) {
            for (k, got) in [("p1", b.p_from), ("q1", b.q_from), ("p2", b.p_to), ("q2", b.q_to)] {
                w.check("transformer flow", id, got, f(&g[k]));
            }
        }
    }
    for (id, g) in lf["transformers3"].as_object().unwrap() {
        let t = m.transformers3.iter().find(|t| t.id == *id).unwrap();
        for (k, wd) in t.windings.iter().enumerate() {
            voltage(w, "transformer end", id, wd.node, &g[format!("v{}", k + 1)]);
            if let Some(b) = report
                .branches
                .iter()
                .find(|b| b.id == *id && b.winding == Some(k as u8 + 1))
            {
                w.check("transformer flow", id, b.p_from, f(&g[format!("p{}", k + 1)]));
                w.check("transformer flow", id, b.q_from, f(&g[format!("q{}", k + 1)]));
            }
        }
    }
    let slack: Vec<&str> = golden["slack"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .collect();
    for (id, g) in lf["generators"].as_object().unwrap() {
        let Some(u) = report.gens.iter().find(|u| u.id == *id) else {
            continue;
        };
        // PowSyBl reports a generator's terminal power in load convention.
        if !slack.contains(&id.as_str()) {
            w.check("generator output", id, -u.p, f(&g["p"]));
        }
        w.check("generator output", id, -u.q, f(&g["q"]));
    }
    for (id, g) in lf["loads"].as_object().unwrap() {
        let Some(u) = report.loads.iter().find(|u| u.id == *id) else {
            continue;
        };
        w.check("load", id, u.p, f(&g["p"]));
        w.check("load", id, u.q, f(&g["q"]));
    }
    for (id, g) in lf["shunts"].as_object().unwrap() {
        let Some(u) = report.shunts.iter().find(|u| u.id == *id) else {
            continue;
        };
        w.check("shunt Q", id, -u.q, f(&g["q"]));
    }
}

#[test]
fn cgmes_configurations_match_powsybl() {
    let cases = json("tests/oracle/cgmes-cases.json");
    let mut failures = Vec::new();
    for case in cases["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let golden = golden(&format!("cgmes-{name}"));
        let imported = ps_io::cgmes::import(&cgmes_files(case)).unwrap_or_else(|e| panic!("{name}: {e}"));
        eprintln!("{name}:");
        let mut w = Worst::default();
        compare_import(&imported.model, &golden, &mut w);
        if !golden["loadflow"].is_null() {
            let model = boundary_shunts_at_network_end(&imported.model);
            compare_loadflow(&model, case["start"].as_str().unwrap_or("dc"), &golden, &mut w);
        }
        for (what, d, at, _) in &w.rows {
            eprintln!("  {what:28} {d:9.2e}  {at}");
        }
        let flows = [
            "line flow",
            "boundary line flow",
            "transformer flow",
            "generator output",
            "load",
            "shunt Q",
        ];
        let voltages = w
            .rows
            .iter()
            .filter(|r| r.0.ends_with(" V"))
            .map(|r| r.1)
            .fold(0.0, f64::max);
        let angles = w
            .rows
            .iter()
            .filter(|r| r.0.ends_with(" angle") && !r.0.starts_with("transformer angle"))
            .map(|r| r.1)
            .fold(0.0, f64::max);
        let flow = flows.iter().map(|k| w.max(k)).fold(0.0, f64::max);
        let data = w
            .rows
            .iter()
            .filter(|r| !flows.contains(&r.0.as_str()) && !r.0.ends_with(" V") && !r.0.ends_with(" angle"))
            .map(|r| r.1 / 1f64.max(r.3.abs()))
            .fold(0.0, f64::max);
        let data = data.max(w.max("transformer angle"));
        eprintln!(
            "SUMMARY {name}: V {voltages:.1e} p.u., angle {angles:.1e}°, flows {flow:.1e} MW or Mvar, data {data:.1e}"
        );
        if voltages > V_TOL || angles > ANGLE_TOL || flow > FLOW_TOL || data > 1e-9 {
            failures.push(format!(
                "{name}: V {voltages:.1e}, angle {angles:.1e}°, flows {flow:.1e}, data {data:.1e}"
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
