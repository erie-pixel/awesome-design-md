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
   Encrypted albums (see crypto.js): album.json holds only the wrapped
   key; album.bin, index/sNN.bin and data/xx/<random> are sealed, so the
   repository shows no names, dates, places or pixels.
   ============================================================ */

import { INDEX_PATH, META_PATH, SEALED_META, SHARD_DIR, parseIndex, joinIndex, splitIndex, emptyIndex, applyOps, filesOf } from './core.js';
import { waitFor } from './limits.js';
import { t } from './i18n.js';
import { isHeader, isSealed, seal, sealParts, open } from './crypto.js';

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
const utf8 = new TextDecoder();

/** An encrypted album without (or with the wrong) key on this device. */
export class LockedError extends Error {
  constructor(header, stale = false) {
    super(t('lock.title'));
    this.locked = true;
    this.header = header;
    this.stale = stale;
  }
}

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
    this.header = null;     // wrapped-key header when the album is encrypted
    this.key = null;        // album CryptoKey once unlocked
  }

  get sealed() { return !!this.header; }
  setEncryption(header, key) { this.header = header; this.key = key; }

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
        throw new GitHubError(0, t('gh.network'));
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
      if (res.status === 401) throw new GitHubError(401, t('gh.401'));
      if (res.status === 403 && !limited) throw new GitHubError(403, t('gh.403'));
      if (res.status === 404) throw new GitHubError(404, t('gh.404'));
      throw new GitHubError(res.status, msg || t('gh.other', { s: res.status }));
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

  /** Blob bytes by sha. Blobs are content-addressed, so the cache never goes stale. */
  async blobBytes(sha) {
    const key = this.cacheKey(`.blob/${sha}`);
    let c = null;
    if ('caches' in globalThis) {
      try {
        c = await caches.open(MEDIA_CACHE);
        const hit = await c.match(key);
        if (hit) return new Uint8Array(await hit.arrayBuffer());
      } catch { c = null; }
    }
    const b = await this.req('GET', `/git/blobs/${sha}`, { accept: 'application/vnd.github.raw+json', as: 'blob', cache: 'force-cache' });
    const u8 = new Uint8Array(await b.arrayBuffer());
    if (c) c.put(key, new Response(u8)).catch(() => {});
    return u8;
  }

  async blobText(sha) { return utf8.decode(await this.blobBytes(sha)); }

  /** Text of a sealed index file. A key that can't open it is treated as no key. */
  async sealedText(sha) {
    const u8 = await this.blobBytes(sha);
    if (!isSealed(u8)) throw new Error('unencrypted file in an encrypted album');
    try { return utf8.decode(await open(this.key, u8)); } catch { throw new LockedError(this.header, true); }
  }

  /**
   * Album state at a commit: { head, index, files: Map(path → { sha, size, text }) }.
   * Reads v2 (album.json + index/*.json) or the v1 single index.json.
   * Unchanged shards come from cache, so a refresh costs ~3 requests.
   */
  async state(head) {
    const commit = await this.req('GET', `/git/commits/${head}`);
    const rootCommit = !commit.parents?.length; // history was erased (or never had more than one commit)
    const root = (await this.req('GET', `/git/trees/${commit.tree.sha}`)).tree;
    const find = n => root.find(e => e.path === n);
    const meta = find(META_PATH), legacy = find(INDEX_PATH), dir = find(SHARD_DIR);
    const files = new Map();
    const shardList = async ext => (dir?.type === 'tree'
      ? (await this.req('GET', `/git/trees/${dir.sha}`)).tree.filter(e => e.type === 'blob' && e.path.endsWith(ext)).map(e => ({ ...e, path: `${SHARD_DIR}/${e.path}` }))
      : []);
    if (meta) {
      const metaText = await this.blobText(meta.sha);
      let doc = null;
      try { doc = JSON.parse(metaText); } catch { /* joinIndex reports it */ }
      if (isHeader(doc)) {
        this.header = doc;
        if (!this.key) throw new LockedError(doc);
        const body = find(SEALED_META);
        if (!body) return { head, index: null, files, root: rootCommit };
        const all = [{ ...body, path: SEALED_META }, ...await shardList('.bin')];
        const texts = await Promise.all(all.map(f => this.sealedText(f.sha)));
        all.forEach((f, i) => files.set(f.path, { sha: f.sha, size: f.size, text: texts[i] }));
        return { head, index: joinIndex(texts[0], texts.slice(1)), files, root: rootCommit };
      }
      this.header = null;
      const shards = await shardList('.json');
      const texts = [metaText, ...await Promise.all(shards.map(f => this.blobText(f.sha)))];
      [{ ...meta, path: META_PATH }, ...shards].forEach((f, i) => files.set(f.path, { sha: f.sha, size: f.size ?? texts[i].length, text: texts[i] }));
      if (legacy) files.set(INDEX_PATH, { sha: legacy.sha, size: legacy.size, text: null }); // removed on next commit
      return { head, index: joinIndex(texts[0], texts.slice(1)), files, root: rootCommit };
    }
    if (legacy) {
      const text = await this.blobText(legacy.sha);
      files.set(INDEX_PATH, { sha: legacy.sha, size: legacy.size ?? text.length, text });
      return { head, index: parseIndex(text), files, root: rootCommit };
    }
    return { head, index: null, files, root: rootCommit };
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

  /** Blob for an index file: sealed in an encrypted album. */
  async putText(text) {
    const bytes = new TextEncoder().encode(text);
    return this.blob(bytesToBase64(this.sealed ? await seal(this.key, bytes) : bytes));
  }

  /** Blob for a photo/video file; prime = keep a copy in the local cache (as stored). */
  async putMedia(path, blob, { prime = false } = {}) {
    const body = this.sealed ? new Blob(await sealParts(this.key, new Uint8Array(await blob.arrayBuffer()))) : blob;
    const sha = await this.blob(await blobToBase64(body));
    if (prime) this.primeCache(path, body);
    return sha;
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
      const next = splitIndex(ix, { sealed: this.sealed });
      const changed = [...next].filter(([path, text]) => st.files.get(path)?.text !== text);
      const shas = await Promise.all(changed.map(([, text]) => this.putText(text)));
      const nextFiles = new Map();
      for (const [path, text] of next) nextFiles.set(path, { ...st.files.get(path), text, size: new TextEncoder().encode(text).length + (this.sealed ? 32 : 0) });
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
        return { head: c.sha, index: ix, files: nextFiles, root: false };
      } catch (e) {
        if (e.status !== 422 && e.status !== 409) throw e;
        await sleep(300 + Math.random() * 700 * (attempt + 1)); // someone else committed first
      }
    }
    throw new GitHubError(409, t('gh.conflict'));
  }

  /** Photo/video blob stored for a target mode: sealed with `key`, or as-is when key is null. */
  async putMediaWith(blob, key) {
    const body = key ? new Blob(await sealParts(key, new Uint8Array(await blob.arrayBuffer()))) : blob;
    return this.blob(await blobToBase64(body));
  }

  /**
   * Switch the album between plain and encrypted in one commit.
   * map: old path → { path, sha } of the file already stored in the target form (null: file was missing).
   * target: { header, key } to encrypt, null to decrypt.
   * Returns { missing, st } without committing when the album gained files the map
   * doesn't cover yet (a friend uploaded meanwhile), else { state } in the new mode.
   */
  async convertCommit({ map, target, readme, message }) {
    const sealed = !!target;
    const put = async text => { const b = new TextEncoder().encode(text); return this.blob(bytesToBase64(sealed ? await seal(target.key, b) : b)); };
    for (let attempt = 0; attempt < 8; attempt++) {
      const head = await this.head();
      const [tree, st] = await Promise.all([this.treeOf(head), this.state(head)]);
      const ix = structuredClone(st.index);
      const oldPaths = Object.values(ix.photos).flatMap(filesOf);
      if (oldPaths.some(p => !(p in map))) return { missing: true, st };
      const entries = [];
      for (const p of Object.values(ix.photos)) {
        for (const k of Object.keys(p.files || {})) {
          if (k.endsWith('Mime')) continue;
          const m = map[p.files[k]];
          if (m) { p.files[k] = m.path; entries.push({ path: m.path, mode: '100644', type: 'blob', sha: m.sha }); } else delete p.files[k];
        }
      }
      const next = splitIndex(ix, { sealed });
      const shas = await Promise.all([...next.values()].map(put));
      const nextFiles = new Map();
      [...next].forEach(([path, text], i) => {
        entries.push({ path, mode: '100644', type: 'blob', sha: shas[i] });
        nextFiles.set(path, { sha: shas[i], text, size: new TextEncoder().encode(text).length + (sealed ? 32 : 0) });
      });
      if (sealed) entries.push({ path: META_PATH, mode: '100644', type: 'blob', sha: await this.blob(textToBase64(JSON.stringify(target.header, null, 2) + '\n')) });
      if (readme) entries.push({ path: 'README.md', mode: '100644', type: 'blob', sha: await this.blob(textToBase64(readme)) });
      const written = new Set(entries.map(e => e.path));
      const gone = [...new Set([...oldPaths.filter(p => map[p]), ...st.files.keys()])].filter(p => !written.has(p));
      entries.push(...gone.map(path => ({ path, mode: '100644', type: 'blob', sha: null })));
      const newTree = (await this.req('POST', '/git/trees', { body: { base_tree: tree, tree: entries } })).sha;
      const c = await this.req('POST', '/git/commits', { body: { message, tree: newTree, parents: [head] } });
      await this.gate();
      try {
        await this.req('PATCH', `/git/refs/heads/${encodeURIComponent(this.branch)}`, { body: { sha: c.sha, force: false } });
      } catch (e) {
        if (e.status !== 422 && e.status !== 409) throw e;
        await sleep(300 + Math.random() * 700 * (attempt + 1));
        continue;
      }
      this.setEncryption(target?.header || null, target?.key || null);
      return { state: { head: c.sha, index: ix, files: nextFiles, root: false } };
    }
    throw new GitHubError(409, t('gh.conflict'));
  }

  setDescription(description) { return this.req('PATCH', '', { body: { description } }); }

  /**
   * Erase history: the branch becomes one commit holding today's files,
   * so photos deleted earlier are reachable from no commit and GitHub
   * garbage-collects them. Rewrites the branch (force update), so it
   * starts over if a friend saves in the meantime.
   */
  async purgeHistory(message) {
    const ref = `/git/refs/heads/${encodeURIComponent(this.branch)}`;
    for (let attempt = 0; attempt < 6; attempt++) {
      const head = await this.head();
      if (!head) throw new GitHubError(409, 'empty', { empty: true });
      const c = await this.req('POST', '/git/commits', { body: { message, tree: await this.treeOf(head), parents: [] } });
      await this.gate();
      if (await this.head() !== head) { await sleep(400 + Math.random() * 600); continue; }
      await this.req('PATCH', ref, { body: { sha: c.sha, force: true } });
      return c.sha;
    }
    throw new GitHubError(409, t('gh.conflict'));
  }

  // ---------- media with local cache ----------

  cacheKey(path) { return `https://moa.cache/${this.owner}/${this.repo}/${path}`; }

  /** Files are immutable (unique ids) so cache forever — as stored, i.e. still encrypted. Limited parallelism. */
  async media(path, { cache = true } = {}) {
    const stored = await this.storedMedia(path, cache);
    if (!this.sealed) return stored;
    try { return new Blob([await open(this.key, new Uint8Array(await stored.arrayBuffer()))]); } catch { throw new LockedError(this.header, true); }
  }

  async storedMedia(path, cache) {
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
      if (!b) throw new GitHubError(404, t('gh.missing', { p: path }));
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

  /** Drop cached copies of these paths (photos a friend deleted). */
  async forget(paths) {
    if (!('caches' in globalThis) || !paths.length) return;
    const c = await caches.open(MEDIA_CACHE);
    await Promise.all(paths.map(p => c.delete(this.cacheKey(p))));
  }

  /** Keep only this album's cached files named in `keep` (paths and ".blob/<sha>"). */
  async pruneCache(keep) {
    if (!('caches' in globalThis)) return;
    const c = await caches.open(MEDIA_CACHE);
    const prefix = this.cacheKey('');
    for (const req of await c.keys()) {
      if (!req.url.startsWith(prefix)) continue;
      const path = decodeURIComponent(req.url.slice(prefix.length));
      if (path !== '.moa/index-cache.json' && !keep.has(path)) await c.delete(req);
    }
  }

  // ---------- sharing ----------

  /** Invite a GitHub user with write access. Returns the invitation, or null if already a collaborator. */
  invite(username) { return this.req('PUT', `/collaborators/${encodeURIComponent(username)}`, { body: { permission: 'push' } }); }
  collaborators() { return this.req('GET', '/collaborators?per_page=100'); }
  pendingInvites() { return this.req('GET', '/invitations?per_page=100'); }
  cancelInvite(id) { return this.req('DELETE', `/invitations/${id}`); }
}

export const ALBUM_TOPIC = 'moa-album';
export const ENCRYPTED_DESCRIPTION = 'Moa · encrypted'; // the title stays inside the album

/** Account-level calls for a signed-in user (no particular repository). */
export class Account {
  constructor(token, api) {
    this.r = new Repo({ owner: '-', repo: '-', token, api });
    this.api = this.r.api;
  }
  req(method, path, opts) { return this.r.req(method, this.api + path, opts); }
  user() { return this.req('GET', '/user'); }

  /** Repositories this user can open that are Moa albums (tagged with the topic). */
  async albums() {
    const list = await this.req('GET', '/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member');
    return list.filter(r => (r.topics || []).includes(ALBUM_TOPIC));
  }

  /** A new private repository for an album, tagged so it can be found again. */
  async createAlbumRepo(name, title, { encrypted = false } = {}) {
    const description = encrypted ? ENCRYPTED_DESCRIPTION : `${title} · Moa`;
    const r = await this.req('POST', '/user/repos', { body: { name, description, private: true, has_issues: false, has_projects: false, has_wiki: false } });
    await this.req('PUT', `/repos/${r.owner.login}/${r.name}/topics`, { body: { names: [ALBUM_TOPIC] } }).catch(() => {});
    return r;
  }

  invitations() { return this.req('GET', '/user/repository_invitations?per_page=100'); }
  accept(id) { return this.req('PATCH', `/user/repository_invitations/${id}`); }
  /** A repository this user can open, or null. */
  repo(owner, name) { return this.req('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, { allow404: true }); }

  // ---------- invite links ----------
  // Each invite is a secret gist (unlisted, readable by whoever has its id).
  // A friend asks to join by commenting on it — GitHub vouches for who wrote
  // the comment — and the owner's app turns that into a collaborator invite.

  async createInvite(meta) {
    const g = await this.req('POST', '/gists', { body: { description: inviteDescription({ ...meta, seen: 0 }), public: false, files: { [INVITE_FILE]: { content: JSON.stringify({ kind: 'moa-invite', v: 1, ...meta }, null, 2) } } } });
    return { id: g.id, ...meta, seen: 0, comments: 0 };
  }

  /** My open invites, parsed from the gist descriptions (no extra requests). */
  async invites() {
    const list = await this.req('GET', '/gists?per_page=100');
    return list.map(g => { const m = parseInviteDescription(g.description); return m && { id: g.id, ...m, comments: g.comments || 0 }; }).filter(Boolean);
  }

  /** An invite as its recipient sees it; null once used or revoked. */
  async readInvite(id) {
    const g = await this.req('GET', `/gists/${encodeURIComponent(id)}`, { allow404: true });
    if (!g) return null;
    try { const m = JSON.parse(g.files?.[INVITE_FILE]?.content || ''); return m.kind === 'moa-invite' ? { ...m, id, owner: g.owner?.login } : null; } catch { return null; }
  }

  inviteComments(id) { return this.req('GET', `/gists/${encodeURIComponent(id)}/comments?per_page=100`); }
  requestJoin(id) { return this.req('POST', `/gists/${encodeURIComponent(id)}/comments`, { body: { body: JOIN_REQUEST } }); }
  markInvite(inv, seen) { return this.req('PATCH', `/gists/${encodeURIComponent(inv.id)}`, { body: { description: inviteDescription({ ...inv, seen }) } }); }
  revokeInvite(id) { return this.req('DELETE', `/gists/${encodeURIComponent(id)}`, { allow404: true }); }
}

const INVITE_FILE = 'moa-invite.json';
export const JOIN_REQUEST = 'moa-join';
// "Moa invite <owner/repo> <expires ISO> <uses: 1 | 0=until expiry> <comments already handled>"
const inviteDescription = m => `Moa invite ${m.repo} ${m.expires} ${m.uses} ${m.seen || 0}`;
function parseInviteDescription(d) {
  const m = /^Moa invite (\S+\/\S+) (\S+) (\d+) (\d+)$/.exec(d || '');
  return m && { repo: m[1], expires: m[2], uses: +m[3], seen: +m[4] };
}

export async function clearMediaCache() {
  if ('caches' in globalThis) await caches.delete(MEDIA_CACHE);
}
