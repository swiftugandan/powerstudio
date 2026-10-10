//! The key derivation for encrypted project files against Argon2id's reference C implementation
//! (tests/oracle/golden/kdf.json, written by scripts/oracle/kdf.py).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use common::*;
use ps_study::crypto::{KdfParams, derive_key};

#[test]
fn argon2id_keys_match_the_reference_implementation() {
    let golden = json("tests/oracle/golden/kdf.json");
    for case in golden["cases"].as_array().unwrap() {
        let hex = |s: &str| -> Vec<u8> {
            (0..s.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
                .collect()
        };
        let num = |k: &str| case[k].as_u64().unwrap() as u32;
        let key = derive_key(
            case["passphrase"].as_str().unwrap().as_bytes(),
            &hex(case["salt"].as_str().unwrap()),
            KdfParams {
                memory_kib: num("memoryKiB"),
                iterations: num("iterations"),
                parallelism: num("parallelism"),
            },
        )
        .unwrap();
        assert_eq!(
            key.to_vec(),
            hex(case["key"].as_str().unwrap()),
            "{}",
            case["passphrase"]
        );
    }
}
