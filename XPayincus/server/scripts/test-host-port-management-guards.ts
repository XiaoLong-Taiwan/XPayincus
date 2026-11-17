import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import ts from 'typescript'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const routeSource = readFileSync(resolve(__dirname, '../src/routes/host-ports.ts'), 'utf8')
const instanceSource = readFileSync(resolve(__dirname, '../src/routes/instances.ts'), 'utf8')
const tabSource = readFileSync(resolve(__dirname, '../../client/src/components/host/HostPortsTab.vue'), 'utf8')
const instancesTabSource = readFileSync(resolve(__dirname, '../../client/src/components/host/HostInstancesTab.vue'), 'utf8')
const adminApiSource = readFileSync(resolve(__dirname, '../../client/src/api/admin.ts'), 'utf8')

assert.ok(routeSource.includes("request.user.role !== 'admin'"), 'host port listing must be admin-only')
assert.ok(routeSource.includes("source: 'managed-mappings'"), 'host port listing must identify managed mappings')
assert.ok(routeSource.includes("listenerCoverage: 'unavailable'"), 'host port listing must not claim complete listener coverage')
assert.ok(routeSource.includes("addressFamilies: deviceFamilies.get(mapping.id) || ['unknown']"), 'unreadable mapping listener data must be unknown')
assert.ok(routeSource.includes('deviceFamilies.set(mapping.id, resolveAddressFamilies(matchingListeners))'), 'listener families must be indexed per mapping')
assert.ok(routeSource.includes('parsed.protocol === mapping.protocol && parsed.port === mapping.publicPort'), 'listeners must match both mapping protocol and public port')
assert.ok(!routeSource.includes('deviceFamilies.set(instanceId,'), 'instances must not merge listener families across mappings')
assert.ok(routeSource.includes("remote.type === 'container' || remote.type === 'virtual-machine'"), 'host port listing must preserve Incus instance type')
assert.ok(instanceSource.includes('if (mapping.system_managed)') && instanceSource.includes('apiError(ErrorCode.FORBIDDEN)'), 'system-managed mappings must not be removable')
assert.ok(tabSource.includes('api.instances.deletePort(mapping.instanceId, mapping.id)'), 'host port removal must reuse instance port deletion API')
assert.ok(tabSource.includes('String(props.hostId)'), 'host port instance links must retain host context')
assert.ok(instancesTabSource.includes('adminInstanceDetailPath') && instancesTabSource.includes("authStore.user?.role === 'admin'"), 'admin host instance entry must use admin instance route')
assert.ok(adminApiSource.includes("getPorts: (id: number)"), 'admin client must expose host port listing API')

const fixtureSource = routeSource.replace(/^import .*\r?\n/gm, '').replace('export default async function', 'async function')
const fixtureCode = ts.transpileModule(fixtureSource, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
type MappingResult = { id: number; addressFamilies: string[]; instanceType: string }
type PortResponse = { readFailures: number; mappings: MappingResult[] }
let handler: (request: unknown, reply: unknown) => Promise<PortResponse>
let instanceReads = 0
const fixtureInstance = { id: 9, name: 'fixture', incusId: 'fixture', status: 'running', networkMode: 'nat' }
const fixtureMappings = [
  { id: 1, instanceId: 9, protocol: 'tcp', publicPort: 10000, instance: fixtureInstance },
  { id: 2, instanceId: 9, protocol: 'udp', publicPort: 10000, instance: fixtureInstance },
  { id: 3, instanceId: 9, protocol: 'tcp', publicPort: 10001, instance: fixtureInstance },
  { id: 4, instanceId: 9, protocol: 'tcp', publicPort: 10002, instance: fixtureInstance }
]
const register = new Function('db', 'prisma', 'getIncusClient', 'getInstance', 'apiError', 'ErrorCode', `${fixtureCode}; return hostPortRoutes`)(
  { getHostById: async () => ({ id: 7, status: 'online' }) },
  { portMapping: { findMany: async () => fixtureMappings } },
  async () => ({}),
  async () => {
    instanceReads++
    return { type: 'virtual-machine', expanded_devices: {
      tcp4: { type: 'proxy', listen: 'tcp:0.0.0.0:10000' },
      udp6: { type: 'proxy', listen: 'udp:[::]:10000' },
      dual4: { type: 'proxy', listen: 'tcp:0.0.0.0:10001' },
      dual6: { type: 'proxy', listen: 'tcp:[::]:10001' }
    } }
  }, () => ({}), {})
await register({ authenticate() {}, get(_path: string, _options: unknown, callback: typeof handler) { handler = callback } })
const response = await handler!({ user: { role: 'admin' }, params: { id: '7' } }, {})
assert.equal(instanceReads, 1)
assert.equal(response.readFailures, 0)
assert.deepEqual(response.mappings.map(mapping => mapping.addressFamilies), [['ipv4'], ['ipv6'], ['ipv4', 'ipv6'], ['unknown']])
assert.ok(response.mappings.every(mapping => mapping.instanceType === 'virtual-machine'))

console.log('host port management guard tests passed')
