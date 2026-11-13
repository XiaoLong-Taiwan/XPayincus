# Release Notes

Release documentation has two layers:

- This page: manually maintained release strategy, OTA capability and production verification notes.
- [System Version Log](/en/release/version-log): automatically generated from Git tags and commits.

Root `VERSION` and `RELEASE.md` define the unified release. The current target is **v1.0.15**; GitHub Releases record publication status.

## v1.0.15 Storage Pools, Monitoring, and Host Entry Points (Release Target)

- Persist storage pool `purpose` updates after checking registration and association. Purpose-only changes do not call Incus; capacity or description changes update Incus.
- Use the shared HTTP client for Agent monitoring, retaining common authentication, refresh, and error handling, query parameters, cancellation signals, and the 30-second timeout.
- Correct the unified repository path for `incudal`/`k` shortcuts. Atomically replace the cache only after successful download and Bash validation; failures preserve but do not execute the cache. Preserve unrelated existing `k` commands and provide `--install-shortcuts` for repair.
- Remove maintenance preflight/creation controls and related target/instance requests from host details, retaining existing plans and follow-up actions.
- Synchronize product versions, Compose tags, fixtures, and current documentation, retaining third-party and historical versions, 30 assets, and minimum updater `v0.0.3`.
- This cycle uses editing and static inspection only, without tests, type checks, builds, commits, or publication; remote Releases were not rechecked. Full details are in `docs-site/release-notes/v1.0.15.md`.

## v1.0.14 Installation Details and Flow Fixes (Historical Preparation)

- Display the installation command, panel address, and TOKEN separately with independent copy actions, success/failure feedback, and Agent TOKEN expiration. Commands do not embed the TOKEN.
- Clear frontend installation details before reloading, on closing, host changes, deactivation, and unmount; ignore stale responses. This does not revoke issued TOKENs or clear the clipboard.
- Show and confirm the plan before installation, handling UUID host and `ait_` Agent TOKENs through their respective flows. Fresh installs prepare Incus/ZFS before Agent installation, default new pools to ZFS, and preserve existing pools; reinstalls retain configuration. Update host trust after confirmation and refresh Incus trust after Agent installation.
- Improve step output, terminal menus, and color suppression. Accept decimal capacities with distinct GB/GiB units. Disable framework request logs on the legacy host script route containing TOKENs; external proxies still need URL redaction.
- Synchronize product versions, Compose tags, fixtures, and current documentation, retaining third-party and historical versions, 30 assets, and minimum updater `v0.0.3`.
- On 2026-11-13, GitHub confirmed v1.0.13 as a non-draft, non-prerelease release published at `2026-11-12T16:51:03Z`. This cycle uses editing and static inspection only, without tests, builds, commits, or publication. Full details are in `docs-site/release-notes/v1.0.14.md`.

## v1.0.13 Fixes and Version Synchronization

- Calculate the default ZFS loop size from half the free space on the filesystem containing `/var/lib/incus`, rounded down to whole GiB and capped at 10GiB. Valid sizes must be at least 1GiB and no more than half the free space.
- Prompt again for malformed, undersized, or oversized interactive input. Empty input uses the dynamic default, and EOF stops the operation. An invalid explicit `INCUS_STORAGE_SIZE` fails directly.
- With automatic driver selection and no explicit size, fall back to `dir` when half the free space cannot fit 1GiB. An explicit ZFS driver or size fails instead of silently switching. Failed capacity queries or invalid capacity data stop pool creation.
- Synchronize three VERSION files, four package.json files, the RFW first-party crates and Cargo.lock, the Agent default, Compose tags, fixtures, and current documentation. Retain the 30-asset set and minimum updater `v0.0.3`.
- Full details are in `docs-site/release-notes/v1.0.13.md`.

## v1.0.12 New Capabilities (Released; Historical Preparation)

Publication status follows the maintainer's confirmation on 2026-11-13; the preparation and validation record below is preserved.

- Agent schemaVersion 2 adds host/instance history, Linux PSI, instance rankings, and RFW/ZFS state events, with avg/min/max/count/coverage and cumulative counter deltas/reset detection. Missing values are not zero. Retention is at most 30 days; each Agent is capped at 8192 samples or 1536 KiB and 512 events or 256 KiB, so capacity can truncate history sooner. Persist state at both ends and run one Node API process.
- Product network probes retain browser HTTPS and manually submitted local TCP/ICMP records, always marked `verified: false`. Manual submissions require acknowledgement; the Agent does not execute remote probes. Retention is at most 30 days, with 100 records per owner and 10000 globally. Ship migration `20261111050000_network_probe_records`.
- Compose updates save deployment files and a nonempty database dump, hash backups, and persist completion in the journal. Resume validates backup integrity. Failures retain backups without automatic database rollback; writes may occur between the live snapshot and migration. Back up keys, configuration, and certificates off-host separately.

This target follows the maintainer-confirmed v1.0.11 release run `42940308896` and authorization after public release review and receipt completion. Root `RELEASE.md` records the full scope and limits. This cycle uses editing and static inspection only: no local tests, type checks, builds, packaging, staging, commits, pushes, publication, or deployment.

## v1.0.11 New Capabilities (Historical Preparation)

- Task center, persistent provisioning progress and retries, purchase drafts, stock subscriptions, and 7/30-day automatic renewal forecasts.
- Host maintenance plans with restricted IPv4 NAT/shared OVN cold migration; hosting withdrawal payment status, references, proof, and failure refunds.
- Agent background collection, history replay, persistent upgrade health confirmation, read-only RFW/ZFS status, and independent host tools.
- Compose doctor, migration planning, update preflight, and backup inventories, retaining the complete 30-asset release contract.

Ship migration `20261110000000_add_delivery_maintenance_stock_payments` with the application. Back up the database and original keys before upgrading; database rollback is not automatic. This version synchronization uses static inspection only, without tests, builds, commits, or deployment. The full release draft is in `docs-site/release-notes/v1.0.11.md`.

## Versioning Rule / 版本号规则

- The unified root `VERSION` is the sole source, using canonical `vMAJOR.MINOR.PATCH[-prerelease][+build]` as specified in root `RELEASE.md`.
- Patch numbers are not limited to one digit: this cycle advances the source version from `v1.0.14` to `v1.0.15`, without implying that the preceding version was published.
- Core numbers and numeric prerelease identifiers must not have leading zeros. Version files reject BOM, whitespace, and extra lines, allowing one optional LF/CRLF ending.
- Preserve historical tags, handoffs, and release notes. Third-party dependency and actual ZFS module versions do not follow the product version.

## OTA Release Frequency / OTA 发布频率

- Do not publish an OTA for every tiny change / 不要每修一个小点就发 OTA.
- Publish one OTA after a feature, complete bugfix, or coherent fix bundle is implemented and verified / 一个功能、一个完整 bugfix、或一组相关修复完成并通过验收后，再发布一个 OTA.
- Handoff-only, audit-only, and non-behavior documentation changes usually do not need an OTA, but the public docs site should stay current / 纯交接文档、审计记录、非行为性文档补充通常不发 OTA；但公开文档站仍要保持最新.
- Emergency production fixes may ship separately, but must include a clear commit subject, verification evidence, and version log updates / 紧急生产修复可以单独发 OTA，但必须包含明确提交说明、测试证据和版本日志.

## Historically Verified Capabilities

- GitHub Release artifact.
- OTA manifest.
- SHA256 verification.
- Atomic `current` / `releases` switching.
- Rollback to the previous release.
- Updating forward again after rollback.

The current public repository uses two release-evidence entry points:

```text
HANDOFF.md
docs-site/docs/release/version-log.md
```

`HANDOFF.md` preserves historical operational evidence. Root `VERSION`/`RELEASE.md` define the current target, and GitHub Releases record publication status. The generated Git version log does not establish current deployment or acceptance of new capabilities.

## Git Changelog

The documentation build automatically runs:

```bash
pnpm docs:changelog
```

It reads Git tags and commits and generates:

```text
docs-site/docs/release/version-log.md
docs-site/docs/en/release/version-log.md
```

Readable public release notes still depend on clear commit messages or GitHub Release copy.
