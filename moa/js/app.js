/* ============================================================
   Moa — app UI
   Tabs: Library (date · place · map · tag views) · Albums · Settings
   All UI strings go through t() (js/i18n.js); English by default.
   Every edit is an op (see core.js) applied optimistically, kept in
   a persisted pending queue, and flushed to GitHub as one commit.
   ============================================================ */

import * as C from './core.js';
import { Repo, Account, clearMediaCache, textToBase64, ENCRYPTED_DESCRIPTION } from './github.js';
import { createAlbumKey, unlockAlbumKey, rewrapAlbumKey, setPassphrase, newRecoveryCode, withRecovery, hasRecovery, unlockWithRecovery, keyToText, keyFromText, BadPassphrase, rememberKey, recallKey, forgetKey, forgetAllKeys, passkeyAvailable, addPasskey, removePasskey, passkeySlots, unlockWithPasskey, NoPasskey } from './crypto.js';
import { analyzeFile, buildEntries, makeRenditions } from './media.js';
import { reverseGeocode, searchPlaces } from './geo.js';
import * as LIM from './limits.js';
import * as Q from './queue.js';
import { ZipWriter } from './zip.js';
import * as AI from './ai.js';
import { AI_VERSION, labelName, toEnglishQuery } from './ai-labels.js';
import { t, setLang, lang, locale, fmtDay, fmtMonth, fmtTime } from './i18n.js';

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
  spark: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.5c.5 4.6 2.4 6.5 7 7-4.6.5-6.5 2.4-7 7-.5-4.6-2.4-6.5-7-7 4.6-.5 6.5-2.4 7-7zM19 15c.25 2 1 2.75 3 3-2 .25-2.75 1-3 3-.25-2-1-2.75-3-3 2-.25 2.75-1 3-3z"/></svg>',
  faceid: '<svg class="faceid" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M4 8V6.5A2.5 2.5 0 0 1 6.5 4H8M16 4h1.5A2.5 2.5 0 0 1 20 6.5V8M20 16v1.5a2.5 2.5 0 0 1-2.5 2.5H16M8 20H6.5A2.5 2.5 0 0 1 4 17.5V16M9 9.5v1.5M15 9.5v1.5M12 9.5v3.5h-1M9.5 16a4 4 0 0 0 5 0"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/></svg>',
};

// ---------------- persistence ----------------

const LS = { spaces: 'moa.spaces', current: 'moa.current', prefs: 'moa.prefs', auth: 'moa.auth', pending: id => 'moa.pending.' + id, convert: id => 'moa.convert.' + id, invite: 'moa.invite', passkey: id => 'moa.passkey.' + id };
function load(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } }
function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* quota / private mode */ } }

const prefs = Object.assign({ autoplayLive: true, keepOriginal: true, geocode: true, notify: true, ai: false, lang: 'en' }, load(LS.prefs, {}));
setLang(prefs.lang);

const S = {
  spaces: load(LS.spaces, []),
  auth: load(LS.auth, null), loginAvailable: false, authApi: 'https://api.github.com', initTitle: null,
  space: null, gh: null, me: null, canWrite: true, repoInfo: null,
  index: null, head: null, base: null, pending: [],
  tab: 'photos', album: null,
  view: 'date', order: 'desc', placeLevel: 'city', placeOrder: 'recent', mapFocus: null,
  filter: { kind: '', tag: '', q: '' },
  selecting: false, selected: new Set(), expanded: new Set(),
  list: [],
  keys: new Map(), // space id → album CryptoKey, for this session
  initPass: null,
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
  $('.bar .logo')?.classList.toggle('working', state === 'saving' || state === 'purging');
  const el = $('#sync');
  el.hidden = !state;
  el.classList.toggle('err', state === 'error');
  el.classList.toggle('info', state === 'throttle');
  el.textContent = state ? t(`sync.${state}`, { s: arg }) : '';
}

// ---------------- system notifications: a long job finished while Moa was in the background ----------------
const canNotify = () => typeof Notification !== 'undefined';
/** Ask once, from the tap that starts a long job (browsers only allow it from a gesture). */
function askNotify() {
  if (prefs.notify && canNotify() && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
}
async function notify(title, body) {
  if (!prefs.notify || !canNotify() || Notification.permission !== 'granted' || !document.hidden) return;
  const opts = { body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: 'moa-done' };
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) return await reg.showNotification(title, opts);
  } catch { /* fall back to a page notification */ }
  try { new Notification(title, opts); } catch { /* not allowed here (e.g. iOS outside the Home Screen app) */ }
}

// header ring: fills with the progress of a long job (uploads, encryption on/off)
let ringTimer = null;
function ringProgress(p) {
  const el = $('.bar .logo');
  clearTimeout(ringTimer);
  if (p == null) {
    el.classList.remove('busy');
    ringTimer = setTimeout(() => el.style.removeProperty('--p'), 250); // after the fade
    return;
  }
  el.style.setProperty('--p', String(Math.max(0.03, Math.min(1, p))));
  el.classList.add('busy');
}
/** Finish the ring to 100%, let it be seen full for a beat, then fade it. */
function ringDone() {
  ringProgress(1);
  ringTimer = setTimeout(() => ringProgress(null), 450);
}

// "new since my last visit": when each album was last open on this device
const SEEN = 'moa.seen';
function markSeen(id) { const m = load(SEEN, {}); m[id] = Date.now(); save(SEEN, m); }
/** Ids of albums someone pushed to after I last had them open (30s allowance for clock drift). */
function freshAlbums(repos) {
  const m = load(SEEN, {});
  const fresh = new Set();
  for (const r of repos) {
    const id = r.full_name.toLowerCase(), pushed = Date.parse(r.pushed_at || 0) || 0;
    if (!(id in m)) m[id] = pushed; // first sighting is the baseline, not "new"
    else if (pushed > m[id] + 30000) fresh.add(id);
  }
  save(SEEN, m);
  return fresh;
}

const fmtDur = s => { const t = Math.max(0, Math.floor(s || 0)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
const fmtDate = iso => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString(locale(), { year: 'numeric', month: 'long', day: 'numeric' }); };
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

function parseHash() {
  const h = new URLSearchParams(location.hash.replace(/^#/, ''));
  const out = { auth: h.get('auth'), scope: h.get('scope'), authError: h.get('auth_error'), join: null, invite: null };
  const inv = parseInviteCode(h.get('invite') || '');
  if (inv) out.invite = { id: inv, k: h.get('k') || null };
  const j = h.get('join');
  if (j) {
    const [owner, repo] = j.split('/');
    if (owner && repo) out.join = { owner, repo, api: h.get('api'), by: h.get('by') };
  }
  return out;
}

/** Invite code = the invite's gist id; accepts the code (any grouping) or a whole invite link. */
function parseInviteCode(s) {
  let v = String(s || '').trim();
  const m = /[#&]invite=([^&\s]+)/.exec(v);
  if (m) v = m[1];
  v = v.replace(/[\s-]/g, '').toLowerCase();
  return /^[0-9a-f]{20,40}$/.test(v) ? v : null;
}
const fmtCode = id => id.match(/.{1,4}/g).join('-');

function parseRepo(s) {
  const t = String(s || '').trim().replace(/\.git$/, '').replace(/^https?:\/\/[^/]+\//, '');
  const [owner, repo] = t.split('/').filter(Boolean);
  return owner && repo ? { owner, repo } : null;
}

const sameRepo = (a, b) => a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase();
const tokenFor = sp => sp.token || S.auth?.token || '';
const loginApi = () => (S.authApi && S.authApi !== 'https://api.github.com' ? S.authApi : null);
const account = () => new Account(S.auth.token, S.authApi);
const isEncryptedRepo = r => r.description === ENCRYPTED_DESCRIPTION;
const knownTitle = r => S.spaces.find(x => !x.token && sameRepo(x, { owner: r.owner.login, repo: r.name }))?.title;
const albumTitle = r => (isEncryptedRepo(r) ? knownTitle(r) || r.name : r.description?.replace(/ (—|·) Moa( 공유앨범| shared album)?$/, '') || r.name);

/** Is "Sign in with GitHub" available? Only when the /api functions are deployed and configured. */
async function loadAuthConfig() {
  try {
    const r = await fetch('api/auth/config', { cache: 'no-store' });
    const j = r.ok ? await r.json() : null;
    S.loginAvailable = !!j?.login;
    S.authApi = j?.api || 'https://api.github.com';
  } catch { S.loginAvailable = false; }
}

function spaceFromRepo(r) {
  const sp = { id: r.full_name.toLowerCase(), owner: r.owner.login, repo: r.name, branch: r.default_branch || null, api: loginApi(), title: albumTitle(r) };
  const known = S.spaces.find(x => sameRepo(x, sp) && !x.token);
  // an encrypted album's title is only known once it's opened
  if (known) return Object.assign(known, { branch: sp.branch || known.branch, title: isEncryptedRepo(r) ? known.title || sp.title : sp.title });
  S.spaces.push(sp);
  saveSpaces();
  return sp;
}

async function boot() {
  registerSW();
  const h = parseHash();
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  await loadAuthConfig();
  if (h.auth) {
    S.auth = { token: h.auth, scope: h.scope || '' };
    save(LS.auth, S.auth);
  }
  if (h.invite) save(LS.invite, { ...h.invite, at: Date.now() }); // survives the sign-in round trip
  let join = h.join;
  try { join ||= JSON.parse(sessionStorage.getItem('moa.join') || 'null'); sessionStorage.removeItem('moa.join'); } catch { /* private mode */ }
  if (h.authError) toast(h.authError === 'access_denied' ? t('auth.cancelled') : t('auth.failed', { e: h.authError }), 4000);

  if (S.auth) {
    try {
      const me = await account().user();
      Object.assign(S.auth, { login: me.login, avatar: me.avatar_url, name: me.name || '' });
      save(LS.auth, S.auth);
    } catch (e) {
      if (e.status === 401) { signedOut(t('auth.expired')); return; }
    }
  }
  if (load(LS.invite, null)) {
    if (S.auth) { processInvites(); return showHome(); }
    return showWelcome({ invite: true });
  }
  if (S.auth) processInvites();
  if (join) {
    const known = S.spaces.find(sp => sameRepo(sp, join) && tokenFor(sp));
    if (known) return openSpace(known);
    if (S.auth) return showHome({ join });
    return showWelcome({ join });
  }
  const sp = S.spaces.find(x => x.id === load(LS.current, null) && tokenFor(x)) || S.spaces.find(x => tokenFor(x));
  if (sp) return openSpace(sp);
  if (S.auth) return showHome();
  showWelcome();
}

// an invite link opened in a tab where Moa is already running only changes the #fragment
window.addEventListener('hashchange', () => {
  const h = parseHash();
  if (!h.invite) return;
  history.replaceState(null, '', location.pathname + location.search);
  save(LS.invite, { ...h.invite, at: Date.now() });
  if (!$('#viewer').hidden) closeViewer(true);
  closeSheet();
  if (S.auth) showHome(); else showWelcome({ invite: true });
});

function signedOut(msg) {
  S.auth = null;
  localStorage.removeItem(LS.auth);
  if (msg) toast(msg, 4000);
  showWelcome();
}

async function logout() {
  if (!confirm(t('auth.logoutConfirm'))) return;
  const token = S.auth?.token;
  fetch('api/auth/revoke', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) }).catch(() => {});
  for (const sp of S.spaces.filter(x => !x.token)) localStorage.removeItem(LS.pending(sp.id));
  S.spaces = S.spaces.filter(x => x.token);
  saveSpaces();
  S.space = null; S.gh = null; S.index = null;
  S.keys.clear();
  localStorage.removeItem(LS.invite);
  Q.clearAll();
  AI.wipe().catch(() => {});
  await Promise.all([clearMediaCache().catch(() => {}), forgetAllKeys()]);
  urls.clear(); resolved.clear();
  signedOut(t('auth.signedOut'));
}

// the first Moa logo (a photo grid with a Live Photo ring) lives on as the "nothing here yet" picture
const EMPTY_ART = '<img class="empty-art" src="icons/tiles.svg" alt="" width="88" height="88">';

const MOSAIC = ['#ff9f0a', '#ff375f', '#bf5af2', '#0a84ff', '#30d158', '#ffd60a', '#64d2ff', '#ff6961', '#5e5ce6', '#ffb340', '#34c759', '#ff2d55', '#af52de', '#007aff', '#ffcc00', '#5ac8fa'];
const GITHUB_MARK = '<svg viewBox="0 0 16 16" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>';

function showWelcome({ join, adding, invite } = {}) {
  $('#shell').hidden = true;
  const w = $('#welcome');
  w.hidden = false;
  window.scrollTo(0, 0);
  const login = S.loginAvailable && !S.auth;
  w.innerHTML = `<div class="card">
    <div class="mosaic" aria-hidden="true">${MOSAIC.map((c, i) => `<i style="background:${c};animation-delay:${i * 35}ms"></i>`).join('')}</div>
    <h1>Moa</h1>
    <p class="lead">${t('welcome.lead')}</p>
    ${join ? `<div class="invite-banner">${t('welcome.invited', { by: join.by ? '@' + esc(join.by) : '', repo: `<b>${esc(join.owner)}/${esc(join.repo)}</b>` })}</div>` : ''}
    ${invite ? `<div class="invite-banner">${t('join.signin')}</div>` : ''}
    ${login ? `<button class="btn btn-github btn-block" id="loginBtn">${GITHUB_MARK}${t('welcome.signin')}</button>` : ''}
    <details class="guide" id="tokenBox"${login ? '' : ' open'}><summary>${t(login ? 'welcome.tokenAdvanced' : 'welcome.connect')}</summary>
    <form id="connectForm" autocomplete="off" style="padding:4px 16px 16px">
      <label class="field"><span>${t('welcome.repo')}</span><input name="repo" placeholder="owner/repo" value="${join ? esc(join.owner + '/' + join.repo) : ''}" required autocapitalize="off" spellcheck="false"></label>
      <label class="field"><span>${t('welcome.token')}</span><input name="token" type="password" placeholder="github_pat_…" required autocapitalize="off" spellcheck="false"></label>
      <details class="field"><summary style="cursor:pointer;color:var(--muted);font-size:13px;margin:0 4px 8px">${t('welcome.advanced')}</summary>
        <label class="field"><span>${t('welcome.branch')}</span><input name="branch" placeholder="main"></label>
        <label class="field"><span>${t('welcome.api')}</span><input name="api" placeholder="https://api.github.com" value="${join?.api ? esc(join.api) : ''}"></label>
      </details>
      <button class="btn ${login ? 'btn-quiet' : 'btn-primary'} btn-block" type="submit">${t('welcome.connectBtn')}</button>
      <p class="err" id="connectErr" hidden></p>
    </form>
    </details>
    ${adding || S.space ? `<button class="btn btn-quiet btn-block" id="welcomeCancel" style="margin-top:12px" type="button">${t('common.cancel')}</button>` : ''}
  </div>`;
  $('#loginBtn')?.addEventListener('click', () => {
    try { if (join) sessionStorage.setItem('moa.join', JSON.stringify(join)); } catch { /* private mode */ }
    location.href = 'api/auth/login';
  });
  const form = $('#connectForm');
  if (join && !login) setTimeout(() => form.token.focus(), 50);
  $('#welcomeCancel')?.addEventListener('click', () => { w.hidden = true; if (S.space) { $('#shell').hidden = false; } else boot(); });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const err = $('#connectErr');
    err.hidden = true;
    const r = parseRepo(form.repo.value);
    if (!r) { err.textContent = t('welcome.repoFormat'); err.hidden = false; return; }
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = t('common.checking');
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
      btn.disabled = false; btn.textContent = t('welcome.connectBtn');
    }
  });
}

// ---------------- signed-in home: my albums, invitations, new album ----------------

async function showHome({ join } = {}) {
  $('#shell').hidden = true;
  const w = $('#welcome');
  w.hidden = false;
  window.scrollTo(0, 0);
  const a = S.auth;
  w.innerHTML = `<div class="card home">
    <div class="me"><img class="avatar" alt="" src="${esc(a.avatar || avatar(a.login || 'ghost'))}"><div class="grow"><b>${esc(a.name || '@' + (a.login || ''))}</b><small>@${esc(a.login || '')}</small></div><button class="text-btn" id="logoutBtn">${t('auth.signOut')}</button></div>
    <h1>${t('home.title')}</h1>
    <div id="homeJoin"></div>
    <div id="homeInvites"></div>
    <div class="panel home-list" id="homeAlbums"><div class="row"><div class="grow"><small>${t('sync.loading')}</small></div></div></div>
    <button class="btn btn-primary btn-block" id="newRepoBtn">${t('home.new')}</button>
    <button class="btn btn-quiet btn-block" id="codeBtn" style="margin-top:10px">${t('join.enterCode')}</button>
    ${S.space ? `<button class="btn btn-quiet btn-block" id="homeBack" style="margin-top:12px">${t('common.back')}</button>` : ''}
  </div>`;
  $('#logoutBtn').onclick = logout;
  $('#newRepoBtn').onclick = newAlbumRepo;
  $('#codeBtn').onclick = codeSheet;
  renderJoinCard();
  $('#homeBack')?.addEventListener('click', () => { w.hidden = true; $('#shell').hidden = false; });
  let albums = [], invites = [];
  try {
    [albums, invites] = await Promise.all([account().albums(), account().invitations().catch(() => [])]);
  } catch (e) {
    if (e.status === 401) return signedOut(t('auth.expired'));
    $('#homeAlbums').innerHTML = `<div class="row"><div class="grow"><b>${t('home.loadFailed')}</b><small>${esc(errMsg(e))}</small></div></div>`;
    return;
  }
  if ($('#welcome').hidden || !$('#homeAlbums')) return;
  if (load(LS.invite, null)) joinTick();
  const tokenSpaces = S.spaces.filter(x => x.token && !albums.some(r => sameRepo(x, { owner: r.owner.login, repo: r.name })));
  const inviteFor = j => invites.find(i => sameRepo({ owner: i.repository.owner.login, repo: i.repository.name }, j));
  if (join) {
    const has = albums.find(r => sameRepo({ owner: r.owner.login, repo: r.name }, join));
    if (has) return openSpace(spaceFromRepo(has));
    if (!inviteFor(join)) $('#homeJoin').innerHTML = `<div class="invite-banner">${t('home.noInviteYet', { repo: `<b>${esc(join.owner)}/${esc(join.repo)}</b>`, me: `<b>@${esc(a.login)}</b>` })}</div>`;
  }
  $('#homeInvites').innerHTML = invites.length ? `<h2 class="section-title" style="margin:0 0 10px">${t('home.invites')}</h2><div class="panel">${invites.map(i => `<div class="row"><img class="avatar" alt="" src="${esc(i.inviter?.avatar_url || avatar(i.inviter?.login || 'ghost'))}"><div class="grow"><b>${esc(albumTitle(i.repository))}</b><small>@${esc(i.inviter?.login || '')} · ${esc(i.repository.full_name)}</small></div><button class="btn btn-primary btn-sm" data-accept="${i.id}">${t('home.accept')}</button></div>`).join('')}</div>` : '';
  const fresh = freshAlbums(albums);
  let nth = 0;
  const rows = [
    ...albums.map(r => {
      const isNew = fresh.has(r.full_name.toLowerCase());
      return `<button class="row row-btn" data-repo="${esc(r.full_name)}"><span class="album-dot${isEncryptedRepo(r) ? ' locked' : ''}${isNew ? ' fresh' : ''}" style="background:${MOSAIC[[...r.name].reduce((h, c) => h + c.charCodeAt(0), 0) % MOSAIC.length]}${isNew ? `;--i:${nth++}` : ''}">${isEncryptedRepo(r) ? ICON.lock : ''}</span><span class="grow"><b>${esc(albumTitle(r))}</b><small>${esc(r.full_name)}${isEncryptedRepo(r) ? ` · ${t('enc.on')}` : ''}${r.private ? '' : ` · ⚠️ ${t('home.public')}`}</small></span>${isNew ? `<span class="fresh-tag">${t('home.fresh')}</span>` : ''}<span class="val">›</span></button>`;
    }),
    ...tokenSpaces.map(x => `<button class="row row-btn" data-space="${esc(x.id)}"><span class="album-dot" style="background:var(--muted)"></span><span class="grow"><b>${esc(x.owner)}/${esc(x.repo)}</b><small>${t('home.viaToken')}</small></span><span class="val">›</span></button>`),
  ];
  $('#homeAlbums').innerHTML = rows.join('') || `<div class="row"><div class="grow"><b>${t('home.empty')}</b></div></div>`;
  homeCovers(albums);
  w.onclick = async e => {
    const acc = e.target.closest('[data-accept]');
    const repo = e.target.closest('[data-repo]');
    const tsp = e.target.closest('[data-space]');
    if (acc) {
      acc.disabled = true; acc.textContent = t('home.accepting');
      const inv = invites.find(i => String(i.id) === acc.dataset.accept);
      try {
        await account().accept(inv.id);
        toast(t('home.joined', { name: albumTitle(inv.repository) }));
        openSpace(spaceFromRepo(inv.repository));
      } catch (ex) { acc.disabled = false; acc.textContent = t('home.accept'); toast(errMsg(ex), 4000); }
    } else if (repo) {
      openSpace(spaceFromRepo(albums.find(r => r.full_name === repo.dataset.repo)));
    } else if (tsp) {
      openSpace(S.spaces.find(x => x.id === tsp.dataset.space));
    }
  };
}

function repoSlug(title) {
  const ascii = title.normalize('NFKD').replace(/[^\w\s-]/g, '').trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const d = new Date();
  return 'moa-' + (ascii.length >= 3 ? ascii.slice(0, 40) : `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`);
}

/** An encrypted album's repository name must not give its title away. */
const opaqueSlug = () => 'moa-' + C.newId().split('-')[1];

// "Encrypt" switch + passphrase fields, shared by the two album-creation forms
function encFieldsHTML() {
  return `<div class="row opt-row"><div class="grow"><b>${ICON.lock}${t('enc.encrypt')}</b></div><label class="switch"><input type="checkbox" id="encOn"><span></span></label></div>
    <div id="encBox" hidden>
      <label class="field"><span>${t('enc.pass')}</span><input id="encPass" type="password" autocomplete="new-password"></label>
      <label class="field"><span>${t('enc.pass2')}</span><input id="encPass2" type="password" autocomplete="new-password"><small>${t('enc.lost')}</small></label>
    </div>`;
}
function bindEncFields(root, onToggle) {
  const on = $('#encOn', root);
  on.onchange = () => { $('#encBox', root).hidden = !on.checked; onToggle?.(on.checked); if (on.checked) $('#encPass', root).focus(); };
}
function readEncFields(root) {
  if (!$('#encOn', root)?.checked) return { pass: null };
  const a = $('#encPass', root).value, b = $('#encPass2', root).value;
  if (a.length < 8) return { error: t('enc.short') };
  if (a !== b) return { error: t('enc.mismatch') };
  return { pass: a };
}

function newAlbumRepo() {
  const sh = openSheet(`<h2>${t('newAlbum.title')}</h2>
    <label class="field"><span>${t('newAlbum.name')}</span><input id="nrTitle" placeholder="${t('newAlbum.namePh')}" maxlength="60"></label>
    <label class="field"><span>${t('newAlbum.repo')}</span><input id="nrName" autocapitalize="off" spellcheck="false" maxlength="100"></label>
    ${encFieldsHTML()}
    <p class="err" id="nrErr" hidden></p>
    <div class="actions"><button class="btn btn-quiet" data-close>${t('common.cancel')}</button><button class="btn btn-primary" id="nrOk">${t('common.create')}</button></div>`);
  const titleIn = $('#nrTitle', sh), n = $('#nrName', sh);
  let touched = false, sealed = false;
  const slug = () => (sealed ? opaqueSlug() : repoSlug(titleIn.value));
  n.value = repoSlug('');
  titleIn.oninput = () => { if (!touched && !sealed) n.value = slug(); };
  n.oninput = () => { touched = true; };
  bindEncFields(sh, on => { sealed = on; if (!touched) n.value = slug(); });
  setTimeout(() => titleIn.focus(), 50);
  $('#nrOk', sh).onclick = async () => {
    const title = titleIn.value.trim() || t('newAlbum.default');
    const name = n.value.trim();
    const err = $('#nrErr', sh);
    const enc = readEncFields(sh);
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) { err.textContent = t('newAlbum.badName'); err.hidden = false; return; }
    if (enc.error) { err.textContent = enc.error; err.hidden = false; return; }
    const btn = $('#nrOk', sh);
    btn.disabled = true; btn.textContent = t('common.creating');
    try {
      const r = await account().createAlbumRepo(name, title, { encrypted: !!enc.pass });
      closeSheet();
      openSpace(spaceFromRepo(r), { initTitle: title, initPass: enc.pass });
    } catch (e) {
      err.textContent = e.status === 422 ? t('newAlbum.taken') : errMsg(e);
      err.hidden = false;
      btn.disabled = false; btn.textContent = t('common.create');
    }
  };
}

async function openSpace(sp, { initTitle, initPass } = {}) {
  if (!tokenFor(sp)) return S.loginAvailable ? showWelcome() : showWelcome({ join: sp });
  S.space = sp;
  save(LS.current, sp.id);
  S.gh = new Repo({ ...sp, token: tokenFor(sp) });
  S.initTitle = initTitle || null;
  S.initPass = initPass || null;
  S.gh.onWait = s => toast(t('rate.wait', { s }), 5000);
  // GitHub recommends ≤ 6 pushes/minute per repository; the client paces itself
  S.gh.onThrottle = s => setSync('throttle', s);
  S.pending = load(LS.pending(sp.id), []);
  Object.assign(S, { index: null, head: null, base: null, album: null, me: null, tab: 'photos' });
  S.filter = { kind: '', tag: '', q: '' };
  S.semantic = null;
  AIS.emb = null;
  S.selected.clear();
  setSelecting(false);
  $('#welcome').hidden = true;
  $('#shell').hidden = false;
  $('#spaceName').textContent = sp.title || sp.repo;
  $('#content').innerHTML = `<div class="empty"><p>${t('sync.loading')}</p></div>`;
  $('#hero').innerHTML = '';
  showTab('photos', false);
  setSync('loading');
  try {
    const [me, info, key] = await Promise.all([S.gh.user(), S.gh.info(), S.keys.get(sp.id) || recallKey(sp.id)]);
    if (S.space !== sp) return;
    if (key) { S.gh.key = key; S.keys.set(sp.id, key); }
    S.me = me;
    S.repoInfo = info;
    S.canWrite = info.permissions ? !!info.permissions.push : true;
    if (sp.branch !== S.gh.branch) { sp.branch = S.gh.branch; saveSpaces(); }
    await refresh(true);
    setSync(S.pending.length ? 'pending' : null);
    if (S.pending.length) scheduleFlush(500);
    resumeUploads();
    if (prefs.ai) aiStart();
  } catch (e) {
    if (S.space !== sp) return;
    setSync('error');
    if (e.status === 401 && !sp.token) return signedOut(t('auth.expired'));
    if (e.status === 0 && await loadOfflineIndex()) { toast(t('offline')); return; }
    $('#content').innerHTML = `<div class="empty"><h2>${t('open.failed')}</h2><p>${esc(errMsg(e))}</p><button class="btn btn-primary" id="retryBtn">${t('common.retry')}</button> <button class="btn btn-quiet" id="reconnectBtn">${t(sp.token ? 'open.reenterToken' : 'home.title')}</button></div>`;
    $('#retryBtn').onclick = () => openSpace(sp);
    $('#reconnectBtn').onclick = () => (sp.token ? showWelcome({ join: { owner: sp.owner, repo: sp.repo, api: sp.api }, adding: true }) : showHome());
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
  let st;
  try { st = await S.gh.state(head); } catch (e) {
    if (!e.locked || S.space !== sp) throw e;
    if (e.stale) { S.keys.delete(sp.id); S.gh.key = null; forgetKey(sp.id); }
    return renderLocked(e.header);
  }
  if (S.space !== sp) return;
  if (!st.index) { S.head = head; S.index = null; return renderInit(false); }
  const ix = st.index;
  const before = S.index ? Object.keys(S.index.photos).length : null;
  const headMoved = S.head !== head;
  adopt(st);
  const after = Object.keys(S.index.photos).length;
  if (!first && before != null && after > before) toast(t('refresh.new', { n: after - before }));
  // an encrypted album's index stays off the device; others keep an offline copy
  if (!S.gh.sealed) S.gh.primeCache('.moa/index-cache.json', new Blob([JSON.stringify({ head, index: ix })], { type: 'application/json' }));
  // someone erased the history: drop cached copies of anything no longer in the album
  if (st.root && headMoved) S.gh.pruneCache(keepSet(st)).catch(() => {});
  if (first && S.canWrite && S.me?.login && !S.index.members[S.me.login]) edit({ op: 'join', user: S.me.login, at: new Date().toISOString() });
  runGeocodeJob();
  scheduleAi();
}

/** Take a fetched/committed album state { head, index, files } as the new base. */
function adopt(st) {
  const gone = S.base?.index ? C.removedFiles(S.base.index, st.index) : [];
  if (gone.length) S.gh.forget(gone).catch(() => {});
  S.head = st.head;
  S.base = st;
  markSeen(S.space.id);
  S.index = C.applyOps(structuredClone(st.index), S.pending);
  $('#spaceName').textContent = S.index.title || S.space.repo;
  if (S.gh.sealed && S.index.title && S.space.title !== S.index.title) { S.space.title = S.index.title; saveSpaces(); }
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
  if (!S.canWrite) { toast(t('readonly')); return; }
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
  const names = { tag: 'tags', like: 'likes', comment: 'comment', uncomment: 'remove comment', updatePhoto: 'photo info', deletePhotos: 'delete photos', createAlbum: 'new album', renameAlbum: 'rename album', deleteAlbum: 'delete album', albumMembership: 'album photos', setCover: 'album cover', join: 'join', setTitle: 'title', replacePhoto: 'replace photo' };
  return `Moa: ${kinds.map(k => names[k] || k).join(', ')}${n > 1 ? ` (${n})` : ''}${S.me?.login ? ` — @${S.me.login}` : ''}`;
}

function flush() {
  clearTimeout(flushTimer);
  return serial(async () => {
    if (!S.pending.length || !S.gh || (S.gh.sealed && !S.gh.key)) return; // a locked album keeps its queue until unlocked
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
      toast(t('save.failed', { e: errMsg(e) }), 4000);
      flushTimer = setTimeout(flush, 20000);
    }
  });
}

// periodic pull so friends' uploads show up
setInterval(() => { if (!document.hidden) pull(); }, 45000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) pull(); else if (S.pending.length) flush(); });
window.addEventListener('online', () => { if (S.pending.length) flush(); pull(); resumeUploads(); });
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
  rememberCover();
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
    c.innerHTML = `<div class="empty"><h2>${t('init.notAlbum')}</h2></div>`;
    return;
  }
  c.innerHTML = `<div class="empty">${EMPTY_ART}
    <h2>${t('init.title')}</h2>
    <p><b>${esc(S.space.owner)}/${esc(S.space.repo)}</b></p>
    <div style="max-width:340px;margin:0 auto;text-align:left" id="initForm"><label class="field"><span>${t('newAlbum.name')}</span><input id="initTitle" value="${esc(S.initTitle || (S.repoInfo?.description && !isEncryptedRepo(S.repoInfo) ? albumTitle(S.repoInfo) : '') || t('newAlbum.default'))}"></label>
    ${S.gh.sealed ? '' : encFieldsHTML()}<p class="err" id="initErr" hidden></p>
    <button class="btn btn-primary btn-block" id="initBtn">${t('init.create')}</button></div></div>`;
  if (!S.gh.sealed) bindEncFields(c);
  $('#initBtn').onclick = () => {
    const enc = S.initPass ? { pass: S.initPass } : readEncFields(c);
    if (enc.error) { $('#initErr').textContent = enc.error; $('#initErr').hidden = false; return; }
    serial(async () => {
      const btn = $('#initBtn');
      btn.disabled = true; btn.textContent = t('common.creating');
      const title = $('#initTitle').value.trim() || t('newAlbum.default');
      S.initTitle = null; S.initPass = null;
      try {
        if (empty) await S.gh.seed('README.md', repoReadme(enc.pass ? null : title), 'Moa: start album');
        const files = [];
        let recovery = null;
        if (enc.pass && !S.gh.sealed) {
          // album.json carries only the wrapped key; everything else is sealed from the first commit on
          const made = await createAlbumKey(enc.pass);
          const key = made.key;
          recovery = newRecoveryCode();
          const header = await withRecovery(made.header, key, recovery);
          files.push({ path: C.META_PATH, sha: await S.gh.blob(textToBase64(JSON.stringify(header, null, 2) + '\n')) });
          S.gh.setEncryption(header, key);
          S.keys.set(S.space.id, key);
          rememberKey(S.space.id, key);
        }
        const r = await S.gh.commit({ files, ops: [{ op: 'setTitle', title }, { op: 'join', user: S.me.login, at: new Date().toISOString() }], message: `Moa: create album — @${S.me.login}`, title });
        $('#toolbar').hidden = false;
        adopt(r);
        toast(t('init.done'));
        if (recovery) recoverySheet(recovery);
      } catch (e) {
        btn.disabled = false; btn.textContent = t('init.create');
        toast(errMsg(e), 4000);
      }
    });
  };
  // an album repo we just created: no need to ask for the name twice
  if (S.initTitle) $('#initBtn').click();
}

function repoReadme(title) {
  if (!title) return '# Moa album\n\nEncrypted. Open it in Moa with the album passphrase.\n\nManage files from the app; moving them by hand can break the album.\n';
  return `# ${title}\n\nA Moa shared album.\n\n- \`album.json\` — title, members, albums\n- \`index/YYYY-MM.json\` — photo metadata by capture month\n- \`media/YYYY/MM/DD/\` — originals (\`*.live.mov\` = Live Photo motion)\n- \`preview/\`, \`thumb/\` — JPEG renditions\n\nManage files from the app; moving them by hand can break the album.\n`;
}

// ---------------- capacity (GitHub repository limits) ----------------

const storageUsage = () => LIM.usage({ repoKB: S.repoInfo?.size || 0, photos: photos() });
const pctText = r => `${r < 0.1 ? (r * 100).toFixed(1) : Math.round(r * 100)}%`;

function capBanner() {
  const u = storageUsage();
  if (u.level === 'ok') return '';
  const head = u.level === 'over' ? t('cap.over') : t('cap.used', { p: pctText(u.ratio) });
  return `<div class="cap-banner ${u.level}"><span><b>${head}</b> · ${t('cap.left', { b: C.fmtBytes(u.remaining) })}</span><button class="text-btn" data-act="storage">${t('cap.details')}</button></div>`;
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
  const row = (level, title, sub, val) => `<div class="row"><span class="dot ${level}"></span><div class="grow"><b>${title}</b>${sub ? `<small>${sub}</small>` : ''}</div><span class="val">${val}</span></div>`;
  return [
    row(u.level, t('lim.repo'), '', C.fmtBytes(u.used)),
    row(LIM.levelOf(big.size / LIM.LIMITS.objectHard), t('lim.file'), big.size ? esc(big.name || '') : '', C.fmtBytes(big.size)),
    row('info', t('lim.fileRec'), '', t('lim.nPhotos', { n: over1 })),
    row(busy.level, t('lim.dir'), busy.dir ? esc(busy.dir) : '', busy.count.toLocaleString(locale())),
    shard.path ? row(LIM.levelOf(shard.size / LIM.LIMITS.objectRecommended), t('lim.index'), esc(shard.path), C.fmtBytes(shard.size)) : '',
    row(pushes >= LIM.LIMITS.pushesPerMinute ? 'warn' : 'ok', t('lim.push'), '', t('lim.perMin', { n: pushes })),
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
    tooBig ? li('danger', t('plan.tooBig', { n: tooBig })) : '',
    plan.heavy.length ? li('warn', t('plan.heavy', { n: plan.heavy.length })) : '',
    plan.overRecommended.length && keepOriginal ? li('info', t('plan.saveOrig', { b: C.fmtBytes(withOrig.bytes - noOrig.bytes) })) : '',
    plan.level !== 'ok' ? li(plan.level, t(plan.level === 'over' ? 'plan.over' : 'plan.after', { p: pctText(plan.ratioAfter) })) : '',
    n > 10 ? li('info', t('plan.batches', { n: Math.ceil(n / 10) })) : '',
  ].join('');
  return { plan, html: `<div class="cap ${plan.level}"><div class="cap-track"><i class="add" style="transform:scaleX(${Math.min(1, plan.ratioAfter).toFixed(4)})"></i><i class="used" style="transform:scaleX(${Math.min(1, plan.ratioBefore).toFixed(4)})"></i></div>
    <div class="cap-labels"><span>${t('plan.this', { b: `<b>${C.fmtBytes(plan.bytes)}</b>` })}</span><span>${t('plan.left', { b: `<b>${C.fmtBytes(plan.remainingAfter)}</b>` })}</span></div></div>
    ${items ? `<ul class="limit-list">${items}</ul>` : ''}
    ${plan.level === 'over' ? `<label class="ack"><input type="checkbox" id="upAck">${t('plan.ack')}</label>` : ''}` };
}

// ---------------- photos tab ----------------

function currentList() {
  const f = { album: S.album, tag: S.filter.tag, kind: S.filter.kind, ai: S.filter.ai, area: S.filter.area, month: S.filter.month };
  const list = C.filterPhotos(photos(), { ...f, q: S.filter.q });
  // search by description (on-device AI): add what it found that the words alone didn't
  const sem = S.semantic;
  if (!S.filter.q || !sem || sem.q !== S.filter.q) return list;
  const have = new Set(list.map(p => p.id));
  const extra = C.filterPhotos(sem.ids.map(id => S.index.photos[id]).filter(Boolean), f).filter(p => !have.has(p.id));
  return [...list, ...extra];
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
    c.innerHTML = `<div class="empty">${EMPTY_ART}<h2>${t(S.album ? 'empty.album' : 'empty.library')}</h2>
      ${S.canWrite ? `<button class="btn btn-primary" data-act="upload">${t('empty.upload')}</button>` : ''}</div>`;
    S.list = [];
    return;
  }
  if (!list.length) {
    c.innerHTML = `<div class="empty"><h2>${t('empty.noMatch')}</h2><button class="btn btn-quiet" data-act="clearFilter">${t('empty.clear')}</button></div>`;
    S.list = [];
    return;
  }
  if (S.view === 'map') return renderMap(list, c);

  let html = '';
  if (S.view === 'date') {
    const groups = C.groupByDate(list, S.order);
    let month = '';
    for (const g of groups) {
      if (g.month !== month) { month = g.month; html += `<h2 class="month">${/^\d{4}-\d{2}$/.test(month) ? fmtMonth(month) : '—'}</h2>`; }
      const labels = [...new Set(g.photos.map(p => p.place?.name || p.place?.label).filter(Boolean))];
      const sub = labels.length ? esc(labels[0]) + (labels.length > 1 ? t('date.more', { n: labels.length - 1 }) : '') : '';
      html += `<div class="group-h"><h3>${/^\d{4}-\d{2}-\d{2}$/.test(g.key) ? fmtDay(g.key) : '—'}</h3><span class="sub">${sub}</span></div><div class="grid">${g.photos.map(tileHTML).join('')}</div>`;
    }
    S.list = groups.flatMap(g => g.photos);
  } else if (S.view === 'place') {
    const groups = C.groupByPlace(list, { level: S.placeLevel, order: S.placeOrder });
    html = groups.map(g => groupCard(g, g.none ? '' : [g.subtitle, periodText(g.range)].filter(Boolean).join(' · '), !g.none && g.center)).join('');
    S.list = groups.flatMap(g => g.photos);
  } else {
    const groups = C.groupByTag(list);
    html = groups.map(g => groupCard(g, '')).join('');
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
    <div class="group-h"><div style="min-width:0"><h3>${esc(g.none ? t(g.key === '' && S.view === 'tag' ? 'group.noTag' : 'group.noPlace') : g.title)}</h3>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}</div>
      ${center ? `<button class="text-btn" data-act="mapAt" data-lat="${center.lat}" data-lng="${center.lng}">${t('view.map')}</button>` : ''}</div>
    <div class="grid">${shown.map(tileHTML).join('')}</div>
    <div class="foot"><span>${t('n.photos', { n: g.photos.length })}</span>${g.photos.length > LIMIT ? `<button class="text-btn" data-act="expand" data-key="${esc(key)}">${t(open ? 'group.less' : 'group.all')}</button>` : ''}</div>
  </section>`;
}

function tileHTML(p) {
  return `<button class="tile${S.selected.has(p.id) ? ' sel' : ''}" data-id="${esc(p.id)}" aria-label="${esc(p.name || t('photo'))}">${thumbImg(p.files?.thumb)}${p.files?.live ? `<span class="badge">${ICON.live}</span>` : ''}${p.kind === 'video' ? `<span class="dur">${fmtDur(p.duration)}</span>` : ''}${p.likes?.length ? ICON.heart : ''}${marksOf(p).length ? `<span class="marks">${marksOf(p).slice(0, 3).map(esc).join('')}</span>` : ''}<span class="check"></span></button>`;
}

// ---------------- symbol tags: one-tap marks (⭐ 📌 ✈️ …), shown like the ♥ ----------------

const marksOf = p => (p.tags || []).filter(C.isSymbolTag);
const tagLabel = tg => (C.isSymbolTag(tg) ? tg : '#' + tg);

/** Suggestions under a tag field as you type: matching marks first, then tags already in use. */
function bindTagSuggest(input, box, onPick) {
  const draw = () => {
    const last = input.value.split(/[,，]/).pop();
    const sug = C.suggestTags(last, C.tagCounts(photos()).map(([tg]) => tg));
    box.innerHTML = sug.map(tg => `<button type="button" class="chip${C.isSymbolTag(tg) ? ' mark' : ''}" data-sug="${esc(tg)}">${esc(tagLabel(tg))}</button>`).join('');
    box.hidden = !sug.length;
  };
  input.addEventListener('input', draw);
  box.addEventListener('click', e => {
    const b = e.target.closest('[data-sug]');
    if (!b) return;
    e.stopPropagation();
    onPick(b.dataset.sug);
    draw();
  });
  box.hidden = true;
}

function marksRowHTML(on, extra = []) {
  const list = [...new Set([...extra, ...C.quickSymbols(photos())])];
  return `<div class="marks-row" role="group" aria-label="${t('marks.title')}">${list.map(m => `<button type="button" class="mark${on.includes(m) ? ' on' : ''}" data-mark="${esc(m)}" aria-pressed="${on.includes(m)}">${esc(m)}</button>`).join('')}</div>`;
}

function renderHero(all) {
  const h = $('#hero');
  const lives = all.filter(p => p.files?.live).length;
  const videos = all.filter(p => p.kind === 'video').length;
  const bits = [t('hero.photos', { n: all.length - videos })];
  if (videos) bits.push(t('hero.videos', { n: videos }));
  if (lives) bits.push(t('hero.live', { n: lives }));
  if (S.album) {
    const a = S.index.albums[S.album];
    h.innerHTML = `<div style="min-width:0"><button class="back" data-act="backAlbums">${ICON.back}${t('tab.albums')}</button><h1>${esc(a.name)}</h1><p>${bits.join(' · ')}${a.by ? ` · @${esc(a.by)}` : ''}</p></div>
      <div class="hero-actions">${S.canWrite ? `<button class="btn btn-quiet btn-sm" data-act="albumMenu">${t('common.edit')}</button>` : ''}</div>`;
  } else {
    const members = Object.keys(S.index.members || {}).length;
    if (members > 1) bits.push(t('hero.members', { n: members }));
    h.innerHTML = `<div><h1>${t('tab.library')}</h1><p>${bits.join(' · ')}</p></div>`;
  }
}

function renderToolbar(all) {
  const views = ['date', 'place', 'map', 'tag'];
  $$('#viewSeg button').forEach(b => b.classList.toggle('on', b.dataset.view === S.view));
  $('#segThumb').style.transform = `translateX(${views.indexOf(S.view) * 100}%)`;
  const ctl = $('#controls');
  if (S.view === 'date') {
    ctl.innerHTML = `<select data-ctl="order" aria-label="${t('sort')}"><option value="desc">${t('sort.newest')}</option><option value="asc">${t('sort.oldest')}</option></select>`;
    ctl.querySelector('select').value = S.order;
  } else if (S.view === 'place') {
    ctl.innerHTML = `<select data-ctl="placeLevel" aria-label="${t('place.level')}"><option value="country">${t('place.country')}</option><option value="city">${t('place.city')}</option><option value="district">${t('place.district')}</option></select>
      <select data-ctl="placeOrder" aria-label="${t('sort')}"><option value="recent">${t('place.recent')}</option><option value="count">${t('place.count')}</option><option value="name">${t('place.name')}</option></select>`;
    ctl.querySelector('[data-ctl=placeLevel]').value = S.placeLevel;
    ctl.querySelector('[data-ctl=placeOrder]').value = S.placeOrder;
  } else ctl.innerHTML = '';

  const f = S.filter;
  const lives = all.filter(p => p.files?.live).length;
  const videos = all.filter(p => p.kind === 'video').length;
  const favs = all.filter(p => p.likes?.length).length;
  const counted = C.tagCounts(all);
  const tags = [...counted.filter(([tg]) => C.isSymbolTag(tg)), ...counted.filter(([tg]) => !C.isSymbolTag(tg))].slice(0, 40);
  $('#chips').innerHTML = [
    f.area ? `<button class="chip on scope" data-chip="area" aria-label="${t('area.clear')}">${ICON.pin}${esc(f.area.label)} <span class="x">✕</span></button>` : '',
    f.month ? `<button class="chip on scope" data-chip="month" aria-label="${t('area.clear')}">${esc(fmtMonth(f.month))} <span class="x">✕</span></button>` : '',
    `<button class="chip${!f.kind && !f.tag && !f.ai && !f.area && !f.month ? ' on' : ''}" data-chip="all">${t('chip.all')}</button>`,
    videos ? `<button class="chip${f.kind === 'photo' ? ' on' : ''}" data-chip="kind" data-v="photo">${t('chip.photos')} <span class="n">${all.length - videos}</span></button>` : '',
    lives ? `<button class="chip${f.kind === 'live' ? ' on' : ''}" data-chip="kind" data-v="live">${ICON.live}LIVE <span class="n">${lives}</span></button>` : '',
    videos ? `<button class="chip${f.kind === 'video' ? ' on' : ''}" data-chip="kind" data-v="video">${t('chip.videos')} <span class="n">${videos}</span></button>` : '',
    favs ? `<button class="chip${f.kind === 'fav' ? ' on' : ''}" data-chip="kind" data-v="fav">♥ ${t('chip.liked')} <span class="n">${favs}</span></button>` : '',
    ...tags.map(([tg, n]) => `<button class="chip${C.isSymbolTag(tg) ? ' mark' : ''}${f.tag === tg ? ' on' : ''}" data-chip="tag" data-v="${esc(tg)}">${esc(tagLabel(tg))} <span class="n">${n}</span></button>`),
    ...C.aiTagCounts(all).slice(0, 20).map(([k, n]) => `<button class="chip ai${f.ai === k ? ' on' : ''}" data-chip="ai" data-v="${esc(k)}">${ICON.spark}${esc(labelName(k, lang()))} <span class="n">${n}</span></button>`),
  ].join('');
}

// ---------------- map view ----------------

function renderMap(list, c) {
  const pts = list.filter(p => p.gps).sort((a, b) => C.sortTs(b) - C.sortTs(a));
  S.list = pts;
  if (!window.L) { c.innerHTML = `<div class="empty"><p>${t('map.failed')}</p></div>`; return; }
  S.map?.remove();
  c.innerHTML = `<div class="map-wrap"><div id="map" style="width:100%;height:100%"></div>${pts.length ? `<button class="map-note map-area" id="mapArea"></button>` : `<div class="map-note">${t('map.none')}</div>`}</div>`;
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
        const tight = z >= 16 || b.getNorthEast().distanceTo(b.getSouthWest()) < 30;
        openClusterSheet(cl.photos, { area: areaOf(b.pad(0.05)), zoom: tight ? null : () => map.flyToBounds(b.pad(0.4), { maxZoom: 18, duration: 0.6 }) });
      });
    }
    $$('#map img[data-thumb]').forEach(loadThumb);
  };
  // "Photos in this area": only what the map shows right now
  const inView = () => { const a = areaOf(map.getBounds()); return { a, list: pts.filter(p => C.inArea(p.gps, a)) }; };
  const note = () => {
    const btn = $('#mapArea');
    if (!btn) return;
    const { list } = inView();
    btn.innerHTML = list.length ? `${t('area.show', { n: list.length })} <span aria-hidden="true">›</span>` : t('area.none');
    btn.disabled = !list.length;
  };
  $('#mapArea')?.addEventListener('click', () => { const { a, list } = inView(); if (list.length) showArea({ ...a, label: areaLabel(list) }); });
  map.on('zoomend', draw);
  map.on('moveend', note);
  draw();
  note();
  setTimeout(() => { if (S.map === map) map.invalidateSize(); }, 50); // the view may have changed (and removed this map) meanwhile
}

/** Leaflet bounds → { s, w, n, e } with longitudes back in -180…180 (the map can wrap). */
function areaOf(b) {
  const s = Math.max(-90, b.getSouth()), n = Math.min(90, b.getNorth());
  if (b.getEast() - b.getWest() >= 360) return { s, n, w: -180, e: 180 };
  const wrap = x => ((((x + 180) % 360) + 360) % 360) - 180;
  return { s, n, w: wrap(b.getWest()), e: wrap(b.getEast()) };
}

function areaLabel(list) {
  const a = C.areaName(list);
  return a ? (a.more ? t('area.more', { name: a.name, n: a.more }) : a.name) : t('area.here');
}

/** Only the photos taken in an area: back to the grid with a removable "📍 place" filter. */
function showArea(area) {
  closeSheet();
  S.filter.area = area;
  S.view = 'date';
  showTab('photos');
  window.scrollTo(0, 0);
}

function openClusterSheet(list, { area = null, zoom = null } = {}) {
  const sh = openSheet(`<h2>${area ? esc(areaLabel(list)) : ''} <small>${t('n.photos', { n: list.length })}</small></h2>
    ${area ? `<div class="actions" style="margin:0 0 14px">${zoom ? `<button class="btn btn-quiet" id="clZoom">${t('area.zoom')}</button>` : ''}<button class="btn btn-primary" id="clOnly">${t('area.only')}</button></div>` : ''}
    <div class="grid" style="margin:0 -20px">${list.map(tileHTML).join('')}</div>`, { kind: 'cluster' });
  observeThumbs(sh);
  $('#clOnly', sh)?.addEventListener('click', () => showArea({ ...area, label: areaLabel(list) }));
  $('#clZoom', sh)?.addEventListener('click', () => { closeSheet(); zoom(); });
  sh.onclick = e => { const tile = e.target.closest('.tile'); if (tile) { closeSheet(); openViewer(tile.dataset.id, list); } };
}

// ---------------- albums tab ----------------

function albumCover(a, id) {
  const inAlbum = photos().filter(p => (p.albums || []).includes(id)).sort((x, y) => C.sortTs(y) - C.sortTs(x));
  const cover = (a.cover && S.index.photos[a.cover]) || inAlbum[0];
  return { cover, count: inAlbum.length };
}

function renderAlbums() {
  const el = $('#tab-albums');
  const albums = Object.entries(S.index.albums).sort((a, b) => (b[1].createdAt || '').localeCompare(a[1].createdAt || ''));
  const all = photos();
  const smart = [
    ['live', t('smart.live'), all.filter(p => p.files?.live)],
    ['video', t('chip.videos'), all.filter(p => p.kind === 'video')],
    ['fav', t('chip.liked'), all.filter(p => p.likes?.length)],
  ].filter(x => x[2].length);
  const card = (inner, attrs) => `<button class="album-card" ${attrs}>${inner}</button>`;
  const coverHTML = p => `<div class="cover">${p ? thumbImg(p.files.thumb) : ICON.album}</div>`;
  const newest = l => l.sort((x, y) => C.sortTs(y) - C.sortTs(x))[0];
  const places = new Set(all.map(p => p.place && C.placeKey(p.place)).filter(Boolean)).size;
  const tags = C.tagCounts(all).length;
  el.innerHTML = `<div class="hero"><div><h1>${t('tab.albums')}</h1><p>${albums.length}</p></div></div>
    <div class="albums">
      ${S.canWrite ? `<button class="album-card new" data-act="newAlbum"><div class="cover">${ICON.plus}</div><b>${t('newAlbum.title')}</b><span>&nbsp;</span></button>` : ''}
      ${albums.map(([id, a]) => { const { cover, count } = albumCover(a, id); return card(`${coverHTML(cover)}<b>${esc(a.name)}</b><span>${count}</span>`, `data-album="${esc(id)}"`); }).join('')}
    </div>
    ${smart.length || places || tags ? `<h2 class="section-title">${t('smart.title')}</h2>` : ''}
    <div class="albums">
      ${smart.map(([k, name, l]) => card(`${coverHTML(newest(l))}<b>${name}</b><span>${l.length}</span>`, `data-smart="${k}"`)).join('')}
      ${places ? card(`${coverHTML(newest(all.filter(p => p.place)))}<b>${t('smart.places')}</b><span>${places}</span>`, 'data-smart="place"') : ''}
      ${tags ? card(`${coverHTML(all.find(p => p.tags?.length))}<b>${t('smart.tags')}</b><span>${tags}</span>`, 'data-smart="tag"') : ''}
      ${all.length ? card(`<div class="cover stats-cover">${statsSpark(all)}</div><b>${t('stats.title')}</b><span>${t('n.photos', { n: all.length })}</span>`, 'data-act="stats"') : ''}
    </div>`;
  observeThumbs(el);
}

function newAlbum(then) {
  const sh = openSheet(`<h2>${t('newAlbum.title')}</h2><label class="field"><span>${t('newAlbum.name')}</span><input id="albumName" placeholder="${t('newAlbum.namePh')}" maxlength="60"></label><div class="actions"><button class="btn btn-quiet" data-close>${t('common.cancel')}</button><button class="btn btn-primary" id="albumOk">${t('common.create')}</button></div>`);
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
  const { cover } = albumCover(a, S.album);
  const sh = openSheet(`<h2>${t('albumEdit.title')}</h2><label class="field"><span>${t('newAlbum.name')}</span><input id="albumName" value="${esc(a.name)}" maxlength="60"></label>
    ${cover ? `<button class="cover-row" id="albumCover"><span class="cover-thumb">${thumbImg(cover.files.thumb)}</span><span class="grow"><b>${t('cover.album')}</b><small>${t(a.cover ? 'cover.chosen' : 'cover.auto')}</small></span><span class="text-btn">${t('cover.change')}</span></button>` : ''}
    <div class="actions"><button class="btn btn-danger" id="albumDel">${t('albumEdit.delete')}</button><button class="btn btn-primary" id="albumOk">${t('common.save')}</button></div>`);
  observeThumbs(sh);
  $('#albumCover', sh)?.addEventListener('click', () => albumCoverSheet(S.album));
  $('#albumOk', sh).onclick = () => { const n = $('#albumName', sh).value.trim(); if (n && n !== a.name) edit({ op: 'renameAlbum', id: S.album, name: n }); closeSheet(); };
  $('#albumDel', sh).onclick = () => {
    if (!confirm(t('albumEdit.confirm', { name: a.name }))) return;
    const id = S.album; S.album = null; closeSheet(); edit({ op: 'deleteAlbum', id }); showTab('albums');
  };
}

function pickAlbum(ids) {
  const albums = Object.entries(S.index.albums);
  const sh = openSheet(`<h2>${t('pick.title')}</h2><div>${albums.map(([id, a]) => `<button class="list-btn" data-pick="${esc(id)}"><span class="grow">${esc(a.name)}<small>${t('n.photos', { n: albumCover(a, id).count })}</small></span></button>`).join('')}
    <button class="list-btn" data-pick="__new"><span class="grow" style="color:var(--primary)">+ ${t('newAlbum.title')}</span></button></div>
    ${S.album ? `<div class="actions"><button class="btn btn-danger" data-pick="__remove">${t('pick.remove', { name: esc(S.index.albums[S.album].name) })}</button></div>` : ''}`);
  sh.onclick = e => {
    const b = e.target.closest('[data-pick]');
    if (!b) return;
    const v = b.dataset.pick;
    const add = id => { edit({ op: 'albumMembership', ids, album: id, on: true }); toast(t('pick.added', { n: ids.length, name: S.index.albums[id].name })); setSelecting(false); };
    if (v === '__new') return newAlbum(add);
    closeSheet();
    if (v === '__remove') { edit({ op: 'albumMembership', ids, album: S.album, on: false }); setSelecting(false); return; }
    add(v);
  };
}

// ---------------- settings tab ----------------

function renderSettings() {
  const el = $('#tab-settings');
  const all = photos();
  const u = storageUsage();
  const members = Object.entries(S.index.members || {});
  const counts = {};
  all.forEach(p => { counts[p.by] = (counts[p.by] || 0) + 1; });
  const repoUrl = S.gh.webUrl;
  const sw = key => `<div class="row"><div class="grow"><b>${t('opt.' + key)}</b></div><label class="switch"><input type="checkbox" data-pref="${key}"${prefs[key] ? ' checked' : ''}><span></span></label></div>`;
  el.innerHTML = `<div class="hero"><div><h1>${t('tab.settings')}</h1><p>${esc(S.index.title || '')}</p></div></div>
    <h2 class="section-title">${t('set.people')}</h2>
    <div class="panel">
      ${members.map(([login]) => `<div class="row"><img class="avatar" alt="" src="${avatar(login)}" loading="lazy"><div class="grow"><b>@${esc(login)}${login === S.me?.login ? ` (${t('set.me')})` : ''}</b><small>${t('n.photos', { n: counts[login] || 0 })}</small></div></div>`).join('')}
      <button class="row" style="width:100%" data-act="invite"><span class="grow" style="text-align:left;color:var(--primary)">+ ${t('invite.title')}</span></button>
    </div>
    <h2 class="section-title">${t('set.album')}</h2>
    <div class="panel">
      <div class="row"><div class="grow"><b>${esc(S.space.owner)}/${esc(S.space.repo)}</b><small>${S.repoInfo?.private === false ? `⚠️ ${t('home.public')}` : t('set.private')} · ${esc(S.gh.branch)}${S.canWrite ? '' : ` · ${t('set.readonly')}`}</small></div>${repoUrl ? `<a class="text-btn" href="${repoUrl}" target="_blank" rel="noopener">GitHub</a>` : ''}</div>
      ${S.canWrite ? `<button class="row" style="width:100%" data-act="rename"><span class="grow" style="text-align:left"><b>${t('newAlbum.name')}</b><small>${esc(S.index.title || '')}</small></span><span class="text-btn">${t('common.edit')}</span></button>` : ''}
      ${S.canWrite && all.length ? `<button class="row row-btn" data-act="mainCover"><span class="cover-thumb">${thumbImg(libraryCover()?.files?.thumb)}</span><span class="grow"><b>${t('cover.main')}</b><small>${t(S.index.cover && S.index.photos[S.index.cover] ? 'cover.chosen' : 'cover.auto')}${S.gh.sealed ? ` · ${t('cover.sealedNote')}` : ''}</small></span><span class="text-btn">${t('cover.change')}</span></button>` : ''}
      ${all.length ? `<button class="row row-btn" data-act="stats"><span class="grow"><b>${t('stats.title')}</b><small>${t('stats.sub')}</small></span><span class="val">›</span></button>` : ''}
      ${S.gh.sealed ? `<div class="row"><span class="lock-badge">${ICON.lock}</span><div class="grow"><b>${t('enc.on')}</b><small>AES-256-GCM</small></div></div>
      ${S.canWrite ? `<button class="row row-btn" data-act="passphrase"><span class="grow"><b>${t('enc.change')}</b></span><span class="val">›</span></button>
      <button class="row row-btn" data-act="recovery"><span class="grow"><b>${t('rec.title')}</b><small>${t(hasRecovery(S.gh.header) ? 'rec.set' : 'rec.notSet')}</small></span><span class="val">›</span></button>
      <button class="row row-btn" data-act="passkey"><span class="grow"><b>${esc(t('pk.title', { name: bioName() }))}</b><small>${passkeyStatus()}</small></span><span class="val">›</span></button>` : ''}
      <button class="row row-btn" data-act="lockHere"><span class="grow"><b>${t('enc.lockHere')}</b></span><span class="val">›</span></button>` : ''}
      ${isOwner() && !S.gh.sealed ? `<button class="row row-btn" data-act="encryptAlbum"><span class="grow"><b>${ICON.lock}${t(load(LS.convert(S.space.id), null)?.toSealed ? 'conv.resumeEncrypt' : 'conv.encryptTitle')}</b></span><span class="val">›</span></button>` : ''}
      ${isOwner() && S.gh.sealed ? `<button class="row row-btn" data-act="decryptAlbum"><span class="grow"><b>${t(load(LS.convert(S.space.id), null)?.toSealed === false ? 'conv.resumeDecrypt' : 'conv.decryptTitle')}</b></span><span class="val">›</span></button>` : ''}
      ${all.length ? `<button class="row row-btn" data-act="downloadAll"><span class="grow"><b>${t('dl.all')}</b><small>${t('n.photos', { n: all.length })}</small></span><span class="val">›</span></button>` : ''}
      ${S.canWrite ? `<button class="row row-btn" data-act="purge"><span class="grow"><b style="color:var(--danger)">${t('purge.title')}</b></span><span class="val">›</span></button>` : ''}
    </div>
    <h2 class="section-title" id="storageTitle">${t('set.storage')}</h2>
    <div class="panel">
      <div class="storage">${ring(u.ratio, u.level)}<div style="min-width:0"><div class="big">${t('set.left', { b: C.fmtBytes(u.remaining) })}</div><div class="sub">${C.fmtBytes(u.used)} / 10 GB</div>
        <div class="legend"><span><i style="background:var(--primary)"></i>${t('set.originals')} ${C.fmtBytes(u.breakdown.original)}</span><span><i style="background:#ff9f0a"></i>${t('set.liveVideo')} ${C.fmtBytes(u.breakdown.live)}</span><span><i style="background:#30d158"></i>${t('set.previews')} ${C.fmtBytes(u.breakdown.preview + u.breakdown.thumb)}</span></div></div></div>
      <div class="row"><div class="grow"><b>${t('set.githubSize')}</b></div><span class="val">${C.fmtBytes(u.repo)}</span></div>
    </div>
    <h2 class="section-title">${t('set.limits')}</h2>
    <div class="panel">${limitRows()}</div>
    <h2 class="section-title">${t('set.albums')}</h2>
    <div class="panel">
      ${S.spaces.filter(x => tokenFor(x)).map(x => `<div class="row"><button class="grow" data-space="${esc(x.id)}"><b>${esc(x.title || x.repo)}</b><small>${esc(x.owner)}/${esc(x.repo)}${x.id === S.space.id ? ` · <span class="tick">✓</span>` : ''}</small></button><button class="text-btn danger" data-unlink="${esc(x.id)}">${t('set.remove')}</button></div>`).join('')}
      ${S.auth ? `<button class="row row-btn" data-act="home"><span class="grow" style="color:var(--primary)">${t('set.allAlbums')}</span></button>` : ''}
      <button class="row" style="width:100%" data-act="addSpace"><span class="grow" style="text-align:left;color:var(--primary)">+ ${t('welcome.tokenAdvanced')}</span></button>
    </div>
    <h2 class="section-title">${t('set.options')}</h2>
    <div class="panel">
      <div class="row"><div class="grow"><b>${t('set.language')}</b></div><select class="lang-select" data-lang aria-label="${t('set.language')}"><option value="en">English</option><option value="ko">한국어</option></select></div>
      ${sw('autoplayLive')}
      ${sw('keepOriginal')}
      ${sw('geocode')}
      ${canNotify() ? sw('notify') : ''}
      <div class="row"><div class="grow"><b>${t('ai.opt')}</b><small id="aiStatus">${aiStatusText()}</small></div><label class="switch"><input type="checkbox" data-ai-toggle${prefs.ai ? ' checked' : ''}><span></span></label></div>
      <button class="row" style="width:100%" data-act="clearCache"><span class="grow" style="text-align:left"><b>${t('set.clearCache')}</b></span></button>
    </div>
    <h2 class="section-title">${t('set.account')}</h2>
    <div class="panel"><div class="row"><img class="avatar" alt="" src="${esc(S.auth?.avatar || avatar(S.me?.login || 'ghost'))}"><div class="grow"><b>@${esc(S.me?.login || '')}</b></div>${S.auth ? `<button class="text-btn danger" data-act="logout">${t('auth.signOut')}</button>` : ''}</div></div>`;
  $('[data-lang]', el).value = lang();
  observeThumbs(el);
  // draw the ring from empty once it's on screen
  requestAnimationFrame(() => requestAnimationFrame(() => $$('.ring .val', el).forEach(c => { c.style.strokeDashoffset = c.dataset.off; })));
}

function inviteSheet() {
  const base = location.origin + location.pathname;
  const link = `${base}#join=${encodeURIComponent(S.space.owner + '/' + S.space.repo)}${S.space.api ? '&api=' + encodeURIComponent(S.space.api) : ''}${S.me?.login ? '&by=' + encodeURIComponent(S.me.login) : ''}`;
  const sh = openSheet(`<h2>${t('invite.title')}</h2>
    <label class="field"><span>${t('invite.username')}</span><input id="invUser" placeholder="octocat" autocapitalize="off" spellcheck="false" enterkeyhint="send"></label>
    <button class="btn btn-primary btn-block" id="invSend">${t('invite.send')}</button>
    <h2 style="font-size:17px;margin:22px 0 6px">${t('set.people')}</h2>
    <div id="invList"><p class="note" style="margin:0;padding:0">${t('sync.loading')}</p></div>
    ${S.auth && isOwner() ? `<h2 style="font-size:17px;margin:22px 0 10px">${t('inv.byLink')}</h2>
    ${S.gh.sealed ? `<div class="row opt-row"><div class="grow"><b>${ICON.lock}${t('inv.withKey')}</b></div><label class="switch"><input type="checkbox" id="invKey" checked><span></span></label></div>` : ''}
    <div class="actions" style="margin-top:0"><button class="btn btn-quiet" id="invOnce">${t('inv.once')}</button><button class="btn btn-quiet" id="invWeek">${t('inv.week')}</button></div>
    <div id="invShow"></div><div id="invActive"></div>` : ''}
    <details class="guide" style="margin-top:16px"><summary>${t('invite.link')}</summary><div style="padding:0 16px 14px">
      <input readonly value="${esc(link)}" id="inviteLink" class="link-field">
      <div class="actions" style="margin-top:10px"><button class="btn btn-quiet" id="copyLink">${t('invite.copy')}</button>${navigator.share ? `<button class="btn btn-quiet" id="shareLink">${t('invite.share')}</button>` : ''}</div></div></details>`, { onClose: () => { clearInterval(invPoll); invPoll = null; } });
  const list = async () => {
    const [col, inv] = await Promise.allSettled([S.gh.collaborators(), S.gh.pendingInvites()]);
    const people = col.status === 'fulfilled' ? col.value : [];
    const pending = inv.status === 'fulfilled' ? inv.value : [];
    const box = $('#invList', sh);
    if (!box) return;
    box.innerHTML = `<div class="panel" style="margin:0">${[
      ...people.map(u => `<div class="row"><img class="avatar" alt="" src="${esc(u.avatar_url || avatar(u.login))}"><div class="grow"><b>@${esc(u.login)}${u.login === S.me?.login ? ` (${t('set.me')})` : ''}</b><small>${t(u.login === S.space.owner ? 'invite.owner' : u.permissions?.push ? 'invite.canEdit' : 'invite.viewOnly')}</small></div></div>`),
      ...pending.map(i => `<div class="row"><img class="avatar" alt="" src="${esc(i.invitee?.avatar_url || avatar(i.invitee?.login || 'ghost'))}"><div class="grow"><b>@${esc(i.invitee?.login || '')}</b><small>${t('invite.pending')}</small></div><button class="text-btn danger" data-cancel="${i.id}">${t('common.cancel')}</button></div>`),
    ].join('') || `<div class="row"><div class="grow"><small>${t('invite.noAccess')}</small></div></div>`}</div>`;
  };
  list();
  const send = async () => {
    const u = $('#invUser', sh).value.trim().replace(/^@/, '');
    if (!/^[A-Za-z0-9-]{1,39}$/.test(u)) return toast(t('invite.badUser'));
    const btn = $('#invSend', sh);
    btn.disabled = true; btn.textContent = t('invite.sending');
    try {
      const r = await S.gh.invite(u);
      toast(t(r ? 'invite.sent' : 'invite.already', { u: '@' + u }));
      $('#invUser', sh).value = '';
      list();
    } catch (e) {
      toast(e.status === 404 ? t('invite.noUser', { u: '@' + u }) : e.status === 403 ? t('invite.ownerOnly') : errMsg(e), 4000);
    } finally { btn.disabled = false; btn.textContent = t('invite.send'); }
  };
  $('#invSend', sh).onclick = send;
  $('#invUser', sh).onkeydown = e => { if (e.key === 'Enter' && !e.isComposing) send(); };
  sh.addEventListener('click', async e => {
    const c = e.target.closest('[data-cancel]');
    if (!c) return;
    try { await S.gh.cancelInvite(c.dataset.cancel); list(); } catch (ex) { toast(errMsg(ex)); }
  });
  $('#copyLink', sh).onclick = async () => {
    try { await navigator.clipboard.writeText(link); } catch { $('#inviteLink', sh).select(); document.execCommand('copy'); }
    toast(t('invite.copied'));
  };
  $('#shareLink', sh)?.addEventListener('click', () => navigator.share({ title: 'Moa', text: S.index.title, url: link }).catch(() => {}));
  if (!$('#invOnce', sh)) return;
  const make = async uses => {
    const btns = [$('#invOnce', sh), $('#invWeek', sh)];
    btns.forEach(b => { b.disabled = true; });
    try {
      const expires = new Date(Date.now() + (uses === 1 ? 1 : 7) * 864e5).toISOString();
      const sealed = S.gh.sealed;
      const meta = { repo: `${S.space.owner}/${S.space.repo}`, by: S.auth.login, expires, uses, ...(sealed ? { encrypted: true } : { title: S.index.title }) };
      const inv = await account().createInvite(meta);
      const k = sealed && $('#invKey', sh)?.checked ? await keyToText(S.gh.key) : null;
      showInvite(sh, inv, k);
      listInvites(sh);
      clearInterval(invPoll);
      invPoll = setInterval(() => processInvites().then(n => { if (n) { list(); listInvites(sh); } }), 3000);
    } catch (e) {
      if (e.status === 403 || e.status === 404) $('#invShow', sh).innerHTML = `<div class="invite-banner">${t('inv.needScope')} <button class="text-btn" id="invRelogin">${t('inv.relogin')}</button></div>`;
      else toast(errMsg(e), 4000);
      $('#invRelogin', sh)?.addEventListener('click', () => { location.href = 'api/auth/login'; });
    } finally { btns.forEach(b => { b.disabled = false; }); }
  };
  $('#invOnce', sh).onclick = () => make(1);
  $('#invWeek', sh).onclick = () => make(0);
  listInvites(sh);
  sh.addEventListener('click', async e => {
    const r = e.target.closest('[data-revoke]');
    if (!r) return;
    r.disabled = true;
    await account().revokeInvite(r.dataset.revoke).catch(() => {});
    if ($('#invShow', sh).dataset.id === r.dataset.revoke) $('#invShow', sh).innerHTML = '';
    listInvites(sh);
  });
}

// ---------------- invite links & codes ----------------

let invPoll = null;

/** QR as SVG from the vendored encoder (vendor/qrcode, MIT). */
function qrSVG(text) {
  if (!window.qrcode) return '';
  const q = window.qrcode(0, 'M');
  q.addData(text);
  q.make();
  const n = q.getModuleCount(), pad = 4;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + pad} ${r + pad}h1v1h-1z`;
  return `<svg class="qr" viewBox="0 0 ${n + pad * 2} ${n + pad * 2}" shape-rendering="crispEdges" role="img" aria-label="QR"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

function inviteLink(id, k) {
  return `${location.origin}${location.pathname.replace(/index\.html$/, '')}#invite=${id}${k ? '&k=' + k : ''}`;
}

function showInvite(sh, inv, k) {
  const link = inviteLink(inv.id, k);
  const box = $('#invShow', sh);
  box.dataset.id = inv.id;
  box.innerHTML = `<div class="invite-card">${qrSVG(link)}
    <div class="code-box small" id="invCode">${esc(fmtCode(inv.id))}</div>
    <small>${t(inv.uses === 1 ? 'inv.onceNote' : 'inv.weekNote', { d: fmtDate(inv.expires) })}</small>
    <input readonly class="link-field" id="invLink" value="${esc(link)}">
    <div class="actions"><button class="btn btn-quiet" id="invCopy">${t('invite.copy')}</button>${navigator.share ? `<button class="btn btn-quiet" id="invShare">${t('invite.share')}</button>` : ''}</div></div>`;
  $('#invCopy', box).onclick = async () => { try { await navigator.clipboard.writeText(link); } catch { $('#invLink', box).select(); document.execCommand('copy'); } toast(t('invite.copied')); };
  $('#invShare', box)?.addEventListener('click', () => navigator.share({ title: 'Moa', url: link }).catch(() => {}));
}

async function listInvites(sh) {
  const box = $('#invActive', sh);
  if (!box) return;
  let list = [];
  try { list = (await account().invites()).filter(i => i.repo.toLowerCase() === `${S.space.owner}/${S.space.repo}`.toLowerCase() && Date.parse(i.expires) > Date.now()); } catch { /* no gist scope yet */ }
  if (!$('#invActive', sh)) return;
  box.innerHTML = list.length ? `<div class="panel" style="margin:12px 0 0">${list.map(i => `<div class="row"><div class="grow"><b>${esc(fmtCode(i.id).slice(0, 9))}…</b><small>${t(i.uses === 1 ? 'inv.once' : 'inv.week')} · ${t('inv.until', { d: fmtDate(i.expires) })}</small></div><button class="text-btn danger" data-revoke="${esc(i.id)}">${t('inv.revoke')}</button></div>`).join('')}</div>` : '';
}

/**
 * Owner side: turn join requests on my invites into GitHub collaborator
 * invitations. Runs while the app is open; returns how many people were let in.
 */
let invBusy = false;
async function processInvites() {
  if (!S.auth || invBusy || document.hidden) return 0;
  invBusy = true;
  let admitted = 0;
  try {
    const acc = account();
    for (const inv of await acc.invites()) {
      if (Date.parse(inv.expires) < Date.now()) { await acc.revokeInvite(inv.id).catch(() => {}); continue; }
      if (inv.comments <= inv.seen) continue;
      const comments = await acc.inviteComments(inv.id);
      const [owner, repo] = inv.repo.split('/');
      const gh = new Repo({ owner, repo, token: S.auth.token, api: S.authApi });
      let spent = false;
      for (const c of comments.slice(inv.seen)) {
        const who = c.user?.login;
        if (!who || who === S.auth.login || String(c.body || '').trim() !== 'moa-join') continue;
        try { await gh.invite(who); admitted++; toast(t('inv.letIn', { u: '@' + who })); } catch (e) { console.warn('invite', who, e); }
        if (inv.uses === 1) { spent = true; break; }
      }
      if (spent) await acc.revokeInvite(inv.id); // one-time: the code stops working
      else await acc.markInvite(inv, comments.length);
    }
  } catch { /* offline, or signed in before invite links existed (no gist scope) */ }
  finally { invBusy = false; }
  return admitted;
}
setInterval(() => { if (S.auth) processInvites(); }, 30000);

function codeSheet() {
  const sh = openSheet(`<h2>${t('join.enterCode')}</h2>
    <label class="field"><span>${t('join.code')}</span><input id="joinCode" autocapitalize="off" autocomplete="off" spellcheck="false" placeholder="xxxx-xxxx-…"></label>
    <p class="err" id="joinErr" hidden></p>
    <div class="actions"><button class="btn btn-quiet" data-close>${t('common.cancel')}</button><button class="btn btn-primary" id="joinOk">${t('join.next')}</button></div>`);
  setTimeout(() => $('#joinCode', sh).focus(), 50);
  const ok = () => {
    const raw = $('#joinCode', sh).value;
    const id = parseInviteCode(raw);
    if (!id) { $('#joinErr', sh).textContent = t('join.badCode'); $('#joinErr', sh).hidden = false; return; }
    save(LS.invite, { id, k: /[#&]k=([\w-]+)/.exec(raw)?.[1] || null, at: Date.now() });
    closeSheet();
    renderJoinCard();
    joinTick();
  };
  $('#joinOk', sh).onclick = ok;
  $('#joinCode', sh).onkeydown = e => { if (e.key === 'Enter' && !e.isComposing) ok(); };
}

/** Friend side: the pending invite on the home screen. */
function renderJoinCard(state) {
  const box = $('#homeJoin');
  const inv = load(LS.invite, null);
  if (!box) return;
  if (!inv) { box.innerHTML = ''; return; }
  const st = state || inv.state || 'loading';
  const name = inv.title ? `<b>${esc(inv.title)}</b>` : `<b>${esc(inv.repo || fmtCode(inv.id).slice(0, 9) + '…')}</b>`;
  const by = inv.by ? '@' + esc(inv.by) : '';
  const body = {
    loading: `<span>${t('sync.loading')}</span>`,
    ask: `<span>${t('join.ask', { name, by })}</span><div class="actions"><button class="btn btn-quiet" data-join="cancel">${t('common.cancel')}</button><button class="btn btn-primary" data-join="go">${t('join.join')}</button></div>`,
    waiting: `<span>${t('join.waiting', { name, by })}</span><div class="actions"><button class="btn btn-quiet" data-join="cancel">${t('common.cancel')}</button></div>`,
    gone: `<span>${t('join.gone')}</span><div class="actions"><button class="btn btn-quiet" data-join="cancel">${t('common.done')}</button></div>`,
    own: `<span>${t('join.own')}</span><div class="actions"><button class="btn btn-quiet" data-join="cancel">${t('common.done')}</button></div>`,
    scope: `<span>${t('inv.needScope')}</span><div class="actions"><button class="btn btn-primary" data-join="relogin">${t('inv.relogin')}</button></div>`,
  }[st];
  box.innerHTML = `<div class="invite-banner join-card" data-state="${st}">${body}</div>`;
  box.onclick = e => {
    const b = e.target.closest('[data-join]');
    if (!b) return;
    const cur = load(LS.invite, null);
    if (b.dataset.join === 'cancel') { localStorage.removeItem(LS.invite); renderJoinCard(); }
    else if (b.dataset.join === 'relogin') location.href = 'api/auth/login';
    else if (cur) { cur.accepted = true; save(LS.invite, cur); joinTick(); }
  };
}

let joinBusy = false;
async function joinTick() {
  const inv = load(LS.invite, null);
  if (!inv || !S.auth || joinBusy) return;
  joinBusy = true;
  const set = (state, extra = {}) => { Object.assign(inv, extra, { state }); save(LS.invite, inv); renderJoinCard(state); };
  try {
    const acc = account();
    if (!inv.repo) {
      const meta = await acc.readInvite(inv.id);
      if (!meta || Date.parse(meta.expires) < Date.now()) return set('gone');
      // who made the gist is vouched for by GitHub; the text inside it is not
      if (meta.owner === S.auth.login) return set('own');
      Object.assign(inv, { repo: meta.repo, by: meta.owner, title: meta.title || null });
    }
    if (!inv.accepted) return set('ask'); // joining is the friend's choice
    const [owner, name] = inv.repo.split('/');
    // already let in? accept the GitHub invitation and open the album
    const pending = (await acc.invitations().catch(() => [])).find(i => sameRepo({ owner: i.repository.owner.login, repo: i.repository.name }, { owner, repo: name }));
    if (pending) await acc.accept(pending.id);
    const r = pending ? pending.repository : await acc.repo(owner, name);
    if (r) {
      localStorage.removeItem(LS.invite);
      const sp = spaceFromRepo(r);
      if (inv.k) { try { const key = await keyFromText(inv.k); S.keys.set(sp.id, key); await rememberKey(sp.id, key); } catch { /* bad key in link: ask for the passphrase */ } }
      toast(t('home.joined', { name: sp.title || r.name }));
      return openSpace(sp);
    }
    if (!inv.asked) {
      try { await acc.requestJoin(inv.id); } catch (e) {
        if (e.status === 404 && !(await acc.readInvite(inv.id))) return set('gone');
        if (e.status === 403 || e.status === 404) return set('scope');
        throw e;
      }
      inv.asked = true;
    }
    set('waiting');
  } catch (e) { console.warn('join', e); }
  finally { joinBusy = false; }
}
setInterval(() => { if (S.auth && load(LS.invite, null)?.accepted && !$('#welcome').hidden && $('#homeJoin')) joinTick(); }, 3000);

function spaceSheet() {
  const recent = S.spaces.filter(x => tokenFor(x));
  const sh = openSheet(`<h2>${t('home.title')}</h2><div>${recent.map(x => `<button class="list-btn" data-space="${esc(x.id)}"><span class="grow">${esc(x.title || x.repo)}<small>${esc(x.owner)}/${esc(x.repo)}</small></span>${x.id === S.space?.id ? '<span class="tick">✓</span>' : ''}</button>`).join('')}
    ${S.auth ? `<button class="list-btn" data-act="home"><span class="grow" style="color:var(--primary)">${t('set.allAlbums')}</span></button>` : ''}
    <button class="list-btn" data-act="addSpace"><span class="grow" style="color:${S.auth ? 'var(--muted)' : 'var(--primary)'}">+ ${t('welcome.tokenAdvanced')}</span></button></div>`);
  sh.onclick = e => {
    const b = e.target.closest('[data-space],[data-act]');
    if (!b) return;
    closeSheet();
    if (b.dataset.act === 'home') return showHome();
    if (b.dataset.act) return showWelcome({ adding: true });
    const sp = S.spaces.find(s => s.id === b.dataset.space);
    if (sp && sp.id !== S.space?.id) openSpace(sp);
  };
}

// ---------------- selection ----------------

// ---------------- statistics ----------------
// One series per chart, one hue (the app's accent), recessive axes, the peak labelled,
// every bar a button with its value spoken and shown on hover/focus.

const monthShort = m => new Date(Date.UTC(2000, m, 1)).toLocaleDateString(locale(), { timeZone: 'UTC', month: 'short' });
const weekdayShort = d => new Date(Date.UTC(2000, 0, 2 + d)).toLocaleDateString(locale(), { timeZone: 'UTC', weekday: 'short' }); // 2000-01-02 was a Sunday

/** Vertical bars. items: [{ label, value, tip, attrs }] */
function vbarsHTML(items, { cls = '' } = {}) {
  const max = Math.max(1, ...items.map(i => i.value));
  const peak = items.findIndex(i => i.value === max && max > 0);
  return `<div class="vbars ${cls}" role="list">${items.map((it, k) => `<div class="vcol" role="listitem">
    <button class="vbar${it.value ? '' : ' zero'}" style="--h:${(it.value / max).toFixed(3)}" aria-label="${esc(it.tip)}" ${it.attrs || ''}${it.value ? '' : ' disabled'}>${k === peak ? `<span class="peak">${it.value}</span>` : ''}<i></i><span class="tip" aria-hidden="true">${esc(it.tip)}</span></button>
    <span class="vlbl">${esc(it.label)}</span></div>`).join('')}</div>`;
}

/** Ranked horizontal bars. rows: [{ label, value, lead? }] */
function hbarsHTML(rows) {
  const max = Math.max(1, ...rows.map(r => r.value));
  return `<div class="hbars">${rows.map(r => `<div class="hrow">${r.lead || ''}<span class="hlbl">${esc(r.label)}</span><span class="htrack"><i style="width:${Math.max(2, (r.value / max) * 100).toFixed(1)}%"></i></span><span class="hval">${r.value}</span></div>`).join('')}</div>`;
}

/** Tiny last-12-months bars for the Collections card. */
function statsSpark(list) {
  const now = new Date(), keys = [];
  for (let i = 11; i >= 0; i--) { const d = new Date(now.getFullYear(), now.getMonth() - i, 1); keys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`); }
  const n = keys.map(k => list.filter(p => (p.takenAt || '').startsWith(k)).length);
  const max = Math.max(1, ...n);
  return `<svg viewBox="0 0 120 80" aria-hidden="true">${n.map((v, i) => { const h = Math.max(2, (v / max) * 60); return `<rect x="${6 + i * 9.4}" y="${70 - h}" width="6.6" height="${h}" rx="2"/>`; }).join('')}</svg>`;
}

function showStats(year = null) {
  const all = S.album ? photos().filter(p => (p.albums || []).includes(S.album)) : photos();
  const st = C.photoStats(all);
  const y = st.years.find(x => x.year === year) || st.years[st.years.length - 1];
  const pct = n => (st.total ? Math.round((n / st.total) * 100) : 0);
  const tiles = [
    [t('stats.photos'), st.photos], [t('chip.videos'), st.videos], ['LIVE', st.lives],
    [t('stats.located'), `${pct(st.located)}%`], [t('stats.size'), C.fmtBytes(st.bytes)],
  ];
  const busiest = st.busiest ? t('stats.busiest', { m: fmtMonth(st.busiest[0]), n: st.busiest[1] }) : '';
  const sh = openSheet(`<h2>${t('stats.title')} <small>${esc(S.album ? S.index.albums[S.album]?.name : S.index.title || '')}</small></h2>
    <div class="stat-tiles">${tiles.map(([k, v]) => `<div class="stat-tile"><b>${v}</b><span>${k}</span></div>`).join('')}</div>
    ${y ? `<h4 class="sheet-h4">${t('stats.monthly')}</h4>
      <div class="year-chips">${st.years.slice().reverse().map(x => `<button class="chip${x === y ? ' on' : ''}" data-year="${x.year}">${x.year} <span class="n">${x.total}</span></button>`).join('')}</div>
      ${vbarsHTML(y.months.map((v, m) => ({ label: monthShort(m), value: v, tip: `${fmtMonth(`${y.year}-${String(m + 1).padStart(2, '0')}`)} · ${t('n.photos', { n: v })}`, attrs: `data-month="${y.year}-${String(m + 1).padStart(2, '0')}"` })))}
      <p class="stat-note">${busiest}${busiest ? ' · ' : ''}${t('stats.tapMonth')}</p>` : ''}
    ${st.years.length > 1 ? `<h4 class="sheet-h4">${t('stats.yearly')}</h4>${hbarsHTML(st.years.slice().reverse().map(x => ({ label: x.year, value: x.total })))}` : ''}
    ${y ? `<h4 class="sheet-h4">${t('stats.weekday')}</h4>${vbarsHTML(st.weekdays.map((v, d) => ({ label: weekdayShort(d), value: v, tip: `${weekdayShort(d)} · ${t('n.photos', { n: v })}` })), { cls: 'short' })}
      <h4 class="sheet-h4">${t('stats.hour')}</h4>${vbarsHTML(st.hours.map((v, h) => ({ label: h % 6 === 0 ? String(h) : '', value: v, tip: `${h}:00 · ${t('n.photos', { n: v })}` })), { cls: 'short dense' })}` : ''}
    ${st.people.length > 1 ? `<h4 class="sheet-h4">${t('stats.people')}</h4>${hbarsHTML(st.people.map(([login, n]) => ({ label: '@' + login, value: n, lead: `<img class="avatar sm" alt="" src="${esc(avatar(login))}" loading="lazy">` })))}` : ''}
    ${st.places.length ? `<h4 class="sheet-h4">${t('stats.places')}</h4>${hbarsHTML(st.places.slice(0, 6).map(x => ({ label: x.title, value: x.n })))}` : ''}
    ${st.tags.length ? `<h4 class="sheet-h4">${t('stats.tags')}</h4>${hbarsHTML(st.tags.slice(0, 8).map(([tg, n]) => ({ label: tagLabel(tg), value: n })))}` : ''}
    ${st.undated ? `<p class="stat-note">${t('stats.undated', { n: st.undated })}</p>` : ''}`, { kind: 'stats' });
  sh.onclick = e => {
    const yb = e.target.closest('[data-year]');
    if (yb) { const top = sh.scrollTop; showStats(yb.dataset.year); $('#sheet').scrollTop = top; return; }
    const mb = e.target.closest('[data-month]');
    if (mb) {
      closeSheet();
      S.filter.month = mb.dataset.month;
      S.view = 'date';
      showTab('photos');
      window.scrollTo(0, 0);
    }
  };
}

// ---------------- replace a photo: a new file, same place in the album ----------------

function pickReplacement(p) {
  if (U.running || CONV.running) return toast(t('up.busy'));
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'image/*,video/*,.heic,.heif,.mov';
  inp.multiple = true; // a Live Photo is two files
  inp.onchange = () => { if (inp.files.length) replaceSheet(p, [...inp.files]); };
  inp.click();
}

async function replaceSheet(p, files) {
  files = files.filter(f => !/\.(aae|xmp|json)$/i.test(f.name));
  let cancelled = false;
  openSheet(`<h2>${t('up.reading')}</h2><div class="progress"><i style="transform:scaleX(.5)"></i></div>`, { kind: 'replace', onClose: () => { cancelled = true; } });
  const items = [];
  for (let i = 0; i < files.length; i++) items.push(await analyzeFile(files[i], 'x' + i));
  const entries = buildEntries(items).filter(e => !e.main.error);
  if (cancelled) return;
  if (entries.length !== 1) { closeSheet(); return toast(t(entries.length ? 'replace.one' : 'replace.unreadable'), 4000); }
  const e = entries[0], m = e.main;
  if (m.hash && m.hash === p.hash) { closeSheet(); return toast(t('replace.same')); }
  const url = m.kind === 'photo' ? URL.createObjectURL(m.file) : '';
  const newDate = m.meta.takenAt && m.meta.takenAt !== p.takenAt, newGps = !!m.meta.gps && JSON.stringify(m.meta.gps) !== JSON.stringify(p.gps);
  openSheet(`<h2>${t('replace.title')}</h2>
    <div class="replace-pair"><figure>${thumbImg(p.files.thumb)}<figcaption>${t('replace.now')}</figcaption></figure><span aria-hidden="true">→</span><figure>${url ? `<img alt="" src="${url}">` : `<div class="ph">▶</div>`}<figcaption>${esc(m.name)}${e.live ? ' · LIVE' : ''}</figcaption></figure></div>
    <p class="sheet-p">${t('replace.keeps')}</p>
    ${newDate || newGps ? `<div class="row opt-row"><div class="grow"><b>${t('replace.useMeta')}</b><small>${[newDate ? fmtDate(m.meta.takenAt) : '', newGps ? t('info.place') : ''].filter(Boolean).join(' · ')}</small></div><label class="switch"><input type="checkbox" id="rpMeta"${!p.takenAt || p.dateSource !== 'exif' ? ' checked' : ''}><span></span></label></div>` : ''}
    <div class="row opt-row"><div class="grow"><b>${t('purge.also')}</b><small>${t('replace.purgeNote')}</small></div><label class="switch"><input type="checkbox" id="rpPurge"><span></span></label></div>
    <div class="actions"><button class="btn btn-quiet" data-close>${t('common.cancel')}</button><button class="btn btn-primary" id="rpGo">${t('replace.go')}</button></div>`,
  { kind: 'replace', onClose: () => url && URL.revokeObjectURL(url) });
  observeThumbs($('#sheet'));
  $('#rpGo').onclick = () => runReplace(p, e, { meta: !!$('#rpMeta')?.checked, purge: $('#rpPurge').checked });
}

async function runReplace(old, e, { meta, purge }) {
  const sp = S.space;
  const sh = openSheet(`<h2>${t('replace.working')}</h2><div class="progress"><i id="rpBar"></i></div>`, { kind: 'replace-run' });
  const done = () => { if (sheetOpen() && sh.dataset.kind === 'replace-run') closeSheet(); };
  const bar = $('#rpBar', sh);
  ringProgress(0);
  try {
    // setEntryStatus reports each file as it goes up
    const tick = () => { if (e.status?.k === 'uploading') { const f = (e.status.i - 1) / e.status.n; bar && (bar.style.transform = `scaleX(${f})`); ringProgress(f); } };
    const timer = setInterval(tick, 200);
    let photo, files;
    try { ({ photo, files } = await preparePhoto(e, { keepOriginal: !!(old.files.original && old.kind === 'photo') || prefs.keepOriginal, tags: [], album: null })); } finally { clearInterval(timer); }
    if (S.space !== sp) return;
    const set = Object.fromEntries(C.REPLACED.map(k => [k, photo[k]]));
    if (meta || !old.takenAt) Object.assign(set, { takenAt: photo.takenAt, tz: photo.tz, ts: photo.ts, dateSource: photo.dateSource });
    if ((meta || !old.gps) && photo.gps) set.gps = photo.gps;
    const op = { op: 'replacePhoto', id: old.id, set, at: new Date().toISOString(), by: S.me.login };
    await serial(async () => {
      const r = await S.gh.commit({ files, ops: [op], message: `Moa: replace ${old.name || 'photo'} — @${S.me.login}`, base: S.base, title: S.index?.title });
      if (S.space === sp) adopt(r);
    });
    ringDone();
    done();
    toast(t('replace.done'));
    runGeocodeJob();
    scheduleAi();
    if (purge) eraseHistory();
  } catch (err) {
    console.error(err);
    ringProgress(null);
    done();
    toast(t('replace.failed', { e: errMsg(err) }), 5000);
  }
}

// ---------------- album covers: the main photo (home screen) and each album's cover ----------------

const COVERS = 'moa.covers'; // album id → thumbnail path, so the home screen can show it without opening the album

function libraryCover() {
  const ix = S.index;
  return (ix?.cover && ix.photos[ix.cover]) || photos().sort((a, b) => C.sortTs(b) - C.sortTs(a))[0] || null;
}

function rememberCover() {
  if (!S.space || !S.gh) return;
  const m = load(COVERS, {});
  const v = S.gh.sealed ? null : libraryCover()?.files?.thumb || null; // an encrypted album's photos stay behind its lock
  if ((m[S.space.id] || null) === v) return;
  if (v) m[S.space.id] = v; else delete m[S.space.id];
  save(COVERS, m);
}

/** Home rows: each album's main photo, from this device's cache (fetched once if it's gone). */
function homeCovers(albums) {
  const m = load(COVERS, {});
  for (const r of albums) {
    const path = m[r.full_name.toLowerCase()];
    if (!path || isEncryptedRepo(r)) continue;
    const gh = new Repo({ owner: r.owner.login, repo: r.name, branch: r.default_branch, token: S.auth.token, api: loginApi() });
    gh.media(path).then(b => {
      const dot = $(`[data-repo="${CSS.escape(r.full_name)}"] .album-dot`);
      if (!dot) return;
      const img = new Image();
      img.alt = '';
      img.onload = () => { dot.classList.add('has-cover'); setTimeout(() => URL.revokeObjectURL(img.src), 1000); };
      img.src = URL.createObjectURL(b);
      dot.append(img);
    }).catch(() => {});
  }
}

/** Pick one photo from a list (album cover, main photo). */
function pickPhotoSheet(title, list, current, onPick) {
  const sorted = [...list].sort((a, b) => C.sortTs(b) - C.sortTs(a));
  const sh = openSheet(`<h2>${esc(title)}</h2><div class="grid pick-grid" style="margin:0 -20px">${sorted.map(p => tileHTML(p).replace('class="tile', `class="tile${p.id === current ? ' current' : ''}`)).join('')}</div>`, { kind: 'cluster' });
  observeThumbs(sh);
  sh.onclick = e => { const tile = e.target.closest('.tile'); if (tile) { closeSheet(); onPick(tile.dataset.id); } };
}

function mainCoverSheet() {
  pickPhotoSheet(t('cover.main'), photos(), S.index.cover, id => { edit({ op: 'setCover', photo: id }); toast(t('cover.mainSet')); });
}

function albumCoverSheet(albumId) {
  const inAlbum = photos().filter(p => (p.albums || []).includes(albumId));
  if (!inAlbum.length) return toast(t('empty.album'));
  pickPhotoSheet(t('cover.album'), inAlbum, S.index.albums[albumId]?.cover, id => { edit({ op: 'setCover', album: albumId, photo: id }); toast(t('info.coverSet')); });
}

function setSelecting(on) {
  S.selecting = on;
  if (!on) S.selected.clear();
  $('#app').classList.toggle('selecting', on);
  $('#selectBtn').textContent = t(on ? 'common.done' : 'select');
  $('#selectBar').hidden = !on;
  $('#tabbar').hidden = on;
  $$('.tile.sel').forEach(t => { if (!S.selected.has(t.dataset.id)) t.classList.remove('sel'); });
  updateSelCount();
}
function updateSelCount() { $('#selCount').textContent = t('selected', { n: S.selected.size }); }

function tagSheet(ids) {
  const existing = C.tagCounts(photos()).filter(([tg]) => !C.isSymbolTag(tg)).slice(0, 24);
  const sh = openSheet(`<h2>${t('tags.title')} <small>${t('n.photos', { n: ids.length })}</small></h2>
    <h4 class="sheet-h4">${t('marks.title')}</h4>${marksRowHTML([])}
    <label class="field"><span>${t('tags.new')}</span><input id="tagIn" placeholder="${t('tags.ph')}" enterkeyhint="done" autocomplete="off"></label>
    <div class="tag-suggest" id="tagSug"></div>
    ${existing.length ? `<div class="tag-suggest">${existing.map(([tg]) => `<button class="chip" data-t="${esc(tg)}">#${esc(tg)}</button>`).join('')}</div>` : ''}
    <div class="actions"><button class="btn btn-quiet" data-close>${t('common.cancel')}</button><button class="btn btn-primary" id="tagOk">${t('common.add')}</button></div>`);
  const inp = $('#tagIn', sh);
  setTimeout(() => inp.focus(), 50);
  bindTagSuggest(inp, $('#tagSug', sh), tg => {
    const parts = inp.value.split(/[,，]/); parts.pop();
    inp.value = [...parts.map(x => x.trim()).filter(Boolean), tg].join(', ') + ', ';
    inp.focus();
  });
  sh.addEventListener('click', e => {
    const c = e.target.closest('[data-t]'); if (c) c.classList.toggle('on');
    const m = e.target.closest('[data-mark]'); if (m) { m.classList.toggle('on'); m.setAttribute('aria-pressed', m.classList.contains('on')); }
  });
  const ok = () => {
    const tags = [...inp.value.split(/[,，]/), ...$$('.chip.on', sh).map(c => c.dataset.t), ...$$('.mark.on', sh).map(c => c.dataset.mark)].map(C.normalizeTag).filter(Boolean);
    if (!tags.length) return inp.focus();
    for (const tg of new Set(tags)) edit({ op: 'tag', ids, tag: tg, on: true });
    closeSheet();
    toast(t('tags.done', { n: ids.length }));
    setSelecting(false);
  };
  $('#tagOk', sh).onclick = ok;
  inp.onkeydown = e => { if (e.key === 'Enter') ok(); };
}

function deletePhotos(ids, after) {
  const sh = openSheet(`<h2>${t('delete.confirm', { n: ids.length })}</h2>
    <div class="row opt-row"><div class="grow"><b>${t('purge.also')}</b></div><label class="switch"><input type="checkbox" id="delPurge"><span></span></label></div>
    <div class="actions"><button class="btn btn-quiet" data-close>${t('common.cancel')}</button><button class="btn btn-danger" id="delOk">${t('common.delete')}</button></div>`);
  $('#delOk', sh).onclick = () => {
    const purge = $('#delPurge', sh).checked;
    closeSheet();
    edit({ op: 'deletePhotos', ids });
    after?.();
    if (purge) eraseHistory();
  };
}

// ---------------- erase history · encryption ----------------

/** Paths and index blobs the album still uses: the local cache keeps only these. */
function keepSet(st) {
  const keep = new Set();
  for (const p of Object.values(st.index?.photos || {})) for (const f of C.filesOf(p)) keep.add(f);
  for (const f of st.files?.values() || []) if (f.sha) keep.add('.blob/' + f.sha);
  return keep;
}

async function eraseHistory() {
  const sp = S.space;
  await flush(); // the delete lands first
  if (S.space !== sp) return;
  if (S.pending.length) return toast(t('purge.failed', { e: t('purge.unsaved') }), 4000);
  setSync('purging');
  try {
    await serial(async () => {
      const head = await S.gh.purgeHistory(`Moa: erase history — @${S.me?.login || ''}`);
      if (S.space !== sp) return;
      const st = await S.gh.state(head);
      if (S.space !== sp) return;
      adopt(st);
      await S.gh.pruneCache(keepSet(st)).catch(() => {});
    });
    setSync(null);
    toast(t('purge.done'));
  } catch (e) {
    console.error(e);
    setSync('error');
    toast(t('purge.failed', { e: errMsg(e) }), 5000);
  }
}

function purgeSheet() {
  const sh = openSheet(`<h2>${t('purge.confirm')}</h2><p class="sheet-p">${t('purge.body')}</p>
    <div class="actions"><button class="btn btn-quiet" data-close>${t('common.cancel')}</button><button class="btn btn-danger" id="purgeOk">${t('purge.go')}</button></div>`);
  $('#purgeOk', sh).onclick = () => { closeSheet(); eraseHistory(); };
}

/** Commit a new album.json (wrapped keys) for an encrypted album. */
async function saveHeader(header, message) {
  const sp = S.space;
  await serial(async () => {
    const sha = await S.gh.blob(textToBase64(JSON.stringify(header, null, 2) + '\n'));
    const r = await S.gh.commit({ files: [{ path: C.META_PATH, sha }], message: `${message} — @${S.me?.login || ''}`, base: S.base, title: S.index?.title });
    S.gh.header = header;
    if (S.space === sp) adopt(r);
  });
}

function recoverySheet(code) {
  const sh = openSheet(`<h2>${t('rec.title')}</h2><p class="sheet-p">${t('rec.body')}</p>
    <div class="code-box" id="rcCode">${esc(code)}</div>
    <div class="actions"><button class="btn btn-quiet" id="rcCopy">${t('common.copy')}</button><button class="btn btn-quiet" id="rcSave">${t('rec.save')}</button></div>
    <button class="btn btn-primary btn-block" data-close style="margin-top:10px">${t('common.done')}</button>`, { kind: 'recovery' });
  $('#rcCopy', sh).onclick = async () => { try { await navigator.clipboard.writeText(code); toast(t('common.copied')); } catch { getSelection().selectAllChildren($('#rcCode', sh)); } };
  $('#rcSave', sh).onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([`Moa — ${S.space.owner}/${S.space.repo}\n${t('rec.title')}: ${code}\n`], { type: 'text/plain' }));
    a.download = `moa-recovery-${S.space.repo}.txt`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  };
}

function newRecoverySheet() {
  const had = hasRecovery(S.gh.header);
  const sh = openSheet(`<h2>${t('rec.title')}</h2><p class="sheet-p">${t(had ? 'rec.replace' : 'rec.none')}</p>
    ${had ? `<div class="row opt-row"><div class="grow"><b>${t('purge.also')}</b></div><label class="switch"><input type="checkbox" id="rcPurge" checked><span></span></label></div>` : ''}
    <div class="actions"><button class="btn btn-quiet" data-close>${t('common.cancel')}</button><button class="btn btn-primary" id="rcNew">${t(had ? 'rec.new' : 'rec.create')}</button></div>`);
  $('#rcNew', sh).onclick = async () => {
    const btn = $('#rcNew', sh);
    btn.disabled = true;
    const purge = !!$('#rcPurge', sh)?.checked;
    try {
      const code = newRecoveryCode();
      await saveHeader(await withRecovery(S.gh.header, S.gh.key, code), 'Moa: new recovery code');
      recoverySheet(code);
      if (purge) eraseHistory(); // the old code's copy of the key stays in history until erased
    } catch (e) { btn.disabled = false; toast(errMsg(e), 4000); }
  };
}

/** forgot: this device holds the key, so the old passphrase isn't needed. */
function passphraseSheet({ forgot = false, title } = {}) {
  const sh = openSheet(`<h2>${title || t('enc.change')}</h2>
    <label class="field" id="ppOldBox"${forgot ? ' hidden' : ''}><span>${t('enc.current')}</span><input id="ppOld" type="password" autocomplete="current-password"></label>
    ${forgot ? '' : `<button class="text-btn forgot" id="ppForgot">${t('lock.forgot')}</button>`}
    <label class="field"><span>${t('enc.new')}</span><input id="encPass" type="password" autocomplete="new-password"></label>
    <label class="field"><span>${t('enc.pass2')}</span><input id="encPass2" type="password" autocomplete="new-password"></label>
    <div class="row opt-row"><div class="grow"><b>${t('purge.also')}</b></div><label class="switch"><input type="checkbox" id="ppPurge" checked><span></span></label></div>
    <p class="err" id="ppErr" hidden></p>
    <div class="actions"><button class="btn btn-quiet" data-close>${t('common.cancel')}</button><button class="btn btn-primary" id="ppOk">${t('common.save')}</button></div>`);
  setTimeout(() => $(forgot ? '#encPass' : '#ppOld', sh).focus(), 50);
  $('#ppForgot', sh)?.addEventListener('click', () => { forgot = true; $('#ppOldBox', sh).hidden = true; $('#ppForgot', sh).remove(); $('#encPass', sh).focus(); });
  $('#ppOk', sh).onclick = async () => {
    const err = $('#ppErr', sh);
    const fail = m => { err.textContent = m; err.hidden = false; };
    const a = $('#encPass', sh).value;
    if (a.length < 8) return fail(t('enc.short'));
    if (a !== $('#encPass2', sh).value) return fail(t('enc.mismatch'));
    const btn = $('#ppOk', sh);
    btn.disabled = true; btn.textContent = t('lock.unlocking');
    try {
      const header = forgot ? await setPassphrase(S.gh.header, S.gh.key, a) : await rewrapAlbumKey(S.gh.header, $('#ppOld', sh).value, a);
      await saveHeader(header, 'Moa: change passphrase');
      const purge = $('#ppPurge', sh).checked;
      closeSheet();
      toast(t('enc.changed'));
      // the old wrapped key stays in history until it's erased
      if (purge) eraseHistory();
    } catch (e) {
      btn.disabled = false; btn.textContent = t('common.save');
      fail(e instanceof BadPassphrase ? t('lock.wrong') : errMsg(e));
    }
  };
}

// ---------------- encryption on / off for an existing album ----------------
// Every file is fetched, re-stored in the other form under a new path, then one
// commit swaps the whole album over. Progress survives a closed tab (the map of
// converted files is kept per album), so a long run resumes where it stopped.

const CONV = { running: false, done: 0, total: 0 };
const LIVE_EXT = { 'video/quicktime': 'mov', 'video/mp4': 'mp4', 'video/webm': 'webm' };

function plainPath(p, kind) {
  const ym = C.mediaDir(p.takenAt || p.uploadedAt);
  if (kind === 'preview') return `preview/${ym}/${p.id}.jpg`;
  if (kind === 'thumb') return `thumb/${ym}/${p.id}.jpg`;
  if (kind === 'live') return `media/${ym}/${p.id}.live.${LIVE_EXT[p.liveMime] || 'mov'}`;
  return `media/${ym}/${p.id}.${C.extOf(p.name) || (p.kind === 'video' ? 'mp4' : 'jpg')}`;
}

const isOwner = () => !!S.repoInfo?.permissions?.admin;

function convertProgress(toSealed) {
  const label = t(toSealed ? 'conv.encrypting' : 'conv.decrypting');
  setSync('converting', `${label} ${CONV.done}/${CONV.total}`);
  ringProgress(CONV.total ? CONV.done / CONV.total : 0);
  const sh = $('#sheet');
  if (sh.dataset.kind !== 'convert') return;
  $('#cvCount', sh).textContent = `${CONV.done}/${CONV.total}`;
  $('#cvBar', sh).style.transform = `scaleX(${CONV.total ? CONV.done / CONV.total : 0})`;
}

async function convertAlbum(toSealed, { pass = null, purge = true } = {}) {
  if (CONV.running || U.running) return toast(t('up.busy'));
  const sp = S.space, gh = S.gh;
  let job = load(LS.convert(sp.id), null);
  if (job && job.toSealed !== toSealed) job = null;
  let target = null;
  CONV.running = true;
  try {
    if (toSealed) {
      let key = job ? await recallKey('convert:' + sp.id) : null;
      if (!job || !key) {
        if (!pass) { localStorage.removeItem(LS.convert(sp.id)); throw new Error(t('conv.restart')); }
        const made = await createAlbumKey(pass);
        const recovery = newRecoveryCode();
        job = { toSealed, header: await withRecovery(made.header, made.key, recovery), recovery, map: {} };
        key = made.key;
        await rememberKey('convert:' + sp.id, key);
        save(LS.convert(sp.id), job);
      }
      target = { header: job.header, key };
    } else if (!job) {
      job = { toSealed, map: {} };
      save(LS.convert(sp.id), job);
    }
    openSheet(`<h2>${t(toSealed ? 'conv.encrypting' : 'conv.decrypting')} <small id="cvCount"></small></h2><div class="progress"><i id="cvBar"></i></div>`, { kind: 'convert' });
    let r;
    for (;;) {
      const todo = Object.values(S.base.index.photos).flatMap(p => Object.entries(p.files || {}).filter(([k, v]) => v && !k.endsWith('Mime') && !(v in job.map)).map(([k, v]) => ({ p, k, path: v })));
      CONV.total = Object.keys(job.map).length + todo.length;
      CONV.done = Object.keys(job.map).length;
      convertProgress(toSealed);
      let n = 0;
      for (const { p, k, path } of todo) {
        if (S.space !== sp) throw new Error(t('conv.paused'));
        let entry = null;
        try {
          const blob = await gh.media(path, { cache: k === 'thumb' || k === 'preview' });
          const to = toSealed ? C.sealedPath() : plainPath(p, k);
          entry = { path: to, sha: await gh.putMediaWith(blob, target?.key || null) };
        } catch (e) { if (e.status !== 404) throw e; }
        job.map[path] = entry;
        CONV.done++;
        if (++n % 6 === 0) save(LS.convert(sp.id), job);
        convertProgress(toSealed);
      }
      save(LS.convert(sp.id), job);
      const title = S.base.index.title || '';
      r = await serial(() => gh.convertCommit({ map: job.map, target, readme: repoReadme(toSealed ? null : title), message: `Moa: ${toSealed ? 'encrypt' : 'decrypt'} album — @${S.me?.login || ''}` }));
      if (!r.missing) break;
      adopt(r.st); // a friend added photos meanwhile: convert those too
    }
    localStorage.removeItem(LS.convert(sp.id));
    forgetKey('convert:' + sp.id);
    if (toSealed) { S.keys.set(sp.id, target.key); await rememberKey(sp.id, target.key); } else { S.keys.delete(sp.id); forgetKey(sp.id); }
    adopt(r.state);
    const description = toSealed ? ENCRYPTED_DESCRIPTION : `${S.index.title} · Moa`;
    gh.setDescription(description).then(() => { if (S.repoInfo) S.repoInfo.description = description; }).catch(() => {});
    CONV.running = false;
    setSync(null);
    ringDone();
    toast(t(toSealed ? 'conv.encrypted' : 'conv.decrypted'));
    notify(S.index?.title || 'Moa', t(toSealed ? 'conv.encrypted' : 'conv.decrypted'));
    if (toSealed) recoverySheet(job.recovery); else closeSheet();
    // encrypting only helps once the plain copies are gone from history too
    if (toSealed || purge) await eraseHistory();
    rerender();
  } catch (e) {
    console.error(e);
    CONV.running = false;
    ringProgress(null);
    setSync('error');
    if ($('#sheet').dataset.kind === 'convert') closeSheet();
    toast(t('conv.failed', { e: errMsg(e) }), 5000);
    rerender();
  }
}

function encryptAlbumSheet() {
  if (load(LS.convert(S.space.id), null)?.toSealed) return convertAlbum(true);
  const sh = openSheet(`<h2>${t('conv.encryptTitle')}</h2><p class="sheet-p">${t('conv.encryptBody')}</p>
    <label class="field"><span>${t('enc.pass')}</span><input id="encPass" type="password" autocomplete="new-password"></label>
    <label class="field"><span>${t('enc.pass2')}</span><input id="encPass2" type="password" autocomplete="new-password"><small>${t('enc.lost')}</small></label>
    <p class="err" id="cvErr" hidden></p>
    <div class="actions"><button class="btn btn-quiet" data-close>${t('common.cancel')}</button><button class="btn btn-primary" id="cvGo">${t('conv.encrypt')}</button></div>`);
  setTimeout(() => $('#encPass', sh).focus(), 50);
  $('#cvGo', sh).onclick = () => {
    const a = $('#encPass', sh).value, err = $('#cvErr', sh);
    if (a.length < 8) { err.textContent = t('enc.short'); err.hidden = false; return; }
    if (a !== $('#encPass2', sh).value) { err.textContent = t('enc.mismatch'); err.hidden = false; return; }
    convertAlbum(true, { pass: a });
  };
}

function decryptAlbumSheet() {
  if (load(LS.convert(S.space.id), null)?.toSealed === false) return convertAlbum(false);
  const sh = openSheet(`<h2>${t('conv.decryptTitle')}</h2><p class="sheet-p">${t('conv.decryptBody')}</p>
    <div class="row opt-row"><div class="grow"><b>${t('purge.also')}</b></div><label class="switch"><input type="checkbox" id="cvPurge" checked><span></span></label></div>
    <div class="actions"><button class="btn btn-quiet" data-close>${t('common.cancel')}</button><button class="btn btn-danger" id="cvGo">${t('conv.decrypt')}</button></div>`);
  $('#cvGo', sh).onclick = () => convertAlbum(false, { purge: $('#cvPurge', sh).checked });
}

// ---------------- Face ID / Touch ID: a passkey that opens an encrypted album ----------------

const IS_IOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
function bioName() {
  const ua = navigator.userAgent;
  if (IS_IOS()) return 'Face ID';
  if (/Macintosh/.test(ua)) return 'Touch ID';
  if (/Windows/.test(ua)) return 'Windows Hello';
  if (/Android/.test(ua)) return t('pk.android');
  return t('pk.generic');
}
function deviceLabel() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (IS_IOS()) return 'iPad';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Android/.test(ua)) return 'Android';
  if (/Windows/.test(ua)) return 'Windows';
  return t('pk.device');
}
const myPasskey = () => { const id = load(LS.passkey(S.space.id), null); return passkeySlots(S.gh.header).find(x => x.id === id) || null; };
function passkeyStatus() {
  const n = passkeySlots(S.gh.header).length;
  return myPasskey() ? t('pk.onHere', { n }) : n ? t('pk.others', { n }) : t('pk.off');
}

async function passkeySheet() {
  const slots = passkeySlots(S.gh.header), mine = myPasskey(), name = bioName();
  const ok = await passkeyAvailable();
  const sh = openSheet(`<h2>${esc(t('pk.title', { name }))}</h2>
    <p class="sheet-p">${esc(t('pk.body', { name }))}</p>
    ${slots.length ? `<div class="panel pk-list">${slots.map(x => `<div class="row"><span class="grow"><b>${esc(x.label || t('pk.device'))}${x.id === mine?.id ? ` · ${t('pk.thisDevice')}` : ''}</b><small>@${esc(x.by || '')} · ${fmtDate(x.at)}</small></span>${S.canWrite ? `<button class="text-btn danger" data-pk-del="${esc(x.id)}">${t('common.delete')}</button>` : ''}</div>`).join('')}</div>` : ''}
    ${!ok ? `<p class="err">${esc(t('pk.unsupported', { name }))}</p>` : ''}
    <p class="err" id="pkErr" hidden></p>
    <div class="actions"><button class="btn btn-quiet" data-close>${t('common.close')}</button>${ok && !mine && S.canWrite ? `<button class="btn btn-primary" id="pkAdd">${esc(t('pk.turnOn'))}</button>` : ''}</div>`);
  const fail = msg => { const e = $('#pkErr', sh); e.textContent = msg; e.hidden = false; };
  $('#pkAdd', sh)?.addEventListener('click', async e => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const { header, id } = await addPasskey(S.gh.header, S.gh.key, { title: S.index?.title || S.space.repo, user: S.me?.login || 'moa', label: deviceLabel(), by: S.me?.login || '' });
      await saveHeader(header, `Moa: add ${name} unlock`);
      save(LS.passkey(S.space.id), id);
      toast(t('pk.added', { name }));
      closeSheet();
      rerender();
    } catch (ex) {
      btn.disabled = false;
      if (ex instanceof NoPasskey && ex.message === 'cancelled') return;
      fail(ex instanceof NoPasskey ? t('pk.unsupported', { name }) : errMsg(ex));
    }
  });
  sh.addEventListener('click', async e => {
    const b = e.target.closest('[data-pk-del]');
    if (!b) return;
    b.disabled = true;
    try {
      await saveHeader(removePasskey(S.gh.header, b.dataset.pkDel), `Moa: remove ${name} unlock`);
      toast(t('pk.removed'));
      passkeySheet();
      rerender();
    } catch (ex) { b.disabled = false; fail(errMsg(ex)); }
  });
}

function lockHere() {
  const sp = S.space;
  S.keys.delete(sp.id);
  forgetKey(sp.id);
  S.gh.key = null;
  for (const k of [...resolved.keys()]) if (k.startsWith(sp.id + ':')) { URL.revokeObjectURL(resolved.get(k)); resolved.delete(k); urls.delete(k); }
  renderLocked(S.gh.header);
}

function renderLocked(header) {
  Object.assign(S, { index: null, head: null, base: null });
  showTab('photos', false);
  $('#hero').innerHTML = '';
  $('#toolbar').hidden = true;
  $('#uploadBtn').hidden = true;
  $('#uploadFab').hidden = true;
  $('#selectBtn').hidden = true;
  setSync(null);
  const c = $('#content');
  c.innerHTML = `<div class="empty locked-album"><div class="lock-hero">${ICON.lock}</div>
    <h2>${t('lock.title')}</h2>
    <div id="pkUnlockBox" style="max-width:340px;margin:0 auto 14px" hidden><button class="btn btn-primary btn-block" type="button" id="pkUnlock">${ICON.faceid}${esc(t('pk.unlock', { name: bioName() }))}</button><p class="or-line">${t('pk.or')}</p></div>
    <form id="unlockForm" autocomplete="off" style="max-width:340px;margin:0 auto;text-align:left">
      <label class="field" id="unlockPassBox"><span>${t('lock.pass')}</span><input id="unlockPass" type="password" autocomplete="current-password"></label>
      <label class="field" id="unlockCodeBox" hidden><span>${t('rec.title')}</span><input id="unlockCode" autocapitalize="characters" autocomplete="off" spellcheck="false" placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"></label>
      <div class="row opt-row"><div class="grow"><b>${t('lock.remember')}</b></div><label class="switch"><input type="checkbox" id="unlockRemember" checked><span></span></label></div>
      <p class="err" id="unlockErr" hidden></p>
      <button class="btn btn-primary btn-block" type="submit" id="unlockBtn">${t('lock.unlock')}</button>
      <button class="text-btn forgot" type="button" id="unlockForgot">${t('lock.forgot')}</button>
    </form></div>`;
  const sp = S.space;
  let viaCode = false;
  const opened = async (key, { remember, recovered = false }) => {
    if (S.space !== sp) return;
    S.gh.key = key;
    S.keys.set(sp.id, key);
    if (remember) rememberKey(sp.id, key);
    await serial(() => refresh(true));
    if (S.space !== sp) return;
    setSync(S.pending.length ? 'pending' : null);
    if (S.pending.length) scheduleFlush(500);
    // opened with the recovery code: the passphrase is lost, so set a new one now
    if (recovered && S.canWrite) passphraseSheet({ forgot: true, title: t('rec.setNew') });
    else resumeUploads();
  };
  // Face ID first when this album has passkeys; the passphrase form stays underneath
  if (passkeySlots(header).length) passkeyAvailable().then(ok => {
    if (!ok || S.space !== sp || !$('#pkUnlockBox')) return;
    $('#pkUnlockBox').hidden = false;
    $('#pkUnlock').onclick = async () => {
      const btn = $('#pkUnlock'), err = $('#unlockErr');
      err.hidden = true;
      btn.disabled = true;
      try {
        const { key, id } = await unlockWithPasskey(header);
        save(LS.passkey(sp.id), id); // this device (or its synced keychain) holds that passkey
        await opened(key, { remember: false });
      } catch (ex) {
        if (!$('#pkUnlock')) return;
        btn.disabled = false;
        // browsers answer "cancelled" and "no such passkey here" the same way, on purpose
        err.textContent = ex instanceof NoPasskey ? t(ex.message === 'cancelled' ? 'pk.notOpened' : 'pk.notHere', { name: bioName() }) : errMsg(ex);
        err.hidden = false;
      }
    };
  });
  setTimeout(() => { if ($('#pkUnlockBox')?.hidden !== false) $('#unlockPass')?.focus(); }, 50);
  $('#unlockForgot').onclick = () => {
    const err = $('#unlockErr');
    if (!hasRecovery(header)) { err.textContent = t('rec.missing'); err.hidden = false; return; }
    viaCode = !viaCode;
    $('#unlockPassBox').hidden = viaCode;
    $('#unlockCodeBox').hidden = !viaCode;
    $('#unlockForgot').textContent = t(viaCode ? 'lock.usePass' : 'lock.forgot');
    err.hidden = true;
    $(viaCode ? '#unlockCode' : '#unlockPass').focus();
  };
  $('#unlockForm').onsubmit = async e => {
    e.preventDefault();
    const btn = $('#unlockBtn'), err = $('#unlockErr');
    err.hidden = true;
    btn.disabled = true; btn.textContent = t('lock.unlocking');
    try {
      const key = viaCode ? await unlockWithRecovery(header, $('#unlockCode').value) : await unlockAlbumKey(header, $('#unlockPass').value);
      await opened(key, { remember: $('#unlockRemember').checked, recovered: viaCode });
    } catch (ex) {
      if (!$('#unlockBtn')) return;
      btn.disabled = false; btn.textContent = t('lock.unlock');
      err.textContent = ex instanceof BadPassphrase ? t(viaCode ? 'rec.wrong' : 'lock.wrong') : errMsg(ex);
      err.hidden = false;
      $(viaCode ? '#unlockCode' : '#unlockPass').select();
    }
  };
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
  if (p !== V.p) { if (V.p?.id === p.id && V.p.files?.thumb === p.files?.thumb) { V.p = p; viewerChrome(); if (V.info) renderInfo(); } else showCurrent(); }
}

function viewerChrome() {
  const p = V.p;
  const day = (p.takenAt || '').slice(0, 10);
  $('#vDate').textContent = /^\d{4}-\d{2}-\d{2}$/.test(day) ? fmtDay(day, false) : '';
  $('#vSub').textContent = [fmtTime(p.takenAt), p.place?.name || p.place?.label].filter(Boolean).join(' · ');
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
    } catch (e) { toast(t('viewer.videoFailed')); }
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
    } catch { toast(t('viewer.photoFailed')); }
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
  try { u = await mediaURL(p.files.live, playableType(p.liveMime || 'video/quicktime')); } catch { return toast(t('viewer.liveFailed')); }
  if (token !== V.token) return;
  const v = $('#vLive');
  if (v.dataset.src !== u) { v.src = u; v.dataset.src = u; }
  v.muted = !sound;
  try { v.currentTime = 0; } catch { /* not loaded yet */ }
  try {
    await v.play();
    if (token === V.token) stage().classList.add('live-on');
  } catch (e) {
    if (sound && e.name !== 'AbortError') toast(t('viewer.hevc'));
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
  toast(t('dl.start'));
  try {
    const blob = await S.gh.media(path, { cache: !!p.files.preview && path === p.files.preview });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = p.files.original ? (p.name || path.split('/').pop()) : C.baseOf(p.name || p.id) + '.jpg';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  } catch (e) { toast(t('dl.failed', { e: errMsg(e) })); }
}

function renderInfo() {
  const p = V.p;
  if (!p) return;
  const box = $('#vInfo');
  const scroll = box.scrollTop;
  const albums = Object.entries(S.index.albums);
  const allTags = C.tagCounts(photos()).map(([tg]) => tg).filter(tg => !C.isSymbolTag(tg) && !(p.tags || []).includes(tg)).slice(0, 10);
  const words = (p.tags || []).filter(tg => !C.isSymbolTag(tg));
  const day = (p.takenAt || '').slice(0, 10);
  const cam = [p.camera?.model || p.camera?.make, p.camera?.lens && p.camera.lens.replace(p.camera.model || '', '').trim()].filter(Boolean).join(' · ');
  const sizes = [p.w && p.h ? `${p.w} × ${p.h}` : '', p.size ? C.fmtBytes(p.size) : '', p.duration ? fmtDur(p.duration) : '', p.name].filter(Boolean).join(' · ');
  const w = S.canWrite;
  box.innerHTML = `<div class="grab"></div>
    ${w ? `<textarea id="iCap" rows="1" placeholder="${t('info.caption')}" maxlength="500">${esc(p.caption || '')}</textarea>` : p.caption ? `<div class="kv">${esc(p.caption)}</div>` : ''}
    ${p.ai?.length ? `<h4>${t('ai.tags')}</h4><div class="tagrow">${p.ai.map(k => `<span class="chip ai">${ICON.spark}${esc(labelName(k, lang()))}${w ? `<button data-i="unai" data-t="${esc(k)}" aria-label="${t('info.untag')}">✕</button>` : ''}</span>`).join('')}</div>` : ''}
    <h4>${t('info.tags')}</h4>
    ${w ? marksRowHTML(marksOf(p), marksOf(p)) : marksOf(p).length ? `<div class="marks-row">${marksOf(p).map(m => `<span class="mark on">${esc(m)}</span>`).join('')}</div>` : ''}
    ${words.length ? `<div class="tagrow">${words.map(tg => `<span class="chip">#${esc(tg)}${w ? `<button data-i="untag" data-t="${esc(tg)}" aria-label="${t('info.untag')}">✕</button>` : ''}</span>`).join('')}</div>` : ''}
    ${w ? `<input type="text" id="iTag" placeholder="${t('info.addTag')}" enterkeyhint="done" autocomplete="off">
    <div class="tag-suggest" id="iTagSug"></div>
    ${allTags.length ? `<div class="tag-suggest">${allTags.map(tg => `<button class="chip" data-i="tag" data-t="${esc(tg)}">+ ${esc(tg)}</button>`).join('')}</div>` : ''}` : ''}
    <h4>${t('info.date')} ${w ? `<button data-i="editDate">${t('common.edit')}</button>` : ''}</h4>
    <div class="kv" id="iDate">${/^\d{4}-\d{2}-\d{2}$/.test(day) ? fmtDay(day) : '—'} ${fmtTime(p.takenAt)}${p.tz ? `<small>UTC${p.tz}</small>` : ''}</div>
    <h4>${t('info.place')} ${w ? `<button data-i="editPlace">${t('common.edit')}</button>` : ''}</h4>
    <div id="iPlace">${p.gps ? `<div class="kv">${esc(p.place?.name || p.place?.label || '…')}<small>${esc([p.place?.name && p.place?.label, p.place?.country].filter(Boolean).join(', ') || `${p.gps.lat.toFixed(4)}, ${p.gps.lng.toFixed(4)}`)}</small></div><div class="mini-map" id="iMap"></div><button class="text-btn" data-i="onMap" style="padding-left:0;margin-top:4px">${t('info.onMap')}</button>` : '<div class="kv"><small>—</small></div>'}</div>
    <h4>${t('tab.albums')}</h4>
    <div>${albums.map(([id, a]) => `<label class="alb"><input type="checkbox" data-i="alb" data-a="${esc(id)}"${(p.albums || []).includes(id) ? ' checked' : ''}${w ? '' : ' disabled'}>${esc(a.name)}</label>`).join('')}${w ? `<button class="text-btn" data-i="newAlbum" style="padding-left:0">+ ${t('newAlbum.title')}</button>` : ''}</div>
    ${p.likes?.length ? `<h4>${t('chip.liked')} ${p.likes.length}</h4><div class="kv">${p.likes.map(l => '@' + esc(l)).join(', ')}</div>` : ''}
    <h4>${t('info.comments')} ${p.comments?.length || ''}</h4>
    <div>${(p.comments || []).map(c => `<div class="cmt"><b>@${esc(c.by)}</b><small>${fmtDate(c.at)}</small>${c.by === S.me?.login ? `<button class="del" data-i="uncomment" data-c="${esc(c.id)}">${t('common.delete')}</button>` : ''}<div>${esc(c.text)}</div></div>`).join('')}</div>
    ${w ? `<input type="text" id="iCmt" placeholder="${t('info.addComment')}" enterkeyhint="send" maxlength="500" style="margin-top:8px">` : ''}
    <h4>${t('info.details')}</h4>
    ${cam ? `<div class="kv">${esc(cam)}</div>` : ''}
    <div class="kv"><small>${esc(sizes)}</small></div>
    <div class="kv" style="margin-top:6px">@${esc(p.by || '')}<small>${fmtDate(p.uploadedAt)}</small></div>
    <div class="danger-zone">
      <button class="btn btn-quiet btn-sm" data-i="download">${t(p.files.original ? 'info.dlOriginal' : 'info.dlJpeg')}</button>
      ${p.files.live ? `<button class="btn btn-quiet btn-sm" data-i="downloadLive">${t('info.dlLive')}</button>` : ''}
      ${w && S.album ? `<button class="btn btn-quiet btn-sm" data-i="cover">${t('info.setCover')}</button>` : ''}
      ${w && !S.album ? `<button class="btn btn-quiet btn-sm" data-i="mainCover">${t('cover.setMain')}</button>` : ''}
      ${w ? `<button class="btn btn-quiet btn-sm" data-i="replace">${t('replace.btn')}</button>` : ''}
      ${w ? `<button class="btn btn-danger btn-sm" data-i="delete">${t('common.delete')}</button>` : ''}
    </div>`;
  box.scrollTop = scroll;

  V.miniMap?.remove(); V.miniMap = null;
  if (p.gps && window.L && $('#iMap')) {
    const m = V.miniMap = L.map('iMap', { zoomControl: false, dragging: false, scrollWheelZoom: false, doubleClickZoom: false, touchZoom: false, keyboard: false, boxZoom: false }).setView([p.gps.lat, p.gps.lng], 14);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(m);
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
  if (tagIn) bindTagSuggest(tagIn, $('#iTagSug', box), tg => {
    edit({ op: 'tag', ids: [p.id], tag: tg, on: true });
    tagIn.value = '';
    setTimeout(() => $('#iTag')?.focus(), 90);
  });
  const cmt = $('#iCmt', box);
  if (cmt) cmt.onkeydown = e => {
    if (e.key !== 'Enter' || e.isComposing || !cmt.value.trim()) return;
    edit({ op: 'comment', id: p.id, comment: { id: C.newId(), by: S.me.login, at: new Date().toISOString(), text: cmt.value.trim() } });
    cmt.value = '';
  };
  box.onclick = e => {
    const mk = w && e.target.closest('[data-mark]');
    if (mk) return edit({ op: 'tag', ids: [p.id], tag: mk.dataset.mark, on: !(p.tags || []).includes(mk.dataset.mark) });
    const b = e.target.closest('[data-i]');
    if (!b || b.tagName === 'INPUT' && b.type !== 'checkbox') return;
    switch (b.dataset.i) {
      case 'untag': return edit({ op: 'tag', ids: [p.id], tag: b.dataset.t, on: false });
      case 'unai': return edit({ op: 'aiTags', id: p.id, tags: (p.ai || []).filter(k => k !== b.dataset.t), v: p.aiv || AI_VERSION });
      case 'tag': return edit({ op: 'tag', ids: [p.id], tag: b.dataset.t, on: true });
      case 'alb': return edit({ op: 'albumMembership', ids: [p.id], album: b.dataset.a, on: b.checked });
      case 'newAlbum': return newAlbum(id => edit({ op: 'albumMembership', ids: [p.id], album: id, on: true }));
      case 'uncomment': return edit({ op: 'uncomment', id: p.id, commentId: b.dataset.c });
      case 'editDate': return editDate(p);
      case 'editPlace': return editPlace(p);
      case 'onMap': closeViewer(); S.view = 'map'; S.mapFocus = [p.gps.lat, p.gps.lng]; S.album = null; S.filter = { kind: '', tag: '', q: '' }; showTab('photos'); return;
      case 'download': return download(p);
      case 'downloadLive': return download({ ...p, name: C.baseOf(p.name || p.id) + '.' + C.extOf(p.files.live), files: { original: p.files.live } });
      case 'cover': edit({ op: 'setCover', album: S.album, photo: p.id }); return toast(t('info.coverSet'));
      case 'mainCover': edit({ op: 'setCover', photo: p.id }); return toast(t('cover.mainSet'));
      case 'replace': return pickReplacement(p);
      case 'delete': {
        const id = p.id;
        deletePhotos([id], () => { if (V.list.length <= 1) closeViewer(); });
      }
    }
  };
}

function editDate(p) {
  const el = $('#iDate');
  el.innerHTML = `<input type="datetime-local" step="1" id="iDateIn" value="${esc((p.takenAt || '').slice(0, 19))}"><div style="display:flex;gap:8px;margin-top:8px"><button class="btn btn-quiet btn-sm" id="iDateCancel">${t('common.cancel')}</button><button class="btn btn-primary btn-sm" id="iDateOk">${t('common.save')}</button></div>`;
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
  el.innerHTML = `<input type="search" id="iPlaceIn" placeholder="${t('place.search')}" enterkeyhint="search"><div id="iPlaceRes" style="margin-top:6px"></div>
    <div style="display:flex;gap:8px;margin-top:8px"><button class="btn btn-quiet btn-sm" id="iPlaceCancel">${t('common.cancel')}</button>${p.gps ? `<button class="btn btn-danger btn-sm" id="iPlaceClear">${t('place.clear')}</button>` : ''}</div>`;
  const inp = $('#iPlaceIn');
  inp.focus();
  $('#iPlaceCancel').onclick = () => renderInfo();
  $('#iPlaceClear')?.addEventListener('click', () => edit({ op: 'updatePhoto', id: p.id, set: { gps: null, place: null } }));
  let results = [];
  inp.onkeydown = async e => {
    if (e.key !== 'Enter' || e.isComposing) return;
    const res = $('#iPlaceRes');
    res.innerHTML = `<div class="kv"><small>${t('place.searching')}</small></div>`;
    try { results = await searchPlaces(inp.value); } catch { results = []; }
    res.innerHTML = results.map((r, i) => `<button class="result" data-r="${i}">${esc(r.place?.name || r.place?.label || r.display)}<small>${esc(r.display)}</small></button>`).join('') || `<div class="kv"><small>${t('place.noResults')}</small></div>`;
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
  if (!S.index) return;
  if (!S.canWrite) return toast(t('readonly'));
  if (U.running || CONV.running) return toast(t('up.busy'));
  const files = [...fileList].filter(f => !/\.(aae|xmp|json)$/i.test(f.name));
  if (!files.length) return;
  const sh = openSheet(`<h2>${t('up.reading')}</h2><p class="up-summary" id="anaText">0 / ${files.length}</p><div class="progress"><i id="anaBar"></i></div>`, { kind: 'upload' });
  const items = [];
  for (let i = 0; i < files.length; i++) {
    items.push(await analyzeFile(files[i], 'f' + i));
    if ($('#anaBar', sh)) { $('#anaBar', sh).style.transform = `scaleX(${(i + 1) / files.length})`; $('#anaText', sh).textContent = `${i + 1} / ${files.length}`; }
  }
  const entries = buildEntries(items);
  const hashes = new Set(photos().map(p => p.hash).filter(Boolean));
  const seen = new Set();
  for (const e of entries) {
    e.dup = !!e.main.hash && (hashes.has(e.main.hash) || seen.has(e.main.hash));
    if (e.main.hash) seen.add(e.main.hash);
    e.skip = !!e.main.error || e.dup;
    e.main.tooBig = !!e.main.tooBig;
    e.status = e.skip ? (e.main.error ? { k: 'err', text: e.main.error } : { k: 'dup' }) : null;
  }
  U.entries = entries;
  showUploadSheet(true);
}

function showUploadSheet(review) {
  const E = U.entries;
  const go = E.filter(e => !e.skip);
  const n = k => go.filter(k).length;
  const summary = [
    t('hero.photos', { n: n(e => e.main.kind === 'photo') }),
    n(e => e.live) ? t('hero.live', { n: n(e => e.live) }) : '',
    n(e => e.main.kind === 'video') ? t('hero.videos', { n: n(e => e.main.kind === 'video') }) : '',
    t('up.withLocation', { n: n(e => e.main.meta.gps) }),
    E.filter(e => e.dup).length ? t('up.dups', { n: E.filter(e => e.dup).length }) : '',
    E.filter(e => e.main.error).length ? t('up.errors', { n: E.filter(e => e.main.error).length }) : '',
  ].filter(Boolean).join(' · ');
  const albums = Object.entries(S.index.albums);
  const thumbs = E.slice(0, 200).map(e => {
    const m = e.main;
    e.url ||= m.kind === 'photo' ? URL.createObjectURL(m.file) : '';
    return `<div class="up-item${e.skip ? ' skip' : ''}" id="up-${m.key}">${e.url ? `<img alt="" src="${e.url}" loading="lazy">` : ''}
      <div class="flags">${Math.max(m.size, e.live?.size || 0) >= LIM.LIMITS.apiUpload ? `<b class="big">${t('up.large')}</b>` : ''}${e.live ? '<b class="live">LIVE</b>' : ''}${m.kind === 'video' ? '<b>▶</b>' : ''}${m.meta.gps ? `<b class="gps">${t('info.place')}</b>` : ''}</div>
      <span class="nm">${esc(m.name)}</span>${statusHTML(e)}</div>`;
  }).join('');
  const sh = openSheet(`<h2>${review ? t('up.title', { n: go.length }) : t('up.uploading')} ${review ? '' : `<small id="upCount">${U.done}/${U.total}</small>`}</h2>
    <p class="up-summary">${summary}</p>
    ${review ? `<div id="upPlan">${uploadPlanHTML(E, prefs.keepOriginal).html}</div>` : ''}
    ${!review ? `<div class="progress"><i id="upBar" style="transform:scaleX(${U.total ? (U.done + U.failed) / U.total : 0})"></i></div>` : ''}
    <div class="up-list">${thumbs}</div>${E.length > 200 ? `<p class="up-summary">+${E.length - 200}</p>` : ''}
    ${!review && U.running ? `<div class="actions"><button class="btn btn-quiet" id="upStop"${U.stop ? ' disabled' : ''}>${t(U.stop ? 'up.stopping' : 'up.stop')}</button></div>` : ''}
    ${review ? `
      <label class="field"><span>${t('tab.albums')}</span><select id="upAlbum"><option value="">${t('up.libraryOnly')}</option>${albums.map(([id, a]) => `<option value="${esc(id)}"${id === S.album ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>
      <label class="field"><span>${t('info.tags')}</span><input id="upTags" placeholder="${t('tags.ph')}"></label>
      <div class="row" style="padding:4px 4px 12px;border:0"><div class="grow"><b style="font-size:15px">${t('opt.keepOriginal')}</b></div><label class="switch"><input type="checkbox" id="upOrig"${prefs.keepOriginal ? ' checked' : ''}><span></span></label></div>
      <div class="actions"><button class="btn btn-quiet" data-close>${t('common.cancel')}</button><button class="btn btn-primary" id="upGo"${go.length ? '' : ' disabled'}>${t('up.go')}</button></div>` : ''}`,
  { kind: 'upload', onClose: () => { if (!U.running) cleanupUpload(); else updatePill(); } });
  $('#upPill').hidden = true;
  $('#upStop', sh)?.addEventListener('click', e => { U.stop = true; e.target.disabled = true; e.target.textContent = t('up.stopping'); });
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

/** Per-item status chip: { k: 'dup'|'err'|'processing'|'uploading'|'queued'|'saving'|'done'|'fail', text?, i?, n? } */
function statusHTML(e) {
  const st = e.status;
  if (!st) return '';
  const label = st.k === 'err' ? st.text : t('up.st.' + st.k, st);
  return `<span class="st${st.k === 'done' ? ' done' : st.k === 'fail' ? ' fail' : ''}">${esc(label)}</span>`;
}

function setEntryStatus(e, k, extra = {}) {
  e.status = { k, ...extra };
  const el = document.getElementById('up-' + e.main.key);
  if (el) {
    el.querySelector('.st')?.remove();
    el.insertAdjacentHTML('beforeend', statusHTML(e));
  }
  const bar = $('#upBar'); if (bar) bar.style.transform = `scaleX(${(U.done + U.failed) / U.total})`;
  if (U.running) ringProgress((U.done + U.failed + (k === 'uploading' ? (extra.i - 1) / extra.n : 0)) / U.total);
  const cnt = $('#upCount'); if (cnt) cnt.textContent = `${U.done}/${U.total}`;
  updatePill();
}

function updatePill() {
  const pill = $('#upPill');
  const sheetOpen = $('#sheet').dataset.kind === 'upload';
  pill.hidden = !U.running || sheetOpen;
  pill.textContent = `${t('up.uploading')} ${U.done}/${U.total}`;
}

async function startUpload(opts, { resumed = false } = {}) {
  if (!resumed) askNotify(); // still inside the tap on "Upload"
  const list = U.entries.filter(e => !e.skip);
  Object.assign(U, { running: true, done: 0, failed: 0, total: list.length, stop: false });
  ringProgress(0);
  const sp = S.space;
  showUploadSheet(false);
  let wake = null;
  try { wake = await navigator.wakeLock?.request('screen'); } catch { /* not supported */ }
  // keep a copy on the device until each photo's commit lands, so a closed app can pick up again
  if (!resumed) { try { await Q.enqueue(sp.id, list, opts); } catch (err) { console.warn('upload queue unavailable', err); } }
  const batch = { files: [], photos: [], entries: [], bytes: 0 };
  const commitBatch = async () => {
    if (!batch.photos.length) return;
    const files = batch.files.splice(0), ps = batch.photos.splice(0), es = batch.entries.splice(0);
    batch.bytes = 0;
    es.forEach(e => setEntryStatus(e, 'saving'));
    try {
      await serial(async () => {
        const r = await S.gh.commit({ files, ops: [{ op: 'addPhotos', photos: ps }], message: `Moa: add ${ps.length} photo${ps.length === 1 ? '' : 's'} — @${S.me.login}`, base: S.base, title: S.index?.title });
        if (S.space === sp) adopt(r);
      });
      U.done += es.length;
      es.forEach(e => setEntryStatus(e, 'done'));
      Q.done(es.map(e => e.qid).filter(Boolean)).catch(() => {});
    } catch (err) {
      console.error(err); // stays queued: tried again next time the album opens
      U.failed += es.length;
      es.forEach(e => setEntryStatus(e, 'fail'));
      toast(t('save.failedNow', { e: errMsg(err) }), 4000);
    }
  };
  for (const e of list) {
    if (S.space !== sp || U.stop) break;
    setEntryStatus(e, 'processing');
    try {
      const { photo, files, bytes } = await preparePhoto(e, e.opts || opts);
      batch.files.push(...files);
      batch.photos.push(photo);
      batch.entries.push(e);
      batch.bytes += bytes;
      setEntryStatus(e, 'queued');
      if (batch.photos.length >= 10 || batch.bytes > 50 * LIM.MB) await commitBatch();
    } catch (err) {
      console.error(e.main.name, err);
      toast(`${e.main.name}: ${errMsg(err)}`, 4000);
      U.failed++;
      setEntryStatus(e, 'fail');
      // a file that can't be read won't get better; a network or GitHub error might
      if (err.status === undefined && e.qid) Q.done([e.qid]).catch(() => {});
    }
  }
  await commitBatch();
  if (U.stop) Q.done(list.filter(e => e.status?.k !== 'done' && e.qid).map(e => e.qid)).catch(() => {});
  U.running = false;
  ringDone();
  wake?.release?.().catch(() => {});
  updatePill();
  const summary = U.failed ? t('up.partial', { n: U.done, f: U.failed }) : t('up.allDone', { n: U.done });
  toast(summary, 3500);
  notify(S.index?.title || 'Moa', summary);
  if ($('#sheet').dataset.kind === 'upload' && !U.failed) setTimeout(() => { if (!U.running && $('#sheet').dataset.kind === 'upload') closeSheet(); }, 1200);
  else if ($('#sheet').dataset.kind !== 'upload') cleanupUpload();
  S.gh.info().then(i => { if (S.space === sp) { S.repoInfo = i; rerender(); } }).catch(() => {});
  runGeocodeJob();
  scheduleAi();
}

// ---------------- downloading many photos: ZIP, or straight into Photos via the share sheet ----------------

const DL = { running: false, stop: false };
const ZIP_PART = 300 * 1024 * 1024; // phones hold a part in memory; bigger albums come in several ZIPs
const safeName = s => String(s || 'Moa').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 60) || 'Moa';
const canShareFiles = () => { try { return !!navigator.canShare?.({ files: [new File([''], 'a.jpg', { type: 'image/jpeg' })] }); } catch { return false; } };

/** The files one photo downloads as: the original (or the JPEG when none was kept), plus its Live Photo video. */
async function photoFiles(p) {
  const date = new Date(p.takenAt || p.uploadedAt || Date.now());
  const base = (p.name || p.id).replace(/\.[^.]+$/, '');
  const main = p.files.original
    ? { name: p.name || `${p.id}.${C.extOf(p.files.original) || 'jpg'}`, path: p.files.original, type: p.mime || 'image/jpeg' }
    : { name: `${base}.jpg`, path: p.files.preview || p.files.thumb, type: 'image/jpeg' };
  const want = [main];
  if (p.files.live) want.push({ name: `${base}.${LIVE_EXT[p.liveMime] || 'mov'}`, path: p.files.live, type: p.liveMime || 'video/quicktime' });
  const out = [];
  for (const f of want) out.push({ ...f, date, blob: await S.gh.media(f.path, { cache: false }) });
  return out;
}

function downloadSheet(list) {
  if (!list.length) return;
  if (DL.running) return toast(t('up.busy'));
  const bytes = list.reduce((n, p) => n + (p.sizes?.original || p.sizes?.preview || 0) + (p.sizes?.live || 0), 0);
  const share = canShareFiles() && list.length <= 30;
  const sh = openSheet(`<h2>${t('dl.title', { n: list.length })}</h2><p class="sheet-p">≈ ${C.fmtBytes(bytes)}</p>
    <div class="actions">${share ? `<button class="btn btn-quiet" id="dlShare">${t('dl.toPhotos')}</button>` : `<button class="btn btn-quiet" data-close>${t('common.cancel')}</button>`}<button class="btn btn-primary" id="dlZip">${t('dl.zip')}</button></div>`);
  $('#dlZip', sh).onclick = () => runDownload(list, 'zip');
  $('#dlShare', sh)?.addEventListener('click', () => runDownload(list, 'share'));
}

async function runDownload(list, mode) {
  askNotify();
  Object.assign(DL, { running: true, stop: false });
  const sp = S.space, total = list.length, title = safeName(S.index?.title);
  let done = 0;
  const sh = openSheet(`<h2>${t('dl.preparing')} <small id="dlCount">0/${total}</small></h2><div class="progress"><i id="dlBar"></i></div>
    <div id="dlReady"></div><div class="actions"><button class="btn btn-quiet" id="dlStop">${t('up.stop')}</button></div>`, { kind: 'download', onClose: () => { DL.stop = true; } });
  $('#dlStop', sh).onclick = () => closeSheet();
  const progress = () => {
    if ($('#dlCount', sh)) { $('#dlCount', sh).textContent = `${done}/${total}`; $('#dlBar', sh).style.transform = `scaleX(${done / total})`; }
    ringProgress(done / total);
  };
  // saving needs a fresh tap (browsers only download or share from a gesture), so each result waits for one
  const ready = (label, onTap) => new Promise(resolve => {
    const box = $('#dlReady', sh);
    if (!box) return resolve();
    box.innerHTML = `<button class="btn btn-primary btn-block" id="dlSave">${label}</button>`;
    $('#dlSave', box).onclick = () => { onTap(); box.innerHTML = ''; resolve(); };
    notify(S.index?.title || 'Moa', t('dl.ready'));
  });
  const saveBlob = (blob, name) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  };
  let zip = new ZipWriter(), part = 1;
  const shared = [];
  try {
    for (const p of list) {
      if (DL.stop || S.space !== sp) throw new Error('stopped');
      const items = await photoFiles(p);
      if (mode === 'share') shared.push(...items.map(i => new File([i.blob], i.name, { type: i.type, lastModified: +i.date })));
      else {
        const size = items.reduce((n, i) => n + i.blob.size, 0);
        if (zip.count && zip.size + size > ZIP_PART) {
          const full = zip.build(), k = part++;
          await ready(t('dl.savePart', { k }), () => saveBlob(full, `${title}-${k}.zip`));
          zip = new ZipWriter();
        }
        for (const i of items) await zip.add(i.name, i.blob, i.date);
      }
      done++;
      progress();
    }
    ringDone();
    if (mode === 'share') await ready(t('dl.saveN', { n: shared.length }), () => navigator.share({ files: shared }).catch(e => { if (e.name !== 'AbortError') toast(t('dl.failed', { e: errMsg(e) }), 4000); }));
    else { const last = zip.build(); await ready(part > 1 ? t('dl.savePart', { k: part }) : t('dl.saveZip'), () => saveBlob(last, part > 1 ? `${title}-${part}.zip` : `${title}.zip`)); }
    DL.running = false;
    setTimeout(() => { if ($('#sheet').dataset.kind === 'download') closeSheet(); }, 400);
  } catch (e) {
    DL.running = false;
    ringProgress(null);
    if (e.message !== 'stopped') { toast(t('dl.failed', { e: errMsg(e) }), 4000); if ($('#sheet').dataset.kind === 'download') closeSheet(); }
  }
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

/** Pick up an upload that didn't finish (app closed, iOS suspended it, network gone). */
async function resumeUploads() {
  if (U.running || CONV.running || !S.index || !S.canWrite) return;
  const sp = S.space;
  let rows;
  try { rows = await Q.pending(sp.id); } catch { return; }
  if (!rows.length || S.space !== sp || U.running || !S.index) return;
  // anything whose commit landed just before the app closed is already in the album
  const have = new Set(photos().map(p => p.hash).filter(Boolean));
  const landed = rows.filter(r => r.main?.hash && have.has(r.main.hash));
  Q.done(landed.map(r => r.qid)).catch(() => {});
  const todo = rows.filter(r => !landed.includes(r) && r.main?.file);
  if (!todo.length) return;
  U.entries = todo.map((r, i) => ({ ...r, main: { ...r.main, key: 'r' + i }, live: r.live || null, skip: false, status: null }));
  toast(t('up.resuming', { n: todo.length }));
  startUpload(null, { resumed: true });
}

async function preparePhoto(e, opts) {
  const m = e.main, meta = m.meta;
  const id = C.newId();
  const ym = C.mediaDir(meta.takenAt);
  let r = null;
  try { r = await makeRenditions(m); } catch (err) { if (m.kind === 'photo') throw err; }
  const ext = C.extOf(m.name) || (m.kind === 'video' ? 'mp4' : 'jpg');
  const files = {}, up = [], sizes = {};
  // encrypted album: random names, so paths give away no dates or file types
  const at = path => (S.gh.sealed ? C.sealedPath() : path);
  if (m.kind === 'video' || opts.keepOriginal) { files.original = at(`media/${ym}/${id}.${ext}`); up.push([files.original, m.file, 'original']); }
  if (r) { files.preview = at(`preview/${ym}/${id}.jpg`); up.push([files.preview, r.preview, 'preview']); }
  files.thumb = at(`thumb/${ym}/${id}.jpg`);
  up.push([files.thumb, r?.thumb || await placeholderThumb(), 'thumb']);
  if (e.live) { files.live = at(`media/${ym}/${id}.live.${C.extOf(e.live.name) || 'mov'}`); up.push([files.live, e.live.file, 'live']); }

  const blobs = [];
  let bytes = 0;
  for (const [path, blob, k] of up) {
    setEntryStatus(e, 'uploading', { i: blobs.length + 1, n: up.length });
    const sha = await S.gh.putMedia(path, blob, { prime: k === 'thumb' || k === 'preview' });
    blobs.push({ path, sha });
    sizes[k] = blob.size;
    bytes += blob.size;
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

// ---------------- on-device AI: auto tags and search by description (opt-in) ----------------
// Off until the person agrees. The CLIP model comes from Hugging Face once; photos are
// looked at on this device only. Embeddings stay on the device; auto tags go into the
// album (so every member sees them) and are encrypted with it when it is encrypted.

const AIS = { status: 'off', loaded: 0, total: 0, done: 0, todo: 0, emb: null, running: false, error: '' };

function aiStatusText() {
  if (!prefs.ai) return t('ai.offNote');
  if (AIS.status === 'loading') return AIS.total ? t('ai.downloading', { p: Math.round((AIS.loaded / AIS.total) * 100) }) : t('ai.starting');
  if (AIS.status === 'error') return t('ai.failed', { e: AIS.error });
  if (AIS.running && AIS.todo) return t('ai.analyzing', { n: AIS.done, total: AIS.todo });
  return t('ai.ready');
}
function aiStatusUpdate() { const el = $('#aiStatus'); if (el) el.textContent = aiStatusText(); }

function aiConsentSheet() {
  const sh = openSheet(`<h2>${t('ai.consentTitle')}</h2>
    <ul class="consent">
      <li>${t('ai.c1')}</li><li>${t('ai.c2')}</li><li>${t('ai.c3')}</li><li>${t('ai.c4')}</li>
    </ul>
    <div class="actions"><button class="btn btn-quiet" data-close>${t('common.cancel')}</button><button class="btn btn-primary" id="aiAgree">${t('ai.agree')}</button></div>`);
  $('#aiAgree', sh).onclick = () => {
    prefs.ai = true;
    prefs.aiConsentAt = new Date().toISOString();
    save(LS.prefs, prefs);
    closeSheet();
    render();
    aiStart();
  };
}

function aiOffSheet() {
  const has = photos().some(p => p.ai?.length);
  const sh = openSheet(`<h2>${t('ai.offTitle')}</h2><p class="sheet-p">${t('ai.offBody')}</p>
    ${has && S.canWrite ? `<div class="row opt-row"><div class="grow"><b>${t('ai.clearTags')}</b></div><label class="switch"><input type="checkbox" id="aiClear"><span></span></label></div>` : ''}
    <div class="actions"><button class="btn btn-quiet" data-close>${t('common.cancel')}</button><button class="btn btn-danger" id="aiOff">${t('ai.turnOff')}</button></div>`);
  $('#aiOff', sh).onclick = async () => {
    const clear = !!$('#aiClear', sh)?.checked;
    prefs.ai = false;
    delete prefs.aiConsentAt;
    save(LS.prefs, prefs);
    Object.assign(AIS, { status: 'off', emb: null, running: false, done: 0, todo: 0 });
    S.semantic = null;
    closeSheet();
    await AI.wipe().catch(() => {});
    if (clear) edit({ op: 'aiClear' });
    render();
    toast(t('ai.offDone'));
  };
}

async function aiStart() {
  if (!prefs.ai || AIS.status === 'loading' || AIS.status === 'ready') return scheduleAi();
  Object.assign(AIS, { status: 'loading', loaded: 0, total: 0, error: '' });
  aiStatusUpdate();
  try {
    await AI.start((loaded, total) => { AIS.loaded = loaded; AIS.total = total; aiStatusUpdate(); });
    if (!prefs.ai) return;
    AIS.status = 'ready';
    aiStatusUpdate();
    scheduleAi(0);
  } catch (e) {
    console.error(e);
    Object.assign(AIS, { status: 'error', error: errMsg(e) });
    aiStatusUpdate();
  }
}

let aiTimer = null;
function scheduleAi(ms = 1500) {
  if (!prefs.ai) return;
  clearTimeout(aiTimer);
  aiTimer = setTimeout(() => (AIS.status === 'ready' ? runAiJob() : aiStart()), ms);
}

/** Look at every photo this device hasn't yet; tag the ones the album hasn't tagged. */
async function runAiJob() {
  if (!prefs.ai || AIS.status !== 'ready' || AIS.running || !S.index) return;
  AIS.running = true;
  const sp = S.space;
  try {
    if (!AIS.emb || AIS.emb.space !== sp.id) { AIS.emb = await AI.loadEmbeddings(sp.id); AIS.emb.space = sp.id; }
    const emb = AIS.emb;
    const todo = photos().filter(p => p.files?.thumb && (!emb.has(p.id) || (S.canWrite && p.aiv !== AI_VERSION)));
    Object.assign(AIS, { done: 0, todo: todo.length });
    aiStatusUpdate();
    for (const p of todo) {
      if (!prefs.ai || S.space !== sp || AIS.status !== 'ready') break;
      while (U.running || CONV.running || document.hidden) { await new Promise(r => setTimeout(r, 2000)); if (S.space !== sp || !prefs.ai) return; }
      let vec = emb.get(p.id);
      if (!vec) {
        try { vec = await AI.embedImage(await S.gh.media(p.files.thumb)); } catch (e) { console.warn('ai', p.id, e); AIS.done++; continue; }
        emb.set(p.id, vec);
        AI.saveEmbedding(sp.id, p.id, vec).catch(() => {});
      }
      const cur = S.index?.photos[p.id];
      if (cur && S.canWrite && cur.aiv !== AI_VERSION) edit({ op: 'aiTags', id: p.id, tags: await AI.tagsFor(vec), v: AI_VERSION });
      AIS.done++;
      aiStatusUpdate();
    }
  } catch (e) {
    console.error(e);
  } finally {
    AIS.running = false;
    aiStatusUpdate();
  }
  if (S.filter.q) semanticSearch(S.filter.q);
}

/** Search by description: words → English (CLIP's text side) → closest photos. */
let semSeq = 0;
async function semanticSearch(q) {
  const my = ++semSeq;
  if (!prefs.ai || AIS.status !== 'ready' || !q.trim() || !AIS.emb?.size) { if (S.semantic) { S.semantic = null; renderPhotos(); } return; }
  const english = toEnglishQuery(q);
  if (!english) return;
  try {
    const ids = await AI.rank(english, AIS.emb);
    if (my !== semSeq || S.filter.q !== q) return;
    S.semantic = { q, ids };
    renderPhotos();
  } catch (e) { console.warn('semantic search', e); }
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
  // image fallbacks without inline handlers (the CSP forbids them)
  document.addEventListener('error', e => {
    const t = e.target;
    if (t.matches?.('img.avatar')) t.style.visibility = 'hidden';
    else if (t.matches?.('.up-item img')) t.remove();
  }, true);
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
  $('#searchInput').oninput = e => { clearTimeout(qTimer); qTimer = setTimeout(() => { S.filter.q = e.target.value; renderPhotos(); semanticSearch(S.filter.q); }, 200); };
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
    if (t === 'all') { f.kind = ''; f.tag = ''; f.ai = ''; f.area = null; f.month = ''; }
    else if (t === 'area') f.area = null;
    else if (t === 'month') f.month = '';
    else if (t === 'ai') f.ai = f.ai === v ? '' : v;
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
      if (!sp || !confirm(t('set.removeConfirm', { repo: `${sp.owner}/${sp.repo}` }))) return;
      S.spaces = S.spaces.filter(s => s !== sp);
      saveSpaces();
      localStorage.removeItem(LS.pending(sp.id));
      S.keys.delete(sp.id);
      forgetKey(sp.id);
      Q.clearSpace(sp.id).catch(() => {});
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
      case 'mainCover': return mainCoverSheet();
      case 'stats': return showStats();
      case 'purge': return purgeSheet();
      case 'downloadAll': return downloadSheet(photos().sort((a, b) => C.sortTs(a) - C.sortTs(b)));
      case 'passphrase': return passphraseSheet();
      case 'recovery': return newRecoverySheet();
      case 'encryptAlbum': return encryptAlbumSheet();
      case 'decryptAlbum': return decryptAlbumSheet();
      case 'lockHere': return lockHere();
      case 'passkey': return passkeySheet();
      case 'storage': showTab('settings'); requestAnimationFrame(() => $('#storageTitle')?.scrollIntoView({ block: 'start' })); return;
      case 'addSpace': return showWelcome({ adding: true });
      case 'home': return showHome();
      case 'logout': return logout();
      case 'rename': {
        const title = prompt(t('newAlbum.name'), S.index.title || '');
        if (title && title.trim()) edit({ op: 'setTitle', title: title.trim() });
        return;
      }
      case 'clearCache':
        clearMediaCache().then(() => { urls.clear(); resolved.clear(); toast(t('set.cacheCleared')); });
        return;
    }
  });
  $('#main').addEventListener('change', e => {
    if (e.target.matches('[data-lang]')) {
      prefs.lang = e.target.value;
      save(LS.prefs, prefs);
      setLang(prefs.lang);
      applyStaticText();
      render();
      return;
    }
    if (e.target.matches('[data-ai-toggle]')) {
      const want = e.target.checked;
      e.target.checked = prefs.ai; // stays as it was until the sheet is confirmed
      return want ? aiConsentSheet() : aiOffSheet();
    }
    const k = e.target.dataset.pref;
    if (!k) return;
    prefs[k] = e.target.checked;
    save(LS.prefs, prefs);
    if (k === 'geocode' && prefs.geocode) runGeocodeJob();
    if (k === 'notify' && prefs.notify) askNotify();
  });

  $('#selectBar').onclick = e => {
    const b = e.target.closest('[data-sel]');
    if (!b) return;
    const ids = [...S.selected];
    if (!ids.length) return toast(t('select.none'));
    if (b.dataset.sel === 'tag') tagSheet(ids);
    else if (b.dataset.sel === 'album') pickAlbum(ids);
    else if (b.dataset.sel === 'download') downloadSheet(ids.map(id => S.index.photos[id]).filter(Boolean));
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

/** Text baked into index.html: data-i18n (text), data-i18n-aria, data-i18n-ph. */
function applyStaticText() {
  $$('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  $$('[data-i18n-aria]').forEach(el => el.setAttribute('aria-label', t(el.dataset.i18nAria)));
  $$('[data-i18n-ph]').forEach(el => el.setAttribute('placeholder', t(el.dataset.i18nPh)));
  document.title = t('app.title');
  $('#selectBtn').textContent = t(S.selecting ? 'common.done' : 'select');
}

function registerSW() {
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

applyStaticText();
bind();
boot();

// test hook (used by test/e2e.mjs)
window.__moa = { S, flush, refresh: () => serial(() => refresh()), showHome, queued: () => Q.pending(S.space.id).then(r => r.length) };
