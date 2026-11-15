/**
 * services/zipWriter.js — minimal dependency-free ZIP writer.
 *
 * Writes a spec-compliant ZIP archive (PKWARE APPNOTE 6.3.x) with
 * deflate-compressed entries and a central directory. Enough for evidence
 * bundles (text + PNG/WebM media); no encryption, no zip64 (entries < 4 GB,
 * archives < 4 GB — evidence bundles are bounded far below that).
 *
 * Verification approach: the test suite extracts produced archives with the
 * platform `tar` (bsdtar reads ZIP) — no extra dependency needed.
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib';

// CRC-32 (IEEE 802.3), table-based.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(date = new Date()) {
  const time = ((date.getHours() & 0x1F) << 11) | ((date.getMinutes() & 0x3F) << 5) | ((Math.floor(date.getSeconds() / 2)) & 0x1F);
  const day = (((date.getFullYear() - 1980) & 0x7F) << 9) | (((date.getMonth() + 1) & 0x0F) << 5) | (date.getDate() & 0x1F);
  return { time, day };
}

function u16(v) { const b = Buffer.alloc(2); b.writeUInt16LE(v & 0xFFFF, 0); return b; }
function u32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0, 0); return b; }

/**
 * Build a ZIP archive from entries.
 * @param {Array<{ name: string, data: Buffer|string }>} entries
 * @returns {Buffer}
 */
export function createZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const { time, day } = dosDateTime();

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name.replace(/\\/g, '/'), 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const compressed = deflateRawSync(raw);
    const useDeflate = compressed.length < raw.length;
    const payload = useDeflate ? compressed : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const localHeader = Buffer.concat([
      u32(0x04034b50),          // local file header signature
      u16(20),                  // version needed (deflate)
      u16(0),                   // general purpose flags
      u16(method),
      u16(time),
      u16(day),
      u32(crc),
      u32(payload.length),      // compressed size
      u32(raw.length),          // uncompressed size
      u16(nameBuf.length),
      u16(0),                   // extra field length
      nameBuf,
    ]);
    localParts.push(localHeader, payload);

    const centralHeader = Buffer.concat([
      u32(0x02014b50),          // central directory header signature
      u16(20),                  // version made by
      u16(20),                  // version needed
      u16(0),
      u16(method),
      u16(time),
      u16(day),
      u32(crc),
      u32(payload.length),
      u32(raw.length),
      u16(nameBuf.length),
      u16(0), u16(0),           // extra + comment lengths
      u16(0),                   // disk number start
      u16(0),                   // internal attrs
      u32(0),                   // external attrs
      u32(offset),              // relative offset of local header
      nameBuf,
    ]);
    centralParts.push(centralHeader);

    offset += localHeader.length + payload.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.concat([
    u32(0x06054b50),            // end of central directory signature
    u16(0), u16(0),             // disk numbers
    u16(entries.length),
    u16(entries.length),
    u32(centralDir.length),
    u32(offset),                // offset of central directory
    u16(0),                     // comment length
  ]);

  return Buffer.concat([...localParts, centralDir, eocd]);
}

/**
 * Extract a ZIP archive produced by createZip (test/verification helper).
 * Supports deflate + stored entries; no zip64.
 * @param {Buffer} zip
 * @returns {Map<string, Buffer>} name → uncompressed data
 */
export function readZip(zip) {
  const out = new Map();
  // Locate the end-of-central-directory record (scan backwards for signature).
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('readZip: end of central directory not found');
  const count = zip.readUInt16LE(eocd + 10);
  const cdOffset = zip.readUInt32LE(eocd + 16);

  let ptr = cdOffset;
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(ptr) !== 0x02014b50) throw new Error('readZip: bad central directory entry');
    const method = zip.readUInt16LE(ptr + 10);
    const csize = zip.readUInt32LE(ptr + 20);
    const nameLen = zip.readUInt16LE(ptr + 28);
    const extraLen = zip.readUInt16LE(ptr + 30);
    const commentLen = zip.readUInt16LE(ptr + 32);
    const localOffset = zip.readUInt32LE(ptr + 42);
    const name = zip.slice(ptr + 46, ptr + 46 + nameLen).toString('utf8');

    const localNameLen = zip.readUInt16LE(localOffset + 26);
    const localExtraLen = zip.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const data = zip.slice(dataStart, dataStart + csize);
    out.set(name, method === 8 ? inflateRawSync(data) : data);

    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
