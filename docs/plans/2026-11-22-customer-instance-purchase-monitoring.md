# Plan: 客戶實例與購買流程整合改版

Source: `docs/specs/2026-11-22-customer-instance-purchase-monitoring-design.md`
Created: 2026-11-22
Status: draft

## Files

- `XPayincus/server/src/services/agent-monitoring.ts`
- `XPayincus/server/src/lib/agent-monitoring-stream.ts`
- `XPayincus/server/src/routes/agent.ts`
- `XPayincus/server/src/routes/agent-monitoring-stream.ts`
- `XPayincus/server/src/app.ts`
- `XPayincus/server/src/services/agent-monitoring-cleanup.ts`
- `XPayincus/server/src/services/monitoring-retention.ts`
- `XPayincus-Agent/internal/report/monitoring.go`
- `XPayincus-Agent/internal/report/collector.go`
- `XPayincus-Agent/internal/panel/monitoring.go`
- `XPayincus-Agent/internal/panel/client.go`
- `XPayincus-Agent/internal/panel/monitoring_test.go`
- `XPayincus/server/prisma/schema.prisma`
- `XPayincus/server/prisma/migrations/20261122000000_add_provisioning_error_metadata/migration.sql`
- `XPayincus/server/prisma/migrations/20261122000100_remove_mail_product/migration.sql`
- `XPayincus/server/src/routes/instances.ts`
- `XPayincus/server/src/routes/operations.ts`
- `XPayincus/server/src/db/instance-tasks.ts`
- `XPayincus/server/src/services/provisioning-error.ts`
- `XPayincus/server/scripts/test-provisioning-error-contract-guards.ts`
- `XPayincus/client/src/api/agent-monitoring.ts`
- `XPayincus/client/src/api/index.ts`
- `XPayincus/client/src/views/InstanceDetailView.vue`
- `XPayincus/client/src/components/instances/InstanceMonitoringPanel.vue`
- `XPayincus/client/src/components/instances/InstanceNetworkInfo.vue`
- `XPayincus/client/src/composables/useInstanceMonitoring.ts`
- `XPayincus/client/src/scripts/test-instance-monitoring-guards.mjs`
- `XPayincus/client/src/views/InstanceCreateView.vue`
- `XPayincus/client/src/components/instances/InstancePurchaseStepper.vue`
- `XPayincus/client/src/scripts/test-instance-purchase-flow-guards.mjs`
- `XPayincus/client/src/views/HostingApplicationView.vue`
- `XPayincus/client/src/scripts/test-hosting-application-ui-guards.mjs`
- `XPayincus/client/src/router/user.ts`
- `XPayincus/client/src/router/admin.ts`
- `XPayincus/client/src/config/side-nav-items-user.ts`
- `XPayincus/client/src/config/side-nav-items-admin.ts`
- `XPayincus/client/src/components/layout/SideNav.vue`
- `XPayincus/client/src/utils/app-paths.ts`
- `XPayincus/client/src/api/admin.ts`
- `XPayincus/client/src/stores/config.ts`
- `XPayincus/server/src/app.ts`
- `XPayincus/server/src/db/mail.ts`
- `XPayincus/server/src/db/aff.ts`
- `XPayincus/server/src/routes/mail.ts`
- `XPayincus/server/src/services/cranemail.ts`
- `XPayincus/server/src/services/smartermail.ts`
- `XPayincus/server/src/services/mail-expiry-scheduler.ts`
- `XPayincus/server/src/services/mail-autorenew-scheduler.ts`
- `XPayincus/server/src/services/mail-usage-scheduler.ts`
- `XPayincus/server/prisma/schema.prisma`
- `XPayincus/server/scripts/test-mail-route-id-guards.ts`
- `XPayincus/server/scripts/test-mail-removal-guards.ts`
- `XPayincus/client/src/locales/en.ts`
- `XPayincus/client/src/locales/zh-CN.ts`
- `XPayincus/client/src/locales/zh-TW.ts`
- `XPayincus/client/scripts/test-frontend-route-guards.ts`
- `XPayincus/client/scripts/test-frontend-i18n-keys.ts`

## Task 1: 建立監控 SSE 與七日保留

Owner: server monitoring

### Files

- Create `XPayincus/server/src/lib/agent-monitoring-stream.ts`
- Create `XPayincus/server/src/routes/agent-monitoring-stream.ts`
- Create `XPayincus/server/src/services/agent-monitoring-cleanup.ts`
- Modify `XPayincus/server/src/services/agent-monitoring.ts`
- Modify `XPayincus/server/src/routes/agent.ts`
- Modify `XPayincus/server/src/app.ts`
- Create `XPayincus/server/scripts/test-agent-monitoring-stream-guards.ts`

### Steps

1. Write a guard test that asserts the monitoring stream exposes `text/event-stream`, validates authenticated instance ownership, emits a complete sample event, emits an offline event after the freshness threshold, and rejects an unrelated user.
2. Run `pnpm --filter server exec tsx scripts/test-agent-monitoring-stream-guards.ts`; it must fail because the stream route and publisher are absent.
3. Add a process-local publisher keyed by instance ID, an SSE route with heartbeat and disconnect cleanup, a snapshot query that filters the existing journal to the instance, and app startup cleanup that removes samples older than seven days without changing Agent tunnel authentication. Register the route before the generic agent routes and use the existing auth and error utilities.
4. Run `pnpm --filter server exec tsx scripts/test-agent-monitoring-stream-guards.ts` and `pnpm --filter server type-check`; both must pass.
5. Commit with `feat(server): add instance monitoring SSE stream`; stage only the Task 1 files.

## Task 2: 補齊 Agent 網路採樣與事件發布

Owner: agent monitoring

### Files

- Modify `XPayincus-Agent/internal/report/monitoring.go`
- Modify `XPayincus-Agent/internal/report/collector.go`
- Modify `XPayincus-Agent/internal/panel/monitoring.go`
- Modify `XPayincus-Agent/internal/panel/client.go`
- Create `XPayincus-Agent/internal/panel/monitoring_test.go`

### Steps

1. Write Go tests for adjacent snapshots that calculate per-instance network receive and transmit bytes per second, preserve cumulative byte counters, and omit rates when the sample interval or instance identity is invalid.
2. Run `go test ./internal/report ./internal/panel`; it must fail on missing network rate fields or assertions.
3. Extend the existing performance snapshot with Incus interface counters, calculate rates from monotonic deltas, add receive/transmit cumulative counters to the monitoring payload, and preserve the current spool and monitoring ACK behaviour. Do not add credentials or raw command output to the payload.
4. Run `gofmt -w` on the four Go implementation files, then run `go test ./internal/report ./internal/panel`; all tests must pass.
5. Commit with `feat(agent): report instance network metrics`; stage only the Task 2 files.

## Task 3: 傳遞建立實例結構化錯誤

Owner: provisioning API

### Files

- Modify `XPayincus/server/prisma/schema.prisma`
- Create `XPayincus/server/prisma/migrations/20261122000000_add_provisioning_error_metadata/migration.sql`
- Create `XPayincus/server/src/services/provisioning-error.ts`
- Modify `XPayincus/server/src/routes/instances.ts`
- Modify `XPayincus/server/src/routes/operations.ts`
- Modify `XPayincus/server/src/db/instance-tasks.ts`
- Create `XPayincus/server/scripts/test-provisioning-error-contract-guards.ts`

### Steps

1. Write route guard tests for a failed provisioning job that returns an error code, safe localized detail, request/task identifier, and retryability; assert that a different user cannot read the error and that secret-like payload fields are absent.
2. Run `pnpm --filter server exec tsx scripts/test-provisioning-error-contract-guards.ts`; it must fail because structured error columns and the response contract do not exist.
3. Add nullable structured error code, safe detail, request identifier, and retryable fields to `ProvisioningJob`; create the forward migration; normalize worker exceptions through `provisioning-error.ts`; expose the fields through the existing provisioning and operations queries; retain compensation, idempotency, Turnstile, billing, and resource validation paths.
4. Run `pnpm --filter server exec prisma generate`, `pnpm --filter server exec tsx scripts/test-provisioning-error-contract-guards.ts`, and `pnpm --filter server type-check`; all must pass.
5. Commit with `feat(server): expose provisioning failure details`; stage only the Task 3 files.

## Task 4: 改造實例詳情監控與網路資訊

Owner: customer instance detail

### Files

- Modify `XPayincus/client/src/api/agent-monitoring.ts`
- Modify `XPayincus/client/src/api/index.ts`
- Create `XPayincus/client/src/composables/useInstanceMonitoring.ts`
- Create `XPayincus/client/src/components/instances/InstanceMonitoringPanel.vue`
- Create `XPayincus/client/src/components/instances/InstanceNetworkInfo.vue`
- Modify `XPayincus/client/src/views/InstanceDetailView.vue`
- Create `XPayincus/client/src/scripts/test-instance-monitoring-guards.mjs`

### Steps

1. Write frontend guards for IPv4-only, IPv4-plus-IPv6, mapped public SSH port, CPU/network/memory rendering, seven-day trend loading, reconnect state, and Agent offline state.
2. Run `node client/scripts/test-instance-monitoring-guards.mjs`; it must fail because the components and SSE composable are absent.
3. Add typed monitoring API contracts, an EventSource composable with credentials, exponential reconnect capped at five attempts, stale-state detection, bounded in-memory trend data, and accessible panels. Render `port_mappings.public_port` for SSH and omit IPv6 when null. Remove the existing stats polling only after SSE initial snapshot and fallback history are wired.
4. Run `node client/scripts/test-instance-monitoring-guards.mjs`, `pnpm --filter client type-check`, and `pnpm --filter client build`; all must pass.
5. Commit with `feat(client): add live instance monitoring`; stage only the Task 4 files.

## Task 5: 將建立實例改為購買步驟

Owner: customer purchase flow

### Files

- Create `XPayincus/client/src/components/instances/InstancePurchaseStepper.vue`
- Modify `XPayincus/client/src/views/InstanceCreateView.vue`
- Create `XPayincus/client/src/scripts/test-instance-purchase-flow-guards.mjs`

### Steps

1. Write guards for package selection, instance configuration, confirmation summary, payment/submit state, creating state, success state, failure state, back navigation without data loss, and disabled final submit during an active request.
2. Run `node client/scripts/test-instance-purchase-flow-guards.mjs`; it must fail because the stepper and state transitions are absent.
3. Extract the existing controls into a stepper with explicit step validation, retain all current package/plan/resource/image/SSH/init-command/promo fields, show price and resource summaries before submission, keep the current idempotency key and Turnstile token generation, and render structured provisioning errors with request/task IDs. Preserve server-side validation and redirect semantics.
4. Run `node client/scripts/test-instance-purchase-flow-guards.mjs`, `pnpm --filter client type-check`, and `pnpm --filter client build`; all must pass.
5. Commit with `feat(client): add instance purchase stepper`; stage only the Task 5 files.

## Task 6: 統一託管上架申請介面

Owner: hosting application UI

### Files

- Modify `XPayincus/client/src/views/HostingApplicationView.vue`
- Create `XPayincus/client/src/scripts/test-hosting-application-ui-guards.mjs`

### Steps

1. Write guards for AppLayout-compatible page header, shared card/input/button classes, loading skeleton, empty/error retry state, pending state, rejected reason state, and approved action state.
2. Run `node client/scripts/test-hosting-application-ui-guards.mjs`; it must fail because the view still relies on page-local application styles and status markup.
3. Replace page-local presentation with the existing page header, card, input, button, spinner/skeleton, error, and toast patterns while retaining all current API calls, status transitions, rejection reason, and approved links.
4. Run `node client/scripts/test-hosting-application-ui-guards.mjs` and `pnpm --filter client type-check`; both must pass.
5. Commit with `style(client): unify hosting application view`; stage only the Task 6 files.

## Task 7: 完整移除郵箱販售商品

Owner: mail product removal

### Files

- Modify `XPayincus/server/prisma/schema.prisma`
- Create `XPayincus/server/prisma/migrations/20261122000100_remove_mail_product/migration.sql`
- Modify `XPayincus/server/src/app.ts`
- Delete `XPayincus/server/src/db/mail.ts`
- Delete `XPayincus/server/src/routes/mail.ts`
- Delete `XPayincus/server/src/services/cranemail.ts`
- Delete `XPayincus/server/src/services/smartermail.ts`
- Delete `XPayincus/server/src/services/mail-expiry-scheduler.ts`
- Delete `XPayincus/server/src/services/mail-autorenew-scheduler.ts`
- Delete `XPayincus/server/src/services/mail-usage-scheduler.ts`
- Modify `XPayincus/server/src/db/aff.ts`
- Modify `XPayincus/client/src/router/user.ts`
- Modify `XPayincus/client/src/router/admin.ts`
- Modify `XPayincus/client/src/config/side-nav-items-user.ts`
- Modify `XPayincus/client/src/config/side-nav-items-admin.ts`
- Modify `XPayincus/client/src/components/layout/SideNav.vue`
- Modify `XPayincus/client/src/utils/app-paths.ts`
- Modify `XPayincus/client/src/api/admin.ts`
- Modify `XPayincus/client/src/stores/config.ts`
- Delete `XPayincus/client/src/views/MailView.vue`
- Delete `XPayincus/client/src/views/MailDomainView.vue`
- Delete `XPayincus/client/src/views/admin/AdminMailView.vue`
- Modify `XPayincus/client/src/locales/en.ts`
- Modify `XPayincus/client/src/locales/zh-CN.ts`
- Modify `XPayincus/client/src/locales/zh-TW.ts`
- Create `XPayincus/server/scripts/test-mail-removal-guards.ts`
- Modify `XPayincus/client/scripts/test-frontend-route-guards.ts`
- Modify `XPayincus/client/scripts/test-frontend-i18n-keys.ts`

### Steps

1. Write guards that fail if mail product routes, navigation, provider services, product API exports, mail-only scheduler registrations, mail subscription schema relations, or mail product translation keys remain; add positive assertions for `mailer.ts`, system SMTP routes, verification email, and notification email.
2. Run `pnpm --filter server exec tsx scripts/test-mail-removal-guards.ts`; it must fail while the mail product is present.
3. Remove the product models, enums, relations, API, routes, pages, navigation, provider integrations, schedulers, product-only affiliate fields, and availability flags; add a forward migration that drops only product tables and columns. Keep `mailer.ts`, system SMTP configuration, system SMTP API, verification/notification queues, and all transactional email call sites.
4. Run `pnpm --filter server exec prisma generate`, `pnpm --filter server exec tsx scripts/test-mail-removal-guards.ts`, `pnpm --filter client type-check`, `pnpm --filter server type-check`, and `pnpm build`; all must pass.
5. Commit with `refactor: remove mail product module`; stage only the Task 7 files.

## Task 8: 整合驗證與瀏覽器回歸

Owner: integration verification

### Files

- Modify `XPayincus/client/scripts/test-frontend-route-guards.ts`
- Modify `XPayincus/client/scripts/test-frontend-i18n-keys.ts`
- Create `XPayincus/server/scripts/test-customer-instance-integration-guards.ts`

### Steps

1. Write integration guards for the complete contract: IPv4/IPv6 and mapped SSH output, SSE auth and reconnect contract, provisioning error visibility, purchase step order, hosting application shared styling, mail product absence, and system email presence.
2. Run `pnpm --filter server exec tsx scripts/test-customer-instance-integration-guards.ts`; it must fail until every task contract is present.
3. Update route and i18n guards for the new purchase, monitoring, provisioning-error, and hosting-application keys while removing only mail product assertions. Keep system SMTP translation assertions and route checks.
4. Run `pnpm test`, `pnpm lint`, `pnpm build`, and `pnpm --filter server exec tsx scripts/test-customer-instance-integration-guards.ts`; all must pass, followed by browser checks at desktop and mobile widths for the purchase flow and instance detail SSE state transitions.
5. Commit with `test: cover customer instance integration contracts`; stage only the Task 8 files.
