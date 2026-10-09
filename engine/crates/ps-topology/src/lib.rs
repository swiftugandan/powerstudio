//! Topology processing: from equipment and switch states to the calculation buses the solvers work on.
//!
//! 1. Nodes joined by closed switches merge into one calculation bus (a union-find over switches).
//! 2. Every three-winding transformer in service adds a star-point bus.
//! 3. Branches in service join buses into islands through their connected ends. A branch open at one end gets a bus of
//!    its own there, so its charging still loads the end that is connected.
//! 4. An island is energised when it holds a source: an external grid or a reference machine. An island that has
//!    machines but no source takes the machine with the best reference priority, or else its largest machine (by
//!    rated power, with a warning). Other islands are de-energised and left out of the calculation.
//!
//! The result maps both ways: node to calculation bus, and calculation bus to its nodes, so results land back on
//! equipment. Outages for a single calculation (contingency cases) are applied through [`Outages`] without editing
//! the model.

use ps_model::{Class, MachineControl, Model};
use std::collections::HashSet;

/// Elements taken out of service for one calculation, on top of their own in-service flags.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Outages {
    set: HashSet<(Class, u32)>,
}

impl Outages {
    /// No outages.
    pub fn none() -> Self {
        Self::default()
    }

    /// Takes row `row` of a class out of service.
    pub fn insert(&mut self, class: Class, row: usize) {
        self.set.insert((class, row as u32));
    }

    /// Whether row `row` of a class is out.
    pub fn contains(&self, class: Class, row: usize) -> bool {
        self.set.contains(&(class, row as u32))
    }

    /// True when nothing is out.
    pub fn is_empty(&self) -> bool {
        self.set.is_empty()
    }
}

/// Whether an element takes part in calculations: it exists, is switched in, and is not outaged.
pub fn active(model: &Model, outages: &Outages, class: Class, row: usize) -> bool {
    if !model.alive(class, row) || outages.contains(class, row) {
        return false;
    }
    let in_service = match class {
        Class::Line => model.lines.get(row).map(|e| e.in_service),
        Class::Transformer2 => model.transformers2.get(row).map(|e| e.in_service),
        Class::Transformer3 => model.transformers3.get(row).map(|e| e.in_service),
        Class::Generator => model.generators.get(row).map(|e| e.in_service),
        Class::Load => model.loads.get(row).map(|e| e.in_service),
        Class::Shunt => model.shunts.get(row).map(|e| e.in_service),
        Class::Svc => model.svcs.get(row).map(|e| e.in_service),
        Class::ExternalGrid => model.external_grids.get(row).map(|e| e.in_service),
        Class::Converter => model.converters.get(row).map(|e| e.in_service),
        Class::Hvdc => model.hvdc_lines.get(row).map(|e| e.in_service),
        Class::Switch => model.switches.get(row).map(|e| !e.open),
        _ => Some(true),
    };
    in_service.unwrap_or(false)
}

/// A calculation bus.
#[derive(Debug, Clone, PartialEq)]
pub struct CalcBus {
    /// Nodes merged into the bus, in node order; empty for a transformer star point.
    pub nodes: Vec<u32>,
    /// The three-winding transformer whose star point this is, if it is one.
    pub star_of: Option<u32>,
    /// The branch end this bus stands for when that end is open: class, row and end (1 or 2).
    pub open_end_of: Option<(Class, u32, u8)>,
    /// Base voltage, kV: the first node's nominal voltage, or winding 1's rated voltage for a star point.
    pub base_kv: f64,
    /// Island number, counted over energised islands in bus order.
    pub island: u32,
}

/// The outcome of topology processing.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Topology {
    /// Energised calculation buses: node buses in order of their first node, then star points.
    pub buses: Vec<CalcBus>,
    /// Calculation bus of every node, `None` when the node is de-energised or deleted.
    pub node_bus: Vec<Option<u32>>,
    /// Star-point bus of every three-winding transformer, `None` when it is out of the calculation.
    pub star_bus: Vec<Option<u32>>,
    /// Buses standing for open branch ends, by (class, row, end).
    pub open_end_bus: Vec<((Class, u32, u8), u32)>,
    /// Alive nodes left without supply, in node order.
    pub deenergised: Vec<u32>,
    /// Generators made reference for an island that had none.
    pub promoted: Vec<u32>,
    /// Number of energised islands.
    pub islands: u32,
    /// What the processing had to decide, in plain words.
    pub warnings: Vec<String>,
}

struct UnionFind {
    parent: Vec<usize>,
}

impl UnionFind {
    fn new(n: usize) -> Self {
        Self {
            parent: (0..n).collect(),
        }
    }

    fn find(&mut self, mut i: usize) -> usize {
        while self.parent[i] != i {
            self.parent[i] = self.parent[self.parent[i]];
            i = self.parent[i];
        }
        i
    }

    /// Joins two sets, keeping the smaller root so roots are the lowest member (a stable bus order).
    fn union(&mut self, a: usize, b: usize) {
        let (ra, rb) = (self.find(a), self.find(b));
        if ra < rb {
            self.parent[rb] = ra;
        } else if rb < ra {
            self.parent[ra] = rb;
        }
    }
}

impl Topology {
    /// Processes the model's topology with the given outages.
    pub fn build(model: &Model, outages: &Outages) -> Topology {
        let nn = model.nodes.len();
        let nt3 = model.transformers3.len();
        let live_node = |i: usize| model.alive(Class::Node, i);
        let node_ok = |r: ps_model::NodeRef| r.index() < nn && live_node(r.index());

        // 1. Switches merge nodes into electrical buses.
        let mut merge = UnionFind::new(nn);
        for (k, s) in model.switches.iter().enumerate() {
            if active(model, outages, Class::Switch, k) && node_ok(s.node1) && node_ok(s.node2) {
                merge.union(s.node1.index(), s.node2.index());
            }
        }
        // 2 and 3. Islands over buses (merged node roots) and star points (indices nn..nn+nt3).
        let mut island = UnionFind::new(nn + nt3);
        for i in 0..nn {
            if live_node(i) {
                let r = merge.find(i);
                island.union(i, r);
            }
        }
        let joins = |a: ps_model::NodeRef, b: ps_model::NodeRef, island: &mut UnionFind| {
            if node_ok(a) && node_ok(b) {
                island.union(a.index(), b.index());
            }
        };
        // Branches with exactly one open end, for open-end buses once the islands are known.
        let mut half_open: Vec<(Class, u32, u8, ps_model::NodeRef, ps_model::NodeRef)> = Vec::new();
        let mut branch = |class: Class,
                          k: usize,
                          a: ps_model::NodeRef,
                          b: ps_model::NodeRef,
                          open: [bool; 2],
                          island: &mut UnionFind| {
            if !active(model, outages, class, k) || !node_ok(a) || !node_ok(b) {
                return;
            }
            match open {
                [false, false] => joins(a, b, island),
                [true, false] => half_open.push((class, k as u32, 1, b, a)),
                [false, true] => half_open.push((class, k as u32, 2, a, b)),
                [true, true] => {}
            }
        };
        for (k, l) in model.lines.iter().enumerate() {
            branch(Class::Line, k, l.node1, l.node2, l.open, &mut island);
        }
        for (k, t) in model.transformers2.iter().enumerate() {
            branch(Class::Transformer2, k, t.node1, t.node2, t.open, &mut island);
        }
        let mut t3_in = vec![false; nt3];
        for (k, t) in model.transformers3.iter().enumerate() {
            let connected = t.windings.iter().filter(|w| !w.open).count();
            if active(model, outages, Class::Transformer3, k)
                && t.windings.iter().all(|w| node_ok(w.node))
                && connected > 0
            {
                t3_in[k] = true;
                for w in t.windings.iter().filter(|w| !w.open) {
                    island.union(nn + k, w.node.index());
                }
            }
        }

        // 4. Sources decide which islands are energised.
        let mut sourced = HashSet::new();
        for (k, g) in model.external_grids.iter().enumerate() {
            if active(model, outages, Class::ExternalGrid, k) && node_ok(g.node) {
                sourced.insert(island.find(g.node.index()));
            }
        }
        for (k, g) in model.generators.iter().enumerate() {
            if g.control == MachineControl::Reference && active(model, outages, Class::Generator, k) && node_ok(g.node)
            {
                sourced.insert(island.find(g.node.index()));
            }
        }
        let mut warnings = Vec::new();
        // Per unsourced island, the machine that becomes reference: the lowest positive reference priority, then the
        // largest rating, then the first in model order.
        let rank = |k: usize| {
            let g = &model.generators[k];
            (
                if g.reference_priority > 0 {
                    g.reference_priority
                } else {
                    u32::MAX
                },
                -g.rated_mva,
            )
        };
        let mut best: Vec<(usize, usize)> = Vec::new(); // (island root, generator row)
        for (k, g) in model.generators.iter().enumerate() {
            if !active(model, outages, Class::Generator, k) || !node_ok(g.node) {
                continue;
            }
            let root = island.find(g.node.index());
            if sourced.contains(&root) {
                continue;
            }
            match best.iter_mut().find(|(r, _)| *r == root) {
                Some(entry) => {
                    if rank(k).partial_cmp(&rank(entry.1)) == Some(std::cmp::Ordering::Less) {
                        entry.1 = k;
                    }
                }
                None => best.push((root, k)),
            }
        }
        let mut promoted = Vec::new();
        for (root, k) in best {
            sourced.insert(root);
            promoted.push(k as u32);
            if model.generators[k].reference_priority == 0 {
                warnings.push(format!(
                    "{} is the reference machine for its island, which has no external grid or reference machine.",
                    model.name_of(Class::Generator, k)
                ));
            }
        }
        promoted.sort_unstable();

        // Number the energised buses: node buses by first node, then star points.
        let mut node_bus = vec![None; nn];
        let mut buses: Vec<CalcBus> = Vec::new();
        let mut deenergised = Vec::new();
        let mut island_ids: Vec<(usize, u32)> = Vec::new();
        let mut island_of = |root: usize| -> u32 {
            match island_ids.iter().find(|(r, _)| *r == root) {
                Some(&(_, id)) => id,
                None => {
                    let id = island_ids.len() as u32;
                    island_ids.push((root, id));
                    id
                }
            }
        };
        let mut root_bus: Vec<Option<u32>> = vec![None; nn];
        for i in 0..nn {
            if !live_node(i) {
                continue;
            }
            let iroot = island.find(i);
            if !sourced.contains(&iroot) {
                deenergised.push(i as u32);
                continue;
            }
            let r = merge.find(i);
            let b = match root_bus[r] {
                Some(b) => b,
                None => {
                    let b = buses.len() as u32;
                    root_bus[r] = Some(b);
                    buses.push(CalcBus {
                        nodes: Vec::new(),
                        star_of: None,
                        open_end_of: None,
                        base_kv: model.nodes[i].nominal_kv,
                        island: island_of(iroot),
                    });
                    b
                }
            };
            buses[b as usize].nodes.push(i as u32);
            node_bus[i] = Some(b);
        }
        let mut star_bus = vec![None; nt3];
        for k in 0..nt3 {
            let root = island.find(nn + k);
            if t3_in[k] && sourced.contains(&root) {
                star_bus[k] = Some(buses.len() as u32);
                buses.push(CalcBus {
                    nodes: Vec::new(),
                    star_of: Some(k as u32),
                    open_end_of: None,
                    base_kv: model.transformers3[k].windings[0].rated_kv,
                    island: island_of(root),
                });
            }
        }
        let mut open_end_bus = Vec::new();
        for (class, row, end, connected, open) in half_open {
            let root = island.find(connected.index());
            if sourced.contains(&root) {
                open_end_bus.push(((class, row, end), buses.len() as u32));
                buses.push(CalcBus {
                    nodes: Vec::new(),
                    star_of: None,
                    open_end_of: Some((class, row, end)),
                    base_kv: model.nodes[open.index()].nominal_kv,
                    island: island_of(root),
                });
            }
        }
        for b in &buses {
            if let Some(&first) = b.nodes.first() {
                let kv = model.nodes[first as usize].nominal_kv;
                if b.nodes
                    .iter()
                    .any(|&n| (model.nodes[n as usize].nominal_kv - kv).abs() > 1e-9 * kv)
                {
                    warnings.push(format!(
                        "Closed switches join nodes of different nominal voltages at {}; {} kV is used.",
                        model.name_of(Class::Node, first as usize),
                        kv
                    ));
                }
            }
        }
        Topology {
            islands: island_ids.len() as u32,
            buses,
            node_bus,
            star_bus,
            open_end_bus,
            deenergised,
            promoted,
            warnings,
        }
    }

    /// The calculation bus of a branch end (1 or 2): its open-end bus when the end is open, otherwise its node's.
    pub fn end_bus(&self, class: Class, row: usize, end: u8, node: ps_model::NodeRef, open: bool) -> Option<usize> {
        if open {
            self.open_end_bus
                .iter()
                .find(|(k, _)| *k == (class, row as u32, end))
                .map(|&(_, b)| b as usize)
        } else {
            self.bus_of(node)
        }
    }

    /// The calculation bus of a node.
    pub fn bus_of(&self, node: ps_model::NodeRef) -> Option<usize> {
        self.node_bus.get(node.index()).copied().flatten().map(|b| b as usize)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ps_model::{ExternalGrid, Generator, Line, Node, NodeRef, Switch, SwitchKind};

    fn node(id: &str) -> Node {
        Node {
            id: id.into(),
            nominal_kv: 110.0,
            ..Default::default()
        }
    }

    fn line(id: &str, a: u32, b: u32) -> Line {
        Line {
            id: id.into(),
            node1: NodeRef(a),
            node2: NodeRef(b),
            in_service: true,
            x: 10.0,
            ..Default::default()
        }
    }

    /// Two busbar sections joined by a breaker feed a line to a third node; a fourth node hangs off an open breaker.
    fn sample() -> Model {
        let mut m = Model::new("t");
        m.nodes = vec![node("s1"), node("s2"), node("far"), node("spur")];
        m.switches = vec![
            Switch {
                id: "cb".into(),
                node1: NodeRef(0),
                node2: NodeRef(1),
                kind: SwitchKind::Breaker,
                open: false,
                ..Default::default()
            },
            Switch {
                id: "cb2".into(),
                node1: NodeRef(1),
                node2: NodeRef(3),
                kind: SwitchKind::Breaker,
                open: true,
                ..Default::default()
            },
        ];
        m.lines = vec![line("l", 1, 2)];
        m.external_grids = vec![ExternalGrid {
            id: "x".into(),
            node: NodeRef(0),
            in_service: true,
            v_set: 1.0,
            ..Default::default()
        }];
        m
    }

    #[test]
    fn closed_switches_merge_and_open_ones_isolate() {
        let m = sample();
        let t = Topology::build(&m, &Outages::none());
        assert_eq!(t.buses.len(), 2);
        assert_eq!(t.buses[0].nodes, vec![0, 1]);
        assert_eq!(t.node_bus, vec![Some(0), Some(0), Some(1), None]);
        assert_eq!(t.deenergised, vec![3]);
        assert_eq!(t.islands, 1);
    }

    #[test]
    fn outages_split_islands_and_unsourced_machines_are_promoted() {
        let mut m = sample();
        m.generators = vec![
            Generator {
                id: "small".into(),
                node: NodeRef(2),
                in_service: true,
                rated_mva: 10.0,
                ..Default::default()
            },
            Generator {
                id: "big".into(),
                node: NodeRef(2),
                in_service: true,
                rated_mva: 50.0,
                ..Default::default()
            },
        ];
        let mut out = Outages::none();
        out.insert(Class::Line, 0);
        let t = Topology::build(&m, &out);
        assert_eq!(t.islands, 2);
        assert_eq!(t.promoted, vec![1]);
        assert!(t.warnings[0].starts_with("big is the reference machine"));
        // Without the machines the far node is lost.
        m.generators.clear();
        let t = Topology::build(&m, &out);
        assert_eq!(t.deenergised, vec![2, 3]);
    }
}
