// Turns uploaded files into greyscale rasters: { w, h, data } with data a
// Float32Array of brightness, 0 black to 1 white. PDFs and .ai files are
// rendered page by page; photos keep their camera orientation.

const MAX_IMAGE = 4500;     // longest side for photos and scans, px
const PDF_PX_PER_MM = 10;   // render resolution for vector files
const MAX_PDF = 7000;

function toGray(ctx, w, h) {
  const rgba = ctx.getImageData(0, 0, w, h).data;
  const data = new Float32Array(w * h);
  for (let i = 0, j = 0; i < data.length; i++, j += 4) {
    // Transparent pixels count as paper.
    const a = rgba[j + 3] / 255;
    const l = (0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2]) / 255;
    data[i] = l * a + (1 - a);
  }
  return { w, h, data };
}

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

async function* fromImage(file) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { throw new Error(`${file.name} isn't an image this browser can open. Try JPG or PNG (iPhone HEIC photos only open in Safari).`); }
  const s = Math.min(1, MAX_IMAGE / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * s), h = Math.round(bmp.height * s);
  const c = canvas(w, h), ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  yield { ...toGray(ctx, w, h), source: file.name };
}

// Pages are rendered one at a time, so a whole class scanned into one PDF
// never has to sit in memory at once.
async function* fromPDF(file) {
  const data = new Uint8Array(await file.arrayBuffer());
  let doc;
  try { doc = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise; }
  catch {
    const head = new TextDecoder().decode(data.subarray(0, 20));
    if (head.startsWith('%!PS')) throw new Error(`${file.name} is the blank sheet straight from this site. Draw on it in Illustrator and save it first, so it has a PDF part.`);
    throw new Error(`${file.name} couldn't be read. If it's an Illustrator file, save it again with Create PDF Compatible File ticked.`);
  }
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    let scale = PDF_PX_PER_MM * 25.4 / 72;
    scale = Math.min(scale, MAX_PDF / Math.max(base.width, base.height));
    const vp = page.getViewport({ scale });
    const w = Math.ceil(vp.width), h = Math.ceil(vp.height);
    const c = canvas(w, h), ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const r = { ...toGray(ctx, w, h), source: doc.numPages > 1 ? `${file.name} page ${n}` : file.name };
    c.width = c.height = 0;
    page.cleanup();
    yield r;
  }
  doc.destroy();
}

// Yields one raster per image or page.
export function loadRasters(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.pdf') || name.endsWith('.ai') || file.type === 'application/pdf') return fromPDF(file);
  return fromImage(file);
}
