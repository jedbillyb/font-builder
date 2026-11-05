# font-builder

Handwriting Font Maker, for font.jedbillyb.com. Print a sheet, fill it in with a black pen, scan it or take a photo, and get a .ttf font of your handwriting.

Everything runs in the browser. Nothing is uploaded, so the site is plain static files in `site/`.

## Status

- Sheet generator: done. Quick (1 page), Standard (2 pages) and Complete (3 pages) sheets, A4, US Letter or A3 (the A4 sheet scaled up 1.41x, so the scanner needs no changes), optional class list with one named sheet per person.
- Digital mode: downloads an Illustrator .ai (locked Sheet layer, empty Draw here layer, pages side by side) or a PDF for Procreate and other apps.
- Scanning and font building: done. Takes scans, phone photos, PDFs and Illustrator-saved .ai files (several at once, grouped per person by the QR id), traces every box and writes a .ttf (zip for a class). Works with pen or pencil: guide lines are divided out by their measured darkness and the ink threshold adapts to each sheet.
- Guide removal handles light pencil the same grey as the lines: each guide is compared with the same guide in the other boxes of its row (allowing 0.4 mm for a bent page), the dashed line is only removed on its dashes, and strokes along or across a line are joined back up.
- Lining up: letters are moved onto the baseline (g j p q y hang, their tops on the x-height) and punctuation goes where type puts it (full stops on the line, quotes at cap height, dashes in the middle). Marks are only moved, never resized, and each has a checkbox to turn it off. Accented letters are built from the drawn hyphen, apostrophe and full stop; Complete sheets alternate first and second versions through a GSUB calt feature.

## Sheet format

Geometry lives in `site/js/layout.js` and is shared with the scanner. Each page has a finder square in each corner of a fixed 186 x 255 mm frame, centred on the paper, and a QR code holding `FB2|sheet|page|id|name`. Change `VERSION` if the layout ever changes, so old sheets can still be read.

## Illustrator notes

The .ai is a legacy (version 3, PostScript) Illustrator file written by `toAI` in `render.js`, checked against Illustrator 2026:

- A PDF renamed to .ai opens, but Illustrator ignores PDF layers and only opens page 1, so that route was dropped.
- The legacy format keeps layers and lock state but has one artboard, so pages sit side by side with a 20 mm gap.
- Illustrator drops the last point of every closed sub-path, so each one must end back on its start point.
- `%AI5_ArtSize` sets the artboard. Adding `%AI3_Cropmarks` gives a second, stray artboard.
- When saved, Illustrator writes a normal .ai with a PDF part that pdf.js can read.

jsQR often misses the code on a whole page, but reads it every time once the QR area is cropped out, so the scanner should find the corner markers first.

## Testing

`test-sheets/` (not committed) holds simulated inputs: phone photos in pen, normal pencil and light pencil, a three-page Complete set, a three-student greyscale class scan PDF, a sideways photo, and two broken photos (a corner cut off, a blurred QR code) that should produce the failure preview. Expected: every box found, one font per person, and plain explanations for the two broken ones. Real scans used for regression checks: a felt-pen A3 Standard set and a light-pencil A4 Complete set.

## Run locally

    cd site && python -m http.server 8765

## Deploy

`./deploy.sh` rsyncs `site/` to `/var/www/font` on the OCI box. nginx serves it as font.jedbillyb.com (vhost `/etc/nginx/sites-available/font`, Let's Encrypt cert via certbot), with Cloudflare proxying in front. Cloudflare tells browsers to keep JS and CSS for 4 hours, so the script adds `?v=<commit>` to every local JS and CSS reference on the way out and a deploy shows up straight away.

Third-party files are listed in `site/vendor/LICENSES.txt`.
