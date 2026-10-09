//! A load flow's result in the terms exchange formats need: CGMES state variables.

use std::collections::HashMap;

use ps_io::cgmes_sv::State;
use ps_model::{Model, NodeRef};
use ps_net::Calc;

use crate::LoadFlowReport;

/// The solved state of `model` for CGMES SV: every node's voltage and the power flowing into each element from each
/// of its terminals, in load sign (MW and Mvar into the equipment).
pub fn sv_state(model: &Model, calc: &Calc, sol: &ps_lf::Solution, report: &LoadFlowReport) -> State {
    let node_v = (0..model.nodes.len())
        .map(|k| {
            calc.topo
                .bus_of(NodeRef(k as u32))
                .map(|b| (sol.vm[b], sol.va[b].to_degrees()))
        })
        .collect();
    let mut flows: HashMap<String, Vec<Option<(f64, f64)>>> = HashMap::new();
    for b in &report.branches {
        let ends = flows.entry(b.id.clone()).or_default();
        match b.winding {
            // A three-winding transformer: one row per winding, its from end at the winding's bus.
            Some(w) => {
                let k = usize::from(w) - 1;
                if ends.len() <= k {
                    ends.resize(k + 1, None);
                }
                ends[k] = Some((b.p_from, b.q_from));
            }
            None => *ends = vec![Some((b.p_from, b.q_from)), Some((b.p_to, b.q_to))],
        }
    }
    // Machines, grids and compensators report their output; SV wants the power into the equipment.
    for u in report.gens.iter().chain(&report.grids).chain(&report.svcs) {
        flows.insert(u.id.clone(), vec![Some((-u.p, -u.q))]);
    }
    for u in &report.loads {
        flows.insert(u.id.clone(), vec![Some((u.p, u.q))]);
    }
    // A shunt's report gives the power it consumes (P) and the reactive power it supplies (Q).
    for u in &report.shunts {
        flows.insert(u.id.clone(), vec![Some((u.p, -u.q))]);
    }
    let node_island = (0..model.nodes.len())
        .map(|k| calc.topo.bus_of(NodeRef(k as u32)).map(|b| calc.topo.buses[b].island))
        .collect();
    // Each island's angle reference: the bus of its reference machine or external grid.
    let mut island_reference = vec![None; calc.topo.islands as usize];
    let refs = calc
        .net
        .machines
        .iter()
        .filter(|g| g.mode == ps_lf::MachineMode::Reference)
        .map(|g| g.bus)
        .chain(calc.net.grids.iter().map(|g| g.bus));
    for b in refs {
        let bus = &calc.topo.buses[b];
        if let (Some(slot), Some(&node)) = (island_reference.get_mut(bus.island as usize), bus.nodes.first()) {
            slot.get_or_insert(node as usize);
        }
    }
    State {
        node_v,
        flows,
        node_island,
        island_reference,
    }
}
