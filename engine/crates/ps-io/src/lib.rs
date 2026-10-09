//! Importers and exporters for the data formats operators exchange models in.
//!
//! Each format module reads its files into a faithful in-memory image of the format (keeping its own conventions and
//! units). Conversion into the engine's canonical model happens in a separate step that reports every approximation.

pub mod cgmes;
pub mod files;
pub mod matpower;
pub mod matpower_model;
pub mod powerstudio;
pub mod rdf;
pub mod zip;

/// A problem found while reading a file, located well enough for the user to find it.
#[derive(Debug, Clone, PartialEq)]
pub struct ParseError {
    /// What is wrong, in plain words.
    pub message: String,
    /// 1-based line number, when known.
    pub line: Option<usize>,
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.line {
            Some(l) => write!(f, "line {l}: {}", self.message),
            None => write!(f, "{}", self.message),
        }
    }
}

impl std::error::Error for ParseError {}

impl ParseError {
    pub(crate) fn new(message: impl Into<String>, line: Option<usize>) -> Self {
        Self {
            message: message.into(),
            line,
        }
    }
}
