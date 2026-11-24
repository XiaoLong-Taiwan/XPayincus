import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const agentRouteSource = readFileSync(resolve(__dirname, '../src/routes/agent.ts'), 'utf8')

const parserStart = agentRouteSource.indexOf('function parsePositiveId(value: string): number | null')
assert.notEqual(parserStart, -1, 'Agent route positive ID parser not found')
const parserEnd = agentRouteSource.indexOf('function sanitizeShortString', parserStart)
assert.notEqual(parserEnd, -1, 'Agent route positive ID parser end marker not found')
const parserSection = agentRouteSource.slice(parserStart, parserEnd)

assert.ok(
  agentRouteSource.includes('const positiveRouteIdPattern = /^[1-9]\\d*$/'),
  'Agent route path IDs must use a strict positive integer regex'
)
assert.ok(
  parserSection.includes('positiveRouteIdPattern.test(value)') &&
    parserSection.includes('const id = Number(value)'),
  'Agent route path ID parser must reject malformed values before numeric conversion'
)
assert.ok(
  !parserSection.includes('Number.parseInt') && !parserSection.includes('parseInt'),
  'Agent route path ID parser must not use loose parseInt semantics'
)

const hostIdParseCount = (agentRouteSource.match(/parsePositiveId\(request\.params\.hostId\)/g) ?? []).length
assert.equal(
  hostIdParseCount,
  8,
  'all Agent host status/history/install/credential route IDs must use strict positive parsing'
)

const realtimeStart = agentRouteSource.indexOf("fastify.post<{ Body: AgentRealtimeBody }>('/monitoring/realtime'")
assert.notEqual(realtimeStart, -1, 'Agent realtime route not found')
const heartbeatStart = agentRouteSource.indexOf("fastify.post<{ Body: AgentHeartbeatBody }>('/heartbeat'")
assert.notEqual(heartbeatStart, -1, 'Agent heartbeat route not found')
const realtimeSection = agentRouteSource.slice(realtimeStart, heartbeatStart)
const heartbeatSection = agentRouteSource.slice(heartbeatStart)

const publisher = agentRouteSource.slice(agentRouteSource.indexOf('async function publishReportedInstanceMonitoring'), agentRouteSource.indexOf('export default async function agentRoutes'))
assert.match(publisher, /point\.incusId \? \[point\.name, point\.incusId\] : \[point\.name\]/)
assert.match(publisher, /where: \{ hostId: agent\.hostId, status: \{ not: 'deleted' \}, incusId: \{ in: identifiers \} \}/)
assert.match(publisher, /matchAgentMonitoringInstances\(agent\.hostId, instances, fresh\)/)
assert.match(realtimeSection, /await publishReportedInstanceMonitoring\(agent, points, now\)/)
const realtimeNormalizerStart = agentRouteSource.indexOf('function normalizeRealtimeInstances')
const realtimeNormalizerEnd = agentRouteSource.indexOf('\n}', realtimeNormalizerStart)
const realtimeNormalizer = agentRouteSource.slice(realtimeNormalizerStart, realtimeNormalizerEnd)
assert.ok(
  realtimeNormalizer.includes('const legacyInterval = raw.intervalSeconds') &&
    realtimeNormalizer.includes('body.intervalSeconds') &&
    realtimeNormalizer.includes(': 60') &&
    realtimeNormalizer.includes('intervalSeconds: pointInterval, metrics'),
  'realtime normalization must support legacy per-instance intervals and default missing intervals'
)
assert.match(realtimeNormalizer, /if \(body\.intervalSeconds !== undefined && intervalSeconds === null\) return null/)
assert.match(realtimeNormalizer, /if \(now - sampledAt > monitoringFreshnessMs\) continue/)
assert.match(heartbeatSection, /ingestAgentMonitoring\(agent\.agentId, request\.body\.monitoring, now\.getTime\(\), points => \{ persistedMonitoringPoints = points \}\)/)
assert.match(heartbeatSection, /await publishReportedInstanceMonitoring\(agent, persistedMonitoringPoints, now\.getTime\(\)\)/)

console.log('agent route ID guard tests passed')
