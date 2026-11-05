// Builds a TrueType font from traced glyphs.
// glyphs: Map of key -> { contours, bounds }, where a key is a character or
// a character plus '.alt' for second versions. Contours are in font units,
// baseline at 0, cap height 700.

const UPM = 1000, CAP = 700;

// Plain characters that typographic ones fall back to.
const EXTRA = { '‘': "'", '’': "'", '‚': ',', '“': '"', '”': '"', '„': '"', '–': '-', '—': '-', '−': '-', '‐': '-', '′': "'", '″': '"' };

const ACCENTS = {
  grave: 'ÀÈÌÒÙàèìòù', acute: 'ÁÉÍÓÚÝáéíóúý', circumflex: 'ÂÊÎÔÛâêîôû', tilde: 'ÃÑÕãñõ',
  diaeresis: 'ÄËÏÖÜäëïöüÿ', ring: 'Åå', macron: 'ĀĒĪŌŪāēīōū', cedilla: 'Çç',
};
const MARK_SOURCE = { grave: "'", acute: "'", circumflex: '^', tilde: '~', diaeresis: '.', ring: '°', macron: '-', cedilla: ',' };

class W { // big-endian byte writer
  constructor() { this.b = []; }
  u8(v) { this.b.push(v & 255); return this; }
  u16(v) { return this.u8(v >> 8).u8(v); }
  i16(v) { return this.u16(v < 0 ? v + 65536 : v); }
  u32(v) { return this.u16(Math.floor(v / 65536) & 0xFFFF).u16(v & 0xFFFF); }
  tag(s) { for (const c of s) this.u8(c.charCodeAt(0)); return this; }
  bytes(a) { for (const x of a) this.u8(x); return this; }
  pad() { while (this.b.length % 4) this.u8(0); return this; }
  get length() { return this.b.length; }
}

function bbox(contours) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of contours) for (const p of c) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}

function mapPts(contours, fn) {
  return contours.map(c => c.map(p => { const [x, y] = fn(p.x, p.y); return { x: Math.round(x), y: Math.round(y), on: p.on }; }));
}

// ---------- accents ----------

function median(a) { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; }

function dotless(contours, xh) {
  const body = contours.filter(c => bbox([c]).y0 < xh * 0.6);
  return body.length && body.length < contours.length ? body : contours;
}

// Returns the mark's contours sized for a base of the given width, with its
// bounding box at the origin (bottom-left).
function makeMark(kind, src, baseW) {
  const b = bbox(src);
  let c = src;
  const rot = (deg) => {
    const a = deg * Math.PI / 180, cs = Math.cos(a), sn = Math.sin(a);
    return mapPts(c, (x, y) => [b.cx + (x - b.cx) * cs - (y - b.cy) * sn, b.cy + (x - b.cx) * sn + (y - b.cy) * cs]);
  };
  const scaleTo = (s, sy = s) => { const bb = bbox(c); c = mapPts(c, (x, y) => [(x - bb.x0) * s, (y - bb.y0) * sy]); };
  if (kind === 'acute') { c = rot(-40); const bb = bbox(c); scaleTo(Math.min(1, 170 / bb.h)); }
  else if (kind === 'grave') { c = rot(40); const bb = bbox(c); scaleTo(Math.min(1, 170 / bb.h)); }
  else if (kind === 'macron') { scaleTo(Math.max(60, baseW * 0.62) / b.w, 1); }
  else if (kind === 'circumflex' || kind === 'tilde') { scaleTo(Math.max(80, baseW * 0.58) / b.w); }
  else if (kind === 'ring') { scaleTo(Math.min(1, 150 / b.h)); }
  else if (kind === 'cedilla') { scaleTo(Math.min(1, 160 / b.h)); }
  else if (kind === 'diaeresis') {
    scaleTo(Math.min(1, 90 / Math.max(b.w, b.h)));
    const d = bbox(c), gap = Math.max(baseW * 0.42, d.w * 2.2);
    c = [...c, ...mapPts(c, (x, y) => [x + gap, y])];
  }
  const bb = bbox(c);
  return mapPts(c, (x, y) => [x - bb.x0, y - bb.y0]);
}

function compose(glyphs) {
  const out = new Map();
  const xs = ['x', 'z', 'v', 'w', 'u', 'n', 'm'].filter(k => glyphs.has(k)).map(k => glyphs.get(k).bounds.y1);
  const xh = median(xs) ?? 430;
  for (const [kind, chars] of Object.entries(ACCENTS)) {
    const src = glyphs.get(MARK_SOURCE[kind]);
    if (!src) continue;
    for (const ch of chars) {
      if (glyphs.has(ch)) continue;
      const baseCh = ch.normalize('NFD')[0];
      const base = glyphs.get(baseCh);
      if (!base) continue;
      const baseC = baseCh === 'i' ? dotless(base.contours, xh) : base.contours;
      const bb = bbox(baseC);
      const mark = makeMark(kind, src.contours, bb.w);
      const mb = bbox(mark);
      const dx = bb.cx - mb.w / 2;
      const dy = kind === 'cedilla' ? -mb.h + 20 : bb.y1 + 50;
      const placed = mapPts(mark, (x, y) => [x + dx, y + dy]);
      const contours = [...baseC, ...placed];
      out.set(ch, { contours, bounds: bbox(contours) });
    }
  }
  return out;
}

// ---------- punctuation placement ----------

// Small marks have no guide line to aim at, so they often land too high or
// too low. Each is moved up or down (never resized) to where type puts it.
const ON_BASELINE = new Set([...'.:!?…']);
const AT_CAP = new Set([...'\'"`^°*']);
const ON_MIDDLE = new Set([...'-~=+×÷•']);
const PLACED = new Set([...ON_BASELINE, ...AT_CAP, ...ON_MIDDLE, ',', '_']);

export function placeMarks(glyphs) {
  const top = ks => median(ks.filter(k => glyphs.has(k)).map(k => bbox(glyphs.get(k).contours).y1));
  const xh = top([...'xzvwunm']) ?? 450;
  const cap = top([...'HIEFTLKNMXZ']) ?? CAP;
  const out = new Map();
  const shift = (g, dy) => { const c = mapPts(g.contours, (x, y) => [x, y + dy]); return { ...g, contours: c, bounds: bbox(c) }; };
  // Full stops first: a comma's head sits as high as the full stop.
  let dotH = 90;
  const stop = glyphs.get('.');
  if (stop) { const b = bbox(stop.contours); dotH = b.h; }
  for (const [key, g] of glyphs) {
    const ch = key.replace(/\.alt$/, '');
    if (!PLACED.has(ch) || !g.contours.length) { out.set(key, g); continue; }
    const b = bbox(g.contours);
    let dy = 0;
    if (ON_BASELINE.has(ch)) dy = -b.y0;
    else if (AT_CAP.has(ch)) dy = cap - b.y1;
    else if (ON_MIDDLE.has(ch)) dy = xh / 2 - b.cy;
    else if (ch === ',') dy = Math.max(dotH, b.h * 0.35) - b.y1;
    else if (ch === '_') dy = -100 - b.y1;
    out.set(key, dy ? shift(g, Math.round(dy)) : g);
  }
  return out;
}

// ---------- GSUB: alternate between first and second versions ----------

// Every glyph that has a second version switches to it when the glyph before
// it is a first version, so repeated and neighbouring letters alternate.
function gsub(pairs) {
  pairs.sort((a, b) => a[0] - b[0]);
  const cov = new W().u16(1).u16(pairs.length); pairs.forEach(p => cov.u16(p[0]));
  const single = new W().u16(2).u16(6 + 2 * pairs.length).u16(pairs.length); pairs.forEach(p => single.u16(p[1]));
  single.bytes(cov.b);
  const chain = new W().u16(3).u16(1).u16(18).u16(1).u16(18).u16(0).u16(1).u16(0).u16(1).bytes(cov.b);
  const lookup = (type, sub) => new W().u16(type).u16(0).u16(1).u16(8).bytes(sub.b);
  const l0 = lookup(6, chain), l1 = lookup(1, single);
  const lookups = new W().u16(2).u16(6).u16(6 + l0.length).bytes(l0.b).bytes(l1.b);
  const features = new W().u16(1).tag('calt').u16(8).u16(0).u16(1).u16(0);
  const script = () => new W().u16(4).u16(0).u16(0).u16(0xFFFF).u16(1).u16(0);
  const scripts = new W().u16(2).tag('DFLT').u16(14).tag('latn').u16(26).bytes(script().b).bytes(script().b);
  const head = 10;
  return new W().u16(1).u16(0).u16(head).u16(head + scripts.length).u16(head + scripts.length + features.length)
    .bytes(scripts.b).bytes(features.b).bytes(lookups.b);
}

// ---------- public ----------

// Characters that get a glyph without being drawn.
export function derivedChars(glyphs) {
  return [...compose(glyphs).keys()];
}

export function buildTTF(drawn, opts = {}) {
  const family = String(opts.family || '').replace(/[\x00-\x1f]/g, '').trim().slice(0, 60) || 'My Handwriting';
  const ascii = s => s.normalize('NFD').replace(/[^\x20-\x7E]/g, '');
  const version = String(opts.version || '').replace(/[^0-9.]/g, '') || '1.0';
  const ps = (ascii(family).replace(/[^A-Za-z0-9]/g, '') || 'MyHandwriting').slice(0, 50) + '-Regular';
  const sb = opts.sideBearing ?? 45;
  const space = opts.wordSpace ?? 300;

  const glyphs = opts.placeMarks === false ? new Map(drawn) : placeMarks(drawn);
  for (const [k, v] of compose(glyphs)) glyphs.set(k, v);

  const list = [
    { name: '.notdef', contours: [[{ x: 50, y: 0, on: true }, { x: 50, y: 700, on: true }, { x: 450, y: 700, on: true }, { x: 450, y: 0, on: true }], [{ x: 100, y: 50, on: true }, { x: 400, y: 50, on: true }, { x: 400, y: 650, on: true }, { x: 100, y: 650, on: true }]], advance: 500 },
    { name: 'space', contours: [], advance: space },
  ];
  const idOf = new Map();
  for (const [key, g] of glyphs) {
    const b = bbox(g.contours);
    const dx = sb - b.x0;
    idOf.set(key, list.length);
    // Negative spacing lets letters overlap; the advance just can't go below zero.
    list.push({ key, contours: mapPts(g.contours, (x, y) => [x + dx, y]), advance: Math.max(10, Math.round(b.w + 2 * sb)) });
  }

  const cmap = new Map([[32, 1], [0xA0, 1]]);
  for (const [key, id] of idOf) if (!key.endsWith('.alt')) cmap.set(key.codePointAt(0), id);
  // Second versions also sit in the Private Use Area (U+E000 + ASCII code) so the
  // page can preview them; normal text reaches them through calt.
  for (const [key, id] of idOf) if (key.endsWith('.alt') && key.codePointAt(0) < 0x80) cmap.set(0xE000 + key.codePointAt(0), id);
  // Missing letters borrow the other case.
  for (const key of [...idOf.keys()]) {
    if (key.endsWith('.alt')) continue;
    for (const other of [key.toUpperCase(), key.toLowerCase()]) {
      if (other.length === 1 && !cmap.has(other.codePointAt(0))) cmap.set(other.codePointAt(0), idOf.get(key));
    }
  }
  for (const [k, v] of Object.entries(EXTRA)) if (!cmap.has(k.codePointAt(0)) && cmap.has(v.codePointAt(0))) cmap.set(k.codePointAt(0), cmap.get(v.codePointAt(0)));

  // glyf + loca
  const glyf = new W(), loca = [];
  let gx0 = 0, gy0 = 0, gx1 = 0, gy1 = 0, maxPts = 0, maxCont = 0, first = true;
  for (const gl of list) {
    loca.push(glyf.length);
    const cs = gl.contours;
    gl.xMin = 0;
    if (!cs.length) continue;
    const all = cs.flat();
    const b = bbox(cs);
    gl.xMin = b.x0; gl.xMax = b.x1; gl.yMin = b.y0; gl.yMax = b.y1;
    if (first) { [gx0, gy0, gx1, gy1] = [b.x0, b.y0, b.x1, b.y1]; first = false; }
    else { gx0 = Math.min(gx0, b.x0); gy0 = Math.min(gy0, b.y0); gx1 = Math.max(gx1, b.x1); gy1 = Math.max(gy1, b.y1); }
    maxPts = Math.max(maxPts, all.length); maxCont = Math.max(maxCont, cs.length);
    glyf.i16(cs.length).i16(b.x0).i16(b.y0).i16(b.x1).i16(b.y1);
    let end = -1; for (const c of cs) { end += c.length; glyf.u16(end); }
    glyf.u16(0); // no instructions
    for (const p of all) glyf.u8(p.on ? 1 : 0);
    let px = 0; for (const p of all) { glyf.i16(p.x - px); px = p.x; }
    let py = 0; for (const p of all) { glyf.i16(p.y - py); py = p.y; }
    glyf.pad();
  }
  loca.push(glyf.length);

  // Line spacing comes from letters and digits, so one tall symbol can't stretch every line.
  const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };
  const alnum = list.filter(g => g.key && /^[A-Za-z0-9]$/.test(g.key) && g.contours.length);
  const asc = Math.max(CAP + 100, pct(alnum.map(g => g.yMax), 0.95));
  const desc = Math.min(-250, pct(alnum.map(g => g.yMin), 0.05));
  const xs = ['x', 'z', 'v', 'w', 'u', 'n', 'm'].filter(k => idOf.has(k)).map(k => list[idOf.get(k)].yMax);
  const xh = Math.round(median(xs) ?? 450);
  const now = Math.floor(Date.now() / 1000) + 2082844800; // seconds since 1904
  const tables = {};

  tables.head = new W().u32(0x00010000).u32(Math.round(parseFloat(version) * 65536) || 65536).u32(0).u32(0x5F0F3CF5)
    .u16(0x000B).u16(UPM).u32(0).u32(now).u32(0).u32(now)
    .i16(gx0).i16(gy0).i16(gx1).i16(gy1).u16(0).u16(8).i16(2).i16(1).i16(0);

  const drawnList = list.filter(g => g.contours.length);
  const advMax = Math.max(...list.map(g => g.advance));
  const minLsb = Math.min(...drawnList.map(g => g.xMin));
  const minRsb = Math.min(...drawnList.map(g => g.advance - g.xMax));
  tables.hhea = new W().u32(0x00010000).i16(asc).i16(desc).i16(0).u16(advMax).i16(minLsb).i16(minRsb).i16(gx1)
    .i16(1).i16(0).i16(0).i16(0).i16(0).i16(0).i16(0).i16(0).u16(list.length);

  const hmtx = new W(); for (const g of list) hmtx.u16(g.advance).i16(g.xMin); tables.hmtx = hmtx;
  const locaW = new W(); for (const o of loca) locaW.u32(o); tables.loca = locaW;
  tables.glyf = glyf;
  tables.maxp = new W().u32(0x00010000).u16(list.length).u16(maxPts).u16(maxCont).u16(0).u16(0)
    .u16(2).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0);

  // cmap format 4, one segment per code
  const codes = [...cmap.keys()].filter(c => c <= 0xFFFF).sort((a, b) => a - b);
  const segs = codes.map(c => [c, c, (cmap.get(c) - c + 65536) % 65536]).concat([[0xFFFF, 0xFFFF, 1]]);
  const n = segs.length, sr = 2 * 2 ** Math.floor(Math.log2(n));
  const f4 = new W().u16(4).u16(16 + 8 * n).u16(0).u16(2 * n).u16(sr).u16(Math.log2(sr / 2)).u16(2 * n - sr);
  segs.forEach(s => f4.u16(s[1])); f4.u16(0);
  segs.forEach(s => f4.u16(s[0])); segs.forEach(s => f4.u16(s[2])); segs.forEach(() => f4.u16(0));
  tables.cmap = new W().u16(0).u16(2).u16(0).u16(3).u32(20).u16(3).u16(1).u32(20).bytes(f4.b);

  // Windows names keep the full name (macrons and all), Mac names get plain ASCII.
  const names = { 1: family, 2: 'Regular', 3: `${ps}-${version}`, 4: `${family} Regular`, 5: `Version ${version}`, 6: ps };
  const recs = [];
  for (const [id, s] of Object.entries(names)) {
    recs.push([1, 0, 0, +id, [...ascii(s)].map(c => c.charCodeAt(0))]);
    const be = []; for (let i = 0; i < s.length; i++) { const u = s.charCodeAt(i); be.push(u >> 8, u & 255); }
    recs.push([3, 1, 0x409, +id, be]);
  }
  recs.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3]);
  const name = new W().u16(0).u16(recs.length).u16(6 + 12 * recs.length);
  let off = 0; for (const r of recs) { name.u16(r[0]).u16(r[1]).u16(r[2]).u16(r[3]).u16(r[4].length).u16(off); off += r[4].length; }
  for (const r of recs) name.bytes(r[4]);
  tables.name = name;

  const avg = Math.round(drawnList.reduce((s, g) => s + g.advance, 0) / drawnList.length);
  tables['OS/2'] = new W().u16(4).i16(avg).u16(400).u16(5).u16(0)
    .i16(650).i16(600).i16(0).i16(75).i16(650).i16(600).i16(0).i16(350).i16(50).i16(300).i16(0)
    .bytes([3, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    .u32(0x00000007).u32(0).u32(0).u32(0).tag('JEDB').u16(0x00C0)
    .u16(Math.min(...codes)).u16(Math.max(...codes))
    .i16(asc).i16(desc).i16(0).u16(Math.max(gy1, asc)).u16(Math.max(-gy0, -desc))
    .u32(3).u32(0).i16(xh).i16(CAP).u16(0).u16(32).u16(1);

  tables.post = new W().u32(0x00030000).u32(0).i16(-100).i16(50).u32(0).u32(0).u32(0).u32(0).u32(0);

  const pairs = [];
  for (const [key, id] of idOf) if (key.endsWith('.alt') && idOf.has(key.slice(0, -4))) pairs.push([idOf.get(key.slice(0, -4)), id]);
  if (pairs.length) tables.GSUB = gsub(pairs);

  // assemble
  const tags = Object.keys(tables).sort();
  const nt = tags.length, es = 2 ** Math.floor(Math.log2(nt));
  const out = new W().u32(0x00010000).u16(nt).u16(es * 16).u16(Math.log2(es)).u16(nt * 16 - es * 16);
  let offset = 12 + 16 * nt;
  const dir = [];
  for (const t of tags) { const raw = tables[t].length; tables[t].pad(); dir.push([t, offset, raw]); offset += tables[t].length; }
  const sum = b => { let s = 0; for (let i = 0; i < b.length; i += 4) s = (s + ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3]) >>> 0; return s; };
  for (const [t, o, raw] of dir) out.tag(t.padEnd(4)).u32(sum(tables[t].b)).u32(o).u32(raw);
  for (const t of tags) out.bytes(tables[t].b);
  const bytes = new Uint8Array(out.b);
  const adj = (0xB1B0AFBA - sum(bytes)) >>> 0;
  const ho = dir.find(d => d[0] === 'head')[1] + 8;
  bytes[ho] = adj >>> 24; bytes[ho + 1] = (adj >> 16) & 255; bytes[ho + 2] = (adj >> 8) & 255; bytes[ho + 3] = adj & 255;
  return { bytes, chars: codes.length, derived: [...glyphs.keys()].filter(k => !drawn.has(k)) };
}
