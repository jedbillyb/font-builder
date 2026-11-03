// Finds sheets in a raster, straightens them, reads their QR code and cuts out
// each box. A raster can hold several sheets (an .ai has its pages side by
// side), so sheets are found by their four corner markers.
import { FRAME, MARKER, CELL, GRID, PAGES, HINTS, cellRect, decodeTag } from './layout.js';

const DETECT_MAX = 1600;           // longest side used for marker detection, px
export const RES = 10;             // straightened sheet resolution, px per mm
const MARGIN = 6;                  // mm of extra page kept around the frame
const C = MARKER / 2;
// Marker centres in frame mm: TL, TR, BL, BR.
const CORNERS = [[C, C], [FRAME.w - C, C], [C, FRAME.h - C], [FRAME.w - C, FRAME.h - C]];
const SHORT = FRAME.w - MARKER, LONG = FRAME.h - MARKER;

// ---------- marker detection ----------

function downscale(r) {
  const f = Math.max(1, Math.max(r.w, r.h) / DETECT_MAX);
  const w = Math.round(r.w / f), h = Math.round(r.h / f);
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * f), y1 = Math.max(y0 + 1, Math.floor((y + 1) * f));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * f), x1 = Math.max(x0 + 1, Math.floor((x + 1) * f));
      let s = 0, n = 0;
      for (let yy = y0; yy < y1 && yy < r.h; yy++) for (let xx = x0; xx < x1 && xx < r.w; xx++) { s += r.data[yy * r.w + xx]; n++; }
      data[y * w + x] = n ? s / n : 1;
    }
  }
  return { w, h, data, f };
}

// Dark pixels relative to their neighbourhood, so shadows and uneven light don't matter.
function binarize(img) {
  const { w, h, data } = img;
  const I = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) { row += data[y * w + x]; I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row; }
  }
  const r = Math.max(8, Math.round(Math.max(w, h) / 40));
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const ya = Math.max(0, y - r), yb = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const xa = Math.max(0, x - r), xb = Math.min(w, x + r + 1);
      const mean = (I[yb * (w + 1) + xb] - I[ya * (w + 1) + xb] - I[yb * (w + 1) + xa] + I[ya * (w + 1) + xa]) / ((yb - ya) * (xb - xa));
      const v = data[y * w + x];
      out[y * w + x] = v < mean * 0.78 && v < 0.65 ? 1 : 0;
    }
  }
  return out;
}

function components(bin, w, h) {
  const label = new Int32Array(w * h).fill(-1);
  const comps = [];
  const stack = [];
  for (let i = 0; i < bin.length; i++) {
    if (!bin[i] || label[i] >= 0) continue;
    const c = { area: 0, sx: 0, sy: 0, x0: w, y0: h, x1: 0, y1: 0 };
    const id = comps.length;
    label[i] = id; stack.push(i);
    while (stack.length) {
      const p = stack.pop(), x = p % w, y = (p - x) / w;
      c.area++; c.sx += x; c.sy += y;
      if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x; if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
      if (x > 0 && bin[p - 1] && label[p - 1] < 0) { label[p - 1] = id; stack.push(p - 1); }
      if (x < w - 1 && bin[p + 1] && label[p + 1] < 0) { label[p + 1] = id; stack.push(p + 1); }
      if (y > 0 && bin[p - w] && label[p - w] < 0) { label[p - w] = id; stack.push(p - w); }
      if (y < h - 1 && bin[p + w] && label[p + w] < 0) { label[p + w] = id; stack.push(p + w); }
    }
    c.w = c.x1 - c.x0 + 1; c.h = c.y1 - c.y0 + 1;
    c.cx = c.sx / c.area; c.cy = c.sy / c.area;
    comps.push(c);
  }
  return comps;
}

// A marker is a square ring with a solid square in the middle (7:5:3).
function findMarkers(img) {
  const bin = binarize(img);
  const comps = components(bin, img.w, img.h);
  const rings = comps.filter(c => c.w >= 10 && c.h >= 10 && c.w / c.h > 0.6 && c.w / c.h < 1.67 && c.area / (c.w * c.h) > 0.3 && c.area / (c.w * c.h) < 0.7);
  const markers = [];
  for (const r of rings) {
    const mx = (r.x0 + r.x1) / 2, my = (r.y0 + r.y1) / 2, size = (r.w + r.h) / 2;
    const core = comps.find(c => c !== r && Math.abs(c.cx - mx) < size * 0.12 && Math.abs(c.cy - my) < size * 0.12 &&
      c.w > size * 0.22 && c.w < size * 0.62 && c.h > size * 0.22 && c.h < size * 0.62 && c.area / (c.w * c.h) > 0.55);
    if (!core) continue;
    // Ring and core centroids together give a sub-pixel centre.
    const cx = (r.sx + core.sx) / (r.area + core.area), cy = (r.sy + core.sy) / (r.area + core.area);
    markers.push({ x: (cx + 0.5) * img.f - 0.5, y: (cy + 0.5) * img.f - 0.5, size: size * img.f });
  }
  return markers;
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// Groups markers into sheets: a short edge, then the two far corners where a
// rectangle of the right shape says they should be.
function groupSheets(markers) {
  const quads = [];
  for (const a of markers) for (const b of markers) {
    if (a === b) continue;
    const ratio = Math.max(a.size, b.size) / Math.min(a.size, b.size);
    if (ratio > 1.6) continue;
    const k = (a.size + b.size) / 2 / MARKER; // px per mm
    const d = dist(a, b);
    if (Math.abs(d - SHORT * k) > SHORT * k * 0.3) continue;
    const ux = (b.x - a.x) / d, uy = (b.y - a.y) / d;
    const L = d * LONG / SHORT;
    for (const s of [1, -1]) {
      const ec = { x: a.x - uy * L * s, y: a.y + ux * L * s }, ed = { x: b.x - uy * L * s, y: b.y + ux * L * s };
      let c = null, d2 = null, ec2 = Infinity, ed2 = Infinity;
      for (const m of markers) {
        if (m === a || m === b) continue;
        const e1 = dist(m, ec), e2 = dist(m, ed);
        if (e1 < ec2) { ec2 = e1; c = m; }
        if (e2 < ed2) { ed2 = e2; d2 = m; }
      }
      if (!c || !d2 || c === d2 || ec2 > L * 0.2 || ed2 > L * 0.2) continue;
      quads.push({ pts: [a, b, c, d2], score: (ec2 + ed2) / L });
    }
  }
  quads.sort((p, q) => p.score - q.score);
  const used = new Set(), sheets = [];
  for (const q of quads) {
    if (q.pts.some(p => used.has(p))) continue;
    q.pts.forEach(p => used.add(p));
    let [a, b, c, d] = q.pts;
    // Make it TL, TR, BL, BR going clockwise on screen (y down).
    if ((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x) < 0) [a, b, c, d] = [b, a, d, c];
    sheets.push([a, b, c, d]);
  }
  return sheets;
}

// ---------- geometry ----------

// Homography taking frame mm to image px, from four point pairs.
function homography(src, dst) {
  const A = [], B = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); B.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); B.push(v);
  }
  for (let i = 0; i < 8; i++) {
    let p = i;
    for (let r = i + 1; r < 8; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
    [A[i], A[p]] = [A[p], A[i]]; [B[i], B[p]] = [B[p], B[i]];
    for (let r = 0; r < 8; r++) {
      if (r === i) continue;
      const f = A[r][i] / A[i][i];
      for (let c = i; c < 8; c++) A[r][c] -= f * A[i][c];
      B[r] -= f * B[i];
    }
  }
  const h = B.map((b, i) => b / A[i][i]);
  return [...h, 1];
}

// Samples the raster into a straightened image of the frame area plus margin.
function warp(r, H, x0, y0, x1, y1) {
  const w = Math.round((x1 - x0) * RES), h = Math.round((y1 - y0) * RES);
  const out = new Float32Array(w * h);
  for (let j = 0; j < h; j++) {
    const fy = y0 + (j + 0.5) / RES;
    for (let i = 0; i < w; i++) {
      const fx = x0 + (i + 0.5) / RES;
      const z = H[6] * fx + H[7] * fy + H[8];
      const u = (H[0] * fx + H[1] * fy + H[2]) / z, v = (H[3] * fx + H[4] * fy + H[5]) / z;
      const ix = Math.floor(u), iy = Math.floor(v);
      if (ix < 0 || iy < 0 || ix >= r.w - 1 || iy >= r.h - 1) { out[j * w + i] = 1; continue; }
      const ax = u - ix, ay = v - iy, p = iy * r.w + ix, d = r.data;
      out[j * w + i] = (d[p] * (1 - ax) + d[p + 1] * ax) * (1 - ay) + (d[p + r.w] * (1 - ax) + d[p + r.w + 1] * ax) * ay;
    }
  }
  return { w, h, data: out, x0, y0 };
}

// Divides by the local paper brightness so shadows and grey scans become white.
function flatten(img) {
  const B = 3 * RES;
  const bw = Math.ceil(img.w / B), bh = Math.ceil(img.h / B);
  const bg = new Float32Array(bw * bh);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    const vals = [];
    for (let y = by * B; y < Math.min(img.h, (by + 1) * B); y += 2) for (let x = bx * B; x < Math.min(img.w, (bx + 1) * B); x += 2) vals.push(img.data[y * img.w + x]);
    vals.sort((a, b) => a - b);
    bg[by * bw + bx] = vals[Math.floor(vals.length * 0.9)] || 1;
  }
  // Take the brighter of each block and its neighbours, so a block full of ink still finds paper.
  const bg2 = new Float32Array(bg.length);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    let m = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const x = bx + dx, y = by + dy;
      if (x >= 0 && y >= 0 && x < bw && y < bh) m = Math.max(m, bg[y * bw + x]);
    }
    bg2[by * bw + bx] = Math.max(m, 0.15);
  }
  const ink = new Float32Array(img.w * img.h);
  for (let y = 0; y < img.h; y++) {
    const gy = Math.min(bh - 1, Math.max(0, (y + 0.5) / B - 0.5)), y0 = Math.floor(gy), y1 = Math.min(bh - 1, y0 + 1), fy = gy - y0;
    for (let x = 0; x < img.w; x++) {
      const gx = Math.min(bw - 1, Math.max(0, (x + 0.5) / B - 0.5)), x0 = Math.floor(gx), x1 = Math.min(bw - 1, x0 + 1), fx = gx - x0;
      const b = (bg2[y0 * bw + x0] * (1 - fx) + bg2[y0 * bw + x1] * fx) * (1 - fy) + (bg2[y1 * bw + x0] * (1 - fx) + bg2[y1 * bw + x1] * fx) * fy;
      ink[y * img.w + x] = Math.max(0, Math.min(1, 1 - img.data[y * img.w + x] / b));
    }
  }
  return { ...img, data: ink };
}

function readQR(r, H) {
  const q = warp(r, H, 143, -5, 179, 27);
  const rgba = new Uint8ClampedArray(q.w * q.h * 4);
  for (let i = 0; i < q.data.length; i++) {
    const v = q.data[i] < 0.55 ? 0 : 255;
    rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = v; rgba[i * 4 + 3] = 255;
  }
  const res = jsQR(rgba, q.w, q.h, { inversionAttempts: 'dontInvert' });
  if (!res) return null;
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(res.binaryData)); } catch { text = res.data; }
  return decodeTag(text);
}

// ---------- public ----------

export function findSheets(r) {
  const small = downscale(r);
  const markers = findMarkers(small);
  const found = [], quads = groupSheets(markers);
  let unreadable = 0;
  for (const quad of quads) {
    // The short edges are always top and bottom, so a sideways photo is fine;
    // that leaves upright or upside down, and the QR code decides.
    let ok = false;
    for (const order of [[0, 1, 2, 3], [3, 2, 1, 0]]) {
      const H = homography(CORNERS, order.map(i => [quad[i].x, quad[i].y]));
      const tag = readQR(r, H);
      if (!tag) continue;
      const img = flatten(warp(r, H, -MARGIN, -MARGIN, FRAME.w + MARGIN, FRAME.h + MARGIN));
      found.push({ tag, img, source: r.source });
      ok = true;
      break;
    }
    if (!ok) unreadable++;
  }
  // Enough to explain a failure: what was seen and where the markers were.
  return { sheets: found, markers, quads: quads.length, unreadable, preview: small };
}

// The ink of one box, in mm relative to the box, as a darkness field, with
// the printed guide lines and label taken out. The label strip is included
// because tall letters reach into it.
function rawField(sheet, index) {
  const r = cellRect(index), img = sheet.img;
  const inset = 0.7;
  const x0 = Math.round((r.x + inset - img.x0) * RES), y0 = Math.round((r.y + inset - img.y0) * RES);
  const x1 = Math.round((r.x + r.w - inset - img.x0) * RES), y1 = Math.round((r.y + r.h - inset - img.y0) * RES);
  const w = x1 - x0, h = y1 - y0, data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = img.data[(y0 + y) * img.w + x0 + x];
  // Origin of the field in box mm, so tracing can place the baseline.
  return { w, h, data, ox: x0 / RES + img.x0 - r.x, oy: y0 / RES + img.y0 - r.y, rect: r };
}

export function cellField(sheet, index, label = '') {
  const f = rawField(sheet, index);
  removeGuides(f, label, rowGuides(sheet, Math.floor(index / GRID.cols)));
  return f;
}

// The printed guides are identical in every box of a grid row, so the median
// of the neighbours' measurements is what a guide really looks like there.
// A box whose own measurement is much darker has ink lying along the guide
// (like the crossbar of an H on the dashed line) and uses the median instead.
function rowGuides(sheet, gridRow) {
  sheet.guides ??= new Map();
  if (!sheet.guides.has(gridRow)) {
    const count = PAGES[sheet.tag.page].chars.length;
    const per = [];
    for (let c = 0; c < GRID.cols; c++) {
      const i = gridRow * GRID.cols + c;
      if (i < count) per.push(measureGuides(rawField(sheet, i)));
    }
    const med = per[0].map((rows, li) => rows.map((_, yi) => {
      const v = per.map(m => m[li][yi]).sort((a, b) => a - b);
      return v[Math.floor(v.length / 2)];
    }));
    sheet.guides.set(gridRow, med);
  }
  return sheet.guides.get(gridRow);
}

// Pencil is about as dark as the printed guides, so a plain threshold can't
// tell them apart. Instead, near each guide the darkness of the line itself is
// measured row by row (the typical value across the box, which ink barely
// affects) and divided out. Paper under the line becomes white again, while a
// stroke crossing it keeps its own darkness.
function guideLines(f) {
  const { w } = f;
  const row = mm => Math.round((mm - f.oy) * RES);
  const right = f.rect.w - f.ox - w / RES; // inset on the right, mm
  const lines = [
    { y: CELL.xHeight, x0: 0, x1: w, dashed: true },
    { y: CELL.baseline, x0: 0, x1: w },
    // capital marks: short ticks at both edges
    { y: CELL.cap, x0: 0, x1: Math.round((2.6 - f.ox) * RES) },
    { y: CELL.cap, x0: w - Math.round((2.6 - right) * RES), x1: w },
    { y: CELL.band, x0: 0, x1: w }, // edge of the shaded strip
  ];
  const search = Math.round(1.2 * RES);
  return lines.map(L => ({ ...L, x0: Math.max(0, L.x0), x1: Math.min(w, L.x1), ya: row(L.y) - search, yb: row(L.y) + search }));
}

// For each guide, its darkness in every pixel row near it (null outside the box).
function measureGuides(f) {
  const { w, h, data } = f;
  return guideLines(f).map(L => {
    const out = [];
    for (let y = L.ya; y <= L.yb; y++) {
      if (y < 0 || y >= h || L.x1 - L.x0 < 3) { out.push(0); continue; }
      const vals = [];
      for (let x = L.x0; x < L.x1; x++) vals.push(data[y * w + x]);
      vals.sort((a, b) => a - b);
      // Half of a dashed line is gaps, so look higher up the range for it.
      out.push(vals[Math.floor(vals.length * (L.dashed ? 0.7 : 0.5))]);
    }
    return out;
  });
}

function removeGuides(f, label, rowMedian) {
  const { w, h, data } = f;
  const row = mm => Math.round((mm - f.oy) * RES);
  const own = measureGuides(f);
  guideLines(f).forEach((L, li) => {
    const x0 = L.x0, x1 = L.x1;
    if (x1 - x0 < 3) return;
    for (let y = Math.max(0, L.ya); y <= Math.min(h - 1, L.yb); y++) {
      const yi = y - L.ya;
      let line = own[li][yi];
      const ref = rowMedian ? rowMedian[li][yi] : line;
      if (line > ref * 1.5 + 0.05) line = ref;
      if (line < 0.03) continue;
      for (let x = x0; x < x1; x++) {
        const i = y * w + x;
        data[i] = Math.max(0, 1 - (1 - data[i]) / (1 - line));
      }
    }
  });
  // Label (and its hint word) in the top-left of the strip. Its width is an
  // overestimate from the character count, which is plenty: letters rarely reach there.
  const labelW = 1.4 + 2.6 + (label.length > 1 ? 1 + 1.15 * (label.length - 2) : 0) + 0.6;
  const lx1 = Math.min(w, Math.round((labelW - f.ox) * RES)), ly1 = Math.min(h, row(CELL.band - 0.2));
  for (let y = 0; y < ly1; y++) for (let x = 0; x < lx1; x++) data[y * w + x] = 0;
  // Whatever is left of the shaded strip is very light; drop it.
  for (let y = 0; y < ly1; y++) for (let x = 0; x < w; x++) data[y * w + x] = Math.max(0, data[y * w + x] - 0.12);
}

// Ink darkness for a sheet, from its strokes: felt pen is near 0.9, pencil 0.4.
// Returns the threshold that traces at about half the stroke darkness.
export function inkThreshold(fields) {
  const vals = [];
  for (const f of fields) for (let i = 0; i < f.data.length; i += 3) if (f.data[i] > 0.12) vals.push(f.data[i]);
  if (vals.length < 400) return 0.45;
  vals.sort((a, b) => a - b);
  const ink = vals[Math.floor(vals.length * 0.8)];
  return Math.min(0.5, Math.max(0.16, ink * 0.5));
}

export function pageChars(tag) {
  const alt = PAGES[tag.page].alt;
  return PAGES[tag.page].chars.map((ch, i) => ({ ch, key: alt ? ch + '.alt' : ch, index: i, label: ch + ((alt ? '2nd' : HINTS[ch]) || '') }));
}

export { CELL };
