//! The EMT simulation of a network: the circuit from the load flow, the events, and the report.

use ps_lf::Solution;
use ps_model::study::{EmtEvent, EmtEventKind, EmtFault, EmtSettings};
use ps_model::{Class, Model};
use ps_net::Calc;
use ps_num::C64;
use serde::Serialize;

use crate::dense::positive;
use crate::network::{self, Network, SourceAt, Target};
use crate::transient::Transient;

/// Values the report may hold in all (samples times traces), and the samples each trace keeps at least.
const VALUE_BUDGET: usize = 6_000_000;
const MIN_SAMPLES: usize = 300;
/// The most steps a simulation may take.
const MAX_STEPS: f64 = 20_000_000.0;
/// One-cycle RMS values use at most this many samples a cycle.
const RMS_POINTS: usize = 128;

/// Phase traces: a, b and c.
pub type Phases = [Vec<f32>; 3];

/// A busbar's voltages.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EmtBus {
    /// Identifier.
    pub id: String,
    /// Nominal voltage, kV (phase to phase).
    pub kv: f64,
    /// Phase-to-earth voltages, kV.
    pub v: Phases,
    /// Largest instantaneous phase-to-earth voltage, kV.
    pub peak: f64,
    /// The same as a share of the nominal crest `√2·Un/√3`, p.u.
    pub peak_pu: f64,
    /// When it occurred, s.
    pub peak_at: f64,
    /// Lowest one-cycle RMS voltage of any phase after the first cycle, p.u. of `Un/√3`.
    pub rms_min: f64,
    /// Highest, p.u.
    pub rms_max: f64,
}

/// A branch's currents.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EmtBranch {
    /// Identifier.
    pub id: String,
    /// Winding of a three-winding transformer, 1 to 3; 0 otherwise.
    pub winding: u8,
    /// `travelling`, `pi` or `transformer`.
    pub model: &'static str,
    /// Phase currents into the branch at its from end, kA.
    pub from: Phases,
    /// At its to end, kA.
    pub to: Phases,
    /// Largest instantaneous current at either end, kA.
    pub peak: f64,
    /// When it occurred, s.
    pub peak_at: f64,
}

/// A source's currents.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EmtSource {
    /// Identifier.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Phase currents out of the source into the network, kA.
    pub i: Phases,
    /// Largest instantaneous current, kA.
    pub peak: f64,
    /// When it occurred, s.
    pub peak_at: f64,
}

/// A fault's currents.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EmtFaultTrace {
    /// The faulted node.
    pub target: String,
    /// Kind.
    pub fault: EmtFault,
    /// When it began, s.
    pub t_on: f64,
    /// When its last phase went out, s; `None` while it lasts to the end.
    pub t_off: Option<f64>,
    /// Phase currents into the fault, kA.
    pub i: Phases,
    /// Largest instantaneous current, kA: the peak short-circuit current of this inception.
    pub peak: f64,
    /// When it occurred, s.
    pub peak_at: f64,
    /// The largest phase's RMS current over the fault's last full cycle, kA; `None` for a fault shorter than a cycle.
    pub rms: Option<f64>,
}

/// An event and what became of it.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct EmtAppliedEvent {
    /// The event as given.
    #[serde(flatten)]
    pub event: EmtEvent,
    /// Whether it changed the network.
    pub applied: bool,
    /// The step's time it acted at, s.
    pub at: f64,
    /// What it did, in plain words.
    pub note: String,
}

/// A breaker pole or fault path that opened at a current zero, or closed.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PoleOperation {
    /// Time, s.
    pub t: f64,
    /// The element (or faulted node).
    pub element: String,
    /// What happened, in plain words.
    pub note: String,
}

/// The EMT simulation report.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EmtReport {
    /// Sample times, s.
    pub t: Vec<f32>,
    /// Time step, s.
    pub dt: f64,
    /// Steps taken.
    pub steps: u64,
    /// Busbars.
    pub buses: Vec<EmtBus>,
    /// Branches.
    pub branches: Vec<EmtBranch>,
    /// Sources.
    pub sources: Vec<EmtSource>,
    /// Faults.
    pub faults: Vec<EmtFaultTrace>,
    /// Events in time order.
    pub events: Vec<EmtAppliedEvent>,
    /// Breaker poles and fault paths that opened at current zeros, in time order.
    pub operations: Vec<PoleOperation>,
    /// Lines simulated as travelling waves.
    pub travelling: usize,
    /// Lines simulated as π sections.
    pub pi: usize,
    /// The largest difference between the initial state's positive-sequence busbar voltages and the load flow's, p.u.
    pub initial_mismatch: f64,
    /// Matrix factorisations.
    pub factorisations: usize,
    /// Notes on the models.
    pub notes: Vec<String>,
    /// Outcome in plain words.
    pub message: String,
}

/// Solver options a caller may set; the defaults are what the app uses.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Options {
    /// Breakers and faults open at their command rather than at the next current zero. It exists so the engine can
    /// be compared with a circuit simulator whose switches are time-controlled.
    pub instant_switching: bool,
}

/// One-cycle RMS of a stream of values: squares of every `stride`-th step over one cycle.
struct Rms {
    stride: usize,
    len: usize,
    ring: Vec<f64>,
    sum: f64,
    count: usize,
    pos: usize,
}

impl Rms {
    fn new(cycle_steps: usize) -> Self {
        let stride = cycle_steps.div_ceil(RMS_POINTS).max(1);
        let len = (cycle_steps as f64 / stride as f64).round().max(1.0) as usize;
        Self {
            stride,
            len,
            ring: vec![0.0; len],
            sum: 0.0,
            count: 0,
            pos: 0,
        }
    }

    /// Adds the value of step `n`; returns the RMS once a full cycle is in.
    fn push(&mut self, n: u64, x: f64) -> Option<f64> {
        if !n.is_multiple_of(self.stride as u64) {
            return None;
        }
        let x2 = x * x;
        self.sum += x2 - self.ring[self.pos];
        self.ring[self.pos] = x2;
        self.pos = (self.pos + 1) % self.len;
        self.count += 1;
        // Recompute now and then so rounding does not accumulate.
        if self.pos == 0 {
            self.sum = self.ring.iter().sum();
        }
        (self.count >= self.len).then(|| (self.sum.max(0.0) / self.len as f64).sqrt())
    }

    fn reset(&mut self) {
        self.ring.iter_mut().for_each(|x| *x = 0.0);
        self.sum = 0.0;
        self.count = 0;
        self.pos = 0;
    }
}

/// A peak and when it occurred.
#[derive(Debug, Clone, Copy, Default)]
struct Peak {
    value: f64,
    at: f64,
}

impl Peak {
    fn see(&mut self, x: f64, t: f64) {
        if x.abs() > self.value {
            self.value = x.abs();
            self.at = t;
        }
    }
}

const PHASE: [&str; 3] = ["a", "b", "c"];

/// Simulates the settings' events from the load flow `lf` of `calc` (whose network is the solved one). `max_samples`
/// bounds the samples kept per trace, as does the report's budget of values; `progress` receives (simulated time,
/// end time).
pub fn simulate(
    model: &Model,
    calc: &Calc,
    lf: &Solution,
    st: &EmtSettings,
    max_samples: usize,
    options: Options,
    progress: &mut dyn FnMut(f64, f64),
) -> Result<EmtReport, String> {
    let dt = st.dt_us * 1e-6;
    if !(dt > 0.0 && st.t_end > 0.0 && dt.is_finite() && st.t_end.is_finite()) {
        return Err("The simulation time and time step must be above zero.".into());
    }
    let steps_f = (st.t_end / dt).round().max(1.0);
    if steps_f > MAX_STEPS {
        return Err(format!(
            "{steps_f:.0} steps are more than an EMT simulation takes ({MAX_STEPS:.0}); lengthen the step or shorten the time."
        ));
    }
    let steps = steps_f as u64;
    let f_hz = model.meta.frequency_hz;
    let sb = calc.net.base_mva;
    let Network {
        circuit,
        buses,
        branches,
        sources,
        faults,
        breakers,
        targets,
        owner,
        lf_voltage,
        travelling,
        pi,
        mut notes,
        refused,
    } = network::build(model, calc, lf, st, dt)?;
    let mut tr = Transient::new(circuit, dt)?;
    let initial_mismatch = buses
        .iter()
        .enumerate()
        .filter(|(b, _)| lf_voltage[*b].abs() > 1e-6)
        .map(|(b, bus)| {
            let v: Vec<C64> = bus.nodes.iter().map(|&n| tr.initial[n]).collect();
            (positive(&v) - lf_voltage[b]).abs()
        })
        .fold(0.0_f64, f64::max);

    let index = model.index();
    let name_of = |id: &str| -> String {
        Class::ALL
            .iter()
            .find_map(|&c| index.get(c, id).map(|row| model.name_of(c, row).to_string()))
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| id.to_string())
    };

    // Events, in time order, at the nearest step.
    let mut order: Vec<usize> = (0..st.events.len()).collect();
    order.sort_by(|&a, &b| st.events[a].t.total_cmp(&st.events[b].t));
    let mut events: Vec<EmtAppliedEvent> = order
        .iter()
        .map(|&k| {
            let ev = &st.events[k];
            EmtAppliedEvent {
                event: ev.clone(),
                applied: false,
                at: (ev.t.max(0.0) / dt).round() * dt,
                note: String::new(),
            }
        })
        .collect();
    let event_step: Vec<u64> = events
        .iter()
        .map(|e| (e.event.t.max(0.0) / dt).round() as u64)
        .collect();
    for (pos, &k) in order.iter().enumerate() {
        if let Some((_, why)) = refused.iter().find(|(r, _)| *r == k) {
            events[pos].note = format!("{} is {why}.", name_of(&events[pos].event.target));
        }
    }

    // Recording.
    let traces = 3 * buses.len() + 6 * branches.len() + 3 * sources.len() + 3 * faults.len();
    let samples = max_samples.min((VALUE_BUDGET / traces.max(1)).max(MIN_SAMPLES)).max(2);
    let every = (steps as usize + 1).div_ceil(samples).max(1) as u64;
    let cycle = (1.0 / (f_hz * dt)).round().max(1.0) as usize;
    let parts = Parts {
        buses: &buses,
        branches: &branches,
        sources: &sources,
        faults: &faults,
        breakers: &breakers,
        sb,
    };
    let mut rec = Recorder::new(&parts, cycle);
    let mut operations: Vec<PoleOperation> = Vec::new();
    rec.observe(&tr, &parts, true);
    let mut next = 0;
    let instant = options.instant_switching;
    for n in 0..steps {
        // Events of this step act after its point is solved.
        while next < events.len() && event_step[next] <= n {
            if events[next].note.is_empty() {
                let k = order[next];
                let ev = &mut events[next];
                let name = name_of(&ev.event.target);
                apply(&mut tr, ev, k, &name, &faults, &breakers, &targets, instant);
                if ev.applied
                    && ev.event.kind == EmtEventKind::Fault
                    && let Some(fk) = faults.iter().position(|f| f.event == k)
                {
                    rec.flt_on[fk] = Some(tr.time());
                    rec.flt_rms[fk].iter_mut().for_each(Rms::reset);
                }
            }
            next += 1;
        }
        let opened = tr.step()?;
        let t = tr.time();
        // The poles that opened, by element and end.
        let mut groups: Vec<(&network::Owner, Vec<usize>)> = Vec::new();
        for s in opened {
            let o = &owner[s];
            match groups
                .iter_mut()
                .find(|(g, _)| g.id == o.id && g.end == o.end && g.fault == o.fault)
            {
                Some((_, list)) => list.push(o.phase),
                None => groups.push((o, vec![o.phase])),
            }
        }
        for (o, mut poles) in groups {
            poles.sort_unstable();
            let what = poles.iter().map(|&p| PHASE[p]).collect::<Vec<_>>().join(", ");
            let s = if poles.len() > 1 { "s" } else { "" };
            let note = match (o.fault, o.end) {
                (true, _) => format!(
                    "Fault at {}: phase{s} {what} went out at a current zero.",
                    name_of(&o.id)
                ),
                (false, Some(b)) => format!(
                    "{}: pole{s} {what} at {} opened at a current zero.",
                    name_of(&o.id),
                    name_of(&buses[b].id)
                ),
                (false, None) => format!("{}: pole{s} {what} opened at a current zero.", name_of(&o.id)),
            };
            operations.push(PoleOperation {
                t,
                element: o.id.clone(),
                note,
            });
        }
        for (k, f) in faults.iter().enumerate() {
            if rec.flt_on[k].is_some() && rec.flt_off[k].is_none() && f.switches.iter().all(|&s| !tr.is_closed(s)) {
                rec.flt_off[k] = Some(t);
            }
        }
        let n1 = tr.steps();
        rec.observe(&tr, &parts, n1 % every == 0 || n1 == steps);
        if n1 & 255 == 0 {
            progress(t, st.t_end);
        }
    }
    progress(tr.time(), st.t_end);
    for ev in events.iter_mut().filter(|e| e.note.is_empty()) {
        ev.note = format!("At {:.4} s, after the end of the simulation.", ev.event.t);
    }
    for (s, o) in owner.iter().enumerate() {
        if tr.is_pending(s) {
            notes.push(format!(
                "{}: {} {} had not reached a current zero by the end.",
                name_of(&o.id),
                if o.fault { "phase" } else { "pole" },
                PHASE[o.phase]
            ));
        }
    }

    let Recorder {
        t: t_rec,
        bus_v,
        br_i,
        src_i,
        flt_i,
        bus_peak,
        rms_lo,
        rms_hi,
        br_peak,
        src_peak,
        flt_peak,
        flt_last_rms,
        flt_on,
        flt_off,
        ..
    } = rec;
    let buses_out: Vec<EmtBus> = buses
        .iter()
        .zip(bus_v)
        .enumerate()
        .map(|(k, (b, v))| EmtBus {
            peak: bus_peak[k].value,
            peak_pu: bus_peak[k].value / (2.0_f64.sqrt() * kv_phase(b.kv)),
            peak_at: bus_peak[k].at,
            rms_min: if rms_lo[k].is_finite() { rms_lo[k] } else { 0.0 },
            rms_max: rms_hi[k],
            id: b.id.clone(),
            kv: b.kv,
            v,
        })
        .collect();
    let branches_out: Vec<EmtBranch> = branches
        .iter()
        .zip(br_i)
        .enumerate()
        .map(|(k, (b, [from, to]))| EmtBranch {
            id: b.id.clone(),
            winding: b.winding,
            model: b.model,
            from,
            to,
            peak: br_peak[k].value,
            peak_at: br_peak[k].at,
        })
        .collect();
    let sources_out: Vec<EmtSource> = sources
        .iter()
        .zip(src_i)
        .enumerate()
        .map(|(k, (s, i))| EmtSource {
            id: s.id.clone(),
            name: s.name.clone(),
            i,
            peak: src_peak[k].value,
            peak_at: src_peak[k].at,
        })
        .collect();
    let faults_out: Vec<EmtFaultTrace> = faults
        .iter()
        .zip(flt_i)
        .enumerate()
        .filter(|(k, _)| flt_on[*k].is_some())
        .map(|(k, (f, i))| EmtFaultTrace {
            target: f.target.clone(),
            fault: f.fault,
            t_on: flt_on[k].unwrap_or(0.0),
            t_off: flt_off[k],
            i,
            peak: flt_peak[k].value,
            peak_at: flt_peak[k].at,
            rms: flt_last_rms[k],
        })
        .collect();
    if travelling + pi > 0 {
        notes.push(format!(
            "{travelling} line(s) as travelling waves and {pi} as π sections (a line whose travel time is below the time step is a π section)."
        ));
    }
    let highest = buses_out
        .iter()
        .max_by(|a, b| a.peak_pu.total_cmp(&b.peak_pu))
        .map(|b| format!(" Highest voltage {:.2} p.u. of crest at {}.", b.peak_pu, name_of(&b.id)))
        .unwrap_or_default();
    let fault_peak = faults_out
        .iter()
        .max_by(|a, b| a.peak.total_cmp(&b.peak))
        .map(|f| format!(" Peak fault current {:.2} kA at {}.", f.peak, name_of(&f.target)))
        .unwrap_or_default();
    let message = format!(
        "{:.3} s simulated in {steps} steps of {} µs.{highest}{fault_peak}",
        tr.time(),
        st.dt_us
    );
    Ok(EmtReport {
        t: t_rec,
        dt,
        steps,
        buses: buses_out,
        branches: branches_out,
        sources: sources_out,
        faults: faults_out,
        events,
        operations,
        travelling,
        pi,
        initial_mismatch,
        factorisations: tr.factorisations,
        notes,
        message,
    })
}

/// The parts of the network a recorder reads.
struct Parts<'a> {
    buses: &'a [network::BusNodes],
    branches: &'a [network::BranchEnds],
    sources: &'a [network::SourceNodes],
    faults: &'a [network::FaultSwitches],
    breakers: &'a [network::Breaker],
    sb: f64,
}

/// Phase-to-earth kV per p.u. at a bus of `kv`.
fn kv_phase(kv: f64) -> f64 {
    kv / 3.0_f64.sqrt()
}

/// Traces at the report's samples and statistics at every step.
struct Recorder {
    t: Vec<f32>,
    bus_v: Vec<Phases>,
    br_i: Vec<[Phases; 2]>,
    src_i: Vec<Phases>,
    flt_i: Vec<Phases>,
    bus_peak: Vec<Peak>,
    bus_rms: Vec<[Rms; 3]>,
    rms_lo: Vec<f64>,
    rms_hi: Vec<f64>,
    br_peak: Vec<Peak>,
    src_peak: Vec<Peak>,
    flt_peak: Vec<Peak>,
    flt_rms: Vec<[Rms; 3]>,
    flt_last_rms: Vec<Option<f64>>,
    flt_on: Vec<Option<f64>>,
    flt_off: Vec<Option<f64>>,
}

impl Recorder {
    fn new(p: &Parts, cycle: usize) -> Self {
        let rms3 = || [Rms::new(cycle), Rms::new(cycle), Rms::new(cycle)];
        Self {
            t: Vec::new(),
            bus_v: vec![Default::default(); p.buses.len()],
            br_i: vec![Default::default(); p.branches.len()],
            src_i: vec![Default::default(); p.sources.len()],
            flt_i: vec![Default::default(); p.faults.len()],
            bus_peak: vec![Peak::default(); p.buses.len()],
            bus_rms: p.buses.iter().map(|_| rms3()).collect(),
            rms_lo: vec![f64::INFINITY; p.buses.len()],
            rms_hi: vec![0.0; p.buses.len()],
            br_peak: vec![Peak::default(); p.branches.len()],
            src_peak: vec![Peak::default(); p.sources.len()],
            flt_peak: vec![Peak::default(); p.faults.len()],
            flt_rms: p.faults.iter().map(|_| rms3()).collect(),
            flt_last_rms: vec![None; p.faults.len()],
            flt_on: vec![None; p.faults.len()],
            flt_off: vec![None; p.faults.len()],
        }
    }

    /// Takes the statistics of the last point, and its values when `record`.
    fn observe(&mut self, tr: &Transient, p: &Parts, record: bool) {
        let (t, n) = (tr.time(), tr.steps());
        let ka = |kv: f64| p.sb / (3.0_f64.sqrt() * kv);
        if record {
            self.t.push(t as f32);
        }
        for (k, bus) in p.buses.iter().enumerate() {
            let scale = kv_phase(bus.kv);
            for ph in 0..3 {
                let v = tr.voltage(bus.nodes[ph]);
                self.bus_peak[k].see(v * scale, t);
                if let Some(r) = self.bus_rms[k][ph].push(n, v) {
                    self.rms_lo[k] = self.rms_lo[k].min(r);
                    self.rms_hi[k] = self.rms_hi[k].max(r);
                }
                if record {
                    self.bus_v[k][ph].push((v * scale) as f32);
                }
            }
        }
        for (k, br) in p.branches.iter().enumerate() {
            for end in 0..2 {
                let scale = ka(br.kv[end]);
                for ph in 0..3 {
                    let i = tr.switch_current(p.breakers[br.ends[end]].poles[ph]) * scale;
                    self.br_peak[k].see(i, t);
                    if record {
                        self.br_i[k][end][ph].push(i as f32);
                    }
                }
            }
        }
        for (k, s) in p.sources.iter().enumerate() {
            let scale = ka(s.kv);
            let i = match s.at {
                SourceAt::Breaker(b) => p.breakers[b].poles.map(|x| -tr.switch_current(x)),
                SourceAt::Injection(j) => tr.injection_current(j),
            };
            for (ph, x) in i.iter().enumerate() {
                self.src_peak[k].see(x * scale, t);
                if record {
                    self.src_i[k][ph].push((x * scale) as f32);
                }
            }
        }
        for (k, f) in p.faults.iter().enumerate() {
            let scale = ka(p.buses[f.bus].kv);
            let active = f.switches.iter().any(|&s| tr.is_closed(s));
            let mut largest: Option<f64> = None;
            for (ph, list) in f.phases.iter().enumerate() {
                let i = list.iter().map(|&(s, sign)| sign * tr.switch_current(s)).sum::<f64>() * scale;
                if active {
                    self.flt_peak[k].see(i, t);
                    if let Some(r) = self.flt_rms[k][ph].push(n, i) {
                        largest = Some(largest.map_or(r, |x: f64| x.max(r)));
                    }
                }
                if record {
                    self.flt_i[k][ph].push(i as f32);
                }
            }
            if largest.is_some() {
                self.flt_last_rms[k] = largest;
            }
        }
    }
}

/// Applies one event.
#[allow(clippy::too_many_arguments)]
fn apply(
    tr: &mut Transient,
    ev: &mut EmtAppliedEvent,
    k: usize,
    name: &str,
    faults: &[network::FaultSwitches],
    breakers: &[network::Breaker],
    targets: &std::collections::HashMap<String, Target>,
    instant: bool,
) {
    let e = &ev.event;
    match e.kind {
        EmtEventKind::Fault => {
            let Some(f) = faults.iter().find(|f| f.event == k) else {
                ev.note = format!("{name} is not an energised busbar.");
                return;
            };
            for &s in &f.switches {
                tr.close(s);
            }
            ev.applied = true;
            let what = match f.fault {
                EmtFault::ThreePhase => "Three-phase fault",
                EmtFault::LineToLine => "Line-to-line fault (phases b and c)",
                EmtFault::TwoPhaseEarth => "Two-phase-to-earth fault (phases b and c)",
                EmtFault::LineToEarth => "Line-to-earth fault (phase a)",
            };
            ev.note = match e.r.filter(|&r| r > 0.0) {
                Some(r) => format!("{what} at {name} through {r} Ω."),
                None => format!("{what} at {name}."),
            };
        }
        EmtEventKind::Clear => {
            let mut any = false;
            for f in faults.iter().filter(|f| f.target == e.target) {
                for &s in &f.switches {
                    if tr.is_closed(s) {
                        any = true;
                        if instant { tr.open(s) } else { tr.open_at_zero(s) }
                    }
                }
            }
            ev.applied = any;
            ev.note = if !any {
                format!("No fault at {name} to clear.")
            } else if instant {
                format!("Fault at {name} cleared.")
            } else {
                format!("Fault at {name} clearing: each phase goes out at its next current zero.")
            };
        }
        EmtEventKind::Trip | EmtEventKind::Close => {
            let out = e.kind == EmtEventKind::Trip;
            match targets.get(&e.target) {
                None => ev.note = format!("{name} has no breaker in the simulation."),
                Some(Target::Injection(j)) => {
                    tr.set_injection(*j, !out);
                    ev.applied = true;
                    ev.note = if out {
                        format!("{name} blocked: its converter stops injecting.")
                    } else {
                        format!("{name} injecting again.")
                    };
                }
                Some(Target::Breakers(list)) => {
                    let mut changed = false;
                    for &b in list {
                        for &s in &breakers[b].poles {
                            if out && tr.is_closed(s) && !tr.is_pending(s) {
                                changed = true;
                                if instant { tr.open(s) } else { tr.open_at_zero(s) }
                            } else if !out && !tr.is_closed(s) {
                                changed = true;
                                tr.close(s);
                            }
                        }
                    }
                    ev.applied = changed;
                    ev.note = match (out, changed, instant) {
                        (true, true, false) => {
                            format!("{name} tripped: each pole opens at its next current zero.")
                        }
                        (true, true, true) => format!("{name} switched out."),
                        (false, true, _) => format!("{name} switched in: all poles closed."),
                        (true, false, _) => format!("{name} is already out."),
                        (false, false, _) => format!("{name} is already in."),
                    };
                }
            }
        }
    }
}
