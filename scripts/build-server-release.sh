#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/release-common.sh"
[[ "$(uname -s)" == Linux ]] || { printf 'Linux native build required\n' >&2; exit 1; }
ARCH="$(native_arch)"
OUTPUT="$DIST_DIR/xpayincus-panel-${VERSION}-linux-${ARCH}.tar.gz"
require_new "$OUTPUT"
cd "$ROOT_DIR/XPayincus"
export CI=1
export DATABASE_URL="${DATABASE_URL:-postgresql://user:pass@localhost:5432/db}"
pnpm install --frozen-lockfile --ignore-scripts
pnpm rebuild esbuild
pnpm --filter server exec prisma generate
pnpm --filter client build
pnpm --filter server build
STAGING="$(mktemp -d "$DIST_DIR/.server.XXXXXXXX")"
ARCHIVE="$(mktemp "$DIST_DIR/.server-archive.XXXXXXXX")"
trap 'rm -rf -- "$STAGING"; rm -f -- "$ARCHIVE"' EXIT
mkdir -p "$STAGING/client/dist" "$STAGING/server" "$STAGING/deploy" "$STAGING/scripts"
cp -a client/dist/. "$STAGING/client/dist/"
for entry in dist prisma prisma.config.ts package.json templates; do
  cp -a "server/$entry" "$STAGING/server/"
done
cp package.json pnpm-lock.yaml pnpm-workspace.yaml .env.example "$STAGING/"
cp -a deploy/. "$STAGING/deploy/"
for entry in init-env.sh verify-log-header-exposure.sh verify-live-acceptance.sh verify-production-readiness.sh verify-split-host.sh apply-online-update.sh migrate-ota-atomic-layout.sh; do
  cp "scripts/$entry" "$STAGING/scripts/"
done
cp "$ROOT_DIR/scripts/incudal-release.sh" "$STAGING/incudal.sh"
chmod +x "$STAGING/incudal.sh"
export VERSION STAGING
SOURCE_COMMIT="${SOURCE_COMMIT:-$(git rev-parse HEAD)}"
export SOURCE_COMMIT
node --input-type=module <<'NODE'
import fs from 'node:fs'
fs.writeFileSync(`${process.env.STAGING}/version.json`, JSON.stringify({
  version: process.env.VERSION,
  gitTag: process.env.VERSION,
  gitCommit: process.env.SOURCE_COMMIT.slice(0, 12),
  buildTime: new Date().toISOString(),
  deployedAt: null,
  changelog: [`Unified Server/Agent ${process.env.VERSION} build`]
}, null, 2) + '\n', { flag: 'wx' })
NODE
(
  cd "$STAGING"
  pnpm install --prod --frozen-lockfile --ignore-scripts --filter server
  pnpm --filter server exec prisma generate
)
tar -czf "$ARCHIVE" -C "$STAGING" .
publish_file "$ARCHIVE" "$OUTPUT"
