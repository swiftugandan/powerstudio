//! CGMES state variables (SV) from a solved model: the profile that carries a load flow's result back into a CGMES
//! exchange, next to the EQ, TP and SSH files it was computed from.
//!
//! The writer reads the original files again for the identifiers SV refers to: every topological node gets an
//! `SvVoltage`, every island a `TopologicalIsland` with its angle reference, every terminal of equipment PowerStudio
//! solved an `SvPowerFlow` (load sign: power flowing out of the node into the equipment), every tap changer an
//! `SvTapStep`, every conducting equipment an `SvStatus` and every shunt compensator an `SvShuntCompensatorSections`.
//! The model's elements carry their CGMES mRIDs, which is how each result finds its terminal. Version (2.4.15 or 3.0)
//! and namespaces follow the input; the SV model depends on the input's TP and SSH models and takes their scenario
//! time and modelling authority. Identifiers of the new objects derive from the input and the element they describe,
//! so exporting the same state twice gives the same file.

use std::collections::{BTreeMap, HashMap};
use std::fmt::Write as _;

use ps_model::{Class, Model};
use sha2::{Digest, Sha256};

use crate::files::File;
use crate::rdf::{Graph, Header, Object};

/// A solved state, in the model's terms.
#[derive(Debug, Clone, Default)]
pub struct State {
    /// Voltage of every node, p.u. and degrees; `None` for a node without supply.
    pub node_v: Vec<Option<(f64, f64)>>,
    /// Power flowing into each element from each of its terminals, MW and Mvar, by element identifier, in terminal
    /// order (a line's ends 1 and 2, a transformer's windings by end number, an injection's one terminal).
    pub flows: HashMap<String, Vec<Option<(f64, f64)>>>,
    /// Island of every node with supply.
    pub node_island: Vec<Option<u32>>,
    /// Per island, the node whose angle is the reference.
    pub island_reference: Vec<Option<usize>>,
}

/// Export settings.
#[derive(Debug, Clone, Default)]
pub struct Options {
    /// `md:Model.created`, an ISO 8601 time (callers pass the clock; tests pass a fixed one).
    pub created: String,
    /// `md:Model.description`.
    pub description: String,
}

/// A written SV file.
#[derive(Debug, Clone)]
pub struct Written {
    /// The XML.
    pub text: String,
    /// Counts of what was written, by class.
    pub counts: Vec<(&'static str, usize)>,
    /// What could not be written, in plain words.
    pub notes: Vec<String>,
}

/// A deterministic UUID (version 4 layout) from a seed.
fn uuid(seed: &str) -> String {
    let h = Sha256::digest(seed.as_bytes());
    let mut b = [0u8; 16];
    b.copy_from_slice(&h[..16]);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let hex: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

fn num(x: f64) -> String {
    if x == 0.0 || !x.is_finite() {
        "0".into()
    } else {
        format!("{x}")
    }
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// A reference to an object of the input.
fn r(id: &str) -> String {
    format!("#_{id}")
}

/// The CGMES version of the input, from its profile URIs.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Version {
    V2,
    V3,
}

impl Version {
    fn cim(self) -> &'static str {
        match self {
            Version::V2 => "http://iec.ch/TC57/2013/CIM-schema-cim16#",
            Version::V3 => "http://iec.ch/TC57/CIM100#",
        }
    }
    fn profile(self) -> &'static str {
        match self {
            Version::V2 => "http://entsoe.eu/CIM/StateVariables/4/1",
            Version::V3 => "http://iec.ch/TC57/ns/CIM/StateVariables-EU/3.0",
        }
    }
}

fn has(h: &Header, what: &str) -> bool {
    h.profiles.iter().any(|p| p.contains(what))
}

/// Writes the SV profile of `state` for the model read from `files`.
pub fn write(files: &[File], m: &Model, state: &State, opt: &Options) -> Result<Written, String> {
    let mut g = Graph::new();
    for f in files.iter().filter(|f| f.name.to_ascii_lowercase().ends_with(".xml")) {
        g.read(&f.name, &f.data).map_err(|e| e.to_string())?;
    }
    let v3 = g
        .headers
        .iter()
        .flat_map(|h| &h.profiles)
        .any(|p| p.contains("/3.0") || p.contains("CIM100"));
    let version = if v3 { Version::V3 } else { Version::V2 };
    // The TP and SSH models the state was solved from: the SV depends on them and takes their time and authority.
    let solved_from: Vec<&Header> = g
        .headers
        .iter()
        .filter(|h| has(h, "Topology") || has(h, "SteadyStateHypothesis"))
        .collect();
    let depends: Vec<String> = solved_from
        .iter()
        .map(|h| {
            if h.id.starts_with("urn:") {
                h.id.clone()
            } else {
                format!("urn:uuid:{}", h.id)
            }
        })
        .collect();
    let scenario = solved_from
        .iter()
        .copied()
        .chain(&g.headers)
        .find_map(|h| h.scenario_time.clone())
        .unwrap_or_else(|| opt.created.clone());
    let authority = solved_from
        .iter()
        .find(|h| has(h, "SteadyStateHypothesis"))
        .or(solved_from.first())
        .and_then(|h| h.authority.clone())
        .unwrap_or_default();
    let seed: String = g.headers.iter().map(|h| h.id.as_str()).collect::<Vec<_>>().join("+");

    let mut body = String::new();
    let mut counts: Vec<(&'static str, usize)> = Vec::new();
    let mut notes = Vec::new();

    // Model nodes by identifier; each topological node's model node (itself, or a connectivity node in it).
    let node_index: HashMap<&str, usize> = m.nodes.iter().enumerate().map(|(k, n)| (n.id.as_str(), k)).collect();
    let mut cn_in_tn: HashMap<&str, usize> = HashMap::new();
    for cn in g.of_class("ConnectivityNode") {
        if let (Some(tn), Some(&k)) = (
            g.reference(cn, "ConnectivityNode.TopologicalNode"),
            node_index.get(&*cn.id),
        ) {
            cn_in_tn.entry(tn).or_insert(k);
        }
    }
    let tns: Vec<(&str, Option<usize>)> = g
        .of_class("TopologicalNode")
        .map(|tn| {
            (
                &*tn.id,
                node_index.get(&*tn.id).or_else(|| cn_in_tn.get(&*tn.id)).copied(),
            )
        })
        .collect();

    let mut unknown = 0;
    for &(tn, node) in &tns {
        let Some(k) = node else {
            unknown += 1;
            continue;
        };
        // A node without supply gets zero voltage, as CGMES writes de-energised nodes.
        let (v, a) = state
            .node_v
            .get(k)
            .copied()
            .flatten()
            .map_or((0.0, 0.0), |(vm, va)| (vm * m.nodes[k].nominal_kv, va));
        let _ = writeln!(
            body,
            "  <cim:SvVoltage rdf:ID=\"_{}\">\n    <cim:SvVoltage.angle>{}</cim:SvVoltage.angle>\n    <cim:SvVoltage.v>{}</cim:SvVoltage.v>\n    <cim:SvVoltage.TopologicalNode rdf:resource=\"{}\"/>\n  </cim:SvVoltage>",
            uuid(&format!("{seed}/SvVoltage/{tn}")),
            num(a),
            num(v),
            r(tn)
        );
    }
    counts.push(("SvVoltage", tns.len() - unknown));
    if unknown > 0 {
        notes.push(format!(
            "{unknown} topological node(s) have no node in the model; they get no voltage."
        ));
    }

    // Topological islands: the topological nodes with supply, grouped as solved, each with its angle reference.
    let mut islands: BTreeMap<u32, Vec<&str>> = BTreeMap::new();
    let mut tn_of_node: HashMap<usize, &str> = HashMap::new();
    for &(tn, node) in &tns {
        let Some(k) = node else { continue };
        tn_of_node.entry(k).or_insert(tn);
        if let Some(i) = state.node_island.get(k).copied().flatten() {
            islands.entry(i).or_default().push(tn);
        }
    }
    for (i, members) in &islands {
        let reference = state
            .island_reference
            .get(*i as usize)
            .copied()
            .flatten()
            .and_then(|k| tn_of_node.get(&k).copied())
            .unwrap_or(members[0]);
        let _ = writeln!(
            body,
            "  <cim:TopologicalIsland rdf:ID=\"_{}\">",
            uuid(&format!("{seed}/TopologicalIsland/{reference}"))
        );
        let _ = writeln!(
            body,
            "    <cim:IdentifiedObject.name>Island {}</cim:IdentifiedObject.name>",
            i + 1
        );
        let _ = writeln!(
            body,
            "    <cim:TopologicalIsland.AngleRefTopologicalNode rdf:resource=\"{}\"/>",
            r(reference)
        );
        for tn in members {
            let _ = writeln!(
                body,
                "    <cim:TopologicalIsland.TopologicalNodes rdf:resource=\"{}\"/>",
                r(tn)
            );
        }
        let _ = writeln!(body, "  </cim:TopologicalIsland>");
    }
    counts.push(("TopologicalIsland", islands.len()));

    // Terminals in the order the importer gave each element's ends: transformers by end number, the rest by
    // sequence number.
    let mut terminals: HashMap<&str, Vec<(i64, &Object)>> = HashMap::new();
    for t in g.of_class("Terminal") {
        if let Some(eq) = g.reference(t, "Terminal.ConductingEquipment") {
            let seq = g.num(t, "ACDCTerminal.sequenceNumber").unwrap_or(1.0) as i64;
            terminals.entry(eq).or_default().push((seq, t));
        }
    }
    let mut end_terminal: HashMap<&str, Vec<(i64, &str)>> = HashMap::new();
    let mut end_of: HashMap<&str, (&str, u8)> = HashMap::new();
    for e in g.of_class("PowerTransformerEnd") {
        let (Some(pt), Some(n)) = (
            g.reference(e, "PowerTransformerEnd.PowerTransformer"),
            g.num(e, "TransformerEnd.endNumber"),
        ) else {
            continue;
        };
        end_of.insert(&e.id, (pt, n as u8));
        if let Some(t) = g.reference(e, "TransformerEnd.Terminal") {
            end_terminal.entry(pt).or_default().push((n as i64, t));
        }
    }
    let mut written = 0;
    let mut ids: Vec<&String> = state.flows.keys().collect();
    ids.sort();
    for id in ids {
        let ordered: Vec<&str> = match end_terminal.get(id.as_str()) {
            Some(ends) => {
                let mut ends = ends.clone();
                ends.sort_by_key(|e| e.0);
                ends.into_iter().map(|e| e.1).collect()
            }
            None => {
                let mut ts = terminals.get(id.as_str()).cloned().unwrap_or_default();
                ts.sort_by_key(|t| t.0);
                ts.into_iter().map(|t| &*t.1.id).collect()
            }
        };
        for (t, flow) in ordered.iter().zip(&state.flows[id]) {
            let Some((p, q)) = flow else { continue };
            let _ = writeln!(
                body,
                "  <cim:SvPowerFlow rdf:ID=\"_{}\">\n    <cim:SvPowerFlow.p>{}</cim:SvPowerFlow.p>\n    <cim:SvPowerFlow.q>{}</cim:SvPowerFlow.q>\n    <cim:SvPowerFlow.Terminal rdf:resource=\"{}\"/>\n  </cim:SvPowerFlow>",
                uuid(&format!("{seed}/SvPowerFlow/{t}")),
                num(*p),
                num(*q),
                r(t)
            );
            written += 1;
        }
    }
    counts.push(("SvPowerFlow", written));

    // Tap positions, by tap changer: its end's transformer and end number.
    let mut written = 0;
    for class in [
        "RatioTapChanger",
        "PhaseTapChangerLinear",
        "PhaseTapChangerSymmetrical",
        "PhaseTapChangerAsymmetrical",
        "PhaseTapChangerTabular",
    ] {
        let ratio = class == "RatioTapChanger";
        let link = if ratio {
            "RatioTapChanger.TransformerEnd"
        } else {
            "PhaseTapChanger.TransformerEnd"
        };
        for tc in g.of_class(class) {
            let Some(&(pt, end)) = g.reference(tc, link).and_then(|e| end_of.get(e)) else {
                continue;
            };
            let two = m.transformers2.iter().find(|t| t.id == pt);
            let three = m.transformers3.iter().find(|t| t.id == pt);
            let position = match (ratio, two, three) {
                (true, Some(t), _) => t.ratio_taps.iter().find(|x| x.end == end).map(|x| x.position),
                (false, Some(t), _) => t.phase_tap.as_ref().filter(|x| x.end == end).map(|x| x.position),
                (true, None, Some(t)) => t.ratio_taps.iter().find(|x| x.end == end).map(|x| x.position),
                (false, None, Some(t)) => t.phase_taps.iter().find(|x| x.end == end).map(|x| x.position),
                _ => None,
            };
            let Some(position) = position else { continue };
            let _ = writeln!(
                body,
                "  <cim:SvTapStep rdf:ID=\"_{}\">\n    <cim:SvTapStep.position>{position}</cim:SvTapStep.position>\n    <cim:SvTapStep.TapChanger rdf:resource=\"{}\"/>\n  </cim:SvTapStep>",
                uuid(&format!("{seed}/SvTapStep/{}", tc.id)),
                r(&tc.id)
            );
            written += 1;
        }
    }
    counts.push(("SvTapStep", written));

    // Status of every conducting equipment: the model's own state, or in service for equipment the model holds as a
    // node (busbar sections, junctions). A switch's open or closed state belongs to SSH; as equipment it is in
    // service.
    let mut row_of: HashMap<&str, (Class, usize)> = HashMap::new();
    for class in Class::ALL {
        for row in 0..m.len(class) {
            if let Some(id) = m.id_of(class, row) {
                row_of.entry(id).or_insert((class, row));
            }
        }
    }
    let mut equipment: Vec<&str> = terminals.keys().copied().collect();
    equipment.sort_unstable();
    for id in &equipment {
        let on = match row_of.get(id) {
            Some(&(Class::Switch, _)) | None => true,
            Some(&(class, row)) => ps_topology::active(m, &ps_topology::Outages::none(), class, row),
        };
        let _ = writeln!(
            body,
            "  <cim:SvStatus rdf:ID=\"_{}\">\n    <cim:SvStatus.inService>{on}</cim:SvStatus.inService>\n    <cim:SvStatus.ConductingEquipment rdf:resource=\"{}\"/>\n  </cim:SvStatus>",
            uuid(&format!("{seed}/SvStatus/{id}")),
            r(id)
        );
    }
    counts.push(("SvStatus", equipment.len()));

    let mut written = 0;
    for s in &m.shunts {
        let compensator = g.get(&s.id).is_some_and(|o| {
            let c = g.name(o.class);
            c == "LinearShuntCompensator" || c == "NonlinearShuntCompensator"
        });
        if !compensator {
            continue;
        }
        let _ = writeln!(
            body,
            "  <cim:SvShuntCompensatorSections rdf:ID=\"_{}\">\n    <cim:SvShuntCompensatorSections.sections>{}</cim:SvShuntCompensatorSections.sections>\n    <cim:SvShuntCompensatorSections.ShuntCompensator rdf:resource=\"{}\"/>\n  </cim:SvShuntCompensatorSections>",
            uuid(&format!("{seed}/SvShuntCompensatorSections/{}", s.id)),
            s.sections,
            r(&s.id)
        );
        written += 1;
    }
    counts.push(("SvShuntCompensatorSections", written));

    let model_id = uuid(&format!("{seed}/SV/{}", opt.created));
    let mut text = String::new();
    let _ = writeln!(text, "<?xml version=\"1.0\" encoding=\"UTF-8\"?>");
    let _ = writeln!(
        text,
        "<rdf:RDF xmlns:cim=\"{}\" xmlns:md=\"http://iec.ch/TC57/61970-552/ModelDescription/1#\" xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">",
        version.cim()
    );
    let _ = writeln!(text, "  <md:FullModel rdf:about=\"urn:uuid:{model_id}\">");
    let _ = writeln!(
        text,
        "    <md:Model.created>{}</md:Model.created>",
        escape(&opt.created)
    );
    let _ = writeln!(
        text,
        "    <md:Model.scenarioTime>{}</md:Model.scenarioTime>",
        escape(&scenario)
    );
    let _ = writeln!(
        text,
        "    <md:Model.description>{}</md:Model.description>",
        escape(&opt.description)
    );
    let _ = writeln!(text, "    <md:Model.version>1</md:Model.version>");
    for d in &depends {
        let _ = writeln!(text, "    <md:Model.DependentOn rdf:resource=\"{d}\"/>");
    }
    let _ = writeln!(text, "    <md:Model.profile>{}</md:Model.profile>", version.profile());
    let _ = writeln!(
        text,
        "    <md:Model.modelingAuthoritySet>{}</md:Model.modelingAuthoritySet>",
        escape(&authority)
    );
    let _ = writeln!(text, "  </md:FullModel>");
    text.push_str(&body);
    let _ = writeln!(text, "</rdf:RDF>");
    Ok(Written { text, counts, notes })
}
