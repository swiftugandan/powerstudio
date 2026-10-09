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

/// Worst difference per quantity, with where it occurred.
#[derive(Default)]
pub struct Worst {
    pub rows: Vec<(String, f64, String, f64)>,
}

impl Worst {
    /// Records a difference. A missing reference value (an element PowSyBl left unsolved) is skipped.
    pub fn check(&mut self, what: &str, id: &str, got: f64, want: f64) {
        if want.is_nan() {
            return;
        }
        // A missing or non-finite result counts as an infinite difference.
        let d = match (got - want).abs() {
            d if d.is_finite() => d,
            _ => f64::INFINITY,
        };
        match self.rows.iter_mut().find(|r| r.0 == what) {
            Some(r) if d > r.1 => *r = (what.into(), d, format!("{id} ({got} vs {want})"), got),
            Some(_) => {}
            None => self.rows.push((what.into(), d, format!("{id} ({got} vs {want})"), got)),
        }
    }

    pub fn max(&self, what: &str) -> f64 {
        self.rows.iter().find(|r| r.0 == what).map_or(0.0, |r| r.1)
    }
}
