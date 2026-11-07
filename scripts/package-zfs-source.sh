#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/release-common.sh"
OUTPUT="$DIST_DIR/xpayincus-zfs-builder-${VERSION}-source.tar.gz"
require_new "$OUTPUT"
tar -czf "$OUTPUT" -C "$ROOT_DIR/XPayincus-ZFS" README.md zfs-builder.sh
