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
  assert.equal(d[1].title, '2024년 5월 4일 토요일');
  assert.deepEqual(d[1].photos.map(p => p.id), ['2', '1']);
  assert.deepEqual(C.groupByDate(P, 'asc').map(g => g.key)[0], '2023-12-24');

  const city = C.groupByPlace(P);
  assert.deepEqual(city.map(g => g.title), ['서울특별시', '서귀포시', '東京都', '위치 정보 없음']);
  assert.deepEqual(city[1].range, ['2024-05-04', '2024-05-04']);
  assert.ok(city[1].center.lat > 33.2 && city[1].center.lat < 33.5);
  assert.deepEqual(C.groupByPlace(P, { level: 'district', order: 'count' }).map(g => g.photos.length), [1, 1, 1, 1, 1]);
  assert.deepEqual(C.groupByPlace(P, { level: 'country', order: 'count' }).map(g => g.title), ['대한민국', '日本', '위치 정보 없음']);

  const t = C.groupByTag(P);
  assert.deepEqual(t.map(g => g.title), ['#제주', '#바다', '태그 없음']);
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
  assert.equal(C.fmtTime('2024-05-04T00:05:00'), '오전 12:05');
  assert.equal(C.fmtTime('2024-05-04T13:30:00'), '오후 1:30');
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
