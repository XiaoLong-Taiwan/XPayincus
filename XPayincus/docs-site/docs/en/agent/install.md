# Agent Installation

The Agent runs on Incus hosts. It reports host resources, instance state and traffic data, and helps the panel complete delivery workflows.

## Host OS

The host install script is recommended for Ubuntu 22.04+ and Debian 12/13. Debian 11 remains best-effort compatible, but it is not recommended for new hosts. Debian 10 and earlier are rejected by the installer.

## Panel Certificate Trust

The host installer adds the panel Incus client certificate to host trust. After panel reinstall, migration, disaster recovery, or certificate rotation, stale trust can cause `not authorized`. A current HMAC-capable Agent can retrieve and authenticate the new certificate using existing node credentials; the old fingerprint is removed only after the new connection succeeds.

An older Agent without the HMAC trust endpoint cannot securely prove a new certificate to the panel. Do not automatically trust a downloaded certificate or remove old trust. Back up `/etc/incus/` and the Agent configuration, upgrade the panel to a release with the authenticated trust endpoint, then run the updated host management script on the original Incus host to update the Agent binary. Open the script again to complete authenticated trust rotation. If the old Agent cannot authenticate, generate a fresh Agent install command/one-time token for that host in the admin console and run it on the original host to pair the Agent again; then verify the host in the panel. For `AGENT_AUTH_REQUIRED` or `AGENT_SIGNATURE_INVALID`, do not bypass verification or manually trust the downloaded certificate; use the re-pairing path. This process does not automatically remove Incus containers, storage pools, or host data. Do not use uninstall/delete-data options or remove old trust until the new certificate connection is verified.

The panel certificate pair is checked on every API start. `client.crt` and `client.key` are generated only if both files are absent. A partial pair, permission error, or mismatched pair prevents API startup; restore the original pair from backup instead of deleting files to trigger regeneration.

## Release Configuration

```dotenv
INCUDAL_RELEASE_REPOSITORY=owner/unified-repository
INCUDAL_AGENT_RELEASE_REPOSITORY=
INCUDAL_AGENT_RELEASE_TAG_PREFIX=
INCUDAL_AGENT_RELEASE_TOKEN=
```

Configure these on the panel. The default repository is `XiaoLong-Taiwan/XPayincus`. A nonempty `INCUDAL_AGENT_RELEASE_REPOSITORY` takes priority over the unified source. When the tag prefix is unset, the official unified repository or a source matching the unified setting uses an empty prefix; other Agent repositories default to `agent-`. An explicitly empty prefix means `v*` tags. Compose passes both repository settings to the API; additional variables such as the prefix and token still require an override or equivalent injection.

Remote releases must include assets for both architectures. The proxy prefers the versioned Agent manifest, falling back to `manifest.json`, and validates version, size, and SHA256 for gzip or uncompressed binaries. Only a missing manifest permits fallback to both uncompressed binaries; an invalid manifest is rejected. Tags or Actions artifacts cannot replace Release assets. Downloads remain behind the panel same-origin `/api/agent/manifest.json` and `/api/agent/binary` proxy; private tokens stay on the panel. Agent, Incus, RFW, and ZFS do not run in panel Compose.

If GitHub Agent releases are unavailable, use a local release directory containing the legacy `manifest.json` and both architecture `.gz` files; manifest SHA256 values cover the compressed bytes:

```dotenv
INCUDAL_AGENT_RELEASE_DIR=/opt/incudal/agent-release
```

The Agent installer reads `https://<panel>/api/agent/manifest.json` and selects the `linux-amd64` or `linux-arm64` binary for the host. If installation fails with `agent manifest does not contain linux-amd64 binary metadata`, the installer is likely too old to parse the compact single-line JSON manifest served by the panel. Update the panel to a version that includes the Agent manifest parser fix, then copy a fresh Agent install command from the admin console.

If backend logs show the install token was consumed but the Agent remains offline, and the Nginx access log shows `/api/agent/binary/...gz?v=<timestamp>` returning HTTP 400, the old installer is using the backend-reserved `v` query parameter for binary cache busting. Update the panel to a version that includes the Agent binary download query fix, confirm the public `install.sh` uses `cache_bust` for binary URLs, then copy a fresh Agent install command from the admin console.

## Resource And Log Limits

The Agent reports every 60 seconds by default, with a 30-second minimum. Do not lower the interval to values such as 5 seconds. On hosts with many instances, each heartbeat reads host resources, running instance state and traffic counters, so high-frequency polling can increase Incus API and host CPU pressure.

The current Agent includes these protections:

- At most 500 instances are reported per heartbeat.
- Incus instance state reads are limited to concurrency 3.
- Non-running instances do not trigger extra `/state` requests.
- Successful heartbeat logs are throttled to the first entry and about one entry every 10 minutes; failed heartbeat logs are throttled to the first entry and about one entry per minute.
- The generated `incudal-agent.service` includes `CPUQuota=20%`, `MemoryMax=256M`, `TasksMax=128`, `LogRateLimitIntervalSec=30s` and `LogRateLimitBurst=120`.

If a host was installed with an older Agent, update the panel, copy a fresh Agent install command from the admin console, and run it once on the host. Binary self-upgrade alone cannot rewrite an old systemd service; rerunning the installer refreshes the binary, config and systemd resource/log limits.

## Local Build

Run from the unified repository root:

```bash
bash scripts/build-agent-release.sh
```

The product version comes from root `VERSION`; Go sources live in `XPayincus-Agent/`. The root release workflow uploads Actions artifacts only and does not create a GitHub Release. No tests, builds, or host upgrades were performed during this documentation update.
