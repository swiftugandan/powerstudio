//! PSS/E dynamic data (DYR) applied to a model read from a RAW file.
//!
//! A DYR file is a list of records `BUS 'MODEL' ID values… /`, each giving one model of the machine `ID` at bus `BUS`
//! with its parameters in the PSS/E model library's order (integer ICONs first, then CONs). GENCLS and GENROU set the
//! machine's rotor model; the exciter, governor and stabiliser models of [`ps_model::ControllerKind`] set its controls.
//! Every other record is reported with the machines it concerns, which keep their classical model and lose nothing
//! else. GENCLS takes its transient reactance from the RAW file's source reactance (ZSORCE), as PSS/E does; GENROU's
//! X″d replaces the source reactance, which PSS/E requires to equal it, and the report says where the two differed.

use std::collections::BTreeMap;

use ps_model::{Controller, ControllerKind, Model, RotorModel, RoundRotor};

use crate::report::ClassReport;

/// What applying a DYR file did.
#[derive(Debug, Clone, Default)]
pub struct Applied {
    /// Records read per model, and what became of them.
    pub classes: Vec<ClassReport>,
    /// Records skipped and values replaced, in plain words.
    pub notes: Vec<String>,
}

/// One record.
struct Record {
    bus: i64,
    model: String,
    id: String,
    values: Vec<f64>,
    line: usize,
}

/// Splits DYR text into records. A record ends with `/`; the model name is quoted; values may wrap over lines. Text
/// after a `/` on its line is a comment.
fn records(text: &str) -> (Vec<Record>, Vec<String>) {
    let mut out = Vec::new();
    let mut bad = Vec::new();
    let mut tokens: Vec<String> = Vec::new();
    let mut start = 1;
    for (n, line) in text.lines().enumerate() {
        let (body, ends) = match line.find('/') {
            Some(k) => (&line[..k], true),
            None => (line, false),
        };
        if tokens.is_empty() {
            start = n + 1;
        }
        let mut rest = body.trim();
        while !rest.is_empty() {
            if let Some(q) = rest.strip_prefix('\'') {
                let end = q.find('\'').unwrap_or(q.len());
                tokens.push(format!("'{}'", &q[..end]));
                rest = q.get(end + 1..).unwrap_or("").trim_start();
            } else {
                let end = rest.find(|c: char| c.is_whitespace() || c == ',').unwrap_or(rest.len());
                if end > 0 {
                    tokens.push(rest[..end].to_string());
                }
                rest = rest[end..].trim_start_matches(|c: char| c.is_whitespace() || c == ',');
            }
        }
        if ends && !tokens.is_empty() {
            let t = std::mem::take(&mut tokens);
            let model = t
                .get(1)
                .filter(|m| m.starts_with('\''))
                .map(|m| m.trim_matches('\'').trim().to_uppercase());
            match (t.first().and_then(|b| b.parse::<i64>().ok()), model) {
                (Some(bus), Some(model)) => {
                    let id = t
                        .get(2)
                        .map(|s| s.trim_matches('\'').trim().to_string())
                        .unwrap_or_else(|| "1".into());
                    let values = t.iter().skip(3).filter_map(|v| v.parse::<f64>().ok()).collect();
                    out.push(Record {
                        bus,
                        model,
                        id,
                        values,
                        line: start,
                    });
                }
                _ => bad.push(format!("line {start}: {}", t.join(" "))),
            }
        }
    }
    (out, bad)
}

/// Applies a DYR file to a model imported from RAW (machines named `B<bus>-G<id>`).
pub fn apply(model: &mut Model, text: &str) -> Applied {
    let (recs, bad) = records(text);
    let mut applied = Applied::default();
    for b in &bad {
        applied
            .notes
            .push(format!("A DYR record could not be read and was skipped: {b}."));
    }
    let index: BTreeMap<String, usize> = model
        .generators
        .iter()
        .enumerate()
        .map(|(k, g)| (g.id.clone(), k))
        .collect();
    // Per model: records read, applied, and the machines of records left out.
    let mut tally: BTreeMap<String, (usize, usize, Vec<String>)> = BTreeMap::new();
    let mut xdss_changed = 0;
    for r in recs {
        let entry = tally.entry(r.model.clone()).or_default();
        entry.0 += 1;
        let gid = format!("B{}-G{}", r.bus, crate::psse_model::id_part(&r.id));
        let Some(&row) = index.get(&gid) else {
            entry.2.push(format!("bus {} machine {}", r.bus, r.id));
            applied.notes.push(format!(
                "line {}: {} is for machine {} at bus {}, which the RAW file does not have; it was skipped.",
                r.line, r.model, r.id, r.bus
            ));
            continue;
        };
        let g = &mut model.generators[row];
        let need = |n: usize, notes: &mut Vec<String>| -> bool {
            if r.values.len() < n {
                notes.push(format!(
                    "line {}: {} for machine {} at bus {} has {} values, not {n}; it was skipped.",
                    r.line,
                    r.model,
                    r.id,
                    r.bus,
                    r.values.len()
                ));
                false
            } else {
                true
            }
        };
        match r.model.as_str() {
            "GENCLS" => {
                if !need(2, &mut applied.notes) {
                    continue;
                }
                g.dynamics.rotor_model = RotorModel::Classical;
                g.dynamics.h = r.values[0];
                g.dynamics.d = r.values[1];
                g.dynamics.xdt = g.sc.xdss;
                entry.1 += 1;
            }
            "GENROU" => {
                if !need(14, &mut applied.notes) {
                    continue;
                }
                let v = &r.values;
                g.dynamics.rotor_model = RotorModel::RoundRotor;
                g.dynamics.rotor = RoundRotor {
                    td0t: v[0],
                    td0s: v[1],
                    tq0t: v[2],
                    tq0s: v[3],
                    xd: v[6],
                    xq: v[7],
                    xqt: v[9],
                    xl: v[11],
                    s10: v[12],
                    s12: v[13],
                };
                g.dynamics.h = v[4];
                g.dynamics.d = v[5];
                g.dynamics.xdt = v[8];
                if (g.sc.xdss - v[10]).abs() > 1e-6 {
                    xdss_changed += 1;
                }
                g.sc.xdss = v[10];
                entry.1 += 1;
            }
            name => match ControllerKind::from_name(name) {
                Some(kind) => {
                    let n = kind.params().len();
                    if !need(n, &mut applied.notes) {
                        continue;
                    }
                    if r.values.len() > n {
                        applied.notes.push(format!(
                            "line {}: {name} for machine {} at bus {} has {} values; the {} after the first {n} were ignored.",
                            r.line,
                            r.id,
                            r.bus,
                            r.values.len(),
                            r.values.len() - n
                        ));
                    }
                    *g.dynamics.controls.slot_mut(kind.slot()) = Some(Controller {
                        kind,
                        values: r.values[..n].to_vec(),
                    });
                    entry.1 += 1;
                }
                None => entry.2.push(format!("bus {} machine {}", r.bus, r.id)),
            },
        }
    }
    if xdss_changed > 0 {
        applied.notes.push(format!(
            "{xdss_changed} machine(s) state a source reactance (ZSORCE) in the RAW file other than GENROU's X″d; X″d is used for both the short circuit and the simulation."
        ));
    }
    for (model, (count, used, missing)) in tally {
        let known = model == "GENCLS" || model == "GENROU" || ControllerKind::from_name(&model).is_some();
        let (status, detail) = if known && used == count {
            ("mapped", "applied to its machine".to_string())
        } else if known {
            (
                "mapped",
                format!("{used} applied; {} skipped (see the notes)", count - used),
            )
        } else {
            (
                "not used",
                format!(
                    "not in PowerStudio's model library; {} keep(s) their classical model or no such control: {}",
                    if missing.len() == 1 {
                        "the machine"
                    } else {
                        "the machines"
                    },
                    missing.join(", ")
                ),
            )
        };
        applied.classes.push(ClassReport {
            class: format!("DYR {model}"),
            count,
            status,
            detail,
        });
    }
    applied
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_wrap_lines_and_quote_names() {
        let text = "  1 'GENROU' 1  8.0 0.03 0.4 0.05\n 6.5 0 1.8 1.7 0.3\n 0.55 0.25 0.06 0 0 /comment\n  2 'TGOV1' 1 0.05 0.49 33 0.4 2.1 7 0 /\n";
        let (r, bad) = records(text);
        assert!(bad.is_empty());
        assert_eq!(r.len(), 2);
        assert_eq!((r[0].bus, r[0].model.as_str(), r[0].values.len()), (1, "GENROU", 14));
        assert_eq!((r[1].model.as_str(), r[1].values[2]), ("TGOV1", 33.0));
        assert_eq!(r[1].line, 4);
    }
}
