#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/release-common.sh"
OUTPUT="$DIST_DIR/xpayincus-zfs-builder-${VERSION}-source.tar.gz"
require_new "$OUTPUT"
STAGING="$(mktemp -d "$DIST_DIR/.zfs.XXXXXXXX")"
trap 'rm -rf -- "$STAGING"' EXIT
mkdir -p "$STAGING/host-tools/rfw" "$STAGING/host-tools/zfs"
cp "$ROOT_DIR/XPayincus-Agent/components/README.md" "$ROOT_DIR/XPayincus-Agent/components/host-snapshot.py" \
  "$ROOT_DIR/XPayincus-Agent/components/install-host-tools.sh" "$STAGING/host-tools/"
cp "$ROOT_DIR/XPayincus-Agent/components/rfw/rfw-manage.py" "$STAGING/host-tools/rfw/"
cp "$ROOT_DIR/XPayincus-Agent/components/zfs/zfs-status.py" "$STAGING/host-tools/zfs/"
tar -czf "$STAGING/archive.tar.gz" -C "$ROOT_DIR/XPayincus-Agent/components/zfs" VERSION README.md zfs-builder.sh build-debian13-ci.sh verify-debian13-modules.py zfs-status.py \
  -C "$STAGING" host-tools
publish_file "$STAGING/archive.tar.gz" "$OUTPUT"
