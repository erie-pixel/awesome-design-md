/* ============================================================
   Moa — GitHub repository limits
   Numbers from GitHub Docs "Repository limits":
     on-disk size 10 GB (recommended max) · single object 1 MB
     recommended / 100 MB enforced · 3,000 entries per directory ·
     directory depth 50 · push 2 GB enforced · 6 pushes/minute.
   Pure functions so the capacity math is unit-tested.
   ============================================================ */

export const MB = 1024 * 1024;
export const GB = 1024 * MB;

export const LIMITS = {
  repoSize: 10 * GB,
  objectRecommended: 1 * MB,
  objectHard: 100 * MB,
  apiUpload: 50 * MB,        // larger blobs go through base64 JSON and often time out
  dirEntries: 3000,
  dirDepth: 50,
  pushSize: 2 * GB,
  pushesPerMinute: 6,
};

// rendition size guesses until they're generated (2048px JPEG q.84, 400px thumb)
const EST_PREVIEW = 0.6 * MB;
const EST_THUMB = 0.06 * MB;

export function levelOf(ratio) {
  if (ratio >= 1) return 'over';
  if (ratio >= 0.95) return 'danger';
  if (ratio >= 0.8) return 'warn';
  return 'ok';
}

const sizeOf = p => Object.values(p.sizes || {}).reduce((a, b) => a + (b || 0), 0);

/**
 * Storage estimate. GitHub's own `size` (KB, .git on disk) includes
 * history and deleted photos but lags behind recent pushes; the index sum
 * is current but ignores history. The larger of the two is the honest one.
 */
export function usage({ repoKB = 0, photos = [] } = {}) {
  const content = photos.reduce((s, p) => s + sizeOf(p), 0);
  const repo = repoKB * 1024;
  const used = Math.max(repo, content);
  const breakdown = { original: 0, preview: 0, thumb: 0, live: 0 };
  for (const p of photos) for (const k of Object.keys(breakdown)) breakdown[k] += p.sizes?.[k] || 0;
  return {
    used, repo, content, breakdown,
    limit: LIMITS.repoSize,
    remaining: Math.max(0, LIMITS.repoSize - used),
    ratio: used / LIMITS.repoSize,
    level: levelOf(used / LIMITS.repoSize),
  };
}

const dirOf = path => path.slice(0, path.lastIndexOf('/'));

/** Entries per directory, from the file paths the index knows about. */
export function dirCounts(photos, extra = []) {
  const m = new Map();
  const add = path => { if (path) { const d = dirOf(path); m.set(d, (m.get(d) || 0) + 1); } };
  for (const p of photos) new Set(Object.values(p.files || {})).forEach(add);
  extra.forEach(add);
  return m;
}

export function busiestDir(counts) {
  let best = { dir: '', count: 0 };
  for (const [dir, count] of counts) if (count > best.count) best = { dir, count };
  return { ...best, ratio: best.count / LIMITS.dirEntries, level: levelOf(best.count / LIMITS.dirEntries) };
}

export function largestFile(photos) {
  let best = { name: '', size: 0 };
  for (const p of photos) for (const s of Object.values(p.sizes || {})) if (s > best.size) best = { name: p.name, size: s };
  return best;
}

/**
 * Estimate what an upload adds and which files break a rule.
 * entries: [{ main: { kind, size, name }, live?: { size }, skip? }]
 */
export function planUpload(entries, { keepOriginal = true, usage: u } = {}) {
  let bytes = 0, files = 0;
  const blocked = [], heavy = [], overRecommended = [];
  for (const e of entries) {
    if (e.skip) continue;
    const m = e.main;
    const parts = [];
    if (m.kind === 'video' || keepOriginal) parts.push(m.size);
    if (m.kind === 'photo') parts.push(Math.min(EST_PREVIEW, m.size));
    parts.push(EST_THUMB);
    if (e.live) parts.push(e.live.size);
    bytes += parts.reduce((a, b) => a + b, 0);
    files += parts.length;
    const biggest = Math.max(m.size, e.live?.size || 0);
    if (biggest >= LIMITS.objectHard) blocked.push(e);
    else if (biggest >= LIMITS.apiUpload) heavy.push(e);
    if ((m.kind === 'video' || keepOriginal) && m.size > LIMITS.objectRecommended) overRecommended.push(e);
  }
  const used = u?.used || 0;
  const after = used + bytes;
  return {
    bytes, files, blocked, heavy, overRecommended,
    after,
    remainingAfter: Math.max(0, LIMITS.repoSize - after),
    ratioBefore: used / LIMITS.repoSize,
    ratioAfter: after / LIMITS.repoSize,
    level: levelOf(after / LIMITS.repoSize),
  };
}

/** Rolling-window gate: at most `max` events per `windowMs`. Returns ms to wait. */
export function waitFor(times, now, max = LIMITS.pushesPerMinute, windowMs = 60000) {
  const recent = times.filter(t => now - t < windowMs);
  if (recent.length < max) return 0;
  return windowMs - (now - recent[recent.length - max]);
}
