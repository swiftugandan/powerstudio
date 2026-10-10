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

/// What an engine instance keeps between requests: the load flow's analysed Jacobian patterns, so a re-solve after an
/// edit that keeps the network's pattern (any change of values) skips the ordering and symbolic factorisation.
#[derive(Default)]
pub struct Session {
    lf: ps_lf::Cache,
}

impl std::fmt::Debug for Session {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Session")
            .field("hits", &self.lf.hits)
            .field("misses", &self.lf.misses)
            .finish()
    }
}

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
    /// The generators and static var compensators the solution held at a reactive limit, and which limit.
    #[serde(default)]
    held: Vec<HeldUnit>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HeldUnit {
    id: String,
    limit: Limit,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Limit {
    Min,
    Max,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ShortCircuitOptions {
    fault: Option<ps_model::study::FaultType>,
    mode: Option<ps_model::study::ScMode>,
    kappa: Option<ps_model::study::KappaMethod>,
    lv_tolerance: Option<ps_model::study::LvTolerance>,
    location: Option<String>,
    t_min: Option<f64>,
    t_k: Option<f64>,
    line_temperature: Option<f64>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RmsOptions {
    t_end: Option<f64>,
    dt: Option<f64>,
    events: Option<Vec<ps_model::study::SimEvent>>,
    load_p_power: Option<f64>,
    load_p_current: Option<f64>,
    load_q_power: Option<f64>,
    load_q_current: Option<f64>,
    load_v_low: Option<f64>,
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
pub fn handle(
    kind: &str,
    opts: &Value,
    doc: Option<&Loaded>,
    session: &mut Session,
    progress: &mut dyn Progress,
) -> Result<Value, String> {
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
            let (start, held) = match o.start {
                Some(s) => {
                    let index = model.index();
                    let mut per_node = vec![None; model.nodes.len()];
                    for (k, id) in s.bus_ids.iter().enumerate() {
                        if let (Some(row), Some(&vm), Some(&va)) =
                            (index.get(Class::Node, id), s.vm.get(k), s.va.get(k))
                        {
                            per_node[row] = Some((vm, va.to_radians()));
                        }
                    }
                    // Units no longer in the network are passed over: the solve finds their limits as usual.
                    let mut dir = vec![0_i8; model.nodes.len()];
                    for u in &s.held {
                        let node = index
                            .get(Class::Generator, &u.id)
                            .and_then(|r| model.generators.get(r))
                            .map(|g| g.node)
                            .or_else(|| {
                                index
                                    .get(Class::Svc, &u.id)
                                    .and_then(|r| model.svcs.get(r))
                                    .map(|v| v.node)
                            });
                        if let Some(slot) = node.and_then(|n| dir.get_mut(n.index())) {
                            *slot = match u.limit {
                                Limit::Min => -1,
                                Limit::Max => 1,
                            };
                        }
                    }
                    (Some(per_node), Some(dir))
                }
                None => (None, None),
            };
            to_json(&loadflow::run_cached(
                model,
                &LoadFlowRun {
                    settings,
                    outages,
                    start,
                    held,
                },
                &mut session.lf,
            ))
        }
        "shortcircuit" => {
            let o: ShortCircuitOptions = options(opts)?;
            let mut st = study.shortcircuit.clone();
            st.fault = o.fault.unwrap_or(st.fault);
            st.mode = o.mode.unwrap_or(st.mode);
            st.kappa = o.kappa.unwrap_or(st.kappa);
            st.lv_tolerance = o.lv_tolerance.unwrap_or(st.lv_tolerance);
            st.t_min = o.t_min.unwrap_or(st.t_min);
            st.t_k = o.t_k.unwrap_or(st.t_k);
            st.line_temperature = o.line_temperature.unwrap_or(st.line_temperature);
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
            let r = &study.rms;
            let settings = RmsSettings {
                t_end: o.t_end.unwrap_or(r.t_end),
                dt: o.dt.unwrap_or(r.dt),
                events: o.events.unwrap_or_else(|| r.events.clone()),
                load_p_power: o.load_p_power.unwrap_or(r.load_p_power),
                load_p_current: o.load_p_current.unwrap_or(r.load_p_current),
                load_q_power: o.load_q_power.unwrap_or(r.load_q_power),
                load_q_current: o.load_q_current.unwrap_or(r.load_q_current),
                load_v_low: o.load_v_low.unwrap_or(r.load_v_low),
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
