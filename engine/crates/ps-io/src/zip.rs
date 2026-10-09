//! A minimal ZIP reader for model exchange archives: stored and deflated entries, nested archives, CRC-32 checked.
//!
//! CGMES models travel as ZIP files, often a ZIP of per-profile ZIPs. This reads the central directory, inflates each
//! entry and expands entries that are themselves archives. Encrypted entries, multi-disk archives and ZIP64 (entries
//! or archives over 4 GiB) are refused with a message.

use crate::ParseError;

/// One file from an archive.
#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    /// Path inside the archive; for a nested archive, `outer.zip/inner.xml`.
    pub name: String,
    /// Uncompressed contents.
    pub data: Vec<u8>,
}

/// Whether bytes start like a ZIP archive.
pub fn is_zip(bytes: &[u8]) -> bool {
    bytes.starts_with(b"PK\x03\x04") || bytes.starts_with(b"PK\x05\x06")
}

fn u16_at(b: &[u8], at: usize) -> Result<usize, ParseError> {
    b.get(at..at + 2)
        .map(|s| usize::from(u16::from_le_bytes([s[0], s[1]])))
        .ok_or_else(truncated)
}

fn u32_at(b: &[u8], at: usize) -> Result<u32, ParseError> {
    b.get(at..at + 4)
        .map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
        .ok_or_else(truncated)
}

fn truncated() -> ParseError {
    ParseError::new("the ZIP archive is truncated or damaged", None)
}

/// Reads every file of an archive, expanding nested archives, in directory order. Directories are skipped.
pub fn read(bytes: &[u8]) -> Result<Vec<Entry>, ParseError> {
    let mut out = Vec::new();
    read_into(bytes, "", &mut out, 0, &|_| true)?;
    Ok(out)
}

/// Reads only the top-level entries whose path starts with one of `prefixes` (a folder ending in `/`, or a file),
/// expanding the archives among them. Large archives of test configurations are read this way, one case at a time.
pub fn read_matching(bytes: &[u8], prefixes: &[&str]) -> Result<Vec<Entry>, ParseError> {
    let mut out = Vec::new();
    read_into(bytes, "", &mut out, 0, &|name| {
        prefixes.iter().any(|p| name.starts_with(p))
    })?;
    Ok(out)
}

fn read_into(
    bytes: &[u8],
    prefix: &str,
    out: &mut Vec<Entry>,
    depth: usize,
    keep: &dyn Fn(&str) -> bool,
) -> Result<(), ParseError> {
    if depth > 4 {
        return Err(ParseError::new(
            "the ZIP archive nests archives more than four levels deep",
            None,
        ));
    }
    // The end-of-central-directory record sits within the last 64 KiB + 22 bytes.
    let min = bytes.len().saturating_sub(22 + 65_535);
    let eocd = (min..=bytes.len().saturating_sub(22))
        .rev()
        .find(|&i| bytes[i..].starts_with(b"PK\x05\x06"))
        .ok_or_else(|| ParseError::new("not a ZIP archive (no central directory)", None))?;
    if u16_at(bytes, eocd + 4)? != 0 || u16_at(bytes, eocd + 6)? != 0 {
        return Err(ParseError::new("multi-disk ZIP archives are not supported", None));
    }
    let count = u16_at(bytes, eocd + 10)?;
    let cd_offset = u32_at(bytes, eocd + 16)?;
    if count == 0xFFFF || cd_offset == u32::MAX {
        return Err(ParseError::new("ZIP64 archives are not supported", None));
    }
    let mut at = cd_offset as usize;
    for _ in 0..count {
        if u32_at(bytes, at)? != 0x0201_4b50 {
            return Err(truncated());
        }
        let flags = u16_at(bytes, at + 8)?;
        let method = u16_at(bytes, at + 10)?;
        let crc = u32_at(bytes, at + 16)?;
        let packed = u32_at(bytes, at + 20)?;
        let size = u32_at(bytes, at + 24)?;
        let (name_len, extra_len, comment_len) = (
            u16_at(bytes, at + 28)?,
            u16_at(bytes, at + 30)?,
            u16_at(bytes, at + 32)?,
        );
        let local = u32_at(bytes, at + 42)? as usize;
        let name_bytes = bytes.get(at + 46..at + 46 + name_len).ok_or_else(truncated)?;
        let name = String::from_utf8_lossy(name_bytes).into_owned();
        at += 46 + name_len + extra_len + comment_len;
        if name.ends_with('/') || !keep(&name) {
            continue;
        }
        if flags & 1 != 0 {
            return Err(ParseError::new(format!("{prefix}{name} is encrypted"), None));
        }
        if packed == u32::MAX || size == u32::MAX || local == u32::MAX as usize {
            return Err(ParseError::new("ZIP64 archives are not supported", None));
        }
        if u32_at(bytes, local)? != 0x0403_4b50 {
            return Err(truncated());
        }
        let start = local + 30 + u16_at(bytes, local + 26)? + u16_at(bytes, local + 28)?;
        let raw = bytes.get(start..start + packed as usize).ok_or_else(truncated)?;
        let data = match method {
            0 => raw.to_vec(),
            8 => miniz_oxide::inflate::decompress_to_vec_with_limit(raw, size as usize)
                .map_err(|e| ParseError::new(format!("{prefix}{name} cannot be inflated: {e:?}"), None))?,
            m => {
                return Err(ParseError::new(
                    format!("{prefix}{name} uses compression method {m}, which is not supported"),
                    None,
                ));
            }
        };
        if data.len() != size as usize || crc32(&data) != crc {
            return Err(ParseError::new(format!("{prefix}{name} fails its checksum"), None));
        }
        let full = format!("{prefix}{name}");
        if is_zip(&data) {
            read_into(&data, &format!("{full}/"), out, depth + 1, &|_| true)?;
        } else {
            out.push(Entry { name: full, data });
        }
    }
    Ok(())
}

/// CRC-32 (IEEE 802.3), as ZIP uses it.
pub fn crc32(data: &[u8]) -> u32 {
    static TABLE: std::sync::OnceLock<[u32; 256]> = std::sync::OnceLock::new();
    let table = TABLE.get_or_init(|| {
        let mut t = [0u32; 256];
        for (i, slot) in t.iter_mut().enumerate() {
            let mut c = i as u32;
            for _ in 0..8 {
                c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
            }
            *slot = c;
        }
        t
    });
    !data
        .iter()
        .fold(!0u32, |c, &b| table[((c ^ u32::from(b)) & 0xFF) as usize] ^ (c >> 8))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds a stored-only archive.
    fn archive(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut central = Vec::new();
        for (name, data) in files {
            let offset = out.len() as u32;
            let crc = crc32(data);
            let size = data.len() as u32;
            out.extend_from_slice(b"PK\x03\x04");
            out.extend_from_slice(&[20, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
            out.extend_from_slice(&crc.to_le_bytes());
            out.extend_from_slice(&size.to_le_bytes());
            out.extend_from_slice(&size.to_le_bytes());
            out.extend_from_slice(&(name.len() as u16).to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(name.as_bytes());
            out.extend_from_slice(data);
            central.extend_from_slice(b"PK\x01\x02");
            central.extend_from_slice(&[20, 0, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
            central.extend_from_slice(&crc.to_le_bytes());
            central.extend_from_slice(&size.to_le_bytes());
            central.extend_from_slice(&size.to_le_bytes());
            central.extend_from_slice(&(name.len() as u16).to_le_bytes());
            central.extend_from_slice(&[0; 12]);
            central.extend_from_slice(&offset.to_le_bytes());
            central.extend_from_slice(name.as_bytes());
        }
        let cd_offset = out.len() as u32;
        out.extend_from_slice(&central);
        out.extend_from_slice(b"PK\x05\x06\0\0\0\0");
        out.extend_from_slice(&(files.len() as u16).to_le_bytes());
        out.extend_from_slice(&(files.len() as u16).to_le_bytes());
        out.extend_from_slice(&(central.len() as u32).to_le_bytes());
        out.extend_from_slice(&cd_offset.to_le_bytes());
        out.extend_from_slice(&[0, 0]);
        out
    }

    #[test]
    fn reads_nested_archives_and_checks_crcs() -> Result<(), ParseError> {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
        let inner = archive(&[("EQ.xml", b"<eq/>")]);
        let outer = archive(&[("readme.txt", b"hello"), ("model.zip", &inner)]);
        let entries = read(&outer)?;
        assert_eq!(
            entries.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(),
            ["readme.txt", "model.zip/EQ.xml"]
        );
        assert_eq!(entries[1].data, b"<eq/>");
        let mut broken = outer.clone();
        let at = broken.windows(5).position(|w| w == b"hello").unwrap_or(0);
        broken[at] = b'j';
        assert!(read(&broken).is_err(), "a changed byte fails the checksum");
        Ok(())
    }
}
