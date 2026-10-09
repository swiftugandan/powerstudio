//! PSS/E RAW (versions 33 and 35) → canonical model.
//!
//! RAW data is per unit on the system base and each bus's base voltage; the model stores engineering values. The
//! conversion is exact for what the load flow uses:
//!
//! - Buses become nodes; a bus of type 4 (isolated) takes everything connected to it out of service.
//! - Non-transformer branches become lines with their charging split between both ends plus the end shunts GI, BI, GJ,
//!   BJ. A branch between buses of different base voltage keeps the per-unit meaning of the file (no ratio between
//!   the bases), so it becomes a transformer without taps.
//! - Transformers keep the winding ratios of the file (CW 1, 2 or 3) as fixed tap changers on each winding, the
//!   impedance between the windings (CZ 1, 2 or 3) on winding 1's bus base, and the magnetising admittance (CM 1 or
//!   2) at bus I, where PSS/E places it. Three-winding units become a star of three windings.
//! - Generators on type 2 and 3 buses hold voltage (at the bus IREG names, if any); on type 3 buses the first one in
//!   service is the reference. A type 3 bus with no generator in service gets an external grid.
//! - Switched shunts take the switching levels of their blocks (reactors first, then capacitors, as PowSyBl orders
//!   them) and sit at the level nearest BINIT.
//!
//! Identifiers follow PowSyBl's PSS/E import (`B2-L1`, `L-1-2-1`, `T-4-7-1`, `B9-SH1`), so results compare by name.

use std::collections::HashMap;

use ps_model::{
    Area, CurrentLimit, ExternalGrid, FlowControl, Generator, Line, Load, MachineControl, MachineDynamics,
    MachineShortCircuit, Model, Node, NodeKind, NodeRef, PhaseTap, RatioTap, Shunt, Substation, Svc, Switch,
    SwitchKind, TapPoint, Transformer2, Transformer3, VoltageControl, VoltageLevel, Winding, Winding3,
};

use crate::ParseError;
use crate::psse::{RawCase, Record, Section};
use crate::report::{ClassReport, FileReport, ImportReport};

/// A converted RAW case.
#[derive(Debug, Clone)]
pub struct Imported {
    /// The model.
    pub model: Model,
    /// What the import did.
    pub report: ImportReport,
}

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

/// Field positions that differ between versions 33 and 35.
struct Layout {
    rev: u32,
}

impl Layout {
    fn v35(&self) -> bool {
        self.rev >= 35
    }
    /// Generator: MBASE's position (NREG is inserted before it in version 35).
    fn gen_mbase(&self) -> usize {
        if self.v35() { 9 } else { 8 }
    }
    /// Branch: first rating field and the field after the ratings (GI).
    fn branch_rate(&self) -> usize {
        if self.v35() { 7 } else { 6 }
    }
    fn branch_gi(&self) -> usize {
        if self.v35() { 19 } else { 9 }
    }
    /// Transformer winding line: first rating, COD and RMA positions.
    fn winding_cod(&self) -> usize {
        if self.v35() { 15 } else { 6 }
    }
    fn winding_rma(&self) -> usize {
        if self.v35() { 18 } else { 8 }
    }
    /// Switched shunt: MODSW, BINIT and first block positions, and fields per block.
    fn sws_binit(&self) -> usize {
        if self.v35() { 11 } else { 9 }
    }
    fn sws_block(&self) -> (usize, usize) {
        if self.v35() { (12, 3) } else { (10, 2) }
    }
}

/// An equipment terminal of the node-breaker data: type code, the bus, the equipment's other buses (sorted) and its
/// identifier.
type TerminalKey = (char, i64, Vec<i64>, String);

struct Ctx {
    m: Model,
    sbase: f64,
    lay: Layout,
    /// Per bus number: its node (the lowest substation node for node-breaker buses), base kV and type (IDE).
    node_of: HashMap<i64, (NodeRef, f64, i64)>,
    /// Node-breaker terminals: where an equipment end connects inside its bus's substation.
    terminals: HashMap<TerminalKey, NodeRef>,
    notes: Vec<String>,
}

impl Ctx {
    fn bus(&self, num: i64, r: &Record) -> Result<(NodeRef, f64, i64), ParseError> {
        self.node_of
            .get(&num.abs())
            .copied()
            .ok_or_else(|| ParseError::new(format!("bus {num} is not defined"), Some(r.line)))
    }

    /// Where an equipment end at `bus` connects: the substation node its terminal record names, otherwise the bus's
    /// node. `kind` is the terminal type code (`L`, `F`, `S`, `M`, `B`, `2`, `3`), `others` the equipment's other buses.
    fn at(
        &self,
        kind: char,
        bus: i64,
        others: &[i64],
        id: &str,
        r: &Record,
    ) -> Result<(NodeRef, f64, i64), ParseError> {
        let (node, kv, ide) = self.bus(bus, r)?;
        let mut others: Vec<i64> = others.iter().map(|b| b.abs()).filter(|&b| b != 0).collect();
        others.sort_unstable();
        let key = (kind, bus.abs(), others, id.trim().to_string());
        Ok((self.terminals.get(&key).copied().unwrap_or(node), kv, ide))
    }
}

/// Converts a parsed RAW case.
pub fn to_model(raw: &RawCase, file: &str) -> Result<Imported, ParseError> {
    let mut cx = Ctx {
        m: Model::new(raw.title[0].clone()),
        sbase: raw.sbase,
        lay: Layout { rev: raw.rev },
        node_of: HashMap::new(),
        terminals: HashMap::new(),
        notes: Vec::new(),
    };
    cx.m.meta.base_mva = raw.sbase;
    cx.m.meta.frequency_hz = raw.basfrq;
    cx.m.meta.description = format!("Imported from PSS/E RAW version {} ({}).", raw.rev, raw.title[1]);
    if cx.m.meta.name.is_empty() {
        cx.m.meta.name = file.to_string();
    }
    buses(&mut cx, raw)?;
    loads(&mut cx, raw)?;
    shunts(&mut cx, raw)?;
    generators(&mut cx, raw)?;
    branches(&mut cx, raw)?;
    switches(&mut cx, raw)?;
    transformers(&mut cx, raw)?;
    areas(&mut cx, raw)?;
    facts(&mut cx, raw)?;
    let mut classes: Vec<ClassReport> = raw
        .records
        .iter()
        .map(|(s, r)| ClassReport {
            class: format!("{} DATA", s.name()),
            count: r.len(),
            status: "mapped",
            detail: mapped_as(*s).into(),
        })
        .collect();
    if !raw.substations.is_empty() {
        classes.push(ClassReport {
            class: "SUBSTATION DATA".into(),
            count: raw.substations.len(),
            status: "mapped",
            detail: "substations: nodes, switches and equipment terminals".into(),
        });
    }
    classes.extend(raw.skipped.iter().map(|(s, n)| ClassReport {
        class: format!("{} DATA", s.name()),
        count: *n,
        status: "not used",
        detail: not_used(*s).into(),
    }));
    let report = ImportReport {
        files: vec![FileReport {
            name: file.to_string(),
            profiles: vec![format!("PSS/E RAW version {}", raw.rev)],
        }],
        classes,
        notes: cx.notes,
    };
    Ok(Imported { model: cx.m, report })
}

fn mapped_as(s: Section) -> &'static str {
    match s {
        Section::Bus => "nodes",
        Section::Load => "loads",
        Section::FixedShunt | Section::SwitchedShunt => "shunts",
        Section::Generator => "generators (external grids for empty slack buses)",
        Section::Branch => "lines (transformers between different base voltages)",
        Section::SwitchingDevice => "switches",
        Section::Transformer => "two- and three-winding transformers",
        Section::Area => "areas (interchange control off)",
        Section::Facts => "static var compensators (shunt devices; series devices not modelled)",
        _ => "",
    }
}

fn not_used(s: Section) -> &'static str {
    match s {
        Section::TwoTerminalDc | Section::VscDc | Section::MultiTerminalDc => {
            "HVDC links: not yet modelled (design phase 3)"
        }
        Section::InductionMachine => "induction machines: not yet modelled",
        Section::ImpedanceCorrection => "impedance correction tables: transformers use their stated impedance",
        _ => "not used by the calculations",
    }
}

fn id_part(s: &str) -> String {
    s.trim().to_string()
}

fn buses(cx: &mut Ctx, raw: &RawCase) -> Result<(), ParseError> {
    let mut areas: HashMap<i64, u32> = HashMap::new();
    let mut zero_kv = 0;
    // Substation nodes by bus number: (substation index, node record).
    let mut sub_nodes: HashMap<i64, Vec<(usize, &Record)>> = HashMap::new();
    for (k, sub) in raw.substations.iter().enumerate() {
        for n in &sub.nodes {
            sub_nodes.entry(n.int(0, 2, 0)?).or_default().push((k, n));
        }
    }
    let substation_of: HashMap<usize, u32> = raw
        .substations
        .iter()
        .enumerate()
        .map(|(k, sub)| -> Result<(usize, u32), ParseError> {
            cx.m.substations.push(Substation {
                id: format!("S{}", sub.header.int(0, 0, 0)?),
                name: sub.header.text(0, 1, ""),
                region: String::new(),
            });
            Ok((k, (cx.m.substations.len() - 1) as u32))
        })
        .collect::<Result<_, _>>()?;
    for r in raw.section(Section::Bus) {
        let num = r.int(0, 0, 0)?;
        let kv = r.num(0, 2, 0.0)?;
        let ide = r.int(0, 3, 1)?;
        let area = r.int(0, 4, 1)?;
        let kv = if kv > 0.0 {
            kv
        } else {
            zero_kv += 1;
            1.0
        };
        let a = *areas.entry(area).or_insert_with(|| {
            cx.m.areas.push(Area {
                id: format!("A{area}"),
                name: format!("Area {area}"),
                ..Default::default()
            });
            (cx.m.areas.len() - 1) as u32
        });
        let bus = Node {
            id: format!("B{num}"),
            name: r.text(0, 1, ""),
            kind: NodeKind::Bus,
            voltage_level: None,
            nominal_kv: kv,
            v_min: r.num(0, 10, 0.9)?,
            v_max: r.num(0, 9, 1.1)?,
            area: Some(a),
            v0: r.num(0, 7, 1.0)?,
            angle0: r.num(0, 8, 0.0)?,
        };
        let Some(nodes) = sub_nodes.get_mut(&num) else {
            cx.node_of.insert(num, (NodeRef(cx.m.nodes.len() as u32), kv, ide));
            cx.m.nodes.push(bus);
            continue;
        };
        // Node-breaker: the bus is a voltage level of its substation, one model node per substation node.
        nodes.sort_by_key(|(_, n)| n.int(0, 0, 0).unwrap_or(0));
        cx.m.voltage_levels.push(VoltageLevel {
            id: format!("VL{num}"),
            name: bus.name.clone(),
            substation: substation_of.get(&nodes[0].0).copied(),
            nominal_kv: kv,
        });
        let vl = (cx.m.voltage_levels.len() - 1) as u32;
        let first = NodeRef(cx.m.nodes.len() as u32);
        for &(k, n) in nodes.iter() {
            let ni = n.int(0, 0, 0)?;
            let sub = &raw.substations[k];
            let has_equipment = sub
                .terminals
                .iter()
                .any(|t| t.int(0, 0, 0).ok() == Some(num) && t.int(0, 1, 0).ok() == Some(ni));
            let node = NodeRef(cx.m.nodes.len() as u32);
            cx.m.nodes.push(Node {
                id: format!("B{num}-N{ni}"),
                name: n.text(0, 1, ""),
                kind: if has_equipment {
                    NodeKind::Connectivity
                } else {
                    NodeKind::BusbarSection
                },
                voltage_level: Some(vl),
                v0: n.num(0, 4, bus.v0)?,
                angle0: n.num(0, 5, bus.angle0)?,
                ..bus.clone()
            });
            for t in sub
                .terminals
                .iter()
                .filter(|t| t.int(0, 0, 0).ok() == Some(num) && t.int(0, 1, 0).ok() == Some(ni))
            {
                let kind = t.text(0, 2, "").chars().next().unwrap_or(' ').to_ascii_uppercase();
                let (others, id) = match kind {
                    'B' | '2' => (vec![t.int(0, 3, 0)?], t.text(0, 4, "1")),
                    '3' => (vec![t.int(0, 3, 0)?, t.int(0, 4, 0)?], t.text(0, 5, "1")),
                    _ => (Vec::new(), t.text(0, 3, "1")),
                };
                let mut others: Vec<i64> = others.into_iter().map(i64::abs).filter(|&b| b != 0).collect();
                others.sort_unstable();
                cx.terminals.insert((kind, num, others, id.trim().to_string()), node);
            }
        }
        cx.node_of.insert(num, (first, kv, ide));
    }
    let node_id = |cx: &Ctx, bus: i64, ni: i64| {
        cx.m.nodes
            .iter()
            .position(|n| n.id == format!("B{bus}-N{ni}"))
            .map(|i| NodeRef(i as u32))
    };
    let mut left_out = 0;
    for sub in &raw.substations {
        // Node numbers are local to the substation; the bus of each comes from the node records.
        let bus_of: HashMap<i64, i64> = sub
            .nodes
            .iter()
            .filter_map(|n| Some((n.int(0, 0, 0).ok()?, n.int(0, 2, 0).ok()?)))
            .collect();
        for r in &sub.switches {
            let (ni, nj) = (r.int(0, 0, 0)?, r.int(0, 1, 0)?);
            let ends = bus_of
                .get(&ni)
                .zip(bus_of.get(&nj))
                .and_then(|(&bi, &bj)| node_id(cx, bi, ni).zip(node_id(cx, bj, nj)));
            let Some((n1, n2)) = ends else {
                left_out += 1;
                continue;
            };
            cx.m.switches.push(Switch {
                id: format!(
                    "S{}-Sw-{ni}-{nj}-{}",
                    sub.header.int(0, 0, 0)?,
                    id_part(&r.text(0, 2, "1"))
                ),
                name: r.text(0, 3, ""),
                node1: n1,
                node2: n2,
                kind: if r.int(0, 4, 2)? == 2 {
                    SwitchKind::Breaker
                } else {
                    SwitchKind::Disconnector
                },
                open: r.int(0, 5, 1)? != 1,
            });
        }
    }
    let unplaced: usize = sub_nodes
        .iter()
        .filter(|(b, _)| !cx.node_of.contains_key(b))
        .map(|(_, v)| v.len())
        .sum();
    if unplaced > 0 || left_out > 0 {
        cx.notes.push(format!(
            "{unplaced} substation node(s) and {left_out} switching device(s) refer to buses or nodes that are not defined; they are left out."
        ));
    }
    if zero_kv > 0 {
        cx.notes.push(format!(
            "{zero_kv} bus(es) have no base voltage; 1 kV is used, so per-unit values carry over unchanged."
        ));
    }
    Ok(())
}

fn loads(cx: &mut Ctx, raw: &RawCase) -> Result<(), ParseError> {
    let mut zip = 0;
    for r in raw.section(Section::Load) {
        let num = r.int(0, 0, 0)?;
        let (node, _, ide) = cx.at('L', num, &[], &r.text(0, 1, "1"), r)?;
        let (pl, ql, ip, iq, yp, yq) = (
            r.num(0, 5, 0.0)?,
            r.num(0, 6, 0.0)?,
            r.num(0, 7, 0.0)?,
            r.num(0, 8, 0.0)?,
            r.num(0, 9, 0.0)?,
            r.num(0, 10, 0.0)?,
        );
        // At 1 p.u. voltage. YQ is negative for an inductive admittance (PSS/E), so it consumes −YQ.
        let p = pl + ip + yp;
        let q = ql + iq - yq;
        let share = |z: f64, i: f64, c: f64, t: f64| {
            if t != 0.0 {
                [z / t, i / t, c / t]
            } else {
                [0.0, 0.0, 1.0]
            }
        };
        if ip != 0.0 || yp != 0.0 || iq != 0.0 || yq != 0.0 {
            zip += 1;
        }
        cx.m.loads.push(Load {
            id: format!("B{num}-L{}", id_part(&r.text(0, 1, "1"))),
            name: String::new(),
            node,
            in_service: r.int(0, 2, 1)? == 1 && ide != 4,
            p,
            q,
            p_zip: share(yp, ip, pl, p),
            q_zip: share(-yq, iq, ql, q),
        });
    }
    if zip > 0 {
        cx.notes.push(format!(
            "{zip} load(s) have constant-current or constant-admittance parts; their values at 1 p.u. voltage are used."
        ));
    }
    Ok(())
}

/// A switched shunt block: steps and Mvar per step at 1 p.u. voltage.
type Block = (i64, f64);

fn shunts(cx: &mut Ctx, raw: &RawCase) -> Result<(), ParseError> {
    for r in raw.section(Section::FixedShunt) {
        let num = r.int(0, 0, 0)?;
        let (node, kv, ide) = cx.at('F', num, &[], &r.text(0, 1, "1"), r)?;
        cx.m.shunts.push(Shunt {
            id: format!("B{num}-SH{}", id_part(&r.text(0, 1, "1"))),
            name: String::new(),
            node,
            in_service: r.int(0, 2, 1)? == 1 && ide != 4,
            nominal_kv: kv,
            // GL and BL are MW and Mvar at 1 p.u. voltage.
            g_per_section: r.num(0, 3, 0.0)? / (kv * kv),
            b_per_section: r.num(0, 4, 0.0)? / (kv * kv),
            sections: 1,
            max_sections: 1,
            control: None,
            points: Vec::new(),
        });
    }
    let lay = &cx.lay;
    let (first, width) = lay.sws_block();
    let binit_at = lay.sws_binit();
    let v35 = lay.v35();
    let mut other_control = 0;
    for r in raw.section(Section::SwitchedShunt) {
        let num = r.int(0, 0, 0)?;
        let id = if v35 { id_part(&r.text(0, 1, "1")) } else { "1".into() };
        let (node, kv, ide) = cx.at('S', num, &[], &id, r)?;
        let stat_at = if v35 { 4 } else { 3 };
        let adjm = r.int(0, if v35 { 3 } else { 2 }, 0)?;
        // Blocks: (steps, Mvar per step); in version 35 each block also has a status.
        let mut blocks = Vec::new();
        for k in 0..8 {
            let base = first + k * width;
            let (status, n, b) = if v35 {
                (r.int(0, base, 1)?, r.int(0, base + 1, 0)?, r.num(0, base + 2, 0.0)?)
            } else {
                (1, r.int(0, base, 0)?, r.num(0, base + 1, 0.0)?)
            };
            if status == 1 && n > 0 && b != 0.0 {
                blocks.push((n, b));
            }
        }
        // Levels as PowSyBl builds them: reactor steps from zero, then capacitor steps, plus zero, sorted.
        let (mut reactors, mut capacitors): (Vec<Block>, Vec<Block>) = blocks.iter().partition(|(_, b)| *b < 0.0);
        if adjm == 1 {
            reactors.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
            capacitors.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
        }
        let mut levels = vec![0.0];
        let mut acc = 0.0;
        for &(n, b) in &reactors {
            for _ in 0..n {
                acc += b;
                levels.push(acc);
            }
        }
        if adjm == 1 {
            acc = 0.0;
        }
        for &(n, b) in &capacitors {
            for _ in 0..n {
                acc += b;
                levels.push(acc);
            }
        }
        levels.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let binit = r.num(0, binit_at, 0.0)?;
        let at = levels
            .iter()
            .enumerate()
            .min_by(|a, b| {
                (a.1 - binit)
                    .abs()
                    .partial_cmp(&(b.1 - binit).abs())
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .map_or(0, |(i, _)| i);
        // As section increments: the first section brings the lowest level.
        let mut prev = 0.0;
        let points: Vec<(f64, f64)> = levels
            .iter()
            .map(|&l| {
                let inc = l - prev;
                prev = l;
                (0.0, inc / (kv * kv))
            })
            .collect();
        let control = {
            let swrem = r.int(0, if v35 { 7 } else { 6 }, 0)?;
            let target_node = if swrem != 0 {
                cx.node_of.get(&swrem).map(|t| t.0).unwrap_or(node)
            } else {
                node
            };
            let (hi, lo) = (
                r.num(0, if v35 { 5 } else { 4 }, 1.0)?,
                r.num(0, if v35 { 6 } else { 5 }, 1.0)?,
            );
            let tkv = cx.m.nominal_kv(target_node);
            // MODSW 1 and 2 hold a bus voltage between VSWLO and VSWHI; 3 to 6 follow a machine's reactive power,
            // a converter or another device, which has no model yet.
            let modsw = r.int(0, if v35 { 2 } else { 1 }, 0)?;
            other_control += usize::from(modsw > 2);
            matches!(modsw, 1 | 2).then_some(VoltageControl {
                enabled: true,
                node: target_node,
                target_kv: (hi + lo) / 2.0 * tkv,
                deadband_kv: (hi - lo) * tkv,
            })
        };
        cx.m.shunts.push(Shunt {
            id: format!("B{num}-SwSH{id}"),
            name: String::new(),
            node,
            in_service: r.int(0, stat_at, 1)? == 1 && ide != 4,
            nominal_kv: kv,
            g_per_section: 0.0,
            b_per_section: 0.0,
            sections: (at + 1) as u32,
            max_sections: levels.len() as u32,
            control,
            points,
        });
    }
    if other_control > 0 {
        cx.notes.push(format!(
            "{other_control} switched shunt(s) follow a machine's reactive power or another device (MODSW 3 to 6); they stay at their stated sections."
        ));
    }
    Ok(())
}

fn generators(cx: &mut Ctx, raw: &RawCase) -> Result<(), ParseError> {
    let mut has_ref: HashMap<i64, bool> = HashMap::new();
    let mbase_at = cx.lay.gen_mbase();
    let mut step_up = 0;
    for r in raw.section(Section::Generator) {
        let num = r.int(0, 0, 0)?;
        let (node, kv, ide) = cx.at('M', num, &[], &r.text(0, 1, "1"), r)?;
        let on = r.int(0, mbase_at + 6, 1)? == 1 && ide != 4;
        let reference = ide == 3 && on && !has_ref.get(&num).copied().unwrap_or(false);
        if reference {
            has_ref.insert(num, true);
        }
        let control = match ide {
            _ if reference => MachineControl::Reference,
            2 | 3 => MachineControl::Pv,
            _ => MachineControl::Pq,
        };
        let ireg = r.int(0, 7, 0)?;
        let regulated = (ireg != 0 && ireg != num)
            .then(|| cx.node_of.get(&ireg).map(|t| t.0))
            .flatten();
        let mbase = r.num(0, mbase_at, cx.sbase)?;
        let (xt, gtap) = (r.num(0, mbase_at + 4, 0.0)?, r.num(0, mbase_at + 5, 1.0)?);
        if xt != 0.0 || gtap != 1.0 {
            step_up += 1;
        }
        cx.m.generators.push(Generator {
            id: format!("B{num}-G{}", id_part(&r.text(0, 1, "1"))),
            name: String::new(),
            node,
            in_service: on,
            control,
            p: r.num(0, 2, 0.0)?,
            q: r.num(0, 3, 0.0)?,
            v_set: r.num(0, 6, 1.0)?,
            regulated_node: regulated,
            angle: if reference {
                cx.m.nodes[node.index()].angle0
            } else {
                0.0
            },
            q_min: r.num(0, 5, -9999.0)?,
            q_max: r.num(0, 4, 9999.0)?,
            p_min: r.num(0, mbase_at + 9, 0.0)?,
            p_max: r.num(0, mbase_at + 8, 0.0)?,
            rated_mva: if mbase > 0.0 { mbase } else { cx.sbase },
            rated_kv: kv,
            participation: 0.0,
            reference_priority: 0,
            sc: MachineShortCircuit {
                xdss: r.num(0, mbase_at + 2, TYPICAL_SC.xdss)?,
                rs: r.num(0, mbase_at + 1, 0.0)?,
                ..TYPICAL_SC
            },
            dynamics: TYPICAL_DYNAMICS,
        });
    }
    if step_up > 0 {
        cx.notes.push(format!("{step_up} generator(s) state a step-up transformer (XT, GTAP) inside the generator record; it is not modelled, as in PowSyBl."));
    }
    // Slack buses without a generator in service hold their voltage with an external grid.
    let slack: Vec<(i64, NodeRef)> = cx
        .node_of
        .iter()
        .filter(|(_, v)| v.2 == 3)
        .map(|(&k, v)| (k, v.0))
        .collect();
    let mut slack = slack;
    slack.sort_by_key(|s| s.0);
    for (num, node) in slack {
        if !has_ref.get(&num).copied().unwrap_or(false) {
            let n = &cx.m.nodes[node.index()];
            cx.notes.push(format!(
                "Slack bus {num} has no generator in service; an external grid holds its voltage."
            ));
            let (v_set, angle) = (n.v0, n.angle0);
            cx.m.external_grids.push(ExternalGrid {
                id: format!("B{num}-X"),
                name: String::new(),
                node,
                in_service: true,
                v_set,
                angle,
                sk_max: 5000.0,
                sk_min: 4000.0,
                rx_max: 0.1,
                rx_min: 0.1,
                x0x1: 1.0,
                r0x0: 0.1,
            });
        }
    }
    Ok(())
}

fn limits(mva: f64, kv1: f64, kv2: f64) -> Vec<CurrentLimit> {
    if mva <= 0.0 {
        return Vec::new();
    }
    let amps = |kv: f64| mva / (3.0_f64.sqrt() * kv) * 1000.0;
    vec![
        CurrentLimit {
            end: 1,
            duration_s: None,
            amps: amps(kv1),
        },
        CurrentLimit {
            end: 2,
            duration_s: None,
            amps: amps(kv2),
        },
    ]
}

fn fixed_tap(end: u8, ratio: f64) -> RatioTap {
    RatioTap {
        end,
        table: vec![TapPoint {
            position: 0,
            ratio,
            ..Default::default()
        }],
        ..Default::default()
    }
}

fn branches(cx: &mut Ctx, raw: &RawCase) -> Result<(), ParseError> {
    let (rate_at, gi_at) = (cx.lay.branch_rate(), cx.lay.branch_gi());
    let st_at = gi_at + 4;
    let mut odd = 0;
    for r in raw.section(Section::Branch) {
        let (i, j) = (r.int(0, 0, 0)?, r.int(0, 1, 0)?.abs());
        let ckt = id_part(&r.text(0, 2, "1"));
        let ((n1, kv1, ide1), (n2, kv2, ide2)) = (cx.at('B', i, &[j], &ckt, r)?, cx.at('B', j, &[i], &ckt, r)?);
        let (rr, xx, bb) = (r.num(0, 3, 0.0)?, r.num(0, 4, 0.0)?, r.num(0, 5, 0.0)?);
        let (gi, bi, gj, bj) = (
            r.num(0, gi_at, 0.0)?,
            r.num(0, gi_at + 1, 0.0)?,
            r.num(0, gi_at + 2, 0.0)?,
            r.num(0, gi_at + 3, 0.0)?,
        );
        let in_service = r.int(0, st_at, 1)? == 1 && ide1 != 4 && ide2 != 4;
        let rate = r.num(0, rate_at, 0.0)?;
        let zb = kv1 * kv1 / cx.sbase;
        if (kv1 - kv2).abs() > 1e-9 * kv1 {
            odd += 1;
            // Per unit on each bus's own base, as the file means it: a transformer at its rated ratio.
            cx.m.transformers2.push(Transformer2 {
                id: format!("L-{i}-{j}-{ckt}"),
                name: r.text(0, 6, "").trim().to_string(),
                node1: n1,
                node2: n2,
                in_service,
                open: [false; 2],
                rated_kv1: kv1,
                rated_kv2: kv2,
                rated_mva: if rate > 0.0 { rate } else { cx.sbase },
                r: rr * zb,
                x: xx * zb,
                g1: gi / zb,
                b1: (bb / 2.0 + bi) / zb,
                g2: gj / zb,
                b2: (bb / 2.0 + bj) / zb,
                clock: 0,
                phase_shift_deg: 0.0,
                conn1: Winding::Yn,
                conn2: Winding::Yn,
                r0: rr * zb,
                x0: xx * zb,
                ratio_taps: Vec::new(),
                phase_tap: None,
                limits: limits(rate, kv1, kv2),
            });
            continue;
        }
        cx.m.lines.push(Line {
            id: format!("L-{i}-{j}-{ckt}"),
            name: if cx.lay.v35() {
                r.text(0, 6, "").trim().to_string()
            } else {
                String::new()
            },
            node1: n1,
            node2: n2,
            in_service,
            open: [false; 2],
            r: rr * zb,
            x: xx * zb,
            g1: gi / zb,
            b1: (bb / 2.0 + bi) / zb,
            g2: gj / zb,
            b2: (bb / 2.0 + bj) / zb,
            r0: 3.0 * rr * zb,
            x0: 3.0 * xx * zb,
            b0: 0.6 * bb / zb,
            length_km: r.num(0, st_at + 2, 0.0)?,
            limits: limits(rate, kv1, kv2),
        });
    }
    if odd > 0 {
        cx.notes.push(format!("{odd} branch(es) join buses of different base voltage; they are modelled as transformers at the ratio of the bases, as the per-unit data means."));
    }
    if !raw.section(Section::Branch).is_empty() {
        cx.notes
            .push("RAW files have no zero-sequence line data: lines use R0 = 3·R, X0 = 3·X, B0 = 0.6·B.".into());
    }
    Ok(())
}

fn switches(cx: &mut Ctx, raw: &RawCase) -> Result<(), ParseError> {
    for r in raw.section(Section::SwitchingDevice) {
        let (i, j) = (r.int(0, 0, 0)?, r.int(0, 1, 0)?.abs());
        let ((n1, ..), (n2, ..)) = (cx.bus(i, r)?, cx.bus(j, r)?);
        let kind = match r.int(0, 19, 2)? {
            1 => SwitchKind::Other,
            3 => SwitchKind::Disconnector,
            _ => SwitchKind::Breaker,
        };
        cx.m.switches.push(Switch {
            id: format!("Sw-{i}-{j}-{}", id_part(&r.text(0, 2, "1"))),
            name: r.text(0, 20, ""),
            node1: n1,
            node2: n2,
            kind,
            open: r.int(0, 16, 1)? != 1,
        });
    }
    Ok(())
}

/// Ratio of a winding from its WINDV, as a multiple of the bus base voltage.
fn ratio(cw: i64, windv: f64, baskv: f64, nomv: f64) -> f64 {
    let nomv = if nomv > 0.0 { nomv } else { baskv };
    match cw {
        2 => windv / baskv,
        3 => windv * nomv / baskv,
        _ => windv,
    }
}

/// Impedance between two windings, per unit on the system base.
fn pair_impedance(cz: i64, r: f64, x: f64, sbase: f64, sw: f64) -> (f64, f64) {
    let sw = if sw > 0.0 { sw } else { sbase };
    match cz {
        2 => (r * sbase / sw, x * sbase / sw),
        3 => {
            // R from the load loss (W), X from |Z|, both per unit on the winding base first.
            let rw = r / sw / 1e6;
            let xw = (x * x - rw * rw).max(0.0).sqrt();
            (rw * sbase / sw, xw * sbase / sw)
        }
        _ => (r, x),
    }
}

/// Magnetising admittance at bus I, per unit on the system base and bus I's base voltage.
fn magnetising(cm: i64, g: f64, b: f64, sbase: f64, sw: f64, baskv: f64, nomv: f64) -> (f64, f64) {
    let nomv = if nomv > 0.0 { nomv } else { baskv };
    let sw = if sw > 0.0 { sw } else { sbase };
    match cm {
        2 => {
            let g = g / (1e6 * sbase) * (baskv / nomv).powi(2);
            let y = b * (sw / sbase) * (baskv / nomv).powi(2);
            (g, -(y * y - g * g).max(0.0).sqrt())
        }
        _ => (g, b),
    }
}

/// Steps from `first` to `last` in `n` equal increments, with `stated` added as a step of its own when no step equals
/// it, so the present position reproduces the file exactly (PowSyBl does the same, though it accepts a step within
/// 1e-5). Returns the values and the index of the present one.
fn steps_through(first: f64, last: f64, n: i64, stated: f64) -> (Vec<f64>, usize) {
    let mut values: Vec<f64> = (0..n)
        .map(|k| first + (last - first) / (n - 1) as f64 * k as f64)
        .collect();
    let rising = last >= first;
    match values.iter().position(|&v| v == stated || (v > stated) == rising) {
        Some(k) if values[k] == stated => (values, k),
        Some(k) => {
            values.insert(k, stated);
            (values, k)
        }
        None => {
            values.push(stated);
            let k = values.len() - 1;
            (values, k)
        }
    }
}

/// Index of the value nearest `target`.
fn nearest(values: &[f64], target: f64) -> usize {
    values
        .iter()
        .enumerate()
        .min_by(|a, b| (a.1 - target).abs().total_cmp(&(b.1 - target).abs()))
        .map_or(0, |(k, _)| k)
}

/// The tap changers of one transformer winding: its ratio (a table over RMI…RMA when the winding controls voltage
/// or reactive power) and, for a winding that controls active power, a phase tap table over RMI…RMA degrees.
struct WindingTaps {
    ratio: RatioTap,
    phase: Option<PhaseTap>,
}

/// Reads winding `end` (1, 2 or 3) of a transformer record: WINDV, NOMV, ANG, …, COD, CONT, …, RMA, RMI, VMA, VMI,
/// NTP. `kv` is the winding's bus base voltage and `cw` the record's winding data code.
fn winding_taps(cx: &Ctx, r: &Record, end: u8, cw: i64, kv: f64) -> Result<WindingTaps, ParseError> {
    let l = usize::from(end) + 1;
    let (cod_at, rma_at) = (cx.lay.winding_cod(), cx.lay.winding_rma());
    let nomv = r.num(l, 1, 0.0)?;
    let stated = ratio(cw, r.num(l, 0, 1.0)?, kv, nomv);
    let ang = r.num(l, 2, 0.0)?;
    let cod = r.int(l, cod_at, 0)?;
    let cont = r.int(l, cod_at + 1, 0)?;
    let (rma, rmi) = (r.num(l, rma_at, 1.1)?, r.num(l, rma_at + 1, 0.9)?);
    let (vma, vmi) = (r.num(l, rma_at + 2, 1.1)?, r.num(l, rma_at + 3, 0.9)?);
    let ntp = r.int(l, rma_at + 4, 33)?;
    let mut taps = WindingTaps {
        ratio: fixed_tap(end, stated),
        phase: None,
    };
    if ntp <= 1 {
        return Ok(taps);
    }
    match cod.abs() {
        1 | 2 if ang == 0.0 => {
            let (values, at) = steps_through(ratio(cw, rmi, kv, nomv), ratio(cw, rma, kv, nomv), ntp, stated);
            // COD 1 holds the voltage of bus CONT (its own bus when CONT is 0) between VMI and VMA; COD 2 controls
            // reactive power, which has no model yet.
            let own = r.int(0, usize::from(end) - 1, 0)?.abs();
            let control = cx
                .node_of
                .get(if cont != 0 { &cont } else { &own })
                .filter(|_| cod.abs() == 1)
                .map(|b| {
                    let target = cx.m.nominal_kv(b.0);
                    VoltageControl {
                        enabled: cod > 0,
                        node: b.0,
                        target_kv: (vma + vmi) / 2.0 * target,
                        deadband_kv: (vma - vmi) * target,
                    }
                });
            taps.ratio = RatioTap {
                end,
                low: 1,
                high: values.len() as i32,
                neutral: nearest(&values, 1.0) as i32 + 1,
                step_pct: 0.0,
                position: at as i32 + 1,
                control,
                table: values
                    .iter()
                    .enumerate()
                    .map(|(k, &ratio)| TapPoint {
                        position: k as i32 + 1,
                        ratio,
                        ..Default::default()
                    })
                    .collect(),
            };
        }
        3 | 5 => {
            let (values, at) = steps_through(rmi, rma, ntp, ang);
            taps.phase = Some(PhaseTap {
                end,
                low: 1,
                high: values.len() as i32,
                neutral: nearest(&values, 0.0) as i32 + 1,
                step_deg: 0.0,
                position: at as i32 + 1,
                // VMA and VMI bound the active power flowing into the winding, MW.
                control: Some(FlowControl {
                    enabled: cod > 0,
                    target_mw: (vma + vmi) / 2.0,
                    deadband_mw: vma - vmi,
                }),
                table: values
                    .iter()
                    .enumerate()
                    .map(|(k, &angle_deg)| TapPoint {
                        position: k as i32 + 1,
                        ratio: 1.0,
                        angle_deg,
                        ..Default::default()
                    })
                    .collect(),
            });
        }
        _ => {}
    }
    Ok(taps)
}

fn transformers(cx: &mut Ctx, raw: &RawCase) -> Result<(), ParseError> {
    let cod_at = cx.lay.winding_cod();
    let sbase = cx.sbase;
    let mut controlled = 0;
    for r in raw.section(Section::Transformer) {
        let (i, j, k) = (r.int(0, 0, 0)?, r.int(0, 1, 0)?.abs(), r.int(0, 2, 0)?.abs());
        let ckt = id_part(&r.text(0, 3, "1"));
        let (cw, cz, cm) = (r.int(0, 4, 1)?, r.int(0, 5, 1)?, r.int(0, 6, 1)?);
        let (mag1, mag2) = (r.num(0, 7, 0.0)?, r.num(0, 8, 0.0)?);
        let stat = r.int(0, 11, 1)?;
        let name = r.text(0, 10, "").trim().to_string();
        let (code, others) = if k == 0 { ('2', [j, 0]) } else { ('3', [j, k]) };
        let ((n1, kv1, ide1), (n2, kv2, ide2)) = (
            cx.at(code, i, &others, &ckt, r)?,
            cx.at(code, j, &[i, others[1]], &ckt, r)?,
        );
        // Winding line fields: WINDV, NOMV, ANG, …, COD, …, RMA, RMI, VMA, VMI, NTP.
        if (1..=3).any(|l| r.int(1 + l, cod_at, 0).unwrap_or(0) != 0) {
            controlled += 1;
        }
        if k == 0 {
            let (rr, xx) = pair_impedance(cz, r.num(1, 0, 0.0)?, r.num(1, 1, 0.0)?, sbase, r.num(1, 2, sbase)?);
            let nomv1 = r.num(2, 1, 0.0)?;
            // Winding 1 carries the tap changer; winding 2's ratio is fixed.
            let taps = winding_taps(cx, r, 1, cw, kv1)?;
            let t1 = ratio(cw, r.num(2, 0, 1.0)?, kv1, nomv1);
            let t2 = ratio(cw, r.num(3, 0, 1.0)?, kv2, r.num(3, 1, 0.0)?);
            let (g, b) = magnetising(cm, mag1, mag2, sbase, r.num(1, 2, sbase)?, kv1, nomv1);
            let zb1 = kv1 * kv1 / sbase;
            let rate = r.num(2, 3, 0.0)?;
            cx.m.transformers2.push(Transformer2 {
                id: format!("T-{i}-{j}-{ckt}"),
                name,
                node1: n1,
                node2: n2,
                in_service: stat == 1 && ide1 != 4 && ide2 != 4,
                open: [false; 2],
                rated_kv1: kv1,
                rated_kv2: kv2,
                rated_mva: if rate > 0.0 { rate } else { r.num(1, 2, sbase)? },
                r: rr * zb1,
                x: xx * zb1,
                // At bus I, outside winding 1's ratio: in the model's frame, scaled by t1².
                g1: g / zb1 * t1 * t1,
                b1: b / zb1 * t1 * t1,
                g2: 0.0,
                b2: 0.0,
                clock: 0,
                // A phase-shifting winding states ANG through its phase tap.
                phase_shift_deg: if taps.phase.is_some() { 0.0 } else { r.num(2, 2, 0.0)? },
                conn1: Winding::Yn,
                conn2: Winding::Yn,
                r0: rr * zb1,
                x0: xx * zb1,
                ratio_taps: vec![taps.ratio, fixed_tap(2, t2)],
                phase_tap: taps.phase,
                limits: limits(rate, kv1, kv2),
            });
        } else {
            let (n3, kv3, ide3) = cx.at('3', k, &[i, j], &ckt, r)?;
            let s = |q: usize| r.num(1, q, sbase);
            let z12 = pair_impedance(cz, r.num(1, 0, 0.0)?, r.num(1, 1, 0.0)?, sbase, s(2)?);
            let z23 = pair_impedance(cz, r.num(1, 3, 0.0)?, r.num(1, 4, 0.0)?, sbase, s(5)?);
            let z31 = pair_impedance(cz, r.num(1, 6, 0.0)?, r.num(1, 7, 0.0)?, sbase, s(8)?);
            let star = |a: (f64, f64), b: (f64, f64), c: (f64, f64)| ((a.0 + b.0 - c.0) / 2.0, (a.1 + b.1 - c.1) / 2.0);
            let zs = [star(z12, z31, z23), star(z12, z23, z31), star(z23, z31, z12)];
            let kvs = [kv1, kv2, kv3];
            let nodes = [n1, n2, n3];
            let nomv1 = r.num(2, 1, 0.0)?;
            let (g, b) = magnetising(cm, mag1, mag2, sbase, s(2)?, kv1, nomv1);
            let mut windings = [Winding3::default(); 3];
            let mut taps = Vec::new();
            let mut phase_taps = Vec::new();
            for w in 0..3 {
                let t = ratio(cw, r.num(2 + w, 0, 1.0)?, kvs[w], r.num(2 + w, 1, 0.0)?);
                let wt = winding_taps(cx, r, w as u8 + 1, cw, kvs[w])?;
                if let Some(tap) = wt.phase {
                    phase_taps.push(tap);
                }
                let zb = kvs[w] * kvs[w] / sbase;
                let (gw, bw) = if w == 0 {
                    (g * zb.recip() * t * t, b * zb.recip() * t * t)
                } else {
                    (0.0, 0.0)
                };
                windings[w] = Winding3 {
                    node: nodes[w],
                    rated_kv: kvs[w],
                    rated_mva: s([2, 5, 8][w])?,
                    r: zs[w].0 * zb,
                    x: zs[w].1 * zb,
                    g: gw,
                    b: bw,
                    clock: 0,
                    // PSS/E: the winding's bus leads the star point by ANG; the model's shift is a lag. A
                    // phase-shifting winding states ANG through its phase tap instead.
                    phase_shift_deg: if phase_taps.iter().any(|p| usize::from(p.end) == w + 1) {
                        0.0
                    } else {
                        -r.num(2 + w, 2, 0.0)?
                    },
                    conn: Winding::Yn,
                    // STAT: 0 all out, 1 all in, 2 winding 2 out, 3 winding 3 out, 4 winding 1 out.
                    open: matches!((stat, w), (2, 1) | (3, 2) | (4, 0)),
                };
                taps.push(wt.ratio);
            }
            cx.m.transformers3.push(Transformer3 {
                id: format!("T-{i}-{j}-{k}-{ckt}"),
                name,
                windings,
                in_service: stat != 0 && ide1 != 4 && ide2 != 4 && ide3 != 4,
                ratio_taps: taps,
                phase_taps,
                limits: Vec::new(),
            });
        }
    }
    if controlled > 0 {
        cx.notes.push(format!(
            "{controlled} transformer(s) have automatic tap control (COD); taps stay at their stated positions until control is modelled (design phase 3)."
        ));
    }
    Ok(())
}

fn areas(cx: &mut Ctx, raw: &RawCase) -> Result<(), ParseError> {
    for r in raw.section(Section::Area) {
        let num = r.int(0, 0, 0)?;
        let name = r.text(0, 4, "");
        let (pdes, ptol) = (r.num(0, 2, 0.0)?, r.num(0, 3, 0.0)?);
        if let Some(a) = cx.m.areas.iter_mut().find(|a| a.id == format!("A{num}")) {
            a.name = if name.is_empty() { a.name.clone() } else { name };
            a.interchange_mw = pdes;
            a.tolerance_mw = ptol;
        } else {
            cx.m.areas.push(Area {
                id: format!("A{num}"),
                name,
                interchange_mw: pdes,
                tolerance_mw: ptol,
                control: false,
            });
        }
    }
    Ok(())
}

/// FACTS devices. A shunt device (J = 0, a STATCOM) becomes a static var compensator with ±SHMX Mvar at 1 p.u. that
/// holds VSET; a series device is not modelled yet. Fields: NAME (version 33: N), I, J, MODE, PDES, QDES, VSET, SHMX,
/// …, FCREG (version 33: REMOT) at position 19.
fn facts(cx: &mut Ctx, raw: &RawCase) -> Result<(), ParseError> {
    let (mut series, mut remote) = (0, 0);
    for r in raw.section(Section::Facts) {
        let (i, j) = (r.int(0, 1, 0)?, r.int(0, 2, 0)?);
        if j != 0 {
            series += 1;
            continue;
        }
        let name = r.text(0, 0, "").trim().to_string();
        let (node, kv, ide) = cx.at('A', i, &[], &name, r)?;
        let reg = r.int(0, 19, 0)?;
        if reg != 0 && reg != i {
            remote += 1;
        }
        let shmx = r.num(0, 7, 9999.0)?;
        let vset = r.num(0, 6, 1.0)?;
        cx.m.svcs.push(Svc {
            id: format!("FactsDevice-{name}"),
            name,
            node,
            in_service: r.int(0, 3, 1)? != 0 && ide != 4,
            nominal_kv: kv,
            b_min: -shmx / (kv * kv),
            b_max: shmx / (kv * kv),
            v_set: vset,
            regulating: vset > 0.0,
            q: r.num(0, 5, 0.0)?,
        });
    }
    if series > 0 {
        cx.notes.push(format!(
            "{series} series FACTS device(s) are not modelled yet (design phase 3)."
        ));
    }
    if remote > 0 {
        cx.notes.push(format!(
            "{remote} FACTS device(s) regulate a remote bus; they hold their own terminal voltage instead."
        ));
    }
    Ok(())
}

/// Reads and converts a RAW file.
pub fn import(text: &str, file: &str) -> Result<Imported, ParseError> {
    to_model(&crate::psse::parse(text)?, file)
}
