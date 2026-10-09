//! MATPOWER case → canonical model.
//!
//! MATPOWER stores per-unit values on the system base; the model stores engineering values. The conversion is exact
//! for everything MATPOWER describes, so a load flow of the model reproduces MATPOWER's own:
//!
//! - A branch with no off-nominal ratio, no phase shift and equal base voltages at both ends becomes a line with its
//!   total impedance in Ω and its charging in S.
//! - Any other branch becomes a two-winding transformer whose winding-1 rated voltage carries the off-nominal ratio,
//!   whose phase shift is kept as a fixed shift, and whose line charging becomes the magnetising admittance split
//!   half to each end (MATPOWER puts the from half behind the tap, as the model does).
//! - Generators on the reference bus become reference machines; a reference bus with no generator gets an external
//!   grid.
//!
//! MATPOWER has no zero-sequence, short-circuit or dynamic data. Those fields get stated typical values, listed in the
//! issues the import returns.

use ps_model::{
    Area, CurrentLimit, ExternalGrid, Generator, Line, Load, MachineControl, MachineDynamics, MachineShortCircuit,
    Model, Node, NodeKind, NodeRef, Shunt, Transformer2, Winding,
};
use std::collections::HashMap;

use crate::matpower::{MatpowerCase, branch, bus, generator as gen_col};

/// A converted model and what the conversion assumed or skipped.
#[derive(Debug, Clone)]
pub struct Imported {
    /// The model.
    pub model: Model,
    /// Assumptions and skipped rows, in plain words.
    pub issues: Vec<String>,
}

/// Converts a parsed MATPOWER case.
pub fn to_model(case: &MatpowerCase) -> Imported {
    let sb = case.base_mva;
    let mut m = Model::new(case.name.clone());
    m.meta.base_mva = sb;
    m.meta.description = format!("Imported from MATPOWER case {}.", case.name);
    let mut issues = Vec::new();
    let mut node_of: HashMap<i64, (u32, f64, i64)> = HashMap::with_capacity(case.bus.len());
    let mut areas: HashMap<i64, u32> = HashMap::new();
    let mut zero_kv = 0;
    for (k, r) in case.bus.iter().enumerate() {
        let num = r[bus::I] as i64;
        let kind = r[bus::TYPE] as i64;
        let kv = if r[bus::BASE_KV] > 0.0 {
            r[bus::BASE_KV]
        } else {
            zero_kv += 1;
            1.0
        };
        let area_num = r[bus::AREA] as i64;
        let area = *areas.entry(area_num).or_insert_with(|| {
            m.areas.push(Area {
                id: format!("A{area_num}"),
                name: format!("Area {area_num}"),
                ..Default::default()
            });
            (m.areas.len() - 1) as u32
        });
        let row = m.nodes.len() as u32;
        node_of.insert(num, (row, kv, kind));
        m.nodes.push(Node {
            id: format!("B{num}"),
            name: case.bus_names.get(k).cloned().unwrap_or_else(|| format!("Bus {num}")),
            kind: NodeKind::Bus,
            voltage_level: None,
            nominal_kv: kv,
            v_min: if r[bus::VMIN] > 0.0 { r[bus::VMIN] } else { 0.9 },
            v_max: if r[bus::VMAX] > 0.0 { r[bus::VMAX] } else { 1.1 },
            area: Some(area),
            v0: r[bus::VM],
            angle0: r[bus::VA],
        });
        let in_service = kind != 4;
        if r[bus::PD] != 0.0 || r[bus::QD] != 0.0 {
            m.loads.push(Load {
                id: format!("D{num}"),
                name: format!("Load {num}"),
                node: NodeRef(row),
                in_service,
                p: r[bus::PD],
                q: r[bus::QD],
                p_zip: [0.0, 0.0, 1.0],
                q_zip: [0.0, 0.0, 1.0],
            });
        }
        if r[bus::GS] != 0.0 || r[bus::BS] != 0.0 {
            // GS and BS are MW and Mvar at 1 p.u.; in siemens that is the value over kV².
            m.shunts.push(Shunt {
                id: format!("S{num}"),
                name: format!("Shunt {num}"),
                node: NodeRef(row),
                in_service,
                nominal_kv: kv,
                g_per_section: r[bus::GS] / (kv * kv),
                b_per_section: r[bus::BS] / (kv * kv),
                sections: 1,
                max_sections: 1,
                control: None,
                points: Vec::new(),
            });
        }
    }
    if zero_kv > 0 {
        issues.push(format!("{zero_kv} buses have no base voltage in the file and were given 1 kV, so per-unit values carry over unchanged."));
    }

    let mut has_ref: HashMap<i64, bool> = HashMap::new();
    let mut typical_machines = 0;
    for (k, r) in case.generators.iter().enumerate() {
        let num = r[gen_col::BUS] as i64;
        let Some(&(row, kv, kind)) = node_of.get(&num) else {
            issues.push(format!("Generator {} refers to missing bus {num}; skipped.", k + 1));
            continue;
        };
        let on = r[gen_col::STATUS] > 0.0;
        let reference = kind == 3 && on && !has_ref.get(&num).copied().unwrap_or(false);
        if reference {
            has_ref.insert(num, true);
        }
        let control = match kind {
            _ if reference => MachineControl::Reference,
            1 => MachineControl::Pq,
            _ => MachineControl::Pv,
        };
        typical_machines += 1;
        m.generators.push(Generator {
            id: format!("G{}", k + 1),
            name: format!("Gen {}", k + 1),
            node: NodeRef(row),
            in_service: on && kind != 4,
            control,
            p: r[gen_col::PG],
            q: r[gen_col::QG],
            v_set: r[gen_col::VG],
            regulated_node: None,
            angle: if reference { m.nodes[row as usize].angle0 } else { 0.0 },
            q_min: r[gen_col::QMIN],
            q_max: r[gen_col::QMAX],
            p_min: r[gen_col::PMIN],
            p_max: r[gen_col::PMAX],
            rated_mva: if r[gen_col::MBASE] > 0.0 { r[gen_col::MBASE] } else { sb },
            rated_kv: kv,
            participation: 0.0,
            reference_priority: 0,
            sc: TYPICAL_SC,
            dynamics: TYPICAL_DYNAMICS,
        });
    }
    if typical_machines > 0 {
        issues.push(format!(
            "MATPOWER has no machine impedances or inertia: all {typical_machines} generators use x″d = {}, R = {}, cos φ = {}, x′d = {}, H = {} s.",
            TYPICAL_SC.xdss, TYPICAL_SC.rs, TYPICAL_SC.cos_phi, TYPICAL_DYNAMICS.xdt, TYPICAL_DYNAMICS.h
        ));
    }
    for r in &case.bus {
        let num = r[bus::I] as i64;
        if r[bus::TYPE] as i64 == 3 && !has_ref.get(&num).copied().unwrap_or(false) {
            let Some(&(row, _, _)) = node_of.get(&num) else {
                continue;
            };
            issues.push(format!(
                "Reference bus {num} has no generator in service; an external grid holds its voltage."
            ));
            m.external_grids.push(ExternalGrid {
                id: format!("X{num}"),
                name: format!("Grid {num}"),
                node: NodeRef(row),
                in_service: true,
                v_set: r[bus::VM],
                angle: r[bus::VA],
                sk_max: 5000.0,
                sk_min: 4000.0,
                rx_max: 0.1,
                rx_min: 0.1,
                x0x1: 1.0,
                r0x0: 0.1,
            });
        }
    }

    // Branches are named by their row in the case, as MATPOWER identifies them: L17 or T17 for row 17.
    for (row, r) in case.branch.iter().enumerate() {
        let row = row + 1;
        let (fb, tb) = (r[branch::F_BUS] as i64, r[branch::T_BUS] as i64);
        let (Some(&(f, vf, _)), Some(&(t, vt, _))) = (node_of.get(&fb), node_of.get(&tb)) else {
            issues.push(format!("Branch {fb}-{tb} refers to a missing bus; skipped."));
            continue;
        };
        let (rr, xx, bb) = (r[branch::R], r[branch::X], r[branch::B]);
        let (ratio, shift) = (r[branch::RATIO], r[branch::ANGLE]);
        let rate = r[branch::RATE_A];
        let in_service = r[branch::STATUS] > 0.0;
        if (ratio == 0.0 || ratio == 1.0) && shift == 0.0 && vf == vt {
            let zb = vf * vf / sb;
            let limits = if rate > 0.0 {
                let amps = rate / (3.0_f64.sqrt() * vf) * 1000.0;
                vec![
                    CurrentLimit {
                        end: 1,
                        duration_s: None,
                        amps,
                    },
                    CurrentLimit {
                        end: 2,
                        duration_s: None,
                        amps,
                    },
                ]
            } else {
                Vec::new()
            };
            m.lines.push(Line {
                id: format!("L{row}"),
                name: format!("Line {fb}-{tb}"),
                node1: NodeRef(f),
                node2: NodeRef(t),
                in_service,
                open: [false; 2],
                r: rr * zb,
                x: xx * zb,
                g1: 0.0,
                b1: bb / zb / 2.0,
                g2: 0.0,
                b2: bb / zb / 2.0,
                r0: 3.0 * rr * zb,
                x0: 3.0 * xx * zb,
                b0: 0.6 * bb / zb,
                length_km: 0.0,
                limits,
            });
        } else {
            let tap = if ratio == 0.0 { 1.0 } else { ratio };
            let k1 = vf * tap;
            // Impedance in Ω referred to winding 1 (rated k1): p.u. on the system base times k1²/S.
            let z1 = k1 * k1 / sb;
            m.transformers2.push(Transformer2 {
                id: format!("T{row}"),
                name: format!("Transformer {fb}-{tb}"),
                node1: NodeRef(f),
                node2: NodeRef(t),
                in_service,
                open: [false; 2],
                rated_kv1: k1,
                rated_kv2: vt,
                rated_mva: if rate > 0.0 { rate } else { sb },
                r: rr * z1,
                x: xx * z1,
                g1: 0.0,
                b1: bb / 2.0 / z1,
                g2: 0.0,
                b2: bb / 2.0 / z1,
                clock: 0,
                phase_shift_deg: shift,
                conn1: Winding::Yn,
                conn2: Winding::Yn,
                r0: rr * z1,
                x0: xx * z1,
                ratio_taps: Vec::new(),
                phase_tap: None,
                limits: Vec::new(),
            });
        }
    }
    if !m.lines.is_empty() {
        issues.push(
            "MATPOWER has no zero-sequence data: lines use R0 = 3·R, X0 = 3·X, B0 = 0.6·B and transformers Z0 = Z."
                .into(),
        );
    }
    Imported { model: m, issues }
}

/// Typical short-circuit data for machines whose source gives none.
pub const TYPICAL_SC: MachineShortCircuit = MachineShortCircuit {
    xdss: 0.16,
    rs: 0.0024,
    cos_phi: 0.85,
    earthed: false,
};
/// Typical classical dynamic data for machines whose source gives none.
pub const TYPICAL_DYNAMICS: MachineDynamics = MachineDynamics {
    xdt: 0.25,
    h: 4.0,
    d: 0.0,
};
