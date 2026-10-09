//! The engine state behind the WebAssembly boundary and its request handler. Natively testable: nothing here touches
//! raw memory.

use serde_json::{Value, json};

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
        let header = serde_json::from_slice(&bytes[4..end])
            .map_err(|e| format!("the header is not valid JSON: {e}"))?;
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

/// The engine instance: loaded networks and the results of the latest studies.
#[derive(Debug, Default)]
pub struct Engine {
    network: Option<ps_bridge::Converted>,
}

impl Engine {
    /// Handles one encoded request and returns the encoded response. Errors become `{"ok": false, "error": …}`.
    pub fn handle(&mut self, request: &[u8]) -> Vec<u8> {
        let reply = Envelope::decode(request).and_then(|env| self.dispatch(&env));
        match reply {
            Ok(env) => env.encode(),
            Err(error) => Envelope {
                header: json!({ "ok": false, "error": error }),
                payload: Vec::new(),
            }
            .encode(),
        }
    }

    fn dispatch(&mut self, req: &Envelope) -> Result<Envelope, String> {
        let op = req
            .header
            .get("op")
            .and_then(Value::as_str)
            .ok_or("the request has no op")?;
        match op {
            "version" => Ok(ok(json!({ "engine": env!("CARGO_PKG_VERSION") }))),
            "load_matpower" => {
                let text = std::str::from_utf8(&req.payload)
                    .map_err(|_| "the MATPOWER file is not UTF-8 text")?;
                let t0 = ps_num::clock::now_ms();
                let case = ps_io::matpower::parse(text).map_err(|e| e.to_string())?;
                let conv = ps_bridge::from_matpower(&case);
                let (buses, branches) = (conv.net.buses.len(), conv.net.branches.len());
                self.network = Some(conv);
                Ok(ok(
                    json!({ "name": case.name, "buses": buses, "branches": branches, "parse_ms": ps_num::clock::now_ms() - t0 }),
                ))
            }
            "solve_lf" => {
                let conv = self.network.as_ref().ok_or("no network is loaded")?;
                let h = &req.header;
                let opt = ps_lf::Options {
                    tolerance: h.get("tolerance").and_then(Value::as_f64).unwrap_or(1e-8),
                    max_iter: h
                        .get("max_iter")
                        .and_then(Value::as_u64)
                        .map_or(30, |v| v as usize),
                    enforce_q_limits: h.get("q_limits").and_then(Value::as_bool).unwrap_or(false),
                    dc_start: h.get("dc_start").and_then(Value::as_bool).unwrap_or(true),
                    warm_start: h
                        .get("warm_start")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                };
                let sol = ps_lf::solve(&conv.net, &opt);
                // Voltages travel as a binary payload: magnitudes then angles, f64 little-endian.
                let mut payload = Vec::with_capacity(16 * sol.vm.len());
                for v in sol.vm.iter().chain(&sol.va) {
                    payload.extend_from_slice(&v.to_le_bytes());
                }
                Ok(Envelope {
                    header: json!({
                        "ok": true, "converged": sol.converged, "message": sol.message, "iterations": sol.iterations,
                        "mismatch": sol.mismatch, "n": sol.vm.len(),
                        "timing": { "analyse_ms": sol.timing.analyse_ms, "factor_solve_ms": sol.timing.factor_solve_ms, "total_ms": sol.timing.total_ms },
                    }),
                    payload,
                })
            }
            other => Err(format!("unknown op \"{other}\"")),
        }
    }
}

fn ok(mut header: Value) -> Envelope {
    if let Some(obj) = header.as_object_mut() {
        obj.insert("ok".into(), Value::Bool(true));
    }
    Envelope {
        header,
        payload: Vec::new(),
    }
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
        let reply = Envelope::decode(
            &engine.handle(
                &Envelope {
                    header: json!({ "op": "nope" }),
                    payload: vec![],
                }
                .encode(),
            ),
        )?;
        assert_eq!(reply.header["ok"], json!(false));
        let reply = Envelope::decode(&engine.handle(&[1, 2]))?;
        assert_eq!(reply.header["ok"], json!(false));
        Ok(())
    }
}
