//! Contingency analysis: every selected outage is solved by an AC load flow from the base case and judged against
//! the branch limits and every node's voltage band.
//!
//! The outages come from the study case: every line, transformer, generator or HVDC link it selects (N-1), and its
//! list of contingencies of several elements. Both go through one type, [`Contingency`].
//!
//! The base case is built and solved once. An outage of one branch that does not split the network keeps the
//! network's buses and its admittance pattern (the branch's admittances become zero), so it is solved on a copy of
//! the base network, started from the base voltages, reusing the base case's ordering and symbolic factorisation
//! ([`ps_lf::Cache`]). Every other outage (one that splits the network, a generator, a link, several elements) is
//! built afresh through topology processing, as a load flow with those elements switched out would be.
//!
//! The work splits into chunks of outages ([`run_chunk`]) that [`merge`] combines in chunk order, so a pool of
//! engines running contiguous chunks produces exactly the sequential result ([`run`]).

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};

use ps_lf::{Cache, PuNetwork, Solution};
use ps_model::study::{Action, Condition, Contingency, RemedialAction, StudyCase};
use ps_model::{Class, Model};
use ps_net::Calc;
use ps_num::C64;
use ps_topology::{Outages, active};

use crate::limits;
use crate::loadflow::{self, LoadFlowRun};
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
    /// Contingency identifier (or `base`).
    pub id: String,
    /// The class of a single-element outage: `line`, `trafo`, `trafo3`, `gen`, `hvdc`; `multiple` for several
    /// elements; `base` for the base case.
    pub cls: String,
    /// The elements out.
    pub elements: Vec<String>,
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
    /// Whether screening judged the outage safe without a full load flow (its loading is then the estimate's).
    pub screened: bool,
    /// Remedial actions that fired; the case's results are those after them.
    pub remedial: Vec<String>,
    /// Violations the outage caused before the remedial actions.
    pub violations_before: usize,
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

/// How the cases were solved.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Effort {
    /// Outages solved on the base network with its ordering reused.
    pub reused: usize,
    /// Outages built afresh (splitting the network, machines, links, several elements).
    pub rebuilt: usize,
    /// Outages screening judged safe without a full load flow.
    pub screened: usize,
}

/// Where the time went.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Timing {
    /// The longest chunk, ms (the whole run when run in one).
    pub total_ms: f64,
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
    /// How the cases were solved.
    pub effort: Effort,
    /// Where the time went.
    pub timing: Timing,
    /// What the analysis wants the user to know about how it ran, such as why screening did not apply.
    pub notes: Vec<String>,
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
    /// How this chunk's cases were solved.
    pub effort: Effort,
    /// Where the time went.
    pub timing: Timing,
    /// What the analysis wants the user to know about how it ran.
    pub notes: Vec<String>,
}

/// The contingencies a study case selects, in order: lines, transformers, generators and HVDC links one at a time
/// (each class in model order), then its list.
pub fn definitions(model: &Model, study: &StudyCase) -> Vec<Contingency> {
    let st = &study.contingency;
    let none = Outages::none();
    let mut out = Vec::new();
    let mut add = |class: Class, n: usize, on: bool| {
        if !on {
            return;
        }
        for r in (0..n).filter(|&r| active(model, &none, class, r)) {
            let id = model.id_of(class, r).unwrap_or("").to_string();
            out.push(Contingency {
                id: id.clone(),
                name: model.name_of(class, r).to_string(),
                elements: vec![id],
            });
        }
    };
    add(Class::Line, model.lines.len(), st.lines);
    add(Class::Transformer2, model.transformers2.len(), st.trafos);
    add(Class::Transformer3, model.transformers3.len(), st.trafos);
    add(Class::Generator, model.generators.len(), st.gens);
    add(Class::Hvdc, model.hvdc_lines.len(), st.hvdc);
    // A fault on every busbar: buses of bus-branch models and busbar sections of node-breaker ones, where anything
    // connects.
    if st.busbars {
        let incidence = Incidence::new(model);
        for (row, n) in model.nodes.iter().enumerate() {
            let busbar = matches!(n.kind, ps_model::NodeKind::Bus | ps_model::NodeKind::BusbarSection);
            if busbar && model.alive(Class::Node, row) && incidence.0.get(row).is_some_and(|e| !e.is_empty()) {
                out.push(Contingency {
                    id: n.id.clone(),
                    name: if n.name.is_empty() {
                        n.id.clone()
                    } else {
                        n.name.clone()
                    },
                    elements: vec![n.id.clone()],
                });
            }
        }
    }
    out.extend(st.list.iter().cloned());
    out
}

fn cls_name(class: Class) -> &'static str {
    match class {
        Class::Line => "line",
        Class::Transformer2 => "trafo",
        Class::Transformer3 => "trafo3",
        Class::Generator => "gen",
        Class::Hvdc => "hvdc",
        Class::Load => "load",
        Class::Shunt => "shunt",
        _ => "other",
    }
}

/// What judging a solved network needs, per calculation branch and bus.
struct Monitor {
    /// Per branch: element identifier, the applicable limits of its ends (kA) and its rating (MVA).
    branches: Vec<(String, [Option<f64>; 2], Option<f64>)>,
    /// Per bus: identifier and voltage band.
    buses: Vec<(String, f64, f64)>,
    /// Bus of every node identifier.
    node_bus: HashMap<String, usize>,
}

impl Monitor {
    fn new(model: &Model, calc: &Calc, duration_s: Option<f64>) -> Self {
        let branches = calc
            .branches
            .iter()
            .map(|&src| {
                (
                    model.id_of(src.class, src.row as usize).unwrap_or("").to_string(),
                    limits::end_limits(model, src, duration_s),
                    limits::rated_mva(model, src),
                )
            })
            .collect();
        let buses = calc
            .topo
            .buses
            .iter()
            .enumerate()
            .map(|(b, bus)| {
                let (lo, hi) = bus.nodes.iter().map(|&n| &model.nodes[n as usize]).fold(
                    (f64::NEG_INFINITY, f64::INFINITY),
                    |(lo, hi), n| {
                        (
                            if n.v_min > 0.0 { lo.max(n.v_min) } else { lo },
                            if n.v_max > 0.0 { hi.min(n.v_max) } else { hi },
                        )
                    },
                );
                (calc.bus_id(model, b), lo, hi)
            })
            .collect();
        let node_bus = calc
            .topo
            .buses
            .iter()
            .enumerate()
            .flat_map(|(b, bus)| bus.nodes.iter().map(move |&n| (model.nodes[n as usize].id.clone(), b)))
            .collect();
        Self {
            branches,
            buses,
            node_bus,
        }
    }
}

/// A solved state reduced to what a case reports: each branch's loading and each bus's voltage.
struct Outcome {
    loadings: Vec<(usize, f64)>,
    voltages: Vec<(usize, f64)>,
}

/// Loadings and voltages of a solved network; buses that are not energised (no node) are left out.
fn outcome(net: &PuNetwork, sol: &Solution, mon: &Monitor, real_bus: &[bool]) -> Outcome {
    let sb = net.base_mva;
    let flows = ps_lf::branch_flows(net, &sol.vm, &sol.va);
    let loadings = flows
        .iter()
        .filter_map(|fl| {
            let (_, lim, rated) = &mon.branches[fl.id];
            let i = [fl.i_from_ka, fl.i_to_ka];
            let s = [fl.s_from.abs() * sb, fl.s_to.abs() * sb];
            // A branch the outage switched out (its admittances zero) is not judged.
            if out_of_service(&net.branches[fl.id]) {
                return None;
            }
            limits::loading(*lim, *rated, i, s).map(|l| (fl.id, l))
        })
        .collect();
    let voltages = (0..net.buses.len())
        .filter(|&b| real_bus[b])
        .map(|b| (b, sol.vm[b]))
        .collect();
    Outcome { loadings, voltages }
}

/// Whether a branch is switched out on the base network (the fast path sets its admittances to zero).
fn out_of_service(br: &ps_lf::PuBranch) -> bool {
    br.yft == C64::ZERO && br.ytf == C64::ZERO && br.yff == C64::ZERO && br.ytt == C64::ZERO
}

/// The base case's state for the fast path: the network as solved, started from its voltages, and the branches
/// whose loss splits it.
struct Base {
    net: PuNetwork,
    opt: ps_lf::Options,
    bridges: HashSet<usize>,
    monitor: Monitor,
    real_bus: Vec<bool>,
    /// The calculation branch of each line and two-winding transformer, by class and row.
    branch_of: HashMap<(Class, u32), usize>,
}

impl Base {
    /// The calculation branch of a single-branch outage when the fast path and screening can take it: a line or a
    /// two-winding transformer whose loss keeps the network whole.
    fn reusable_branch(&self, found: &[(Class, usize)]) -> Option<usize> {
        match found {
            [(k @ (Class::Line | Class::Transformer2), row)] => self
                .branch_of
                .get(&(*k, *row as u32))
                .copied()
                .filter(|b| !self.bridges.contains(b)),
            _ => None,
        }
    }
}

/// Branches whose removal splits the network (bridges of its graph; parallel branches never are).
fn bridges(net: &PuNetwork) -> HashSet<usize> {
    let n = net.buses.len();
    let mut adj: Vec<Vec<(usize, usize)>> = vec![Vec::new(); n];
    for (k, br) in net.branches.iter().enumerate() {
        if br.f != br.t {
            adj[br.f].push((br.t, k));
            adj[br.t].push((br.f, k));
        }
    }
    let mut disc = vec![usize::MAX; n];
    let mut low = vec![0usize; n];
    let mut out = HashSet::new();
    let mut time = 0;
    for root in 0..n {
        if disc[root] != usize::MAX {
            continue;
        }
        // Iterative depth-first search: (bus, edge it was entered by, next neighbour index).
        let mut stack: Vec<(usize, usize, usize)> = vec![(root, usize::MAX, 0)];
        disc[root] = time;
        low[root] = time;
        time += 1;
        while let Some(&mut (u, via, ref mut next)) = stack.last_mut() {
            if *next < adj[u].len() {
                let (v, e) = adj[u][*next];
                *next += 1;
                if e == via {
                    continue;
                }
                if disc[v] == usize::MAX {
                    disc[v] = time;
                    low[v] = time;
                    time += 1;
                    stack.push((v, e, 0));
                } else {
                    low[u] = low[u].min(disc[v]);
                }
            } else {
                stack.pop();
                if let Some(&(p, _, _)) = stack.last() {
                    low[p] = low[p].min(low[u]);
                    if low[u] > disc[p] {
                        out.insert(via);
                    }
                }
            }
        }
    }
    out
}

/// Fast decoupled iterations of a screened outage, and the largest mismatch they must reach, p.u.
const SCREEN_ITERATIONS: usize = 10;
const SCREEN_TOLERANCE: f64 = 1e-5;
/// The change in loading, %, an estimate must show to count for a branch already inside the margins in the base
/// case, and how close to the loading limit it may come before it counts whatever its change. The screening test
/// holds the estimate's error to a tenth of it.
pub const SCREEN_DRIFT_LOADING: f64 = 0.1;
/// The same for voltages, p.u.
pub const SCREEN_DRIFT_V: f64 = 1e-3;

/// What screening needs: the decoupled models of the base network (B′ and B″, factorised once), its admittance
/// matrix and its solved state.
///
/// Each single-branch outage is solved by fast decoupled iterations from the base solution on the full AC equations
/// with the branch out, reusing the base network's factorised B′ and B″ (so no factorisation per outage). When they
/// reach 1e-5 p.u. within ten iterations, the branches' flows and the buses' voltages are judged at that state with
/// the margins; otherwise, or when anything comes within the margins, the outage gets a full Newton load flow.
struct Screen {
    dc: ps_lf::DcModel,
    vmodel: ps_lf::VoltageModel,
    y: ps_lf::Ybus,
    vm: Vec<f64>,
    va: Vec<f64>,
    /// Injection of every bus at the base solution, p.u.: the schedule the estimate holds.
    s: Vec<C64>,
    /// Buses whose angle is fixed (references) and whose voltage magnitude a control holds.
    reference: Vec<bool>,
    fixed: Vec<bool>,
    /// Branches and buses that already violate a limit in the base case (their violations are the base case's): buses
    /// by side, since an outage can take a bus above its band in the base case below it.
    branch_in_base: HashSet<usize>,
    low_in_base: HashSet<usize>,
    high_in_base: HashSet<usize>,
    /// Loading above which an outage is solved in full, %.
    threshold: f64,
    /// The loading limit itself, %.
    limit: f64,
    margin_v: f64,
    /// Base loading of every branch, %.
    base_loading: Vec<Option<f64>>,
    /// Loads whose power follows their voltage (with voltage-dependent loads on), by index into the network's loads.
    zip_loads: Vec<usize>,
    /// Static var compensators held at a limit, whose output then follows the square of their voltage: bus and limit
    /// at 1 p.u.
    held_svcs: Vec<(usize, f64)>,
    /// The reactive limits that hold the base solution, when the study respects them.
    reactive: Option<Reactive>,
}

/// What screening checks of reactive limits: the room each voltage-controlled bus's machines have left, and the buses
/// held at a limit with their voltage targets.
struct Reactive {
    /// Per bus: how far its machines' reactive power may rise and fall before a limit, p.u. (zero where none control).
    up: Vec<f64>,
    down: Vec<f64>,
    /// Buses held at a limit: bus, +1 at the upper limit (voltage below target) or −1 at the lower, voltage target.
    held: Vec<(usize, i8, f64)>,
}

impl Reactive {
    fn new(net: &ps_lf::PuNetwork, sol: &Solution) -> Self {
        let n = net.buses.len();
        let (mut up, mut down) = (vec![0.0; n], vec![0.0; n]);
        let mut grid_bus = vec![false; n];
        for g in &net.grids {
            grid_bus[g.bus] = true;
        }
        // A machine with a reactive range under 1 Mvar does not control voltage when limits apply; leaving it out
        // only shrinks the room.
        let tiny = 1.0 / net.base_mva;
        for (m, g) in net.machines.iter().enumerate() {
            let Some(out) = sol.machines.get(m) else { continue };
            let held = sol.v_held.get(g.bus).copied().unwrap_or(false);
            if g.mode == ps_lf::MachineMode::Pq
                || !held
                || grid_bus[g.bus]
                || out.at_limit != 0
                || g.q_max - g.q_min < tiny
            {
                continue;
            }
            let s = if g.kind == ps_lf::UnitKind::Svc {
                sol.vm[g.bus] * sol.vm[g.bus]
            } else {
                1.0
            };
            up[g.bus] += (g.q_max * s - out.q).max(0.0);
            down[g.bus] += (out.q - g.q_min * s).max(0.0);
        }
        let held = sol
            .held
            .iter()
            .filter_map(|&(m, dir)| net.machines.get(m).map(|g| (g.bus, dir, g.v_set)))
            .collect();
        Self { up, down, held }
    }
}

/// The reactive power a screened machine must keep clear of its limits, and the voltage a bus held at a limit must keep
/// clear of its target, p.u.: ten times the estimate's error at 1e-5 p.u. of mismatch.
const SCREEN_Q_MARGIN: f64 = 1e-4;
const SCREEN_RELEASE_V: f64 = 1e-4;

/// Why screening does not apply to a study, when it does not: the decoupled solution keeps the base solution's
/// controls as they are, so a control that an outage would move rules it out.
fn screening_ruled_out(net: &ps_lf::PuNetwork, lf: &ps_model::study::LoadFlowSettings) -> Option<&'static str> {
    use ps_model::study::Balance;
    let controlling = |g: &&ps_lf::PuMachine| g.mode != ps_lf::MachineMode::Pq;
    if lf.remote_voltage && net.machines.iter().filter(controlling).any(|g| g.reg_bus != g.bus) {
        return Some("machines regulate remote busbars");
    }
    if lf.balance != Balance::Reference {
        return Some("the imbalance is shared among several units");
    }
    if (lf.tap_control || lf.phase_control) && !net.taps.is_empty() {
        return Some("tap changers regulate");
    }
    if lf.shunt_control && !net.shunt_controls.is_empty() {
        return Some("switched shunts regulate");
    }
    None
}

impl Screen {
    fn new(base: &Base, sol: &Solution, base_case: &Case, study: &StudyCase) -> Option<Self> {
        let st = &study.contingency;
        let net = &base.net;
        let dc = ps_lf::DcModel::new(net)?;
        let fixed = sol.v_held.clone();
        let vmodel = ps_lf::VoltageModel::new(&base.net, &fixed)?;
        let y = ps_lf::Ybus::build(&base.net, &[]);
        let injections = ps_lf::bus_injections(&y, &sol.vm, &sol.va);
        let reference: Vec<bool> = sol.kind.iter().map(|k| *k == ps_lf::BusKind::Reference).collect();
        let loading_ids: HashSet<&str> = base_case
            .violations
            .iter()
            .filter(|v| v.kind == "loading")
            .map(|v| v.id.as_str())
            .collect();
        let in_base = |kind: &str| -> HashSet<usize> {
            let ids: HashSet<&str> = base_case
                .violations
                .iter()
                .filter(|v| v.kind == kind)
                .map(|v| v.id.as_str())
                .collect();
            (0..base.monitor.buses.len())
                .filter(|&b| ids.contains(base.monitor.buses[b].0.as_str()))
                .collect()
        };
        Some(Self {
            dc,
            vmodel,
            y,
            vm: sol.vm.clone(),
            va: sol.va.clone(),
            s: injections,
            reference,
            fixed,
            branch_in_base: (0..base.monitor.branches.len())
                .filter(|&b| loading_ids.contains(base.monitor.branches[b].0.as_str()))
                .collect(),
            low_in_base: in_base("undervoltage"),
            high_in_base: in_base("overvoltage"),
            threshold: st.max_loading * (1.0 - st.screening_margin / 100.0),
            limit: st.max_loading,
            margin_v: st.screening_voltage,
            base_loading: {
                let out = outcome(&base.net, sol, &base.monitor, &base.real_bus);
                let mut v = vec![None; base.monitor.branches.len()];
                for (b, l) in out.loadings {
                    v[b] = Some(l);
                }
                v
            },
            zip_loads: if study.loadflow.voltage_dependent_loads {
                (0..net.loads.len())
                    .filter(|&k| net.loads[k].p_zip[2] != 1.0 || net.loads[k].q_zip[2] != 1.0)
                    .collect()
            } else {
                Vec::new()
            },
            held_svcs: sol
                .held
                .iter()
                .filter_map(|&(m, dir)| net.machines.get(m).map(|g| (g, dir)))
                .filter(|(g, _)| g.kind == ps_lf::UnitKind::Svc)
                .map(|(g, dir)| (g.bus, if dir > 0 { g.q_max } else { g.q_min }))
                .collect(),
            reactive: study.loadflow.enforce_q_limits.then(|| Reactive::new(net, sol)),
        })
    }

    /// The estimate of losing branch `k`: `Some(highest loading)` when every branch stays below the threshold and
    /// every voltage inside its band by the margin; `None` when the outage needs a full load flow (or the estimate
    /// does not converge).
    fn estimate(&mut self, base: &Base, k: usize) -> Option<Outcome> {
        let net = &base.net;
        let n = net.buses.len();
        let sb = net.base_mva;
        let br = net.branches[k];
        let mut va = self.va.clone();
        let mut vm = self.vm.clone();
        let mut v: Vec<C64> = (0..n).map(|i| C64::from_polar(vm[i], va[i])).collect();
        let mut cur = vec![C64::ZERO; n];
        // The mismatches of the base schedule (the base solution's injections, with voltage-dependent loads and
        // compensators held at a limit at the new voltages) with the branch out.
        let mismatch = |v: &[C64], cur: &mut [C64]| -> Vec<C64> {
            self.y.mul(v, cur);
            cur[br.f] -= br.yff * v[br.f] + br.yft * v[br.t];
            cur[br.t] -= br.ytf * v[br.f] + br.ytt * v[br.t];
            let mut ds: Vec<C64> = (0..n).map(|i| self.s[i] - v[i] * cur[i].conj()).collect();
            for &l in &self.zip_loads {
                let load = &net.loads[l];
                let (p0, q0, _, _) = load.at(self.vm[load.bus], true);
                let (p, q, _, _) = load.at(v[load.bus].abs(), true);
                ds[load.bus] += C64::new(p0 - p, q0 - q);
            }
            for &(b, q) in &self.held_svcs {
                ds[b] += C64::new(0.0, q * (v[b].norm_sqr() - self.vm[b] * self.vm[b]));
            }
            ds
        };
        // B′ and B″ without the branch: low-rank corrections of the base factors.
        let dc_change = self.dc.without_branch(k)?;
        let v_change = self.vmodel.without_branch(&br)?;
        let mut converged = false;
        for _ in 0..SCREEN_ITERATIONS {
            let ds = mismatch(&v, &mut cur);
            let dp: Vec<(usize, f64)> = (0..n).map(|i| (i, ds[i].re / vm[i])).collect();
            let worst_p = (0..n)
                .filter(|&i| !self.reference[i])
                .fold(0.0_f64, |m, i| m.max(ds[i].re.abs()));
            let worst_q = (0..n)
                .filter(|&i| !self.fixed[i])
                .fold(0.0_f64, |m, i| m.max(ds[i].im.abs()));
            if worst_p < SCREEN_TOLERANCE && worst_q < SCREEN_TOLERANCE {
                converged = true;
                break;
            }
            let dth = self.dc.angles_with(&dc_change, &dp);
            for i in 0..n {
                va[i] += dth[i];
                v[i] = C64::from_polar(vm[i], va[i]);
            }
            let ds = mismatch(&v, &mut cur);
            let dq: Vec<(usize, f64)> = (0..n)
                .filter(|&i| !self.fixed[i])
                .map(|i| (i, ds[i].im / vm[i]))
                .collect();
            let dv = self.vmodel.response_with(&v_change, &dq);
            for i in 0..n {
                vm[i] += dv[i];
                v[i] = C64::from_polar(vm[i], va[i]);
            }
            if vm.iter().any(|x| !x.is_finite() || *x < 0.3) {
                return None;
            }
        }
        if !converged {
            return None;
        }
        if let Some(r) = &self.reactive {
            // The reactive power each voltage-controlled bus must now supply beyond the base case's, against the room
            // its machines have; and a bus held at a limit must not reach the voltage that would release it.
            let ds = mismatch(&v, &mut cur);
            // The reference machines too: they keep the angle but lose the voltage at a limit like any other.
            for b in (0..n).filter(|&b| self.fixed[b]) {
                let dq = -ds[b].im;
                if dq > r.up[b] - SCREEN_Q_MARGIN || -dq > r.down[b] - SCREEN_Q_MARGIN {
                    return None;
                }
            }
            for &(b, dir, target) in &r.held {
                let released = if dir > 0 {
                    vm[b] > target - SCREEN_RELEASE_V
                } else {
                    vm[b] < target + SCREEN_RELEASE_V
                };
                if released {
                    return None;
                }
            }
        }
        for (b, (_, lo, hi)) in base.monitor.buses.iter().enumerate() {
            // A bus whose voltage a control holds keeps it in the full solution too (a reactive limit that would release
            // it is checked above), so only a violation the base case already has could show there.
            if !base.real_bus[b] || self.fixed[b] {
                continue;
            }
            // A voltage inside the margin counts when the outage moves it further towards the band's edge, and always
            // when it comes within the drift of the edge itself; a side the base case already violates is the base
            // case's.
            let (v, v0) = (vm[b], self.vm[b]);
            let low = !self.low_in_base.contains(&b)
                && v < lo + self.margin_v
                && (v < v0 - SCREEN_DRIFT_V || v < lo + SCREEN_DRIFT_V);
            let high = !self.high_in_base.contains(&b)
                && v > hi - self.margin_v
                && (v > v0 + SCREEN_DRIFT_V || v > hi - SCREEN_DRIFT_V);
            if low || high || !v.is_finite() {
                return None;
            }
        }
        let mut loadings = Vec::new();
        for (l, b) in net.branches.iter().enumerate() {
            if l == k {
                continue;
            }
            let (_, lim, rated) = &base.monitor.branches[l];
            if lim.iter().all(Option::is_none) && rated.is_none() {
                continue;
            }
            let (vf, vt) = (C64::from_polar(vm[b.f], va[b.f]), C64::from_polar(vm[b.t], va[b.t]));
            let (i_f, i_t) = (b.yff * vf + b.yft * vt, b.ytf * vf + b.ytt * vt);
            let s = [(vf * i_f.conj()).abs() * sb, (vt * i_t.conj()).abs() * sb];
            let ka = |bus: usize| sb / ((3.0_f64).sqrt() * net.buses[bus].base_kv);
            let i = [i_f.abs() * ka(b.f), i_t.abs() * ka(b.t)];
            let Some(load) = limits::loading(*lim, *rated, i, s) else {
                continue;
            };
            loadings.push((l, load));
            // A loading inside the margin counts when the outage raises it, and always when it comes within the drift
            // of the limit itself.
            let raised = self.base_loading[l].is_none_or(|b| load > b + SCREEN_DRIFT_LOADING)
                || load > self.limit - SCREEN_DRIFT_LOADING;
            if load > self.threshold && raised && !self.branch_in_base.contains(&l) {
                return None;
            }
        }
        let voltages = (0..n).filter(|&b| base.real_bus[b]).map(|b| (b, vm[b])).collect();
        Some(Outcome { loadings, voltages })
    }
}

/// What a contingency that rebuilds the network starts from, by node: the base solution's voltages (magnitude p.u.,
/// angle radians) and the reactive limits its machines are held at (−1 lower, +1 upper, 0 none).
struct Start {
    voltages: Vec<Option<(f64, f64)>>,
    held: Vec<i8>,
}

/// The base case, solved once, and what every contingency starts from.
struct Prepared {
    base: Base,
    screen: Option<Screen>,
    base_case: Case,
    start: Start,
    base_dead: HashSet<String>,
    post_duration: Option<f64>,
    limit: f64,
    notes: Vec<String>,
}

fn prepare(model: &Model, study: &StudyCase) -> Result<Prepared, String> {
    let st = &study.contingency;
    let limit = st.max_loading;
    let post_duration = (st.acceptable_s > 0.0).then_some(st.acceptable_s);
    // A model that carries a solution (an imported state) starts its base case from it.
    let stored = model.nodes.iter().any(|n| n.v0 > 0.0);
    let run = LoadFlowRun {
        settings: study.loadflow,
        start: stored.then(|| {
            model
                .nodes
                .iter()
                .map(|n| (n.v0 > 0.0).then(|| (n.v0, n.angle0.to_radians())))
                .collect()
        }),
        ..Default::default()
    };
    let (calc, sol, base_report) = loadflow::solve(model, &run);
    if !base_report.converged {
        return Err(format!("The base case does not converge: {}", base_report.message));
    }
    let real_bus: Vec<bool> = calc.topo.buses.iter().map(|b| !b.nodes.is_empty()).collect();
    let base_dead: HashSet<String> = base_report.deenergized.iter().cloned().collect();
    // The base case is judged against permanent limits; outages against those for the acceptable duration.
    let base_monitor = Monitor::new(model, &calc, None);
    let base_out = outcome(&sol.net, &sol, &base_monitor, &real_bus);
    let base_case = judge(
        "base",
        "base",
        Vec::new(),
        &base_report_status(&base_report),
        Some(&base_out),
        &base_monitor,
        limit,
        None,
        Vec::new(),
    );
    let mut start = vec![None; model.nodes.len()];
    for (b, bus) in calc.topo.buses.iter().enumerate() {
        for &n in &bus.nodes {
            start[n as usize] = Some((sol.vm[b], sol.va[b]));
        }
    }
    // The base solution's reactive limit state by node, for outages that rebuild the network.
    let mut held_start = vec![0_i8; model.nodes.len()];
    for &(m, dir) in &sol.held {
        if let Some(g) = sol.net.machines.get(m) {
            for &n in &calc.topo.buses[g.bus].nodes {
                held_start[n as usize] = dir;
            }
        }
    }
    // Every outage starts from the base solution: its voltages, and with reactive limits the machines it holds at
    // a limit (as OpenLoadFlow's security analysis does), so each outage does not find them again.
    let mut net = sol.net.clone();
    for (b, bus) in net.buses.iter_mut().enumerate() {
        bus.vm0 = sol.vm[b];
        bus.va0 = sol.va[b];
        bus.held0 = 0;
    }
    for &(m, dir) in &sol.held {
        if let Some(g) = sol.net.machines.get(m) {
            net.buses[g.bus].held0 = dir;
        }
    }
    let opt = ps_lf::Options {
        warm_start: true,
        ..loadflow::options(&study.loadflow, model.meta.base_mva, true)
    };
    let base = Base {
        bridges: bridges(&net),
        branch_of: calc
            .branches
            .iter()
            .enumerate()
            .filter(|(_, b)| b.winding == 0)
            .map(|(i, b)| ((b.class, b.row), i))
            .collect(),
        monitor: Monitor::new(model, &calc, post_duration),
        net,
        opt,
        real_bus,
    };
    let mut notes = Vec::new();
    let screen = match (st.screening, screening_ruled_out(&base.net, &study.loadflow)) {
        (false, _) => None,
        (true, Some(why)) => {
            notes.push(format!("Screening is off for this study: {why}, which the quick decoupled solution cannot follow, so every outage gets a full load flow."));
            None
        }
        (true, None) => Screen::new(&base, &sol, &base_case, study),
    };
    Ok(Prepared {
        base,
        screen,
        base_case,
        start: Start {
            voltages: start,
            held: held_start,
        },
        base_dead,
        post_duration,
        limit,
        notes,
    })
}

/// What connects at each node: the in-service elements with a terminal there, switches included. A busbar fault takes
/// them out.
struct Incidence(Vec<Vec<(Class, usize)>>);

impl Incidence {
    fn new(model: &Model) -> Self {
        let mut at = vec![Vec::new(); model.nodes.len()];
        for class in [
            Class::Line,
            Class::Transformer2,
            Class::Transformer3,
            Class::Generator,
            Class::Load,
            Class::Shunt,
            Class::Svc,
            Class::ExternalGrid,
            Class::Converter,
            Class::Switch,
        ] {
            for row in (0..model.len(class)).filter(|&r| active(model, &Outages::none(), class, r)) {
                for n in model.element_nodes(class, row) {
                    if let Some(list) = at.get_mut(n.index()) {
                        list.push((class, row));
                    }
                }
            }
        }
        Self(at)
    }
}

/// The elements of a contingency resolved to classes and rows, its class name, and the identifiers not found. A node
/// stands for a fault on that busbar: its protection opens every switch around it and everything connected there goes
/// out.
fn resolve<'a>(
    index: &ps_model::IdIndex,
    incidence: &Incidence,
    c: &'a Contingency,
) -> (Vec<(Class, usize)>, &'static str, Vec<&'a str>) {
    let mut found: Vec<(Class, usize)> = Vec::new();
    let mut busbars = 0;
    for id in &c.elements {
        if let Some(row) = index.get(Class::Node, id) {
            busbars += 1;
            for &e in incidence.0.get(row).into_iter().flatten() {
                if !found.contains(&e) {
                    found.push(e);
                }
            }
        } else if let Some(e) = Class::ALL.iter().find_map(|&k| index.get(k, id).map(|row| (k, row)))
            && !found.contains(&e)
        {
            found.push(e);
        }
    }
    let cls = match (found.as_slice(), busbars, c.elements.len()) {
        (_, 1, 1) => "busbar",
        ([(k, _)], 0, _) => cls_name(*k),
        _ => "multiple",
    };
    let missing = c
        .elements
        .iter()
        .filter(|id| !Class::ALL.iter().any(|&k| index.get(k, id).is_some()))
        .map(String::as_str)
        .collect();
    (found, cls, missing)
}

/// The remedial actions whose conditions hold on a contingency's solution, in order.
fn fired<'a>(rules: &'a [RemedialAction], c: &Contingency, out: &Outcome, mon: &Monitor) -> Vec<&'a RemedialAction> {
    let loading = |id: &str| {
        out.loadings
            .iter()
            .filter(|(b, _)| mon.branches[*b].0 == id)
            .map(|x| x.1)
            .fold(None, |m: Option<f64>, x| Some(m.map_or(x, |m| m.max(x))))
    };
    let voltage = |node: &str| {
        let bus = *mon.node_bus.get(node)?;
        out.voltages.iter().find(|(b, _)| *b == bus).map(|x| x.1)
    };
    rules
        .iter()
        .filter(|r| r.contingencies.is_empty() || r.contingencies.contains(&c.id))
        .filter(|r| {
            r.conditions.iter().all(|cond| match cond {
                Condition::Loading { element, above } => loading(element).is_some_and(|l| l > *above),
                Condition::VoltageBelow { node, below } => voltage(node).is_some_and(|v| v < *below),
                Condition::VoltageAbove { node, above } => voltage(node).is_some_and(|v| v > *above),
                Condition::Outage { element } => c.elements.contains(element),
            })
        })
        .collect()
}

/// The model with remedial actions applied. Returns what could not be applied, in plain words.
fn apply(model: &Model, rules: &[&RemedialAction]) -> (Model, Vec<String>) {
    let mut m = model.clone();
    let index = m.index();
    let mut problems = Vec::new();
    let find = |id: &str| Class::ALL.iter().find_map(|&k| index.get(k, id).map(|row| (k, row)));
    for r in rules {
        for a in &r.actions {
            let ok = match a {
                Action::Switch { element, in_service } => match find(element) {
                    Some((Class::Line, row)) => {
                        m.lines[row].in_service = *in_service;
                        true
                    }
                    Some((Class::Transformer2, row)) => {
                        m.transformers2[row].in_service = *in_service;
                        true
                    }
                    Some((Class::Transformer3, row)) => {
                        m.transformers3[row].in_service = *in_service;
                        true
                    }
                    Some((Class::Generator, row)) => {
                        m.generators[row].in_service = *in_service;
                        true
                    }
                    Some((Class::Load, row)) => {
                        m.loads[row].in_service = *in_service;
                        true
                    }
                    Some((Class::Shunt, row)) => {
                        m.shunts[row].in_service = *in_service;
                        true
                    }
                    Some((Class::Switch, row)) => {
                        m.switches[row].open = !*in_service;
                        true
                    }
                    _ => false,
                },
                Action::Generation { element, p } => match find(element) {
                    Some((Class::Generator, row)) => {
                        m.generators[row].p = *p;
                        true
                    }
                    _ => false,
                },
                Action::Tap { element, position } => match find(element) {
                    Some((Class::Transformer2, row)) => {
                        let t = &mut m.transformers2[row];
                        match (t.ratio_taps.first_mut(), t.phase_tap.as_mut()) {
                            (Some(r), _) => r.position = *position,
                            (None, Some(p)) => p.position = *position,
                            _ => {}
                        }
                        true
                    }
                    _ => false,
                },
                Action::LoadShed { element, percent } => match find(element) {
                    Some((Class::Load, row)) => {
                        let keep = 1.0 - percent.clamp(0.0, 100.0) / 100.0;
                        m.loads[row].p *= keep;
                        m.loads[row].q *= keep;
                        true
                    }
                    _ => false,
                },
            };
            if !ok {
                problems.push(format!(
                    "Remedial action {}: its element is missing or of the wrong kind.",
                    r.id
                ));
            }
        }
    }
    (m, problems)
}

/// Runs contingencies `range` of [`definitions`] (the base case is solved in every chunk).
pub fn run_chunk(
    model: &Model,
    study: &StudyCase,
    range: std::ops::Range<usize>,
    progress: &mut dyn Progress,
) -> Result<Chunk, String> {
    let t0 = ps_num::clock::now_ms();
    let Prepared {
        base,
        mut screen,
        base_case,
        start,
        base_dead,
        post_duration,
        limit,
        notes,
    } = prepare(model, study)?;
    let base_dead: HashSet<&str> = base_dead.iter().map(String::as_str).collect();
    let mut cache = Cache::default();
    let list = definitions(model, study);
    let range = range.start.min(list.len())..range.end.min(list.len());
    let total = range.len();
    let index = model.index();
    let incidence = Incidence::new(model);
    let mut cases = Vec::with_capacity(total);
    let mut worst = Worst::default();
    let mut effort = Effort::default();
    for (done, c) in list[range].iter().enumerate() {
        let (found, cls, missing) = resolve(&index, &incidence, c);
        // Screening: a single branch that keeps the network whole and whose estimate stays clear of every limit.
        if let Some(scr) = screen.as_mut()
            && let Some(b) = base.reusable_branch(&found)
            && let Some(est) = scr.estimate(&base, b)
            // A remedial action that would fire on the estimate needs the full solution.
            && fired(&study.contingency.remedial, c, &est, &base.monitor).is_empty()
        {
            effort.screened += 1;
            let mut case = judge(
                &c.id,
                cls,
                c.elements.clone(),
                &Status {
                    converged: true,
                    message: format!(
                        "Screened: the decoupled solution keeps every branch below {:.0} % of its limit and every voltage inside its band.",
                        100.0 - study.contingency.screening_margin
                    ),
                },
                Some(&est),
                &base.monitor,
                limit,
                Some(&base_case),
                Vec::new(),
            );
            case.screened = true;
            worst.record(&est, &base.monitor, &c.id);
            cases.push(case);
            progress.report((done + 1) as f64, total as f64);
            continue;
        }
        let solved = if missing.is_empty() {
            solve_case(
                model,
                study,
                &base,
                &mut cache,
                &found,
                &start,
                &base_dead,
                post_duration,
                &mut effort,
                true,
            )
        } else {
            Solved {
                status: Status {
                    converged: false,
                    message: format!("Unknown element(s): {}.", missing.join(", ")),
                },
                sol: None,
                rebuilt: None,
                lost: Vec::new(),
            }
        };
        let mut out = solved.outcome(&base);
        let mut case = judge(
            &c.id,
            cls,
            c.elements.clone(),
            &solved.status,
            out.as_ref(),
            solved.monitor(&base),
            limit,
            Some(&base_case),
            solved.lost.clone(),
        );
        // Remedial actions: those whose conditions hold apply, and the contingency is solved again with them.
        let rules = out
            .as_ref()
            .map(|o| fired(&study.contingency.remedial, c, o, solved.monitor(&base)))
            .unwrap_or_default();
        let mut after: Option<Solved> = None;
        if !rules.is_empty() {
            let (acted, problems) = apply(model, &rules);
            let again = solve_case(
                &acted,
                study,
                &base,
                &mut cache,
                &found,
                &start,
                &base_dead,
                post_duration,
                &mut effort,
                // The actions changed the model, so the base network no longer applies.
                false,
            );
            let before = case.violations.iter().filter(|v| !v.in_base).count();
            out = again.outcome(&base);
            case = judge(
                &c.id,
                cls,
                c.elements.clone(),
                &again.status,
                out.as_ref(),
                again.monitor(&base),
                limit,
                Some(&base_case),
                again.lost.clone(),
            );
            case.remedial = rules.iter().map(|r| r.id.clone()).collect();
            case.violations_before = before;
            if !problems.is_empty() {
                case.message = format!("{} {}", case.message, problems.join(" "));
            }
            after = Some(again);
        }
        let monitor = after
            .as_ref()
            .map_or_else(|| solved.monitor(&base), |a| a.monitor(&base));
        if let Some(out) = &out {
            worst.record(out, monitor, &c.id);
        }
        cases.push(case);
        progress.report((done + 1) as f64, total as f64);
    }
    Ok(Chunk {
        base: base_case,
        cases,
        worst_loading: worst.loading,
        worst_voltage: worst.voltage,
        limit,
        effort,
        timing: Timing {
            total_ms: ps_num::clock::now_ms() - t0,
        },
        notes,
    })
}

/// The worst loading of every branch and the voltage extremes of every bus over the cases so far, in first-seen order.
#[derive(Default)]
struct Worst {
    loading: Vec<(String, WorstLoading)>,
    loading_at: HashMap<String, usize>,
    voltage: Vec<(String, WorstVoltage)>,
    voltage_at: HashMap<String, usize>,
}

impl Worst {
    /// Takes in one case's outcome; a tie keeps the earlier case.
    fn record(&mut self, out: &Outcome, monitor: &Monitor, case: &str) {
        for &(b, value) in &out.loadings {
            let id = &monitor.branches[b].0;
            match self.loading_at.get(id) {
                Some(&k) if value <= self.loading[k].1.value => {}
                Some(&k) => {
                    self.loading[k].1 = WorstLoading {
                        value,
                        outage: case.to_string(),
                    }
                }
                None => {
                    self.loading_at.insert(id.clone(), self.loading.len());
                    self.loading.push((
                        id.clone(),
                        WorstLoading {
                            value,
                            outage: case.to_string(),
                        },
                    ));
                }
            }
        }
        for &(b, vm) in &out.voltages {
            let id = &monitor.buses[b].0;
            let k = *self.voltage_at.entry(id.clone()).or_insert_with(|| {
                self.voltage.push((
                    id.clone(),
                    WorstVoltage {
                        min: f64::INFINITY,
                        min_outage: String::new(),
                        max: f64::NEG_INFINITY,
                        max_outage: String::new(),
                    },
                ));
                self.voltage.len() - 1
            });
            let w = &mut self.voltage[k].1;
            if vm < w.min {
                w.min = vm;
                w.min_outage = case.to_string();
            }
            if vm > w.max {
                w.max = vm;
                w.max_outage = case.to_string();
            }
        }
    }
}

struct Status {
    converged: bool,
    message: String,
}

fn base_report_status(r: &loadflow::LoadFlowReport) -> Status {
    Status {
        converged: r.converged,
        message: r.message.clone(),
    }
}

/// A solved contingency: its network as solved, with the monitor and buses of a rebuilt one.
struct Solved {
    status: Status,
    sol: Option<Solution>,
    rebuilt: Option<(Monitor, Vec<bool>)>,
    lost: Vec<String>,
}

impl Solved {
    fn outcome(&self, base: &Base) -> Option<Outcome> {
        let sol = self.sol.as_ref().filter(|s| s.converged)?;
        let (mon, real) = self
            .rebuilt
            .as_ref()
            .map_or((&base.monitor, &base.real_bus), |(m, r)| (m, r));
        Some(outcome(&sol.net, sol, mon, real))
    }

    fn monitor<'a>(&'a self, base: &'a Base) -> &'a Monitor {
        self.rebuilt.as_ref().map_or(&base.monitor, |(m, _)| m)
    }
}

/// Solves one contingency: on the base network when it is one branch that keeps the network whole, otherwise built
/// afresh.
#[allow(clippy::too_many_arguments)]
fn solve_case(
    model: &Model,
    study: &StudyCase,
    base: &Base,
    cache: &mut Cache,
    found: &[(Class, usize)],
    start: &Start,
    base_dead: &HashSet<&str>,
    post_duration: Option<f64>,
    effort: &mut Effort,
    fast: bool,
) -> Solved {
    let branch = if fast { base.reusable_branch(found) } else { None };
    if let Some(b) = branch {
        effort.reused += 1;
        let mut net = base.net.clone();
        let br = &mut net.branches[b];
        br.yff = C64::ZERO;
        br.yft = C64::ZERO;
        br.ytf = C64::ZERO;
        br.ytt = C64::ZERO;
        let sol = ps_lf::solve_cached(&net, &base.opt, cache);
        return Solved {
            status: Status {
                converged: sol.converged,
                message: sol.message.clone(),
            },
            sol: Some(sol),
            rebuilt: None,
            lost: Vec::new(),
        };
    }
    effort.rebuilt += 1;
    let mut outages = Outages::none();
    for &(k, row) in found {
        outages.insert(k, row);
    }
    let (calc, sol, report) = loadflow::solve_prepared(
        model,
        &LoadFlowRun {
            settings: study.loadflow,
            outages,
            start: Some(start.voltages.clone()),
        },
        |calc| {
            for (b, bus) in calc.topo.buses.iter().enumerate() {
                let held = bus.nodes.iter().map(|&n| start.held[n as usize]).find(|&h| h != 0);
                calc.net.buses[b].held0 = held.unwrap_or(0);
            }
        },
    );
    let lost = report
        .deenergized
        .iter()
        .filter(|b| !base_dead.contains(b.as_str()))
        .cloned()
        .collect();
    let monitor = Monitor::new(model, &calc, post_duration);
    let real_bus: Vec<bool> = calc.topo.buses.iter().map(|b| !b.nodes.is_empty()).collect();
    Solved {
        status: Status {
            converged: report.converged,
            message: report.message.clone(),
        },
        sol: Some(sol),
        rebuilt: Some((monitor, real_bus)),
        lost,
    }
}

/// Post-contingency flows and voltages of one contingency, by identifier, for checking the engine against other
/// tools. Flows are MW and Mvar into a branch at its ends (`p1`, `q1`, `p2`, `q2`); voltages p.u. and degrees.
#[derive(Debug, Clone, PartialEq)]
pub struct Detail {
    /// Contingency identifier.
    pub id: String,
    /// Whether its load flow converged.
    pub converged: bool,
    /// Load flow outcome.
    pub message: String,
    /// Whether it was solved on the base network with the base case's ordering.
    pub reused: bool,
    /// Flows of every two-terminal branch in service.
    pub flows: HashMap<String, [f64; 4]>,
    /// Voltage of every energised bus.
    pub voltages: HashMap<String, (f64, f64)>,
}

/// Solves the given contingencies through the same paths as [`run_chunk`] and returns their flows and voltages.
pub fn detailed(model: &Model, study: &StudyCase, list: &[Contingency]) -> Result<Vec<Detail>, String> {
    let p = prepare(model, study)?;
    let base_dead: HashSet<&str> = p.base_dead.iter().map(String::as_str).collect();
    let index = model.index();
    let incidence = Incidence::new(model);
    let mut cache = Cache::default();
    let mut effort = Effort::default();
    let mut out = Vec::with_capacity(list.len());
    for c in list {
        let (found, _, missing) = resolve(&index, &incidence, c);
        if !missing.is_empty() {
            return Err(format!("{}: unknown element(s) {}", c.id, missing.join(", ")));
        }
        let before = effort.reused;
        let solved = solve_case(
            model,
            study,
            &p.base,
            &mut cache,
            &found,
            &p.start,
            &base_dead,
            p.post_duration,
            &mut effort,
            true,
        );
        let mon = solved.monitor(&p.base);
        let mut flows = HashMap::new();
        let mut voltages = HashMap::new();
        if let Some(sol) = solved.sol.as_ref().filter(|s| s.converged) {
            let sb = sol.net.base_mva;
            for fl in ps_lf::branch_flows(&sol.net, &sol.vm, &sol.va) {
                if out_of_service(&sol.net.branches[fl.id]) {
                    continue;
                }
                flows.insert(
                    mon.branches[fl.id].0.clone(),
                    [fl.s_from.re * sb, fl.s_from.im * sb, fl.s_to.re * sb, fl.s_to.im * sb],
                );
            }
            for (b, (id, _, _)) in mon.buses.iter().enumerate() {
                if b < sol.vm.len() {
                    voltages.insert(id.clone(), (sol.vm[b], sol.va[b].to_degrees()));
                }
            }
        }
        out.push(Detail {
            id: c.id.clone(),
            converged: solved.status.converged,
            message: solved.status.message.clone(),
            reused: effort.reused > before,
            flows,
            voltages,
        });
    }
    Ok(out)
}

/// Combines chunks of contiguous outage ranges, given in outage order.
pub fn merge(chunks: Vec<Chunk>) -> Result<ContingencyReport, String> {
    let mut iter = chunks.into_iter();
    let first = iter.next().ok_or("there are no contingency results to merge")?;
    let (base, limit, notes) = (first.base.clone(), first.limit, first.notes.clone());
    let mut cases = Vec::new();
    let mut worst_loading: BTreeMap<String, WorstLoading> = BTreeMap::new();
    let mut worst_voltage: BTreeMap<String, WorstVoltage> = BTreeMap::new();
    let mut effort = Effort::default();
    let mut timing = Timing::default();
    for chunk in std::iter::once(first).chain(iter) {
        cases.extend(chunk.cases);
        effort.reused += chunk.effort.reused;
        effort.rebuilt += chunk.effort.rebuilt;
        effort.screened += chunk.effort.screened;
        timing.total_ms = timing.total_ms.max(chunk.timing.total_ms);
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
        effort,
        timing,
        notes,
    })
}

/// Runs every selected contingency.
pub fn run(model: &Model, study: &StudyCase, progress: &mut dyn Progress) -> Result<ContingencyReport, String> {
    merge(vec![run_chunk(model, study, 0..usize::MAX, progress)?])
}

#[allow(clippy::too_many_arguments)]
fn judge(
    id: &str,
    cls: &str,
    elements: Vec<String>,
    status: &Status,
    out: Option<&Outcome>,
    mon: &Monitor,
    limit: f64,
    base: Option<&Case>,
    lost_buses: Vec<String>,
) -> Case {
    let mut c = Case {
        id: id.into(),
        cls: cls.into(),
        elements,
        converged: status.converged,
        message: status.message.clone(),
        max_loading: None,
        max_loading_id: String::new(),
        min_v: None,
        min_v_bus: String::new(),
        max_v: None,
        max_v_bus: String::new(),
        lost_buses,
        violations: Vec::new(),
        screened: false,
        remedial: Vec::new(),
        violations_before: 0,
    };
    let Some(out) = out else { return c };
    let in_base =
        |kind: &str, el: &str| base.is_some_and(|b| b.violations.iter().any(|v| v.kind == kind && v.id == el));
    let violation = |kind: &str, id: &str, value: f64, limit: f64| Violation {
        kind: kind.into(),
        id: id.into(),
        value,
        limit,
        in_base: in_base(kind, id),
    };
    for &(b, loading) in &out.loadings {
        let bid = &mon.branches[b].0;
        if c.max_loading.is_none_or(|m| loading > m) {
            c.max_loading = Some(loading);
            c.max_loading_id.clone_from(bid);
        }
        if loading > limit {
            c.violations.push(violation("loading", bid, loading, limit));
        }
    }
    for &(b, vm) in &out.voltages {
        let (bid, vmin, vmax) = &mon.buses[b];
        if c.min_v.is_none_or(|m| vm < m) {
            c.min_v = Some(vm);
            c.min_v_bus.clone_from(bid);
        }
        if c.max_v.is_none_or(|m| vm > m) {
            c.max_v = Some(vm);
            c.max_v_bus.clone_from(bid);
        }
        if vm < vmin - 1e-9 {
            c.violations.push(violation("undervoltage", bid, vm, *vmin));
        }
        if vm > vmax + 1e-9 {
            c.violations.push(violation("overvoltage", bid, vm, *vmax));
        }
    }
    c
}

#[cfg(test)]
mod tests {
    use super::*;
    use ps_lf::PuBranch;

    fn branch(f: usize, t: usize) -> PuBranch {
        PuBranch {
            id: 0,
            f,
            t,
            yff: C64::new(0.0, -10.0),
            yft: C64::new(0.0, 10.0),
            ytf: C64::new(0.0, 10.0),
            ytt: C64::new(0.0, -10.0),
            shift: 0.0,
            ratio: 1.0,
        }
    }

    #[test]
    fn bridges_are_the_branches_whose_loss_splits_the_network() {
        // A ring 0-1-2-0 with a spur 2-3, and a doubled branch 3-4.
        let mut net = PuNetwork {
            buses: vec![
                ps_lf::PuBus {
                    base_kv: 1.0,
                    vm0: 1.0,
                    va0: 0.0,
                    held0: 0
                };
                5
            ],
            ..Default::default()
        };
        net.branches = vec![
            branch(0, 1),
            branch(1, 2),
            branch(2, 0),
            branch(2, 3),
            branch(3, 4),
            branch(3, 4),
        ];
        let b = bridges(&net);
        assert_eq!(b, HashSet::from([3]));
    }
}
