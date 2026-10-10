/** Encrypted project files: a project's JSON sealed with AES-256-GCM under a key from a passphrase.
 *
 * The key comes from the engine's `derive_key` (Argon2id, RFC 9106's second recommended option), which runs in a worker;
 * Web Crypto encrypts. The envelope says how to derive the key again (salt and cost) and carries the nonce; those fields
 * are the cipher's additional data, so a file whose parameters were changed does not open. Nothing about the passphrase
 * is stored. A wrong passphrase and a changed file look the same: the authentication tag does not match.
 *
 * @typedef {{ algorithm: 'argon2id', version: 19, memoryKiB: number, iterations: number, parallelism: number, salt: string }} KdfSpec
 * @typedef {{ format: 'powerstudio-encrypted', version: 1, content: string, kdf: KdfSpec,
 *   cipher: { algorithm: 'AES-256-GCM', iv: string }, data: string }} Sealed
 * @typedef {(header: Record<string, unknown>, payload: Uint8Array) => Promise<Uint8Array>} DeriveKey
 */

export const SEALED_FORMAT = 'powerstudio-encrypted';

/** The cost new files use; the engine refuses anything weaker. */
export const KDF_COST = Object.freeze({ memoryKiB: 64 * 1024, iterations: 3, parallelism: 4 });

/** Shortest passphrase the app accepts for a new file. */
export const MIN_PASSPHRASE = 12;

/** @param {unknown} json @returns {json is Sealed} */
export const isSealed = json => !!json && typeof json === 'object' && /** @type {any} */ (json).format === SEALED_FORMAT;

/** @param {Uint8Array} bytes */
function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** @param {string} text */
function fromBase64(text) {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** The envelope's fields that the tag covers, in a fixed order. @param {Omit<Sealed, 'data'>} e */
const additional = e => new TextEncoder().encode(JSON.stringify([e.format, e.version, e.content, e.kdf.algorithm, e.kdf.version,
  e.kdf.memoryKiB, e.kdf.iterations, e.kdf.parallelism, e.kdf.salt, e.cipher.algorithm, e.cipher.iv]));

/** An AES-GCM key from a passphrase, through the engine. The passphrase is normalised (NFC), so the same words typed on
 * another system give the same key. @param {DeriveKey} derive @param {string} passphrase @param {KdfSpec} kdf */
async function key(derive, passphrase, kdf) {
  const raw = await derive({ op: 'derive_key', salt: [...fromBase64(kdf.salt)], memoryKiB: kdf.memoryKiB, iterations: kdf.iterations,
    parallelism: kdf.parallelism }, new TextEncoder().encode(passphrase.normalize('NFC')));
  return crypto.subtle.importKey('raw', /** @type {Uint8Array<ArrayBuffer>} */ (raw), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/**
 * Seals `text` (a project's JSON) under a passphrase.
 * @param {string} text @param {string} passphrase @param {DeriveKey} derive @param {string} [content] what the text is
 * @returns {Promise<Sealed>}
 */
export async function seal(text, passphrase, derive, content = 'powerstudio-project') {
  if (passphrase.length < MIN_PASSPHRASE) throw new Error(`The passphrase needs at least ${MIN_PASSPHRASE} characters.`);
  /** @type {Omit<Sealed, 'data'>} */
  const head = {
    format: SEALED_FORMAT, version: 1, content,
    kdf: { algorithm: 'argon2id', version: 19, ...KDF_COST, salt: toBase64(crypto.getRandomValues(new Uint8Array(16))) },
    cipher: { algorithm: 'AES-256-GCM', iv: toBase64(crypto.getRandomValues(new Uint8Array(12))) },
  };
  const k = await key(derive, passphrase, head.kdf);
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: fromBase64(head.cipher.iv), additionalData: additional(head) }, k, new TextEncoder().encode(text));
  return { ...head, data: toBase64(new Uint8Array(data)) };
}

/**
 * Opens a sealed file with its passphrase and returns the text it holds. Throws with a plain message when the file is
 * not one this version reads, or when the passphrase is wrong or the file was changed.
 * @param {Sealed} sealed @param {string} passphrase @param {DeriveKey} derive @returns {Promise<string>}
 */
export async function unseal(sealed, passphrase, derive) {
  if (sealed.version !== 1 || sealed.kdf?.algorithm !== 'argon2id' || sealed.kdf.version !== 19 || sealed.cipher?.algorithm !== 'AES-256-GCM') {
    throw new Error('This encrypted file was written by a newer PowerStudio, or is damaged.');
  }
  const k = await key(derive, passphrase, sealed.kdf);
  try {
    const text = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(sealed.cipher.iv), additionalData: additional(sealed) }, k, fromBase64(sealed.data));
    return new TextDecoder().decode(text);
  } catch {
    throw new Error('The passphrase is not right, or the file has been changed since it was written.');
  }
}
