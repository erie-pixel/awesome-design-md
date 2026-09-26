/* ============================================================
   Moa — pure logic (no DOM, no network)
   Index format, edit operations, grouping/sorting, metadata
   parsing (EXIF → photo fields, QuickTime atoms, Apple MakerNote)
   and Live Photo pairing. Shared by the app and the Node tests.
   ============================================================ */

import { labelWords } from './ai-labels.js';

export const INDEX_PATH = 'index.json';   // v1: everything in one file (read + migrated)
export const META_PATH = 'album.json';    // v2: title, members, albums
export const SHARD_DIR = 'index';         // v2: index/YYYY-MM.json, photos by capture month
export const SEALED_META = 'album.bin';   // encrypted album: sealed album.json body (album.json holds the wrapped key)
const SEALED_SHARDS = 32;                 // encrypted album: index/sNN.bin, bucketed by photo id so names reveal no dates
export const INDEX_VERSION = 2;

// ---------------- ids & small helpers ----------------

export function newId(now = Date.now()) {
  const rnd = new Uint8Array(4);
  globalThis.crypto.getRandomValues(rnd);
  return now.toString(36) + '-' + [...rnd].map(b => b.toString(36).padStart(2, '0')).join('').slice(0, 6);
}

export function normalizeTag(t) {
  return String(t || '').trim().replace(/^#+/, '').replace(/\s+/g, ' ').toLowerCase().slice(0, 40);
}

export function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

export function baseOf(name) {
  return String(name || '').replace(/\.[^.]+$/, '').toLowerCase();
}

const VIDEO_EXT = ['mov', 'mp4', 'm4v', 'webm', '3gp'];
const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'heic', 'heif', 'webp', 'gif', 'avif', 'dng', 'tif', 'tiff'];

export function kindOf(name, mime = '') {
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('image/')) return 'photo';
  const e = extOf(name);
  if (VIDEO_EXT.includes(e)) return 'video';
  if (IMAGE_EXT.includes(e)) return 'photo';
  return null;
}

// ---------------- index ----------------

export function emptyIndex(title = 'Our album') {
  return { app: 'moa', version: INDEX_VERSION, title, createdAt: new Date().toISOString(), members: {}, albums: {}, photos: {} };
}

function photosBody(photos) {
  const keys = Object.keys(photos).sort();
  return keys.length
    ? '{\n' + keys.map(k => `    ${JSON.stringify(k)}: ${JSON.stringify(photos[k])}`).join(',\n') + '\n  }'
    : '{}';
}

/** Readable, diff-friendly JSON: one photo per line. */
export function serializeIndex(ix) {
  const { photos = {}, ...rest } = ix;
  const head = JSON.stringify(rest, null, 2);
  return head.slice(0, -2) + `,\n  "photos": ${photosBody(photos)}\n}\n`;
}

/**
 * GitHub recommends single objects stay under 1 MB. One big index.json
 * crosses that at ~2,000 photos and is rewritten on every like, so v2
 * splits it: album.json for the small shared state plus one shard per
 * capture month. A commit only rewrites the shards it touched.
 */
export function shardOf(p) {
  const m = /^(\d{4})-(\d{2})/.exec(p.takenAt || p.uploadedAt || '');
  return `${SHARD_DIR}/${m ? `${m[1]}-${m[2]}` : 'undated'}.json`;
}

/** Shard for a photo in an encrypted album: a stable bucket of its id (FNV-1a). */
export function sealedShardOf(id) {
  let h = 0x811c9dc5;
  for (const c of String(id)) { h ^= c.charCodeAt(0); h = Math.imul(h, 0x01000193); }
  return `${SHARD_DIR}/s${String((h >>> 0) % SEALED_SHARDS).padStart(2, '0')}.bin`;
}

/** Opaque path for an encrypted file: data/ab/<30 hex>. 256 folders keep each far below 3,000 entries. */
export function sealedPath() {
  const r = new Uint8Array(16);
  globalThis.crypto.getRandomValues(r);
  const hex = [...r].map(b => b.toString(16).padStart(2, '0')).join('');
  return `data/${hex.slice(0, 2)}/${hex.slice(2)}`;
}

/** path → text for every index file. sealed: album.bin + index/sNN.bin (the caller encrypts them). */
export function splitIndex(ix, { sealed = false } = {}) {
  const { photos = {}, ...meta } = ix;
  const files = new Map([[sealed ? SEALED_META : META_PATH, JSON.stringify({ ...meta, version: INDEX_VERSION }, null, 2) + '\n']]);
  const shards = new Map();
  for (const [id, p] of Object.entries(photos)) {
    const k = sealed ? sealedShardOf(id) : shardOf(p);
    if (!shards.has(k)) shards.set(k, {});
    shards.get(k)[id] = p;
  }
  for (const k of [...shards.keys()].sort()) files.set(k, `{\n  "photos": ${photosBody(shards.get(k))}\n}\n`);
  return files;
}

export function joinIndex(metaText, shardTexts = []) {
  const meta = JSON.parse(metaText);
  if (!meta || meta.app !== 'moa') throw new Error('Not a Moa album.json');
  const ix = { ...meta, members: meta.members || {}, albums: meta.albums || {}, photos: {} };
  for (const t of shardTexts) Object.assign(ix.photos, JSON.parse(t).photos || {});
  return ix;
}

/** media/YYYY/MM/DD — day folders keep every directory far below GitHub's 3,000-entry guidance. */
export function mediaDir(takenAt) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(takenAt || '');
  if (m) return `${m[1]}/${m[2]}/${m[3]}`;
  const d = new Date();
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
}

export function parseIndex(text) {
  const ix = JSON.parse(text);
  if (!ix || ix.app !== 'moa') throw new Error('Not a Moa index.json');
  ix.members ||= {};
  ix.albums ||= {};
  ix.photos ||= {};
  return ix;
}

// ---------------- edit operations ----------------
// Every change is a small plain-object op. The client replays its
// pending ops on top of the freshest index before each commit, so two
// friends editing at once never clobber each other.

const EDITABLE = ['caption', 'takenAt', 'tz', 'ts', 'dateSource', 'gps', 'place'];
/** What a replacement file brings with it (the rest of the photo stays). */
export const REPLACED = ['kind', 'name', 'mime', 'size', 'hash', 'w', 'h', 'duration', 'files', 'liveMime', 'sizes', 'camera', 'contentId'];

function uniqPush(arr, v) { if (!arr.includes(v)) arr.push(v); }
function remove(arr, v) { const i = arr.indexOf(v); if (i >= 0) arr.splice(i, 1); }

export function applyOp(ix, op) {
  const P = ix.photos;
  const each = (ids, fn) => (ids || []).forEach(id => P[id] && fn(P[id]));
  switch (op.op) {
    case 'addPhotos': {
      const hashes = new Set(Object.values(P).map(p => p.hash).filter(Boolean));
      for (const p of op.photos) {
        if (P[p.id] || (p.hash && hashes.has(p.hash))) continue;
        P[p.id] = p;
        if (p.hash) hashes.add(p.hash);
      }
      break;
    }
    case 'updatePhoto':
      each([op.id], p => {
        for (const k of EDITABLE) if (k in op.set) {
          if (op.set[k] === null || op.set[k] === '') delete p[k]; else p[k] = op.set[k];
        }
      });
      break;
    case 'tag': {
      const t = normalizeTag(op.tag);
      if (!t) break;
      each(op.ids, p => { p.tags ||= []; op.on ? uniqPush(p.tags, t) : remove(p.tags, t); });
      break;
    }
    case 'like':
      each([op.id], p => { p.likes ||= []; op.on ? uniqPush(p.likes, op.user) : remove(p.likes, op.user); });
      break;
    case 'comment':
      each([op.id], p => { p.comments ||= []; if (!p.comments.some(c => c.id === op.comment.id)) p.comments.push(op.comment); });
      break;
    case 'uncomment':
      each([op.id], p => {
        p.comments = (p.comments || []).filter(c => c.id !== op.commentId);
        if (p.pinned === op.commentId) { delete p.pinned; delete p.caption; delete p.captionBy; }
      });
      break;
    case 'pinComment': // the caption is a pinned comment (null unpins; a legacy caption unpins the same way)
      each([op.id], p => {
        const c = op.commentId && (p.comments || []).find(x => x.id === op.commentId);
        if (c) { p.pinned = c.id; p.caption = c.text; p.captionBy = c.by; } else { delete p.pinned; delete p.caption; delete p.captionBy; }
      });
      break;
    case 'setLive': // the motion of a Live Photo, added after the still was uploaded
      each([op.id], p => {
        p.files = { ...p.files, live: op.path };
        p.liveMime = op.mime;
        p.sizes = { ...(p.sizes || {}), live: op.size };
      });
      break;
    case 'deletePhotos':
      for (const id of op.ids) {
        delete P[id];
        for (const a of Object.values(ix.albums)) if (a.cover === id) delete a.cover;
        if (ix.cover === id) delete ix.cover;
      }
      break;
    case 'trashPhotos': // recently deleted: hidden, files kept, gone for good after TRASH_DAYS
      each(op.ids, p => { p.trashedAt = op.at; p.trashedBy = op.by; });
      break;
    case 'restorePhotos':
      each(op.ids, p => { delete p.trashedAt; delete p.trashedBy; });
      break;
    case 'replacePhoto': // a new file in the same place: tags, albums, likes, comments and caption stay
      each([op.id], p => {
        for (const k of REPLACED) delete p[k];
        if ('gps' in op.set) delete p.place; // looked up again for the new location
        for (const [k, v] of Object.entries(op.set)) if (v != null && v !== '') p[k] = v;
        delete p.ai; delete p.aiv; // analysed again
        p.replacedAt = op.at;
        p.replacedBy = op.by;
      });
      break;
    case 'createAlbum':
      if (!ix.albums[op.album.id]) ix.albums[op.album.id] = op.album;
      break;
    case 'renameAlbum':
      if (ix.albums[op.id]) ix.albums[op.id].name = op.name;
      break;
    case 'deleteAlbum':
      delete ix.albums[op.id];
      Object.values(P).forEach(p => p.albums && remove(p.albums, op.id));
      break;
    case 'albumMembership':
      if (!ix.albums[op.album]) break;
      each(op.ids, p => { p.albums ||= []; op.on ? uniqPush(p.albums, op.album) : remove(p.albums, op.album); });
      break;
    case 'setCover': // no album: the main photo, shown for the whole album on the home screen
      if (!op.album) { if (op.photo) ix.cover = op.photo; else delete ix.cover; } else if (ix.albums[op.album]) ix.albums[op.album].cover = op.photo;
      break;
    case 'join':
      if (!ix.members[op.user]) ix.members[op.user] = { joinedAt: op.at };
      break;
    case 'setTitle':
      ix.title = op.title;
      break;
    case 'aiTags': // on-device AI's labels for one photo ([] = looked, found nothing)
      each([op.id], p => { p.ai = op.tags; p.aiv = op.v; });
      break;
    case 'aiClear':
      Object.values(P).forEach(p => { delete p.ai; delete p.aiv; });
      break;
  }
  return ix;
}

export function applyOps(ix, ops) { for (const op of ops) applyOp(ix, op); return ix; }

// ---------------- recently deleted ----------------

export const TRASH_DAYS = 30;
export const isTrashed = p => !!p?.trashedAt;
const DAY = 86400000;
/** Whole days left before a trashed photo is deleted for good (0 = due). */
export function trashDaysLeft(p, now = Date.now()) {
  const t = Date.parse(p.trashedAt);
  return Number.isFinite(t) ? Math.max(0, Math.ceil((t + TRASH_DAYS * DAY - now) / DAY)) : 0;
}
/** Trashed photos whose 30 days are up. */
export const trashDue = (list, now = Date.now()) => list.filter(p => isTrashed(p) && trashDaysLeft(p, now) === 0).map(p => p.id);

/** Repository paths a delete op should remove. */
export function filesOf(p) {
  return Object.entries(p.files || {}).filter(([k, v]) => v && !k.endsWith('Mime')).map(([, v]) => v).filter((v, i, a) => a.indexOf(v) === i);
}

/** Files `before` used that `after` doesn't (deleted or replaced photos). */
export function removedFiles(before, after) {
  const keep = new Set(Object.values(after?.photos || {}).flatMap(filesOf));
  return Object.values(before?.photos || {}).flatMap(filesOf).filter(f => !keep.has(f));
}

/** Repository paths a replace op should remove: the old files the new ones don't reuse. */
export function replacedFiles(ix, op) {
  const old = ix?.photos?.[op.id];
  if (!old) return [];
  const keep = new Set(Object.values(op.set?.files || {}));
  return filesOf(old).filter(f => !keep.has(f));
}

// ---------------- dates ----------------

const pad = n => String(n).padStart(2, '0');

/** "2026:09:24 14:03:22" → "2026-09-24T14:03:22" */
export function exifDateToISO(s) {
  if (!s || typeof s !== 'string') return null;
  const m = /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s.trim());
  if (!m || m[1] === '0000') return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
}

/** "+0900" / "+09:00" / "Z" → "+09:00" */
export function normalizeTz(s) {
  if (!s) return null;
  if (s === 'Z') return '+00:00';
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(String(s).trim());
  return m ? `${m[1]}${m[2]}:${m[3]}` : null;
}

export function tsOf(takenAt, tz) {
  const t = Date.parse(takenAt + (tz || ''));
  return Number.isFinite(t) ? t : null;
}

export function localISO(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function localTz(d) {
  const off = -d.getTimezoneOffset();
  const s = off >= 0 ? '+' : '-';
  return `${s}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

export function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

// ---------------- EXIF → photo fields ----------------

export function metaFromExif(x) {
  if (!x) return {};
  const out = {};
  const taken = exifDateToISO(x.DateTimeOriginal) || exifDateToISO(x.CreateDate) || exifDateToISO(x.DateTimeDigitized) || exifDateToISO(x.ModifyDate) || exifDateToISO(x.DateTime);
  if (taken) {
    out.takenAt = taken;
    out.tz = normalizeTz(x.OffsetTimeOriginal || x.OffsetTimeDigitized || x.OffsetTime);
    out.dateSource = 'exif';
  }
  const lat = Number(x.latitude), lng = Number(x.longitude);
  if (Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
    out.gps = { lat: round6(lat), lng: round6(lng) };
    const alt = Number(Array.isArray(x.GPSAltitude) ? x.GPSAltitude[0] : x.GPSAltitude);
    if (Number.isFinite(alt)) out.gps.alt = Math.round((x.GPSAltitudeRef === 1 ? -alt : alt) * 10) / 10;
  }
  const cam = {};
  if (x.Make) cam.make = String(x.Make).trim();
  if (x.Model) cam.model = String(x.Model).trim();
  if (x.LensModel) cam.lens = String(x.LensModel).trim();
  if (Object.keys(cam).length) out.camera = cam;
  if (x.makerNote) {
    const cid = appleContentId(x.makerNote);
    if (cid) out.contentId = cid;
  }
  return out;
}

const round6 = v => Math.round(v * 1e6) / 1e6;

/** Apple MakerNote ("Apple iOS\0" + IFD) → ContentIdentifier (tag 0x0011), the Live Photo pairing UUID. */
export function appleContentId(bytes) {
  try {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (u8.length < 16 || String.fromCharCode(...u8.subarray(0, 9)) !== 'Apple iOS') return null;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const le = u8[12] === 0x49; // "II" little endian, "MM" big endian
    const count = dv.getUint16(14, le);
    for (let i = 0; i < count; i++) {
      const e = 16 + i * 12;
      if (e + 12 > u8.length) break;
      const tag = dv.getUint16(e, le), type = dv.getUint16(e + 2, le), n = dv.getUint32(e + 4, le);
      if (tag !== 0x0011 || type !== 2) continue;
      const off = n <= 4 ? e + 8 : dv.getUint32(e + 8, le);
      if (off + n > u8.length) return null;
      return String.fromCharCode(...u8.subarray(off, off + n)).replace(/\0+$/, '') || null;
    }
  } catch { /* malformed makernote */ }
  return null;
}

// ---------------- QuickTime / MP4 ----------------

export function parseISO6709(s) {
  const m = /([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)?/.exec(s || '');
  if (!m) return null;
  const lat = parseFloat(m[1]), lng = parseFloat(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) return null;
  const g = { lat: round6(lat), lng: round6(lng) };
  if (m[3]) g.alt = Math.round(parseFloat(m[3]) * 10) / 10;
  return g;
}

const MAC_EPOCH = 2082844800; // seconds between 1904-01-01 and 1970-01-01
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'udta', 'meta', 'minf', 'stbl']);

function* atoms(dv, start, end) {
  let p = start;
  while (p + 8 <= end) {
    let size = dv.getUint32(p);
    const type = String.fromCharCode(dv.getUint8(p + 4), dv.getUint8(p + 5), dv.getUint8(p + 6), dv.getUint8(p + 7));
    let hdr = 8;
    if (size === 1) {
      if (p + 16 > end) return;
      size = Number(dv.getBigUint64(p + 8)); hdr = 16;
    } else if (size === 0) size = end - p;
    if (size < hdr || p + size > end) return;
    yield { type, start: p + hdr, end: p + size };
    p += size;
  }
}

const utf8 = (dv, a, b) => new TextDecoder().decode(new Uint8Array(dv.buffer, dv.byteOffset + a, b - a));

/**
 * Pull capture date, location, duration and the Apple content
 * identifier out of a .mov/.mp4 buffer (moov/mvhd + moov/meta keys/ilst).
 */
export function parseQuickTime(buf) {
  const dv = buf instanceof DataView ? buf : new DataView(buf.buffer ? buf.buffer : buf, buf.byteOffset || 0, buf.byteLength);
  const out = {};
  const keys = [];
  const meta = {};

  const walk = (s, e, parent) => {
    for (const a of atoms(dv, s, e)) {
      if (a.type === 'mvhd' && parent === 'moov') {
        const v = dv.getUint8(a.start);
        let created, scale, dur;
        if (v === 1) {
          created = Number(dv.getBigUint64(a.start + 4));
          scale = dv.getUint32(a.start + 20);
          dur = Number(dv.getBigUint64(a.start + 24));
        } else {
          created = dv.getUint32(a.start + 4);
          scale = dv.getUint32(a.start + 12);
          dur = dv.getUint32(a.start + 16);
        }
        if (created > MAC_EPOCH) out.createdUtc = (created - MAC_EPOCH) * 1000;
        if (scale) out.duration = Math.round((dur / scale) * 100) / 100;
      } else if (a.type === 'keys') {
        const n = dv.getUint32(a.start + 4);
        let p = a.start + 8;
        for (let i = 0; i < n && p + 8 <= a.end; i++) {
          const sz = dv.getUint32(p);
          if (sz < 8) break;
          keys.push(utf8(dv, p + 8, p + sz));
          p += sz;
        }
      } else if (a.type === 'ilst') {
        for (const item of atoms(dv, a.start, a.end)) {
          const idx = dv.getUint32(item.start - 4); // item type = 1-based key index
          for (const d of atoms(dv, item.start, item.end)) {
            if (d.type !== 'data') continue;
            const key = keys[idx - 1];
            if (key) meta[key] = utf8(dv, d.start + 8, d.end);
          }
        }
      } else if (a.type === '©xyz' && parent === 'udta') {
        const len = dv.getUint16(a.start);
        out.location ||= parseISO6709(utf8(dv, a.start + 4, Math.min(a.end, a.start + 4 + len)));
      } else if (CONTAINERS.has(a.type)) {
        let s2 = a.start;
        // ISO 'meta' is a full box (4 bytes version/flags); QuickTime 'meta' is not.
        if (a.type === 'meta' && a.start + 8 <= a.end) {
          const t = String.fromCharCode(dv.getUint8(a.start + 4), dv.getUint8(a.start + 5), dv.getUint8(a.start + 6), dv.getUint8(a.start + 7));
          if (t !== 'hdlr' && dv.getUint32(a.start) === 0) s2 += 4;
        }
        walk(s2, a.end, a.type);
      }
    }
  };
  try { walk(0, dv.byteLength, null); } catch { /* truncated file */ }

  const cd = meta['com.apple.quicktime.creationdate'];
  const m = cd && /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?([+-]\d{2}:?\d{2}|Z)?/.exec(cd);
  if (m) { out.takenAt = m[1]; out.tz = normalizeTz(m[2]); }
  if (meta['com.apple.quicktime.location.ISO6709']) out.location = parseISO6709(meta['com.apple.quicktime.location.ISO6709']) || out.location;
  if (meta['com.apple.quicktime.content.identifier']) out.contentId = meta['com.apple.quicktime.content.identifier'];
  if (meta['com.apple.quicktime.make']) out.make = meta['com.apple.quicktime.make'];
  if (meta['com.apple.quicktime.model']) out.model = meta['com.apple.quicktime.model'];
  return out;
}

export function metaFromQuickTime(q, tz) {
  const out = {};
  if (q.takenAt) {
    out.takenAt = q.takenAt; out.tz = q.tz; out.dateSource = 'video';
  } else if (q.createdUtc) {
    // mvhd is UTC: express in the viewer's local zone
    const d = new Date(q.createdUtc);
    out.takenAt = localISO(d); out.tz = tz || localTz(d); out.dateSource = 'video';
  }
  if (q.location) out.gps = q.location;
  if (q.duration) out.duration = q.duration;
  if (q.contentId) out.contentId = q.contentId;
  if (q.make || q.model) out.camera = { ...(q.make && { make: q.make }), ...(q.model && { model: q.model }) };
  return out;
}

// ---------------- Live Photo pairing ----------------

/**
 * items: [{ key, kind: 'photo'|'video', name, contentId?, ts?, duration? }]
 * Pairs a short video with its still by (1) Apple content identifier,
 * (2) identical file base name (IMG_1234.HEIC + IMG_1234.MOV),
 * (3) capture time within 1.5s. Returns Map(photoKey → videoKey).
 */
export function pairLivePhotos(items) {
  const photos = items.filter(i => i.kind === 'photo');
  const videos = items.filter(i => i.kind === 'video' && !(i.duration > 6));
  const pairs = new Map();
  const used = new Set();
  const take = (p, v) => { pairs.set(p.key, v.key); used.add(v.key); };

  for (const p of photos) {
    if (!p.contentId) continue;
    const v = videos.find(v => !used.has(v.key) && v.contentId === p.contentId);
    if (v) take(p, v);
  }
  for (const p of photos) {
    if (pairs.has(p.key)) continue;
    const v = videos.find(v => !used.has(v.key) && baseOf(v.name) === baseOf(p.name) && (!p.contentId || !v.contentId));
    if (v) take(p, v);
  }
  for (const p of photos) {
    if (pairs.has(p.key) || p.ts == null || p.contentId) continue;
    const v = videos.find(v => !used.has(v.key) && v.ts != null && !v.contentId && Math.abs(v.ts - p.ts) <= 1500);
    if (v) take(p, v);
  }
  return pairs;
}

// ---------------- places ----------------

export function placeFromNominatim(j) {
  if (!j || !j.address) return null;
  const a = j.address;
  const city = a.city || a.town || a.village || a.municipality || a.county || a.state || a.province || a.region || '';
  const district = a.borough || a.city_district || a.district || a.suburb || (a.county && a.county !== city ? a.county : '') || '';
  const place = {
    country: a.country || '',
    cc: (a.country_code || '').toLowerCase(),
    region: a.state || a.province || '',
    city,
    district: district !== city ? district : '',
    name: j.name && j.name !== city && j.name !== district ? j.name : '',
  };
  place.label = [place.city, place.district].filter(Boolean).join(' ') || place.country || j.display_name || '';
  return place;
}

export function placeKey(place, level = 'city') {
  if (!place) return '';
  if (level === 'country') return place.country || place.label;
  if (level === 'district') return [place.country, place.city, place.district].filter(Boolean).join(' · ');
  return [place.country, place.city].filter(Boolean).join(' · ') || place.label;
}

export function placeTitle(place, level = 'city') {
  if (!place) return '';
  if (level === 'country') return place.country || place.label;
  if (level === 'district') return [place.city, place.district].filter(Boolean).join(' ') || place.label;
  return place.city || place.label;
}

// ---------------- filtering & grouping ----------------

export const sortTs = p => p.ts ?? (Date.parse(p.uploadedAt) || 0);

export function filterPhotos(list, { album, tag, kind, q, ai, area, month } = {}) {
  const query = (q || '').trim().toLowerCase();
  return list.filter(p => {
    if (album && !(p.albums || []).includes(album)) return false;
    if (area && !inArea(p.gps, area)) return false;
    if (month && monthOf(p) !== month) return false;
    if (tag && !(p.tags || []).includes(tag)) return false;
    if (ai && !(p.ai || []).includes(ai)) return false;
    if (kind === 'live' && !p.files?.live) return false;
    if (kind === 'video' && p.kind !== 'video') return false;
    if (kind === 'photo' && p.kind === 'video') return false;
    if (kind === 'fav' && !(p.likes || []).length) return false;
    if (query) {
      const hay = [p.name, p.caption, p.by, p.place?.label, p.place?.name, p.place?.country, p.place?.region, ...(p.tags || []), ...(p.ai || []).flatMap(labelWords), p.camera?.model].filter(Boolean).join(' ').toLowerCase();
      if (!query.split(/\s+/).every(w => hay.includes(w.replace(/^#/, '')))) return false;
    }
    return true;
  });
}

/** Day groups, newest first (or oldest). Each group carries its month for section headers; the UI formats titles. */
export function groupByDate(list, order = 'desc') {
  const dir = order === 'asc' ? 1 : -1;
  const sorted = [...list].sort((a, b) => dir * (sortTs(a) - sortTs(b)));
  const groups = [];
  let cur = null;
  for (const p of sorted) {
    const day = (p.takenAt || p.uploadedAt || '').slice(0, 10);
    if (!cur || cur.key !== day) {
      cur = { key: day, month: day.slice(0, 7), photos: [] };
      groups.push(cur);
    }
    cur.photos.push(p);
  }
  return groups;
}

export function groupByPlace(list, { level = 'city', order = 'recent' } = {}) {
  const map = new Map();
  const none = { key: '', title: '', photos: [], none: true };
  for (const p of list) {
    const key = p.place ? placeKey(p.place, level) : '';
    if (!key) { none.photos.push(p); continue; }
    if (!map.has(key)) map.set(key, { key, title: placeTitle(p.place, level), subtitle: level === 'country' ? '' : [p.place.region !== p.place.city && p.place.region, p.place.country].filter(Boolean).join(', '), photos: [] });
    map.get(key).photos.push(p);
  }
  const groups = [...map.values()];
  for (const g of groups) {
    g.photos.sort((a, b) => sortTs(b) - sortTs(a));
    g.latest = sortTs(g.photos[0]);
    const pts = g.photos.filter(p => p.gps);
    if (pts.length) g.center = { lat: pts.reduce((s, p) => s + p.gps.lat, 0) / pts.length, lng: pts.reduce((s, p) => s + p.gps.lng, 0) / pts.length };
    const days = g.photos.map(p => (p.takenAt || '').slice(0, 10)).filter(Boolean).sort();
    if (days.length) g.range = [days[0], days[days.length - 1]];
  }
  if (order === 'count') groups.sort((a, b) => b.photos.length - a.photos.length || b.latest - a.latest);
  else if (order === 'name') groups.sort((a, b) => a.title.localeCompare(b.title, 'ko'));
  else groups.sort((a, b) => b.latest - a.latest);
  none.photos.sort((a, b) => sortTs(b) - sortTs(a));
  if (none.photos.length) groups.push(none);
  return groups;
}

export function groupByTag(list) {
  const map = new Map();
  const none = { key: '', title: '', photos: [], none: true };
  for (const p of list) {
    const tags = p.tags || [];
    if (!tags.length) { none.photos.push(p); continue; }
    for (const t of tags) {
      if (!map.has(t)) map.set(t, { key: t, title: isSymbolTag(t) ? t : '#' + t, photos: [] });
      map.get(t).photos.push(p);
    }
  }
  const groups = [...map.values()].sort((a, b) => b.photos.length - a.photos.length || a.key.localeCompare(b.key, 'ko'));
  for (const g of groups) g.photos.sort((a, b) => sortTs(b) - sortTs(a));
  none.photos.sort((a, b) => sortTs(b) - sortTs(a));
  if (none.photos.length) groups.push(none);
  return groups;
}

/** [key, count] for auto tags, most common first. */
export function aiTagCounts(list) {
  const m = new Map();
  for (const p of list) for (const k of p.ai || []) m.set(k, (m.get(k) || 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]);
}

// ---------------- symbol tags: one-tap marks, like the ♥ ----------------

export const SYMBOLS = [
  { s: '⭐', w: ['star', 'best', 'favorite', 'fav', '별', '베스트', '최고', '즐겨찾기', '인생샷'] },
  { s: '📌', w: ['pin', 'important', 'keep', '중요', '고정', '핀'] },
  { s: '✈️', w: ['travel', 'trip', 'flight', 'vacation', '여행', '비행', '해외', '휴가'] },
  { s: '🍽️', w: ['food', 'meal', 'dinner', 'lunch', 'restaurant', '음식', '맛집', '식사', '저녁', '점심'] },
  { s: '🎉', w: ['party', 'celebrate', 'birthday', 'anniversary', '파티', '축하', '생일', '기념'] },
  { s: '💝', w: ['love', 'couple', 'date', '사랑', '커플', '데이트'] },
  { s: '🐾', w: ['pet', 'dog', 'cat', 'puppy', '반려', '강아지', '고양이', '댕댕'] },
  { s: '🌿', w: ['nature', 'hike', 'walk', 'camping', '자연', '산책', '등산', '캠핑'] },
  { s: '👶', w: ['baby', 'kid', 'child', '아기', '아이', '육아'] },
  { s: '🏠', w: ['home', 'house', '집', '우리집'] },
  { s: '🎵', w: ['music', 'concert', 'festival', '음악', '공연', '콘서트', '페스티벌'] },
  { s: '🔖', w: ['later', 'todo', 'print', '나중', '인화', '할일'] },
];

/** A tag made only of symbols or emoji (no letters or digits): shown as a mark, without "#". */
export const isSymbolTag = t => !!t && /^[^\p{L}\p{N}\s]+$/u.test(t) && [...t].length <= 8;

/** Marks to offer in one tap: the ones this album already uses first, then the defaults. */
export function quickSymbols(list, n = 8) {
  const used = tagCounts(list).map(([t]) => t).filter(isSymbolTag);
  return [...new Set([...used, ...SYMBOLS.map(x => x.s)])].slice(0, n);
}

/** While typing a tag: marks whose words fit what's typed, then existing tags that contain it. */
export function suggestTags(input, existing = [], limit = 8) {
  const q = normalizeTag(input);
  if (!q) return [];
  const out = [];
  for (const { s, w } of SYMBOLS) if (w.some(x => x.startsWith(q) || (x.length > 1 && q.startsWith(x)))) out.push(s);
  for (const t of existing) if (t !== q && t.includes(q) && !out.includes(t)) out.push(t);
  return out.slice(0, limit);
}

// ---------------- map area, month ----------------

export const monthOf = p => (p.takenAt || p.uploadedAt || '').slice(0, 7);

/** area = { s, w, n, e } in degrees; w > e crosses the date line. */
export function inArea(g, a) {
  if (!g || g.lat < a.s || g.lat > a.n) return false;
  return a.w <= a.e ? g.lng >= a.w && g.lng <= a.e : g.lng >= a.w || g.lng <= a.e;
}

/** Name for a set of photos' places: the most common city, "+n" for the rest. */
export function areaName(list) {
  const m = new Map();
  for (const p of list) { const k = p.place && placeTitle(p.place); if (k) m.set(k, (m.get(k) || 0) + 1); }
  const top = [...m].sort((a, b) => b[1] - a[1]);
  return top.length ? { name: top[0][0], more: top.length - 1 } : null;
}

// ---------------- statistics ----------------

/** Counts for the stats page. Dates are capture time as the camera recorded it. */
export function photoStats(list) {
  const months = new Map(), people = new Map(), places = new Map();
  const weekdays = Array(7).fill(0), hours = Array(24).fill(0);
  let videos = 0, lives = 0, located = 0, undated = 0;
  for (const p of list) {
    if (p.kind === 'video') videos++;
    if (p.files?.live) lives++;
    if (p.gps) located++;
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})/.exec(p.takenAt || '');
    if (m) {
      const k = `${m[1]}-${m[2]}`;
      months.set(k, (months.get(k) || 0) + 1);
      weekdays[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()]++;
      hours[+m[4]]++;
    } else undated++;
    if (p.by) people.set(p.by, (people.get(p.by) || 0) + 1);
    if (p.place) {
      const k = placeKey(p.place);
      if (k) { const e = places.get(k) || { key: k, title: placeTitle(p.place), country: p.place.country || '', n: 0 }; e.n++; places.set(k, e); }
    }
  }
  const years = [...new Set([...months.keys()].map(k => k.slice(0, 4)))].sort();
  const byYear = years.map(y => ({ year: y, total: 0, months: Array.from({ length: 12 }, (_, i) => { const n = months.get(`${y}-${pad(i + 1)}`) || 0; return n; }) }));
  for (const y of byYear) y.total = y.months.reduce((a, b) => a + b, 0);
  const sorted = m => [...m].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
  return {
    total: list.length, photos: list.length - videos, videos, lives, located, undated,
    bytes: storageBytes(list), years: byYear,
    busiest: sorted(months)[0] || null,
    people: sorted(people), places: [...places.values()].sort((a, b) => b.n - a.n), tags: tagCounts(list),
    weekdays, hours,
  };
}

export function tagCounts(list) {
  const m = new Map();
  for (const p of list) for (const t of p.tags || []) m.set(t, (m.get(t) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ko'));
}

export function storageBytes(list) {
  return list.reduce((s, p) => s + Object.values(p.sizes || {}).reduce((a, b) => a + (b || 0), 0), 0);
}

/**
 * Marker clustering by distance in pixel space. project: ({lat,lng}) → {x,y}.
 * Each photo joins the nearest group started within `radius` px, else starts its own
 * (newest photos start groups, so pins don't jump around as older ones load).
 * Unlike a fixed grid, two photos a few pixels apart never split just because a cell
 * border happens to run between them. A coarse grid of seeds keeps it near O(n).
 */
export function clusterPoints(list, project, radius = 64) {
  const pts = list.filter(p => p.gps).map(p => ({ p, ...project(p.gps) }));
  pts.sort((a, b) => sortTs(b.p) - sortTs(a.p));
  const groups = [], seeds = new Map(), r2 = radius * radius;
  for (const q of pts) {
    const cx = Math.floor(q.x / radius), cy = Math.floor(q.y / radius);
    let best = null, bd = r2;
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      for (const g of seeds.get(`${cx + i}:${cy + j}`) || []) {
        const d = (g.x - q.x) ** 2 + (g.y - q.y) ** 2;
        if (d <= bd) { bd = d; best = g; }
      }
    }
    if (!best) {
      best = { x: q.x, y: q.y, photos: [], lat: 0, lng: 0 };
      groups.push(best);
      const k = `${cx}:${cy}`;
      if (!seeds.has(k)) seeds.set(k, []);
      seeds.get(k).push(best);
    }
    best.photos.push(q.p);
    best.lat += q.p.gps.lat;
    best.lng += q.p.gps.lng;
  }
  return groups.map(g => ({ lat: g.lat / g.photos.length, lng: g.lng / g.photos.length, photos: g.photos }));
}
