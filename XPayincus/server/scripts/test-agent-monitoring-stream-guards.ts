import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { subscribeInstanceMonitoring, getInstanceMonitoringSubscriberCount, publishInstanceMonitoring } from '../src/lib/agent-monitoring-stream.js'
import { ingestAgentMonitoring, readAgentInstanceSnapshot, monitoringRetentionMs } from '../src/services/agent-monitoring.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const routeSource = readFileSync(join(root, 'src/routes/agent-monitoring-stream.ts'), 'utf8')
const appSource = readFileSync(join(root, 'src/app.ts'), 'utf8')
const directory = mkdtempSync(join(tmpdir(), 'agent-monitoring-stream-'))
const previousDirectory = process.env.INCUDAL_AGENT_STATE_DIR
process.env.INCUDAL_AGENT_STATE_DIR = directory

try {
  assert.ok(routeSource.includes("'/instances/:instanceId/monitoring/stream'"))
  assert.ok(routeSource.includes("text/event-stream"))
  assert.ok(routeSource.includes('fastify.authenticate'))
  assert.ok(routeSource.includes('instance.userId !== request.user.id'))
  assert.ok(routeSource.includes("type: 'offline'"))
  assert.ok(routeSource.includes("response.on('close'"))
  assert.ok(appSource.indexOf("fastify.register(agentMonitoringStreamRoutes") < appSource.indexOf("fastify.register(agentRoutes"))
  assert.equal(monitoringRetentionMs, 7 * 86400000)

  const now = Date.now()
  const sampleId = 'a'.repeat(32)
  ingestAgentMonitoring('stream-fixture', {
    schemaVersion: 2,
    samples: [{
      id: sampleId,
      sampledAt: new Date(now - 1000).toISOString(),
      metrics: { heartbeatIntervalSeconds: 60 },
      instances: [{
        name: 'vm1',
        sampledAt: new Date(now - 1000).toISOString(),
        intervalSeconds: 60,
        metrics: { cpuUsagePercent: 25, memoryUsedBytes: 1024, rxBytesPerSecond: 128, txBytesPerSecond: 64, rxBytes: 999, txBytes: 998 }
      }]
    }]
  }, now)
  assert.deepEqual(readAgentInstanceSnapshot('stream-fixture', 'vm1', now), {
    sampledAt: new Date(now - 1000).toISOString(),
    online: true,
    metrics: { cpuUsagePercent: 25, memoryUsedBytes: 1024, rxBytesPerSecond: 128, txBytesPerSecond: 64 }
  })
  assert.equal(readAgentInstanceSnapshot('stream-fixture', 'vm1', now + monitoringRetentionMs + 1), null)

  const events: unknown[] = []
  const unsubscribe = subscribeInstanceMonitoring(42, event => events.push(event))
  assert.equal(getInstanceMonitoringSubscriberCount(42), 1)
  publishInstanceMonitoring(42, { sampledAt: new Date(now).toISOString(), online: true, metrics: { cpuUsagePercent: 25 } })
  publishInstanceMonitoring(42, { type: 'offline', online: false })
  assert.equal(events.length, 2)
  assert.deepEqual(events[1], { type: 'offline', online: false })
  unsubscribe()
  assert.equal(getInstanceMonitoringSubscriberCount(42), 0)

  console.log('agent monitoring stream guard tests passed')
} finally {
  if (previousDirectory === undefined) delete process.env.INCUDAL_AGENT_STATE_DIR
  else process.env.INCUDAL_AGENT_STATE_DIR = previousDirectory
  rmSync(directory, { recursive: true, force: true })
}
