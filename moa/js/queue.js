/* ============================================================
   Moa — upload queue that survives the app being closed
   Picked files are copied into IndexedDB before uploading and removed
   once their commit lands, so an upload iOS suspended or killed picks
   up where it stopped the next time that album opens.
   ============================================================ */

const DB = 'moa-uploads', STORE = 'queue';

function db() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'qid' }).createIndex('space', 'space');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => { d.close(); resolve(out?.result ?? out); };
    t.onerror = t.onabort = () => { d.close(); reject(t.error); };
  });
}

// what preparePhoto needs from an analysed file; File objects are stored as-is
const pick = m => m && { key: m.key, file: m.file, name: m.name, kind: m.kind, mime: m.mime, size: m.size, hash: m.hash, meta: m.meta };

/** Save entries for an album; each gets e.qid. One transaction per entry keeps big batches from failing whole. */
export async function enqueue(space, entries, opts) {
  const at = Date.now();
  let i = 0;
  for (const e of entries) {
    const qid = `${space}|${at.toString(36)}|${i++}`;
    await tx('readwrite', s => s.put({ qid, space, at, opts, main: pick(e.main), live: pick(e.live) }));
    e.qid = qid;
  }
}

/** Entries still waiting for this album, oldest first, shaped like upload entries. */
export async function pending(space) {
  const rows = await tx('readonly', s => s.index('space').getAll(space));
  return rows.sort((a, b) => a.qid.localeCompare(b.qid, 'en', { numeric: true })).map(r => ({ qid: r.qid, opts: r.opts, main: r.main, live: r.live }));
}

export async function done(qids) {
  if (!qids.length) return;
  await tx('readwrite', s => { for (const q of qids) s.delete(q); });
}

export async function clearSpace(space) {
  const rows = await pending(space);
  await done(rows.map(r => r.qid));
}

export const clearAll = () => tx('readwrite', s => s.clear()).catch(() => {});
