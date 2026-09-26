/* ============================================================
   Moa — what the on-device AI looks for (pure; shared with tests)
   Auto tags are stored as these keys and shown in the reader's
   language. CLIP compares a photo with each prompt; background
   prompts soak up photos that fit none, so nothing is forced.
   ============================================================ */

export const AI_VERSION = 1; // bump when LABELS change: photos get re-tagged

export const LABELS = [
  { key: 'people', en: 'People', ko: '사람', prompt: 'a photo of a group of people' },
  { key: 'selfie', en: 'Selfies', ko: '셀카', prompt: 'a selfie' },
  { key: 'kids', en: 'Kids', ko: '아이', prompt: 'a photo of a baby or a young child' },
  { key: 'dog', en: 'Dogs', ko: '강아지', prompt: 'a photo of a dog' },
  { key: 'cat', en: 'Cats', ko: '고양이', prompt: 'a photo of a cat' },
  { key: 'food', en: 'Food', ko: '음식', prompt: 'a photo of a meal on a plate' },
  { key: 'coffee', en: 'Café', ko: '카페', prompt: 'a photo of coffee in a cafe' },
  { key: 'dessert', en: 'Dessert', ko: '디저트', prompt: 'a photo of cake or dessert' },
  { key: 'beach', en: 'Beach', ko: '해변', prompt: 'a photo of a sandy beach' },
  { key: 'ocean', en: 'Sea', ko: '바다', prompt: 'a photo of the ocean' },
  { key: 'mountain', en: 'Mountains', ko: '산', prompt: 'a photo of mountains' },
  { key: 'forest', en: 'Forest', ko: '숲', prompt: 'a photo of a forest with trees' },
  { key: 'flowers', en: 'Flowers', ko: '꽃', prompt: 'a photo of flowers' },
  { key: 'sunset', en: 'Sunset', ko: '노을', prompt: 'a photo of a sunset or sunrise' },
  { key: 'night', en: 'Night', ko: '야경', prompt: 'a photo of a city at night' },
  { key: 'city', en: 'City', ko: '도시', prompt: 'a photo of a city street' },
  { key: 'snow', en: 'Snow', ko: '눈', prompt: 'a photo of snow' },
  { key: 'landmark', en: 'Landmarks', ko: '명소', prompt: 'a photo of a famous landmark, temple or palace' },
  { key: 'car', en: 'Cars', ko: '자동차', prompt: 'a photo of a car' },
  { key: 'flight', en: 'Flights', ko: '비행', prompt: 'a view from an airplane window or an airport' },
  { key: 'party', en: 'Parties', ko: '파티', prompt: 'a photo of a birthday party or celebration' },
  { key: 'wedding', en: 'Weddings', ko: '결혼식', prompt: 'a photo of a wedding' },
  { key: 'concert', en: 'Concerts', ko: '공연', prompt: 'a photo of a concert or stage performance' },
  { key: 'sports', en: 'Sports', ko: '운동', prompt: 'a photo of people playing sports' },
  { key: 'art', en: 'Art', ko: '예술', prompt: 'a photo of a painting or artwork in a museum' },
  { key: 'screenshot', en: 'Screenshots', ko: '스크린샷', prompt: 'a screenshot of a phone screen' },
  { key: 'document', en: 'Documents', ko: '문서', prompt: 'a photo of a receipt or a document' },
];
export const BACKGROUND = ['a photo', 'a photo of an object', 'a blurry photo', 'a photo of a room'];

const BY_KEY = new Map(LABELS.map(l => [l.key, l]));
export const labelName = (key, lang = 'en') => (BY_KEY.get(key)?.[lang === 'ko' ? 'ko' : 'en']) || key;
/** Both languages, for plain-text search over auto tags. */
export const labelWords = key => { const l = BY_KEY.get(key); return l ? [l.en, l.ko, l.key] : [key]; };

/**
 * Auto tags from similarities: softmax over labels + background prompts
 * (CLIP's logit scale, 100), keep labels at 25%+ — at most three.
 */
export function pickTags(imageVec, labelVecs, backgroundVecs = []) {
  const dot = v => { let s = 0; for (let i = 0; i < v.length; i++) s += v[i] * imageVec[i]; return s; };
  const logits = [...labelVecs, ...backgroundVecs].map(v => 100 * dot(v));
  const max = Math.max(...logits);
  const exp = logits.map(l => Math.exp(l - max));
  const sum = exp.reduce((a, b) => a + b, 0);
  return LABELS.map((l, i) => ({ key: l.key, p: exp[i] / sum }))
    .filter(x => x.p >= 0.25).sort((a, b) => b.p - a.p).slice(0, 3).map(x => x.key);
}

// ---------- Korean queries → English (CLIP's text side only reads English) ----------
const KO = {
  사람: 'people', 친구: 'friends', 가족: 'family', 셀카: 'a selfie', 아기: 'a baby', 아이: 'a child', 웃는: 'smiling',
  강아지: 'a dog', 개: 'a dog', 고양이: 'a cat', 새: 'a bird',
  음식: 'food', 밥: 'a meal', 커피: 'coffee', 카페: 'a cafe', 케이크: 'a cake', 디저트: 'dessert', 빵: 'bread', 술: 'drinks',
  바다: 'the ocean', 해변: 'a beach', 산: 'mountains', 숲: 'a forest', 나무: 'trees', 꽃: 'flowers', 하늘: 'the sky', 구름: 'clouds',
  노을: 'a sunset', 일출: 'a sunrise', 일몰: 'a sunset', 밤: 'night', 야경: 'a city at night', 도시: 'a city', 거리: 'a street',
  눈: 'snow', 비: 'rain', 강: 'a river', 호수: 'a lake', 폭포: 'a waterfall', 캠핑: 'camping', 수영장: 'a swimming pool',
  차: 'a car', 자동차: 'a car', 기차: 'a train', 자전거: 'a bicycle', 비행기: 'an airplane', 공항: 'an airport', 다리: 'a bridge',
  성: 'a castle', 궁: 'a palace', 궁궐: 'a palace', 절: 'a temple', 교회: 'a church', 명소: 'a famous landmark',
  파티: 'a party', 생일: 'a birthday', 결혼식: 'a wedding', 공연: 'a concert', 운동: 'sports', 축구: 'soccer', 그림: 'a painting', 예술: 'art',
  스크린샷: 'a screenshot', 문서: 'a document', 영수증: 'a receipt',
  빨간: 'red', 파란: 'blue', 초록: 'green', 노란: 'yellow', 하얀: 'white', 검은: 'black', 분홍: 'pink',
};
const KO_KEYS = Object.keys(KO).sort((a, b) => b.length - a.length);

/** English for CLIP, or null when a Korean word has no mapping (then only plain search runs). */
export function toEnglishQuery(q) {
  const words = String(q || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const out = [];
  for (const w of words) {
    if (!/[가-힣]/.test(w)) { out.push(w); continue; }
    const hit = KO_KEYS.find(k => w.startsWith(k)); // "바다에서" → 바다
    if (!hit) return null;
    out.push(KO[hit]);
  }
  return out.join(' ');
}
