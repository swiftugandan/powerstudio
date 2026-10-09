//! Edit operations. Every change to a model is an [`Op`]; applying one returns its inverse, so undo is applying the
//! inverse and an edit log replays a session exactly.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::equipment::*;
use crate::wiring::Wiring;
use crate::{Class, IdIndex, Model, NodeRef};

/// Why an operation was refused. A refused operation leaves the model unchanged.
#[derive(Debug, Clone, PartialEq)]
pub enum OpError {
    /// No alive element of the class has the identifier.
    NotFound(Class, String),
    /// An alive element of the class already has the identifier.
    Duplicate(Class, String),
    /// The element would refer to a node or container that does not exist or is deleted.
    BadReference(Class, String, String),
    /// Other elements still refer to the element being removed.
    InUse(Class, String, usize),
    /// A field edit named an unknown field or gave a value of the wrong type.
    BadField(Class, String, String),
}

impl std::fmt::Display for OpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound(c, id) => write!(f, "there is no {} \"{id}\"", c.label()),
            Self::Duplicate(c, id) => write!(f, "a {} \"{id}\" already exists", c.label()),
            Self::BadReference(c, id, what) => write!(f, "{} \"{id}\": {what}", c.label()),
            Self::InUse(c, id, n) => {
                write!(f, "{} \"{id}\" is still used by {n} element(s)", c.label())
            }
            Self::BadField(c, id, what) => write!(f, "{} \"{id}\": {what}", c.label()),
        }
    }
}

impl std::error::Error for OpError {}

macro_rules! classes {
    ($($variant:ident => $field:ident: $ty:ty),* $(,)?) => {
        /// One element of any class.
        #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
        #[serde(tag = "class", content = "data", rename_all = "camelCase")]
        pub enum Element {
            $(
                #[doc = concat!("A [`", stringify!($ty), "`].")]
                $variant($ty),
            )*
        }

        impl Element {
            /// The element's class.
            pub fn class(&self) -> Class {
                match self {
                    $(Element::$variant(_) => Class::$variant,)*
                }
            }

            /// The element's identifier.
            pub fn id(&self) -> &str {
                match self {
                    $(Element::$variant(e) => &e.id,)*
                }
            }

            /// The nodes the element refers to.
            pub fn nodes(&self) -> Vec<NodeRef> {
                match self {
                    $(Element::$variant(e) => e.nodes(),)*
                }
            }

            fn to_value(&self) -> Result<Value, String> {
                match self {
                    $(Element::$variant(e) => serde_json::to_value(e).map_err(|e| e.to_string()),)*
                }
            }

            fn from_value(class: Class, v: Value) -> Result<Self, String> {
                match class {
                    $(Class::$variant => serde_json::from_value(v).map(Element::$variant).map_err(|e| e.to_string()),)*
                }
            }
        }

        impl Model {
            /// A copy of one row as an [`Element`].
            pub fn element(&self, class: Class, row: usize) -> Option<Element> {
                match class {
                    $(Class::$variant => self.$field.get(row).cloned().map(Element::$variant),)*
                }
            }

            /// The nodes row `row` of a class refers to.
            pub fn element_nodes(&self, class: Class, row: usize) -> Vec<NodeRef> {
                match class {
                    $(Class::$variant => self.$field.get(row).map(Wiring::nodes).unwrap_or_default(),)*
                }
            }

            pub(crate) fn rewire(&mut self, map: &dyn Fn(NodeRef) -> NodeRef) {
                $(
                    for e in &mut self.$field {
                        for r in e.nodes_mut() {
                            *r = map(*r);
                        }
                    }
                )*
            }

            pub(crate) fn retain_rows(&mut self, class: Class, keep: &[bool]) {
                fn retain<T>(v: &mut Vec<T>, keep: &[bool]) {
                    let mut i = 0;
                    v.retain(|_| {
                        let k = keep.get(i).copied().unwrap_or(true);
                        i += 1;
                        k
                    });
                }
                match class {
                    $(Class::$variant => retain(&mut self.$field, keep),)*
                }
            }

            fn push_element(&mut self, e: Element) -> usize {
                match e {
                    $(Element::$variant(v) => {
                        self.$field.push(v);
                        self.$field.len() - 1
                    })*
                }
            }

            /// Replaces a row and returns the previous record. The classes must match.
            fn put_element(&mut self, row: usize, e: Element) -> Option<Element> {
                match e {
                    $(Element::$variant(v) => self
                        .$field
                        .get_mut(row)
                        .map(|slot| Element::$variant(std::mem::replace(slot, v))),)*
                }
            }
        }
    };
}

classes! {
    Substation => substations: Substation,
    VoltageLevel => voltage_levels: VoltageLevel,
    Node => nodes: Node,
    Switch => switches: Switch,
    Line => lines: Line,
    Transformer2 => transformers2: Transformer2,
    Transformer3 => transformers3: Transformer3,
    Generator => generators: Generator,
    Load => loads: Load,
    Shunt => shunts: Shunt,
    Svc => svcs: Svc,
    ExternalGrid => external_grids: ExternalGrid,
    Converter => converters: Converter,
    Hvdc => hvdc_lines: HvdcLine,
    Area => areas: Area,
}

/// One edit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum Op {
    /// Adds an element. Its identifier must be new within its class.
    Insert {
        /// The element.
        element: Element,
    },
    /// Replaces an element's whole record; the identifier stays the same.
    Replace {
        /// The new record.
        element: Element,
    },
    /// Changes one field of an element, addressed by its camelCase name (as in the JSON form of the record).
    Set {
        /// Class of the element.
        class: Class,
        /// Identifier of the element.
        id: String,
        /// Field name.
        field: String,
        /// New value.
        value: Value,
    },
    /// Removes an element. Refused while other alive elements still refer to it.
    Remove {
        /// Class of the element.
        class: Class,
        /// Identifier of the element.
        id: String,
    },
    /// Brings back the most recently removed element with the identifier (the inverse of [`Op::Remove`]).
    Restore {
        /// Class of the element.
        class: Class,
        /// Identifier of the element.
        id: String,
    },
    /// Several edits applied as one: all succeed or none do.
    Batch {
        /// The edits, in order.
        ops: Vec<Op>,
    },
}

impl Model {
    /// Applies an edit and returns its inverse. `index` must be the model's [`IdIndex`]; it is kept up to date.
    pub fn apply(&mut self, op: Op, index: &mut IdIndex) -> Result<Op, OpError> {
        match op {
            Op::Insert { element } => {
                let (class, id) = (element.class(), element.id().to_string());
                if index.get(class, &id).is_some() {
                    return Err(OpError::Duplicate(class, id));
                }
                self.check_references(&element)?;
                let row = self.push_element(element);
                index.insert(class, &id, row);
                Ok(Op::Remove { class, id })
            }
            Op::Replace { element } => {
                let (class, id) = (element.class(), element.id().to_string());
                let row = index
                    .get(class, &id)
                    .ok_or_else(|| OpError::NotFound(class, id.clone()))?;
                self.check_references(&element)?;
                let old = self
                    .put_element(row, element)
                    .ok_or_else(|| OpError::NotFound(class, id.clone()))?;
                Ok(Op::Replace { element: old })
            }
            Op::Set {
                class,
                id,
                field,
                value,
            } => {
                let row = index
                    .get(class, &id)
                    .ok_or_else(|| OpError::NotFound(class, id.clone()))?;
                let current = self
                    .element(class, row)
                    .ok_or_else(|| OpError::NotFound(class, id.clone()))?;
                let mut record = current
                    .to_value()
                    .map_err(|e| OpError::BadField(class, id.clone(), e))?;
                let slot = record
                    .get_mut(&field)
                    .ok_or_else(|| OpError::BadField(class, id.clone(), format!("there is no field \"{field}\"")))?;
                if field == "id" {
                    return Err(OpError::BadField(class, id, "the identifier cannot be changed".into()));
                }
                let previous = std::mem::replace(slot, value);
                let updated = Element::from_value(class, record)
                    .map_err(|e| OpError::BadField(class, id.clone(), format!("field \"{field}\": {e}")))?;
                self.check_references(&updated)?;
                self.put_element(row, updated);
                Ok(Op::Set {
                    class,
                    id,
                    field,
                    value: previous,
                })
            }
            Op::Remove { class, id } => {
                let row = index
                    .get(class, &id)
                    .ok_or_else(|| OpError::NotFound(class, id.clone()))?;
                let users = self.users_of(class, row);
                if users > 0 {
                    return Err(OpError::InUse(class, id, users));
                }
                self.mark_deleted(class, row, true);
                index.remove(class, &id);
                Ok(Op::Restore { class, id })
            }
            Op::Restore { class, id } => {
                if index.get(class, &id).is_some() {
                    return Err(OpError::Duplicate(class, id));
                }
                let row = (0..self.len(class))
                    .rev()
                    .find(|&r| !self.alive(class, r) && self.id_of(class, r) == Some(id.as_str()))
                    .ok_or_else(|| OpError::NotFound(class, id.clone()))?;
                if let Some(e) = self.element(class, row) {
                    self.check_references(&e)?;
                }
                self.mark_deleted(class, row, false);
                index.insert(class, &id, row);
                Ok(Op::Remove { class, id })
            }
            Op::Batch { ops } => {
                let mut inverses = Vec::with_capacity(ops.len());
                for op in ops {
                    match self.apply(op, index) {
                        Ok(inv) => inverses.push(inv),
                        Err(e) => {
                            // Roll back what was applied, newest first. Inverses of applied edits always apply.
                            for inv in inverses.into_iter().rev() {
                                let _ = self.apply(inv, index);
                            }
                            return Err(e);
                        }
                    }
                }
                inverses.reverse();
                Ok(Op::Batch { ops: inverses })
            }
        }
    }

    fn mark_deleted(&mut self, class: Class, row: usize, deleted: bool) {
        let pos = match self.deleted.iter().position(|(c, _)| *c == class) {
            Some(p) => p,
            None => {
                self.deleted.push((class, Vec::new()));
                self.deleted.len() - 1
            }
        };
        let rows = &mut self.deleted[pos].1;
        match (rows.binary_search(&(row as u32)), deleted) {
            (Err(at), true) => rows.insert(at, row as u32),
            (Ok(at), false) => {
                rows.remove(at);
            }
            _ => {}
        }
        if rows.is_empty() {
            self.deleted.remove(pos);
        }
    }

    /// Alive elements that refer to row `row` of a class (nodes, voltage levels, substations and areas are referred
    /// to; other classes never are).
    pub fn users_of(&self, class: Class, row: usize) -> usize {
        let r = row as u32;
        match class {
            Class::Node => Class::ALL
                .iter()
                .map(|&c| {
                    (0..self.len(c))
                        .filter(|&i| self.alive(c, i) && self.element_nodes(c, i).contains(&NodeRef(r)))
                        .count()
                })
                .sum(),
            Class::VoltageLevel => (0..self.nodes.len())
                .filter(|&i| self.alive(Class::Node, i) && self.nodes[i].voltage_level == Some(r))
                .count(),
            Class::Substation => (0..self.voltage_levels.len())
                .filter(|&i| self.alive(Class::VoltageLevel, i) && self.voltage_levels[i].substation == Some(r))
                .count(),
            Class::Area => (0..self.nodes.len())
                .filter(|&i| self.alive(Class::Node, i) && self.nodes[i].area == Some(r))
                .count(),
            _ => 0,
        }
    }

    fn check_references(&self, e: &Element) -> Result<(), OpError> {
        let bad = |what: String| OpError::BadReference(e.class(), e.id().to_string(), what);
        for n in e.nodes() {
            if n.index() >= self.nodes.len() || !self.alive(Class::Node, n.index()) {
                return Err(bad(format!("node #{} does not exist", n.0)));
            }
        }
        let container = |class: Class, r: Option<u32>| -> Result<(), OpError> {
            match r {
                Some(r) if (r as usize) >= self.len(class) || !self.alive(class, r as usize) => {
                    Err(bad(format!("{} #{r} does not exist", class.label())))
                }
                _ => Ok(()),
            }
        };
        match e {
            Element::Node(n) => {
                container(Class::VoltageLevel, n.voltage_level)?;
                container(Class::Area, n.area)
            }
            Element::VoltageLevel(v) => container(Class::Substation, v.substation),
            _ => Ok(()),
        }
    }
}
