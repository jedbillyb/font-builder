// Builds one sheet page as a display list in frame coordinates (mm, y down).
// Text is turned into outlines so the PDF needs no embedded fonts and opens
// the same in Illustrator, Procreate or a browser.
import { FRAME, MARKER, CELL, PAGES, SHEETS, HINTS, cellRect, encodeTag } from './layout.js';

// Everything inside a box except your own ink is lighter than CELL_LABEL, so the
// scanner can drop it with a single threshold.
const INK = 0, LABEL = 0.3, HINT = 0.5, BORDER = 0.45, BAND = 0.91, BASELINE = 0.62, GUIDE = 0.74, CELL_LABEL = 0.58, CELL_HINT = 0.66;

export class TextSet {
  // fonts: opentype.js fonts in fallback order
  constructor(regular, bold) { this.regular = regular; this.bold = bold; }

  layout(str, x, y, size, { bold = false, align = 'left', path = true } = {}) {
    const fonts = bold ? this.bold : this.regular;
    const glyphs = [];
    let w = 0;
    for (const ch of str) {
      const f = fonts.find(f => f.charToGlyphIndex(ch) > 0) || fonts[0];
      const g = f.charToGlyph(ch);
      glyphs.push({ g, f, x: w });
      w += g.advanceWidth * size / f.unitsPerEm;
    }
    const x0 = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    if (!path) return { width: w };
    const cmds = [];
    for (const { g, x: gx } of glyphs) cmds.push(...g.getPath(x0 + gx, y, size).commands);
    return { width: w, cmds };
  }
}

function text(items, ts, str, x, y, size, gray, opts) {
  const r = ts.layout(str, x, y, size, opts);
  if (r.cmds.length) items.push({ t: 'path', cmds: r.cmds, fill: gray });
  return r.width;
}

function marker(items, x, y) {
  const u = MARKER / 7;
  items.push({ t: 'rect', x, y, w: MARKER, h: MARKER, fill: INK });
  items.push({ t: 'rect', x: x + u, y: y + u, w: 5 * u, h: 5 * u, fill: 1 });
  items.push({ t: 'rect', x: x + 2 * u, y: y + 2 * u, w: 3 * u, h: 3 * u, fill: INK });
}

function qr(items, payload, x, y, size) {
  const q = qrcode(0, 'M');
  q.addData(payload, 'Byte');
  q.make();
  const n = q.getModuleCount(), m = size / n;
  // One path for the whole code: separate rectangles leave hairline seams
  // between rows when anti-aliased, and those stop the code being read.
  const cmds = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!q.isDark(r, c)) continue;
      let e = c;
      while (e + 1 < n && q.isDark(r, e + 1)) e++;
      const x0 = x + c * m, x1 = x + (e + 1) * m, y0 = y + r * m, y1 = y0 + m;
      cmds.push({ type: 'M', x: x0, y: y0 }, { type: 'L', x: x1, y: y0 }, { type: 'L', x: x1, y: y1 }, { type: 'L', x: x0, y: y1 }, { type: 'Z' });
      c = e;
    }
  }
  items.push({ t: 'path', cmds, fill: INK });
}

function cell(items, ts, ch, alt, r) {
  const { x, y, w, h } = r;
  items.push({ t: 'rect', x, y, w, h: CELL.band, fill: BAND });
  const lw = text(items, ts, ch, x + 1.4, y + 2.85, 2.9, CELL_LABEL);
  const hint = alt ? '2nd' : HINTS[ch];
  if (hint) text(items, ts, hint, x + 1.4 + lw + 1, y + 2.7, 2, CELL_HINT);
  items.push({ t: 'line', x1: x, y1: y + CELL.cap, x2: x + 2.2, y2: y + CELL.cap, stroke: BASELINE, lw: 0.25 });
  items.push({ t: 'line', x1: x + w - 2.2, y1: y + CELL.cap, x2: x + w, y2: y + CELL.cap, stroke: BASELINE, lw: 0.25 });
  items.push({ t: 'line', x1: x, y1: y + CELL.xHeight, x2: x + w, y2: y + CELL.xHeight, stroke: GUIDE, lw: 0.2, dash: [1, 1] });
  items.push({ t: 'line', x1: x, y1: y + CELL.baseline, x2: x + w, y2: y + CELL.baseline, stroke: BASELINE, lw: 0.25 });
  items.push({ t: 'box', x, y, w, h, stroke: BORDER, lw: 0.35 });
}

export function buildPage(ts, { sheet, pageIndex, id, name, digital = false }) {
  const pageKey = SHEETS[sheet].pages[pageIndex];
  const page = PAGES[pageKey];
  const pageCount = SHEETS[sheet].pages.length;
  const items = [];
  const W = FRAME.w, H = FRAME.h;

  for (const [mx, my] of [[0, 0], [W - MARKER, 0], [0, H - MARKER], [W - MARKER, H - MARKER]]) marker(items, mx, my);

  // Header
  text(items, ts, 'Handwriting font', 12, 6.4, 5.4, INK, { bold: true });
  text(items, ts, `${SHEETS[sheet].label} sheet, page ${pageIndex + 1} of ${pageCount}: ${page.title}`, 12, 11.6, 3.2, LABEL);
  const nw = text(items, ts, 'Name', 12, 19.5, 3.6, LABEL);
  items.push({ t: 'line', x1: 12 + nw + 2, y1: 20.1, x2: 136, y2: 20.1, stroke: BASELINE, lw: 0.3 });
  if (name) text(items, ts, name, 12 + nw + 4, 19.1, 5.6, INK, { bold: true });
  qr(items, encodeTag({ sheet, page: pageKey, id, name }), 150, 0, 22);

  const lines = page.alt
    ? ['Write a second version of each character, a little different from your first one.',
       'Your font will swap between the two, so repeated letters don\'t look identical.']
    : digital
    ? ['Draw each character in black inside its box, sitting on the solid line. Draw on a new layer and don\'t move the sheet.',
       'Small letters reach the dashed line, capitals reach the short marks, and tails on g, j, p, q, y hang below.']
    : ['Use a dark pen or pencil (felt pen works best). Write each character inside its box, sitting on the solid line.',
       'Small letters reach the dashed line, capitals reach the short marks, and tails on g, j, p, q, y hang below.'];
  text(items, ts, lines[0], 12, 25.2, 2.9, INK);
  text(items, ts, lines[1], 12, 29, 2.9, INK);

  page.chars.forEach((ch, i) => cell(items, ts, ch, page.alt, cellRect(i)));

  // Footer between the bottom markers
  text(items, ts, digital ? 'Keep the four corner squares on the page and don\'t crop it.' : 'Keep the four corner squares visible and don\'t fold the sheet.', 12, H - 2.6, 2.6, HINT);
  text(items, ts, 'font.jedbillyb.com', W - 12, H - 2.6, 2.6, HINT, { align: 'right' });

  return items;
}

export function newId() {
  const a = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(a, b => (b % 36).toString(36)).join('');
}

// One entry per printed page: a set of pages for each person.
export function planPages(sheet, names, copies, digital = false) {
  const people = names.length ? names : Array.from({ length: Math.max(1, copies) }, () => '');
  const out = [];
  for (const name of people) {
    const id = newId();
    SHEETS[sheet].pages.forEach((_, pageIndex) => out.push({ sheet, pageIndex, id, name, digital }));
  }
  return out;
}
