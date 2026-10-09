//! Load flow study and its report.

use ps_lf::{BusKind, Options};
use ps_model::study::LoadFlowSettings;
use ps_model::{Class, Model};
use ps_net::{BuildOptions, Calc};
use ps_num::DEG;
use ps_topology::Outages;
use serde::Serialize;

/// One load flow run: settings, outages and an optional warm start.
#[derive(Debug, Clone, Default)]
pub struct LoadFlowRun {
    /// Settings (tolerance in MVA, load scale in %).
    pub settings: LoadFlowSettings,
    /// Elements out of service for this run only.
    pub outages: Outages,
    /// Starting voltage of each node (magnitude p.u., angle radians); `None` entries start from setpoints.
    pub start: Option<Vec<Option<(f64, f64)>>>,
}

/// A calculation bus's result.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct BusResult {
    /// Identifier of the bus's first node.
    pub id: String,
    /// Voltage magnitude, p.u.
    pub vm: f64,
    /// Voltage angle, degrees.
    pub va: f64,
    /// Voltage magnitude, kV.
    pub kv: f64,
    /// Net active injection, MW.
    pub p: f64,
    /// Net reactive injection, Mvar.
    pub q: f64,
    /// Bus type as solved: `Ref`, `PV` or `PQ`.
    #[serde(rename = "type")]
    pub kind: &'static str,
}

/// A branch's result. Powers enter the branch at each end.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BranchResult {
    /// Element identifier.
    pub id: String,
    /// `line`, `trafo` or `trafo3`.
    pub cls: &'static str,
    /// Winding of a three-winding transformer (1–3); absent otherwise.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub winding: Option<u8>,
    /// Active power at the from end, MW.
    pub p_from: f64,
    /// Reactive power at the from end, Mvar.
    pub q_from: f64,
    /// Active power at the to end, MW.
    pub p_to: f64,
    /// Reactive power at the to end, Mvar.
    pub q_to: f64,
    /// Current at the from end, kA.
    pub i_from: f64,
    /// Current at the to end, kA.
    pub i_to: f64,
    /// Active losses, MW.
    pub p_loss: f64,
    /// Reactive losses, Mvar.
    pub q_loss: f64,
    /// Loading, % of the permanent current limit (lines) or rated power (transformers); `null` without a rating.
    pub loading: Option<f64>,
}

/// A unit's output.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UnitResult {
    /// Element identifier.
    pub id: String,
    /// Active power, MW.
    pub p: f64,
    /// Reactive power, Mvar.
    pub q: f64,
    /// `min` or `max` when held at a reactive limit.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at_limit: Option<&'static str>,
}

/// One Newton iteration.
#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
pub struct IterationResult {
    /// Iteration number.
    pub iteration: usize,
    /// Largest mismatch after it, MVA.
    pub mismatch: f64,
}

/// System totals.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    /// Generation, MW.
    pub generation: f64,
    /// Load, MW.
    pub load: f64,
    /// Losses, MW.
    pub losses: f64,
    /// Reactive generation, Mvar.
    pub generation_q: f64,
    /// Reactive load, Mvar.
    pub load_q: f64,
}

/// Solved voltages in bus order.
#[derive(Debug, Clone, Serialize, PartialEq, Default)]
pub struct State {
    /// Magnitudes, p.u.
    pub vm: Vec<f64>,
    /// Angles, degrees.
    pub va: Vec<f64>,
}

/// Timing of the run.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Timing {
    /// Topology processing and network build, ms.
    pub build_ms: f64,
    /// Ordering and symbolic factorisation, ms.
    pub analyse_ms: f64,
    /// Numeric factorisation and solves, ms.
    pub factor_solve_ms: f64,
    /// Whole run, ms.
    pub total_ms: f64,
}

/// The load flow report.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LoadFlowReport {
    /// Whether the mismatch fell below the tolerance.
    pub converged: bool,
    /// Newton iterations.
    pub iterations: usize,
    /// Final largest mismatch, MVA.
    pub mismatch: f64,
    /// Progress per iteration.
    pub log: Vec<IterationResult>,
    /// Outcome in plain words.
    pub message: String,
    /// Energised buses.
    pub buses: Vec<BusResult>,
    /// Branches in the calculation.
    pub branches: Vec<BranchResult>,
    /// Generators.
    pub gens: Vec<UnitResult>,
    /// External grids.
    pub grids: Vec<UnitResult>,
    /// Static var compensators.
    pub svcs: Vec<UnitResult>,
    /// Loads.
    pub loads: Vec<UnitResult>,
    /// Shunts.
    pub shunts: Vec<UnitResult>,
    /// Nodes without supply.
    pub deenergized: Vec<String>,
    /// What the calculation decided or simplified.
    pub warnings: Vec<String>,
    /// System totals.
    pub totals: Totals,
    /// Voltages in bus order.
    pub state: State,
    /// Bus identifiers, in bus order.
    pub bus_ids: Vec<String>,
    /// Where the time went.
    pub timing: Timing,
}

/// Runs a load flow and returns the solved network with its report. Studies built on the load flow use the network.
pub fn solve(model: &Model, run: &LoadFlowRun) -> (Calc, ps_lf::Solution, LoadFlowReport) {
    let t0 = ps_num::clock::now_ms();
    let st = &run.settings;
    let mut calc = Calc::build(
        model,
        &run.outages,
        BuildOptions {
            load_scale: st.load_scale / 100.0,
        },
    );
    if let Some(start) = &run.start {
        calc.set_start(start);
    }
    let build_ms = ps_num::clock::now_ms() - t0;
    let sb = model.meta.base_mva;
    let opt = Options {
        tolerance: st.tolerance / sb,
        max_iter: st.max_iter as usize,
        enforce_q_limits: st.enforce_q_limits,
        dc_start: st.dc_start,
        warm_start: run.start.is_some(),
    };
    let sol = ps_lf::solve(&calc.net, &opt);
    let mut report = assemble(model, &calc, &sol);
    report.timing = Timing {
        build_ms,
        analyse_ms: sol.timing.analyse_ms,
        factor_solve_ms: sol.timing.factor_solve_ms,
        total_ms: ps_num::clock::now_ms() - t0,
    };
    (calc, sol, report)
}

/// Runs a load flow.
pub fn run(model: &Model, run: &LoadFlowRun) -> LoadFlowReport {
    solve(model, run).2
}

fn assemble(model: &Model, calc: &Calc, sol: &ps_lf::Solution) -> LoadFlowReport {
    let net = &calc.net;
    let sb = net.base_mva;
    let n = net.buses.len();
    let y = ps_lf::Ybus::build(net, &[]);
    let s = if n > 0 {
        ps_lf::bus_injections(&y, &sol.vm, &sol.va)
    } else {
        Vec::new()
    };
    let bus_ids: Vec<String> = (0..n).map(|b| calc.bus_id(model, b)).collect();
    let buses = (0..n)
        .map(|i| BusResult {
            id: bus_ids[i].clone(),
            vm: sol.vm[i],
            va: sol.va[i] * DEG,
            kv: sol.vm[i] * net.buses[i].base_kv,
            p: s[i].re * sb,
            q: s[i].im * sb,
            kind: match sol.kind.get(i) {
                Some(BusKind::Reference) => "Ref",
                Some(BusKind::Pv) => "PV",
                _ => "PQ",
            },
        })
        .collect();
    let flows = if n > 0 {
        ps_lf::branch_flows(net, &sol.vm, &sol.va)
    } else {
        Vec::new()
    };
    let mut losses = 0.0;
    let branches = flows
        .iter()
        .map(|fl| {
            let src = calc.branches[fl.id];
            let row = src.row as usize;
            let (p_from, q_from) = (fl.s_from.re * sb, fl.s_from.im * sb);
            let (p_to, q_to) = (fl.s_to.re * sb, fl.s_to.im * sb);
            let (id, cls, loading) = match src.class {
                Class::Line => {
                    let l = &model.lines[row];
                    let rated_ka = l
                        .limits
                        .iter()
                        .filter(|c| c.duration_s.is_none())
                        .map(|c| c.amps / 1000.0)
                        .fold(f64::INFINITY, f64::min);
                    let loading = (rated_ka.is_finite() && rated_ka > 0.0)
                        .then(|| fl.i_from_ka.max(fl.i_to_ka) / rated_ka * 100.0);
                    (l.id.clone(), "line", loading)
                }
                Class::Transformer2 => {
                    let t = &model.transformers2[row];
                    let s_max = fl.s_from.abs().max(fl.s_to.abs()) * sb;
                    (
                        t.id.clone(),
                        "trafo",
                        (t.rated_mva > 0.0).then(|| s_max / t.rated_mva * 100.0),
                    )
                }
                _ => {
                    let t = &model.transformers3[row];
                    let rated = t.windings[usize::from(src.winding.max(1)) - 1].rated_mva;
                    (
                        t.id.clone(),
                        "trafo3",
                        (rated > 0.0).then(|| fl.s_from.abs() * sb / rated * 100.0),
                    )
                }
            };
            losses += p_from + p_to;
            BranchResult {
                id,
                cls,
                winding: (src.class == Class::Transformer3).then_some(src.winding),
                p_from,
                q_from,
                p_to,
                q_to,
                i_from: fl.i_from_ka,
                i_to: fl.i_to_ka,
                p_loss: p_from + p_to,
                q_loss: q_from + q_to,
                loading,
            }
        })
        .collect();
    // Network machines are the generators, then the static var compensators.
    let ng = calc.machines.len();
    let unit_name = |m: usize| match m < ng {
        true => (Class::Generator, calc.machines[m] as usize),
        false => (Class::Svc, calc.svcs[m - ng] as usize),
    };
    let svcs: Vec<UnitResult> = sol
        .machines
        .iter()
        .filter(|u| u.id >= ng)
        .map(|u| UnitResult {
            id: model.svcs[calc.svcs[u.id - ng] as usize].id.clone(),
            p: 0.0,
            q: u.q * sb,
            at_limit: match u.at_limit {
                1 => Some("max"),
                -1 => Some("min"),
                _ => None,
            },
        })
        .collect();
    let gens: Vec<UnitResult> = sol
        .machines
        .iter()
        .filter(|u| u.id < ng)
        .map(|u| UnitResult {
            id: model.generators[calc.machines[u.id] as usize].id.clone(),
            p: u.p * sb,
            q: u.q * sb,
            at_limit: match u.at_limit {
                1 => Some("max"),
                -1 => Some("min"),
                _ => None,
            },
        })
        .collect();
    let grids: Vec<UnitResult> = sol
        .grids
        .iter()
        .map(|u| UnitResult {
            id: model.external_grids[calc.grids[u.id] as usize].id.clone(),
            p: u.p * sb,
            q: u.q * sb,
            at_limit: None,
        })
        .collect();
    let loads: Vec<UnitResult> = net
        .loads
        .iter()
        .map(|l| UnitResult {
            id: model.loads[calc.loads[l.id] as usize].id.clone(),
            p: l.p * sb,
            q: l.q * sb,
            at_limit: None,
        })
        .collect();
    let shunts: Vec<UnitResult> = net
        .shunts
        .iter()
        .take(calc.shunts.len())
        .map(|sh| {
            let v2 = sol.vm.get(sh.bus).map_or(0.0, |v| v * v);
            UnitResult {
                id: model.shunts[calc.shunts[sh.id] as usize].id.clone(),
                p: sh.y.re * v2 * sb,
                q: sh.y.im * v2 * sb,
                at_limit: None,
            }
        })
        .collect();
    let mut warnings = calc.warnings.clone();
    for &(m, lim) in &sol.held {
        let pm = &net.machines[m];
        let (word, q) = if lim > 0 {
            ("upper", pm.q_max * sb)
        } else {
            ("lower", pm.q_min * sb)
        };
        let (class, row) = unit_name(m);
        warnings.push(format!(
            "{} reached its {word} reactive power limit and now holds {q:.2} Mvar.",
            model.name_of(class, row)
        ));
    }
    let totals = Totals {
        generation: gens.iter().chain(&grids).map(|u| u.p).sum(),
        load: loads.iter().map(|u| u.p).sum(),
        losses,
        generation_q: gens.iter().chain(&grids).chain(&svcs).map(|u| u.q).sum(),
        load_q: loads.iter().map(|u| u.q).sum(),
    };
    LoadFlowReport {
        converged: sol.converged,
        iterations: sol.iterations,
        mismatch: sol.mismatch * sb,
        log: sol
            .log
            .iter()
            .map(|l| IterationResult {
                iteration: l.iteration,
                mismatch: l.mismatch * sb,
            })
            .collect(),
        message: sol.message.clone(),
        buses,
        branches,
        gens,
        grids,
        svcs,
        loads,
        shunts,
        deenergized: calc
            .topo
            .deenergised
            .iter()
            .map(|&n| model.nodes[n as usize].id.clone())
            .collect(),
        warnings,
        totals,
        state: State {
            vm: sol.vm.clone(),
            va: sol.va.iter().map(|a| a * DEG).collect(),
        },
        bus_ids,
        timing: Timing::default(),
    }
}
