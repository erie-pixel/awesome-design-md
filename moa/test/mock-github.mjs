// In-memory stand-in for the slice of the GitHub REST API Moa uses:
// /user, /repos/:o/:r, git refs/commits/trees/blobs, contents (raw GET,
// PUT on an empty repo). Enforces fast-forward ref updates like GitHub,
// so concurrent writers really conflict and must retry.

import http from 'node:http';
import crypto from 'node:crypto';

export function createMockGitHub({ owner = 'alice', repo = 'photos', users = { 'tok-alice': 'alice', 'tok-bob': 'bob' }, readOnly = [] } = {}) {
  const blobs = new Map();   // sha -> Buffer
  const trees = new Map();   // sha -> Map(path -> blobSha)
  const commits = new Map(); // sha -> { tree, parents, message }
  let ref = null;            // main branch head
  let sizeKB = 0;            // what GET /repos reports as .git size
  const stats = { commits: 0, conflicts: 0, requests: 0, pushes: {} }; // pushes: user -> [ms]

  const sha = (kind, data) => crypto.createHash('sha1').update(kind + '\0').update(data).digest('hex');
  const putBlob = buf => { const s = sha('blob', buf); blobs.set(s, buf); return s; };
  const putTree = map => { const s = sha('tree', JSON.stringify([...map].sort())); trees.set(s, new Map(map)); return s; };
  const putCommit = c => { const s = sha('commit', JSON.stringify(c) + Math.random()); commits.set(s, c); stats.commits++; return s; };
  const isAncestor = (anc, c) => { const seen = new Set(); const q = [c]; while (q.length) { const x = q.shift(); if (x === anc) return true; if (seen.has(x)) continue; seen.add(x); q.push(...(commits.get(x)?.parents || [])); } return false; };
  const treeAt = r => { const c = commits.get(r === 'main' ? ref : r); return c ? trees.get(c.tree) : null; };

  const api = {
    stats,
    head: () => ref,
    fileText: (path) => { const t = treeAt('main'); const b = t && t.get(path); return b ? blobs.get(b).toString('utf8') : null; },
    paths: () => [...(treeAt('main')?.keys() || [])].sort(),
    shaOf: path => treeAt('main')?.get(path),
    setSizeKB: kb => { sizeKB = kb; },
    /** Most ref updates one user made inside any 60s window. */
    maxPushesPerMinute(user) {
      const t = stats.pushes[user] || [];
      return t.reduce((m, x, i) => Math.max(m, t.filter(y => y >= x && y - x < 60000).length), 0);
    },
    /** Commit a JSON file change directly, as another client would (used to force conflicts). */
    commitJson(path, mutator, message = 'external') {
      const t = new Map(treeAt('main'));
      const doc = JSON.parse(blobs.get(t.get(path)).toString('utf8'));
      mutator(doc);
      t.set(path, putBlob(Buffer.from(JSON.stringify(doc, null, 2))));
      ref = putCommit({ tree: putTree(t), parents: [ref], message });
    },
    /** Put a file straight into the tree (seeding legacy layouts). */
    putFile(path, text, message = 'seed') {
      const t = new Map(ref ? treeAt('main') : []);
      t.set(path, putBlob(Buffer.from(text)));
      ref = putCommit({ tree: putTree(t), parents: ref ? [ref] : [], message });
    },
  };

  const server = http.createServer(async (req, res) => {
    stats.requests++;
    const url = new URL(req.url, 'http://x');
    const send = (code, body, headers = {}) => {
      const isBuf = Buffer.isBuffer(body);
      res.writeHead(code, { 'Access-Control-Allow-Origin': '*', 'Content-Type': isBuf ? 'application/octet-stream' : 'application/json', ...headers });
      res.end(isBuf ? body : body === undefined ? '' : JSON.stringify(body));
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept', 'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE' });
      return res.end();
    }
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const user = users[token];
    if (!user) return send(401, { message: 'Bad credentials' });
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;

    if (url.pathname === '/user') return send(200, { login: user, id: 1, avatar_url: '' });
    const prefix = `/repos/${owner}/${repo}`;
    if (!url.pathname.startsWith(prefix)) return send(404, { message: 'Not Found' });
    const p = url.pathname.slice(prefix.length);
    const canPush = !readOnly.includes(user);
    const write = req.method !== 'GET';
    if (write && !canPush) return send(403, { message: 'Resource not accessible by personal access token' });

    if (p === '' && req.method === 'GET') return send(200, { name: repo, full_name: `${owner}/${repo}`, private: true, default_branch: 'main', description: '', size: sizeKB, permissions: { admin: user === owner, push: canPush, pull: true } });
    if (p === '/git/ref/heads/main' && req.method === 'GET') {
      if (!ref) return send(409, { message: 'Git Repository is empty.' });
      return send(200, { ref: 'refs/heads/main', object: { sha: ref, type: 'commit' } });
    }
    let m;
    if ((m = /^\/git\/commits\/(\w+)$/.exec(p)) && req.method === 'GET') {
      const c = commits.get(m[1]);
      return c ? send(200, { sha: m[1], tree: { sha: c.tree }, parents: c.parents.map(s => ({ sha: s })), message: c.message }) : send(404, { message: 'Not Found' });
    }
    if ((m = /^\/git\/trees\/(\w+)$/.exec(p)) && req.method === 'GET') {
      // non-recursive listing; sub-directories become synthetic tree objects
      const t = trees.get(m[1]);
      if (!t) return send(404, { message: 'Not Found' });
      const dirs = new Map(), out = [];
      for (const [path, b] of t) {
        const i = path.indexOf('/');
        if (i < 0) out.push({ path, mode: '100644', type: 'blob', sha: b, size: blobs.get(b).length });
        else { const d = path.slice(0, i); if (!dirs.has(d)) dirs.set(d, new Map()); dirs.get(d).set(path.slice(i + 1), b); }
      }
      for (const [d, sub] of dirs) out.push({ path: d, mode: '040000', type: 'tree', sha: putTree(sub) });
      return send(200, { sha: m[1], tree: out, truncated: false });
    }
    if ((m = /^\/git\/blobs\/(\w+)$/.exec(p)) && req.method === 'GET') {
      const b = blobs.get(m[1]);
      if (!b) return send(404, { message: 'Not Found' });
      if (!/raw/.test(req.headers.accept || '')) return send(200, { sha: m[1], size: b.length, encoding: 'base64', content: b.toString('base64') });
      return send(200, b);
    }
    if ((m = /^\/contents\/(.+)$/.exec(p))) {
      const path = decodeURIComponent(m[1]);
      if (req.method === 'GET') {
        if (!ref) return send(404, { message: 'This repository is empty.' });
        const t = treeAt(url.searchParams.get('ref') || 'main');
        const b = t && t.get(path);
        if (!b) return send(404, { message: 'Not Found' });
        if (!/raw/.test(req.headers.accept || '')) return send(415, { message: 'test mock only serves raw' });
        return send(200, blobs.get(b));
      }
      if (req.method === 'PUT') {
        const t = new Map(ref ? treeAt('main') : []);
        t.set(path, putBlob(Buffer.from(body.content, 'base64')));
        ref = putCommit({ tree: putTree(t), parents: ref ? [ref] : [], message: body.message });
        (stats.pushes[user] ||= []).push(Date.now());
        return send(201, { commit: { sha: ref } });
      }
    }
    if (p === '/git/blobs' && req.method === 'POST') {
      if (!ref) return send(409, { message: 'Git Repository is empty.' });
      return send(201, { sha: putBlob(Buffer.from(body.content, body.encoding === 'base64' ? 'base64' : 'utf8')) });
    }
    if (p === '/git/trees' && req.method === 'POST') {
      const base = trees.get(body.base_tree);
      if (!base) return send(422, { message: 'base_tree not found' });
      const t = new Map(base);
      for (const e of body.tree) {
        if (e.sha === null) {
          if (!t.has(e.path)) return send(422, { message: `tree.path ${e.path} does not exist` });
          t.delete(e.path);
        } else {
          if (!blobs.has(e.sha)) return send(422, { message: 'blob missing' });
          t.set(e.path, e.sha);
        }
      }
      return send(201, { sha: putTree(t) });
    }
    if (p === '/git/commits' && req.method === 'POST') {
      if (!trees.has(body.tree)) return send(422, { message: 'tree missing' });
      return send(201, { sha: putCommit({ tree: body.tree, parents: body.parents, message: body.message }) });
    }
    if (p === '/git/refs/heads/main' && req.method === 'PATCH') {
      if (!commits.has(body.sha)) return send(422, { message: 'Object does not exist' });
      if (!body.force && ref && !isAncestor(ref, body.sha)) { stats.conflicts++; return send(422, { message: 'Update is not a fast forward' }); }
      ref = body.sha;
      (stats.pushes[user] ||= []).push(Date.now());
      return send(200, { ref: 'refs/heads/main', object: { sha: ref } });
    }
    send(404, { message: 'Not Found (mock)' });
  });

  return { server, api };
}
