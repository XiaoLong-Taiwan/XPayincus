import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import strictAssert from 'node:assert/strict'
import ts from 'typescript'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const hostsRoute = readFileSync(resolve(root, 'server/src/routes/hosts.ts'), 'utf8')
const agentRoute = readFileSync(resolve(root, 'server/src/routes/agent.ts'), 'utf8')
const createView = readFileSync(resolve(root, 'client/src/views/resources/MyHostCreateView.vue'), 'utf8')
const agentReport = readFileSync(resolve(root, '../XPayincus-Agent/internal/report/report.go'), 'utf8')

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

assert(hostsRoute.includes("required: ['name']"), 'Host creation must require only a name')
assert(hostsRoute.includes('issueHostAgentInstallToken(hostId)'), 'Agent onboarding must issue a one-time Agent token')
assert(hostsRoute.includes('const normalizedHostUrl = url || `agent://${randomUUID()}`'), 'Agent-only hosts must receive a stable agent URI')
assert(hostsRoute.includes('url: normalizedHostUrl'), 'Agent onboarding must return the agent URI')
assert(hostsRoute.includes('prepareHostAddressSnapshotForWrite(normalizedHostUrl) : null'), 'Agent onboarding must not resolve/register a public URL')
assert(agentRoute.includes('hostReport.routedIpv6 === true') && agentRoute.includes('hostReport.ipv6Prefixes.find'), 'Routed IPv6 must require an explicit capability and prefix')
assert(agentRoute.includes('currentHost?.ipv6Mode === 3 && !currentHost.ipv6Subnet && typeof routedIpv6 === \'string\'') && agentRoute.includes('ipv6Mode: 1, ipv6Subnet: routedIpv6.trim()'), 'IPv6 must only enable routed mode when an explicit prefix is reported')
assert(agentRoute.includes('isIP(address.address) > 0'), 'Reported host addresses must be valid IP literals')
assert(agentRoute.includes('prisma.storagePool.upsert'), 'Reported Incus pools must be persisted')
assert(createView.includes('api.hosts.getAgentStatus') && !createView.includes('api.hosts.verify('), 'Create flow must verify Agent heartbeat rather than direct Incus connectivity')
assert(!createView.includes('hostAddress') && !createView.includes('apiPort'), 'Create flow must not request host address or API port')
assert(agentReport.includes('"ipv6Prefixes":  ipv6Prefixes') && agentReport.includes('collectIncusStoragePools()'), 'Agent host report must include routeable IPv6 prefixes and detected Incus pools')
assert(!agentReport.includes('ip.String()+"/64"'), 'Agent must never invent a prefix length for a single IPv6 address')

const hostUpdateStart = agentRoute.indexOf('const hostUpdates: Prisma.HostUpdateInput = {')
const hostUpdateEnd = agentRoute.indexOf('let acceptedSampleIds:', hostUpdateStart)
const hostUpdate = agentRoute.slice(hostUpdateStart, hostUpdateEnd)
assert(hostUpdateStart >= 0 && hostUpdateEnd > hostUpdateStart, 'Heartbeat host update must exist')
assert(!hostUpdate.slice(0, hostUpdate.indexOf('await prisma.host.update(')).includes("status: 'online'"), 'Unconditional host updates must never change maintenance status')
assert(hostUpdate.includes('await prisma.host.updateMany({') && hostUpdate.includes("where: { id: agent.hostId, status: { in: ['online', 'offline'] } }"), 'Heartbeat status writes must atomically reject maintenance at write time')
assert(agentRoute.includes("storagePools: { where: { purpose: 'instance_data' }") && agentRoute.includes('value.name === systemPoolName'), 'Capacity must use the configured system pool rather than sum unrelated pools')
assert(!agentRoute.includes('poolReports.reduce('), 'Pool capacities must not be summed across shared backing storage')
assert(agentRoute.includes("['arm64', 'aarch64'].includes(architecture) ? 'aarch64'") && agentRoute.includes('reportedRuntime.goarch'), 'ARM architecture reports must be normalized with runtime fallback')
assert(hostUpdate.includes('...(normalizedArchitecture ? { architecture: normalizedArchitecture } : {})'), 'Unknown architecture must not overwrite persisted architecture')
assert(agentReport.includes('"architecture": runtime.GOARCH'), 'Agent must explicitly report host architecture')
assert(agentReport.includes('url.PathEscape(pool.Name)+"/resources"'), 'Agent must request each pool resource endpoint')
const urlUpdateStart = hostsRoute.indexOf('if (updates.url !== undefined) {', hostsRoute.indexOf('trafficResetDay?:'))
const urlUpdateEnd = hostsRoute.indexOf('await persistHostAddressSnapshot(hostId, lockedSnapshot', urlUpdateStart)
assert(urlUpdateStart >= 0 && urlUpdateEnd > urlUpdateStart && hostsRoute.slice(urlUpdateStart, urlUpdateEnd).includes('trafficResetDay: updates.trafficResetDay'), 'URL-bearing host updates must persist traffic reset day')

const heartbeatStart = agentRoute.indexOf('const hostReport = isRecord(request.body.host)')
const heartbeatEnd = agentRoute.indexOf('let acceptedSampleIds:', heartbeatStart)
assert(heartbeatStart >= 0 && heartbeatEnd > heartbeatStart, 'Heartbeat fixture section must exist')
const heartbeatCode = ts.transpileModule(agentRoute.slice(heartbeatStart, heartbeatEnd), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 }
}).outputText
assert(!agentRoute.slice(hostUpdateStart, hostUpdateEnd).includes('isInstalled: true'), 'Agent heartbeat must not mark a host as panel-verified')
const heartbeatFixture = new Function('prisma', 'request', 'agent', 'isRecord', 'finitePositiveNumber', 'isIP', 'isPublicIpv4', 'isRoutedIpv6Prefix', `return (async () => { ${heartbeatCode} })()`)
for (const scenario of [
  { status: 'maintenance', race: false, pool: 'default', capacity: 0, hostArch: 'arm64', runtimeArch: 'amd64', expectedArch: 'aarch64', expectedCapacity: 100 },
  { status: 'offline', race: true, pool: 'system', capacity: 0, hostArch: 'aarch64', runtimeArch: 'amd64', expectedArch: 'aarch64', expectedCapacity: 200 },
  { status: 'offline', race: false, pool: 'system', capacity: 42, hostArch: undefined, runtimeArch: 'arm64', expectedArch: 'aarch64', expectedCapacity: 42 },
  { status: 'online', race: false, pool: undefined, capacity: 0, hostArch: 'unknown', runtimeArch: 'unknown', expectedArch: 'existing', expectedCapacity: 0 },
  { status: 'offline', race: false, pool: 'missing', capacity: 0, hostArch: 'amd64', runtimeArch: 'arm64', expectedArch: 'x86_64', expectedCapacity: 0 }
]) {
  const state: Record<string, unknown> = { status: scenario.status, storageSize: scenario.capacity, architecture: 'existing' }
  const fixturePrisma = {
    storagePool: { upsert: async () => ({}) },
    host: {
      findUnique: async () => {
        if (scenario.race) state.status = 'maintenance'
        return { cpuAllowanceMax: 100, memoryMax: 1024, storageSize: scenario.capacity, ipv6Mode: 1, storagePools: scenario.pool ? [{ name: scenario.pool }] : [] }
      },
      update: async ({ data }: { data: Record<string, unknown> }) => { Object.assign(state, data) },
      updateMany: async ({ where, data }: { where: { status: { in: string[] } }; data: Record<string, unknown> }) => {
        strictAssert.deepEqual(where.status.in, ['online', 'offline'])
        if (!where.status.in.includes(String(state.status))) return { count: 0 }
        Object.assign(state, data)
        return { count: 1 }
      }
    }
  }
  const body = {
    runtime: { goarch: scenario.runtimeArch },
    host: { architecture: scenario.hostArch, storagePools: [
      { name: 'default', driver: 'zfs', space: { total: 100 * 1024 ** 3 } },
      { name: 'system', driver: 'zfs', space: { total: 200 * 1024 ** 3 } },
      { name: 'data', driver: 'dir', space: { total: 1000 * 1024 ** 3 } }
    ] }
  }
  await heartbeatFixture(fixturePrisma, { body }, { hostId: 7 },
    (value: unknown) => typeof value === 'object' && value !== null && !Array.isArray(value),
    (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null,
    () => 0, () => false, () => false)
  strictAssert.equal(state.status, scenario.status === 'maintenance' || scenario.race ? 'maintenance' : 'online')
  strictAssert.equal(state.storageSize, scenario.expectedCapacity)
  strictAssert.equal(state.architecture, scenario.expectedArch)
}

console.log('host Agent onboarding guard checks passed')
