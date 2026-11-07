import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { PrismaClient } from '@prisma/client'
import { clampAgentHeartbeatIntervalSeconds, deriveAgentStatus, getAgentOfflineThresholdMs, summarizeAgentStatuses } from '../src/lib/agent-status.js'
import { checkAgentOffline, runAgentOfflineCheck } from '../src/services/agent-offline-check.js'

const now = new Date('2026-11-07T00:00:00Z')
const base = { enabled: true, status: 'online', lastSeenAt: now, lastReport: {} }
for (const value of [undefined, null, {}, [], true, '', '1.5', NaN, Infinity, 0]) {
  assert.equal(clampAgentHeartbeatIntervalSeconds(value), 30)
}
assert.equal(clampAgentHeartbeatIntervalSeconds(1), 5)
assert.equal(clampAgentHeartbeatIntervalSeconds(' 60 '), 60)
assert.equal(clampAgentHeartbeatIntervalSeconds(7200), 3600)
for (const [interval, threshold] of [[undefined, 120000], [60, 180000], [3600, 10800000]] as const) {
  const agent = { ...base, lastReport: { metrics: { heartbeatIntervalSeconds: interval } } }
  assert.equal(getAgentOfflineThresholdMs(agent), threshold)
  assert.equal(deriveAgentStatus({ ...agent, lastSeenAt: new Date(+now - threshold) }, now), 'online')
  assert.equal(deriveAgentStatus({ ...agent, lastSeenAt: new Date(+now - threshold - 1) }, now), 'offline')
}
const stale = { ...base, lastSeenAt: new Date(+now - 180001) }
assert.equal(deriveAgentStatus({ ...base, lastSeenAt: null }, now), 'offline')
assert.equal(deriveAgentStatus({ ...base, lastSeenAt: new Date(NaN) }, now), 'offline')
assert.equal(deriveAgentStatus({ ...stale, enabled: false }, now), 'online')
assert.equal(deriveAgentStatus({ ...base, status: 'offline' }, now), 'offline')
assert.equal(deriveAgentStatus({ ...base, status: 'disabled' }, now), 'disabled')
assert.deepEqual(summarizeAgentStatuses([base, stale, { ...stale, enabled: false }, { ...base, status: 'offline' }], now), { online: 1, stale: 2 })

const makeRow = () => ({ ...stale, id: 1, agentId: 'test-agent', updatedAt: new Date(+now - 200000) })
let row = makeRow()
let writes = 0
let beforeWrite = () => {}
const db = {
  hostAgent: {
    async findMany() {
      return row.enabled && row.status === 'online' ? [{ ...row }] : []
    },
    async updateMany({ where, data }: { where: Record<string, unknown>; data: { status: string } }) {
      beforeWrite()
      const matches = Object.entries(where).every(([key, value]) => {
        const current = row[key as keyof typeof row]
        return current instanceof Date && value instanceof Date ? +current === +value : current === value
      })
      if (!matches) return { count: 0 }
      writes += 1
      row.status = data.status
      return { count: 1 }
    }
  }
} as unknown as Pick<PrismaClient, 'hostAgent'>

assert.equal(await checkAgentOffline(db, now), 1)
assert.equal(await checkAgentOffline(db, now), 0)
assert.equal(writes, 1)
for (const race of ['heartbeat', 'disable', 'rotate', 'report'] as const) {
  row = makeRow()
  beforeWrite = () => {
    if (race === 'heartbeat') row.lastSeenAt = now
    if (race === 'disable') row.enabled = false
    if (race === 'rotate') row.agentId = 'rotated-agent'
    if (race === 'report') row.updatedAt = now
  }
  assert.equal(await checkAgentOffline(db, now), 0, race)
  assert.equal(row.status, 'online', race)
}
beforeWrite = () => {}
row = { ...makeRow(), lastSeenAt: null } as unknown as typeof row
assert.equal(await checkAgentOffline(db, now), 1)

let release: () => void = () => {}
let reads = 0
const blockedDb = { hostAgent: { async findMany() {
  reads += 1
  await new Promise<void>(resolve => { release = resolve })
  return []
} } } as unknown as Pick<PrismaClient, 'hostAgent'>
const running = runAgentOfflineCheck(blockedDb)
assert.equal(await runAgentOfflineCheck(blockedDb), 0)
assert.equal(reads, 1)
release()
await running
const failingDb = { hostAgent: { async findMany() { throw new Error('test failure') } } } as unknown as Pick<PrismaClient, 'hostAgent'>
await assert.rejects(runAgentOfflineCheck(failingDb), /test failure/)
row = makeRow()
assert.equal(await runAgentOfflineCheck(db), 1)

const route = readFileSync(new URL('../src/routes/agent.ts', import.meta.url), 'utf8')
const heartbeat = route.slice(route.indexOf("fastify.post<{ Body: AgentHeartbeatBody }>('/heartbeat'"))
assert.ok(route.includes("from '../lib/agent-status.js'"))
assert.equal((route.match(/status: deriveAgentStatus\(agent\)/g) ?? []).length, 2)
assert.ok(heartbeat.includes('agentModel.updateMany(') && heartbeat.includes('enabled: true'))
assert.ok(heartbeat.includes('lastSeenAt: { lte: now }') && heartbeat.includes('heartbeatResult.count !== 1'))
const scheduler = readFileSync(new URL('../src/services/status-scheduler.ts', import.meta.url), 'utf8')
assert.ok(scheduler.includes('runAgentOfflineCheck(prisma).catch('))
assert.ok(scheduler.indexOf('runAgentOfflineCheck(prisma)') > scheduler.indexOf("schedule('*/1 * * * *'"))
const statistics = readFileSync(new URL('../src/routes/admin-statistics.ts', import.meta.url), 'utf8')
assert.ok(statistics.includes('summarizeAgentStatuses(agents, now)'))
assert.ok(!statistics.includes('AGENT_STALE_MINUTES'))
console.log('agent status guard checks passed')
