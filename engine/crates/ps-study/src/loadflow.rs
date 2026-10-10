//! Load flow study and its report.

use ps_lf::{BusKind, Options};
use ps_model::study::{Balance, LoadFlowSettings};
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

/// An HVDC link's result. Powers enter the link from the AC network at each converter station.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HvdcResult {
    /// Link identifier.
    pub id: String,
    /// Station identifiers at ends 1 and 2.
    pub stations: [String; 2],
    /// Active power at end 1, MW.
    pub p1: f64,
    /// Reactive power at end 1, Mvar.
    pub q1: f64,
    /// Active power at end 2, MW.
    pub p2: f64,
    /// Reactive power at end 2, Mvar.
    pub q2: f64,
    /// Losses of the stations and the DC line, MW.
    pub losses: f64,
}

/// A tap changer the load flow regulated.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TapResult {
    /// Transformer identifier.
    pub id: String,
    /// `trafo` or `trafo3`.
    pub cls: &'static str,
    /// Winding the tap changer sits on.
    pub winding: u8,
    /// `ratio` or `phase`.
    pub kind: &'static str,
    /// Position after the load flow.
    pub position: i32,
    /// Position before it.
    pub start: i32,
    /// Lowest position.
    pub low: i32,
    /// Highest position.
    pub high: i32,
}

/// A switched shunt the load flow regulated.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SectionResult {
    /// Shunt identifier.
    pub id: String,
    /// Sections in service after the load flow.
    pub sections: u32,
    /// Sections before it.
    pub start: u32,
    /// Sections installed.
    pub max: u32,
}

/// A bus with a large remaining mismatch when the load flow did not converge.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MismatchResult {
    /// Bus identifier.
    pub id: String,
    /// Active power mismatch, MW.
    pub p: f64,
    /// Reactive power mismatch, Mvar.
    pub q: f64,
    /// Voltage at the last iteration, p.u.
    pub vm: f64,
}

/// What one control did.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ControlResult {
    /// `slack`, `reactiveLimits`, `phaseShifters`, `taps` or `shunts`.
    pub control: &'static str,
    /// Times it changed something.
    pub changes: usize,
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
    /// HVDC links.
    pub hvdc: Vec<HvdcResult>,
    /// Tap changers the load flow regulated.
    pub taps: Vec<TapResult>,
    /// Switched shunts the load flow regulated.
    pub sections: Vec<SectionResult>,
    /// Active power the slack distribution moved, MW.
    pub distributed: f64,
    /// What each enabled control did.
    pub controls: Vec<ControlResult>,
    /// When it did not converge: the buses with the largest remaining mismatch.
    pub worst: Vec<MismatchResult>,
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
    let opt = options(st, sb, run.start.is_some());
    let sol = ps_lf::solve(&calc.net, &opt);
    let mut report = assemble(model, &calc, &sol, st);
    report.timing = Timing {
        build_ms,
        analyse_ms: sol.timing.analyse_ms,
        factor_solve_ms: sol.timing.factor_solve_ms,
        total_ms: ps_num::clock::now_ms() - t0,
    };
    (calc, sol, report)
}

/// The solver options for study case settings on base power `sb`.
pub fn options(st: &LoadFlowSettings, sb: f64, warm_start: bool) -> Options {
    Options {
        tolerance: st.tolerance / sb,
        max_iter: st.max_iter as usize,
        enforce_q_limits: st.enforce_q_limits,
        dc_start: st.dc_start,
        warm_start,
        balance: match st.balance {
            Balance::Reference => ps_lf::Balance::Reference,
            Balance::MaxP => ps_lf::Balance::MaxP,
            Balance::TargetP => ps_lf::Balance::TargetP,
            Balance::Factor => ps_lf::Balance::Factor,
            Balance::Margin => ps_lf::Balance::Margin,
            Balance::Load => ps_lf::Balance::Load,
        },
        slack_tolerance: st.slack_tolerance / sb,
        remote_voltage: st.remote_voltage,
        zip_loads: st.voltage_dependent_loads,
        tap_control: st.tap_control,
        shunt_control: st.shunt_control,
        phase_control: st.phase_control,
        max_outer: 30,
    }
}

/// Runs a load flow.
pub fn run(model: &Model, run: &LoadFlowRun) -> LoadFlowReport {
    solve(model, run).2
}

fn assemble(model: &Model, calc: &Calc, sol: &ps_lf::Solution, st: &LoadFlowSettings) -> LoadFlowReport {
    // The solved network carries the final taps and sections.
    let net = &sol.net;
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
            let (id, cls) = match src.class {
                Class::Line => (model.lines[row].id.clone(), "line"),
                Class::Transformer2 => (model.transformers2[row].id.clone(), "trafo"),
                _ => (model.transformers3[row].id.clone(), "trafo3"),
            };
            let loading = crate::limits::loading(
                crate::limits::end_limits(model, src, None),
                crate::limits::rated_mva(model, src),
                [fl.i_from_ka, fl.i_to_ka],
                [fl.s_from.abs() * sb, fl.s_to.abs() * sb],
            );
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
    let svcs: Vec<UnitResult> = sol
        .machines
        .iter()
        .filter(|u| calc.unit(u.id).0 == Class::Svc)
        .map(|u| UnitResult {
            id: model.svcs[calc.unit(u.id).1].id.clone(),
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
        .filter(|u| calc.unit(u.id).0 == Class::Generator)
        .map(|u| UnitResult {
            id: model.generators[calc.unit(u.id).1].id.clone(),
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
        .zip(&sol.loads)
        .filter(|(l, _)| calc.load_unit(l.id).0 == Class::Load)
        .map(|(l, &(p, q))| UnitResult {
            id: model.loads[calc.load_unit(l.id).1].id.clone(),
            p: p * sb,
            q: q * sb,
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
    if !st.remote_voltage && net.machines.iter().any(|g| g.reg_bus != g.bus) {
        warnings.push(
            "Remote voltage control is off: machines that regulate another busbar hold their own terminals.".into(),
        );
    }
    if !st.voltage_dependent_loads && net.loads.iter().any(|l| l.p_zip[2] != 1.0 || l.q_zip[2] != 1.0) {
        warnings.push("Voltage-dependent loads are off: every load is solved as constant power.".into());
    }
    warnings.extend(sol.notes.iter().cloned());
    for &(m, lim) in &sol.held {
        let q = sol.machines[m].q * sb;
        let word = if lim > 0 { "upper" } else { "lower" };
        let (class, row) = calc.unit(m);
        warnings.push(format!(
            "{} reached its {word} reactive power limit and now holds {q:.2} Mvar.",
            model.name_of(class, row)
        ));
    }
    // Each station's draw from its AC network: a line-commutated one as the load it is, a voltage-source one as the
    // negative of its output.
    let station_pq = |row: u32| -> (f64, f64) {
        let lcc = net
            .loads
            .iter()
            .zip(&sol.loads)
            .find(|(l, _)| calc.load_unit(l.id) == (Class::Converter, row as usize))
            .map(|(_, &(p, q))| (p * sb, q * sb));
        let vsc = || {
            sol.machines
                .iter()
                .find(|u| calc.unit(u.id) == (Class::Converter, row as usize))
                .map(|u| (-u.p * sb, -u.q * sb))
        };
        lcc.or_else(vsc).unwrap_or((0.0, 0.0))
    };
    let hvdc = calc
        .hvdc
        .iter()
        .map(|h| {
            let ((p1, q1), (p2, q2)) = (station_pq(h.stations[0]), station_pq(h.stations[1]));
            HvdcResult {
                id: model.hvdc_lines[h.row as usize].id.clone(),
                stations: h.stations.map(|s| model.converters[s as usize].id.clone()),
                p1,
                q1,
                p2,
                q2,
                losses: p1 + p2,
            }
        })
        .collect();
    let taps = sol
        .net
        .taps
        .iter()
        .zip(&calc.net.taps)
        .flat_map(|(after, before)| after.axes.iter().zip(&before.axes))
        .map(|(a, b)| {
            let src = calc.tap_sources[a.id];
            let (id, cls) = match src.class {
                Class::Transformer2 => (model.transformers2[src.row as usize].id.clone(), "trafo"),
                _ => (model.transformers3[src.row as usize].id.clone(), "trafo3"),
            };
            TapResult {
                id,
                cls,
                winding: src.end,
                kind: if src.phase { "phase" } else { "ratio" },
                position: a.low + a.index as i32,
                start: b.low + b.index as i32,
                low: a.low,
                high: a.low + a.count as i32 - 1,
            }
        })
        .collect();
    let sections = sol
        .net
        .shunt_controls
        .iter()
        .zip(&calc.net.shunt_controls)
        .map(|(a, b)| SectionResult {
            id: model.shunts[calc.shunt_controls[a.id] as usize].id.clone(),
            sections: a.index as u32,
            start: b.index as u32,
            max: (a.steps.len() - 1) as u32,
        })
        .collect();
    let controls = sol
        .controls
        .iter()
        .map(|c| ControlResult {
            control: match c.control {
                ps_lf::Control::Slack => "slack",
                ps_lf::Control::ReactiveLimits => "reactiveLimits",
                ps_lf::Control::PhaseShifters => "phaseShifters",
                ps_lf::Control::Taps => "taps",
                ps_lf::Control::Shunts => "shunts",
            },
            changes: c.changes,
        })
        .collect();
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
        message: match sol.worst.first() {
            Some(&(b, p, q)) if !sol.converged => {
                let name = calc.topo.buses[b].nodes.first().map_or_else(
                    || bus_ids[b].clone(),
                    |&n| model.name_of(Class::Node, n as usize).to_string(),
                );
                format!(
                    "{} The largest mismatch is at {name}: {:.1} MW and {:.1} Mvar, at {:.3} p.u.",
                    sol.message,
                    p * sb,
                    q * sb,
                    sol.vm[b]
                )
            }
            _ => sol.message.clone(),
        },
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
        hvdc,
        taps,
        sections,
        distributed: sol.distributed.iter().sum::<f64>() * sb,
        controls,
        worst: sol
            .worst
            .iter()
            .map(|&(b, p, q)| MismatchResult {
                id: bus_ids.get(b).cloned().unwrap_or_default(),
                p: p * sb,
                q: q * sb,
                vm: sol.vm.get(b).copied().unwrap_or(0.0),
            })
            .collect(),
        state: State {
            vm: sol.vm.clone(),
            va: sol.va.iter().map(|a| a * DEG).collect(),
        },
        bus_ids,
        timing: Timing::default(),
    }
}
