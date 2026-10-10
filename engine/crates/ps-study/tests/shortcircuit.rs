//! Short circuit against pandapower 3.5.6 on the 0.1 sample documents, and the hand calculations of the 0.1 tests.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use common::*;
use ps_model::study::{FaultType, KappaMethod, LvTolerance, ScMode, ShortCircuitSettings};
use ps_model::{ExternalGrid, Model, Node, NodeRef};
use ps_study::shortcircuit::{self, kappa_of};

fn settings(fault: FaultType, mode: ScMode, kappa: KappaMethod, location: &str) -> ShortCircuitSettings {
    ShortCircuitSettings {
        fault,
        mode,
        kappa,
        lv_tolerance: LvTolerance::Ten,
        location: location.into(),
        // The oracle (scripts/oracle/oracle.py) runs pandapower with tk_s = 1 and lines at 20 °C.
        t_min: 0.1,
        t_k: 1.0,
        line_temperature: 20.0,
        fault_r: 0.0,
        fault_x: 0.0,
    }
}

#[test]
fn every_fault_type_and_mode_matches_pandapower() {
    for name in ["ieee14", "riverside"] {
        let imp = input(name);
        for (fault, key) in [
            (FaultType::ThreePhase, "3ph"),
            (FaultType::LineToLine, "2ph"),
            (FaultType::LineToEarth, "1ph"),
        ] {
            // Maximum and minimum currents, and maximum currents through the oracle's fault impedance.
            for (mode, mkey) in [(ScMode::Max, "max"), (ScMode::Min, "min"), (ScMode::Max, "max-zf")] {
                let mut st = settings(fault, mode, KappaMethod::C, "");
                if mkey.ends_with("zf") {
                    st.fault_r = f(&golden(name)["faultImpedance"]["r"]);
                    st.fault_x = f(&golden(name)["faultImpedance"]["x"]);
                }
                let r = shortcircuit::run(&imp.model, &st);
                let reference = &golden(name)["shortcircuit"][format!("{key}-{mkey}")];
                assert_eq!(
                    r.buses.len(),
                    reference.as_object().unwrap().len(),
                    "{name} {key}-{mkey}"
                );
                for b in &r.buses {
                    for (k, got) in [("ikss", b.ikss), ("ip", b.ip), ("ith", b.ith)] {
                        let want = &reference[&b.id][k];
                        if want.is_null() {
                            // pandapower reports no ip or Ith for earth faults, and no current where there is no
                            // zero-sequence path.
                            assert!(
                                k != "ikss" || b.ikss < 1e-6,
                                "{name} {key}-{mkey} {}: pandapower finds no fault current",
                                b.id
                            );
                            continue;
                        }
                        let want = f(want);
                        assert!(
                            (got - want).abs() <= 1e-9 * want.abs() + 1e-7,
                            "{name} {key}-{mkey} {} {k}: {got} vs {want}",
                            b.id
                        );
                    }
                }
            }
        }
    }
}

#[test]
fn a_single_infeed_reproduces_the_hand_calculation() {
    let mut m = Model::new("one");
    m.nodes.push(Node {
        id: "B1".into(),
        nominal_kv: 20.0,
        ..Default::default()
    });
    m.external_grids.push(ExternalGrid {
        id: "X1".into(),
        node: NodeRef(0),
        in_service: true,
        v_set: 1.0,
        sk_max: 500.0,
        sk_min: 400.0,
        rx_max: 0.1,
        rx_min: 0.1,
        x0x1: 1.0,
        r0x0: 0.1,
        ..Default::default()
    });
    let r = shortcircuit::run(&m, &settings(FaultType::ThreePhase, ScMode::Max, KappaMethod::C, ""));
    // ZQ = c·Un²/Sk″, so Ik″ = Sk″/(√3·Un) whatever c is.
    assert!((r.buses[0].ikss - 500.0 / (3.0_f64.sqrt() * 20.0)).abs() < 1e-12);
    assert!(
        (r.buses[0].kappa - kappa_of(0.1)).abs() < 1e-12,
        "method C on a single source equals κ(R/X)"
    );
}

#[test]
fn branch_contributions_add_up_to_the_fault_current() {
    let imp = input("riverside");
    let r = shortcircuit::run(
        &imp.model,
        &settings(FaultType::ThreePhase, ScMode::Max, KappaMethod::C, "B3"),
    );
    assert_eq!(r.buses.len(), 1);
    // Mill Lane has no machine of its own, so the two cables bring the whole fault current.
    let sum: f64 = r
        .contributions
        .iter()
        .filter(|c| c.id == "L1" || c.id == "L2")
        .map(|c| if c.id == "L1" { c.i_to } else { c.i_from })
        .sum();
    let ik = r.buses[0].ikss;
    assert!(sum >= ik * (1.0 - 1e-9) && sum < ik * 1.02, "{sum} vs {ik}");
}

#[test]
fn method_b_applies_the_safety_factor_and_caps_kappa() {
    let imp = input("riverside");
    let r = shortcircuit::run(
        &imp.model,
        &settings(FaultType::ThreePhase, ScMode::Max, KappaMethod::B, "B2"),
    );
    let b = &r.buses[0];
    assert!((b.kappa - (1.15 * kappa_of(b.rx)).min(2.0)).abs() < 1e-12);
}
