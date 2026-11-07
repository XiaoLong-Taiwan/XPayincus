#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/release-common.sh"
OUTPUT="$DIST_DIR/xpayincus-zfs-builder-${VERSION}-source.tar.gz"
require_new "$OUTPUT"
STAGING="$(mktemp -d "$DIST_DIR/.zfs.XXXXXXXX")"
trap 'rm -rf -- "$STAGING"' EXIT
tar -czf "$STAGING/archive.tar.gz" -C "$ROOT_DIR/XPayincus-Agent/components/zfs" VERSION README.md zfs-builder.sh
publish_file "$STAGING/archive.tar.gz" "$OUTPUT"
