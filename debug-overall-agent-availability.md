# Debug Session: overall-agent-availability

- Status: [AWAITING CONFIRMATION]
- Scope: Validate the main application and Agent together, identify runtime or contract failures, apply evidence-based fixes, and verify regressions.
- Constraint: Do not change business logic until runtime evidence identifies a root cause.

## Hypotheses

1. Existing build, type-check, lint, or test failures expose broken static contracts.
2. The main application and Agent disagree on install-token, host, route, or environment-variable contracts.
3. Startup ordering, health checks, or external dependencies prevent end-to-end availability.
4. Authentication, network, or process failures contain unhandled error paths.
5. Existing tests do not exercise the real main-application-to-Agent exchange flow.

## Evidence

- Pre-fix `pnpm test` printed `host address registry guard tests passed` but the Node process remained alive for more than seven minutes.
- Runtime instrumentation showed no active requests after the guard completed; importing `security.ts` created three referenced cleanup intervals.
- After the timer fix, the guard exited immediately and the full suite advanced to the next failure.
- The full suite then rejected public route `GET /api/agent/helpers/:helper`; the route itself uses a fixed two-entry filename allowlist.
- The server listened on port 3001, but background jobs emitted Prisma P2022 errors while `/api/health` and the monitor still reported healthy.
- Agent heartbeat smoke failed because `hosts.ipv4_alias` was absent. The development database had 204 of 207 migrations applied.
- Before the readiness fix, `verify:production-db` incorrectly passed against the incompatible schema.
- After adding schema compatibility probes, the same readiness command failed on the missing Host column and Agent enrollment table.
- Production split-host verification passed for `pay.payincus.com` and `admin.payincus.com`, including assets, API proxying, WebSocket proxying, TLS, and security headers.
- Production Agent release smoke failed because the deployed installer still uses `INCUDAL_*` variables and token-in-path enrollment, while the current source uses `XPAYINCUS_*` and a JSON-body token exchange.
- Browser verification reproduced `/market` rewriting itself to `?package=3` on initial load, incorrectly presenting a normal catalog visit as a package purchase link.

## Findings

1. Module-level cleanup intervals in `security.ts` prevented short-lived scripts from exiting.
2. The public Agent helper route was missing from the explicit route-security allowlist.
3. Production database readiness checked connectivity but did not reliably detect schema drift.
4. The local development database missed three additive migrations required by Agent Caddy tasks, Host IPv4 aliases, and Agent enrollment.
5. The client install-command response incorrectly typed `agent` as always present, although the server may return null.
6. The Agent README documented an obsolete token-in-path enrollment endpoint.
7. The public market wrote its implicit first-package preview into the URL and changed the page semantics.
8. Production currently serves an older Agent contract and cannot pass the current release smoke until a new panel/Agent release is deployed.

## Fixes

- Unreferenced the three cleanup intervals without changing cleanup behavior.
- Added the fixed-name Agent helper route to the explicit public-route guard.
- Added representative Host, SnapshotPolicy, and HostAgentEnrollment schema probes to production DB readiness.
- Extended the split deployment guard to require the schema compatibility check.
- Corrected the nullable client response type and Agent enrollment documentation.
- Applied the three pending additive migrations to the local `xpayincus_dev` database only.
- Kept the initial market package preview but only writes `package` to the URL for an incoming package link or an explicit user selection.

## Verification

- `pnpm test`: passed.
- `pnpm build`: passed.
- Client and server type checks: passed.
- Agent `go test ./...`, `go vet ./...`, and `gofmt -l`: passed.
- Agent heartbeat smoke: passed; replay and invalid signature both returned HTTP 401.
- Agent release smoke: passed; install script returned 200 and invalid binary requests returned 400.
- Production DB readiness: rejected the incompatible schema before migration and passed after migration.
- Server runtime: health returned 200; AutoPolicy and HostAddress jobs completed without schema errors.
- Installer, gift-card flow, and host network mode guards: passed.
- Remaining environment warnings: weak development secrets, no active payment provider, SMTP disabled, Lsky absent, no online Incus host, and no public package.
- Production split-host verification: passed against both public origins.
- Production browser verification: user home, `/market`, help, registration, password recovery, and admin login rendered without persistent console or network failures.
- Production Agent release verification: failed as expected against the older deployed `INCUDAL_*` installer; deployment remains required.
- Production DB readiness and real Agent heartbeat were not run because this machine has no production env, service, or database access.
