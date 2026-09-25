/* ============================================================
   Moa — GitHub storage layer
   A private repository is the photo library:
     album.json                      title, members, albums
     index/YYYY-MM.json              photo metadata, one shard per month
     media/YYYY/MM/DD/<id>.<ext>     originals (+ <id>.live.mov for Live Photos)
     preview/YYYY/MM/DD/<id>.jpg     ~2048px JPEG for any browser
     thumb/YYYY/MM/DD/<id>.jpg       grid thumbnail
   Writes go through the Git Data API so one upload batch (files +
   touched index shards) lands as a single commit; a non-fast-forward
   ref update means a friend committed first, so we re-read and replay.
   Ref updates are paced to GitHub's 6-pushes-per-minute guidance.
   ============================================================ */

import { INDEX_PATH, META_PATH, SHARD_DIR, parseIndex, joinIndex, splitIndex, emptyIndex, applyOps, filesOf } from './core.js';
import { waitFor } from './limits.js';

const MEDIA_CACHE = 'moa-media-v1';
const sleep = ms => new Promise(r => setTimeout(r, ms));

export class GitHubError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

export function textToBase64(text) {
  return bytesToBase64(new TextEncoder().encode(text));
}

export function bytesToBase64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).slice(String(r.result).indexOf(',') + 1));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

const encPath = p => p.split('/').map(encodeURIComponent).join('/');

export class Repo {
  constructor({ owner, repo, token, branch, api }) {
    this.owner = owner;
    this.repo = repo;
    this.token = token;
    this.branch = branch || null;
    this.api = (api || 'https://api.github.com').replace(/\/+$/, '');
    this.onWait = null;     // (seconds) => void, API rate-limit notice
    this.onThrottle = null; // (seconds) => void, push-rate pacing notice
    this.pushTimes = [];
    this._inflight = 0;
    this._queue = [];
  }

  get base() { return `${this.api}/repos/${this.owner}/${this.repo}`; }
  get webUrl() { return this.api === 'https://api.github.com' ? `https://github.com/${this.owner}/${this.repo}` : null; }

  async req(method, url, { body, accept = 'application/vnd.github+json', as = 'json', allow404 = false, cache } = {}) {
    const full = url.startsWith('http') ? url : this.base + url;
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetch(full, {
          method,
          cache: cache || (method === 'GET' ? 'no-cache' : 'no-store'),
          headers: {
            Accept: accept,
            Authorization: `Bearer ${this.token}`,
            ...(body !== undefined && { 'Content-Type': 'application/json' }),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
      } catch (e) {
        if (attempt < 3) { await sleep(800 * 2 ** attempt); continue; }
        throw new GitHubError(0, '네트워크에 연결할 수 없어요');
      }
      if (res.ok) {
        if (as === 'blob') return res.blob();
        if (as === 'text') return res.text();
        if (res.status === 204) return null;
        return res.json();
      }
      if (res.status === 404 && allow404) return null;
      let msg = '';
      try { msg = (await res.json()).message || ''; } catch { /* non-JSON */ }

      // primary & secondary rate limits: wait it out (bounded) and retry
      const remaining = res.headers.get('x-ratelimit-remaining');
      const retryAfter = Number(res.headers.get('retry-after'));
      const limited = res.status === 429 || (res.status === 403 && (remaining === '0' || /rate limit/i.test(msg)));
      if (limited && attempt < 4) {
        let wait = retryAfter || 0;
        if (!wait && remaining === '0') wait = Math.max(1, Number(res.headers.get('x-ratelimit-reset')) - Date.now() / 1000);
        wait = Math.min(Math.max(wait || 60, 5), 900);
        this.onWait?.(Math.round(wait));
        await sleep(wait * 1000);
        continue;
      }
      if (res.status >= 500 && attempt < 3) { await sleep(1000 * 2 ** attempt); continue; }
      if (res.status === 409 && /empty/i.test(msg)) throw new GitHubError(409, msg, { empty: true });
      if (res.status === 401) throw new GitHubError(401, '토큰이 올바르지 않거나 만료되었어요');
      if (res.status === 403 && !limited) throw new GitHubError(403, '이 저장소에 쓸 권한이 없어요 (토큰 권한: Contents 읽기/쓰기 확인)');
      if (res.status === 404) throw new GitHubError(404, '저장소를 찾을 수 없어요 (이름과 토큰 접근 범위를 확인하세요)');
      throw new GitHubError(res.status, msg || `GitHub 오류 ${res.status}`);
    }
  }

  user() { return this.req('GET', `${this.api}/user`); }

  async info() {
    const r = await this.req('GET', '');
    if (!this.branch) this.branch = r.default_branch;
    return r;
  }

  /** Current branch head, or null when the repository has no commits yet. */
  async head() {
    try {
      const r = await this.req('GET', `/git/ref/heads/${encodeURIComponent(this.branch)}`, { allow404: true });
      return r ? r.object.sha : null;
    } catch (e) {
      if (e.empty) return null;
      throw e;
    }
  }

  async treeOf(commitSha) { return (await this.req('GET', `/git/commits/${commitSha}`)).tree.sha; }

  /** Raw file at a ref (commit sha or branch). null if missing. */
  async file(path, ref = this.branch, as = 'blob') {
    return this.req('GET', `/contents/${encPath(path)}?ref=${encodeURIComponent(ref)}`, { accept: 'application/vnd.github.raw+json', as, allow404: true });
  }

  /** Blob text by sha. Blobs are content-addressed, so the cache never goes stale. */
  async blobText(sha) {
    const key = `https://moa.cache/blob/${sha}`;
    let c = null;
    if ('caches' in globalThis) {
      try {
        c = await caches.open(MEDIA_CACHE);
        const hit = await c.match(key);
        if (hit) return hit.text();
      } catch { c = null; }
    }
    const text = await this.req('GET', `/git/blobs/${sha}`, { accept: 'application/vnd.github.raw+json', as: 'text', cache: 'force-cache' });
    if (c) c.put(key, new Response(text)).catch(() => {});
    return text;
  }

  /**
   * Album state at a commit: { head, index, files: Map(path → { sha, size, text }) }.
   * Reads v2 (album.json + index/*.json) or the v1 single index.json.
   * Unchanged shards come from cache, so a refresh costs ~3 requests.
   */
  async state(head) {
    const tree = await this.treeOf(head);
    const root = (await this.req('GET', `/git/trees/${tree}`)).tree;
    const find = n => root.find(e => e.path === n);
    const meta = find(META_PATH), legacy = find(INDEX_PATH), dir = find(SHARD_DIR);
    const files = new Map();
    if (meta) {
      const shards = dir?.type === 'tree'
        ? (await this.req('GET', `/git/trees/${dir.sha}`)).tree.filter(e => e.type === 'blob' && e.path.endsWith('.json')).map(e => ({ ...e, path: `${SHARD_DIR}/${e.path}` }))
        : [];
      const all = [{ ...meta, path: META_PATH }, ...shards];
      const texts = await Promise.all(all.map(f => this.blobText(f.sha)));
      all.forEach((f, i) => files.set(f.path, { sha: f.sha, size: f.size ?? texts[i].length, text: texts[i] }));
      if (legacy) files.set(INDEX_PATH, { sha: legacy.sha, size: legacy.size, text: null }); // removed on next commit
      return { head, index: joinIndex(texts[0], texts.slice(1)), files };
    }
    if (legacy) {
      const text = await this.blobText(legacy.sha);
      files.set(INDEX_PATH, { sha: legacy.sha, size: legacy.size ?? text.length, text });
      return { head, index: parseIndex(text), files };
    }
    return { head, index: null, files };
  }

  /** Wait until another ref update fits in GitHub's recommended push rate. */
  async gate() {
    for (;;) {
      const ms = waitFor(this.pushTimes, Date.now());
      if (!ms) break;
      this.onThrottle?.(Math.ceil(ms / 1000));
      await sleep(ms + 50);
    }
    this.pushTimes.push(Date.now());
    this.pushTimes = this.pushTimes.filter(t => Date.now() - t < 60000);
  }

  recentPushes() { return this.pushTimes.filter(t => Date.now() - t < 60000).length; }

  async blob(base64) {
    return (await this.req('POST', '/git/blobs', { body: { content: base64, encoding: 'base64' } })).sha;
  }

  /** First commit into an empty repository (Git Data API refuses empty repos). */
  async seed(path, text, message) {
    await this.gate();
    await this.req('PUT', `/contents/${encPath(path)}`, { body: { message, content: textToBase64(text) } });
  }

  /**
   * One atomic commit: new blobs + ops replayed on the freshest index.
   * files: [{ path, sha }] — already-created blobs.
   * base: a state() result the caller already has (skips reads while still current).
   * Only shards whose text changed get new blobs; v1 index.json migrates here.
   */
  async commit({ files = [], ops = [], message, base, title }) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const head = await this.head();
      if (!head) throw new GitHubError(409, 'empty', { empty: true });
      const [tree, st] = await Promise.all([
        this.treeOf(head),
        base && base.head === head && base.files ? base : this.state(head),
      ]);
      const ix = st.index ? structuredClone(st.index) : emptyIndex(title);
      const deletes = [];
      for (const op of ops) if (op.op === 'deletePhotos') for (const id of op.ids) if (ix.photos[id]) deletes.push(...filesOf(ix.photos[id]));
      applyOps(ix, ops);
      const next = splitIndex(ix);
      const changed = [...next].filter(([path, text]) => st.files.get(path)?.text !== text);
      const shas = await Promise.all(changed.map(([, text]) => this.blob(textToBase64(text))));
      const nextFiles = new Map();
      for (const [path, text] of next) nextFiles.set(path, { ...st.files.get(path), text, size: new TextEncoder().encode(text).length });
      changed.forEach(([path], i) => { nextFiles.get(path).sha = shas[i]; });
      const removed = [...st.files.keys()].filter(path => !next.has(path));
      const entries = [
        ...files.map(f => ({ path: f.path, mode: '100644', type: 'blob', sha: f.sha })),
        ...changed.map(([path], i) => ({ path, mode: '100644', type: 'blob', sha: shas[i] })),
        ...[...new Set([...deletes, ...removed])].map(path => ({ path, mode: '100644', type: 'blob', sha: null })),
      ];
      const newTree = (await this.req('POST', '/git/trees', { body: { base_tree: tree, tree: entries } })).sha;
      const c = await this.req('POST', '/git/commits', { body: { message, tree: newTree, parents: [head] } });
      await this.gate();
      try {
        await this.req('PATCH', `/git/refs/heads/${encodeURIComponent(this.branch)}`, { body: { sha: c.sha, force: false } });
        return { head: c.sha, index: ix, files: nextFiles };
      } catch (e) {
        if (e.status !== 422 && e.status !== 409) throw e;
        await sleep(300 + Math.random() * 700 * (attempt + 1)); // someone else committed first
      }
    }
    throw new GitHubError(409, '다른 사람의 변경과 계속 충돌해요. 잠시 후 다시 시도하세요');
  }

  // ---------- media with local cache ----------

  cacheKey(path) { return `https://moa.cache/${this.owner}/${this.repo}/${path}`; }

  /** Files are immutable (unique ids) so cache forever. Limited parallelism. */
  async media(path, { cache = true } = {}) {
    let c = null;
    if (cache && 'caches' in globalThis) {
      try {
        c = await caches.open(MEDIA_CACHE);
        const hit = await c.match(this.cacheKey(path));
        if (hit) return hit.blob();
      } catch { c = null; }
    }
    while (this._inflight >= 6) await new Promise(r => this._queue.push(r));
    this._inflight++;
    try {
      const b = await this.file(path);
      if (!b) throw new GitHubError(404, '파일이 없어요: ' + path);
      if (c) c.put(this.cacheKey(path), new Response(b)).catch(() => {});
      return b;
    } finally {
      this._inflight--;
      this._queue.shift()?.();
    }
  }

  async primeCache(path, blob) {
    if (!('caches' in globalThis)) return;
    try { await (await caches.open(MEDIA_CACHE)).put(this.cacheKey(path), new Response(blob)); } catch { /* quota */ }
  }
}

export async function clearMediaCache() {
  if ('caches' in globalThis) await caches.delete(MEDIA_CACHE);
}
