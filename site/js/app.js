import { PAPER, FRAME, SHEETS, PAGES } from './layout.js';
import { TextSet, buildPage, planPages } from './sheet.js';
import { toPDF, toAI, toSVG } from './render.js';

const $ = id => document.getElementById(id);
qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];

let ts = null;
let busy = false;

async function loadFont(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't load ${url}`);
  return opentype.parse(await res.arrayBuffer());
}

function settings() {
  const sheet = document.querySelector('input[name=sheet]:checked').value;
  const paper = PAPER[$('paper').value];
  const names = $('names').value.split('\n').map(s => s.trim().slice(0, 40)).filter(Boolean).slice(0, 200);
  const copies = Math.min(60, Math.max(1, Math.floor(+$('copies').value) || 1));
  const digital = document.querySelector('input[name=mode]:checked').value === 'digital';
  if (digital) {
    const name = $('name').value.trim().slice(0, 40);
    return { sheet, paper, names: name ? [name] : [], copies: 1, digital };
  }
  return { sheet, paper, names, copies, digital };
}

function placed(paper, spec) {
  return { paper, ox: (paper.w - FRAME.w) / 2, oy: (paper.h - FRAME.h) / 2, items: buildPage(ts, spec) };
}

function updateForm() {
  const { sheet, names, copies, digital } = settings();
  $('copiesField').hidden = digital || names.length > 0;
  $('printOnly').hidden = $('open').hidden = $('printHelp').hidden = digital;
  $('digitalOnly').hidden = $('downloadAi').hidden = $('digitalHelp').hidden = !digital;
  const people = names.length || copies;
  const pages = SHEETS[sheet].pages.length * people;
  $('note').textContent = `${pages} page${pages === 1 ? '' : 's'}` + (people > 1 ? `, ${people} people` : '');
  drawPreview();
}

function drawPreview() {
  const { sheet, paper, names, digital } = settings();
  const box = $('preview');
  box.textContent = '';
  SHEETS[sheet].pages.forEach((key, pageIndex) => {
    const fig = document.createElement('figure');
    fig.innerHTML = toSVG(placed(paper, { sheet, pageIndex, id: 'preview', name: names[0] || '', digital }));
    const cap = document.createElement('figcaption');
    cap.textContent = `Page ${pageIndex + 1}: ${PAGES[key].title}`;
    fig.append(cap);
    box.append(fig);
  });
}

async function makeFile(kind) {
  const { sheet, paper, names, copies, digital } = settings();
  const pages = planPages(sheet, names, copies, digital).map(spec => placed(paper, spec));
  const title = `Handwriting font, ${SHEETS[sheet].label} sheet`;
  if (kind === 'ai') return new Blob([toAI(pages, { title })], { type: 'application/postscript' });
  return new Blob([await toPDF(pages, { title })], { type: 'application/pdf' });
}

function fileName(ext = 'pdf') {
  const { sheet, names } = settings();
  const who = names.length === 1 ? '-' + names[0].replace(/[^A-Za-z0-9]+/g, '') : names.length > 1 ? '-class' : '';
  return `handwriting-sheet-${sheet}${who}.${ext}`;
}

async function withFile(kind, fn) {
  if (busy) return;
  busy = true;
  $('note').textContent = 'Making the file...';
  try {
    const url = URL.createObjectURL(await makeFile(kind));
    fn(url);
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    updateForm();
  } catch (e) {
    $('note').textContent = 'Something went wrong: ' + (e.message || e);
  } finally {
    busy = false;
  }
}

function save(url, name) {
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove();
}
$('download').addEventListener('click', () => withFile('pdf', url => save(url, fileName())));
$('downloadAi').addEventListener('click', () => withFile('ai', url => save(url, fileName('ai'))));
$('open').addEventListener('click', () => withFile('pdf', url => window.open(url, '_blank')));
for (const el of document.querySelectorAll('input[name=sheet], input[name=mode], #paper, #copies')) el.addEventListener('change', updateForm);
let t = null;
for (const id of ['names', 'name']) $(id).addEventListener('input', () => { clearTimeout(t); t = setTimeout(updateForm, 250); });

try {
  const [r, rx, b, bx] = await Promise.all([
    'fonts/arimo-latin-400-normal.woff', 'fonts/arimo-latin-ext-400-normal.woff',
    'fonts/arimo-latin-700-normal.woff', 'fonts/arimo-latin-ext-700-normal.woff',
  ].map(loadFont));
  ts = new TextSet([r, rx], [b, bx]);
  $('download').disabled = $('open').disabled = $('downloadAi').disabled = false;
  updateForm();
} catch (e) {
  $('note').textContent = 'The page failed to load: ' + (e.message || e);
}
