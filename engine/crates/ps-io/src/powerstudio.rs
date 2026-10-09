//! PowerStudio 0.1 documents (`"format": "powerstudio"`, version 1) → canonical model and study case.
//!
//! A 0.1 document stores equipment as a network engineer enters it (Ω/km, %, kV, MVA) together with diagram
//! positions. The conversion keeps every electrical value: per-length line data become totals, transformer uk and uR
//! become impedances referred to the HV winding, iron losses and no-load current become a magnetising admittance split
//! half to each winding, as the 0.1 engine modelled it. Diagram fields stay with the document. Missing fields take the
//! 0.1 catalogue defaults (src/core/catalog.js), so a hand-written document reads the same in both.

use ps_model::study::StudyCase;
use ps_model::{
    Area, Class, CurrentLimit, ExternalGrid, Generator, Line, Load, MachineControl, MachineDynamics,
    MachineShortCircuit, Model, Node, NodeKind, NodeRef, RatioTap, Shunt, Transformer2, Winding,
};
use serde_json::Value;
use std::collections::HashMap;

use crate::ParseError;

/// A converted document.
#[derive(Debug, Clone)]
pub struct Imported {
    /// The model.
    pub model: Model,
    /// The document's study case.
    pub study: StudyCase,
    /// Elements skipped or values replaced, in plain words.
    pub issues: Vec<String>,
}

struct El<'a>(&'a serde_json::Map<String, Value>);

impl<'a> El<'a> {
    fn num(&self, key: &str, default: f64) -> f64 {
        self.0
            .get(key)
            .and_then(Value::as_f64)
            .filter(|v| v.is_finite())
            .unwrap_or(default)
    }
    fn int(&self, key: &str, default: i32) -> i32 {
        self.0
            .get(key)
            .and_then(Value::as_i64)
            .map_or(default, |v| v.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32)
    }
    fn text(&self, key: &str) -> &'a str {
        self.0.get(key).and_then(Value::as_str).unwrap_or("")
    }
    fn flag(&self, key: &str, default: bool) -> bool {
        self.0.get(key).and_then(Value::as_bool).unwrap_or(default)
    }
}

/// Parses a vector group such as `Dyn11` into winding connections and clock number.
pub fn vector_group(group: &str) -> Option<(Winding, Winding, u8)> {
    let digits = group.trim_start_matches(|c: char| !c.is_ascii_digit());
    let letters = &group[..group.len() - digits.len()];
    let clock: u8 = digits.parse().ok()?;
    let split = letters
        .char_indices()
        .skip(1)
        .find(|(_, c)| c.is_ascii_lowercase())
        .map(|(i, _)| i)?;
    let conn = |s: &str| match s.to_ascii_uppercase().as_str() {
        "Y" => Some(Winding::Y),
        "YN" => Some(Winding::Yn),
        "D" => Some(Winding::D),
        "Z" => Some(Winding::Z),
        "ZN" => Some(Winding::Zn),
        _ => None,
    };
    Some((conn(&letters[..split])?, conn(&letters[split..])?, clock % 12))
}

/// Reads a document from its JSON text.
pub fn parse(text: &str) -> Result<Imported, ParseError> {
    let v: Value = serde_json::from_str(text)
        .map_err(|e| ParseError::new(format!("the document is not valid JSON: {e}"), Some(e.line())))?;
    from_value(&v)
}

/// Converts a parsed document.
pub fn from_value(doc: &Value) -> Result<Imported, ParseError> {
    if doc.get("format").and_then(Value::as_str) != Some("powerstudio") {
        return Err(ParseError::new(
            "the file is not a PowerStudio document (format field missing)",
            None,
        ));
    }
    let mut m = Model::new(doc.get("name").and_then(Value::as_str).unwrap_or("Imported network"));
    m.meta.description = doc.get("description").and_then(Value::as_str).unwrap_or("").to_string();
    m.meta.base_mva = doc
        .get("baseMVA")
        .and_then(Value::as_f64)
        .filter(|v| *v > 0.0)
        .unwrap_or(100.0);
    m.meta.frequency_hz = if doc.get("frequency").and_then(Value::as_f64) == Some(60.0) {
        60.0
    } else {
        50.0
    };
    let mut issues = Vec::new();
    let elements: Vec<&serde_json::Map<String, Value>> = doc
        .get("elements")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_object).collect())
        .unwrap_or_default();

    // Busbars first: every other element refers to them.
    let mut node_of: HashMap<&str, u32> = HashMap::new();
    let mut areas: HashMap<String, u32> = HashMap::new();
    for e in elements.iter().map(|e| El(e)).filter(|e| e.text("cls") == "bus") {
        let id = e.text("id");
        if id.is_empty() || node_of.contains_key(id) {
            issues.push(format!("Skipped a busbar with a missing or duplicate id \"{id}\"."));
            continue;
        }
        let zone = e.text("zone");
        let area = (!zone.is_empty()).then(|| {
            *areas.entry(zone.to_string()).or_insert_with(|| {
                m.areas.push(Area {
                    id: zone.to_string(),
                    name: zone.to_string(),
                    ..Default::default()
                });
                (m.areas.len() - 1) as u32
            })
        });
        node_of.insert(id, m.nodes.len() as u32);
        m.nodes.push(Node {
            id: id.to_string(),
            name: e.text("name").to_string(),
            kind: NodeKind::Bus,
            voltage_level: None,
            nominal_kv: e.num("vn", 110.0),
            v_min: e.num("vmin", 0.95),
            v_max: e.num("vmax", 1.05),
            area,
            v0: 0.0,
            angle0: 0.0,
        });
    }
    let mut seen: HashMap<(Class, String), ()> = HashMap::new();
    for raw in &elements {
        let e = El(raw);
        let (cls, id) = (e.text("cls"), e.text("id").to_string());
        let class = match cls {
            "bus" => continue,
            "line" => Class::Line,
            "trafo" => Class::Transformer2,
            "gen" => Class::Generator,
            "extgrid" => Class::ExternalGrid,
            "load" => Class::Load,
            "shunt" => Class::Shunt,
            other => {
                issues.push(format!("Skipped an element of unknown class \"{other}\"."));
                continue;
            }
        };
        if id.is_empty() || seen.insert((class, id.clone()), ()).is_some() {
            issues.push(format!(
                "Skipped a {} with a missing or duplicate id \"{id}\".",
                class.label()
            ));
            continue;
        }
        let ends: &[&str] = match class {
            Class::Line => &["from", "to"],
            Class::Transformer2 => &["hv", "lv"],
            _ => &["bus"],
        };
        let nodes: Option<Vec<NodeRef>> = ends
            .iter()
            .map(|k| node_of.get(e.text(k)).map(|&n| NodeRef(n)))
            .collect();
        let Some(nodes) = nodes else {
            issues.push(format!("{id}: removed, it connects to a missing busbar."));
            continue;
        };
        if nodes.len() == 2 && nodes[0] == nodes[1] {
            issues.push(format!("{id}: removed, both ends are on the same busbar."));
            continue;
        }
        let name = e.text("name").to_string();
        let in_service = e.flag("inService", true);
        match class {
            Class::Line => {
                let (len, par) = (e.num("length", 10.0), f64::from(e.int("parallel", 1).max(1)));
                let rated = e.num("ratedA", 0.6) * par * 1000.0;
                let limits = if rated > 0.0 {
                    vec![
                        CurrentLimit {
                            end: 1,
                            duration_s: None,
                            amps: rated,
                        },
                        CurrentLimit {
                            end: 2,
                            duration_s: None,
                            amps: rated,
                        },
                    ]
                } else {
                    Vec::new()
                };
                m.lines.push(Line {
                    id,
                    name,
                    node1: nodes[0],
                    node2: nodes[1],
                    in_service,
                    open: [false; 2],
                    r: e.num("r1", 0.12) * len / par,
                    x: e.num("x1", 0.39) * len / par,
                    g1: 0.0,
                    b1: e.num("b1", 2.9) * 1e-6 * len * par / 2.0,
                    g2: 0.0,
                    b2: e.num("b1", 2.9) * 1e-6 * len * par / 2.0,
                    r0: e.num("r0", 0.36) * len / par,
                    x0: e.num("x0", 1.17) * len / par,
                    b0: e.num("b0", 1.8) * 1e-6 * len * par,
                    length_km: len,
                    limits,
                });
            }
            Class::Transformer2 => {
                let (sn, vh, vl) = (e.num("sn", 40.0), e.num("vnHV", 110.0), e.num("vnLV", 20.0));
                let zb1 = vh * vh / sn;
                let series = |uk: f64, ur: f64| {
                    (
                        ur / 100.0 * zb1,
                        ((uk / 100.0).powi(2) - (ur / 100.0).powi(2)).max(0.0).sqrt() * zb1,
                    )
                };
                let (r, x) = series(e.num("uk", 12.0), e.num("ur", 0.4));
                let (r0, x0) = series(e.num("uk0", 12.0), e.num("ur0", 0.4));
                // Magnetising admittance in p.u. of the rating, then siemens at winding 1, half to each winding.
                let g = e.num("pfe", 20.0) / 1000.0 / sn;
                let ym = e.num("i0", 0.05) / 100.0;
                let bm = -(ym * ym - g * g).max(0.0).sqrt();
                let group = e.text("vectorGroup");
                let (conn1, conn2, clock) = vector_group(if group.is_empty() { "Dyn11" } else { group })
                    .unwrap_or_else(|| {
                        issues.push(format!("{id}: unknown vector group \"{group}\"; Dyn11 is used."));
                        (Winding::D, Winding::Yn, 11)
                    });
                m.transformers2.push(Transformer2 {
                    id,
                    name,
                    node1: nodes[0],
                    node2: nodes[1],
                    in_service,
                    open: [false; 2],
                    rated_kv1: vh,
                    rated_kv2: vl,
                    rated_mva: sn,
                    r,
                    x,
                    g1: g / zb1 / 2.0,
                    b1: bm / zb1 / 2.0,
                    g2: g / zb1 / 2.0,
                    b2: bm / zb1 / 2.0,
                    clock,
                    phase_shift_deg: 0.0,
                    conn1,
                    conn2,
                    r0,
                    x0,
                    ratio_taps: vec![RatioTap {
                        end: 1,
                        low: e.int("tapMin", -9),
                        high: e.int("tapMax", 9),
                        neutral: e.int("tapNeutral", 0),
                        step_pct: e.num("tapStep", 1.25),
                        position: e.int("tapPos", 0),
                        control: None,
                        table: Vec::new(),
                    }],
                    phase_tap: None,
                    limits: Vec::new(),
                });
            }
            Class::Generator => {
                let control = match e.text("mode") {
                    "PQ" => MachineControl::Pq,
                    "Reference" => MachineControl::Reference,
                    _ => MachineControl::Pv,
                };
                m.generators.push(Generator {
                    id,
                    name,
                    node: nodes[0],
                    in_service,
                    control,
                    p: e.num("p", 50.0),
                    q: e.num("q", 0.0),
                    v_set: e.num("vset", 1.0),
                    regulated_node: None,
                    angle: e.num("angle", 0.0),
                    q_min: e.num("qmin", -30.0),
                    q_max: e.num("qmax", 40.0),
                    p_min: 0.0,
                    p_max: 0.0,
                    rated_mva: e.num("sn", 60.0),
                    rated_kv: e.num("vn", 10.5),
                    participation: 0.0,
                    reference_priority: 0,
                    sc: MachineShortCircuit {
                        xdss: e.num("xdss", 0.16),
                        rs: e.num("rs", 0.0024),
                        cos_phi: e.num("cosphi", 0.85),
                        earthed: false,
                    },
                    dynamics: MachineDynamics {
                        xdt: e.num("xdt", 0.25),
                        h: e.num("h", 4.0),
                        d: e.num("damping", 0.0),
                    },
                });
            }
            Class::ExternalGrid => m.external_grids.push(ExternalGrid {
                id,
                name,
                node: nodes[0],
                in_service,
                v_set: e.num("vset", 1.0),
                angle: e.num("angle", 0.0),
                sk_max: e.num("skMax", 5000.0),
                sk_min: e.num("skMin", 4000.0),
                rx_max: e.num("rxMax", 0.1),
                rx_min: e.num("rxMin", 0.1),
                x0x1: e.num("x0x1", 1.0),
                r0x0: e.num("r0x0", 0.1),
            }),
            Class::Load => m.loads.push(Load {
                id,
                name,
                node: nodes[0],
                in_service,
                p: e.num("p", 10.0),
                q: e.num("q", 3.0),
                p_zip: [0.0, 0.0, 1.0],
                q_zip: [0.0, 0.0, 1.0],
            }),
            Class::Shunt => {
                let vn = e.num("vn", 110.0);
                m.shunts.push(Shunt {
                    id,
                    name,
                    node: nodes[0],
                    in_service,
                    nominal_kv: vn,
                    g_per_section: e.num("p", 0.0) / (vn * vn),
                    b_per_section: e.num("q", 10.0) / (vn * vn),
                    sections: 1,
                    max_sections: 1,
                    control: None,
                    points: Vec::new(),
                });
            }
            _ => {}
        }
    }
    let study = match doc.get("study") {
        Some(s) => serde_json::from_value(s.clone()).unwrap_or_else(|e| {
            issues.push(format!("Study case: {e}; defaults are used."));
            StudyCase::default()
        }),
        None => StudyCase::default(),
    };
    Ok(Imported {
        model: m,
        study,
        issues,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vector_groups_parse() {
        assert_eq!(vector_group("Dyn11"), Some((Winding::D, Winding::Yn, 11)));
        assert_eq!(vector_group("YNd5"), Some((Winding::Yn, Winding::D, 5)));
        assert_eq!(vector_group("YNyn0"), Some((Winding::Yn, Winding::Yn, 0)));
        assert_eq!(vector_group("Yyn0"), Some((Winding::Y, Winding::Yn, 0)));
        assert_eq!(vector_group("Dd0"), Some((Winding::D, Winding::D, 0)));
        assert_eq!(vector_group("nonsense"), None);
    }
}
