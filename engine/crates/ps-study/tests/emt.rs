//! Electromagnetic transients: against ngspice on the cases of `tests/oracle/emt-cases.json`, against closed-form
//! solutions, and against the load flow for the undisturbed state.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use common::*;
use ps_emt::circuit::{Circuit, GROUND, Line, LineMode, Rl, Switch};
use ps_emt::dense::Mat;
use ps_emt::transient::Transient;
use ps_num::C64;
use ps_study::Silent;
use ps_study::api::{self, Loaded, Session};
use serde_json::{Value, json};

/// Runs an EMT request on a document from `tests/oracle/`.
fn emt(input: &str, options: Value) -> Value {
    let imp = ps_io::powerstudio::parse(&read(&format!("tests/oracle/{input}"))).unwrap();
    let doc = Loaded {
        model: imp.model,
        study: imp.study,
    };
    api::handle("emt", &options, Some(&doc), &mut Session::default(), &mut Silent).unwrap()
}

fn series(v: &Value) -> Vec<f64> {
    v.as_array().unwrap().iter().map(f).collect()
}

/// The largest difference between an engine trace and a golden one at the golden's samples (`at`: the engine sample
/// of each), as a share of `scale`.
fn worst(engine: &Value, golden: &Value, at: &[usize], scale: f64) -> f64 {
    let (e, g) = (series(engine), series(golden));
    g.iter()
        .zip(at)
        .map(|(want, &k)| (e[k] - want).abs() / scale)
        .fold(0.0, f64::max)
}

fn peak(v: &Value) -> f64 {
    v.as_array()
        .unwrap()
        .iter()
        .flat_map(series)
        .fold(0.0_f64, |m, x| m.max(x.abs()))
}

/// Tolerances against ngspice, as shares of the nominal crest voltage and of each kind of current's largest value
/// in the case. The engine steps 5 µs with the trapezoidal rule against SPICE's 0.5 µs; the differences are the
/// trapezoidal rule's at that step, largest on the cables' kilohertz ringing after a switching.
const V_TOL: f64 = 5e-3;
const I_TOL: f64 = 5e-3;

#[test]
fn agrees_with_ngspice() {
    let cases = json("tests/oracle/emt-cases.json");
    let d = &cases["defaults"];
    assert_eq!(
        f(&d["engine"]["breakerPu"]),
        ps_emt::network::R_ON,
        "the oracle's breaker resistance"
    );
    assert_eq!(
        f(&d["engine"]["strayPu"]),
        ps_emt::network::STRAY,
        "the oracle's conductance to earth"
    );
    for case in cases["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let golden = json(&format!("tests/oracle/golden/emt-{name}.json"));
        let c = &golden["case"];
        let r = emt(
            c["input"].as_str().unwrap(),
            json!({
                "tEnd": c["tEnd"], "dtUs": c["dtUs"], "lineModel": c["lineModel"], "events": c["events"],
                "instantSwitching": true, "maxSamples": 1_000_000
            }),
        );
        assert!(
            f(&golden["steadyStateVsLoadFlow"]) < 1e-4,
            "{name}: the oracle's own steady state"
        );
        // The engine's sample at each of the golden's times (the report may keep every other step).
        let te = series(&r["t"]);
        let every = te[1] - te[0];
        let at: Vec<usize> = series(&golden["t"])
            .iter()
            .map(|&t| {
                let k = (t / every).round() as usize;
                assert!((te[k] - t).abs() < every * 0.01, "{name}: no engine sample at {t} s");
                k
            })
            .collect();
        let by_id = |list: &Value, id: &str| -> Value {
            list.as_array()
                .unwrap()
                .iter()
                .find(|x| x["id"] == id || x["target"] == id)
                .cloned()
                .unwrap_or_else(|| panic!("{name}: {id} missing from the report"))
        };
        let (mut wv, mut wi, mut ws, mut wf) = (0.0_f64, 0.0_f64, 0.0_f64, 0.0_f64);
        let mut place = String::new();
        for (id, phases) in golden["buses"].as_object().unwrap() {
            let b = by_id(&r["buses"], id);
            let crest = f(&b["kv"]) / 3.0_f64.sqrt() * 2.0_f64.sqrt();
            for p in 0..3 {
                let e = worst(&b["v"][p], &phases[p], &at, crest);
                if e > wv {
                    (wv, place) = (e, format!("{id} phase {p}"));
                }
            }
        }
        let branch_scale = golden["branches"]
            .as_object()
            .unwrap()
            .values()
            .map(peak)
            .fold(0.0, f64::max);
        for (id, phases) in golden["branches"].as_object().unwrap() {
            let b = by_id(&r["branches"], id);
            for p in 0..3 {
                wi = wi.max(worst(&b["from"][p], &phases[p], &at, branch_scale));
            }
        }
        let source_scale = golden["sources"]
            .as_object()
            .unwrap()
            .values()
            .map(peak)
            .fold(0.0, f64::max);
        for (id, phases) in golden["sources"].as_object().unwrap() {
            let s = by_id(&r["sources"], id);
            for p in 0..3 {
                ws = ws.max(worst(&s["i"][p], &phases[p], &at, source_scale));
            }
        }
        for (id, phases) in golden["faults"].as_object().unwrap() {
            let fl = by_id(&r["faults"], id);
            let scale = peak(phases);
            for p in 0..3 {
                wf = wf.max(worst(&fl["i"][p], &phases[p], &at, scale));
            }
        }
        eprintln!("{name}: voltages {wv:.2e} ({place}), branch currents {wi:.2e}, sources {ws:.2e}, fault {wf:.2e}");
        assert!(wv < V_TOL, "{name}: voltages differ by {wv:.2e} of crest at {place}");
        assert!(wi < I_TOL, "{name}: branch currents differ by {wi:.2e}");
        assert!(ws < I_TOL, "{name}: source currents differ by {ws:.2e}");
        assert!(wf < I_TOL, "{name}: fault currents differ by {wf:.2e}");
    }
}

#[test]
fn undisturbed_networks_stay_at_their_load_flow() {
    for input in [
        "inputs/ieee14.json",
        "inputs/riverside.json",
        "inputs/riverside-converters.json",
    ] {
        let r = emt(
            input,
            json!({ "tEnd": 0.06, "lineModel": "pi", "events": [], "maxSamples": 10 }),
        );
        // The breaker poles' resistance (1e-5 p.u.) is all that separates the circuit from the load flow's network.
        assert!(f(&r["initialMismatch"]) < 1e-4, "{input}: {}", r["initialMismatch"]);
        let lf = emt_loadflow(input);
        for b in r["buses"].as_array().unwrap() {
            let want = lf[b["id"].as_str().unwrap()];
            for k in ["rmsMin", "rmsMax"] {
                assert!(
                    (f(&b[k]) - want).abs() < 1e-4,
                    "{input} {}: {k} {} vs {want}",
                    b["id"],
                    b[k]
                );
            }
        }
    }
}

/// Busbar voltages of a document's load flow, p.u.
fn emt_loadflow(input: &str) -> std::collections::HashMap<String, f64> {
    let imp = ps_io::powerstudio::parse(&read(&format!("tests/oracle/{input}"))).unwrap();
    let doc = Loaded {
        model: imp.model,
        study: imp.study,
    };
    let r = api::handle(
        "loadflow",
        &Value::Null,
        Some(&doc),
        &mut Session::default(),
        &mut Silent,
    )
    .unwrap();
    r["buses"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| (b["id"].as_str().unwrap().to_string(), f(&b["vm"])))
        .collect()
}

#[test]
fn travelling_lines_start_close_to_the_load_flow() {
    // A travelling-wave line is a distributed line, the load flow's a π section: they differ by the line's
    // distributed effect, a few 1e-4 p.u. on IEEE 14's longest lines.
    let r = emt(
        "inputs/ieee14.json",
        json!({ "tEnd": 0.02, "events": [], "maxSamples": 10 }),
    );
    assert!(f(&r["travelling"]) >= 1.0);
    assert!(f(&r["initialMismatch"]) < 1e-3, "{}", r["initialMismatch"]);
}

#[test]
fn breakers_open_at_current_zeros() {
    // A cable trips at 30 ms: each pole at each end stays closed until its current changes sign and then carries
    // nothing.
    let r = emt(
        "inputs/riverside.json",
        json!({ "tEnd": 0.08, "dtUs": 20, "lineModel": "pi", "maxSamples": 1_000_000,
                "events": [{ "t": 0.03, "kind": "trip", "target": "L1" }] }),
    );
    let ops: Vec<&Value> = r["operations"].as_array().unwrap().iter().collect();
    assert!(!ops.is_empty());
    let br = r["branches"]
        .as_array()
        .unwrap()
        .iter()
        .find(|b| b["id"] == "L1")
        .unwrap();
    let t = series(&r["t"]);
    let dt = f(&r["dt"]);
    let cmd = (0.03 / dt).round() as usize;
    let mut poles = 0;
    for end in ["from", "to"] {
        for p in 0..3 {
            let i = series(&br[end][p]);
            let amplitude = i[..cmd].iter().fold(0.0_f64, |m, x| m.max(x.abs()));
            // The pole opens at the first step whose current has changed sign since the command, so from the next
            // step on it carries nothing.
            let zero = (cmd + 1..i.len()).find(|&k| i[k] * i[k - 1] <= 0.0).unwrap();
            // Within a cycle: once the other end has opened, a pole carries only the cable's charging current, whose
            // zero can come later than the load current's would have.
            assert!(t[zero] - t[cmd] < 0.02, "{end} {p}: no current zero within a cycle");
            assert!(
                i[zero].abs() < amplitude * 0.1,
                "{end} {p}: {} of {amplitude} kA when it opened",
                i[zero]
            );
            assert!(
                i[zero + 1..].iter().all(|&x| x == 0.0),
                "{end} {p}: current after opening"
            );
            poles += 1;
        }
    }
    assert_eq!(poles, 6);
    assert!(r["events"][0]["applied"].as_bool().unwrap());
}

#[test]
fn a_close_cancels_a_trip_still_waiting_for_its_current_zeros() {
    // The close comes 0.1 ms after the trip, before any pole has reached its current zero: the cable stays in.
    let r = emt(
        "inputs/riverside.json",
        json!({ "tEnd": 0.06, "dtUs": 20, "lineModel": "pi", "maxSamples": 1_000_000,
                "events": [{ "t": 0.03, "kind": "trip", "target": "L1" }, { "t": 0.0301, "kind": "close", "target": "L1" }] }),
    );
    assert!(
        r["events"][1]["applied"].as_bool().unwrap(),
        "{}",
        r["events"][1]["note"]
    );
    let br = r["branches"]
        .as_array()
        .unwrap()
        .iter()
        .find(|b| b["id"] == "L1")
        .unwrap();
    for end in ["from", "to"] {
        for p in 0..3 {
            let i = series(&br[end][p]);
            let tail = &i[i.len() - 1000..];
            assert!(
                tail.iter().any(|&x| x != 0.0),
                "{end} {p}: the pole opened after the close"
            );
        }
    }
}

#[test]
fn a_run_keeps_at_most_its_samples() {
    let r = emt(
        "emt/emt-line.json",
        json!({ "tEnd": 0.06, "dtUs": 50, "maxSamples": 10 }),
    );
    let t = series(&r["t"]);
    assert!(t.len() <= 10, "{} samples", t.len());
    // Times are kept as f32.
    assert!(
        (t[t.len() - 1] - 0.06).abs() < 1e-6,
        "the last sample is the end: {t:?}"
    );
}

#[test]
fn energising_an_out_of_service_line_and_reclosing() {
    let r = emt(
        "emt/emt-line.json",
        json!({ "tEnd": 0.03, "dtUs": 5, "maxSamples": 100,
                "events": [{ "t": 0.005, "kind": "close", "target": "L2" }, { "t": 0.012, "kind": "close", "target": "L2" }] }),
    );
    assert_eq!(
        f(&r["travelling"]),
        1.0,
        "the long line is a travelling-wave line: {}",
        r["notes"]
    );
    assert!(r["events"][0]["applied"].as_bool().unwrap());
    assert!(
        !r["events"][1]["applied"].as_bool().unwrap(),
        "{}",
        r["events"][1]["note"]
    );
    // Energising a long line raises the voltage above its steady value at the receiving end.
    let b = r["buses"].as_array().unwrap().iter().find(|b| b["id"] == "B").unwrap();
    assert!(f(&b["peakPu"]) > 1.05, "{}", b["peakPu"]);
}

#[test]
fn same_inputs_same_report() {
    let options = json!({ "tEnd": 0.05, "events": [{ "t": 0.01, "kind": "fault", "target": "B5", "fault": "2phg" },
        { "t": 0.03, "kind": "clear", "target": "B5" }] });
    let a = emt("inputs/ieee14.json", options.clone());
    let b = emt("inputs/ieee14.json", options);
    assert_eq!(a, b);
}

/// A source `e` behind R and L switched onto a short circuit at `t0` from rest: the current is the steady-state
/// sinusoid less its value at the switching, decaying with L/R (the DC offset).
#[test]
fn rl_switching_matches_the_closed_form() {
    let w = 2.0 * std::f64::consts::PI * 50.0;
    let (r, l) = (0.05, 0.3 / w);
    let e = C64::from_polar(1.0, 0.4);
    let mut c = Circuit {
        omega: w,
        stray: 0.0,
        ..Default::default()
    };
    let [n1, n2] = [c.node(), c.node()];
    c.rl.push(Rl {
        ports: vec![vec![(n1, -1.0)]],
        r: Mat::diag(&[r]),
        l: Mat::diag(&[l]),
        emf: vec![e],
    });
    c.switches.push(Switch {
        a: n1,
        b: n2,
        r: 1e-9,
        closed: false,
    });
    // The far node to earth through a small resistance, so it is defined while the switch is open.
    c.switches.push(Switch {
        a: n2,
        b: GROUND,
        r: 1e-9,
        closed: true,
    });
    let dt = 10e-6;
    let mut tr = Transient::new(c, dt).unwrap();
    let steps0 = 503;
    for _ in 0..steps0 {
        tr.step().unwrap();
    }
    tr.close(0);
    let t0 = tr.time();
    let z = C64::new(r, w * l);
    let i_ss = e / z;
    let tau = l / r;
    let mut err = 0.0_f64;
    for _ in 0..4000 {
        tr.step().unwrap();
        let t = tr.time();
        let ss = |t: f64| std::f64::consts::SQRT_2 * (i_ss * C64::from_polar(1.0, w * t)).re;
        let want = ss(t) - ss(t0) * (-(t - t0) / tau).exp();
        err = err.max((tr.switch_current(0) - want).abs());
    }
    let amplitude = std::f64::consts::SQRT_2 * i_ss.abs();
    assert!(err < 2e-3 * amplitude, "{err} of {amplitude}");
}

/// A lossless line matched at its far end: the far end's voltage is the near end's delayed by the travel time.
#[test]
fn matched_lossless_line_delays_exactly() {
    let w = 2.0 * std::f64::consts::PI * 50.0;
    let (zc, tau) = (300.0, 1e-3);
    let mut c = Circuit {
        omega: w,
        stray: 0.0,
        ..Default::default()
    };
    let near = c.nodes3();
    let far = c.nodes3();
    let src = c.nodes3();
    let mode = LineMode { zc, r: 0.0, tau };
    c.lines.push(Line {
        ends: [near, far],
        modes: [mode; 3],
    });
    // A balanced source behind a small reactance, a breaker, and the matching resistance at the far end.
    c.rl.push(Rl {
        ports: (0..3).map(|k| vec![(src[k], -1.0)]).collect(),
        r: Mat::diag(&[1.0; 3]),
        l: Mat::diag(&[0.01 / w; 3]),
        emf: ps_emt::dense::balanced(C64::new(1000.0, 0.0)).to_vec(),
    });
    for k in 0..3 {
        c.switches.push(Switch {
            a: src[k],
            b: near[k],
            r: 1e-6,
            closed: false,
        });
        c.switches.push(Switch {
            a: far[k],
            b: GROUND,
            r: zc,
            closed: true,
        });
    }
    let dt = 50e-6; // the delay is exactly 20 steps
    let mut tr = Transient::new(c, dt).unwrap();
    for _ in 0..7 {
        tr.step().unwrap();
    }
    for k in 0..3 {
        tr.close(2 * k);
    }
    let mut near_v: Vec<[f64; 3]> = Vec::new();
    let mut far_v: Vec<[f64; 3]> = Vec::new();
    for _ in 0..400 {
        tr.step().unwrap();
        near_v.push(near.map(|n| tr.voltage(n)));
        far_v.push(far.map(|n| tr.voltage(n)));
    }
    let d = 20;
    let scale = near_v.iter().flatten().fold(0.0_f64, |m, x| m.max(x.abs()));
    for k in 0..d - 1 {
        assert!(
            far_v[k].iter().all(|x| x.abs() < 1e-9 * scale),
            "before the wave arrives: {:?}",
            far_v[k]
        );
    }
    for k in d..400 {
        for p in 0..3 {
            assert!(
                (far_v[k][p] - near_v[k - d][p]).abs() < 1e-9 * scale,
                "step {k} phase {p}: {} vs {}",
                far_v[k][p],
                near_v[k - d][p]
            );
        }
    }
    let _ = GROUND;
}

#[test]
fn faults_settle_at_the_phasor_solution() {
    // A fault applied for good: the simulation settles at the phasor solution of the circuit with the fault closed.
    let event = json!({ "t": 0.01, "kind": "fault", "target": "B2", "fault": "1ph", "r": 1.0 });
    let r = emt(
        "inputs/riverside.json",
        json!({ "tEnd": 0.6, "dtUs": 20, "lineModel": "pi", "maxSamples": 100, "events": [event.clone()] }),
    );
    let rms = f(&r["faults"][0]["rms"]);
    let imp = input("riverside");
    let (mut calc, sol, _) = ps_study::loadflow::solve(
        &imp.model,
        &ps_study::LoadFlowRun {
            settings: imp.study.loadflow,
            ..Default::default()
        },
    );
    calc.net = sol.net.clone();
    let settings = ps_model::study::EmtSettings {
        line_model: ps_model::study::LineModel::Pi,
        events: vec![serde_json::from_value(event).unwrap()],
        ..Default::default()
    };
    let mut net = ps_emt::network::build(&imp.model, &calc, &sol, &settings, 20e-6).unwrap();
    let fault = net.faults[0].clone();
    for &s in &fault.switches {
        net.circuit.switches[s].closed = true;
    }
    let v = net.circuit.steady_state().unwrap();
    let sw = &net.circuit.switches[fault.switches[0]];
    let i_pu = (v[sw.a] - if sw.b == GROUND { C64::ZERO } else { v[sw.b] }).scale(1.0 / sw.r);
    let kv = net.buses[fault.bus].kv;
    let want = i_pu.abs() * calc.net.base_mva / (3.0_f64.sqrt() * kv);
    assert!((rms - want).abs() < 1e-3 * want, "settled {rms} kA, phasor {want} kA");
}

#[test]
fn phase_shifts_beyond_the_vector_group_reproduce_the_load_flow() {
    // A phase shifter's angle rotates the windings' voltages: with further shifts on Riverside's YNd5 and Dyn5
    // transformers and a phase tap on a primary transformer, the initial state is still the load flow's.
    let mut doc: Value = serde_json::from_str(&read("tests/oracle/inputs/riverside.json")).unwrap();
    for e in doc["elements"].as_array_mut().unwrap() {
        match e["id"].as_str().unwrap() {
            "T3" => e["shift"] = json!(7.5),
            "T4" => e["shift"] = json!(-12.0),
            "T1" => {
                e["tapKind"] = json!("phase");
                e["phaseStep"] = json!(1.5);
                e["tapPos"] = json!(3);
            }
            _ => {}
        }
    }
    let imp = ps_io::powerstudio::parse(&doc.to_string()).unwrap();
    let loaded = Loaded {
        model: imp.model,
        study: imp.study,
    };
    let r = api::handle(
        "emt",
        &json!({ "tEnd": 0.02, "lineModel": "pi", "events": [], "maxSamples": 10 }),
        Some(&loaded),
        &mut Session::default(),
        &mut Silent,
    )
    .unwrap();
    assert!(f(&r["initialMismatch"]) < 1e-4, "{}", r["initialMismatch"]);
    for b in r["buses"].as_array().unwrap() {
        assert!(
            f(&b["rmsMax"]) - f(&b["rmsMin"]) < 1e-4,
            "{} does not stay at its state",
            b["id"]
        );
    }
}
