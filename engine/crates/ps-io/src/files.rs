//! Collecting model files from what the user hands over: XML files, folders and ZIP archives, in any mix.

use crate::{ParseError, zip};

/// A named file's contents.
#[derive(Debug, Clone, PartialEq)]
pub struct File {
    /// Name, with its archive path when it came from one.
    pub name: String,
    /// Contents.
    pub data: Vec<u8>,
}

/// Expands archives into their files, keeping files that are not archives as they are. Order is preserved.
pub fn expand(files: Vec<File>) -> Result<Vec<File>, ParseError> {
    let mut out = Vec::new();
    for f in files {
        if zip::is_zip(&f.data) {
            for e in zip::read(&f.data)? {
                out.push(File {
                    name: format!("{}/{}", f.name, e.name),
                    data: e.data,
                });
            }
        } else {
            out.push(f);
        }
    }
    Ok(out)
}

/// Reads paths from disk (files, or folders whose files are read in name order) and expands archives.
#[cfg(not(target_arch = "wasm32"))]
pub fn read_paths(paths: &[String]) -> Result<Vec<File>, ParseError> {
    let mut files = Vec::new();
    for p in paths {
        let path = std::path::Path::new(p);
        if path.is_dir() {
            let mut entries: Vec<_> = std::fs::read_dir(path)
                .map_err(|e| ParseError::new(format!("{p}: {e}"), None))?
                .filter_map(Result::ok)
                .map(|e| e.path())
                .filter(|e| e.is_file())
                .collect();
            entries.sort();
            for e in entries {
                let data = std::fs::read(&e).map_err(|err| ParseError::new(format!("{}: {err}", e.display()), None))?;
                files.push(File {
                    name: e
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_default(),
                    data,
                });
            }
        } else {
            let data = std::fs::read(path).map_err(|e| ParseError::new(format!("{p}: {e}"), None))?;
            files.push(File {
                name: path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                data,
            });
        }
    }
    expand(files)
}
