//! The engine's request interface: a calculation kind, options as JSON and a document in, a JSON report out.
//! The browser (through `ps-wasm`) and the command line (`ps-cli`) both go through [`handle`], so they run the same
//! code path. docs/ENGINE.md lists every request and its options.

use serde::Deserialize;
use serde_json::{Value, json};

use ps_model::study::{RmsSettings, StudyCase};
use ps_model::{Class, Model};

use crate::contingency::{self, Chunk};
use crate::loadflow::{self, LoadFlowRun};
use crate::progress::Progress;
use crate::rms;

/// Load flow options; absent fields take the document's study case.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LoadFlowOptions {
    tolerance: Option<f64>,
    max_iter: Option<u32>,
    enforce_q_limits: Option<bool>,
    dc_start: Option<bool>,
    /// Percent.
    load_scale: Option<f64>,
    outages: Option<Vec<String>>,
    start: Option<StartOptions>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StartOptions {
    bus_ids: Vec<String>,
    vm: Vec<f64>,
    /// Degrees.
    va: Vec<f64>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ShortCircuitOptions {
    fault: Option<ps_model::study::FaultType>,
    mode: Option<ps_model::study::ScMode>,
    kappa: Option<ps_model::study::KappaMethod>,
    lv_tolerance: Option<ps_model::study::LvTolerance>,
    location: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RmsOptions {
    t_end: Option<f64>,
    dt: Option<f64>,
    events: Option<Vec<ps_model::study::SimEvent>>,
    max_samples: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChunkOptions {
    from: usize,
    to: usize,
}

fn options<T: for<'de> Deserialize<'de> + Default>(v: &Value) -> Result<T, String> {
    if v.is_null() {
        return Ok(T::default());
    }
    serde_json::from_value(v.clone()).map_err(|e| format!("invalid options: {e}"))
}

fn to_json<T: serde::Serialize>(r: &T) -> Result<Value, String> {
    serde_json::to_value(r).map_err(|e| format!("the report could not be encoded: {e}"))
}

/// A document read into a model and study case, with the issues the conversion found.
pub struct Loaded {
    /// The model.
    pub model: Model,
    /// The study case.
    pub study: StudyCase,
}

/// Runs one request.
///
/// `kind` is `loadflow`, `shortcircuit`, `contingency`, `contingency_plan`, `contingency_chunk`, `contingency_merge`
/// or `rms`. Every kind but `contingency_merge` needs `doc`; `contingency_merge` takes the chunks as `options`.
pub fn handle(kind: &str, opts: &Value, doc: Option<&Loaded>, progress: &mut dyn Progress) -> Result<Value, String> {
    if kind == "contingency_merge" {
        let chunks: Vec<Chunk> =
            serde_json::from_value(opts.clone()).map_err(|e| format!("invalid contingency chunks: {e}"))?;
        return to_json(&contingency::merge(chunks)?);
    }
    let Loaded { model, study } = doc.ok_or("this request needs a document")?;
    match kind {
        "loadflow" => {
            let o: LoadFlowOptions = options(opts)?;
            let mut settings = study.loadflow;
            settings.tolerance = o.tolerance.unwrap_or(settings.tolerance);
            settings.max_iter = o.max_iter.unwrap_or(settings.max_iter);
            settings.enforce_q_limits = o.enforce_q_limits.unwrap_or(settings.enforce_q_limits);
            settings.dc_start = o.dc_start.unwrap_or(settings.dc_start);
            settings.load_scale = o.load_scale.unwrap_or(settings.load_scale);
            let (outages, unknown) = crate::outages_by_id(model, o.outages.iter().flatten().map(String::as_str));
            if let Some(id) = unknown.first() {
                return Err(format!("the outage {id} is not an element of the network"));
            }
            let start = o.start.map(|s| {
                let index = model.index();
                let mut per_node = vec![None; model.nodes.len()];
                for (k, id) in s.bus_ids.iter().enumerate() {
                    if let (Some(row), Some(&vm), Some(&va)) = (index.get(Class::Node, id), s.vm.get(k), s.va.get(k)) {
                        per_node[row] = Some((vm, va.to_radians()));
                    }
                }
                per_node
            });
            to_json(&loadflow::run(
                model,
                &LoadFlowRun {
                    settings,
                    outages,
                    start,
                },
            ))
        }
        "shortcircuit" => {
            let o: ShortCircuitOptions = options(opts)?;
            let mut st = study.shortcircuit.clone();
            st.fault = o.fault.unwrap_or(st.fault);
            st.mode = o.mode.unwrap_or(st.mode);
            st.kappa = o.kappa.unwrap_or(st.kappa);
            st.lv_tolerance = o.lv_tolerance.unwrap_or(st.lv_tolerance);
            if let Some(l) = o.location {
                st.location = l;
            }
            to_json(&ps_sc::run(model, &st))
        }
        "contingency" => to_json(&contingency::run(model, study, progress)?),
        "contingency_plan" => {
            let ids: Vec<String> = contingency::definitions(model, study)
                .into_iter()
                .map(|c| c.id)
                .collect();
            Ok(json!({ "count": ids.len(), "ids": ids }))
        }
        "contingency_chunk" => {
            let o: ChunkOptions = serde_json::from_value(opts.clone()).map_err(|e| format!("invalid options: {e}"))?;
            to_json(&contingency::run_chunk(model, study, o.from..o.to, progress)?)
        }
        "rms" => {
            let o: RmsOptions = options(opts)?;
            let settings = RmsSettings {
                t_end: o.t_end.unwrap_or(study.rms.t_end),
                dt: o.dt.unwrap_or(study.rms.dt),
                events: o.events.unwrap_or_else(|| study.rms.events.clone()),
            };
            to_json(&rms::run(
                model,
                study,
                &settings,
                o.max_samples.unwrap_or(rms::DEFAULT_SAMPLES),
                progress,
            )?)
        }
        other => Err(format!("unknown calculation \"{other}\"")),
    }
}
