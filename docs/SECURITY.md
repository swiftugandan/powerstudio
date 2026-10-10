# Security

PowerStudio is a single HTML file that runs entirely in the browser. This page states what it protects, how, and
where that protection ends. The app's About page says the same in brief.

## What it protects and from whom

Network models can be confidential: an operator's grid data, a planned connection. PowerStudio keeps them on the
device and makes them hard to leak through the app itself.

- **No network access.** The built app's Content-Security-Policy forbids every connection (`connect-src 'none'`), form
  submission and remote code: the page cannot send a model anywhere, even if a bug or a crafted file tried to. A
  browser test (`tests/browser/app.spec.mjs`, "makes no network requests…") records every request a session makes and
  checks the policy.
- **No code from data.** There is no `eval` and no remote script. Trusted Types are required where the browser has
  them (Chromium, Firefox, WebKit today): HTML reaches the page only through the app's own policy, whose input is
  built from escaped values, and the engine's worker starts only from the blob URL the app creates. A browser test
  checks that a raw HTML write and a second policy are both refused.
- **Imported files are data.** CGMES, PSS/E, MATPOWER and PowerStudio files are parsed by the Rust engine, which has no
  `unsafe` code outside its WebAssembly entry points and turns every error into a message; the import gate checks
  every value against the catalogue before a document opens.
- **Encrypted export.** A project can be exported locked with a passphrase, for moving it between machines: AES-256-GCM
  through the browser's Web Crypto, under a key the engine derives with Argon2id at RFC 9106's second recommended cost
  (64 MiB, three passes, four lanes, a 128-bit random salt). The envelope's parameters are authenticated with the
  data, so a file whose cost or nonce was changed does not open, and the engine refuses a cost below what PowerStudio
  writes. A wrong passphrase and a changed file give the same message. Key derivation is checked against Argon2's
  reference implementation (`tests/oracle/golden/kdf.json`, `scripts/oracle/kdf.py`); sealing, opening and tampering
  are tested in `tests/sealed.test.mjs` and in the browser.

## Where the protection ends

- **Data at rest in the browser is as safe as the device account.** Networks, projects, run logs and results are kept
  in the browser's IndexedDB for the origin the app was opened from, unencrypted, like any web app's storage. Anyone
  who can use the browser profile can read them; a device that is compromised (malware, a shared account, a stolen
  unlocked laptop) is out of scope. Use the operating system's disk encryption and account separation, and the
  encrypted export for copies.
- **The passphrase is not stored and cannot be recovered.** A forgotten passphrase loses the encrypted file.
- **The single file is only as trustworthy as where it came from.** Check a downloaded `PowerStudio.html` against the
  SHA-256 published with each release and the build's GitHub attestation (`gh attestation verify PowerStudio.html
  --repo swiftugandan/powerstudio`). Releases are reproducible: `scripts/check-reproducible.mjs` and CI's two-system
  comparison rebuild the engine to the same bytes.
- **Browser extensions** can read any page they are allowed on. That is outside what a page can control.

## Supply chain

Each release carries a CycloneDX bill of materials (`PowerStudio.cdx.json`, written by `scripts/sbom.mjs`): the crates
the engine is built from (85 in 1.0.0), with the checksums `engine/Cargo.lock` pins, and the npm tools used to build and test,
which the app does not contain. A test holds every shipped component to a permissive licence and a pinned hash. The
release workflow attests the files' provenance and the bill of materials with GitHub's artifact attestations.

## Reporting a problem

Please report a security problem privately through the repository's "Report a vulnerability" button (GitHub private
vulnerability reporting), not in a public issue.
