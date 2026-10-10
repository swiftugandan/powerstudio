//! Classical stability against closed-form results: the equal-area criterion and the linearised swing frequency.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use common::*;
use ps_model::study::{EventKind, LoadFlowSettings, RmsSettings, SimEvent, StudyCase};
use ps_model::{ExternalGrid, Generator, Line, MachineControl, MachineDynamics, Model, Node, NodeRef};
use ps_study::{LoadFlowRun, Silent, loadflow, rms};

/// One machine against an infinite bus over a lossless line, the textbook equal-area case.
fn smib(pm: f64) -> Model {
    let mut m = Model::new("SMIB");
    m.nodes = vec![
        Node {
            id: "G".into(),
            nominal_kv: 110.0,
            ..Default::default()
        },
        Node {
            id: "I".into(),
            nominal_kv: 110.0,
            ..Default::default()
        },
    ];
    m.lines.push(Line {
        id: "L".into(),
        node1: NodeRef(0),
        node2: NodeRef(1),
        in_service: true,
        x: 0.4 * 50.0,
        ..Default::default()
    });
    m.generators.push(Generator {
        id: "M".into(),
        node: NodeRef(0),
        in_service: true,
        control: MachineControl::Pv,
        p: pm,
        v_set: 1.0,
        q_min: -1e3,
        q_max: 1e3,
        rated_mva: 100.0,
        rated_kv: 110.0,
        dynamics: MachineDynamics::classical(0.3, 4.0, 0.0),
        ..Default::default()
    });
    m.external_grids.push(ExternalGrid {
        id: "X".into(),
        node: NodeRef(1),
        in_service: true,
        v_set: 1.0,
        sk_max: 1e12,
        rx_max: 0.0,
        ..Default::default()
    });
    m
}

fn study() -> StudyCase {
    StudyCase {
        loadflow: LoadFlowSettings {
            tolerance: 1e-8,
            ..Default::default()
        },
        ..Default::default()
    }
}

/// Internal voltage, initial angle and the line-plus-machine reactance of the SMIB case.
fn operating_point(m: &Model) -> (f64, f64, f64, f64) {
    let lf = loadflow::run(
        m,
        &LoadFlowRun {
            settings: study().loadflow,
            ..Default::default()
        },
    );
    let g = &lf.gens[0];
    let (pm, q) = (g.p / 100.0, g.q / 100.0);
    let (v, th) = (lf.buses[0].vm, lf.buses[0].va.to_radians());
    // E′ = V + j·x′d·conj(S/V)
    let ir = (pm * th.cos() + q * th.sin()) / v;
    let ii = (pm * th.sin() - q * th.cos()) / v;
    let (er, ei) = (v * th.cos() - 0.3 * ii, v * th.sin() + 0.3 * ir);
    (er.hypot(ei), ei.atan2(er), 0.3 + 0.4 * 50.0 / 121.0, pm)
}

fn fault_at_g(clear: f64) -> Vec<SimEvent> {
    vec![
        SimEvent {
            t: 0.0,
            kind: EventKind::Fault,
            target: "G".into(),
            value: None,
            r: None,
            x: None,
        },
        SimEvent {
            t: clear,
            kind: EventKind::Clear,
            target: "G".into(),
            value: None,
            r: None,
            x: None,
        },
    ]
}

#[test]
fn the_equal_area_critical_clearing_time_separates_stable_from_unstable() {
    let m = smib(80.0);
    let (e, d0, x, pm) = operating_point(&m);
    assert!(
        ((e / x) * d0.sin() - pm).abs() < 1e-9,
        "the operating point lies on the power-angle curve"
    );
    let dcr = ((std::f64::consts::PI - 2.0 * d0) * d0.sin() - d0.cos()).acos();
    let tcr = (4.0 * 4.0 * (dcr - d0) / (2.0 * std::f64::consts::PI * 50.0 * pm)).sqrt();
    assert!(tcr > 0.1 && tcr < 0.5, "tcr {tcr}");
    let run = |clear: f64| {
        rms::run(
            &m,
            &study(),
            &RmsSettings {
                t_end: 2.0,
                dt: 0.0005,
                events: fault_at_g(clear),
                ..Default::default()
            },
            4000,
            &mut Silent,
        )
        .unwrap()
    };
    assert!(
        run(tcr * 0.98).stable,
        "clearing 2 % before the critical time stays in step"
    );
    assert!(!run(tcr * 1.02).stable, "clearing 2 % after it loses synchronism");
}

#[test]
fn undisturbed_operation_stays_at_its_load_flow_equilibrium() {
    let imp = input("ieee14");
    let r = rms::run(
        &imp.model,
        &imp.study,
        &RmsSettings {
            t_end: 1.0,
            dt: 0.002,
            events: Vec::new(),
            ..Default::default()
        },
        4000,
        &mut Silent,
    )
    .unwrap();
    for m in &r.machines {
        let (lo, hi) = m.delta.iter().fold((f32::INFINITY, f32::NEG_INFINITY), |(lo, hi), &d| {
            (lo.min(d), hi.max(d))
        });
        assert!(hi - lo < 1e-4, "{} drifts {}°", m.id, hi - lo);
    }
}

#[test]
fn small_oscillations_follow_the_linearised_swing_frequency() {
    let m = smib(50.0);
    let r = rms::run(
        &m,
        &study(),
        &RmsSettings {
            t_end: 3.0,
            dt: 0.001,
            events: fault_at_g(0.01),
            ..Default::default()
        },
        4000,
        &mut Silent,
    )
    .unwrap();
    let d = &r.machines.iter().find(|x| x.id == "M").unwrap().delta;
    let peaks: Vec<f32> = (1..d.len() - 1)
        .filter(|&i| d[i] > d[i - 1] && d[i] >= d[i + 1] && r.t[i] > 0.05)
        .map(|i| r.t[i])
        .collect();
    let measured = (peaks.len() - 1) as f64 / f64::from(peaks[peaks.len() - 1] - peaks[0]);
    let (e, _, x, pm) = operating_point(&m);
    let d0 = (pm * x / e).asin();
    let ks = e / x * d0.cos(); // synchronising power coefficient
    let expected = (2.0 * std::f64::consts::PI * 50.0 * ks / (2.0 * 4.0)).sqrt() / (2.0 * std::f64::consts::PI);
    assert!(
        (measured - expected).abs() / expected < 0.01,
        "{measured} Hz vs {expected} Hz"
    );
}

#[test]
fn the_bundled_ieee14_disturbance_applies_in_order_and_stays_stable() {
    let imp = input("ieee14");
    let r = rms::run(
        &imp.model,
        &imp.study,
        &imp.study.rms,
        rms::DEFAULT_SAMPLES,
        &mut Silent,
    )
    .unwrap();
    assert_eq!(
        r.events.iter().map(|e| e.applied).collect::<Vec<_>>(),
        [true, true, true]
    );
    assert!(r.stable);
    assert_eq!(r.angle_reference, "coi");
    assert!(r.t.len() > 100 && r.t[r.t.len() - 1] == 3.0);
}
