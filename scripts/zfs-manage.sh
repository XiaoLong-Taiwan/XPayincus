#!/usr/bin/env bash
set -euo pipefail
[[ "${1:-}" == status ]] || { printf 'Usage: %s status [--next-kernel RELEASE]\n' "$0" >&2; exit 2; }
shift
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
exec python3 "$root/XPayincus-Agent/components/zfs/zfs-status.py" "$@"
