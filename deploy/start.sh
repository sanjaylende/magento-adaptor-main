#!/bin/bash
set -euo pipefail

cd /var/www/html/magento-adapter-main

while IFS= read -r line || [ -n "$line" ]; do
  [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || continue
  key="${line%%=*}"
  value="${line#*=}"
  export "$key=$value"
done < .env

exec /opt/nodejs/node22/bin/node --use-system-ca server.js
