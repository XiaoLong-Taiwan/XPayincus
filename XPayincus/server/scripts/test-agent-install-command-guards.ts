import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const agentRouteSource = readFileSync(resolve(__dirname, '../src/routes/agent.ts'), 'utf8')
const installScriptSource = readFileSync(resolve(__dirname, '../templates/agent-install.sh'), 'utf8')
const hostAgentCredentialsSource = readFileSync(resolve(__dirname, '../src/lib/host-agent-credentials.ts'), 'utf8')
const agentBuildReleaseScriptSource = readFileSync(resolve(__dirname, '../../../XPayincus-Agent/scripts/build-release.sh'), 'utf8')
const agentReleaseWorkflowSource = readFileSync(resolve(__dirname, '../../../XPayincus-Agent/.github/workflows/agent-release.yml'), 'utf8')
const onlineUpdateUnitSource = readFileSync(resolve(__dirname, '../../deploy/incudal-online-update@.service.example'), 'utf8')
const onlineRollbackUnitSource = readFileSync(resolve(__dirname, '../../deploy/incudal-online-rollback@.service.example'), 'utf8')
const onlineTaskHelperSource = readFileSync(resolve(__dirname, '../../deploy/incudal-online-task.sh.example'), 'utf8')
const retiredReleaseRepository = 'retired-release-repository'

for (const [name, source, mode] of [
  ['update', onlineUpdateUnitSource, 'update'],
  ['rollback', onlineRollbackUnitSource, 'rollback']
] as const) {
  assert.ok(
    source.includes('User=root') &&
      source.includes(`ExecStart=/usr/local/libexec/incudal/incudal-online-task ${mode} %i`) &&
      !source.includes('/opt/incudal/current/server/dist/scripts/'),
    `root ${name} unit must enter through the fixed root-owned helper`
  )
}
assert.ok(
  onlineTaskHelperSource.includes('verify_manifest') &&
    onlineTaskHelperSource.includes('release file set or digest differs from trusted manifest') &&
    onlineTaskHelperSource.includes('release integrity verification failed'),
  'root OTA helper must verify the sealed release manifest before executing a worker'
)

assert.ok(
  agentRouteSource.includes("const defaultAgentReleaseRepository = 'XiaoLong-Taiwan/XPayincus'"),
  'Agent release proxy must default to the current repository'
)
assert.ok(
  agentRouteSource.includes('configured || process.env.INCUDAL_RELEASE_REPOSITORY?.trim() || defaultAgentReleaseRepository') &&
    agentRouteSource.includes('process.env.INCUDAL_AGENT_RELEASE_TAG_PREFIX') &&
    agentRouteSource.includes("? '' : 'agent-'") &&
    agentRouteSource.includes('const version = tag.slice(prefix.length)') &&
    agentRouteSource.includes('getAgentReleaseAssetUrl(getAgentReleaseTag(validated.version), assetName)') &&
    agentRouteSource.includes('loadRemoteAgentRelease(input.version)') &&
    !agentRouteSource.includes('getAgentReleaseAssetUrl(`agent-${'),
  'Agent release listing and exact downloads must share configurable tag prefixes while preserving the legacy repository override'
)
assert.ok(
  agentRouteSource.includes("['amd64', 'arm64'].every(arch =>") &&
    agentRouteSource.includes('asset.name === `xpayincus-agent-${version}-linux-${arch}`') &&
    installScriptSource.includes('MANIFEST_URL="${INCUDAL_AGENT_MANIFEST_URL:-${PANEL_BASE_URL}/api/agent/manifest.json}"') &&
    installScriptSource.includes('DEFAULT_BINARY_BASE_URL="${PANEL_BASE_URL}/api/agent/binary"'),
  'Unified releases must include both raw Agent binaries and installers must keep using the panel proxy'
)
assert.ok(
  !agentRouteSource.includes(retiredReleaseRepository),
  'Agent release proxy must not default to the retired repository'
)
assert.ok(
  agentRouteSource.includes('const maxAgentInstallUrlLength = 2048'),
  'Agent install URL inputs must be bounded before command generation'
)
assert.ok(
  agentRouteSource.includes('function normalizeAgentBinaryUrl'),
  'Agent custom binary URLs must be normalized and protocol validated'
)
assert.ok(
  agentRouteSource.includes("parsed.protocol !== 'http:' && parsed.protocol !== 'https:'"),
  'Agent install URLs must reject non-HTTP(S) protocols'
)
assert.ok(
  agentRouteSource.includes("code: 'INVALID_AGENT_BASE_URL'"),
  'admin Agent install-command must reject invalid explicit baseUrl instead of silently falling back'
)
assert.ok(
  agentRouteSource.includes("code: 'INVALID_AGENT_BINARY_URL'"),
  'admin Agent install-command must reject invalid custom binaryUrl'
)
assert.ok(
  agentRouteSource.includes('if (binaryUrl && !isSha256(request.body.binarySha256))'),
  'admin Agent install-command must require sha256 only for a validated custom binary URL'
)
assert.ok(
  agentRouteSource.includes('binaryUrl,'),
  'Agent install command must use the normalized custom binary URL'
)
assert.ok(
  installScriptSource.includes('fail "INCUDAL_AGENT_BINARY_SHA256 is required when INCUDAL_AGENT_BINARY_URL is set"'),
  'Agent install script must refuse custom binary downloads without sha256'
)
assert.ok(
  installScriptSource.includes('verify_sha256 "${target}.download" "${expected_sha256}"'),
  'Agent install script must verify custom and manifest binary checksums before install'
)
assert.ok(
  /manifest_value\(\)[\s\S]*compact="\$\(tr -d '\\n\\r' < "\$\{manifest_path\}"\)"[\s\S]*sed -nE[\s\S]*\$\{platform\}[\s\S]*\$\{key\}/.test(installScriptSource),
  'Agent install script must parse compact single-line Agent manifests served by the panel'
)
assert.ok(
  installScriptSource.includes('MANIFEST_URL="$(append_query_param "${MANIFEST_URL}" "cache_bust" "${BINARY_CACHE_BUSTER}")"') &&
    installScriptSource.includes('BINARY_URL="$(append_query_param "${BINARY_URL}" "cache_bust" "${BINARY_CACHE_BUSTER}")"') &&
    !installScriptSource.includes('BINARY_URL="$(append_query_param "${BINARY_URL}" "v" "${BINARY_CACHE_BUSTER}")"'),
  'Agent install script must not use the binary proxy reserved v query parameter for cache busting'
)
assert.ok(
  installScriptSource.includes('download_binary_once "${fallback_url}" "${target}" "${expected_sha256}"'),
  'Agent install script fallback binary downloads must keep the same sha256 verification requirement'
)
assert.ok(
  installScriptSource.includes('HEARTBEAT_INTERVAL="${INCUDAL_HEARTBEAT_INTERVAL_SECONDS:-60}"') &&
    installScriptSource.includes('normalize_heartbeat_interval') &&
    installScriptSource.includes('[ "${value}" -ge 30 ]') &&
    installScriptSource.includes('CPUQuota=20%') &&
    installScriptSource.includes('MemoryMax=256M') &&
    installScriptSource.includes('TasksMax=128') &&
    installScriptSource.includes('LogRateLimitIntervalSec=30s') &&
    installScriptSource.includes('LogRateLimitBurst=120'),
  'Agent install script must install conservative heartbeat defaults plus systemd CPU, memory, task, and journal rate limits'
)
assert.ok(
  agentRouteSource.includes('interface AgentBinaryQuery') &&
    agentRouteSource.includes('Querystring: AgentBinaryQuery'),
  'Agent binary proxy must type and read version/checksum query parameters'
)
assert.ok(
  agentRouteSource.includes('function normalizeAgentBinaryVersion') &&
    agentRouteSource.includes("code: 'AGENT_BINARY_QUERY_INCOMPLETE'"),
  'Agent binary proxy must reject incomplete or malformed version/checksum query parameters'
)
assert.ok(
  agentRouteSource.includes('const requestedVersion = typeof request.query?.v') &&
    agentRouteSource.includes('const requestedSha256 = typeof request.query?.sha256'),
  'Agent binary proxy must honor the version and sha256 carried by upgrade URLs'
)
assert.ok(
  agentRouteSource.includes('expectedSha256 = file.sha256.toLowerCase()') &&
    agentRouteSource.includes('expectedSha256'),
  'Agent binary proxy must only fall back to latest manifest sha256 when no exact query is supplied'
)
assert.ok(
  agentRouteSource.includes('const agentReleaseFetchTimeoutMs = 15 * 1000'),
  'Agent release GitHub requests must use a bounded timeout'
)
assert.ok(
  !agentRouteSource.includes('await fetch(') &&
    agentRouteSource.includes('async function readAgentReleaseResponse') &&
    agentRouteSource.includes('accept, agentReleaseFetchTimeoutMs)') &&
    agentRouteSource.includes('cache.ensure') && agentRouteSource.includes('cache.binary'),
  'Agent release API, checksum, manifest and binary downloads must use trusted redirects and bounded timeouts with persistent caching'
)
assert.ok(
  agentRouteSource.includes('function getLocalAgentReleaseDir') &&
    agentRouteSource.includes('INCUDAL_AGENT_RELEASE_DIR') &&
    agentRouteSource.includes('readLocalAgentUpgradeManifest') &&
    agentRouteSource.includes('Local Agent release binary sha256 mismatch'),
  'Agent release proxy must support a checksum-verified local release directory before falling back to GitHub releases'
)
assert.ok(
  agentRouteSource.includes('const agentBinaryNamePattern = /^xpayincus-agent-v[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?-linux-(amd64|arm64)(?:\\.gz)?$/'),
  'Agent binary proxy must accept gzip local release artifacts referenced by the manifest'
)
assert.ok(
  agentBuildReleaseScriptSource.includes('build_one amd64') &&
    agentBuildReleaseScriptSource.includes('build_one arm64') &&
    agentBuildReleaseScriptSource.includes('xpayincus-agent-${VERSION}-linux-amd64') &&
    agentBuildReleaseScriptSource.includes('xpayincus-agent-${VERSION}-linux-arm64'),
  'Agent release build script must produce linux-amd64 and linux-arm64 binaries'
)
assert.ok(
  agentReleaseWorkflowSource.includes('cp "dist/xpayincus-agent-${VERSION}-linux-amd64" "release/xpayincus-agent-${VERSION}-linux-amd64"') &&
    agentReleaseWorkflowSource.includes('cp "dist/xpayincus-agent-${VERSION}-linux-arm64" "release/xpayincus-agent-${VERSION}-linux-arm64"'),
  'Agent release workflow must rename local build outputs to the release asset names expected by the panel proxy'
)
assert.ok(
  agentReleaseWorkflowSource.includes('tag_name: agent-${{ needs.version.outputs.version }}') &&
    agentReleaseWorkflowSource.includes('agent-release/xpayincus-agent-${{ needs.version.outputs.version }}-linux-amd64') &&
    agentReleaseWorkflowSource.includes('agent-release/xpayincus-agent-${{ needs.version.outputs.version }}-linux-arm64'),
  'Agent release workflow must publish agent-v* releases with both expected architecture assets'
)

assert.ok(
  hostAgentCredentialsSource.includes("const agentInstallTokenPrefix = 'ait_'") &&
    hostAgentCredentialsSource.includes('const agentInstallTokenTtlMs = 30 * 60 * 1000'),
  'Agent install tokens must use a distinct prefix and bounded 30-minute TTL'
)
assert.ok(
  hostAgentCredentialsSource.includes("return createHash('sha256').update(token).digest('hex')") &&
    hostAgentCredentialsSource.includes('installTokenHash: hashAgentInstallToken(installToken)'),
  'Agent install tokens must be hashed before persistence'
)
assert.ok(
  hostAgentCredentialsSource.includes('where: { installTokenHash: tokenHash }') &&
    hostAgentCredentialsSource.includes('installTokenUsedAt: null') &&
    hostAgentCredentialsSource.includes('installTokenExpiresAt: { gte: new Date() }') &&
    hostAgentCredentialsSource.includes('if (updated.count !== 1)'),
  'Agent install-token consumption must be conditional on unused and unexpired state'
)
assert.ok(
  hostAgentCredentialsSource.includes('installTokenHash: null') &&
    hostAgentCredentialsSource.includes('installTokenExpiresAt: null') &&
    hostAgentCredentialsSource.includes('installTokenUsedAt: new Date()'),
  'Agent install-token consumption must clear the token hash and mark used-at'
)

assert.ok(
  installScriptSource.includes('validate_credentials()') &&
    installScriptSource.includes('^agt_[A-Za-z0-9_-]{24,64}$') &&
    installScriptSource.includes('^ias_[A-Za-z0-9_-]{32,96}$') &&
    installScriptSource.indexOf('\n  validate_credentials\n') < installScriptSource.indexOf('\ndownload_binary "${BINARY_URL}"') &&
    installScriptSource.slice(installScriptSource.indexOf('\nfetch_agent_install_config\n'), installScriptSource.indexOf('[步骤 3/4] 暂存 Agent 配置与服务')).includes('validate_credentials'),
  'static credentials must reject YAML injection before downloading and exchanged credentials must validate before writing config'
)
assert.ok(
  installScriptSource.includes('--panel-url|--token-file|--binary|--sha256') &&
    installScriptSource.includes('IFS= read -r -s "${name}" </dev/tty') &&
    installScriptSource.includes("printf '  %s' \"${label}\" >/dev/tty") &&
    installScriptSource.includes('set +x'),
  'Agent standalone installer must accept independent URL and protected TOKEN input without tracing secrets'
)
assert.ok(
  installScriptSource.includes('install -m 0600 -o root -g root "${CONFIG_FILE}" "${STAGED_CONFIG}"') &&
    installScriptSource.includes('--reinstall cannot be combined with new credentials or panel URL'),
  'Agent reinstall must preserve config and reject credential replacement'
)
assert.ok(
  installScriptSource.includes('BINARY_LOCAL_SHA256="$(sha256_file "${LOCAL_BINARY}")"') &&
    installScriptSource.indexOf('download_binary "${BINARY_URL}"') < installScriptSource.indexOf('\nfetch_agent_install_config\n'),
  'Local compiled binaries must share checksum staging before TOKEN consumption'
)
assert.ok(
  installScriptSource.includes('--retry 2 --retry-delay 2 --retry-max-time 360') &&
    installScriptSource.includes('--config - -o "${INSTALL_CONFIG_PATH}" 2>/dev/null') &&
    !installScriptSource.includes('. "${INSTALL_CONFIG_PATH}"'),
  'Public downloads must have bounded retries; TOKEN exchange must hide its URL and never execute the response'
)
assert.ok(
  /'\/install-config\/:token', \{\s*logLevel: 'silent'/.test(agentRouteSource),
  'Agent TOKEN exchange must suppress request URL logging while retaining the separate audit record'
)

const commandBuilder = agentRouteSource.slice(agentRouteSource.indexOf('function buildAgentInstallCommand('), agentRouteSource.indexOf('function buildAgentInstallConfig('))
assert.ok(!commandBuilder.includes('installToken') && !commandBuilder.includes('INSTALL_TOKEN'), 'generic command must not contain TOKEN values')
const buildCommand = new Function('input', 'shellEscape', commandBuilder.slice(commandBuilder.indexOf('  const envParts'), commandBuilder.lastIndexOf('}'))) as (input: object, escape: (value: string) => string) => string
const escapeShell = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`
assert.equal(buildCommand({ panelUrl: 'https://panel.example.org' }, escapeShell), "curl -fsSL 'https://panel.example.org/api/agent/install.sh' | sudo env INCUDAL_PANEL_URL='https://panel.example.org' bash")
assert.ok(buildCommand({ panelUrl: 'https://panel.example.org', binaryUrl: 'https://binary.example.org/agent', binarySha256: 'a'.repeat(64) }, escapeShell).includes("INCUDAL_AGENT_BINARY_SHA256='" + 'a'.repeat(64) + "'"), 'custom binaries must retain their checksum without embedding TOKEN')
assert.equal((agentRouteSource.match(/\n      panelUrl,\n      agent:/g) ?? []).length, 2, 'both Agent install responses must include panelUrl')
assert.ok(installScriptSource.indexOf('\nconfirm_plan\n') < installScriptSource.indexOf('\npreflight_environment\n'), 'summary confirmation must precede host mutations')
assert.ok(installScriptSource.includes('--prepare-agent-host') && installScriptSource.includes('--refresh-agent-trust'), 'ait TOKEN flow must initialize the host and authenticate Incus trust')
assert.ok(installScriptSource.includes('api/hosts/install.sh/%s') && installScriptSource.includes('unset INCUDAL_AGENT_INSTALL_TOKEN'), 'UUID must delegate to host initialization without leaking TOKEN into nested Agent install')
const pythonBootstrap = installScriptSource.indexOf('apt-get install -y -qq python3')
assert.ok(pythonBootstrap > installScriptSource.indexOf('\nconfirm_plan\n') && pythonBootstrap < installScriptSource.indexOf('MANIFEST_SELECTION="$(select_manifest)"'), 'missing Python must bootstrap after confirmation and before manifest validation')
assert.match(installScriptSource, /if \[ "\$\{REINSTALL\}" != 1 \][^\n]*\[\[ "\$\{INCUDAL_AGENT_INSTALL_TOKEN:-\}" == ait_\* \]\]; then\n  prepare_host_script/, 'static credential updates must never enter host preparation')

console.log('agent install command guard tests passed')
