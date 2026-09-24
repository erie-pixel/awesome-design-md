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
const { server: apiServer, api } = createMockGitHub();
await new Promise(r => apiServer.listen(API_PORT, r));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
const appServer = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise(r => appServer.listen(APP_PORT, r));

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failures++; };
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
  A.on('pageerror', e => { console.log('pageerror(A):', e.message); failures++; });
  await A.goto(`${APP}#join=alice/photos&api=${encodeURIComponent(API)}`);
  await A.fill('input[name=token]', 'tok-alice');
  if (SHOTS) await A.screenshot({ path: `${SHOTS}/01-welcome.png` });
  await A.click('#connectForm button[type=submit]');
  await A.waitForSelector('#initBtn');
  ok(true, 'empty repository offers to create an album');
  await A.fill('#initTitle', '우리들의 봄 여행');
  await A.click('#initBtn');
  await A.waitForFunction(() => document.querySelector('#content .empty h2')?.textContent.includes('첫 사진'));
  ok(api.paths().includes('index.json') && api.paths().includes('README.md'), 'album initialized with README.md + index.json');
  ok(JSON.parse(api.fileText('index.json')).members.alice, 'alice recorded as member');

  await A.setInputFiles('#fileInput', files);
  await A.waitForSelector('#upGo');
  const summary = await A.textContent('.up-summary');
  ok(/사진 5/.test(summary) && /라이브 1/.test(summary) && /위치 있음 4/.test(summary), `review sheet summary: "${summary}"`);
  ok(await A.locator('.up-item').count() === 5, 'AAE sidecar ignored, webm folded into the Live Photo');
  await A.fill('#upTags', '봄여행');
  if (SHOTS) { await A.waitForTimeout(500); await A.screenshot({ path: `${SHOTS}/02-upload-review.png` }); }
  await A.click('#upGo');
  await A.waitForFunction(() => document.querySelectorAll('#content .tile').length === 5, null, { timeout: 60000 });
  ok(true, '5 tiles in the library after upload');
  const ix1 = JSON.parse(api.fileText('index.json'));
  const live = Object.values(ix1.photos).find(p => p.name === 'IMG_0001.JPG');
  ok(live && live.files.live && api.paths().includes(live.files.live), 'Live Photo video stored next to the still');
  ok(live.contentId === 'D5B3C7E2-0001-4C44-9A0B-LIVEPHOTO001', 'Apple content identifier kept');
  ok(live.takenAt === '2024-05-04T06:12:09' && live.tz === '+09:00' && Math.abs(live.gps.lat - 33.4589) < 1e-4, 'EXIF date/offset/GPS stored');
  ok(Object.values(ix1.photos).every(p => p.tags?.includes('봄여행')), 'upload tags applied');
  ok(Object.values(ix1.photos).every(p => ['original', 'preview', 'thumb'].every(k => api.paths().includes(p.files[k]))), 'original + preview + thumb files committed');

  // place names resolve in the background and are committed
  await A.waitForFunction(() => Object.values(window.__moa.S.index.photos).filter(p => p.place).length === 4, null, { timeout: 30000 });
  await A.evaluate(() => window.__moa.flush());
  await A.waitForFunction(() => !window.__moa.S.pending.length, null, { timeout: 20000 });
  const ix2 = JSON.parse(api.fileText('index.json'));
  ok(Object.values(ix2.photos).filter(p => p.place).length === 4, 'reverse-geocoded places committed to index.json');

  // date view
  await A.waitForTimeout(400);
  const months = await A.$$eval('.month', els => els.map(e => e.textContent));
  ok(JSON.stringify(months) === JSON.stringify(['2024년 5월', '2024년 2월', '2023년 12월']), `date view months newest first: ${months}`);
  ok(await A.locator('.tile .badge').count() === 1, 'LIVE badge on exactly one tile');
  if (SHOTS) await A.screenshot({ path: `${SHOTS}/03-library-date.png` });

  // place view
  await A.click('[data-view=place]');
  await A.waitForSelector('.place-card');
  const placeTitles = await A.$$eval('.place-card h3', els => els.map(e => e.textContent));
  ok(JSON.stringify(placeTitles) === JSON.stringify(['서울특별시', '서귀포시', '渋谷区', '위치 정보 없음']), `place view groups: ${placeTitles}`);
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
  const ix3 = JSON.parse(api.fileText('index.json'));
  const album = Object.values(ix3.albums)[0];
  ok(album?.name === '제주 3박 4일' && Object.values(ix3.photos).filter(p => p.albums?.includes(album.id)).length === 3, 'album created with 3 selected photos');
  ok(Object.values(ix3.photos).find(p => p.id === live.id).tags.includes('제주'), 'tag edit committed');

  // ---------- Bob joins with his own token ----------
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 820 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
  await stub(ctxB);
  const B = await ctxB.newPage();
  B.on('pageerror', e => { console.log('pageerror(B):', e.message); failures++; });
  await B.goto(`${APP}#join=alice/photos&api=${encodeURIComponent(API)}&by=alice`);
  ok((await B.textContent('.invite-banner')).includes('@alice'), 'invite link shows who invited');
  await B.fill('input[name=token]', 'tok-bob');
  await B.click('#connectForm button[type=submit]');
  await B.waitForFunction(() => document.querySelectorAll('#content .tile').length === 5);
  ok(true, 'bob sees all 5 photos');
  await B.evaluate(() => window.__moa.flush());
  await B.waitForFunction(() => !window.__moa.S.pending.length, null, { timeout: 20000 });
  ok(JSON.parse(api.fileText('index.json')).members.bob, 'bob joined the member list');

  // tag view, bob-side
  await B.click('[data-view=tag]');
  const tagTitles = await B.$$eval('.place-card h3', els => els.map(e => e.textContent));
  ok(tagTitles[0] === '#봄여행' && tagTitles.includes('#제주'), `tag view groups: ${tagTitles}`);
  await B.click('[data-view=date]');

  // concurrent edits from both friends → both survive (ref update conflict + replay)
  const [p0, p1] = await B.$$eval('#content .tile', t => [t[0].dataset.id, t[1].dataset.id]);
  const conflictsBefore = api.stats.conflicts;
  api.commitIndex(ix => { ix.photos[p1].caption = '다른 기기에서 먼저 저장'; }, 'external write');
  await B.click(`#content .tile[data-id="${p0}"]`);
  await B.click('[data-v=like]');
  await Promise.all([
    B.evaluate(() => window.__moa.flush()),
    A.evaluate(async id => { const m = window.__moa; m.S.pending.push({ op: 'tag', ids: [id], tag: '동시편집', on: true }); await m.flush(); }, p1),
  ]);
  await B.waitForFunction(() => !window.__moa.S.pending.length, null, { timeout: 20000 });
  await A.waitForFunction(() => !window.__moa.S.pending.length, null, { timeout: 20000 });
  const ix4 = JSON.parse(api.fileText('index.json'));
  ok(ix4.photos[p0].likes?.includes('bob'), 'bob\'s like saved');
  ok(ix4.photos[p1].tags?.includes('동시편집') && ix4.photos[p1].caption === '다른 기기에서 먼저 저장', 'alice\'s concurrent tag merged with the external caption');
  ok(api.stats.conflicts > conflictsBefore, `fast-forward conflicts happened and were retried (${api.stats.conflicts - conflictsBefore})`);
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
  ok(JSON.parse(api.fileText('index.json')).photos[noGps.id].place?.name === '산방산', 'place set manually from search');
  await A.click('[data-v=info]');
  await A.click('[data-v=close]');

  // delete removes the files from the tree
  A.once('dialog', d => d.accept());
  const victim = ix4.photos[p1];
  await A.click(`#content .tile[data-id="${p1}"]`);
  await A.click('[data-v=info]');
  await A.click('[data-i=delete]');
  await A.evaluate(() => window.__moa.flush());
  await A.waitForFunction(() => !window.__moa.S.pending.length, null, { timeout: 20000 });
  ok(!JSON.parse(api.fileText('index.json')).photos[p1] && !api.paths().includes(victim.files.thumb) && !api.paths().includes(victim.files.original), 'delete removes entry and its files');

  // duplicate upload is skipped
  await A.keyboard.press('Escape'); // closes the info panel
  await A.keyboard.press('Escape'); // closes the viewer
  ok(await A.isHidden('#viewer'), 'Escape closes info panel, then viewer');
  await A.setInputFiles('#fileInput', [files[2]]);
  await A.waitForSelector('#upGo');
  ok((await A.textContent('.up-summary')).includes('중복 1개'), 're-uploading the same file is flagged as duplicate');
  await A.click('[data-close]');

  // settings tab
  await A.click('[data-tab=settings]');
  await A.waitForSelector('#tab-settings .panel');
  const settingsText = await A.textContent('#tab-settings');
  ok(settingsText.includes('@alice') && settingsText.includes('@bob') && settingsText.includes('저장 공간'), 'settings lists members and storage');
  if (SHOTS) await A.screenshot({ path: `${SHOTS}/09-settings.png`, fullPage: true });
  await A.click('[data-act=invite]');
  const link = await A.inputValue('#inviteLink');
  ok(link.includes('#join=alice%2Fphotos') && link.includes('by=alice'), 'invite link generated');
  await A.click('#scrim', { position: { x: 10, y: 10 } });

  // albums tab
  await A.click('[data-tab=albums]');
  await A.waitForSelector('[data-album]');
  if (SHOTS) { await A.waitForTimeout(500); await A.screenshot({ path: `${SHOTS}/10-albums.png` }); }
  await A.click('[data-album]');
  ok((await A.textContent('#hero h1')) === '제주 3박 4일', 'album page opens');

  console.log(`\nmock API: ${api.stats.requests} requests, ${api.stats.commits} commits, ${api.stats.conflicts} conflicts`);
} finally {
  await browser.close();
  apiServer.close();
  appServer.close();
}
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
