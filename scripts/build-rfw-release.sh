#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/release-common.sh"
[[ "$(uname -s)" == Linux ]] || { printf 'Linux native build required\n' >&2; exit 1; }
ARCH="$(native_arch)"
case "$ARCH" in
  amd64) TARGET=x86_64-unknown-linux-musl ;;
  arm64) TARGET=aarch64-unknown-linux-musl ;;
esac
OUTPUT="$DIST_DIR/xpayincus-rfw-${VERSION}-linux-${ARCH}"
require_new "$OUTPUT"
cd "$ROOT_DIR/XPayincus-Agent/components/rfw"
CC=musl-gcc CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER=musl-gcc CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER=musl-gcc \
  cargo build --locked --package rfw --release --target "$TARGET"
STAGING="$(mktemp -d "$DIST_DIR/.rfw.XXXXXXXX")"
trap 'rm -rf -- "$STAGING"' EXIT
cp "target/$TARGET/release/rfw" "$STAGING/rfw"
chmod +x "$STAGING/rfw"
publish_file "$STAGING/rfw" "$OUTPUT"
