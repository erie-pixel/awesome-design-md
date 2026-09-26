/* ============================================================
   Moa — place names from coordinates (OpenStreetMap Nominatim)
   Nominatim's usage policy allows ~1 request/second, so calls are
   serialized, spaced, and cached per ~100m cell in localStorage.
   ============================================================ */

import { placeFromNominatim } from './core.js';
import { lang as appLang } from './i18n.js';

const BASE = 'https://nominatim.openstreetmap.org';
const CACHE_KEY = 'moa.geo.v2';
let cache = {};
try { cache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); } catch { cache = {}; }

let chain = Promise.resolve();
let last = 0;

function throttled(fn) {
  const run = chain.then(async () => {
    const wait = last + 1100 - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    last = Date.now();
    return fn();
  });
  chain = run.catch(() => {});
  return run;
}

function save() {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch { /* quota */ }
}

const lang = () => (appLang() === 'ko' ? 'ko,en' : 'en');

export async function reverseGeocode(lat, lng) {
  const k = `${lang()}:${lat.toFixed(3)},${lng.toFixed(3)}`;
  if (k in cache) return cache[k];
  const place = await throttled(async () => {
    const r = await fetch(`${BASE}/reverse?format=jsonv2&addressdetails=1&zoom=16&lat=${lat}&lon=${lng}&accept-language=${lang()}`);
    if (!r.ok) throw new Error('geocode ' + r.status);
    return placeFromNominatim(await r.json());
  });
  cache[k] = place;
  save();
  return place;
}

export async function searchPlaces(q) {
  if (!q.trim()) return [];
  return throttled(async () => {
    const r = await fetch(`${BASE}/search?format=jsonv2&addressdetails=1&limit=6&q=${encodeURIComponent(q)}&accept-language=${lang()}`);
    if (!r.ok) throw new Error('search ' + r.status);
    return (await r.json()).map(j => ({
      gps: { lat: Math.round(+j.lat * 1e6) / 1e6, lng: Math.round(+j.lon * 1e6) / 1e6 },
      place: placeFromNominatim(j),
      display: j.display_name,
    }));
  });
}
