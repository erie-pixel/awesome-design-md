/* ============================================================
   Moa — GitHub sign-in (OAuth web flow)
   The only server-side piece: GitHub requires a client secret to
   turn the login `code` into a token, and a secret can't live in a
   browser. Vercel runs these as functions from /api; nothing is
   stored server-side — the token goes straight back to the user's
   browser and every photo request still goes browser → GitHub.

   Env: GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET
        optional GITHUB_URL (default https://github.com),
                 GITHUB_API_URL (default https://api.github.com) for GHE
   ============================================================ */

const STATE_COOKIE = 'moa_oauth';
// repo: create the album's private repository, read/write it, invite
// and accept collaborators. GitHub OAuth has no narrower scope for that.
const SCOPE = 'repo';

export function settings(env) {
  return {
    id: env.GITHUB_CLIENT_ID || '',
    secret: env.GITHUB_CLIENT_SECRET || '',
    web: (env.GITHUB_URL || 'https://github.com').replace(/\/+$/, ''),
    api: (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, ''),
  };
}

const noStore = { 'Cache-Control': 'no-store' };

function cookies(req) {
  const out = {};
  for (const part of (req.headers.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function randomState() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}

const stateCookie = (value, maxAge) =>
  `${STATE_COOKIE}=${value}; Path=/api/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

/** GET /api/auth/config — lets the static app know sign-in is available. */
export function config(env) {
  const s = settings(env);
  return Response.json({ login: !!(s.id && s.secret), api: s.api }, { headers: noStore });
}

/** GET /api/auth/login — send the user to GitHub's consent screen. */
export function login(req, env) {
  const s = settings(env);
  if (!s.id) return new Response('GITHUB_CLIENT_ID가 설정되지 않았어요', { status: 500, headers: noStore });
  const origin = new URL(req.url).origin;
  const state = randomState();
  const to = new URL(`${s.web}/login/oauth/authorize`);
  to.searchParams.set('client_id', s.id);
  to.searchParams.set('redirect_uri', `${origin}/api/auth/callback`);
  to.searchParams.set('scope', SCOPE);
  to.searchParams.set('state', state);
  to.searchParams.set('allow_signup', 'true');
  return new Response(null, { status: 302, headers: { Location: to.toString(), 'Set-Cookie': stateCookie(state, 600), ...noStore } });
}

/**
 * GET /api/auth/callback — exchange the code for a token and hand it to
 * the app in the URL fragment (fragments never reach a server or a
 * Referer header; the app strips it from history right away).
 */
export async function callback(req, env, fetchImpl = fetch) {
  const s = settings(env);
  const url = new URL(req.url);
  const back = hash => new Response(null, { status: 302, headers: { Location: `${url.origin}/#${hash}`, 'Set-Cookie': stateCookie('', 0), ...noStore } });
  const err = url.searchParams.get('error');
  if (err) return back(`auth_error=${encodeURIComponent(err)}`);
  const code = url.searchParams.get('code'), state = url.searchParams.get('state');
  if (!code || !state || state !== cookies(req)[STATE_COOKIE]) return back('auth_error=state');
  try {
    const r = await fetchImpl(`${s.web}/login/oauth/access_token`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: s.id, client_secret: s.secret, code, redirect_uri: `${url.origin}/api/auth/callback` }),
    });
    const j = await r.json();
    if (!j.access_token) return back(`auth_error=${encodeURIComponent(j.error || 'exchange')}`);
    return back(`auth=${encodeURIComponent(j.access_token)}&scope=${encodeURIComponent(j.scope || '')}`);
  } catch {
    return back('auth_error=network');
  }
}

/** POST /api/auth/revoke {token} — sign-out also revokes the grant on GitHub. */
export async function revoke(req, env, fetchImpl = fetch) {
  const s = settings(env);
  let token = '';
  try { token = (await req.json()).token || ''; } catch { /* no body */ }
  if (!token || !s.id || !s.secret) return new Response(null, { status: 204, headers: noStore });
  try {
    await fetchImpl(`${s.api}/applications/${s.id}/token`, {
      method: 'DELETE',
      headers: { Accept: 'application/vnd.github+json', Authorization: `Basic ${btoa(`${s.id}:${s.secret}`)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_token: token }),
    });
  } catch { /* best effort */ }
  return new Response(null, { status: 204, headers: noStore });
}
