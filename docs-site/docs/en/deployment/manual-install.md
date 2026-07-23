# Manual Install

Manual deployment is intended for environments that already manage PostgreSQL, Nginx, systemd, TLS, and release operations. This procedure uses a SHA256-verified GitHub Release artifact and creates the same atomic layout used by admin OTA.

Example environment:

```text
Install directory: /opt/xpayincus
User portal: https://panel.example.com
Admin console: https://admin.example.com
Backend: 127.0.0.1:3001
```

## Runtime Dependencies

The server needs Node.js 22, pnpm 9.14.2, PostgreSQL 16, Redis, Nginx, and systemd. Redis 7 is recommended.

```bash
corepack enable
corepack prepare pnpm@9.14.2 --activate
node -v
pnpm -v
```

## Create Directories and User

```bash
sudo useradd --system --home /opt/xpayincus --shell /usr/sbin/nologin xpayincus 2>/dev/null || true
sudo install -d -o xpayincus -g xpayincus /opt/xpayincus /opt/xpayincus/releases /opt/xpayincus/update-logs
```

Do not create `/opt/xpayincus/current` as a regular directory. It must be a symlink to the active release.

## Download and Verify a Release

Confirm the version and server architecture on [GitHub Releases](https://github.com/XiaoLong-Taiwan/XPayincus/releases). The version below is an example; replace it with the production tag you intend to deploy.

```bash
export VERSION=v1.3.4
export ARCH=amd64
export PACKAGE="xpayincus-${VERSION}-linux-${ARCH}.tar.gz"
export RELEASE_DIR="/opt/xpayincus/releases/${VERSION}"

curl -fLO "https://github.com/XiaoLong-Taiwan/XPayincus/releases/download/${VERSION}/${PACKAGE}"
curl -fLO "https://github.com/XiaoLong-Taiwan/XPayincus/releases/download/${VERSION}/${PACKAGE}.sha256"
sha256sum -c "${PACKAGE}.sha256"
```

Stop immediately if verification fails. Do not extract or start the service.

## Install the Release and Switch `current`

```bash
sudo install -d -o xpayincus -g xpayincus "${RELEASE_DIR}"
sudo tar -xzf "${PACKAGE}" -C "${RELEASE_DIR}"
sudo chown -R xpayincus:xpayincus "${RELEASE_DIR}"

sudo rm -f /opt/xpayincus/releases/.next-current
sudo ln -s "${RELEASE_DIR}" /opt/xpayincus/releases/.next-current
sudo mv -Tf /opt/xpayincus/releases/.next-current /opt/xpayincus/current
readlink -f /opt/xpayincus/current
test -f /opt/xpayincus/current/server/dist/app.js
```

The release artifact already contains the built user portal, admin console, backend, and production dependencies. Do not rerun `pnpm install` or `pnpm build` on the server. Custom source builds should be produced by a separate CI pipeline with the same layout and a trusted SHA256.

## Environment

```bash
sudo cp /opt/xpayincus/current/.env.example /opt/xpayincus/.env
sudo chown xpayincus:xpayincus /opt/xpayincus/.env
sudo chmod 600 /opt/xpayincus/.env
sudo editor /opt/xpayincus/.env
```

Configure production values using [Environment Variables](/en/deployment/environment). The minimum set includes:

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=3001
TRUST_PROXY=true
SERVE_STATIC_CLIENT=false

DATABASE_URL=postgresql://xpayincus:change_me@127.0.0.1:5432/xpayincus
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
sudo -u xpayincus env HOME=/opt/xpayincus bash -lc \
  'cd /opt/xpayincus/current/server && pnpm exec prisma migrate deploy'
```

Do not use development reset commands on production data.

## Install systemd and Nginx

Install and verify the [systemd Service](/en/deployment/systemd). Its working directory must be `/opt/xpayincus/current`, and it must load `/opt/xpayincus/.env`.

The user and admin frontends require separate domains and static roots:

```text
panel.example.com -> /opt/xpayincus/current/client/dist/user
admin.example.com -> /opt/xpayincus/current/client/dist/admin
```

Proxy `/api/` and `/api/ws/` to the backend. See [Nginx Split Deployment](/en/deployment/nginx).

## Verification

```bash
systemctl is-active xpayincus-backend
curl -fsS http://127.0.0.1:3001/api/health

cd /opt/xpayincus/current
FRONTEND_URL=https://panel.example.com \
ADMIN_FRONTEND_URL=https://admin.example.com \
BACKEND_URL=http://127.0.0.1:3001 \
pnpm verify:split:host
```
