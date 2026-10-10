//! A load flow's result in the terms exchange formats need: CGMES state variables.

use std::collections::HashMap;

use ps_io::cgmes_sv::State;
use ps_model::{Model, NodeRef};
use ps_net::Calc;

use crate::LoadFlowReport;

/// The solved state of `model` for CGMES SV: every node's voltage and the power flowing into each element from each
/// of its terminals, in load sign (MW and Mvar into the equipment).
pub fn sv_state(model: &Model, calc: &Calc, sol: &ps_lf::Solution, report: &LoadFlowReport) -> State {
    let node_v = (0..model.nodes.len())
        .map(|k| {
            calc.topo
                .bus_of(NodeRef(k as u32))
                .map(|b| (sol.vm[b], sol.va[b].to_degrees()))
        })
        .collect();
    let mut flows: HashMap<String, Vec<Option<(f64, f64)>>> = HashMap::new();
    for b in &report.branches {
        let ends = flows.entry(b.id.clone()).or_default();
        match b.winding {
            // A three-winding transformer: one row per winding, its from end at the winding's bus.
            Some(w) => {
                let k = usize::from(w) - 1;
                if ends.len() <= k {
                    ends.resize(k + 1, None);
                }
                ends[k] = Some((b.p_from, b.q_from));
            }
            None => *ends = vec![Some((b.p_from, b.q_from)), Some((b.p_to, b.q_to))],
        }
    }
    // Machines, grids and compensators report their output; SV wants the power into the equipment.
    for u in report.gens.iter().chain(&report.grids).chain(&report.svcs) {
        flows.insert(u.id.clone(), vec![Some((-u.p, -u.q))]);
    }
    for u in &report.loads {
        flows.insert(u.id.clone(), vec![Some((u.p, u.q))]);
    }
    // A shunt's report gives the power it consumes (P) and the reactive power it supplies (Q).
    for u in &report.shunts {
        flows.insert(u.id.clone(), vec![Some((u.p, -u.q))]);
    }
    let node_island = (0..model.nodes.len())
        .map(|k| calc.topo.bus_of(NodeRef(k as u32)).map(|b| calc.topo.buses[b].island))
        .collect();
    // Each island's angle reference: the bus of its reference machine or external grid.
    let mut island_reference = vec![None; calc.topo.islands as usize];
    let refs = calc
        .net
        .machines
        .iter()
        .filter(|g| g.mode == ps_lf::MachineMode::Reference)
        .map(|g| g.bus)
        .chain(calc.net.grids.iter().map(|g| g.bus));
    for b in refs {
        let bus = &calc.topo.buses[b];
        if let (Some(slot), Some(&node)) = (island_reference.get_mut(bus.island as usize), bus.nodes.first()) {
            slot.get_or_insert(node as usize);
        }
    }
    // Positions the load flow's controls set.
    let taps = report
        .taps
        .iter()
        .map(|t| ((t.id.clone(), t.winding, t.kind == "ratio"), t.position))
        .collect();
    let sections = report.sections.iter().map(|x| (x.id.clone(), x.sections)).collect();
    State {
        node_v,
        flows,
        node_island,
        island_reference,
        taps,
        sections,
    }
}

/// How closely the editor's version of an imported model reproduces it.
#[derive(Debug, Clone, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Fidelity {
    /// Whether the imported model's load flow converged (nothing is compared otherwise).
    pub solved: bool,
    /// Largest voltage difference between the two load flows, p.u.
    pub max_dv: f64,
    /// Largest angle difference, degrees.
    pub max_da: f64,
    /// The node where the voltage differs most.
    pub worst: String,
    /// Whether the document's load flow converges from the editor's default start (a DC load flow).
    pub editor_converges: bool,
    /// Starting voltages for the document's busbars: the model's solution, or the voltages it was read with when it
    /// does not solve.
    pub start: Start,
}

/// Starting voltages by busbar, in the shape of the load flow request's `start` option.
#[derive(Debug, Clone, Default, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Start {
    /// Busbar identifiers.
    pub bus_ids: Vec<String>,
    /// Magnitudes, p.u.
    pub vm: Vec<f64>,
    /// Angles, degrees.
    pub va: Vec<f64>,
}

/// In-service voltage-controlling machines whose reactive power in the file sits at one of its limits (within 0.01
/// Mvar), counting only machines with a reactive range of at least 1 Mvar, as the load flow does.
pub fn machines_at_reactive_limits(model: &Model) -> usize {
    model
        .generators
        .iter()
        .filter(|g| g.in_service && g.control != ps_model::MachineControl::Pq && g.q_max - g.q_min >= 1.0)
        .filter(|g| (g.q - g.q_max).abs() < 0.01 || (g.q - g.q_min).abs() < 0.01)
        .count()
}

/// Solves `model` and the document converted from it (`ps_io::powerstudio_write`), the document started from the
/// model's solution, and compares every node's voltage through the busbar that stands for it.
pub fn editor_fidelity(model: &Model, converted: &ps_io::powerstudio_write::Converted) -> Fidelity {
    use ps_model::study::LoadFlowSettings;
    // The controls the document expresses exactly (regulated busbars, load characteristics) are on; the discrete ones
    // stay where they are, since the document's tap changers are even approximations of tabled ones.
    let settings = LoadFlowSettings {
        tolerance: 1e-8,
        max_iter: 50,
        remote_voltage: true,
        voltage_dependent_loads: true,
        ..LoadFlowSettings::plain()
    };
    // Models that carry a solution start from it; others from a DC load flow.
    let stored = model.nodes.iter().any(|n| n.v0 > 0.0);
    let start = stored.then(|| {
        model
            .nodes
            .iter()
            .map(|n| (n.v0 > 0.0).then(|| (n.v0, n.angle0.to_radians())))
            .collect()
    });
    let run = crate::LoadFlowRun {
        settings,
        start,
        ..Default::default()
    };
    let (calc, sol, report) = crate::loadflow::solve(model, &run);
    let mut out = Fidelity {
        solved: report.converged,
        max_dv: 0.0,
        max_da: 0.0,
        worst: String::new(),
        editor_converges: false,
        start: Start::default(),
    };
    let Ok(doc) = ps_io::powerstudio::from_value(&converted.doc) else {
        return out;
    };
    // Whether the editor's default start (a DC load flow) reaches a solution: a probe, capped at ten iterations, since
    // Newton converges in a handful from a good start and a diverging case would otherwise run its full limit.
    let editor = crate::loadflow::run(
        &doc.model,
        &crate::LoadFlowRun {
            settings: LoadFlowSettings {
                max_iter: 10,
                ..settings
            },
            ..Default::default()
        },
    );
    out.editor_converges = editor.converged;

    // The model's voltages by node: solved, or as read when the load flow fails.
    let solved: Vec<Option<(f64, f64)>> = (0..model.nodes.len())
        .map(|k| match (report.converged, calc.topo.bus_of(NodeRef(k as u32))) {
            (true, Some(b)) => Some((sol.vm[b], sol.va[b])),
            _ => (model.nodes[k].v0 > 0.0).then(|| (model.nodes[k].v0, model.nodes[k].angle0.to_radians())),
        })
        .collect();
    // Busbars the conversion added start at the model's star point, or behind their ideal transformer.
    let mut first_node: HashMap<&str, usize> = HashMap::new();
    for (k, b) in converted.bus_of_node.iter().enumerate() {
        if let Some(b) = b {
            first_node.entry(b.as_str()).or_insert(k);
        }
    }
    let internal: HashMap<&str, &ps_io::powerstudio_write::Internal> =
        converted.internal.iter().map(|(id, how)| (id.as_str(), how)).collect();
    fn start_of(
        id: &str,
        first_node: &HashMap<&str, usize>,
        internal: &HashMap<&str, &ps_io::powerstudio_write::Internal>,
        solved: &[Option<(f64, f64)>],
        star: &dyn Fn(usize) -> Option<(f64, f64)>,
        depth: u8,
    ) -> Option<(f64, f64)> {
        use ps_io::powerstudio_write::Internal;
        if let Some(&k) = first_node.get(id) {
            return solved[k];
        }
        match internal.get(id)? {
            Internal::Star(row) => star(*row),
            Internal::Behind { bus, ratio, shift } if depth < 4 => {
                let (vm, va) = start_of(bus, first_node, internal, solved, star, depth + 1)?;
                Some((vm / ratio, va - shift))
            }
            Internal::Behind { .. } => None,
        }
    }
    let star = |row: usize| -> Option<(f64, f64)> {
        let b = calc.topo.star_bus.get(row).copied().flatten()? as usize;
        report.converged.then(|| (sol.vm[b], sol.va[b]))
    };
    let start: Vec<Option<(f64, f64)>> = doc
        .model
        .nodes
        .iter()
        .map(|n| start_of(&n.id, &first_node, &internal, &solved, &star, 0))
        .collect();
    for (n, v) in doc.model.nodes.iter().zip(&start) {
        if let Some((vm, va)) = v {
            out.start.bus_ids.push(n.id.clone());
            out.start.vm.push(*vm);
            out.start.va.push(va.to_degrees());
        }
    }
    if !report.converged {
        return out;
    }
    let (calc2, sol2, again) = crate::loadflow::solve(
        &doc.model,
        &crate::LoadFlowRun {
            settings,
            start: Some(start),
            ..Default::default()
        },
    );
    if !again.converged {
        out.max_dv = f64::INFINITY;
        return out;
    }
    let index: HashMap<&str, usize> = doc
        .model
        .nodes
        .iter()
        .enumerate()
        .map(|(k, n)| (n.id.as_str(), k))
        .collect();
    for (k, v) in solved.iter().enumerate() {
        let (Some((vm, va)), Some(bus)) = (v, converted.bus_of_node[k].as_deref()) else {
            continue;
        };
        let Some(b) = index.get(bus).and_then(|&j| calc2.topo.bus_of(NodeRef(j as u32))) else {
            continue;
        };
        let (dv, da) = ((sol2.vm[b] - vm).abs(), (sol2.va[b] - va).abs().to_degrees());
        if dv > out.max_dv {
            out.max_dv = dv;
            out.worst = model.nodes[k].id.clone();
        }
        out.max_da = out.max_da.max(da);
    }
    out
}

/// An imported network ready for the editor: what was read, what the editor's document holds, and how closely.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForEditor {
    /// `cgmes`, `psse` or `matpower`.
    pub format: &'static str,
    /// What the import read, mapped and assumed.
    pub report: ps_io::report::ImportReport,
    /// The model's validation findings.
    pub validation: Vec<ps_model::Issue>,
    /// What the editor's document reduced or approximated.
    pub conversion: Vec<String>,
    /// How the study case was set from the file, and why.
    pub study: Vec<String>,
    /// How closely the document reproduces the model's load flow, and the voltages to start from.
    pub fidelity: Fidelity,
    /// Counts of what the model holds.
    pub size: Size,
    /// The document (sent separately as the reply's payload).
    #[serde(skip)]
    pub doc: serde_json::Value,
}

/// Counts of a model's equipment.
#[derive(Debug, Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Size {
    /// Nodes.
    pub nodes: usize,
    /// Lines and transformers.
    pub branches: usize,
    /// Generators, external grids and static var compensators.
    pub sources: usize,
    /// Loads.
    pub loads: usize,
    /// Switches.
    pub switches: usize,
}

/// Reads the files a user handed over (CGMES XML files or archives, one PSS/E RAW file or one MATPOWER case) into a
/// model, validates it and converts it into the editor's document.
pub fn import_for_editor(files: Vec<ps_io::files::File>) -> Result<ForEditor, String> {
    use ps_io::report::{FileReport, ImportReport};
    let files = ps_io::files::expand(files).map_err(|e| e.to_string())?;
    // The format by extension, or by content when the extension says nothing: CGMES is RDF/XML, a MATPOWER case
    // assigns mpc.bus, and a RAW file starts with its case identification (IC, SBASE, REV, …).
    let ext = |f: &ps_io::files::File| -> String {
        let by_name = f
            .name
            .rsplit_once('.')
            .map(|(_, e)| e.to_ascii_lowercase())
            .unwrap_or_default();
        if matches!(by_name.as_str(), "raw" | "m" | "xml") {
            return by_name;
        }
        let head = String::from_utf8_lossy(&f.data[..f.data.len().min(4096)]).into_owned();
        let first = head
            .lines()
            .find(|l| !l.trim().is_empty() && !l.trim_start().starts_with("@!"))
            .unwrap_or("");
        let fields: Vec<&str> = first
            .split('/')
            .next()
            .unwrap_or("")
            .split([',', ' ', '\t'])
            .filter(|t| !t.is_empty())
            .collect();
        if head.trim_start().starts_with('<') && head.contains("rdf:RDF") {
            "xml".into()
        } else if head.contains("mpc.bus") {
            "m".into()
        } else if fields.len() >= 3 && fields[..3].iter().all(|t| t.parse::<f64>().is_ok()) {
            "raw".into()
        } else {
            by_name
        }
    };
    let single = |what: &str| -> Result<&ps_io::files::File, String> {
        match files.iter().filter(|f| ext(f) == what).count() {
            1 => Ok(files.iter().find(|f| ext(f) == what).ok_or("no file")?),
            n => Err(format!("open one .{what} file at a time ({n} were given)")),
        }
    };
    let (format, model, report) = if files.iter().any(|f| ext(f) == "raw") {
        let f = single("raw")?;
        let imp = ps_io::psse_model::import(&ps_io::psse::decode(&f.data), &f.name)
            .map_err(|e| format!("{}: {e}", f.name))?;
        ("psse", imp.model, imp.report)
    } else if files.iter().any(|f| ext(f) == "m") {
        let f = single("m")?;
        let text = std::str::from_utf8(&f.data).map_err(|_| format!("{} is not text", f.name))?;
        let case = ps_io::matpower::parse(text).map_err(|e| format!("{}: {e}", f.name))?;
        let imp = ps_io::matpower_model::to_model(&case);
        let report = ImportReport {
            files: vec![FileReport {
                name: f.name.clone(),
                profiles: vec!["MATPOWER".into()],
            }],
            classes: Vec::new(),
            notes: imp.issues,
        };
        ("matpower", imp.model, report)
    } else if files.iter().any(|f| ext(f) == "xml") {
        let imp = ps_io::cgmes::import(&files).map_err(|e| e.to_string())?;
        ("cgmes", imp.model, imp.report)
    } else {
        return Err(
            "PowerStudio opens CGMES models (XML files or ZIP archives), PSS/E RAW files (.raw) and MATPOWER cases (.m)"
                .into(),
        );
    };
    let validation = model.validate();
    let mut converted = ps_io::powerstudio_write::to_document(&model);
    let fidelity = editor_fidelity(&model, &converted);
    let at_limit = machines_at_reactive_limits(&model);
    let mut study = Vec::new();
    if at_limit > 0 {
        converted.doc["study"]["loadflow"]["enforceQLimits"] = serde_json::Value::Bool(true);
        study.push(format!(
            "The study case respects reactive power limits: {at_limit} machine(s) sit at a limit in the file's own \
             solution, so it was solved with them. Without them, machines would hold voltages they cannot reach."
        ));
    }
    let size = Size {
        nodes: model.nodes.len(),
        branches: model.lines.len() + model.transformers2.len() + model.transformers3.len(),
        sources: model.generators.len() + model.external_grids.len() + model.svcs.len(),
        loads: model.loads.len(),
        switches: model.switches.len(),
    };
    Ok(ForEditor {
        format,
        report,
        validation,
        conversion: converted.notes,
        study,
        fidelity,
        size,
        doc: converted.doc,
    })
}

/// CGMES files that carry an edited operating point back to the operator's toolchain: the input's SSH with the
/// operating values the document changed, and the SV of a load flow on the files with that SSH.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CgmesExport {
    /// The files: each changed SSH, then the SV (sent separately as the reply's payload).
    #[serde(skip)]
    pub files: Vec<ps_io::files::File>,
    /// Operating values that differ from the files.
    pub changes: usize,
    /// SSH properties written.
    pub edits: usize,
    /// Whether the load flow on the new SSH converged.
    pub converged: bool,
    /// Its iterations.
    pub iterations: usize,
    /// What could not be carried, in plain words.
    pub notes: Vec<String>,
}

/// Exports the operating point of `doc`, a document made from the CGMES `files` (and edited since), as SSH and SV.
/// Values are compared with the document the files convert to, so only what the user changed is written.
pub fn export_cgmes(
    files: Vec<ps_io::files::File>,
    doc: &serde_json::Value,
    created: &str,
) -> Result<CgmesExport, String> {
    use ps_io::cgmes_ssh::{Change, Options, Setting};
    let files = ps_io::files::expand(files).map_err(|e| e.to_string())?;
    let model = ps_io::cgmes::import(&files).map_err(|e| e.to_string())?.model;
    let original = ps_io::powerstudio_write::to_document(&model).doc;
    let elements = |d: &serde_json::Value| -> std::collections::HashMap<String, serde_json::Value> {
        d["elements"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|e| Some((e["id"].as_str()?.to_string(), e.clone())))
                    .collect()
            })
            .unwrap_or_default()
    };
    let (was, now) = (elements(&original), elements(doc));
    let kv = |n: ps_model::NodeRef| model.nodes.get(n.index()).map_or(0.0, |x| x.nominal_kv);
    let mut changes = Vec::new();
    let (mut equipment, mut added, mut removed) = (0usize, 0usize, 0usize);
    let differs = |a: &serde_json::Value, b: &serde_json::Value| match (a.as_f64(), b.as_f64()) {
        (Some(x), Some(y)) => (x - y).abs() > 1e-9 * x.abs().max(1.0),
        _ => a != b,
    };
    for (id, e) in &now {
        let Some(o) = was.get(id) else {
            added += 1;
            continue;
        };
        let cls = e["cls"].as_str().unwrap_or("");
        let mut push = |setting: Setting| {
            changes.push(Change {
                id: id.clone(),
                setting,
            })
        };
        // A field the conversion left out holds the catalogue's default once the editor's import gate has filled it
        // in (src/core/catalog.js; the engine test of this export checks the two agree).
        let default = |k: &str| -> serde_json::Value {
            match (cls, k) {
                (_, "inService") => true.into(),
                ("trafo", "tapControl") | ("shunt", "vControl") => false.into(),
                ("trafo" | "shunt", "vTarget") | ("gen" | "extgrid", "vset") => 1.0.into(),
                ("shunt", "sections") => 1.0.into(),
                ("trafo", "tapPos") | (_, "angle") | ("gen", "q") => 0.0.into(),
                _ => serde_json::Value::Null,
            }
        };
        let before = |k: &str| o.get(k).cloned().unwrap_or_else(|| default(k));
        let changed = |k: &str| e.get(k).is_some_and(|v| differs(v, &before(k)));
        let number = |k: &str| e[k].as_f64().unwrap_or(0.0);
        let mut operating: Vec<&str> = vec!["inService"];
        if changed("inService") {
            push(Setting::InService(e["inService"].as_bool().unwrap_or(true)));
        }
        match cls {
            "load" => {
                operating.extend(["p", "q"]);
                if changed("p") {
                    push(Setting::LoadP(number("p")));
                }
                if changed("q") {
                    push(Setting::LoadQ(number("q")));
                }
            }
            "gen" | "extgrid" => {
                operating.extend(["p", "q", "vset", "angle"]);
                if cls == "gen" && changed("p") {
                    push(Setting::MachineP(number("p")));
                }
                if cls == "gen" && changed("q") {
                    push(Setting::MachineQ(number("q")));
                }
                if changed("vset") {
                    let node = model
                        .generators
                        .iter()
                        .find(|g| g.id == *id)
                        .map(|g| g.regulated_node.unwrap_or(g.node))
                        .or_else(|| model.external_grids.iter().find(|g| g.id == *id).map(|g| g.node));
                    match node {
                        Some(n) => push(Setting::VoltageTargetKv(number("vset") * kv(n))),
                        None => equipment += 1,
                    }
                }
            }
            "shunt" => {
                operating.push("sections");
                if changed("sections") {
                    push(Setting::Sections(number("sections")));
                }
            }
            "trafo" => {
                operating.extend(["tapPos", "tapControl", "vTarget"]);
                let t = model.transformers2.iter().find(|t| t.id == *id);
                let tap = t.and_then(ps_io::powerstudio_write::written_tap);
                if let (Some(tap), true) = (tap, changed("tapPos") || changed("tapControl") || changed("vTarget")) {
                    if changed("tapPos") {
                        push(Setting::TapStep {
                            phase: tap.phase,
                            end: tap.end,
                            step: tap.position + number("tapPos").round() as i32,
                        });
                    }
                    if changed("tapControl") {
                        push(Setting::TapControl {
                            phase: tap.phase,
                            end: tap.end,
                            on: e["tapControl"].as_bool().unwrap_or(false),
                        });
                    }
                    let control = t
                        .and_then(|t| t.ratio_taps.iter().find(|r| r.end == tap.end))
                        .and_then(|r| r.control);
                    if changed("vTarget") && !tap.phase {
                        match control {
                            Some(c) => push(Setting::TapTargetKv {
                                end: tap.end,
                                kv: number("vTarget") * kv(c.node),
                            }),
                            None => equipment += 1,
                        }
                    }
                }
            }
            _ => {}
        }
        // Everything else the document describes is equipment (EQ), or the drawing.
        let drawing = [
            "x", "y", "len", "orient", "fromPos", "toPos", "hvPos", "lvPos", "pos", "side", "bend", "name", "id", "cls",
        ];
        let other = |(k, v): (&String, &serde_json::Value)| {
            !operating.contains(&k.as_str())
                && !drawing.contains(&k.as_str())
                && o.get(k).is_some_and(|w| differs(v, w))
        };
        if e.as_object().is_some_and(|fields| fields.iter().any(other)) {
            equipment += 1;
        }
    }
    for id in was.keys().filter(|id| !now.contains_key(*id)) {
        removed += 1;
        changes.push(Change {
            id: id.clone(),
            setting: Setting::InService(false),
        });
    }
    let ssh = ps_io::cgmes_ssh::write(
        &files,
        &changes,
        &Options {
            created: created.to_string(),
        },
    )?;
    let mut notes = ssh.notes.clone();
    if equipment > 0 {
        notes.push(format!(
            "{equipment} element(s) also changed equipment data (impedances, ratings and the like); that belongs to the EQ profile, which PowerStudio does not export."
        ));
    }
    if added > 0 {
        notes.push(format!(
            "{added} element(s) added in PowerStudio are not in the CGMES files, so SSH cannot carry them."
        ));
    }
    if removed > 0 {
        notes.push(format!(
            "{removed} element(s) removed in PowerStudio are written as out of service."
        ));
    }
    // The files with the new SSH in place of the old ones, solved for the SV.
    let solved: Vec<ps_io::files::File> = files
        .iter()
        .map(|f| ssh.files.iter().find(|n| n.name == f.name).unwrap_or(f).clone())
        .collect();
    let model = ps_io::cgmes::import(&solved).map_err(|e| e.to_string())?.model;
    let settings = ps_io::powerstudio::from_value(doc)
        .map_err(|e| e.to_string())?
        .study
        .loadflow;
    let start: Vec<Option<(f64, f64)>> = model
        .nodes
        .iter()
        .map(|n| (n.v0 > 0.0).then(|| (n.v0, n.angle0.to_radians())))
        .collect();
    let run = crate::LoadFlowRun {
        settings,
        start: start.iter().any(Option::is_some).then_some(start),
        ..Default::default()
    };
    let (calc, sol, report) = crate::loadflow::solve(&model, &run);
    if !report.converged {
        notes.push(format!(
            "The load flow on the new operating point did not converge ({}); the SV is its last state.",
            report.message
        ));
    }
    let state = sv_state(&model, &calc, &sol, &report);
    let sv = ps_io::cgmes_sv::write(
        &solved,
        &model,
        &state,
        &ps_io::cgmes_sv::Options {
            created: created.to_string(),
            description: "PowerStudio: the load flow of the operating point in the accompanying SSH.".into(),
        },
    )?;
    notes.extend(sv.notes);
    let mut out: Vec<ps_io::files::File> = ssh
        .files
        .iter()
        .map(|f| ps_io::files::File {
            name: suffixed(&f.name, "PowerStudio"),
            data: f.data.clone(),
        })
        .collect();
    let base = ssh
        .files
        .first()
        .map_or("SV.xml".to_string(), |f| f.name.replace("SSH", "SV"));
    out.push(ps_io::files::File {
        name: suffixed(&base, "PowerStudio"),
        data: sv.text.into_bytes(),
    });
    Ok(CgmesExport {
        files: out,
        changes: changes.len(),
        edits: ssh.edits,
        converged: report.converged,
        iterations: report.iterations,
        notes,
    })
}

/// A file name with a suffix before its extension, and the folders dropped.
fn suffixed(name: &str, suffix: &str) -> String {
    let name = name.rsplit(['/', '\\']).next().unwrap_or(name);
    match name.rsplit_once('.') {
        Some((stem, ext)) => format!("{stem}_{suffix}.{ext}"),
        None => format!("{name}_{suffix}"),
    }
}
