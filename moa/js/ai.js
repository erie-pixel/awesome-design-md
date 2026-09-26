/* ============================================================
   Moa — on-device AI, page side
   Talks to js/ai-worker.js, keeps each photo's CLIP embedding in
   IndexedDB (this device only), turns embeddings into auto tags and
   ranks photos for a described search. Opt-in; wipe() removes the
   model cache and every embedding.
   ============================================================ */

import { LABELS, BACKGROUND, pickTags } from './ai-labels.js';

let worker = null, seq = 0;
const waiting = new Map();
let onProgress = null;

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./ai-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    if (data.type === 'progress') return onProgress?.(data.loaded, data.total);
    const w = waiting.get(data.id);
    if (!w) return;
    waiting.delete(data.id);
    data.error ? w.reject(new Error(data.error)) : w.resolve(data);
  };
  worker.onerror = e => { for (const w of waiting.values()) w.reject(new Error(e.message || 'AI worker failed')); waiting.clear(); worker = null; };
  return worker;
}

function call(type, payload = {}, transfer = []) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    ensureWorker().postMessage({ id, type, ...payload }, transfer);
  });
}

/** Download (first time) and load the model. progress(loaded, total) while downloading. */
export async function start(progress) {
  onProgress = progress;
  await call('init');
}

export function stop() {
  worker?.terminate();
  worker = null;
  for (const w of waiting.values()) w.reject(new Error('stopped'));
  waiting.clear();
}

/** Embedding of an image blob; scaled so its short side is 224px (what CLIP looks at). */
export async function embedImage(blob) {
  const bmp = await createImageBitmap(blob);
  const s = 224 / Math.min(bmp.width, bmp.height);
  const w = Math.max(1, Math.round(bmp.width * s)), h = Math.max(1, Math.round(bmp.height * s));
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const g = c.getContext('2d');
  g.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  const { data } = g.getImageData(0, 0, w, h);
  return (await call('image', { data: data.buffer, width: w, height: h }, [data.buffer])).vec;
}

export async function embedText(texts) {
  return (await call('text', { texts })).vecs;
}

let labelVecs = null;
async function labels() {
  if (!labelVecs) {
    const vecs = await embedText([...LABELS.map(l => l.prompt), ...BACKGROUND]);
    labelVecs = { labels: vecs.slice(0, LABELS.length), background: vecs.slice(LABELS.length) };
  }
  return labelVecs;
}

export async function tagsFor(vec) {
  const l = await labels();
  return pickTags(vec, l.labels, l.background);
}

/** Photos best matching a (English) description, best first. */
export async function rank(description, embeddings, { limit = 60 } = {}) {
  const [q] = await embedText([`a photo of ${description}`]);
  const scored = [];
  for (const [id, v] of embeddings) {
    let s = 0;
    for (let i = 0; i < v.length; i++) s += v[i] * q[i];
    scored.push({ id, s });
  }
  scored.sort((a, b) => b.s - a.s);
  const best = scored[0]?.s ?? 0;
  // CLIP ViT-B/32: related ≈ 0.25–0.33, unrelated ≈ 0.15–0.2 — nothing under 0.2, however "close"
  return scored.filter(x => x.s >= 0.24 || (x.s >= 0.2 && x.s >= best - 0.02)).slice(0, limit).map(x => x.id);
}

// ---------- embeddings on this device ----------
const DB = 'moa-ai', STORE = 'emb';

function db() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function loadEmbeddings(space) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const out = new Map(), prefix = space + '|';
    const req = d.transaction(STORE).objectStore(STORE).openCursor(IDBKeyRange.bound(prefix, prefix + '￿'));
    req.onsuccess = () => {
      const c = req.result;
      if (!c) { d.close(); return resolve(out); }
      out.set(String(c.key).slice(prefix.length), c.value);
      c.continue();
    };
    req.onerror = () => { d.close(); reject(req.error); };
  });
}

export async function saveEmbedding(space, id, vec) {
  const d = await db();
  await new Promise((resolve, reject) => {
    const t = d.transaction(STORE, 'readwrite');
    t.objectStore(STORE).put(vec, `${space}|${id}`);
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
  d.close();
}

/** Turning it off: the model, the embeddings and the worker all go. */
export async function wipe() {
  stop();
  labelVecs = null;
  await new Promise(r => { const q = indexedDB.deleteDatabase(DB); q.onsuccess = q.onerror = q.onblocked = () => r(); });
  if ('caches' in globalThis) await caches.delete('transformers-cache').catch(() => {});
}
