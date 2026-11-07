import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import Fastify from 'fastify'
import rateLimit from '@fastify/rate-limit'
process.env.DATABASE_URL ||= 'postgresql://test:test@127.0.0.1:5432/test'
const { parseNetworkProbeTargets } = await import('../src/lib/network-probe.js')
const { setCachedConfig } = await import('../src/lib/config-cache.js')
const { default: networkProbeRoutes } = await import('../src/routes/network-probe.js')

const valid = [{ id: 'node-a', label: 'Node A', host: 'node.example.com', tcpPorts: [443], icmp: true }]
assert.deepEqual(parseNetworkProbeTargets(valid), valid)
assert.equal(parseNetworkProbeTargets([{ ...valid[0], host: '127.0.0.1' }]), null)
assert.equal(parseNetworkProbeTargets([{ ...valid[0], tcpPorts: [0] }]), null)
assert.equal(parseNetworkProbeTargets([{ ...valid[0], host: 'https://node.example.com' }]), null)
assert.equal(parseNetworkProbeTargets(Array.from({ length: 31 }, (_, index) => ({ ...valid[0], id: `node-${index}` }))), null)

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
const publicRoute = routerSource.slice(routerSource.indexOf("path: '/network-test'"), routerSource.indexOf("path: '/market'"))
assert.match(publicRoute, /NetworkTestView\.vue/)
assert.doesNotMatch(publicRoute, /requiresAuth|requiresUser|guest:/)
assert.match(marketSource, /<RouterLink to="\/network-test"/)
assert.match(appSource, /publicSiteRouteNames = new Set\([^\n]*'network-test'/)
assert.match(composeSource, /net\.ipv4\.ping_group_range: '1000 1000'/)
assert.match(composeSource, /cap_drop:\s+- NET_RAW/)
assert.match(dockerSource, /iputils-ping/)

setCachedConfig('network_probe_targets', '[]')
const app = Fastify()
app.decorate('authenticateAdmin', async (_request, reply) => { await reply.code(401).send({ error: 'Unauthorized' }) })
await app.register(rateLimit, { global: false })
await app.register(networkProbeRoutes, { prefix: '/api/network-probe' })
try {
  const targets = await app.inject({ method: 'GET', url: '/api/network-probe/targets' })
  assert.equal(targets.statusCode, 200)
  assert.deepEqual(targets.json(), { targets: [] })
  for (let index = 0; index < 5; index++) {
    const probe = await app.inject({ method: 'POST', url: '/api/network-probe/test', payload: { targetId: 'missing', method: 'icmp' } })
    assert.equal(probe.statusCode, 400)
    assert.match(probe.json().error, /未獲管理員允許/)
  }
  assert.equal((await app.inject({ method: 'POST', url: '/api/network-probe/test', payload: { targetId: 'missing', method: 'icmp' } })).statusCode, 429)
  assert.equal((await app.inject({ method: 'PUT', url: '/api/network-probe/manage-targets', payload: { targets: [] } })).statusCode, 401)
} finally {
  await app.close()
}
console.log('Anonymous network probe routes passed: targets=200, unconfigured target=400, rate limit=429, management=401')
console.log('Network probe security guards passed')
process.exit(0)
