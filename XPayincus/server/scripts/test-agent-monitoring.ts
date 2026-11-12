import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import ts from 'typescript'
import { aggregateMonitoring, aggregateMonitoringCounters, ingestAgentMonitoring, instanceMonitoringKeys, isMonitoringInstanceName, readAgentComponentEvents, readAgentInstanceHistory, readAgentInstanceTop, readAgentMonitoring } from '../src/services/agent-monitoring.js'

const directory = mkdtempSync(join(tmpdir(), 'agent-monitoring-'))
const previousDirectory = process.env.INCUDAL_AGENT_STATE_DIR
process.env.INCUDAL_AGENT_STATE_DIR = directory
const now = Date.now()
const range = { from: now - 180000, to: now, resolutionSeconds: 60, limit: 1000 }
const sample = (id: string, at: number, value: number) => ({
  id: id.repeat(32), sampledAt: new Date(at).toISOString(),
  resources: { cpuUsagePercent: value, 'psi.cpu.some.avg10': value / 10 }, metrics: { heartbeatIntervalSeconds: 60 },
  instances: [{ name: 'vm1', sampledAt: new Date(at).toISOString(), intervalSeconds: 60, metrics: { cpuUsagePercent: value, memoryUsedBytes: value * 1024, diskIOBytesPerSecond: value * 100, rxBytes: 999 } }],
  events: [{ type: 'component-state', components: { zfs: { available: true, collectedAt: new Date(at).toISOString(), status: { moduleLoaded: true } } } }]
})
const envelope = { schemaVersion: 2, samples: [sample('a', now - 120000, 10), sample('b', now - 60000, 30)] }
const app = Fastify()
try {
  assert.deepEqual(ingestAgentMonitoring('fixture', envelope, now), ['a'.repeat(32), 'b'.repeat(32)])
  assert.deepEqual(ingestAgentMonitoring('fixture', envelope, now), ['a'.repeat(32), 'b'.repeat(32)])
  const history = readAgentMonitoring('fixture', range, now)
  assert.deepEqual(history.summary.cpuUsagePercent, { min: 10, max: 30, avg: 20, count: 2, coverage: 2 / 3 })
  assert.equal(history.buckets.length, 2)
  assert.equal(readAgentMonitoring('other', range, now).buckets.length, 0)
  assert.equal(readAgentInstanceTop('fixture', range, 'cpuUsagePercent', 'avg', 10, now).items[0]?.avg, 20)
  const instanceHistory = readAgentInstanceHistory('fixture', range, 'vm1', now)
  assert.deepEqual(instanceHistory.summary.cpuUsagePercent, history.summary.cpuUsagePercent)
  assert.equal(instanceHistory.buckets.length, 2)
  assert.deepEqual(readAgentInstanceHistory('fixture', range, 'absent', now).summary, {})
  assert.deepEqual(readAgentInstanceHistory(null, range, 'vm1', now).buckets, [])
  const cached = { ...sample('e', now - 30000, 999), instances: envelope.samples[0]!.instances, events: [] }
  ingestAgentMonitoring('fixture', { schemaVersion: 2, samples: [cached] }, now)
  assert.deepEqual(readAgentInstanceHistory('fixture', range, 'vm1', now).summary, instanceHistory.summary)
  const outside = { from: now - 50000, to: now, resolutionSeconds: 30, limit: 1000 }
  assert.deepEqual(readAgentInstanceHistory('fixture', outside, 'vm1', now).buckets, [])
  const unknownInterval = { ...sample('f', now - 30000, 5), instances: [{ ...sample('f', now - 30000, 5).instances[0]!, intervalSeconds: undefined }], events: [] }
  ingestAgentMonitoring('unknown-interval', { schemaVersion: 2, samples: [unknownInterval] }, now)
  assert.equal(readAgentInstanceHistory('unknown-interval', range, 'vm1', now).summary.cpuUsagePercent?.coverage, 0)
  assert.equal(isMonitoringInstanceName('vm1'), true)
  assert.equal(isMonitoringInstanceName('vm/name'), false)
  assert.equal(readAgentComponentEvents('fixture', range, now).events.length, 1)
  assert.deepEqual(ingestAgentMonitoring('fixture', { schemaVersion: 1, samples: [] }, now), [])
  assert.deepEqual(ingestAgentMonitoring('fixture', { schemaVersion: 2, samples: [sample('c', now + 120000, 1)] }, now), [])
  assert.deepEqual(ingestAgentMonitoring('fixture', { schemaVersion: 2, samples: [sample('d', now - 9 * 86400000, 1)] }, now), ['d'.repeat(32)])
  assert.equal(readAgentMonitoring('fixture', range, now).summary.cpuUsagePercent?.count, 3)
  assert.equal(readAgentMonitoring('fixture', { ...range, limit: 1 }, now).bucketsTruncated, true)
  const missing = aggregateMonitoring([{ sampledAt: now - 60000, intervalSeconds: 60, metrics: {} }], range.from, range.to)
  assert.deepEqual(missing, {})
  const duplicate = aggregateMonitoring([{ sampledAt: now - 60000, intervalSeconds: 60, metrics: { cpu: 2 } }, { sampledAt: now - 60000, intervalSeconds: 60, metrics: { cpu: 2 } }], range.from, range.to)
  assert.equal(duplicate.cpu?.count, 1)
  const counterKey = 'psi.cpu.some.total'
  const counters = [100, 160, 20, 50].map((value, index) => ({ sampledAt: range.from + index * 30000, intervalSeconds: 30, metrics: { [counterKey]: value } }))
  assert.deepEqual(aggregateMonitoring(counters, range.from, range.to), {})
  assert.deepEqual(aggregateMonitoringCounters(counters, range.from, range.to)[counterKey], { first: 100, last: 50, delta: 90, resetCount: 1, count: 4, coverage: 1 / 3, unit: 'microseconds' })
  assert.equal(aggregateMonitoringCounters(counters.slice(0, 1), range.from, range.to)[counterKey]?.coverage, 0)
  const reboot = counters.slice(0, 2).map((point, index) => ({ ...point, metrics: { ...point.metrics, uptimeSeconds: index ? 1 : 100 } }))
  assert.equal(aggregateMonitoringCounters(reboot, range.from, range.to)[counterKey]?.delta, 0)
  const pressureSamples = counters.map((point, index) => ({ id: String(index + 1).repeat(32), sampledAt: new Date(point.sampledAt).toISOString(), resources: point.metrics }))
  ingestAgentMonitoring('pressure', { schemaVersion: 2, samples: pressureSamples }, now)
  const pressureHistory = readAgentMonitoring('pressure', range, now)
  assert.equal(pressureHistory.summary[counterKey], undefined)
  assert.equal(pressureHistory.summaryCounters[counterKey]?.delta, 90)
  for (const name of readdirSync(directory)) assert.ok(!readFileSync(join(directory, name), 'utf8').includes('rxBytes'))
  const source = readFileSync(new URL('../src/routes/agent.ts', import.meta.url), 'utf8')
  const start = source.indexOf("  for (const view of ['history', 'instances/top', 'instances/history', 'events'] as const)")
  const end = source.indexOf('  fastify.post<', start)
  assert.ok(start > 0 && end > start)
  const compiled = ts.transpile(source.slice(start, end), { target: ts.ScriptTarget.ES2022 })
  app.decorate('authenticate', async (request: any, reply: any) => {
    if (!request.headers['x-test-user']) return reply.code(401).send({ error: 'Unauthorized' })
    request.user = { id: Number(request.headers['x-test-user']), role: request.headers['x-test-role'] ?? 'user' }
  })
  new Function('fastify', 'prisma', 'agentModel', 'parsePositiveId', 'instanceMonitoringKeys', 'readAgentInstanceTop', 'readAgentComponentEvents', 'readAgentMonitoring', 'isMonitoringInstanceName', 'readAgentInstanceHistory', compiled)(
    app, { host: { findUnique: async ({ where }: any) => where.id === 1 ? { userId: 1 } : null } }, { findUnique: async () => ({ agentId: 'fixture' }) },
    (value: string) => /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null,
    instanceMonitoringKeys, readAgentInstanceTop, readAgentComponentEvents, readAgentMonitoring, isMonitoringInstanceName, readAgentInstanceHistory
  )
  for (const view of ['history', 'instances/top', 'events']) {
    const url = `/hosts/1/monitoring/${view}`
    assert.equal((await app.inject({ url })).statusCode, 401)
    assert.equal((await app.inject({ url, headers: { 'x-test-user': '2' } })).statusCode, 403)
    for (const headers of [{ 'x-test-user': '1' }, { 'x-test-user': '2', 'x-test-role': 'admin' }]) assert.equal((await app.inject({ url, headers })).statusCode, 200)
    assert.equal((await app.inject({ url: `${url}?top=101`, headers: { 'x-test-user': '1' } })).statusCode, 400)
    assert.equal((await app.inject({ url: url.replace('/1/', '/1abc/'), headers: { 'x-test-user': '1' } })).statusCode, 400)
  }
  const instanceUrl = '/hosts/1/monitoring/instances/history'
  const owner = { 'x-test-user': '1' }
  assert.equal((await app.inject({ url: `${instanceUrl}?name=vm1` })).statusCode, 401)
  assert.equal((await app.inject({ url: `${instanceUrl}?name=vm1`, headers: { 'x-test-user': '2' } })).statusCode, 403)
  for (const headers of [owner, { 'x-test-user': '2', 'x-test-role': 'admin' }]) {
    const response = await app.inject({ url: `${instanceUrl}?name=vm1`, headers })
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().name, 'vm1')
    assert.equal(response.json().summary.cpuUsagePercent.count, 2)
  }
  for (const name of ['', '../vm', 'vm/name', 'vm name', '-vm', 'a'.repeat(129)]) {
    const response = await app.inject({ url: `${instanceUrl}?name=${encodeURIComponent(name)}`, headers: owner })
    assert.equal(response.statusCode, 400)
    assert.equal(response.json().code, 'AGENT_MONITORING_INVALID_NAME')
  }
  assert.equal((await app.inject({ url: instanceUrl, headers: owner })).statusCode, 400)
  assert.equal((await app.inject({ url: `${instanceUrl}?name=vm1&resolutionSeconds=29`, headers: owner })).statusCode, 400)
  const transitions = [true, false, true].map((loaded, index) => {
    const value = sample(String(index + 1), now - 150000 + index * 30000, 1)
    return { ...value, instances: [], events: [{ type: 'component-state', id: String(index + 1).repeat(32), sampledAt: value.sampledAt, components: { zfs: { available: true, status: { moduleLoaded: loaded } } } }] }
  })
  for (const value of [transitions[2]!, transitions[0]!, transitions[1]!, transitions[0]!]) ingestAgentMonitoring('transitions', { schemaVersion: 2, samples: [value] }, now)
  const events = readAgentComponentEvents('transitions', range, now).events
  assert.deepEqual(events.map(event => (event.components.zfs as any).status.moduleLoaded), [true, false, true])
  const rewrapped = { ...transitions[0]!, id: '9'.repeat(32), sampledAt: new Date(now - 10000).toISOString() }
  ingestAgentMonitoring('transitions', { schemaVersion: 2, samples: [rewrapped] }, now)
  assert.deepEqual(readAgentComponentEvents('transitions', range, now).events, events)
  for (let batch = 0; batch < 17; batch++) {
    const samples = Array.from({ length: 32 }, (_, index) => {
      const number = batch * 32 + index
      const id = number.toString(16).padStart(32, '0')
      const sampledAt = new Date(now - 1000000 + number * 1000).toISOString()
      return { id, sampledAt, events: [{ id, sampledAt, type: 'component-state', components: { rfw: { generation: number } } }] }
    })
    assert.equal(ingestAgentMonitoring('event-capacity', { schemaVersion: 2, samples }, now).length, 32)
  }
  const cappedEvents = readAgentComponentEvents('event-capacity', { ...range, from: now - 2000000 }, now)
  assert.equal(cappedEvents.capacityTruncated, true)
  assert.equal(cappedEvents.events.length, 512)
  assert.equal((cappedEvents.events[0]!.components.rfw as any).generation, 32)
  assert.deepEqual(readAgentMonitoring('event-capacity', range, now).buckets, [])
  const previousStatePath = process.env.INCUDAL_AGENT_STATE_DIR
  process.env.INCUDAL_AGENT_STATE_DIR = fileURLToPath(new URL('..', import.meta.url))
  assert.throws(() => ingestAgentMonitoring('failed-write', envelope, now))
  process.env.INCUDAL_AGENT_STATE_DIR = previousStatePath
  const heartbeat = source.slice(source.indexOf("fastify.post<{ Body: AgentHeartbeatBody }>('/heartbeat'"))
  assert.ok(heartbeat.indexOf('authenticateAgentRequest') < heartbeat.indexOf('ingestAgentMonitoring'))
  assert.ok(!readFileSync(new URL('../src/services/agent-monitoring.ts', import.meta.url), 'utf8').includes('processAgentInstanceReport'))
  for (let batch = 0; batch < 10; batch++) {
    const samples = Array.from({ length: 16 }, (_, index) => {
      const value = sample('a', now - 1000000 + (batch * 16 + index) * 1000, 1)
      return { ...value, id: (batch * 16 + index).toString(16).padStart(32, '0'), instances: Array.from({ length: 100 }, (_, instance) => ({ ...value.instances[0], name: `vm${instance}` })) }
    })
    assert.equal(ingestAgentMonitoring('capacity', { schemaVersion: 2, samples }, now).length, 16)
  }
  assert.equal(readAgentMonitoring('capacity', { ...range, from: now - 2000000 }, now).capacityTruncated, true)
  for (const name of readdirSync(directory)) assert.ok(readFileSync(join(directory, name)).length <= 4 * 1024 * 1024)
} finally {
  await app.close()
  if (previousDirectory === undefined) delete process.env.INCUDAL_AGENT_STATE_DIR
  else process.env.INCUDAL_AGENT_STATE_DIR = previousDirectory
  rmSync(directory, { recursive: true, force: true })
}
console.log('agent monitoring v2 checks passed')
