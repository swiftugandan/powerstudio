//! CGMES steady-state hypothesis (SSH) with changed operating values: the profile that carries an operator's set
//! points, written back so a study's operating point can return to the operator's toolchain.
//!
//! The writer edits the input's own SSH files rather than generating new ones. Each change names an equipment by its
//! mRID and an operating value in engineering terms; the writer finds the SSH objects that hold that value (the
//! equipment, its terminals, its regulating control, its tap changer, through the EQ files), replaces the property in
//! the object's XML or adds it, and leaves every other byte of the file as it was. A file it changes gets a new model
//! identifier (derived from the old one and the changes, so the same changes give the same file), the time it was
//! written, and a `Model.Supersedes` reference to the file it replaces; files without changes are not returned.

use std::collections::{BTreeMap, HashMap};

use sha2::{Digest, Sha256};

use crate::files::File;
use crate::rdf::{Graph, normalise};

/// An operating value, in the terms the editor holds it.
#[derive(Debug, Clone, PartialEq)]
pub enum Setting {
    /// In or out of service: every terminal's connection, and in CGMES 3 the equipment's own flag.
    InService(bool),
    /// A load's active power, MW.
    LoadP(f64),
    /// A load's reactive power, Mvar.
    LoadQ(f64),
    /// A machine's or external network injection's active power, MW, positive when producing.
    MachineP(f64),
    /// Its reactive power, Mvar, positive when producing.
    MachineQ(f64),
    /// The voltage target of the equipment's regulating control, kV.
    VoltageTargetKv(f64),
    /// A shunt compensator's sections in service.
    Sections(f64),
    /// A transformer's tap changer step: the ratio changer at winding `end`, or the phase changer when `phase`.
    TapStep {
        /// Phase changer rather than ratio changer.
        phase: bool,
        /// Winding the changer is on (1 or 2).
        end: u8,
        /// Step.
        step: i32,
    },
    /// Whether that tap changer regulates.
    TapControl {
        /// Phase changer rather than ratio changer.
        phase: bool,
        /// Winding the changer is on.
        end: u8,
        /// Regulating.
        on: bool,
    },
    /// The voltage target of a ratio tap changer's control, kV.
    TapTargetKv {
        /// Winding the changer is on.
        end: u8,
        /// Target, kV.
        kv: f64,
    },
}

/// A change to one equipment, by mRID.
#[derive(Debug, Clone, PartialEq)]
pub struct Change {
    /// The equipment's mRID.
    pub id: String,
    /// What changes.
    pub setting: Setting,
}

/// Export settings.
#[derive(Debug, Clone, Default)]
pub struct Options {
    /// `md:Model.created`, an ISO 8601 time.
    pub created: String,
}

/// The rewritten SSH files.
#[derive(Debug, Clone, Default)]
pub struct Written {
    /// The SSH files that changed, under their input names.
    pub files: Vec<File>,
    /// Properties written.
    pub edits: usize,
    /// Changes that could not be written, in plain words.
    pub notes: Vec<String>,
}

/// One property to set on one object.
struct Edit {
    object: String,
    class: String,
    prop: &'static str,
    value: String,
}

/// Writes `changes` into the SSH files among `files`.
pub fn write(files: &[File], changes: &[Change], opt: &Options) -> Result<Written, String> {
    let mut g = Graph::new();
    for f in files.iter().filter(|f| f.name.to_ascii_lowercase().ends_with(".xml")) {
        g.read(&f.name, &f.data).map_err(|e| e.to_string())?;
    }
    let v3 = g
        .headers
        .iter()
        .flat_map(|h| &h.profiles)
        .any(|p| p.contains("/3.0") || p.contains("CIM100"));
    // Terminals by equipment, transformer ends by transformer, tap changers by transformer end.
    let mut terminals: HashMap<&str, Vec<&str>> = HashMap::new();
    for t in g.of_class("Terminal") {
        if let Some(eq) = g.reference(t, "Terminal.ConductingEquipment") {
            terminals.entry(eq).or_default().push(&t.id);
        }
    }
    let mut ends: HashMap<&str, Vec<(u8, &str)>> = HashMap::new();
    for e in g.of_class("PowerTransformerEnd") {
        if let Some(t) = g.reference(e, "PowerTransformerEnd.PowerTransformer") {
            let n = g.num(e, "TransformerEnd.endNumber").unwrap_or(1.0) as u8;
            ends.entry(t).or_default().push((n, &e.id));
        }
    }
    let mut changers: HashMap<(&str, bool), &str> = HashMap::new();
    for (class, phase, link) in [
        ("RatioTapChanger", false, "RatioTapChanger.TransformerEnd"),
        ("PhaseTapChangerLinear", true, "PhaseTapChanger.TransformerEnd"),
        ("PhaseTapChangerSymmetrical", true, "PhaseTapChanger.TransformerEnd"),
        ("PhaseTapChangerAsymmetrical", true, "PhaseTapChanger.TransformerEnd"),
        ("PhaseTapChangerTabular", true, "PhaseTapChanger.TransformerEnd"),
    ] {
        for tc in g.of_class(class) {
            if let Some(end) = g.reference(tc, link) {
                changers.insert((end, phase), &tc.id);
            }
        }
    }
    let class_of = |id: &str| g.get(id).map(|o| g.name(o.class).to_string());
    let changer = |id: &str, phase: bool, end: u8| -> Option<&str> {
        let list = ends.get(id)?;
        list.iter()
            .filter(|(n, _)| phase || *n == end)
            .find_map(|(_, e)| changers.get(&(*e, phase)).copied())
    };

    let mut edits: Vec<Edit> = Vec::new();
    let mut notes = Vec::new();
    let mut missed = 0usize;
    for c in changes {
        let Some(class) = class_of(&c.id) else {
            missed += 1;
            continue;
        };
        let mut set = |object: &str, prop: &'static str, value: String| {
            let class = class_of(object).unwrap_or_default();
            edits.push(Edit {
                object: object.to_string(),
                class,
                prop,
                value,
            });
        };
        // The property holding a power, by the class the importer read it from; all in the files' load sign.
        let power_prop = |p: bool| match (class.as_str(), p) {
            ("ExternalNetworkInjection", true) => Some("ExternalNetworkInjection.p"),
            ("ExternalNetworkInjection", false) => Some("ExternalNetworkInjection.q"),
            ("EquivalentInjection", true) => Some("EquivalentInjection.p"),
            ("EquivalentInjection", false) => Some("EquivalentInjection.q"),
            ("SynchronousMachine" | "AsynchronousMachine", true) => Some("RotatingMachine.p"),
            ("SynchronousMachine" | "AsynchronousMachine", false) => Some("RotatingMachine.q"),
            ("EnergyConsumer" | "ConformLoad" | "NonConformLoad" | "StationSupply", true) => Some("EnergyConsumer.p"),
            ("EnergyConsumer" | "ConformLoad" | "NonConformLoad" | "StationSupply", false) => Some("EnergyConsumer.q"),
            _ => None,
        };
        match &c.setting {
            Setting::InService(on) => {
                for t in terminals.get(c.id.as_str()).into_iter().flatten() {
                    set(t, "ACDCTerminal.connected", on.to_string());
                }
                if v3 {
                    set(&c.id, "Equipment.inService", on.to_string());
                }
            }
            // Load sign convention in the files: a load's power as it is, a producer's negated.
            Setting::LoadP(x) | Setting::LoadQ(x) | Setting::MachineP(x) | Setting::MachineQ(x) => {
                let p = matches!(c.setting, Setting::LoadP(_) | Setting::MachineP(_));
                let producing = matches!(c.setting, Setting::MachineP(_) | Setting::MachineQ(_));
                match power_prop(p) {
                    Some(prop) => set(&c.id, prop, num(if producing { -x } else { *x })),
                    None => notes.push(format!(
                        "{} ({class}): its power is not a value CGMES keeps for this class.",
                        c.id
                    )),
                }
            }
            Setting::VoltageTargetKv(kv) if class == "EquivalentInjection" => {
                set(&c.id, "EquivalentInjection.regulationTarget", num(*kv));
            }
            Setting::VoltageTargetKv(kv) => match g
                .get(&c.id)
                .and_then(|o| g.reference(o, "RegulatingCondEq.RegulatingControl"))
            {
                Some(rc) => set(rc, "RegulatingControl.targetValue", num(*kv)),
                None => notes.push(format!(
                    "{}: its voltage target has no regulating control to go in.",
                    c.id
                )),
            },
            Setting::Sections(n) => set(&c.id, "ShuntCompensator.sections", num(*n)),
            Setting::TapStep { phase, end, step } => match changer(&c.id, *phase, *end) {
                Some(tc) => set(tc, "TapChanger.step", step.to_string()),
                None => notes.push(format!("{}: no tap changer found for its tap position.", c.id)),
            },
            Setting::TapControl { phase, end, on } => match changer(&c.id, *phase, *end) {
                Some(tc) => set(tc, "TapChanger.controlEnabled", on.to_string()),
                None => notes.push(format!("{}: no tap changer found for its tap control.", c.id)),
            },
            Setting::TapTargetKv { end, kv } => {
                match changer(&c.id, false, *end)
                    .and_then(|tc| g.get(tc))
                    .and_then(|tc| g.reference(tc, "TapChanger.TapChangerControl"))
                {
                    Some(rc) => set(rc, "RegulatingControl.targetValue", num(*kv)),
                    None => notes.push(format!(
                        "{}: its tap changer has no control for the voltage target.",
                        c.id
                    )),
                }
            }
        }
    }
    if missed > 0 {
        notes.push(format!(
            "{missed} change(s) concern elements the CGMES files do not have (added in PowerStudio, or made by its conversion); SSH cannot carry them."
        ));
    }

    // Each object's edits go to the SSH file that has the object; one no SSH file has goes to the first.
    let ssh: Vec<&File> = files
        .iter()
        .filter(|f| {
            g.headers
                .iter()
                .any(|h| h.file == f.name && h.profiles.iter().any(|p| p.contains("SteadyStateHypothesis")))
        })
        .collect();
    if ssh.is_empty() {
        return Err("the files have no steady-state hypothesis (SSH) to write the changes into".into());
    }
    let texts: Vec<String> = ssh
        .iter()
        .map(|f| String::from_utf8_lossy(&f.data).into_owned())
        .collect();
    let spans: Vec<HashMap<String, (usize, usize)>> = texts.iter().map(|t| object_spans(t)).collect();
    let mut per_file: Vec<BTreeMap<String, Vec<&Edit>>> = vec![BTreeMap::new(); ssh.len()];
    for e in &edits {
        let k = spans.iter().position(|s| s.contains_key(&e.object)).unwrap_or(0);
        per_file[k].entry(e.object.clone()).or_default().push(e);
    }
    let mut out = Written {
        notes,
        ..Default::default()
    };
    for (k, file) in ssh.iter().enumerate() {
        if per_file[k].is_empty() {
            continue;
        }
        let text = &texts[k];
        let mut replaced: Vec<(usize, usize, String)> = Vec::new();
        let mut added = String::new();
        for (object, list) in &per_file[k] {
            out.edits += list.len();
            match spans[k].get(object) {
                Some(&(a, b)) => {
                    let mut body = text[a..b].to_string();
                    for e in list {
                        body = set_property(&body, e.prop, &e.value);
                    }
                    replaced.push((a, b, body));
                }
                None => {
                    let class = &list[0].class;
                    added.push_str(&format!("  <cim:{class} rdf:about=\"#_{object}\">\n"));
                    for e in list {
                        added.push_str(&format!("    <cim:{p}>{v}</cim:{p}>\n", p = e.prop, v = e.value));
                    }
                    added.push_str(&format!("  </cim:{class}>\n"));
                }
            }
        }
        let header = header_span(text).ok_or_else(|| format!("{}: no md:FullModel header", file.name))?;
        let old = attribute(&text[header.0..header.1], "rdf:about").unwrap_or_default();
        let seed = format!(
            "{old}|{}",
            per_file[k]
                .iter()
                .flat_map(|(o, l)| l.iter().map(move |e| format!("{o}.{}={}", e.prop, e.value)))
                .collect::<Vec<_>>()
                .join(";")
        );
        let new_id = format!("urn:uuid:{}", uuid(&seed));
        let old_ref = if old.starts_with("urn:") {
            old.clone()
        } else {
            format!("urn:uuid:{}", normalise(&old))
        };
        let mut head =
            text[header.0..header.1].replacen(&format!("rdf:about=\"{old}\""), &format!("rdf:about=\"{new_id}\""), 1);
        head = set_property_ns(&head, "md", "Model.created", &opt.created);
        head = insert_line(&head, &format!("<md:Model.Supersedes rdf:resource=\"{old_ref}\"/>"));
        replaced.push((header.0, header.1, head));
        replaced.sort_by_key(|r| r.0);
        let mut body = String::with_capacity(text.len() + added.len() + 256);
        let mut at = 0;
        for (a, b, s) in &replaced {
            body.push_str(&text[at..*a]);
            body.push_str(s);
            at = *b;
        }
        body.push_str(&text[at..]);
        if !added.is_empty() {
            let close = body
                .rfind("</rdf:RDF>")
                .ok_or_else(|| format!("{}: no closing rdf:RDF", file.name))?;
            body.insert_str(close, &added);
        }
        out.files.push(File {
            name: file.name.clone(),
            data: body.into_bytes(),
        });
    }
    Ok(out)
}

/// The span of every object element (`<prefix:Class rdf:about="…">` to its closing tag), by normalised identifier.
fn object_spans(text: &str) -> HashMap<String, (usize, usize)> {
    let mut out = HashMap::new();
    let mut from = 0;
    while let Some(i) = text[from..].find("rdf:about=\"").map(|i| i + from) {
        from = i + 11;
        let Some(lt) = text[..i].rfind('<') else { continue };
        let tag: String = text[lt + 1..]
            .chars()
            .take_while(|c| !c.is_whitespace() && *c != '>')
            .collect();
        if tag.starts_with("md:") || tag.contains('/') {
            continue;
        }
        let Some(q) = text[from..].find('"') else { break };
        let id = normalise(&text[from..from + q]).to_string();
        let close = format!("</{tag}>");
        let Some(end) = text[from..].find(&close).map(|e| e + from + close.len()) else {
            continue;
        };
        out.entry(id).or_insert((lt, end));
        from = end;
    }
    out
}

/// The span of the `md:FullModel` header.
fn header_span(text: &str) -> Option<(usize, usize)> {
    let a = text.find("<md:FullModel")?;
    let close = "</md:FullModel>";
    let b = text[a..].find(close)? + a + close.len();
    Some((a, b))
}

/// The value of an attribute in an element's text.
fn attribute(element: &str, name: &str) -> Option<String> {
    let at = element.find(&format!("{name}=\""))? + name.len() + 2;
    let end = element[at..].find('"')?;
    Some(element[at..at + end].to_string())
}

/// An object's XML with `prop` set: the property's text replaced, or the property added before the closing tag.
fn set_property(object: &str, prop: &str, value: &str) -> String {
    let prefix: String = object[1..].chars().take_while(|c| *c != ':').collect();
    set_property_ns(object, &prefix, prop, value)
}

fn set_property_ns(object: &str, prefix: &str, prop: &str, value: &str) -> String {
    let open = format!("<{prefix}:{prop}>");
    let close = format!("</{prefix}:{prop}>");
    if let Some(a) = object.find(&open)
        && let Some(b) = object[a..].find(&close).map(|b| b + a)
    {
        return format!("{}{open}{value}{}", &object[..a], &object[b..]);
    }
    insert_line(object, &format!("{open}{value}{close}"))
}

/// An element's XML with a child line added before its closing tag, indented as its other children are.
fn insert_line(element: &str, line: &str) -> String {
    let Some(close) = element.rfind("</") else {
        return element.to_string();
    };
    let indent = element
        .find("\n")
        .map(|n| {
            element[n + 1..]
                .chars()
                .take_while(|c| c.is_whitespace() && *c != '\n')
                .collect::<String>()
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "    ".into());
    let before = element[..close].trim_end_matches([' ', '\t']);
    let tail_indent = &element[before.len()..close];
    let sep = if before.ends_with('\n') { "" } else { "\n" };
    format!("{before}{sep}{indent}{line}\n{tail_indent}{}", &element[close..])
}

/// A number as SSH files write it: integers without a decimal point.
fn num(x: f64) -> String {
    if x == 0.0 || !x.is_finite() {
        "0".into()
    } else if x.fract() == 0.0 && x.abs() < 1e15 {
        format!("{}", x as i64)
    } else {
        format!("{x}")
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    const SSH: &str = r##"<?xml version="1.0" encoding="utf-8"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:cim="http://iec.ch/TC57/2013/CIM-schema-cim16#" xmlns:md="http://iec.ch/TC57/61970-552/ModelDescription/1#">
  <md:FullModel rdf:about="urn:uuid:aaaa">
    <md:Model.created>2014-10-24T11:42:40</md:Model.created>
    <md:Model.profile>http://entsoe.eu/CIM/SteadyStateHypothesis/1/1</md:Model.profile>
  </md:FullModel>
  <cim:EnergyConsumer rdf:about="#_L1">
    <cim:EnergyConsumer.p>1.000000</cim:EnergyConsumer.p>
  </cim:EnergyConsumer>
  <cim:Terminal rdf:about="#_T1">
    <cim:ACDCTerminal.connected>true</cim:ACDCTerminal.connected>
  </cim:Terminal>
</rdf:RDF>
"##;
    const EQ: &str = r##"<?xml version="1.0" encoding="utf-8"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:cim="http://iec.ch/TC57/2013/CIM-schema-cim16#" xmlns:md="http://iec.ch/TC57/61970-552/ModelDescription/1#">
  <md:FullModel rdf:about="urn:uuid:eeee">
    <md:Model.profile>http://entsoe.eu/CIM/EquipmentCore/3/1</md:Model.profile>
  </md:FullModel>
  <cim:EnergyConsumer rdf:ID="_L1"><cim:IdentifiedObject.name>Load</cim:IdentifiedObject.name></cim:EnergyConsumer>
  <cim:Terminal rdf:ID="_T1"><cim:Terminal.ConductingEquipment rdf:resource="#_L1"/></cim:Terminal>
</rdf:RDF>
"##;

    fn files() -> Vec<File> {
        vec![
            File {
                name: "EQ.xml".into(),
                data: EQ.as_bytes().to_vec(),
            },
            File {
                name: "SSH.xml".into(),
                data: SSH.as_bytes().to_vec(),
            },
        ]
    }

    #[test]
    fn changes_replace_and_add_properties_and_supersede_the_input() -> Result<(), String> {
        let changes = [
            Change {
                id: "L1".into(),
                setting: Setting::LoadP(2.5),
            },
            Change {
                id: "L1".into(),
                setting: Setting::LoadQ(0.5),
            },
            Change {
                id: "L1".into(),
                setting: Setting::InService(false),
            },
        ];
        let opt = Options {
            created: "2026-10-10T12:00:00Z".into(),
        };
        let w = write(&files(), &changes, &opt)?;
        assert_eq!(w.files.len(), 1);
        let text = String::from_utf8_lossy(&w.files[0].data).into_owned();
        assert!(text.contains("<cim:EnergyConsumer.p>2.5</cim:EnergyConsumer.p>"));
        assert!(text.contains("    <cim:EnergyConsumer.q>0.5</cim:EnergyConsumer.q>\n  </cim:EnergyConsumer>"));
        assert!(text.contains("<cim:ACDCTerminal.connected>false</cim:ACDCTerminal.connected>"));
        assert!(text.contains("<md:Model.Supersedes rdf:resource=\"urn:uuid:aaaa\"/>"));
        assert!(text.contains("<md:Model.created>2026-10-10T12:00:00Z</md:Model.created>"));
        assert!(!text.contains("rdf:about=\"urn:uuid:aaaa\""));
        // The same changes give the same file; the rest of it is untouched.
        assert_eq!(write(&files(), &changes, &opt)?.files[0].data, w.files[0].data);
        assert!(text.starts_with("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<rdf:RDF"));
        Ok(())
    }

    #[test]
    fn unknown_elements_are_noted_and_nothing_changes_without_changes() -> Result<(), String> {
        let opt = Options::default();
        let w = write(
            &files(),
            &[Change {
                id: "nowhere".into(),
                setting: Setting::LoadP(1.0),
            }],
            &opt,
        )?;
        assert!(w.files.is_empty());
        assert_eq!(w.notes.len(), 1);
        Ok(())
    }
}
