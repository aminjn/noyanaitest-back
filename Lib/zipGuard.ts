// A zip (an .xlsx) whose files unpack to far more than the upload itself
// (a "zip bomb") is refused before ExcelJS expands it in memory (2026-10).
// The sizes come from the zip's own central directory; a zip without one,
// or a ZIP64 one, is not a spreadsheet we read.
export const zipTooLarge = (buf: Buffer, maxBytes = 60 * 1024 * 1024, maxEntries = 2000): boolean => {
  // end of central directory: 22 bytes plus a comment of up to 64KB
  const from = Math.max(0, buf.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buf.length - 22; i >= from; i--)
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) return true;
  const entries = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  if (entries === 0xffff || offset === 0xffffffff || entries > maxEntries) return true;
  let total = 0;
  for (let n = 0; n < entries; n++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== 0x02014b50) return true;
    const size = buf.readUInt32LE(offset + 24);
    if (size === 0xffffffff) return true;
    total += size;
    if (total > maxBytes) return true;
    offset += 46 + buf.readUInt16LE(offset + 28) + buf.readUInt16LE(offset + 30) + buf.readUInt16LE(offset + 32);
  }
  return false;
};
