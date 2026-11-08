import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { AgentUpgradeRequests, agentVersionStatus } from '../src/lib/agent-upgrade.js'
import Fastify from 'fastify'
import ts from 'typescript'

for (const [current, target, expected] of [
  ['v1.9.0', 'v1.10.0', 'outdated'],
  ['v1.10.0', 'v1.9.0', 'latest'],
  ['v1.0.0', 'v1.0.0', 'latest'],
  ['v1.0.0-rc.2', 'v1.0.0', 'outdated'],
  ['dev', 'v1.0.0', 'unknown'],
  ['v01.0.0', 'v1.0.0', 'unknown'],
  [null, 'v1.0.0', 'unknown']
] as const) assert.equal(agentVersionStatus(current, target), expected)

const requests = new AgentUpgradeRequests()
const now = Date.parse('2026-11-08T00:00:00Z')
const runtime = { goos: 'linux', goarch: 'amd64' }
const instruction = {
  available: true, version: 'v1.1.0', url: 'https://panel.example/api/agent/binary/release',
  sha256: 'a'.repeat(64), platform: 'linux', arch: 'amd64'
}
assert.deepEqual(requests.heartbeat('agent', 'v1.0.0', runtime, now), { available: false })
assert.equal(requests.get('agent'), null)
assert.throws(() => requests.request('invalid', { available: false }, 60, now))
const pending = requests.request('agent', instruction, 60, now)
assert.equal(pending.status, 'pending')
assert.deepEqual(requests.request('agent', { ...instruction, version: 'v2.0.0' }, 60, now + 1), pending)
assert.deepEqual(requests.heartbeat('other', 'v1.0.0', runtime, now + 1), { available: false })
assert.deepEqual(requests.heartbeat('agent', 'v1.0.0', { ...runtime, goarch: 'arm64' }, now + 1), { available: false })
assert.deepEqual(requests.heartbeat('agent', 'v2.0.0', runtime, now + 1), { available: false })
assert.deepEqual(requests.heartbeat('agent', 'dev', runtime, now + 1), { available: false })
instruction.sha256 = 'b'.repeat(64)
const delivered = requests.heartbeat('agent', 'v1.0.0', runtime, now + 2)
assert.equal(delivered.sha256, 'a'.repeat(64))
assert.equal(requests.get('agent', now + 2)?.status, 'delivered')
assert.deepEqual(requests.heartbeat('agent', 'v1.0.0', runtime, now + 3), { available: false })
assert.deepEqual(requests.heartbeat('agent', 'v1.1.0', runtime, now + 4), { available: false })
assert.equal(requests.get('agent', now + 4)?.status, 'succeeded')
assert.equal(new AgentUpgradeRequests().get('agent'), null)

requests.request('expired', instruction, 60, now)
const expiredAt = Date.parse(requests.get('expired', now)!.expiresAt) + 1
assert.deepEqual(requests.heartbeat('expired', 'v1.0.0', runtime, expiredAt), { available: false })
assert.equal(requests.get('expired', expiredAt)?.status, 'unconfirmed')
requests.request('timeout', instruction, 60, now)
requests.heartbeat('timeout', 'v1.0.0', runtime, now + 1)
assert.equal(requests.get('timeout', expiredAt)?.status, 'unconfirmed')
requests.heartbeat('timeout', 'v1.1.0', runtime, expiredAt + 1)
assert.equal(requests.get('timeout', expiredAt + 1)?.status, 'succeeded')
assert.equal(requests.request('expired', instruction, 60, expiredAt).status, 'pending')

const source = readFileSync(new URL('../src/routes/agent.ts', import.meta.url), 'utf8')
const start = source.indexOf("}>('/hosts/:hostId/upgrade'")
assert.ok(start > 0)
const route = source.slice(start, source.indexOf("}>('/hosts/:hostId/install-command'", start))
assert.ok(route.includes('onRequest: [fastify.authenticate]'))
assert.ok(route.includes("host.userId !== request.user.id && request.user.role !== 'admin'"))
assert.ok(route.includes("required: ['confirm', 'targetVersion']"))
assert.ok(route.includes('request.body.confirm !== true || request.body.targetVersion !== latestVersion'))
assert.ok(route.includes("!agent.enabled || derivedStatus !== 'online'"))
assert.ok(route.includes('instruction.version !== latestVersion'))
assert.ok(!route.includes('request.body.url') && !route.includes('request.body.command'))
const heartbeat = source.slice(source.indexOf("fastify.post<{ Body: AgentHeartbeatBody }>('/heartbeat'"))
assert.ok(heartbeat.indexOf('authenticateAgentRequest') < heartbeat.indexOf('agentUpgradeRequests.heartbeat'))
assert.ok(heartbeat.includes('agentUpgradeRequests.heartbeat(agent.agentId'))
assert.ok(!heartbeat.includes('buildAgentUpgradeInstruction(request'))
const ui = readFileSync(new URL('../../client/src/components/host/HostInfoTab.vue', import.meta.url), 'utf8')
assert.ok(ui.includes("window.confirm(t('admin.hosts.agentUpgradeConfirm'"))
assert.ok(ui.includes('api.hosts.requestAgentUpgrade(props.host.id, targetVersion)'))
assert.ok(ui.includes('agentUpgradeActive.value') && ui.includes('aria-live="polite"'))

const app = Fastify()
app.decorate('authenticate', async (request: any, reply: any) => {
  if (!request.headers['x-test-user']) return reply.code(401).send({ error: 'Unauthorized' })
  request.user = { id: Number(request.headers['x-test-user']), role: request.headers['x-test-role'] ?? 'user' }
})
let enabled = true
let online = true
let currentVersion = 'v1.0.0'
let compatible = true
let authorizations = 0
let audited = 0
const host = { id: 1, userId: 1, name: 'isolated test' }
const agent = () => ({ agentId: 'fixture', version: currentVersion, enabled, lastReport: { runtime } })
const routeStart = source.lastIndexOf('  fastify.post<', start)
const routeEnd = source.indexOf('  fastify.post<', start)
const compiled = ts.transpile(source.slice(routeStart, routeEnd), { target: ts.ScriptTarget.ES2022 })
new Function('fastify', 'prisma', 'agentModel', 'parsePositiveId', 'getLatestAgentVersion', 'getAgentVersionStatus',
  'deriveAgentStatus', 'getAgentHeartbeatIntervalSeconds', 'isRecord', 'buildAgentUpgradeInstruction', 'createLog',
  'LogModule', 'LogResult', 'agentUpgradeRequests', compiled)(
  app, { host: { findUnique: async () => host } }, { findUnique: async () => agent() },
  (value: string) => /^[1-9]\d*$/.test(value) ? Number(value) : null,
  async () => 'v1.1.0', agentVersionStatus, () => online ? 'online' : 'offline', () => 60,
  (value: unknown) => !!value && typeof value === 'object',
  async () => compatible ? instruction : { available: false }, async () => { audited++ },
  { HOST: 'host' }, { SUCCESS: 'success' }, { request: (...args: Parameters<AgentUpgradeRequests['request']>) => {
    authorizations++
    return new AgentUpgradeRequests().request(...args)
  } }
)
try {
  const payload = { confirm: true, targetVersion: 'v1.1.0' }
  const post = (body: unknown = payload, user = '1', role = 'user') => app.inject({
    method: 'POST', url: '/hosts/1/upgrade', headers: user ? { 'x-test-user': user, 'x-test-role': role } : {}, payload: body as any
  })
  assert.equal((await post(payload, '')).statusCode, 401)
  assert.equal((await post(payload, '2')).statusCode, 403)
  for (const body of [{}, { confirm: false, targetVersion: 'v1.1.0' }, { confirm: 'true', targetVersion: 'v1.1.0' }, { ...payload, url: 'https://untrusted.example' }, { ...payload, command: 'id' }]) {
    assert.equal((await post(body)).statusCode, 400)
  }
  assert.equal((await post({ ...payload, targetVersion: 'v1.2.0' })).statusCode, 409)
  enabled = false
  assert.equal((await post()).statusCode, 409)
  enabled = true
  online = false
  assert.equal((await post()).statusCode, 409)
  online = true
  compatible = false
  assert.equal((await post()).statusCode, 409)
  compatible = true
  currentVersion = 'dev'
  assert.equal((await post()).statusCode, 409)
  currentVersion = 'v2.0.0'
  const newer = await post()
  assert.equal(newer.statusCode, 200)
  assert.equal(newer.json().requested, false)
  assert.equal(authorizations, 0)
  currentVersion = 'v1.0.0'
  for (const [user, role] of [['1', 'user'], ['2', 'admin']]) {
    const response = await post(payload, user, role)
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().requested, true)
    assert.equal(response.json().upgrade.status, 'pending')
    assert.ok(!response.body.includes('sha256') && !response.body.includes('https://'))
  }
  assert.equal(authorizations, 2)
  assert.equal(audited, 2)
} finally {
  await app.close()
}
console.log('agent upgrade authorization and state checks passed')
