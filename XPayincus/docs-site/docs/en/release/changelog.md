# Release Notes

Release documentation has two layers:

- This page: manually maintained release strategy, OTA capability and production verification notes.
- [System Version Log](/en/release/version-log): automatically generated from Git tags and commits.

Root `VERSION` and `RELEASE.md` define the unified release. v1.0.11 has been officially released; the current source targets **v1.0.12 (unreleased)**. Historical OTA proof does not validate this release.

## v1.0.12 New Capabilities

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
- Patch numbers are not limited to one digit: this cycle advances from released `v1.0.11` to `v1.0.12`.
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
