/* ============================================================
   Moa — optional album encryption (WebCrypto only, no library)
   One random 256-bit album key encrypts every file with AES-GCM.
   album.json keeps that key wrapped by a key derived from the album
   passphrase (PBKDF2-SHA-256), so a new passphrase rewraps 32 bytes
   instead of re-encrypting every photo.
   A second copy is wrapped by a random recovery code, so a lost
   passphrase isn't a lost album.
   Sealed file layout: "MOA1" | 12-byte IV | ciphertext + 16-byte tag.
   The unwrapped key stays on this device (IndexedDB, if asked). It is
   extractable so an unlocked device can set a new passphrase or put
   the key into an invite link.
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

const albumKey = raw => subtle.importKey('raw', raw, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
const rawOf = async key => new Uint8Array(await subtle.exportKey('raw', key));

async function wrap(raw, passphrase, iterations) {
  const salt = rand(16), iv = rand(12);
  const data = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, await passKey(passphrase, salt, iterations), raw));
  return { kdf: { name: 'PBKDF2-SHA-256', iterations, salt: b64(salt) }, wrapped: { iv: b64(iv), data: b64(data) } };
}

/** slot = { kdf, wrapped } — the header itself (passphrase) or header.recovery. */
async function unwrap(slot, secret) {
  try {
    const k = await passKey(secret, unb64(slot.kdf.salt), slot.kdf.iterations);
    return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: unb64(slot.wrapped.iv) }, k, unb64(slot.wrapped.data)));
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

/** Same album key under a new passphrase (the recovery code keeps working). */
export async function rewrapAlbumKey(header, oldPassphrase, newPassphrase) {
  const raw = await unwrap(header, oldPassphrase);
  return { ...header, ...(await wrap(raw, newPassphrase, Math.max(header.kdf.iterations, KDF_ITERATIONS))) };
}

/** New passphrase from a device that already holds the key (forgot the old one). */
export async function setPassphrase(header, key, newPassphrase) {
  return { ...header, ...(await wrap(await rawOf(key), newPassphrase, KDF_ITERATIONS)) };
}

// ---------- recovery code: 120 random bits, Crockford base32, XXXX-XXXX-XXXX-XXXX-XXXX-XXXX ----------

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const RECOVERY_ITERATIONS = 20000; // the code itself carries the strength

export function newRecoveryCode() {
  const bytes = rand(15);
  let bits = 0, n = 0, out = '';
  for (const b of bytes) { n = (n << 8) | b; bits += 8; while (bits >= 5) { out += B32[(n >> (bits - 5)) & 31]; bits -= 5; } }
  return out.match(/.{4}/g).join('-');
}

/** Typed codes forgive case, spaces, dashes and the usual look-alikes (O→0, I/L→1). */
export function normalizeRecoveryCode(code) {
  const s = String(code).toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return s.length === 24 ? s.match(/.{4}/g).join('-') : s;
}

export async function withRecovery(header, key, code) {
  return { ...header, recovery: await wrap(await rawOf(key), normalizeRecoveryCode(code), RECOVERY_ITERATIONS) };
}

export const hasRecovery = header => !!header?.recovery;

export async function unlockWithRecovery(header, code) {
  if (!header.recovery) throw new BadPassphrase('no recovery code');
  return albumKey(await unwrap(header.recovery, normalizeRecoveryCode(code)));
}

// ---------- Face ID / Touch ID / fingerprint: a passkey slot (WebAuthn PRF) ----------
// A passkey made for this album gives back the same 32 secret bytes every time the person
// passes Face ID (the PRF extension), and those bytes wrap the album key like a passphrase
// would. The slots live in album.json next to the passphrase slot: iCloud Keychain / Google
// Password Manager sync the passkey, so the person's other devices open the album too.
// Only the person holding the passkey can use their slot; the passphrase and recovery code
// keep working.

export class NoPasskey extends Error {}

const b64url = u8 => b64(u8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = s => unb64(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));

/** Face ID / Touch ID / Windows Hello / fingerprint on this device, and a browser that speaks WebAuthn. */
export async function passkeyAvailable() {
  try {
    return !!globalThis.PublicKeyCredential && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch { return false; }
}

async function prfKey(secret) {
  const base = await subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode('moa album key v1') }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

const prfFirst = cred => {
  const r = cred?.getClientExtensionResults?.().prf?.results?.first;
  return r ? new Uint8Array(r) : null;
};

/** Ask for Face ID and the PRF secret of one of `ids` (credential ids as base64url). → { id, secret } */
async function prfGet(ids, salt) {
  let cred;
  try {
    cred = await navigator.credentials.get({ publicKey: {
      challenge: rand(32),
      allowCredentials: ids.map(id => ({ type: 'public-key', id: unb64url(id) })),
      userVerification: 'required',
      timeout: 120000,
      extensions: { prf: { eval: { first: unb64url(salt) } } },
    } });
  } catch (e) { throw new NoPasskey(e?.name === 'NotAllowedError' ? 'cancelled' : e?.message || 'failed'); }
  const secret = prfFirst(cred);
  if (!secret) throw new NoPasskey('prf unsupported');
  return { id: b64url(new Uint8Array(cred.rawId)), secret };
}

/**
 * Make a passkey for this album on this device and a slot for the header.
 * header.passkeys = { salt, slots: [{ id, label, by, at, wrapped }] } — one salt per album,
 * so one Face ID prompt can try every slot this device might hold.
 */
export async function addPasskey(header, key, { title = 'Moa', user = 'moa', label = '', by = '' } = {}) {
  const salt = header.passkeys?.salt || b64url(rand(32));
  let cred;
  try {
    cred = await navigator.credentials.create({ publicKey: {
      rp: { name: 'Moa' },
      user: { id: rand(16), name: user, displayName: `${title} · Moa` },
      challenge: rand(32),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'required', userVerification: 'required' },
      timeout: 120000,
      extensions: { prf: { eval: { first: unb64url(salt) } } },
    } });
  } catch (e) { throw new NoPasskey(e?.name === 'NotAllowedError' ? 'cancelled' : e?.message || 'failed'); }
  const id = b64url(new Uint8Array(cred.rawId));
  if (cred.getClientExtensionResults?.().prf?.enabled === false) throw new NoPasskey('prf unsupported');
  // some browsers only hand out the secret on sign-in, not at creation: ask once more
  const secret = prfFirst(cred) || (await prfGet([id], salt)).secret;
  const iv = rand(12);
  const data = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, await prfKey(secret), await rawOf(key)));
  const slot = { id, label, by, at: new Date().toISOString(), wrapped: { iv: b64(iv), data: b64(data) } };
  const slots = (header.passkeys?.slots || []).filter(x => x.id !== id);
  return { header: { ...header, passkeys: { salt, slots: [...slots, slot] } }, id };
}

export const passkeySlots = header => header?.passkeys?.slots || [];

export function removePasskey(header, id) {
  const slots = passkeySlots(header).filter(x => x.id !== id);
  const { passkeys, ...rest } = header;
  return slots.length ? { ...rest, passkeys: { ...passkeys, slots } } : rest;
}

/** Face ID → album key. Throws NoPasskey (cancelled, not on this device) or BadPassphrase (slot doesn't open). */
export async function unlockWithPasskey(header) {
  const slots = passkeySlots(header);
  if (!slots.length) throw new NoPasskey('none');
  const { id, secret } = await prfGet(slots.map(x => x.id), header.passkeys.salt);
  const slot = slots.find(x => x.id === id);
  if (!slot) throw new NoPasskey('unknown passkey');
  try {
    const raw = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: unb64(slot.wrapped.iv) }, await prfKey(secret), unb64(slot.wrapped.data)));
    return { key: await albumKey(raw), id };
  } catch { throw new BadPassphrase('passkey slot does not open'); }
}

// ---------- the key as text, for an invite link's #fragment ----------

export async function keyToText(key) {
  return b64(await rawOf(key)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function keyFromText(text) {
  const raw = unb64(String(text).replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));
  if (raw.length !== 32) throw new Error('bad key');
  return albumKey(raw);
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
