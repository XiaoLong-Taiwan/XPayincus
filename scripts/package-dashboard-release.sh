#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/release-common.sh"
[[ "${GITHUB_ACTIONS:-}" == true ]] || { printf 'CI-only: packages committed root HEAD, not uncommitted workspace files\n' >&2; exit 1; }
[[ "$(git -C "$ROOT_DIR" rev-parse --show-toplevel)" == "$ROOT_DIR" ]] || { printf 'Root repository checkout required\n' >&2; exit 1; }
[[ "$(git -C "$ROOT_DIR" show HEAD:VERSION | tr -d '\r\n')" == "$VERSION" ]] || { printf 'Committed VERSION mismatch\n' >&2; exit 1; }
OUTPUT="$DIST_DIR/xpayincus-dashboard-${VERSION}-compose.tar.gz"
BOOTSTRAP="$DIST_DIR/xpayincus-compose-${VERSION}.sh"
require_new "$OUTPUT"
require_new "$BOOTSTRAP"
require_new "$DIST_DIR/xpayincus-compose-${VERSION}.tar.gz"
STAGING="$(mktemp -d "$DIST_DIR/.dashboard.XXXXXXXX")"
trap 'rm -rf -- "$STAGING"' EXIT
mkdir "$STAGING/source"
git -C "$ROOT_DIR" archive --format=tar HEAD -- \
  VERSION XPayincus/package.json XPayincus/pnpm-lock.yaml XPayincus/pnpm-workspace.yaml \
  XPayincus/client XPayincus/server XPayincus/deploy/compose \
  | tar -xf - -C "$STAGING/source" \
    --exclude='.git' --exclude='.gitmodules' --exclude='node_modules' \
    --exclude='secrets' --exclude='.env' --exclude='.env.*' \
    --exclude='dist' --exclude='__pycache__' --exclude='*.pyc' --exclude='certs' --exclude='*.pem' --exclude='*.key' \
    --exclude='*.p12' --exclude='*.pfx' --exclude='*.dump' --exclude='*.log'
[[ -z "$(find "$STAGING" -type l -print -quit)" ]] || { printf 'Dashboard sources must not contain symlinks\n' >&2; exit 1; }
for entry in \
  package.json pnpm-lock.yaml pnpm-workspace.yaml \
  client/package.json client/index.html client/vite.config.ts client/tsconfig.json client/tsconfig.node.json client/src/main.ts client/src/admin/main.ts \
  server/package.json server/tsconfig.json server/src/app.ts server/prisma.config.ts server/prisma/schema.prisma server/prisma/migrations/migration_lock.toml \
  server/templates/install.sh server/templates/agent-install.sh server/templates/caddy.sh \
  server/scripts/export-legacy-host.mjs server/scripts/LEGACY_HOST_EXPORT.md \
  deploy/compose/docker-compose.yml deploy/compose/compose.yaml deploy/compose/Dockerfile deploy/compose/Dockerfile.dockerignore \
  deploy/compose/panel.sh deploy/compose/download.sh deploy/compose/update.py deploy/compose/operations.py deploy/compose/api-entrypoint.sh deploy/compose/nginx.conf.template \
  deploy/compose/origin-entrypoint.sh deploy/compose/edge-nginx.conf.template deploy/compose/tunnel-nginx.conf.template \
  deploy/compose/README.md deploy/compose/https-proxy.conf.example; do
  [[ -f "$STAGING/source/XPayincus/$entry" && -r "$STAGING/source/XPayincus/$entry" && -s "$STAGING/source/XPayincus/$entry" ]] || { printf 'Missing, unreadable or empty committed Dashboard source: %s\n' "$entry" >&2; exit 1; }
done
node "$ROOT_DIR/scripts/prepare-compose-release.mjs" "$STAGING/source"
bash -n "$STAGING/source/XPayincus/deploy/compose/download.sh"
tar -czf "$STAGING/archive.tar.gz" -C "$STAGING/source" .
node "$ROOT_DIR/scripts/package-compose-bundle.mjs" "$STAGING/source" "$DIST_DIR"
publish_file "$STAGING/archive.tar.gz" "$OUTPUT"
publish_file "$STAGING/source/XPayincus/deploy/compose/download.sh" "$BOOTSTRAP"
