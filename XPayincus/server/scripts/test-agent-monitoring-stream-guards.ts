import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { subscribeInstanceMonitoring, getInstanceMonitoringSubscriberCount, publishInstanceMonitoring } from '../src/lib/agent-monitoring-stream.js'
import { consumeMonitoringStreamAccessTicket, generateMonitoringStreamAccessTicket, inspectMonitoringStreamAccessTicket } from '../src/lib/action-ticket.js'
import { ingestAgentMonitoring, matchAgentMonitoringInstances, monitoringInstanceScope, monitoringRetentionMs, publishAgentInstanceMonitoring, readManagedInstanceHistory, readManagedInstanceSnapshot, type InstancePoint } from '../src/services/agent-monitoring.js'
import { customerHostMetrics, publishCustomerHostRealtimePoint, readCustomerHostRealtimePoint } from '../src/services/customer-host-status.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const routeSource = readFileSync(join(root, 'src/routes/agent-monitoring-stream.ts'), 'utf8')
const appSource = readFileSync(join(root, 'src/app.ts'), 'utf8')
const directory = mkdtempSync(join(tmpdir(), 'agent-monitoring-stream-'))
const previousDirectory = process.env.INCUDAL_AGENT_STATE_DIR
process.env.INCUDAL_AGENT_STATE_DIR = directory

try {
  const hostStatus = routeSource.slice(routeSource.indexOf("'/host-status'"), routeSource.indexOf("'/instances/:instanceId/monitoring/history'"))
  assert.match(hostStatus, /onRequest: \[fastify\.authenticate\]/)
  assert.match(hostStatus, /const userId\s*=\s*request\.user\.id\b/)
  assert.match(hostStatus, /const ownInstance\s*=\s*\{\s*userId\s*,\s*status:\s*\{\s*not:\s*'deleted'\s+as const\s*,?\s*\}\s*,?\s*\}/)
  assert.match(hostStatus, /where:\s*\{\s*monitoringVisible:\s*true\s*,\s*OR:\s*\[\s*\{\s*userId\s*,?\s*\}\s*,\s*\{\s*instances:\s*\{\s*some:\s*ownInstance\s*,?\s*\}\s*,?\s*\}\s*,?\s*\]\s*,?\s*\}/)
  assert.match(hostStatus, /instances:\s*\{\s*where:\s*ownInstance\s*,/)
  assert.match(hostStatus, /packageHosts:\s*\{\s*where:\s*\{\s*package:\s*\{\s*userId\s*,?\s*\}\s*,?\s*\}/)
  assert.match(hostStatus, /Cache-Control', 'no-store'/)
  assert.doesNotMatch(hostStatus, /monitoringVisible:\s*host\./)
  assert.doesNotMatch(hostStatus, /select:\s*\{[^}]*monitoringVisible:/)
  assert.match(hostStatus, /displayName: customName/)
  assert.match(hostStatus, /category: host\.monitoringCategory/)
  assert.match(hostStatus, /countryCode: host\.countryCode/)
  assert.match(hostStatus, /max: 120, timeWindow: '1 minute'/)
  const hostNow = new Date()
  const hostAgent = {
    enabled: true, status: 'online', lastSeenAt: hostNow,
    lastReport: { resources: { cpuUsagePercent: 31, memoryUsagePercent: 50, diskUsagePercent: 101, swapUsagePercent: 0,
      hostRxBytesPerSecond: 321, hostTxBytesPerSecond: -1, cpuTotal: 8, memoryTotalMb: 16000 } }
  }
  assert.deepEqual(customerHostMetrics(hostAgent, hostNow), {
    sampledAt: hostNow.toISOString(), source: 'heartbeat', cpuPercent: 31, ramPercent: 50, diskPercent: null, swapPercent: 0,
    rxBytesPerSecond: 321, txBytesPerSecond: null
  })
  assert.deepEqual(customerHostMetrics(hostAgent, new Date(hostNow.getTime() + 121000)), customerHostMetrics(null, hostNow))
  assert.deepEqual(customerHostMetrics({ ...hostAgent, enabled: false }, hostNow), customerHostMetrics(null, hostNow))
  const realtimePoint = { agentId: 'agent-1', sampledAt: hostNow.getTime(), cpuPercent: 22, ramPercent: 44 }
  assert.equal(publishCustomerHostRealtimePoint(991, realtimePoint, hostNow.getTime()), true)
  assert.equal(publishCustomerHostRealtimePoint(991, { ...realtimePoint, sampledAt: realtimePoint.sampledAt - 1 }, hostNow.getTime()), false)
  assert.equal(readCustomerHostRealtimePoint(991, 'agent-1', hostNow.getTime())?.cpuPercent, 22)
  assert.equal(readCustomerHostRealtimePoint(991, 'different-agent', hostNow.getTime()), null)
  assert.equal(readCustomerHostRealtimePoint(991, 'agent-1', hostNow.getTime() + 15001), null)
  assert.equal(publishCustomerHostRealtimePoint(991, { ...realtimePoint, agentId: 'agent-2', sampledAt: hostNow.getTime() + 60000, rxBytesPerSecond: 0, txBytesPerSecond: 2048 }, hostNow.getTime()), true)
  assert.equal(readCustomerHostRealtimePoint(991, 'agent-1', hostNow.getTime()), null)
  assert.deepEqual(customerHostMetrics(hostAgent, hostNow, 991, 'agent-2'), {
    sampledAt: new Date(hostNow.getTime() + 60000).toISOString(), source: 'realtime', cpuPercent: 22, ramPercent: 44,
    diskPercent: null, swapPercent: null, rxBytesPerSecond: 0, txBytesPerSecond: 2048
  })
  assert.equal(customerHostMetrics(hostAgent, new Date(hostNow.getTime() + 15001), 991, 'agent-2').source, 'heartbeat')
  assert.equal(publishCustomerHostRealtimePoint(991, { ...realtimePoint, agentId: 'agent-2', sampledAt: hostNow.getTime() + 15001 }, hostNow.getTime() + 15001), true)

  const history = routeSource.slice(routeSource.indexOf("'/instances/:instanceId/monitoring/history'"), routeSource.indexOf("'/instances/:instanceId/monitoring/stream-ticket'"))
  assert.match(history, /onRequest: \[fastify\.authenticate\]/)
  assert.match(history, /instance\.userId !== request\.user\.id && request\.user\.role !== 'admin'/)
  assert.ok(history.indexOf('readManagedInstanceHistory(') > history.indexOf('instance.userId !== request.user.id'))
  assert.match(history, /from: now - 7 \* 86400000/)
  assert.match(history, /readManagedInstanceHistory\(instance\.host\.agent\?\.agentId \?\? null, range, instance, otherMonitoringIdentifiers\(instance\), now\)/)
  assert.ok(routeSource.includes("'/instances/:instanceId/monitoring/stream'"))
  assert.ok(routeSource.includes("'/instances/:instanceId/monitoring/stream-ticket'"))
  assert.ok(routeSource.includes("text/event-stream"))
  assert.ok(routeSource.includes('fastify.authenticate'))
  assert.ok(routeSource.includes('consumeMonitoringStreamAccessTicket(ticket, instanceId)'))
  assert.ok(routeSource.includes('inspectMonitoringStreamAccessTicket(ticket, instanceId)'))
  const streamOwnershipCheck = routeSource.indexOf('instance.userId !== inspected.userId')
  assert.ok(streamOwnershipCheck >= 0 && streamOwnershipCheck < routeSource.indexOf('consumeMonitoringStreamAccessTicket(ticket, instanceId)'))
  assert.ok(routeSource.includes('isAccessTokenInvalidated(inspected.userId, inspected.issuedAt, inspected.sessionId)'))
  assert.ok(routeSource.includes('instance.userId !== request.user.id'))
  assert.ok(routeSource.includes("type: 'offline'"))
  assert.ok(routeSource.includes("response.on('close'"))
  assert.match(routeSource, /readManagedInstanceSnapshot\(agentId, instance, otherMonitoringIdentifiers\(instance\)\)/)
  assert.match(routeSource, /subscribeInstanceMonitoring\(scope, onEvent\)/)
  assert.match(routeSource, /monitoringInstanceScope\(current\.host\.agent\?\.agentId \?\? null, current\) !== scope/)
  const streamRegistration = appSource.indexOf('fastify.register(agentMonitoringStreamRoutes')
  assert.ok(streamRegistration >= 0 && streamRegistration < appSource.indexOf('fastify.register(agentRoutes'))
  const agentRouteSource = readFileSync(join(root, 'src/routes/agent.ts'), 'utf8')
  const realtimeAuth = agentRouteSource.slice(agentRouteSource.indexOf('async function authenticateRealtimeAgentRequest'), agentRouteSource.indexOf('function normalizeRealtimeInstances'))
  assert.match(realtimeAuth, /request\.rawAgentBody && createHash\('sha256'\)\.update\(request\.rawAgentBody\)/)
  assert.doesNotMatch(realtimeAuth, /createAgentBodyHash|return reply/)
  for (const code of ['AGENT_AUTH_REQUIRED', 'AGENT_AUTH_INVALID', 'AGENT_AUTH_EXPIRED', 'AGENT_BODY_HASH_MISMATCH', 'AGENT_DISABLED', 'AGENT_SECRET_INVALID', 'AGENT_SIGNATURE_INVALID', 'AGENT_NONCE_REPLAY', 'AGENT_REALTIME_AUTH_UNAVAILABLE']) {
    assert.match(realtimeAuth, new RegExp(`code: '${code}'[^\\n]*\\n\\s*return null`))
  }
  assert.match(realtimeAuth, /if \(realtimeNonces\.size >= realtimeNonceLimit\)/)
  assert.match(agentRouteSource, /if \(!host\?\.isInstalled\).*code: 'AGENT_HOST_NOT_VERIFIED'/)
  const hostRealtimeRoute = agentRouteSource.slice(agentRouteSource.indexOf("'/monitoring/host-realtime'"), agentRouteSource.indexOf("'/monitoring/realtime'"))
  assert.match(hostRealtimeRoute, /authenticateRealtimeAgentRequest<AgentHostRealtimeBody>/)
  assert.match(hostRealtimeRoute, /bodyLimit: 2048/)
  assert.match(hostRealtimeRoute, /config: \{ rateLimit: \{/)
  assert.match(hostRealtimeRoute, /sampledAt >= now - 15000/)
  assert.match(hostRealtimeRoute, /publishCustomerHostRealtimePoint/)
  assert.match(appSource, /'\/api\/agent\/monitoring\/host-realtime'/)
  assert.ok(agentRouteSource.includes('const requestedFrom = request.query.from === undefined ? now - 86400000 : Date.parse(request.query.from)'))
  assert.ok(agentRouteSource.includes('const requestedTo = request.query.to === undefined ? now : Date.parse(request.query.to)'))
  assert.ok(agentRouteSource.includes('const from = Math.max(requestedFrom, now - 7 * 86400000)'))
  assert.ok(agentRouteSource.includes('const to = Math.min(requestedTo, now)'))
  assert.equal(monitoringRetentionMs, 7 * 86400000)

  const now = Date.now()
  const agentId = 'stream-fixture'
  const uuid = '11111111-1111-4111-8111-111111111111'
  const otherUuid = '22222222-2222-4222-8222-222222222222'
  const instance = { id: 42, hostId: 1, userId: 7, name: 'shared-label', incusId: 'u7-physical', createdAt: new Date(now - 3600000) }
  const neighbor = { ...instance, id: 43, userId: 8, incusId: 'u8-physical' }
  const legacy = { ...instance, id: 44, incusId: uuid }
  const rebuilt = { ...instance, incusId: 'u7-rebuilt' }
  const transfer = { ...instance, userId: 8, incusId: 'u8-transferred' }
  const reused = { ...instance, id: 45, userId: 8, createdAt: new Date(now - 500) }
  const remote = { ...instance, hostId: 2 }
  const point: InstancePoint = { name: instance.incusId, incusId: uuid, sampledAt: now - 1000, intervalSeconds: 60, metrics: { cpuUsagePercent: 25, rxBytes: 999, txBytes: 998 } }
  const nameOnly: InstancePoint = { name: point.name, sampledAt: now - 2000, intervalSeconds: 60, metrics: point.metrics }
  assert.deepEqual(matchAgentMonitoringInstances(1, [neighbor, remote, instance], [point, nameOnly]), [{ instance, point }])
  assert.deepEqual(matchAgentMonitoringInstances(1, [instance], [nameOnly]), [{ instance, point: nameOnly }])
  assert.deepEqual(matchAgentMonitoringInstances(1, [instance, neighbor], [{ ...point, name: instance.name }]), [])
  assert.deepEqual(matchAgentMonitoringInstances(1, [instance, legacy], [point]), [])
  assert.deepEqual(matchAgentMonitoringInstances(1, [instance, reused], [point]), [])
  assert.deepEqual(matchAgentMonitoringInstances(1, [remote, reused, rebuilt], [point]), [])
  const legacyPoint = { ...point, name: 'legacy-physical' }
  assert.deepEqual(matchAgentMonitoringInstances(1, [legacy], [legacyPoint]), [{ instance: legacy, point: legacyPoint }])
  assert.deepEqual(matchAgentMonitoringInstances(1, [legacy], [{ ...point, name: uuid, incusId: otherUuid }]), [])

  const payload = {
    schemaVersion: 2,
    samples: [{
      id: 'a'.repeat(32), sampledAt: new Date(point.sampledAt).toISOString(),
      instances: [point, nameOnly, { ...point, name: neighbor.incusId, incusId: otherUuid, metrics: { cpuUsagePercent: 90 } }]
        .map(value => ({ ...value, sampledAt: new Date(value.sampledAt).toISOString() }))
    }]
  }
  const persisted: InstancePoint[][] = []
  assert.deepEqual(ingestAgentMonitoring(agentId, payload, now, points => persisted.push(points)), ['a'.repeat(32)])
  assert.deepEqual(ingestAgentMonitoring(agentId, payload, now, points => persisted.push(points)), ['a'.repeat(32)])
  assert.equal(persisted.length, 1)
  assert.deepEqual(persisted[0]?.[0], point)
  const range = { from: now - 3600000, to: now, resolutionSeconds: 60, limit: 60 }
  const noConflicts = new Set<string>()
  assert.equal(readManagedInstanceHistory(agentId, range, instance, noConflicts, now).summary.cpuUsagePercent?.count, 2)
  assert.equal(readManagedInstanceHistory(agentId, range, neighbor, noConflicts, now).summary.cpuUsagePercent?.avg, 90)
  assert.equal(readManagedInstanceHistory(agentId, range, legacy, noConflicts, now).summary.cpuUsagePercent?.avg, 25)
  assert.deepEqual(readManagedInstanceHistory(agentId, range, legacy, new Set([instance.incusId]), now).buckets, [])
  assert.deepEqual(readManagedInstanceHistory(agentId, range, instance, new Set([instance.incusId]), now).buckets, [])
  assert.equal(readManagedInstanceSnapshot(agentId, legacy, new Set([instance.incusId]), now), null)
  assert.deepEqual(readManagedInstanceSnapshot(agentId, instance, noConflicts, now), { sampledAt: new Date(point.sampledAt).toISOString(), online: true, metrics: point.metrics })
  for (const isolated of [rebuilt, transfer, reused]) {
    assert.deepEqual(readManagedInstanceHistory(agentId, range, isolated, noConflicts, now).buckets, [])
    assert.equal(readManagedInstanceSnapshot(agentId, isolated, noConflicts, now), null)
  }
  assert.equal(readManagedInstanceSnapshot('other-agent', instance, noConflicts, now), null)
  assert.equal(readManagedInstanceSnapshot(agentId, instance, noConflicts, now + monitoringRetentionMs + 1), null)

  const scope = monitoringInstanceScope(agentId, instance)
  const events: unknown[] = []
  const unsubscribe = subscribeInstanceMonitoring(scope, event => events.push(event))
  assert.equal(getInstanceMonitoringSubscriberCount(scope), 1)
  const live = { ...point, sampledAt: now - 100, metrics: { cpuUsagePercent: 30 } }
  publishAgentInstanceMonitoring(agentId, instance, live, now)
  publishAgentInstanceMonitoring(agentId, instance, point, now)
  assert.equal(readManagedInstanceSnapshot(agentId, instance, noConflicts, now)?.metrics.cpuUsagePercent, 30)
  assert.equal(readManagedInstanceSnapshot(agentId, instance, new Set([uuid]), now)?.sampledAt, new Date(nameOnly.sampledAt).toISOString())
  for (const isolated of [neighbor, rebuilt, transfer, reused, { ...instance, userId: 8 }]) {
    publishAgentInstanceMonitoring(agentId, isolated, { ...live, name: isolated.incusId }, now)
  }
  publishAgentInstanceMonitoring('other-agent', remote, live, now)
  publishInstanceMonitoring(scope, { type: 'offline', online: false })
  assert.equal(events.length, 2)
  assert.deepEqual(events[1], { type: 'offline', online: false })
  unsubscribe()
  assert.equal(getInstanceMonitoringSubscriberCount(scope), 0)

  const ticket = generateMonitoringStreamAccessTicket(7, 42, 123, 'session-1')
  assert.deepEqual(consumeMonitoringStreamAccessTicket(ticket, 42), {
    valid: true,
    userId: 7,
    instanceId: 42,
    issuedAt: 123,
    sessionId: 'session-1'
  })
  assert.equal(consumeMonitoringStreamAccessTicket(ticket, 42).valid, false)
  const mismatchedTicket = generateMonitoringStreamAccessTicket(7, 42, 123)
  assert.equal(consumeMonitoringStreamAccessTicket(mismatchedTicket, 43).valid, false)
  assert.equal(inspectMonitoringStreamAccessTicket(mismatchedTicket, 42).valid, true)
  assert.equal(consumeMonitoringStreamAccessTicket(mismatchedTicket, 42).valid, true)

  console.log('agent monitoring stream guard tests passed')
} finally {
  if (previousDirectory === undefined) delete process.env.INCUDAL_AGENT_STATE_DIR
  else process.env.INCUDAL_AGENT_STATE_DIR = previousDirectory
  rmSync(directory, { recursive: true, force: true })
}
