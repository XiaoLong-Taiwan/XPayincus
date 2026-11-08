import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import Fastify from 'fastify'
import rateLimit from '@fastify/rate-limit'
import dns from 'node:dns/promises'
import { syncBuiltinESMExports } from 'node:module'
process.env.DATABASE_URL ||= 'postgresql://test:test@127.0.0.1:5432/test'
let addresses = [{ address: '8.8.8.8', family: 4 }]
const originalLookup = dns.lookup
dns.lookup = (async () => addresses) as typeof dns.lookup
syncBuiltinESMExports()
const { parseNetworkProbeTargets, resolvePublicTargetHost } = await import('../src/lib/network-probe.js')
const { setCachedConfig } = await import('../src/lib/config-cache.js')
const { default: networkProbeRoutes } = await import('../src/routes/network-probe.js')
const { prisma } = await import('../src/db/prisma.js')

const valid = [{ id: 'node-a', label: 'Node A', host: 'node.example.com', tcpPorts: [443], icmp: true, https: true, packageId: 1, hostId: 2 }]
assert.deepEqual(parseNetworkProbeTargets(valid), valid)
assert.equal(parseNetworkProbeTargets([{ ...valid[0], host: '127.0.0.1' }]), null)
assert.equal(parseNetworkProbeTargets([{ ...valid[0], tcpPorts: [0] }]), null)
assert.equal(parseNetworkProbeTargets([{ ...valid[0], host: 'https://node.example.com' }]), null)
assert.equal(parseNetworkProbeTargets(Array.from({ length: 31 }, (_, index) => ({ ...valid[0], id: `node-${index}` }))), null)
assert.equal(parseNetworkProbeTargets([{ ...valid[0], packageId: undefined }]), null)
assert.equal(parseNetworkProbeTargets([{ ...valid[0], hostId: -1 }]), null)
assert.equal(parseNetworkProbeTargets([{ ...valid[0], host: 'node.example.com;id' }]), null)
for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '100.64.0.1', '192.0.2.1', '198.51.100.1', '203.0.113.1', '::1', 'fc00::1', '::ffff:127.0.0.1', '2001:db8::1', '2002:7f00:1::1']) {
  addresses = [{ address, family: address.includes(':') ? 6 : 4 }]
  assert.equal(await resolvePublicTargetHost('node.example.com'), null, address)
}
addresses = [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }]
assert.equal(await resolvePublicTargetHost('node.example.com'), null)
addresses = [{ address: '8.8.8.8', family: 4 }]

const probeSource = await readFile(new URL('../src/lib/network-probe.ts', import.meta.url), 'utf8')
const routeSource = await readFile(new URL('../src/routes/network-probe.ts', import.meta.url), 'utf8')
assert.match(probeSource, /spawn\('ping', args, \{ shell: false/)
assert.match(probeSource, /activeProbes >= 10/)
assert.match(probeSource, /setTimeout\(\(\) => child\.kill\(\)/)
assert.match(routeSource, /authenticateAdmin/)
assert.match(routeSource, /rateLimit: \{ max: 5, timeWindow: '1 minute' \}/)
assert.match(routeSource, /tcpPorts\.includes\(port\)/)
const routerSource = await readFile(new URL('../../client/src/router/user.ts', import.meta.url), 'utf8')
const marketSource = await readFile(new URL('../../client/src/views/MarketView.vue', import.meta.url), 'utf8')
const appSource = await readFile(new URL('../../client/src/App.vue', import.meta.url), 'utf8')
const composeSource = await readFile(new URL('../../deploy/compose/compose.yaml', import.meta.url), 'utf8')
const dockerSource = await readFile(new URL('../../deploy/compose/Dockerfile', import.meta.url), 'utf8')
assert.doesNotMatch(routerSource, /NetworkTestView|path: '\/network-test'/)
assert.doesNotMatch(marketSource, /to="\/network-test"/)
assert.doesNotMatch(appSource, /publicSiteRouteNames = new Set\([^\n]*'network-test'/)
const purchaseSource = await readFile(new URL('../../client/src/views/InstanceCreateView.vue', import.meta.url), 'utf8')
const componentSource = await readFile(new URL('../../client/src/components/instance/PurchaseNetworkProbe.vue', import.meta.url), 'utf8')
assert.match(purchaseSource, /<PurchaseNetworkProbe v-if="isPaidPackage && form.packageId && form.hostId"/)
assert.match(componentSource, /非 TCP／ICMP/)
assert.match(componentSource, /credentials: 'omit'.*redirect: 'error'/)
assert.match(componentSource, /prepared.address/)
assert.match(componentSource, /api\.networkProbe\.targets\(props\.packageId, props\.hostId\)/)
assert.match(componentSource, /const prepared = await api\.networkProbe\.prepare\(props\.packageId, props\.hostId, target\.value\.id\)/)
assert.match(componentSource, /if \(!https \|\| !prepared\.httpsUrl\) return/)
const browserProbeFetches = componentSource.split('\n').filter(line => /\bfetch\s*\(/.test(line))
assert.equal(browserProbeFetches.length, 1, 'purchase probe must make exactly one direct browser request')
assert.equal(browserProbeFetches[0].trim(), "const response = await fetch(`${prepared.httpsUrl}?nonce=${crypto.randomUUID()}`, { method: 'GET', mode: 'cors', credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal })", 'browser probe must use only the prepared HTTPS URL without API credentials, redirects, referrers or cached responses')
assert.match(componentSource, /onBeforeUnmount\(\(\) => \{\s+disposed = true\s+controller\?\.abort\(\)/)
assert.match(componentSource, /controller = new AbortController\(\)/)
assert.match(componentSource, /window\.setTimeout\(\(\) => controller\?\.abort\(\), 5000\)/)
assert.match(componentSource, /finally \{\s+window\.clearTimeout\(timeout\)/)
assert.match(componentSource, /await response\.body\?\.cancel\(\)/)
assert.match(composeSource, /net\.ipv4\.ping_group_range: '1000 1000'/)
assert.match(composeSource, /cap_drop:\s+- NET_RAW/)
assert.match(dockerSource, /iputils-ping/)

setCachedConfig('network_probe_targets', JSON.stringify(valid))
const originalFind = prisma.package.findFirst
const originalBindingFind = prisma.packageHost.findUnique
prisma.packageHost.findUnique = (async () => null) as typeof prisma.packageHost.findUnique
prisma.package.findFirst = (async (args: any) => {
  assert.equal(args.where.active, true)
  assert.deepEqual(args.where.OR, [{ userId: 7 }, { globalShared: true }, { shares: { some: { sharedToId: 7 } } }])
  return args.where.id === 1 && args.where.packageHosts.some.hostId === 2 ? { id: 1 } : null
}) as typeof prisma.package.findFirst
const app = Fastify()
app.decorate('authenticateUser', async (request, reply) => {
  if (request.headers.authorization !== 'test-user') return reply.code(401).send({ error: 'Unauthorized' })
  request.user = { id: 7, role: 'user' } as typeof request.user
})
app.decorate('authenticateAdmin', async (request, reply) => {
  if (request.headers.authorization !== 'test-admin') return reply.code(401).send({ error: 'Unauthorized' })
  request.user = { id: 8, role: 'admin' } as typeof request.user
})
await app.register(rateLimit, { global: false })
await app.register(networkProbeRoutes, { prefix: '/api/network-probe' })
try {
  const targets = await app.inject({ method: 'GET', url: '/api/network-probe/targets' })
  assert.equal(targets.statusCode, 401)
  const headers = { authorization: 'test-user' }
  assert.equal((await app.inject({ method: 'GET', url: '/api/network-probe/targets', headers })).statusCode, 400)
  assert.equal((await app.inject({ method: 'GET', url: '/api/network-probe/targets?packageId=3&hostId=2', headers })).statusCode, 404)
  assert.equal((await app.inject({ method: 'GET', url: '/api/network-probe/targets?packageId=1&hostId=3', headers })).statusCode, 404)
  const scoped = await app.inject({ method: 'GET', url: '/api/network-probe/targets?packageId=1&hostId=2', headers })
  assert.equal(scoped.statusCode, 200)
  assert.deepEqual(scoped.json().targets, valid)
  addresses = [{ address: '127.0.0.1', family: 4 }]
  assert.deepEqual((await app.inject({ method: 'GET', url: '/api/network-probe/targets?packageId=1&hostId=2', headers })).json(), { targets: [] })
  addresses = [{ address: '8.8.8.8', family: 4 }]
  assert.equal((await app.inject({ method: 'POST', url: '/api/network-probe/test', headers, payload: { targetId: 'node-a', method: 'icmp' } })).statusCode, 401)
  assert.equal((await app.inject({ method: 'POST', url: '/api/network-probe/prepare', payload: { packageId: 1, hostId: 2, targetId: 'node-a' } })).statusCode, 401)
  for (let index = 0; index < 5; index++) {
    const payload = { packageId: 1, hostId: index === 0 ? 3 : 2, targetId: index === 1 ? 'missing' : 'node-a' }
    const probe = await app.inject({ method: 'POST', url: '/api/network-probe/prepare', headers, payload })
    assert.equal(probe.statusCode, index === 0 ? 404 : index === 1 ? 400 : 200)
    if (probe.statusCode === 200) {
      assert.equal(probe.json().address, '8.8.8.8')
      assert.equal(probe.json().httpsUrl, 'https://node.example.com/.well-known/network-probe')
      assert.equal(probe.json().source, undefined)
    }
  }
  assert.equal((await app.inject({ method: 'POST', url: '/api/network-probe/prepare', headers, payload: { packageId: 1, hostId: 2, targetId: 'node-a' } })).statusCode, 429)
  assert.equal((await app.inject({ method: 'PUT', url: '/api/network-probe/manage-targets', payload: { targets: [] } })).statusCode, 401)
  assert.equal((await app.inject({ method: 'PUT', url: '/api/network-probe/manage-targets', headers: { authorization: 'test-admin' }, payload: { targets: [{ ...valid[0], hostId: 0 }] } })).statusCode, 400)
  const invalidBinding = await app.inject({ method: 'PUT', url: '/api/network-probe/manage-targets', headers: { authorization: 'test-admin' }, payload: { targets: valid } })
  assert.equal(invalidBinding.statusCode, 400)
  assert.match(invalidBinding.json().error, /綁定商品既有的 host/)
} finally {
  await app.close()
  prisma.package.findFirst = originalFind
  prisma.packageHost.findUnique = originalBindingFind
  dns.lookup = originalLookup
  syncBuiltinESMExports()
}
console.log('Scoped network probe routes passed: auth=401, scope=404, validation=400, preparation=200, rate limit=429')
console.log('Network probe security guards passed')
process.exit(0)
