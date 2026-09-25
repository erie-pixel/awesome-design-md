/* ============================================================
   Moa — app UI
   Tabs: 보관함 (date · place · map · tag views) · 앨범 · 공유·설정
   Every edit is an op (see core.js) applied optimistically, kept in
   a persisted pending queue, and flushed to GitHub as one commit.
   ============================================================ */

import * as C from './core.js';
import { Repo, blobToBase64, clearMediaCache } from './github.js';
import { analyzeFile, buildEntries, makeRenditions } from './media.js';
import { reverseGeocode, searchPlaces } from './geo.js';
import * as LIM from './limits.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ICON = {
  live: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><circle cx="12" cy="12" r="2.8"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="9.3" stroke-dasharray="1.2 2.4"/></svg>',
  heart: '<svg class="fav" viewBox="0 0 24 24"><path d="M12 20.5s-7.5-4.6-9.3-9.2C1.5 8 3.3 4.5 6.7 4.5c2.1 0 3.4 1.1 4.3 2.4.9-1.3 2.2-2.4 4.3-2.4 3.4 0 5.2 3.5 4 6.8-1.8 4.6-9.3 9.2-9.3 9.2z"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l10.5-6.5z"/></svg>',
  album: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><rect x="3" y="5" width="18" height="15" rx="2.5"/><path d="m3 16 5-5 4 4 3-3 6 6"/><circle cx="15.5" cy="9.5" r="1.6"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/></svg>',
  back: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="m15 5-7 7 7 7"/></svg>',
};

// ---------------- persistence ----------------

const LS = { spaces: 'moa.spaces', current: 'moa.current', prefs: 'moa.prefs', pending: id => 'moa.pending.' + id };
function load(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } }
function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* quota / private mode */ } }

const prefs = Object.assign({ autoplayLive: true, keepOriginal: true, geocode: true }, load(LS.prefs, {}));

const S = {
  spaces: load(LS.spaces, []),
  space: null, gh: null, me: null, canWrite: true, repoInfo: null,
  index: null, head: null, base: null, pending: [],
  tab: 'photos', album: null,
  view: 'date', order: 'desc', placeLevel: 'city', placeOrder: 'recent', mapFocus: null,
  filter: { kind: '', tag: '', q: '' },
  selecting: false, selected: new Set(), expanded: new Set(),
  list: [],
};

const photos = () => Object.values(S.index?.photos || {});
const saveSpaces = () => save(LS.spaces, S.spaces);
const savePending = () => S.space && save(LS.pending(S.space.id), S.pending);

// ---------------- small UI helpers ----------------

let toastTimer;
function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

// Bottom sheet: transitions (not keyframes) so open/close can be
// interrupted; drawer curve in, quicker ease-out away; flick to dismiss.
let sheetOnClose = null, sheetTimer = null;
const sheetOpen = () => $('#scrim').classList.contains('open');
function openSheet(html, { onClose, kind = '' } = {}) {
  const sc = $('#scrim'), sh = $('#sheet');
  clearTimeout(sheetTimer);
  const prev = sheetOnClose; sheetOnClose = null; prev?.();
  const wasOpen = sheetOpen();
  sh.dataset.kind = kind;
  sh.innerHTML = '<div class="grab"></div>' + html;
  sh.scrollTop = 0;
  sh.style.transform = '';
  sc.hidden = false;
  if (!wasOpen) { void sc.offsetWidth; sc.classList.add('open'); }
  sheetOnClose = onClose || null;
  return sh;
}
function closeSheet() {
  const sc = $('#scrim'), sh = $('#sheet');
  if (!sheetOpen()) return;
  sc.classList.remove('open');
  sh.dataset.kind = '';
  const f = sheetOnClose; sheetOnClose = null; f?.();
  clearTimeout(sheetTimer);
  sheetTimer = setTimeout(() => { if (!sheetOpen()) { sc.hidden = true; sh.innerHTML = ''; sh.style.transform = ''; } }, 240);
}

function bindSheetDrag() {
  const sh = $('#sheet');
  let d = null;
  sh.addEventListener('pointerdown', e => {
    if (!matchMedia('(max-width: 719px)').matches || d) return; // one pointer at a time
    if (e.target.closest('input, textarea, select, button, a, .up-list, .chips') || sh.scrollTop > 0) return;
    d = { y: e.clientY, t: performance.now(), id: e.pointerId, dy: 0, active: false };
  });
  sh.addEventListener('pointermove', e => {
    if (!d || e.pointerId !== d.id) return;
    const dy = e.clientY - d.y;
    if (!d.active) {
      if (Math.abs(dy) < 6) return;
      d.active = true;
      sh.setPointerCapture(e.pointerId);
      sh.classList.add('dragging');
    }
    // downward follows the finger, upward meets friction
    d.dy = dy > 0 ? dy : -Math.sqrt(-dy) * 2;
    sh.style.transform = `translateY(${d.dy}px)`;
  });
  const end = e => {
    if (!d || e.pointerId !== d.id) return;
    const { dy, t, active } = d;
    d = null;
    if (!active) return;
    sh.classList.remove('dragging');
    const velocity = dy / (performance.now() - t);
    if (dy > sh.offsetHeight * 0.3 || (dy > 12 && velocity > 0.11)) {
      sh.style.transform = 'translateY(100%)';
      closeSheet();
    } else sh.style.transform = '';
  };
  sh.addEventListener('pointerup', end);
  sh.addEventListener('pointercancel', end);
}

function setSync(state, arg) {
  const el = $('#sync');
  el.hidden = !state;
  el.classList.toggle('err', state === 'error');
  el.classList.toggle('info', state === 'throttle');
  el.textContent = { pending: '저장 대기', saving: '저장 중…', error: '저장 실패', loading: '불러오는 중…', throttle: `속도 조절 ${arg}초` }[state] || '';
}

const fmtDur = s => { const t = Math.max(0, Math.floor(s || 0)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
const fmtDate = iso => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' }); };
const avatar = login => `https://github.com/${encodeURIComponent(login)}.png?size=96`;
const errMsg = e => e?.message || String(e);

// ---------------- media URLs (object URLs over the cached blobs) ----------------

const urls = new Map();      // key -> Promise<objectURL>
const resolved = new Map();  // key -> objectURL, for synchronous re-renders without flicker
function mediaURL(path, mime) {
  if (!path) return Promise.reject(new Error('no path'));
  const key = S.space.id + ':' + path;
  if (urls.has(key)) { const v = urls.get(key); urls.delete(key); urls.set(key, v); return v; }
  const gh = S.gh;
  const pr = gh.media(path).then(b => {
    const u = URL.createObjectURL(mime && b.type !== mime ? new Blob([b], { type: mime }) : b);
    if (urls.get(key) === pr) resolved.set(key, u);
    return u;
  });
  pr.catch(() => urls.delete(key));
  urls.set(key, pr);
  if (urls.size > 700) {
    const [k, v] = urls.entries().next().value;
    urls.delete(k);
    resolved.delete(k);
    v.then(u => setTimeout(() => URL.revokeObjectURL(u), 60000), () => {});
  }
  return pr;
}

/** <img> for a thumbnail: immediate when already loaded, lazy otherwise. */
function thumbImg(path) {
  const u = path && resolved.get(S.space.id + ':' + path);
  return u ? `<img alt="" class="ok" src="${u}">` : `<img alt="" data-thumb="${esc(path || '')}">`;
}

function playableType(mime) {
  if (mime === 'video/quicktime' && !document.createElement('video').canPlayType('video/quicktime')) return 'video/mp4';
  return mime || 'video/mp4';
}

const io = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
  for (const e of entries) if (e.isIntersecting) { io.unobserve(e.target); loadThumb(e.target); }
}, { rootMargin: '800px 0px' }) : null;

function loadThumb(img) {
  const path = img.dataset.thumb;
  if (!path || img.dataset.loaded) return;
  img.dataset.loaded = '1';
  mediaURL(path, 'image/jpeg').then(u => {
    img.onload = () => img.classList.add('ok');
    img.src = u;
  }).catch(() => { img.dataset.loaded = ''; });
}

function observeThumbs(root) {
  $$('img[data-thumb]', root).forEach(img => io ? io.observe(img) : loadThumb(img));
}

// ============================================================
// boot & spaces
// ============================================================

function parseJoin() {
  const m = /[#&]join=([^&]+)/.exec(location.hash);
  if (!m) return null;
  const [owner, repo] = decodeURIComponent(m[1]).split('/');
  const api = /[#&]api=([^&]+)/.exec(location.hash);
  const by = /[#&]by=([^&]+)/.exec(location.hash);
  return owner && repo ? { owner, repo, api: api && decodeURIComponent(api[1]), by: by && decodeURIComponent(by[1]) } : null;
}

function parseRepo(s) {
  const t = String(s || '').trim().replace(/\.git$/, '').replace(/^https?:\/\/[^/]+\//, '');
  const [owner, repo] = t.split('/').filter(Boolean);
  return owner && repo ? { owner, repo } : null;
}

async function boot() {
  registerSW();
  const join = parseJoin();
  if (join) {
    const known = S.spaces.find(s => s.owner.toLowerCase() === join.owner.toLowerCase() && s.repo.toLowerCase() === join.repo.toLowerCase());
    history.replaceState(null, '', location.pathname + location.search);
    if (known) return openSpace(known);
    return showWelcome({ join });
  }
  const sp = S.spaces.find(s => s.id === load(LS.current, null)) || S.spaces[0];
  if (!sp) return showWelcome();
  openSpace(sp);
}

function showWelcome({ join, adding } = {}) {
  $('#shell').hidden = true;
  const w = $('#welcome');
  w.hidden = false;
  const colors = ['#ff9f0a', '#ff375f', '#bf5af2', '#0a84ff', '#30d158', '#ffd60a', '#64d2ff', '#ff6961', '#5e5ce6', '#ffb340', '#34c759', '#ff2d55', '#af52de', '#007aff', '#ffcc00', '#5ac8fa'];
  w.innerHTML = `<div class="card">
    <div class="mosaic" aria-hidden="true">${colors.map((c, i) => `<i style="background:${c};animation-delay:${i * 35}ms"></i>`).join('')}</div>
    <h1>Moa</h1>
    <p class="lead">GitHub 저장소를 사진 클라우드로.<br>친구와 함께 채우는 공유앨범.</p>
    ${join ? `<div class="invite-banner">📮 ${join.by ? `<b>@${esc(join.by)}</b>님이 ` : ''}<b>${esc(join.owner)}/${esc(join.repo)}</b> 앨범에 초대했어요. 초대를 수락한 GitHub 계정의 토큰으로 연결하세요.</div>` : ''}
    <form id="connectForm" autocomplete="off">
      <label class="field"><span>GitHub 저장소</span><input name="repo" placeholder="아이디/저장소이름" value="${join ? esc(join.owner + '/' + join.repo) : ''}" required autocapitalize="off" spellcheck="false"></label>
      <label class="field"><span>액세스 토큰</span><input name="token" type="password" placeholder="github_pat_…" required autocapitalize="off" spellcheck="false"><small>토큰은 이 기기의 브라우저에만 저장되고 GitHub 말고는 어디에도 보내지 않아요.</small></label>
      <details class="field"><summary style="cursor:pointer;color:var(--muted);font-size:13px;margin:0 4px 8px">고급 설정</summary>
        <label class="field"><span>브랜치 (비우면 기본 브랜치)</span><input name="branch" placeholder="main"></label>
        <label class="field"><span>API 주소 (GitHub Enterprise)</span><input name="api" placeholder="https://api.github.com" value="${join?.api ? esc(join.api) : ''}"></label>
      </details>
      <button class="btn btn-primary btn-block" type="submit">연결하기</button>
      <p class="err" id="connectErr" hidden></p>
    </form>
    <details class="guide"${S.spaces.length ? '' : ' open'}><summary>처음이라면 — 3분 설정</summary>
      <ol class="steps">
        <li><a href="https://github.com/new" target="_blank" rel="noopener">github.com/new</a>에서 <b>Private</b> 저장소를 하나 만드세요 (예: <code>our-photos</code>). 비어 있어도 괜찮아요.</li>
        <li><a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">Fine-grained 토큰 만들기</a> → Repository access: <b>Only select repositories</b>에서 그 저장소 선택 → Permissions → <b>Contents: Read and write</b> → 생성.</li>
        <li>위에 <code>아이디/저장소이름</code>과 토큰을 붙여넣고 연결하면 끝. 친구 초대는 연결 후 <b>공유·설정</b> 탭에서.</li>
      </ol>
      <p class="note" style="margin:0 0 12px">친구의 <b>개인 계정</b> 저장소에 협업자로 참여하는 경우, fine-grained 토큰이 그 저장소를 고를 수 없으면 <b>classic 토큰</b>(<code>repo</code> 권한)을 쓰거나, 저장소를 GitHub 조직(Organization)으로 옮기세요.</p>
    </details>
    ${adding || S.spaces.length ? '<button class="btn btn-quiet btn-block" id="welcomeCancel" style="margin-top:12px" type="button">취소</button>' : ''}
  </div>`;
  const form = $('#connectForm');
  if (join) setTimeout(() => form.token.focus(), 50);
  $('#welcomeCancel')?.addEventListener('click', () => { w.hidden = true; if (S.space) { $('#shell').hidden = false; } else boot(); });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const err = $('#connectErr');
    err.hidden = true;
    const r = parseRepo(form.repo.value);
    if (!r) { err.textContent = '저장소는 "아이디/저장소이름" 형식으로 적어주세요'; err.hidden = false; return; }
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = '확인 중…';
    const sp = { id: `${r.owner}/${r.repo}`.toLowerCase() + (form.api.value ? '@' + form.api.value : ''), ...r, token: form.token.value.trim(), branch: form.branch.value.trim() || null, api: form.api.value.trim() || null };
    try {
      const gh = new Repo(sp);
      await gh.user();
      await gh.info();
      sp.branch = gh.branch;
      S.spaces = S.spaces.filter(s => s.id !== sp.id).concat(sp);
      saveSpaces();
      w.hidden = true;
      openSpace(sp);
    } catch (ex) {
      err.textContent = errMsg(ex);
      err.hidden = false;
    } finally {
      btn.disabled = false; btn.textContent = '연결하기';
    }
  });
}

async function openSpace(sp) {
  S.space = sp;
  save(LS.current, sp.id);
  S.gh = new Repo(sp);
  S.gh.onWait = s => toast(`GitHub 요청 한도에 걸려 ${s}초 기다리는 중…`, 5000);
  // GitHub recommends ≤ 6 pushes/minute per repository; the client paces itself
  S.gh.onThrottle = s => { setSync('throttle', s); if (!S.throttleToast) { S.throttleToast = true; toast('GitHub 권장 저장 속도(분당 6회)에 맞춰 잠시 쉬었다 저장해요', 3500); } };
  S.pending = load(LS.pending(sp.id), []);
  Object.assign(S, { index: null, head: null, base: null, album: null, me: null, tab: 'photos' });
  S.filter = { kind: '', tag: '', q: '' };
  S.selected.clear();
  setSelecting(false);
  $('#welcome').hidden = true;
  $('#shell').hidden = false;
  $('#spaceName').textContent = sp.repo;
  $('#content').innerHTML = '<div class="empty"><p>앨범을 불러오는 중…</p></div>';
  $('#hero').innerHTML = '';
  showTab('photos', false);
  setSync('loading');
  try {
    const [me, info] = await Promise.all([S.gh.user(), S.gh.info()]);
    if (S.space !== sp) return;
    S.me = me;
    S.repoInfo = info;
    S.canWrite = info.permissions ? !!info.permissions.push : true;
    if (sp.branch !== S.gh.branch) { sp.branch = S.gh.branch; saveSpaces(); }
    await refresh(true);
    setSync(S.pending.length ? 'pending' : null);
    if (S.pending.length) scheduleFlush(500);
  } catch (e) {
    if (S.space !== sp) return;
    setSync('error');
    if (e.status === 0 && await loadOfflineIndex()) { toast('오프라인 — 마지막으로 불러온 앨범을 보여줘요'); return; }
    $('#content').innerHTML = `<div class="empty"><h2>연결할 수 없어요</h2><p>${esc(errMsg(e))}</p><button class="btn btn-primary" id="retryBtn">다시 시도</button> <button class="btn btn-quiet" id="reconnectBtn">토큰 다시 입력</button></div>`;
    $('#retryBtn').onclick = () => openSpace(sp);
    $('#reconnectBtn').onclick = () => showWelcome({ join: { owner: sp.owner, repo: sp.repo, api: sp.api }, adding: true });
  }
}

async function loadOfflineIndex() {
  try {
    const hit = await (await caches.open('moa-media-v1')).match(S.gh.cacheKey('.moa/index-cache.json'));
    if (!hit) return false;
    const { head, index } = await hit.json();
    S.me ||= { login: '' };
    adopt({ head, index, files: null });
    return true;
  } catch { return false; }
}

/** Pull the latest head; re-render if anything changed. */
async function refresh(first = false) {
  const sp = S.space;
  const head = await S.gh.head();
  if (S.space !== sp) return;
  if (!head) { S.head = null; S.index = null; return renderInit(true); }
  if (head === S.head && !first) return;
  const st = await S.gh.state(head);
  if (S.space !== sp) return;
  if (!st.index) { S.head = head; S.index = null; return renderInit(false); }
  const ix = st.index;
  const before = S.index ? Object.keys(S.index.photos).length : null;
  adopt(st);
  const after = Object.keys(S.index.photos).length;
  if (!first && before != null && after > before) toast(`새 사진 ${after - before}장이 올라왔어요`);
  S.gh.primeCache('.moa/index-cache.json', new Blob([JSON.stringify({ head, index: ix })], { type: 'application/json' }));
  if (first && S.canWrite && S.me?.login && !S.index.members[S.me.login]) edit({ op: 'join', user: S.me.login, at: new Date().toISOString() });
  runGeocodeJob();
}

/** Take a fetched/committed album state { head, index, files } as the new base. */
function adopt(st) {
  S.head = st.head;
  S.base = st;
  S.index = C.applyOps(structuredClone(st.index), S.pending);
  $('#spaceName').textContent = S.index.title || S.space.repo;
  if (S.album && !S.index.albums[S.album]) S.album = null;
  rerender();
  if (!$('#viewer').hidden) refreshViewer();
}

// ---------------- commits ----------------

let chain = Promise.resolve();
function serial(fn) { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; }

let flushTimer = null, firstPendingAt = 0;
function edit(op) {
  if (!S.index) return;
  if (!S.canWrite) { toast('이 저장소는 읽기 전용이에요'); return; }
  C.applyOp(S.index, op);
  if (!S.pending.length) firstPendingAt = Date.now();
  S.pending.push(op);
  savePending();
  scheduleFlush();
  rerender();
}

function scheduleFlush(ms = 2500) {
  clearTimeout(flushTimer);
  setSync('pending');
  const overdue = Date.now() - firstPendingAt > 12000;
  flushTimer = setTimeout(flush, overdue ? 0 : ms);
}

function describe(ops) {
  const n = ops.length;
  const kinds = [...new Set(ops.map(o => o.op))];
  const names = { tag: '태그', like: '좋아요', comment: '댓글', uncomment: '댓글 삭제', updatePhoto: '사진 정보', deletePhotos: '사진 삭제', createAlbum: '앨범 만들기', renameAlbum: '앨범 이름', deleteAlbum: '앨범 삭제', albumMembership: '앨범 정리', setCover: '앨범 커버', join: '참여', setTitle: '제목' };
  return `Moa: ${kinds.map(k => names[k] || k).join(', ')}${n > 1 ? ` (${n})` : ''}${S.me?.login ? ` — @${S.me.login}` : ''}`;
}

function flush() {
  clearTimeout(flushTimer);
  return serial(async () => {
    if (!S.pending.length || !S.gh) return;
    const sp = S.space;
    const ops = S.pending.slice();
    setSync('saving');
    try {
      const r = await S.gh.commit({ ops, message: describe(ops), base: S.base, title: S.index?.title });
      if (S.space !== sp) return;
      S.pending = S.pending.slice(ops.length);
      savePending();
      if (S.pending.length) firstPendingAt = Date.now();
      adopt(r);
      setSync(S.pending.length ? 'pending' : null);
      if (S.pending.length) scheduleFlush(400);
    } catch (e) {
      if (S.space !== sp) return;
      console.error(e);
      setSync('error');
      toast('저장하지 못했어요: ' + errMsg(e) + ' — 잠시 후 다시 시도할게요', 4000);
      flushTimer = setTimeout(flush, 20000);
    }
  });
}

// periodic pull so friends' uploads show up
setInterval(() => { if (!document.hidden) pull(); }, 45000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) pull(); else if (S.pending.length) flush(); });
window.addEventListener('online', () => { if (S.pending.length) flush(); pull(); });
function pull() {
  if (!S.gh || !S.head || U.running) return;
  serial(() => refresh().catch(() => {}));
}
window.addEventListener('beforeunload', e => { if (U.running) { e.preventDefault(); e.returnValue = ''; } });

// ============================================================
// rendering
// ============================================================

let rerenderTimer = null;
function rerender() {
  clearTimeout(rerenderTimer);
  rerenderTimer = setTimeout(render, 60);
}

function render() {
  if (!S.index) return;
  $('#uploadBtn').hidden = !S.canWrite;
  $('#uploadFab').hidden = !S.canWrite;
  $('#selectBtn').hidden = S.tab !== 'photos' || S.view === 'map' || !S.canWrite;
  $('#searchBtn').hidden = S.tab !== 'photos';
  if (S.tab === 'photos') renderPhotos();
  else if (S.tab === 'albums') renderAlbums();
  else renderSettings();
}

function showTab(tab, draw = true) {
  S.tab = tab;
  if (tab !== 'photos') setSelecting(false);
  $$('.tab').forEach(t => { t.hidden = t.id !== 'tab-' + tab; });
  const tabs = ['photos', 'albums', 'settings'];
  $$('#tabbar [data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  $('#tabThumb').style.transform = `translateX(${tabs.indexOf(tab) * 100}%)`;
  if (draw) { render(); window.scrollTo(0, 0); }
}

function renderInit(empty) {
  showTab('photos', false);
  $('#hero').innerHTML = '';
  $('#toolbar').hidden = true;
  $('#uploadBtn').hidden = true;
  $('#uploadFab').hidden = true;
  $('#selectBtn').hidden = true;
  setSync(null);
  const c = $('#content');
  if (!S.canWrite) {
    c.innerHTML = `<div class="empty"><h2>아직 앨범이 아니에요</h2><p>이 저장소에는 Moa 앨범이 없고, 이 토큰으로는 만들 수 없어요 (읽기 전용).</p></div>`;
    return;
  }
  c.innerHTML = `<div class="empty">
    <h2>${empty ? '비어 있는 저장소예요' : '이 저장소에 앨범을 만들까요?'}</h2>
    <p><b>${esc(S.space.owner)}/${esc(S.space.repo)}</b>에 Moa 앨범을 시작합니다. 사진은 이 저장소에 파일로 저장되고, 앨범 정보는 <code>index.json</code> 하나에 담겨요.</p>
    <div style="max-width:340px;margin:0 auto"><label class="field"><span>앨범 이름</span><input id="initTitle" value="${esc(S.repoInfo?.description || '우리 앨범')}"></label>
    <button class="btn btn-primary btn-block" id="initBtn">앨범 만들기</button></div></div>`;
  $('#initBtn').onclick = () => serial(async () => {
    const btn = $('#initBtn');
    btn.disabled = true; btn.textContent = '만드는 중…';
    const title = $('#initTitle').value.trim() || '우리 앨범';
    try {
      if (empty) await S.gh.seed('README.md', repoReadme(title), 'Moa 앨범 시작');
      const r = await S.gh.commit({ ops: [{ op: 'setTitle', title }, { op: 'join', user: S.me.login, at: new Date().toISOString() }], message: `Moa: 앨범 만들기 — @${S.me.login}`, title });
      $('#toolbar').hidden = false;
      adopt(r);
      toast('앨범을 만들었어요. 사진을 올려보세요!');
    } catch (e) {
      btn.disabled = false; btn.textContent = '앨범 만들기';
      toast(errMsg(e), 4000);
    }
  });
}

function repoReadme(title) {
  return `# ${title}\n\n[Moa](https://github.com/erie-pixel/awesome-design-md/tree/main/moa) 공유앨범 저장소예요.\n\n- \`album.json\` — 앨범 이름, 멤버, 앨범 목록\n- \`index/YYYY-MM.json\` — 촬영 월별 사진 정보, 태그, 댓글\n- \`media/YYYY/MM/DD/\` — 원본 사진·동영상 (\`*.live.mov\` 는 라이브 포토 영상)\n- \`preview/\`, \`thumb/\` — 앱에서 보여주는 JPEG\n\n파일을 직접 옮기거나 지우면 앨범이 깨질 수 있으니 Moa 앱에서 관리하세요.\n`;
}

// ---------------- capacity (GitHub repository limits) ----------------

const storageUsage = () => LIM.usage({ repoKB: S.repoInfo?.size || 0, photos: photos() });
const pctText = r => `${r < 0.1 ? (r * 100).toFixed(1) : Math.round(r * 100)}%`;

function capBanner() {
  const u = storageUsage();
  if (u.level === 'ok') return '';
  const head = u.level === 'over' ? '권장 용량 초과' : `용량 ${pctText(u.ratio)} 사용`;
  return `<div class="cap-banner ${u.level}"><span><b>${head}</b> · 남은 ${C.fmtBytes(u.remaining)} / 10GB</span><button class="text-btn" data-act="storage">자세히</button></div>`;
}

function ring(ratio, level) {
  const R0 = 42, CIRC = 2 * Math.PI * R0;
  const off = CIRC * (1 - Math.min(1, ratio));
  return `<div class="ring ${level}"><svg viewBox="0 0 96 96"><circle class="track" cx="48" cy="48" r="${R0}"/><circle class="val" cx="48" cy="48" r="${R0}" stroke-dasharray="${CIRC.toFixed(1)}" stroke-dashoffset="${CIRC.toFixed(1)}" data-off="${off.toFixed(1)}"/></svg><span class="pct">${pctText(ratio)}</span></div>`;
}

/** Status rows for every GitHub limit Moa can run into. */
function limitRows() {
  const all = photos();
  const u = storageUsage();
  const big = LIM.largestFile(all);
  const busy = LIM.busiestDir(LIM.dirCounts(all));
  const over1 = all.filter(p => Object.values(p.sizes || {}).some(x => x > LIM.LIMITS.objectRecommended)).length;
  let shard = { path: '', size: 0 };
  for (const [path, f] of S.base?.files || []) if ((f.size || 0) > shard.size) shard = { path, size: f.size };
  const pushes = S.gh.recentPushes();
  const row = (level, title, sub, val) => `<div class="row"><span class="dot ${level}"></span><div class="grow"><b>${title}</b><small>${sub}</small></div><span class="val">${val}</span></div>`;
  return [
    row(u.level, '저장소 크기 · 권장 최대 10GB', 'GitHub 권장치를 넘으면 느려질 수 있어요', `${C.fmtBytes(u.used)}`),
    row(LIM.levelOf(big.size / LIM.LIMITS.objectHard), '파일 1개 · 최대 100MB', big.size ? `가장 큰 파일 ${esc(big.name || '')}` : '아직 파일이 없어요', C.fmtBytes(big.size)),
    row('info', '권장 파일 크기 1MB', over1 ? `1MB 넘는 사진 ${over1}장 — 원본은 대부분 커요. 옵션에서 원본 저장을 끄면 줄어요` : '모두 권장 크기 이하', `${over1}장`),
    row(busy.level, '폴더당 파일 · 권장 최대 3,000개', busy.dir ? `가장 붐비는 폴더 ${esc(busy.dir)}` : '날짜별 폴더로 나눠 저장해요', `${busy.count.toLocaleString()}개`),
    shard.path ? row(LIM.levelOf(shard.size / LIM.LIMITS.objectRecommended), '앨범 정보 파일 · 권장 1MB', `가장 큰 조각 ${esc(shard.path)} (월별로 나눠 저장)`, C.fmtBytes(shard.size)) : '',
    row(pushes >= LIM.LIMITS.pushesPerMinute ? 'warn' : 'ok', '저장 속도 · 권장 분당 6회', pushes >= LIM.LIMITS.pushesPerMinute ? '한도에 닿아서 다음 저장은 잠시 기다렸다 해요' : '넘을 것 같으면 앱이 알아서 기다렸다 저장해요', `${pushes}회/분`),
  ].join('');
}

function uploadPlanHTML(E, keepOriginal) {
  const u = storageUsage();
  const plan = LIM.planUpload(E, { keepOriginal, usage: u });
  const withOrig = keepOriginal ? plan : LIM.planUpload(E, { keepOriginal: true, usage: u });
  const noOrig = keepOriginal ? LIM.planUpload(E, { keepOriginal: false, usage: u }) : plan;
  const tooBig = E.filter(e => e.main.tooBig).length;
  const n = E.filter(e => !e.skip).length;
  const li = (level, text) => `<li><span class="dot ${level}"></span><span>${text}</span></li>`;
  const items = [
    tooBig ? li('danger', `100MB 넘는 파일 ${tooBig}개는 GitHub가 받지 않아 빼고 올려요`) : '',
    plan.heavy.length ? li('warn', `50MB 넘는 파일 ${plan.heavy.length}개 — 브라우저 업로드가 느리거나 실패할 수 있어요`) : '',
    plan.overRecommended.length && keepOriginal ? li('info', `GitHub 권장 파일 크기(1MB)를 넘는 원본 ${plan.overRecommended.length}개 — 원본 저장을 끄면 약 ${C.fmtBytes(withOrig.bytes - noOrig.bytes)} 줄어요`) : '',
    plan.level !== 'ok' ? li(plan.level, plan.level === 'over' ? `업로드하면 권장 용량 10GB를 넘어요 (${pctText(plan.ratioAfter)})` : `업로드 후 권장 용량의 ${pctText(plan.ratioAfter)}를 쓰게 돼요`) : '',
    n > 10 ? li('info', `${Math.ceil(n / 10)}번에 나눠 저장해요 (GitHub 권장 분당 6회 이하로 속도 조절)`) : '',
  ].join('');
  return { plan, html: `<div class="cap ${plan.level}"><div class="cap-track"><i class="add" style="transform:scaleX(${Math.min(1, plan.ratioAfter).toFixed(4)})"></i><i class="used" style="transform:scaleX(${Math.min(1, plan.ratioBefore).toFixed(4)})"></i></div>
    <div class="cap-labels"><span>이번 업로드 약 <b>${C.fmtBytes(plan.bytes)}</b></span><span>남은 용량 <b>${C.fmtBytes(plan.remainingAfter)}</b> / 10GB</span></div></div>
    ${items ? `<ul class="limit-list">${items}</ul>` : ''}
    ${plan.level === 'over' ? '<label class="ack"><input type="checkbox" id="upAck">GitHub 권장 용량을 넘는 걸 알고 올릴게요 (저장소가 느려질 수 있어요)</label>' : ''}` };
}

// ---------------- photos tab ----------------

function currentList() {
  return C.filterPhotos(photos(), { album: S.album, tag: S.filter.tag, kind: S.filter.kind, q: S.filter.q });
}

function renderPhotos() {
  $('#toolbar').hidden = false;
  const all = S.album ? photos().filter(p => (p.albums || []).includes(S.album)) : photos();
  renderHero(all);
  renderToolbar(all);
  const list = currentList();
  const c = $('#content');
  if (S.view !== 'map' && S.map) { S.map.remove(); S.map = null; }

  if (!all.length) {
    c.innerHTML = `<div class="empty"><h2>${S.album ? '앨범이 비어 있어요' : '첫 사진을 올려보세요'}</h2>
      <p>${S.album ? '보관함에서 사진을 선택해 이 앨범에 추가하거나, 여기서 바로 업로드하세요.' : '아이폰 사진의 촬영 날짜·장소·라이브 포토가 그대로 담겨요. 친구도 같은 저장소에 올리면 모두 함께 보여요.'}</p>
      ${S.canWrite ? '<button class="btn btn-primary" data-act="upload">사진 올리기</button>' : ''}</div>`;
    S.list = [];
    return;
  }
  if (!list.length) {
    c.innerHTML = '<div class="empty"><h2>조건에 맞는 사진이 없어요</h2><p>필터나 검색어를 바꿔보세요.</p><button class="btn btn-quiet" data-act="clearFilter">필터 지우기</button></div>';
    S.list = [];
    return;
  }
  if (S.view === 'map') return renderMap(list, c);

  let html = '';
  if (S.view === 'date') {
    const groups = C.groupByDate(list, S.order);
    let month = '';
    for (const g of groups) {
      if (g.month !== month) { month = g.month; html += `<h2 class="month">${/^\d{4}-\d{2}$/.test(month) ? C.fmtMonth(month) : esc(month)}</h2>`; }
      const labels = [...new Set(g.photos.map(p => p.place?.name || p.place?.label).filter(Boolean))];
      const sub = labels.length ? esc(labels[0]) + (labels.length > 1 ? ` 외 ${labels.length - 1}곳` : '') : '';
      html += `<div class="group-h"><h3>${esc(g.title)}</h3><span class="sub">${sub}</span></div><div class="grid">${g.photos.map(tileHTML).join('')}</div>`;
    }
    S.list = groups.flatMap(g => g.photos);
  } else if (S.view === 'place') {
    const groups = C.groupByPlace(list, { level: S.placeLevel, order: S.placeOrder });
    html = groups.map(g => groupCard(g, g.none ? '위치 정보가 없는 사진' : [g.subtitle, periodText(g.range)].filter(Boolean).join(' · '), !g.none && g.center)).join('');
    S.list = groups.flatMap(g => g.photos);
  } else {
    const groups = C.groupByTag(list);
    html = groups.map(g => groupCard(g, g.none ? '태그를 달면 여기서 모아볼 수 있어요' : '')).join('');
    const seen = new Set();
    S.list = groups.flatMap(g => g.photos).filter(p => !seen.has(p.id) && seen.add(p.id));
  }
  c.innerHTML = capBanner() + html;
  observeThumbs(c);
}

function periodText(range) {
  if (!range) return '';
  const f = d => d.replace(/^(\d{4})-0?(\d+)-0?(\d+)$/, '$1.$2.$3');
  return range[0] === range[1] ? f(range[0]) : `${f(range[0])} – ${f(range[1])}`;
}

function groupCard(g, sub, center) {
  const key = S.view + ':' + g.key;
  const open = S.expanded.has(key);
  const LIMIT = 12;
  const shown = open ? g.photos : g.photos.slice(0, LIMIT);
  return `<section class="place-card">
    <div class="group-h"><div style="min-width:0"><h3>${esc(g.title)}</h3><div class="sub">${esc(sub)}</div></div>
      ${center ? `<button class="text-btn" data-act="mapAt" data-lat="${center.lat}" data-lng="${center.lng}">지도</button>` : ''}</div>
    <div class="grid">${shown.map(tileHTML).join('')}</div>
    <div class="foot"><span>${g.photos.length}장</span>${g.photos.length > LIMIT ? `<button class="text-btn" data-act="expand" data-key="${esc(key)}">${open ? '접기' : `모두 보기`}</button>` : ''}</div>
  </section>`;
}

function tileHTML(p) {
  return `<button class="tile${S.selected.has(p.id) ? ' sel' : ''}" data-id="${esc(p.id)}" aria-label="${esc(p.name || '사진')}">${thumbImg(p.files?.thumb)}${p.files?.live ? `<span class="badge">${ICON.live}</span>` : ''}${p.kind === 'video' ? `<span class="dur">${fmtDur(p.duration)}</span>` : ''}${p.likes?.length ? ICON.heart : ''}<span class="check"></span></button>`;
}

function renderHero(all) {
  const h = $('#hero');
  const lives = all.filter(p => p.files?.live).length;
  const videos = all.filter(p => p.kind === 'video').length;
  const bits = [`사진 ${(all.length - videos).toLocaleString()}장`];
  if (videos) bits.push(`동영상 ${videos}개`);
  if (lives) bits.push(`라이브 ${lives}`);
  if (S.album) {
    const a = S.index.albums[S.album];
    h.innerHTML = `<div style="min-width:0"><button class="back" data-act="backAlbums">${ICON.back}앨범</button><h1>${esc(a.name)}</h1><p>${bits.join(' · ')}${a.by ? ` · @${esc(a.by)}` : ''}</p></div>
      <div class="hero-actions">${S.canWrite ? '<button class="btn btn-quiet btn-sm" data-act="albumMenu">편집</button>' : ''}</div>`;
  } else {
    const members = Object.keys(S.index.members || {}).length;
    if (members > 1) bits.push(`멤버 ${members}명`);
    h.innerHTML = `<div><h1>보관함</h1><p>${bits.join(' · ')}</p></div>`;
  }
}

function renderToolbar(all) {
  const views = ['date', 'place', 'map', 'tag'];
  $$('#viewSeg button').forEach(b => b.classList.toggle('on', b.dataset.view === S.view));
  $('#segThumb').style.transform = `translateX(${views.indexOf(S.view) * 100}%)`;
  const ctl = $('#controls');
  if (S.view === 'date') {
    ctl.innerHTML = `<select data-ctl="order" aria-label="정렬"><option value="desc">최신순</option><option value="asc">오래된순</option></select>`;
    ctl.querySelector('select').value = S.order;
  } else if (S.view === 'place') {
    ctl.innerHTML = `<select data-ctl="placeLevel" aria-label="장소 단위"><option value="country">나라</option><option value="city">도시</option><option value="district">동네</option></select>
      <select data-ctl="placeOrder" aria-label="정렬"><option value="recent">최근 방문순</option><option value="count">사진 많은순</option><option value="name">이름순</option></select>`;
    ctl.querySelector('[data-ctl=placeLevel]').value = S.placeLevel;
    ctl.querySelector('[data-ctl=placeOrder]').value = S.placeOrder;
  } else ctl.innerHTML = '';

  const f = S.filter;
  const lives = all.filter(p => p.files?.live).length;
  const videos = all.filter(p => p.kind === 'video').length;
  const favs = all.filter(p => p.likes?.length).length;
  const tags = C.tagCounts(all).slice(0, 40);
  $('#chips').innerHTML = [
    `<button class="chip${!f.kind && !f.tag ? ' on' : ''}" data-chip="all">전체</button>`,
    lives ? `<button class="chip${f.kind === 'live' ? ' on' : ''}" data-chip="kind" data-v="live">${ICON.live}LIVE <span class="n">${lives}</span></button>` : '',
    videos ? `<button class="chip${f.kind === 'video' ? ' on' : ''}" data-chip="kind" data-v="video">동영상 <span class="n">${videos}</span></button>` : '',
    favs ? `<button class="chip${f.kind === 'fav' ? ' on' : ''}" data-chip="kind" data-v="fav">♥ 좋아요 <span class="n">${favs}</span></button>` : '',
    ...tags.map(([t, n]) => `<button class="chip${f.tag === t ? ' on' : ''}" data-chip="tag" data-v="${esc(t)}">#${esc(t)} <span class="n">${n}</span></button>`),
  ].join('');
}

// ---------------- map view ----------------

function renderMap(list, c) {
  const pts = list.filter(p => p.gps).sort((a, b) => C.sortTs(b) - C.sortTs(a));
  S.list = pts;
  if (!window.L) { c.innerHTML = '<div class="empty"><p>지도를 불러오지 못했어요.</p></div>'; return; }
  S.map?.remove();
  c.innerHTML = `<div class="map-wrap"><div id="map" style="width:100%;height:100%"></div><div class="map-note">${pts.length ? `${pts.length}장` : '위치가 있는 사진이 없어요'}${list.length > pts.length ? ` · 위치 없는 ${list.length - pts.length}장 제외` : ''}</div></div>`;
  const map = S.map = L.map('map', { worldCopyJump: true, zoomControl: !matchMedia('(pointer: coarse)').matches });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }).addTo(map);
  const layer = L.layerGroup().addTo(map);
  if (S.mapFocus) { map.setView(S.mapFocus, 14); S.mapFocus = null; }
  else if (pts.length) map.fitBounds(L.latLngBounds(pts.map(p => [p.gps.lat, p.gps.lng])).pad(0.15), { maxZoom: 15 });
  else map.setView([37.5665, 126.978], 11);

  const draw = () => {
    layer.clearLayers();
    const z = map.getZoom();
    for (const cl of C.clusterPoints(pts, g => map.project([g.lat, g.lng], z), 72)) {
      const p0 = cl.photos[0];
      const icon = L.divIcon({ className: '', iconSize: [58, 58], iconAnchor: [29, 64], html: `<div class="pin">${thumbImg(p0.files.thumb)}${cl.photos.length > 1 ? `<span class="cnt">${cl.photos.length}</span>` : ''}</div>` });
      L.marker([cl.lat, cl.lng], { icon, riseOnHover: true }).addTo(layer).on('click', () => {
        if (cl.photos.length === 1) return openViewer(p0.id, pts);
        const b = L.latLngBounds(cl.photos.map(p => [p.gps.lat, p.gps.lng]));
        if (z >= 16 || b.getNorthEast().distanceTo(b.getSouthWest()) < 30) openClusterSheet(cl.photos);
        else map.flyToBounds(b.pad(0.4), { maxZoom: 18, duration: 0.6 });
      });
    }
    $$('#map img[data-thumb]').forEach(loadThumb);
  };
  map.on('zoomend', draw);
  draw();
  setTimeout(() => map.invalidateSize(), 50);
}

function openClusterSheet(list) {
  const sh = openSheet(`<h2>이 근처 사진 ${list.length}장</h2><div class="grid" style="margin:0 -20px">${list.map(tileHTML).join('')}</div>`, { kind: 'cluster' });
  observeThumbs(sh);
  sh.onclick = e => { const t = e.target.closest('.tile'); if (t) { closeSheet(); openViewer(t.dataset.id, list); } };
}

// ---------------- albums tab ----------------

function albumCover(a, id) {
  const inAlbum = photos().filter(p => (p.albums || []).includes(id)).sort((x, y) => C.sortTs(y) - C.sortTs(x));
  const cover = (a.cover && S.index.photos[a.cover]) || inAlbum[0];
  return { cover, count: inAlbum.length };
}

function renderAlbums() {
  const t = $('#tab-albums');
  const albums = Object.entries(S.index.albums).sort((a, b) => (b[1].createdAt || '').localeCompare(a[1].createdAt || ''));
  const all = photos();
  const smart = [
    ['live', '라이브 포토', all.filter(p => p.files?.live)],
    ['video', '동영상', all.filter(p => p.kind === 'video')],
    ['fav', '좋아요', all.filter(p => p.likes?.length)],
  ].filter(s => s[2].length);
  const card = (inner, attrs) => `<button class="album-card" ${attrs}>${inner}</button>`;
  const coverHTML = p => `<div class="cover">${p ? thumbImg(p.files.thumb) : ICON.album}</div>`;
  t.innerHTML = `<div class="hero"><div><h1>앨범</h1><p>${albums.length}개 · 모든 멤버가 함께 채워요</p></div></div>
    <div class="albums">
      ${S.canWrite ? `<button class="album-card new" data-act="newAlbum"><div class="cover">${ICON.plus}</div><b>새 앨범</b><span>&nbsp;</span></button>` : ''}
      ${albums.map(([id, a]) => { const { cover, count } = albumCover(a, id); return card(`${coverHTML(cover)}<b>${esc(a.name)}</b><span>${count}장</span>`, `data-album="${esc(id)}"`); }).join('')}
    </div>
    ${smart.length || all.length ? '<h2 class="section-title">모아보기</h2>' : ''}
    <div class="albums">
      ${smart.map(([k, name, l]) => card(`${coverHTML(l.sort((x, y) => C.sortTs(y) - C.sortTs(x))[0])}<b>${name}</b><span>${l.length}</span>`, `data-smart="${k}"`)).join('')}
      ${all.some(p => p.place) ? card(`${coverHTML(all.filter(p => p.place).sort((x, y) => C.sortTs(y) - C.sortTs(x))[0])}<b>장소</b><span>${new Set(all.map(p => p.place && C.placeKey(p.place)).filter(Boolean)).size}곳</span>`, 'data-smart="place"') : ''}
      ${C.tagCounts(all).length ? card(`${coverHTML(all.find(p => p.tags?.length))}<b>태그</b><span>${C.tagCounts(all).length}개</span>`, 'data-smart="tag"') : ''}
    </div>`;
  observeThumbs(t);
}

function newAlbum(then) {
  const sh = openSheet(`<h2>새 앨범</h2><label class="field"><span>이름</span><input id="albumName" placeholder="예: 2026 제주 여행" maxlength="60"></label><div class="actions"><button class="btn btn-quiet" data-close>취소</button><button class="btn btn-primary" id="albumOk">만들기</button></div>`);
  const inp = $('#albumName', sh);
  setTimeout(() => inp.focus(), 50);
  const ok = () => {
    const name = inp.value.trim();
    if (!name) return inp.focus();
    const id = 'a-' + C.newId();
    edit({ op: 'createAlbum', album: { id, name, createdAt: new Date().toISOString(), by: S.me?.login } });
    closeSheet();
    then?.(id);
  };
  $('#albumOk', sh).onclick = ok;
  inp.onkeydown = e => { if (e.key === 'Enter') ok(); };
}

function albumMenu() {
  const a = S.index.albums[S.album];
  const sh = openSheet(`<h2>앨범 편집</h2><label class="field"><span>이름</span><input id="albumName" value="${esc(a.name)}" maxlength="60"></label>
    <div class="actions"><button class="btn btn-danger" id="albumDel">앨범 삭제</button><button class="btn btn-primary" id="albumOk">저장</button></div>
    <p class="note" style="margin:12px 0 0;padding:0">앨범을 지워도 사진은 보관함에 남아요.</p>`);
  $('#albumOk', sh).onclick = () => { const n = $('#albumName', sh).value.trim(); if (n && n !== a.name) edit({ op: 'renameAlbum', id: S.album, name: n }); closeSheet(); };
  $('#albumDel', sh).onclick = () => {
    if (!confirm(`'${a.name}' 앨범을 삭제할까요? 사진은 지워지지 않아요.`)) return;
    const id = S.album; S.album = null; closeSheet(); edit({ op: 'deleteAlbum', id }); showTab('albums');
  };
}

function pickAlbum(ids) {
  const albums = Object.entries(S.index.albums);
  const sh = openSheet(`<h2>앨범에 추가</h2><div>${albums.map(([id, a]) => `<button class="list-btn" data-pick="${esc(id)}"><span class="grow">${esc(a.name)}<small>${albumCover(a, id).count}장</small></span></button>`).join('') || '<p class="note" style="margin:0;padding:0">아직 앨범이 없어요.</p>'}
    <button class="list-btn" data-pick="__new"><span class="grow" style="color:var(--primary)">+ 새 앨범</span></button></div>
    ${S.album ? `<div class="actions"><button class="btn btn-danger" data-pick="__remove">'${esc(S.index.albums[S.album].name)}'에서 빼기</button></div>` : ''}`);
  sh.onclick = e => {
    const b = e.target.closest('[data-pick]');
    if (!b) return;
    const v = b.dataset.pick;
    const add = id => { edit({ op: 'albumMembership', ids, album: id, on: true }); toast(`'${S.index.albums[id].name}'에 ${ids.length}장 추가했어요`); setSelecting(false); };
    if (v === '__new') return newAlbum(add);
    closeSheet();
    if (v === '__remove') { edit({ op: 'albumMembership', ids, album: S.album, on: false }); setSelecting(false); return; }
    add(v);
  };
}

// ---------------- settings tab ----------------

function renderSettings() {
  const t = $('#tab-settings');
  const all = photos();
  const u = storageUsage();
  const members = Object.entries(S.index.members || {});
  const counts = {};
  all.forEach(p => { counts[p.by] = (counts[p.by] || 0) + 1; });
  const repoUrl = S.gh.webUrl;
  const sw = (key, label, sub) => `<div class="row"><div class="grow"><b>${label}</b>${sub ? `<small>${sub}</small>` : ''}</div><label class="switch"><input type="checkbox" data-pref="${key}"${prefs[key] ? ' checked' : ''}><span></span></label></div>`;
  t.innerHTML = `<div class="hero"><div><h1>공유·설정</h1><p>${esc(S.index.title || '')}</p></div></div>
    <h2 class="section-title">함께하는 사람</h2>
    <div class="panel">
      ${members.map(([login, m]) => `<div class="row"><img class="avatar" alt="" src="${avatar(login)}" loading="lazy" onerror="this.style.visibility='hidden'"><div class="grow"><b>@${esc(login)}${login === S.me?.login ? ' (나)' : ''}</b><small>사진 ${counts[login] || 0}장 · ${fmtDate(m.joinedAt)} 참여</small></div></div>`).join('')}
      <button class="row" style="width:100%" data-act="invite"><span class="grow" style="text-align:left;color:var(--primary)">+ 친구 초대하기</span></button>
    </div>
    <h2 class="section-title">이 앨범 저장소</h2>
    <div class="panel">
      <div class="row"><div class="grow"><b>${esc(S.space.owner)}/${esc(S.space.repo)}</b><small>${S.repoInfo?.private === false ? '⚠️ 공개 저장소 — 누구나 사진을 볼 수 있어요' : '비공개 저장소'} · 브랜치 ${esc(S.gh.branch)} · ${S.canWrite ? '쓰기 가능' : '읽기 전용'}</small></div>${repoUrl ? `<a class="text-btn" href="${repoUrl}" target="_blank" rel="noopener">GitHub</a>` : ''}</div>
      ${S.canWrite ? `<button class="row" style="width:100%" data-act="rename"><span class="grow" style="text-align:left"><b>앨범 이름</b><small>${esc(S.index.title || '')}</small></span><span class="text-btn">변경</span></button>` : ''}
    </div>
    <h2 class="section-title" id="storageTitle">저장 공간</h2>
    <div class="panel">
      <div class="storage">${ring(u.ratio, u.level)}<div style="min-width:0"><div class="big">남은 ${C.fmtBytes(u.remaining)}</div><div class="sub">${C.fmtBytes(u.used)} / 10GB 사용 · GitHub 권장 최대</div>
        <div class="legend"><span><i style="background:var(--primary)"></i>원본 ${C.fmtBytes(u.breakdown.original)}</span><span><i style="background:#ff9f0a"></i>라이브 ${C.fmtBytes(u.breakdown.live)}</span><span><i style="background:#30d158"></i>미리보기·썸네일 ${C.fmtBytes(u.breakdown.preview + u.breakdown.thumb)}</span></div></div></div>
      <div class="row"><div class="grow"><b>GitHub가 잰 저장소 크기</b><small>지운 사진의 이력까지 포함 · 업로드 후 늦게 갱신돼요</small></div><span class="val">${C.fmtBytes(u.repo)}</span></div>
    </div>
    <h2 class="section-title">GitHub 저장소 한도</h2>
    <div class="panel">${limitRows()}</div>
    <p class="note">GitHub Docs "Repository limits" 기준이에요. 권장치를 넘어도 바로 막히진 않지만 저장소가 느려질 수 있어요. 100MB 파일 제한만 강제예요. 모임별·연도별로 저장소를 나누면 여유 있게 쓸 수 있어요.</p>
    <h2 class="section-title">다른 앨범 저장소</h2>
    <div class="panel">
      ${S.spaces.map(s => `<div class="row"><button class="grow" data-space="${esc(s.id)}"><b>${esc(s.owner)}/${esc(s.repo)}</b><small>${s.id === S.space.id ? '<span class="tick">사용 중</span>' : '눌러서 전환'}</small></button><button class="text-btn danger" data-unlink="${esc(s.id)}">연결 해제</button></div>`).join('')}
      <button class="row" style="width:100%" data-act="addSpace"><span class="grow" style="text-align:left;color:var(--primary)">+ 저장소 추가</span></button>
    </div>
    <h2 class="section-title">옵션</h2>
    <div class="panel">
      ${sw('autoplayLive', '라이브 포토 자동 재생', '사진을 열면 한 번 움직여요. 길게 누르면 소리와 함께 재생')}
      ${sw('keepOriginal', '원본 파일도 저장', '끄면 2048px JPEG만 올려서 용량을 아껴요 (라이브 영상은 항상 저장)')}
      ${sw('geocode', '장소 이름 자동으로 찾기', 'GPS 좌표를 OpenStreetMap으로 보내 동네 이름을 받아와요')}
      <button class="row" style="width:100%" data-act="clearCache"><span class="grow" style="text-align:left"><b>이 기기의 사진 캐시 비우기</b><small>저장소의 사진은 그대로예요</small></span></button>
    </div>
    <p class="note">@${esc(S.me?.login || '')}로 연결됨 · 토큰은 이 브라우저에만 저장돼요. 공용 기기라면 사용 후 연결 해제하세요.</p>`;
  // draw the ring from empty once it's on screen
  requestAnimationFrame(() => requestAnimationFrame(() => $$('.ring .val', t).forEach(c => { c.style.strokeDashoffset = c.dataset.off; })));
}

function inviteSheet() {
  const base = location.origin + location.pathname;
  const link = `${base}#join=${encodeURIComponent(S.space.owner + '/' + S.space.repo)}${S.space.api ? '&api=' + encodeURIComponent(S.space.api) : ''}${S.me?.login ? '&by=' + encodeURIComponent(S.me.login) : ''}`;
  const repoUrl = S.gh.webUrl;
  const sh = openSheet(`<h2>친구 초대</h2>
    <ol class="steps" style="padding-left:20px">
      <li>${repoUrl ? `<a href="${repoUrl}/settings/access" target="_blank" rel="noopener">저장소 Settings → Collaborators</a>` : '저장소 설정의 Collaborators'}에서 친구의 GitHub 아이디를 추가하세요. (저장소 주인만 할 수 있어요)</li>
      <li>친구가 GitHub 초대 메일을 <b>수락</b>하면,</li>
      <li>아래 링크를 보내주세요. 친구는 링크를 열고 자기 토큰으로 연결하면 같은 앨범을 함께 써요.</li>
    </ol>
    <label class="field"><span>초대 링크</span><input readonly value="${esc(link)}" id="inviteLink"></label>
    <div class="actions"><button class="btn btn-quiet" id="copyLink">링크 복사</button>${navigator.share ? '<button class="btn btn-primary" id="shareLink">공유하기</button>' : ''}</div>
    <p class="note" style="margin:14px 0 0;padding:0">친구 토큰: 저장소가 <b>조직(Organization)</b>에 있으면 fine-grained 토큰(해당 저장소, Contents 읽기/쓰기)을, <b>개인 계정</b> 저장소면 classic 토큰(<code>repo</code>)이 필요할 수 있어요. 보기만 할 친구는 Read 권한으로 초대하세요.</p>`);
  $('#copyLink', sh).onclick = async () => {
    try { await navigator.clipboard.writeText(link); toast('링크를 복사했어요'); } catch { $('#inviteLink', sh).select(); document.execCommand('copy'); toast('링크를 복사했어요'); }
  };
  $('#shareLink', sh)?.addEventListener('click', () => navigator.share({ title: 'Moa 공유앨범 초대', text: `'${S.index.title}' 앨범에 초대할게요`, url: link }).catch(() => {}));
}

function spaceSheet() {
  const sh = openSheet(`<h2>앨범 저장소</h2><div>${S.spaces.map(s => `<button class="list-btn" data-space="${esc(s.id)}"><span class="grow">${esc(s.owner)}/${esc(s.repo)}<small>${s.id === S.space?.id ? '사용 중' : '전환'}</small></span>${s.id === S.space?.id ? '<span class="tick">✓</span>' : ''}</button>`).join('')}
    <button class="list-btn" data-act="addSpace"><span class="grow" style="color:var(--primary)">+ 저장소 추가</span></button></div>`);
  sh.onclick = e => {
    const b = e.target.closest('[data-space],[data-act]');
    if (!b) return;
    closeSheet();
    if (b.dataset.act) return showWelcome({ adding: true });
    const sp = S.spaces.find(s => s.id === b.dataset.space);
    if (sp && sp.id !== S.space?.id) openSpace(sp);
  };
}

// ---------------- selection ----------------

function setSelecting(on) {
  S.selecting = on;
  if (!on) S.selected.clear();
  $('#app').classList.toggle('selecting', on);
  $('#selectBtn').textContent = on ? '완료' : '선택';
  $('#selectBar').hidden = !on;
  $('#tabbar').hidden = on;
  $$('.tile.sel').forEach(t => { if (!S.selected.has(t.dataset.id)) t.classList.remove('sel'); });
  updateSelCount();
}
function updateSelCount() { $('#selCount').textContent = `${S.selected.size}개 선택`; }

function tagSheet(ids) {
  const existing = C.tagCounts(photos()).slice(0, 24);
  const sh = openSheet(`<h2>태그 달기 <small style="font-size:14px;color:var(--muted);font-weight:400">${ids.length}장</small></h2>
    <label class="field"><span>새 태그 (쉼표로 여러 개)</span><input id="tagIn" placeholder="예: 제주, 바다, 가족" enterkeyhint="done"></label>
    ${existing.length ? `<div class="tag-suggest">${existing.map(([t]) => `<button class="chip" data-t="${esc(t)}">#${esc(t)}</button>`).join('')}</div>` : ''}
    <div class="actions"><button class="btn btn-quiet" data-close>취소</button><button class="btn btn-primary" id="tagOk">추가</button></div>`);
  const inp = $('#tagIn', sh);
  setTimeout(() => inp.focus(), 50);
  sh.addEventListener('click', e => { const c = e.target.closest('[data-t]'); if (c) c.classList.toggle('on'); });
  const ok = () => {
    const tags = [...inp.value.split(/[,，]/), ...$$('.chip.on', sh).map(c => c.dataset.t)].map(C.normalizeTag).filter(Boolean);
    if (!tags.length) return inp.focus();
    for (const t of new Set(tags)) edit({ op: 'tag', ids, tag: t, on: true });
    closeSheet();
    toast(`${ids.length}장에 태그를 달았어요`);
    setSelecting(false);
  };
  $('#tagOk', sh).onclick = ok;
  inp.onkeydown = e => { if (e.key === 'Enter') ok(); };
}

function deletePhotos(ids, after) {
  if (!confirm(`${ids.length}장을 삭제할까요? 모든 멤버의 앨범에서 사라져요.`)) return false;
  edit({ op: 'deletePhotos', ids });
  after?.();
  return true;
}

// ============================================================
// viewer
// ============================================================

const V = { list: [], i: 0, p: null, token: 0, info: false, hold: null, holding: false, down: null, closing: false };
const stage = () => $('#vStage');
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)';
const EASE_DRAWER = 'cubic-bezier(0.32, 0.72, 0, 1)';

function tileRect(id) {
  const t = document.querySelector(`#content .tile[data-id="${CSS.escape(id)}"]`);
  if (!t) return null;
  const r = t.getBoundingClientRect();
  return r.width && r.bottom > 0 && r.top < innerHeight ? r : null;
}

/**
 * Keyframes that grow a square grid tile into the full photo (FLIP):
 * translate + scale the media layer onto the tile, and clip-path crop
 * it to the tile's square so the thumbnail and the photo read as one object.
 */
function zoomFrames(from, p) {
  const img = $('#vImg');
  const nw = p.w || img.naturalWidth, nh = p.h || img.naturalHeight;
  const box = $('#vMedia').getBoundingClientRect();
  if (!nw || !nh || !box.width) return null;
  const fit = Math.min(box.width / nw, box.height / nh);
  const cw = nw * fit, ch = nh * fit;
  const s = Math.max(from.width / cw, from.height / ch);
  const dx = from.left + from.width / 2 - (box.left + box.width / 2);
  const dy = from.top + from.height / 2 - (box.top + box.height / 2);
  const ix = Math.max(0, ((box.width - from.width / s) / 2 / box.width) * 100);
  const iy = Math.max(0, ((box.height - from.height / s) / 2 / box.height) * 100);
  const radius = innerWidth >= 820 ? 6 / s : 0;
  return [
    { transform: `translate(${dx}px, ${dy}px) scale(${s})`, clipPath: `inset(${iy}% ${ix}% ${iy}% ${ix}% round ${radius}px)` },
    { transform: 'translate(0px, 0px) scale(1)', clipPath: 'inset(0% 0% 0% 0% round 0px)' },
  ];
}

function fadeChrome(show, delay = 0) {
  for (const el of $$('#viewer .v-top, #viewer .v-bottom, #livePill')) {
    el.animate([{ opacity: show ? 0 : 1 }, { opacity: show ? 1 : 0 }], { duration: show ? 200 : 120, delay, easing: 'ease', fill: show ? 'none' : 'forwards' });
  }
}

function openViewer(id, list = S.list, fromEl = null) {
  V.list = list.map(p => p.id);
  V.i = V.list.indexOf(id);
  if (V.i < 0 || V.closing) return;
  const from = fromEl?.getBoundingClientRect() || null;
  $('#viewer').hidden = false;
  $('#viewer').classList.remove('bare', 'dragging');
  document.body.style.overflow = 'hidden';
  history.pushState({ moaViewer: true }, '');
  showCurrent();
  const p = V.p, media = $('#vMedia'), bd = $('#vBackdrop');
  const frames = from && p && !reduceMotion() && zoomFrames(from, p);
  if (frames) media.animate(frames, { duration: 380, easing: EASE_DRAWER });
  bd.animate([{ opacity: 0 }, { opacity: 1 }], { duration: frames ? 300 : 200, easing: 'ease' });
  fadeChrome(true, frames ? 120 : 0);
}

function closeViewer(fromPop = false) {
  const viewer = $('#viewer');
  if (viewer.hidden || V.closing) return;
  V.closing = true;
  stopLive();
  $('#vVideo').pause();
  const media = $('#vMedia'), bd = $('#vBackdrop');
  const p = V.p;
  const current = media.style.transform || 'translate(0px, 0px) scale(1)';
  const bdFrom = bd.style.opacity || '1';
  const to = p && !V.info && !reduceMotion() ? tileRect(p.id) : null;
  const frames = to && zoomFrames(to, p);
  let ms = 200;
  media.getAnimations().forEach(a => a.cancel());
  if (frames) {
    frames.reverse();
    frames[0].transform = current;
    media.animate(frames, { duration: ms = 280, easing: EASE_OUT, fill: 'forwards' });
  } else if (!reduceMotion()) {
    media.animate([{ transform: current, opacity: 1 }, { transform: `${current} scale(0.94)`, opacity: 0 }], { duration: ms, easing: EASE_OUT, fill: 'forwards' });
  } else media.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms, easing: 'ease', fill: 'forwards' });
  bd.animate([{ opacity: bdFrom }, { opacity: 0 }], { duration: ms, easing: 'ease', fill: 'forwards' });
  fadeChrome(false);
  if (V.info) { $('#vInfo').hidden = true; viewer.classList.remove('info-open'); V.info = false; V.miniMap?.remove(); V.miniMap = null; }
  setTimeout(() => {
    const vv = $('#vVideo'); vv.removeAttribute('src'); vv.load();
    viewer.hidden = true;
    viewer.classList.remove('dragging', 'bare');
    media.style.transform = ''; bd.style.opacity = '';
    for (const el of [media, bd, ...$$('#viewer .v-top, #viewer .v-bottom, #livePill')]) el.getAnimations().forEach(a => a.cancel());
    document.body.style.overflow = '';
    V.closing = false;
  }, ms);
  if (!fromPop && history.state?.moaViewer) history.back();
}
window.addEventListener('popstate', () => { if (!$('#viewer').hidden) closeViewer(true); });

function currentPhoto() { return S.index?.photos[V.list[V.i]] || null; }

function refreshViewer() {
  // the photo might have been deleted by a friend
  V.list = V.list.filter(id => S.index.photos[id]);
  if (!V.list.length) return closeViewer();
  V.i = Math.min(V.i, V.list.length - 1);
  const p = currentPhoto();
  if (p !== V.p) { if (V.p?.id === p.id) { V.p = p; viewerChrome(); if (V.info) renderInfo(); } else showCurrent(); }
}

function viewerChrome() {
  const p = V.p;
  const day = (p.takenAt || '').slice(0, 10);
  $('#vDate').textContent = /^\d{4}-\d{2}-\d{2}$/.test(day) ? C.fmtDay(day).replace(/ \S+요일$/, '') : '';
  $('#vSub').textContent = [C.fmtTime(p.takenAt), p.place?.name || p.place?.label].filter(Boolean).join(' · ');
  const liked = p.likes?.includes(S.me?.login);
  $('#vLike').classList.toggle('on', !!liked);
  $('#vLike span').textContent = p.likes?.length || '';
  $('#vCmt span').textContent = p.comments?.length || '';
  $('#vTags').innerHTML = (p.tags || []).map(t => `<button data-vtag="${esc(t)}">#${esc(t)}</button>`).join('');
  $('#livePill').hidden = !p.files?.live;
  $('[data-v=prev]').disabled = V.i <= 0;
  $('[data-v=next]').disabled = V.i >= V.list.length - 1;
}

async function showCurrent() {
  const p = V.p = currentPhoto();
  if (!p) return closeViewer();
  const token = ++V.token;
  stopLive();
  viewerChrome();
  if (V.info) renderInfo();
  const img = $('#vImg'), vid = $('#vVideo'), spin = $('#vSpin');
  vid.pause();
  spin.classList.add('on');
  if (p.kind === 'video') {
    img.hidden = true;
    vid.hidden = false;
    vid.removeAttribute('src');
    try {
      const poster = await mediaURL(p.files.preview || p.files.thumb, 'image/jpeg').catch(() => '');
      if (token !== V.token) return;
      vid.poster = poster;
      const u = await mediaURL(p.files.original, playableType(p.mime));
      if (token !== V.token) return;
      vid.src = u;
    } catch (e) { toast('동영상을 불러오지 못했어요'); }
    spin.classList.remove('on');
  } else {
    vid.hidden = true;
    img.hidden = false;
    const ready = resolved.get(S.space.id + ':' + p.files.thumb);
    if (ready) { img.src = ready; img.style.filter = 'blur(6px)'; } else img.removeAttribute('src');
    try {
      const tu = await mediaURL(p.files.thumb, 'image/jpeg');
      if (token !== V.token) return;
      img.src = tu;
      img.style.filter = 'blur(6px)';
      const pu = await mediaURL(p.files.preview || p.files.original, 'image/jpeg');
      if (token !== V.token) return;
      img.src = pu;
      await img.decode().catch(() => {});
      if (token !== V.token) return;
      img.style.filter = '';
    } catch { toast('사진을 불러오지 못했어요'); }
    spin.classList.remove('on');
    if (p.files.live) {
      const lu = mediaURL(p.files.live, playableType(p.liveMime || 'video/quicktime'));
      if (prefs.autoplayLive) lu.then(() => { if (token === V.token && !V.holding) playLive(false); }).catch(() => {});
    }
  }
  // warm the neighbours
  for (const d of [1, -1]) {
    const n = S.index.photos[V.list[V.i + d]];
    if (n) mediaURL(n.files.preview || n.files.thumb, 'image/jpeg').catch(() => {});
  }
}

/** Next/previous. From a swipe it slides; keys and buttons switch instantly (never animate keyboard actions). */
function go(d, fromDx = null) {
  const j = V.i + d;
  const media = $('#vMedia');
  if (j < 0 || j >= V.list.length) return;
  if (fromDx == null || reduceMotion()) { V.i = j; showCurrent(); return; }
  const w = stage().offsetWidth;
  media.animate([{ transform: `translateX(${fromDx}px)` }, { transform: `translateX(${-d * w}px)` }], { duration: 160, easing: EASE_OUT, fill: 'forwards' })
    .finished.then(() => {
      V.i = j;
      showCurrent();
      media.getAnimations().forEach(a => a.cancel());
      media.animate([{ transform: `translateX(${d * w * 0.25}px)`, opacity: 0 }, { transform: 'translateX(0px)', opacity: 1 }], { duration: 240, easing: EASE_OUT });
    });
}

async function playLive(sound) {
  const p = V.p;
  if (!p?.files?.live) return;
  const token = V.token;
  let u;
  try { u = await mediaURL(p.files.live, playableType(p.liveMime || 'video/quicktime')); } catch { return toast('라이브 영상을 불러오지 못했어요'); }
  if (token !== V.token) return;
  const v = $('#vLive');
  if (v.dataset.src !== u) { v.src = u; v.dataset.src = u; }
  v.muted = !sound;
  try { v.currentTime = 0; } catch { /* not loaded yet */ }
  try {
    await v.play();
    if (token === V.token) stage().classList.add('live-on');
  } catch (e) {
    if (sound && e.name !== 'AbortError') toast('이 브라우저는 라이브 영상(HEVC)을 재생하지 못할 수 있어요');
  }
}

function stopLive() {
  const v = $('#vLive');
  v.pause();
  stage().classList.remove('live-on');
}

function bindViewer() {
  const st = stage(), media = $('#vMedia');
  $('#vLive').addEventListener('ended', () => stage().classList.remove('live-on'));
  const pill = $('#livePill');
  pill.addEventListener('click', e => { e.stopPropagation(); playLive(true); });
  pill.addEventListener('pointerenter', e => { if (e.pointerType === 'mouse') playLive(false); });

  st.addEventListener('pointerdown', e => {
    if (V.down || V.closing || e.button > 0 || e.target.closest('button') || e.target.id === 'vVideo') return;
    V.down = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId, axis: null, dx: 0, dy: 0 };
    st.setPointerCapture?.(e.pointerId);
    if (V.p?.files?.live) V.hold = setTimeout(() => { V.holding = true; playLive(true); }, 230);
  });
  st.addEventListener('pointermove', e => {
    const d = V.down;
    if (!d || e.pointerId !== d.id || V.holding) return;
    let dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (!d.axis) {
      if (Math.hypot(dx, dy) < 10) return;
      d.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      clearTimeout(V.hold);
      if (d.axis === 'y' && (dy < 0 || V.info)) { d.axis = 'none'; return; }
      if (d.axis === 'y') $('#viewer').classList.add('dragging');
    }
    if (d.axis === 'x') {
      const edge = (dx > 0 && V.i === 0) || (dx < 0 && V.i === V.list.length - 1);
      if (edge) dx = Math.sign(dx) * Math.sqrt(Math.abs(dx)) * 4; // rubber-band past the ends
      media.style.transform = `translateX(${dx}px)`;
    } else if (d.axis === 'y') {
      dy = Math.max(0, dy);
      const k = Math.min(1, dy / innerHeight);
      media.style.transform = `translate(${dx * 0.6}px, ${dy}px) scale(${1 - k * 0.35})`;
      $('#vBackdrop').style.opacity = String(Math.max(0, 1 - k * 1.6));
    }
    d.dx = dx; d.dy = dy;
  });
  const settle = () => {
    const from = media.style.transform;
    media.style.transform = '';
    if (from) media.animate([{ transform: from }, { transform: 'translate(0px, 0px) scale(1)' }], { duration: 320, easing: EASE_DRAWER });
    const bd = $('#vBackdrop');
    if (bd.style.opacity) { bd.animate([{ opacity: bd.style.opacity }, { opacity: 1 }], { duration: 240, easing: 'ease' }); bd.style.opacity = ''; }
    $('#viewer').classList.remove('dragging');
  };
  const end = e => {
    const d = V.down;
    if (!d || e.pointerId !== d.id) return;
    V.down = null;
    clearTimeout(V.hold);
    const dt = Math.max(1, performance.now() - d.t);
    if (V.holding) { V.holding = false; stopLive(); return; }
    if (d.axis === 'x') {
      const v = Math.abs(d.dx) / dt, dir = d.dx < 0 ? 1 : -1;
      const hasNext = V.i + dir >= 0 && V.i + dir < V.list.length;
      if (hasNext && (Math.abs(d.dx) > stage().offsetWidth * 0.25 || (Math.abs(d.dx) > 20 && v > 0.11))) {
        const dx = d.dx; media.style.transform = ''; go(dir, dx);
      } else settle();
    } else if (d.axis === 'y') {
      const v = d.dy / dt;
      if (d.dy > 110 || (d.dy > 20 && v > 0.11)) closeViewer(); // a flick is enough
      else settle();
    } else if (!d.axis && performance.now() - d.t < 230) $('#viewer').classList.toggle('bare');
  };
  st.addEventListener('pointerup', end);
  st.addEventListener('pointercancel', end);
  st.addEventListener('contextmenu', e => { if (V.p?.files?.live) e.preventDefault(); });

  $('#viewer').addEventListener('click', e => {
    const b = e.target.closest('[data-v],[data-vtag]');
    if (!b) return;
    if (b.dataset.vtag) {
      closeViewer();
      S.filter = { kind: '', tag: b.dataset.vtag, q: '' };
      showTab('photos');
      return;
    }
    const p = V.p;
    switch (b.dataset.v) {
      case 'close': return closeViewer();
      case 'prev': return go(-1);
      case 'next': return go(1);
      case 'info': return toggleInfo();
      case 'comments': toggleInfo(true); setTimeout(() => $('#iCmt')?.focus(), 80); return;
      case 'like': {
        const on = !p.likes?.includes(S.me.login);
        edit({ op: 'like', id: p.id, user: S.me.login, on });
        viewerChrome();
        if (on && !reduceMotion()) $('#vLike svg').animate([{ transform: 'scale(1)' }, { transform: 'scale(1.28)' }, { transform: 'scale(1)' }], { duration: 360, easing: EASE_OUT });
        return;
      }
      case 'download': return download(p);
    }
  });

  document.addEventListener('keydown', e => {
    if ($('#viewer').hidden || /INPUT|TEXTAREA/.test(document.activeElement?.tagName)) {
      if (e.key === 'Escape' && sheetOpen()) closeSheet();
      return;
    }
    if (e.key === 'ArrowRight') go(1);
    else if (e.key === 'ArrowLeft') go(-1);
    else if (e.key === 'Escape') V.info ? toggleInfo(false) : closeViewer();
    else if (e.key === 'i') toggleInfo();
    else if (e.key === ' ' && V.p?.files?.live) { e.preventDefault(); playLive(true); }
  });
}

function toggleInfo(force) {
  V.info = force ?? !V.info;
  $('#vInfo').hidden = !V.info;
  $('#viewer').classList.toggle('info-open', V.info);
  if (V.info) renderInfo(); else { V.miniMap?.remove(); V.miniMap = null; }
}

async function download(p) {
  const path = p.files.original || p.files.preview;
  toast('받는 중…');
  try {
    const blob = await S.gh.media(path, { cache: !!p.files.preview && path === p.files.preview });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = p.files.original ? (p.name || path.split('/').pop()) : C.baseOf(p.name || p.id) + '.jpg';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  } catch (e) { toast('다운로드 실패: ' + errMsg(e)); }
}

function renderInfo() {
  const p = V.p;
  if (!p) return;
  const box = $('#vInfo');
  const scroll = box.scrollTop;
  const albums = Object.entries(S.index.albums);
  const allTags = C.tagCounts(photos()).map(([t]) => t).filter(t => !(p.tags || []).includes(t)).slice(0, 10);
  const day = (p.takenAt || '').slice(0, 10);
  const srcLabel = { exif: '사진 정보(EXIF) 기준', video: '동영상 정보 기준', file: '파일 수정 시각 기준 (촬영 정보 없음)', manual: '직접 수정함' }[p.dateSource] || '';
  const cam = [p.camera?.model || p.camera?.make, p.camera?.lens && p.camera.lens.replace(p.camera.model || '', '').trim()].filter(Boolean).join(' · ');
  const sizes = [p.w && p.h ? `${p.w} × ${p.h}` : '', p.size ? C.fmtBytes(p.size) : '', p.duration ? fmtDur(p.duration) : '', p.name].filter(Boolean).join(' · ');
  const w = S.canWrite;
  box.innerHTML = `<div class="grab"></div>
    ${w ? `<textarea id="iCap" rows="1" placeholder="설명 추가…" maxlength="500">${esc(p.caption || '')}</textarea>` : p.caption ? `<div class="kv">${esc(p.caption)}</div>` : ''}
    <h4>태그</h4>
    <div class="tagrow">${(p.tags || []).map(t => `<span class="chip">#${esc(t)}${w ? `<button data-i="untag" data-t="${esc(t)}" aria-label="태그 삭제">✕</button>` : ''}</span>`).join('') || '<span class="kv"><small>아직 태그가 없어요</small></span>'}</div>
    ${w ? `<input type="text" id="iTag" placeholder="태그 추가 후 Enter" enterkeyhint="done" autocomplete="off">
    ${allTags.length ? `<div class="tag-suggest">${allTags.map(t => `<button class="chip" data-i="tag" data-t="${esc(t)}">+ ${esc(t)}</button>`).join('')}</div>` : ''}` : ''}
    <h4>날짜와 시간 ${w ? '<button data-i="editDate">수정</button>' : ''}</h4>
    <div class="kv" id="iDate">${/^\d{4}-\d{2}-\d{2}$/.test(day) ? C.fmtDay(day) : '날짜 없음'} ${C.fmtTime(p.takenAt)}<small>${p.tz ? 'UTC' + p.tz + ' · ' : ''}${srcLabel}</small></div>
    <h4>장소 ${w ? '<button data-i="editPlace">수정</button>' : ''}</h4>
    <div id="iPlace">${p.gps ? `<div class="kv">${esc(p.place?.name || p.place?.label || '장소 이름을 찾는 중…')}<small>${esc([p.place?.name && p.place?.label, p.place?.country].filter(Boolean).join(', ') || `${p.gps.lat.toFixed(4)}, ${p.gps.lng.toFixed(4)}`)}</small></div><div class="mini-map" id="iMap"></div><button class="text-btn" data-i="onMap" style="padding-left:0;margin-top:4px">보관함 지도에서 보기</button>` : '<div class="kv"><small>위치 정보가 없어요</small></div>'}</div>
    <h4>앨범</h4>
    <div>${albums.map(([id, a]) => `<label class="alb"><input type="checkbox" data-i="alb" data-a="${esc(id)}"${(p.albums || []).includes(id) ? ' checked' : ''}${w ? '' : ' disabled'}>${esc(a.name)}</label>`).join('')}${w ? '<button class="text-btn" data-i="newAlbum" style="padding-left:0">+ 새 앨범</button>' : ''}</div>
    ${p.likes?.length ? `<h4>좋아요 ${p.likes.length}</h4><div class="kv">${p.likes.map(l => '@' + esc(l)).join(', ')}</div>` : ''}
    <h4>댓글 ${p.comments?.length || ''}</h4>
    <div>${(p.comments || []).map(c => `<div class="cmt"><b>@${esc(c.by)}</b><small>${fmtDate(c.at)}</small>${c.by === S.me?.login ? `<button class="del" data-i="uncomment" data-c="${esc(c.id)}">삭제</button>` : ''}<div>${esc(c.text)}</div></div>`).join('')}</div>
    ${w ? '<input type="text" id="iCmt" placeholder="댓글 달기…" enterkeyhint="send" maxlength="500" style="margin-top:8px">' : ''}
    <h4>정보</h4>
    ${cam ? `<div class="kv">${esc(cam)}</div>` : ''}
    <div class="kv"><small>${esc(sizes)}</small></div>
    <div class="kv" style="margin-top:6px">@${esc(p.by || '')} 님이 올림<small>${fmtDate(p.uploadedAt)}${p.files.live ? ' · 라이브 포토' : ''}${p.files.original ? '' : ' · 원본 없이 JPEG만 저장됨'}</small></div>
    <div class="danger-zone">
      <button class="btn btn-quiet btn-sm" data-i="download">${p.files.original ? '원본 받기' : 'JPEG 받기'}</button>
      ${p.files.live ? '<button class="btn btn-quiet btn-sm" data-i="downloadLive">라이브 영상</button>' : ''}
      ${w && S.album ? '<button class="btn btn-quiet btn-sm" data-i="cover">앨범 커버로</button>' : ''}
      ${w ? '<button class="btn btn-danger btn-sm" data-i="delete">삭제</button>' : ''}
    </div>`;
  box.scrollTop = scroll;

  V.miniMap?.remove(); V.miniMap = null;
  if (p.gps && window.L && $('#iMap')) {
    const m = V.miniMap = L.map('iMap', { zoomControl: false, attributionControl: false, dragging: false, scrollWheelZoom: false, doubleClickZoom: false, touchZoom: false, keyboard: false, boxZoom: false }).setView([p.gps.lat, p.gps.lng], 14);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(m);
    L.circleMarker([p.gps.lat, p.gps.lng], { radius: 7, color: '#fff', weight: 2.5, fillColor: '#2997ff', fillOpacity: 1 }).addTo(m);
  }

  const cap = $('#iCap', box);
  if (cap) {
    cap.onchange = () => { const v = cap.value.trim(); if (v !== (p.caption || '')) edit({ op: 'updatePhoto', id: p.id, set: { caption: v } }); };
  }
  const tagIn = $('#iTag', box);
  if (tagIn) tagIn.onkeydown = e => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    tagIn.value.split(/[,，]/).map(C.normalizeTag).filter(Boolean).forEach(t => edit({ op: 'tag', ids: [p.id], tag: t, on: true }));
    tagIn.value = '';
    setTimeout(() => $('#iTag')?.focus(), 90);
  };
  const cmt = $('#iCmt', box);
  if (cmt) cmt.onkeydown = e => {
    if (e.key !== 'Enter' || e.isComposing || !cmt.value.trim()) return;
    edit({ op: 'comment', id: p.id, comment: { id: C.newId(), by: S.me.login, at: new Date().toISOString(), text: cmt.value.trim() } });
    cmt.value = '';
  };
  box.onclick = e => {
    const b = e.target.closest('[data-i]');
    if (!b || b.tagName === 'INPUT' && b.type !== 'checkbox') return;
    switch (b.dataset.i) {
      case 'untag': return edit({ op: 'tag', ids: [p.id], tag: b.dataset.t, on: false });
      case 'tag': return edit({ op: 'tag', ids: [p.id], tag: b.dataset.t, on: true });
      case 'alb': return edit({ op: 'albumMembership', ids: [p.id], album: b.dataset.a, on: b.checked });
      case 'newAlbum': return newAlbum(id => edit({ op: 'albumMembership', ids: [p.id], album: id, on: true }));
      case 'uncomment': return edit({ op: 'uncomment', id: p.id, commentId: b.dataset.c });
      case 'editDate': return editDate(p);
      case 'editPlace': return editPlace(p);
      case 'onMap': closeViewer(); S.view = 'map'; S.mapFocus = [p.gps.lat, p.gps.lng]; S.album = null; S.filter = { kind: '', tag: '', q: '' }; showTab('photos'); return;
      case 'download': return download(p);
      case 'downloadLive': return download({ ...p, name: C.baseOf(p.name || p.id) + '.' + C.extOf(p.files.live), files: { original: p.files.live } });
      case 'cover': edit({ op: 'setCover', album: S.album, photo: p.id }); return toast('앨범 커버로 정했어요');
      case 'delete': {
        const id = p.id;
        deletePhotos([id], () => { if (V.list.length <= 1) closeViewer(); });
      }
    }
  };
}

function editDate(p) {
  const el = $('#iDate');
  el.innerHTML = `<input type="datetime-local" step="1" id="iDateIn" value="${esc((p.takenAt || '').slice(0, 19))}"><div style="display:flex;gap:8px;margin-top:8px"><button class="btn btn-quiet btn-sm" id="iDateCancel">취소</button><button class="btn btn-primary btn-sm" id="iDateOk">저장</button></div>`;
  $('#iDateCancel').onclick = () => renderInfo();
  $('#iDateOk').onclick = () => {
    let v = $('#iDateIn').value;
    if (!v) return;
    if (v.length === 16) v += ':00';
    const tz = p.tz || C.localTz(new Date(v));
    edit({ op: 'updatePhoto', id: p.id, set: { takenAt: v, tz, ts: C.tsOf(v, tz), dateSource: 'manual' } });
  };
}

function editPlace(p) {
  const el = $('#iPlace');
  V.miniMap?.remove(); V.miniMap = null;
  el.innerHTML = `<input type="search" id="iPlaceIn" placeholder="장소 검색 (예: 성산일출봉)" enterkeyhint="search"><div id="iPlaceRes" style="margin-top:6px"></div>
    <div style="display:flex;gap:8px;margin-top:8px"><button class="btn btn-quiet btn-sm" id="iPlaceCancel">취소</button>${p.gps ? '<button class="btn btn-danger btn-sm" id="iPlaceClear">위치 지우기</button>' : ''}</div>`;
  const inp = $('#iPlaceIn');
  inp.focus();
  $('#iPlaceCancel').onclick = () => renderInfo();
  $('#iPlaceClear')?.addEventListener('click', () => edit({ op: 'updatePhoto', id: p.id, set: { gps: null, place: null } }));
  let results = [];
  inp.onkeydown = async e => {
    if (e.key !== 'Enter' || e.isComposing) return;
    const res = $('#iPlaceRes');
    res.innerHTML = '<div class="kv"><small>찾는 중…</small></div>';
    try { results = await searchPlaces(inp.value); } catch { results = []; }
    res.innerHTML = results.map((r, i) => `<button class="result" data-r="${i}">${esc(r.place?.name || r.place?.label || r.display)}<small>${esc(r.display)}</small></button>`).join('') || '<div class="kv"><small>결과가 없어요</small></div>';
  };
  $('#iPlaceRes').onclick = e => {
    const b = e.target.closest('[data-r]');
    if (!b) return;
    const r = results[+b.dataset.r];
    edit({ op: 'updatePhoto', id: p.id, set: { gps: r.gps, place: r.place } });
  };
}

// ============================================================
// upload
// ============================================================

const U = { running: false, entries: [], done: 0, failed: 0, total: 0 };

async function handleFiles(fileList) {
  if (!S.index) return toast('먼저 앨범을 만들어주세요');
  if (!S.canWrite) return toast('이 저장소는 읽기 전용이에요');
  if (U.running) return toast('업로드가 끝난 뒤에 더 올릴 수 있어요');
  const files = [...fileList].filter(f => !/\.(aae|xmp|json)$/i.test(f.name));
  if (!files.length) return;
  const sh = openSheet(`<h2>사진 확인 중</h2><p class="up-summary" id="anaText">0 / ${files.length}</p><div class="progress"><i id="anaBar"></i></div>`, { kind: 'upload' });
  const items = [];
  for (let i = 0; i < files.length; i++) {
    items.push(await analyzeFile(files[i], 'f' + i));
    if ($('#anaBar', sh)) { $('#anaBar', sh).style.width = `${((i + 1) / files.length) * 100}%`; $('#anaText', sh).textContent = `${i + 1} / ${files.length}`; }
  }
  const entries = buildEntries(items);
  const hashes = new Set(photos().map(p => p.hash).filter(Boolean));
  const seen = new Set();
  for (const e of entries) {
    e.dup = !!e.main.hash && (hashes.has(e.main.hash) || seen.has(e.main.hash));
    if (e.main.hash) seen.add(e.main.hash);
    e.skip = !!e.main.error || e.dup;
    e.main.tooBig = !!e.main.tooBig;
    e.status = e.skip ? (e.main.error || '이미 있음') : '';
  }
  U.entries = entries;
  showUploadSheet(true);
}

function showUploadSheet(review) {
  const E = U.entries;
  const go = E.filter(e => !e.skip);
  const n = k => go.filter(k).length;
  const summary = [
    `사진 ${n(e => e.main.kind === 'photo')}`,
    n(e => e.live) ? `라이브 ${n(e => e.live)}` : '',
    n(e => e.main.kind === 'video') ? `동영상 ${n(e => e.main.kind === 'video')}` : '',
    `위치 있음 ${n(e => e.main.meta.gps)}`,
    E.filter(e => e.dup).length ? `중복 ${E.filter(e => e.dup).length}개 건너뜀` : '',
    E.filter(e => e.main.error).length ? `불가 ${E.filter(e => e.main.error).length}` : '',
  ].filter(Boolean).join(' · ');
  const albums = Object.entries(S.index.albums);
  const thumbs = E.slice(0, 200).map(e => {
    const m = e.main;
    e.url ||= m.kind === 'photo' ? URL.createObjectURL(m.file) : '';
    return `<div class="up-item${e.skip ? ' skip' : ''}" id="up-${m.key}">${e.url ? `<img alt="" src="${e.url}" loading="lazy" onerror="this.remove()">` : ''}
      <div class="flags">${Math.max(m.size, e.live?.size || 0) >= LIM.LIMITS.apiUpload ? '<b class="big">대용량</b>' : ''}${e.live ? '<b class="live">LIVE</b>' : ''}${m.kind === 'video' ? '<b>▶</b>' : ''}${m.meta.gps ? '<b class="gps">위치</b>' : ''}</div>
      <span class="nm">${esc(m.name)}</span>${e.status ? `<span class="st${e.status === '완료' ? ' done' : e.failed ? ' fail' : ''}">${esc(e.status)}</span>` : ''}</div>`;
  }).join('');
  const noMeta = go.filter(e => e.main.kind === 'photo' && e.main.meta.dateSource === 'file').length;
  const sh = openSheet(`<h2>${review ? `${go.length}개 올리기` : '업로드 중'} ${review ? '' : `<small style="font-size:14px;color:var(--muted);font-weight:400" id="upCount">${U.done}/${U.total}</small>`}</h2>
    <p class="up-summary">${summary}</p>
    ${review ? `<div id="upPlan">${uploadPlanHTML(E, prefs.keepOriginal).html}</div>` : ''}
    ${!review ? `<div class="progress"><i id="upBar" style="width:${U.total ? (U.done + U.failed) / U.total * 100 : 0}%"></i></div><p class="note" style="margin:6px 0 14px;padding:0">창을 닫아도 계속 올라가요. 앱을 닫지는 마세요.</p>` : ''}
    <div class="up-list">${thumbs}</div>${E.length > 200 ? `<p class="note" style="margin:0 0 12px;padding:0">외 ${E.length - 200}개</p>` : ''}
    ${review ? `
      ${noMeta ? `<p class="note" style="margin:0 0 12px;padding:0">⚠️ ${noMeta}장은 촬영 정보(EXIF)가 없어 파일 시각으로 정렬돼요.</p>` : ''}
      <label class="field"><span>앨범</span><select id="upAlbum"><option value="">보관함에만</option>${albums.map(([id, a]) => `<option value="${esc(id)}"${id === S.album ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>
      <label class="field"><span>태그 (선택, 쉼표로 여러 개)</span><input id="upTags" placeholder="예: 제주, 가족여행"></label>
      <div class="row" style="padding:4px 4px 12px;border:0"><div class="grow"><b style="font-size:15px">원본 파일도 저장</b><small>끄면 2048px JPEG만 저장해요</small></div><label class="switch"><input type="checkbox" id="upOrig"${prefs.keepOriginal ? ' checked' : ''}><span></span></label></div>
      <details class="guide" style="margin:0 0 4px"><summary>아이폰 라이브 포토·위치를 온전히 올리려면</summary>
        <ol class="steps">
          <li>사진 앱에서 사진을 고른 뒤 <b>공유</b> → 위쪽 <b>옵션</b> → <b>모든 사진 데이터</b>를 켜고(위치도 켜기) → <b>파일에 저장</b>.</li>
          <li>Moa에서 업로드 → <b>파일 선택/찾아보기</b> → 저장한 폴더에서 <code>HEIC</code>와 <code>MOV</code>를 함께 선택.</li>
          <li>이름이 같은 사진+영상(예: IMG_1234.HEIC + IMG_1234.MOV)이나 같은 라이브 포토 ID를 가진 파일은 자동으로 라이브 포토로 묶여요.</li>
        </ol>
        <p class="note" style="margin:0 0 12px">사진 보관함에서 바로 고르면 iOS가 정지 사진만 넘겨줘서 라이브가 빠지고, 설정에 따라 위치도 빠질 수 있어요. 위치는 나중에 사진 정보에서 직접 넣을 수도 있어요.</p>
      </details>
      <div class="actions"><button class="btn btn-quiet" data-close>취소</button><button class="btn btn-primary" id="upGo"${go.length ? '' : ' disabled'}>업로드</button></div>` : ''}`,
  { kind: 'upload', onClose: () => { if (!U.running) cleanupUpload(); else updatePill(); } });
  $('#upPill').hidden = true;
  if (review) {
    const gate = () => {
      const { plan } = uploadPlanHTML(E, $('#upOrig', sh).checked);
      $('#upGo', sh).disabled = !go.length || (plan.level === 'over' && !$('#upAck', sh)?.checked);
    };
    $('#upOrig', sh).onchange = () => { $('#upPlan', sh).innerHTML = uploadPlanHTML(E, $('#upOrig', sh).checked).html; gate(); };
    $('#upPlan', sh).onchange = gate;
    gate();
  }
  if (review) $('#upGo', sh).onclick = () => startUpload({
    album: $('#upAlbum', sh).value || null,
    tags: $('#upTags', sh).value.split(/[,，]/).map(C.normalizeTag).filter(Boolean),
    keepOriginal: $('#upOrig', sh).checked,
  });
}

function cleanupUpload() {
  U.entries.forEach(e => e.url && URL.revokeObjectURL(e.url));
  U.entries = [];
}

function setEntryStatus(e, status, failed = false) {
  e.status = status;
  e.failed = failed;
  const el = document.getElementById('up-' + e.main.key);
  if (el) {
    el.querySelector('.st')?.remove();
    el.insertAdjacentHTML('beforeend', `<span class="st${status === '완료' ? ' done' : failed ? ' fail' : ''}">${esc(status)}</span>`);
  }
  const bar = $('#upBar'); if (bar) bar.style.width = `${(U.done + U.failed) / U.total * 100}%`;
  const cnt = $('#upCount'); if (cnt) cnt.textContent = `${U.done}/${U.total}`;
  updatePill();
}

function updatePill() {
  const pill = $('#upPill');
  const sheetOpen = $('#sheet').dataset.kind === 'upload';
  pill.hidden = !U.running || sheetOpen;
  pill.textContent = `업로드 중 ${U.done}/${U.total}`;
}

async function startUpload(opts) {
  const list = U.entries.filter(e => !e.skip);
  Object.assign(U, { running: true, done: 0, failed: 0, total: list.length });
  const sp = S.space;
  let wake = null;
  try { wake = await navigator.wakeLock?.request('screen'); } catch { /* not supported */ }
  showUploadSheet(false);
  const batch = { files: [], photos: [], entries: [], bytes: 0 };
  const commitBatch = async () => {
    if (!batch.photos.length) return;
    const files = batch.files.splice(0), ps = batch.photos.splice(0), es = batch.entries.splice(0);
    batch.bytes = 0;
    es.forEach(e => setEntryStatus(e, '저장 중'));
    try {
      await serial(async () => {
        const r = await S.gh.commit({ files, ops: [{ op: 'addPhotos', photos: ps }], message: `Moa: 사진 ${ps.length}장 추가 — @${S.me.login}`, base: S.base, title: S.index?.title });
        if (S.space === sp) adopt(r);
      });
      U.done += es.length;
      es.forEach(e => setEntryStatus(e, '완료'));
    } catch (err) {
      console.error(err);
      U.failed += es.length;
      es.forEach(e => setEntryStatus(e, '실패', true));
      toast('저장 실패: ' + errMsg(err), 4000);
    }
  };
  for (const e of list) {
    if (S.space !== sp) break;
    setEntryStatus(e, '처리 중');
    try {
      const { photo, files, bytes } = await preparePhoto(e, opts);
      batch.files.push(...files);
      batch.photos.push(photo);
      batch.entries.push(e);
      batch.bytes += bytes;
      setEntryStatus(e, '대기');
      if (batch.photos.length >= 10 || batch.bytes > 50 * LIM.MB) await commitBatch();
    } catch (err) {
      console.error(e.main.name, err);
      U.failed++;
      setEntryStatus(e, '실패', true);
    }
  }
  await commitBatch();
  U.running = false;
  wake?.release?.().catch(() => {});
  updatePill();
  toast(U.failed ? `${U.done}개 올림 · ${U.failed}개 실패` : `${U.done}개 모두 올렸어요`, 3500);
  if ($('#sheet').dataset.kind === 'upload' && !U.failed) setTimeout(() => { if (!U.running && $('#sheet').dataset.kind === 'upload') closeSheet(); }, 1200);
  else if ($('#sheet').dataset.kind !== 'upload') cleanupUpload();
  S.gh.info().then(i => { if (S.space === sp) { S.repoInfo = i; rerender(); } }).catch(() => {});
  runGeocodeJob();
}

function placeholderThumb() {
  const c = document.createElement('canvas');
  c.width = 400; c.height = 400;
  const g = c.getContext('2d');
  g.fillStyle = '#2c2c2e'; g.fillRect(0, 0, 400, 400);
  g.fillStyle = '#8e8e93';
  g.beginPath(); g.moveTo(165, 135); g.lineTo(165, 265); g.lineTo(270, 200); g.closePath(); g.fill();
  return new Promise(r => c.toBlob(r, 'image/jpeg', 0.8));
}

const clean = o => { for (const k of Object.keys(o)) { const v = o[k]; if (v == null || v === '' || (Array.isArray(v) && !v.length)) delete o[k]; } return o; };

async function preparePhoto(e, opts) {
  const m = e.main, meta = m.meta;
  const id = C.newId();
  const ym = C.mediaDir(meta.takenAt);
  let r = null;
  try { r = await makeRenditions(m); } catch (err) { if (m.kind === 'photo') throw err; }
  const ext = C.extOf(m.name) || (m.kind === 'video' ? 'mp4' : 'jpg');
  const files = {}, up = [], sizes = {};
  if (m.kind === 'video' || opts.keepOriginal) { files.original = `media/${ym}/${id}.${ext}`; up.push([files.original, m.file, 'original']); }
  if (r) { files.preview = `preview/${ym}/${id}.jpg`; up.push([files.preview, r.preview, 'preview']); }
  files.thumb = `thumb/${ym}/${id}.jpg`;
  up.push([files.thumb, r?.thumb || await placeholderThumb(), 'thumb']);
  if (e.live) { files.live = `media/${ym}/${id}.live.${C.extOf(e.live.name) || 'mov'}`; up.push([files.live, e.live.file, 'live']); }

  const blobs = [];
  let bytes = 0;
  for (const [path, blob, k] of up) {
    setEntryStatus(e, `올리는 중 ${blobs.length + 1}/${up.length}`);
    const sha = await S.gh.blob(await blobToBase64(blob));
    blobs.push({ path, sha });
    sizes[k] = blob.size;
    bytes += blob.size;
    if (k === 'thumb' || k === 'preview') S.gh.primeCache(path, blob);
  }
  const lq = e.live?.meta || {};
  const photo = clean({
    id, kind: m.kind, name: m.name, mime: m.mime, size: m.size, hash: m.hash,
    takenAt: meta.takenAt, tz: meta.tz, ts: meta.ts, dateSource: meta.dateSource,
    gps: meta.gps || lq.gps, camera: meta.camera || lq.camera, contentId: meta.contentId,
    w: r?.w, h: r?.h, duration: meta.duration || (m.kind === 'video' && r?.duration ? Math.round(r.duration * 100) / 100 : undefined),
    files, liveMime: e.live?.mime, sizes,
    tags: opts.tags, albums: opts.album ? [opts.album] : [],
    by: S.me.login, uploadedAt: new Date().toISOString(),
  });
  return { photo, files: blobs, bytes };
}

// ---------------- place names in the background ----------------

const geoTried = new Set();
let geoRunning = false;
async function runGeocodeJob() {
  if (!prefs.geocode || geoRunning || !S.canWrite || !S.index) return;
  geoRunning = true;
  const sp = S.space;
  try {
    const now = Date.now();
    const todo = photos().filter(p => p.gps && !p.place && !geoTried.has(p.id) && (p.by === S.me?.login || now - Date.parse(p.uploadedAt) > 10 * 60e3));
    for (const p of todo) {
      if (S.space !== sp || !prefs.geocode) break;
      geoTried.add(p.id);
      const place = await reverseGeocode(p.gps.lat, p.gps.lng).catch(() => null);
      if (S.space !== sp) break;
      const cur = S.index?.photos[p.id];
      if (place && cur && !cur.place) edit({ op: 'updatePhoto', id: p.id, set: { place } });
    }
  } finally { geoRunning = false; }
}

// ============================================================
// global event wiring
// ============================================================

function bind() {
  $('#uploadBtn').onclick = () => $('#fileInput').click();
  $('#uploadFab').onclick = () => $('#fileInput').click();
  bindSheetDrag();
  // scroll-edge hairline under the translucent bar, only once content slides beneath it
  const onScroll = () => $('.bar').classList.toggle('scrolled', window.scrollY > 4);
  window.addEventListener('scroll', onScroll, { passive: true });
  $('#fileInput').onchange = e => { handleFiles(e.target.files); e.target.value = ''; };
  $('#spaceBtn').onclick = spaceSheet;
  $('#selectBtn').onclick = () => setSelecting(!S.selecting);
  $('#searchBtn').onclick = () => {
    const row = $('#searchRow');
    row.hidden = !row.hidden;
    if (!row.hidden) $('#searchInput').focus();
    else if (S.filter.q) { S.filter.q = ''; $('#searchInput').value = ''; render(); }
  };
  let qTimer;
  $('#searchInput').oninput = e => { clearTimeout(qTimer); qTimer = setTimeout(() => { S.filter.q = e.target.value; renderPhotos(); }, 200); };
  $('#upPill').onclick = () => showUploadSheet(false);

  $('#tabbar').onclick = e => {
    const b = e.target.closest('[data-tab]');
    if (!b || !S.index) return;
    if (b.dataset.tab === 'photos' && S.tab === 'photos' && S.album) S.album = null;
    showTab(b.dataset.tab);
  };
  $('#viewSeg').onclick = e => {
    const b = e.target.closest('[data-view]');
    if (!b) return;
    S.view = b.dataset.view;
    if (S.view === 'map') setSelecting(false);
    render();
  };
  $('#controls').onchange = e => { const k = e.target.dataset.ctl; if (k) { S[k] = e.target.value; renderPhotos(); } };
  $('#chips').onclick = e => {
    const b = e.target.closest('[data-chip]');
    if (!b) return;
    const f = S.filter, t = b.dataset.chip, v = b.dataset.v;
    if (t === 'all') { f.kind = ''; f.tag = ''; }
    else if (t === 'kind') f.kind = f.kind === v ? '' : v;
    else f.tag = f.tag === v ? '' : v;
    renderPhotos();
  };

  // one delegated handler for the three tabs
  $('#main').addEventListener('click', e => {
    const tile = e.target.closest('.tile');
    if (tile && tile.closest('#content')) {
      const id = tile.dataset.id;
      if (S.selecting) {
        S.selected.has(id) ? S.selected.delete(id) : S.selected.add(id);
        $$(`.tile[data-id="${CSS.escape(id)}"]`).forEach(t => t.classList.toggle('sel', S.selected.has(id)));
        updateSelCount();
      } else openViewer(id, S.list, tile);
      return;
    }
    const b = e.target.closest('[data-act],[data-album],[data-smart],[data-space],[data-unlink]');
    if (!b) return;
    if (b.dataset.album) { S.album = b.dataset.album; S.filter = { kind: '', tag: '', q: '' }; showTab('photos'); return; }
    if (b.dataset.smart) {
      const k = b.dataset.smart;
      S.album = null;
      S.filter = { kind: ['live', 'video', 'fav'].includes(k) ? k : '', tag: '', q: '' };
      S.view = k === 'place' ? 'place' : k === 'tag' ? 'tag' : 'date';
      showTab('photos');
      return;
    }
    if (b.dataset.space) { const sp = S.spaces.find(s => s.id === b.dataset.space); if (sp && sp !== S.space) openSpace(sp); return; }
    if (b.dataset.unlink) {
      const sp = S.spaces.find(s => s.id === b.dataset.unlink);
      if (!sp || !confirm(`${sp.owner}/${sp.repo} 연결을 이 기기에서 해제할까요? (저장소와 사진은 그대로예요)`)) return;
      S.spaces = S.spaces.filter(s => s !== sp);
      saveSpaces();
      localStorage.removeItem(LS.pending(sp.id));
      if (sp === S.space) { S.space = null; S.gh = null; S.index = null; S.spaces[0] ? openSpace(S.spaces[0]) : showWelcome(); }
      else render();
      return;
    }
    switch (b.dataset.act) {
      case 'upload': return $('#fileInput').click();
      case 'clearFilter': S.filter = { kind: '', tag: '', q: '' }; $('#searchInput').value = ''; return renderPhotos();
      case 'backAlbums': S.album = null; return showTab('albums');
      case 'albumMenu': return albumMenu();
      case 'newAlbum': return newAlbum(id => { S.album = id; showTab('photos'); });
      case 'expand': { const k = b.dataset.key; S.expanded.has(k) ? S.expanded.delete(k) : S.expanded.add(k); return renderPhotos(); }
      case 'mapAt': S.view = 'map'; S.mapFocus = [+b.dataset.lat, +b.dataset.lng]; return render();
      case 'invite': return inviteSheet();
      case 'storage': showTab('settings'); requestAnimationFrame(() => $('#storageTitle')?.scrollIntoView({ block: 'start' })); return;
      case 'addSpace': return showWelcome({ adding: true });
      case 'rename': {
        const t = prompt('앨범 이름', S.index.title || '');
        if (t && t.trim()) edit({ op: 'setTitle', title: t.trim() });
        return;
      }
      case 'clearCache':
        clearMediaCache().then(() => { urls.clear(); resolved.clear(); toast('캐시를 비웠어요'); });
        return;
    }
  });
  $('#main').addEventListener('change', e => {
    const k = e.target.dataset.pref;
    if (!k) return;
    prefs[k] = e.target.checked;
    save(LS.prefs, prefs);
    if (k === 'geocode' && prefs.geocode) runGeocodeJob();
  });

  $('#selectBar').onclick = e => {
    const b = e.target.closest('[data-sel]');
    if (!b) return;
    const ids = [...S.selected];
    if (!ids.length) return toast('사진을 먼저 선택하세요');
    if (b.dataset.sel === 'tag') tagSheet(ids);
    else if (b.dataset.sel === 'album') pickAlbum(ids);
    else deletePhotos(ids, () => setSelecting(false));
  };

  $('#scrim').addEventListener('click', e => { if (e.target.id === 'scrim' || e.target.closest('[data-close]')) closeSheet(); });

  // desktop drag & drop
  let dragDepth = 0;
  window.addEventListener('dragenter', e => { if (e.dataTransfer?.types?.includes('Files')) { dragDepth++; $('#main').classList.add('drop-hint'); } });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#main').classList.remove('drop-hint'); } });
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => {
    e.preventDefault();
    dragDepth = 0;
    $('#main').classList.remove('drop-hint');
    if (e.dataTransfer?.files?.length && S.index) handleFiles(e.dataTransfer.files);
  });

  bindViewer();
}

function registerSW() {
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

bind();
boot();

// test hook (used by test/e2e.mjs)
window.__moa = { S, flush, refresh: () => serial(() => refresh()) };
