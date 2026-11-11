#!/usr/bin/env bash
set -euo pipefail
umask 022
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
[[ "$(id -u)" == 0 ]] || { printf 'Root is required\n' >&2; exit 1; }
command -v python3 >/dev/null
command -v systemctl >/dev/null
[[ -d /run/systemd/system ]] || { printf 'Running systemd is required\n' >&2; exit 1; }
for file in rfw/rfw-manage.py zfs/zfs-status.py host-snapshot.py; do
    [[ -f "$root/$file" && ! -L "$root/$file" ]] || { printf 'Missing regular source: %s\n' "$file" >&2; exit 1; }
done
install -d -m 0755 /usr/local/lib/xpayincus-host /usr/local/sbin /etc/systemd/system
for file in rfw/rfw-manage.py zfs/zfs-status.py host-snapshot.py; do
    destination="/usr/local/lib/xpayincus-host/${file##*/}"
    temporary="$(mktemp "${destination}.XXXXXXXX")"
    install -m 0755 -o root -g root "$root/$file" "$temporary"
    mv -f -- "$temporary" "$destination"
done
ln -sfn /usr/local/lib/xpayincus-host/rfw-manage.py /usr/local/sbin/rfw-manage
ln -sfn /usr/local/lib/xpayincus-host/zfs-status.py /usr/local/sbin/zfs-status
temporary="$(mktemp /etc/systemd/system/.xpayincus-snapshot-service.XXXXXXXX)"
cat > "$temporary" <<'EOF'
[Unit]
Description=XPayincus read-only %i status snapshot
After=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/bin/python3 /usr/local/lib/xpayincus-host/host-snapshot.py %i
User=root
UMask=0022
RuntimeDirectory=xpayincus
RuntimeDirectoryMode=0755
RuntimeDirectoryPreserve=yes
TimeoutStartSec=75
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/run/xpayincus
EOF
chmod 0644 "$temporary"
mv -f -- "$temporary" /etc/systemd/system/xpayincus-snapshot@.service
temporary="$(mktemp /etc/systemd/system/.xpayincus-snapshot-timer.XXXXXXXX)"
cat > "$temporary" <<'EOF'
[Unit]
Description=XPayincus periodic %i status snapshot

[Timer]
OnBootSec=30s
OnUnitInactiveSec=60s
AccuracySec=5s
Unit=xpayincus-snapshot@%i.service

[Install]
WantedBy=timers.target
EOF
chmod 0644 "$temporary"
mv -f -- "$temporary" /etc/systemd/system/xpayincus-snapshot@.timer
systemctl daemon-reload
systemctl enable --now xpayincus-snapshot@rfw.timer xpayincus-snapshot@zfs.timer
printf 'Host management tools and read-only snapshot timers installed.\n'
