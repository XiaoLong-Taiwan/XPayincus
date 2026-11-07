#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/release-common.sh"
[[ "${GITHUB_ACTIONS:-}" == true ]] || { printf 'CI-only: packages committed root HEAD, not uncommitted workspace files\n' >&2; exit 1; }
[[ "$(git -C "$ROOT_DIR" rev-parse --show-toplevel)" == "$ROOT_DIR" ]] || { printf 'Root repository checkout required\n' >&2; exit 1; }
[[ "$(git -C "$ROOT_DIR" show HEAD:VERSION | tr -d '\r\n')" == "$VERSION" ]] || { printf 'Committed VERSION mismatch\n' >&2; exit 1; }
OUTPUT="$DIST_DIR/xpayincus-dashboard-${VERSION}-compose.tar.gz"
require_new "$OUTPUT"
STAGING="$(mktemp -d)"
trap 'rm -rf -- "$STAGING"' EXIT
git -C "$ROOT_DIR" archive --format=tar HEAD -- \
  VERSION XPayincus/package.json XPayincus/pnpm-lock.yaml XPayincus/pnpm-workspace.yaml \
  XPayincus/client XPayincus/server XPayincus/deploy/compose \
  | tar -xf - -C "$STAGING" \
    --exclude='.git' --exclude='.gitmodules' --exclude='node_modules' \
    --exclude='secrets' --exclude='.env' --exclude='.env.*' \
    --exclude='dist' --exclude='certs' --exclude='*.pem' --exclude='*.key' \
    --exclude='*.p12' --exclude='*.pfx' --exclude='*.dump' --exclude='*.log'
[[ -z "$(find "$STAGING" -type l -print -quit)" ]] || { printf 'Dashboard sources must not contain symlinks\n' >&2; exit 1; }
for entry in package.json pnpm-lock.yaml pnpm-workspace.yaml client/package.json server/package.json server/prisma/schema.prisma deploy/compose/compose.yaml deploy/compose/Dockerfile deploy/compose/Dockerfile.dockerignore deploy/compose/panel.sh deploy/compose/api-entrypoint.sh deploy/compose/nginx.conf.template; do
  [[ -f "$STAGING/XPayincus/$entry" ]] || { printf 'Missing committed Dashboard source: %s\n' "$entry" >&2; exit 1; }
done
tar -czf "$OUTPUT" -C "$STAGING" .
