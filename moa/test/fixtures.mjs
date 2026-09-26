// Builders for synthetic iPhone-like metadata: EXIF (with GPS and an
// Apple MakerNote carrying the Live Photo ContentIdentifier) and
// QuickTime moov/meta atoms. Used by the unit and e2e tests.

const enc = s => new TextEncoder().encode(s);

function concat(parts) {
  const len = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const u16 = n => new Uint8Array([(n >> 8) & 255, n & 255]);
const u32 = n => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

// ---------------- TIFF / EXIF (big endian) ----------------
// entry: [tag, type, count, bytes]  types: 1 BYTE, 2 ASCII, 4 LONG, 5 RATIONAL, 7 UNDEFINED

const ascii = (tag, s) => { const b = enc(s + '\0'); return [tag, 2, b.length, b]; };
const long = (tag, n) => [tag, 4, 1, u32(n)];
const rationals = (tag, vals) => [tag, 5, vals.length, concat(vals.flatMap(([a, b]) => [u32(a), u32(b)]))];
const byte = (tag, n) => [tag, 1, 1, new Uint8Array([n])];
const undef = (tag, bytes) => [tag, 7, bytes.length, bytes];

/** Lay out one IFD at `start` (TIFF-relative). Returns bytes (IFD + its data area). */
function ifd(entries, start) {
  entries = [...entries].sort((a, b) => a[0] - b[0]);
  const head = 2 + entries.length * 12 + 4;
  let dataOff = start + head;
  const table = [u16(entries.length)], data = [];
  for (const [tag, type, count, bytes] of entries) {
    table.push(u16(tag), u16(type), u32(count));
    if (bytes.length <= 4) {
      const v = new Uint8Array(4); v.set(bytes); table.push(v);
    } else {
      table.push(u32(dataOff));
      const padded = bytes.length % 2 ? concat([bytes, new Uint8Array(1)]) : bytes;
      data.push(padded);
      dataOff += padded.length;
    }
  }
  table.push(u32(0));
  return concat([...table, ...data]);
}

const dms = v => {
  const a = Math.abs(v), d = Math.floor(a), mf = (a - d) * 60, m = Math.floor(mf), s = Math.round((mf - m) * 60 * 10000);
  return [[d, 1], [m, 1], [s, 10000]];
};

export function appleMakerNote(contentId) {
  const id = enc(contentId + '\0');
  const header = concat([enc('Apple iOS\0'), u16(1), enc('MM')]); // 14 bytes
  const entryStart = 14 + 2;
  const dataOff = entryStart + 12 + 4;
  if (id.length <= 4) { const v = new Uint8Array(4); v.set(id); return concat([header, u16(1), u16(0x0011), u16(2), u32(id.length), v, u32(0)]); }
  return concat([header, u16(1), u16(0x0011), u16(2), u32(id.length), u32(dataOff), u32(0), id]);
}

/** Build a TIFF block containing IFD0 → EXIF IFD (+ MakerNote) and GPS IFD. */
export function buildTiff({ date, tz, lat, lng, alt, make = 'Apple', model = 'iPhone 15 Pro', lens, contentId } = {}) {
  const exifEntries = [];
  if (date) exifEntries.push(ascii(0x9003, date));
  if (tz) exifEntries.push(ascii(0x9011, tz));
  if (lens) exifEntries.push(ascii(0xa434, lens));
  if (contentId) exifEntries.push(undef(0x927c, appleMakerNote(contentId)));
  const gpsEntries = lat == null ? [] : [
    ascii(0x0001, lat >= 0 ? 'N' : 'S'), rationals(0x0002, dms(lat)),
    ascii(0x0003, lng >= 0 ? 'E' : 'W'), rationals(0x0004, dms(lng)),
    ...(alt != null ? [byte(0x0005, alt < 0 ? 1 : 0), rationals(0x0006, [[Math.round(Math.abs(alt) * 100), 100]])] : []),
  ];
  // IFD0 needs final offsets for the sub-IFDs: lay out twice.
  const base = [ascii(0x010f, make), ascii(0x0110, model)];
  const mk = (exifOff, gpsOff) => ifd([...base, long(0x8769, exifOff), ...(gpsEntries.length ? [long(0x8825, gpsOff)] : [])], 8);
  const ifd0Len = mk(0, 0).length;
  const exifOff = 8 + ifd0Len;
  const exifBytes = ifd(exifEntries, exifOff);
  const gpsOff = exifOff + exifBytes.length;
  const gpsBytes = gpsEntries.length ? ifd(gpsEntries, gpsOff) : new Uint8Array(0);
  return concat([enc('MM'), u16(42), u32(8), mk(exifOff, gpsOff), exifBytes, gpsBytes]);
}

/** Insert an APP1 Exif segment right after the JPEG SOI marker. */
export function withExif(jpeg, opts) {
  const tiff = buildTiff(opts);
  const payload = concat([enc('Exif\0\0'), tiff]);
  const seg = concat([new Uint8Array([0xff, 0xe1]), u16(payload.length + 2), payload]);
  const src = jpeg instanceof Uint8Array ? jpeg : new Uint8Array(jpeg);
  if (src[0] !== 0xff || src[1] !== 0xd8) throw new Error('not a JPEG');
  return concat([src.subarray(0, 2), seg, src.subarray(2)]);
}

// ---------------- QuickTime ----------------

const latin1 = s => new Uint8Array([...s].map(c => c.charCodeAt(0)));
const atom = (type, ...children) => { const body = concat(children); return concat([u32(8 + body.length), latin1(type), body]); };

export function buildMov({ creationdate, iso6709, contentId, created1904, duration = 2.5, isoMeta = false, udtaXyz } = {}) {
  const scale = 600;
  const mvhd = atom('mvhd', new Uint8Array([0, 0, 0, 0]), u32(created1904 || 0), u32(created1904 || 0), u32(scale), u32(Math.round(duration * scale)), new Uint8Array(80));
  const kv = [];
  if (creationdate) kv.push(['com.apple.quicktime.creationdate', creationdate]);
  if (iso6709) kv.push(['com.apple.quicktime.location.ISO6709', iso6709]);
  if (contentId) kv.push(['com.apple.quicktime.content.identifier', contentId]);
  kv.push(['com.apple.quicktime.make', 'Apple'], ['com.apple.quicktime.model', 'iPhone 15 Pro']);
  const keys = atom('keys', u32(0), u32(kv.length), ...kv.map(([k]) => concat([u32(8 + enc(k).length), enc('mdta'), enc(k)])));
  const ilst = concat(kv.map(([, v], i) => {
    const data = atom('data', u32(1), u32(0), enc(v));
    return concat([u32(8 + data.length), u32(i + 1), data]);
  }));
  const hdlr = atom('hdlr', new Uint8Array(4), new Uint8Array(4), enc('mdta'), new Uint8Array(13));
  const metaBody = [hdlr, keys, atom('ilst', ilst)];
  const meta = isoMeta ? atom('meta', u32(0), ...metaBody) : atom('meta', ...metaBody);
  const udta = udtaXyz ? atom('udta', atom('©xyz', u16(enc(udtaXyz).length), u16(0x15c7), enc(udtaXyz))) : new Uint8Array(0);
  const ftyp = atom('ftyp', enc('qt  '), u32(0), enc('qt  '));
  const mdat = atom('mdat', new Uint8Array(64));
  return concat([ftyp, mdat, atom('moov', mvhd, meta, udta)]);
}
