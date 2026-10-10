//! CGMES (2.4.15 and 3.0) → canonical model.
//!
//! The equipment profile gives the network as built, the steady-state hypothesis its state (switch positions, set
//! points, tap positions, connected terminals), the topology profile the topological nodes and the state variables
//! the last solution, which becomes the model's starting voltages. Boundary files add the boundary points, which
//! become ordinary nodes; equivalent injections there become loads or regulating machines, so a lone TSO model
//! behaves like PowSyBl's dangling lines and an assembled one joins at the boundary.
//!
//! Every class in the files appears in the [`Report`]: mapped into the model, used as supporting data, or not used
//! (with the reason). Values the files leave out and the importer fills in are listed as notes.

use std::collections::{BTreeMap, HashMap};

use ps_model::{
    Area, CurrentLimit, Generator, Line, Load, MachineControl, MachineDynamics, MachineShortCircuit, Model, Node,
    NodeKind, NodeRef, PhaseTap, RatioTap, Shunt, Substation, Svc, Switch, SwitchKind, TapPoint, Transformer2,
    Transformer3, VoltageControl, VoltageLevel, Winding, Winding3,
};

use crate::ParseError;
use crate::files::File;
use crate::rdf::{Graph, Object};

pub use crate::report::{ClassReport, FileReport, ImportReport as Report};

/// A converted CGMES model.
#[derive(Debug, Clone)]
pub struct Imported {
    /// The model.
    pub model: Model,
    /// What the import did.
    pub report: Report,
}

/// Typical machine data used when a file gives none.
const TYPICAL_SC: MachineShortCircuit = MachineShortCircuit {
    xdss: 0.2,
    rs: 0.0,
    cos_phi: 0.85,
    earthed: false,
};
const TYPICAL_DYNAMICS: MachineDynamics = MachineDynamics {
    xdt: 0.3,
    h: 4.0,
    d: 0.0,
};

const SWITCH_CLASSES: [&str; 10] = [
    "Switch",
    "Breaker",
    "Disconnector",
    "LoadBreakSwitch",
    "Fuse",
    "Jumper",
    "ProtectedSwitch",
    "Recloser",
    "Sectionaliser",
    "DisconnectingCircuitBreaker",
];
const LOAD_CLASSES: [&str; 5] = [
    "EnergyConsumer",
    "ConformLoad",
    "NonConformLoad",
    "StationSupply",
    "AsynchronousMachine",
];
const PHASE_TAP_CLASSES: [&str; 4] = [
    "PhaseTapChangerLinear",
    "PhaseTapChangerSymmetrical",
    "PhaseTapChangerAsymmetrical",
    "PhaseTapChangerTabular",
];

/// Classes read as supporting data, with what they provide.
const USED: [(&str, &str); 34] = [
    ("Terminal", "connection points"),
    ("ConnectivityNode", "nodes"),
    ("TopologicalNode", "nodes of bus-branch models and solved voltages"),
    ("BaseVoltage", "nominal voltages"),
    ("BusbarSection", "busbar nodes"),
    ("BoundaryPoint", "boundary nodes"),
    ("PowerTransformerEnd", "transformer windings"),
    ("RatioTapChanger", "ratio tap changers"),
    ("RatioTapChangerTable", "ratio tap tables"),
    ("RatioTapChangerTablePoint", "ratio tap tables"),
    ("PhaseTapChangerLinear", "phase tap changers"),
    ("PhaseTapChangerSymmetrical", "phase tap changers"),
    ("PhaseTapChangerAsymmetrical", "phase tap changers"),
    ("PhaseTapChangerTabular", "phase tap changers"),
    ("PhaseTapChangerTable", "phase tap tables"),
    ("PhaseTapChangerTablePoint", "phase tap tables"),
    ("TapChangerControl", "tap changer control targets"),
    ("RegulatingControl", "voltage control targets"),
    ("GeneratingUnit", "active power limits"),
    ("HydroGeneratingUnit", "active power limits"),
    ("ThermalGeneratingUnit", "active power limits"),
    ("NuclearGeneratingUnit", "active power limits"),
    ("WindGeneratingUnit", "active power limits"),
    ("SolarGeneratingUnit", "active power limits"),
    ("ReactiveCapabilityCurve", "reactive power limits"),
    ("CurveData", "reactive power limits"),
    ("LoadResponseCharacteristic", "voltage dependence of loads"),
    ("NonlinearShuntCompensatorPoint", "non-linear shunt sections"),
    ("OperationalLimitSet", "current limits"),
    ("OperationalLimitType", "current limit durations"),
    ("CurrentLimit", "current limits"),
    ("SvVoltage", "starting voltages"),
    (
        "SynchronousMachineTimeConstantReactance",
        "transient reactance, inertia and damping",
    ),
    ("Bay", "voltage level of nodes in bays"),
];

/// Classes deliberately not used, with the reason.
fn not_used_reason(class: &str) -> &'static str {
    match class {
        c if c.starts_with("Diagram") || c == "TextDiagramObject" || c == "VisibilityLayer" => {
            "diagram layout: shown with the substation diagrams (design phase 4)"
        }
        "Location" | "PositionPoint" | "CoordinateSystem" => {
            "geographical location: shown with the geographic diagrams (design phase 4)"
        }
        c if c.starts_with("DC") || c.contains("Converter") => "HVDC equipment: not yet modelled (design phase 3)",
        c if c.starts_with("Sv") || c == "TopologicalIsland" => {
            "state variables beyond voltages: recomputed by the load flow"
        }
        "TieFlow" | "ControlAreaGeneratingUnit" => "interchange accounting: not used by the load flow",
        "GroundDisconnector" | "Ground" | "GroundingImpedance" | "PetersenCoil" => {
            "earthing equipment: not part of the load flow"
        }
        c if c.contains("Dynamics")
            || c.starts_with("Exc")
            || c.starts_with("Gov")
            || c.starts_with("Pss")
            || c.starts_with("VComp")
            || c.starts_with("Synchronous") =>
        {
            "dynamic models: the classical model is used (design phase 5 adds these)"
        }
        _ => "not used by the calculations",
    }
}

struct Term<'g> {
    id: &'g str,
    seq: i64,
    node: Option<NodeRef>,
    connected: bool,
}

struct Ctx<'g> {
    g: &'g Graph,
    m: Model,
    notes: Vec<String>,
    mapped: BTreeMap<String, String>,
    terminals: HashMap<&'g str, Vec<Term<'g>>>,
    term_node: HashMap<&'g str, NodeRef>,
    term_connected: HashMap<&'g str, bool>,
    limits: HashMap<&'g str, Vec<(Option<f64>, f64)>>,
    /// Objects of a class grouped by the object a property refers to, built once per (class, property).
    groups: HashMap<(&'static str, &'static str), HashMap<&'g str, Vec<&'g Object>>>,
}

impl<'g> Ctx<'g> {
    /// Objects of `class` whose property `link` refers to `target`.
    fn linked(&mut self, class: &'static str, link: &'static str, target: &str) -> Vec<&'g Object> {
        let g = self.g;
        let group = self.groups.entry((class, link)).or_insert_with(|| {
            let mut m: HashMap<&'g str, Vec<&'g Object>> = HashMap::new();
            for o in g.of_class(class) {
                if let Some(r) = g.reference(o, link) {
                    m.entry(r).or_default().push(o);
                }
            }
            m
        });
        group.get(target).cloned().unwrap_or_default()
    }
}

impl<'g> Ctx<'g> {
    fn name(&self, o: &Object) -> String {
        self.g.text(o, "IdentifiedObject.name").unwrap_or("").to_string()
    }

    fn num(&self, o: &Object, prop: &str) -> Option<f64> {
        self.g.num(o, prop)
    }

    fn numd(&self, o: &Object, prop: &str) -> f64 {
        self.g.num(o, prop).unwrap_or(0.0)
    }

    fn in_service(&self, o: &Object) -> bool {
        self.g.flag(o, "Equipment.inService").unwrap_or(true)
    }

    fn terms(&self, o: &Object) -> &[Term<'g>] {
        self.terminals.get(&*o.id).map_or(&[], |v| v.as_slice())
    }

    fn mark(&mut self, class: &str, detail: &str) {
        self.mapped
            .entry(class.to_string())
            .or_insert_with(|| detail.to_string());
    }

    fn nominal_kv(&self, node: NodeRef) -> f64 {
        self.m.nodes.get(node.index()).map_or(0.0, |n| n.nominal_kv)
    }

    /// Current limits of a terminal, as model limits at branch end `end`.
    fn current_limits(&self, term: &str, end: u8) -> Vec<CurrentLimit> {
        self.limits
            .get(term)
            .map(|v| {
                v.iter()
                    .map(|&(duration_s, amps)| CurrentLimit { end, duration_s, amps })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// A voltage control from a regulating control object: enabled flag, regulated node and target.
    fn voltage_control(&self, eq: &Object, own: NodeRef) -> Option<(bool, NodeRef, f64, f64)> {
        let rc = self.g.follow(eq, "RegulatingCondEq.RegulatingControl")?;
        let mode = self.g.enumeration(rc, "RegulatingControl.mode").unwrap_or("voltage");
        if mode != "voltage" {
            return None;
        }
        let node = self
            .g
            .reference(rc, "RegulatingControl.Terminal")
            .and_then(|t| self.term_node.get(t).copied())
            .unwrap_or(own);
        let enabled = self.g.flag(eq, "RegulatingCondEq.controlEnabled").unwrap_or(false)
            && self.g.flag(rc, "RegulatingControl.enabled").unwrap_or(true);
        let target = self.num(rc, "RegulatingControl.targetValue")?;
        let deadband = self.numd(rc, "RegulatingControl.targetDeadband");
        Some((enabled, node, target, deadband))
    }
}

/// Imports CGMES files (XML; archives expanded beforehand by [`crate::files::expand`]).
pub fn import(files: &[File]) -> Result<Imported, ParseError> {
    let mut g = Graph::new();
    for f in files.iter().filter(|f| f.name.to_ascii_lowercase().ends_with(".xml")) {
        g.read(&f.name, &f.data)?;
    }
    if g.objects.is_empty() {
        return Err(ParseError::new("no CGMES objects were found in the files", None));
    }
    let mut cx = Ctx {
        g: &g,
        m: Model::new(""),
        notes: Vec::new(),
        mapped: BTreeMap::new(),
        terminals: HashMap::new(),
        term_node: HashMap::new(),
        term_connected: HashMap::new(),
        limits: HashMap::new(),
        groups: HashMap::new(),
    };
    cx.m.meta.name = model_name(cx.g, files);
    cx.m.meta.description = "Imported from CGMES.".into();
    containers(&mut cx);
    nodes(&mut cx);
    limits(&mut cx);
    branches(&mut cx);
    transformers(&mut cx);
    injections(&mut cx);
    switches(&mut cx);
    let report = report(&cx, &g);
    let mut model = cx.m;
    model.meta.frequency_hz = 50.0;
    Ok(Imported { model, report })
}

fn containers(cx: &mut Ctx) {
    let g = cx.g;
    let mut subs: HashMap<&str, u32> = HashMap::new();
    for o in g.of_class("Substation") {
        subs.insert(&o.id, cx.m.substations.len() as u32);
        let name = cx.name(o);
        let region = g.follow(o, "Substation.Region").map(|r| cx.name(r)).unwrap_or_default();
        cx.m.substations.push(Substation {
            id: o.id.to_string(),
            name,
            region,
        });
    }
    for o in g.of_class("VoltageLevel") {
        let kv = g
            .follow(o, "VoltageLevel.BaseVoltage")
            .and_then(|b| g.num(b, "BaseVoltage.nominalVoltage"))
            .unwrap_or(0.0);
        let substation = g
            .reference(o, "VoltageLevel.Substation")
            .and_then(|s| subs.get(s).copied());
        cx.m.voltage_levels.push(VoltageLevel {
            id: o.id.to_string(),
            name: cx.name(o),
            substation,
            nominal_kv: kv,
        });
    }
    for o in g.of_class("ControlArea") {
        cx.m.areas.push(Area {
            id: o.id.to_string(),
            name: cx.name(o),
            interchange_mw: cx.numd(o, "ControlArea.netInterchange"),
            tolerance_mw: cx.numd(o, "ControlArea.pTolerance"),
            control: false,
            slack: None,
        });
    }
    cx.mark("Substation", "substations");
    cx.mark("VoltageLevel", "voltage levels");
    cx.mark("ControlArea", "areas (interchange control off)");
}

/// The voltage level a container stands for: itself, or a bay's.
fn voltage_level_of<'g>(g: &'g Graph, container: Option<&'g Object>) -> Option<&'g Object> {
    let c = container?;
    match g.name(c.class) {
        "VoltageLevel" => Some(c),
        "Bay" => g.follow(c, "Bay.VoltageLevel"),
        _ => None,
    }
}

fn nodes(cx: &mut Ctx) {
    let g = cx.g;
    let vl_index: HashMap<&str, u32> = g
        .of_class("VoltageLevel")
        .enumerate()
        .map(|(i, v)| (&*v.id, i as u32))
        .collect();
    let sv: HashMap<&str, (f64, f64)> = g
        .of_class("SvVoltage")
        .filter_map(|o| {
            Some((
                g.reference(o, "SvVoltage.TopologicalNode")?,
                (g.num(o, "SvVoltage.v")?, g.num(o, "SvVoltage.angle").unwrap_or(0.0)),
            ))
        })
        .collect();
    let busbars: std::collections::HashSet<&str> = g
        .of_class("Terminal")
        .filter(|t| {
            g.follow(t, "Terminal.ConductingEquipment")
                .is_some_and(|e| g.name(e.class) == "BusbarSection")
        })
        .filter_map(|t| g.reference(t, "Terminal.ConnectivityNode"))
        .collect();
    // Equipment base voltages, for nodes whose container gives none (boundary points).
    let mut equipment_kv: HashMap<&str, f64> = HashMap::new();
    for t in g.of_class("Terminal") {
        let node = g
            .reference(t, "Terminal.ConnectivityNode")
            .or_else(|| g.reference(t, "Terminal.TopologicalNode"));
        let kv = g
            .follow(t, "Terminal.ConductingEquipment")
            .and_then(|e| g.follow(e, "ConductingEquipment.BaseVoltage"))
            .and_then(|b| g.num(b, "BaseVoltage.nominalVoltage"));
        if let (Some(n), Some(kv)) = (node, kv) {
            equipment_kv.entry(n).or_insert(kv);
        }
    }
    // The nodes to create: every connectivity node, then the topological nodes that terminals name directly
    // (bus-branch models).
    let mut specs: Vec<(&Object, Option<&Object>, NodeKind)> = Vec::new();
    let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
    // Boundary points: named by BoundaryPoint objects (CGMES 3.0) or flagged on the node (2.4.15).
    let boundary: std::collections::HashSet<&str> = g
        .of_class("BoundaryPoint")
        .filter_map(|b| g.reference(b, "BoundaryPoint.ConnectivityNode"))
        .collect();
    let is_boundary = |o: &Object| {
        boundary.contains(&*o.id)
            || g.flag(o, "ConnectivityNode.boundaryPoint").unwrap_or(false)
            || g.flag(o, "TopologicalNode.boundaryPoint").unwrap_or(false)
    };
    for o in g.of_class("ConnectivityNode") {
        let kind = if is_boundary(o) {
            NodeKind::Boundary
        } else if busbars.contains(&*o.id) {
            NodeKind::BusbarSection
        } else {
            NodeKind::Connectivity
        };
        specs.push((o, g.follow(o, "ConnectivityNode.TopologicalNode"), kind));
        seen.insert(&o.id);
    }
    for t in g.of_class("Terminal") {
        if g.reference(t, "Terminal.ConnectivityNode").is_none()
            && let Some(tn) = g.follow(t, "Terminal.TopologicalNode")
            && seen.insert(&tn.id)
        {
            specs.push((
                tn,
                Some(tn),
                if is_boundary(tn) {
                    NodeKind::Boundary
                } else {
                    NodeKind::Bus
                },
            ));
        }
    }
    let mut node_of: HashMap<&str, NodeRef> = HashMap::new();
    let mut missing_kv = 0;
    for (o, tn, kind) in specs {
        let container = g
            .follow(o, "ConnectivityNode.ConnectivityNodeContainer")
            .or_else(|| g.follow(o, "TopologicalNode.ConnectivityNodeContainer"));
        let vl = voltage_level_of(g, container);
        let kv = vl
            .and_then(|v| g.follow(v, "VoltageLevel.BaseVoltage"))
            .or_else(|| tn.and_then(|t| g.follow(t, "TopologicalNode.BaseVoltage")))
            .and_then(|b| g.num(b, "BaseVoltage.nominalVoltage"))
            .or_else(|| equipment_kv.get(&*o.id).copied())
            .unwrap_or(0.0);
        if kv <= 0.0 {
            missing_kv += 1;
        }
        let limit = |prop: &str| vl.and_then(|v| g.num(v, prop)).filter(|_| kv > 0.0).map(|x| x / kv);
        let (v0, angle0) = tn
            .and_then(|t| sv.get(&*t.id))
            .map_or((0.0, 0.0), |&(v, a)| if kv > 0.0 { (v / kv, a) } else { (0.0, 0.0) });
        node_of.insert(&o.id, NodeRef(cx.m.nodes.len() as u32));
        cx.m.nodes.push(Node {
            id: o.id.to_string(),
            name: cx.name(o),
            kind,
            voltage_level: vl.and_then(|v| vl_index.get(&*v.id).copied()),
            nominal_kv: kv,
            v_min: limit("VoltageLevel.lowVoltageLimit").unwrap_or(0.0),
            v_max: limit("VoltageLevel.highVoltageLimit").unwrap_or(f64::MAX),
            area: None,
            v0,
            angle0,
        });
    }
    if missing_kv > 0 {
        cx.notes.push(format!(
            "{missing_kv} node(s) have no nominal voltage in the files; they are left out of calculations."
        ));
    }
    for t in g.of_class("Terminal") {
        let Some(eq) = g.reference(t, "Terminal.ConductingEquipment") else {
            continue;
        };
        let node = g
            .reference(t, "Terminal.ConnectivityNode")
            .and_then(|n| node_of.get(n).copied())
            .or_else(|| {
                g.reference(t, "Terminal.TopologicalNode")
                    .and_then(|n| node_of.get(n).copied())
            });
        let seq = g.num(t, "ACDCTerminal.sequenceNumber").unwrap_or(1.0) as i64;
        let connected = g.flag(t, "ACDCTerminal.connected").unwrap_or(true);
        if let Some(n) = node {
            cx.term_node.insert(&t.id, n);
        }
        cx.term_connected.insert(&t.id, connected);
        cx.terminals.entry(eq).or_default().push(Term {
            id: &t.id,
            seq,
            node,
            connected,
        });
    }
    for v in cx.terminals.values_mut() {
        v.sort_by_key(|t| t.seq);
    }
    cx.mark("ConnectivityNode", "nodes");
}

fn limits(cx: &mut Ctx) {
    let g = cx.g;
    let sets: HashMap<&str, &str> = g
        .of_class("OperationalLimitSet")
        .filter_map(|s| Some((&*s.id, g.reference(s, "OperationalLimitSet.Terminal")?)))
        .collect();
    for l in g.of_class("CurrentLimit") {
        let Some(term) = g
            .reference(l, "OperationalLimit.OperationalLimitSet")
            .and_then(|s| sets.get(s).copied())
        else {
            continue;
        };
        let Some(amps) = g
            .num(l, "CurrentLimit.value")
            .or_else(|| g.num(l, "CurrentLimit.normalValue"))
        else {
            continue;
        };
        let ty = g.follow(l, "OperationalLimit.OperationalLimitType");
        let infinite = ty
            .and_then(|t| g.flag(t, "OperationalLimitType.isInfiniteDuration"))
            .unwrap_or(false)
            || ty.and_then(|t| g.enumeration(t, "OperationalLimitType.limitType")) == Some("patl");
        let duration = ty
            .and_then(|t| g.num(t, "OperationalLimitType.acceptableDuration"))
            .filter(|_| !infinite);
        cx.limits.entry(term).or_default().push((duration, amps));
    }
}

fn two_terminals(cx: &Ctx, o: &Object) -> Option<(NodeRef, NodeRef, [bool; 2], [String; 2])> {
    let t = cx.terms(o);
    let (a, b) = (t.first()?, t.get(1)?);
    Some((
        a.node?,
        b.node?,
        [!a.connected, !b.connected],
        [a.id.to_string(), b.id.to_string()],
    ))
}

fn branches(cx: &mut Ctx) {
    let g = cx.g;
    let mut skipped = 0;
    for (class, detail) in [
        ("ACLineSegment", "lines"),
        ("SeriesCompensator", "lines (series compensation)"),
        ("EquivalentBranch", "lines (equivalent branches)"),
    ] {
        for o in g.of_class(class) {
            let Some((n1, n2, open, terms)) = two_terminals(cx, o) else {
                skipped += 1;
                continue;
            };
            let (r, x, g_, b, r0, x0, b0) = match class {
                "ACLineSegment" => (
                    cx.numd(o, "ACLineSegment.r"),
                    cx.numd(o, "ACLineSegment.x"),
                    cx.numd(o, "ACLineSegment.gch"),
                    cx.numd(o, "ACLineSegment.bch"),
                    cx.numd(o, "ACLineSegment.r0"),
                    cx.numd(o, "ACLineSegment.x0"),
                    cx.numd(o, "ACLineSegment.b0ch"),
                ),
                "SeriesCompensator" => (
                    cx.numd(o, "SeriesCompensator.r"),
                    cx.numd(o, "SeriesCompensator.x"),
                    0.0,
                    0.0,
                    cx.numd(o, "SeriesCompensator.r0"),
                    cx.numd(o, "SeriesCompensator.x0"),
                    0.0,
                ),
                _ => {
                    let (r12, x12) = (cx.numd(o, "EquivalentBranch.r"), cx.numd(o, "EquivalentBranch.x"));
                    if cx
                        .num(o, "EquivalentBranch.r21")
                        .is_some_and(|r21| (r21 - r12).abs() > 1e-9 * r12.abs().max(1.0))
                    {
                        cx.notes.push(format!(
                            "Equivalent branch {} is asymmetrical; its 1-to-2 impedance is used both ways.",
                            o.id
                        ));
                    }
                    (
                        r12,
                        x12,
                        0.0,
                        0.0,
                        cx.numd(o, "EquivalentBranch.r0"),
                        cx.numd(o, "EquivalentBranch.x0"),
                        0.0,
                    )
                }
            };
            let mut limits = cx.current_limits(&terms[0], 1);
            limits.extend(cx.current_limits(&terms[1], 2));
            cx.m.lines.push(Line {
                id: o.id.to_string(),
                name: cx.name(o),
                node1: n1,
                node2: n2,
                in_service: cx.in_service(o),
                open,
                r,
                x,
                g1: g_ / 2.0,
                b1: b / 2.0,
                g2: g_ / 2.0,
                b2: b / 2.0,
                r0,
                x0,
                b0,
                length_km: cx.numd(o, "Conductor.length"),
                limits,
            });
            cx.mark(class, detail);
        }
    }
    if skipped > 0 {
        cx.notes
            .push(format!("{skipped} line(s) lack a terminal or node and were skipped."));
    }
}

/// Tap position from the steady-state hypothesis, or the normal step.
fn tap_position(cx: &mut Ctx, tc: &Object) -> i32 {
    let step = cx
        .num(tc, "TapChanger.step")
        .or_else(|| cx.num(tc, "TapChanger.normalStep"))
        .unwrap_or(0.0);
    if (step - step.round()).abs() > 1e-9 {
        cx.notes.push(format!(
            "Tap changer {} is at the non-integer step {step}; step {} is used.",
            tc.id,
            step.round()
        ));
    }
    step.round() as i32
}

fn steps(cx: &Ctx, tc: &Object) -> (i32, i32, i32) {
    let low = cx.num(tc, "TapChanger.lowStep").unwrap_or(0.0) as i32;
    let high = cx.num(tc, "TapChanger.highStep").unwrap_or(0.0) as i32;
    let neutral = cx.num(tc, "TapChanger.neutralStep").unwrap_or(0.0) as i32;
    (low, high, neutral)
}

fn table_points(cx: &mut Ctx, table: Option<&str>, point_class: &'static str, link: &'static str) -> Vec<TapPoint> {
    let Some(table) = table else { return Vec::new() };
    let mut points: Vec<TapPoint> = cx
        .linked(point_class, link, table)
        .into_iter()
        .map(|p| TapPoint {
            position: cx.numd(p, "TapChangerTablePoint.step") as i32,
            ratio: cx.num(p, "TapChangerTablePoint.ratio").unwrap_or(1.0),
            angle_deg: cx.numd(p, "PhaseTapChangerTablePoint.angle"),
            r_pct: cx.numd(p, "TapChangerTablePoint.r"),
            x_pct: cx.numd(p, "TapChangerTablePoint.x"),
            g_pct: cx.numd(p, "TapChangerTablePoint.g"),
            b_pct: cx.numd(p, "TapChangerTablePoint.b"),
        })
        .collect();
    points.sort_by_key(|p| p.position);
    points
}

fn ratio_tap(cx: &mut Ctx, tc: &Object, end: u8) -> RatioTap {
    let (low, high, neutral) = steps(cx, tc);
    let position = tap_position(cx, tc);
    let table_ref = cx.g.reference(tc, "RatioTapChanger.RatioTapChangerTable");
    let table = table_points(
        cx,
        table_ref,
        "RatioTapChangerTablePoint",
        "RatioTapChangerTablePoint.RatioTapChangerTable",
    );
    let control = tap_control(cx, tc);
    RatioTap {
        end,
        low,
        high,
        neutral,
        step_pct: cx.numd(tc, "RatioTapChanger.stepVoltageIncrement"),
        position,
        control,
        table,
    }
}

fn tap_control(cx: &Ctx, tc: &Object) -> Option<VoltageControl> {
    let g = cx.g;
    let rc = g.follow(tc, "TapChanger.TapChangerControl")?;
    if g.enumeration(rc, "RegulatingControl.mode").unwrap_or("voltage") != "voltage" {
        return None;
    }
    let node = g
        .reference(rc, "RegulatingControl.Terminal")
        .and_then(|t| cx.term_node.get(t).copied())?;
    Some(VoltageControl {
        enabled: g.flag(tc, "TapChanger.controlEnabled").unwrap_or(false)
            && g.flag(rc, "RegulatingControl.enabled").unwrap_or(true),
        node,
        target_kv: cx.numd(rc, "RegulatingControl.targetValue"),
        deadband_kv: cx.numd(rc, "RegulatingControl.targetDeadband"),
    })
}

/// A phase tap changer, converted as PowSyBl does. Linear ones keep a constant step unless their reactance varies
/// with the angle; symmetrical, asymmetrical and tabular ones become tables of angle and ratio per position. `xtx` is
/// the transformer's reactance referred to the changer's winding, Ω, against which xMin and xMax are compared.
fn phase_tap(cx: &mut Ctx, tc: &Object, end: u8, xtx: f64) -> PhaseTap {
    let g = cx.g;
    let (low, high, neutral) = steps(cx, tc);
    let position = tap_position(cx, tc);
    let class = g.name(tc.class);
    let du = cx.numd(tc, "PhaseTapChangerNonLinear.voltageStepIncrement") / 100.0;
    let increment = cx
        .num(tc, "PhaseTapChangerLinear.stepPhaseShiftIncrement")
        .or_else(|| cx.num(tc, "PhaseTapChangerSymmetrical.stepPhaseShiftIncrement"))
        .filter(|v| *v != 0.0);
    let theta = cx
        .numd(tc, "PhaseTapChangerAsymmetrical.windingConnectionAngle")
        .to_radians();
    let rows = |f: &dyn Fn(f64) -> (f64, f64)| -> Vec<TapPoint> {
        (low..=high)
            .map(|p| {
                let (ratio, angle_deg) = f(f64::from(p - neutral));
                TapPoint {
                    position: p,
                    ratio,
                    angle_deg,
                    ..Default::default()
                }
            })
            .collect()
    };
    let mut table = match class {
        "PhaseTapChangerLinear" => rows(&|n| (1.0, n * increment.unwrap_or(0.0))),
        "PhaseTapChangerSymmetrical" => rows(&|n| {
            (
                1.0,
                increment.map_or_else(|| (2.0 * (n * du / 2.0).atan()).to_degrees(), |inc| n * inc),
            )
        }),
        "PhaseTapChangerAsymmetrical" => rows(&|n| {
            let (re, im) = (1.0 + n * du * theta.cos(), n * du * theta.sin());
            (re.hypot(im), im.atan2(re).to_degrees())
        }),
        _ => {
            let table_ref = g.reference(tc, "PhaseTapChangerTabular.PhaseTapChangerTable");
            table_points(
                cx,
                table_ref,
                "PhaseTapChangerTablePoint",
                "PhaseTapChangerTablePoint.PhaseTapChangerTable",
            )
        }
    };
    // The reactance of non-tabular phase shifters varies with the angle between xMin (at no shift) and xMax (at the
    // largest shift); xMin defaults to the transformer's own reactance.
    let x_min = cx
        .num(tc, "PhaseTapChangerLinear.xMin")
        .or_else(|| cx.num(tc, "PhaseTapChangerNonLinear.xMin"))
        .filter(|v| *v > 0.0)
        .unwrap_or(xtx);
    let x_max = cx
        .num(tc, "PhaseTapChangerLinear.xMax")
        .or_else(|| cx.num(tc, "PhaseTapChangerNonLinear.xMax"));
    let varies =
        class != "PhaseTapChangerTabular" && x_max.is_some_and(|m| m > 0.0 && x_min >= 0.0 && x_min <= m) && xtx != 0.0;
    if let (true, Some(x_max)) = (varies, x_max) {
        let alpha_max = table
            .iter()
            .map(|p| p.angle_deg)
            .fold(f64::NEG_INFINITY, f64::max)
            .to_radians();
        for p in &mut table {
            let alpha = p.angle_deg.to_radians();
            let share = if alpha_max == 0.0 {
                0.0
            } else if class == "PhaseTapChangerAsymmetrical" {
                let num = theta.sin() - alpha_max.tan() * theta.cos();
                let den = theta.sin() - alpha.tan() * theta.cos();
                (alpha.tan() / alpha_max.tan() * num / den).powi(2)
            } else {
                ((alpha / 2.0).sin() / (alpha_max / 2.0).sin()).powi(2)
            };
            let x = if alpha_max == 0.0 {
                0.0
            } else {
                x_min + (x_max - x_min) * share
            };
            p.x_pct = 100.0 * (x - xtx) / xtx;
        }
    }
    let stepped = class == "PhaseTapChangerLinear" && !varies;
    PhaseTap {
        end,
        low,
        high,
        neutral,
        step_deg: if stepped { increment.unwrap_or(0.0) } else { 0.0 },
        position,
        control: None,
        table: if stepped { Vec::new() } else { table },
    }
}

fn winding(kind: Option<&str>) -> Winding {
    match kind {
        Some("D") => Winding::D,
        Some("Y") => Winding::Y,
        Some("Z") => Winding::Z,
        Some("Zn") => Winding::Zn,
        _ => Winding::Yn,
    }
}

fn transformers(cx: &mut Ctx) {
    let g = cx.g;
    let mut ends: HashMap<&str, Vec<&Object>> = HashMap::new();
    for e in g.of_class("PowerTransformerEnd") {
        if let Some(pt) = g.reference(e, "PowerTransformerEnd.PowerTransformer") {
            ends.entry(pt).or_default().push(e);
        }
    }
    let mut ratio: HashMap<&str, &Object> = HashMap::new();
    for tc in g.of_class("RatioTapChanger") {
        if let Some(e) = g.reference(tc, "RatioTapChanger.TransformerEnd") {
            ratio.insert(e, tc);
        }
    }
    let mut phase: HashMap<&str, &Object> = HashMap::new();
    for class in PHASE_TAP_CLASSES {
        for tc in g.of_class(class) {
            if let Some(e) = g.reference(tc, "PhaseTapChanger.TransformerEnd") {
                phase.insert(e, tc);
            }
        }
    }
    let mut skipped = 0;
    let mut clocks_ignored = 0;
    for pt in g.of_class("PowerTransformer") {
        let Some(es) = ends.get_mut(&*pt.id) else {
            skipped += 1;
            continue;
        };
        es.sort_by_key(|e| g.num(e, "TransformerEnd.endNumber").unwrap_or(0.0) as i64);
        // Each end: its node, connection state, terminal and electrical data.
        let mut data = Vec::new();
        for e in es.iter() {
            let term = g.reference(e, "TransformerEnd.Terminal").unwrap_or("");
            let Some(node) = cx.term_node.get(term).copied() else {
                break;
            };
            data.push((e, node, !cx.term_connected.get(term).copied().unwrap_or(true), term));
        }
        if data.len() != es.len() || !(2..=3).contains(&data.len()) {
            skipped += 1;
            continue;
        }
        let u = |e: &Object| cx.numd(e, "PowerTransformerEnd.ratedU");
        // Phase angle clocks describe the vector group. Exchanged models are solved without them (PowSyBl applies them
        // only on request, and stored solutions are consistent with leaving them out), so they are not applied;
        // transformers that carry one are counted in the report.
        let clocked = es.iter().any(|e| {
            cx.num(e, "PowerTransformerEnd.phaseAngleClock")
                .is_some_and(|c| c.rem_euclid(12.0) != 0.0)
        });
        clocks_ignored += usize::from(clocked);
        let clock = |_: &Object| 0_i64;
        let in_service = cx.in_service(pt);
        if data.len() == 2 {
            let ((e1, n1, open1, t1), (e2, n2, open2, t2)) = (data[0], data[1]);
            let (u1, u2) = (u(e1), u(e2));
            let k = (u1 / u2).powi(2);
            let refer_y = (u2 / u1).powi(2);
            let mut limits = cx.current_limits(t1, 1);
            limits.extend(cx.current_limits(t2, 2));
            let mut t = Transformer2 {
                id: pt.id.to_string(),
                name: cx.name(pt),
                node1: n1,
                node2: n2,
                in_service,
                open: [open1, open2],
                rated_kv1: u1,
                rated_kv2: u2,
                rated_mva: cx
                    .num(e1, "PowerTransformerEnd.ratedS")
                    .or_else(|| cx.num(e2, "PowerTransformerEnd.ratedS"))
                    .unwrap_or(0.0),
                unrated: false,
                r: cx.numd(e1, "PowerTransformerEnd.r") + cx.numd(e2, "PowerTransformerEnd.r") * k,
                x: cx.numd(e1, "PowerTransformerEnd.x") + cx.numd(e2, "PowerTransformerEnd.x") * k,
                g1: cx.numd(e1, "PowerTransformerEnd.g"),
                b1: cx.numd(e1, "PowerTransformerEnd.b"),
                g2: cx.numd(e2, "PowerTransformerEnd.g") * refer_y,
                b2: cx.numd(e2, "PowerTransformerEnd.b") * refer_y,
                clock: (clock(e2) - clock(e1)).rem_euclid(12) as u8,
                phase_shift_deg: 0.0,
                conn1: winding(g.enumeration(e1, "PowerTransformerEnd.connectionKind")),
                conn2: winding(g.enumeration(e2, "PowerTransformerEnd.connectionKind")),
                r0: cx.numd(e1, "PowerTransformerEnd.r0") + cx.numd(e2, "PowerTransformerEnd.r0") * k,
                x0: cx.numd(e1, "PowerTransformerEnd.x0") + cx.numd(e2, "PowerTransformerEnd.x0") * k,
                ratio_taps: Vec::new(),
                phase_tap: None,
                limits,
            };
            for (end, e) in [(1u8, e1), (2u8, e2)] {
                if let Some(tc) = ratio.get(&*e.id).copied() {
                    t.ratio_taps.push(ratio_tap(cx, tc, end));
                }
                if let Some(tc) = phase.get(&*e.id).copied() {
                    let xtx = if end == 2 {
                        t.x * (t.rated_kv2 / t.rated_kv1).powi(2)
                    } else {
                        t.x
                    };
                    t.phase_tap = Some(phase_tap(cx, tc, end, xtx));
                }
            }
            cx.m.transformers2.push(t);
            cx.mark("PowerTransformer", "two- and three-winding transformers");
        } else {
            let mut windings = [Winding3::default(); 3];
            let mut limits = Vec::new();
            for (i, &(e, node, open, term)) in data.iter().enumerate() {
                windings[i] = Winding3 {
                    node,
                    rated_kv: u(e),
                    rated_mva: cx.numd(e, "PowerTransformerEnd.ratedS"),
                    r: cx.numd(e, "PowerTransformerEnd.r"),
                    x: cx.numd(e, "PowerTransformerEnd.x"),
                    g: cx.numd(e, "PowerTransformerEnd.g"),
                    b: cx.numd(e, "PowerTransformerEnd.b"),
                    phase_shift_deg: 0.0,
                    clock: (clock(e) - clock(data[0].0)).rem_euclid(12) as u8,
                    conn: winding(g.enumeration(e, "PowerTransformerEnd.connectionKind")),
                    open,
                };
                limits.extend(cx.current_limits(term, i as u8 + 1));
            }
            let mut ratio_taps = Vec::new();
            let mut phase_taps = Vec::new();
            for (i, &(e, ..)) in data.iter().enumerate() {
                if let Some(tc) = ratio.get(&*e.id).copied() {
                    ratio_taps.push(ratio_tap(cx, tc, i as u8 + 1));
                }
                if let Some(tc) = phase.get(&*e.id).copied() {
                    // The winding's reactance, Ω at its own rated voltage, is what the tap's reactance varies from.
                    phase_taps.push(phase_tap(cx, tc, i as u8 + 1, windings[i].x));
                }
            }
            cx.m.transformers3.push(Transformer3 {
                id: pt.id.to_string(),
                name: cx.name(pt),
                windings,
                in_service,
                ratio_taps,
                phase_taps,
                limits,
            });
            cx.mark("PowerTransformer", "two- and three-winding transformers");
        }
    }
    if skipped > 0 {
        cx.notes.push(format!(
            "{skipped} transformer(s) have missing ends, terminals or nodes and were skipped."
        ));
    }
    if clocks_ignored > 0 {
        cx.notes.push(format!(
            "{clocks_ignored} transformer(s) state a vector group phase displacement (phaseAngleClock); as in PowSyBl, it is not applied to the load flow."
        ));
    }
}

/// Reactive limits from a capability curve at active power `p`.
fn curve_limits(cx: &mut Ctx, sm: &Object, p: f64) -> Option<(f64, f64)> {
    let g = cx.g;
    let curve = g.reference(sm, "SynchronousMachine.InitialReactiveCapabilityCurve")?;
    let mut pts: Vec<(f64, f64, f64)> = cx
        .linked("CurveData", "CurveData.Curve", curve)
        .into_iter()
        .filter_map(|d| {
            Some((
                g.num(d, "CurveData.xvalue")?,
                g.num(d, "CurveData.y1value")?,
                g.num(d, "CurveData.y2value")?,
            ))
        })
        .collect();
    pts.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    let (first, last) = (pts.first()?, pts.last()?);
    if p <= first.0 {
        return Some((first.1.min(first.2), first.1.max(first.2)));
    }
    if p >= last.0 {
        return Some((last.1.min(last.2), last.1.max(last.2)));
    }
    let w = pts.windows(2).find(|w| p >= w[0].0 && p <= w[1].0)?;
    let f = (p - w[0].0) / (w[1].0 - w[0].0);
    let (a, b) = (w[0].1 + f * (w[1].1 - w[0].1), w[0].2 + f * (w[1].2 - w[0].2));
    Some((a.min(b), a.max(b)))
}

#[allow(clippy::too_many_lines)]
fn injections(cx: &mut Ctx) {
    let g = cx.g;
    let mut typical_sc = 0;
    let mut typical_dyn = 0;
    let mut no_limits = 0;
    let dynamics: HashMap<&str, &Object> = g
        .of_class("SynchronousMachineTimeConstantReactance")
        .filter_map(|d| Some((g.reference(d, "SynchronousMachineDynamics.SynchronousMachine")?, d)))
        .collect();
    for (class, detail) in [
        ("SynchronousMachine", "generators"),
        ("ExternalNetworkInjection", "generators (external network injections)"),
    ] {
        for o in g.of_class(class) {
            let Some(node) = cx.terms(o).first().and_then(|t| t.node) else {
                continue;
            };
            let connected = cx.terms(o).first().is_some_and(|t| t.connected);
            let (pp, qp, minq, maxq, prio) = match class {
                "SynchronousMachine" => (
                    "RotatingMachine.p",
                    "RotatingMachine.q",
                    "SynchronousMachine.minQ",
                    "SynchronousMachine.maxQ",
                    "SynchronousMachine.referencePriority",
                ),
                _ => (
                    "ExternalNetworkInjection.p",
                    "ExternalNetworkInjection.q",
                    "ExternalNetworkInjection.minQ",
                    "ExternalNetworkInjection.maxQ",
                    "ExternalNetworkInjection.referencePriority",
                ),
            };
            // Load sign convention in the files: a producing machine has negative p.
            let p = -cx.numd(o, pp);
            let q = -cx.numd(o, qp);
            let control = cx.voltage_control(o, node);
            let (mode, v_set, regulated) = match control {
                Some((true, n, target, _)) => {
                    let kv = cx.nominal_kv(n);
                    (
                        MachineControl::Pv,
                        if kv > 0.0 { target / kv } else { 1.0 },
                        (n != node).then_some(n),
                    )
                }
                _ => (MachineControl::Pq, 1.0, None),
            };
            let (q_min, q_max) = match (cx.num(o, minq), cx.num(o, maxq)) {
                (Some(a), Some(b)) => (a.min(b), a.max(b)),
                _ => curve_limits(cx, o, p).unwrap_or_else(|| {
                    no_limits += 1;
                    (-f64::MAX, f64::MAX)
                }),
            };
            let unit = g.follow(o, "RotatingMachine.GeneratingUnit");
            let sc = match cx.num(o, "SynchronousMachine.satDirectSubtransX") {
                Some(xdss) => MachineShortCircuit {
                    xdss,
                    rs: cx.numd(o, "SynchronousMachine.r"),
                    cos_phi: cx
                        .num(o, "RotatingMachine.ratedPowerFactor")
                        .unwrap_or(TYPICAL_SC.cos_phi),
                    earthed: g.flag(o, "SynchronousMachine.earthing").unwrap_or(false),
                },
                None => {
                    typical_sc += usize::from(class == "SynchronousMachine");
                    TYPICAL_SC
                }
            };
            let dynamics = match dynamics.get(&*o.id) {
                Some(d) => MachineDynamics {
                    xdt: cx
                        .num(d, "SynchronousMachineTimeConstantReactance.xDirectTrans")
                        .unwrap_or(TYPICAL_DYNAMICS.xdt),
                    h: cx
                        .num(d, "RotatingMachineDynamics.inertia")
                        .unwrap_or(TYPICAL_DYNAMICS.h),
                    d: cx.numd(d, "RotatingMachineDynamics.damping"),
                },
                None => {
                    typical_dyn += usize::from(class == "SynchronousMachine");
                    TYPICAL_DYNAMICS
                }
            };
            cx.m.generators.push(Generator {
                id: o.id.to_string(),
                name: cx.name(o),
                node,
                in_service: cx.in_service(o) && connected,
                control: mode,
                p,
                q,
                v_set,
                regulated_node: regulated,
                angle: 0.0,
                q_min,
                q_max,
                p_min: unit
                    .and_then(|u| cx.num(u, "GeneratingUnit.minOperatingP"))
                    .unwrap_or(0.0),
                p_max: unit
                    .and_then(|u| cx.num(u, "GeneratingUnit.maxOperatingP"))
                    .unwrap_or(0.0),
                rated_mva: cx.num(o, "RotatingMachine.ratedS").unwrap_or(0.0),
                rated_kv: cx
                    .num(o, "RotatingMachine.ratedU")
                    .unwrap_or_else(|| cx.nominal_kv(node)),
                participation: 0.0,
                reference_priority: cx.num(o, prio).map_or(0, |v| v.max(0.0) as u32),
                sc,
                dynamics,
            });
            cx.mark(class, detail);
        }
    }
    // At a boundary point that both neighbouring models reach, the equivalent injections stand for the other side,
    // which is now present: a merged model leaves them out (PowSyBl pairs the boundary lines into tie lines).
    let mut reach: HashMap<NodeRef, usize> = HashMap::new();
    for (eq, terms) in &cx.terminals {
        if g.get(eq).is_some_and(|o| g.name(o.class) != "EquivalentInjection") {
            for t in terms.iter().filter_map(|t| t.node) {
                *reach.entry(t).or_default() += 1;
            }
        }
    }
    let mut paired = 0;
    for o in g.of_class("EquivalentInjection") {
        let Some(node) = cx.terms(o).first().and_then(|t| t.node) else {
            continue;
        };
        if cx.m.nodes[node.index()].kind == NodeKind::Boundary && reach.get(&node).copied().unwrap_or(0) >= 2 {
            paired += 1;
            continue;
        }
        let connected = cx.terms(o).first().is_some_and(|t| t.connected);
        let (p, q) = (cx.numd(o, "EquivalentInjection.p"), cx.numd(o, "EquivalentInjection.q"));
        let regulating = g.flag(o, "EquivalentInjection.regulationCapability").unwrap_or(false)
            && g.flag(o, "EquivalentInjection.regulationStatus").unwrap_or(false);
        if regulating {
            let kv = cx.nominal_kv(node);
            let target = cx.numd(o, "EquivalentInjection.regulationTarget");
            cx.m.generators.push(Generator {
                id: o.id.to_string(),
                name: cx.name(o),
                node,
                in_service: cx.in_service(o) && connected,
                control: MachineControl::Pv,
                p: -p,
                q: -q,
                v_set: if kv > 0.0 { target / kv } else { 1.0 },
                q_min: cx.num(o, "EquivalentInjection.minQ").unwrap_or(-f64::MAX),
                q_max: cx.num(o, "EquivalentInjection.maxQ").unwrap_or(f64::MAX),
                rated_kv: kv,
                sc: TYPICAL_SC,
                dynamics: TYPICAL_DYNAMICS,
                ..Default::default()
            });
            cx.mark("EquivalentInjection", "generators when regulating, loads otherwise");
        } else {
            cx.m.loads.push(Load {
                id: o.id.to_string(),
                name: cx.name(o),
                node,
                in_service: cx.in_service(o) && connected,
                p,
                q,
                p_zip: [0.0, 0.0, 1.0],
                q_zip: [0.0, 0.0, 1.0],
            });
            cx.mark("EquivalentInjection", "generators when regulating, loads otherwise");
        }
    }
    if paired > 0 {
        cx.notes.push(format!(
            "{paired} equivalent injection(s) at boundary points that both neighbouring models reach were left out: in a merged model the other side is present."
        ));
    }
    let mut exponential = 0;
    for class in LOAD_CLASSES {
        for o in g.of_class(class) {
            let Some(node) = cx.terms(o).first().and_then(|t| t.node) else {
                continue;
            };
            let connected = cx.terms(o).first().is_some_and(|t| t.connected);
            let (p, q) = if class == "AsynchronousMachine" {
                (cx.numd(o, "RotatingMachine.p"), cx.numd(o, "RotatingMachine.q"))
            } else {
                (cx.numd(o, "EnergyConsumer.p"), cx.numd(o, "EnergyConsumer.q"))
            };
            let (mut p_zip, mut q_zip) = ([0.0, 0.0, 1.0], [0.0, 0.0, 1.0]);
            if let Some(lrc) = g.follow(o, "EnergyConsumer.LoadResponse") {
                if g.flag(lrc, "LoadResponseCharacteristic.exponentModel").unwrap_or(false) {
                    exponential += 1;
                } else {
                    let share = |z: &str, i: &str, pw: &str| {
                        let v = [cx.numd(lrc, z), cx.numd(lrc, i), cx.numd(lrc, pw)];
                        let sum: f64 = v.iter().sum();
                        if sum > 0.0 { v.map(|x| x / sum) } else { [0.0, 0.0, 1.0] }
                    };
                    p_zip = share(
                        "LoadResponseCharacteristic.pConstantImpedance",
                        "LoadResponseCharacteristic.pConstantCurrent",
                        "LoadResponseCharacteristic.pConstantPower",
                    );
                    q_zip = share(
                        "LoadResponseCharacteristic.qConstantImpedance",
                        "LoadResponseCharacteristic.qConstantCurrent",
                        "LoadResponseCharacteristic.qConstantPower",
                    );
                }
            }
            cx.m.loads.push(Load {
                id: o.id.to_string(),
                name: cx.name(o),
                node,
                in_service: cx.in_service(o) && connected,
                p,
                q,
                p_zip,
                q_zip,
            });
            cx.mark(class, "loads");
        }
    }
    for class in ["LinearShuntCompensator", "NonlinearShuntCompensator"] {
        for o in g.of_class(class) {
            let Some(node) = cx.terms(o).first().and_then(|t| t.node) else {
                continue;
            };
            let connected = cx.terms(o).first().is_some_and(|t| t.connected);
            let sections = cx
                .num(o, "ShuntCompensator.sections")
                .or_else(|| cx.num(o, "ShuntCompensator.normalSections"))
                .unwrap_or(0.0);
            let mut points: Vec<(i64, f64, f64)> = cx
                .linked(
                    "NonlinearShuntCompensatorPoint",
                    "NonlinearShuntCompensatorPoint.NonlinearShuntCompensator",
                    &o.id,
                )
                .into_iter()
                .map(|p| {
                    (
                        cx.numd(p, "NonlinearShuntCompensatorPoint.sectionNumber") as i64,
                        cx.numd(p, "NonlinearShuntCompensatorPoint.g"),
                        cx.numd(p, "NonlinearShuntCompensatorPoint.b"),
                    )
                })
                .collect();
            points.sort_by_key(|p| p.0);
            let control = cx
                .voltage_control(o, node)
                .map(|(enabled, n, target, deadband)| VoltageControl {
                    enabled,
                    node: n,
                    target_kv: target,
                    deadband_kv: deadband,
                });
            cx.m.shunts.push(Shunt {
                id: o.id.to_string(),
                name: cx.name(o),
                node,
                in_service: cx.in_service(o) && connected,
                nominal_kv: cx
                    .num(o, "ShuntCompensator.nomU")
                    .unwrap_or_else(|| cx.nominal_kv(node)),
                g_per_section: cx.numd(o, "LinearShuntCompensator.gPerSection"),
                b_per_section: cx.numd(o, "LinearShuntCompensator.bPerSection"),
                sections: sections.round().max(0.0) as u32,
                max_sections: cx
                    .num(o, "ShuntCompensator.maximumSections")
                    .unwrap_or(sections)
                    .round()
                    .max(0.0) as u32,
                control,
                points: points.into_iter().map(|(_, g, b)| (g, b)).collect(),
            });
            cx.mark(class, "shunts");
        }
    }
    // Equivalent shunts: a fixed admittance at the nominal voltage of their node.
    for o in g.of_class("EquivalentShunt") {
        let Some(node) = cx.terms(o).first().and_then(|t| t.node) else {
            continue;
        };
        let connected = cx.terms(o).first().is_some_and(|t| t.connected);
        cx.m.shunts.push(Shunt {
            id: o.id.to_string(),
            name: cx.name(o),
            node,
            in_service: cx.in_service(o) && connected,
            nominal_kv: cx.nominal_kv(node),
            g_per_section: cx.numd(o, "EquivalentShunt.g"),
            b_per_section: cx.numd(o, "EquivalentShunt.b"),
            sections: 1,
            max_sections: 1,
            control: None,
            points: Vec::new(),
        });
        cx.mark("EquivalentShunt", "shunts");
    }
    for o in g.of_class("StaticVarCompensator") {
        let Some(node) = cx.terms(o).first().and_then(|t| t.node) else {
            continue;
        };
        let connected = cx.terms(o).first().is_some_and(|t| t.connected);
        let control = cx.voltage_control(o, node);
        let kv = cx.nominal_kv(node);
        let target = control
            .map(|c| c.2)
            .or_else(|| cx.num(o, "StaticVarCompensator.voltageSetPoint"));
        let susceptance = |prop: &str| cx.num(o, prop).filter(|x| *x != 0.0).map_or(0.0, |x| 1.0 / x);
        cx.m.svcs.push(Svc {
            id: o.id.to_string(),
            name: cx.name(o),
            node,
            in_service: cx.in_service(o) && connected,
            nominal_kv: kv,
            b_min: susceptance("StaticVarCompensator.inductiveRating"),
            b_max: susceptance("StaticVarCompensator.capacitiveRating"),
            v_set: target.map_or(1.0, |t| if kv > 0.0 { t / kv } else { 1.0 }),
            regulating: control.is_some_and(|c| c.0),
            q: -cx.numd(o, "StaticVarCompensator.q"),
        });
        cx.mark("StaticVarCompensator", "static var compensators");
    }
    if typical_sc > 0 {
        cx.notes.push(format!(
            "{typical_sc} synchronous machine(s) have no short-circuit data; x″d = {} p.u. and cos φ = {} are assumed.",
            TYPICAL_SC.xdss, TYPICAL_SC.cos_phi
        ));
    }
    if typical_dyn > 0 {
        cx.notes.push(format!(
            "{typical_dyn} synchronous machine(s) have no dynamic model; x′d = {} p.u. and H = {} s are assumed for the classical model.",
            TYPICAL_DYNAMICS.xdt, TYPICAL_DYNAMICS.h
        ));
    }
    if no_limits > 0 {
        cx.notes.push(format!(
            "{no_limits} machine(s) have no reactive power limits; they are treated as unlimited."
        ));
    }
    if exponential > 0 {
        cx.notes.push(format!("{exponential} load(s) use an exponential voltage model, which is not yet supported; they are treated as constant power."));
    }
}

fn switches(cx: &mut Ctx) {
    let g = cx.g;
    for class in SWITCH_CLASSES {
        for o in g.of_class(class) {
            let t = cx.terms(o);
            let (Some(a), Some(b)) = (t.first().and_then(|t| t.node), t.get(1).and_then(|t| t.node)) else {
                continue;
            };
            let terminals_open = t.iter().any(|t| !t.connected);
            let open = g
                .flag(o, "Switch.open")
                .or_else(|| g.flag(o, "Switch.normalOpen"))
                .unwrap_or(false)
                || terminals_open
                || !cx.in_service(o);
            let kind = match class {
                "Breaker" | "DisconnectingCircuitBreaker" => SwitchKind::Breaker,
                "Disconnector" => SwitchKind::Disconnector,
                "LoadBreakSwitch" => SwitchKind::LoadBreak,
                "Fuse" => SwitchKind::Fuse,
                _ => SwitchKind::Other,
            };
            cx.m.switches.push(Switch {
                id: o.id.to_string(),
                name: cx.name(o),
                node1: a,
                node2: b,
                kind,
                open,
            });
            cx.mark(class, "switches");
        }
    }
}

fn report(cx: &Ctx, g: &Graph) -> Report {
    let short = |p: &str| p.trim_end_matches('/').rsplit('/').nth(1).unwrap_or(p).to_string();
    let files = g
        .headers
        .iter()
        .map(|h| FileReport {
            name: h.file.clone(),
            profiles: h.profiles.iter().map(|p| short(p)).collect(),
        })
        .collect();
    let classes = g
        .class_counts()
        .into_iter()
        .map(|(class, count)| {
            if let Some(detail) = cx.mapped.get(&class) {
                ClassReport {
                    class,
                    count,
                    status: "mapped",
                    detail: detail.clone(),
                }
            } else if let Some((_, what)) = USED.iter().find(|(c, _)| *c == class) {
                ClassReport {
                    class,
                    count,
                    status: "used",
                    detail: (*what).to_string(),
                }
            } else if matches!(
                class.as_str(),
                "GeographicalRegion"
                    | "SubGeographicalRegion"
                    | "Line"
                    | "LoadArea"
                    | "SubLoadArea"
                    | "ConformLoadGroup"
                    | "NonConformLoadGroup"
                    | "LoadGroup"
                    | "EnergySchedulingType"
                    | "FullModel"
            ) {
                ClassReport {
                    class,
                    count,
                    status: "used",
                    detail: "names and grouping".into(),
                }
            } else {
                let detail = not_used_reason(&class).to_string();
                ClassReport {
                    class,
                    count,
                    status: "not used",
                    detail,
                }
            }
        })
        .collect();
    Report {
        files,
        classes,
        notes: cx.notes.clone(),
    }
}

/// A name for the model from its equipment files (not the boundary set): their names without the profile and
/// version part (`20210325T1530Z_1D_BE_EQ_001` → `20210325T1530Z_1D_BE`), several joined by their common start
/// (`…_1D_BE + NL`).
fn model_name(g: &Graph, files: &[File]) -> String {
    let stem = |f: &str| {
        let base = f.rsplit(['/', '\\']).next().unwrap_or(f);
        let base = base
            .strip_suffix(".xml")
            .or_else(|| base.strip_suffix(".XML"))
            .unwrap_or(base);
        base.find("_EQ").map_or(base, |at| &base[..at]).to_string()
    };
    let mut stems: Vec<String> = g
        .headers
        .iter()
        .filter(|h| {
            h.profiles
                .iter()
                .any(|p| p.contains("Equipment") && !p.contains("Boundary"))
        })
        .map(|h| stem(&h.file))
        .collect();
    stems.dedup();
    match stems.len() {
        0 => files.first().map(|f| stem(&f.name)).unwrap_or_default(),
        1 => stems.remove(0),
        _ => {
            let first = &stems[0];
            let common = stems
                .iter()
                .map(|s| first.bytes().zip(s.bytes()).take_while(|(a, b)| a == b).count())
                .min()
                .unwrap_or(0);
            let cut = first[..common].rfind('_').map_or(0, |i| i + 1);
            let parts: Vec<&str> = stems.iter().map(|s| &s[cut..]).collect();
            format!("{}{}", &first[..cut], parts.join(" + "))
        }
    }
}
