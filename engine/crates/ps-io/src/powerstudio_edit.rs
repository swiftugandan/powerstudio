//! A PowerStudio document held open between calculations and kept in step with the editor by its edit operations,
//! so a calculation after an edit converts the document ([`OpenDocument::convert`]) without reading its text again.
//!
//! The operations are the editor's (`src/core/store.js`), as JSON:
//!
//! | `type` | Fields | Effect |
//! | --- | --- | --- |
//! | `set` | `id`, `key`, `after` | sets one field of an element |
//! | `add` | `el`, `index` | inserts an element at a position |
//! | `remove` | `el` (its `id` is used) | removes an element |
//! | `doc` | `key`, `after` | sets a document field (name, base power, frequency, …) |
//! | `study` | `section`, `key`, `after` | sets one study case setting |

use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value};

use crate::ParseError;
use crate::powerstudio::{Imported, from_value};

/// An open document: its JSON tree and an index of its elements by identifier.
#[derive(Debug)]
pub struct OpenDocument {
    doc: Value,
    index: HashMap<String, usize>,
}

impl OpenDocument {
    /// Reads a document's text.
    pub fn open(text: &str) -> Result<Self, ParseError> {
        let doc: Value = serde_json::from_str(text)
            .map_err(|e| ParseError::new(format!("the document is not valid JSON: {e}"), Some(e.line())))?;
        if !doc.is_object() {
            return Err(ParseError::new("the document is not a JSON object", None));
        }
        let mut open = Self {
            doc,
            index: HashMap::new(),
        };
        open.reindex();
        Ok(open)
    }

    fn elements(&mut self) -> Result<&mut Vec<Value>, ParseError> {
        self.doc
            .get_mut("elements")
            .and_then(Value::as_array_mut)
            .ok_or_else(|| ParseError::new("the document has no element list", None))
    }

    fn reindex(&mut self) {
        self.index = self
            .doc
            .get("elements")
            .and_then(Value::as_array)
            .map(|els| {
                els.iter()
                    .enumerate()
                    .filter_map(|(i, e)| Some((e.get("id")?.as_str()?.to_string(), i)))
                    .collect()
            })
            .unwrap_or_default();
    }

    /// Applies the editor's operations in order. An operation that cannot apply (an unknown element, a malformed
    /// operation) stops there with an error and leaves the document as far as it got; the editor then sends the whole
    /// document again. A run of removals (deleting a selection) is applied in one pass, and the index is rebuilt once
    /// after a run of additions or removals.
    pub fn apply(&mut self, ops: &[Value]) -> Result<(), ParseError> {
        let kind = |op: &Value| op.get("type").and_then(Value::as_str).map(str::to_string);
        let mut k = 0;
        while k < ops.len() {
            if kind(&ops[k]).as_deref() == Some("remove") {
                let mut gone = HashSet::new();
                while k < ops.len() && kind(&ops[k]).as_deref() == Some("remove") {
                    let id = ops[k]
                        .get("el")
                        .and_then(|e| e.get("id"))
                        .and_then(Value::as_str)
                        .ok_or_else(|| ParseError::new("a removal names no element", None))?;
                    gone.insert(id.to_string());
                    k += 1;
                }
                self.elements()?
                    .retain(|e| e.get("id").and_then(Value::as_str).is_none_or(|id| !gone.contains(id)));
                self.reindex();
                continue;
            }
            if kind(&ops[k]).as_deref() == Some("add") {
                while k < ops.len() && kind(&ops[k]).as_deref() == Some("add") {
                    let el = ops[k]
                        .get("el")
                        .ok_or_else(|| ParseError::new("an addition has no element", None))?
                        .clone();
                    let els = self.elements()?;
                    let at = ops[k]
                        .get("index")
                        .and_then(Value::as_u64)
                        .and_then(|i| usize::try_from(i).ok())
                        .map_or(els.len(), |i| i.min(els.len()));
                    els.insert(at, el);
                    k += 1;
                }
                self.reindex();
                continue;
            }
            let op = &ops[k];
            k += 1;
            let field = |k: &str| {
                op.get(k)
                    .ok_or_else(|| ParseError::new(format!("an edit has no {k}"), None))
            };
            let text = |k: &str| {
                field(k).and_then(|v| {
                    v.as_str()
                        .ok_or_else(|| ParseError::new(format!("an edit's {k} is not text"), None))
                })
            };
            match op.get("type").and_then(Value::as_str) {
                Some("set") => {
                    let (id, key, after) = (text("id")?, text("key")?, field("after")?.clone());
                    let i = *self
                        .index
                        .get(id)
                        .ok_or_else(|| ParseError::new(format!("the edit names an unknown element {id}"), None))?;
                    let el = self
                        .elements()?
                        .get_mut(i)
                        .and_then(Value::as_object_mut)
                        .ok_or_else(|| ParseError::new(format!("element {id} is not an object"), None))?;
                    el.insert(key.to_string(), after);
                }
                Some("doc") => {
                    let (key, after) = (text("key")?, field("after")?.clone());
                    if let Some(doc) = self.doc.as_object_mut() {
                        doc.insert(key.to_string(), after);
                    }
                }
                Some("study") => {
                    let (section, key, after) = (text("section")?, text("key")?, field("after")?.clone());
                    let study = object_at(&mut self.doc, "study")?;
                    let part = object_at(study, section)?;
                    part.as_object_mut()
                        .ok_or_else(|| ParseError::new("the study case is not an object", None))?
                        .insert(key.to_string(), after);
                }
                other => return Err(ParseError::new(format!("unknown edit {other:?}"), None)),
            }
        }
        Ok(())
    }

    /// The document converted to the engine's model and study case.
    pub fn convert(&self) -> Result<Imported, ParseError> {
        from_value(&self.doc)
    }

    /// The document's JSON tree.
    pub fn value(&self) -> &Value {
        &self.doc
    }

    /// The number of elements.
    pub fn len(&self) -> usize {
        self.doc.get("elements").and_then(Value::as_array).map_or(0, Vec::len)
    }

    /// Whether the document has no elements.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// The object under `key`, created when missing.
fn object_at<'a>(v: &'a mut Value, key: &str) -> Result<&'a mut Value, ParseError> {
    let obj = v
        .as_object_mut()
        .ok_or_else(|| ParseError::new(format!("the parent of {key} is not an object"), None))?;
    Ok(obj.entry(key.to_string()).or_insert_with(|| Value::Object(Map::new())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn doc() -> Result<OpenDocument, ParseError> {
        let text = json!({
            "format": "powerstudio", "version": 1, "name": "T", "baseMVA": 100, "frequency": 50,
            "elements": [{ "id": "B1", "cls": "bus", "name": "One" }, { "id": "B2", "cls": "bus", "name": "Two" }],
            "study": { "loadflow": { "tolerance": 0.001 } },
        })
        .to_string();
        OpenDocument::open(&text)
    }

    #[test]
    fn edits_apply_as_the_editor_applies_them() -> Result<(), ParseError> {
        let mut d = doc()?;
        d.apply(&[
            json!({ "type": "set", "id": "B2", "key": "name", "before": "Two", "after": "Second" }),
            json!({ "type": "add", "index": 1, "el": { "id": "B3", "cls": "bus", "name": "Three" } }),
            json!({ "type": "remove", "el": { "id": "B1" } }),
            json!({ "type": "doc", "key": "name", "after": "Renamed" }),
            json!({ "type": "study", "section": "loadflow", "key": "tolerance", "after": 0.01 }),
            json!({ "type": "set", "id": "B2", "key": "vn", "after": 33 }),
        ])?;
        let v = d.value();
        let ids: Vec<&str> = v["elements"]
            .as_array()
            .map(|els| els.iter().filter_map(|e| e["id"].as_str()).collect())
            .unwrap_or_default();
        assert_eq!(ids, ["B3", "B2"]);
        assert_eq!(v["elements"][1]["name"], "Second");
        assert_eq!(v["elements"][1]["vn"], 33);
        assert_eq!(v["name"], "Renamed");
        assert_eq!(v["study"]["loadflow"]["tolerance"], 0.01);
        Ok(())
    }

    #[test]
    fn a_selection_deleted_at_once_leaves_the_rest_in_order() -> Result<(), ParseError> {
        let mut d = doc()?;
        d.apply(&[
            json!({ "type": "add", "index": 2, "el": { "id": "B3", "cls": "bus" } }),
            json!({ "type": "remove", "el": { "id": "B1" } }),
            json!({ "type": "remove", "el": { "id": "B3" } }),
            json!({ "type": "set", "id": "B2", "key": "name", "after": "Left" }),
        ])?;
        assert_eq!(
            d.value()["elements"],
            json!([{ "id": "B2", "cls": "bus", "name": "Left" }])
        );
        Ok(())
    }

    #[test]
    fn an_edit_of_an_unknown_element_is_an_error() -> Result<(), ParseError> {
        let mut d = doc()?;
        assert!(
            d.apply(&[json!({ "type": "set", "id": "X", "key": "name", "after": "x" })])
                .is_err()
        );
        assert!(d.apply(&[json!({ "type": "move" })]).is_err());
        Ok(())
    }
}
