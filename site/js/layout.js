// Sheet geometry, shared by the sheet generator and (later) the scanner.
// All sizes are millimetres. Everything is placed inside a fixed frame that is
// centred on the paper, so A4 and US Letter sheets have identical content and
// the scanner only has to find the four corner markers.

export const VERSION = 'FB2'; // FB1 was the 7 x 10 grid, never released

export const PAPER = {
  a4: { w: 210, h: 297, label: 'A4' },
  letter: { w: 215.9, h: 279.4, label: 'US Letter' },
};

export const FRAME = { w: 186, h: 255 };

// Finder pattern in each frame corner (7:5:3 rings, like a QR code).
export const MARKER = 8;

export const GRID = { x: 0, y: 32, cols: 8, rows: 9, cellW: 186 / 8, cellH: 214 / 9 };

// Guide positions inside a cell, measured down from the cell top.
// The label band sits above the writing area and is never traced.
export const CELL = { band: 3.6, cap: 6.6, xHeight: 10.6, baseline: 16.6 }; // cap height 10 mm, x-height 6 mm

const BASIC = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', '.', ',', '!', '?', "'", '"', '-', '&'];
const SYMBOLS = [...'#$%()*+/:;<=>@[\\]^_`{|}~€£¢¥©®™°§¶†•…±×÷¡¿«»µ½¼¾¹²³¬'];

export const PAGES = {
  basic: { code: 'b', title: 'Letters and numbers', chars: BASIC, alt: false },
  symbols: { code: 's', title: 'Symbols', chars: SYMBOLS, alt: false },
  alternates: { code: 'a', title: 'Second versions', chars: BASIC, alt: true },
};

export const SHEETS = {
  quick: { code: 'q', label: 'Quick', pages: ['basic'] },
  standard: { code: 's', label: 'Standard', pages: ['basic', 'symbols'] },
  complete: { code: 'c', label: 'Complete', pages: ['basic', 'symbols', 'alternates'] },
};

// Small words printed next to labels that are easy to mix up.
export const HINTS = {
  I: 'capital i', l: 'small L', O: 'letter', '0': 'zero', o: 'small o',
  '.': 'full stop', ',': 'comma', "'": 'apostrophe', '"': 'quotes', '-': 'hyphen',
  '`': 'backtick', '^': 'caret', '_': 'underscore', '|': 'bar', '~': 'tilde',
  '\\': 'backslash', '/': 'slash', '¬': 'not', '•': 'bullet', '…': 'dots',
  'µ': 'micro', '¡': 'upside down', '¿': 'upside down', '°': 'degree',
  '¹': 'raised 1', '²': 'raised 2', '³': 'raised 3',
};

export function cellRect(index) {
  const col = index % GRID.cols, row = Math.floor(index / GRID.cols);
  return { x: GRID.x + col * GRID.cellW, y: GRID.y + row * GRID.cellH, w: GRID.cellW, h: GRID.cellH };
}

export function glyphKey(page, ch) {
  return PAGES[page].alt ? ch + '.alt' : ch;
}

// QR payload: FB2|sheet|page|id|name
export function encodeTag({ sheet, page, id, name }) {
  return [VERSION, SHEETS[sheet].code, PAGES[page].code, id, name || ''].join('|');
}

export function decodeTag(text) {
  const [v, s, p, id, ...rest] = String(text).split('|');
  if (v !== VERSION) return null;
  const sheet = Object.keys(SHEETS).find(k => SHEETS[k].code === s);
  const page = Object.keys(PAGES).find(k => PAGES[k].code === p);
  if (!sheet || !page) return null;
  return { sheet, page, id, name: rest.join('|') };
}
