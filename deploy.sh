#!/bin/sh
# Copies site/ to font.jedbillyb.com (OCI, nginx vhost /etc/nginx/sites-available/font).
set -e
cd "$(dirname "$0")"
rsync -av --delete site/ oci:/var/www/font/
