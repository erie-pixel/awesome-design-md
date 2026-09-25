// In-memory stand-in for the slice of the GitHub REST API Moa uses:
// /user, /user/repos (list + create), repository invitations, and per
// repository: info, topics, collaborators/invitations, git refs/commits/
// trees/blobs, contents (raw GET, PUT on an empty repo). Enforces
// fast-forward ref updates like GitHub so concurrent writers really
// conflict, and access control so only owners/collaborators see a repo.

import http from 'node:http';
import crypto from 'node:crypto';

export function createMockGitHub({ users = { 'tok-alice': 'alice', 'tok-bob': 'bob' }, repos = [], extraLogins = [] } = {}) {
  const blobs = new Map();   // sha -> Buffer          (shared, content-addressed)
  const trees = new Map();   // sha -> Map(path -> blobSha)
  const commits = new Map(); // sha -> { tree, parents, message }
  const R = new Map();       // "owner/name" (lowercase) -> repo state
  const logins = new Set([...Object.values(users), ...extraLogins]);
  let nextInvite = 1;
  const stats = { commits: 0, conflicts: 0, requests: 0, pushes: {} }; // pushes: "user owner/repo" -> [ms]

  const sha = (kind, data) => crypto.createHash('sha1').update(kind + '\0').update(data).digest('hex');
  const putBlob = buf => { const s = sha('blob', buf); blobs.set(s, buf); return s; };
  const putTree = map => { const s = sha('tree', JSON.stringify([...map].sort())); trees.set(s, new Map(map)); return s; };
  const putCommit = c => { const s = sha('commit', JSON.stringify(c) + Math.random()); commits.set(s, c); stats.commits++; return s; };
  const isAncestor = (anc, c) => { const seen = new Set(); const q = [c]; while (q.length) { const x = q.shift(); if (x === anc) return true; if (seen.has(x)) continue; seen.add(x); q.push(...(commits.get(x)?.parents || [])); } return false; };

  function makeRepo(owner, name, extra = {}) {
    const r = { owner, name, ref: null, sizeKB: 0, description: '', private: true, topics: [], collaborators: new Map([[owner, 'admin']]), invitations: [], ...extra };
    R.set(`${owner}/${name}`.toLowerCase(), r);
    return r;
  }
  for (const r of repos) makeRepo(r.owner, r.repo, r);

  const treeAt = (repo, ref) => { const c = commits.get(ref === 'main' || !ref ? repo.ref : ref); return c ? trees.get(c.tree) : null; };
  const perm = (repo, user) => repo.collaborators.get(user);
  const repoJson = (repo, user) => ({
    id: repo.name.length, name: repo.name, full_name: `${repo.owner}/${repo.name}`, owner: { login: repo.owner },
    private: repo.private, description: repo.description, default_branch: 'main', size: repo.sizeKB, topics: repo.topics,
    permissions: { admin: perm(repo, user) === 'admin', push: ['admin', 'push'].includes(perm(repo, user)), pull: !!perm(repo, user) },
  });
  const inviteJson = (repo, i) => ({ id: i.id, repository: repoJson(repo, i.invitee), inviter: { login: i.inviter, avatar_url: '' }, invitee: { login: i.invitee, avatar_url: '' } });

  /** Test helpers for one repository. */
  const at = full => {
    const repo = R.get(full.toLowerCase());
    if (!repo) throw new Error('no repo ' + full);
    return {
      repo,
      head: () => repo.ref,
      fileText: path => { const t = treeAt(repo); const b = t && t.get(path); return b ? blobs.get(b).toString('utf8') : null; },
      fileBytes: path => { const t = treeAt(repo); const b = t && t.get(path); return b ? blobs.get(b) : null; },
      /** Commits reachable from the branch head. */
      history() { const out = [], seen = new Set(), q = [repo.ref]; while (q.length) { const c = q.shift(); if (!c || seen.has(c)) continue; seen.add(c); out.push(c); q.push(...commits.get(c).parents); } return out; },
      /** Is this blob still in any commit of the branch's history? */
      reachable(blobSha) { return this.history().some(c => [...trees.get(commits.get(c).tree).values()].includes(blobSha)); },
      paths: () => [...(treeAt(repo)?.keys() || [])].sort(),
      shaOf: path => treeAt(repo)?.get(path),
      setSizeKB: kb => { repo.sizeKB = kb; },
      commitJson(path, mutator, message = 'external') {
        const t = new Map(treeAt(repo));
        const doc = JSON.parse(blobs.get(t.get(path)).toString('utf8'));
        mutator(doc);
        t.set(path, putBlob(Buffer.from(JSON.stringify(doc, null, 2))));
        repo.ref = putCommit({ tree: putTree(t), parents: [repo.ref], message });
      },
      putFile(path, data, message = 'seed') {
        const t = new Map(repo.ref ? treeAt(repo) : []);
        t.set(path, putBlob(Buffer.isBuffer(data) ? data : Buffer.from(data)));
        repo.ref = putCommit({ tree: putTree(t), parents: repo.ref ? [repo.ref] : [], message });
      },
    };
  };

  const api = {
    stats, at,
    repos: () => [...R.values()].map(r => `${r.owner}/${r.name}`),
    /** Most ref updates one user made to one repository inside any 60s window (GitHub's guidance is per repository). */
    maxPushesPerMinute(user) {
      let peak = 0;
      for (const [k, t] of Object.entries(stats.pushes)) {
        if (!k.startsWith(user + ' ')) continue;
        peak = t.reduce((m, x) => Math.max(m, t.filter(y => y >= x && y - x < 60000).length), peak);
      }
      return peak;
    },
  };

  const server = http.createServer(async (req, res) => {
    stats.requests++;
    const url = new URL(req.url, 'http://x');
    const send = (code, body, headers = {}) => {
      const isBuf = Buffer.isBuffer(body);
      res.writeHead(code, { 'Access-Control-Allow-Origin': '*', 'Content-Type': isBuf ? 'application/octet-stream' : 'application/json', ...headers });
      res.end(isBuf ? body : body === undefined || code === 204 ? '' : JSON.stringify(body));
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept', 'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE' });
      return res.end();
    }
    const user = users[(req.headers.authorization || '').replace(/^Bearer\s+/i, '')];
    if (!user) return send(401, { message: 'Bad credentials' });
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
    const pushed = () => (stats.pushes[`${user} ${repo.owner}/${repo.name}`] ||= []).push(Date.now());
    let m;

    // ---------- account ----------
    if (url.pathname === '/user') return send(200, { login: user, name: user[0].toUpperCase() + user.slice(1), id: 1, avatar_url: '' });
    if (url.pathname === '/user/repos' && req.method === 'GET') return send(200, [...R.values()].filter(r => perm(r, user)).map(r => repoJson(r, user)));
    if (url.pathname === '/user/repos' && req.method === 'POST') {
      if (!/^[A-Za-z0-9._-]+$/.test(body.name || '')) return send(422, { message: 'name invalid' });
      if (R.has(`${user}/${body.name}`.toLowerCase())) return send(422, { message: 'Repository creation failed.', errors: [{ message: 'name already exists on this account' }] });
      const repo = makeRepo(user, body.name, { description: body.description || '', private: body.private !== false });
      return send(201, repoJson(repo, user));
    }
    if (url.pathname === '/user/repository_invitations' && req.method === 'GET') {
      return send(200, [...R.values()].flatMap(r => r.invitations.filter(i => i.invitee === user).map(i => inviteJson(r, i))));
    }
    if ((m = /^\/user\/repository_invitations\/(\d+)$/.exec(url.pathname)) && req.method === 'PATCH') {
      for (const r of R.values()) {
        const i = r.invitations.find(x => x.id === +m[1] && x.invitee === user);
        if (i) { r.invitations = r.invitations.filter(x => x !== i); r.collaborators.set(user, i.permission); return send(204); }
      }
      return send(404, { message: 'Not Found' });
    }

    // ---------- repository ----------
    if (!(m = /^\/repos\/([^/]+)\/([^/]+)(.*)$/.exec(url.pathname))) return send(404, { message: 'Not Found (mock)' });
    const repo = R.get(`${m[1]}/${m[2]}`.toLowerCase());
    if (!repo || !perm(repo, user)) return send(404, { message: 'Not Found' });
    const p = m[3];
    const canPush = ['admin', 'push'].includes(perm(repo, user));
    const isAdmin = perm(repo, user) === 'admin';
    if (req.method !== 'GET' && !canPush) return send(403, { message: 'Resource not accessible' });

    if (p === '' && req.method === 'GET') return send(200, repoJson(repo, user));
    if (p === '/topics' && req.method === 'PUT') { if (!isAdmin) return send(403, { message: 'Must have admin rights' }); repo.topics = body.names; return send(200, { names: repo.topics }); }
    if (p.startsWith('/collaborators')) {
      if (req.method === 'GET') return send(200, [...repo.collaborators].map(([login, pm]) => ({ login, avatar_url: '', permissions: { admin: pm === 'admin', push: pm !== 'pull', pull: true } })));
      const who = decodeURIComponent(p.split('/')[2] || '');
      if (req.method === 'PUT') {
        if (!isAdmin) return send(403, { message: 'Must have admin rights to Repository.' });
        if (!logins.has(who)) return send(404, { message: 'Not Found' });
        if (repo.collaborators.has(who)) return send(204);
        let inv = repo.invitations.find(i => i.invitee === who);
        if (!inv) repo.invitations.push(inv = { id: nextInvite++, invitee: who, inviter: user, permission: body?.permission === 'pull' ? 'pull' : 'push' });
        return send(201, inviteJson(repo, inv));
      }
    }
    if (p === '/invitations' && req.method === 'GET') { if (!isAdmin) return send(403, { message: 'Must have admin rights' }); return send(200, repo.invitations.map(i => inviteJson(repo, i))); }
    if ((m = /^\/invitations\/(\d+)$/.exec(p)) && req.method === 'DELETE') { if (!isAdmin) return send(403, { message: 'Must have admin rights' }); repo.invitations = repo.invitations.filter(i => i.id !== +m[1]); return send(204); }

    if (p === '/git/ref/heads/main' && req.method === 'GET') {
      if (!repo.ref) return send(409, { message: 'Git Repository is empty.' });
      return send(200, { ref: 'refs/heads/main', object: { sha: repo.ref, type: 'commit' } });
    }
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
        if (!repo.ref) return send(404, { message: 'This repository is empty.' });
        const t = treeAt(repo, url.searchParams.get('ref') || 'main');
        const b = t && t.get(path);
        if (!b) return send(404, { message: 'Not Found' });
        if (!/raw/.test(req.headers.accept || '')) return send(415, { message: 'test mock only serves raw' });
        return send(200, blobs.get(b));
      }
      if (req.method === 'PUT') {
        const t = new Map(repo.ref ? treeAt(repo) : []);
        t.set(path, putBlob(Buffer.from(body.content, 'base64')));
        repo.ref = putCommit({ tree: putTree(t), parents: repo.ref ? [repo.ref] : [], message: body.message });
        pushed();
        return send(201, { commit: { sha: repo.ref } });
      }
    }
    if (p === '/git/blobs' && req.method === 'POST') {
      if (!repo.ref) return send(409, { message: 'Git Repository is empty.' });
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
      if (!body.force && repo.ref && !isAncestor(repo.ref, body.sha)) { stats.conflicts++; return send(422, { message: 'Update is not a fast forward' }); }
      repo.ref = body.sha;
      pushed();
      return send(200, { ref: 'refs/heads/main', object: { sha: repo.ref } });
    }
    send(404, { message: 'Not Found (mock)' });
  });

  return { server, api };
}
