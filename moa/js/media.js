/* ============================================================
   Moa — reading picked files in the browser
   Hash (dedupe), metadata (EXIF via exifr, QuickTime atoms for
   .mov/.mp4), Live Photo pairing, and JPEG preview/thumbnail
   renditions drawn on a canvas. HEIC decodes natively on Safari
   (iPhone, Mac). No third-party decoder is loaded: the page holds
   a GitHub token, so it runs no eval-based code (see vercel.json CSP).
   ============================================================ */

import { kindOf, extOf, metaFromExif, parseQuickTime, metaFromQuickTime, pairLivePhotos, tsOf, localISO, localTz } from './core.js';

export const MAX_FILE = 95 * 1024 * 1024; // GitHub enforces 100 MB per object; keep headroom for the API upload

async function sha256(buf) {
  if (!crypto.subtle) return null;
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function mimeOf(file) {
  if (file.type) return file.type;
  return ({ heic: 'image/heic', heif: 'image/heif', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', mov: 'video/quicktime', mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm' })[extOf(file.name)] || 'application/octet-stream';
}

/** Read one picked file → { key, file, name, kind, mime, size, hash, meta } */
export async function analyzeFile(file, key) {
  const mime = mimeOf(file);
  const kind = kindOf(file.name, mime);
  const item = { key, file, name: file.name, kind, mime, size: file.size, meta: {}, error: null };
  if (!kind) { item.error = '지원하지 않는 형식'; return item; }
  if (file.size > MAX_FILE) { item.error = '100MB 초과 (GitHub 제한)'; item.tooBig = true; return item; }
  const buf = await file.arrayBuffer();
  item.hash = await sha256(buf);
  try {
    if (kind === 'photo') {
      const x = await globalThis.exifr?.parse(buf, { tiff: true, exif: true, gps: true, makerNote: true, reviveValues: false, translateValues: false, xmp: false, icc: false, iptc: false, jfif: false });
      item.meta = metaFromExif(x);
    } else {
      item.meta = metaFromQuickTime(parseQuickTime(buf));
    }
  } catch (e) {
    console.warn('metadata', file.name, e);
  }
  if (!item.meta.takenAt) {
    // no embedded date: fall back to the file's modified time
    const d = new Date(file.lastModified || Date.now());
    Object.assign(item.meta, { takenAt: localISO(d), tz: localTz(d), dateSource: 'file' });
  }
  item.meta.ts = tsOf(item.meta.takenAt, item.meta.tz);
  return item;
}

/** Group analyzed items into upload entries, attaching Live Photo videos to their stills. */
export function buildEntries(items) {
  const ok = items.filter(i => !i.error);
  // file-modified times are not capture times, so they never drive time-based pairing
  const pairs = pairLivePhotos(ok.map(i => ({ key: i.key, kind: i.kind, name: i.name, contentId: i.meta.contentId, ts: i.meta.dateSource === 'file' ? null : i.meta.ts, duration: i.meta.duration })));
  const byKey = new Map(ok.map(i => [i.key, i]));
  const livesUsed = new Set(pairs.values());
  const entries = [];
  for (const i of items) {
    if (livesUsed.has(i.key)) continue;
    const e = { main: i, live: null };
    if (pairs.has(i.key)) {
      e.live = byKey.get(pairs.get(i.key));
      // a Live Photo still sometimes lacks GPS the video has
      if (!i.meta.gps && e.live.meta.gps) i.meta.gps = e.live.meta.gps;
    }
    entries.push(e);
  }
  return entries;
}

// ---------------- decoding ----------------

function loadImg(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => resolve({ src: img, w: img.naturalWidth, h: img.naturalHeight, done: () => URL.revokeObjectURL(url) });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode')); };
    img.src = url;
  });
}

async function decodeImage(file, mime) {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    return { src: bmp, w: bmp.width, h: bmp.height, done: () => bmp.close() };
  } catch { /* fall through */ }
  try { return await loadImg(file); } catch { /* fall through */ }
  if (/hei[cf]/.test(mime) || /\.hei[cf]$/i.test(file.name)) throw new Error('이 브라우저는 HEIC를 열 수 없어요 — 아이폰·맥의 Safari에서 올리거나 JPEG로 바꿔 주세요');
  throw new Error('이미지를 열 수 없어요');
}

function frameOfVideo(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    const fail = () => { cleanup(); reject(new Error('video decode')); };
    const timer = setTimeout(fail, 10000);
    const cleanup = () => { clearTimeout(timer); v.removeAttribute('src'); v.load(); URL.revokeObjectURL(url); };
    v.onerror = fail;
    v.onloadedmetadata = () => { v.currentTime = Math.min(0.5, (v.duration || 1) / 3); };
    v.onseeked = () => {
      const res = { src: v, w: v.videoWidth, h: v.videoHeight, duration: v.duration, done: cleanup };
      if (!res.w) return fail();
      clearTimeout(timer);
      resolve(res);
    };
    v.src = url;
  });
}

function toJpeg(src, sw, sh, scale, quality) {
  const w = Math.max(1, Math.round(sw * scale)), h = Math.max(1, Math.round(sh * scale));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, w, h);
  return new Promise((resolve, reject) => c.toBlob(b => b ? resolve(b) : reject(new Error('encode')), 'image/jpeg', quality));
}

/**
 * JPEG renditions. Preview: long side ≤ 2048. Thumb: short side ≈ 400
 * (grid tiles crop to squares). Videos get a poster frame as both.
 */
export async function makeRenditions(item) {
  const d = item.kind === 'video' ? await frameOfVideo(item.file) : await decodeImage(item.file, item.mime);
  try {
    const long = Math.max(d.w, d.h), short = Math.min(d.w, d.h);
    const preview = await toJpeg(d.src, d.w, d.h, Math.min(1, 2048 / long), 0.84);
    const thumb = await toJpeg(d.src, d.w, d.h, Math.min(1, 400 / short, 1000 / long), 0.78);
    return { preview, thumb, w: d.w, h: d.h, duration: d.duration };
  } finally {
    d.done();
  }
}
