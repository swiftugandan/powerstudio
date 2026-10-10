//! Stability simulation against ANDES on its published PSS/E cases (tests/oracle/dyn-cases.json): Kundur's two-area
//! system with classical and with round-rotor machines and their controls, the IEEE 14-bus system and the WECC
//! 179-bus system, each read from its RAW and DYR files. scripts/oracle/andes_dyn.py runs the same files and events
//! in ANDES at a quarter of the engine's step; this test runs them in the engine and compares every machine's rotor
//! angle, speed, electrical and reactive power, field voltage and mechanical power, and the bus voltages, at ANDES's
//! own time points (the engine's trajectory interpolated there).
//!
//! Each case runs twice. With ANDES's way across events ([`rms::EventSteps::Andes`]) the trajectories must agree
//! everywhere except within two steps of an event, where the two time grids differ. With the engine's own way
//! (the default) they must agree from 0.3 s after each event, to three times the tolerance: ANDES's first step after
//! an event carries a first-order error, which shows at once in the subtransient states and then in the swings it
//! excites.
//!
//! The tolerances (docs/TESTING.md derives them) allow three measured effects: ANDES's anti-windup limits carry an
//! error that shrinks with its step (Kundur's fault, where every exciter reaches its ceiling), the engine's 1 ms step
//! on the IEEE 14-bus system's fast EXST1 exciter during a fault, and the WECC load flows' difference of 1.8e-6 p.u.,
//! which moves the slack machine's power by 3.7e-4 p.u.
//!
//! `PS_DYN_REPORT` prints the worst differences; `PS_DYN_DUMP` set to a folder writes every compared value and ANDES's
//! as CSV; `PS_DYN_STEP` runs the engine at another step.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use common::*;
use ps_model::study::{EventKind, RmsSettings, SimEvent, StudyCase};
use ps_study::{LoadFlowRun, Silent, loadflow, rms};
use serde_json::Value;

/// Agreement required, per quantity: rotor angle (rad), speed (p.u.), powers (p.u. on 100 MVA), field voltage (p.u.),
/// bus voltage (p.u.).
const TOL: [(&str, f64); 7] = [
    ("delta", 2e-3),
    ("omega", 3e-6),
    ("Pe", 1e-3),
    ("Qe", 1e-3),
    ("vf", 2e-3),
    ("tm", 1e-3),
    ("v", 5e-5),
];
/// Load flow agreement, p.u. and rad.
const LF_TOL: (f64, f64) = (5e-6, 2e-5);
/// How long after an event the engine's own stepping is compared, s, and how much more it may differ: ANDES's
/// first-order step at an event excites the machines' swings, which decay over seconds on the WECC system.
const SETTLE: f64 = 0.3;
const CONSISTENT_FACTOR: f64 = 3.0;

fn model_of(case: &Value) -> ps_model::Model {
    let read = |key: &str| {
        let path = repo(&format!(".cache/reference/{}", case[key].as_str().unwrap()));
        std::fs::read(&path)
            .unwrap_or_else(|e| panic!("{}: {e}. Run node scripts/fetch-reference.mjs first.", path.display()))
    };
    let mut model = ps_io::psse_model::import(&ps_io::psse::decode(&read("raw")), "case.raw")
        .unwrap()
        .model;
    let applied = ps_io::dyr::apply(&mut model, &ps_io::psse::decode(&read("dyr")));
    for c in &applied.classes {
        assert!(
            c.status == "mapped",
            "{}: {} {} ({})",
            case["name"],
            c.class,
            c.status,
            c.detail
        );
    }
    // Another control for a machine, for models no published DYR case uses.
    for r in case["replace"].as_array().into_iter().flatten() {
        let kind = ps_model::ControllerKind::from_name(r["model"].as_str().unwrap()).unwrap();
        let values: Vec<f64> = r["values"].as_array().unwrap().iter().map(f).collect();
        assert_eq!(values.len(), kind.params().len(), "{}", kind.name());
        // A replacement that names its parameters names them in the engine's order.
        if let Some(names) = r["params"].as_array() {
            let names: Vec<&str> = names.iter().map(|n| n.as_str().unwrap()).collect();
            assert_eq!(names, kind.params(), "{}", kind.name());
        }
        let g = model
            .generators
            .iter_mut()
            .find(|g| g.id == r["generator"].as_str().unwrap())
            .unwrap();
        *g.dynamics.controls.slot_mut(kind.slot()) = Some(ps_model::Controller { kind, values });
    }
    for o in case["overrides"].as_array().into_iter().flatten() {
        for g in &mut model.generators {
            for slot in [
                ps_model::Slot::Exciter,
                ps_model::Slot::Governor,
                ps_model::Slot::Stabiliser,
            ] {
                if let Some(c) = g.dynamics.controls.slot_mut(slot)
                    && c.kind.name() == o["model"].as_str().unwrap()
                {
                    let k = c
                        .kind
                        .params()
                        .iter()
                        .position(|p| *p == o["param"].as_str().unwrap())
                        .unwrap();
                    c.values[k] = f(&o["value"]);
                }
            }
        }
    }
    model
}

fn events_of(case: &Value, model: &ps_model::Model) -> Vec<SimEvent> {
    case["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| {
            let target = e["target"].as_str().unwrap().to_string();
            let kind = match e["kind"].as_str().unwrap() {
                "fault" => EventKind::Fault,
                "clear" => EventKind::Clear,
                "trip" => EventKind::Trip,
                "close" => EventKind::Close,
                k => panic!("event {k}"),
            };
            // ANDES states the fault impedance in p.u. on the system base; the engine takes ohms.
            let ohms = |pu: f64| {
                let kv = model.nodes.iter().find(|n| n.id == target).unwrap().nominal_kv;
                pu * kv * kv / model.meta.base_mva
            };
            SimEvent {
                t: f(&e["t"]),
                kind,
                target: target.clone(),
                value: None,
                r: (kind == EventKind::Fault).then(|| ohms(f(&e["rf"]))),
                x: (kind == EventKind::Fault).then(|| ohms(f(&e["xf"]))),
            }
        })
        .collect()
}

/// Linear interpolation of a trace at `t`, on the side of any repeated time (an event) after it.
fn at(ts: &[f64], ys: &[f64], t: f64) -> f64 {
    let k = ts.partition_point(|&x| x <= t).clamp(1, ts.len() - 1);
    let (t0, t1) = (ts[k - 1], ts[k]);
    if t1 <= t0 {
        return ys[k];
    }
    ys[k - 1] + (ys[k] - ys[k - 1]) * (t - t0) / (t1 - t0)
}

type Worst = Vec<(&'static str, f64, String)>;
/// A way across events, the samples it is compared at, and its tolerance factor.
type Run<'a> = (rms::EventSteps, &'a dyn Fn(f64) -> bool, f64);

/// The worst difference per quantity, and where it occurred, over the samples `keep` admits; and the compared values
/// as CSV.
fn compare(golden: &Value, traj: &rms::Trajectory, keep: &dyn Fn(f64) -> bool) -> (Worst, String) {
    let gt: Vec<f64> = golden["traces"]["t"].as_array().unwrap().iter().map(f).collect();
    let mut worst: Worst = TOL.iter().map(|(q, _)| (*q, 0.0, String::new())).collect();
    let mut dump = String::from("quantity,element,t,engine,andes\n");
    let mut note = |q: &str, el: &str, k: usize, got: f64, want: f64| {
        dump.push_str(&format!("{q},{el},{},{got},{want}\n", gt[k]));
        let w = worst.iter_mut().find(|w| w.0 == q).unwrap();
        let d = (got - want).abs();
        if d > w.1 || d.is_nan() {
            *w = (w.0, d, format!("{el} at {:.3} s", gt[k]));
        }
    };
    for (gid, series) in golden["traces"]["generators"].as_object().unwrap() {
        let u = traj
            .unit_ids
            .iter()
            .position(|i| i == gid)
            .unwrap_or_else(|| panic!("no unit {gid}"));
        let ours = &traj.units[u];
        for (q, ys) in [
            ("delta", &ours.delta),
            ("omega", &ours.omega),
            ("Pe", &ours.pe),
            ("Qe", &ours.qe),
            ("vf", &ours.vf),
            ("tm", &ours.tm),
        ] {
            for (k, want) in series[q].as_array().unwrap().iter().map(f).enumerate() {
                if keep(gt[k]) {
                    note(q, gid, k, at(&traj.t, ys, gt[k]), want);
                }
            }
        }
    }
    for (bid, series) in golden["traces"]["buses"].as_object().unwrap() {
        let b = traj
            .bus_ids
            .iter()
            .position(|i| i == bid)
            .unwrap_or_else(|| panic!("no bus {bid}"));
        for (k, want) in series.as_array().unwrap().iter().map(f).enumerate() {
            if keep(gt[k]) {
                note("v", bid, k, at(&traj.t, &traj.voltages[b], gt[k]), want);
            }
        }
    }
    (worst, dump)
}

#[test]
fn trajectories_agree_with_andes_on_its_published_cases() {
    let cases = json("tests/oracle/dyn-cases.json");
    let report = std::env::var("PS_DYN_REPORT").is_ok();
    let mut failures = Vec::new();
    for case in cases["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let golden = golden(&format!("dyn-{name}"));
        let model = model_of(case);
        // ANDES solves its load flow to 1e-12; so does this one, or the machines start from other powers.
        let mut study = StudyCase::default();
        study.loadflow.tolerance = 1e-10;

        // The load flow against ANDES's (angles against the first bus, as the references may differ).
        let lf = loadflow::run(
            &model,
            &LoadFlowRun {
                settings: study.loadflow,
                ..Default::default()
            },
        );
        let gpf = golden["powerflow"].as_object().unwrap();
        let first = lf.buses.iter().find(|b| gpf.contains_key(&b.id)).unwrap();
        let (a0, ga0) = (first.va.to_radians(), f(&gpf[&first.id]["a"]));
        let (mut wv, mut wa) = (0.0_f64, 0.0_f64);
        for b in &lf.buses {
            if let Some(g) = gpf.get(&b.id) {
                wv = wv.max((b.vm - f(&g["v"])).abs());
                wa = wa.max(((b.va.to_radians() - a0) - (f(&g["a"]) - ga0)).abs());
            }
        }
        if report {
            eprintln!("LOADFLOW {name}: |V| {wv:.2e}, angle {wa:.2e} rad");
        }
        if wv > LF_TOL.0 || wa > LF_TOL.1 {
            failures.push(format!(
                "{name}: the load flow differs by {wv:.2e} p.u. and {wa:.2e} rad"
            ));
        }

        let share = |kind: &str, k: usize| case["loads"][kind][k].as_f64().unwrap_or(0.0);
        let settings = RmsSettings {
            load_p_power: share("p", 0),
            load_p_current: share("p", 1),
            load_q_power: share("q", 0),
            load_q_current: share("q", 1),
            t_end: f(&case["tf"]),
            dt: std::env::var("PS_DYN_STEP")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(f(&case["step"])),
            events: events_of(case, &model),
            ..Default::default()
        };
        let events: Vec<f64> = settings.events.iter().map(|e| e.t).collect();
        let dt = settings.dt;
        let away = |t: f64| !events.iter().any(|&te| (t - te).abs() < 2.0 * dt + 1e-9);
        let settled = |t: f64| !events.iter().any(|&te| t > te - 2.0 * dt - 1e-9 && t < te + SETTLE);
        let runs: [Run; 2] = [
            (rms::EventSteps::Andes, &away, 1.0),
            (rms::EventSteps::Consistent, &settled, CONSISTENT_FACTOR),
        ];
        for (mode, keep, factor) in runs {
            let options = rms::Options { event_steps: mode };
            let (rep, traj) = match rms::run_detailed(&model, &study, &settings, usize::MAX, options, &mut Silent) {
                Ok(r) => r,
                Err(e) => {
                    failures.push(format!("{name} ({mode:?}): {e}"));
                    continue;
                }
            };
            let (worst, dump) = compare(&golden, &traj, keep);
            if let Ok(dir) = std::env::var("PS_DYN_DUMP") {
                std::fs::write(std::path::Path::new(&dir).join(format!("{name}-{mode:?}.csv")), &dump).unwrap();
            }
            if report {
                eprintln!("SUMMARY {name} ({mode:?}): {} steps; {}", rep.steps, rep.message);
                for (q, d, wh) in &worst {
                    eprintln!("  {q:6} {d:.2e} ({wh})");
                }
                for n in &rep.notes {
                    eprintln!("  note: {n}");
                }
            }
            for ((q, d, wh), (_, tol)) in worst.iter().zip(TOL) {
                let tol = tol * factor;
                if d.is_nan() || *d > tol {
                    failures.push(format!(
                        "{name} ({mode:?}): {q} differs by {d:.2e} at {wh} (tolerance {tol:.0e})"
                    ));
                }
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// Without events every published case stays where it starts: each model's initial state is its equilibrium, at the
/// operating point of the load flow.
#[test]
fn published_cases_rest_in_equilibrium_without_events() {
    let cases = json("tests/oracle/dyn-cases.json");
    let mut seen = std::collections::HashSet::new();
    for case in cases["cases"].as_array().unwrap() {
        let key = (case["raw"].as_str().unwrap(), case["dyr"].as_str().unwrap());
        if !seen.insert(key) {
            continue;
        }
        let model = model_of(case);
        let mut study = StudyCase::default();
        study.loadflow.tolerance = 1e-10;
        let settings = RmsSettings {
            t_end: 5.0,
            dt: 0.005,
            ..Default::default()
        };
        let (_, traj) = rms::run_detailed(
            &model,
            &study,
            &settings,
            usize::MAX,
            rms::Options::default(),
            &mut Silent,
        )
        .unwrap();
        let drift = |ys: &[f64]| ys.iter().map(|y| (y - ys[0]).abs()).fold(0.0, f64::max);
        for (u, tr) in traj.units.iter().enumerate() {
            for (q, ys) in [
                ("delta", &tr.delta),
                ("omega", &tr.omega),
                ("vf", &tr.vf),
                ("tm", &tr.tm),
                ("Pe", &tr.pe),
            ] {
                assert!(
                    drift(ys) < 1e-7,
                    "{}: {} {q} moves by {:.2e}",
                    case["name"],
                    traj.unit_ids[u],
                    drift(ys)
                );
            }
        }
        for (b, ys) in traj.voltages.iter().enumerate() {
            assert!(
                drift(ys) < 1e-8,
                "{}: {} moves by {:.2e}",
                case["name"],
                traj.bus_ids[b],
                drift(ys)
            );
        }
    }
}

/// Constant power loads near a fault turn into constant impedances below the study case's voltage, so a bolted fault
/// at a loaded busbar stays solvable; with the threshold at zero the loads keep drawing their power until the
/// iteration gives up. ANDES converts nothing during a simulation, so this is checked here rather than against it.
#[test]
fn constant_power_loads_turn_into_impedances_near_a_fault() {
    let cases = json("tests/oracle/dyn-cases.json");
    let case = cases["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "ieee14")
        .unwrap();
    let model = model_of(case);
    let fault = |t: f64, kind: EventKind| SimEvent {
        t,
        kind,
        target: "B9".into(),
        value: None,
        r: None,
        x: None,
    };
    let settings = RmsSettings {
        t_end: 2.0,
        load_p_power: 100.0,
        load_q_power: 100.0,
        events: vec![fault(1.0, EventKind::Fault), fault(1.1, EventKind::Clear)],
        ..Default::default()
    };
    let study = StudyCase::default();
    let (rep, traj) = rms::run_detailed(
        &model,
        &study,
        &settings,
        usize::MAX,
        rms::Options::default(),
        &mut Silent,
    )
    .unwrap_or_else(|e| panic!("{e}"));
    assert!(rep.stable, "{}", rep.message);
    let b9 = traj.bus_ids.iter().position(|b| b == "B9").unwrap();
    let during = traj.t.iter().position(|&t| t > 1.05).unwrap();
    assert!(traj.voltages[b9][during] < 1e-3, "the bolted fault holds B9 near zero");
    let without = RmsSettings {
        load_v_low: 0.0,
        ..settings.clone()
    };
    assert!(
        rms::run_detailed(
            &model,
            &study,
            &without,
            usize::MAX,
            rms::Options::default(),
            &mut Silent
        )
        .is_err()
    );
}
