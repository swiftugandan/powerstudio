//! The classical-model simulation.

use std::collections::HashSet;
use std::f64::consts::PI;

use ps_lf::Solution;
use ps_model::study::{EventKind, RmsSettings, SimEvent};
use ps_model::{Class, Model};
use ps_net::Calc;
use ps_num::{C64, DEG};
use ps_sparse::ComplexLu;
use serde::Serialize;

/// Admittance of a bolted fault, p.u.
const FAULT_Y: f64 = 1e6;

/// Traces of one machine or grid.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct MachineTrace {
    /// Element identifier.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Rotor angle against the reference, degrees.
    pub delta: Vec<f32>,
    /// Speed, Hz.
    pub speed: Vec<f32>,
    /// Electrical power, MW.
    pub pe: Vec<f32>,
}

/// An event and what became of it.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AppliedEvent {
    /// The event as given.
    #[serde(flatten)]
    pub event: SimEvent,
    /// Whether it changed the network.
    pub applied: bool,
    /// What it did, in plain words.
    pub note: String,
}

/// The simulation report.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RmsReport {
    /// Sample times, s.
    pub t: Vec<f32>,
    /// Machine and grid traces.
    pub machines: Vec<MachineTrace>,
    /// Bus identifiers, in bus order.
    pub bus_ids: Vec<String>,
    /// Voltage magnitude traces per bus, p.u.
    pub voltages: Vec<Vec<f32>>,
    /// Events in time order.
    pub events: Vec<AppliedEvent>,
    /// Whether every machine stayed in synchronism.
    pub stable: bool,
    /// When synchronism was lost, s.
    pub loss_of_synchronism: Option<f64>,
    /// `grid` when angles are measured against an external grid, `coi` for the centre of inertia.
    pub angle_reference: &'static str,
    /// Integration steps.
    pub steps: usize,
    /// Outcome in plain words.
    pub message: String,
}

struct Source {
    id: String,
    name: String,
    bus: usize,
    /// Internal admittance 1/(r + jx), p.u.
    y: C64,
    /// Internal voltage magnitude, p.u.
    e: f64,
    delta0: f64,
    pm: f64,
    h: f64,
    d: f64,
    grid: bool,
    on: bool,
}

/// A source from its load-flow operating point: E′ = V + Z·I with I = conj(S/V).
#[allow(clippy::too_many_arguments)]
fn source(id: String, name: String, bus: usize, z: C64, s: C64, v: C64, h: f64, d: f64, grid: bool) -> Source {
    let i = (s / v).conj();
    let e = v + z * i;
    Source {
        id,
        name,
        bus,
        y: z.inv(),
        e: e.abs(),
        delta0: e.arg(),
        pm: s.re,
        h,
        d,
        grid,
        on: true,
    }
}

struct LoadY {
    bus: usize,
    y: C64,
    scale: f64,
}

/// The network side of the simulation: sources, loads, switching state and the factorised admittance matrix.
struct Network<'a> {
    model: &'a Model,
    calc: &'a Calc,
    index: ps_model::IdIndex,
    branch_ids: Vec<&'a str>,
    src: Vec<Source>,
    loads: Vec<(String, LoadY)>,
    outaged: HashSet<String>,
    faults: Vec<usize>,
    lu: Option<ComplexLu>,
}

impl Network<'_> {
    fn refactor(&mut self) -> Result<(), String> {
        let net = &self.calc.net;
        let n = net.buses.len();
        let mut e: Vec<(usize, usize, C64)> = Vec::with_capacity(4 * net.branches.len() + n);
        for (k, br) in net.branches.iter().enumerate() {
            if !self.outaged.contains(self.branch_ids[k]) {
                e.extend([
                    (br.f, br.f, br.yff),
                    (br.f, br.t, br.yft),
                    (br.t, br.f, br.ytf),
                    (br.t, br.t, br.ytt),
                ]);
            }
        }
        e.extend(net.shunts.iter().map(|s| (s.bus, s.bus, s.y)));
        e.extend(
            self.loads
                .iter()
                .filter(|(id, _)| !self.outaged.contains(id))
                .map(|(_, l)| (l.bus, l.bus, l.y.scale(l.scale))),
        );
        e.extend(self.src.iter().filter(|s| s.on).map(|s| (s.bus, s.bus, s.y)));
        e.extend(self.faults.iter().map(|&b| (b, b, C64::new(0.0, -FAULT_Y))));
        self.lu = Some(
            ComplexLu::factor(n, &e).map_err(|err| format!("The network matrix could not be factorised: {err}."))?,
        );
        Ok(())
    }

    /// Network voltages and the electrical power of each source for given rotor angles.
    fn solve(&mut self, delta: &[f64]) -> Result<(Vec<C64>, Vec<f64>), String> {
        let n = self.calc.net.buses.len();
        let mut inj = vec![C64::ZERO; n];
        for (k, s) in self.src.iter().enumerate().filter(|(_, s)| s.on) {
            inj[s.bus] += s.y * C64::from_polar(s.e, delta[k]);
        }
        let lu = self.lu.as_mut().ok_or("The network matrix is not factorised.")?;
        let v = lu
            .solve(&inj)
            .map_err(|e| format!("The network solution failed: {e}."))?;
        let pe = self
            .src
            .iter()
            .enumerate()
            .map(|(k, s)| {
                if !s.on {
                    return 0.0;
                }
                let e = C64::from_polar(s.e, delta[k]);
                (e * (s.y * (e - v[s.bus])).conj()).re
            })
            .collect();
        Ok((v, pe))
    }

    /// Swing equation right-hand sides: dδ/dt = ωb(ω − 1), dω/dt = (Pm − Pe − D(ω − 1)) / 2H.
    fn deriv(&mut self, delta: &[f64], w: &[f64], wb: f64) -> Result<(Vec<f64>, Vec<f64>), String> {
        let (_, pe) = self.solve(delta)?;
        let m = self.src.len();
        let (mut dd, mut dw) = (vec![0.0; m], vec![0.0; m]);
        for (k, s) in self.src.iter().enumerate() {
            if !s.grid && s.on {
                dd[k] = wb * (w[k] - 1.0);
                dw[k] = (s.pm - pe[k] - s.d * (w[k] - 1.0)) / (2.0 * s.h);
            }
        }
        Ok((dd, dw))
    }

    fn node_bus(&self, id: &str) -> Option<usize> {
        self.index
            .get(Class::Node, id)
            .and_then(|row| self.calc.topo.node_bus[row])
            .map(|b| b as usize)
    }

    fn name_of(&self, id: &str) -> String {
        Class::ALL
            .iter()
            .find_map(|&c| self.index.get(c, id).map(|row| self.model.name_of(c, row).to_string()))
            .unwrap_or_else(|| id.to_string())
    }

    /// Applies one event; returns whether the network changed.
    fn apply(&mut self, ev: &mut AppliedEvent) -> bool {
        let target = ev.event.target.clone();
        let name = self.name_of(&target);
        match ev.event.kind {
            EventKind::Fault => match self.node_bus(&target) {
                Some(b) => {
                    if !self.faults.contains(&b) {
                        self.faults.push(b);
                    }
                    ev.applied = true;
                    ev.note = format!("Three-phase fault at {name}.");
                }
                None => ev.note = format!("{name} is not an energised busbar."),
            },
            EventKind::Clear => match self.node_bus(&target).filter(|b| self.faults.contains(b)) {
                Some(b) => {
                    self.faults.retain(|&x| x != b);
                    ev.applied = true;
                    ev.note = format!("Fault at {name} cleared.");
                }
                None => ev.note = format!("No fault at {name} to clear."),
            },
            EventKind::Trip => {
                if let Some(s) = self.src.iter_mut().find(|s| s.id == target) {
                    s.on = false;
                    ev.applied = true;
                    ev.note = format!("{name} tripped.");
                } else if self.branch_ids.contains(&target.as_str()) || self.loads.iter().any(|(id, _)| *id == target) {
                    self.outaged.insert(target);
                    ev.applied = true;
                    ev.note = format!("{name} switched out.");
                } else {
                    ev.note = format!("{name} is not in service.");
                }
            }
            EventKind::Loadstep => match self.loads.iter_mut().find(|(id, _)| *id == target) {
                Some((_, l)) => {
                    l.scale = ev.event.value.unwrap_or(100.0) / 100.0;
                    ev.applied = true;
                    ev.note = format!("{name} set to {:.0} % of its initial power.", l.scale * 100.0);
                }
                None => ev.note = format!("{name} is not a load in service."),
            },
        }
        ev.applied
    }
}

/// Stored samples.
struct Recorder {
    t: Vec<f32>,
    delta: Vec<Vec<f32>>,
    speed: Vec<Vec<f32>>,
    pe: Vec<Vec<f32>>,
    v: Vec<Vec<f32>>,
}

/// Simulates the settings' events from a solved load flow of `calc`. `max_samples` bounds the stored samples;
/// `progress` receives (simulated time, end time).
pub fn simulate(
    model: &Model,
    calc: &Calc,
    lf: &Solution,
    st: &RmsSettings,
    max_samples: usize,
    progress: &mut dyn FnMut(f64, f64),
) -> Result<RmsReport, String> {
    let net = &calc.net;
    let n = net.buses.len();
    let sb = net.base_mva;
    let f = model.meta.frequency_hz;
    let wb = 2.0 * PI * f;
    let (t_end, dt) = (st.t_end, st.dt);
    if !(dt > 0.0 && t_end > 0.0) {
        return Err("The simulation time and step size must be above zero.".into());
    }
    let v0: Vec<C64> = (0..n).map(|i| C64::from_polar(lf.vm[i], lf.va[i])).collect();

    // Sources: machines with inertia, then grids without.
    let mut src: Vec<Source> = Vec::new();
    for u in &lf.machines {
        let row = calc.machines[u.id] as usize;
        let g = &model.generators[row];
        let bus = net.machines[u.id].bus;
        let x = g.dynamics.xdt * (sb / g.rated_mva) * (g.rated_kv / net.buses[bus].base_kv).powi(2);
        let (h, d) = (g.dynamics.h * g.rated_mva / sb, g.dynamics.d * g.rated_mva / sb);
        let name = model.name_of(Class::Generator, row).to_string();
        src.push(source(
            g.id.clone(),
            name,
            bus,
            C64::new(0.0, x),
            C64::new(u.p, u.q),
            v0[bus],
            h,
            d,
            false,
        ));
    }
    for u in &lf.grids {
        let row = calc.grids[u.id] as usize;
        let g = &model.external_grids[row];
        let bus = net.grids[u.id].bus;
        let x = (sb / g.sk_max) / (1.0 + g.rx_max * g.rx_max).sqrt();
        let name = model.name_of(Class::ExternalGrid, row).to_string();
        src.push(source(
            g.id.clone(),
            name,
            bus,
            C64::new(g.rx_max * x, x),
            C64::new(u.p, u.q),
            v0[bus],
            f64::INFINITY,
            0.0,
            true,
        ));
    }
    if !src.iter().any(|s| !s.grid) {
        return Err("The network has no synchronous machine to simulate.".into());
    }
    // Loads become constant admittances at their initial voltage: y = (P − jQ)/|V|².
    let loads = net
        .loads
        .iter()
        .map(|l| {
            let v2 = v0[l.bus].norm_sqr();
            (
                model.loads[calc.loads[l.id] as usize].id.clone(),
                LoadY {
                    bus: l.bus,
                    y: C64::new(l.p / v2, -l.q / v2),
                    scale: 1.0,
                },
            )
        })
        .collect();
    let mut nw = Network {
        model,
        calc,
        index: model.index(),
        branch_ids: calc
            .branches
            .iter()
            .map(|b| model.id_of(b.class, b.row as usize).unwrap_or(""))
            .collect(),
        src,
        loads,
        outaged: HashSet::new(),
        faults: Vec::new(),
        lu: None,
    };
    nw.refactor()?;

    let m = nw.src.len();
    let mut delta: Vec<f64> = nw.src.iter().map(|s| s.delta0).collect();
    let mut w = vec![1.0; m];
    let mut events: Vec<AppliedEvent> = st
        .events
        .iter()
        .map(|e| AppliedEvent {
            event: e.clone(),
            applied: false,
            note: String::new(),
        })
        .collect();
    events.sort_by(|a, b| a.event.t.partial_cmp(&b.event.t).unwrap_or(std::cmp::Ordering::Equal));
    let mut next = 0;
    let due =
        |events: &[AppliedEvent], next: usize, t: f64| next < events.len() && events[next].event.t <= t + dt * 1e-6;
    let steps = (t_end / dt - 1e-9).ceil().max(0.0) as usize;
    let stride = (steps + 1 + 2 * events.len()).div_ceil(max_samples.max(1)).max(1);
    let has_grid = nw.src.iter().any(|s| s.grid);
    let nominal = ps_lf::nominal_angles(net, &vec![0.0; n]);
    let mut rec = Recorder {
        t: Vec::new(),
        delta: vec![Vec::new(); m],
        speed: vec![Vec::new(); m],
        pe: vec![Vec::new(); m],
        v: vec![Vec::new(); n],
    };
    let record = |nw: &mut Network, rec: &mut Recorder, delta: &[f64], w: &[f64], t: f64| -> Result<(), String> {
        let (v, pe) = nw.solve(delta)?;
        // Angles read against the grid when there is one, otherwise against the centre of inertia.
        let mut reference = 0.0;
        if !has_grid {
            let on = nw.src.iter().enumerate().filter(|(_, s)| s.on);
            let (sum, hs) = on.fold((0.0, 0.0), |(sum, hs), (k, s)| {
                (sum + s.h * (delta[k] - nominal[s.bus]), hs + s.h)
            });
            reference = if hs > 0.0 { sum / hs } else { 0.0 };
        }
        rec.t.push(t as f32);
        for (k, s) in nw.src.iter().enumerate() {
            rec.delta[k].push(((delta[k] - nominal[s.bus] - reference) * DEG) as f32);
            rec.speed[k].push((w[k] * f) as f32);
            rec.pe[k].push((pe[k] * sb) as f32);
        }
        for (i, vi) in v.iter().enumerate() {
            rec.v[i].push(vi.abs() as f32);
        }
        Ok(())
    };
    let apply_due = |nw: &mut Network, events: &mut [AppliedEvent], next: &mut usize, t: f64| -> Result<bool, String> {
        let mut changed = false;
        while due(events, *next, t) {
            changed |= nw.apply(&mut events[*next]);
            *next += 1;
        }
        if changed {
            nw.refactor()?;
        }
        Ok(changed)
    };

    apply_due(&mut nw, &mut events, &mut next, 0.0)?;
    record(&mut nw, &mut rec, &delta, &w, 0.0)?;
    let mut t = 0.0;
    let mut loss_of_synchronism = None;
    let axpy = |a: &[f64], b: &[f64], k: f64| -> Vec<f64> { a.iter().zip(b).map(|(x, y)| x + k * y).collect() };
    for s in 0..steps {
        let h = dt.min(t_end - t);
        let (k1d, k1w) = nw.deriv(&delta, &w, wb)?;
        let (k2d, k2w) = nw.deriv(&axpy(&delta, &k1d, h / 2.0), &axpy(&w, &k1w, h / 2.0), wb)?;
        let (k3d, k3w) = nw.deriv(&axpy(&delta, &k2d, h / 2.0), &axpy(&w, &k2w, h / 2.0), wb)?;
        let (k4d, k4w) = nw.deriv(&axpy(&delta, &k3d, h), &axpy(&w, &k3w, h), wb)?;
        for i in 0..m {
            delta[i] += h / 6.0 * (k1d[i] + 2.0 * k2d[i] + 2.0 * k3d[i] + k4d[i]);
            w[i] += h / 6.0 * (k1w[i] + 2.0 * k2w[i] + 2.0 * k3w[i] + k4w[i]);
        }
        t = ((s + 1) as f64 * dt).min(t_end);
        if due(&events, next, t) {
            record(&mut nw, &mut rec, &delta, &w, t)?; // the value just before the event
        }
        let changed = apply_due(&mut nw, &mut events, &mut next, t)?;
        if changed || (s + 1) % stride == 0 || s + 1 == steps {
            record(&mut nw, &mut rec, &delta, &w, t)?;
        }
        if loss_of_synchronism.is_none() && separation(&nw.src, &delta, &nominal) > PI {
            loss_of_synchronism = Some(t);
        }
        if s & 255 == 0 {
            progress(t, t_end);
        }
    }
    progress(t, t_end);
    let machines = nw
        .src
        .iter()
        .zip(rec.delta.into_iter().zip(rec.speed).zip(rec.pe))
        .map(|(s, ((delta, speed), pe))| MachineTrace {
            id: s.id.clone(),
            name: s.name.clone(),
            delta,
            speed,
            pe,
        })
        .collect();
    Ok(RmsReport {
        t: rec.t,
        machines,
        bus_ids: (0..n).map(|b| calc.bus_id(model, b)).collect(),
        voltages: rec.v,
        events,
        stable: loss_of_synchronism.is_none(),
        loss_of_synchronism,
        angle_reference: if has_grid { "grid" } else { "coi" },
        steps,
        message: match loss_of_synchronism {
            None => "All machines stay in synchronism.".into(),
            Some(t) => format!("Loss of synchronism at {t:.3} s."),
        },
    })
}

/// Largest rotor angle difference between sources in service, grids included, net of transformer phase shifts.
fn separation(src: &[Source], delta: &[f64], nominal: &[f64]) -> f64 {
    let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
    for (k, s) in src.iter().enumerate().filter(|(_, s)| s.on) {
        let a = delta[k] - nominal[s.bus];
        lo = lo.min(a);
        hi = hi.max(a);
    }
    hi - lo
}
