#!/bin/sh
set -eu
set +x
umask 022

case "${PANEL_ENTRY:-}" in user|admin) ;; *) exit 1 ;; esac
for origin in "${FRONTEND_URL:-}" "${ADMIN_FRONTEND_URL:-}"; do
  printf '%s\n' "$origin" | LC_ALL=C grep -Eq '^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?$' || {
    printf '%s\n' 'Invalid frontend HTTPS origin' >&2
    exit 1
  }
done
destination="/usr/share/nginx/panel/$PANEL_ENTRY/runtime-config.js"
temporary="$(mktemp "${destination}.XXXXXX")"
trap 'rm -f "$temporary"' EXIT
printf 'window.__XPAYINCUS_CONFIG__ = {"apiBaseUrl":"/api","customerBaseUrl":"%s","adminBaseUrl":"%s"};\n' "$FRONTEND_URL" "$ADMIN_FRONTEND_URL" >"$temporary"
chmod 644 "$temporary"
mv -f "$temporary" "$destination"
