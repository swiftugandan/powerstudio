"""Key derivation reference: Argon2id from the reference C implementation (phc-winner-argon2, through argon2-cffi's
low-level binding), for the engine's `derive_key` (engine/crates/ps-study/src/crypto.rs).

Writes tests/oracle/golden/kdf.json: each case's passphrase (UTF-8), salt (hex), cost, and the 32-byte key (hex).

    python scripts/oracle/kdf.py
"""

import json
from pathlib import Path

from argon2.low_level import Type, hash_secret_raw

ROOT = Path(__file__).resolve().parents[2]
CASES = [
    {"passphrase": "correct horse battery staple", "salt": "000102030405060708090a0b0c0d0e0f", "memoryKiB": 65536, "iterations": 3, "parallelism": 4},
    {"passphrase": "Übertragungsnetz 380 kV — Prüfung", "salt": "f0e1d2c3b4a5968778695a4b3c2d1e0f", "memoryKiB": 65536, "iterations": 3, "parallelism": 1},
    {"passphrase": "", "salt": "5a" * 32, "memoryKiB": 131072, "iterations": 4, "parallelism": 2},
]


def main():
    out = []
    for c in CASES:
        key = hash_secret_raw(
            secret=c["passphrase"].encode("utf-8"), salt=bytes.fromhex(c["salt"]), time_cost=c["iterations"],
            memory_cost=c["memoryKiB"], parallelism=c["parallelism"], hash_len=32, type=Type.ID, version=19,
        )
        out.append({**c, "key": key.hex()})
    golden = {
        "about": "Argon2id keys from the reference C implementation through argon2-cffi; written by scripts/oracle/kdf.py. Do not edit by hand.",
        "cases": out,
    }
    (ROOT / "tests" / "oracle" / "golden" / "kdf.json").write_text(json.dumps(golden, indent=1, ensure_ascii=False) + "\n")
    print(f"wrote {len(out)} cases")


if __name__ == "__main__":
    main()
