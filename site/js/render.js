// Renders sheet display lists to a PDF file or to SVG for the on-page preview.
// Each page is { paper: {w, h}, ox, oy, items } with ox/oy the frame offset in mm.

const PT = 72 / 25.4;
const num = v => (Math.round(v * 100) / 100).toString();

function pathOps(cmds, P) {
  let out = '', cx = 0, cy = 0, sx = 0, sy = 0;
  for (const c of cmds) {
    if (c.type === 'M') { out += `${P(c.x, c.y)} m\n`; cx = sx = c.x; cy = sy = c.y; }
    else if (c.type === 'L') { out += `${P(c.x, c.y)} l\n`; cx = c.x; cy = c.y; }
    else if (c.type === 'C') { out += `${P(c.x1, c.y1)} ${P(c.x2, c.y2)} ${P(c.x, c.y)} c\n`; cx = c.x; cy = c.y; }
    else if (c.type === 'Q') {
      const x1 = cx + 2 / 3 * (c.x1 - cx), y1 = cy + 2 / 3 * (c.y1 - cy);
      const x2 = c.x + 2 / 3 * (c.x1 - c.x), y2 = c.y + 2 / 3 * (c.y1 - c.y);
      out += `${P(x1, y1)} ${P(x2, y2)} ${P(c.x, c.y)} c\n`; cx = c.x; cy = c.y;
    } else if (c.type === 'Z') { out += 'h\n'; cx = sx; cy = sy; }
  }
  return out;
}

function pageContent({ paper, ox, oy, items }) {
  const X = x => num((x + ox) * PT), Y = y => num((paper.h - (y + oy)) * PT);
  const P = (x, y) => `${X(x)} ${Y(y)}`;
  let s = '';
  for (const it of items) {
    if (it.t === 'rect') {
      s += `${num(it.fill)} g ${X(it.x)} ${Y(it.y + it.h)} ${num(it.w * PT)} ${num(it.h * PT)} re f\n`;
    } else if (it.t === 'box') {
      s += `${num(it.stroke)} G ${num(it.lw * PT)} w [] 0 d ${X(it.x)} ${Y(it.y + it.h)} ${num(it.w * PT)} ${num(it.h * PT)} re S\n`;
    } else if (it.t === 'line') {
      const dash = it.dash ? `[${it.dash.map(d => num(d * PT)).join(' ')}] 0 d` : '[] 0 d';
      s += `${num(it.stroke)} G ${num(it.lw * PT)} w ${dash} ${P(it.x1, it.y1)} m ${P(it.x2, it.y2)} l S\n`;
    } else if (it.t === 'path') {
      s += `${num(it.fill)} g\n${pathOps(it.cmds, P)}f\n`;
    }
  }
  return s;
}

async function deflate(bytes) {
  const cs = new CompressionStream('deflate');
  const w = cs.writable.getWriter();
  w.write(bytes); w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

export async function toPDF(pages, { title = 'Handwriting font sheet' } = {}) {
  const enc = new TextEncoder();
  const chunks = [];
  let size = 0;
  const offsets = [];
  const push = b => { if (typeof b === 'string') b = enc.encode(b); chunks.push(b); size += b.length; };
  const obj = (n, body) => { offsets[n] = size; push(`${n} 0 obj\n`); for (const b of [].concat(body)) push(b); push('\nendobj\n'); };

  push('%PDF-1.4\n');
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  const pageObjs = pages.map((_, i) => 4 + i * 2);
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Count ${pages.length} /Kids [${pageObjs.map(n => `${n} 0 R`).join(' ')}] >>`);
  const safeTitle = title.replace(/[^\x20-\x7e]/g, '').replace(/[\\()]/g, m => '\\' + m);
  obj(3, `<< /Title (${safeTitle}) /Producer (font.jedbillyb.com) >>`);

  for (let i = 0; i < pages.length; i++) {
    const p = pages[i], n = pageObjs[i];
    obj(n, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(p.paper.w * PT)} ${num(p.paper.h * PT)}] /Resources << >> /Contents ${n + 1} 0 R >>`);
    const data = await deflate(enc.encode(pageContent(p)));
    obj(n + 1, [`<< /Length ${data.length} /Filter /FlateDecode >>\nstream\n`, data, '\nendstream']);
  }

  const count = 4 + pages.length * 2;
  const xref = size;
  let x = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let n = 1; n < count; n++) x += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  push(x);
  push(`trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

// Legacy (version 3, PostScript based) Illustrator file. Modern Illustrator
// still opens these and, unlike a PDF, they keep layers: the sheet goes in a
// locked "Sheet" layer with an empty "Draw here" layer on top. The format has
// a single artboard, so pages sit side by side with AI_GAP mm between them.
// A page's optional `draw` items go in the Draw here layer (used for test files).
export const AI_GAP = 20;

function aiPage({ paper, ox, oy, items }, dx, H) {
  const X = x => num((x + ox + dx) * PT), Y = y => num((H - (y + oy)) * PT);
  const P = (x, y) => `${X(x)} ${Y(y)}`;
  let s = '';
  const rect = (x, y, w, h) => `${P(x, y)} m\n${P(x + w, y)} L\n${P(x + w, y + h)} L\n${P(x, y + h)} L\n${P(x, y)} L\n`;
  for (const it of items) {
    if (it.t === 'rect') {
      s += `${num(it.fill)} g\n${rect(it.x, it.y, it.w, it.h)}f\n`;
    } else if (it.t === 'box') {
      s += `${num(it.stroke)} G ${num(it.lw * PT)} w []0 d\n${rect(it.x, it.y, it.w, it.h)}s\n`;
    } else if (it.t === 'line') {
      const dash = it.dash ? `[${it.dash.map(d => num(d * PT)).join(' ')}]0 d` : '[]0 d';
      s += `${num(it.stroke)} G ${num(it.lw * PT)} w ${dash}\n${P(it.x1, it.y1)} m\n${P(it.x2, it.y2)} L\nS\n`;
    } else if (it.t === 'path') {
      // One compound path per item, each sub-path closed and filled. Illustrator
      // drops the last point of a closed sub-path, assuming it repeats the
      // first, so every sub-path is explicitly brought back to its start.
      let body = '', open = false, cx = 0, cy = 0, sx = 0, sy = 0;
      const close = () => {
        if (Math.abs(cx - sx) > 1e-6 || Math.abs(cy - sy) > 1e-6) body += `${P(sx, sy)} L\n`;
        body += 'f\n'; open = false; cx = sx; cy = sy;
      };
      for (const c of it.cmds) {
        if (c.type === 'M') { if (open) close(); body += `${P(c.x, c.y)} m\n`; open = true; cx = sx = c.x; cy = sy = c.y; }
        else if (c.type === 'L') { body += `${P(c.x, c.y)} L\n`; cx = c.x; cy = c.y; }
        else if (c.type === 'C') { body += `${P(c.x1, c.y1)} ${P(c.x2, c.y2)} ${P(c.x, c.y)} C\n`; cx = c.x; cy = c.y; }
        else if (c.type === 'Q') {
          const x1 = cx + 2 / 3 * (c.x1 - cx), y1 = cy + 2 / 3 * (c.y1 - cy);
          const x2 = c.x + 2 / 3 * (c.x1 - c.x), y2 = c.y + 2 / 3 * (c.y1 - c.y);
          body += `${P(x1, y1)} ${P(x2, y2)} ${P(c.x, c.y)} C\n`; cx = c.x; cy = c.y;
        } else if (c.type === 'Z') close();
      }
      if (open) close();
      if (body) s += `${num(it.fill)} g\n*u\n${body}*U\n`;
    }
  }
  return s;
}

export function toAI(pages, { title = 'Handwriting font sheet' } = {}) {
  const H = Math.max(...pages.map(p => p.paper.h));
  let W = 0;
  const offsets = pages.map(p => { const x = W; W += p.paper.w + AI_GAP; return x; });
  W -= AI_GAP;
  const w = num(W * PT), h = num(H * PT);
  const safeTitle = title.replace(/[^\x20-\x7e]/g, '').replace(/[\\()]/g, '');
  let s = `%!PS-Adobe-3.0
%%Creator: font.jedbillyb.com
%%Title: (${safeTitle})
%%BoundingBox: 0 0 ${Math.ceil(W * PT)} ${Math.ceil(H * PT)}
%%HiResBoundingBox: 0 0 ${w} ${h}
%AI5_FileFormat 3.0
%AI3_ColorUsage: Black&White
%AI3_TemplateBox: ${num(W * PT / 2)} ${num(H * PT / 2)} ${num(W * PT / 2)} ${num(H * PT / 2)}
%AI3_TileBox: 0 0 ${w} ${h}
%AI3_DocumentPreview: None
%AI5_ArtSize: ${w} ${h}
%AI5_RulerUnits: 1
%AI5_NumLayers: 2
%%EndComments
%%BeginProlog
%%EndProlog
%%BeginSetup
%%EndSetup
%AI5_BeginLayer
1 1 0 1 0 0 0 79 128 255 Lb
(Sheet) Ln
0 A
0 O
0 R
0 i 0 J 0 j 1 w 4 M []0 d
`;
  pages.forEach((p, i) => { s += aiPage(p, offsets[i], H); });
  s += `LB
%AI5_EndLayer--
%AI5_BeginLayer
1 1 1 1 0 0 1 255 79 79 Lb
(Draw here) Ln
0 A
${pages.map((p, i) => p.draw ? aiPage({ ...p, items: p.draw }, offsets[i], H) : '').join('')}LB
%AI5_EndLayer--
%%PageTrailer
%%Trailer
%%EOF
`;
  return new TextEncoder().encode(s);
}

const hex = g => { const v = Math.round(g * 255).toString(16).padStart(2, '0'); return `#${v}${v}${v}`; };

export function toSVG({ paper, ox, oy, items }) {
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${paper.w} ${paper.h}"><rect width="${paper.w}" height="${paper.h}" fill="#fff"/><g transform="translate(${ox} ${oy})">`;
  for (const it of items) {
    if (it.t === 'rect') s += `<rect x="${num(it.x)}" y="${num(it.y)}" width="${num(it.w)}" height="${num(it.h)}" fill="${hex(it.fill)}"/>`;
    else if (it.t === 'box') s += `<rect x="${num(it.x)}" y="${num(it.y)}" width="${num(it.w)}" height="${num(it.h)}" fill="none" stroke="${hex(it.stroke)}" stroke-width="${it.lw}"/>`;
    else if (it.t === 'line') s += `<line x1="${num(it.x1)}" y1="${num(it.y1)}" x2="${num(it.x2)}" y2="${num(it.y2)}" stroke="${hex(it.stroke)}" stroke-width="${it.lw}"${it.dash ? ` stroke-dasharray="${it.dash.join(' ')}"` : ''}/>`;
    else if (it.t === 'path') {
      let d = '';
      for (const c of it.cmds) {
        if (c.type === 'M' || c.type === 'L') d += `${c.type}${num(c.x)} ${num(c.y)}`;
        else if (c.type === 'Q') d += `Q${num(c.x1)} ${num(c.y1)} ${num(c.x)} ${num(c.y)}`;
        else if (c.type === 'C') d += `C${num(c.x1)} ${num(c.y1)} ${num(c.x2)} ${num(c.y2)} ${num(c.x)} ${num(c.y)}`;
        else if (c.type === 'Z') d += 'Z';
      }
      s += `<path d="${d}" fill="${hex(it.fill)}"/>`;
    }
  }
  return s + '</g></svg>';
}
