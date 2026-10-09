//! Network features that importers rely on: open branch ends, reference priority and tabular tap changers.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use ps_model::study::LoadFlowSettings;
use ps_model::{
    ExternalGrid, Generator, Line, Load, MachineControl, Model, Node, NodeRef, PhaseTap, RatioTap, TapPoint,
    Transformer2,
};
use ps_study::{LoadFlowRun, loadflow};

fn node(id: &str, kv: f64) -> Node {
    Node {
        id: id.into(),
        nominal_kv: kv,
        ..Default::default()
    }
}

fn grid(at: u32) -> ExternalGrid {
    ExternalGrid {
        id: "X".into(),
        node: NodeRef(at),
        in_service: true,
        v_set: 1.0,
        sk_max: 1e4,
        ..Default::default()
    }
}

fn tight() -> LoadFlowRun {
    LoadFlowRun {
        settings: LoadFlowSettings {
            tolerance: 1e-10,
            ..Default::default()
        },
        ..Default::default()
    }
}

#[test]
fn a_line_open_at_one_end_charges_from_the_other_and_its_far_end_rises() {
    // 400 kV, 300 km, lossless: the open end sits at V/cos(βl) (the Ferranti rise) with β from its total L and C.
    let (x, b) = (0.3 * 300.0, 4.0e-6 * 300.0);
    let mut m = Model::new("ferranti");
    m.nodes = vec![node("A", 400.0), node("B", 400.0)];
    m.lines.push(Line {
        id: "L".into(),
        node1: NodeRef(0),
        node2: NodeRef(1),
        in_service: true,
        open: [false, true],
        x,
        b1: b / 2.0,
        b2: b / 2.0,
        ..Default::default()
    });
    m.external_grids.push(grid(0));
    let r = loadflow::run(&m, &tight());
    assert!(r.converged, "{}", r.message);
    assert_eq!(r.deenergized, ["B"], "the node behind the open end has no supply");
    let end = r.buses.iter().find(|b| b.id == "L.end2").unwrap();
    // The π model of the whole line gives V2/V1 = 1/(1 − X·B/2) exactly.
    let expected = 1.0 / (1.0 - x * b / 2.0);
    assert!((end.vm - expected).abs() < 1e-9, "{} vs {expected}", end.vm);
    let line = &r.branches[0];
    assert!(
        line.p_to.abs() < 1e-9 && line.q_to.abs() < 1e-9,
        "no power leaves the open end"
    );
    assert!(line.q_from < 0.0, "the line delivers its charging into the grid");
}

#[test]
fn reference_priority_chooses_the_island_reference() {
    let mut m = Model::new("priority");
    m.nodes = vec![node("A", 110.0), node("B", 110.0)];
    m.lines.push(Line {
        id: "L".into(),
        node1: NodeRef(0),
        node2: NodeRef(1),
        in_service: true,
        r: 1.0,
        x: 10.0,
        ..Default::default()
    });
    let machine = |id: &str, at: u32, mva: f64, priority: u32| Generator {
        id: id.into(),
        node: NodeRef(at),
        in_service: true,
        control: MachineControl::Pv,
        p: 20.0,
        v_set: 1.0,
        q_min: -100.0,
        q_max: 100.0,
        rated_mva: mva,
        reference_priority: priority,
        ..Default::default()
    };
    m.generators = vec![machine("big", 0, 500.0, 0), machine("chosen", 1, 50.0, 1)];
    m.loads.push(Load {
        id: "D".into(),
        node: NodeRef(0),
        in_service: true,
        p: 60.0,
        q: 10.0,
        p_zip: [0.0, 0.0, 1.0],
        q_zip: [0.0, 0.0, 1.0],
        ..Default::default()
    });
    let r = loadflow::run(&m, &tight());
    assert!(r.converged);
    assert_eq!(
        r.buses.iter().find(|b| b.kind == "Ref").map(|b| b.id.as_str()),
        Some("B")
    );
    assert!(
        r.warnings.iter().all(|w| !w.contains("reference machine")),
        "a declared priority needs no warning"
    );
    let chosen = r.gens.iter().find(|g| g.id == "chosen").unwrap();
    assert!(
        (chosen.p - (60.0 - 20.0) - (r.totals.losses)).abs() < 1e-6,
        "the reference balances the island"
    );
}

#[test]
fn a_tap_table_acts_like_the_stepped_changer_it_tabulates() {
    let base = || {
        let mut m = Model::new("taps");
        m.nodes = vec![node("HV", 110.0), node("LV", 20.0)];
        m.external_grids.push(grid(0));
        m.loads.push(Load {
            id: "D".into(),
            node: NodeRef(1),
            in_service: true,
            p: 20.0,
            q: 5.0,
            p_zip: [0.0, 0.0, 1.0],
            q_zip: [0.0, 0.0, 1.0],
            ..Default::default()
        });
        m.transformers2.push(Transformer2 {
            id: "T".into(),
            node1: NodeRef(0),
            node2: NodeRef(1),
            in_service: true,
            rated_kv1: 110.0,
            rated_kv2: 20.0,
            rated_mva: 40.0,
            r: 1.2,
            x: 36.0,
            ..Default::default()
        });
        m
    };
    let stepped = {
        let mut m = base();
        m.transformers2[0].ratio_taps = vec![RatioTap {
            end: 1,
            low: -5,
            high: 5,
            neutral: 0,
            step_pct: 1.5,
            position: 3,
            ..Default::default()
        }];
        m.transformers2[0].phase_tap = Some(PhaseTap {
            end: 1,
            low: -5,
            high: 5,
            neutral: 0,
            step_deg: 2.0,
            position: -2,
            ..Default::default()
        });
        m
    };
    let tabular = {
        let mut m = base();
        let rows = |f: &dyn Fn(i32) -> TapPoint| (-5..=5).map(f).collect::<Vec<_>>();
        m.transformers2[0].ratio_taps = vec![RatioTap {
            end: 1,
            low: -5,
            high: 5,
            position: 3,
            table: rows(&|p| TapPoint {
                position: p,
                ratio: 1.0 + 0.015 * f64::from(p),
                ..Default::default()
            }),
            ..Default::default()
        }];
        m.transformers2[0].phase_tap = Some(PhaseTap {
            end: 1,
            low: -5,
            high: 5,
            position: -2,
            table: rows(&|p| TapPoint {
                position: p,
                ratio: 1.0,
                angle_deg: 2.0 * f64::from(p),
                ..Default::default()
            }),
            ..Default::default()
        });
        m
    };
    let (a, b) = (loadflow::run(&stepped, &tight()), loadflow::run(&tabular, &tight()));
    assert!(a.converged && b.converged);
    for (x, y) in a.buses.iter().zip(&b.buses) {
        assert!(
            (x.vm - y.vm).abs() < 1e-12 && (x.va - y.va).abs() < 1e-10,
            "{} differs",
            x.id
        );
    }
    // Moving the phase changer to winding 2 reverses the angle the model applies.
    let mut flipped = tabular.clone();
    if let Some(t) = flipped.transformers2[0].phase_tap.as_mut() {
        t.end = 2;
    }
    let c = loadflow::run(&flipped, &tight());
    let lv = |r: &ps_study::LoadFlowReport| r.buses.iter().find(|b| b.id == "LV").map_or(f64::NAN, |b| b.va);
    assert!(
        (lv(&c) - lv(&b)).abs() > 7.0,
        "the shift changes sign: {} vs {}",
        lv(&c),
        lv(&b)
    );
}
