#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(node "$ROOT_DIR/scripts/release-contract.mjs")"
export VERSION
DIST_DIR="${DIST_DIR:-${ROOT_DIR}/dist/unified}"
mkdir -p "$DIST_DIR"
DIST_DIR="$(cd "$DIST_DIR" && pwd)"

require_new() {
  [[ ! -e "$1" && ! -L "$1" ]] || { printf 'Refusing to overwrite: %s\n' "$1" >&2; exit 1; }
}

publish_file() {
  require_new "$2"
  ln -T -- "$1" "$2"
}

native_arch() {
  case "$(uname -m)" in
    x86_64) printf 'amd64\n' ;;
    aarch64|arm64) printf 'arm64\n' ;;
    *) printf 'Unsupported architecture\n' >&2; exit 1 ;;
  esac
}
