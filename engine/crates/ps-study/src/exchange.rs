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
    State {
        node_v,
        flows,
        node_island,
        island_reference,
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

/// Solves `model` and the document converted from it (`ps_io::powerstudio_write`), the document started from the
/// model's solution, and compares every node's voltage through the busbar that stands for it.
pub fn editor_fidelity(model: &Model, converted: &ps_io::powerstudio_write::Converted) -> Fidelity {
    use ps_model::study::LoadFlowSettings;
    let settings = LoadFlowSettings {
        tolerance: 1e-8,
        max_iter: 50,
        ..Default::default()
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
            settings: LoadFlowSettings { max_iter: 10, ..settings },
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
    let converted = ps_io::powerstudio_write::to_document(&model);
    let fidelity = editor_fidelity(&model, &converted);
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
        fidelity,
        size,
        doc: converted.doc,
    })
}
