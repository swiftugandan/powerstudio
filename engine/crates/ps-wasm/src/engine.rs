//! The engine state behind the WebAssembly boundary and its request handler. Natively testable: nothing here touches
//! raw memory.
//!
//! Requests (the header's `op`):
//!
//! | `op` | Header fields | Payload | Reply |
//! | --- | --- | --- | --- |
//! | `version` | | | `engine` version |
//! | `study` | `kind`, `options`, `resident` (use the open document), `record` (hash the inputs and the report) | PowerStudio document (JSON text); none for `contingency_merge` or with `resident` | the report as JSON text; with `record`, the header's `record` holds the `engine` version and the SHA-256 of the `model`, the `study` case and the `results` |
//! | `doc_open` | | PowerStudio document (JSON text) | `elements` |
//! | `doc_edit` | `ops`: the editor's operations (see `ps_io::powerstudio_edit`) | | `elements` |
//! | `load_matpower` | | MATPOWER case text | model size and conversion issues |
//! | `solve_model` | `tolerance` (MVA), `warm_start`, `dc_start`, `q_limits`, `bump` (change the largest load by this factor first), `keep` (store the solution as the next warm start) | | load flow summary |
//! | `import` | `files`: `[{ name, size }]` | the files' bytes, one after another | format, import report, validation, conversion notes, fidelity and size; the editor's document as payload |
//!
//! Reports travel as a payload, not in the header, so the header stays small and the host can parse them separately.

use serde_json::{Value, json};

use ps_io::powerstudio_edit::OpenDocument;
use ps_study::api::{self, Loaded};
use ps_study::{LoadFlowRun, Progress};

/// A decoded message: JSON header and binary payload.
#[derive(Debug, Clone, PartialEq)]
pub struct Envelope {
    /// The header.
    pub header: Value,
    /// The payload (may be empty).
    pub payload: Vec<u8>,
}

impl Envelope {
    /// Decodes `[u32 header length][header JSON][payload]`.
    pub fn decode(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() < 4 {
            return Err("the request is shorter than its length prefix".into());
        }
        let n = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
        let end = 4usize
            .checked_add(n)
            .filter(|&e| e <= bytes.len())
            .ok_or("the header length exceeds the request")?;
        let header =
            serde_json::from_slice(&bytes[4..end]).map_err(|e| format!("the header is not valid JSON: {e}"))?;
        Ok(Self {
            header,
            payload: bytes[end..].to_vec(),
        })
    }

    /// Encodes the envelope.
    pub fn encode(&self) -> Vec<u8> {
        let header = self.header.to_string();
        let mut out = Vec::with_capacity(4 + header.len() + self.payload.len());
        out.extend_from_slice(&(header.len() as u32).to_le_bytes());
        out.extend_from_slice(header.as_bytes());
        out.extend_from_slice(&self.payload);
        out
    }
}

/// The engine instance: the last document it read, the document the editor has open, the model loaded for
/// benchmarks, and what load flows keep between requests.
#[derive(Default)]
pub struct Engine {
    document: Option<(Vec<u8>, Loaded, Vec<String>)>,
    /// The document the editor has open, kept in step by its edits, and its conversion since the last edit.
    open: Option<Open>,
    model: Option<ps_model::Model>,
    session: api::Session,
}

/// A report without its `timing` fields, which measure the machine rather than the result.
fn without_timing(v: &Value) -> Value {
    match v {
        Value::Object(m) => Value::Object(
            m.iter()
                .filter(|(k, _)| k.as_str() != "timing")
                .map(|(k, x)| (k.clone(), without_timing(x)))
                .collect(),
        ),
        Value::Array(a) => Value::Array(a.iter().map(without_timing).collect()),
        other => other.clone(),
    }
}

/// The document the editor has open, and its conversion since the last edit.
struct Open {
    doc: OpenDocument,
    loaded: Option<(Loaded, Vec<String>)>,
}

impl Open {
    /// The converted document and its conversion notes, converting it when an edit came since.
    fn loaded(&mut self) -> Result<&(Loaded, Vec<String>), String> {
        if self.loaded.is_none() {
            let imp = self.doc.convert().map_err(|e| e.to_string())?;
            let loaded = Loaded {
                model: imp.model,
                study: imp.study,
            };
            self.loaded = Some((loaded, imp.issues));
        }
        self.loaded
            .as_ref()
            .ok_or_else(|| "the open document was not converted".to_string())
    }
}

impl std::fmt::Debug for Engine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Engine")
            .field("document", &self.document.is_some())
            .field("open", &self.open.is_some())
            .field("model", &self.model.is_some())
            .finish()
    }
}

impl Engine {
    /// Handles one encoded request and returns the encoded response. Errors become `{"ok": false, "error": …}`.
    pub fn handle(&mut self, request: &[u8], progress: &mut dyn Progress) -> Vec<u8> {
        let reply = Envelope::decode(request).and_then(|env| self.dispatch(&env, progress));
        match reply {
            Ok(env) => env.encode(),
            Err(error) => Envelope {
                header: json!({ "ok": false, "error": error }),
                payload: Vec::new(),
            }
            .encode(),
        }
    }

    /// Reads a document into `self.document`, re-using the previous one when the bytes are the same.
    fn load_document(&mut self, bytes: &[u8]) -> Result<(), String> {
        let same = self.document.as_ref().is_some_and(|(b, _, _)| b.as_slice() == bytes);
        if !same {
            let text = std::str::from_utf8(bytes).map_err(|_| "the document is not UTF-8 text")?;
            let imp = ps_io::powerstudio::parse(text).map_err(|e| e.to_string())?;
            self.document = Some((
                bytes.to_vec(),
                Loaded {
                    model: imp.model,
                    study: imp.study,
                },
                imp.issues,
            ));
        }
        Ok(())
    }

    fn dispatch(&mut self, req: &Envelope, progress: &mut dyn Progress) -> Result<Envelope, String> {
        let op = req
            .header
            .get("op")
            .and_then(Value::as_str)
            .ok_or("the request has no op")?;
        match op {
            "version" => Ok(ok(json!({ "engine": env!("CARGO_PKG_VERSION") }), Vec::new())),
            "study" => {
                let kind = req
                    .header
                    .get("kind")
                    .and_then(Value::as_str)
                    .ok_or("the study request has no kind")?;
                let opts = req.header.get("options").cloned().unwrap_or(Value::Null);
                let resident = req.header.get("resident").and_then(Value::as_bool).unwrap_or(false);
                let record = req.header.get("record").and_then(Value::as_bool).unwrap_or(false);
                let (loaded, issues) = if kind == "contingency_merge" {
                    (None, Vec::new())
                } else if resident {
                    let (loaded, issues) = self.open.as_mut().ok_or("no document is open")?.loaded()?;
                    (Some(loaded), issues.clone())
                } else {
                    self.load_document(&req.payload)?;
                    let (_, doc, issues) = self.document.as_ref().ok_or("no document")?;
                    (Some(doc), issues.clone())
                };
                let value = api::handle(kind, &opts, loaded, &mut self.session, progress)?;
                let report = value.to_string().into_bytes();
                let mut header = json!({ "issues": issues });
                if record {
                    // The run record's hashes: the model as calculated (not how it is drawn), the study case, and the
                    // report without its timings, which the engine's determinism makes reproducible.
                    let results = ps_model::sha256_hex(without_timing(&value).to_string().as_bytes());
                    let mut hashes = json!({ "engine": env!("CARGO_PKG_VERSION"), "results": results });
                    if let Some(l) = loaded {
                        hashes["model"] = json!(l.model.content_hash().map_err(|e| e.to_string())?);
                        let study = serde_json::to_vec(&l.study).map_err(|e| e.to_string())?;
                        hashes["study"] = json!(ps_model::sha256_hex(&study));
                    }
                    header["record"] = hashes;
                }
                Ok(ok(header, report))
            }
            "doc_open" => {
                let text = std::str::from_utf8(&req.payload).map_err(|_| "the document is not UTF-8 text")?;
                let doc = OpenDocument::open(text).map_err(|e| e.to_string())?;
                let elements = doc.len();
                self.open = Some(Open { doc, loaded: None });
                Ok(ok(json!({ "elements": elements }), Vec::new()))
            }
            "doc_edit" => {
                let ops = req
                    .header
                    .get("ops")
                    .and_then(Value::as_array)
                    .ok_or("the edit has no operations")?;
                let open = self.open.as_mut().ok_or("no document is open")?;
                open.loaded = None;
                if let Err(e) = open.doc.apply(ops) {
                    // Out of step with the editor: it sends the whole document again.
                    self.open = None;
                    return Err(e.to_string());
                }
                Ok(ok(json!({ "elements": open.doc.len() }), Vec::new()))
            }
            "load_matpower" => {
                let text = std::str::from_utf8(&req.payload).map_err(|_| "the MATPOWER file is not UTF-8 text")?;
                let t0 = ps_num::clock::now_ms();
                let case = ps_io::matpower::parse(text).map_err(|e| e.to_string())?;
                let t1 = ps_num::clock::now_ms();
                let imp = ps_io::matpower_model::to_model(&case);
                let t2 = ps_num::clock::now_ms();
                let m = &imp.model;
                let header = json!({
                    "name": m.meta.name, "nodes": m.nodes.len(), "branches": m.lines.len() + m.transformers2.len(),
                    "parse_ms": t1 - t0, "convert_ms": t2 - t1, "issues": imp.issues,
                });
                self.model = Some(imp.model);
                Ok(ok(header, Vec::new()))
            }
            "solve_model" => {
                let model = self.model.as_mut().ok_or("no model is loaded")?;
                let h = &req.header;
                let settings = ps_model::study::LoadFlowSettings {
                    tolerance: h.get("tolerance").and_then(Value::as_f64).unwrap_or(1e-6),
                    enforce_q_limits: h.get("q_limits").and_then(Value::as_bool).unwrap_or(false),
                    dc_start: h.get("dc_start").and_then(Value::as_bool).unwrap_or(true),
                    ..Default::default()
                };
                // An edit: the largest load changes by a factor.
                if let Some(f) = h.get("bump").and_then(Value::as_f64)
                    && let Some(load) = model.loads.iter_mut().max_by(|a, b| a.p.total_cmp(&b.p))
                {
                    load.p *= f;
                    load.q *= f;
                }
                let warm = h.get("warm_start").and_then(Value::as_bool).unwrap_or(false);
                let start = warm.then(|| {
                    model
                        .nodes
                        .iter()
                        .map(|n| (n.v0 > 0.0).then(|| (n.v0, n.angle0.to_radians())))
                        .collect()
                });
                let (calc, sol, r) = ps_study::loadflow::solve(
                    model,
                    &LoadFlowRun {
                        settings,
                        start,
                        ..Default::default()
                    },
                );
                // An editing session re-solves from its last solution: keep it as the model's warm start.
                if h.get("keep").and_then(Value::as_bool).unwrap_or(false) && r.converged {
                    for (b, bus) in calc.topo.buses.iter().enumerate() {
                        for &n in &bus.nodes {
                            let node = &mut model.nodes[n as usize];
                            node.v0 = sol.vm[b];
                            node.angle0 = sol.va[b].to_degrees();
                        }
                    }
                }
                Ok(ok(
                    json!({
                        "converged": r.converged, "message": r.message, "iterations": r.iterations, "mismatch": r.mismatch,
                        "buses": r.buses.len(), "timing": r.timing,
                    }),
                    Vec::new(),
                ))
            }
            "import" => {
                // The payload holds the files one after another, in the order and sizes the header lists.
                let list = req
                    .header
                    .get("files")
                    .and_then(Value::as_array)
                    .ok_or("the import request lists no files")?;
                let mut files = Vec::new();
                let mut at = 0usize;
                for f in list {
                    let name = f.get("name").and_then(Value::as_str).ok_or("a file has no name")?;
                    let size = f.get("size").and_then(Value::as_u64).ok_or("a file has no size")? as usize;
                    let end = at
                        .checked_add(size)
                        .filter(|&e| e <= req.payload.len())
                        .ok_or("the files exceed the payload")?;
                    files.push(ps_io::files::File {
                        name: name.to_string(),
                        data: req.payload[at..end].to_vec(),
                    });
                    at = end;
                }
                let t0 = ps_num::clock::now_ms();
                let result = ps_study::exchange::import_for_editor(files)?;
                let mut header = serde_json::to_value(&result).map_err(|e| e.to_string())?;
                if let Some(h) = header.as_object_mut() {
                    h.insert("ms".into(), json!(ps_num::clock::now_ms() - t0));
                }
                Ok(ok(header, result.doc.to_string().into_bytes()))
            }
            other => Err(format!("unknown op \"{other}\"")),
        }
    }
}

fn ok(mut header: Value, payload: Vec<u8>) -> Envelope {
    if let Some(obj) = header.as_object_mut() {
        obj.insert("ok".into(), Value::Bool(true));
    }
    Envelope { header, payload }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelopes_round_trip_and_errors_are_replies() -> Result<(), String> {
        let env = Envelope {
            header: json!({ "op": "version" }),
            payload: vec![1, 2, 3],
        };
        assert_eq!(Envelope::decode(&env.encode())?, env);
        let mut engine = Engine::default();
        let mut quiet = ps_study::Silent;
        let reply = Envelope::decode(
            &engine.handle(
                &Envelope {
                    header: json!({ "op": "nope" }),
                    payload: vec![],
                }
                .encode(),
                &mut quiet,
            ),
        )?;
        assert_eq!(reply.header["ok"], json!(false));
        let reply = Envelope::decode(&engine.handle(&[1, 2], &mut quiet))?;
        assert_eq!(reply.header["ok"], json!(false));
        Ok(())
    }
}
