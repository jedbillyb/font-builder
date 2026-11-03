// Traces the ink in one box into TrueType contours (quadratic, font units).
// The outline is the iso-line of a lightly blurred darkness field, found with
// marching squares, so edges come out smooth instead of stair-stepped.
import { CELL } from './layout.js';
import { RES } from './scan.js';

export const UNITS_PER_MM = 700 / (CELL.baseline - CELL.cap); // cap height = 700 units

const MIN_AREA = 0.06;   // mm², smaller specks are dropped (a tiny full stop is about 0.15)

function blur(f, w, h, sigma) {
  const r = Math.ceil(sigma * 2.5), k = [];
  let s = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp(-i * i / (2 * sigma * sigma)); k.push(v); s += v; }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = 0;
    for (let i = -r; i <= r; i++) { const xx = Math.min(w - 1, Math.max(0, x + i)); a += f[y * w + xx] * k[i + r]; }
    tmp[y * w + x] = a;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = 0;
    for (let i = -r; i <= r; i++) { const yy = Math.min(h - 1, Math.max(0, y + i)); a += tmp[yy * w + x] * k[i + r]; }
    out[y * w + x] = a;
  }
  return out;
}

// Zeroes connected marks that are too small or too faint to be ink
// (dust, guide-line remains, a label that printed too dark).
function clean(f, w, h, t, minPeak) {
  const seen = new Uint8Array(w * h), stack = [], minPx = MIN_AREA * RES * RES;
  for (let i = 0; i < f.length; i++) {
    if (seen[i] || f[i] <= t) continue;
    const pix = [];
    let peak = 0;
    seen[i] = 1; stack.push(i);
    while (stack.length) {
      const p = stack.pop(), x = p % w;
      pix.push(p); if (f[p] > peak) peak = f[p];
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) {
        if (q >= 0 && q < f.length && !seen[q] && f[q] > t) { seen[q] = 1; stack.push(q); }
      }
    }
    if (pix.length < minPx || peak < minPeak) for (const p of pix) f[p] = 0;
  }
}

// Marching squares. Returns closed loops in pixel coordinates.
function isoLoops(f, w, h, t) {
  const W = w + 2, Hh = h + 2;
  const v = (i, j) => (i <= 0 || j <= 0 || i > w || j > h) ? 0 : f[(j - 1) * w + (i - 1)];
  const hKey = (i, j) => (j * W + i) * 2, vKey = (i, j) => (j * W + i) * 2 + 1;
  const adj = new Map();
  const link = (a, b) => {
    if (!adj.has(a)) adj.set(a, []); if (!adj.has(b)) adj.set(b, []);
    adj.get(a).push(b); adj.get(b).push(a);
  };
  for (let j = 0; j < Hh - 1; j++) for (let i = 0; i < W - 1; i++) {
    const tl = v(i, j), tr = v(i + 1, j), br = v(i + 1, j + 1), bl = v(i, j + 1);
    const c = (tl > t ? 8 : 0) | (tr > t ? 4 : 0) | (br > t ? 2 : 0) | (bl > t ? 1 : 0);
    if (c === 0 || c === 15) continue;
    const T = hKey(i, j), B = hKey(i, j + 1), L = vKey(i, j), R = vKey(i + 1, j);
    const mid = (tl + tr + br + bl) / 4 > t;
    switch (c) {
      case 1: case 14: link(L, B); break;
      case 2: case 13: link(B, R); break;
      case 3: case 12: link(L, R); break;
      case 4: case 11: link(T, R); break;
      case 6: case 9: link(T, B); break;
      case 7: case 8: link(L, T); break;
      case 5: if (mid) { link(L, T); link(B, R); } else { link(T, R); link(L, B); } break;
      case 10: if (mid) { link(T, R); link(L, B); } else { link(L, T); link(B, R); } break;
    }
  }
  const pos = key => {
    const cell = key >> 1, i = cell % W, j = (cell - i) / W;
    if (key & 1) { const a = v(i, j), b = v(i, j + 1); return [i, j + (t - a) / (b - a)]; }
    const a = v(i, j), b = v(i + 1, j); return [i + (t - a) / (b - a), j];
  };
  const loops = [], done = new Set();
  for (const start of adj.keys()) {
    if (done.has(start)) continue;
    const loop = [];
    let prev = -1, cur = start;
    while (cur !== undefined && !done.has(cur)) {
      done.add(cur);
      const [x, y] = pos(cur);
      loop.push([x - 1, y - 1]); // undo the padding
      const n = adj.get(cur);
      const next = n[0] !== prev ? n[0] : n[1];
      prev = cur; cur = next;
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

function area(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] - pts[i][0]) * (pts[j][1] + pts[i][1]);
  return a / 2;
}

function simplify(pts, eps) {
  // Douglas-Peucker on a closed loop, split at the two farthest-apart points.
  const n = pts.length;
  if (n < 8) return pts;
  let far = 0, fd = 0;
  for (let i = 1; i < n; i++) { const d = (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2; if (d > fd) { fd = d; far = i; } }
  const keep = new Uint8Array(n); keep[0] = keep[far] = 1;
  const rec = (a, b) => {
    const [ax, ay] = pts[a], [bx, by] = pts[b % n];
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
    let md = 0, mi = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i % n];
      const d = Math.abs(dy * px - dx * py + bx * ay - by * ax) / len;
      if (d > md) { md = d; mi = i; }
    }
    if (md > eps && mi >= 0) { keep[mi % n] = 1; rec(a, mi); rec(mi, b); }
  };
  rec(0, far); rec(far, n);
  return pts.filter((_, i) => keep[i]);
}

function inside(pt, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}

// Polygon vertices become off-curve points, so TrueType draws a smooth
// quadratic spline through the midpoints. Sharp turns stay as corners.
function toQuadratic(poly) {
  const n = poly.length, out = [];
  const corner = poly.map((p, i) => {
    const a = poly[(i + n - 1) % n], b = poly[(i + 1) % n];
    const v1 = [p[0] - a[0], p[1] - a[1]], v2 = [b[0] - p[0], b[1] - p[1]];
    const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / ((Math.hypot(...v1) * Math.hypot(...v2)) || 1);
    return cos < Math.cos(75 * Math.PI / 180);
  });
  for (let i = 0; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    out.push({ x: p[0], y: p[1], on: corner[i] });
    if (!corner[i] && !corner[(i + 1) % n]) out.push({ x: (p[0] + q[0]) / 2, y: (p[1] + q[1]) / 2, on: true });
  }
  // Round, and drop on-curve points that land on top of each other.
  const r = [];
  for (const p of out) {
    const q = { x: Math.round(p.x), y: Math.round(p.y), on: p.on };
    const last = r[r.length - 1];
    if (last && last.x === q.x && last.y === q.y) { last.on = last.on || q.on; continue; }
    r.push(q);
  }
  while (r.length > 2 && r[0].x === r[r.length - 1].x && r[0].y === r[r.length - 1].y) r.pop();
  return r;
}

// field: from cellField(). Returns { contours, inkArea (mm²), bounds } or null for an empty box.
// threshold comes from inkThreshold(): lower for pencil, which is also grainier,
// so it gets a little more smoothing.
export function traceCell(field, threshold = 0.45) {
  const { w, h, ox, oy } = field;
  const f = blur(field.data, w, h, threshold < 0.3 ? 1.3 : 0.9);
  // A mark must be clearly darker than the threshold somewhere to count as ink.
  clean(f, w, h, threshold, threshold * 1.3);
  const loops = isoLoops(f, w, h, threshold);
  // pixel -> font units (y up, baseline at 0)
  const toFont = ([x, y]) => [(ox + (x + 0.5) / RES) * UNITS_PER_MM, (CELL.baseline - (oy + (y + 0.5) / RES)) * UNITS_PER_MM];
  const minA = MIN_AREA * UNITS_PER_MM * UNITS_PER_MM;
  let polys = loops.map(l => simplify(l, 0.4).map(toFont)).filter(p => p.length >= 3 && Math.abs(area(p)) > minA * 0.25);
  if (!polys.length) return null;
  // Outer contours clockwise, holes anticlockwise (y up), decided by nesting depth.
  let ink = 0;
  polys = polys.map((p, i) => {
    const depth = polys.reduce((d, q, j) => d + (j !== i && inside(p[0], q) ? 1 : 0), 0);
    const a = area(p); // positive = anticlockwise (y up)
    const outer = depth % 2 === 0;
    ink += outer ? Math.abs(a) : -Math.abs(a);
    return (outer ? a > 0 : a < 0) ? p.slice().reverse() : p;
  });
  const inkMm = ink / (UNITS_PER_MM * UNITS_PER_MM);
  if (inkMm < 0.1) return null;
  const contours = polys.map(toQuadratic).filter(c => c.length >= 3);
  const xs = contours.flat().map(p => p.x), ys = contours.flat().map(p => p.y);
  return { contours, inkArea: inkMm, bounds: { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) } };
}
