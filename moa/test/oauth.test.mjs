import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as oauth from '../server/oauth.js';

const ENV = { GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'sec' };
const ORIGIN = 'https://moa.example.com';

test('config reports whether sign-in is set up', async () => {
  assert.deepEqual(await oauth.config(ENV).json(), { login: true, api: 'https://api.github.com' });
  assert.equal((await oauth.config({}).json()).login, false);
  assert.equal((await oauth.config({ GITHUB_CLIENT_ID: 'x' }).json()).login, false, 'needs the secret too');
});

test('login redirects to GitHub with repo + gist scope and a state cookie', () => {
  const r = oauth.login(new Request(`${ORIGIN}/api/auth/login`), ENV);
  assert.equal(r.status, 302);
  const to = new URL(r.headers.get('location'));
  assert.equal(to.origin + to.pathname, 'https://github.com/login/oauth/authorize');
  assert.equal(to.searchParams.get('client_id'), 'cid');
  assert.equal(to.searchParams.get('scope'), 'repo gist');
  assert.equal(to.searchParams.get('redirect_uri'), `${ORIGIN}/api/auth/callback`);
  const state = to.searchParams.get('state');
  assert.match(state, /^[0-9a-f]{32}$/);
  const cookie = r.headers.get('set-cookie');
  assert.ok(cookie.startsWith(`moa_oauth=${state};`) && /HttpOnly/.test(cookie) && /Secure/.test(cookie) && /SameSite=Lax/.test(cookie));
  assert.equal(oauth.login(new Request(`${ORIGIN}/api/auth/login`), {}).status, 500);
});

const cb = (qs, cookie) => new Request(`${ORIGIN}/api/auth/callback?${qs}`, { headers: cookie ? { cookie } : {} });

test('callback exchanges the code and hands the token back in the fragment', async () => {
  let sent;
  const fetchImpl = async (url, init) => { sent = { url, body: JSON.parse(init.body) }; return Response.json({ access_token: 'gho_abc', scope: 'repo' }); };
  const r = await oauth.callback(cb('code=c1&state=s1', 'moa_oauth=s1'), ENV, fetchImpl);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), `${ORIGIN}/#auth=gho_abc&scope=repo`);
  assert.equal(sent.url, 'https://github.com/login/oauth/access_token');
  assert.deepEqual(sent.body, { client_id: 'cid', client_secret: 'sec', code: 'c1', redirect_uri: `${ORIGIN}/api/auth/callback` });
  assert.match(r.headers.get('set-cookie'), /moa_oauth=;.*Max-Age=0/, 'state cookie cleared');
  assert.equal(r.headers.get('cache-control'), 'no-store');
});

test('callback rejects a missing or mismatched state (CSRF) without calling GitHub', async () => {
  const boom = async () => { throw new Error('must not be called'); };
  for (const [qs, cookie] of [['code=c&state=s1', 'moa_oauth=other'], ['code=c&state=s1', null], ['code=c', 'moa_oauth=s1']]) {
    const r = await oauth.callback(cb(qs, cookie), ENV, boom);
    assert.equal(r.headers.get('location'), `${ORIGIN}/#auth_error=state`);
  }
});

test('callback surfaces GitHub errors', async () => {
  let r = await oauth.callback(cb('error=access_denied&state=s1', 'moa_oauth=s1'), ENV);
  assert.equal(r.headers.get('location'), `${ORIGIN}/#auth_error=access_denied`);
  r = await oauth.callback(cb('code=c&state=s', 'moa_oauth=s'), ENV, async () => Response.json({ error: 'bad_verification_code' }));
  assert.equal(r.headers.get('location'), `${ORIGIN}/#auth_error=bad_verification_code`);
  r = await oauth.callback(cb('code=c&state=s', 'moa_oauth=s'), ENV, async () => { throw new Error('down'); });
  assert.equal(r.headers.get('location'), `${ORIGIN}/#auth_error=network`);
});

test('revoke deletes the grant with app credentials', async () => {
  let sent;
  const fetchImpl = async (url, init) => { sent = { url, init }; return new Response(null, { status: 204 }); };
  const r = await oauth.revoke(new Request(`${ORIGIN}/api/auth/revoke`, { method: 'POST', body: JSON.stringify({ token: 'gho_abc' }) }), ENV, fetchImpl);
  assert.equal(r.status, 204);
  assert.equal(sent.url, 'https://api.github.com/applications/cid/token');
  assert.equal(sent.init.method, 'DELETE');
  assert.equal(sent.init.headers.Authorization, `Basic ${btoa('cid:sec')}`);
  assert.deepEqual(JSON.parse(sent.init.body), { access_token: 'gho_abc' });
});

test('GitHub Enterprise URLs are configurable', () => {
  const r = oauth.login(new Request(`${ORIGIN}/api/auth/login`), { ...ENV, GITHUB_URL: 'https://ghe.corp/' });
  assert.ok(r.headers.get('location').startsWith('https://ghe.corp/login/oauth/authorize?'));
});
