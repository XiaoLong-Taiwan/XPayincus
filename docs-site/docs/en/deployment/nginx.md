# Nginx Split Deployment

Nginx serves two frontend builds and proxies API/WebSocket traffic to the same backend. Production should not let the backend serve frontend static assets directly.

Template:

```text
deploy/nginx-split-intranet.conf.example
```

## Replace

| Template value | Replace with |
| --- | --- |
| `panel.example.com` | User portal domain |
| `admin.example.com` | Admin console domain |
| `/opt/xpayincus/current/client/dist/user` | Active user frontend release directory |
| `/opt/xpayincus/current/client/dist/admin` | Active admin frontend release directory |
| `10.0.0.12:3001` | Backend internal IP and port; single-host deployments can use `127.0.0.1:3001` |

## Required Boundary

```text
User domain -> /opt/xpayincus/current/client/dist/user
Admin domain -> /opt/xpayincus/current/client/dist/admin
/api/ -> backend /api/
/api/ws/ -> backend /api/ws/
```

Do not serve the admin build from the user domain, and do not serve the user build from the admin domain. Both domains call the same backend through same-origin `/api`.

## WebSocket

Terminal and realtime tasks depend on `/api/ws/`. Keep upgrade headers enabled:

```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
proxy_buffering off;
```

## OTA Cache Rules

- Serve `index.html` with `expires epoch` so browsers reload the SPA entry after an OTA release switch.
- Serve `/assets/` from a dedicated static location with long-lived caching. Vite assets are content-hashed, so changed content gets a new path.
- If Cloudflare/CDN is in front, do not give `index.html` long-lived cache.

## Security Headers

The template sets:

```text
Content-Security-Policy
X-Frame-Options
X-Content-Type-Options
Referrer-Policy
Strict-Transport-Security
```

If another proxy, WAF or CDN is in front, acceptance checks must confirm that public responses still include these headers.

## Verification

```bash
nginx -t
systemctl reload nginx
```

```bash
FRONTEND_URL=https://panel.example.com \
ADMIN_FRONTEND_URL=https://admin.example.com \
BACKEND_URL=http://127.0.0.1:3001 \
pnpm verify:split:host
```

`verify:split:host` checks that the user and admin domains serve the correct builds, `/api/health` is reachable, and the WebSocket path satisfies the basic split-host requirements.
