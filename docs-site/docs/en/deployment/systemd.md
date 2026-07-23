# systemd Service

Production should run the backend under systemd and start OTA update/rollback work through narrow oneshot templates. The backend service is long-running; online update and rollback services run per task ID.

## Backend Service

Template:

```text
deploy/xpayincus-backend.service.example
```

Install:

```bash
sudo cp deploy/xpayincus-backend.service.example /etc/systemd/system/xpayincus-backend.service
sudo systemctl daemon-reload
sudo systemctl enable --now xpayincus-backend
sudo systemctl status xpayincus-backend --no-pager
```

Important runtime settings:

```text
User=xpayincus
Group=xpayincus
WorkingDirectory=/opt/xpayincus/current
EnvironmentFile=/opt/xpayincus/.env
ExecStartPre=/usr/bin/bash -lc 'cd /opt/xpayincus/current/server && pnpm exec prisma migrate deploy'
ExecStart=/usr/bin/node /opt/xpayincus/current/server/dist/app.js
```

`WorkingDirectory` points to `/opt/xpayincus/current`, so after OTA switches the symlink a service restart enters the new release.

## Permission Boundary

The backend template uses `ProtectSystem=strict` and `ProtectHome=true`, with write access limited to XPayincus runtime directories:

```text
/opt/xpayincus
/opt/xpayincus/current
/opt/xpayincus/releases
/opt/xpayincus/update-logs
```

Do not add `/`, `/etc` or database directories to `ReadWritePaths`. Payment secrets, database URLs, OAuth secrets, SMTP passwords and install tokens should live only in `/opt/xpayincus/.env` or encrypted admin configuration.

## Online Update Services

The update and rollback oneshots run as **root**, but their entry point is funneled through a single root helper, backed by restricted sudoers, an argument-validating wrapper, and a trusted file manifest — so the service user is never handed arbitrary root capability.

### 1. Install the root helper

Extract the helpers from a **SHA256-verified** release and install them `root:root 0755` (the `deploy/*.example` files below are the controlled templates shipped in `/opt/xpayincus/current`):

```bash
sudo install -d -o root -g root -m 0755 /usr/local/libexec/xpayincus /usr/local/libexec/xpayincus/ota-path
sudo install -o root -g root -m 0755 deploy/xpayincus-online-task.sh.example        /usr/local/libexec/xpayincus/xpayincus-online-task
sudo install -o root -g root -m 0755 deploy/xpayincus-systemctl-wrapper.sh.example  /usr/local/libexec/xpayincus/systemctl
sudo install -o root -g root -m 0755 deploy/xpayincus-ota-chown-wrapper.sh.example  /usr/local/libexec/xpayincus/ota-path/chown
# OTA runtime cache and trusted-manifest directories
sudo install -d -o root -g root -m 0755 /var/cache/xpayincus-ota /var/lib/xpayincus-ota/manifests
# Harden ownership: code / current / releases become root-owned; only runtime dirs stay writable by xpayincus
sudo /usr/local/libexec/xpayincus/xpayincus-online-task harden
```

- `xpayincus-online-task` — the only OTA entry point. Before `update <id>` / `rollback <id>` it verifies the trusted file manifest (SHA256), ownership, and git control, then runs `server/dist/scripts/run-system-update-task.js` as root; it re-seals the manifest after a successful task.
- `systemctl` (wrapper) — the only systemctl the service user can reach via sudo. It accepts only `start --no-block xpayincus-online-(update|rollback)@<positive integer>.service` and rejects anything else.

### 2. Install the systemd units

Templates:

```text
deploy/xpayincus-online-update@.service.example
deploy/xpayincus-online-rollback@.service.example
```

Install:

```bash
sudo cp deploy/xpayincus-online-update@.service.example /etc/systemd/system/xpayincus-online-update@.service
sudo cp deploy/xpayincus-online-rollback@.service.example /etc/systemd/system/xpayincus-online-rollback@.service
sudo systemctl daemon-reload
```

Both units are `Type=oneshot`, `User=root`, and their entry point is fixed to the root helper — they do **not** point at scripts inside the release:

```text
ExecStart=/usr/local/libexec/xpayincus/xpayincus-online-task update %i
ExecStart=/usr/local/libexec/xpayincus/xpayincus-online-task rollback %i
```

The admin OTA worker creates a task ID, then starts the corresponding unit through the restricted sudoers wrapper:

```text
sudo /usr/local/libexec/xpayincus/systemctl start --no-block xpayincus-online-update@<taskId>.service
sudo /usr/local/libexec/xpayincus/systemctl start --no-block xpayincus-online-rollback@<taskId>.service
```

## Restricted sudoers

Grant the service user only the **root helper wrapper** (not `/usr/bin/systemctl`), and pin the command lookup path with `secure_path`:

```bash
sudo tee /etc/sudoers.d/xpayincus-online-update >/dev/null << 'EOF'
Defaults:xpayincus !requiretty
Defaults:xpayincus secure_path=/usr/local/libexec/xpayincus:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
xpayincus ALL=(root) NOPASSWD: /usr/local/libexec/xpayincus/systemctl start --no-block xpayincus-online-update@*.service, /usr/local/libexec/xpayincus/systemctl start --no-block xpayincus-online-rollback@*.service
EOF
sudo chmod 440 /etc/sudoers.d/xpayincus-online-update
sudo visudo -cf /etc/sudoers.d/xpayincus-online-update
```

This only lets `xpayincus` start the update/rollback oneshots through the root-owned wrapper: the wrapper validates the unit name and task ID, and the helper then verifies the trusted manifest, ownership, and git control before anything runs. The service user gets neither an arbitrary root shell nor write access to the code tree or manifest.

### First-time manifest seal

Once the units and sudoers are in place, seal the current release once to write the trusted file manifest (every later OTA verifies against it and re-seals on success):

```bash
sudo /usr/local/libexec/xpayincus/xpayincus-online-task seal
```

## Logs

```bash
sudo journalctl -u xpayincus-backend -n 200 --no-pager
sudo journalctl -u 'xpayincus-online-update@*' -n 200 --no-pager
sudo journalctl -u 'xpayincus-online-rollback@*' -n 200 --no-pager
```

Admin OTA task logs are also written under `SYSTEM_UPDATE_LOG_DIR`, which defaults to `/opt/xpayincus/update-logs`.

## Agent Service

The host Agent install command generated by the admin console writes `xpayincus-agent.service` on the Incus host. The current template limits Agent resource use and journal write rate:

```text
CPUQuota=20%
MemoryMax=256M
TasksMax=128
StandardOutput=journal
StandardError=journal
LogRateLimitIntervalSec=30s
LogRateLimitBurst=120
```

If a host was installed with an older Agent, update the panel, copy a fresh Agent install command from the admin console, and run it once on the host. Agent binary self-upgrade alone does not rewrite an old systemd service, so old hosts may still lack CPU, memory and journal rate limits.

## Verification

```bash
systemctl is-active xpayincus-backend
curl -fsS http://127.0.0.1:3001/api/health
```

If startup fails, inspect `journalctl -u xpayincus-backend`, then verify `/opt/xpayincus/.env`, database connectivity, the `/opt/xpayincus/current` symlink, and `server/dist/app.js`.
