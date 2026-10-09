//! Binary snapshots and the model hash.
//!
//! A snapshot is the magic bytes, a little-endian `u32` format version and the compacted model in postcard encoding.
//! The model hash is the SHA-256 of that encoding: two models with the same content have the same hash however they
//! were edited, which is what run records cite.

use sha2::{Digest, Sha256};

use crate::{Class, Model, NodeRef};

/// The first bytes of every snapshot.
pub const SNAPSHOT_MAGIC: &[u8; 8] = b"PSMODEL\0";
/// The snapshot format this build writes and reads.
pub const SNAPSHOT_VERSION: u32 = 1;

/// Why a snapshot could not be read.
#[derive(Debug, Clone, PartialEq)]
pub enum SnapshotError {
    /// The bytes do not start with [`SNAPSHOT_MAGIC`].
    NotASnapshot,
    /// The snapshot was written in another format version.
    Version(u32),
    /// The body could not be decoded.
    Corrupt(String),
    /// The model could not be encoded.
    Encode(String),
}

impl std::fmt::Display for SnapshotError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotASnapshot => write!(f, "this is not a PowerStudio model snapshot"),
            Self::Version(v) => write!(
                f,
                "the snapshot uses format {v}; this build reads format {SNAPSHOT_VERSION}"
            ),
            Self::Corrupt(e) => write!(f, "the snapshot is damaged: {e}"),
            Self::Encode(e) => write!(f, "the model could not be encoded: {e}"),
        }
    }
}

impl std::error::Error for SnapshotError {}

impl Model {
    /// Drops removed rows and renumbers references to the rows that remain.
    pub fn compact(&mut self) {
        if self.deleted.is_empty() {
            return;
        }
        let renumber = |model: &Model, class: Class| -> (Vec<bool>, Vec<u32>) {
            let n = model.len(class);
            let keep: Vec<bool> = (0..n).map(|i| model.alive(class, i)).collect();
            let mut next = 0u32;
            let map = keep
                .iter()
                .map(|&k| {
                    let v = next;
                    if k {
                        next += 1;
                    }
                    v
                })
                .collect();
            (keep, map)
        };
        let (_, node_map) = renumber(self, Class::Node);
        let (_, vl_map) = renumber(self, Class::VoltageLevel);
        let (_, ss_map) = renumber(self, Class::Substation);
        let (_, area_map) = renumber(self, Class::Area);
        let keeps: Vec<(Class, Vec<bool>)> = Class::ALL.iter().map(|&c| (c, renumber(self, c).0)).collect();
        // Alive elements only refer to alive rows (edits enforce it), so the maps are exact where they are read.
        self.rewire(&|r: NodeRef| NodeRef(node_map.get(r.index()).copied().unwrap_or(r.0)));
        let remap = |map: &[u32], r: Option<u32>| r.map(|v| map.get(v as usize).copied().unwrap_or(v));
        for n in &mut self.nodes {
            n.voltage_level = remap(&vl_map, n.voltage_level);
            n.area = remap(&area_map, n.area);
        }
        for v in &mut self.voltage_levels {
            v.substation = remap(&ss_map, v.substation);
        }
        for (class, keep) in keeps {
            self.retain_rows(class, &keep);
        }
        self.deleted.clear();
    }

    /// Encodes a compacted copy of the model.
    pub fn to_snapshot(&self) -> Result<Vec<u8>, SnapshotError> {
        let body = self.canonical_bytes()?;
        let mut out = Vec::with_capacity(12 + body.len());
        out.extend_from_slice(SNAPSHOT_MAGIC);
        out.extend_from_slice(&SNAPSHOT_VERSION.to_le_bytes());
        out.extend_from_slice(&body);
        Ok(out)
    }

    /// Decodes a snapshot.
    pub fn from_snapshot(bytes: &[u8]) -> Result<Model, SnapshotError> {
        if bytes.len() < 12 || &bytes[..8] != SNAPSHOT_MAGIC {
            return Err(SnapshotError::NotASnapshot);
        }
        let version = u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]);
        if version != SNAPSHOT_VERSION {
            return Err(SnapshotError::Version(version));
        }
        postcard::from_bytes(&bytes[12..]).map_err(|e| SnapshotError::Corrupt(e.to_string()))
    }

    /// The model hash: SHA-256 of the compacted model's encoding, as 64 hexadecimal digits.
    pub fn content_hash(&self) -> Result<String, SnapshotError> {
        let digest = Sha256::digest(self.canonical_bytes()?);
        Ok(digest.iter().map(|b| format!("{b:02x}")).collect())
    }

    fn canonical_bytes(&self) -> Result<Vec<u8>, SnapshotError> {
        let encode = |m: &Model| postcard::to_allocvec(m).map_err(|e| SnapshotError::Encode(e.to_string()));
        if self.deleted.is_empty() {
            encode(self)
        } else {
            let mut copy = self.clone();
            copy.compact();
            encode(&copy)
        }
    }
}
