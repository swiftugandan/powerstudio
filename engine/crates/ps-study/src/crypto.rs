//! Keys from passphrases, for encrypted project files: Argon2id (RFC 9106), memory-hard so that guessing a passphrase
//! costs memory as well as time. The page encrypts with the key through Web Crypto (AES-256-GCM); the engine only
//! derives it, so the passphrase never leaves the worker that computes the key.

use argon2::{Algorithm, Argon2, Params, Version};

/// Argon2id's cost: memory in KiB, passes over it, and lanes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KdfParams {
    /// Memory, KiB.
    pub memory_kib: u32,
    /// Passes over the memory.
    pub iterations: u32,
    /// Lanes.
    pub parallelism: u32,
}

/// What new files use: RFC 9106's second recommended option (section 4), 64 MiB, three passes, four lanes, with a
/// 128-bit salt and a 256-bit key.
pub const DEFAULT_KDF: KdfParams = KdfParams {
    memory_kib: 64 * 1024,
    iterations: 3,
    parallelism: 4,
};

/// The bounds a file's parameters must keep, so a crafted file can neither weaken the key below what PowerStudio writes
/// nor ask for more memory than a browser tab can give.
const MEMORY_KIB: (u32, u32) = (64 * 1024, 512 * 1024);
const ITERATIONS: (u32, u32) = (3, 16);
const PARALLELISM: (u32, u32) = (1, 8);

/// A 256-bit key from a passphrase and a salt of at least 16 bytes.
pub fn derive_key(passphrase: &[u8], salt: &[u8], p: KdfParams) -> Result<[u8; 32], String> {
    let within = |v: u32, (lo, hi): (u32, u32)| (lo..=hi).contains(&v);
    if !within(p.memory_kib, MEMORY_KIB) || !within(p.iterations, ITERATIONS) || !within(p.parallelism, PARALLELISM) {
        return Err(format!(
            "The file asks for key derivation with {} KiB, {} passes and {} lanes, outside what PowerStudio accepts.",
            p.memory_kib, p.iterations, p.parallelism
        ));
    }
    if salt.len() < 16 {
        return Err("The file's salt is shorter than 16 bytes.".into());
    }
    let params =
        Params::new(p.memory_kib, p.iterations, p.parallelism, Some(32)).map_err(|e| format!("Argon2: {e}"))?;
    let mut key = [0_u8; 32];
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(passphrase, salt, &mut key)
        .map_err(|e| format!("Argon2: {e}"))?;
    Ok(key)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn parameters_outside_the_bounds_and_short_salts_are_refused() {
        let salt = [7_u8; 16];
        let weak = KdfParams {
            memory_kib: 1024,
            ..DEFAULT_KDF
        };
        assert!(derive_key(b"x", &salt, weak).unwrap_err().contains("outside"));
        assert!(derive_key(b"x", &salt[..8], DEFAULT_KDF).unwrap_err().contains("salt"));
    }
}
