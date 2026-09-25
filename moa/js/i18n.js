/* ============================================================
   Moa — language
   English by default; Korean from Settings → Language.
   Dates and times go through Intl so each language formats its own way.
   ============================================================ */

import STRINGS from './strings.js';

let current = 'en';

export function setLang(l) {
  current = l === 'ko' ? 'ko' : 'en';
  if (typeof document !== 'undefined') document.documentElement.lang = current;
}
export const lang = () => current;
export const locale = () => (current === 'ko' ? 'ko-KR' : 'en-US');

/** t('key', { n: 3 }) — {x} substitutes, {n|photo|photos} picks the English plural. */
export function t(key, vars = {}) {
  const entry = STRINGS[key];
  if (!entry) return key;
  const s = (current === 'ko' ? entry[1] : entry[0]) ?? entry[0];
  return s
    .replace(/\{(\w+)\|([^|}]*)\|([^}]*)\}/g, (_, k, one, other) => (Number(vars[k]) === 1 ? one : other))
    .replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));
}

// "YYYY-MM-DD" is a wall-clock date; format it in UTC so no zone shifts it.
const utc = key => { const [y, m, d] = key.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d || 1)); };

export const fmtDay = (key, weekday = true) =>
  utc(key).toLocaleDateString(locale(), { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric', ...(weekday && { weekday: 'long' }) });

export const fmtMonth = key => utc(key).toLocaleDateString(locale(), { timeZone: 'UTC', year: 'numeric', month: 'long' });

export function fmtTime(takenAt) {
  const m = /T(\d{2}):(\d{2})/.exec(takenAt || '');
  if (!m) return '';
  const h = +m[1];
  if (current === 'ko') return `${h < 12 ? '오전' : '오후'} ${h % 12 || 12}:${m[2]}`; // ICU builds vary on "오전/오후"
  return new Date(Date.UTC(2000, 0, 1, +m[1], +m[2])).toLocaleTimeString(locale(), { timeZone: 'UTC', hour: 'numeric', minute: '2-digit' });
}
