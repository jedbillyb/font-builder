// Step 2: read filled-in sheets and turn them into fonts, one per person.
import { SHEETS, PAGES } from './layout.js';
import { loadRasters } from './raster.js';
import { findSheets, cellField, pageChars, inkThreshold } from './scan.js';
import { traceCell } from './trace.js';
import { buildTTF } from './font.js';
import { makeZip } from './zip.js';

const $ = id => document.getElementById(id);
pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

// id -> { name, sheet, pages: Set, glyphs: Map, family, ttf, face, el }
const people = new Map();
let busy = false, timer = null, faceCount = 0;

let queue = [];
const tick = () => new Promise(r => setTimeout(r, 0));
const status = msg => { $('scanStatus').textContent = msg; };

async function addFiles(files) {
  if (!files.length) return;
  // Files added while a scan is running wait their turn instead of being dropped.
  if (busy) { queue.push(...files); return; }
  busy = true;
  $('problems').textContent = '';
  const notes = [];
  let found = 0;
  try {
    for (const file of files) {
      status(`Reading ${file.name}...`); await tick();
      try {
        for await (const r of loadRasters(file)) {
          status(`Looking for sheets in ${r.source}...`); await tick();
          const res = findSheets(r);
          const { sheets } = res;
          if (res.unreadable) problem(r.source, res, `Found the sheet in ${r.source} but couldn't read its QR code (top right corner). Try a sharper photo from closer up, without glare on the code.`);
          else if (!sheets.length) problem(r.source, res, res.markers.length
            ? `Found ${Math.min(res.markers.length, 3)} of the 4 corner squares in ${r.source}. The whole page needs to be in the picture, flat, in focus, and with nothing covering the corners.`
            : `No sheet found in ${r.source}. Is it one of the sheets from this page? All four corner squares need to be in the picture.`);
          for (const s of sheets) {
            found++;
            const p = person(s.tag);
            p.pages.add(s.tag.page);
            const chars = pageChars(s.tag);
            const fields = chars.map(c => cellField(s, c.index, c.label));
            const threshold = inkThreshold(fields);
            for (let i = 0; i < chars.length; i++) {
              if (i % 10 === 0) { status(`Tracing ${p.name || 'sheet'}, ${PAGES[s.tag.page].title.toLowerCase()} (${i} of ${chars.length})...`); await tick(); }
              const traced = traceCell(fields[i], threshold);
              if (traced) p.glyphs.set(chars[i].key, traced); else p.glyphs.delete(chars[i].key);
            }
          }
        }
      } catch (e) { notes.push(e.message || String(e)); }
    }
  } finally {
    busy = false;
  }
  if (queue.length) { const next = queue; queue = []; return addFiles(next); }
  const failed = $('problems').childElementCount;
  status((found ? `Read ${found} sheet${found === 1 ? '' : 's'}. ` : '') + (failed ? `${failed} couldn't be read, see below. ` : '') + notes.join(' '));
  $('reset').hidden = !people.size && !$('problems').childElementCount;
  if (people.size) { $('fontSettings').hidden = false; rebuildAll(); }
}

// Shows what the scanner saw when it couldn't use a picture, with the corner
// squares it found circled.
function problem(source, res, message) {
  const img = res.preview, s = Math.min(1, 260 / Math.max(img.w, img.h));
  const c = document.createElement('canvas');
  c.width = Math.round(img.w * s); c.height = Math.round(img.h * s);
  const ctx = c.getContext('2d'), im = ctx.createImageData(c.width, c.height);
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
    const v = img.data[Math.min(img.h - 1, Math.floor(y / s)) * img.w + Math.min(img.w - 1, Math.floor(x / s))] * 255, i = (y * c.width + x) * 4;
    im.data[i] = im.data[i + 1] = im.data[i + 2] = v; im.data[i + 3] = 255;
  }
  ctx.putImageData(im, 0, 0);
  for (const m of res.markers) {
    const x = m.x / img.f * s, y = m.y / img.f * s, rad = Math.max(6, m.size / img.f * s * 0.9);
    ctx.lineWidth = 4; ctx.strokeStyle = '#fff'; ctx.beginPath(); ctx.arc(x, y, rad, 0, 7); ctx.stroke();
    ctx.lineWidth = 2; ctx.strokeStyle = '#000'; ctx.beginPath(); ctx.arc(x, y, rad, 0, 7); ctx.stroke();
  }
  const fig = document.createElement('figure');
  const cap = document.createElement('figcaption');
  cap.textContent = message;
  fig.append(c, cap);
  $('problems').append(fig);
}

function person(tag) {
  if (!people.has(tag.id)) {
    const n = people.size;
    people.set(tag.id, { name: tag.name, sheet: tag.sheet, pages: new Set(), glyphs: new Map(),
      family: tag.name ? `${tag.name}'s Handwriting` : (n ? `My Handwriting ${n + 1}` : 'My Handwriting'), face: null, el: null });
  }
  return people.get(tag.id);
}

function fileName(p) {
  const v = $('version').value.replace(/[^0-9.]/g, '') || '1.0';
  const base = p.family.normalize('NFD').replace(/[^A-Za-z0-9]+/g, '') || 'MyHandwriting';
  return `${base}-v${v}.ttf`;
}

async function rebuild(p) {
  p.error = '';
  if (!p.glyphs.size) { p.ttf = null; render(p); return; }
  const res = buildTTF(p.glyphs, { family: p.family, version: $('version').value, sideBearing: spacing('sb'), wordSpace: spacing('ws'), placeMarks: $('placeMarks').checked });
  p.ttf = res.bytes; p.derived = res.derived;
  try {
    const face = new FontFace(`HF${faceCount++}`, res.bytes.buffer.slice(0));
    await face.load();
    if (p.face) document.fonts.delete(p.face);
    document.fonts.add(face);
    p.face = face;
  } catch (e) { p.error = 'The font was made but this browser could not preview it: ' + e.message; }
  render(p);
}

// Rebuilds run one after another, so a slider drag can't load two faces for one person at once.
let chain = Promise.resolve();
function rebuildAll() {
  chain = chain.then(async () => {
    for (const p of people.values()) await rebuild(p);
    $('zipRow').hidden = people.size < 2;
  }).catch(e => status('Something went wrong making the font: ' + (e.message || e)));
  return chain;
}

function render(p) {
  if (!p.el) {
    p.el = document.createElement('div');
    p.el.className = 'font';
    p.el.innerHTML = `<label class="block">Font name<input type="text" class="family"></label>
      <p class="info muted"></p>
      <textarea class="sample" spellcheck="false" rows="3">The quick brown fox jumps over the lazy dog. 0123456789</textarea>
      <p class="row"><button class="dl">Download font</button><span class="muted dlnote"></span></p>
      <div class="grid"></div>`;
    const fam = p.el.querySelector('.family');
    fam.value = p.family;
    fam.addEventListener('input', () => { p.family = fam.value.trim() || 'My Handwriting'; clearTimeout(p.t); p.t = setTimeout(rebuildAll, 300); });
    p.el.querySelector('.dl').addEventListener('click', () => download(p));
    $('fonts').append(p.el);
  }
  const family = p.face ? `"${p.face.family}", sans-serif` : 'sans-serif';
  p.el.querySelector('.sample').style.fontFamily = family;
  const expected = SHEETS[p.sheet].pages;
  const missingPages = expected.filter(k => !p.pages.has(k)).map(k => PAGES[k].title.toLowerCase());
  const all = expected.flatMap(k => PAGES[k].chars.map(ch => PAGES[k].alt ? ch + '.alt' : ch));
  const empty = all.filter(k => p.pages.has(pageOf(k)) && !p.glyphs.has(k));
  let info = `${p.glyphs.size} of ${all.length} boxes filled.`;
  if (empty.length) info += ` Empty boxes: ${empty.map(k => k.endsWith('.alt') ? `‘${k.slice(0, -4)}’ 2nd` : `‘${k}’`).join(' ')}.`;
  if (missingPages.length) info += ` Still to upload: ${missingPages.join(' and ')} page${missingPages.length > 1 ? 's' : ''}.`;
  if (p.derived?.length) info += ` Also made ${p.derived.length} accented letters like ${p.derived.slice(0, 4).join(' ')}.`;
  if (p.error) info += ' ' + p.error;
  p.el.querySelector('.info').textContent = info;
  p.el.querySelector('.dl').disabled = !p.ttf;
  const grid = p.el.querySelector('.grid');
  grid.textContent = '';
  for (const k of all) {
    const has = p.glyphs.has(k);
    const c = document.createElement('div'); c.className = has ? 'cell' : 'cell missing';
    const g = document.createElement('div'); g.className = 'g'; g.textContent = !has ? 'empty' : k.endsWith('.alt') ? String.fromCodePoint(0xE000 + k.codePointAt(0)) : k;
    if (has) g.style.fontFamily = family;
    const lab = document.createElement('div'); lab.className = 'k'; lab.textContent = k.replace('.alt', ' 2nd');
    c.append(g, lab); grid.append(c);
  }
}

function pageOf(key) {
  if (key.endsWith('.alt')) return 'alternates';
  return PAGES.basic.chars.includes(key) ? 'basic' : 'symbols';
}

function save(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

function download(p) {
  if (!p.ttf) return;
  save(new Blob([p.ttf], { type: 'font/ttf' }), fileName(p));
  p.el.querySelector('.dlnote').textContent = `Saved ${fileName(p)}. On a Mac, double-click it and choose Install Font. On Windows, right-click it and choose Install.`;
}

$('zip').addEventListener('click', () => {
  // Two people with the same name still get separate files.
  const used = new Map();
  const files = [...people.values()].filter(p => p.ttf).map(p => {
    let name = fileName(p);
    const n = (used.get(name) || 0) + 1; used.set(name, n);
    if (n > 1) name = name.replace(/\.ttf$/, `-${n}.ttf`);
    return { name, data: p.ttf };
  });
  save(makeZip(files), 'handwriting-fonts.zip');
});
$('reset').addEventListener('click', () => {
  for (const p of people.values()) if (p.face) document.fonts.delete(p.face);
  people.clear(); $('fonts').textContent = ''; $('problems').textContent = ''; $('fontSettings').hidden = true; $('reset').hidden = true; status('');
});

const drop = $('drop');
drop.addEventListener('click', () => $('files').click());
drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('files').click(); } });
$('files').addEventListener('change', e => { addFiles([...e.target.files]); e.target.value = ''; });
drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); addFiles([...e.dataTransfer.files]); });
// Each slider has a number box beside it; the box can go past the slider's ends.
for (const id of ['sb', 'ws']) {
  const range = $(id), box = $(id + 'n');
  const later = () => { clearTimeout(timer); timer = setTimeout(rebuildAll, 200); };
  range.addEventListener('input', () => { box.value = range.value; later(); });
  box.addEventListener('input', () => {
    if (box.value === '' || isNaN(+box.value)) return;
    const v = Math.min(+box.max, Math.max(+box.min, +box.value));
    range.value = v; later();
  });
  box.addEventListener('change', () => { box.value = Math.min(+box.max, Math.max(+box.min, +box.value || 0)); });
}
$('resetSpacing').addEventListener('click', () => {
  for (const id of ['sb', 'ws']) { const r = $(id); r.value = $(id + 'n').value = r.defaultValue; }
  clearTimeout(timer); rebuildAll();
});
const spacing = id => { const b = $(id + 'n'); return Math.min(+b.max, Math.max(+b.min, +b.value || 0)); };
$('placeMarks').addEventListener('change', () => { clearTimeout(timer); rebuildAll(); });
$('version').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(rebuildAll, 300); });
