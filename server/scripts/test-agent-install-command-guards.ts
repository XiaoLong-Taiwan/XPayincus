import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const agentRouteSource = readFileSync(resolve(__dirname, '../src/routes/agent.ts'), 'utf8')
const installScriptSource = readFileSync(resolve(__dirname, '../templates/agent-install.sh'), 'utf8')
const rfwInstallScriptSource = readFileSync(resolve(__dirname, '../templates/rfw.sh'), 'utf8')
const hostAgentCredentialsSource = readFileSync(resolve(__dirname, '../src/lib/host-agent-credentials.ts'), 'utf8')
const onlineUpdateUnitSource = readFileSync(resolve(__dirname, '../../deploy/xpayincus-online-update@.service.example'), 'utf8')
const onlineRollbackUnitSource = readFileSync(resolve(__dirname, '../../deploy/xpayincus-online-rollback@.service.example'), 'utf8')
const onlineTaskHelperSource = readFileSync(resolve(__dirname, '../../deploy/xpayincus-online-task.sh.example'), 'utf8')
const retiredReleaseRepository = 'retired-release-repository'

for (const [name, source, mode] of [
  ['update', onlineUpdateUnitSource, 'update'],
  ['rollback', onlineRollbackUnitSource, 'rollback']
] as const) {
  assert.ok(
    source.includes('User=root') &&
      source.includes(`ExecStart=/usr/local/libexec/xpayincus/xpayincus-online-task ${mode} %i`) &&
      !source.includes('/opt/xpayincus/current/server/dist/scripts/'),
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
  agentRouteSource.includes("const defaultAgentReleaseRepository = 'XiaoLong-Taiwan/XPayincus-Agent'"),
  'Agent release proxy must default to the dedicated Agent repository'
)
assert.ok(
  !agentRouteSource.includes('process.env.GITHUB_REPOSITORY'),
  'Agent release proxy must not inherit the panel repository from GitHub Actions'
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
  installScriptSource.includes('fail "XPAYINCUS_AGENT_BINARY_SHA256 is required when XPAYINCUS_AGENT_BINARY_URL is set"'),
  'Agent install script must refuse custom binary downloads without sha256'
)
assert.ok(
  installScriptSource.includes('install -o root -g root -m 0755 "${staged_caddy}" "${HELPER_DIR}/caddy-install"') &&
    installScriptSource.includes('install -o root -g root -m 0755 "${staged_rfw}" "${HELPER_DIR}/rfw-install"') &&
    installScriptSource.includes('bash -n "${staged_caddy}"') &&
    installScriptSource.includes('bash -n "${staged_rfw}"'),
  'Agent install script must syntax-check and install fixed root-owned service helpers'
)
assert.ok(
  rfwInstallScriptSource.includes('readonly RFW_VERSION="v0.1.9"') &&
    rfwInstallScriptSource.includes('RFW_SHA256_X86_64=') &&
    rfwInstallScriptSource.includes('RFW_SHA256_AARCH64=') &&
    rfwInstallScriptSource.includes('case "$1" in') &&
    rfwInstallScriptSource.includes('ExecStart=${exec_start% }') &&
    !rfwInstallScriptSource.includes('eval '),
  'RFW helper must pin artifacts, allowlist arguments, and avoid shell evaluation'
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
  installScriptSource.includes('MANIFEST_URL="$(append_query_param "${MANIFEST_URL}" "v" "${BINARY_CACHE_BUSTER}")"') &&
    installScriptSource.includes('BINARY_URL="$(append_query_param "${BINARY_URL}" "cache_bust" "${BINARY_CACHE_BUSTER}")"') &&
    !installScriptSource.includes('BINARY_URL="$(append_query_param "${BINARY_URL}" "v" "${BINARY_CACHE_BUSTER}")"'),
  'Agent install script must not use the binary proxy reserved v query parameter for cache busting'
)
assert.ok(
  installScriptSource.includes('download_binary_once "${fallback_url}" "${target}" "${expected_sha256}"'),
  'Agent install script fallback binary downloads must keep the same sha256 verification requirement'
)
assert.ok(
  installScriptSource.includes('HEARTBEAT_INTERVAL="${XPAYINCUS_HEARTBEAT_INTERVAL_SECONDS:-60}"') &&
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
assert.equal(
  (agentRouteSource.match(/signal: AbortSignal\.timeout\(agentReleaseFetchTimeoutMs\)/g) ?? []).length,
  3,
  'Agent release API, checksum, and binary fetch paths must all use the bounded timeout'
)
assert.ok(
  agentRouteSource.includes('function getLocalAgentReleaseDir') &&
    agentRouteSource.includes('XPAYINCUS_AGENT_RELEASE_DIR') &&
    agentRouteSource.includes('readLocalAgentUpgradeManifest') &&
    agentRouteSource.includes('Local Agent release binary sha256 mismatch'),
  'Agent release proxy must support a checksum-verified local release directory before falling back to GitHub releases'
)
assert.ok(
  agentRouteSource.includes('const agentBinaryNamePattern = /^xpayincus-agent-linux-(amd64|arm64)(?:\\.gz)?$/'),
  'Agent binary proxy must accept gzip local release artifacts referenced by the manifest'
)
assert.ok(
  agentRouteSource.includes("const agentReleaseBinaryNamePattern = /^xpayincus-agent-(x86_64|aarch64)-v") &&
    agentRouteSource.includes("if (!tag?.startsWith('agent-'))") &&
    agentRouteSource.includes('return `xpayincus-agent-x86_64-${version}`') &&
    agentRouteSource.includes('return `xpayincus-agent-aarch64-${version}`'),
  'Agent release proxy must preserve the external repository tag and asset naming contract'
)

assert.ok(
  hostAgentCredentialsSource.includes("const agentInstallTokenPrefix = 'ait_'") &&
    hostAgentCredentialsSource.includes('const agentInstallTokenTtlMs = 30 * 60 * 1000'),
  'Agent install tokens must use a distinct prefix and bounded 30-minute TTL'
)
assert.ok(
  hostAgentCredentialsSource.includes("return createHash('sha256').update(token).digest('hex')") &&
    hostAgentCredentialsSource.includes('tokenHash: hashAgentInstallToken(installToken)'),
  'Agent install tokens must be hashed before persistence'
)
assert.ok(
  agentRouteSource.includes("fastify.post<{ Body: AgentInstallConfigBody }>('/install-config'") &&
    installScriptSource.includes("--data-binary \"{\\\"token\\\":\\\"${install_token}\\\"}\"") &&
    !agentRouteSource.includes("'/install-config/:token'") &&
    !installScriptSource.includes('/api/agent/install-config/${install_token}'),
  'Agent install tokens must be exchanged in a request body instead of URL paths'
)
assert.ok(
  hostAgentCredentialsSource.includes('where: { id: enrollment.id, usedAt: null, expiresAt: { gte: now } }') &&
    hostAgentCredentialsSource.includes('data: { usedAt: now }') &&
    hostAgentCredentialsSource.includes('if (consumed.count !== 1)'),
  'Agent install-token consumption must be conditional on unused and unexpired state'
)
assert.ok(
  hostAgentCredentialsSource.includes('where: { installTokenHash: tokenHash }') &&
    hostAgentCredentialsSource.includes('installTokenHash: null') &&
    hostAgentCredentialsSource.includes('installTokenExpiresAt: null') &&
    hostAgentCredentialsSource.includes('installTokenUsedAt: now'),
  'legacy Agent install-token consumption must remain conditional and clear the token hash'
)
assert.ok(
  hostAgentCredentialsSource.includes('HOST_AGENT_CREDENTIAL_LOCK_NAMESPACE') &&
    hostAgentCredentialsSource.includes('await advisoryTransactionLock(transaction, HOST_AGENT_CREDENTIAL_LOCK_NAMESPACE, hostId)') &&
    hostAgentCredentialsSource.includes('await advisoryTransactionLock(transaction, HOST_AGENT_CREDENTIAL_LOCK_NAMESPACE, enrollmentHost.hostId)'),
  'Agent credential rotation, token issuance, and enrollment exchange must serialize per host'
)
assert.ok(
  hostAgentCredentialsSource.includes('where: { hostId, usedAt: null }') &&
    hostAgentCredentialsSource.includes('where: { hostId, installTokenHash: { not: null } }'),
  'Agent token issuance and credential rotation must revoke outstanding enrollment tokens'
)
assert.ok(
  agentRouteSource.includes('agent: result.agent ? await serializeAgent(result.agent) : null'),
  'admin Agent install-command must support hosts without an existing Agent record'
)
assert.ok(
  hostAgentCredentialsSource.includes("throw new Error('AGENT_ID_ALREADY_REGISTERED')") &&
    agentRouteSource.includes("code: 'AGENT_ID_ALREADY_REGISTERED'"),
  'Agent enrollment must return a stable conflict contract for duplicate Agent IDs'
)

console.log('agent install command guard tests passed')
