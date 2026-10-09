//! The report every importer returns: files read, what each class of objects became, and the notes on values it
//! filled in or approximated.

use serde::Serialize;

/// What became of one class of objects (a CIM class, a RAW section).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClassReport {
    /// Class or section name.
    pub class: String,
    /// Objects in the files.
    pub count: usize,
    /// `mapped`, `used` or `not used`.
    pub status: &'static str,
    /// What it became, or why it is not used.
    pub detail: String,
}

/// One file read.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct FileReport {
    /// File name.
    pub name: String,
    /// Profiles it declares (short names such as `CoreEquipment-EU`).
    pub profiles: Vec<String>,
}

/// What an import read, mapped and assumed.
#[derive(Debug, Clone, Serialize, PartialEq, Default)]
pub struct ImportReport {
    /// Files read.
    pub files: Vec<FileReport>,
    /// Every class or section found, mapped or not.
    pub classes: Vec<ClassReport>,
    /// Values filled in, approximations and skipped objects, in plain words.
    pub notes: Vec<String>,
}
