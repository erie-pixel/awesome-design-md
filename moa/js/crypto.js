/* ============================================================
   Moa — optional album encryption (WebCrypto only, no library)
   One random 256-bit album key encrypts every file with AES-GCM.
   album.json keeps that key wrapped by a key derived from the album
   passphrase (PBKDF2-SHA-256), so a new passphrase rewraps 32 bytes
   instead of re-encrypting every photo.
   Sealed file layout: "MOA1" | 12-byte IV | ciphertext + 16-byte tag.
   The unwrapped key never leaves this device: it is imported as
   non-extractable and, if asked, remembered in IndexedDB.
   ============================================================ */

const subtle = globalThis.crypto.subtle;
const MAGIC = new Uint8Array([0x4d, 0x4f, 0x41, 0x31]); // "MOA1"
const HEAD = MAGIC.length + 12;
export const KDF_ITERATIONS = 600000; // OWASP 2023 guidance for PBKDF2-HMAC-SHA256
export const HEADER_KIND = 'moa-encrypted-album';

export class BadPassphrase extends Error {}

const rand = n => globalThis.crypto.getRandomValues(new Uint8Array(n));
const enc = new TextEncoder();

function b64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function unb64(s) {
  const bin = atob(s);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

async function passKey(passphrase, salt, iterations) {
  const base = await subtle.importKey('raw', enc.encode(String(passphrase).normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

const albumKey = raw => subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);

async function wrap(raw, passphrase, iterations) {
  const salt = rand(16), iv = rand(12);
  const data = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, await passKey(passphrase, salt, iterations), raw));
  return { kdf: { name: 'PBKDF2-SHA-256', iterations, salt: b64(salt) }, wrapped: { iv: b64(iv), data: b64(data) } };
}

async function unwrap(header, passphrase) {
  try {
    const k = await passKey(passphrase, unb64(header.kdf.salt), header.kdf.iterations);
    return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: unb64(header.wrapped.iv) }, k, unb64(header.wrapped.data)));
  } catch {
    throw new BadPassphrase('bad passphrase');
  }
}

/** album.json of an encrypted album. No "app" field on purpose: older Moa builds refuse it instead of overwriting it. */
export function isHeader(doc) { return doc?.kind === HEADER_KIND && doc.v === 1; }

/** New album key for a passphrase → { header (for album.json), key (CryptoKey) }. */
export async function createAlbumKey(passphrase, { iterations = KDF_ITERATIONS } = {}) {
  const raw = rand(32);
  const header = { kind: HEADER_KIND, v: 1, cipher: 'AES-256-GCM', ...(await wrap(raw, passphrase, iterations)) };
  return { header, key: await albumKey(raw) };
}

export async function unlockAlbumKey(header, passphrase) {
  return albumKey(await unwrap(header, passphrase));
}

/** Same album key under a new passphrase. */
export async function rewrapAlbumKey(header, oldPassphrase, newPassphrase) {
  const raw = await unwrap(header, oldPassphrase);
  return { ...header, ...(await wrap(raw, newPassphrase, Math.max(header.kdf.iterations, KDF_ITERATIONS))) };
}

export function isSealed(u8) {
  return u8.length >= HEAD + 16 && MAGIC.every((b, i) => u8[i] === b);
}

/** [header, ciphertext] — hand both to a Blob to avoid copying large videos. */
export async function sealParts(key, data) {
  const iv = rand(12);
  const head = new Uint8Array(HEAD);
  head.set(MAGIC);
  head.set(iv, MAGIC.length);
  return [head, new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, data))];
}

export async function seal(key, data) {
  const [head, body] = await sealParts(key, data);
  const out = new Uint8Array(head.length + body.length);
  out.set(head);
  out.set(body, head.length);
  return out;
}

/** Decrypt a sealed file; throws on a wrong key or a tampered file. */
export async function open(key, u8) {
  if (!isSealed(u8)) throw new Error('not an encrypted Moa file');
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: u8.subarray(MAGIC.length, HEAD) }, key, u8.subarray(HEAD)));
}

// ---------- remembered keys (IndexedDB stores CryptoKey objects as-is) ----------

const DB = 'moa-keys', STORE = 'keys';

function db() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => { d.close(); resolve(req.result); };
    t.onerror = t.onabort = () => { d.close(); reject(t.error); };
  });
}

export const rememberKey = (id, key) => tx('readwrite', s => s.put(key, id)).catch(() => {});
export const recallKey = id => tx('readonly', s => s.get(id)).then(k => k || null, () => null);
export const forgetKey = id => tx('readwrite', s => s.delete(id)).catch(() => {});
export const forgetAllKeys = () => tx('readwrite', s => s.clear()).catch(() => {});
