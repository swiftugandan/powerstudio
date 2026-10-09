//! MATPOWER case files (format version 2): the numeric matrices and bus names.

use crate::ParseError;

/// A MATPOWER case as written in the file: per-unit and MW values, MATPOWER column order.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MatpowerCase {
    /// Function name of the case file.
    pub name: String,
    /// System base power, MVA.
    pub base_mva: f64,
    /// `mpc.bus` rows (at least 13 columns).
    pub bus: Vec<Vec<f64>>,
    /// `mpc.gen` rows (at least 10 columns).
    pub generators: Vec<Vec<f64>>,
    /// `mpc.branch` rows (at least 11 columns).
    pub branch: Vec<Vec<f64>>,
    /// `mpc.bus_name`, when present.
    pub bus_names: Vec<String>,
}

/// Column indices of `mpc.bus`.
pub mod bus {
    #![allow(missing_docs)]
    pub const I: usize = 0;
    pub const TYPE: usize = 1;
    pub const PD: usize = 2;
    pub const QD: usize = 3;
    pub const GS: usize = 4;
    pub const BS: usize = 5;
    pub const AREA: usize = 6;
    pub const VM: usize = 7;
    pub const VA: usize = 8;
    pub const BASE_KV: usize = 9;
    pub const ZONE: usize = 10;
    pub const VMAX: usize = 11;
    pub const VMIN: usize = 12;
}

/// Column indices of `mpc.gen`.
pub mod generator {
    #![allow(missing_docs)]
    pub const BUS: usize = 0;
    pub const PG: usize = 1;
    pub const QG: usize = 2;
    pub const QMAX: usize = 3;
    pub const QMIN: usize = 4;
    pub const VG: usize = 5;
    pub const MBASE: usize = 6;
    pub const STATUS: usize = 7;
    pub const PMAX: usize = 8;
    pub const PMIN: usize = 9;
}

/// Column indices of `mpc.branch`.
pub mod branch {
    #![allow(missing_docs)]
    pub const F_BUS: usize = 0;
    pub const T_BUS: usize = 1;
    pub const R: usize = 2;
    pub const X: usize = 3;
    pub const B: usize = 4;
    pub const RATE_A: usize = 5;
    pub const RATE_B: usize = 6;
    pub const RATE_C: usize = 7;
    pub const RATIO: usize = 8;
    pub const ANGLE: usize = 9;
    pub const STATUS: usize = 10;
}

/// Parses a MATPOWER case file.
pub fn parse(text: &str) -> Result<MatpowerCase, ParseError> {
    let mut case = MatpowerCase {
        base_mva: 100.0,
        ..Default::default()
    };
    let mut lines = text.lines().enumerate().peekable();
    while let Some((ln, raw)) = lines.next() {
        let line = strip_comment(raw).trim();
        if line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix("function") {
            if let Some(eq) = rest.find('=') {
                case.name = rest[eq + 1..].trim().trim_end_matches(';').to_string();
            }
            continue;
        }
        let Some(rest) = line.strip_prefix("mpc.") else {
            continue;
        };
        let Some(eq) = rest.find('=') else { continue };
        let key = rest[..eq].trim();
        let value = rest[eq + 1..].trim();
        match key {
            "baseMVA" => {
                case.base_mva =
                    value
                        .trim_end_matches(';')
                        .trim()
                        .parse::<f64>()
                        .map_err(|_| {
                            ParseError::new(
                                format!("baseMVA \"{value}\" is not a number"),
                                Some(ln + 1),
                            )
                        })?;
            }
            "bus" | "gen" | "branch" => {
                let rows = read_matrix(value, &mut lines, ln)?;
                match key {
                    "bus" => case.bus = rows,
                    "gen" => case.generators = rows,
                    _ => case.branch = rows,
                }
            }
            "bus_name" => case.bus_names = read_cells(value, &mut lines),
            _ => {}
        }
    }
    if case.bus.is_empty() {
        return Err(ParseError::new(
            "no mpc.bus matrix found; is this a MATPOWER case file?",
            None,
        ));
    }
    for (what, rows, min) in [
        ("bus", &case.bus, 13),
        ("gen", &case.generators, 10),
        ("branch", &case.branch, 11),
    ] {
        if let Some((k, r)) = rows.iter().enumerate().find(|(_, r)| r.len() < min) {
            return Err(ParseError::new(
                format!(
                    "mpc.{what} row {} has {} columns; format version 2 needs {min}",
                    k + 1,
                    r.len()
                ),
                None,
            ));
        }
    }
    Ok(case)
}

fn strip_comment(s: &str) -> &str {
    match s.find('%') {
        Some(i) => &s[..i],
        None => s,
    }
}

/// Reads matrix rows from the text after `=` up to the closing `];`.
fn read_matrix<'a, I>(
    first: &str,
    lines: &mut std::iter::Peekable<I>,
    start: usize,
) -> Result<Vec<Vec<f64>>, ParseError>
where
    I: Iterator<Item = (usize, &'a str)>,
{
    let mut rows = Vec::new();
    let mut row: Vec<f64> = Vec::new();
    let mut chunk = first.trim_start_matches('[').to_string();
    let mut ln = start;
    loop {
        let (body, done) = match chunk.find(']') {
            Some(i) => (chunk[..i].to_string(), true),
            None => (chunk.clone(), false),
        };
        for piece in body.split(';') {
            for tok in piece.split(|c: char| c.is_whitespace() || c == ',') {
                if tok.is_empty() {
                    continue;
                }
                row.push(tok.parse::<f64>().map_err(|_| {
                    ParseError::new(format!("\"{tok}\" is not a number"), Some(ln + 1))
                })?);
            }
            // A semicolon ends a row; the last piece of a line continues unless the line ends the row.
            if !row.is_empty() {
                rows.push(std::mem::take(&mut row));
            }
        }
        if done {
            break;
        }
        match lines.next() {
            Some((l, next)) => {
                ln = l;
                chunk = strip_comment(next).to_string();
            }
            None => {
                return Err(ParseError::new(
                    "matrix not closed with ];",
                    Some(start + 1),
                ));
            }
        }
    }
    Ok(rows)
}

fn read_cells<'a, I>(first: &str, lines: &mut std::iter::Peekable<I>) -> Vec<String>
where
    I: Iterator<Item = (usize, &'a str)>,
{
    let mut out = Vec::new();
    let mut chunk = first.to_string();
    loop {
        let mut rest = chunk.as_str();
        while let Some(a) = rest.find('\'') {
            let tail = &rest[a + 1..];
            let Some(b) = tail.find('\'') else { break };
            out.push(tail[..b].split_whitespace().collect::<Vec<_>>().join(" "));
            rest = &tail[b + 1..];
        }
        if chunk.contains('}') {
            break;
        }
        match lines.next() {
            Some((_, next)) => chunk = next.to_string(),
            None => break,
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const SMALL: &str = "function mpc = tiny\n%% comment\nmpc.baseMVA = 100;\nmpc.bus = [\n\t1\t3\t0\t0\t0\t0\t1\t1.06\t0\t135\t1\t1.1\t0.9;\n\t2\t1\t20\t10\t0\t0\t1\t1\t0\t135\t1\t1.1\t0.9; % trailing\n];\nmpc.gen = [ 1 50 0 99 -99 1.06 100 1 200 0 ];\nmpc.branch = [\n 1 2 0.01 0.1 0.02 0 0 0 0 0 1 -360 360;\n];\nmpc.bus_name = {\n 'One   A';\n 'Two';\n};\n";

    #[test]
    fn reads_scalars_matrices_and_names() -> Result<(), ParseError> {
        let c = parse(SMALL)?;
        assert_eq!(c.name, "tiny");
        assert_eq!(c.base_mva, 100.0);
        assert_eq!(c.bus.len(), 2);
        assert_eq!(c.bus[1][bus::PD], 20.0);
        assert_eq!(c.generators.len(), 1);
        assert_eq!(c.generators[0][generator::PG], 50.0);
        assert_eq!(c.branch[0][branch::X], 0.1);
        assert_eq!(c.bus_names, vec!["One A".to_string(), "Two".to_string()]);
        Ok(())
    }

    #[test]
    fn rejects_files_without_a_bus_matrix() {
        assert!(parse("function mpc = x\n").is_err());
        assert!(parse("mpc.bus = [1 2 3;];").is_err());
    }
}
