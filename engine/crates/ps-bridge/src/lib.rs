//! Direct conversion of MATPOWER cases into the load flow's per-unit network, used by the solver benchmarks and the
//! oracle comparisons before the canonical model exists for them. It reproduces MATPOWER's own conventions exactly.

use ps_io::matpower::{MatpowerCase, branch, bus, generator as gen_col};
use ps_lf::{
    MachineMode, PuBranch, PuBus, PuGrid, PuLoad, PuMachine, PuNetwork, PuShunt, two_port,
};
use ps_num::{C64, DEG};

/// The per-unit network and, for each of its buses, the MATPOWER bus number.
#[derive(Debug, Clone)]
pub struct Converted {
    /// The network.
    pub net: PuNetwork,
    /// MATPOWER bus number of each calculation bus.
    pub bus_numbers: Vec<i64>,
}

/// Converts a MATPOWER case. Isolated buses (type 4) and out-of-service elements are left out.
pub fn from_matpower(case: &MatpowerCase) -> Converted {
    let sb = case.base_mva;
    let mut index = std::collections::HashMap::new();
    let mut buses = Vec::new();
    let mut numbers = Vec::new();
    let mut kinds = Vec::new();
    for row in &case.bus {
        if row[bus::TYPE] as i64 == 4 {
            continue;
        }
        index.insert(row[bus::I] as i64, buses.len());
        numbers.push(row[bus::I] as i64);
        kinds.push(row[bus::TYPE] as i64);
        let kv = if row[bus::BASE_KV] > 0.0 {
            row[bus::BASE_KV]
        } else {
            1.0
        };
        buses.push(PuBus {
            base_kv: kv,
            vm0: row[bus::VM],
            va0: row[bus::VA] / DEG,
        });
    }
    let mut net = PuNetwork {
        base_mva: sb,
        buses,
        ..Default::default()
    };
    for (k, row) in case.bus.iter().enumerate() {
        let Some(&b) = index.get(&(row[bus::I] as i64)) else {
            continue;
        };
        if row[bus::PD] != 0.0 || row[bus::QD] != 0.0 {
            net.loads.push(PuLoad {
                id: k,
                bus: b,
                p: row[bus::PD] / sb,
                q: row[bus::QD] / sb,
            });
        }
        if row[bus::GS] != 0.0 || row[bus::BS] != 0.0 {
            net.shunts.push(PuShunt {
                id: k,
                bus: b,
                y: C64::new(row[bus::GS] / sb, row[bus::BS] / sb),
            });
        }
    }
    let mut has_ref = vec![false; net.buses.len()];
    for (k, row) in case.generators.iter().enumerate() {
        if row[gen_col::STATUS] <= 0.0 {
            continue;
        }
        let Some(&b) = index.get(&(row[gen_col::BUS] as i64)) else {
            continue;
        };
        let mode = match kinds[b] {
            3 if !has_ref[b] => {
                has_ref[b] = true;
                MachineMode::Reference
            }
            1 => MachineMode::Pq,
            _ => MachineMode::Pv,
        };
        net.machines.push(PuMachine {
            id: k,
            bus: b,
            mode,
            p: row[gen_col::PG] / sb,
            q: row[gen_col::QG] / sb,
            v_set: row[gen_col::VG],
            angle: net.buses[b].va0,
            q_min: row[gen_col::QMIN] / sb,
            q_max: row[gen_col::QMAX] / sb,
        });
    }
    for b in 0..net.buses.len() {
        if kinds[b] == 3 && !has_ref[b] {
            net.grids.push(PuGrid {
                id: b,
                bus: b,
                v_set: net.buses[b].vm0,
                angle: net.buses[b].va0,
            });
        }
    }
    for (k, row) in case.branch.iter().enumerate() {
        if row[branch::STATUS] <= 0.0 {
            continue;
        }
        let (Some(&f), Some(&t)) = (
            index.get(&(row[branch::F_BUS] as i64)),
            index.get(&(row[branch::T_BUS] as i64)),
        ) else {
            continue;
        };
        let ratio = if row[branch::RATIO] == 0.0 {
            1.0
        } else {
            row[branch::RATIO]
        };
        let shift = row[branch::ANGLE] / DEG;
        let (yff, yft, ytf, ytt) = two_port(
            C64::new(row[branch::R], row[branch::X]),
            C64::new(0.0, row[branch::B]),
            ratio,
            shift,
        );
        net.branches.push(PuBranch {
            id: k,
            f,
            t,
            yff,
            yft,
            ytf,
            ytt,
            shift,
        });
    }
    Converted {
        net,
        bus_numbers: numbers,
    }
}
