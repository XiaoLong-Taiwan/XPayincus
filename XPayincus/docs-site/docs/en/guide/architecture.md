# Architecture

XPayincus is a control panel for commercial Incus/LXC/KVM delivery. The unified repository contains `XPayincus/client`, `XPayincus/server`, and `XPayincus-Agent`, with RFW/ZFS sources at `XPayincus-Agent/components/rfw` and `XPayincus-Agent/components/zfs`. Root `VERSION` defines the product release, targeting v1.0.11 (publication status is recorded in GitHub Releases). The Go Agent does not directly load eBPF or ZFS kernel modules.

Panel Compose deploys PostgreSQL, one API, and both frontends only. The entry point `deploy/compose/docker-compose.yml` includes `compose.yaml`, supporting Nginx, Cloudflare Tunnel, or an external HTTPS proxy; frontends default to loopback 3000/3001. Incus, Agent, RFW, and ZFS remain host components. The diagram below describes the retained systemd/Nginx host layout; its OTA flow does not apply to Compose, which rebuilds a selected source revision. Run exactly one Node API process, without cluster, multiple workers, container replicas, or old and new backends writing the same database.

The legacy host export tool and guide are at `XPayincus/server/scripts/export-legacy-host.mjs` and `LEGACY_HOST_EXPORT.md` relative to the unified repository root. Both ship in native Panel archives and Dashboard Compose source packages. Export includes the database, configuration, original keys, and certificates; it does not stop services, import data, switch deployments, or guarantee cross-version schema compatibility.

## Standard Topology

```text
User browser
  -> https://panel.example.com
  -> Nginx serves /opt/incudal/current/client/dist/user
  -> /api and /api/ws proxy to backend 127.0.0.1:3001 or an internal IP

Admin browser
  -> https://admin.example.com
  -> Nginx serves /opt/incudal/current/client/dist/admin
  -> /api and /api/ws proxy to the same backend

Backend Node API
  -> PostgreSQL
  -> Incus hosts / Agent
  -> Payment, SMTP, Telegram, Lsky, Turnstile
  -> Admin OTA
```

The legacy installer keeps Redis for deployment compatibility; the core does not require Redis and Compose does not deploy it. PostgreSQL stores core persistent state, while in-process state still requires a single API.

## Code Modules

| Module | Directory | Responsibility |
| --- | --- | --- |
| User portal | `client/src` + `VITE_APP_ENTRY=user` | Login, instances, terminal, wallet, tickets, notifications, gift cards and self-service pages |
| Admin console | `client/src/admin` + `VITE_APP_ENTRY=admin` | Operations, configuration, resources, billing, delivery, and OTA |
| Backend | `server/src` | Fastify APIs, auth, database, jobs, payment, delivery and audit |
| Agent | `../XPayincus-Agent` | Host heartbeat, resources, instance and traffic reporting; table paths are relative to `XPayincus/` |
| Host components | `../XPayincus-Agent/components/rfw`, `../XPayincus-Agent/components/zfs` | eBPF/XDP firewall and Debian ZFS builder; not automatically replaced by Go Agent upgrades |
| Docs site | `docs-site/docs` | Public docs, API reference, and SDK examples |

## Build Outputs

| Entry | Build output | Domain |
| --- | --- | --- |
| User portal | `client/dist/user` | `FRONTEND_URL` |
| Admin console | `client/dist/admin` | `ADMIN_FRONTEND_URL` |
| Backend | `server/dist/app.js` | `127.0.0.1:3001` or internal API |

`pnpm build` builds both frontends, runs frontend bundle boundary guards, then builds the backend.

## Data and Jobs

- PostgreSQL stores users, instances, plans, billing, payments, gift cards, tickets, notifications, logs, Public API/OAuth data and system update tasks.
- Backend workers process instance tasks, restore tasks, backup uploads, notification email jobs, traffic collection and maintenance tasks.
- High-risk state transitions must go through XPayincus internal state machines, transactions, permissions, audit and compensation logic. Public API can only use controlled entrypoints.
- Host OTA switches `/opt/incudal/current` atomically. See the [OTA guide](/en/guide/ota-update) for unified asset publishing, Git mode compatibility, and database rollback limits. Compose rebuilds a selected source revision.

## External Integrations

| Integration | Purpose | Risk boundary |
| --- | --- | --- |
| Incus/Agent | Instance delivery, resource and traffic state | Host certificates, install tokens and root passwords must not appear in the user portal or Public API |
| Payment providers | Recharge, callbacks, reconciliation, refund/adjustment review | Raw callbacks, secrets and provider config are admin-only and redacted |
| SMTP/Telegram | Mail and notifications | Channel secrets must not leak through responses or logs |
| Turnstile | Login, human verification and sensitive operation protection | Test tokens must not be used in production |
| Lsky | Ticket attachments and image storage | Upload tokens and raw provider payloads are not returned publicly |

## Production Constraints

- Keep `SERVE_STATIC_CLIENT=false`; Nginx serves frontend assets.
- Use separate domains and static directories for the user portal and admin console.
- Both frontends call same-origin `VITE_API_BASE_URL=/api`.
- Nginx proxies only `/api/` and `/api/ws/` to the backend.
- Do not long-cache `index.html`, or browsers may keep loading the old SPA after OTA.
- Payment callbacks should use the public user domain, not the admin domain or internal backend URL.
- The user portal must not expose admin entrypoints, admin APIs or admin wording.
- The admin console must not expose user self-service entrypoints.

## Verification Entrypoints

```bash
pnpm --filter server test:frontend-route-guards
pnpm --filter server test:frontend-dist-boundary-guards
pnpm --filter server test:system-update-guards
pnpm --filter server test:public-api-openapi-guards
```

Production domains also need `pnpm verify:split:host` and `pnpm verify:production`. Final acceptance requires real payment, real Incus/Agent, SMTP/notification, Turnstile and backup/restore proof.
