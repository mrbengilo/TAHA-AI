#!/bin/sh
set -eu

pnpm exec wrangler d1 migrations apply DB \
  --local \
  --persist-to=/data \
  --config=/app/wrangler.vps.jsonc

exec pnpm exec wrangler dev \
  --local \
  --persist-to=/data \
  --config=/app/wrangler.vps.jsonc \
  --ip=0.0.0.0 \
  --port=8787 \
  --no-show-interactive-dev-session
