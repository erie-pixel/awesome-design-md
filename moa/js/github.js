/* ============================================================
   Moa — GitHub storage layer
   A private repository is the photo library:
     index.json                   every photo's metadata, albums, tags
     media/YYYY/MM/<id>.<ext>     originals (+ <id>.live.mov for Live Photos)
     preview/YYYY/MM/<id>.jpg     ~2048px JPEG for any browser
     thumb/YYYY/MM/<id>.jpg       grid thumbnail
   Writes go through the Git Data API so one upload batch (files +
   index) lands as a single commit; a non-fast-forward ref update
   means a friend committed first, so we re-read and replay.
   ============================================================ */

import { INDEX_PATH, parseIndex, serializeIndex, emptyIndex, applyOps, filesOf } from './core.js';

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
    this.onWait = null; // (seconds) => void, rate-limit notice
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

  async index(ref) {
    const text = await this.file(INDEX_PATH, ref, 'text');
    return text == null ? null : parseIndex(text);
  }

  async blob(base64) {
    return (await this.req('POST', '/git/blobs', { body: { content: base64, encoding: 'base64' } })).sha;
  }

  /** First commit into an empty repository (Git Data API refuses empty repos). */
  async seed(path, text, message) {
    await this.req('PUT', `/contents/${encPath(path)}`, { body: { message, content: textToBase64(text) } });
  }

  /**
   * One atomic commit: new blobs + ops replayed on the freshest index.
   * files: [{ path, sha }] — already-created blobs.
   * base: { head, index } the caller already has (skips a read when still current).
   */
  async commit({ files = [], ops = [], message, base, title }) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const head = await this.head();
      if (!head) throw new GitHubError(409, 'empty', { empty: true });
      const [tree, fresh] = await Promise.all([
        this.treeOf(head),
        base && base.head === head && base.index ? structuredClone(base.index) : this.index(head),
      ]);
      const ix = fresh || emptyIndex(title);
      const deletes = [];
      for (const op of ops) if (op.op === 'deletePhotos') for (const id of op.ids) if (ix.photos[id]) deletes.push(...filesOf(ix.photos[id]));
      applyOps(ix, ops);
      const indexSha = await this.blob(textToBase64(serializeIndex(ix)));
      const entries = [
        ...files.map(f => ({ path: f.path, mode: '100644', type: 'blob', sha: f.sha })),
        { path: INDEX_PATH, mode: '100644', type: 'blob', sha: indexSha },
        ...[...new Set(deletes)].map(path => ({ path, mode: '100644', type: 'blob', sha: null })),
      ];
      const newTree = (await this.req('POST', '/git/trees', { body: { base_tree: tree, tree: entries } })).sha;
      const c = await this.req('POST', '/git/commits', { body: { message, tree: newTree, parents: [head] } });
      try {
        await this.req('PATCH', `/git/refs/heads/${encodeURIComponent(this.branch)}`, { body: { sha: c.sha, force: false } });
        return { head: c.sha, index: ix };
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
