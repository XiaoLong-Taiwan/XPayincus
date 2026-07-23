# Split Deployment

XPayincus production uses two public frontend domains, two Vite build outputs and one shared backend API. The user portal and admin console are not one SPA with hidden routes; they are separated by entrypoint, router, API client, navigation and deployment directory.

## Code Boundary

| Area | User portal | Admin console |
| --- | --- | --- |
| Vite entry | `VITE_APP_ENTRY=user` | `VITE_APP_ENTRY=admin` |
| Router | `client/src/router/user.ts` | `client/src/router/admin.ts` |
| Entrypoint | `client/src/main.ts` | `client/src/admin/main.ts` |
| API client | `client/src/api/index.ts` | `client/src/api/admin.ts` |
| URL helper | `app-paths-user` | `app-paths-admin` |
| Build output | `client/dist/user` | `client/dist/admin` |

## Deployment Boundary

```text
https://panel.example.com
  -> /opt/xpayincus/current/client/dist/user
  -> /api, /api/ws -> backend

https://admin.example.com
  -> /opt/xpayincus/current/client/dist/admin
  -> /api, /api/ws -> backend
```

Production backend settings should keep `SERVE_STATIC_CLIENT=false`; Nginx serves static files.

## Behavior Boundary

- Regular users cannot enter `/admin` routes or admin APIs.
- Admin accounts cannot use user-portal business pages.
- The user build must not contain admin entrypoints, admin API clients, admin navigation or admin wording.
- The admin build must not contain user self-service features such as recharge, check-in, friends, transfer or package sharing.
- Admin-generated customer links must use `FRONTEND_URL`, not the admin domain.

## Verification Commands

```bash
pnpm --filter server test:frontend-route-guards
pnpm --filter server test:frontend-dist-boundary-guards
```

Production domain verification:

```bash
FRONTEND_URL=https://panel.example.com \
ADMIN_FRONTEND_URL=https://admin.example.com \
BACKEND_URL=http://127.0.0.1:3001 \
pnpm verify:split:host
```

These checks prove build and domain boundaries only. Real login, payment callbacks, WebSocket terminal and administrator permissions still need live proof.
