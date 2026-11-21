#!/usr/bin/env bash
set -euo pipefail

log() { echo -e "\033[1;32m[+] $1\033[0m"; }
warn() { echo -e "\033[1;33m[!] $1\033[0m"; }
error() { echo -e "\033[1;31m[-] $1\033[0m"; }

readonly CADDY_CONFIG_DIR="/etc/caddy"
readonly CADDYFILE="/etc/caddy/Caddyfile"
readonly CADDY_OVERRIDE_DIR="/etc/systemd/system/caddy.service.d"
readonly CADDY_OVERRIDE_FILE="/etc/systemd/system/caddy.service.d/override.conf"
readonly CADDY_ADMIN_ADDRESS="127.0.0.1:2019"
readonly CADDY_AUTOSAVE="/var/lib/caddy/.config/caddy/autosave.json"
readonly ZABBLY_KEYRING="/etc/apt/keyrings/zabbly.gpg"

while [[ $# -gt 0 ]]; do
  case "$1" in
    *) error "Unknown argument: $1"; exit 1 ;;
  esac
done

# 所有入参必须在 apt、systemctl 或配置文件改动之前完成校验。
if [[ "$EUID" -ne 0 ]]; then error "Must run as root"; exit 1; fi
if ! command -v systemctl >/dev/null 2>&1; then error "systemctl is required"; exit 1; fi

if [[ -f /etc/os-release ]]; then
    source /etc/os-release
    if [[ "${ID:-}" != "ubuntu" && "${ID:-}" != "debian" ]]; then
        error "Only Ubuntu/Debian supported"
        exit 1
    fi
else
    error "Cannot detect OS"; exit 1
fi

OLD_SERVICE_ACTIVE=false
OLD_SERVICE_ENABLED=false
HAD_EXISTING_CADDYFILE=false
[[ ! -e "$CADDYFILE" ]] || HAD_EXISTING_CADDYFILE=true
systemctl is-active --quiet caddy 2>/dev/null && OLD_SERVICE_ACTIVE=true
systemctl is-enabled --quiet caddy 2>/dev/null && OLD_SERVICE_ENABLED=true
CERT_TMP=""
KEY_TMP=""
CADDY_KEY_NEW=""
CADDY_SOURCE_NEW=""
CADDYFILE_NEW=""
OVERRIDE_NEW=""
CADDY_INSTALL_COMPLETE=false
ROLLBACK_HANDLED=false
TRANSACTION_STARTED=false
AUTOSAVE_NEW=""
BACKUP_DIR=""
HAD_OLD_AUTOSAVE=false

restore_caddy_install() {
    local restore_ok=true target name
    if [[ "$TRANSACTION_STARTED" == "true" ]]; then
        if ! systemctl stop caddy >/dev/null 2>&1; then
            error "Cannot stop Caddy for rollback; backups preserved at: $BACKUP_DIR"
            return 1
        fi
        for name in Caddyfile override.conf autosave.json; do
            case "$name" in
                Caddyfile) target="$CADDYFILE" ;;
                override.conf) target="$CADDY_OVERRIDE_FILE" ;;
                autosave.json) target="$CADDY_AUTOSAVE" ;;
            esac
            if [[ -e "$BACKUP_DIR/$name" ]]; then
                cp -a "$BACKUP_DIR/$name" "$target" || restore_ok=false
            else
                rm -f "$target" || restore_ok=false
            fi
        done
        systemctl daemon-reload >/dev/null 2>&1 || restore_ok=false
    fi
    if [[ "$OLD_SERVICE_ENABLED" == "true" ]]; then
        systemctl enable caddy >/dev/null 2>&1 || restore_ok=false
    else
        systemctl disable caddy >/dev/null 2>&1 || restore_ok=false
    fi
    if [[ "$restore_ok" == "true" && "$OLD_SERVICE_ACTIVE" == "true" ]]; then
        systemctl start caddy >/dev/null 2>&1 || restore_ok=false
        systemctl is-active --quiet caddy 2>/dev/null || restore_ok=false
    elif [[ "$OLD_SERVICE_ACTIVE" != "true" ]]; then
        systemctl stop caddy >/dev/null 2>&1 || restore_ok=false
    fi
    [[ "$restore_ok" == "true" ]]
}

cleanup_caddy_install() {
    local exit_status=$?
    rm -f "${CERT_TMP:-}" "${KEY_TMP:-}" "${CADDY_KEY_NEW:-}" "${CADDY_SOURCE_NEW:-}" "${CADDYFILE_NEW:-}" "${OVERRIDE_NEW:-}" "${AUTOSAVE_NEW:-}" 2>/dev/null || true
    if [[ "$exit_status" -ne 0 && "$CADDY_INSTALL_COMPLETE" != "true" && "$ROLLBACK_HANDLED" != "true" ]]; then
        set +e
        if ! restore_caddy_install; then
            error "Automatic rollback was incomplete; inspect backups at: ${BACKUP_DIR:-unavailable}"
        fi
    fi
}

repair_apt_keyring_permissions() {
    [[ ! -L /etc/apt/keyrings ]] || { error "APT keyring directory is a symlink"; return 1; }
    [[ -f "$ZABBLY_KEYRING" && ! -L "$ZABBLY_KEYRING" ]] || return 0
    chown root:root /etc/apt/keyrings "$ZABBLY_KEYRING"
    chmod 0755 /etc/apt/keyrings
    chmod 0644 "$ZABBLY_KEYRING"
}

log "Installing Caddy Web Server & Dependencies..."

export DEBIAN_FRONTEND=noninteractive

if ! repair_apt_keyring_permissions; then
    error "Unable to repair the Zabbly APT keyring permissions"
    exit 1
fi

if ! apt-get update --error-on=any -qq; then
    error "APT update failed before Caddy package or service changes; fix the repository error above and retry"
    exit 1
fi

trap cleanup_caddy_install EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

apt-get install -y -qq curl jq iproute2 debian-keyring debian-archive-keyring apt-transport-https >/dev/null

if ! command -v caddy &> /dev/null; then
    CADDY_KEY_NEW=$(mktemp /usr/share/keyrings/.caddy-stable-archive-keyring.XXXXXX)
    CADDY_SOURCE_NEW=$(mktemp /etc/apt/sources.list.d/.caddy-stable.XXXXXX)
    (umask 022; curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --yes --dearmor -o "$CADDY_KEY_NEW")
    chmod 0644 "$CADDY_KEY_NEW"
    (umask 022; curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > "$CADDY_SOURCE_NEW")
    chmod 0644 "$CADDY_SOURCE_NEW"
    mv -fT -- "$CADDY_KEY_NEW" /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    CADDY_KEY_NEW=""
    mv -fT -- "$CADDY_SOURCE_NEW" /etc/apt/sources.list.d/caddy-stable.list
    CADDY_SOURCE_NEW=""
    apt-get update --error-on=any -qq
    apt-get install -y -qq caddy >/dev/null
    log "Caddy installed successfully"
else
    log "Caddy already installed, updating..."
    apt-get install -y -qq caddy >/dev/null
fi

install -d -o root -g caddy -m 0750 "$CADDY_CONFIG_DIR"
install -d -o caddy -g caddy -m 0750 /var/log/caddy

chmod 0750 "$CADDY_CONFIG_DIR"

log "Preparing and validating Caddy configuration..."
if [[ "$HAD_EXISTING_CADDYFILE" == "true" ]]; then
    if ! caddy adapt --config "$CADDYFILE" --adapter caddyfile | jq -e '
        .admin.listen == "localhost:2019" or .admin.listen == "127.0.0.1:2019"
    ' >/dev/null; then
        error "Existing Caddyfile must declare localhost:2019 or 127.0.0.1:2019"
        exit 1
    fi
    CADDYFILE_NEW=$(mktemp "$CADDY_CONFIG_DIR/.Caddyfile.new.XXXXXX")
    awk '/^[ \t]*admin[ \t]+localhost:2019([ \t]*(#.*)?)$/ { sub(/localhost:2019/, "127.0.0.1:2019") } { print }' "$CADDYFILE" > "$CADDYFILE_NEW"
    if ! caddy adapt --config "$CADDYFILE_NEW" --adapter caddyfile | jq -e '.admin.listen == "127.0.0.1:2019"' >/dev/null; then
        error "Cannot safely migrate the existing admin directive; configuration was not changed"
        exit 1
    fi
else
    CADDYFILE_NEW=$(mktemp "$CADDY_CONFIG_DIR/.Caddyfile.new.XXXXXX")
    cat > "$CADDYFILE_NEW" <<EOF
{
    admin ${CADDY_ADMIN_ADDRESS}
}
EOF
fi
chown root:caddy "$CADDYFILE_NEW"
chmod 0640 "$CADDYFILE_NEW"
caddy validate --config "$CADDYFILE_NEW" --adapter caddyfile

install -d -o root -g root -m 0755 "$CADDY_OVERRIDE_DIR"
if [[ -e "$CADDY_OVERRIDE_FILE" ]]; then
    OVERRIDE_NEW=""
else
    OVERRIDE_NEW=$(mktemp "$CADDY_OVERRIDE_DIR/.override.conf.new.XXXXXX")
    cat > "$OVERRIDE_NEW" <<'EOF'
[Service]
ExecStart=
ExecStart=/usr/bin/caddy run --environ --config /etc/caddy/Caddyfile --resume
EOF
    chown root:root "$OVERRIDE_NEW"
    chmod 0644 "$OVERRIDE_NEW"
fi

SERVICE_ENV=$(systemctl show -p Environment --value caddy)
SERVICE_ENV_FILES=$(systemctl show -p EnvironmentFiles --value caddy)
SERVICE_COMMAND=$(systemctl show -p ExecStart --value caddy)
if [[ "$SERVICE_ENV" =~ (^|[[:space:]\"])(XDG_CONFIG_HOME|HOME)= || -n "$SERVICE_ENV_FILES" ]]; then
    error "Custom Caddy config environment requires manual migration"
    exit 1
fi
if [[ -z "$OVERRIDE_NEW" && ( "$SERVICE_COMMAND" != *"--config /etc/caddy/Caddyfile --resume"* || "$SERVICE_COMMAND" == *"--adapter"* ) ]]; then
    error "Custom Caddy startup requires manual migration"
    exit 1
fi
systemctl stop caddy
BACKUP_DIR=$(mktemp -d "$CADDY_CONFIG_DIR/.before-incudal.XXXXXX")
chmod 0700 "$BACKUP_DIR"
[[ ! -e "$CADDYFILE" ]] || cp -a "$CADDYFILE" "$BACKUP_DIR/Caddyfile"
[[ ! -e "$CADDY_OVERRIDE_FILE" ]] || cp -a "$CADDY_OVERRIDE_FILE" "$BACKUP_DIR/override.conf"
if [[ -e "$CADDY_AUTOSAVE" ]]; then
    cp -a "$CADDY_AUTOSAVE" "$BACKUP_DIR/autosave.json"
    HAD_OLD_AUTOSAVE=true
fi
TRANSACTION_STARTED=true
if [[ "$HAD_OLD_AUTOSAVE" == "true" ]]; then
    AUTOSAVE_NEW=$(mktemp "${CADDY_AUTOSAVE}.new.XXXXXX")
    jq -e '
        if type != "object" or (.admin != null and (.admin | type) != "object")
            or .admin.disabled == true or .admin.config.persist == false
            or ((.admin.listen // "localhost:2019") != "localhost:2019"
                and .admin.listen != "127.0.0.1:2019")
        then error("Unsupported autosave admin configuration")
        else .admin.listen = "127.0.0.1:2019" end
    ' "$CADDY_AUTOSAVE" > "$AUTOSAVE_NEW"
    cp "$AUTOSAVE_NEW" "$BACKUP_DIR/migrated.json"
    chown --reference="$CADDY_AUTOSAVE" "$AUTOSAVE_NEW"
    chmod --reference="$CADDY_AUTOSAVE" "$AUTOSAVE_NEW"
    caddy validate --config "$AUTOSAVE_NEW"
fi

SWITCH_OK=true
if [[ -n "$AUTOSAVE_NEW" ]]; then
    mv -f "$AUTOSAVE_NEW" "$CADDY_AUTOSAVE" || SWITCH_OK=false
fi
if [[ "$SWITCH_OK" == "true" && -n "$CADDYFILE_NEW" ]]; then
    mv -f "$CADDYFILE_NEW" "$CADDYFILE" || SWITCH_OK=false
fi
if [[ "$SWITCH_OK" == "true" && -n "$OVERRIDE_NEW" ]]; then
    mv -f "$OVERRIDE_NEW" "$CADDY_OVERRIDE_FILE" || SWITCH_OK=false
fi
if [[ "$SWITCH_OK" == "true" ]] && ! systemctl daemon-reload; then SWITCH_OK=false; fi
if [[ "$SWITCH_OK" == "true" ]] && ! systemctl enable caddy >/dev/null 2>&1; then SWITCH_OK=false; fi
if [[ "$SWITCH_OK" == "true" ]] && ! systemctl restart caddy; then SWITCH_OK=false; fi

MAIN_PID=""
LISTENER=""
if [[ "$SWITCH_OK" == "true" ]]; then
    sleep 2
    MAIN_PID=$(systemctl show -p MainPID --value caddy 2>/dev/null || true)
    LISTENER=$(ss -H -ltnp 2>/dev/null | awk '$4 == "127.0.0.1:2019" { print }' || true)
    PUBLIC_ADMIN_LISTENER=$(ss -H -ltnp 2>/dev/null | awk '$4 ~ /:2019$/ && $4 != "127.0.0.1:2019" { print }' || true)
    CADDY_UID=$(id -u caddy 2>/dev/null || true)
    if ! systemctl is-enabled --quiet caddy 2>/dev/null || \
       ! systemctl is-active --quiet caddy 2>/dev/null || \
       [[ ! "$MAIN_PID" =~ ^[1-9][0-9]*$ ]] || \
       [[ -z "$CADDY_UID" || ! -d "/proc/${MAIN_PID}" ]] || \
       [[ "$(stat -c %u "/proc/${MAIN_PID}" 2>/dev/null || true)" != "$CADDY_UID" ]] || \
       [[ -n "$PUBLIC_ADMIN_LISTENER" || -z "$LISTENER" ]] || ! grep -Fq "pid=${MAIN_PID}," <<<"$LISTENER"; then
        SWITCH_OK=false
    fi
    EXPECTED_CONFIG="$BACKUP_DIR/migrated.json"
    if [[ "$HAD_OLD_AUTOSAVE" != "true" ]]; then
        caddy adapt --config "$CADDYFILE" --adapter caddyfile > "$EXPECTED_CONFIG" || SWITCH_OK=false
    fi
    if ! curl --noproxy '*' -fsS --max-time 5 "http://${CADDY_ADMIN_ADDRESS}/config/" | jq -e --slurpfile expected "$EXPECTED_CONFIG" '
        .admin.listen == "127.0.0.1:2019" and . == $expected[0]
    ' >/dev/null; then
        SWITCH_OK=false
    fi
fi

if [[ "$SWITCH_OK" != "true" ]]; then
    error "Caddy failed enabled/active/listener/owner validation; restoring previous configuration"
    if restore_caddy_install; then
        error "New Caddy configuration failed; previous configuration and service state were restored"
    else
        error "Automatic rollback was incomplete; inspect backups at: $BACKUP_DIR"
    fi
    ROLLBACK_HANDLED=true
    exit 1
fi

CADDY_INSTALL_COMPLETE=true
log "Caddy installation complete!"
warn "Previous configuration backups preserved at: ${BACKUP_DIR}"
echo ""
echo -e "\033[1;36m========================================\033[0m"
echo -e "\033[1;36m  Caddy Reverse Proxy Ready\033[0m"
echo -e "\033[1;36m========================================\033[0m"
echo -e "\033[1;33m  Admin API:    ${CADDY_ADMIN_ADDRESS} (loopback only)\033[0m"
echo -e "\033[1;33m  Management:   Agent WSS tunnel\033[0m"
echo -e "\033[1;33m  Persistence:  API (--resume mode)\033[0m"
echo -e "\033[1;36m========================================\033[0m"
echo ""
echo -e "\033[1;32mPlease return to the panel and confirm the installation.\033[0m"
