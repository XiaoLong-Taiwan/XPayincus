#!/usr/bin/env bash
set -euo pipefail

readonly RFW_VERSION="v0.1.9"
readonly RFW_SHA256_X86_64="b2486f8a500ae2eb2da3aa8a4191878404ea46b8dbd6e4c9041a1bb2d20e3b6a"
readonly RFW_SHA256_AARCH64="79781139edf77222560a9fd307d1bae5b5bc5aed6b80df44f02542950f42933a"
readonly RFW_RELEASE_URL="https://github.com/XiaoLong-Taiwan/XPayincus-RFW/releases/download/${RFW_VERSION}"
readonly RFW_INSTALL_DIR="/root/rfw"
readonly RFW_SERVICE_FILE="/etc/systemd/system/rfw.service"

fail() {
  echo "error: $*" >&2
  exit 1
}

is_country_list() {
  [[ "$1" =~ ^[A-Z]{2}(,[A-Z]{2})*$ ]]
}

if [[ "${EUID}" -ne 0 ]]; then
  fail "must run as root"
fi

interface=""
mode=""
countries=""
rfw_args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --iface)
      [[ $# -ge 2 ]] || fail "--iface requires a value"
      interface="$2"
      shift 2
      ;;
    --countries|--allow-only-countries|--block-all-from)
      [[ $# -ge 2 ]] || fail "$1 requires a value"
      [[ -z "$mode" ]] || fail "only one country mode may be selected"
      mode="$1"
      countries="${2^^}"
      shift 2
      ;;
    --block-email|--block-http|--block-socks5|--block-fet-strict|--block-wireguard|--block-quic|--block-all|--log-port-access)
      rfw_args+=("$1")
      shift
      ;;
    *)
      fail "unsupported argument: $1"
      ;;
  esac
done

[[ -n "$interface" ]] || fail "--iface is required"
[[ "$interface" =~ ^[A-Za-z0-9_.:-]{1,15}$ ]] || fail "invalid interface"
[[ -d "/sys/class/net/${interface}" ]] || fail "interface does not exist: ${interface}"
if [[ -n "$mode" ]]; then
  is_country_list "$countries" || fail "countries must be comma-separated ISO alpha-2 codes"
  rfw_args+=("$mode" "$countries")
fi

case "$(uname -m)" in
  x86_64|amd64)
    arch="x86_64"
    expected_sha256="$RFW_SHA256_X86_64"
    ;;
  aarch64|arm64)
    arch="aarch64"
    expected_sha256="$RFW_SHA256_AARCH64"
    ;;
  *)
    fail "unsupported architecture: $(uname -m)"
    ;;
esac

command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v sha256sum >/dev/null 2>&1 || fail "sha256sum is required"
command -v systemctl >/dev/null 2>&1 || fail "systemctl is required"
[[ -d /run/systemd/system ]] || fail "systemd is not running"

install -d -o root -g root -m 0755 "$RFW_INSTALL_DIR"
staged_binary=$(mktemp "${RFW_INSTALL_DIR}/.rfw.new.XXXXXX")
staged_service=$(mktemp "${RFW_SERVICE_FILE}.new.XXXXXX")
binary_backup=""
service_backup=""
cleanup() {
  rm -f "$staged_binary" "$staged_service"
}
trap cleanup EXIT

curl -fsSL --connect-timeout 15 --max-time 120 \
  "${RFW_RELEASE_URL}/rfw-${arch}-unknown-linux-musl" -o "$staged_binary"
actual_sha256=$(sha256sum "$staged_binary" | awk '{print $1}')
[[ "$actual_sha256" == "$expected_sha256" ]] || fail "RFW SHA-256 verification failed"
[[ "$(od -An -tx1 -N4 "$staged_binary" | tr -d ' \n')" == "7f454c46" ]] || fail "RFW binary is not ELF"
chmod 0755 "$staged_binary"

printf -v exec_start '%q ' "$RFW_INSTALL_DIR/rfw" --iface "$interface" "${rfw_args[@]}"
cat > "$staged_service" <<EOF
[Unit]
Description=RFW Firewall Service
After=network.target

[Service]
Type=simple
User=root
Environment=RUST_LOG=info
ExecStart=${exec_start% }
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
chmod 0644 "$staged_service"

old_active=false
old_enabled=false
systemctl is-active --quiet rfw 2>/dev/null && old_active=true
systemctl is-enabled --quiet rfw 2>/dev/null && old_enabled=true
if [[ -e "$RFW_INSTALL_DIR/rfw" ]]; then
  binary_backup=$(mktemp "${RFW_INSTALL_DIR}/.rfw.backup.XXXXXX")
  cp -a "$RFW_INSTALL_DIR/rfw" "$binary_backup"
fi
if [[ -e "$RFW_SERVICE_FILE" ]]; then
  service_backup=$(mktemp "${RFW_SERVICE_FILE}.backup.XXXXXX")
  cp -a "$RFW_SERVICE_FILE" "$service_backup"
fi

switch_ok=true
if [[ "$old_active" == "true" ]]; then
  systemctl stop rfw || switch_ok=false
fi
if [[ "$switch_ok" == "true" ]]; then
  mv -f "$staged_binary" "$RFW_INSTALL_DIR/rfw" || switch_ok=false
fi
if [[ "$switch_ok" == "true" ]]; then
  mv -f "$staged_service" "$RFW_SERVICE_FILE" || switch_ok=false
fi
if [[ "$switch_ok" == "true" ]]; then
  systemctl daemon-reload && systemctl enable rfw && systemctl restart rfw || switch_ok=false
fi
if [[ "$switch_ok" == "true" ]]; then
  sleep 2
  systemctl is-enabled --quiet rfw && systemctl is-active --quiet rfw || switch_ok=false
fi

if [[ "$switch_ok" != "true" ]]; then
  systemctl stop rfw >/dev/null 2>&1 || true
  if [[ -n "$binary_backup" ]]; then
    mv -f "$binary_backup" "$RFW_INSTALL_DIR/rfw"
  else
    rm -f "$RFW_INSTALL_DIR/rfw"
  fi
  if [[ -n "$service_backup" ]]; then
    mv -f "$service_backup" "$RFW_SERVICE_FILE"
  else
    rm -f "$RFW_SERVICE_FILE"
  fi
  systemctl daemon-reload >/dev/null 2>&1 || true
  if [[ "$old_enabled" == "true" ]]; then
    systemctl enable rfw >/dev/null 2>&1 || true
  else
    systemctl disable rfw >/dev/null 2>&1 || true
  fi
  if [[ "$old_active" == "true" ]]; then
    systemctl restart rfw >/dev/null 2>&1 || true
  fi
  fail "RFW installation failed and the previous state was restored"
fi

rm -f "$binary_backup" "$service_backup"
echo "RFW installed"
