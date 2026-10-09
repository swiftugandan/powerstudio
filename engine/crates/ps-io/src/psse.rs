//! PSS/E RAW files, versions 33 and 35: the records as written, in the file's own units and conventions.
//!
//! A RAW file is a header of three lines followed by sections of records, each section ended by a record that is just
//! `0` (the whole file by `Q`). Fields are separated by commas or blanks, strings are quoted, and anything after a `/`
//! outside quotes is a comment. Sections come in a fixed order per version; when the file names them in its
//! terminator comments (`0 / END OF BUS DATA, BEGIN LOAD DATA`), those names are used instead, which also copes with
//! files that leave sections out. Sections PowerStudio does not model (DC lines, FACTS devices, GNE devices, induction
//! machines, node-breaker substation data) are skipped record by record and counted, so the import report can name
//! them.

use crate::ParseError;

/// A field: `None` when left empty (the default applies).
pub type Field = Option<String>;

/// Splits a record into fields: commas or blanks separate, quotes group, `/` outside quotes starts a comment.
pub fn fields(line: &str) -> Vec<Field> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut have = false;
    // Set when the last field was closed by blanks, so a following comma does not add an empty field.
    let mut closed_by_blank = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\'' | '"' => {
                for q in chars.by_ref() {
                    if q == c {
                        break;
                    }
                    cur.push(q);
                }
                have = true;
                closed_by_blank = false;
            }
            '/' => break,
            ',' => {
                if have {
                    out.push(Some(std::mem::take(&mut cur)));
                } else if !closed_by_blank {
                    out.push(None);
                }
                have = false;
                closed_by_blank = false;
            }
            c if c.is_whitespace() => {
                if have {
                    out.push(Some(std::mem::take(&mut cur)));
                    have = false;
                    closed_by_blank = true;
                }
            }
            c => {
                cur.push(c);
                have = true;
                closed_by_blank = false;
            }
        }
    }
    if have {
        out.push(Some(cur));
    }
    out
}

/// One record's fields with typed access by position.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Record {
    /// 1-based line number of the record's first line.
    pub line: usize,
    /// Fields of every line of the record, in order.
    pub lines: Vec<Vec<Field>>,
}

impl Record {
    fn get(&self, l: usize, i: usize) -> Option<&str> {
        self.lines
            .get(l)?
            .get(i)?
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
    }

    /// A number, or `default` when the field is empty or absent.
    pub fn num(&self, l: usize, i: usize, default: f64) -> Result<f64, ParseError> {
        match self.get(l, i) {
            None => Ok(default),
            Some(s) => s.parse::<f64>().map_err(|_| {
                ParseError::new(
                    format!("\"{s}\" is not a number (field {})", i + 1),
                    Some(self.line + l),
                )
            }),
        }
    }

    /// An integer, or `default`.
    pub fn int(&self, l: usize, i: usize, default: i64) -> Result<i64, ParseError> {
        let v = self.num(l, i, default as f64)?;
        if v.fract() != 0.0 {
            return Err(ParseError::new(
                format!("{v} is not a whole number (field {})", i + 1),
                Some(self.line + l),
            ));
        }
        Ok(v as i64)
    }

    /// A string with surrounding blanks removed, or `default`.
    pub fn text(&self, l: usize, i: usize, default: &str) -> String {
        self.get(l, i).unwrap_or(default).to_string()
    }
}

/// The sections of a RAW file this reader knows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Section {
    /// System-wide data (version 35).
    SystemWide,
    /// Buses.
    Bus,
    /// Loads.
    Load,
    /// Fixed shunts.
    FixedShunt,
    /// Generators.
    Generator,
    /// Non-transformer branches.
    Branch,
    /// System switching devices (version 35).
    SwitchingDevice,
    /// Two- and three-winding transformers.
    Transformer,
    /// Areas.
    Area,
    /// Two-terminal DC lines.
    TwoTerminalDc,
    /// Voltage source converter DC lines.
    VscDc,
    /// Impedance correction tables.
    ImpedanceCorrection,
    /// Multi-terminal DC lines.
    MultiTerminalDc,
    /// Multi-section line groupings.
    MultiSectionLine,
    /// Zones.
    Zone,
    /// Inter-area transfers.
    InterAreaTransfer,
    /// Owners.
    Owner,
    /// FACTS devices.
    Facts,
    /// Switched shunts.
    SwitchedShunt,
    /// GNE devices.
    Gne,
    /// Induction machines.
    InductionMachine,
    /// Node-breaker substation data (version 35).
    Substation,
}

impl Section {
    /// The name the file uses in its terminator comments.
    pub fn name(self) -> &'static str {
        match self {
            Section::SystemWide => "SYSTEM-WIDE",
            Section::Bus => "BUS",
            Section::Load => "LOAD",
            Section::FixedShunt => "FIXED SHUNT",
            Section::Generator => "GENERATOR",
            Section::Branch => "BRANCH",
            Section::SwitchingDevice => "SYSTEM SWITCHING DEVICE",
            Section::Transformer => "TRANSFORMER",
            Section::Area => "AREA",
            Section::TwoTerminalDc => "TWO-TERMINAL DC",
            Section::VscDc => "VOLTAGE SOURCE CONVERTER",
            Section::ImpedanceCorrection => "IMPEDANCE CORRECTION",
            Section::MultiTerminalDc => "MULTI-TERMINAL DC",
            Section::MultiSectionLine => "MULTI-SECTION LINE",
            Section::Zone => "ZONE",
            Section::InterAreaTransfer => "INTER-AREA TRANSFER",
            Section::Owner => "OWNER",
            Section::Facts => "FACTS CONTROL DEVICE",
            Section::SwitchedShunt => "SWITCHED SHUNT",
            Section::Gne => "GNE DEVICE",
            Section::InductionMachine => "INDUCTION MACHINE",
            Section::Substation => "SUBSTATION",
        }
    }

    fn order(rev: u32) -> &'static [Section] {
        use Section::*;
        const V33: [Section; 19] = [
            Bus,
            Load,
            FixedShunt,
            Generator,
            Branch,
            Transformer,
            Area,
            TwoTerminalDc,
            VscDc,
            ImpedanceCorrection,
            MultiTerminalDc,
            MultiSectionLine,
            Zone,
            InterAreaTransfer,
            Owner,
            Facts,
            SwitchedShunt,
            Gne,
            InductionMachine,
        ];
        const V35: [Section; 22] = [
            SystemWide,
            Bus,
            Load,
            FixedShunt,
            Generator,
            Branch,
            SwitchingDevice,
            Transformer,
            Area,
            TwoTerminalDc,
            VscDc,
            ImpedanceCorrection,
            MultiTerminalDc,
            MultiSectionLine,
            Zone,
            InterAreaTransfer,
            Owner,
            Facts,
            SwitchedShunt,
            Gne,
            InductionMachine,
            Substation,
        ];
        if rev >= 35 { &V35 } else { &V33 }
    }

    /// Lines per record, from the record's first line; `None` when records have a variable length this reader does
    /// not need to know (skipped sections, read up to the terminator).
    fn lines_per_record(self, rev: u32, first: &[Field]) -> Option<usize> {
        match self {
            Section::Transformer => {
                let k = first
                    .get(2)
                    .cloned()
                    .flatten()
                    .and_then(|k| k.trim().parse::<i64>().ok())
                    .unwrap_or(0);
                Some(if k == 0 { 4 } else { 5 })
            }
            Section::TwoTerminalDc | Section::VscDc => Some(3),
            Section::SystemWide
            | Section::ImpedanceCorrection
            | Section::MultiTerminalDc
            | Section::Gne
            | Section::Substation => None,
            _ => {
                let _ = rev;
                Some(1)
            }
        }
    }
}

/// One substation of the node-breaker data (version 35): its record and the three blocks that follow it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RawSubstation {
    /// IS, NAME, LATI, LONG, SRG.
    pub header: Record,
    /// Nodes: NI, NAME, I (bus), STATUS, VM, VA.
    pub nodes: Vec<Record>,
    /// Switching devices: NI, NJ, CKT, NAME, TYPE, STATUS, NSTAT, X, RATE1…3.
    pub switches: Vec<Record>,
    /// Equipment terminals: I, NI, TYPE, then ID; J, CKT; or J, K, CKT by type.
    pub terminals: Vec<Record>,
}

/// A parsed RAW file.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RawCase {
    /// Format version (`REV`).
    pub rev: u32,
    /// System base power, MVA.
    pub sbase: f64,
    /// Base frequency, Hz.
    pub basfrq: f64,
    /// The two title lines.
    pub title: [String; 2],
    /// Records of the sections PowerStudio maps, by section.
    pub records: Vec<(Section, Vec<Record>)>,
    /// Records counted in sections that are skipped.
    pub skipped: Vec<(Section, usize)>,
    /// Node-breaker substations (version 35).
    pub substations: Vec<RawSubstation>,
}

impl RawCase {
    /// The records of a section.
    pub fn section(&self, s: Section) -> &[Record] {
        self.records
            .iter()
            .find(|(k, _)| *k == s)
            .map_or(&[], |(_, r)| r.as_slice())
    }
}

const MAPPED: [Section; 10] = [
    Section::Bus,
    Section::Load,
    Section::FixedShunt,
    Section::Generator,
    Section::Branch,
    Section::SwitchingDevice,
    Section::Transformer,
    Section::Area,
    Section::Facts,
    Section::SwitchedShunt,
];

/// The section a terminator comment begins, if it names one (`… BEGIN LOAD DATA`).
fn begins(comment: &str) -> Option<Section> {
    let upper = comment.to_ascii_uppercase();
    let at = upper.find("BEGIN ")?;
    let rest = upper[at + 6..].trim();
    let name = rest.strip_suffix("DATA").unwrap_or(rest).trim();
    let all = Section::order(35).iter().chain(Section::order(33));
    all.copied().find(|s| s.name() == name)
}

/// The text of a RAW file's bytes: UTF-8 when they are valid UTF-8, otherwise Latin-1 (what older tools write).
pub fn decode(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(text) => text.to_string(),
        Err(_) => bytes.iter().map(|&b| char::from(b)).collect(),
    }
}

/// Reads a RAW file.
pub fn parse(text: &str) -> Result<RawCase, ParseError> {
    let lines: Vec<&str> = text.lines().collect();
    // Skip leading annotation lines (`@!` field captions of version 35).
    let mut i = lines
        .iter()
        .position(|l| !l.trim_start().starts_with("@!"))
        .ok_or_else(|| ParseError::new("the file is empty", None))?;
    let head = fields(lines[i]);
    let num = |k: usize, d: f64| {
        head.get(k)
            .cloned()
            .flatten()
            .and_then(|s| s.trim().parse::<f64>().ok())
            .unwrap_or(d)
    };
    let ic = num(0, 0.0);
    if ic != 0.0 {
        return Err(ParseError::new(
            "this RAW file holds change data (IC = 1), not a complete case",
            Some(i + 1),
        ));
    }
    let rev = num(2, 0.0) as u32;
    if rev != 33 && rev != 35 {
        let shown = if rev == 0 {
            "no version".to_string()
        } else {
            format!("version {rev}")
        };
        return Err(ParseError::new(
            format!("the file states {shown}; PowerStudio reads PSS/E RAW versions 33 and 35"),
            Some(i + 1),
        ));
    }
    let mut case = RawCase {
        rev,
        sbase: num(1, 100.0),
        basfrq: num(5, 60.0),
        title: [
            lines.get(i + 1).map_or("", |l| l.trim()).to_string(),
            lines.get(i + 2).map_or("", |l| l.trim()).to_string(),
        ],
        records: Vec::new(),
        skipped: Vec::new(),
        substations: Vec::new(),
    };
    i += 3;
    let order = Section::order(rev);
    let mut current = order.first().copied();
    let mut records: Vec<Record> = Vec::new();
    while i < lines.len() {
        let raw = lines[i];
        let trimmed = raw.trim_start();
        if trimmed.starts_with("@!") || trimmed.is_empty() {
            i += 1;
            continue;
        }
        let f = fields(raw);
        let first = f.first().cloned().flatten().unwrap_or_default();
        let Some(section) = current else { break };
        if first.trim().eq_ignore_ascii_case("Q") {
            finish(&mut case, section, std::mem::take(&mut records));
            break;
        }
        // A section ends with a record that is just `0`.
        let terminator = first.trim() == "0" && f.len() == 1;
        if terminator {
            finish(&mut case, section, std::mem::take(&mut records));
            let comment = raw.split_once('/').map_or("", |(_, c)| c);
            // The comment names the next section; without one, the version's order gives it.
            current = begins(comment).or_else(|| {
                let at = order.iter().position(|&o| o == section)?;
                order.get(at + 1).copied()
            });
            i += 1;
            continue;
        }
        if section == Section::Substation {
            let (sub, next) = substation(&lines, i);
            case.substations.push(sub);
            i = next;
            continue;
        }
        // A record: one or more lines.
        let start = i;
        let mut rec = vec![f];
        if let Some(n) = section.lines_per_record(rev, &rec[0]) {
            for _ in 1..n {
                i += 1;
                rec.push(lines.get(i).map(|l| fields(l)).unwrap_or_default());
            }
        }
        records.push(Record {
            line: start + 1,
            lines: rec,
        });
        i += 1;
    }
    Ok(case)
}

/// Reads one substation starting at its record: nodes, switching devices and equipment terminals, each block ended by
/// a record that is just `0`. Returns it and the index of the line after it.
fn substation(lines: &[&str], start: usize) -> (RawSubstation, usize) {
    let mut sub = RawSubstation {
        header: Record {
            line: start + 1,
            lines: vec![fields(lines[start])],
        },
        ..Default::default()
    };
    let mut i = start + 1;
    for block in 0..3 {
        while i < lines.len() {
            let t = lines[i].trim_start();
            if t.is_empty() || t.starts_with("@!") {
                i += 1;
                continue;
            }
            let f = fields(lines[i]);
            i += 1;
            if f.len() == 1 && f[0].as_deref().map(str::trim) == Some("0") {
                break;
            }
            let rec = Record {
                line: i,
                lines: vec![f],
            };
            match block {
                0 => sub.nodes.push(rec),
                1 => sub.switches.push(rec),
                _ => sub.terminals.push(rec),
            }
        }
    }
    (sub, i)
}

fn finish(case: &mut RawCase, section: Section, records: Vec<Record>) {
    if records.is_empty() {
        return;
    }
    if MAPPED.contains(&section) {
        case.records.push((section, records));
    } else {
        case.skipped.push((section, records.len()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fields_split_on_commas_and_blanks_and_keep_quotes() {
        let f = fields(" 0     100.00  33 , 0, 0, 60.00       / October 01");
        assert_eq!(f, ["0", "100.00", "33", "0", "0", "60.00"].map(|s| Some(s.to_string())));
        let f = fields("1,'Riversde    ', 138.0,,2 / x");
        assert_eq!(
            f,
            vec![
                Some("1".into()),
                Some("Riversde    ".into()),
                Some("138.0".into()),
                None,
                Some("2".into())
            ]
        );
        let f = fields("4,    2,  7,'1 ',2");
        assert_eq!(f.len(), 5);
    }

    #[test]
    fn sections_follow_their_terminators() -> Result<(), ParseError> {
        let text = "0, 100.0, 33, 0, 0, 50.0 / header\ntitle one\ntitle two\n1,'A',110,3\n2,'B',110,1\n0 / END OF BUS DATA, BEGIN LOAD DATA\n2,'1',1,1,1,10,5\n0 / END OF LOAD DATA, BEGIN TRANSFORMER DATA\n1,2,0,'1',1,1,1,0,0,2,'T',1\n0,0.1,100\n1,0,0\n1,0\n0 / END OF TRANSFORMER DATA\nQ\n";
        let c = parse(text)?;
        assert_eq!((c.rev, c.sbase, c.basfrq), (33, 100.0, 50.0));
        assert_eq!(c.section(Section::Bus).len(), 2);
        assert_eq!(c.section(Section::Load).len(), 1);
        assert_eq!(c.section(Section::Transformer)[0].lines.len(), 4);
        assert_eq!(c.section(Section::Transformer)[0].num(1, 1, 0.0)?, 0.1);
        assert!(parse("0, 100.0, 30\n\n\n").is_err(), "unsupported versions are refused");
        let text = "0,100,35,0,0,50\nt\nt\n0 / END OF SYSTEM-WIDE DATA\n1,'A',110,3\n0 / END OF BUS DATA, BEGIN SUBSTATION DATA\n1,'S1',0,0,0.1\n1,'N1',1,1,1,0\n2,'N2',1,1,1,0\n0 / nodes\n1,2,'1','Br',2,1,1,0,0,0,0\n0 / switches\n1,2,'M','1'\n0 / terminals\n0 / END OF SUBSTATION DATA\nQ\n";
        let c = parse(text)?;
        assert_eq!(c.substations.len(), 1);
        let s = &c.substations[0];
        assert_eq!((s.nodes.len(), s.switches.len(), s.terminals.len()), (2, 1, 1));
        Ok(())
    }
}
