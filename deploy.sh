#!/bin/sh
# Copies site/ to font.jedbillyb.com (OCI, nginx vhost /etc/nginx/sites-available/font).
# Cloudflare tells browsers to keep JS and CSS for 4 hours, so every local
# .js/.css reference (including module imports) gets ?v=<commit> on the way out.
set -e
cd "$(dirname "$0")"
v=$(git rev-parse --short HEAD)$(git diff --quiet HEAD -- site || echo -dirty)
out=$(mktemp -d)
chmod 755 "$out" # mktemp makes it 700 and rsync -a would copy that onto the docroot
trap 'rm -rf "$out"' EXIT
cp -r site/. "$out"/
sed -i -E "s#(href|src)=\"((js|vendor)/[^\"?]+\.js|style\.css)\"#\1=\"\2?v=$v\"#g" "$out"/index.html
sed -i -E "s#(from|import) '(\./[^'?]+\.js)'#\1 '\2?v=$v'#g" "$out"/js/*.js
sed -i -E "s#workerSrc = 'vendor/pdf\.worker\.min\.js'#workerSrc = 'vendor/pdf.worker.min.js?v=$v'#" "$out"/js/make.js
rsync -a --delete "$out"/ oci:/var/www/font/
echo "deployed $v"
