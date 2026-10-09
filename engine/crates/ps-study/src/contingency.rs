//! N-1 contingency analysis: every selected branch or machine is taken out of service in turn and the load flow is
//! solved again from the base-case voltages. Each outage is judged against the study case's loading limit and every
//! node's voltage band.
//!
//! The work splits into chunks of outages ([`run_chunk`]) that [`merge`] combines in chunk order, so a pool of
//! engines running contiguous chunks produces exactly the sequential result ([`run`]).

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};

use ps_model::study::StudyCase;
use ps_model::{Class, Model};
use ps_topology::{Outages, active};

use crate::loadflow::{self, LoadFlowReport, LoadFlowRun};
use crate::progress::Progress;

/// A limit violation in one case.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Violation {
    /// `loading`, `undervoltage` or `overvoltage`.
    pub kind: String,
    /// Element or node identifier.
    pub id: String,
    /// Loading (%) or voltage (p.u.).
    pub value: f64,
    /// The limit crossed.
    pub limit: f64,
    /// Whether the base case already violates it.
    pub in_base: bool,
}

/// One solved case.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Case {
    /// Outaged element (or `base`).
    pub id: String,
    /// Its class: `line`, `trafo`, `trafo3`, `gen` (or `base`).
    pub cls: String,
    /// Whether the load flow converged.
    pub converged: bool,
    /// Load flow outcome.
    pub message: String,
    /// Highest branch loading, %.
    pub max_loading: Option<f64>,
    /// Branch with the highest loading.
    pub max_loading_id: String,
    /// Lowest voltage, p.u.
    pub min_v: Option<f64>,
    /// Bus with the lowest voltage.
    pub min_v_bus: String,
    /// Highest voltage, p.u.
    pub max_v: Option<f64>,
    /// Bus with the highest voltage.
    pub max_v_bus: String,
    /// Nodes the outage cuts off (beyond those dead in the base case).
    pub lost_buses: Vec<String>,
    /// Violations.
    pub violations: Vec<Violation>,
}

/// Worst loading of a branch over all cases.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WorstLoading {
    /// Loading, %.
    pub value: f64,
    /// The outage that causes it.
    pub outage: String,
}

/// Voltage extremes of a bus over all cases.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorstVoltage {
    /// Lowest voltage, p.u.
    pub min: f64,
    /// Outage causing it.
    pub min_outage: String,
    /// Highest voltage, p.u.
    pub max: f64,
    /// Outage causing it.
    pub max_outage: String,
}

/// The contingency report.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContingencyReport {
    /// The base case.
    pub base: Case,
    /// Every outage, failures first, then by number of violations, then by highest loading.
    pub cases: Vec<Case>,
    /// Worst loading per branch.
    pub worst_loading: BTreeMap<String, WorstLoading>,
    /// Voltage extremes per bus.
    pub worst_voltage: BTreeMap<String, WorstVoltage>,
    /// Loading limit, %.
    pub limit: f64,
}

/// A chunk's results, in outage order and unsorted.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Chunk {
    /// The base case.
    pub base: Case,
    /// Cases in outage order.
    pub cases: Vec<Case>,
    /// Worst loading per branch over this chunk, in first-seen order.
    pub worst_loading: Vec<(String, WorstLoading)>,
    /// Voltage extremes per bus over this chunk, in first-seen order.
    pub worst_voltage: Vec<(String, WorstVoltage)>,
    /// Loading limit, %.
    pub limit: f64,
}

/// The outages a study case selects, in order: lines, transformers, then generators, each in model order.
pub fn outage_list(model: &Model, study: &StudyCase) -> Vec<(Class, usize)> {
    let st = &study.contingency;
    let none = Outages::none();
    let mut out = Vec::new();
    let mut add = |class: Class, n: usize, on: bool| {
        if on {
            out.extend((0..n).filter(|&r| active(model, &none, class, r)).map(|r| (class, r)));
        }
    };
    add(Class::Line, model.lines.len(), st.lines);
    add(Class::Transformer2, model.transformers2.len(), st.trafos);
    add(Class::Transformer3, model.transformers3.len(), st.trafos);
    add(Class::Generator, model.generators.len(), st.gens);
    out
}

fn cls_name(class: Class) -> &'static str {
    match class {
        Class::Line => "line",
        Class::Transformer2 => "trafo",
        Class::Transformer3 => "trafo3",
        Class::Generator => "gen",
        _ => "other",
    }
}

/// Runs outages `range` of [`outage_list`] (the base case is solved in every chunk).
pub fn run_chunk(
    model: &Model,
    study: &StudyCase,
    range: std::ops::Range<usize>,
    progress: &mut dyn Progress,
) -> Result<Chunk, String> {
    let limit = study.contingency.max_loading;
    let run = LoadFlowRun {
        settings: study.loadflow,
        ..Default::default()
    };
    let (calc, sol, base) = loadflow::solve(model, &run);
    if !base.converged {
        return Err(format!("The base case does not converge: {}", base.message));
    }
    let bands: HashMap<&str, (f64, f64)> = model
        .nodes
        .iter()
        .map(|n| (n.id.as_str(), (n.v_min, n.v_max)))
        .collect();
    let base_dead: HashSet<&str> = base.deenergized.iter().map(String::as_str).collect();
    let base_case = judge("base", "base", &base, &bands, limit, None, &base_dead);
    let mut start = vec![None; model.nodes.len()];
    for (b, bus) in calc.topo.buses.iter().enumerate() {
        for &n in &bus.nodes {
            start[n as usize] = Some((sol.vm[b], sol.va[b]));
        }
    }
    let list = outage_list(model, study);
    let range = range.start.min(list.len())..range.end.min(list.len());
    let total = range.len();
    let mut cases = Vec::with_capacity(total);
    let mut worst_loading: Vec<(String, WorstLoading)> = Vec::new();
    let mut wl_index: HashMap<String, usize> = HashMap::new();
    let mut worst_voltage: Vec<(String, WorstVoltage)> = Vec::new();
    let mut wv_index: HashMap<String, usize> = HashMap::new();
    for (done, &(class, row)) in list[range].iter().enumerate() {
        let mut outages = Outages::none();
        outages.insert(class, row);
        let id = model.id_of(class, row).unwrap_or("").to_string();
        let r = loadflow::run(
            model,
            &LoadFlowRun {
                settings: study.loadflow,
                outages,
                start: Some(start.clone()),
            },
        );
        cases.push(judge(
            &id,
            cls_name(class),
            &r,
            &bands,
            limit,
            Some(&base_case),
            &base_dead,
        ));
        if r.converged {
            for b in &r.branches {
                let Some(value) = b.loading else { continue };
                match wl_index.get(&b.id) {
                    Some(&k) if value <= worst_loading[k].1.value => {}
                    Some(&k) => {
                        worst_loading[k].1 = WorstLoading {
                            value,
                            outage: id.clone(),
                        }
                    }
                    None => {
                        wl_index.insert(b.id.clone(), worst_loading.len());
                        worst_loading.push((
                            b.id.clone(),
                            WorstLoading {
                                value,
                                outage: id.clone(),
                            },
                        ));
                    }
                }
            }
            for b in &r.buses {
                let k = *wv_index.entry(b.id.clone()).or_insert_with(|| {
                    worst_voltage.push((
                        b.id.clone(),
                        WorstVoltage {
                            min: f64::INFINITY,
                            min_outage: String::new(),
                            max: f64::NEG_INFINITY,
                            max_outage: String::new(),
                        },
                    ));
                    worst_voltage.len() - 1
                });
                let w = &mut worst_voltage[k].1;
                if b.vm < w.min {
                    w.min = b.vm;
                    w.min_outage.clone_from(&id);
                }
                if b.vm > w.max {
                    w.max = b.vm;
                    w.max_outage.clone_from(&id);
                }
            }
        }
        progress.report((done + 1) as f64, total as f64);
    }
    Ok(Chunk {
        base: base_case,
        cases,
        worst_loading,
        worst_voltage,
        limit,
    })
}

/// Combines chunks of contiguous outage ranges, given in outage order.
pub fn merge(chunks: Vec<Chunk>) -> Result<ContingencyReport, String> {
    let mut iter = chunks.into_iter();
    let first = iter.next().ok_or("there are no contingency results to merge")?;
    let (base, limit) = (first.base.clone(), first.limit);
    let mut cases = Vec::new();
    let mut worst_loading: BTreeMap<String, WorstLoading> = BTreeMap::new();
    let mut worst_voltage: BTreeMap<String, WorstVoltage> = BTreeMap::new();
    for chunk in std::iter::once(first).chain(iter) {
        cases.extend(chunk.cases);
        for (id, w) in chunk.worst_loading {
            match worst_loading.get_mut(&id) {
                Some(cur) if w.value > cur.value => *cur = w,
                Some(_) => {}
                None => {
                    worst_loading.insert(id, w);
                }
            }
        }
        for (id, w) in chunk.worst_voltage {
            match worst_voltage.get_mut(&id) {
                Some(cur) => {
                    if w.min < cur.min {
                        cur.min = w.min;
                        cur.min_outage = w.min_outage;
                    }
                    if w.max > cur.max {
                        cur.max = w.max;
                        cur.max_outage = w.max_outage;
                    }
                }
                None => {
                    worst_voltage.insert(id, w);
                }
            }
        }
    }
    // Failures first, then most violations, then highest loading; ties keep outage order.
    cases.sort_by(|a, b| {
        a.converged
            .cmp(&b.converged)
            .then(b.violations.len().cmp(&a.violations.len()))
            .then(
                b.max_loading
                    .unwrap_or(f64::NAN)
                    .partial_cmp(&a.max_loading.unwrap_or(f64::NAN))
                    .unwrap_or(std::cmp::Ordering::Equal),
            )
    });
    Ok(ContingencyReport {
        base,
        cases,
        worst_loading,
        worst_voltage,
        limit,
    })
}

/// Runs every selected outage.
pub fn run(model: &Model, study: &StudyCase, progress: &mut dyn Progress) -> Result<ContingencyReport, String> {
    merge(vec![run_chunk(model, study, 0..usize::MAX, progress)?])
}

fn judge(
    id: &str,
    cls: &str,
    r: &LoadFlowReport,
    bands: &HashMap<&str, (f64, f64)>,
    limit: f64,
    base: Option<&Case>,
    base_dead: &HashSet<&str>,
) -> Case {
    let mut c = Case {
        id: id.into(),
        cls: cls.into(),
        converged: r.converged,
        message: r.message.clone(),
        max_loading: None,
        max_loading_id: String::new(),
        min_v: None,
        min_v_bus: String::new(),
        max_v: None,
        max_v_bus: String::new(),
        lost_buses: r
            .deenergized
            .iter()
            .filter(|b| !base_dead.contains(b.as_str()))
            .cloned()
            .collect(),
        violations: Vec::new(),
    };
    if !r.converged {
        return c;
    }
    let in_base =
        |kind: &str, el: &str| base.is_some_and(|b| b.violations.iter().any(|v| v.kind == kind && v.id == el));
    let violation = |kind: &str, id: &str, value: f64, limit: f64| Violation {
        kind: kind.into(),
        id: id.into(),
        value,
        limit,
        in_base: in_base(kind, id),
    };
    for b in &r.branches {
        let Some(loading) = b.loading else { continue };
        if c.max_loading.is_none_or(|m| loading > m) {
            c.max_loading = Some(loading);
            c.max_loading_id.clone_from(&b.id);
        }
        if loading > limit {
            c.violations.push(violation("loading", &b.id, loading, limit));
        }
    }
    for b in &r.buses {
        if c.min_v.is_none_or(|m| b.vm < m) {
            c.min_v = Some(b.vm);
            c.min_v_bus.clone_from(&b.id);
        }
        if c.max_v.is_none_or(|m| b.vm > m) {
            c.max_v = Some(b.vm);
            c.max_v_bus.clone_from(&b.id);
        }
        let Some(&(vmin, vmax)) = bands.get(b.id.as_str()) else {
            continue;
        };
        if b.vm < vmin - 1e-9 {
            c.violations.push(violation("undervoltage", &b.id, b.vm, vmin));
        }
        if b.vm > vmax + 1e-9 {
            c.violations.push(violation("overvoltage", &b.id, b.vm, vmax));
        }
    }
    c
}
