//! The bus-branch view of a model for formats without switches (PSS/E RAW, the editor's document): nodes joined by
//! closed switches form one bus; open switches are left out.

use std::collections::HashMap;

use ps_model::{Class, Model};
use ps_topology::{Outages, Topology};

/// Buses of the bus-branch view.
#[derive(Debug, Clone, Default)]
pub struct BusBranch {
    /// Bus of every node, `None` for removed nodes.
    pub bus_of: Vec<Option<usize>>,
    /// Nodes of every bus, in node order; buses are ordered by their first node.
    pub nodes: Vec<Vec<u32>>,
    /// Whether any node of the bus has supply.
    pub energised: Vec<bool>,
    /// Closed switches folded into buses.
    pub closed_switches: usize,
}

/// Groups the model's nodes into buses.
pub fn reduce(m: &Model) -> BusBranch {
    let mut parent: Vec<usize> = (0..m.nodes.len()).collect();
    fn root(parent: &mut [usize], mut x: usize) -> usize {
        while parent[x] != x {
            parent[x] = parent[parent[x]];
            x = parent[x];
        }
        x
    }
    let mut out = BusBranch {
        bus_of: vec![None; m.nodes.len()],
        ..Default::default()
    };
    for (k, s) in m.switches.iter().enumerate() {
        if !m.alive(Class::Switch, k) || s.open {
            continue;
        }
        out.closed_switches += 1;
        let (a, b) = (root(&mut parent, s.node1.index()), root(&mut parent, s.node2.index()));
        if a != b {
            parent[a.max(b)] = a.min(b);
        }
    }
    let topo = Topology::build(m, &Outages::none());
    let mut index: HashMap<usize, usize> = HashMap::new();
    for k in 0..m.nodes.len() {
        if !m.alive(Class::Node, k) {
            continue;
        }
        let r = root(&mut parent, k);
        let next = out.nodes.len();
        let b = *index.entry(r).or_insert(next);
        if b == next {
            out.nodes.push(Vec::new());
            out.energised.push(false);
        }
        out.bus_of[k] = Some(b);
        out.nodes[b].push(k as u32);
        if topo.node_bus.get(k).copied().flatten().is_some() {
            out.energised[b] = true;
        }
    }
    out
}
