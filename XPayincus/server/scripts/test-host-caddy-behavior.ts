import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { canShowHostCaddy } from '../../client/src/utils/host-caddy-state.js'
import { AgentTunnelError } from '../src/lib/agent-tunnel.js'

assert.equal(canShowHostCaddy(false, null), false)
assert.equal(canShowHostCaddy(false, { enabled: true, status: 'offline', lastSeenAt: null }), false)
assert.equal(canShowHostCaddy(true, null), true)
assert.equal(canShowHostCaddy(false, { enabled: true, status: 'online' }), true)
assert.equal(canShowHostCaddy(false, { enabled: true, status: 'offline', lastSeenAt: '2026-11-17T00:00:00Z' }), true)
assert.equal(canShowHostCaddy(false, { enabled: false, status: 'online' }), false)

const hosts = readFileSync(new URL('../src/routes/hosts.ts', import.meta.url), 'utf8')
const parsed = ts.createSourceFile('hosts.ts', hosts, ts.ScriptTarget.Latest, true)
const responseUrls: ts.PropertyAssignment[] = []
function visit(node: ts.Node) {
  if (ts.isPropertyAssignment(node) && node.name.getText(parsed) === 'installScriptUrl') responseUrls.push(node)
  ts.forEachChild(node, visit)
}
visit(parsed)
assert.equal(responseUrls.length, 2)
for (const property of responseUrls) {
  const expression = property.initializer.getText(parsed)
  const result = new Function('panelUrl', 'responsePanelUrl', `return ${expression}`)('https://fixture.test', 'https://fixture.test')
  assert.equal(result, 'https://fixture.test/api/agent/install.sh')
}

const certStart = hosts.indexOf("  fastify.get<{ Params: { token: string } }>('/cert/:token'")
assert.ok(certStart >= 0)
const certRoute = hosts.slice(certStart, hosts.indexOf('  // 验证并连接宿主机', certStart))
let certHandler: (request: unknown, reply: unknown) => Promise<unknown>
let pairReads = 0
let status = 200
let body: unknown
const messages: string[] = []
const code = ts.transpileModule(certRoute, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
const fixture = new Function('fastify', 'prisma', 'getPanelCertificatePaths', 'readPanelCertificatePair', 'PANEL_CERTIFICATE_ERROR', code)
fixture({ get(_path: string, _options: unknown, handler: typeof certHandler) { certHandler = handler } },
  { host: { findUnique: async () => ({ id: 1, name: 'fixture', isInstalled: false, installTokenExpire: new Date(Date.now() + 60000) }) } },
  () => ({ certPath: 'fixture.crt', keyPath: 'fixture.key' }),
  () => { pairReads++; throw new Error('private-key-marker') }, 'Invalid certificate pair')
const reply = { code(value: number) { status = value; return this }, send(value: unknown) { body = value; return this }, header() { return this } }
await certHandler!({ params: { token: 'fixture-uuid-token' }, log: { warn(...values: unknown[]) { messages.push(JSON.stringify(values)) }, error(...values: unknown[]) { messages.push(JSON.stringify(values)) }, info() {} } }, reply)
assert.equal(pairReads, 1)
assert.equal(status, 500)
assert.equal(body, '# Error: Invalid certificate pair')
assert.ok(!messages.join('').includes('private-key-marker'))
const agentSource = readFileSync(new URL('../src/routes/agent.ts', import.meta.url), 'utf8')
const trustStart = agentSource.indexOf("  fastify.post<{ Body: AgentHeartbeatBody; Params: { phase: string } }>('/panel-trust/:phase'")
const trustRoute = agentSource.slice(trustStart, agentSource.indexOf("  fastify.get('/install.sh'", trustStart))
let trustHandler: (request: unknown, reply: unknown) => Promise<unknown>
let authenticated = true
let installed = true
let tunnelFails = false
const tunnelRequests: unknown[][] = []
const trustCode = ts.transpileModule(trustRoute, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
new Function('fastify', 'authenticateAgentRequest', 'prisma', 'existsSync', 'join', 'dirname', '__dirname', 'readPanelCertificatePair', 'getAgentTunnel', 'readAgentAuthHeaders', 'createHash', 'createHmac', 'decryptSensitiveData', trustCode)(
  { post(_path: string, handler: typeof trustHandler) { trustHandler = handler } },
  async () => authenticated ? { hostId: 7, secretEncrypted: 'fixture' } : null,
  { host: { findUnique: async () => ({ isInstalled: installed }) } },
  () => false, (...parts: string[]) => parts.join('/'), () => '', '/fixture', () => ({ cert: Buffer.from('fixture-cert') }),
  (hostId: number) => ({ request: async (...args: unknown[]) => { tunnelRequests.push([hostId, ...args]); if (tunnelFails) throw new Error('offline'); return { statusCode: 200, body: Buffer.from('{"type":"sync","status_code":200}') } } }),
  () => ({ nonce: 'fixture' }), () => ({ update() { return this }, digest: () => 'digest' }),
  () => ({ update() { return this }, digest: () => 'proof' }), () => 'fixture-secret')
const trustRequest = { params: { phase: 'verify' }, body: { incus: { serverCertificate: 'fixture-certificate' } }, log: { warn() {}, error() {} } }
const trustReply = { ...reply, type() { return this } }
await trustHandler!(trustRequest, trustReply)
assert.deepEqual(tunnelRequests, [[7, 'incus', 'GET', '/1.0/resources']])
tunnelFails = true
await trustHandler!(trustRequest, trustReply)
assert.equal(status, 502)
installed = false
await trustHandler!(trustRequest, trustReply)
assert.equal(status, 403)
authenticated = false
const calls = tunnelRequests.length
await trustHandler!(trustRequest, trustReply)
assert.equal(tunnelRequests.length, calls)
function routeSource(path: string): string {
  let source = ''
  function find(node: ts.Node) {
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) &&
        node.expression.expression.getText(parsed) === 'fastify.post' &&
        ts.isStringLiteral(node.expression.arguments[0]!) && node.expression.arguments[0].text === path) {
      source = node.getText(parsed)
    }
    ts.forEachChild(node, find)
  }
  find(parsed)
  assert.ok(source, path)
  return ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
}

for (const path of ['/:id/caddy/confirm', '/:id/caddy/test']) {
  for (const scenario of ['success', 'offline', 'disconnect', 'service', 'forbidden', 'admin', 'missing', 'invalid']) {
    let handler: (request: unknown, reply: unknown) => Promise<unknown>
    let writes = 0
    let probes = 0
    let verified = false
    let generated = false
    let responseStatus = 200
    let responseBody: any
    const code = routeSource(path)
    new Function('fastify', 'db', 'prisma', 'parsePositiveRouteId', 'apiError', 'ErrorCode', 'createCaddyClient', 'AgentTunnelError', 'createLog', 'getDnsRecordType', code)(
      { authenticate() {}, post(_path: string, _options: unknown, value: typeof handler) { handler = value } },
      { getHostById: async () => scenario === 'missing' ? null : { id: 7, user_id: 1, name: 'fixture', caddy_enabled: path.endsWith('/test') } },
      { host: { update: async ({ data }: { data: unknown }) => { assert.equal(verified, true); assert.deepEqual(data, { caddyEnabled: true }); writes++ } } },
      (id: string) => id === '7' ? 7 : null, (error: string) => ({ error }),
      { INVALID_ID: 'INVALID_ID', FORBIDDEN: 'FORBIDDEN', HOST_NOT_FOUND: 'HOST_NOT_FOUND' },
      (config: unknown) => {
        generated = true
        assert.deepEqual(config, { hostId: 7, host: '127.0.0.1', port: 2019 })
        return {
          getConfig: async () => {
            probes++
            if (scenario === 'offline') throw new AgentTunnelError('TUNNEL_OFFLINE')
            if (scenario === 'disconnect') throw new AgentTunnelError('TUNNEL_DISCONNECTED', true)
            if (scenario === 'service') throw new Error('private-service-error')
            verified = true
            return {}
          },
          getSitesFromConfig: () => []
        }
      }, AgentTunnelError, async () => {}, () => 'A')
    const result = await handler!({
      params: { id: scenario === 'invalid' ? 'bad' : '7' },
      user: { id: scenario === 'forbidden' || scenario === 'admin' ? 2 : 1, role: scenario === 'admin' ? 'admin' : 'user' },
      log: { info() {}, warn() {} }
    }, {
      code(value: number) { responseStatus = value; return this },
      send(value: unknown) { responseBody = value; return value }
    })
    if (scenario === 'success' || scenario === 'admin') {
      assert.equal(responseStatus, 200)
      assert.equal(probes, 1)
      assert.equal(writes, path.endsWith('/confirm') ? 1 : 0)
      assert.ok(result)
    } else {
      assert.equal(writes, 0)
      assert.equal(responseStatus, { offline: 503, disconnect: 503, service: 502, forbidden: 403, missing: 404, invalid: 400 }[scenario])
      if (scenario === 'offline' || scenario === 'disconnect') assert.match(responseBody.error, /WSS.*離線/)
      if (scenario === 'service') assert.ok(!responseBody.error.includes('private-service-error'))
      if (['forbidden', 'missing', 'invalid'].includes(scenario)) assert.equal(generated, false)
    }
  }
}

for (const { alreadyInstalled, initialStatus, race } of [true, false].flatMap(alreadyInstalled => [
  { alreadyInstalled, initialStatus: 'online', race: false },
  { alreadyInstalled, initialStatus: 'offline', race: false },
  { alreadyInstalled, initialStatus: 'maintenance', race: false },
  { alreadyInstalled, initialStatus: 'online', race: true },
  { alreadyInstalled, initialStatus: 'offline', race: true }
])) {
  let handler: (request: unknown, reply: unknown) => Promise<any>
  let writes = 0
  let statusWrites = 0
  let hostStatus = initialStatus
  let requests = 0
  let fail = false
  let expired = false
  let responseStatus = 200
  new Function('fastify', 'db', 'prisma', 'parsePositiveRouteId', 'apiError', 'ErrorCode', 'getAgentTunnel', 'normalizeArchitecture', 'extractHostPublicIpv6FromResources', 'createLog', routeSource('/:id/verify'))(
    { authenticate() {}, post(_path: string, _options: unknown, value: typeof handler) { handler = value } },
    { getHostById: async () => ({ id: 7, user_id: 1, name: 'fixture', status: hostStatus }) },
    { host: {
      findUnique: async () => ({ isInstalled: alreadyInstalled, installTokenExpire: expired ? new Date(0) : null }),
      update: async ({ data }: { data: { isInstalled: boolean; status?: string } }) => {
        assert.equal(requests % 2, 0)
        assert.equal(data.isInstalled, true)
        assert.equal(Object.hasOwn(data, 'status'), false)
        writes++
        if (race) hostStatus = 'maintenance'
      },
      updateMany: async ({ where, data }: { where: { id: number; status: { in: string[] } }; data: { status: string } }) => {
        assert.equal(writes, statusWrites + 1)
        assert.deepEqual(where, { id: 7, status: { in: ['online', 'offline'] } })
        assert.deepEqual(data, { status: 'online' })
        statusWrites++
        const count = where.status.in.includes(hostStatus) ? 1 : 0
        if (count) hostStatus = data.status
        return { count }
      }
    } },
    () => 7, () => ({}), {},
    () => ({ request: async () => {
      if (fail) throw new AgentTunnelError('TUNNEL_OFFLINE')
      requests++
      return { body: Buffer.from('{"type":"sync","metadata":{}}') }
    } }), () => 'x86_64', () => null, async () => {})
  const request = { params: { id: '7' }, user: { id: 1, role: 'user' }, log: { error() {}, info() {} } }
  const reply = { code(value: number) { responseStatus = value; return this }, send(value: unknown) { return value } }
  assert.equal((await handler!(request, reply)).success, true)
  assert.equal(writes, 1)
  assert.equal(requests, 2)
  assert.equal(statusWrites, 1)
  assert.equal(hostStatus, initialStatus === 'maintenance' || race ? 'maintenance' : 'online')
  fail = true
  await handler!(request, reply)
  assert.equal(responseStatus, 400)
  assert.equal(writes, 1)
  assert.equal(statusWrites, 1)
  assert.equal(hostStatus, initialStatus === 'maintenance' || race ? 'maintenance' : 'online')
  fail = false
  expired = true
  responseStatus = 200
  await handler!(request, reply)
  assert.equal(responseStatus, alreadyInstalled ? 200 : 400)
  assert.equal(writes, alreadyInstalled ? 2 : 1)
  assert.equal(statusWrites, alreadyInstalled ? 2 : 1)
  assert.equal(hostStatus, initialStatus === 'maintenance' || race ? 'maintenance' : 'online')
}

const detail = readFileSync(new URL('../../client/src/views/resources/MyHostDetailView.vue', import.meta.url), 'utf8')
assert.ok(detail.includes('host.value?.isInstalled === false'))
assert.ok(!detail.includes('host.value?.certPath'))
const caddyView = readFileSync(new URL('../../client/src/components/host/HostCaddyTab.vue', import.meta.url), 'utf8')
assert.match(caddyView, /@click="confirmInstallation"[\s\S]*?host.caddy.verifyAndEnable/)
assert.ok(caddyView.includes("t('host.caddy.agentOffline')"))
assert.ok(!agentSource.includes('caddyEnabled'))
console.log('host installation, manual Caddy verification, authorization, tunnel failures and verification state tests passed')
