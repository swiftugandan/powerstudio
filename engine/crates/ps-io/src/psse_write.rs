//! Canonical model → PSS/E RAW, versions 33 and 35.
//!
//! RAW is a bus-branch format, so nodes joined by closed switches become one bus and open switches are left out. Every
//! branch is written from the engine's own per-unit conversion of its element (`ps-net`), so a file read back solves to
//! the same voltages: the ideal transformer's ratio and angle become WINDV1 and ANG1 (CW = 1, CZ = 1, CM = 1), the
//! series impedance R1-2 and X1-2, and the magnetising admittance, which the engine places behind the ideal
//! transformer, moves to bus I where PSS/E places it (divided by the ratio squared, which is exact). A shunt that a
//! RAW record has no place for (a transformer's admittance at its other end, a three-winding transformer's admittance
//! at windings 2 and 3) becomes a fixed shunt at the same bus, which is exact too. Branches with an open end get a bus
//! of their own for that end.
//!
//! Identifiers follow PowSyBl's PSS/E naming where the model's own identifiers allow it (`B12` is bus 12,
//! `B12-L1` is load 1 there, `L-1-2-1` is circuit 1 between buses 1 and 2), so a model read from RAW writes back
//! with its own numbers. Anything else gets fresh bus numbers and identifiers; the export report says what was
//! approximated or left out.

use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;

use ps_model::{Class, MachineControl, Model, NodeRef, Transformer2, Transformer3};
use ps_net::{TransformerOptions, TransformerPu, line_pu, shunt_admittance, transformer2_pu, transformer3_winding_pu};
use ps_num::C64;
use ps_topology::{Outages, Topology};

/// Export settings.
#[derive(Debug, Clone, Default)]
pub struct Options {
    /// Format version: 33 or 35.
    pub rev: u32,
    /// Bus voltages to write, per node (magnitude p.u., angle degrees); the nodes' stored values otherwise.
    pub voltages: Option<Vec<Option<(f64, f64)>>>,
}

/// A written RAW file.
#[derive(Debug, Clone)]
pub struct Written {
    /// The file.
    pub text: String,
    /// RAW bus number of every node (`None` for removed nodes).
    pub bus_of_node: Vec<Option<i64>>,
    /// What the export approximated or left out, in plain words.
    pub notes: Vec<String>,
}

const DEG: f64 = 180.0 / std::f64::consts::PI;

/// A number as RAW wants it: plain decimal, shortest exact form.
fn n(x: f64) -> String {
    if x == 0.0 || !x.is_finite() {
        "0".into()
    } else {
        format!("{x}")
    }
}

/// Text in plain ASCII, as RAW files are read by tools that expect it: accented Latin letters lose their accents,
/// anything else becomes `?`; quotes and control characters are dropped.
fn ascii(s: &str) -> String {
    s.chars()
        .filter(|c| !matches!(c, '\'' | '"') && !c.is_control())
        .map(|c| match c {
            c if c.is_ascii() => c,
            'À'..='Å' => 'A',
            'à'..='å' => 'a',
            'Ç' => 'C',
            'ç' => 'c',
            'È'..='Ë' => 'E',
            'è'..='ë' => 'e',
            'Ì'..='Ï' => 'I',
            'ì'..='ï' => 'i',
            'Ñ' => 'N',
            'ñ' => 'n',
            'Ò'..='Ö' | 'Ø' => 'O',
            'ò'..='ö' | 'ø' => 'o',
            'Ù'..='Ü' => 'U',
            'ù'..='ü' => 'u',
            'Ý' => 'Y',
            'ý' | 'ÿ' => 'y',
            'ß' => 's',
            _ => '?',
        })
        .collect()
}

/// A quoted string, at most `max` characters.
fn q(s: &str, max: usize) -> String {
    format!("'{}'", ascii(s).chars().take(max).collect::<String>())
}

/// Identifiers of up to two characters, unique within a scope (a bus, a bus pair).
#[derive(Default)]
struct Ids {
    used: HashMap<String, HashSet<String>>,
}

impl Ids {
    /// `wanted` if it fits and is free in `scope`, otherwise the first free of 1…99, A1…Z9.
    fn take(&mut self, scope: String, wanted: Option<&str>) -> String {
        let used = self.used.entry(scope).or_default();
        if let Some(w) = wanted
            .map(str::trim)
            .filter(|w| !w.is_empty() && w.chars().count() <= 2)
            && used.insert(w.to_string())
        {
            return w.to_string();
        }
        let fresh = (1..=99)
            .map(|k| k.to_string())
            .chain(('A'..='Z').flat_map(|c| (1..=9).map(move |k| format!("{c}{k}"))))
            .find(|c| !used.contains(c))
            .unwrap_or_else(|| "ZZ".into());
        used.insert(fresh.clone());
        fresh
    }
}

/// The part of `id` after `prefix` (and a bus number), as in `B12-L1` → `1` for prefix `L`.
fn suffix<'a>(id: &'a str, prefix: &str) -> Option<&'a str> {
    let rest = id.strip_prefix('B')?;
    let (num, tail) = rest.split_once('-')?;
    num.parse::<i64>().ok()?;
    tail.strip_prefix(prefix)
}

/// Circuit identifier of `L-1-2-1` or `T-4-7-1` (`T-1-2-3-1` for three windings).
fn circuit(id: &str) -> Option<&str> {
    let mut parts = id.split('-');
    let kind = parts.next()?;
    if kind != "L" && kind != "T" {
        return None;
    }
    let rest: Vec<&str> = parts.collect();
    let (ckt, nums) = rest.split_last()?;
    nums.iter().all(|p| p.parse::<i64>().is_ok()).then_some(*ckt)
}

/// Bus number named by a node identifier: `B12` or `B12-N3` (a node of bus 12's substation).
fn named_bus(id: &str) -> Option<i64> {
    let rest = id.strip_prefix('B')?;
    let num = rest
        .split_once("-N")
        .map_or(rest, |(b, node)| node.parse::<u32>().map_or("", |_| b));
    num.parse::<i64>().ok().filter(|&b| b > 0 && b < 1_000_000)
}

struct Bus {
    number: i64,
    name: String,
    kv: f64,
    nodes: Vec<u32>,
    energised: bool,
    area: i64,
    v: (f64, f64),
    limits: (f64, f64),
}

struct Writer<'a> {
    m: &'a Model,
    rev: u32,
    sb: f64,
    buses: Vec<Bus>,
    /// Bus index of every node.
    group: Vec<Option<usize>>,
    ids: Ids,
    notes: Vec<String>,
    counts: HashMap<&'static str, usize>,
    extra_shunts: Vec<String>,
}

impl Writer<'_> {
    fn v35(&self) -> bool {
        self.rev >= 35
    }

    fn count(&mut self, what: &'static str) {
        *self.counts.entry(what).or_default() += 1;
    }

    fn bus(&self, node: NodeRef) -> Option<&Bus> {
        self.group.get(node.index()).copied().flatten().map(|g| &self.buses[g])
    }

    fn num(&self, node: NodeRef) -> i64 {
        self.bus(node).map_or(0, |b| b.number)
    }

    fn kv(&self, node: NodeRef) -> f64 {
        self.bus(node).map_or(1.0, |b| b.kv)
    }

    /// A bus standing for an open branch end, at the base voltage of the node it was cut from.
    fn open_end(&mut self, node: NodeRef, label: String) -> usize {
        let kv = self.kv(node);
        let next = self.buses.iter().map(|b| b.number).max().unwrap_or(0) + 1;
        let area = self.bus(node).map_or(1, |b| b.area);
        self.buses.push(Bus {
            number: next,
            name: label,
            kv,
            nodes: Vec::new(),
            energised: false,
            area,
            v: (1.0, 0.0),
            limits: (1.1, 0.9),
        });
        self.buses.len() - 1
    }

    /// Bus number of a branch end: its node's bus, or a bus of its own when the end is open.
    fn end(&mut self, node: NodeRef, open: bool, label: impl FnOnce() -> String) -> i64 {
        if open {
            self.count("open branch end(s) written as a bus of their own");
            let b = self.open_end(node, label());
            self.buses[b].number
        } else {
            self.num(node)
        }
    }

    /// A shunt admittance (p.u. on the bus base) that a branch record cannot hold, as a fixed shunt at that bus.
    fn extra_shunt(&mut self, bus: i64, y: C64, in_service: bool) {
        if y == C64::ZERO {
            return;
        }
        let id = self.ids.take(format!("F{bus}"), None);
        self.extra_shunts.push(format!(
            "{bus},{},{},{},{}",
            q(&id, 2),
            u8::from(in_service),
            n(y.re * self.sb),
            n(y.im * self.sb)
        ));
        self.count("branch admittance(s) without a place in their RAW record written as fixed shunts at the same bus");
    }
}

/// Writes a model as a RAW file.
pub fn write(m: &Model, opt: &Options) -> Result<Written, String> {
    let rev = if opt.rev == 0 { 35 } else { opt.rev };
    if rev != 33 && rev != 35 {
        return Err(format!("PowerStudio writes PSS/E RAW versions 33 and 35, not {rev}"));
    }
    let mut w = Writer {
        m,
        rev,
        sb: m.meta.base_mva,
        buses: Vec::new(),
        group: vec![None; m.nodes.len()],
        ids: Ids::default(),
        notes: Vec::new(),
        counts: HashMap::new(),
        extra_shunts: Vec::new(),
    };
    buses(&mut w, opt);
    let mut out = String::new();
    let (title, second) = (m.meta.name.as_str(), m.meta.description.as_str());
    let _ = writeln!(
        out,
        "0, {}, {rev}, 0, 0, {}     / PSS/E {rev} RAW written by PowerStudio",
        n(w.sb),
        n(m.meta.frequency_hz)
    );
    for line in [title, second.lines().next().unwrap_or("")] {
        let _ = writeln!(out, "{}", ascii(line).chars().take(60).collect::<String>());
    }
    let order: &[&str] = if rev >= 35 {
        &[
            "SYSTEM-WIDE",
            "BUS",
            "LOAD",
            "FIXED SHUNT",
            "GENERATOR",
            "BRANCH",
            "SYSTEM SWITCHING DEVICE",
            "TRANSFORMER",
            "AREA",
            "TWO-TERMINAL DC",
            "VOLTAGE SOURCE CONVERTER",
            "IMPEDANCE CORRECTION",
            "MULTI-TERMINAL DC",
            "MULTI-SECTION LINE",
            "ZONE",
            "INTER-AREA TRANSFER",
            "OWNER",
            "FACTS CONTROL DEVICE",
            "SWITCHED SHUNT",
            "GNE DEVICE",
            "INDUCTION MACHINE",
            "SUBSTATION",
        ]
    } else {
        &[
            "BUS",
            "LOAD",
            "FIXED SHUNT",
            "GENERATOR",
            "BRANCH",
            "TRANSFORMER",
            "AREA",
            "TWO-TERMINAL DC",
            "VOLTAGE SOURCE CONVERTER",
            "IMPEDANCE CORRECTION",
            "MULTI-TERMINAL DC",
            "MULTI-SECTION LINE",
            "ZONE",
            "INTER-AREA TRANSFER",
            "OWNER",
            "FACTS CONTROL DEVICE",
            "SWITCHED SHUNT",
            "GNE DEVICE",
            "INDUCTION MACHINE",
        ]
    };
    // Branches first: they may add buses (open ends) and fixed shunts.
    let branch = branches(&mut w);
    let transformer = transformers(&mut w);
    let mut sections: HashMap<&str, Vec<String>> = HashMap::new();
    sections.insert("LOAD", loads(&mut w));
    sections.insert("GENERATOR", generators(&mut w));
    let (fixed, switched) = shunts(&mut w);
    let mut fixed = fixed;
    fixed.append(&mut w.extra_shunts);
    sections.insert("FIXED SHUNT", fixed);
    sections.insert("SWITCHED SHUNT", switched);
    sections.insert("FACTS CONTROL DEVICE", facts(&mut w));
    sections.insert("AREA", areas(&w));
    sections.insert("BRANCH", branch);
    sections.insert("TRANSFORMER", transformer);
    sections.insert("BUS", bus_records(&w));
    for (k, name) in order.iter().enumerate() {
        for line in sections.get(name).into_iter().flatten() {
            let _ = writeln!(out, "{line}");
        }
        match order.get(k + 1) {
            Some(next) => {
                let _ = writeln!(out, "0 / END OF {name} DATA, BEGIN {next} DATA");
            }
            None => {
                let _ = writeln!(out, "0 / END OF {name} DATA");
            }
        }
    }
    let _ = writeln!(out, "Q");
    let mut bus_of_node = vec![None; m.nodes.len()];
    for (k, g) in w.group.iter().enumerate() {
        bus_of_node[k] = g.map(|g| w.buses[g].number);
    }
    let mut notes = std::mem::take(&mut w.notes);
    let mut counted: Vec<(&&str, &usize)> = w.counts.iter().collect();
    counted.sort();
    notes.extend(counted.into_iter().map(|(what, k)| format!("{k} {what}.")));
    Ok(Written {
        text: out,
        bus_of_node,
        notes,
    })
}

fn buses(w: &mut Writer, opt: &Options) {
    let m = w.m;
    // Nodes joined by closed switches form one bus.
    let mut parent: Vec<usize> = (0..m.nodes.len()).collect();
    fn root(parent: &mut [usize], mut x: usize) -> usize {
        while parent[x] != x {
            parent[x] = parent[parent[x]];
            x = parent[x];
        }
        x
    }
    let mut closed = 0;
    for (k, s) in m.switches.iter().enumerate() {
        if !m.alive(Class::Switch, k) || s.open {
            continue;
        }
        closed += 1;
        let (a, b) = (root(&mut parent, s.node1.index()), root(&mut parent, s.node2.index()));
        if a != b {
            parent[a.max(b)] = a.min(b);
        }
    }
    if !m.switches.is_empty() {
        w.notes.push(format!(
            "{} switch(es): closed ones join their nodes into one bus ({closed}), open ones are left out; RAW is a bus-branch format.",
            m.switches.len()
        ));
    }
    let topo = Topology::build(m, &Outages::none());
    let mut index: HashMap<usize, usize> = HashMap::new();
    for k in 0..m.nodes.len() {
        if !m.alive(Class::Node, k) {
            continue;
        }
        let r = root(&mut parent, k);
        let g = *index.entry(r).or_insert_with(|| {
            let node = &m.nodes[k];
            let v = opt
                .voltages
                .as_ref()
                .and_then(|vs| vs.get(k).copied().flatten())
                .unwrap_or((if node.v0 > 0.0 { node.v0 } else { 1.0 }, node.angle0));
            w.buses.push(Bus {
                number: 0,
                name: if node.name.is_empty() {
                    node.id.clone()
                } else {
                    node.name.clone()
                },
                kv: node.nominal_kv,
                nodes: Vec::new(),
                energised: false,
                area: node.area.map_or(1, |a| {
                    m.areas
                        .get(a as usize)
                        .and_then(|ar| ar.id.strip_prefix('A')?.parse().ok())
                        .unwrap_or(i64::from(a) + 1)
                }),
                v,
                limits: (node.v_max, node.v_min),
            });
            w.buses.len() - 1
        });
        w.group[k] = Some(g);
        w.buses[g].nodes.push(k as u32);
        if topo.node_bus.get(k).copied().flatten().is_some() {
            w.buses[g].energised = true;
        }
    }
    // Bus numbers: the one a node's identifier names when unique, otherwise fresh numbers above them all.
    let named: Vec<Option<i64>> = w
        .buses
        .iter()
        .map(|b| b.nodes.first().and_then(|&n| named_bus(&m.nodes[n as usize].id)))
        .collect();
    let mut taken = HashSet::new();
    let mut next = named.iter().flatten().max().copied().unwrap_or(0) + 1;
    for (b, number) in w.buses.iter_mut().zip(named) {
        b.number = match number {
            Some(x) if taken.insert(x) => x,
            _ => {
                let x = next;
                next += 1;
                taken.insert(x);
                x
            }
        };
    }
}

fn bus_records(w: &Writer) -> Vec<String> {
    let m = w.m;
    // Type: 3 where a reference machine or an external grid holds the angle, 2 where a machine holds the voltage, 4
    // for buses without supply.
    let mut kind: HashMap<i64, i64> = HashMap::new();
    let topo_promoted: HashSet<u32> = Topology::build(m, &Outages::none()).promoted.into_iter().collect();
    for (k, g) in m.generators.iter().enumerate() {
        if !m.alive(Class::Generator, k) || !g.in_service {
            continue;
        }
        let t = match g.control {
            _ if topo_promoted.contains(&(k as u32)) => 3,
            MachineControl::Reference => 3,
            MachineControl::Pv => 2,
            MachineControl::Pq => 1,
        };
        let e = kind.entry(w.num(g.node)).or_insert(1);
        *e = (*e).max(t);
    }
    for (k, x) in m.external_grids.iter().enumerate() {
        if m.alive(Class::ExternalGrid, k) && x.in_service {
            kind.insert(w.num(x.node), 3);
        }
    }
    // A swing bus's angle is the angle its reference machine (named or chosen by the topology) or grid holds.
    let mut swing_angle: HashMap<i64, f64> = HashMap::new();
    for (k, g) in m.generators.iter().enumerate() {
        let reference = g.control == MachineControl::Reference || topo_promoted.contains(&(k as u32));
        if m.alive(Class::Generator, k) && g.in_service && reference {
            swing_angle.entry(w.num(g.node)).or_insert(g.angle);
        }
    }
    for (k, x) in m.external_grids.iter().enumerate() {
        if m.alive(Class::ExternalGrid, k) && x.in_service {
            swing_angle.entry(w.num(x.node)).or_insert(x.angle);
        }
    }
    let name_max = 12;
    let mut out: Vec<(i64, String)> = w
        .buses
        .iter()
        .map(|b| {
            let ide = if b.energised {
                kind.get(&b.number).copied().unwrap_or(1)
            } else {
                4
            };
            let va = swing_angle
                .get(&b.number)
                .copied()
                .filter(|_| ide == 3)
                .unwrap_or(b.v.1);
            // A missing limit (zero or unbounded) is written as PSS/E's default.
            let (vmax, vmin) = b.limits;
            let (vmax, vmin) = (
                if vmax > 0.0 && vmax < 10.0 { vmax } else { 1.1 },
                if vmin > 0.0 && vmin < 10.0 { vmin } else { 0.9 },
            );
            (
                b.number,
                format!(
                    "{},{},{},{ide},{},1,1,{},{},{},{},{},{}",
                    b.number,
                    q(&b.name, name_max),
                    n(b.kv),
                    b.area,
                    n(b.v.0),
                    n(va),
                    n(vmax),
                    n(vmin),
                    n(vmax),
                    n(vmin)
                ),
            )
        })
        .collect();
    out.sort_by_key(|(k, _)| *k);
    out.into_iter().map(|(_, s)| s).collect()
}

fn loads(w: &mut Writer) -> Vec<String> {
    let m = w.m;
    let mut out = Vec::new();
    for (k, l) in m.loads.iter().enumerate() {
        if !m.alive(Class::Load, k) {
            continue;
        }
        let bus = w.num(l.node);
        let id = w.ids.take(format!("L{bus}"), suffix(&l.id, "L"));
        // Shares are [admittance, current, power] at 1 p.u.; PSS/E's YQ is negative for an inductive load.
        let (p, qq) = (l.p, l.q);
        let area = w.bus(l.node).map_or(1, |b| b.area);
        let mut line = format!(
            "{bus},{},{},{area},1,{},{},{},{},{},{},1,1,0",
            q(&id, 2),
            u8::from(l.in_service),
            n(p * l.p_zip[2]),
            n(qq * l.q_zip[2]),
            n(p * l.p_zip[1]),
            n(qq * l.q_zip[1]),
            n(p * l.p_zip[0]),
            n(-qq * l.q_zip[0])
        );
        if w.v35() {
            line.push_str(",0,0,0,''");
        }
        out.push(line);
    }
    out
}

fn generators(w: &mut Writer) -> Vec<String> {
    let m = w.m;
    let mut out = Vec::new();
    let v35 = w.v35();
    let record = |bus: i64, id: &str, f: [f64; 6], ireg: i64, mbase: f64, z: (f64, f64), on: bool, pt: f64, pb: f64| {
        let [pg, qg, qt, qb, vs, rmpct] = f;
        let nreg = if v35 { ",0" } else { "" };
        let baslod = if v35 { ",0" } else { "" };
        format!(
            "{bus},{},{},{},{},{},{},{ireg}{nreg},{},{},{},0,0,1,{},{},{},{}{baslod},1,1,0,1,0,1,0,1,0,1",
            q(id, 2),
            n(pg),
            n(qg),
            n(qt),
            n(qb),
            n(vs),
            n(mbase),
            n(z.0),
            n(z.1),
            u8::from(on),
            n(rmpct),
            n(pt),
            n(pb)
        )
    };
    // The voltage a bus is held at: its first voltage-holding machine's set point. PSS/E has one per bus, and a machine
    // with fixed reactive output on such a bus is one whose limits pin it there (QT = QB = QG).
    let mut held: HashMap<i64, f64> = HashMap::new();
    for (k, g) in m.generators.iter().enumerate() {
        if m.alive(Class::Generator, k) && g.in_service && g.control != MachineControl::Pq {
            held.entry(w.num(g.node)).or_insert(g.v_set);
        }
    }
    for (k, g) in m.generators.iter().enumerate() {
        if !m.alive(Class::Generator, k) {
            continue;
        }
        let bus = w.num(g.node);
        let id = w.ids.take(format!("G{bus}"), suffix(&g.id, "G"));
        let ireg = g.regulated_node.filter(|r| *r != g.node).map_or(0, |r| w.num(r));
        let (vs, qt, qb) = match held.get(&bus) {
            Some(&v) if g.control == MachineControl::Pq => {
                w.count("machine(s) with fixed reactive output on a voltage-controlled bus written with QT = QB = QG");
                (v, g.q, g.q)
            }
            _ => (g.v_set, g.q_max, g.q_min),
        };
        out.push(record(
            bus,
            &id,
            [g.p, g.q, qt, qb, vs, 100.0],
            ireg,
            g.rated_mva,
            (g.sc.rs, g.sc.xdss),
            g.in_service,
            g.p_max,
            g.p_min,
        ));
    }
    for (k, x) in m.external_grids.iter().enumerate() {
        if !m.alive(Class::ExternalGrid, k) {
            continue;
        }
        let bus = w.num(x.node);
        let id = w.ids.take(format!("G{bus}"), Some("X"));
        // The grid's short-circuit power as the machine's subtransient reactance on the system base.
        let xs = if x.sk_max > 0.0 { w.sb / x.sk_max } else { 0.0 };
        out.push(record(
            bus,
            &id,
            [0.0, 0.0, 9999.0, -9999.0, x.v_set, 100.0],
            0,
            w.sb,
            (xs * x.rx_max, xs),
            x.in_service,
            9999.0,
            -9999.0,
        ));
        w.count("external grid(s) written as generators holding the bus voltage");
    }
    out
}

/// Shunts: one section or none as fixed shunts, switchable ones as switched shunts with their levels as blocks.
fn shunts(w: &mut Writer) -> (Vec<String>, Vec<String>) {
    let m = w.m;
    let (mut fixed, mut switched) = (Vec::new(), Vec::new());
    let mut switched_at: HashSet<i64> = HashSet::new();
    for (k, s) in m.shunts.iter().enumerate() {
        if !m.alive(Class::Shunt, k) {
            continue;
        }
        let bus = w.num(s.node);
        let kv2 = w.kv(s.node).powi(2);
        let y = shunt_admittance(s);
        let switchable = !s.points.is_empty() || s.max_sections > 1 || s.control.is_some();
        // Version 33 holds one switched shunt per bus.
        if !switchable || (!w.v35() && !switched_at.insert(bus)) {
            if switchable {
                w.count("switched shunt(s) beyond the first at a bus written as fixed shunts (version 33 allows one per bus)");
            }
            let id = w.ids.take(format!("F{bus}"), suffix(&s.id, "SH"));
            fixed.push(format!(
                "{bus},{},{},{},{}",
                q(&id, 2),
                u8::from(s.in_service),
                n(y.re * kv2),
                n(y.im * kv2)
            ));
            continue;
        }
        // Levels reachable from zero, in Mvar at 1 p.u.: reactor steps below zero, capacitor steps above.
        let steps: Vec<C64> = if s.points.is_empty() {
            vec![C64::new(s.g_per_section, s.b_per_section); s.max_sections as usize]
        } else {
            s.points.iter().map(|&(g, b)| C64::new(g, b)).collect()
        };
        if steps.iter().any(|c| c.re != 0.0) {
            // RAW switched shunts have no conductance: the present one goes in a fixed shunt beside it.
            let id = w.ids.take(format!("F{bus}"), None);
            fixed.push(format!(
                "{bus},{},{},{},0",
                q(&id, 2),
                u8::from(s.in_service),
                n(y.re * kv2)
            ));
            w.count("switched shunt(s) with conductance written with a fixed shunt for its present value");
        }
        let mut levels = vec![0.0];
        let mut acc = 0.0;
        for c in &steps {
            acc += c.im * kv2;
            levels.push(acc);
        }
        levels.sort_by(f64::total_cmp);
        levels.dedup();
        let blocks = blocks(&levels);
        if blocks.len() > 8 {
            w.count("switched shunt(s) with more than eight distinct steps cut to eight blocks");
        }
        let control = s
            .control
            .filter(|c| c.enabled && c.target_kv - c.deadband_kv / 2.0 > 0.0);
        let (modsw, hi, lo, rem) = match control {
            Some(c) => {
                let kv = m.nominal_kv(c.node);
                let rem = if c.node == s.node { 0 } else { w.num(c.node) };
                (
                    1,
                    (c.target_kv + c.deadband_kv / 2.0) / kv,
                    (c.target_kv - c.deadband_kv / 2.0) / kv,
                    rem,
                )
            }
            None => (0, 1.0, 1.0, 0),
        };
        let mut line = format!("{bus}");
        if w.v35() {
            let id = w.ids.take(format!("S{bus}"), suffix(&s.id, "SwSH"));
            let _ = write!(line, ",{}", q(&id, 2));
        }
        let _ = write!(line, ",{modsw},0,{},{},{},{rem}", u8::from(s.in_service), n(hi), n(lo));
        if w.v35() {
            line.push_str(",0");
        }
        let _ = write!(line, ",100,'',{}", n(y.im * kv2));
        for (count, mvar) in blocks.iter().take(8) {
            if w.v35() {
                let _ = write!(line, ",1,{count},{}", n(*mvar));
            } else {
                let _ = write!(line, ",{count},{}", n(*mvar));
            }
        }
        switched.push(line);
    }
    (fixed, switched)
}

/// Blocks (steps, Mvar per step) that reach `levels` from zero in PSS/E's order: reactor steps down from zero, then
/// capacitor steps up from zero, equal consecutive steps merged.
fn blocks(levels: &[f64]) -> Vec<(usize, f64)> {
    let mut out: Vec<(usize, f64)> = Vec::new();
    let mut push = |step: f64| match out.last_mut() {
        Some((count, b)) if (*b - step).abs() <= 1e-9 * step.abs().max(1.0) => *count += 1,
        _ => out.push((1, step)),
    };
    let negative: Vec<f64> = levels.iter().copied().filter(|&l| l < 0.0).rev().collect();
    let mut prev = 0.0;
    for l in negative {
        push(l - prev);
        prev = l;
    }
    prev = 0.0;
    for &l in levels.iter().filter(|&&l| l > 0.0) {
        push(l - prev);
        prev = l;
    }
    out
}

fn facts(w: &mut Writer) -> Vec<String> {
    let m = w.m;
    let mut out = Vec::new();
    // Names identify FACTS devices (12 characters); PowSyBl prefixes them with `FactsDevice-` on import.
    let mut used: HashSet<String> = HashSet::new();
    let mut name_of = |id: &str| {
        let base: String = ascii(id.strip_prefix("FactsDevice-").unwrap_or(id))
            .chars()
            .take(12)
            .collect();
        let mut name = base.clone();
        let mut k = 1;
        while !used.insert(name.clone()) {
            let tag = format!("_{k}");
            name = base.chars().take(12 - tag.len()).collect::<String>() + &tag;
            k += 1;
        }
        name
    };
    for (k, c) in m.svcs.iter().enumerate() {
        if !m.alive(Class::Svc, k) {
            continue;
        }
        let bus = w.num(c.node);
        let kv2 = w.kv(c.node).powi(2);
        let shmx = c.b_max.abs().max(c.b_min.abs()) * kv2;
        if (c.b_max + c.b_min).abs() > 1e-12 * c.b_max.abs().max(1.0) {
            w.count("static var compensator(s) with an asymmetric range written with ±the larger limit (a RAW STATCOM is symmetric)");
        }
        let vset = if c.regulating { c.v_set } else { 0.0 };
        out.push(format!(
            "{},{bus},0,{},0,{},{},{},0,0.9,1.1,1,0,0.05,100,1,0,0,0,0,''",
            q(&name_of(&c.id), 12),
            u8::from(c.in_service),
            n(c.q),
            n(vset),
            n(shmx)
        ));
    }
    out
}

fn areas(w: &Writer) -> Vec<String> {
    w.m.areas
        .iter()
        .enumerate()
        .filter(|(k, _)| w.m.alive(Class::Area, *k))
        .map(|(k, a)| {
            let num =
                a.id.strip_prefix('A')
                    .and_then(|x| x.parse::<i64>().ok())
                    .unwrap_or(k as i64 + 1);
            format!(
                "{num},0,{},{},{}",
                n(a.interchange_mw),
                n(a.tolerance_mw),
                q(&a.name, 12)
            )
        })
        .collect()
}

/// Rating in MVA of a permanent current limit at end `end`, at `kv`.
fn rating(limits: &[ps_model::CurrentLimit], end: u8, kv: f64) -> f64 {
    limits
        .iter()
        .filter(|l| l.end == end && l.duration_s.is_none())
        .map(|l| 3.0_f64.sqrt() * kv * l.amps / 1000.0)
        .fold(0.0, f64::max)
}

/// Fields of a RAW branch's ratings: RATEA, RATEB, RATEC (version 33) or RATE1…RATE12 (version 35).
fn ratings(v35: bool, mva: f64) -> String {
    let k = if v35 { 12 } else { 3 };
    std::iter::once(n(mva))
        .chain(std::iter::repeat_n("0".to_string(), k - 1))
        .collect::<Vec<_>>()
        .join(",")
}

fn branches(w: &mut Writer) -> Vec<String> {
    let m = w.m;
    let mut out = Vec::new();
    for (k, l) in m.lines.iter().enumerate() {
        // Lines between buses of different base voltage go with the transformers.
        if !m.alive(Class::Line, k) || across_voltages(w, k) {
            continue;
        }
        let i = w.end(l.node1, l.open[0], || format!("{}.end1", l.id));
        let j = w.end(l.node2, l.open[1], || format!("{}.end2", l.id));
        let (kvf, kvt) = (w.kv(l.node1), w.kv(l.node2));
        let p = line_pu(l, kvf, kvt, w.sb, ps_net::Seq::Positive);
        let ckt = w.ids.take(format!("{}-{}", i.min(j), i.max(j)), circuit(&l.id));
        let rate = rating(&l.limits, 1, kvf);
        let (yf, yt) = (p.y_from, p.y_to);
        // Charging split evenly where both ends carry it; the rest as end shunts.
        let b = if yf.im > 0.0 && yt.im > 0.0 {
            2.0 * yf.im.min(yt.im)
        } else {
            0.0
        };
        let name = if w.v35() {
            format!(",{}", q(&l.name, 40))
        } else {
            String::new()
        };
        out.push(format!(
            "{i},{j},{},{},{},{}{name},{},{},{},{},{},{},1,{},1,1",
            q(&ckt, 2),
            n(p.z.re),
            n(p.z.im),
            n(b),
            ratings(w.v35(), rate),
            n(yf.re),
            n(yf.im - b / 2.0),
            n(yt.re),
            n(yt.im - b / 2.0),
            u8::from(l.in_service),
            n(l.length_km)
        ));
    }
    out
}

/// Whether line `k` joins buses of different base voltage: RAW then needs a transformer at the ratio of the bases,
/// which is what the per-unit data mean.
fn across_voltages(w: &Writer, k: usize) -> bool {
    let l = &w.m.lines[k];
    let (a, b) = (w.kv(l.node1), w.kv(l.node2));
    (a - b).abs() > 1e-12 * a.max(b)
}

/// A two-winding record from a branch's per-unit form: ideal ratio and angle at bus I, magnetising admittance moved to
/// bus I, the admittance at bus J as a fixed shunt there.
#[allow(clippy::too_many_arguments)]
fn out_transformer(
    w: &mut Writer,
    out: &mut Vec<String>,
    name: &str,
    i: i64,
    j: i64,
    ckt: &str,
    p: &TransformerPu,
    on: bool,
    rate: f64,
    control: Option<String>,
) {
    let mag = p.y_from.scale(1.0 / (p.ratio * p.ratio));
    w.extra_shunt(j, p.y_to, on);
    let name_max = if w.v35() { 40 } else { 12 };
    let mut head = format!(
        "{i},{j},0,{},1,1,1,{},{},2,{},{},1,1,0,1,0,1,0,1,''",
        q(ckt, 2),
        n(mag.re),
        n(mag.im),
        q(name, name_max),
        u8::from(on)
    );
    if w.v35() {
        head.push_str(",0");
    }
    let rates = ratings(w.v35(), rate);
    let tail = control.unwrap_or_else(|| {
        let node = if w.v35() { ",0" } else { "" };
        format!("0,0{node},1.1,0.9,1.1,0.9,33,0,0,0,0")
    });
    out.push(head);
    out.push(format!("{},{},{}", n(p.z.re), n(p.z.im), n(w.sb)));
    out.push(format!("{},0,{},{rates},{tail}", n(p.ratio), n(p.shift * DEG)));
    out.push("1,0".into());
}

/// Tap range and control of winding 1 for a RAW record: COD, CONT, (NODE,) RMA, RMI, VMA, VMI, NTP, TAB, CR, CX, CNXA.
fn tap_fields(w: &mut Writer, t: &Transformer2, vh: f64, vl: f64) -> Option<String> {
    let node = if w.v35() { ",0" } else { "" };
    let sb = w.sb;
    let at = |pos: Option<i32>, phase: Option<i32>| {
        let mut c = t.clone();
        if let (Some(p), Some(tap)) = (
            pos,
            c.ratio_taps.iter_mut().find(|r| r.table.len() > 1 || r.high > r.low),
        ) {
            tap.position = p;
        }
        if let (Some(p), Some(tap)) = (phase, c.phase_tap.as_mut()) {
            tap.position = p;
        }
        transformer2_pu(&c, vh, vl, sb, TransformerOptions::default())
    };
    if let Some(tap) = t.phase_tap.as_ref().filter(|p| p.high > p.low) {
        let angles: Vec<f64> = (tap.low..=tap.high).map(|p| at(None, Some(p)).shift * DEG).collect();
        let (lo, hi) = angles
            .iter()
            .fold((f64::MAX, f64::MIN), |(a, b), &x| (a.min(x), b.max(x)));
        let (cod, vma, vmi) = match tap.control {
            Some(c) => (
                if c.enabled { 3 } else { -3 },
                c.target_mw + c.deadband_mw / 2.0,
                c.target_mw - c.deadband_mw / 2.0,
            ),
            None => (0, 0.0, 0.0),
        };
        if t.ratio_taps.iter().any(|r| r.table.len() > 1 || r.high > r.low) {
            w.count("transformer(s) with both ratio and phase tap changers written with the phase range only (one controlled winding)");
        }
        return Some(format!(
            "{cod},0{node},{},{},{},{},{},0,0,0,0",
            n(hi),
            n(lo),
            n(vma),
            n(vmi),
            angles.len()
        ));
    }
    let tap = t.ratio_taps.iter().find(|r| r.table.len() > 1 || r.high > r.low)?;
    let ratios: Vec<f64> = (tap.low..=tap.high).map(|p| at(Some(p), None).ratio).collect();
    let (lo, hi) = ratios
        .iter()
        .fold((f64::MAX, f64::MIN), |(a, b), &x| (a.min(x), b.max(x)));
    if tap.table.iter().any(|p| p.r_pct != 0.0 || p.x_pct != 0.0) {
        w.count("tap changer(s) whose impedance varies with position written without the variation (RAW needs an impedance correction table)");
    }
    // A control without a usable voltage band (a disabled one often has a zero target) has no RAW form.
    let usable = tap.control.filter(|c| c.target_kv - c.deadband_kv / 2.0 > 0.0);
    if tap.control.is_some() && usable.is_none() {
        w.count("tap control(s) without a positive voltage band written as no control (COD 0)");
    }
    let (cod, cont, vma, vmi) = match usable {
        Some(c) => {
            let kv = w.m.nominal_kv(c.node);
            (
                if c.enabled { 1 } else { -1 },
                w.num(c.node),
                (c.target_kv + c.deadband_kv / 2.0) / kv,
                (c.target_kv - c.deadband_kv / 2.0) / kv,
            )
        }
        None => (0, 0, 1.1, 0.9),
    };
    Some(format!(
        "{cod},{cont}{node},{},{},{},{},{},0,0,0,0",
        n(hi),
        n(lo),
        n(vma),
        n(vmi),
        ratios.len()
    ))
}

fn transformers(w: &mut Writer) -> Vec<String> {
    let m = w.m;
    let mut out = Vec::new();
    let across: Vec<usize> = (0..m.lines.len())
        .filter(|&k| m.alive(Class::Line, k) && across_voltages(w, k))
        .collect();
    for k in across {
        let l = &m.lines[k];
        let i = w.end(l.node1, l.open[0], || format!("{}.end1", l.id));
        let j = w.end(l.node2, l.open[1], || format!("{}.end2", l.id));
        let p = line_pu(l, w.kv(l.node1), w.kv(l.node2), w.sb, ps_net::Seq::Positive);
        let ckt = w.ids.take(format!("T{}-{}", i.min(j), i.max(j)), circuit(&l.id));
        let rate = rating(&l.limits, 1, w.kv(l.node1));
        out_transformer(w, &mut out, &l.name, i, j, &ckt, &p, l.in_service, rate, None);
    }
    for (k, t) in m.transformers2.iter().enumerate() {
        if !m.alive(Class::Transformer2, k) {
            continue;
        }
        let i = w.end(t.node1, t.open[0], || format!("{}.end1", t.id));
        let j = w.end(t.node2, t.open[1], || format!("{}.end2", t.id));
        let (vh, vl) = (w.kv(t.node1), w.kv(t.node2));
        let p = transformer2_pu(t, vh, vl, w.sb, TransformerOptions::default());
        let ckt = w.ids.take(format!("T{}-{}", i.min(j), i.max(j)), circuit(&t.id));
        let rate = {
            let r = rating(&t.limits, 1, vh);
            if r > 0.0 { r } else { t.rated_mva }
        };
        let control = tap_fields(w, t, vh, vl);
        out_transformer(w, &mut out, &t.name, i, j, &ckt, &p, t.in_service, rate, control);
    }
    for (k, t) in m.transformers3.iter().enumerate() {
        if !m.alive(Class::Transformer3, k) {
            continue;
        }
        three_winding(w, &mut out, t);
    }
    out
}

/// A three-winding record: the star impedances become the pairwise ones (Z12 = Z1 + Z2, …), each winding's ideal
/// ratio and angle its WINDV and ANG, winding 1's magnetising admittance MAG at bus I, the others fixed shunts.
fn three_winding(w: &mut Writer, out: &mut Vec<String>, t: &Transformer3) {
    let nums: Vec<i64> = t.windings.iter().map(|wd| w.num(wd.node)).collect();
    let pus: Vec<TransformerPu> = (0..3)
        .map(|k| transformer3_winding_pu(t, k, w.kv(t.windings[k].node), w.sb))
        .collect();
    let ckt = w
        .ids
        .take(format!("T{}-{}-{}", nums[0], nums[1], nums[2]), circuit(&t.id));
    let mag = pus[0].y_from.scale(1.0 / (pus[0].ratio * pus[0].ratio));
    for k in 1..3 {
        let y = pus[k].y_from.scale(1.0 / (pus[k].ratio * pus[k].ratio));
        w.extra_shunt(nums[k], y, t.in_service);
    }
    // STAT: 1 all in, 0 all out, 4 winding 1 open, 2 winding 2 open, 3 winding 3 open.
    let open: Vec<bool> = t.windings.iter().map(|wd| wd.open).collect();
    let stat = match (t.in_service, open.as_slice()) {
        (false, _) => 0,
        (true, [true, false, false]) => 4,
        (true, [false, true, false]) => 2,
        (true, [false, false, true]) => 3,
        (true, [false, false, false]) => 1,
        _ => {
            w.count("three-winding transformer(s) with more than one open winding written out of service");
            0
        }
    };
    let name_max = if w.v35() { 40 } else { 12 };
    let mut head = format!(
        "{},{},{},{},1,1,1,{},{},2,{},{stat},1,1,0,1,0,1,0,1,''",
        nums[0],
        nums[1],
        nums[2],
        q(&ckt, 2),
        n(mag.re),
        n(mag.im),
        q(&t.name, name_max)
    );
    if w.v35() {
        head.push_str(",0");
    }
    let z = |a: usize, b: usize| pus[a].z + pus[b].z;
    let (z12, z23, z31) = (z(0, 1), z(1, 2), z(2, 0));
    out.push(head);
    out.push(format!(
        "{},{},{},{},{},{},{},{},{},1,0",
        n(z12.re),
        n(z12.im),
        n(w.sb),
        n(z23.re),
        n(z23.im),
        n(w.sb),
        n(z31.re),
        n(z31.im),
        n(w.sb)
    ));
    let node = if w.v35() { ",0" } else { "" };
    for (k, p) in pus.iter().enumerate() {
        let rate = t.windings[k].rated_mva;
        out.push(format!(
            "{},0,{},{},0,0{node},1.1,0.9,1.1,0.9,33,0,0,0,0",
            n(p.ratio),
            n(p.shift * DEG),
            ratings(w.v35(), rate)
        ));
    }
    if t.ratio_taps.iter().any(|r| r.table.len() > 1 || r.high > r.low) || t.phase_taps.iter().any(|p| p.high > p.low) {
        w.count("three-winding transformer(s) written with their present tap positions only");
    }
}
