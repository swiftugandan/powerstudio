//! Canonical model → PowerStudio document (the editor's format, `src/core/catalog.js`).
//!
//! The document is a bus-branch format with seven classes, so the conversion reduces what it cannot hold and says so:
//! nodes joined by closed switches become one busbar; a three-winding transformer becomes a star busbar with three
//! two-winding transformers; a transformer whose impedance has a negative part or no reactance, which the document's
//! uk and uR cannot express, gets a line from an intermediate busbar for that part; static var compensators
//! become machines without active power; switched shunts keep their present admittance.
//!
//! Electrical values come from the engine's own per-unit form of each element (`ps-net`), so what the document can
//! express it expresses exactly: a transformer's present ratio becomes its rated HV voltage, its impedance uk and uR on
//! its rating, and a line's shunt admittance that is not symmetric goes into shunt elements at its ends. The document
//! splits a transformer's magnetising admittance evenly between its windings; where the model's is not even, the
//! difference is small and counted in the notes. Whoever calls this measures how far the document's load flow is from
//! the model's (`ps-study`'s `exchange::editor_fidelity`).

use std::collections::{HashMap, HashSet};

use ps_model::{Class, MachineControl, Model, NodeRef, Transformer2, Winding};
use ps_net::{TransformerOptions, TransformerPu, line_pu, shunt_admittance, transformer2_pu, transformer3_winding_pu};
use ps_num::C64;
use serde_json::{Map, Value, json};

/// Vector groups the document accepts (`VECTOR_GROUPS` in `src/core/catalog.js`; a test keeps the two equal).
pub const VECTOR_GROUPS: [&str; 17] = [
    "YNyn0", "YNd1", "YNd5", "YNd11", "Dyn1", "Dyn5", "Dyn11", "Yd1", "Yd5", "Yd11", "Dy1", "Dy5", "Dy11", "Yy0",
    "YNy0", "Yyn0", "Dd0",
];

/// Where a busbar the conversion adds (no node stands for it) gets its starting voltage.
#[derive(Debug, Clone, PartialEq)]
pub enum Internal {
    /// The star point of three-winding transformer `row`.
    Star(usize),
    /// Behind an ideal transformer from busbar `bus`: that busbar's voltage over `ratio`, lagging by `shift` radians.
    Behind {
        /// The busbar on the other side of the ideal transformer.
        bus: String,
        /// Its ratio.
        ratio: f64,
        /// Its phase shift, radians.
        shift: f64,
    },
}

/// A converted model.
#[derive(Debug, Clone)]
pub struct Converted {
    /// The document, ready for the editor's import gate.
    pub doc: Value,
    /// The busbar standing for each node (`None` for removed nodes).
    pub bus_of_node: Vec<Option<String>>,
    /// Busbars the conversion added, and where their starting voltage comes from.
    pub internal: Vec<(String, Internal)>,
    /// What the conversion reduced or approximated, in plain words.
    pub notes: Vec<String>,
}

const DEG: f64 = 180.0 / std::f64::consts::PI;
/// Reactive limits beyond this are written as this: the document holds finite numbers.
const Q_LIMIT: f64 = 99_999.0;

struct Doc<'a> {
    m: &'a Model,
    sb: f64,
    elements: Vec<Value>,
    ids: HashSet<String>,
    /// Busbar id and base voltage of every bus-branch bus.
    buses: Vec<(String, f64)>,
    bus_of: Vec<Option<usize>>,
    counts: HashMap<&'static str, usize>,
    internal: Vec<(String, Internal)>,
    /// The element each two-winding transformer was written as, by the model's identifier.
    trafo_ids: HashMap<String, String>,
}

impl Doc<'_> {
    fn count(&mut self, what: &'static str) {
        *self.counts.entry(what).or_default() += 1;
    }

    /// A unique identifier, `wanted` when free.
    fn id(&mut self, wanted: &str) -> String {
        let base = if wanted.is_empty() {
            "E".to_string()
        } else {
            wanted.to_string()
        };
        let mut id = base.clone();
        let mut k = 2;
        while !self.ids.insert(id.clone()) {
            id = format!("{base}~{k}");
            k += 1;
        }
        id
    }

    fn bus(&self, node: NodeRef) -> Option<(String, f64)> {
        self.bus_of
            .get(node.index())
            .copied()
            .flatten()
            .map(|b| self.buses[b].clone())
    }

    fn push(&mut self, cls: &str, wanted: &str, name: &str, fields: Value) -> String {
        let id = self.id(wanted);
        let mut el = Map::new();
        el.insert("id".into(), json!(id));
        el.insert("cls".into(), json!(cls));
        el.insert("name".into(), json!(name));
        if let Value::Object(f) = fields {
            el.extend(f);
        }
        self.elements.push(Value::Object(el));
        id
    }

    /// A shunt element for an admittance in p.u. on the bus base at `bus` (base voltage `kv`).
    fn shunt(&mut self, wanted: &str, name: &str, bus: &str, kv: f64, y: C64, on: bool) {
        if y == C64::ZERO {
            return;
        }
        if y.re < 0.0 {
            self.count("shunt admittance(s) with negative conductance written without it (the editor's losses are not negative)");
        }
        self.push(
            "shunt",
            wanted,
            name,
            json!({ "bus": bus, "inService": on, "q": y.im * self.sb, "p": (y.re * self.sb).max(0.0), "vn": kv }),
        );
    }

    /// A transformer element from a branch's per-unit form (`TransformerData`): the LV rated voltage (the LV base
    /// when none is given), the present ratio in the rated HV voltage, the impedance as uk and uR on the rating and
    /// the zero-sequence one as uk0 and uR0, the magnetising admittance as iron losses and no-load current, or as
    /// shunt elements where those cannot express it. Keeping the rated voltages keeps uk as the nameplate gives it,
    /// which the short-circuit correction factors read.
    fn transformer(&mut self, wanted: &str, name: &str, d: TransformerData, extra: Value) -> Option<String> {
        let TransformerData {
            hv,
            lv,
            p,
            z0,
            rating,
            on,
            conns,
            lv_rated,
        } = d;
        let z0 = z0.filter(|z| *z != C64::ZERO).unwrap_or(p.z);
        if p.z.re < 0.0 || p.z.im <= 0.0 || z0.re < 0.0 || z0.im <= 0.0 {
            // Negative resistance or no positive reactance, as star equivalents and some grid data have, which uk and
            // uR cannot express: the transformer keeps the ratio, any positive resistance and a small reactance, and a
            // line from an intermediate busbar on the LV base carries the rest of the impedance, in both sequences.
            const X_HEAD: f64 = 1e-4;
            let mid = self.push(
                "bus",
                &format!("{wanted}.mid"),
                name,
                json!({ "vn": lv.1, "vmin": 0.5, "vmax": 1.5, "zone": "" }),
            );
            self.internal.push((
                mid.clone(),
                Internal::Behind {
                    bus: hv.0.to_string(),
                    ratio: p.ratio,
                    shift: p.shift,
                },
            ));
            let (head, head0) = (C64::new(p.z.re.max(0.0), X_HEAD), C64::new(z0.re.max(0.0), X_HEAD));
            let id = self.transformer(
                wanted,
                name,
                TransformerData {
                    lv: (&mid, lv.1),
                    p: TransformerPu {
                        z: head,
                        y_to: C64::ZERO,
                        ..p
                    },
                    z0: Some(head0),
                    ..d
                },
                extra,
            )?;
            let zb = lv.1 * lv.1 / self.sb;
            let ((r, x), (r0, x0)) = (
                ((p.z.re - head.re) * zb, (p.z.im - head.im) * zb),
                ((z0.re - head0.re) * zb, (z0.im - head0.im) * zb),
            );
            self.push(
                "line",
                &format!("{wanted}.z"),
                name,
                json!({
                    "from": mid, "to": lv.0, "inService": on, "length": 1, "parallel": 1, "r1": r, "x1": x, "b1": 0,
                    "ratedA": 0, "r0": r0, "x0": x0, "b0": 0,
                }),
            );
            self.shunt(&format!("{wanted}.y2"), name, lv.0, lv.1, p.y_to, on);
            self.count(
                "transformer(s) with negative resistance or no positive reactance written with a line for that part",
            );
            return Some(id);
        }
        let sn = if rating > 0.0 { rating } else { self.sb };
        // Both rated voltages scale with the LV one, so the ratio stays; per-unit values on the rating scale with
        // the square of it.
        let vn_lv = lv_rated.filter(|v| *v > 0.0 && v.is_finite()).unwrap_or(lv.1);
        let scale = vn_lv / lv.1;
        let (vn_hv, on_rating) = (p.ratio * hv.1 * scale, sn / self.sb / (scale * scale));
        let uk = p.z.abs() * on_rating * 100.0;
        let ur = p.z.re * on_rating * 100.0;
        let (uk0, ur0) = (z0.abs() * on_rating * 100.0, z0.re * on_rating * 100.0);
        // Magnetising admittance: the document draws it half at each winding or all at one (behind the ratio on the
        // HV side), from iron losses and no-load current, which cannot be capacitive or negative. Whatever that cannot
        // hold goes into shunt elements, which is exact (the HV one moves outside the ratio).
        let tiny = 1e-12 * (p.y_from.abs() + p.y_to.abs()).max(1e-300);
        let (placement, held, uneven) = if p.y_to.abs() <= tiny {
            ("hv", p.y_from, C64::ZERO)
        } else if p.y_from.abs() <= tiny {
            ("lv", p.y_to, C64::ZERO)
        } else if (p.y_from - p.y_to).abs() <= tiny {
            ("both", p.y_from + p.y_to, C64::ZERO)
        } else {
            ("hv", p.y_from, p.y_to)
        };
        let (held, rest_hv, rest_lv) = if held.re >= 0.0 && held.im <= 0.0 {
            (held, C64::ZERO, uneven)
        } else {
            (C64::ZERO, p.y_from, p.y_to)
        };
        if rest_hv != C64::ZERO || rest_lv != C64::ZERO {
            let ratio2 = p.ratio * p.ratio;
            self.shunt(
                &format!("{wanted}.y1"),
                name,
                hv.0,
                hv.1,
                rest_hv.scale(1.0 / ratio2),
                on,
            );
            self.shunt(&format!("{wanted}.y2"), name, lv.0, lv.1, rest_lv, on);
            self.count(
                "transformer admittance(s) that iron losses and no-load current cannot express written as shunts",
            );
        }
        let (g, b) = (
            held.re * self.sb / sn * scale * scale,
            held.im * self.sb / sn * scale * scale,
        );
        let (pfe, i0) = (g * sn * 1000.0, (g * g + b * b).sqrt() * 100.0);
        // The phase shift as a listed vector group where it is a whole clock number; otherwise a clock-0 group and
        // the rest as the additional shift.
        let shift = p.shift * DEG;
        let clock = (shift / 30.0).round();
        let whole = (shift - 30.0 * clock).abs() < 1e-9;
        let clock = (clock as i64).rem_euclid(12) as u8;
        // The connections decide the zero sequence, so they come first: a listed group with both connections at the
        // clock number, else at the nearest listed clock with the difference as additional shift (the total shift,
        // and so the load flow, is the same). Without a listed group for the connections, one with winding 1's, else
        // any, as before.
        let wrap = |deg: f64| (deg + 180.0).rem_euclid(360.0) - 180.0;
        let exact = conns.and_then(|(a, b)| group_of(a, b, clock)).filter(|_| whole);
        let nearest = conns.and_then(|(a, b)| {
            VECTOR_GROUPS
                .iter()
                .filter_map(|g| crate::powerstudio::vector_group(g).map(|v| (*g, v)))
                .filter(|(_, v)| v.0 == a && v.1 == b)
                .map(|(g, v)| (g, wrap(shift - 30.0 * f64::from(v.2))))
                .min_by(|x, y| x.1.abs().total_cmp(&y.1.abs()))
        });
        let listed = |c: u8| match conns {
            Some((a, _)) => first_winding_group(a, c).or_else(|| any_group(c)),
            None => any_group(c),
        };
        let (group, extra_shift) = match (exact, nearest) {
            (Some(g), _) => (g, 0.0),
            (None, Some((g, rest))) => (g, rest),
            (None, None) => match (whole, listed(clock)) {
                (true, Some(g)) => (g, 0.0),
                _ => (listed(0).unwrap_or("YNyn0"), wrap(shift)),
            },
        };
        let mut fields = json!({
            "hv": hv.0, "lv": lv.0, "inService": on, "sn": sn, "vnHV": vn_hv, "vnLV": vn_lv, "uk": uk, "ur": ur,
            "i0": i0, "pfe": pfe, "magnetising": placement, "vectorGroup": group, "shift": extra_shift, "uk0": uk0, "ur0": ur0,
            "tapStep": 0, "tapPos": 0, "tapNeutral": 0, "tapMin": 0, "tapMax": 0,
        });
        if let (Value::Object(f), Value::Object(e)) = (&mut fields, extra) {
            f.extend(e);
        }
        Some(self.push("trafo", wanted, name, fields))
    }
}

/// What a transformer element is written from: its busbars (identifier and base voltage), its per-unit form
/// between them, the zero-sequence series impedance in the same per unit where the model has one, its rating,
/// state, connections and LV rated voltage.
#[derive(Clone, Copy)]
struct TransformerData<'a> {
    hv: (&'a str, f64),
    lv: (&'a str, f64),
    p: TransformerPu,
    z0: Option<C64>,
    rating: f64,
    on: bool,
    conns: Option<(Winding, Winding)>,
    lv_rated: Option<f64>,
}

/// Converts a model into a PowerStudio document.
pub fn to_document(m: &Model) -> Converted {
    // Each area's zone: its name, or its identifier where the name is empty or shared with another area.
    let zones: Vec<String> = m
        .areas
        .iter()
        .map(|a| {
            let name = a.name.trim();
            let shared = m.areas.iter().filter(|b| b.name.trim() == name).count() > 1;
            if name.is_empty() || shared {
                a.id.clone()
            } else {
                name.to_string()
            }
        })
        .collect();
    let view = crate::busbranch::reduce(m);
    let mut d = Doc {
        m,
        sb: m.meta.base_mva,
        elements: Vec::new(),
        ids: HashSet::new(),
        buses: Vec::new(),
        bus_of: view.bus_of.clone(),
        counts: HashMap::new(),
        internal: Vec::new(),
        trafo_ids: HashMap::new(),
    };
    let mut notes = Vec::new();
    if !m.switches.is_empty() {
        notes.push(format!(
            "{} switch(es): {} closed ones joined their nodes into one busbar and open ones were left out; the editor has no switches yet.",
            m.switches.len(),
            view.closed_switches
        ));
    }
    let sane = |v: f64, d: f64| if v > 0.0 && v < 10.0 { v } else { d };
    for nodes in &view.nodes {
        let n = &m.nodes[nodes[0] as usize];
        // The busbar's name: a busbar section's, else any node's, else its voltage level's, else the node's id.
        let named = |k: &&u32| !m.nodes[**k as usize].name.is_empty();
        let section = nodes
            .iter()
            .filter(named)
            .find(|&&k| m.nodes[k as usize].kind == ps_model::NodeKind::BusbarSection);
        let name = match section.or_else(|| nodes.iter().find(named)) {
            Some(&k) => m.nodes[k as usize].name.clone(),
            None => n
                .voltage_level
                .and_then(|v| m.voltage_levels.get(v as usize))
                .filter(|v| !v.name.is_empty())
                .map_or(n.id.clone(), |v| v.name.clone()),
        };
        let zone = n.area.and_then(|a| zones.get(a as usize)).cloned().unwrap_or_default();
        let kv = if n.nominal_kv > 0.0 { n.nominal_kv } else { 1.0 };
        let id = d.push(
            "bus",
            &n.id,
            &name,
            json!({ "vn": kv, "vmin": sane(n.v_min, 0.95), "vmax": sane(n.v_max, 1.05), "zone": zone }),
        );
        d.buses.push((id, kv));
    }
    let bus_of_node: Vec<Option<String>> = view.bus_of.iter().map(|b| b.map(|b| d.buses[b].0.clone())).collect();
    lines(&mut d);
    transformers2(&mut d);
    transformers3(&mut d);
    injections(&mut d);
    let mut counted: Vec<(&&str, &usize)> = d.counts.iter().collect();
    counted.sort();
    notes.extend(counted.into_iter().map(|(what, k)| format!("{k} {what}.")));
    // Interchange targets of the areas that have a slack, by zone, for the study case.
    let targets: Vec<Value> = m
        .areas
        .iter()
        .zip(&zones)
        .filter(|(a, _)| a.control)
        .filter_map(|(a, zone)| {
            let slack = d.bus(a.slack?)?.0;
            Some(json!({ "zone": zone, "export": a.interchange_mw, "tolerance": a.tolerance_mw, "slack": slack }))
        })
        .collect();
    let mut doc = json!({
        "format": "powerstudio",
        "version": 1,
        "name": m.meta.name,
        "description": m.meta.description,
        "baseMVA": m.meta.base_mva,
        "frequency": m.meta.frequency_hz,
        "elements": d.elements,
    });
    if !targets.is_empty() {
        doc["study"]["loadflow"]["areas"] = Value::Array(targets);
    }
    Converted {
        doc,
        bus_of_node,
        internal: d.internal,
        notes,
    }
}

/// The admittance seen at one end of a branch whose other end is open: its own end shunt in parallel with the series
/// impedance and the open end's shunt, in p.u. on that end's base.
fn open_end_equivalent(p: &TransformerPu, open_end: u8) -> C64 {
    let through = |y_far: C64| {
        if y_far == C64::ZERO {
            C64::ZERO
        } else {
            (p.z + y_far.inv()).inv()
        }
    };
    if open_end == 2 {
        // Seen from end 1, behind the ideal transformer.
        (p.y_from + through(p.y_to)).scale(1.0 / (p.ratio * p.ratio))
    } else {
        p.y_to + through(p.y_from)
    }
}

fn rating_ka(limits: &[ps_model::CurrentLimit]) -> f64 {
    limits
        .iter()
        .filter(|l| l.end == 1 && l.duration_s.is_none())
        .map(|l| l.amps / 1000.0)
        .fold(0.0, f64::max)
}

fn lines(d: &mut Doc) {
    let m = d.m;
    for (k, l) in m.lines.iter().enumerate() {
        if !m.alive(Class::Line, k) {
            continue;
        }
        let (Some(a), Some(b)) = (d.bus(l.node1), d.bus(l.node2)) else {
            continue;
        };
        let p = line_pu(l, a.1, b.1, d.sb, ps_net::Seq::Positive);
        match l.open {
            [true, true] => {
                d.count("branch(es) open at both ends left out");
                continue;
            }
            [false, true] | [true, false] => {
                let (end, bus) = if l.open[1] { (2, &a) } else { (1, &b) };
                let y = open_end_equivalent(&p, end);
                d.shunt(&l.id, &l.name, &bus.0.clone(), bus.1, y, l.in_service);
                d.count("branch(es) open at one end written as the shunt they present at the other");
                continue;
            }
            _ => {}
        }
        if a.0 == b.0 {
            d.count("branch(es) whose ends fell on one busbar left out");
            continue;
        }
        if (a.1 - b.1).abs() > 1e-12 * a.1.max(b.1) {
            // Ends of different base voltage: a transformer at the ratio of the bases, as the per-unit data mean.
            let data = TransformerData {
                hv: (&a.0, a.1),
                lv: (&b.0, b.1),
                p,
                z0: Some(line_pu(l, a.1, b.1, d.sb, ps_net::Seq::Zero).z),
                rating: d.sb,
                on: l.in_service,
                conns: None,
                lv_rated: None,
            };
            if d.transformer(&l.id, &l.name, data, json!({})).is_none() {
                d.count("branch(es) between different voltages that could not be written left out");
            }
            continue;
        }
        // Charging split evenly where both ends carry it; the rest as shunts at the ends.
        let (y1, y2) = (C64::new(l.g1, l.b1), C64::new(l.g2, l.b2));
        let b_sym = if y1.im > 0.0 && y2.im > 0.0 {
            2.0 * y1.im.min(y2.im)
        } else {
            0.0
        };
        let zb = a.1 * a.1 / d.sb;
        let id = d.push(
            "line",
            &l.id,
            &l.name,
            json!({
                "from": a.0, "to": b.0, "inService": l.in_service, "length": 1, "parallel": 1,
                "r1": l.r, "x1": l.x, "b1": b_sym * 1e6, "ratedA": rating_ka(&l.limits),
                "r0": l.r0, "x0": if l.x0 > 0.0 { l.x0 } else { 3.0 * l.x.abs() }, "b0": l.b0.max(0.0) * 1e6,
            }),
        );
        let rest1 = C64::new(y1.re, y1.im - b_sym / 2.0).scale(zb);
        let rest2 = C64::new(y2.re, y2.im - b_sym / 2.0).scale(zb);
        if rest1 != C64::ZERO || rest2 != C64::ZERO {
            d.count("line(s) with uneven or lossy shunt admittance written with shunt elements at their ends");
        }
        d.shunt(&format!("{id}.y1"), &l.name, &a.0.clone(), a.1, rest1, l.in_service);
        d.shunt(&format!("{id}.y2"), &l.name, &b.0.clone(), b.1, rest2, l.in_service);
    }
}

/// Tap fields of a two-winding transformer with the present position as 0 (the present ratio is the rated HV voltage):
/// its range around it, its step and its control. The document holds one tap changer on the HV winding, so a changer
/// with a control is preferred; a table becomes the even step between its end positions (exact at the present
/// position), and a changer on the LV winding becomes the opposite step on the HV winding.
/// The tap changer a transformer's document carries (one per transformer): a phase changer when it regulates and no
/// ratio changer does, or has no ratio changer beside it; otherwise the ratio changer, a regulating one first. Its
/// position is the document's tap position 0.
pub fn written_tap(t: &Transformer2) -> Option<WrittenTap> {
    let (ratio, phase, phase_first) = tap_choice(t);
    if let (Some(p), true) = (phase, phase_first || ratio.is_none()) {
        return Some(WrittenTap {
            phase: true,
            end: p.end,
            position: p.position,
        });
    }
    ratio.map(|r| WrittenTap {
        phase: false,
        end: r.end,
        position: r.position,
    })
}

/// The tap changer [`written_tap`] picks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WrittenTap {
    /// A phase changer rather than a ratio changer.
    pub phase: bool,
    /// The winding it is on.
    pub end: u8,
    /// Its position in the model, which the document counts from.
    pub position: i32,
}

fn tap_choice(t: &Transformer2) -> (Option<&ps_model::RatioTap>, Option<&ps_model::PhaseTap>, bool) {
    let ratio = t
        .ratio_taps
        .iter()
        .filter(|r| r.high > r.low)
        .max_by_key(|r| r.control.is_some_and(|c| c.enabled));
    let phase = t.phase_tap.as_ref().filter(|p| p.high > p.low);
    let phase_first = phase.is_some_and(|p| p.control.is_some_and(|c| c.enabled))
        && !ratio.is_some_and(|r| r.control.is_some_and(|c| c.enabled));
    (ratio, phase, phase_first)
}

fn taps(d: &mut Doc, t: &Transformer2, lv: &str) -> Value {
    let (ratio, phase, phase_first) = tap_choice(t);
    let sign = |end: u8| if end == 2 { -1.0 } else { 1.0 };
    let span = |low: i32, high: i32, position: i32| json!({ "tapPos": 0, "tapNeutral": 0, "tapMin": low - position, "tapMax": high - position });
    if let (Some(p), true) = (phase, phase_first || ratio.is_none()) {
        let angle = |pos: i32| {
            p.table
                .iter()
                .find(|x| x.position == pos)
                .map_or(f64::from(pos - p.neutral) * p.step_deg, |x| x.angle_deg)
        };
        let step = (angle(p.high) - angle(p.low)) / f64::from(p.high - p.low) * sign(p.end);
        if !p.table.is_empty() {
            d.count("phase tap changer table(s) written as even steps (exact at the present position)");
        }
        let mut v = span(p.low, p.high, p.position);
        v["tapKind"] = json!("phase");
        v["phaseStep"] = json!(step);
        if let Some(c) = p.control.filter(|c| c.enabled) {
            v["tapControl"] = json!(true);
            v["pTarget"] = json!(c.target_mw);
            v["pBand"] = json!(c.deadband_mw.max(0.0));
        }
        return v;
    }
    let Some(r) = ratio else { return json!({}) };
    let factor = |pos: i32| {
        r.table
            .iter()
            .find(|x| x.position == pos)
            .map_or(1.0 + f64::from(pos - r.neutral) * r.step_pct / 100.0, |x| x.ratio)
    };
    let step = (factor(r.high) - factor(r.low)) / factor(r.position) / f64::from(r.high - r.low) * 100.0 * sign(r.end);
    if !r.table.is_empty() {
        d.count("tap changer table(s) written as even steps (exact at the present position)");
    }
    if r.end == 2 {
        d.count("tap changer(s) on the LV winding written as the opposite step on the HV winding");
    }
    let mut v = span(r.low, r.high, r.position);
    v["tapStep"] = json!(step);
    if let Some(c) = r.control.filter(|c| c.enabled) {
        let kv = d.m.nominal_kv(c.node);
        let bus = d.bus(c.node).map(|b| b.0).unwrap_or_default();
        v["tapControl"] = json!(true);
        v["ctrlBus"] = json!(if bus == lv { String::new() } else { bus });
        v["vTarget"] = json!(c.target_kv / kv);
        v["vBand"] = json!(c.deadband_kv / kv * 100.0);
    }
    v
}

/// Any listed vector group with this clock number.
fn any_group(clock: u8) -> Option<&'static str> {
    VECTOR_GROUPS
        .iter()
        .find(|g| crate::powerstudio::vector_group(g).is_some_and(|v| v.2 == clock))
        .copied()
}

/// The document's vector group for a transformer's windings and clock, when it lists one.
fn group_of(conn1: Winding, conn2: Winding, clock: u8) -> Option<&'static str> {
    VECTOR_GROUPS
        .iter()
        .find(|g| crate::powerstudio::vector_group(g) == Some((conn1, conn2, clock)))
        .copied()
}

/// The document's first vector group with winding 1's connection and the clock, when it lists one.
fn first_winding_group(conn1: Winding, clock: u8) -> Option<&'static str> {
    VECTOR_GROUPS
        .iter()
        .find(|g| crate::powerstudio::vector_group(g).is_some_and(|v| v.0 == conn1 && v.2 == clock))
        .copied()
}

fn transformers2(d: &mut Doc) {
    let m = d.m;
    for (k, t) in m.transformers2.iter().enumerate() {
        if !m.alive(Class::Transformer2, k) {
            continue;
        }
        let (Some(a), Some(b)) = (d.bus(t.node1), d.bus(t.node2)) else {
            continue;
        };
        let p = transformer2_pu(t, a.1, b.1, d.sb, TransformerOptions::default());
        if t.open[0] || t.open[1] {
            if t.open[0] && t.open[1] {
                d.count("branch(es) open at both ends left out");
                continue;
            }
            let (end, bus) = if t.open[1] { (2, &a) } else { (1, &b) };
            let y = open_end_equivalent(&p, end);
            d.shunt(&t.id, &t.name, &bus.0.clone(), bus.1, y, t.in_service);
            d.count("branch(es) open at one end written as the shunt they present at the other");
            continue;
        }
        if a.0 == b.0 {
            d.count("branch(es) whose ends fell on one busbar left out");
            continue;
        }
        let conns = Some((t.conn1, t.conn2));
        let mut extra = taps(d, t, &b.0);
        if t.unrated {
            // The rated power stands in for a missing rating: the editor's transformer reports no loading.
            match &mut extra {
                Value::Object(o) => {
                    o.insert("thermal".into(), Value::Bool(false));
                }
                other => *other = json!({ "thermal": false }),
            }
        }
        if let Value::Object(o) = &mut extra {
            o.insert("onLoadTaps".into(), Value::Bool(t.on_load_taps));
            o.insert("tapRange".into(), json!(t.tap_range_pct));
            for (key, v) in [
                ("rnHV", t.rn[0]),
                ("xnHV", t.xn[0]),
                ("rnLV", t.rn[1]),
                ("xnLV", t.xn[1]),
            ] {
                o.insert(key.into(), json!(v));
            }
        }
        let zero = TransformerOptions {
            seq: ps_net::Seq::Zero,
            ..Default::default()
        };
        let data = TransformerData {
            hv: (&a.0, a.1),
            lv: (&b.0, b.1),
            p,
            z0: Some(transformer2_pu(t, a.1, b.1, d.sb, zero).z),
            rating: t.rated_mva,
            on: t.in_service,
            conns,
            lv_rated: Some(t.rated_kv2),
        };
        let written = d.transformer(&t.id, &t.name, data, extra);
        match written {
            Some(id) => {
                d.trafo_ids.insert(t.id.clone(), id);
            }
            None => d.count("transformer(s) that could not be written left out"),
        }
    }
}

fn transformers3(d: &mut Doc) {
    let m = d.m;
    for (k, t) in m.transformers3.iter().enumerate() {
        if !m.alive(Class::Transformer3, k) {
            continue;
        }
        let ends: Option<Vec<(String, f64)>> = t.windings.iter().map(|w| d.bus(w.node)).collect();
        let Some(ends) = ends else { continue };
        let pus: Vec<TransformerPu> = (0..3).map(|w| transformer3_winding_pu(t, w, ends[w].1, d.sb)).collect();
        // The windings' zero-sequence impedances, through the same conversion.
        let mut zero = t.clone();
        for w in &mut zero.windings {
            (w.r, w.x) = w.zero_sequence();
        }
        let zs: Vec<C64> = (0..3)
            .map(|w| transformer3_winding_pu(&zero, w, ends[w].1, d.sb).z)
            .collect();
        let open: Vec<usize> = (0..3).filter(|&w| t.windings[w].open).collect();
        if !open.is_empty() {
            d.count("three-winding transformer(s) with an open winding written with that winding left out");
        }
        // A star busbar on winding 1's rated voltage, and one transformer per winding from its busbar to the star (a
        // winding with negative impedance gets a line for it, as any transformer does).
        let k1 = t.windings[0].rated_kv;
        let label = if t.name.is_empty() {
            t.id.clone()
        } else {
            t.name.clone()
        };
        let star = d.push(
            "bus",
            &format!("{}.star", t.id),
            &format!("{label} star"),
            json!({ "vn": k1, "vmin": 0.5, "vmax": 1.5, "zone": "" }),
        );
        d.internal.push((star.clone(), Internal::Star(k)));
        for w in (0..3).filter(|w| !open.contains(w)) {
            // The winding's own connection decides its zero sequence; the star side stands for the star point.
            let wd = &t.windings[w];
            let data = TransformerData {
                hv: (&ends[w].0, ends[w].1),
                lv: (&star, k1),
                p: pus[w],
                z0: Some(zs[w]),
                rating: wd.rated_mva,
                on: t.in_service,
                conns: Some((wd.conn, Winding::Yn)),
                lv_rated: None,
            };
            d.transformer(
                &format!("{}.w{}", t.id, w + 1),
                &t.name,
                data,
                json!({ "rnHV": wd.rn, "xnHV": wd.xn }),
            );
        }
        d.count("three-winding transformer(s) written as a star busbar with three two-winding transformers");
    }
}

fn injections(d: &mut Doc) {
    let m = d.m;
    let promoted: HashSet<u32> = ps_topology::Topology::build(m, &ps_topology::Outages::none())
        .promoted
        .into_iter()
        .collect();
    let clamp_q = |q: f64| q.clamp(-Q_LIMIT, Q_LIMIT);
    for (k, g) in m.generators.iter().enumerate() {
        if !m.alive(Class::Generator, k) {
            continue;
        }
        let Some(bus) = d.bus(g.node) else { continue };
        // A machine the topology chose as an island's reference stays its reference: the document does not carry the
        // priorities that chose it.
        let mode = match g.control {
            MachineControl::Reference => "Reference",
            _ if promoted.contains(&(k as u32)) => "Reference",
            MachineControl::Pv => "PV",
            MachineControl::Pq => "PQ",
        };
        let reg_bus = g
            .regulated_node
            .and_then(|r| d.bus(r))
            .map(|r| r.0)
            .filter(|r| *r != bus.0)
            .unwrap_or_default();
        let vset = g.v_set.clamp(0.5, 1.5);
        if vset != g.v_set && g.control != MachineControl::Pq {
            d.count("voltage set point(s) outside 0.5 to 1.5 p.u. limited to that range");
        }
        let positive = |x: f64, def: f64| if x > 0.0 && x.is_finite() { x } else { def };
        let mut fields = json!({
            "bus": bus.0, "inService": g.in_service, "mode": mode, "p": g.p, "q": g.q, "vset": vset, "angle": g.angle,
            "qmin": clamp_q(g.q_min), "qmax": clamp_q(g.q_max), "sn": positive(g.rated_mva, d.sb),
            "vn": positive(g.rated_kv, bus.1), "cosphi": g.sc.cos_phi.clamp(0.01, 1.0), "xdss": positive(g.sc.xdss, 0.2),
            "rs": g.sc.rs.max(0.0), "xdt": positive(g.dynamics.xdt, 0.3), "h": positive(g.dynamics.h, 4.0),
            "damping": g.dynamics.d.max(0.0), "regBus": reg_bus, "pmin": g.p_min, "pmax": g.p_max.max(0.0),
            "participation": g.participation.max(0.0), "pg": g.sc.pg,
            "unitTrafo": g.unit_transformer.as_ref().and_then(|t| d.trafo_ids.get(t)).cloned().unwrap_or_default(),
        });
        if let Some(f) = g.sc.feeder {
            fields["feeder"] = json!(true);
            fields["skMax"] = json!(f.sk_max);
            fields["skMin"] = json!(f.sk_min);
            fields["rxMax"] = json!(f.rx_max);
            fields["rxMin"] = json!(f.rx_min);
            fields["x0x1"] = json!(f.x0x1);
            fields["r0x0"] = json!(f.r0x0);
        }
        dynamics_fields(&g.dynamics, &mut fields);
        d.push("gen", &g.id, &g.name, fields);
    }
    for (k, c) in m.svcs.iter().enumerate() {
        if !m.alive(Class::Svc, k) {
            continue;
        }
        let Some(bus) = d.bus(c.node) else { continue };
        let kv2 = bus.1 * bus.1;
        // A compensator holds its voltage within its susceptance range like a machine without active power; a very
        // large subtransient reactance keeps it out of short-circuit currents.
        d.push(
            "gen",
            &c.id,
            &c.name,
            json!({
                "bus": bus.0, "inService": c.in_service, "mode": if c.regulating { "PV" } else { "PQ" }, "p": 0, "q": c.q,
                "vset": c.v_set.clamp(0.5, 1.5), "angle": 0, "qmin": clamp_q(c.b_min * kv2), "qmax": clamp_q(c.b_max * kv2),
                "sn": d.sb, "vn": bus.1, "cosphi": 0.85, "xdss": 1e6, "rs": 0, "xdt": 1e6, "h": 0.01, "damping": 0,
            }),
        );
        d.count("static var compensator(s) written as machines without active power");
    }
    // HVDC links run at their setpoints, so each station is a fixed injection: a line-commutated one a load, a
    // voltage-source one a machine without short-circuit contribution.
    for (k, h) in m.hvdc_lines.iter().enumerate() {
        if !m.alive(Class::Hvdc, k) {
            continue;
        }
        let station = |id: &str| m.converters.iter().position(|c| c.id == id);
        let (Some(c1), Some(c2)) = (station(&h.converter1), station(&h.converter2)) else {
            continue;
        };
        let on = h.in_service && m.converters[c1].in_service && m.converters[c2].in_service;
        let powers = ps_net::hvdc_powers(m, h, c1, c2);
        for (c, p) in [(c1, powers[0]), (c2, powers[1])] {
            let st = &m.converters[c];
            let Some(bus) = d.bus(st.node) else { continue };
            let _ = match st.kind {
                ps_model::ConverterKind::Lcc => d.push(
                    "load",
                    &st.id,
                    &st.name,
                    json!({ "bus": bus.0, "inService": on, "p": -p, "q": ps_net::lcc_q(p, st.power_factor) }),
                ),
                ps_model::ConverterKind::Vsc => d.push(
                    "gen",
                    &st.id,
                    &st.name,
                    json!({
                        "bus": bus.0, "inService": on, "mode": if st.voltage_control { "PV" } else { "PQ" }, "p": p,
                        "q": st.q, "vset": st.v_set.clamp(0.5, 1.5), "angle": 0, "qmin": clamp_q(st.q_min),
                        "qmax": clamp_q(st.q_max), "sn": d.sb, "vn": bus.1, "cosphi": 0.85, "xdss": 1e6, "rs": 0,
                        "xdt": 1e6, "h": 0.01, "damping": 0,
                    }),
                ),
            };
        }
        d.count("HVDC link(s) written as the fixed injections of their converter stations");
    }
    for (k, x) in m.external_grids.iter().enumerate() {
        if !m.alive(Class::ExternalGrid, k) {
            continue;
        }
        let Some(bus) = d.bus(x.node) else { continue };
        d.push(
            "extgrid",
            &x.id,
            &x.name,
            json!({
                "bus": bus.0, "inService": x.in_service, "vset": x.v_set.clamp(0.5, 1.5), "angle": x.angle,
                "skMax": x.sk_max, "skMin": x.sk_min, "rxMax": x.rx_max, "rxMin": x.rx_min, "x0x1": x.x0x1, "r0x0": x.r0x0,
            }),
        );
    }
    for (k, l) in m.loads.iter().enumerate() {
        if !m.alive(Class::Load, k) {
            continue;
        }
        let Some(bus) = d.bus(l.node) else { continue };
        let pct = |x: f64| x * 100.0;
        let mut fields = json!({
            "bus": bus.0, "inService": l.in_service, "p": l.p, "q": l.q, "pZ": pct(l.p_zip[0]), "pI": pct(l.p_zip[1]),
            "qZ": pct(l.q_zip[0]), "qI": pct(l.q_zip[1]),
        });
        if let Some(mo) = l.motor {
            fields["motor"] = json!(true);
            fields["motorP"] = json!(mo.rated_mw);
            fields["motorVn"] = json!(mo.rated_kv);
            fields["motorEff"] = json!(mo.efficiency * 100.0);
            fields["motorCosphi"] = json!(mo.cos_phi);
            fields["motorIlr"] = json!(mo.ilr);
            fields["motorRx"] = json!(mo.rx);
            fields["motorPoles"] = json!(mo.pole_pairs);
        }
        d.push("load", &l.id, &l.name, fields);
    }
    for (k, s) in m.shunts.iter().enumerate() {
        if !m.alive(Class::Shunt, k) {
            continue;
        }
        let Some(bus) = d.bus(s.node) else { continue };
        // A bank of equal sections keeps them and its control; an uneven bank keeps its present admittance.
        if s.points.is_empty() && s.g_per_section >= 0.0 && s.max_sections >= 1 {
            let kv = if s.nominal_kv > 0.0 { s.nominal_kv } else { bus.1 };
            let mut v = json!({
                "bus": bus.0, "inService": s.in_service, "vn": kv, "q": s.b_per_section * kv * kv,
                "p": s.g_per_section * kv * kv, "sections": s.sections, "maxSections": s.max_sections.max(s.sections),
            });
            if let Some(c) = s.control.filter(|c| c.enabled) {
                let ckv = d.m.nominal_kv(c.node);
                let reg = d.bus(c.node).map(|b| b.0).filter(|b| *b != bus.0).unwrap_or_default();
                v["vControl"] = json!(true);
                v["ctrlBus"] = json!(reg);
                v["vTarget"] = json!(c.target_kv / ckv);
                v["vBand"] = json!(c.deadband_kv / ckv * 100.0);
            }
            if s.b_per_section != 0.0 || s.g_per_section != 0.0 {
                d.push("shunt", &s.id, &s.name, v);
            }
            continue;
        }
        d.count("shunt(s) with uneven sections written at their present admittance, without their control");
        let y = shunt_admittance(s).scale(bus.1 * bus.1 / d.sb);
        d.shunt(&s.id, &s.name, &bus.0.clone(), bus.1, y, s.in_service);
    }
}

/// Adds a machine's rotor model with its round-rotor data, and its controls, to its document fields. A classical
/// machine without controls adds nothing, so documents of 0.1 machines stay as they were.
pub fn dynamics_fields(dy: &ps_model::MachineDynamics, fields: &mut serde_json::Value) {
    let Some(obj) = fields.as_object_mut() else {
        return;
    };
    if dy.rotor_model == ps_model::RotorModel::RoundRotor {
        let r = &dy.rotor;
        obj.insert("machineModel".into(), json!("roundRotor"));
        for (k, v) in [
            ("xd", r.xd),
            ("xq", r.xq),
            ("xqt", r.xqt),
            ("xl", r.xl),
            ("td0t", r.td0t),
            ("td0s", r.td0s),
            ("tq0t", r.tq0t),
            ("tq0s", r.tq0s),
            ("s10", r.s10),
            ("s12", r.s12),
        ] {
            obj.insert(k.into(), json!(v));
        }
    }
    for (key, slot) in crate::powerstudio::CONTROL_KEYS {
        if let Some(c) = dy.controls.slot(slot) {
            let mut control = serde_json::Map::new();
            control.insert("model".into(), json!(c.kind.name()));
            for (p, v) in c.kind.params().iter().zip(&c.values) {
                control.insert((*p).into(), json!(v));
            }
            obj.insert(key.into(), serde_json::Value::Object(control));
        }
    }
}
