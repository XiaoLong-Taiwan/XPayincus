# Manual Install

Manual deployment is intended for environments that already manage PostgreSQL, Nginx, systemd, TLS, and release operations. This procedure uses a SHA256-verified GitHub Release artifact and creates the same atomic layout used by admin OTA.

Example environment:

```text
Install directory: /opt/incudal
User portal: https://panel.example.com
Admin console: https://admin.example.com
Backend: 127.0.0.1:3001
```

## Runtime Dependencies

Host deployment needs Node.js 22, pnpm 9.14.2, PostgreSQL 16, Nginx, and systemd. The core does not require Redis; the legacy installer still installs Redis and generates service dependencies on it. Run exactly one Node API process, without cluster, multiple workers, or replicas. Panel Compose is a separate deployment option containing both frontends, one API, and PostgreSQL only; Incus, Agent, RFW, and ZFS remain on hosts.

```bash
corepack enable
corepack prepare pnpm@9.14.2 --activate
node -v
pnpm -v
```

## Create Directories and User

```bash
sudo useradd --system --home /opt/incudal --shell /usr/sbin/nologin incudal 2>/dev/null || true
sudo install -d -o incudal -g incudal /opt/incudal /opt/incudal/releases /opt/incudal/update-logs
```

Do not create `/opt/incudal/current` as a regular directory. It must be a symlink to the active release.

## Download and Verify a Release

Confirm the published version, SHA256, and server architecture in the actual release repository. The root release workflow uploads Actions artifacts only; it does not create GitHub Releases. The repository and version below are placeholders and require published assets. Use native Prisma dependencies for the selected architecture; renaming an amd64 package does not make an arm64 release.

```bash
export RELEASE_REPOSITORY=owner/unified-repository
export VERSION=v1.0.0
export ARCH=amd64
export PACKAGE="xpayincus-panel-${VERSION}-linux-${ARCH}.tar.gz"
export RELEASE_DIR="/opt/incudal/releases/${VERSION}"

curl -fLO "https://github.com/${RELEASE_REPOSITORY}/releases/download/${VERSION}/${PACKAGE}"
curl -fLO "https://github.com/${RELEASE_REPOSITORY}/releases/download/${VERSION}/${PACKAGE}.sha256"
sha256sum -c "${PACKAGE}.sha256"
```

Stop immediately if verification fails. Do not extract or start the service.

## Install the Release and Switch `current`

```bash
sudo install -d -o incudal -g incudal "${RELEASE_DIR}"
sudo tar -xzf "${PACKAGE}" -C "${RELEASE_DIR}"
sudo chown -R incudal:incudal "${RELEASE_DIR}"

sudo rm -f /opt/incudal/releases/.next-current
sudo ln -s "${RELEASE_DIR}" /opt/incudal/releases/.next-current
sudo mv -Tf /opt/incudal/releases/.next-current /opt/incudal/current
readlink -f /opt/incudal/current
test -f /opt/incudal/current/server/dist/app.js
```

The release artifact already contains the built user portal, admin console, backend, and production dependencies. Do not rerun `pnpm install` or `pnpm build` on the server. Custom source builds should be produced by a separate CI pipeline with the same layout and a trusted SHA256.

## Environment

```bash
sudo cp /opt/incudal/current/.env.example /opt/incudal/.env
sudo chown incudal:incudal /opt/incudal/.env
sudo chmod 600 /opt/incudal/.env
sudo editor /opt/incudal/.env
```

Configure production values using [Environment Variables](/en/deployment/environment). The minimum set includes:

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=3001
TRUST_PROXY=true
SERVE_STATIC_CLIENT=false

DATABASE_URL=postgresql://incudal:change_me@127.0.0.1:5432/incudal
JWT_SECRET=change_me_generate_with_openssl_rand_base64_48
COOKIE_SECRET=change_me_generate_with_openssl_rand_base64_48
ENCRYPTION_KEY=change_me_generate_with_openssl_rand_base64_48

FRONTEND_URL=https://panel.example.com
ADMIN_FRONTEND_URL=https://admin.example.com
SITE_URL=https://panel.example.com
PAYMENT_CALLBACK_BASE_URL=https://panel.example.com
```

Never set `RESET_DATABASE` in production. Enable payment, SMTP, Telegram, Turnstile, object storage, and OTA variables only after configuring their providers.

## Database Migration

Back up PostgreSQL first, then run:

```bash
sudo -u incudal env HOME=/opt/incudal bash -lc \
  'cd /opt/incudal/current/server && pnpm exec prisma migrate deploy'
```

Do not use development reset commands on production data.

## Install systemd and Nginx

Install and verify the [systemd Service](/en/deployment/systemd). Its working directory must be `/opt/incudal/current`, and it must load `/opt/incudal/.env`.

The user and admin frontends require separate domains and static roots:

```text
panel.example.com -> /opt/incudal/current/client/dist/user
admin.example.com -> /opt/incudal/current/client/dist/admin
```

Proxy `/api/` and `/api/ws/` to the backend. See [Nginx Split Deployment](/en/deployment/nginx).

## Verification and Limits

Commands below are pending references; no tests, builds, migrations, or deployments were performed during this documentation update. Keep separate HTTPS origins and leave `COOKIE_DOMAIN` empty. DB backups exclude keys, environment files, Incus certificates, and instance data. Code rollback does not reverse migrations. The Compose DB CLI only manages its own PostgreSQL and cannot directly manage the external database described here.

```bash
systemctl is-active incudal-backend
curl -fsS http://127.0.0.1:3001/api/health

cd /opt/incudal/current
FRONTEND_URL=https://panel.example.com \
ADMIN_FRONTEND_URL=https://admin.example.com \
BACKEND_URL=http://127.0.0.1:3001 \
pnpm verify:split:host
```
