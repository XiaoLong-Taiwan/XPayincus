# Admin OTA

The admin console includes a version update page for controlled online updates. It shows the current version, latest release tag, release notes, OTA artifact metadata, update tasks, task logs and rollback controls.

Admin page:

```text
https://admin.example.com/admin/system-update
```

## Unified Repository and Deployment Scope

This OTA flow applies to host systemd/sudo deployments, **not panel Compose**. For Compose, export PostgreSQL with `XPayincus/deploy/compose/panel.sh export`, select the source revision, then rebuild with `panel.sh up`. Import requires a trusted archive and `--confirm-replace-incudal`; the panel stays stopped after either success or failure until manually started. DB archives exclude secrets, environment files, Incus certificates, and instance data.

Root `VERSION` defines the unified product release. Root `.github/workflows/release.yml` uploads Actions artifacts only. Publish the actual panel tarballs, hashes, and `ota-manifest.json` to the configured GitHub Release before using remote artifact OTA. The multi-component `release-manifest.json` must not replace the panel-only OTA manifest.

Panel sources now live under `XPayincus/`. The legacy Git updater assumes the source root is the panel root, so Git mode and `auto` fallback cannot be assumed compatible with unified repository tags. Prefer a published panel artifact and verify updater compatibility in isolation. Commands using `scripts/...` below run from the panel working directory or a deployed panel release.

Rollback switches code directories; it **does not reverse database migrations**. Database recovery needs a separate controlled restore with exactly one API writer. Historical release notes are not current verification evidence. No OTA, backup/restore, build, or deployment was performed during this documentation update.

## Recommended Mode

```dotenv
SYSTEM_UPDATE_APPLY_MODE=auto
SYSTEM_UPDATE_RELEASE_REPOSITORY=owner/unified-repository
```

`auto` prefers verified GitHub Release OTA artifacts. If no matching artifact exists for the target tag, it can fall back to Git tag build mode.

The page checks the latest release tag when it opens. If the current deployment is already on the latest tag, the latest version remains visible and the primary action changes to "Updated to latest version". Update tasks are capped at 7 rows per page, with pagination for older tasks and a dedicated log panel for the selected task.

| Mode | Behavior |
| --- | --- |
| `auto` | Prefer artifact, fall back to Git build |
| `artifact` | Only use verified OTA artifacts |
| `git` | Checkout the tag and build on the server |

## Artifact Flow

1. Read `ota-manifest.json` from GitHub Release.
2. Select the artifact for the current Linux architecture.
3. Clean the old `.incudal-update-downloads` cache.
4. Run the disk-space preflight.
5. Download the artifact to the managed cache directory.
6. Verify size and SHA256.
7. Extract to staging.
8. Create a new atomic release under `/opt/incudal/releases`.
9. Run Prisma migrations.
10. Restart the backend and wait for `/api/health`.
11. Run split host and production verification scripts.
12. Clean the download cache and prune old releases after a successful update.

## Atomic Layout

```text
/opt/incudal/current -> /opt/incudal/releases/<version-timestamp>
/opt/incudal/releases/v0.0.10-...
/opt/incudal/releases/v0.0.11-...
```

Rollback switches the `current` symlink back to the previous release, restarts the backend and reruns verification.

After a successful update, old releases are pruned automatically. The cleanup protects:

- The release currently targeted by `current`.
- The current update task `backupPath`.
- Recent successful or rolled-back update task `backupPath` values.

Unprotected releases keep the newest 8 directories by default. Older directories are removed.

## Disk and Retention

Recommended production variables:

```dotenv
SYSTEM_UPDATE_MIN_FREE_MB=4096
SYSTEM_UPDATE_RELEASES_KEEP=8
SYSTEM_UPDATE_BACKUP_TASKS_KEEP=3
```

| Variable | Default | Description |
| --- | ---: | --- |
| `SYSTEM_UPDATE_MIN_FREE_MB` | `4096` | Minimum free disk space before an update, in MB. Artifact mode also reserves extra space based on the package size. |
| `SYSTEM_UPDATE_RELEASES_KEEP` | `8` | Number of unprotected old releases to keep in atomic layout. |
| `SYSTEM_UPDATE_BACKUP_TASKS_KEEP` | `3` | Number of recent successful or rolled-back update task `backupPath` values to protect for rollback. |

When disk space is insufficient, the update fails before download or migration and writes an actionable Chinese message to the task log. Typical remediation:

- Clean `/opt/incudal/.incudal-update-downloads`.
- Check `/opt/incudal/releases` for obsolete releases.
- Expand the system disk and retry the OTA.

## Notes

- Admin users can view the current version, latest release tag and OTA package status.
- Only super administrators can start updates and rollbacks.
- Update APIs stay under `/api/admin/system-update/*`.
- The user portal does not include update controls or update APIs.
- Updates and rollbacks preserve `.env`, `server/certs`, `agent-release`, `.npm` and `.cache`.
