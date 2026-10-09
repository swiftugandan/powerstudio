//! CIM RDF/XML, the serialisation of CGMES: objects with properties, spread over one file per profile.
//!
//! Every file is read with a streaming parser into one [`Graph`]. An object defined in the equipment profile
//! (`rdf:ID`) and described again in the steady-state hypothesis or topology profiles (`rdf:about`) is one object
//! with the properties of all of them. Identifiers are normalised by dropping `#`, `urn:uuid:` and a leading `_`,
//! which is also how PowSyBl names CGMES objects, so results compare by identifier. Class and property names keep
//! their CIM local names (`ACLineSegment`, `ACLineSegment.r`), whatever namespace prefix a file uses.

use quick_xml::events::Event;
use std::collections::HashMap;

use crate::ParseError;

/// An interned class or property name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Sym(u32);

/// A property value.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    /// A literal.
    Text(Box<str>),
    /// A reference to another object, by normalised identifier.
    Ref(Box<str>),
    /// An enumeration value: the fragment of its URI, such as `WindingConnection.D`.
    Enum(Box<str>),
}

/// One object.
#[derive(Debug, Clone, PartialEq)]
pub struct Object {
    /// Normalised identifier.
    pub id: Box<str>,
    /// Class, from the first file that names the object.
    pub class: Sym,
    /// Properties in reading order (a property may repeat).
    pub props: Vec<(Sym, Value)>,
}

/// The header of one file (`md:FullModel`).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Header {
    /// File name.
    pub file: String,
    /// Model identifier.
    pub id: String,
    /// Profile URIs.
    pub profiles: Vec<String>,
}

/// Objects read from one or more files.
#[derive(Debug, Default)]
pub struct Graph {
    names: Vec<Box<str>>,
    name_index: HashMap<Box<str>, Sym>,
    /// Every object.
    pub objects: Vec<Object>,
    index: HashMap<Box<str>, u32>,
    by_class: HashMap<Sym, Vec<u32>>,
    /// File headers in reading order.
    pub headers: Vec<Header>,
}

/// Drops `#`, `urn:uuid:` and a leading `_` from an identifier.
pub fn normalise(id: &str) -> &str {
    let id = id.strip_prefix('#').unwrap_or(id);
    let id = id.strip_prefix("urn:uuid:").unwrap_or(id);
    id.strip_prefix('_').unwrap_or(id)
}

fn local(name: &str) -> &str {
    name.rsplit(':').next().unwrap_or(name)
}

impl Graph {
    /// An empty graph.
    pub fn new() -> Self {
        Self::default()
    }

    /// Interns a name.
    pub fn sym(&mut self, name: &str) -> Sym {
        if let Some(&s) = self.name_index.get(name) {
            return s;
        }
        let s = Sym(self.names.len() as u32);
        self.names.push(name.into());
        self.name_index.insert(name.into(), s);
        s
    }

    /// The symbol of a name, if any object or property uses it.
    pub fn lookup(&self, name: &str) -> Option<Sym> {
        self.name_index.get(name).copied()
    }

    /// The name of a symbol.
    pub fn name(&self, s: Sym) -> &str {
        self.names.get(s.0 as usize).map_or("", |n| n)
    }

    /// The object with an identifier (normalised or not).
    pub fn get(&self, id: &str) -> Option<&Object> {
        self.index.get(normalise(id)).map(|&i| &self.objects[i as usize])
    }

    /// Objects of a class, in reading order.
    pub fn of_class<'a>(&'a self, class: &str) -> impl Iterator<Item = &'a Object> + 'a {
        let rows: &[u32] = self
            .lookup(class)
            .and_then(|s| self.by_class.get(&s))
            .map_or(&[], |v| v.as_slice());
        rows.iter().map(|&i| &self.objects[i as usize])
    }

    /// Number of objects per class name, sorted by name.
    pub fn class_counts(&self) -> Vec<(String, usize)> {
        let mut v: Vec<(String, usize)> = self
            .by_class
            .iter()
            .map(|(&s, rows)| (self.name(s).to_string(), rows.len()))
            .collect();
        v.sort();
        v
    }

    /// The first value of a property.
    pub fn value<'a>(&self, o: &'a Object, prop: &str) -> Option<&'a Value> {
        let s = self.lookup(prop)?;
        o.props.iter().find(|(p, _)| *p == s).map(|(_, v)| v)
    }

    /// A literal property.
    pub fn text<'a>(&self, o: &'a Object, prop: &str) -> Option<&'a str> {
        match self.value(o, prop)? {
            Value::Text(t) => Some(t),
            _ => None,
        }
    }

    /// A numeric property.
    pub fn num(&self, o: &Object, prop: &str) -> Option<f64> {
        self.text(o, prop)
            .and_then(|t| t.trim().parse::<f64>().ok())
            .filter(|v| v.is_finite())
    }

    /// A boolean property.
    pub fn flag(&self, o: &Object, prop: &str) -> Option<bool> {
        match self.text(o, prop)?.trim() {
            "true" | "1" => Some(true),
            "false" | "0" => Some(false),
            _ => None,
        }
    }

    /// A reference property, as the referenced object's identifier.
    pub fn reference<'a>(&self, o: &'a Object, prop: &str) -> Option<&'a str> {
        match self.value(o, prop)? {
            Value::Ref(r) => Some(r),
            _ => None,
        }
    }

    /// The object a reference property points to.
    pub fn follow(&self, o: &Object, prop: &str) -> Option<&Object> {
        self.reference(o, prop).and_then(|r| self.get(r))
    }

    /// An enumeration property, as the part after the last `.` (`WindingConnection.Yn` gives `Yn`).
    pub fn enumeration<'a>(&self, o: &'a Object, prop: &str) -> Option<&'a str> {
        match self.value(o, prop)? {
            Value::Enum(e) => Some(e.rsplit('.').next().unwrap_or(e)),
            _ => None,
        }
    }

    /// The object with an identifier, created if new. A definition (`rdf:ID`) sets the class, so an object first
    /// described under an abstract class in another profile (`Equipment`) still gets its concrete one.
    fn object(&mut self, id: &str, class: &str, definition: bool) -> u32 {
        let id = normalise(id);
        if let Some(&i) = self.index.get(id) {
            let sym = self.sym(class);
            let old = self.objects[i as usize].class;
            if definition && old != sym {
                if let Some(rows) = self.by_class.get_mut(&old) {
                    rows.retain(|&r| r != i);
                }
                self.objects[i as usize].class = sym;
                let rows = self.by_class.entry(sym).or_default();
                let at = rows.partition_point(|&r| r < i);
                rows.insert(at, i);
            }
            return i;
        }
        let class = self.sym(class);
        let i = self.objects.len() as u32;
        self.objects.push(Object {
            id: id.into(),
            class,
            props: Vec::new(),
        });
        self.index.insert(id.into(), i);
        self.by_class.entry(class).or_default().push(i);
        i
    }

    /// Reads one RDF/XML file into the graph.
    pub fn read(&mut self, file: &str, xml: &[u8]) -> Result<(), ParseError> {
        let mut reader = quick_xml::Reader::from_reader(xml);
        reader.config_mut().trim_text(false);
        let mut buf = Vec::new();
        let mut depth = 0usize;
        // The object being described and the property being read.
        let mut current: Option<u32> = None;
        let mut header: Option<Header> = None;
        let mut prop: Option<Sym> = None;
        let mut text = String::new();
        let err = |e: &dyn std::fmt::Display, pos: u64| ParseError::new(format!("{file}: {e} (byte {pos})"), None);
        loop {
            let pos = reader.buffer_position();
            let event = reader.read_event_into(&mut buf).map_err(|e| err(&e, pos))?;
            match event {
                Event::Start(ref e) | Event::Empty(ref e) => {
                    let empty = matches!(event, Event::Empty(_));
                    let name = local(e.name().as_ref()).to_string();
                    let mut about = None;
                    let mut definition = false;
                    let mut resource = None;
                    for a in e.attributes() {
                        let a = a.map_err(|e| err(&e, pos))?;
                        let key = local(a.key.as_ref());
                        if key == "ID" || key == "about" || key == "resource" {
                            let v = a
                                .normalized_value(quick_xml::XmlVersion::Implicit1_0)
                                .map_err(|e| err(&e, pos))?
                                .into_owned();
                            if key == "resource" {
                                resource = Some(v);
                            } else {
                                definition = key == "ID";
                                about = Some(v);
                            }
                        }
                    }
                    match depth {
                        1 if name == "FullModel" => {
                            header = Some(Header {
                                file: file.into(),
                                id: about.unwrap_or_default(),
                                profiles: Vec::new(),
                            })
                        }
                        1 => {
                            current = about.map(|id| self.object(&id, &name, definition)).filter(|_| !empty);
                        }
                        2 => {
                            let s = self.sym(&name);
                            if let Some(r) = resource {
                                let v = if r.starts_with("http") {
                                    Value::Enum(r.rsplit('#').next().unwrap_or(&r).into())
                                } else {
                                    Value::Ref(normalise(&r).into())
                                };
                                self.push(current, &mut header, s, v);
                            } else if !empty {
                                prop = Some(s);
                                text.clear();
                            }
                        }
                        _ => {}
                    }
                    if !empty {
                        depth += 1;
                    }
                }
                Event::Text(t) if prop.is_some() => text.push_str(&t.xml10_content()),
                Event::CData(t) if prop.is_some() => text.push_str(&t.into_inner()),
                Event::GeneralRef(r) if prop.is_some() => {
                    let name = r.into_inner();
                    text.push_str(&entity(&name).ok_or_else(|| err(&format!("unknown entity &{name};"), pos))?);
                }
                Event::End(_) => {
                    depth = depth.saturating_sub(1);
                    match depth {
                        2 => {
                            if let Some(s) = prop.take() {
                                let v = Value::Text(text.trim().into());
                                self.push(current, &mut header, s, v);
                            }
                        }
                        1 => {
                            current = None;
                            if let Some(h) = header.take() {
                                self.headers.push(h);
                            }
                        }
                        _ => {}
                    }
                }
                Event::Eof => break,
                _ => {}
            }
            buf.clear();
        }
        Ok(())
    }

    fn push(&mut self, current: Option<u32>, header: &mut Option<Header>, s: Sym, v: Value) {
        if let Some(h) = header.as_mut() {
            if self.name(s) == "Model.profile"
                && let Value::Text(t) = &v
            {
                h.profiles.push(t.to_string());
            }
            return;
        }
        if let Some(i) = current {
            self.objects[i as usize].props.push((s, v));
        }
    }
}

/// The text of a predefined or character entity.
fn entity(name: &str) -> Option<String> {
    Some(match name {
        "amp" => "&".into(),
        "lt" => "<".into(),
        "gt" => ">".into(),
        "quot" => "\"".into(),
        "apos" => "'".into(),
        _ => {
            let code = name.strip_prefix('#')?;
            let n = match code.strip_prefix('x') {
                Some(hex) => u32::from_str_radix(hex, 16).ok()?,
                None => code.parse().ok()?,
            };
            char::from_u32(n)?.to_string()
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const EQ: &str = r##"<?xml version="1.0" encoding="utf-8"?>
<rdf:RDF xmlns:cim="http://iec.ch/TC57/CIM100#" xmlns:md="http://iec.ch/TC57/61970-552/ModelDescription/1#" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <md:FullModel rdf:about="urn:uuid:m1"><md:Model.profile>http://iec.ch/TC57/ns/CIM/CoreEquipment-EU/3.0</md:Model.profile></md:FullModel>
  <cim:ACLineSegment rdf:ID="_L1">
    <cim:IdentifiedObject.name>Line &amp; one</cim:IdentifiedObject.name>
    <cim:ACLineSegment.r>1.5</cim:ACLineSegment.r>
    <cim:ConductingEquipment.BaseVoltage rdf:resource="#_BV"/>
  </cim:ACLineSegment>
  <cim:PowerTransformerEnd rdf:ID="_E1"><cim:PowerTransformerEnd.connectionKind rdf:resource="http://iec.ch/TC57/CIM100#WindingConnection.Yn"/></cim:PowerTransformerEnd>
</rdf:RDF>"##;
    const SSH: &str = r##"<rdf:RDF xmlns:cim="http://iec.ch/TC57/CIM100#" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <cim:ACLineSegment rdf:about="#_L1"><cim:Equipment.inService>false</cim:Equipment.inService></cim:ACLineSegment>
</rdf:RDF>"##;

    #[test]
    fn merges_profiles_by_identifier() -> Result<(), ParseError> {
        let mut g = Graph::new();
        g.read("EQ.xml", EQ.as_bytes())?;
        g.read("SSH.xml", SSH.as_bytes())?;
        let l = g.get("L1").ok_or_else(|| ParseError::new("L1 missing", None))?;
        assert_eq!(g.name(l.class), "ACLineSegment");
        assert_eq!(g.text(l, "IdentifiedObject.name"), Some("Line & one"));
        assert_eq!(g.num(l, "ACLineSegment.r"), Some(1.5));
        assert_eq!(g.reference(l, "ConductingEquipment.BaseVoltage"), Some("BV"));
        assert_eq!(g.flag(l, "Equipment.inService"), Some(false));
        let e = g.get("#_E1").ok_or_else(|| ParseError::new("E1 missing", None))?;
        assert_eq!(g.enumeration(e, "PowerTransformerEnd.connectionKind"), Some("Yn"));
        assert_eq!(
            g.headers[0].profiles,
            ["http://iec.ch/TC57/ns/CIM/CoreEquipment-EU/3.0"]
        );
        assert_eq!(g.of_class("ACLineSegment").count(), 1);
        Ok(())
    }

    #[test]
    fn a_definition_sets_the_class_whatever_the_file_order() -> Result<(), ParseError> {
        let ssh = r##"<rdf:RDF xmlns:cim="http://iec.ch/TC57/CIM100#" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <cim:Equipment rdf:about="#_T1"><cim:Equipment.inService>true</cim:Equipment.inService></cim:Equipment>
</rdf:RDF>"##;
        let eq = r##"<rdf:RDF xmlns:cim="http://iec.ch/TC57/CIM100#" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <cim:PowerTransformer rdf:ID="_T1"><cim:IdentifiedObject.name>T</cim:IdentifiedObject.name></cim:PowerTransformer>
</rdf:RDF>"##;
        let mut g = Graph::new();
        g.read("SSH.xml", ssh.as_bytes())?;
        g.read("EQ.xml", eq.as_bytes())?;
        assert_eq!(g.of_class("PowerTransformer").count(), 1);
        assert_eq!(g.of_class("Equipment").count(), 0);
        let t = g.get("T1").ok_or_else(|| ParseError::new("T1 missing", None))?;
        assert_eq!(g.flag(t, "Equipment.inService"), Some(true));
        Ok(())
    }
}
