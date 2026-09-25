// End-to-end: two friends share one album through the mock GitHub API.
//   node test/e2e.mjs [--shots <dir>]
// Needs Playwright (global install is fine). OpenStreetMap tiles and
// Nominatim are stubbed so the run is offline and deterministic.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockGitHub } from './mock-github.mjs';
import { withExif } from './fixtures.mjs';
import * as oauth from '../server/oauth.js';
import * as K from '../js/crypto.js';

let chromium;
try { ({ chromium } = await import('playwright')); } catch { ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs')); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shotsArg = process.argv.indexOf('--shots');
const SHOTS = shotsArg > 0 ? path.resolve(process.argv[shotsArg + 1]) : null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const API_PORT = 9911, APP_PORT = 8911;
const API = `http://localhost:${API_PORT}`;
const APP = `http://localhost:${APP_PORT}/index.html`;

// ---------- servers ----------
const { server: apiServer, api } = createMockGitHub({ users: { 'tok-alice': 'alice', 'tok-bob': 'bob', 'tok-dave': 'dave' } });
await new Promise(r => apiServer.listen(API_PORT, r));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };

// Same CSP as production (vercel.json), with the mock API origin allowed.
const CSP = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8')).headers[0].headers.find(h => h.key === 'Content-Security-Policy').value
  .replace("connect-src 'self'", `connect-src 'self' ${API} http://localhost:${API_PORT + 1}`);

// The real /api/auth/* handlers, pointed at a fake github.com served below.
const APP_ORIGIN = `http://localhost:${APP_PORT}`;
const ENV = { GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'csecret', GITHUB_URL: `${APP_ORIGIN}/fake-github`, GITHUB_API_URL: API };
const TOKENS = { alice: 'tok-alice', bob: 'tok-bob', dave: 'tok-dave' };
const authStats = { revoked: 0, exchanged: 0 };
const fakeFetch = async (url, init) => {
  if (url.endsWith('/login/oauth/access_token')) {
    const b = JSON.parse(init.body);
    authStats.exchanged++;
    const who = b.client_id === 'cid' && b.client_secret === 'csecret' && b.code?.startsWith('code-') ? b.code.slice(5) : null;
    return Response.json(TOKENS[who] ? { access_token: TOKENS[who], scope: 'gist,repo', token_type: 'bearer' } : { error: 'bad_verification_code' });
  }
  if (url.includes('/applications/cid/token') && init.method === 'DELETE') { authStats.revoked++; return new Response(null, { status: 204 }); }
  throw new Error('unexpected fetch ' + url);
};
async function toWebRequest(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return new Request(APP_ORIGIN + req.url, { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
}
async function sendWeb(res, r) {
  const headers = {};
  r.headers.forEach((v, k) => { if (k !== 'set-cookie') headers[k] = v; });
  const cookies = r.headers.getSetCookie();
  if (cookies.length) headers['set-cookie'] = cookies;
  res.writeHead(r.status, headers);
  res.end(Buffer.from(await r.arrayBuffer()));
}

const appServer = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  // GitHub's consent screen: approve as whoever the `as` cookie names
  if (u.pathname === '/fake-github/login/oauth/authorize') {
    const who = /(?:^|;\s*)as=(\w+)/.exec(req.headers.cookie || '')?.[1];
    const back = new URL(u.searchParams.get('redirect_uri'));
    if (u.searchParams.get('client_id') !== 'cid' || u.searchParams.get('scope') !== 'repo gist') back.searchParams.set('error', 'bad_client');
    else if (!who) back.searchParams.set('error', 'access_denied');
    else { back.searchParams.set('code', `code-${who}`); back.searchParams.set('state', u.searchParams.get('state')); }
    res.writeHead(302, { Location: back.toString() });
    return res.end();
  }
  if (u.pathname.startsWith('/api/auth/')) {
    const r = await toWebRequest(req);
    const name = u.pathname.split('/').pop();
    const out = name === 'config' ? oauth.config(ENV) : name === 'login' ? oauth.login(r, ENV) : name === 'callback' ? await oauth.callback(r, ENV, fakeFetch) : name === 'revoke' ? await oauth.revoke(r, ENV, fakeFetch) : new Response('nope', { status: 404 });
    return sendWeb(res, out);
  }
  const p = path.join(ROOT, decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname));
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Content-Security-Policy': CSP });
  fs.createReadStream(p).pipe(res);
});
await new Promise(r => appServer.listen(APP_PORT, r));

let RA; // alice's album repository, once created
// the album as the repository holds it: album.json + index/*.json shards
const readIndex = (m = RA) => {
  const meta = JSON.parse(m.fileText('album.json'));
  const photos = {};
  for (const p of m.paths().filter(p => p.startsWith('index/'))) Object.assign(photos, JSON.parse(m.fileText(p)).photos);
  return { ...meta, photos };
};

/** Poll a Node-side condition (repository state) until it holds. */
const until = async (fn, ms = 30000) => { const end = Date.now() + ms; while (!(await fn())) { if (Date.now() > end) throw new Error('timed out: ' + fn); await new Promise(r => setTimeout(r, 100)); } };
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failures++; };
const watch = (page, who) => {
  page.on('pageerror', e => { console.log(`pageerror(${who}):`, e.message); failures++; });
  page.on('console', m => { if (m.type() === 'error' && /Content Security Policy/i.test(m.text())) { console.log(`CSP(${who}):`, m.text()); failures++; } });
};
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });

try {
  // ---------- stubs for OSM ----------
  const tilePage = await browser.newPage({ viewport: { width: 256, height: 256 } });
  await tilePage.setContent(`<body style="margin:0"><div style="width:256px;height:256px;background:#eef0ea;background-image:linear-gradient(#dfe3da 1px,transparent 1px),linear-gradient(90deg,#dfe3da 1px,transparent 1px);background-size:32px 32px"></div></body>`);
  const TILE = await tilePage.screenshot();
  await tilePage.close();
  const PLACES = [
    [33.4589, 126.9425, { name: '성산일출봉', address: { tourism: '성산일출봉', town: '성산읍', city: '서귀포시', province: '제주특별자치도', country: '대한민국', country_code: 'kr' } }],
    [33.2394, 126.4145, { name: '', address: { town: '안덕면', city: '서귀포시', province: '제주특별자치도', country: '대한민국', country_code: 'kr' } }],
    [37.5796, 126.9770, { name: '경복궁', address: { tourism: '경복궁', quarter: '세종로', borough: '종로구', city: '서울특별시', country: '대한민국', country_code: 'kr' } }],
    [35.6595, 139.7005, { name: '渋谷スクランブル交差点', address: { suburb: '渋谷', city: '渋谷区', state: '東京都', country: '日本', country_code: 'jp' } }],
  ];
  const stub = async ctx => {
    await ctx.route(/tile\.openstreetmap\.org/, r => r.fulfill({ status: 200, contentType: 'image/png', body: TILE }));
    await ctx.route(/nominatim\.openstreetmap\.org\/reverse/, r => {
      const u = new URL(r.request().url());
      const lat = +u.searchParams.get('lat'), lng = +u.searchParams.get('lon');
      const hit = PLACES.find(([a, b]) => Math.abs(a - lat) < 0.01 && Math.abs(b - lng) < 0.01);
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(hit ? hit[2] : { address: { country: '어딘가' } }) });
    });
    await ctx.route(/nominatim\.openstreetmap\.org\/search/, r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ lat: '33.2394', lon: '126.4145', display_name: '산방산, 안덕면, 서귀포시, 제주특별자치도, 대한민국', name: '산방산', address: { tourism: '산방산', town: '안덕면', city: '서귀포시', country: '대한민국' } }]) }));
  };

  // ---------- fixture media (drawn in the browser) ----------
  const gen = await browser.newPage();
  const scenes = [
    ['IMG_0001.JPG', ['#ff9a5a', '#ffd36e', '#5b8def'], '성산일출봉 🌅', { date: '2024:05:04 06:12:09', tz: '+09:00', lat: 33.4589, lng: 126.9425, alt: 61, contentId: 'D5B3C7E2-0001-4C44-9A0B-LIVEPHOTO001', lens: 'iPhone 15 Pro back triple camera 6.765mm f/1.78' }],
    ['IMG_0002.JPG', ['#2e8b57', '#9be15d', '#00c6fb'], '산방산 ⛰️', { date: '2024:05:04 15:40:31', tz: '+09:00', lat: 33.2394, lng: 126.4145 }],
    ['IMG_0003.JPG', ['#7f5539', '#e6ccb2', '#b08968'], '경복궁 🏯', { date: '2024:05:06 11:05:00', tz: '+09:00', lat: 37.5796, lng: 126.9770 }],
    ['IMG_0004.JPG', ['#3a0ca3', '#f72585', '#4cc9f0'], '渋谷 🌃', { date: '2023:12:24 21:30:12', tz: '+09:00', lat: 35.6595, lng: 139.7005 }],
    ['IMG_0005.JPG', ['#ffafcc', '#cdb4db', '#a2d2ff'], '생일 케이크 🎂', { date: '2024:02:14 19:00:00', tz: '+09:00' }],
  ];
  const files = [];
  for (const [name, colors, label, exif] of scenes) {
    const b64 = await gen.evaluate(async ([colors, label]) => {
      const c = document.createElement('canvas'); c.width = 1600; c.height = 1200;
      const g = c.getContext('2d');
      const gr = g.createLinearGradient(0, 0, 1600, 1200);
      colors.forEach((col, i) => gr.addColorStop(i / (colors.length - 1), col));
      g.fillStyle = gr; g.fillRect(0, 0, 1600, 1200);
      for (let i = 0; i < 40; i++) { g.fillStyle = `rgba(255,255,255,${Math.random() * 0.18})`; g.beginPath(); g.arc(Math.random() * 1600, Math.random() * 1200, 30 + Math.random() * 160, 0, 7); g.fill(); }
      g.fillStyle = 'rgba(0,0,0,.35)'; g.font = '600 120px sans-serif'; g.textAlign = 'center'; g.fillText(label, 800, 640);
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
      const buf = new Uint8Array(await blob.arrayBuffer());
      let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return btoa(s);
    }, [colors, label]);
    files.push({ name, mimeType: 'image/jpeg', buffer: Buffer.from(withExif(Buffer.from(b64, 'base64'), exif)) });
  }
  // the Live Photo motion part (webm stands in for .mov: Chromium has no HEVC/H.264)
  const liveB64 = await gen.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 640; c.height = 480;
    const g = c.getContext('2d');
    const rec = new MediaRecorder(c.captureStream(30), { mimeType: 'video/webm' });
    const chunks = []; rec.ondataavailable = e => chunks.push(e.data);
    rec.start();
    const t0 = performance.now();
    await new Promise(done => { (function f() { const t = (performance.now() - t0) / 1500; g.fillStyle = `hsl(${30 + t * 30},90%,${55 + t * 10}%)`; g.fillRect(0, 0, 640, 480); g.fillStyle = '#fff5'; g.beginPath(); g.arc(320, 480 - t * 300, 80, 0, 7); g.fill(); if (t < 1) requestAnimationFrame(f); else done(); })(); });
    rec.stop();
    await new Promise(r => rec.onstop = r);
    const buf = new Uint8Array(await new Blob(chunks).arrayBuffer());
    let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  });
  files.push({ name: 'IMG_0001.webm', mimeType: 'video/webm', buffer: Buffer.from(liveB64, 'base64') });
  files.push({ name: 'IMG_0001.AAE', mimeType: 'application/xml', buffer: Buffer.from('<plist/>') });
  await gen.close();

  // ---------- Alice: create album and upload ----------
  const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ko-KR', timezoneId: 'Asia/Seoul' };
  const ctxA = await browser.newContext(phone);
  await stub(ctxA);
  const A = await ctxA.newPage();
  watch(A, 'A');
  await ctxA.addCookies([{ name: 'as', value: 'alice', url: APP_ORIGIN }]);
  await A.goto(APP);
  await A.waitForSelector('#loginBtn');
  ok(!(await A.isVisible('#connectForm')), 'welcome leads with "Continue with GitHub"; token form tucked away');
  if (SHOTS) { await A.waitForTimeout(600); await A.screenshot({ path: `${SHOTS}/01-welcome.png` }); }
  await A.click('#loginBtn');
  await A.waitForSelector('#newRepoBtn');
  ok(authStats.exchanged === 1 && (await A.evaluate(() => JSON.parse(localStorage.getItem('moa.auth')).login)) === 'alice', 'signed in through the OAuth callback — no token typed');
  ok(!(await A.evaluate(() => location.hash)), 'token removed from the address bar');
  if (SHOTS) await A.screenshot({ path: `${SHOTS}/01b-home-empty.png` });
  await A.click('#newRepoBtn');
  await A.fill('#nrTitle', '우리들의 봄 여행');
  ok(/^moa-\d{8}$/.test(await A.inputValue('#nrName')), 'Korean album name gets an ASCII repository name');
  await A.fill('#nrName', 'moa-spring-trip');
  await A.click('#nrOk');
  await A.waitForFunction(() => document.querySelector('#content .empty h2')?.textContent.includes('Add your first photos'));
  RA = api.at('alice/moa-spring-trip');
  ok(RA.repo.private && RA.repo.topics.includes('moa-album'), 'album repository created private and tagged moa-album');
  ok(RA.paths().includes('album.json') && RA.paths().includes('README.md') && !RA.paths().includes('index.json'), 'album initialized with README.md + album.json');
  ok(readIndex().members.alice, 'alice recorded as member');

  await A.setInputFiles('#fileInput', files);
  await A.waitForSelector('#upGo');
  const summary = await A.textContent('.up-summary');
  ok(/5 photos/.test(summary) && /1 Live/.test(summary) && /4 with location/.test(summary), `review sheet summary: "${summary}"`);
  ok(await A.locator('.up-item').count() === 5, 'AAE sidecar ignored, webm folded into the Live Photo');
  ok(await A.isVisible('#upPlan .cap') && (await A.textContent('#upPlan')).includes('left of 10 GB'), 'upload sheet shows this upload vs remaining capacity');
  const planOn = await A.textContent('#upPlan .cap-labels');
  await A.click('#upOrig + span');
  const planOff = await A.textContent('#upPlan .cap-labels');
  ok(planOn !== planOff, `turning originals off recomputes the estimate (${planOn.trim()} → ${planOff.trim()})`);
  await A.click('#upOrig + span');
  await A.fill('#upTags', '봄여행');
  if (SHOTS) { await A.waitForTimeout(500); await A.screenshot({ path: `${SHOTS}/02-upload-review.png` }); }
  await A.click('#upGo');
  await A.waitForFunction(() => document.querySelectorAll('#content .tile').length === 5, null, { timeout: 60000 });
  ok(true, '5 tiles in the library after upload');
  const ix1 = readIndex();
  const live = Object.values(ix1.photos).find(p => p.name === 'IMG_0001.JPG');
  ok(live && live.files.live && RA.paths().includes(live.files.live), 'Live Photo video stored next to the still');
  ok(live.contentId === 'D5B3C7E2-0001-4C44-9A0B-LIVEPHOTO001', 'Apple content identifier kept');
  ok(live.takenAt === '2024-05-04T06:12:09' && live.tz === '+09:00' && Math.abs(live.gps.lat - 33.4589) < 1e-4, 'EXIF date/offset/GPS stored');
  ok(Object.values(ix1.photos).every(p => p.tags?.includes('봄여행')), 'upload tags applied');
  ok(Object.values(ix1.photos).every(p => ['original', 'preview', 'thumb'].every(k => RA.paths().includes(p.files[k]))), 'original + preview + thumb files committed');
  ok(/^media\/2024\/05\/04\//.test(live.files.original), `media stored in day folders (${live.files.original})`);
  ok(['index/2023-12.json', 'index/2024-02.json', 'index/2024-05.json'].every(p => RA.paths().includes(p)), 'index split into monthly shards');

  // place names resolve in the background and are committed
  await A.waitForFunction(() => Object.values(window.__moa.S.index.photos).filter(p => p.place).length === 4, null, { timeout: 30000 });
  await A.evaluate(() => window.__moa.flush());
  await A.waitForFunction(() => !window.__moa.S.pending.length, null, { timeout: 20000 });
  const ix2 = readIndex();
  ok(Object.values(ix2.photos).filter(p => p.place).length === 4, 'reverse-geocoded places committed to index.json');

  // date view
  await A.waitForTimeout(400);
  const months = await A.$$eval('.month', els => els.map(e => e.textContent));
  ok(JSON.stringify(months) === JSON.stringify(['May 2024', 'February 2024', 'December 2023']), `date view months newest first: ${months}`);
  ok(await A.locator('.tile .badge').count() === 1, 'LIVE badge on exactly one tile');
  if (SHOTS) await A.screenshot({ path: `${SHOTS}/03-library-date.png` });

  // place view
  await A.click('[data-view=place]');
  await A.waitForSelector('.place-card');
  const placeTitles = await A.$$eval('.place-card h3', els => els.map(e => e.textContent));
  ok(JSON.stringify(placeTitles) === JSON.stringify(['서울특별시', '서귀포시', '渋谷区', 'No location']), `place view groups: ${placeTitles}`);
  await A.selectOption('[data-ctl=placeOrder]', 'count');
  ok((await A.$$eval('.place-card h3', els => els.map(e => e.textContent)))[0] === '서귀포시', 'place view sorted by photo count');
  if (SHOTS) { await A.waitForTimeout(500); await A.screenshot({ path: `${SHOTS}/04-library-place.png` }); }

  // map view
  await A.click('[data-view=map]');
  await A.waitForSelector('.pin img.ok', { timeout: 15000 });
  ok(await A.locator('.pin').count() >= 2, `map shows ${await A.locator('.pin').count()} photo pins`);
  if (SHOTS) await A.screenshot({ path: `${SHOTS}/05-map.png` });

  // viewer + Live Photo + tagging
  await A.click('[data-view=date]');
  await A.click(`.tile[data-id="${live.id}"]`);
  await A.waitForSelector('#viewer:not([hidden])');
  ok(await A.isVisible('#livePill'), 'LIVE control shown in viewer');
  await A.waitForFunction(() => document.querySelector('#vStage').classList.contains('live-on'), null, { timeout: 10000 });
  ok(true, 'Live Photo motion auto-plays on open');
  await A.waitForFunction(() => !document.querySelector('#vStage').classList.contains('live-on'), null, { timeout: 10000 });
  await A.click('#livePill');
  await A.waitForFunction(() => document.querySelector('#vStage').classList.contains('live-on'), null, { timeout: 5000 });
  ok(true, 'tapping LIVE replays the motion');
  if (SHOTS) { await A.waitForTimeout(500); await A.screenshot({ path: `${SHOTS}/06-viewer-live.png` }); }
  await A.click('[data-v=info]');
  await A.fill('#iTag', '제주');
  await A.press('#iTag', 'Enter');
  await A.waitForSelector('#vInfo .tagrow .chip:has-text("제주")');
  ok(await A.textContent('#iPlace').then(t => t.includes('성산일출봉')), 'info panel shows place name');
  if (SHOTS) { await A.waitForTimeout(500); await A.screenshot({ path: `${SHOTS}/07-viewer-info.png` }); }
  await A.click('[data-v=info]');
  await A.click('[data-v=close]');

  // album via selection mode
  await A.click('#selectBtn');
  const ids = await A.$$eval('#content .tile', t => t.slice(0, 3).map(x => x.dataset.id));
  for (const id of ids) await A.click(`#content .tile[data-id="${id}"]`);
  await A.click('[data-sel=album]');
  await A.click('[data-pick=__new]');
  await A.fill('#albumName', '제주 3박 4일');
  await A.click('#albumOk');
  await A.evaluate(() => window.__moa.flush());
  await A.waitForFunction(() => !window.__moa.S.pending.length, null, { timeout: 20000 });
  const ix3 = readIndex();
  const album = Object.values(ix3.albums)[0];
  ok(album?.name === '제주 3박 4일' && Object.values(ix3.photos).filter(p => p.albums?.includes(album.id)).length === 3, 'album created with 3 selected photos');
  ok(Object.values(ix3.photos).find(p => p.id === live.id).tags.includes('제주'), 'tag edit committed');

  // ---------- Alice invites Bob by GitHub username ----------
  await A.click('[data-tab=settings]');
  await A.click('[data-act=invite]');
  await A.fill('#invUser', 'nobody-here');
  await A.click('#invSend');
  await A.waitForFunction(() => document.querySelector('#toast').textContent.includes('no such GitHub user'));
  ok(true, 'unknown GitHub username is reported');
  await A.fill('#invUser', 'bob');
  await A.click('#invSend');
  await A.waitForSelector('#invList :text("Pending")');
  ok(RA.repo.invitations.some(i => i.invitee === 'bob'), 'invitation created on GitHub for @bob');
  if (SHOTS) { await A.waitForTimeout(400); await A.screenshot({ path: `${SHOTS}/08a-invite.png` }); }
  await A.click('#scrim', { position: { x: 10, y: 10 } });
  await A.click('[data-tab=photos]');

  // ---------- Bob signs in and accepts ----------
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 820 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
  await stub(ctxB);
  await ctxB.addCookies([{ name: 'as', value: 'bob', url: APP_ORIGIN }]);
  const B = await ctxB.newPage();
  watch(B, 'B');
  await B.goto(`${APP}#join=alice/moa-spring-trip&by=alice`);
  ok((await B.textContent('.invite-banner')).includes('@alice'), 'invite link shows who invited');
  await B.click('#loginBtn');
  await B.waitForSelector('[data-accept]');
  ok((await B.textContent('#homeInvites')).includes('우리들의 봄 여행'), 'bob sees the invitation after signing in');
  if (SHOTS) await B.screenshot({ path: `${SHOTS}/08b-accept.png` });
  await B.click('[data-accept]');
  await B.waitForFunction(() => document.querySelectorAll('#content .tile').length === 5);
  ok(RA.repo.collaborators.get('bob') === 'push', 'accepting makes bob a collaborator');
  ok(true, 'bob sees all 5 photos');
  await B.evaluate(() => window.__moa.flush());
  await B.waitForFunction(() => !window.__moa.S.pending.length, null, { timeout: 20000 });
  ok(readIndex().members.bob, 'bob joined the member list');

  // tag view, bob-side
  await B.click('[data-view=tag]');
  const tagTitles = await B.$$eval('.place-card h3', els => els.map(e => e.textContent));
  ok(tagTitles[0] === '#봄여행' && tagTitles.includes('#제주'), `tag view groups: ${tagTitles}`);
  await B.click('[data-view=date]');

  // concurrent edits from both friends → both survive (ref update conflict + replay)
  const [p0, p1] = await B.$$eval('#content .tile', t => [t[0].dataset.id, t[1].dataset.id]);
  const conflictsBefore = api.stats.conflicts;
  const shardOfP = id => `index/${readIndex().photos[id].takenAt.slice(0, 7)}.json`;
  RA.commitJson(shardOfP(p1), d => { d.photos[p1].caption = '다른 기기에서 먼저 저장'; }, 'external write');
  const shardShas = Object.fromEntries(RA.paths().filter(p => p.startsWith('index/')).map(p => [p, RA.shaOf(p)]));
  await B.click(`#content .tile[data-id="${p0}"]`);
  await B.click('[data-v=like]');
  await Promise.all([
    B.evaluate(() => window.__moa.flush()),
    A.evaluate(async id => { const m = window.__moa; m.S.pending.push({ op: 'tag', ids: [id], tag: '동시편집', on: true }); await m.flush(); }, p1),
  ]);
  await B.waitForFunction(() => !window.__moa.S.pending.length, null, { timeout: 20000 });
  await A.waitForFunction(() => !window.__moa.S.pending.length, null, { timeout: 20000 });
  const ix4 = readIndex();
  ok(ix4.photos[p0].likes?.includes('bob'), 'bob\'s like saved');
  ok(ix4.photos[p1].tags?.includes('동시편집') && ix4.photos[p1].caption === '다른 기기에서 먼저 저장', 'alice\'s concurrent tag merged with the external caption');
  ok(api.stats.conflicts > conflictsBefore, `fast-forward conflicts happened and were retried (${api.stats.conflicts - conflictsBefore})`);
  const touched = Object.keys(shardShas).filter(p => RA.shaOf(p) !== shardShas[p]).sort();
  const expected = [...new Set([shardOfP(p0), shardOfP(p1)])].sort();
  ok(JSON.stringify(touched) === JSON.stringify(expected), `edits rewrote only the touched shards (${touched.join(', ')})`);
  // comment
  await B.click('[data-v=comments]');
  await B.fill('#iCmt', '여기 또 가자!');
  await B.press('#iCmt', 'Enter');
  await B.evaluate(() => window.__moa.flush());
  await B.waitForFunction(() => !window.__moa.S.pending.length, null, { timeout: 20000 });
  if (SHOTS) await B.screenshot({ path: `${SHOTS}/08-desktop-viewer.png` });
  await B.click('[data-v=close]');

  // alice pulls bob's changes
  await A.evaluate(() => window.__moa.refresh());
  const aliceSees = await A.evaluate(id => window.__moa.S.index.photos[id], p0);
  ok(aliceSees.likes?.includes('bob') && aliceSees.comments?.[0]?.text === '여기 또 가자!', 'alice sees bob\'s like and comment after refresh');

  // manual place edit
  const noGps = Object.values(ix4.photos).find(p => !p.gps);
  await A.click(`#content .tile[data-id="${noGps.id}"]`);
  await A.click('[data-v=info]');
  await A.click('[data-i=editPlace]');
  await A.fill('#iPlaceIn', '산방산');
  await A.press('#iPlaceIn', 'Enter');
  await A.click('#iPlaceRes [data-r="0"]');
  await A.evaluate(() => window.__moa.flush());
  await A.waitForFunction(() => !window.__moa.S.pending.length, null, { timeout: 20000 });
  ok(readIndex().photos[noGps.id].place?.name === '산방산', 'place set manually from search');
  await A.click('[data-v=info]');
  await A.click('[data-v=close]');

  // delete removes the files from the tree
  const victim = ix4.photos[p1];
  const victimSha = RA.shaOf(victim.files.original);
  await A.click(`#content .tile[data-id="${p1}"]`);
  await A.click('[data-v=info]');
  await A.click('[data-i=delete]');
  await A.waitForSelector('#delOk');
  ok(!(await A.isChecked('#delPurge')), 'delete sheet offers "Also erase from history", off by default');
  await A.click('#delOk');
  await A.evaluate(() => window.__moa.flush());
  await A.waitForFunction(() => !window.__moa.S.pending.length, null, { timeout: 20000 });
  ok(!readIndex().photos[p1] && !RA.paths().includes(victim.files.thumb) && !RA.paths().includes(victim.files.original), 'delete removes entry and its files');
  ok(RA.reachable(victimSha), 'a plain delete still leaves the photo in git history');

  // duplicate upload is skipped
  await A.keyboard.press('Escape'); // closes the info panel
  await A.keyboard.press('Escape'); // closes the viewer
  await A.waitForSelector('#viewer', { state: 'hidden' });
  ok(true, 'Escape closes info panel, then viewer');
  await A.setInputFiles('#fileInput', [files[2]]);
  await A.waitForSelector('#upGo');
  ok((await A.textContent('.up-summary')).includes('1 duplicate'), 're-uploading the same file is flagged as duplicate');
  await A.click('[data-close]');

  // settings tab
  await A.click('[data-tab=settings]');
  await A.waitForSelector('#tab-settings .panel');
  const settingsText = await A.textContent('#tab-settings');
  ok(settingsText.includes('@alice') && settingsText.includes('@bob') && settingsText.includes('Storage'), 'settings lists members and storage');
  ok(settingsText.includes('left') && settingsText.includes('10 GB') && await A.locator('#tab-settings .dot').count() >= 5, 'storage ring + GitHub limit rows rendered');

  // erase history: one root commit with today's files; the deleted photo is gone from every commit
  const pathsBefore = RA.paths();
  const bobHadIt = await B.evaluate(async p => !!(await (await caches.open('moa-media-v1')).match(`https://moa.cache/alice/moa-spring-trip/${p}`)), victim.files.thumb);
  await A.click('[data-act=purge]');
  await A.click('#purgeOk');
  await A.waitForFunction(() => document.querySelector('#toast').textContent.includes('History erased'), null, { timeout: 20000 });
  ok(RA.history().length === 1 && !RA.reachable(victimSha), `history erased: ${RA.history().length} commit, deleted original unreachable`);
  ok(JSON.stringify(RA.paths()) === JSON.stringify(pathsBefore) && Object.keys(readIndex().photos).length === 4, 'the album itself is unchanged');
  // bob's device still points at the old history; his next save lands on the new one
  await B.evaluate(async id => { const m = window.__moa; await m.refresh(); m.S.pending.push({ op: 'tag', ids: [id], tag: '지운뒤', on: true }); await m.flush(); }, p0);
  await B.waitForFunction(() => !window.__moa.S.pending.length, null, { timeout: 20000 });
  ok(readIndex().photos[p0].tags.includes('지운뒤') && RA.history().length === 2, 'a friend on the old history saves on top of the erased one');
  const bobStill = await B.evaluate(async p => !!(await (await caches.open('moa-media-v1')).match(`https://moa.cache/alice/moa-spring-trip/${p}`)), victim.files.thumb);
  ok(!bobStill, `friend's device drops its cached copy of the deleted photo (had it: ${bobHadIt})`);
  // language: English by default, Korean from Settings, remembered
  ok((await A.textContent('[data-tab=photos]')).trim() === 'Library', 'English UI by default');
  await A.selectOption('[data-lang]', 'ko');
  ok((await A.textContent('[data-tab=photos]')).trim() === '보관함' && (await A.textContent('#tab-settings h1')) === '설정' && (await A.getAttribute('html', 'lang')) === 'ko', 'switching to 한국어 re-labels the app');
  if (SHOTS) { await A.waitForTimeout(300); await A.screenshot({ path: `${SHOTS}/09b-settings-ko.png` }); }
  await A.selectOption('[data-lang]', 'en');
  ok((await A.evaluate(() => JSON.parse(localStorage.getItem('moa.prefs')).lang)) === 'en' && (await A.textContent('#tab-settings h1')) === 'Settings', 'language choice is saved');
  if (SHOTS) await A.screenshot({ path: `${SHOTS}/09-settings.png`, fullPage: true });
  await A.click('[data-act=invite]');
  const link = await A.inputValue('#inviteLink');
  ok(link.includes('#join=alice%2Fmoa-spring-trip') && link.includes('by=alice'), 'invite link generated');
  await A.click('#scrim', { position: { x: 10, y: 10 } });

  // albums tab
  await A.click('[data-tab=albums]');
  await A.waitForSelector('[data-album]');
  if (SHOTS) { await A.waitForTimeout(500); await A.screenshot({ path: `${SHOTS}/10-albums.png` }); }
  await A.click('[data-album]');
  ok((await A.textContent('#hero h1')) === '제주 3박 4일', 'album page opens');

  // ---------- an encrypted album ----------
  const PASS = 'our secret trip 2024', PASS2 = 'a brand new passphrase';
  await A.click('[data-tab=settings]');
  await A.click('[data-act=home]');
  await A.click('#newRepoBtn');
  await A.fill('#nrTitle', '비밀 여행');
  await A.click('#encOn + span');
  const encName = await A.inputValue('#nrName');
  ok(/^moa-[a-z0-9]{6}$/.test(encName), `encrypted album gets a repository name that doesn't reveal its title (${encName})`);
  await A.fill('#encPass', 'short');
  await A.fill('#encPass2', 'short');
  await A.click('#nrOk');
  ok((await A.textContent('#nrErr')).includes('8 characters'), 'too-short passphrase refused');
  await A.fill('#encPass', PASS);
  await A.fill('#encPass2', PASS);
  if (SHOTS) { await A.waitForTimeout(300); await A.screenshot({ path: `${SHOTS}/13-new-encrypted.png` }); }
  await A.click('#nrOk');
  await A.waitForFunction(() => document.querySelector('#content .empty h2')?.textContent.includes('Add your first photos'), null, { timeout: 20000 });
  await A.waitForSelector('#rcCode');
  const REC = (await A.textContent('#rcCode')).trim();
  ok(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){5}$/.test(REC), `a recovery code is shown once the album exists (${REC.slice(0, 4)}-…)`);
  if (SHOTS) { await A.waitForTimeout(300); await A.screenshot({ path: `${SHOTS}/13b-recovery-code.png` }); }
  await A.click('#sheet [data-close].btn-primary');
  const RE = api.at(`alice/${encName}`);
  ok(!!JSON.parse(RE.fileText('album.json')).recovery, 'album.json also holds the key wrapped by the recovery code');
  const header = JSON.parse(RE.fileText('album.json'));
  ok(K.isHeader(header) && !RE.fileText('album.json').includes('비밀') && RE.repo.description === 'Moa · encrypted' && !RE.fileText('README.md').includes('비밀'), 'album.json holds only the wrapped key; no title in description or README');
  await A.setInputFiles('#fileInput', [files[0], files[5], files[1]]);
  await A.waitForSelector('#upGo');
  await A.click('#upGo');
  await A.waitForFunction(() => document.querySelectorAll('#content .tile').length === 2, null, { timeout: 60000 });
  const encPaths = RE.paths();
  const stored = encPaths.filter(p => p !== 'album.json' && p !== 'README.md');
  ok(stored.every(p => p === 'album.bin' || /^index\/s\d\d\.bin$/.test(p) || /^data\/[0-9a-f]{2}\/[0-9a-f]{30}$/.test(p)), `only opaque names in the repository (${stored.length} files)`);
  ok(stored.every(p => RE.fileBytes(p).subarray(0, 4).toString() === 'MOA1'), 'every stored file is sealed');
  const leaks = ['IMG_0001', '성산', 'Apple', '2024-05', 'JFIF', 'Exif', 'webm'].filter(w => stored.some(p => RE.fileBytes(p).includes(w)));
  ok(!leaks.length, `no names, places, dates or image headers readable on GitHub${leaks.length ? ' — leaked: ' + leaks : ''}`);
  const aKey = await K.unlockAlbumKey(header, PASS);
  const encIndex = JSON.parse(new TextDecoder().decode(await K.open(aKey, RE.fileBytes('album.bin'))));
  ok(encIndex.title === '비밀 여행', 'album.bin decrypts to the album meta with the passphrase');
  await A.click('#content .tile');
  await A.waitForFunction(() => { const i = document.querySelector('#vImg'); return i.src.startsWith('blob:') && i.naturalWidth > 0 && !i.style.filter; }, null, { timeout: 15000 });
  ok(true, 'viewer decrypts and shows the photo');
  await A.click('[data-v=close]');
  ok(!(await A.evaluate(async repo => !!(await (await caches.open('moa-media-v1')).match(`https://moa.cache/alice/${repo}/.moa/index-cache.json`)), encName)), 'no plaintext offline index kept for an encrypted album');
  await A.click('[data-tab=settings]');
  ok((await A.textContent('#tab-settings')).includes('Encrypted'), 'settings show the album is encrypted');
  await A.click('[data-act=invite]');
  await A.fill('#invUser', 'bob');
  await A.click('#invSend');
  await A.waitForSelector('#invList :text("Pending")');
  await A.click('#scrim', { position: { x: 10, y: 10 } });

  await B.click('[data-tab=settings]');
  await B.click('[data-act=home]');
  await B.waitForSelector('[data-accept]');
  await B.click('[data-accept]');
  await B.waitForSelector('#unlockForm');
  ok(true, 'the invited friend is asked for the album passphrase');
  if (SHOTS) await B.screenshot({ path: `${SHOTS}/14-unlock.png` });
  await B.fill('#unlockPass', 'not the passphrase');
  await B.click('#unlockBtn');
  await B.waitForSelector('#unlockErr:not([hidden])', { timeout: 15000 });
  ok((await B.textContent('#unlockErr')).includes('Wrong passphrase'), 'wrong passphrase refused');
  await B.fill('#unlockPass', PASS);
  await B.click('#unlockBtn');
  await B.waitForFunction(() => document.querySelectorAll('#content .tile img.ok').length === 2, null, { timeout: 20000 });
  ok((await B.textContent('#spaceName')) === '비밀 여행', 'with the passphrase the friend sees the photos and the title');
  await B.reload();
  await B.waitForFunction(() => document.querySelectorAll('#content .tile').length === 2, null, { timeout: 20000 });
  ok(!(await B.isVisible('#unlockForm')), 'the key is remembered on this device');

  // delete + erase from history in one step
  const encVictim = await A.evaluate(() => Object.values(window.__moa.S.index.photos).find(p => p.files.live));
  const encVictimSha = RE.shaOf(encVictim.files.live);
  await A.click('[data-tab=photos]');
  await A.click(`#content .tile[data-id="${encVictim.id}"]`);
  await A.click('[data-v=info]');
  await A.click('[data-i=delete]');
  await A.click('#delPurge + span');
  await A.click('#delOk');
  await until(() => !RE.paths().includes(encVictim.files.live) && RE.history().length === 1, 150000);
  ok(!RE.reachable(encVictimSha) && RE.history().length === 1 && !RE.paths().includes(encVictim.files.live), 'delete with "erase from history" removes the photo from every commit');
  await A.keyboard.press('Escape'); // info panel
  await A.keyboard.press('Escape'); // viewer
  await A.waitForSelector('#viewer', { state: 'hidden' });

  // new passphrase: same key, old passphrase no longer opens album.json
  await A.click('[data-tab=settings]');
  await A.click('[data-act=passphrase]');
  await A.fill('#ppOld', 'wrong old one');
  await A.fill('#encPass', PASS2);
  await A.fill('#encPass2', PASS2);
  await A.click('#ppOk');
  await A.waitForSelector('#ppErr:not([hidden])', { timeout: 15000 });
  ok((await A.textContent('#ppErr')).includes('Wrong passphrase'), 'changing the passphrase needs the current one');
  const headerText = RE.fileText('album.json');
  await A.fill('#ppOld', PASS);
  await A.click('#ppOk');
  await until(() => RE.fileText('album.json') !== headerText && RE.history().length === 1, 150000);
  const header2 = JSON.parse(RE.fileText('album.json'));
  let oldWorks = true;
  try { await K.unlockAlbumKey(header2, PASS); } catch { oldWorks = false; }
  const k2 = await K.unlockAlbumKey(header2, PASS2);
  ok(!oldWorks && JSON.parse(new TextDecoder().decode(await K.open(k2, RE.fileBytes('album.bin')))).title === '비밀 여행', 'new passphrase opens the album, the old one does not');
  ok(RE.history().length === 1, 'the old wrapped key was erased from history too');
  await B.evaluate(() => window.__moa.refresh());
  await B.waitForFunction(() => document.querySelectorAll('#content .tile').length === 1, null, { timeout: 20000 });
  ok(true, 'the friend\'s remembered key keeps working after the passphrase change');
  await B.click('[data-tab=settings]');
  await B.click('[data-act=lockHere]');
  await B.waitForSelector('#unlockForm');
  await B.reload();
  await B.waitForSelector('#unlockForm', { timeout: 20000 });
  ok(true, '"Lock on this device" forgets the key');
  if (SHOTS) await A.screenshot({ path: `${SHOTS}/15-settings-encrypted.png`, fullPage: true });

  // forgot the passphrase: the recovery code opens the album, then a new passphrase is set
  const PASS3 = 'third passphrase after recovery';
  await B.click('#unlockForgot');
  await B.fill('#unlockCode', REC.toLowerCase().replace(/-/g, ' '));
  await B.click('#unlockBtn');
  await B.waitForSelector('#ppOk', { timeout: 20000 });
  await B.waitForFunction(() => document.querySelectorAll('#content .tile').length === 1, null, { timeout: 20000 });
  ok(await B.isHidden('#ppOldBox'), 'recovery code unlocks and asks for a new passphrase (no old one needed)');
  const hRec = RE.fileText('album.json');
  await B.fill('#encPass', PASS3);
  await B.fill('#encPass2', PASS3);
  await B.click('#ppOk');
  await until(() => RE.fileText('album.json') !== hRec && RE.history().length === 1, 150000);
  const h3 = JSON.parse(RE.fileText('album.json'));
  const k3 = await K.unlockAlbumKey(h3, PASS3);
  ok(!!k3 && !!(await K.unlockWithRecovery(h3, REC)), 'new passphrase works and the recovery code still does');

  // turn encryption off, then on again, on the same album
  const sealedSha = RE.shaOf(RE.paths().find(p => p.startsWith('data/')));
  await A.click('[data-tab=settings]');
  await A.click('[data-act=decryptAlbum]');
  await A.click('#cvGo');
  await until(() => { try { return JSON.parse(RE.fileText('album.json')).app === 'moa' && RE.history().length === 1; } catch { return false; } }, 150000);
  const plainPaths = RE.paths();
  ok(!plainPaths.some(p => p.startsWith('data/') || p.endsWith('.bin')) && plainPaths.some(p => /^thumb\/\d{4}\/\d\d\/\d\d\//.test(p)) && plainPaths.some(p => /^index\/\d{4}-\d\d\.json$/.test(p)), 'encryption off: files back under dated paths, readable index');
  ok(readIndex(RE).title === '비밀 여행' && RE.repo.description === '비밀 여행 · Moa' && !RE.reachable(sealedSha), 'title restored to description; encrypted copies erased from history');
  await B.evaluate(() => window.__moa.refresh());
  await B.waitForFunction(() => document.querySelectorAll('#content .tile img.ok').length === 1 && !window.__moa.S.gh.sealed, null, { timeout: 20000 });
  ok(true, 'friend sees the album without a passphrase');
  const PASS4 = 'encrypted once again';
  const plainSha = RE.shaOf(plainPaths.find(p => p.startsWith('thumb/')));
  await A.waitForSelector('[data-act=encryptAlbum]');
  await A.click('[data-act=encryptAlbum]');
  await A.fill('#encPass', PASS4);
  await A.fill('#encPass2', PASS4);
  await A.click('#cvGo');
  await A.waitForSelector('#rcCode', { timeout: 150000 });
  ok(true, 'encrypting an existing album hands out a recovery code');
  await A.click('#sheet [data-close].btn-primary');
  await until(() => RE.history().length === 1 && K.isHeader(JSON.parse(RE.fileText('album.json'))), 150000);
  const reStored = RE.paths().filter(p => p !== 'album.json' && p !== 'README.md');
  ok(reStored.every(p => RE.fileBytes(p).subarray(0, 4).toString() === 'MOA1') && !RE.reachable(plainSha) && RE.repo.description === 'Moa · encrypted', 'encryption on: everything sealed, plain copies erased from history');
  await B.evaluate(() => window.__moa.refresh());
  await B.waitForSelector('#unlockForm', { timeout: 20000 });
  await B.fill('#unlockPass', PASS4);
  await B.click('#unlockBtn');
  await B.waitForFunction(() => document.querySelectorAll('#content .tile img.ok').length === 1, null, { timeout: 20000 });
  ok(true, 'friend needs the new passphrase once, then sees the photo');

  // ---------- invite link / QR: dave joins without anyone typing his username ----------
  await A.click('[data-tab=settings]');
  await A.click('[data-act=invite]');
  await A.click('#invOnce');
  await A.waitForSelector('#invShow .qr');
  const onceLink = await A.inputValue('#invLink');
  ok(onceLink.includes('#invite=') && onceLink.includes('&k=') && api.gists.size === 1, 'one-time QR + link created (carries the album key for an encrypted album)');
  if (SHOTS) { await A.waitForTimeout(300); await A.screenshot({ path: `${SHOTS}/16-invite-qr.png` }); }
  const ctxD = await browser.newContext(phone);
  await stub(ctxD);
  await ctxD.addCookies([{ name: 'as', value: 'dave', url: APP_ORIGIN }]);
  const D = await ctxD.newPage();
  watch(D, 'D');
  await D.goto(onceLink.replace(/^https?:\/\/[^/]+\//, APP_ORIGIN + '/'));
  ok((await D.textContent('.invite-banner')).includes('invited'), 'invite link opens a sign-in screen that says you are invited');
  await D.click('#loginBtn');
  await D.waitForSelector('[data-join=go]', { timeout: 20000 });
  ok((await D.textContent('.join-card')).includes('@alice'), 'after sign-in: "Join … from @alice?"');
  if (SHOTS) await D.screenshot({ path: `${SHOTS}/17-join-ask.png` });
  ok(!RE.repo.collaborators.has('dave') && !RE.repo.invitations.some(i => i.invitee === 'dave'), 'nothing happens before dave chooses to join');
  await D.click('[data-join=go]');
  await D.waitForFunction(() => document.querySelectorAll('#content .tile img.ok').length === 1, null, { timeout: 30000 });
  ok(RE.repo.collaborators.get('dave') === 'push' && !(await D.isVisible('#unlockForm')), 'owner\'s app let dave in, dave\'s app accepted; the key from the link opened the photos');
  ok(api.gists.size === 0, 'one-time invite deleted after use');
  await A.click('#scrim', { position: { x: 10, y: 10 } });
  // a used one-time link is dead
  await B.goto(onceLink.replace(/^https?:\/\/[^/]+\//, APP_ORIGIN + '/'));
  await B.waitForSelector('.join-card[data-state=gone]', { timeout: 20000 });
  ok(true, 'the used one-time link says it was already used (opened in a tab where Moa was already running)');
  await B.click('[data-join=cancel]');

  // 7-day link, joined by typing the code
  await A.click('[data-tab=settings]');
  await A.click(`[data-space="alice/moa-spring-trip"]`);
  await A.waitForFunction(() => document.querySelectorAll('#content .tile').length === 4, null, { timeout: 20000 });
  await A.click('[data-tab=settings]');
  await A.click('[data-act=invite]');
  await A.click('#invWeek');
  await A.waitForSelector('#invShow .qr');
  const code = (await A.textContent('#invCode')).trim();
  ok(!(await A.isVisible('#invKey')) && !(await A.inputValue('#invLink')).includes('&k='), 'a plain album\'s link carries no key');
  await D.click('#spaceBtn');
  await D.click('[data-act=home]');
  await D.click('#codeBtn');
  await D.fill('#joinCode', code.toUpperCase());
  await D.click('#joinOk');
  await D.waitForSelector('[data-join=go]', { timeout: 20000 });
  await D.click('[data-join=go]');
  await D.waitForFunction(() => document.querySelectorAll('#content .tile').length === 4, null, { timeout: 30000 });
  ok(RA.repo.collaborators.get('dave') === 'push' && api.gists.size === 1, 'code entry works; a 7-day link stays open for others');
  ok((await A.textContent('#invActive')).includes('Revoke'), 'owner sees the open invite with a Revoke button');
  await A.click('#invActive [data-revoke]');
  await until(() => api.gists.size === 0);
  ok(true, 'revoking deletes the invite');
  await A.click('#scrim', { position: { x: 10, y: 10 } });
  await ctxD.close();

  for (const u of ['alice', 'bob']) ok(api.maxPushesPerMinute(u) <= 6, `@${u} stayed within 6 pushes/minute per repository (peak ${api.maxPushesPerMinute(u)})`);

  // sign-out revokes the grant and forgets the token
  B.once('dialog', d => d.accept());
  await B.click('[data-act=home]').catch(() => {});
  await B.click('[data-repo]');
  await B.waitForSelector('#content .tile', { timeout: 20000 });
  await B.click('[data-tab=settings]');
  await B.click('[data-act=logout]');
  await B.waitForSelector('#loginBtn');
  ok(authStats.revoked === 1 && !(await B.evaluate(() => localStorage.getItem('moa.auth'))), 'logout revokes the token on GitHub and clears it locally');
  console.log(`\nmock API: ${api.stats.requests} requests, ${api.stats.commits} commits, ${api.stats.conflicts} conflicts`);

  // ---------- a v1 album (single index.json) migrates, and a nearly full repo warns ----------
  const legacy = createMockGitHub({ users: { 'tok-carol': 'carol' }, repos: [{ owner: 'carol', repo: 'old' }] });
  const LR = legacy.api.at('carol/old');
  await new Promise(r => legacy.server.listen(API_PORT + 1, r));
  const old = { app: 'moa', version: 1, title: '예전 앨범', createdAt: '2025-01-01T00:00:00Z', members: { carol: { joinedAt: '2025-01-01T00:00:00Z' } }, albums: {},
    photos: { x1: { id: 'x1', kind: 'photo', name: 'a.jpg', takenAt: '2025-03-01T10:00:00', ts: 1740790800000, files: { thumb: 'thumb/2025/03/x1.jpg', preview: 'preview/2025/03/x1.jpg' }, sizes: { preview: 500000, thumb: 40000 }, by: 'carol', uploadedAt: '2025-03-02T00:00:00Z' } } };
  LR.putFile('index.json', JSON.stringify(old));
  LR.putFile('thumb/2025/03/x1.jpg', TILE);
  LR.putFile('preview/2025/03/x1.jpg', TILE);
  LR.setSizeKB(Math.round(9.7 * 1024 * 1024));
  const ctxC = await browser.newContext(phone);
  await stub(ctxC);
  const Cp = await ctxC.newPage();
  watch(Cp, 'C');
  await Cp.goto(`${APP}#join=carol/old&api=${encodeURIComponent(`http://localhost:${API_PORT + 1}`)}`);
  await Cp.click('#tokenBox summary');
  await Cp.fill('input[name=token]', 'tok-carol');
  await Cp.click('#connectForm button[type=submit]');
  await Cp.waitForSelector('#content .tile');
  ok(true, 'v1 index.json album opens');
  const banner = await Cp.textContent('.cap-banner');
  ok(/97%/.test(banner) && (await Cp.getAttribute('.cap-banner', 'class')).includes('danger'), `nearly full repository shows a warning banner ("${banner.trim()}")`);
  if (SHOTS) await Cp.screenshot({ path: `${SHOTS}/11-capacity-banner.png` });
  await Cp.click('#content .tile');
  await Cp.click('[data-v=like]');
  await Cp.evaluate(() => window.__moa.flush());
  await Cp.waitForFunction(() => !window.__moa.S.pending.length, null, { timeout: 30000 });
  const lp = LR.paths();
  ok(!lp.includes('index.json') && lp.includes('album.json') && lp.includes('index/2025-03.json') && readIndex(LR).photos.x1.likes?.includes('carol'), 'first edit migrates index.json → album.json + monthly shards');
  await Cp.click('[data-v=close]');
  // the repository is now 100 KB short of 10 GB, so this photo tips it over
  await Cp.evaluate(kb => { window.__moa.S.repoInfo.size = kb; }, 10 * 1024 * 1024 - 100);
  await Cp.setInputFiles('#fileInput', [files[0]]);
  await Cp.waitForSelector('#upGo');
  ok(await Cp.isDisabled('#upGo') && await Cp.isVisible('#upAck'), 'upload past the 10GB guidance needs an explicit acknowledgement');
  await Cp.check('#upAck');
  ok(!(await Cp.isDisabled('#upGo')), 'acknowledging enables the upload button');
  if (SHOTS) { await Cp.waitForTimeout(500); await Cp.screenshot({ path: `${SHOTS}/12-upload-over-limit.png` }); }
  legacy.server.close();
} finally {
  await browser.close();
  apiServer.close();
  appServer.close();
}
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
