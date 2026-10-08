#!/bin/bash
# Manual deploy: pulls dev, reinstalls deps, restarts the systemd service.
# Run this by hand on the server for now (no CI auto-deploy wired up yet).
set -euo pipefail

export PATH="/opt/nodejs/node22/bin:$PATH"

cd /var/www/html/magento-adapter-main
git fetch origin dev
git reset --hard origin/dev
npm ci --omit=dev
sudo /usr/bin/systemctl restart magento-flipick-adapter
sudo /usr/bin/systemctl --no-pager status magento-flipick-adapter
