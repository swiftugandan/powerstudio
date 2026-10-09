//! Model validation: the checks a model must pass before studies run on it. Each finding names the element and says
//! what to fix.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;

use crate::{Class, Model};

/// How serious a finding is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Severity {
    /// Worth a look; studies still run.
    Warning,
    /// Studies cannot run until it is fixed.
    Error,
}

/// One validation finding.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    /// Seriousness.
    pub severity: Severity,
    /// Class of the element concerned.
    pub class: Class,
    /// Identifier of the element concerned.
    pub id: String,
    /// What is wrong, in plain words.
    pub message: String,
}

impl Model {
    /// Checks references, identifiers and ratings. Errors come first.
    pub fn validate(&self) -> Vec<Issue> {
        let mut out = Vec::new();
        let mut push = |severity, class, row: usize, message: String| {
            out.push(Issue {
                severity,
                class,
                id: self.id_of(class, row).unwrap_or("").to_string(),
                message,
            });
        };
        for class in Class::ALL {
            let mut seen = HashSet::new();
            for row in 0..self.len(class) {
                if !self.alive(class, row) {
                    continue;
                }
                let id = self.id_of(class, row).unwrap_or("");
                if id.is_empty() {
                    push(Severity::Error, class, row, "has no identifier".into());
                } else if !seen.insert(id) {
                    push(
                        Severity::Error,
                        class,
                        row,
                        format!("shares its identifier with another {}", class.label()),
                    );
                }
                for n in self.element_nodes(class, row) {
                    if n.index() >= self.nodes.len() {
                        push(
                            Severity::Error,
                            class,
                            row,
                            format!("refers to node #{}, which does not exist", n.0),
                        );
                    } else if !self.alive(Class::Node, n.index()) {
                        push(
                            Severity::Error,
                            class,
                            row,
                            format!("refers to the removed node \"{}\"", self.nodes[n.index()].id),
                        );
                    }
                }
            }
        }
        for (i, n) in self.nodes.iter().enumerate() {
            if self.alive(Class::Node, i) && !positive(n.nominal_kv) {
                push(
                    Severity::Error,
                    Class::Node,
                    i,
                    "needs a nominal voltage above 0 kV".into(),
                );
            }
        }
        for (i, l) in self.lines.iter().enumerate() {
            if !self.alive(Class::Line, i) {
                continue;
            }
            if l.r == 0.0 && l.x == 0.0 {
                push(
                    Severity::Error,
                    Class::Line,
                    i,
                    "has zero impedance; model it as a switch instead".into(),
                );
            }
            if l.node1 == l.node2 {
                push(Severity::Warning, Class::Line, i, "connects a node to itself".into());
            }
        }
        for (i, t) in self.transformers2.iter().enumerate() {
            if !self.alive(Class::Transformer2, i) {
                continue;
            }
            if !(positive(t.rated_kv1) && positive(t.rated_kv2)) {
                push(
                    Severity::Error,
                    Class::Transformer2,
                    i,
                    "needs rated voltages above 0 kV on both windings".into(),
                );
            }
            if t.r == 0.0 && t.x == 0.0 {
                push(Severity::Error, Class::Transformer2, i, "has zero impedance".into());
            }
            for tap in t
                .ratio_taps
                .iter()
                .filter(|tap| !(tap.low <= tap.position && tap.position <= tap.high))
            {
                push(
                    Severity::Error,
                    Class::Transformer2,
                    i,
                    format!("tap position {} is outside {}…{}", tap.position, tap.low, tap.high),
                );
            }
        }
        for (i, t) in self.transformers2.iter().enumerate() {
            if !self.alive(Class::Transformer2, i) {
                continue;
            }
            let missing = |table: &[crate::TapPoint], position: i32| {
                !table.is_empty() && !table.iter().any(|p| p.position == position)
            };
            if t.ratio_taps.iter().any(|tap| missing(&tap.table, tap.position)) {
                push(
                    Severity::Error,
                    Class::Transformer2,
                    i,
                    "the ratio tap position is not in its table".into(),
                );
            }
            if t.phase_tap
                .as_ref()
                .is_some_and(|tap| missing(&tap.table, tap.position))
            {
                push(
                    Severity::Error,
                    Class::Transformer2,
                    i,
                    "the phase tap position is not in its table".into(),
                );
            }
        }
        for (i, t) in self.transformers3.iter().enumerate() {
            if !self.alive(Class::Transformer3, i) {
                continue;
            }
            let outside = |table: &[crate::TapPoint], position: i32| {
                !table.is_empty() && !table.iter().any(|p| p.position == position)
            };
            if t.ratio_taps.iter().any(|tap| outside(&tap.table, tap.position))
                || t.phase_taps.iter().any(|tap| outside(&tap.table, tap.position))
            {
                push(
                    Severity::Error,
                    Class::Transformer3,
                    i,
                    "a tap position is not in its table".into(),
                );
            }
            if t.windings.iter().any(|w| !positive(w.rated_kv)) {
                push(
                    Severity::Error,
                    Class::Transformer3,
                    i,
                    "needs rated voltages above 0 kV on all three windings".into(),
                );
            }
        }
        for (i, g) in self.generators.iter().enumerate() {
            if !self.alive(Class::Generator, i) {
                continue;
            }
            if g.q_min > g.q_max {
                push(
                    Severity::Error,
                    Class::Generator,
                    i,
                    format!("Q min ({} Mvar) is above Q max ({} Mvar)", g.q_min, g.q_max),
                );
            }
            if g.control != crate::MachineControl::Pq && !positive(g.v_set) {
                push(
                    Severity::Error,
                    Class::Generator,
                    i,
                    "needs a voltage setpoint above 0 p.u.".into(),
                );
            }
        }
        for (i, s) in self.shunts.iter().enumerate() {
            if self.alive(Class::Shunt, i) && !s.points.is_empty() && s.sections as usize > s.points.len() {
                push(
                    Severity::Error,
                    Class::Shunt,
                    i,
                    format!(
                        "has {} sections in service but only {} defined",
                        s.sections,
                        s.points.len()
                    ),
                );
            }
            if self.alive(Class::Shunt, i) && s.sections > s.max_sections {
                push(
                    Severity::Error,
                    Class::Shunt,
                    i,
                    format!(
                        "has {} sections in service but only {} installed",
                        s.sections, s.max_sections
                    ),
                );
            }
        }
        out.sort_by_key(|i| std::cmp::Reverse(i.severity));
        out
    }
}

/// True for a finite value above zero (false for NaN).
fn positive(x: f64) -> bool {
    x.is_finite() && x > 0.0
}
