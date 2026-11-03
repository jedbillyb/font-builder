// Minimal zip writer (stored, no compression), enough for a folder of fonts.

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(b) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// files: [{ name, data: Uint8Array }]
export function makeZip(files) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  const le = (n, bytes) => { const a = []; for (let i = 0; i < bytes; i++) a.push((n >>> (8 * i)) & 255); return a; };
  for (const f of files) {
    const name = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
    // version 20, flags: bit 11 = UTF-8 names, method 0 = stored
    const common = [...le(20, 2), ...le(0x0800, 2), ...le(0, 2), ...le(0, 2), ...le(0x21, 2), ...le(crc, 4), ...le(size, 4), ...le(size, 4), ...le(name.length, 2), ...le(0, 2)];
    const local = new Uint8Array([...le(0x04034b50, 4), ...common, ...name]);
    parts.push(local, f.data);
    central.push(new Uint8Array([...le(0x02014b50, 4), ...le(20, 2), ...common, ...le(0, 2), ...le(0, 2), ...le(0, 2), ...le(0, 4), ...le(offset, 4), ...name]));
    offset += local.length + size;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array([...le(0x06054b50, 4), ...le(0, 2), ...le(0, 2), ...le(files.length, 2), ...le(files.length, 2), ...le(cdSize, 4), ...le(offset, 4), ...le(0, 2)]);
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}
