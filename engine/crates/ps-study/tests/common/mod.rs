//! Shared test helpers: repository paths and the oracle files. Goldens are read from `tests/oracle/` at the
//! repository root, the same files the browser engine's tests read, so no reference value is typed twice.
#![allow(dead_code)]

use std::path::PathBuf;

pub fn repo(path: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..").join(path)
}

pub fn read(path: &str) -> String {
    std::fs::read_to_string(repo(path)).unwrap_or_else(|e| panic!("{path}: {e}"))
}

pub fn json(path: &str) -> serde_json::Value {
    serde_json::from_str(&read(path)).unwrap_or_else(|e| panic!("{path}: {e}"))
}

/// A 0.1 document from tests/oracle/inputs, as model and study case.
pub fn input(name: &str) -> ps_io::powerstudio::Imported {
    ps_io::powerstudio::parse(&read(&format!("tests/oracle/inputs/{name}.json")))
        .unwrap_or_else(|e| panic!("{name}: {e}"))
}

pub fn golden(name: &str) -> serde_json::Value {
    json(&format!("tests/oracle/golden/{name}.json"))
}

pub fn f(v: &serde_json::Value) -> f64 {
    v.as_f64().unwrap_or(f64::NAN)
}
