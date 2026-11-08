#!/usr/bin/env bash
set +x
set -euo pipefail
umask 077

SERVICE_NAME="incudal-agent"
CONFIG_DIR="${INCUDAL_CONFIG_DIR:-/etc/incudal-agent}"
CONFIG_FILE="${INCUDAL_CONFIG_FILE:-${CONFIG_DIR}/config.yaml}"
INSTALL_DIR="${INCUDAL_INSTALL_DIR:-/usr/local/bin}"
BIN_PATH="${INCUDAL_AGENT_BIN:-${INSTALL_DIR}/incudal-agent}"
SERVICE_FILE="${INCUDAL_SERVICE_FILE:-/etc/systemd/system/${SERVICE_NAME}.service}"
HEARTBEAT_INTERVAL="${INCUDAL_HEARTBEAT_INTERVAL_SECONDS:-60}"
REQUEST_TIMEOUT="${INCUDAL_REQUEST_TIMEOUT_SECONDS:-10}"
DRY_RUN="${INCUDAL_AGENT_DRY_RUN:-0}"
INSTALL_CONFIG_PATH=""
REINSTALL="0"
LOCAL_BINARY=""
TOKEN_FILE=""

usage() {
  printf '%s\n' 'Usage: bash agent-install.sh [--panel-url URL] [--token-file FILE] [--reinstall] [--binary FILE --sha256 HEX]' \
    'Without credentials, prompts on /dev/tty for panel URL and hidden one-time TOKEN.' \
    '--reinstall preserves the existing config; do not supply a new URL or TOKEN.'
}

fail() {
  echo "error: $*" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --reinstall) REINSTALL="1"; shift ;;
    --panel-url|--token-file|--binary|--sha256)
      [ "$#" -ge 2 ] && [ -n "$2" ] || fail "option requires a value"
      case "$1" in
        --panel-url) INCUDAL_PANEL_URL="$2" ;;
        --token-file) TOKEN_FILE="$2" ;;
        --binary) LOCAL_BINARY="$2" ;;
        --sha256) INCUDAL_AGENT_BINARY_SHA256="$2" ;;
      esac
      shift 2
      ;;
    *) fail "unknown option; use --help" ;;
  esac
done

prompt_value() {
  local name="$1" label="$2" hidden="${3:-0}"
  [ -r /dev/tty ] && [ -w /dev/tty ] || fail "non-interactive input requires --panel-url and --token-file (or existing credential environment)"
  if [ "${hidden}" = "1" ]; then
    IFS= read -r -s -p "${label}" "${name}" </dev/tty || fail "input cancelled"
    printf '\n' >/dev/tty
  else
    IFS= read -r -p "${label}" "${name}" </dev/tty || fail "input cancelled"
  fi
}

prepare_inputs() {
  if [ "${REINSTALL}" = "1" ]; then
    [ -z "${INCUDAL_PANEL_URL:-}${INCUDAL_AGENT_INSTALL_TOKEN:-}${TOKEN_FILE}${INCUDAL_AGENT_ID:-}${INCUDAL_AGENT_SECRET:-}" ] || fail "--reinstall cannot be combined with new credentials or panel URL"
    [ -f "${CONFIG_FILE}" ] && [ ! -L "${CONFIG_FILE}" ] || fail "--reinstall requires an existing regular config file"
    INCUDAL_PANEL_URL="$(sed -nE 's/^panel_url: "([^"\\]+)"$/\1/p' "${CONFIG_FILE}")"
  else
    if [ -n "${TOKEN_FILE}" ]; then
      [ -z "${INCUDAL_AGENT_INSTALL_TOKEN:-}" ] || fail "multiple TOKEN sources"
      [ -f "${TOKEN_FILE}" ] && [ ! -L "${TOKEN_FILE}" ] || fail "TOKEN file must be a regular file"
      [ "$(stat -c '%a' "${TOKEN_FILE}")" = "600" ] && [ "$(stat -c '%u' "${TOKEN_FILE}")" = "$(id -u)" ] || fail "TOKEN file must be owned by current user with mode 0600"
      INCUDAL_AGENT_INSTALL_TOKEN="$(cat "${TOKEN_FILE}")"
    fi
    [ -n "${INCUDAL_PANEL_URL:-}" ] || prompt_value INCUDAL_PANEL_URL 'Panel URL: '
    if [ -z "${INCUDAL_AGENT_INSTALL_TOKEN:-}" ] && [ -z "${INCUDAL_AGENT_ID:-}${INCUDAL_AGENT_SECRET:-}" ]; then
      prompt_value INCUDAL_AGENT_INSTALL_TOKEN 'Agent install TOKEN: ' 1
    fi
  fi
  [[ "${INCUDAL_PANEL_URL:-}" =~ ^https?://([a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\])(:[0-9]{1,5})?/?$ ]] || fail "panel URL must be an HTTP(S) origin without credentials, query, or path"
  INCUDAL_PANEL_URL="${INCUDAL_PANEL_URL%/}"
  if [ -n "${INCUDAL_AGENT_INSTALL_TOKEN:-}" ]; then
    [[ "${INCUDAL_AGENT_INSTALL_TOKEN}" =~ ^ait_[A-Za-z0-9_-]{32,128}$ ]] || fail "invalid Agent install TOKEN format"
  fi
  if [ -n "${LOCAL_BINARY}" ]; then
    [ -z "${INCUDAL_AGENT_BINARY_URL:-}" ] || fail "--binary cannot be combined with a binary URL"
    [ -f "${LOCAL_BINARY}" ] && [ -r "${LOCAL_BINARY}" ] || fail "local binary must be a readable file"
    [[ "${LOCAL_BINARY}" != *.gz ]] || fail "--binary requires an uncompressed compiled binary"
    LOCAL_BINARY="$(cd "$(dirname "${LOCAL_BINARY}")" && pwd)/$(basename "${LOCAL_BINARY}")"
    BINARY_LOCAL_SHA256="$(sha256_file "${LOCAL_BINARY}")"
    if [ -n "${INCUDAL_AGENT_BINARY_SHA256:-}" ]; then
      verify_sha256 "${LOCAL_BINARY}" "${INCUDAL_AGENT_BINARY_SHA256}" || fail "local binary checksum mismatch"
    fi
    INCUDAL_AGENT_BINARY_URL="file://${LOCAL_BINARY}"
    INCUDAL_AGENT_BINARY_SHA256="${BINARY_LOCAL_SHA256}"
  fi
}

fetch_public() {
  curl -q -fsSL --proto '=http,https' --proto-redir '=http,https' \
    --connect-timeout 10 --max-time 120 --retry 2 --retry-delay 2 --retry-max-time 360 "$@"
}

normalize_heartbeat_interval() {
  local value="${1:-60}"
  if [[ "${value}" =~ ^[0-9]+$ ]] && [ "${value}" -ge 30 ] && [ "${value}" -le 3600 ]; then
    echo "${value}"
  else
    echo "60"
  fi
}

need_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    fail "${name} is required"
  fi
}

validate_credentials() {
  [[ "${INCUDAL_AGENT_ID:-}" =~ ^agt_[A-Za-z0-9_-]{24,64}$ ]] || fail "invalid Agent ID format"
  [[ "${INCUDAL_AGENT_SECRET:-}" =~ ^ias_[A-Za-z0-9_-]{32,96}$ ]] || fail "invalid Agent secret format"
}

detect_os() {
  case "$(uname -s)" in
    Linux) echo "linux" ;;
    *) fail "unsupported OS: $(uname -s)" ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64) echo "amd64" ;;
    aarch64|arm64) echo "arm64" ;;
    *) fail "unsupported architecture: $(uname -m)" ;;
  esac
}

run() {
  if [ "${DRY_RUN}" = "1" ]; then
    printf '+'
    printf ' %q' "$@"
    printf '\n'
    return 0
  fi
  "$@"
}

write_file() {
  local path="$1"
  local mode="$2"
  local owner="$3"
  local tmp

  if [ "${DRY_RUN}" = "1" ]; then
    echo "+ write ${path} mode=${mode} owner=${owner}"
    if [ "${path}" = "${CONFIG_FILE}" ] || [ "${path}" = "${STAGED_CONFIG:-}" ]; then
      sed -E 's/^([[:space:]]*agent_secret:).*/\1 "<redacted>"/; s/^/| /'
    else
      sed 's/^/| /'
    fi
    return 0
  fi

  tmp="$(mktemp)"
  cat > "${tmp}"
  install -d -m 0755 "$(dirname "${path}")"
  install -m "${mode}" -o "${owner%%:*}" -g "${owner##*:}" "${tmp}" "${path}"
  rm -f "${tmp}"
}

download_binary_once() {
  local binary_url="$1"
  local target="$2"
  local expected_sha256="${3:-}"
  local binary_path="${binary_url%%\?*}"
  binary_path="${binary_path%%#*}"

  if [ "${DRY_RUN}" = "1" ]; then
    echo "+ download ${binary_url} -> ${target}"
    if [ -n "${expected_sha256}" ]; then
      echo "+ verify sha256 ${expected_sha256} ${target}.download"
    fi
    return 0
  fi

  install -d -m 0755 "$(dirname "${target}")"
  if [[ "${binary_url}" == file://* ]]; then
    install -m 0644 "${binary_url#file://}" "${target}.download" || return 1
  else
    command -v curl >/dev/null 2>&1 || fail "curl is required"
    fetch_public "${binary_url}" -o "${target}.download" || {
      rm -f "${target}.download"
      return 1
    }
  fi

  if [ -n "${expected_sha256}" ]; then
    verify_sha256 "${target}.download" "${expected_sha256}" || {
      rm -f "${target}.download"
      return 1
    }
  fi

  if [[ "${binary_path}" == *.gz ]]; then
    command -v gzip >/dev/null 2>&1 || {
      rm -f "${target}.download"
      return 1
    }
    gzip -dc "${target}.download" > "${target}.tmp" || {
      rm -f "${target}.download" "${target}.tmp"
      return 1
    }
    rm -f "${target}.download"
  else
    mv "${target}.download" "${target}.tmp"
  fi
  install -m 0755 "${target}.tmp" "${target}"
  rm -f "${target}.tmp"
}

download_binary() {
  local binary_url="$1"
  local target="$2"
  local fallback_url="${3:-}"
  local expected_sha256="${4:-}"

  if download_binary_once "${binary_url}" "${target}" "${expected_sha256}"; then
    return 0
  fi

  if [ -n "${fallback_url}" ]; then
    echo "warning: failed to download ${binary_url}, fallback to ${fallback_url}" >&2
    download_binary_once "${fallback_url}" "${target}" "${expected_sha256}"
    return $?
  fi

  return 1
}

append_query_param() {
  local url="$1"
  local key="$2"
  local value="$3"

  if [[ "${url}" == *\?* ]]; then
    echo "${url}&${key}=${value}"
  else
    echo "${url}?${key}=${value}"
  fi
}

sha256_file() {
  local path="$1"

  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "${path}" | awk '{print $1}'
    return 0
  fi

  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "${path}" | awk '{print $1}'
    return 0
  fi

  fail "sha256sum or shasum is required"
}

verify_sha256() {
  local path="$1"
  local expected="$2"
  local actual

  actual="$(sha256_file "${path}")"
  if [ "${actual}" != "${expected}" ]; then
    echo "warning: sha256 mismatch for ${path}: expected=${expected} actual=${actual}" >&2
    return 1
  fi
}

download_manifest() {
  local manifest_url="$1"
  local target="$2"

  if [ "${DRY_RUN}" = "1" ]; then
    echo "+ download ${manifest_url} -> ${target}"
    return 0
  fi

  command -v curl >/dev/null 2>&1 || fail "curl is required"
  fetch_public "${manifest_url}" -o "${target}"
}

manifest_value() {
  local manifest_path="$1"
  local platform="$2"
  local key="$3"
  local compact

  compact="$(tr -d '\n\r' < "${manifest_path}")"
  printf '%s\n' "${compact}" | sed -nE \
    "s/.*\"${platform}\"[[:space:]]*:[[:space:]]*\\{[^}]*\"${key}\"[[:space:]]*:[[:space:]]*\"?([^\",}]+)\"?.*/\\1/p" | head -n1
}

validate_binary_name() {
  local name="$1"
  local os="$2"
  local arch="$3"

  case "${name}" in
    "xpayincus-agent-v"*"-${os}-${arch}"|"xpayincus-agent-v"*"-${os}-${arch}.gz")
      return 0
      ;;
    *)
      fail "manifest binary name is invalid for ${os}-${arch}: ${name}"
      ;;
  esac
}

install_binary_atomically() {
  local source="$1"
  local target="$2"
  local next="${target}.new"

  if [ "${DRY_RUN}" = "1" ]; then
    echo "+ install ${source} -> ${target} (atomic replace)"
    return 0
  fi

  install -d -m 0755 "$(dirname "${target}")"
  install -m 0755 "${source}" "${next}"
  mv -f "${next}" "${target}"
}

preflight_target_parent() {
  local path="$1"
  local parent
  parent="$(dirname "${path}")"

  if [ "${DRY_RUN}" = "1" ]; then
    echo "+ preflight writable directory ${parent}"
    return 0
  fi

  if [ ! -d "${parent}" ]; then
    install -d -m 0755 "${parent}"
  fi
  [ -d "${parent}" ] && [ -w "${parent}" ] || fail "target directory is not writable: ${parent}"
}

preflight_environment() {
  if [ "${DRY_RUN}" = "1" ]; then
    echo "+ preflight root, systemd, curl, and target directories"
  else
    [ "$(id -u)" -eq 0 ] || fail "must run as root"
    command -v systemctl >/dev/null 2>&1 || fail "systemctl is required"
    [ -d /run/systemd/system ] || fail "systemd is not running"
    if [ -z "${LOCAL_BINARY}" ] || [ -n "${INCUDAL_AGENT_INSTALL_TOKEN:-}" ]; then
      command -v curl >/dev/null 2>&1 || fail "curl is required"
    fi
  fi

  preflight_target_parent "${BIN_PATH}"
  preflight_target_parent "${CONFIG_FILE}"
  preflight_target_parent "${SERVICE_FILE}"
}

rollback_agent_install() {
  local restore_ok=1
  systemctl stop "${SERVICE_NAME}" >/dev/null 2>&1 || true

  if [ "${HAD_OLD_BIN}" = "1" ] && [ -e "${BACKUP_BIN}" ]; then
    cp -a "${BACKUP_BIN}" "${BIN_PATH}.restore.$$" && mv -f "${BIN_PATH}.restore.$$" "${BIN_PATH}" || restore_ok=0
  else
    rm -f "${BIN_PATH}"
  fi
  if [ "${HAD_OLD_CONFIG}" = "1" ] && [ -e "${BACKUP_CONFIG}" ]; then
    cp -a "${BACKUP_CONFIG}" "${CONFIG_FILE}.restore.$$" && mv -f "${CONFIG_FILE}.restore.$$" "${CONFIG_FILE}" || restore_ok=0
  else
    rm -f "${CONFIG_FILE}"
  fi
  if [ "${HAD_OLD_SERVICE}" = "1" ] && [ -e "${BACKUP_SERVICE}" ]; then
    cp -a "${BACKUP_SERVICE}" "${SERVICE_FILE}.restore.$$" && mv -f "${SERVICE_FILE}.restore.$$" "${SERVICE_FILE}" || restore_ok=0
  else
    rm -f "${SERVICE_FILE}"
  fi

  systemctl daemon-reload >/dev/null 2>&1 || restore_ok=0
  if [ "${OLD_SERVICE_ENABLED}" = "1" ]; then
    systemctl enable "${SERVICE_NAME}" >/dev/null 2>&1 || restore_ok=0
  else
    systemctl disable "${SERVICE_NAME}" >/dev/null 2>&1 || true
  fi
  if [ "${OLD_SERVICE_ACTIVE}" = "1" ]; then
    systemctl restart "${SERVICE_NAME}" >/dev/null 2>&1 || restore_ok=0
    systemctl is-active --quiet "${SERVICE_NAME}" 2>/dev/null || restore_ok=0
  else
    systemctl stop "${SERVICE_NAME}" >/dev/null 2>&1 || true
  fi

  [ "${restore_ok}" = "1" ]
}

fetch_agent_install_config() {
  local install_token="${INCUDAL_AGENT_INSTALL_TOKEN:-}"
  if [ -z "${install_token}" ]; then
    return 0
  fi

  local config_url="${PANEL_BASE_URL}/api/agent/install-config/${install_token}"
  if [ "${DRY_RUN}" = "1" ]; then
    echo "+ fetch ${PANEL_BASE_URL}/api/agent/install-config/<redacted-install-token>"
    INCUDAL_AGENT_ID="${INCUDAL_AGENT_ID:-agt_from_install_token}"
    INCUDAL_AGENT_SECRET="${INCUDAL_AGENT_SECRET:-ias_from_install_token}"
    return 0
  fi

  command -v curl >/dev/null 2>&1 || fail "curl is required"
  INSTALL_CONFIG_PATH="$(mktemp)"
  if ! printf 'url = "%s"\n' "${config_url}" | curl -q -fsS --proto '=http,https' \
    --connect-timeout 10 --max-time 30 --config - -o "${INSTALL_CONFIG_PATH}" 2>/dev/null; then
    fail "Agent TOKEN exchange failed; do not retry automatically; generate a new TOKEN if consumed or uncertain"
  fi
  local line count=0
  while IFS= read -r line; do
    if [[ "${line}" =~ ^INCUDAL_AGENT_ID=\'(agt_[A-Za-z0-9_-]{24,64})\'$ ]] && [ "${count}" = "0" ]; then
      INCUDAL_AGENT_ID="${BASH_REMATCH[1]}"
    elif [[ "${line}" =~ ^INCUDAL_AGENT_SECRET=\'(ias_[A-Za-z0-9_-]{32,96})\'$ ]] && [ "${count}" = "1" ]; then
      INCUDAL_AGENT_SECRET="${BASH_REMATCH[1]}"
    else
      fail "invalid Agent install config response"
    fi
    count=$((count + 1))
  done < "${INSTALL_CONFIG_PATH}"
  [ "${count}" = "2" ] || fail "incomplete Agent install config response"
  rm -f "${INSTALL_CONFIG_PATH}"
  INSTALL_CONFIG_PATH=""
  unset INCUDAL_AGENT_INSTALL_TOKEN
}

prepare_inputs
need_env INCUDAL_PANEL_URL
HEARTBEAT_INTERVAL="$(normalize_heartbeat_interval "${HEARTBEAT_INTERVAL}")"

PANEL_BASE_URL="${INCUDAL_PANEL_URL%/}"
OS="$(detect_os)"
ARCH="$(detect_arch)"
DEFAULT_BINARY_BASE_URL="${PANEL_BASE_URL}/api/agent/binary"
BINARY_BASE_URL="${INCUDAL_AGENT_BINARY_BASE_URL:-${DEFAULT_BINARY_BASE_URL}}"
BINARY_NAME="xpayincus-agent-${OS}-${ARCH}"
BINARY_URL="${INCUDAL_AGENT_BINARY_URL:-}"
BINARY_EXPECTED_SHA256="${INCUDAL_AGENT_BINARY_SHA256:-}"
BINARY_FALLBACK_URL=""
MANIFEST_PATH=""
MANIFEST_URL="${INCUDAL_AGENT_MANIFEST_URL:-${PANEL_BASE_URL}/api/agent/manifest.json}"
STAGED_BIN="${BIN_PATH}.download.$$"
STAGED_CONFIG="${CONFIG_FILE}.new.$$"
STAGED_SERVICE="${SERVICE_FILE}.new.$$"
BACKUP_BIN="${BIN_PATH}.before-incudal-agent.$$"
BACKUP_CONFIG="${CONFIG_FILE}.before-incudal-agent.$$"
BACKUP_SERVICE="${SERVICE_FILE}.before-incudal-agent.$$"
HAD_OLD_BIN="0"
HAD_OLD_CONFIG="0"
HAD_OLD_SERVICE="0"
OLD_SERVICE_ACTIVE="0"
OLD_SERVICE_ENABLED="0"

cleanup() {
  rm -f "${STAGED_BIN}" "${STAGED_BIN}.download" "${STAGED_BIN}.tmp" \
    "${STAGED_CONFIG}" "${STAGED_SERVICE}" "${BIN_PATH}.new"
  if [ -n "${INSTALL_CONFIG_PATH:-}" ]; then
    rm -f "${INSTALL_CONFIG_PATH}"
  fi
  if [ -n "${MANIFEST_PATH:-}" ]; then
    rm -f "${MANIFEST_PATH}"
  fi
}
trap cleanup EXIT

preflight_environment

# 无一次性 token 时，静态凭据也必须在任何下载前完整存在。
if [ "${REINSTALL}" != "1" ] && [ -z "${INCUDAL_AGENT_INSTALL_TOKEN:-}" ]; then
  need_env INCUDAL_AGENT_ID
  need_env INCUDAL_AGENT_SECRET
  validate_credentials
fi

if [ -z "${INCUDAL_AGENT_BINARY_URL:-}" ]; then
  # Cloudflare 等边缘缓存可能缓存旧二进制；默认面板下载强制按安装批次换 URL。
  BINARY_CACHE_BUSTER="${INCUDAL_AGENT_BINARY_CACHE_BUSTER:-$(date +%s)}"
  MANIFEST_URL="$(append_query_param "${MANIFEST_URL}" "v" "${BINARY_CACHE_BUSTER}")"
  MANIFEST_PATH="${BIN_PATH}.manifest.$$"
  download_manifest "${MANIFEST_URL}" "${MANIFEST_PATH}"

  if [ "${DRY_RUN}" != "1" ]; then
    BINARY_NAME="$(manifest_value "${MANIFEST_PATH}" "${OS}-${ARCH}" "name")"
    BINARY_EXPECTED_SHA256="$(manifest_value "${MANIFEST_PATH}" "${OS}-${ARCH}" "sha256")"
    if [ -z "${BINARY_NAME}" ] || [ -z "${BINARY_EXPECTED_SHA256}" ]; then
      fail "agent manifest does not contain ${OS}-${ARCH} binary metadata"
    fi
    validate_binary_name "${BINARY_NAME}" "${OS}" "${ARCH}"
  else
    BINARY_NAME="${BINARY_NAME}.gz"
  fi

  BINARY_URL="${BINARY_BASE_URL}/${BINARY_NAME}"
  # The Agent binary proxy reserves "v" for exact release-version downloads.
  # Use a separate cache-busting key so installer downloads can fall back to
  # the manifest-selected binary without tripping version+sha256 validation.
  BINARY_URL="$(append_query_param "${BINARY_URL}" "cache_bust" "${BINARY_CACHE_BUSTER}")"
elif [ -z "${BINARY_EXPECTED_SHA256}" ]; then
  fail "INCUDAL_AGENT_BINARY_SHA256 is required when INCUDAL_AGENT_BINARY_URL is set"
fi

# 实际下载和校验在消费一次性 token 之前完成，下载失败时同一条命令仍可重试。
download_binary "${BINARY_URL}" "${STAGED_BIN}" "${BINARY_FALLBACK_URL}" "${BINARY_EXPECTED_SHA256}"

fetch_agent_install_config
if [ "${REINSTALL}" != "1" ]; then
  need_env INCUDAL_AGENT_ID
  need_env INCUDAL_AGENT_SECRET
  if [ "${DRY_RUN}" != "1" ]; then
    validate_credentials
  fi
fi

echo "Installing Incudal Agent"
echo "  panel: ${INCUDAL_PANEL_URL}"
echo "  mode: $([ "${REINSTALL}" = "1" ] && echo 'Agent reinstall (preserve config)' || echo 'Agent install')"
if [ -n "${BINARY_EXPECTED_SHA256}" ]; then
  echo "  sha256: ${BINARY_EXPECTED_SHA256}"
fi

# 先生成 0600 临时配置并用暂存二进制冒烟，正式文件此时尚未被替换。
if [ "${REINSTALL}" = "1" ]; then
  if [ "${DRY_RUN}" = "1" ]; then
    echo '+ stage existing Agent config (contents hidden)'
  else
    install -m 0600 -o root -g root "${CONFIG_FILE}" "${STAGED_CONFIG}"
  fi
else
write_file "${STAGED_CONFIG}" 0600 root:root <<EOF_CONFIG
panel_url: "${INCUDAL_PANEL_URL}"
agent_id: "${INCUDAL_AGENT_ID}"
agent_secret: "${INCUDAL_AGENT_SECRET}"
heartbeat_interval_seconds: ${HEARTBEAT_INTERVAL}
request_timeout_seconds: ${REQUEST_TIMEOUT}
EOF_CONFIG
fi

write_file "${STAGED_SERVICE}" 0644 root:root <<EOF_SERVICE
[Unit]
Description=Incudal Host Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${BIN_PATH} -config ${CONFIG_FILE}
Restart=always
RestartSec=5
User=root
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
CPUAccounting=true
CPUQuota=20%
MemoryAccounting=true
MemoryMax=256M
TasksMax=128
StandardOutput=journal
StandardError=journal
LogRateLimitIntervalSec=30s
LogRateLimitBurst=120

[Install]
WantedBy=multi-user.target
EOF_SERVICE

if [ "${DRY_RUN}" = "1" ]; then
  echo "Dry run completed."
  exit 0
fi

if ! "${STAGED_BIN}" -config "${STAGED_CONFIG}" -once; then
  fail "staged Agent smoke test failed; existing installation was not changed"
fi

# 冒烟通过后再备份旧文件。备份失败时仍未触碰正式安装。
if [ -e "${BIN_PATH}" ]; then
  cp -a "${BIN_PATH}" "${BACKUP_BIN}" || fail "failed to back up existing Agent binary"
  HAD_OLD_BIN="1"
fi
if [ -e "${CONFIG_FILE}" ]; then
  cp -a "${CONFIG_FILE}" "${BACKUP_CONFIG}" || fail "failed to back up existing Agent config"
  HAD_OLD_CONFIG="1"
fi
if [ -e "${SERVICE_FILE}" ]; then
  cp -a "${SERVICE_FILE}" "${BACKUP_SERVICE}" || fail "failed to back up existing Agent service"
  HAD_OLD_SERVICE="1"
fi
if systemctl is-active --quiet "${SERVICE_NAME}" 2>/dev/null; then
  OLD_SERVICE_ACTIVE="1"
fi
if systemctl is-enabled --quiet "${SERVICE_NAME}" 2>/dev/null; then
  OLD_SERVICE_ENABLED="1"
fi

COMMIT_OK="1"
install_binary_atomically "${STAGED_BIN}" "${BIN_PATH}" || COMMIT_OK="0"
if [ "${COMMIT_OK}" = "1" ]; then
  mv -f "${STAGED_CONFIG}" "${CONFIG_FILE}" || COMMIT_OK="0"
fi
if [ "${COMMIT_OK}" = "1" ]; then
  mv -f "${STAGED_SERVICE}" "${SERVICE_FILE}" || COMMIT_OK="0"
fi
if [ "${COMMIT_OK}" = "1" ]; then
  systemctl daemon-reload || COMMIT_OK="0"
fi
if [ "${COMMIT_OK}" = "1" ]; then
  systemctl enable "${SERVICE_NAME}" || COMMIT_OK="0"
fi
if [ "${COMMIT_OK}" = "1" ]; then
  # 已安装场景下 enable --now 不会重启旧进程；restart 确保升级后立即使用最新文件。
  systemctl restart "${SERVICE_NAME}" || COMMIT_OK="0"
fi
if [ "${COMMIT_OK}" = "1" ]; then
  sleep 2
  systemctl is-enabled --quiet "${SERVICE_NAME}" 2>/dev/null || COMMIT_OK="0"
  systemctl is-active --quiet "${SERVICE_NAME}" 2>/dev/null || COMMIT_OK="0"
  "${BIN_PATH}" -config "${CONFIG_FILE}" -once || COMMIT_OK="0"
fi

if [ "${COMMIT_OK}" != "1" ]; then
  echo "error: new Agent failed post-install validation; rolling back" >&2
  if rollback_agent_install; then
    fail "new Agent failed; previous binary, config, service, and runtime state were restored"
  fi
  fail "new Agent failed and automatic rollback was incomplete; backup files were preserved"
fi

rm -f "${BACKUP_BIN}" "${BACKUP_CONFIG}" "${BACKUP_SERVICE}"
systemctl status "${SERVICE_NAME}" --no-pager --lines=20 || true

echo "Incudal Agent installed or upgraded and started."
