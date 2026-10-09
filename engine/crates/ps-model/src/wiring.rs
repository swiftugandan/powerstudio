//! Which nodes each element connects to. Validation, topology processing and compaction all walk these references.

use crate::NodeRef;
use crate::equipment::*;

/// Access to the node references an element holds.
pub trait Wiring {
    /// Every node the element refers to, terminals first, then controlled nodes.
    fn nodes(&self) -> Vec<NodeRef>;
    /// Mutable access to the same references, in the same order.
    fn nodes_mut(&mut self) -> Vec<&mut NodeRef>;
}

macro_rules! no_wiring {
    ($($ty:ty),*) => {$(
        impl Wiring for $ty {
            fn nodes(&self) -> Vec<NodeRef> {
                Vec::new()
            }
            fn nodes_mut(&mut self) -> Vec<&mut NodeRef> {
                Vec::new()
            }
        }
    )*};
}

no_wiring!(Substation, VoltageLevel, Node, Area);

macro_rules! two_ends {
    ($($ty:ty),*) => {$(
        impl Wiring for $ty {
            fn nodes(&self) -> Vec<NodeRef> {
                vec![self.node1, self.node2]
            }
            fn nodes_mut(&mut self) -> Vec<&mut NodeRef> {
                vec![&mut self.node1, &mut self.node2]
            }
        }
    )*};
}

two_ends!(Switch, Line);

macro_rules! one_end {
    ($($ty:ty),*) => {$(
        impl Wiring for $ty {
            fn nodes(&self) -> Vec<NodeRef> {
                vec![self.node]
            }
            fn nodes_mut(&mut self) -> Vec<&mut NodeRef> {
                vec![&mut self.node]
            }
        }
    )*};
}

one_end!(Load, Svc, ExternalGrid);

impl Wiring for Transformer2 {
    fn nodes(&self) -> Vec<NodeRef> {
        let mut out = vec![self.node1, self.node2];
        out.extend(self.ratio_tap.as_ref().and_then(|t| t.control).map(|c| c.node));
        out
    }
    fn nodes_mut(&mut self) -> Vec<&mut NodeRef> {
        let mut out = vec![&mut self.node1, &mut self.node2];
        out.extend(
            self.ratio_tap
                .as_mut()
                .and_then(|t| t.control.as_mut())
                .map(|c| &mut c.node),
        );
        out
    }
}

impl Wiring for Transformer3 {
    fn nodes(&self) -> Vec<NodeRef> {
        let mut out: Vec<NodeRef> = self.windings.iter().map(|w| w.node).collect();
        out.extend(self.ratio_tap.as_ref().and_then(|t| t.control).map(|c| c.node));
        out
    }
    fn nodes_mut(&mut self) -> Vec<&mut NodeRef> {
        let mut out: Vec<&mut NodeRef> = self.windings.iter_mut().map(|w| &mut w.node).collect();
        out.extend(
            self.ratio_tap
                .as_mut()
                .and_then(|t| t.control.as_mut())
                .map(|c| &mut c.node),
        );
        out
    }
}

impl Wiring for Generator {
    fn nodes(&self) -> Vec<NodeRef> {
        let mut out = vec![self.node];
        out.extend(self.regulated_node);
        out
    }
    fn nodes_mut(&mut self) -> Vec<&mut NodeRef> {
        let mut out = vec![&mut self.node];
        out.extend(self.regulated_node.as_mut());
        out
    }
}

impl Wiring for Shunt {
    fn nodes(&self) -> Vec<NodeRef> {
        let mut out = vec![self.node];
        out.extend(self.control.map(|c| c.node));
        out
    }
    fn nodes_mut(&mut self) -> Vec<&mut NodeRef> {
        let mut out = vec![&mut self.node];
        out.extend(self.control.as_mut().map(|c| &mut c.node));
        out
    }
}
