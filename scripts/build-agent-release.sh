#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/release-common.sh"
[[ "$(tr -d '[:space:]' < "$ROOT_DIR/XPayincus-Agent/VERSION")" == "$VERSION" ]] || { printf 'Agent VERSION mismatch\n' >&2; exit 1; }
for arch in amd64 arm64; do
  require_new "$DIST_DIR/xpayincus-agent-${VERSION}-linux-${arch}"
  require_new "$DIST_DIR/xpayincus-agent-${VERSION}-linux-${arch}.gz"
done
require_new "$DIST_DIR/manifest.json"
VERSION="$VERSION" DIST_DIR="$DIST_DIR" bash "$ROOT_DIR/XPayincus-Agent/scripts/build-release.sh"
