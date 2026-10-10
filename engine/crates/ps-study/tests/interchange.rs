//! Area interchange control against its own definition (the RAW area record: ISW is the area slack bus, PDES the
//! desired net export, PTOL the tolerance; docs/research/sources.md). No reference tool is used: PowSyBl reads PDES
//! into a target it defines as an import, and its OpenLoadFlow distributes an area's change over every machine in it.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use common::*;
use ps_model::study::LoadFlowSettings;
use ps_study::loadflow::LoadFlowReport;
use ps_study::{LoadFlowRun, loadflow};

fn solve(model: &ps_model::Model, area_interchange: bool) -> LoadFlowReport {
    loadflow::run(
        model,
        &LoadFlowRun {
            settings: LoadFlowSettings {
                tolerance: 1e-6,
                max_iter: 50,
                area_interchange,
                ..LoadFlowSettings::plain()
            },
            outages: Default::default(),
            start: None,
        },
    )
}

/// Every controlled area except the one whose slack is the system reference exports its target within its tolerance,
/// or its slack machines sit at their limits and the report says how far short it is (the two-area case asks area 2
/// to export 400 MW, beyond its slack machine's 900 MW); only machines at area slack buses (and the reference) change
/// their output; and the areas' exports add up to the losses of the branches between them.
#[test]
fn areas_hold_their_net_export_with_their_slack_machines() {
    let cases = json("tests/oracle/psse-cases.json");
    let mut checked = 0;
    for name in ["ieee300", "two-area-33"] {
        let case = cases["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["name"] == name)
            .unwrap();
        let model = psse_import(case).model;
        let (free, held) = (solve(&model, false), solve(&model, true));
        assert!(free.converged && held.converged, "{name}: {}", held.message);
        let reference: Vec<&str> = model
            .generators
            .iter()
            .filter(|g| g.control == ps_model::MachineControl::Reference)
            .map(|g| g.id.as_str())
            .collect();
        let slack_nodes: Vec<_> = model.areas.iter().filter_map(|a| a.slack).collect();
        for a in &held.areas {
            eprintln!(
                "{name} {}: export {:.2} MW (target {}, tolerance {}; {:.2} MW without control)",
                a.id,
                a.export,
                a.target,
                a.tolerance,
                free.areas.iter().find(|x| x.id == a.id).unwrap().export
            );
            let area = model.areas.iter().find(|x| x.id == a.id).unwrap();
            let slack_is_reference = model
                .generators
                .iter()
                .any(|g| Some(g.node) == area.slack && reference.contains(&g.id.as_str()));
            if a.controlled && !slack_is_reference {
                checked += 1;
                if (a.export - a.target).abs() <= a.tolerance + 1e-6 {
                    continue;
                }
                // Short of the target only where its slack machines are at a limit, and the report says so.
                let at_limit = model
                    .generators
                    .iter()
                    .zip(&held.gens)
                    .filter(|(g, _)| Some(g.node) == area.slack)
                    .all(|(g, r)| (r.p - g.p_max).abs() < 1e-6 || (r.p - g.p_min).abs() < 1e-6);
                assert!(
                    at_limit,
                    "{name} {}: {} MW with its slack machines inside their limits",
                    a.id, a.export
                );
                assert!(
                    held.warnings
                        .iter()
                        .any(|w| w.starts_with(&format!("Area {}:", area.name))),
                    "{name} {}: {:?}",
                    a.id,
                    held.warnings
                );
            }
        }
        for (g, (x, y)) in model.generators.iter().zip(free.gens.iter().zip(&held.gens)) {
            if (x.p - y.p).abs() > 1e-6 {
                assert!(
                    slack_nodes.contains(&g.node) || reference.contains(&g.id.as_str()),
                    "{name}: {} moved from {} to {} MW",
                    g.id,
                    x.p,
                    y.p
                );
            }
        }
        let tie_losses: f64 = held
            .branches
            .iter()
            .filter(|b| {
                let ends = model
                    .index()
                    .get(ps_model::Class::Line, &b.id)
                    .map(|r| [model.lines[r].node1, model.lines[r].node2])
                    .or_else(|| {
                        model
                            .index()
                            .get(ps_model::Class::Transformer2, &b.id)
                            .map(|r| [model.transformers2[r].node1, model.transformers2[r].node2])
                    });
                ends.is_some_and(|[f, t]| model.nodes[f.0 as usize].area != model.nodes[t.0 as usize].area)
            })
            .map(|b| b.p_from + b.p_to)
            .sum();
        let total: f64 = held.areas.iter().map(|a| a.export).sum();
        assert!(
            (total - tie_losses).abs() < 1e-3,
            "{name}: exports add to {total} MW, tie losses {tie_losses} MW"
        );
    }
    assert!(checked >= 3, "areas checked: {checked}");
}

/// The editor's document keeps interchange control: each area becomes a zone, and its target, tolerance and slack
/// busbar go into the study case, so the document holds the same exports as the model.
#[test]
fn the_editor_document_holds_the_same_interchange() {
    let cases = json("tests/oracle/psse-cases.json");
    let case = cases["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "ieee300")
        .unwrap();
    let model = psse_import(case).model;
    let converted = ps_io::powerstudio_write::to_document(&model);
    let areas = converted.doc["study"]["loadflow"]["areas"].as_array().unwrap();
    assert_eq!(areas.len(), 3, "{areas:?}");
    let back = ps_io::powerstudio::parse(&converted.doc.to_string()).unwrap().model;
    let (a, b) = (solve(&model, true), solve(&back, true));
    for (x, y) in a.areas.iter().zip(&b.areas) {
        assert!(
            (x.export - y.export).abs() < 1e-6,
            "{} {} vs {} {}",
            x.id,
            x.export,
            y.id,
            y.export
        );
        assert_eq!(
            (x.target, x.tolerance, x.controlled),
            (y.target, y.tolerance, y.controlled)
        );
    }
}
