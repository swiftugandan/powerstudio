//! The operator benchmark kit's comparison (docs/BENCHMARK-KIT.md): PowerStudio's results for a model against another
//! tool's results for the same model, read from CSV tables, with a report of what differs and by how much.
//!
//! The tables, any of them, by name:
//!
//! - `loadflow_buses`: `bus, u_pu, angle_deg`;
//! - `loadflow_branches`: `branch, p_from_mw, q_from_mvar, p_to_mw, q_to_mvar`;
//! - `shortcircuit_<3ph|2ph|1ph>_<max|min>`: `bus, ikss_ka` and optionally `ip_ka`, `ib_ka`;
//! - `contingency`: `outage, branch, loading_pct`, a branch's loading with an element out.
//!
//! Buses and branches are named as the model names them, or as the source format does: a PSS/E bus number (`12` for
//! `B12`), a branch's `from-to-circuit` (`4-7-1` for `L-4-7-1` or `T-4-7-1`), a name that only one element has, or for
//! CGMES a TopologicalNode's mRID or name (the aliases the caller passes). Angles are compared after removing their
//! median difference, since tools choose different reference angles.

use std::collections::HashMap;

use ps_model::study::{FaultType, ScMode, StudyCase};
use ps_model::{Class, Model, NodeRef};
use ps_net::{BuildOptions, Calc};
use ps_topology::Outages;
use serde::Serialize;

use crate::loadflow::{self, LoadFlowRun};

/// A table read from CSV: its name (the file's stem), its header and its rows.
#[derive(Debug, Clone)]
pub struct Table {
    /// The file's stem, which says what the table holds.
    pub name: String,
    /// Column names, lower case.
    pub header: Vec<String>,
    /// Rows of cells.
    pub rows: Vec<Vec<String>>,
}

/// Reads CSV text: a header row, then rows; cells may be quoted with `"`, and `""` inside quotes is a quote.
pub fn parse_csv(name: &str, text: &str) -> Result<Table, String> {
    let mut lines = Vec::new();
    for raw in text.lines() {
        if raw.trim().is_empty() {
            continue;
        }
        let mut cells = Vec::new();
        let (mut cell, mut quoted, mut chars) = (String::new(), false, raw.chars().peekable());
        while let Some(c) = chars.next() {
            match (c, quoted) {
                ('"', true) if chars.peek() == Some(&'"') => {
                    cell.push('"');
                    chars.next();
                }
                ('"', _) => quoted = !quoted,
                (',', false) => cells.push(std::mem::take(&mut cell).trim().to_string()),
                (c, _) => cell.push(c),
            }
        }
        if quoted {
            return Err(format!("{name}: a quoted cell does not end on its line: {raw}"));
        }
        cells.push(cell.trim().to_string());
        lines.push(cells);
    }
    let mut it = lines.into_iter();
    let header: Vec<String> = it
        .next()
        .ok_or_else(|| format!("{name}: the table is empty"))?
        .into_iter()
        .map(|h| h.to_ascii_lowercase())
        .collect();
    Ok(Table {
        name: name.to_string(),
        header,
        rows: it.collect(),
    })
}

/// How far apart the two tools' results may be before a value counts as different.
#[derive(Debug, Clone, Copy)]
pub struct Tolerances {
    /// Voltage magnitude, p.u.
    pub v_pu: f64,
    /// Voltage angle after the common offset is removed, degrees.
    pub angle_deg: f64,
    /// Active and reactive power, MW and Mvar.
    pub power: f64,
    /// Short-circuit currents, relative.
    pub current_rel: f64,
    /// Loading, percentage points.
    pub loading_pct: f64,
}

impl Default for Tolerances {
    fn default() -> Self {
        Self {
            v_pu: 1e-3,
            angle_deg: 0.1,
            power: 1.0,
            current_rel: 0.01,
            loading_pct: 1.0,
        }
    }
}

/// One compared value.
#[derive(Debug, Clone, Serialize)]
pub struct Row {
    /// What the value belongs to, as the reference names it.
    pub id: String,
    /// PowerStudio's value.
    pub ours: f64,
    /// The reference tool's value.
    pub theirs: f64,
    /// The difference that is judged: absolute, or relative for currents.
    pub difference: f64,
}

/// The comparison of one quantity.
#[derive(Debug, Clone, Serialize)]
pub struct Quantity {
    /// What is compared, with its unit.
    pub name: String,
    /// The tolerance it is judged against.
    pub tolerance: f64,
    /// Whether the difference is relative.
    pub relative: bool,
    /// Values compared.
    pub compared: usize,
    /// Values beyond the tolerance.
    pub beyond: usize,
    /// The largest differences, largest first (at most 20).
    pub worst: Vec<Row>,
}

/// The comparison's report.
#[derive(Debug, Clone, Serialize)]
pub struct Report {
    /// Each compared quantity.
    pub quantities: Vec<Quantity>,
    /// References that name nothing in the model, by table.
    pub unmatched: Vec<String>,
    /// What the comparison decided, such as the angle offset it removed.
    pub notes: Vec<String>,
    /// Every value within its tolerance and every reference matched.
    pub passed: bool,
}

/// What a reference may name, and the model's elements those names resolve to.
struct Names<'a> {
    model: &'a Model,
    nodes: HashMap<String, usize>,
    branches: HashMap<String, (Class, usize)>,
    node_names: HashMap<String, Vec<usize>>,
    branch_names: HashMap<String, Vec<(Class, usize)>>,
}

impl<'a> Names<'a> {
    fn new(model: &'a Model, aliases: &HashMap<String, String>) -> Self {
        let mut nodes: HashMap<String, usize> =
            model.nodes.iter().enumerate().map(|(i, n)| (n.id.clone(), i)).collect();
        for (alias, node) in aliases {
            if let Some(&i) = nodes.get(node) {
                nodes.entry(alias.clone()).or_insert(i);
            }
        }
        let mut node_names: HashMap<String, Vec<usize>> = HashMap::new();
        for (i, n) in model.nodes.iter().enumerate() {
            if !n.name.is_empty() {
                node_names.entry(n.name.clone()).or_default().push(i);
            }
        }
        let mut branches = HashMap::new();
        let mut branch_names: HashMap<String, Vec<(Class, usize)>> = HashMap::new();
        let all = model
            .lines
            .iter()
            .enumerate()
            .map(|(k, l)| (Class::Line, k, &l.id, &l.name))
            .chain(
                model
                    .transformers2
                    .iter()
                    .enumerate()
                    .map(|(k, t)| (Class::Transformer2, k, &t.id, &t.name)),
            )
            .chain(
                model
                    .transformers3
                    .iter()
                    .enumerate()
                    .map(|(k, t)| (Class::Transformer3, k, &t.id, &t.name)),
            );
        for (class, k, id, name) in all {
            branches.insert(id.clone(), (class, k));
            if !name.is_empty() {
                branch_names.entry(name.clone()).or_default().push((class, k));
            }
        }
        Self {
            model,
            nodes,
            branches,
            node_names,
            branch_names,
        }
    }

    fn node(&self, s: &str) -> Option<NodeRef> {
        let at = |i: usize| NodeRef(i as u32);
        if let Some(&i) = self.nodes.get(s).or_else(|| self.nodes.get(&format!("B{s}"))) {
            return Some(at(i));
        }
        match self.node_names.get(s).map(Vec::as_slice) {
            Some([i]) => Some(at(*i)),
            _ => None,
        }
    }

    fn branch(&self, s: &str) -> Option<(Class, usize)> {
        let found = self
            .branches
            .get(s)
            .or_else(|| self.branches.get(&format!("L-{s}")))
            .or_else(|| self.branches.get(&format!("T-{s}")));
        if let Some(&b) = found {
            return Some(b);
        }
        match self.branch_names.get(s).map(Vec::as_slice) {
            Some([b]) => Some(*b),
            _ => None,
        }
    }

    fn branch_id(&self, (class, k): (Class, usize)) -> &str {
        match class {
            Class::Line => &self.model.lines[k].id,
            Class::Transformer2 => &self.model.transformers2[k].id,
            _ => &self.model.transformers3[k].id,
        }
    }
}

/// Collects one quantity's values.
struct Collect {
    q: Quantity,
    rows: Vec<Row>,
}

impl Collect {
    fn new(name: &str, tolerance: f64, relative: bool) -> Self {
        Self {
            q: Quantity {
                name: name.to_string(),
                tolerance,
                relative,
                compared: 0,
                beyond: 0,
                worst: Vec::new(),
            },
            rows: Vec::new(),
        }
    }

    fn add(&mut self, id: &str, ours: f64, theirs: f64) {
        let difference = if self.q.relative {
            (ours - theirs).abs() / theirs.abs().max(1e-12)
        } else {
            (ours - theirs).abs()
        };
        let difference = if difference.is_finite() {
            difference
        } else {
            f64::INFINITY
        };
        self.q.compared += 1;
        self.q.beyond += usize::from(difference > self.q.tolerance);
        self.rows.push(Row {
            id: id.to_string(),
            ours,
            theirs,
            difference,
        });
    }

    fn done(mut self) -> Quantity {
        self.rows.sort_by(|a, b| b.difference.total_cmp(&a.difference));
        self.rows.truncate(20);
        self.q.worst = self.rows;
        self.q
    }
}

/// Reads one current from a fault result.
type Pick = fn(&ps_sc::FaultResult) -> f64;

/// A table's column, by name. `None` when the table has no such column.
fn column(t: &Table, name: &str) -> Option<usize> {
    t.header.iter().position(|h| h == name)
}

fn number(t: &Table, row: &[String], col: usize) -> Result<f64, String> {
    let cell = row.get(col).map_or("", String::as_str);
    cell.parse::<f64>()
        .map_err(|_| format!("{}: \"{cell}\" in column {} is not a number", t.name, t.header[col]))
}

fn needs(t: &Table, names: &[&str]) -> Result<Vec<usize>, String> {
    names
        .iter()
        .map(|n| column(t, n).ok_or_else(|| format!("{}: the table needs a column \"{n}\"", t.name)))
        .collect()
}

/// Compares the model's results with the reference tables. `aliases` maps further names (CGMES TopologicalNode mRIDs
/// and names) to node identifiers; `study` gives the load flow and short-circuit settings.
pub fn compare(
    model: &Model,
    aliases: &HashMap<String, String>,
    tables: &[Table],
    study: &StudyCase,
    tol: &Tolerances,
) -> Result<Report, String> {
    let names = Names::new(model, aliases);
    let mut quantities = Vec::new();
    let mut unmatched = Vec::new();
    let mut notes = Vec::new();
    let table = |name: &str| tables.iter().find(|t| t.name == name);
    let run = LoadFlowRun {
        settings: study.loadflow,
        ..Default::default()
    };
    if let Some(t) = table("loadflow_buses") {
        let (calc, sol, report) = loadflow::solve(model, &run);
        if !report.converged {
            return Err(format!("PowerStudio's load flow does not converge: {}", report.message));
        }
        let c = needs(t, &["bus", "u_pu", "angle_deg"])?;
        let (mut v, mut angles) = (Collect::new("Voltage magnitude (p.u.)", tol.v_pu, false), Vec::new());
        for row in &t.rows {
            let id = row[c[0]].as_str();
            match names.node(id).and_then(|n| calc.topo.bus_of(n)) {
                Some(b) => {
                    v.add(id, sol.vm[b], number(t, row, c[1])?);
                    angles.push((id.to_string(), sol.va[b].to_degrees(), number(t, row, c[2])?));
                }
                None => unmatched.push(format!("loadflow_buses: {id}")),
            }
        }
        quantities.push(v.done());
        // The tools' reference angles differ: compare after removing the median difference.
        let mut offsets: Vec<f64> = angles.iter().map(|(_, o, t)| o - t).collect();
        offsets.sort_by(f64::total_cmp);
        let offset = offsets.get(offsets.len() / 2).copied().unwrap_or(0.0);
        if offset.abs() > 1e-9 {
            notes.push(format!(
                "Voltage angles are compared after removing their median difference, {offset:.4}°."
            ));
        }
        let mut a = Collect::new("Voltage angle (°)", tol.angle_deg, false);
        for (id, ours, theirs) in angles {
            a.add(&id, ours - offset, theirs);
        }
        quantities.push(a.done());
    }
    if let Some(t) = table("loadflow_branches") {
        let report = loadflow::run(model, &run);
        if !report.converged {
            return Err(format!("PowerStudio's load flow does not converge: {}", report.message));
        }
        let by_id: HashMap<&str, &crate::loadflow::BranchResult> = report
            .branches
            .iter()
            .filter(|b| b.winding.is_none_or(|w| w == 1))
            .map(|b| (b.id.as_str(), b))
            .collect();
        let c = needs(t, &["branch", "p_from_mw", "q_from_mvar", "p_to_mw", "q_to_mvar"])?;
        let mut sets = [
            Collect::new("Active power at the from end (MW)", tol.power, false),
            Collect::new("Reactive power at the from end (Mvar)", tol.power, false),
            Collect::new("Active power at the to end (MW)", tol.power, false),
            Collect::new("Reactive power at the to end (Mvar)", tol.power, false),
        ];
        for row in &t.rows {
            let id = row[c[0]].as_str();
            match names.branch(id).and_then(|b| by_id.get(names.branch_id(b))) {
                Some(b) => {
                    for (k, ours) in [b.p_from, b.q_from, b.p_to, b.q_to].into_iter().enumerate() {
                        sets[k].add(id, ours, number(t, row, c[k + 1])?);
                    }
                }
                None => unmatched.push(format!("loadflow_branches: {id}")),
            }
        }
        quantities.extend(sets.into_iter().map(Collect::done));
    }
    let calc = Calc::build(model, &Outages::none(), BuildOptions::default());
    for t in tables.iter().filter(|t| t.name.starts_with("shortcircuit_")) {
        let mut parts = t.name.split('_').skip(1);
        let fault = match parts.next() {
            Some("3ph") => FaultType::ThreePhase,
            Some("2ph") => FaultType::LineToLine,
            Some("1ph") => FaultType::LineToEarth,
            _ => {
                return Err(format!(
                    "{}: name a fault type: shortcircuit_3ph_max, shortcircuit_1ph_min…",
                    t.name
                ));
            }
        };
        let mode = match parts.next() {
            Some("max") => ScMode::Max,
            Some("min") => ScMode::Min,
            _ => return Err(format!("{}: name the case, max or min", t.name)),
        };
        let st = ps_model::study::ShortCircuitSettings {
            fault,
            mode,
            location: String::new(),
            ..study.shortcircuit.clone()
        };
        let res = ps_sc::run(model, &st);
        let by_id: HashMap<&str, &ps_sc::FaultResult> = res.buses.iter().map(|b| (b.id.as_str(), b)).collect();
        let c = needs(t, &["bus", "ikss_ka"])?;
        let label = format!(
            "{}, {} currents",
            match fault {
                FaultType::ThreePhase => "three-phase",
                FaultType::LineToLine => "line-to-line",
                FaultType::LineToEarth => "line-to-earth",
            },
            if mode == ScMode::Max { "maximum" } else { "minimum" }
        );
        let mut sets: Vec<(Option<usize>, Collect, Pick)> = vec![
            (
                Some(c[1]),
                Collect::new(&format!("Ik″, {label} (kA)"), tol.current_rel, true),
                |b| b.ikss,
            ),
            (
                column(t, "ip_ka"),
                Collect::new(&format!("ip, {label} (kA)"), tol.current_rel, true),
                |b| b.ip,
            ),
            (
                column(t, "ib_ka"),
                Collect::new(&format!("Ib, {label} (kA)"), tol.current_rel, true),
                |b| b.ib,
            ),
        ];
        for row in &t.rows {
            let id = row[c[0]].as_str();
            let found = names
                .node(id)
                .and_then(|n| calc.topo.bus_of(n))
                .and_then(|k| by_id.get(calc.bus_id(model, k).as_str()));
            match found {
                Some(b) => {
                    for (col, set, value) in &mut sets {
                        if let Some(col) = col {
                            set.add(id, value(b), number(t, row, *col)?);
                        }
                    }
                }
                None => unmatched.push(format!("{}: {id}", t.name)),
            }
        }
        quantities.extend(
            sets.into_iter()
                .filter(|(col, ..)| col.is_some())
                .map(|(_, set, _)| set.done()),
        );
    }
    if let Some(t) = table("contingency") {
        let c = needs(t, &["outage", "branch", "loading_pct"])?;
        let mut set = Collect::new("Loading with the outage (%)", tol.loading_pct, false);
        let mut by_outage: Vec<(String, Vec<&Vec<String>>)> = Vec::new();
        for row in &t.rows {
            let o = row[c[0]].clone();
            match by_outage.iter_mut().find(|(k, _)| *k == o) {
                Some((_, rows)) => rows.push(row),
                None => by_outage.push((o, vec![row])),
            }
        }
        for (outage, rows) in by_outage {
            let Some(out) = names.branch(&outage) else {
                unmatched.push(format!("contingency: outage {outage}"));
                continue;
            };
            let mut outages = Outages::none();
            outages.insert(out.0, out.1);
            let report = loadflow::run(model, &LoadFlowRun { outages, ..run.clone() });
            if !report.converged {
                notes.push(format!(
                    "With {outage} out, PowerStudio's load flow does not converge: {}",
                    report.message
                ));
                continue;
            }
            for row in rows {
                let id = row[c[1]].as_str();
                let found = names.branch(id).and_then(|b| {
                    report
                        .branches
                        .iter()
                        .filter(|r| r.id == names.branch_id(b))
                        .filter_map(|r| r.loading)
                        .reduce(f64::max)
                });
                match found {
                    Some(loading) => set.add(&format!("{id} with {outage} out"), loading, number(t, row, c[2])?),
                    None => unmatched.push(format!("contingency: {id} (no rating, or not in the model)")),
                }
            }
        }
        quantities.push(set.done());
    }
    let passed = unmatched.is_empty() && quantities.iter().all(|q| q.beyond == 0);
    Ok(Report {
        quantities,
        unmatched,
        notes,
        passed,
    })
}

/// The report as Markdown, for people.
pub fn markdown(model: &Model, r: &Report) -> String {
    let mut s = format!(
        "# PowerStudio against the reference: {}\n\n{}\n\n",
        if model.meta.name.is_empty() {
            "model"
        } else {
            &model.meta.name
        },
        if r.passed {
            "Every compared value is within its tolerance, and every reference names an element of the model."
        } else {
            "Some values differ by more than their tolerance, or some references name nothing in the model. Details below."
        }
    );
    s.push_str("| Quantity | Compared | Beyond tolerance | Tolerance | Largest difference |\n| --- | --- | --- | --- | --- |\n");
    for q in &r.quantities {
        let worst = q.worst.first().map_or("—".to_string(), |w| {
            if q.relative {
                format!("{:.3} % at {}", w.difference * 100.0, w.id)
            } else {
                format!("{:.4} at {}", w.difference, w.id)
            }
        });
        let tol = if q.relative {
            format!("{} %", q.tolerance * 100.0)
        } else {
            format!("{}", q.tolerance)
        };
        s.push_str(&format!(
            "| {} | {} | {} | {} | {} |\n",
            q.name, q.compared, q.beyond, tol, worst
        ));
    }
    for n in &r.notes {
        s.push_str(&format!("\n{n}\n"));
    }
    for q in r.quantities.iter().filter(|q| q.beyond > 0) {
        s.push_str(&format!(
            "\n## {}\n\nThe largest differences:\n\n| Element | PowerStudio | Reference | Difference |\n| --- | --- | --- | --- |\n",
            q.name
        ));
        for w in q.worst.iter().filter(|w| w.difference > q.tolerance) {
            let d = if q.relative {
                format!("{:.3} %", w.difference * 100.0)
            } else {
                format!("{:.4}", w.difference)
            };
            s.push_str(&format!("| {} | {:.4} | {:.4} | {} |\n", w.id, w.ours, w.theirs, d));
        }
    }
    if !r.unmatched.is_empty() {
        s.push_str(&format!(
            "\n## References that name nothing in the model ({})\n\n",
            r.unmatched.len()
        ));
        for u in r.unmatched.iter().take(50) {
            s.push_str(&format!("- {u}\n"));
        }
        if r.unmatched.len() > 50 {
            s.push_str(&format!("- and {} more\n", r.unmatched.len() - 50));
        }
    }
    s
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn csv_cells_may_be_quoted() {
        let t = parse_csv(
            "loadflow_buses",
            "Bus,U_pu,angle_deg\n\"Bus \"\"A\"\", 110 kV\",1.01,-2.5\n\n12,0.99,3\n",
        )
        .unwrap();
        assert_eq!(t.header, ["bus", "u_pu", "angle_deg"]);
        assert_eq!(t.rows[0][0], "Bus \"A\", 110 kV");
        assert_eq!(t.rows[1], ["12", "0.99", "3"]);
        assert!(parse_csv("x", "a\n\"open").is_err());
    }
}
