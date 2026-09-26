/* ============================================================
   Moa — ZIP files for downloading many photos at once
   Stored (no compression: photos and videos are compressed already),
   UTF-8 names, built from Blobs so file bytes aren't copied again.
   Parts stay well under 4 GB, so ZIP64 is never needed.
   ============================================================ */

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();

export function crc32(u8, crc = 0) {
  let c = ~crc >>> 0;
  for (let i = 0; i < u8.length; i++) c = TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function dosTime(d) {
  const t = d instanceof Date && !isNaN(d) ? d : new Date();
  const y = Math.max(1980, t.getFullYear());
  return { time: (t.getHours() << 11) | (t.getMinutes() << 5) | (t.getSeconds() >> 1), date: ((y - 1980) << 9) | ((t.getMonth() + 1) << 5) | t.getDate() };
}

/** Collect files, then build(): Blob. add() reads each file once for its CRC. */
export class ZipWriter {
  constructor() { this.parts = []; this.central = []; this.offset = 0; this.files = 0; this.names = new Set(); }

  get size() { return this.offset; }
  get count() { return this.files; }

  /** Same name twice gets " (2)" before the extension. */
  uniqueName(name) {
    let n = name, i = 2;
    while (this.names.has(n.toLowerCase())) n = name.replace(/(\.[^.]*)?$/, ` (${i++})$1`);
    this.names.add(n.toLowerCase());
    return n;
  }

  async add(name, blob, date) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const nameBytes = new TextEncoder().encode(this.uniqueName(name));
    const crc = crc32(bytes), { time, date: day } = dosTime(date);
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true); head.setUint16(4, 20, true); head.setUint16(6, 0x0800, true); // UTF-8 names
    head.setUint16(8, 0, true); head.setUint16(10, time, true); head.setUint16(12, day, true);
    head.setUint32(14, crc, true); head.setUint32(18, bytes.length, true); head.setUint32(22, bytes.length, true);
    head.setUint16(26, nameBytes.length, true); head.setUint16(28, 0, true);
    this.parts.push(head.buffer, nameBytes, blob);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true); cen.setUint16(8, 0x0800, true);
    cen.setUint16(10, 0, true); cen.setUint16(12, time, true); cen.setUint16(14, day, true);
    cen.setUint32(16, crc, true); cen.setUint32(20, bytes.length, true); cen.setUint32(24, bytes.length, true);
    cen.setUint16(28, nameBytes.length, true); cen.setUint32(42, this.offset, true);
    this.central.push(cen.buffer, nameBytes);
    this.files++;
    this.offset += 30 + nameBytes.length + bytes.length;
  }

  build() {
    const cenSize = this.central.reduce((n, p) => n + (p.byteLength ?? p.length), 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, this.count, true); end.setUint16(10, this.count, true);
    end.setUint32(12, cenSize, true); end.setUint32(16, this.offset, true);
    return new Blob([...this.parts, ...this.central, end.buffer], { type: 'application/zip' });
  }
}
