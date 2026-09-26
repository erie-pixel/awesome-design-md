import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as C from '../js/core.js';
import { buildTiff, withExif, buildMov, appleMakerNote } from './fixtures.mjs';

// load the same vendored UMD build the browser uses
const exifrModule = { exports: {} };
vm.runInNewContext(fs.readFileSync(new URL('../vendor/exifr.umd.js', import.meta.url), 'utf8'), { module: exifrModule, exports: exifrModule.exports, require: () => { throw new Error('no require'); }, process, Buffer, TextDecoder, DataView, Uint8Array, console, setTimeout, Promise, global: globalThis }, { filename: 'exifr.umd.js' });
const exifr = exifrModule.exports;

const EXIFR_OPTS = { tiff: true, exif: true, gps: true, makerNote: true, reviveValues: false, translateValues: false, xmp: false, icc: false, iptc: false, jfif: false };
// smallest valid JPEG: SOI + EOI is enough for exifr's segment scan
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

test('EXIF: date, offset, GPS, camera and Live Photo id survive exifr → metaFromExif', async () => {
  const jpg = withExif(JPEG, { date: '2024:05:04 14:03:22', tz: '+09:00', lat: 33.458944, lng: 126.942528, alt: 12.3, lens: 'iPhone 15 Pro back camera 6.765mm f/1.78', contentId: 'A1B2C3D4-LIVE' });
  const x = await exifr.parse(Buffer.from(jpg), EXIFR_OPTS);
  const m = C.metaFromExif(x);
  assert.equal(m.takenAt, '2024-05-04T14:03:22');
  assert.equal(m.tz, '+09:00');
  assert.equal(m.dateSource, 'exif');
  assert.ok(Math.abs(m.gps.lat - 33.458944) < 1e-5, m.gps.lat);
  assert.ok(Math.abs(m.gps.lng - 126.942528) < 1e-5, m.gps.lng);
  assert.equal(m.gps.alt, 12.3);
  assert.deepEqual(m.camera, { make: 'Apple', model: 'iPhone 15 Pro', lens: 'iPhone 15 Pro back camera 6.765mm f/1.78' });
  assert.equal(m.contentId, 'A1B2C3D4-LIVE');
  assert.equal(C.tsOf(m.takenAt, m.tz), Date.UTC(2024, 4, 4, 5, 3, 22));
});

test('EXIF: southern/western hemisphere and missing GPS', async () => {
  const x = await exifr.parse(Buffer.from(withExif(JPEG, { date: '2023:01:02 03:04:05', lat: -33.8568, lng: -70.6693 })), EXIFR_OPTS);
  const m = C.metaFromExif(x);
  assert.ok(m.gps.lat < 0 && m.gps.lng < 0);
  assert.equal(m.tz, null);
  const y = C.metaFromExif(await exifr.parse(Buffer.from(withExif(JPEG, { date: '2023:01:02 03:04:05' })), EXIFR_OPTS));
  assert.equal(y.gps, undefined);
});

test('Apple MakerNote parser rejects non-Apple data', () => {
  assert.equal(C.appleContentId(appleMakerNote('XYZ')), 'XYZ');
  assert.equal(C.appleContentId(new TextEncoder().encode('Nikon\0 whatever bytes here')), null);
  assert.equal(C.appleContentId(new Uint8Array(3)), null);
});

test('QuickTime: Apple creationdate, ISO6709 location, content id, duration', () => {
  const mov = buildMov({ creationdate: '2024-05-04T14:03:22+0900', iso6709: '+33.4589+126.9425+012.300/', contentId: 'A1B2C3D4-LIVE', duration: 2.5 });
  const q = C.parseQuickTime(mov.buffer);
  assert.equal(q.takenAt, '2024-05-04T14:03:22');
  assert.equal(q.tz, '+09:00');
  assert.deepEqual(q.location, { lat: 33.4589, lng: 126.9425, alt: 12.3 });
  assert.equal(q.contentId, 'A1B2C3D4-LIVE');
  assert.equal(q.duration, 2.5);
  assert.equal(q.model, 'iPhone 15 Pro');
  const m = C.metaFromQuickTime(q);
  assert.equal(m.dateSource, 'video');
  assert.deepEqual(m.camera, { make: 'Apple', model: 'iPhone 15 Pro' });
});

test('QuickTime: ISO-style meta box, mvhd UTC fallback and udta ©xyz', () => {
  const created = Math.floor(Date.UTC(2022, 6, 1, 12, 0, 0) / 1000) + 2082844800;
  const q = C.parseQuickTime(buildMov({ isoMeta: true, created1904: created, udtaXyz: '+37.5796+126.9770/' }).buffer);
  assert.equal(q.createdUtc, Date.UTC(2022, 6, 1, 12, 0, 0));
  assert.deepEqual(q.location, { lat: 37.5796, lng: 126.977 });
  const m = C.metaFromQuickTime(q, '+09:00');
  assert.equal(C.tsOf(m.takenAt, m.tz) !== null, true);
  // truncated file must not throw
  assert.doesNotThrow(() => C.parseQuickTime(buildMov({ creationdate: '2024-01-01T00:00:00Z' }).slice(0, 60).buffer));
});

test('Live Photo pairing: content id beats name, name beats time, long videos never pair', () => {
  const items = [
    { key: 'p1', kind: 'photo', name: 'IMG_0001.HEIC', contentId: 'X', ts: 1000 },
    { key: 'v1', kind: 'video', name: 'IMG_9999.MOV', contentId: 'X', ts: 50000, duration: 2.9 },
    { key: 'p2', kind: 'photo', name: 'IMG_0002.HEIC', ts: 90000 },
    { key: 'v2', kind: 'video', name: 'img_0002.mov', ts: 1, duration: 3 },
    { key: 'p3', kind: 'photo', name: 'a.jpg', ts: 200000 },
    { key: 'v3', kind: 'video', name: 'b.mov', ts: 200900, duration: 2 },
    { key: 'p4', kind: 'photo', name: 'IMG_0004.HEIC', ts: 300000 },
    { key: 'v4', kind: 'video', name: 'IMG_0004.MOV', ts: 300000, duration: 45 },
  ];
  const pairs = C.pairLivePhotos(items);
  assert.equal(pairs.get('p1'), 'v1');
  assert.equal(pairs.get('p2'), 'v2');
  assert.equal(pairs.get('p3'), 'v3');
  assert.equal(pairs.has('p4'), false);
});

test('ops: optimistic edits replay cleanly on a friend\'s newer index', () => {
  const ix = C.emptyIndex('t');
  const photo = (id, extra = {}) => ({ id, hash: 'h' + id, takenAt: '2024-05-04T10:00:00', ts: 1, files: { thumb: `thumb/${id}.jpg`, preview: `preview/${id}.jpg`, original: `media/${id}.heic`, live: `media/${id}.live.mov` }, ...extra });
  C.applyOp(ix, { op: 'addPhotos', photos: [photo('a'), photo('b')] });
  C.applyOp(ix, { op: 'addPhotos', photos: [photo('c', { hash: 'ha' })] }); // duplicate content
  assert.deepEqual(Object.keys(ix.photos).sort(), ['a', 'b']);

  const mine = [
    { op: 'tag', ids: ['a', 'b'], tag: ' #Jeju ', on: true },
    { op: 'like', id: 'a', user: 'alice', on: true },
    { op: 'createAlbum', album: { id: 'al', name: 'Trip' } },
    { op: 'albumMembership', ids: ['a'], album: 'al', on: true },
    { op: 'setCover', album: 'al', photo: 'a' },
    { op: 'updatePhoto', id: 'b', set: { caption: 'hi', place: { label: 'x' }, by: 'hacker' } },
  ];
  const friend = structuredClone(ix);
  C.applyOp(friend, { op: 'like', id: 'a', user: 'bob', on: true });
  C.applyOp(friend, { op: 'tag', ids: ['a'], tag: 'jeju', on: true });
  C.applyOps(friend, mine);
  C.applyOps(friend, mine); // replaying twice is harmless
  assert.deepEqual(friend.photos.a.likes, ['bob', 'alice']);
  assert.deepEqual(friend.photos.a.tags, ['jeju']);
  assert.deepEqual(friend.photos.b.tags, ['jeju']);
  assert.deepEqual(friend.photos.a.albums, ['al']);
  assert.equal(friend.photos.b.caption, 'hi');
  assert.equal(friend.photos.b.by, undefined, 'non-editable fields are ignored');

  assert.deepEqual(C.filesOf(friend.photos.a).sort(), ['media/a.heic', 'media/a.live.mov', 'preview/a.jpg', 'thumb/a.jpg']);
  C.applyOp(friend, { op: 'deletePhotos', ids: ['a'] });
  assert.equal(friend.photos.a, undefined);
  assert.equal(friend.albums.al.cover, undefined);
  C.applyOp(friend, { op: 'deleteAlbum', id: 'al' });
  assert.deepEqual(friend.photos.b.albums || [], []);
  C.applyOp(friend, { op: 'updatePhoto', id: 'b', set: { place: null } });
  assert.equal('place' in friend.photos.b, false);
});

test('serializeIndex round-trips and keeps one photo per line', () => {
  const ix = C.emptyIndex('앨범');
  assert.deepEqual(C.parseIndex(C.serializeIndex(ix)), ix);
  ix.photos.b = { id: 'b', tags: ['x'] };
  ix.photos.a = { id: 'a' };
  const text = C.serializeIndex(ix);
  assert.deepEqual(C.parseIndex(text), ix);
  assert.match(text, /\n {4}"a": \{"id":"a"\},\n {4}"b": /);
  assert.throws(() => C.parseIndex('{"foo":1}'));
});

test('grouping: by day (with months), by place level/order, by tag', () => {
  const P = [
    { id: '1', takenAt: '2024-05-04T09:00:00', ts: Date.UTC(2024, 4, 4, 0), place: { country: '대한민국', city: '서귀포시', district: '성산읍', region: '제주특별자치도', label: '서귀포시 성산읍' }, gps: { lat: 33.45, lng: 126.94 }, tags: ['제주', '바다'] },
    { id: '2', takenAt: '2024-05-04T18:00:00', ts: Date.UTC(2024, 4, 4, 9), place: { country: '대한민국', city: '서귀포시', district: '안덕면', label: '서귀포시 안덕면' }, gps: { lat: 33.25, lng: 126.3 }, tags: ['제주'] },
    { id: '3', takenAt: '2024-05-05T12:00:00', ts: Date.UTC(2024, 4, 5, 3), place: { country: '대한민국', city: '서울특별시', district: '종로구', label: '서울특별시 종로구' }, gps: { lat: 37.57, lng: 126.97 } },
    { id: '4', takenAt: '2023-12-24T20:00:00', ts: Date.UTC(2023, 11, 24, 11), place: { country: '日本', city: '東京都', district: '渋谷区', label: '東京都 渋谷区' }, gps: { lat: 35.66, lng: 139.7 } },
    { id: '5', takenAt: '2023-12-25T20:00:00', ts: Date.UTC(2023, 11, 25, 11) },
  ];
  const d = C.groupByDate(P);
  assert.deepEqual(d.map(g => g.key), ['2024-05-05', '2024-05-04', '2023-12-25', '2023-12-24']);
  assert.deepEqual(d[1].photos.map(p => p.id), ['2', '1']);
  assert.deepEqual(C.groupByDate(P, 'asc').map(g => g.key)[0], '2023-12-24');

  const city = C.groupByPlace(P);
  assert.deepEqual(city.map(g => g.title), ['서울특별시', '서귀포시', '東京都', '']);
  assert.equal(city[3].none, true);
  assert.deepEqual(city[1].range, ['2024-05-04', '2024-05-04']);
  assert.ok(city[1].center.lat > 33.2 && city[1].center.lat < 33.5);
  assert.deepEqual(C.groupByPlace(P, { level: 'district', order: 'count' }).map(g => g.photos.length), [1, 1, 1, 1, 1]);
  assert.deepEqual(C.groupByPlace(P, { level: 'country', order: 'count' }).map(g => g.title), ['대한민국', '日本', '']);

  const t = C.groupByTag(P);
  assert.deepEqual(t.map(g => g.title), ['#제주', '#바다', '']);
  assert.deepEqual(C.tagCounts(P), [['제주', 2], ['바다', 1]]);
});

test('filter & search', () => {
  const P = [
    { id: '1', tags: ['제주'], files: { live: 'x' }, place: { label: '서귀포시 성산읍', name: '성산일출봉' }, by: 'alice', kind: 'photo' },
    { id: '2', kind: 'video', caption: '생일 파티', albums: ['al'], likes: ['bob'], files: {} },
  ];
  assert.deepEqual(C.filterPhotos(P, { kind: 'live' }).map(p => p.id), ['1']);
  assert.deepEqual(C.filterPhotos(P, { kind: 'video' }).map(p => p.id), ['2']);
  assert.deepEqual(C.filterPhotos(P, { kind: 'fav' }).map(p => p.id), ['2']);
  assert.deepEqual(C.filterPhotos(P, { album: 'al' }).map(p => p.id), ['2']);
  assert.deepEqual(C.filterPhotos(P, { q: '#제주 일출' }).map(p => p.id), ['1']);
  assert.deepEqual(C.filterPhotos(P, { q: '파티' }).map(p => p.id), ['2']);
});

test('Nominatim address → place (Korea and Japan)', () => {
  const kr = C.placeFromNominatim({ name: '경복궁', address: { tourism: '경복궁', quarter: '세종로', borough: '종로구', city: '서울특별시', country: '대한민국', country_code: 'kr' } });
  assert.deepEqual([kr.city, kr.district, kr.name, kr.label, kr.cc], ['서울특별시', '종로구', '경복궁', '서울특별시 종로구', 'kr']);
  const jeju = C.placeFromNominatim({ address: { town: '성산읍', city: '서귀포시', province: '제주특별자치도', country: '대한민국' } });
  assert.equal(jeju.label, '서귀포시');
  const jp = C.placeFromNominatim({ address: { suburb: '渋谷', city: '渋谷区', state: '東京都', country: '日本' } });
  assert.equal(jp.label, '渋谷区 渋谷');
  assert.equal(C.placeFromNominatim({}), null);
});

test('dates, tags and misc helpers', () => {
  assert.equal(C.exifDateToISO('0000:00:00 00:00:00'), null);
  assert.equal(C.normalizeTz('+0530'), '+05:30');
  assert.equal(C.normalizeTz('Z'), '+00:00');
  assert.equal(C.normalizeTag('  ##Summer  Trip '), 'summer trip');
  assert.equal(C.kindOf('IMG_1.HEIC'), 'photo');
  assert.equal(C.kindOf('IMG_1.MOV'), 'video');
  assert.equal(C.kindOf('x.aae'), null);
  assert.equal(C.parseISO6709('+00.0000+000.0000/'), null);
  assert.match(C.newId(), /^[0-9a-z]+-[0-9a-z]{6}$/);
  const cl = C.clusterPoints([{ gps: { lat: 0.001, lng: 0 } }, { gps: { lat: 0.0011, lng: 0 } }, { gps: { lat: 10, lng: 10 } }, {}], g => ({ x: g.lng * 1000, y: g.lat * 1000 }), 64);
  assert.equal(cl.length, 2);
});

// ---------------- v2 index shards ----------------

test('splitIndex/joinIndex: monthly shards round-trip, meta stays small', () => {
  const ix = C.emptyIndex('봄');
  ix.members.alice = { joinedAt: 'x' };
  ix.albums.a1 = { id: 'a1', name: 'Trip' };
  ix.photos = {
    p1: { id: 'p1', takenAt: '2024-05-04T06:12:09' },
    p2: { id: 'p2', takenAt: '2024-05-30T23:59:59' },
    p3: { id: 'p3', takenAt: '2023-12-24T21:30:12' },
    p4: { id: 'p4', uploadedAt: '2026-09-25T00:00:00Z' },
    p5: { id: 'p5' },
  };
  const files = C.splitIndex(ix);
  assert.deepEqual([...files.keys()], ['album.json', 'index/2023-12.json', 'index/2024-05.json', 'index/2026-09.json', 'index/undated.json']);
  assert.equal(JSON.parse(files.get('album.json')).photos, undefined);
  assert.equal(JSON.parse(files.get('album.json')).version, 2);
  const back = C.joinIndex(files.get('album.json'), [...files.entries()].filter(([k]) => k !== 'album.json').map(([, v]) => v));
  assert.deepEqual(back.photos, ix.photos);
  assert.deepEqual(back.albums, ix.albums);
  assert.throws(() => C.joinIndex('{"app":"other"}'));
  // moving a photo to another month moves it between shards
  ix.photos.p1.takenAt = '2023-12-01T00:00:00';
  assert.ok(C.splitIndex(ix).get('index/2023-12.json').includes('"p1"'));
});

test('mediaDir: day folders', () => {
  assert.equal(C.mediaDir('2024-05-04T06:12:09'), '2024/05/04');
  assert.match(C.mediaDir(null), /^\d{4}\/\d{2}\/\d{2}$/);
});

// ---------------- GitHub repository limits ----------------

import * as L from '../js/limits.js';

test('usage: larger of GitHub-reported size and index sum, against 10 GB', () => {
  const photos = [{ sizes: { original: 3 * L.MB, preview: 0.5 * L.MB, thumb: 0.05 * L.MB, live: 2 * L.MB } }];
  const u = L.usage({ repoKB: 0, photos });
  assert.equal(u.used, 5.55 * L.MB);
  assert.equal(u.breakdown.live, 2 * L.MB);
  assert.equal(u.limit, 10 * L.GB);
  assert.equal(u.level, 'ok');
  const full = L.usage({ repoKB: 9.7 * 1024 * 1024, photos });
  assert.equal(full.used, 9.7 * L.GB);
  assert.equal(full.level, 'danger');
  assert.equal(L.usage({ repoKB: 8.5 * 1024 * 1024 }).level, 'warn');
  assert.equal(L.usage({ repoKB: 11 * 1024 * 1024 }).level, 'over');
  assert.equal(L.usage({ repoKB: 11 * 1024 * 1024 }).remaining, 0);
});

test('planUpload: estimate, originals toggle, 50 MB / 100 MB flags', () => {
  const E = [
    { main: { kind: 'photo', size: 3 * L.MB }, live: { size: 2 * L.MB } },
    { main: { kind: 'video', size: 60 * L.MB } },
    { main: { kind: 'photo', size: 0.5 * L.MB } },
    { main: { kind: 'photo', size: 200 * L.MB }, skip: true },
  ];
  const on = L.planUpload(E, { keepOriginal: true, usage: { used: 0 } });
  const off = L.planUpload(E, { keepOriginal: false, usage: { used: 0 } });
  assert.ok(on.bytes > off.bytes);
  assert.equal(on.bytes - off.bytes, 3.5 * L.MB, 'only photo originals drop; video always kept');
  assert.equal(on.heavy.length, 1);
  assert.equal(on.overRecommended.length, 2);
  assert.equal(off.overRecommended.length, 1);
  const near = L.planUpload(E, { keepOriginal: true, usage: { used: 10 * L.GB - 10 * L.MB } });
  assert.equal(near.level, 'over');
  assert.equal(near.remainingAfter, 0);
});

test('dirCounts / busiestDir / largestFile', () => {
  const photos = [
    { name: 'a', files: { original: 'media/2024/05/04/a.heic', live: 'media/2024/05/04/a.live.mov', thumb: 'thumb/2024/05/04/a.jpg' }, sizes: { original: 9, live: 4 } },
    { name: 'b', files: { original: 'media/2024/05/04/b.heic', thumb: 'thumb/2024/05/05/b.jpg' }, sizes: { original: 12 } },
  ];
  const b = L.busiestDir(L.dirCounts(photos));
  assert.deepEqual([b.dir, b.count, b.level], ['media/2024/05/04', 3, 'ok']);
  assert.equal(L.busiestDir(new Map([['x', 2900]])).level, 'danger');
  assert.deepEqual(L.largestFile(photos), { name: 'b', size: 12 });
});

test('waitFor: at most 6 pushes in any rolling minute', () => {
  const now = 100000;
  assert.equal(L.waitFor([], now), 0);
  assert.equal(L.waitFor([now - 1000, now - 2000, now - 3000, now - 4000, now - 5000], now), 0);
  const six = [now - 50000, now - 40000, now - 30000, now - 20000, now - 10000, now - 1000];
  assert.equal(L.waitFor(six, now), 10000);
  assert.equal(L.waitFor([now - 70000, ...six.slice(1)], now), 0);
});

// ---------------- language ----------------

import * as I from '../js/i18n.js';
import STRINGS from '../js/strings.js';

test('i18n: English default, Korean switch, plurals, dates', () => {
  I.setLang('en');
  assert.equal(I.t('refresh.new', { n: 1 }), '1 new photo');
  assert.equal(I.t('refresh.new', { n: 4 }), '4 new photos');
  assert.equal(I.fmtDay('2024-05-04'), 'Saturday, May 4, 2024');
  assert.equal(I.fmtTime('2024-05-04T13:30:00'), '1:30 PM');
  I.setLang('ko');
  assert.equal(I.t('refresh.new', { n: 4 }), '새 사진 4장');
  assert.equal(I.fmtTime('2024-05-04T00:05:00'), '오전 12:05');
  assert.equal(I.fmtTime('2024-05-04T13:30:00'), '오후 1:30');
  assert.equal(I.t('no.such.key'), 'no.such.key');
  I.setLang('en');
});

test('i18n: every string has both languages and matching variables', () => {
  for (const [k, [en, ko]] of Object.entries(STRINGS)) {
    assert.ok(en && ko, k);
    const vars = s => [...s.matchAll(/\{(\w+)/g)].map(m => m[1]).sort().filter((v, i, a) => a.indexOf(v) === i).join();
    assert.equal(vars(en), vars(ko), `variables differ in ${k}`);
  }
});

test('i18n: every t() key used in the app exists', async () => {
  const fs = await import('node:fs');
  const src = ['app.js', 'media.js', 'github.js', 'crypto.js', 'ai.js'].map(f => fs.readFileSync(new URL('../js/' + f, import.meta.url), 'utf8')).join('\n')
    + fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  // literal keys only (dynamic ones like t('opt.' + key) are skipped)
  const used = new Set([...src.matchAll(/\bt\('([\w.]*\w)'(?!\s*\+)/g), ...src.matchAll(/data-i18n(?:-aria|-ph)?="([\w.]+)"/g)].map(m => m[1]));
  for (const k of used) assert.ok(STRINGS[k], `missing string ${k}`);
});

// ---------------- encryption & erase-history helpers ----------------
import * as K from '../js/crypto.js';

test('crypto: passphrase unlocks the album key; wrong passphrase and tampering are rejected', async () => {
  const { header, key } = await K.createAlbumKey('correct horse battery', { iterations: 1000 });
  assert.ok(K.isHeader(header) && !('app' in header), 'header has no "app" field, so older builds refuse it');
  const sealed = await K.seal(key, new TextEncoder().encode('{"photos":{}}'));
  assert.ok(K.isSealed(sealed));
  assert.equal(new TextDecoder().decode(sealed.subarray(0, 4)), 'MOA1');
  const again = await K.unlockAlbumKey(header, 'correct horse battery');
  assert.equal(new TextDecoder().decode(await K.open(again, sealed)), '{"photos":{}}');
  await assert.rejects(K.unlockAlbumKey(header, 'wrong horse battery'), K.BadPassphrase);
  const bad = sealed.slice(); bad[bad.length - 1] ^= 1;
  await assert.rejects(K.open(again, bad));
  // same plaintext never encrypts the same way twice (fresh IV)
  const twice = await K.seal(key, new TextEncoder().encode('{"photos":{}}'));
  assert.notDeepEqual([...twice], [...sealed]);
  // an invite link can carry the key
  const viaLink = await K.keyFromText(await K.keyToText(again));
  assert.equal(new TextDecoder().decode(await K.open(viaLink, sealed)), '{"photos":{}}');
});

test('crypto: a new passphrase rewraps the same key (old files stay readable)', async () => {
  const { header, key } = await K.createAlbumKey('first passphrase', { iterations: 1000 });
  const file = await K.seal(key, new Uint8Array([1, 2, 3]));
  const next = await K.rewrapAlbumKey(header, 'first passphrase', 'second passphrase');
  assert.notEqual(next.wrapped.data, header.wrapped.data);
  assert.equal(next.kdf.iterations, K.KDF_ITERATIONS, 'rewrap upgrades to the current work factor');
  await assert.rejects(K.unlockAlbumKey(next, 'first passphrase'), K.BadPassphrase);
  const k2 = await K.unlockAlbumKey(next, 'second passphrase');
  assert.deepEqual([...await K.open(k2, file)], [1, 2, 3]);
  await assert.rejects(K.rewrapAlbumKey(header, 'nope', 'x'), K.BadPassphrase);
});

test('sealed layout: shards bucketed by id, opaque paths, round-trips through joinIndex', () => {
  const ix = C.emptyIndex('비밀 앨범');
  for (let i = 0; i < 200; i++) ix.photos['p' + i] = { id: 'p' + i, takenAt: `2024-0${1 + (i % 9)}-01T00:00:00` };
  const files = C.splitIndex(ix, { sealed: true });
  const paths = [...files.keys()];
  assert.equal(paths[0], C.SEALED_META);
  assert.ok(!paths.includes(C.META_PATH), 'album.json (the key header) is never rewritten');
  assert.ok(paths.slice(1).every(p => /^index\/s\d\d\.bin$/.test(p)), paths.join());
  assert.ok(paths.length > 20 && paths.length <= 33, `${paths.length - 1} buckets`);
  assert.equal(C.sealedShardOf('p7'), C.sealedShardOf('p7'));
  const back = C.joinIndex(files.get(C.SEALED_META), paths.slice(1).map(p => files.get(p)));
  assert.equal(Object.keys(back.photos).length, 200);
  assert.equal(back.title, '비밀 앨범');
  const a = C.sealedPath(), b = C.sealedPath();
  assert.match(a, /^data\/[0-9a-f]{2}\/[0-9a-f]{30}$/);
  assert.notEqual(a, b);
});

test('removedFiles: files of photos a newer index no longer has', () => {
  const before = { photos: { a: { id: 'a', files: { thumb: 't/a', original: 'o/a', liveMime: 'x' } }, b: { id: 'b', files: { thumb: 't/b' } } } };
  const after = { photos: { b: before.photos.b } };
  assert.deepEqual(C.removedFiles(before, after).sort(), ['o/a', 't/a']);
  assert.deepEqual(C.removedFiles(null, after), []);
});

test('removedFiles / replacedFiles: a replaced photo gives up only the files it no longer uses', () => {
  const ix = { photos: { a: { id: 'a', files: { thumb: 't/a', preview: 'p/a', original: 'o/a' } } } };
  const op = { op: 'replacePhoto', id: 'a', set: { files: { thumb: 't/a2', preview: 'p/a2' } } };
  assert.deepEqual(C.replacedFiles(ix, op).sort(), ['o/a', 'p/a', 't/a']);
  assert.deepEqual(C.replacedFiles(ix, { ...op, id: 'gone' }), []);
  const after = C.applyOp(structuredClone(ix), op);
  assert.deepEqual(C.removedFiles(ix, after).sort(), ['o/a', 'p/a', 't/a']);
});

test('replacePhoto: new file, same photo — tags, albums, likes, comments, caption stay; AI tags and place are redone', () => {
  const ix = C.emptyIndex();
  ix.albums.x = { id: 'x', name: 'Trip', cover: 'a' };
  ix.photos.a = { id: 'a', kind: 'photo', name: 'old.jpg', hash: 'h1', w: 10, h: 10, files: { thumb: 't/a', original: 'o/a' }, sizes: { thumb: 1 }, camera: { model: 'Old' },
    takenAt: '2024-05-04T06:12:09', gps: { lat: 1, lng: 2 }, place: { city: 'Jeju' }, tags: ['⭐', 'beach'], albums: ['x'], likes: ['bob'], comments: [{ id: 'c' }], caption: 'hi', ai: ['ocean'], aiv: 1 };
  C.applyOp(ix, { op: 'replacePhoto', id: 'a', at: 'T', by: 'alice', set: { kind: 'photo', name: 'new.jpg', hash: 'h2', w: 20, h: 30, files: { thumb: 't/b' }, sizes: { thumb: 2 } } });
  const p = ix.photos.a;
  assert.equal(p.name, 'new.jpg'); assert.equal(p.hash, 'h2'); assert.equal(p.w, 20);
  assert.deepEqual(p.files, { thumb: 't/b' });
  assert.equal(p.camera, undefined, 'the old camera belongs to the old file');
  assert.deepEqual([p.tags, p.albums, p.likes, p.caption, p.comments.length], [['⭐', 'beach'], ['x'], ['bob'], 'hi', 1]);
  assert.equal(p.takenAt, '2024-05-04T06:12:09'); assert.deepEqual(p.place, { city: 'Jeju' }, 'date and place stay unless asked');
  assert.equal(p.ai, undefined);
  assert.equal(ix.albums.x.cover, 'a', 'still the album cover');
  C.applyOp(ix, { op: 'replacePhoto', id: 'a', set: { files: { thumb: 't/c' }, gps: { lat: 5, lng: 6 } } });
  assert.deepEqual(p.gps, { lat: 5, lng: 6 }); assert.equal(p.place, undefined, 'a new place is looked up again');
});

test('setCover: an album cover, or the main photo for the whole album; deleting it falls back', () => {
  const ix = C.emptyIndex();
  ix.albums.x = { id: 'x', name: 'Trip' };
  ix.photos.a = { id: 'a' }; ix.photos.b = { id: 'b' };
  C.applyOp(ix, { op: 'setCover', album: 'x', photo: 'a' });
  C.applyOp(ix, { op: 'setCover', photo: 'b' });
  assert.equal(ix.albums.x.cover, 'a'); assert.equal(ix.cover, 'b');
  C.applyOp(ix, { op: 'deletePhotos', ids: ['a', 'b'] });
  assert.equal(ix.albums.x.cover, undefined); assert.equal(ix.cover, undefined);
});

test('symbol tags: marks are told apart from words, offered in one tap, and suggested while typing', () => {
  for (const m of ['⭐', '✈️', '🍽️', '♥', '👨‍👩‍👧']) assert.ok(C.isSymbolTag(m), m);
  for (const w of ['beach', '바다', '2024', 'a⭐', '', '⭐ ⭐']) assert.ok(!C.isSymbolTag(w), w);
  const list = [{ tags: ['🥐', 'x'] }, { tags: ['🥐'] }];
  const q = C.quickSymbols(list);
  assert.equal(q[0], '🥐', 'marks this album already uses come first');
  assert.equal(q.length, 8);
  assert.ok(q.includes('⭐'));
  assert.deepEqual(C.suggestTags('여행', ['여행지', '제주']).slice(0, 2), ['✈️', '여행지']);
  assert.ok(C.suggestTags('맛', []).includes('🍽️'));
  assert.ok(C.suggestTags('trip', []).includes('✈️'));
  assert.deepEqual(C.suggestTags('', ['a']), []);
  assert.equal(C.groupByTag([{ id: 'a', tags: ['⭐'] }])[0].title, '⭐');
});

test('area and month filters: map bounds (across the date line too) and capture month', () => {
  const ps = [
    { id: 'jeju', gps: { lat: 33.45, lng: 126.94 }, takenAt: '2024-05-04T06:00:00', place: { city: 'Seogwipo' } },
    { id: 'seoul', gps: { lat: 37.58, lng: 126.97 }, takenAt: '2024-05-06T11:00:00', place: { city: 'Seoul' } },
    { id: 'fiji', gps: { lat: -17.7, lng: 178.1 }, takenAt: '2023-12-24T21:00:00' },
    { id: 'samoa', gps: { lat: -13.8, lng: -171.8 }, takenAt: '2023-12-25T09:00:00' },
    { id: 'nogps', takenAt: '2024-05-01T09:00:00' },
  ];
  const ids = f => C.filterPhotos(ps, f).map(p => p.id);
  assert.deepEqual(ids({ area: { s: 33, n: 34, w: 126, e: 127 } }), ['jeju']);
  assert.deepEqual(ids({ area: { s: -20, n: -10, w: 170, e: -165 } }), ['fiji', 'samoa'], 'w > e wraps the date line');
  assert.deepEqual(ids({ month: '2024-05' }), ['jeju', 'seoul', 'nogps']);
  assert.deepEqual(C.areaName(ps.slice(0, 2)), { name: 'Seogwipo', more: 1 });
  assert.equal(C.areaName(ps.slice(2)), null);
});

test('photoStats: per month (by year), weekday, hour, people, places', () => {
  const ps = [
    { by: 'alice', takenAt: '2024-05-04T06:12:09', gps: {}, place: { country: 'KR', city: 'Jeju' } },  // Saturday
    { by: 'alice', takenAt: '2024-05-05T18:00:00', kind: 'video', place: { country: 'KR', city: 'Jeju' } },
    { by: 'bob', takenAt: '2023-12-24T21:30:12', files: { live: 'x' }, tags: ['⭐'] },
    { by: 'bob', uploadedAt: '2024-06-01T00:00:00' },
  ];
  const st = C.photoStats(ps);
  assert.deepEqual([st.total, st.photos, st.videos, st.lives, st.located, st.undated], [4, 3, 1, 1, 1, 1]);
  assert.deepEqual(st.years.map(y => [y.year, y.total]), [['2023', 1], ['2024', 2]]);
  assert.equal(st.years[1].months[4], 2);
  assert.equal(st.years[1].months.length, 12);
  assert.deepEqual(st.busiest, ['2024-05', 2]);
  assert.equal(st.weekdays[6], 1); assert.equal(st.weekdays[0], 2, '2024-05-05 and 2023-12-24 were Sundays');
  assert.equal(st.hours[6], 1); assert.equal(st.hours[21], 1);
  assert.deepEqual(st.people, [['alice', 2], ['bob', 2]]);
  assert.deepEqual(st.places.map(p => [p.title, p.n]), [['Jeju', 2]]);
  assert.deepEqual(st.tags, [['⭐', 1]]);
});

test('crypto: recovery code opens the album when the passphrase is lost; a device can set a new one', async () => {
  const { header, key } = await K.createAlbumKey('forgotten passphrase', { iterations: 1000 });
  const code = K.newRecoveryCode();
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){5}$/);
  const h = await K.withRecovery(header, key, code);
  assert.ok(K.hasRecovery(h) && !K.hasRecovery(header));
  const file = await K.seal(key, new Uint8Array([7, 8, 9]));
  // typed sloppily: lower case, spaces, O for 0, l for 1
  const sloppy = code.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o').replace(/1/g, 'l');
  const k1 = await K.unlockWithRecovery(h, sloppy);
  assert.deepEqual([...await K.open(k1, file)], [7, 8, 9]);
  await assert.rejects(K.unlockWithRecovery(h, K.newRecoveryCode()), K.BadPassphrase);
  await assert.rejects(K.unlockWithRecovery(header, code), K.BadPassphrase);
  // after recovery: a new passphrase, recovery code still valid
  const h2 = await K.setPassphrase(h, k1, 'brand new passphrase');
  await assert.rejects(K.unlockAlbumKey(h2, 'forgotten passphrase'), K.BadPassphrase);
  assert.deepEqual([...await K.open(await K.unlockAlbumKey(h2, 'brand new passphrase'), file)], [7, 8, 9]);
  assert.deepEqual([...await K.open(await K.unlockWithRecovery(h2, code), file)], [7, 8, 9]);
});

test('filterPhotos: photos-only leaves videos out', () => {
  const list = [{ id: 'a', kind: 'photo' }, { id: 'b', kind: 'video' }, { id: 'c', kind: 'photo', files: { live: 'x' } }];
  assert.deepEqual(C.filterPhotos(list, { kind: 'photo' }).map(p => p.id), ['a', 'c']);
  assert.deepEqual(C.filterPhotos(list, { kind: 'video' }).map(p => p.id), ['b']);
});

import { ZipWriter, crc32 } from '../js/zip.js';
test('zip: CRC-32 check value, unique names, readable archive layout', async () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')).toString(16), 'cbf43926');
  const z = new ZipWriter();
  await z.add('사진.jpg', new Blob([new Uint8Array([1, 2, 3])]), new Date(2024, 4, 4));
  await z.add('사진.jpg', new Blob(['x']));
  const u8 = new Uint8Array(await z.build().arrayBuffer());
  const dv = new DataView(u8.buffer);
  assert.equal(dv.getUint32(0, true), 0x04034b50);
  const end = u8.length - 22;
  assert.equal(dv.getUint32(end, true), 0x06054b50);
  assert.equal(dv.getUint16(end + 10, true), 2);
  assert.ok(new TextDecoder().decode(u8).includes('사진 (2).jpg'));
});

import * as AIL from '../js/ai-labels.js';
test('ai: tags from similarities — confident labels only, at most three; background wins → none', () => {
  const dim = AIL.LABELS.length + AIL.BACKGROUND.length;
  const one = i => { const v = new Float32Array(dim); v[i] = 1; return v; };
  const labels = AIL.LABELS.map((_, i) => one(i));
  const bg = AIL.BACKGROUND.map((_, i) => one(AIL.LABELS.length + i));
  const food = AIL.LABELS.findIndex(l => l.key === 'food'), beach = AIL.LABELS.findIndex(l => l.key === 'beach');
  assert.deepEqual(AIL.pickTags(one(food), labels, bg), ['food']);
  const mix = new Float32Array(dim); mix[food] = 0.7; mix[beach] = 0.7;
  assert.deepEqual(AIL.pickTags(mix, labels, bg).sort(), ['beach', 'food']);
  assert.deepEqual(AIL.pickTags(one(AIL.LABELS.length), labels, bg), [], 'a plain photo gets no forced label');
  assert.equal(AIL.labelName('ocean', 'ko'), '바다');
  assert.equal(AIL.labelName('ocean', 'en'), 'Sea');
});

test('ai: Korean search words become English for CLIP; unknown Korean falls back to plain search', () => {
  assert.equal(AIL.toEnglishQuery('dog on the beach'), 'dog on the beach');
  assert.equal(AIL.toEnglishQuery('바다에서 노을'), 'the ocean a sunset');
  assert.equal(AIL.toEnglishQuery('강아지 beach'), 'a dog beach');
  assert.equal(AIL.toEnglishQuery('제주도'), null);
  assert.equal(AIL.toEnglishQuery('  '), null);
});

test('ai: auto-tag ops, filter, counts and plain search over tag names', () => {
  const ix = C.emptyIndex();
  ix.photos = { a: { id: 'a', kind: 'photo' }, b: { id: 'b', kind: 'photo' } };
  C.applyOps(ix, [{ op: 'aiTags', id: 'a', tags: ['ocean', 'beach'], v: 1 }, { op: 'aiTags', id: 'b', tags: [], v: 1 }]);
  assert.deepEqual(ix.photos.a.ai, ['ocean', 'beach']);
  assert.deepEqual(C.aiTagCounts(Object.values(ix.photos)), [['ocean', 1], ['beach', 1]]);
  assert.deepEqual(C.filterPhotos(Object.values(ix.photos), { ai: 'ocean' }).map(p => p.id), ['a']);
  assert.deepEqual(C.filterPhotos(Object.values(ix.photos), { q: '바다' }).map(p => p.id), ['a']);
  C.applyOp(ix, { op: 'aiClear' });
  assert.ok(!ix.photos.a.ai && !ix.photos.b.aiv);
});

test('crypto: Face ID passkey slot (WebAuthn PRF) opens the album; other keys and cancels don\'t', async () => {
  // stand-in authenticator: each credential's PRF is HMAC-SHA-256(its secret, salt)
  const creds = new Map();
  let present = null, cancel = false, prfOnCreate = false;
  const hmac = async (secret, salt) => new Uint8Array(await crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), salt));
  const reply = async (rawId, salt) => ({ rawId: rawId.buffer, getClientExtensionResults: () => ({ prf: { enabled: true, ...(salt && { results: { first: salt } }) } }) });
  const fake = {
    async create({ publicKey }) {
      if (cancel) throw Object.assign(new Error('no'), { name: 'NotAllowedError' });
      const rawId = crypto.getRandomValues(new Uint8Array(16));
      creds.set(Buffer.from(rawId).toString('hex'), crypto.getRandomValues(new Uint8Array(32)));
      present = rawId;
      return reply(rawId, prfOnCreate ? await hmac(creds.get(Buffer.from(rawId).toString('hex')), publicKey.extensions.prf.eval.first) : null);
    },
    async get({ publicKey }) {
      if (cancel) throw Object.assign(new Error('no'), { name: 'NotAllowedError' });
      const hex = Buffer.from(present).toString('hex');
      if (!publicKey.allowCredentials.some(c => Buffer.from(c.id).toString('hex') === hex)) throw Object.assign(new Error('none'), { name: 'NotAllowedError' });
      return reply(present, await hmac(creds.get(hex), publicKey.extensions.prf.eval.first));
    },
  };
  Object.defineProperty(globalThis.navigator, 'credentials', { value: fake, configurable: true });
  try {
    const { header, key } = await K.createAlbumKey('pass phrase!', { iterations: 1000 });
    const a = await K.addPasskey(header, key, { label: 'iPhone', by: 'alice' });
    assert.equal(K.passkeySlots(a.header).length, 1);
    assert.equal(K.passkeySlots(a.header)[0].label, 'iPhone');
    const opened = await K.unlockWithPasskey(a.header);
    assert.equal(opened.id, a.id);
    assert.equal(await K.keyToText(opened.key), await K.keyToText(key));
    prfOnCreate = true; // browsers that hand out the secret right at creation
    const b = await K.addPasskey(a.header, key, { label: 'Mac', by: 'alice' });
    assert.equal(K.passkeySlots(b.header).length, 2);
    assert.equal(b.header.passkeys.salt, a.header.passkeys.salt, 'one salt per album');
    assert.equal(await K.keyToText((await K.unlockWithPasskey(b.header)).key), await K.keyToText(key));
    // the passphrase keeps working, and changing it keeps the passkeys
    const re = await K.rewrapAlbumKey(b.header, 'pass phrase!', 'new phrase!!');
    assert.equal(K.passkeySlots(re).length, 2);
    assert.equal(await K.keyToText((await K.unlockWithPasskey(re)).key), await K.keyToText(key));
    // a tampered slot doesn't open; cancelling isn't an error to show
    const bad = structuredClone(b.header);
    bad.passkeys.slots[1].wrapped.data = bad.passkeys.slots[0].wrapped.data;
    await assert.rejects(K.unlockWithPasskey(bad), K.BadPassphrase);
    cancel = true;
    await assert.rejects(K.unlockWithPasskey(b.header), e => e instanceof K.NoPasskey && e.message === 'cancelled');
    cancel = false;
    const gone = K.removePasskey(K.removePasskey(b.header, a.id), b.id);
    assert.equal(gone.passkeys, undefined);
    await assert.rejects(K.unlockWithPasskey(gone), K.NoPasskey);
  } finally { delete globalThis.navigator.credentials; }
});


test('recovery vault: the text file names the album and carries a code Moa can read back', async () => {
  const G = await import('../js/github.js');
  const code = K.newRecoveryCode();
  const text = G.vaultText({ album: 'alice/moa-6z301u', title: '비밀 여행', code, at: '2026-09-26T00:00:00Z' });
  assert.match(text, /Album: alice\/moa-6z301u \(비밀 여행\)/);
  assert.equal(G.vaultCode(text), code);
  assert.equal(G.vaultCode('Code: nope'), null);
  assert.equal(G.vaultCode(null), null);
  assert.equal(G.vaultPath('Alice', 'Moa-6Z301U'), 'recovery/alice/moa-6z301u.txt');
});

test('clusterPoints: nearby photos group by distance, even across what used to be a grid border', () => {
  const at = (id, x, ts) => ({ id, gps: { lat: 0, lng: x }, takenAt: ts });
  const proj = g => ({ x: g.lng, y: 0 });
  const cl = C.clusterPoints([at('a', 63, '2024-01-02T00:00:00'), at('b', 65, '2024-01-01T00:00:00'), at('c', 300, '2024-01-03T00:00:00')], proj, 64);
  assert.equal(cl.length, 2);
  const ab = cl.find(g => g.photos.length === 2);
  assert.deepEqual(ab.photos.map(p => p.id), ['a', 'b'], 'newest first inside a group');
  assert.equal(ab.lng, 64);
  // a long chain doesn't snowball into one pin: each group stays within the radius of where it started
  const chain = Array.from({ length: 10 }, (_, i) => at('p' + i, i * 40, `2024-01-${String(10 + i).padStart(2, '0')}T00:00:00`));
  assert.ok(C.clusterPoints(chain, proj, 64).length >= 4);
});

test('trash: photos are hidden but kept, restored, and due for good after 30 days', () => {
  const ix = C.emptyIndex();
  ix.photos.a = { id: 'a', files: { thumb: 't/a' } };
  ix.photos.b = { id: 'b', files: { thumb: 't/b' } };
  C.applyOp(ix, { op: 'trashPhotos', ids: ['a', 'b'], at: '2026-09-01T00:00:00Z', by: 'alice' });
  assert.ok(C.isTrashed(ix.photos.a) && ix.photos.a.trashedBy === 'alice' && ix.photos.a.files.thumb === 't/a', 'the files stay while it is in the trash');
  const now = Date.parse('2026-09-21T00:00:00Z');
  assert.equal(C.trashDaysLeft(ix.photos.a, now), 10);
  assert.deepEqual(C.trashDue(Object.values(ix.photos), now), []);
  assert.deepEqual(C.trashDue(Object.values(ix.photos), Date.parse('2026-10-01T00:00:01Z')).sort(), ['a', 'b']);
  C.applyOp(ix, { op: 'restorePhotos', ids: ['b'] });
  assert.ok(!C.isTrashed(ix.photos.b) && ix.photos.b.trashedBy === undefined);
});

test('caption = pinned comment: pin, re-pin, unpin, and deleting the pinned comment clears it', () => {
  const ix = C.emptyIndex();
  ix.photos.a = { id: 'a', comments: [{ id: 'c1', by: 'bob', text: '성산 일출!' }, { id: 'c2', by: 'alice', text: '또 가자' }] };
  C.applyOp(ix, { op: 'pinComment', id: 'a', commentId: 'c1' });
  assert.deepEqual([ix.photos.a.pinned, ix.photos.a.caption, ix.photos.a.captionBy], ['c1', '성산 일출!', 'bob']);
  C.applyOp(ix, { op: 'pinComment', id: 'a', commentId: 'c2' });
  assert.equal(ix.photos.a.caption, '또 가자');
  C.applyOp(ix, { op: 'uncomment', id: 'a', commentId: 'c2' });
  assert.equal(ix.photos.a.caption, undefined);
  assert.equal(ix.photos.a.pinned, undefined);
  ix.photos.a.caption = 'legacy caption';
  C.applyOp(ix, { op: 'pinComment', id: 'a', commentId: null });
  assert.equal(ix.photos.a.caption, undefined);
  assert.ok(C.filterPhotos([{ ...ix.photos.a, caption: '일출' }], { q: '일출' }).length === 1, 'the caption is still searchable');
});

test('setLive: motion added to a still photo later', () => {
  const ix = C.emptyIndex();
  ix.photos.a = { id: 'a', files: { thumb: 't', original: 'o' }, sizes: { thumb: 1 } };
  C.applyOp(ix, { op: 'setLive', id: 'a', path: 'media/x.live.mov', mime: 'video/quicktime', size: 99 });
  assert.deepEqual(ix.photos.a.files, { thumb: 't', original: 'o', live: 'media/x.live.mov' });
  assert.equal(ix.photos.a.sizes.live, 99);
  assert.ok(C.filesOf(ix.photos.a).includes('media/x.live.mov'));
});

