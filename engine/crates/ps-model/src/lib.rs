//! The canonical PowerStudio network model.
//!
//! One model describes equipment as built and its present state: nodes (buses, busbar sections, connectivity nodes),
//! switches, branches, injections and areas, in engineering units. It holds both bus-branch models (MATPOWER, PSS/E,
//! drawn networks: one node per bus, no switches) and node-breaker models (CGMES: busbar sections joined by breakers
//! and disconnectors). Topology processing turns either into calculation buses.
//!
//! Elements are kept in one table per class. They refer to nodes by [`NodeRef`], a dense index into the node table.
//! Every element also has a stable string identifier; edits ([`Op`]) address elements by class and identifier, so an
//! edit log stays valid while tables grow. Removing an element marks it deleted ([`Model::alive`]) instead of shifting
//! indices; [`Model::compact`] drops deleted rows and renumbers references when a snapshot is written.

mod equipment;
mod ops;
mod snapshot;
pub mod study;
mod validate;
mod wiring;

pub use equipment::*;
pub use ops::{Element, Op, OpError};
pub use snapshot::{SNAPSHOT_MAGIC, SNAPSHOT_VERSION, SnapshotError, sha256_hex};
pub use validate::{Issue, Severity};
pub use wiring::Wiring;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// A reference to a node: its index in [`Model::nodes`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, Default)]
#[serde(transparent)]
pub struct NodeRef(pub u32);

impl NodeRef {
    /// The index as `usize`.
    pub fn index(self) -> usize {
        self.0 as usize
    }
}

/// The equipment classes of the model.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Class {
    /// [`Substation`].
    Substation,
    /// [`VoltageLevel`].
    VoltageLevel,
    /// [`Node`].
    Node,
    /// [`Switch`].
    Switch,
    /// [`Line`].
    Line,
    /// [`Transformer2`].
    Transformer2,
    /// [`Transformer3`].
    Transformer3,
    /// [`Generator`].
    Generator,
    /// [`Load`].
    Load,
    /// [`Shunt`].
    Shunt,
    /// [`Svc`].
    Svc,
    /// [`ExternalGrid`].
    ExternalGrid,
    /// [`Converter`].
    Converter,
    /// [`HvdcLine`].
    Hvdc,
    /// [`Area`].
    Area,
}

impl Class {
    /// Every class, in table order.
    pub const ALL: [Class; 15] = [
        Class::Substation,
        Class::VoltageLevel,
        Class::Node,
        Class::Switch,
        Class::Line,
        Class::Transformer2,
        Class::Transformer3,
        Class::Generator,
        Class::Load,
        Class::Shunt,
        Class::Svc,
        Class::ExternalGrid,
        Class::Converter,
        Class::Hvdc,
        Class::Area,
    ];

    /// A readable name.
    pub fn label(self) -> &'static str {
        match self {
            Class::Substation => "substation",
            Class::VoltageLevel => "voltage level",
            Class::Node => "node",
            Class::Switch => "switch",
            Class::Line => "line",
            Class::Transformer2 => "two-winding transformer",
            Class::Transformer3 => "three-winding transformer",
            Class::Generator => "generator",
            Class::Load => "load",
            Class::Shunt => "shunt",
            Class::Svc => "static var compensator",
            Class::ExternalGrid => "external grid",
            Class::Converter => "converter station",
            Class::Hvdc => "HVDC link",
            Class::Area => "area",
        }
    }
}

/// Model-wide settings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    /// Model name.
    pub name: String,
    /// Free description.
    pub description: String,
    /// Base power for per-unit calculations, MVA.
    pub base_mva: f64,
    /// System frequency, Hz.
    pub frequency_hz: f64,
}

impl Default for Meta {
    fn default() -> Self {
        Self {
            name: String::new(),
            description: String::new(),
            base_mva: 100.0,
            frequency_hz: 50.0,
        }
    }
}

/// The network model.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    /// Model-wide settings.
    pub meta: Meta,
    /// Substations.
    pub substations: Vec<Substation>,
    /// Voltage levels.
    pub voltage_levels: Vec<VoltageLevel>,
    /// Nodes.
    pub nodes: Vec<Node>,
    /// Switches.
    pub switches: Vec<Switch>,
    /// Lines and cables.
    pub lines: Vec<Line>,
    /// Two-winding transformers.
    pub transformers2: Vec<Transformer2>,
    /// Three-winding transformers.
    pub transformers3: Vec<Transformer3>,
    /// Generating units.
    pub generators: Vec<Generator>,
    /// Loads.
    pub loads: Vec<Load>,
    /// Shunt compensators.
    pub shunts: Vec<Shunt>,
    /// Static var compensators.
    pub svcs: Vec<Svc>,
    /// External grids.
    pub external_grids: Vec<ExternalGrid>,
    /// HVDC converter stations.
    #[serde(default)]
    pub converters: Vec<Converter>,
    /// HVDC links.
    #[serde(default)]
    pub hvdc_lines: Vec<HvdcLine>,
    /// Control areas.
    pub areas: Vec<Area>,
    /// Deleted rows per class (sorted indices), until the next compaction.
    #[serde(default)]
    pub deleted: Vec<(Class, Vec<u32>)>,
}

impl Model {
    /// An empty model with a name.
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            meta: Meta {
                name: name.into(),
                ..Meta::default()
            },
            ..Self::default()
        }
    }

    /// Number of rows (alive or not) in a class table.
    pub fn len(&self, class: Class) -> usize {
        match class {
            Class::Substation => self.substations.len(),
            Class::VoltageLevel => self.voltage_levels.len(),
            Class::Node => self.nodes.len(),
            Class::Switch => self.switches.len(),
            Class::Line => self.lines.len(),
            Class::Transformer2 => self.transformers2.len(),
            Class::Transformer3 => self.transformers3.len(),
            Class::Generator => self.generators.len(),
            Class::Load => self.loads.len(),
            Class::Shunt => self.shunts.len(),
            Class::Svc => self.svcs.len(),
            Class::ExternalGrid => self.external_grids.len(),
            Class::Converter => self.converters.len(),
            Class::Hvdc => self.hvdc_lines.len(),
            Class::Area => self.areas.len(),
        }
    }

    /// True when the model has no rows at all.
    pub fn is_empty(&self) -> bool {
        Class::ALL.iter().all(|&c| self.len(c) == 0)
    }

    /// Whether row `index` of a class is alive (not deleted).
    pub fn alive(&self, class: Class, index: usize) -> bool {
        match self.deleted.iter().find(|(c, _)| *c == class) {
            Some((_, rows)) => rows.binary_search(&(index as u32)).is_err(),
            None => true,
        }
    }

    /// The identifier of a row.
    pub fn id_of(&self, class: Class, index: usize) -> Option<&str> {
        let s = match class {
            Class::Substation => &self.substations.get(index)?.id,
            Class::VoltageLevel => &self.voltage_levels.get(index)?.id,
            Class::Node => &self.nodes.get(index)?.id,
            Class::Switch => &self.switches.get(index)?.id,
            Class::Line => &self.lines.get(index)?.id,
            Class::Transformer2 => &self.transformers2.get(index)?.id,
            Class::Transformer3 => &self.transformers3.get(index)?.id,
            Class::Generator => &self.generators.get(index)?.id,
            Class::Load => &self.loads.get(index)?.id,
            Class::Shunt => &self.shunts.get(index)?.id,
            Class::Svc => &self.svcs.get(index)?.id,
            Class::ExternalGrid => &self.external_grids.get(index)?.id,
            Class::Converter => &self.converters.get(index)?.id,
            Class::Hvdc => &self.hvdc_lines.get(index)?.id,
            Class::Area => &self.areas.get(index)?.id,
        };
        Some(s)
    }

    /// The display name of a row, falling back to its identifier.
    pub fn name_of(&self, class: Class, index: usize) -> &str {
        let name = match class {
            Class::Substation => self.substations.get(index).map(|e| e.name.as_str()),
            Class::VoltageLevel => self.voltage_levels.get(index).map(|e| e.name.as_str()),
            Class::Node => self.nodes.get(index).map(|e| e.name.as_str()),
            Class::Switch => self.switches.get(index).map(|e| e.name.as_str()),
            Class::Line => self.lines.get(index).map(|e| e.name.as_str()),
            Class::Transformer2 => self.transformers2.get(index).map(|e| e.name.as_str()),
            Class::Transformer3 => self.transformers3.get(index).map(|e| e.name.as_str()),
            Class::Generator => self.generators.get(index).map(|e| e.name.as_str()),
            Class::Load => self.loads.get(index).map(|e| e.name.as_str()),
            Class::Shunt => self.shunts.get(index).map(|e| e.name.as_str()),
            Class::Svc => self.svcs.get(index).map(|e| e.name.as_str()),
            Class::ExternalGrid => self.external_grids.get(index).map(|e| e.name.as_str()),
            Class::Converter => self.converters.get(index).map(|e| e.name.as_str()),
            Class::Hvdc => self.hvdc_lines.get(index).map(|e| e.name.as_str()),
            Class::Area => self.areas.get(index).map(|e| e.name.as_str()),
        };
        match name {
            Some(n) if !n.is_empty() => n,
            _ => self.id_of(class, index).unwrap_or(""),
        }
    }

    /// An index from identifier to (class, row) over alive rows. Identifiers are unique within a class.
    pub fn index(&self) -> IdIndex {
        let mut map = HashMap::new();
        for class in Class::ALL {
            for i in 0..self.len(class) {
                if self.alive(class, i)
                    && let Some(id) = self.id_of(class, i)
                {
                    map.insert((class, id.to_string()), i as u32);
                }
            }
        }
        IdIndex { map }
    }

    /// Nominal voltage of a node, kV.
    pub fn nominal_kv(&self, node: NodeRef) -> f64 {
        self.nodes.get(node.index()).map_or(0.0, |n| n.nominal_kv)
    }
}

/// Looks up rows by class and identifier.
#[derive(Debug, Clone, Default)]
pub struct IdIndex {
    map: HashMap<(Class, String), u32>,
}

impl IdIndex {
    /// The row of an element.
    pub fn get(&self, class: Class, id: &str) -> Option<usize> {
        self.map.get(&(class, id.to_string())).map(|&i| i as usize)
    }

    /// Records a new row.
    pub fn insert(&mut self, class: Class, id: &str, index: usize) {
        self.map.insert((class, id.to_string()), index as u32);
    }

    /// Forgets a row.
    pub fn remove(&mut self, class: Class, id: &str) {
        self.map.remove(&(class, id.to_string()));
    }
}
