#!/usr/bin/env bash
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"
case "${1:-}" in
  start)
    (cd server && pnpm exec prisma migrate deploy)
    exec node server/dist/app.js
    ;;
  migrate) cd server; exec pnpm exec prisma migrate deploy ;;
  version) node -p 'require("./package.json").version' ;;
  *) printf 'Usage: %s {start|migrate|version}\n' "$0" >&2; exit 1 ;;
esac
