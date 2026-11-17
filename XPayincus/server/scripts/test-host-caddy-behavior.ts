import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { canShowHostCaddy } from '../../client/src/utils/host-caddy-state.js'

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
console.log('host installation response, certificate failure and Caddy category timing behavior tests passed')
