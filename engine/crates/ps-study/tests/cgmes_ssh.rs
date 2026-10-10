//! CGMES SSH and SV export of an edited operating point, checked by reading it back: each configuration is imported
//! as the editor's document, operating values are changed as a user would (a load, a machine's voltage target, a
//! transformer's tap, a line switched out), and the exported SSH is read in place of the input's. The editor's document
//! made from the new files must hold the changed values, and the exported SV must be the solved state of the new
//! operating point, so a load flow started there needs no iteration. An unchanged document exports no SSH at all.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use common::*;
use serde_json::Value;

/// The input files with each exported file in place of the input file it replaces (same profile and authority).
fn swap(files: &[ps_io::files::File], exported: &[ps_io::files::File]) -> Vec<ps_io::files::File> {
    let profile =
        |f: &ps_io::files::File, what: &str| String::from_utf8_lossy(&f.data[..f.data.len().min(8192)]).contains(what);
    let authority = |f: &ps_io::files::File| {
        let head = String::from_utf8_lossy(&f.data[..f.data.len().min(8192)]).into_owned();
        head.split("modelingAuthoritySet>")
            .nth(1)
            .map(|s| s.split('<').next().unwrap_or("").to_string())
    };
    let mut out: Vec<ps_io::files::File> = Vec::new();
    for f in files {
        let replaced = exported.iter().find(|e| {
            ["SteadyStateHypothesis", "StateVariables"]
                .iter()
                .any(|p| profile(f, p) && profile(e, p))
                && (profile(e, "StateVariables") || authority(e) == authority(f))
        });
        match replaced {
            Some(e) if !out.iter().any(|o| o.name == e.name) => out.push(e.clone()),
            Some(_) => {}
            None => out.push(f.clone()),
        }
    }
    out
}

/// The first element of a class that passes a test.
fn find(els: &[Value], cls: &str, f: &dyn Fn(&Value) -> bool) -> Option<usize> {
    els.iter().position(|e| e["cls"] == cls && f(e))
}

fn element<'a>(doc: &'a Value, id: &str) -> Option<&'a Value> {
    doc["elements"].as_array().unwrap().iter().find(|e| e["id"] == id)
}

#[test]
fn an_edited_operating_point_reads_back_from_the_exported_ssh_and_sv() {
    let cases = json("tests/oracle/cgmes-cases.json");
    let mut failures = Vec::new();
    for case in cases["cases"].as_array().unwrap() {
        if case["loadflow"] == false {
            continue;
        }
        let name = case["name"].as_str().unwrap();
        let files = ps_io::files::expand(cgmes_files(case)).unwrap();
        let original = ps_study::exchange::import_for_editor(files.clone()).unwrap().doc;
        let created = "2026-10-10T12:00:00Z";
        // Nothing changed: no SSH.
        let same = ps_study::exchange::export_cgmes(files.clone(), &original, created).unwrap();
        if same.changes != 0 || same.files.len() != 1 {
            failures.push(format!(
                "{name}: an unchanged document gave {} changes and {} files",
                same.changes,
                same.files.len()
            ));
        }
        // A user's edits: a load up 10 % with 1 Mvar more, a voltage target 1 % up, a tap one step up, a line out.
        let mut doc = original.clone();
        let mut expect: Vec<(String, &str, Value)> = Vec::new();
        let els = doc["elements"].as_array_mut().unwrap();
        let real = |e: &Value| !e["id"].as_str().unwrap_or("").contains('~');
        if let Some(k) = find(els, "load", &|e| real(e) && e["p"].as_f64().unwrap_or(0.0).abs() > 0.1) {
            let e = &mut els[k];
            let (p, q) = (e["p"].as_f64().unwrap() * 1.1, e["q"].as_f64().unwrap() + 1.0);
            e["p"] = p.into();
            e["q"] = q.into();
            expect.push((e["id"].as_str().unwrap().into(), "p", p.into()));
            expect.push((e["id"].as_str().unwrap().into(), "q", q.into()));
        }
        if let Some(k) = find(els, "gen", &|e| real(e) && e["mode"] != "PQ") {
            let e = &mut els[k];
            let v = e["vset"].as_f64().unwrap() + 0.01;
            e["vset"] = v.into();
            expect.push((e["id"].as_str().unwrap().into(), "vset", v.into()));
        }
        let mut tap: Option<(String, i32)> = None;
        if let Some(k) = find(els, "trafo", &|e| {
            real(e) && e["tapMax"].as_f64().unwrap_or(0.0) >= 1.0 && e["tapControl"] != true
        }) {
            let e = &mut els[k];
            e["tapPos"] = 1.into();
            tap = Some((e["id"].as_str().unwrap().into(), 1));
        }
        let mut switched: Option<String> = None;
        if let Some(k) = find(els, "line", &|e| real(e) && e["inService"] != false) {
            let e = &mut els[k];
            e["inService"] = false.into();
            switched = Some(e["id"].as_str().unwrap().into());
        }
        let export = ps_study::exchange::export_cgmes(files.clone(), &doc, created).unwrap();
        let again = ps_study::exchange::export_cgmes(files.clone(), &doc, created).unwrap();
        if export.files.iter().zip(&again.files).any(|(a, b)| a.data != b.data) {
            failures.push(format!("{name}: two exports of the same state differ"));
        }
        if !export.converged {
            failures.push(format!(
                "{name}: the edited operating point did not converge: {:?}",
                export.notes
            ));
        }
        // Read back: the editor's document from the new files holds the changed values.
        let ssh_only: Vec<ps_io::files::File> = export
            .files
            .iter()
            .filter(|f| !f.name.contains("SV"))
            .cloned()
            .collect();
        let back = ps_study::exchange::import_for_editor(swap(&files, &ssh_only))
            .unwrap()
            .doc;
        for (id, key, want) in &expect {
            let Some(el) = element(&back, id) else {
                failures.push(format!("{name}: {id} is not in the document read back (changed {key})"));
                continue;
            };
            let got = &el[*key];
            let ok = match (got.as_f64(), want.as_f64()) {
                (Some(a), Some(b)) => (a - b).abs() <= 1e-9 * b.abs().max(1.0),
                _ => got == want,
            };
            if !ok {
                failures.push(format!("{name}: {id}.{key} reads back as {got}, not {want}"));
            }
        }
        // Equipment out of service is left out of the editor's document, so the model says it.
        if let Some(id) = &switched {
            let after = ps_io::cgmes::import(&swap(&files, &ssh_only)).unwrap().model;
            // CGMES 3 says it of the equipment; 2.4.15 by disconnecting its terminals, which opens both ends.
            if after
                .lines
                .iter()
                .find(|l| l.id == *id)
                .is_none_or(|l| l.in_service && !(l.open[0] && l.open[1]))
            {
                failures.push(format!("{name}: line {id} is still in service"));
            }
        }
        if let Some((id, step)) = &tap {
            let before = ps_io::cgmes::import(&files).unwrap().model;
            let after = ps_io::cgmes::import(&swap(&files, &ssh_only)).unwrap().model;
            let pos = |m: &ps_model::Model| {
                m.transformers2
                    .iter()
                    .find(|t| t.id == *id)
                    .and_then(ps_io::powerstudio_write::written_tap)
                    .map(|t| t.position)
            };
            if pos(&after) != pos(&before).map(|p| p + *step) {
                failures.push(format!(
                    "{name}: transformer {id} is at {:?}, not one step above {:?}",
                    pos(&after),
                    pos(&before)
                ));
            }
        }
        // For PowSyBl (scripts/oracle/ssh_check.py): the files with the exported SSH and SV, and what they should say.
        if let Ok(dir) = std::env::var("PS_SSH_DIR") {
            let folder = std::path::Path::new(&dir).join(name);
            std::fs::create_dir_all(&folder).unwrap();
            for (k, f) in swap(&files, &export.files).iter().enumerate() {
                let file = f.name.rsplit(['/', '\\']).next().unwrap_or(&f.name);
                std::fs::write(folder.join(format!("{k}-{file}")), &f.data).unwrap();
            }
            let after = ps_io::cgmes::import(&swap(&files, &ssh_only)).unwrap().model;
            let kv = |n: ps_model::NodeRef| after.nodes[n.index()].nominal_kv;
            let target =
                expect.iter().find(|e| e.1 == "vset").and_then(|(id, _, _)| {
                    after.generators.iter().find(|g| g.id == *id).map(
                        |g| serde_json::json!({ "id": id, "kv": g.v_set * kv(g.regulated_node.unwrap_or(g.node)) }),
                    )
                });
            let load = expect.iter().find(|e| e.1 == "p").map(|(id, _, p)| {
                let q = &expect.iter().find(|e| e.0 == *id && e.1 == "q").unwrap().2;
                serde_json::json!({ "id": id, "p": p, "q": q })
            });
            let tap_after = tap.as_ref().and_then(|(id, _)| {
                after
                    .transformers2
                    .iter()
                    .find(|t| t.id == *id)
                    .and_then(ps_io::powerstudio_write::written_tap)
                    .map(|t| serde_json::json!({ "id": id, "phase": t.phase, "position": t.position }))
            });
            let expected = serde_json::json!({ "load": load, "generator": target, "tap": tap_after, "line": switched });
            std::fs::write(folder.join("expected.json"), expected.to_string()).unwrap();
        }
        // The SV is the solved state of the new operating point: a load flow started from it returns to it. With
        // reactive limits it finds again which machines sit at a limit, which can take an iteration or two.
        let model = ps_io::cgmes::import(&swap(&files, &export.files)).unwrap().model;
        let start = model
            .nodes
            .iter()
            .map(|n| (n.v0 > 0.0).then(|| (n.v0, n.angle0.to_radians())))
            .collect();
        let settings = ps_io::powerstudio::from_value(&doc).unwrap().study.loadflow;
        let report = ps_study::loadflow::run(
            &model,
            &ps_study::LoadFlowRun {
                settings,
                start: Some(start),
                ..Default::default()
            },
        );
        let v0: std::collections::HashMap<&str, f64> = model.nodes.iter().map(|n| (n.id.as_str(), n.v0)).collect();
        let moved = report
            .buses
            .iter()
            .filter_map(|b| v0.get(b.id.as_str()).filter(|v| **v > 0.0).map(|v| (b.vm - v).abs()))
            .fold(0.0, f64::max);
        eprintln!(
            "SUMMARY {name}: {} changes, {} SSH edits; restart from the SV: {} iteration(s), moved {moved:.1e} p.u.; notes {:?}",
            export.changes, export.edits, report.iterations, export.notes
        );
        if !report.converged || moved > 1e-6 || (!settings.enforce_q_limits && report.iterations > 0) {
            failures.push(format!(
                "{name}: restart from the exported SV took {} iterations and moved {moved:.1e} p.u. ({})",
                report.iterations, report.message
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
