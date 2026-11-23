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

assert.ok(
  realtimeSection.includes('...(reportedIds.length > 0 ? [{ incusId: { in: reportedIds } }] : [])') &&
    realtimeSection.includes('...(reportedNames.length > 0 ? [{ name: { in: reportedNames } }] : [])'),
  'realtime lookup must separate stable IDs from legacy names'
)
assert.ok(
  !realtimeSection.includes('{ incusId: { in: reportedNames } }'),
  'realtime name-only lookup must not query instance IDs'
)
assert.ok(
  realtimeSection.includes('const byIncusId = new Map(instances.map(instance => [instance.incusId, instance]))') &&
    realtimeSection.includes('byLegacyName.set(instance.name, instance)') &&
    !realtimeSection.includes('byLegacyName.set(instance.incusId, instance)'),
  'realtime mapping must use exact ID matching and name-only legacy fallback'
)
assert.ok(
  realtimeSection.includes('point.incusId ? byIncusId.get(point.incusId) : byLegacyName.get(point.name)'),
  'realtime payloads with IDs must not fall back to names'
)
assert.ok(
  heartbeatSection.includes('...(reportedIds.length ? [{ incusId: { in: reportedIds } }] : [])') &&
    heartbeatSection.includes('...(reportedNames.length ? [{ name: { in: reportedNames } }] : [])'),
  'heartbeat lookup must separate stable IDs from legacy names'
)
assert.ok(
  !heartbeatSection.includes('{ incusId: { in: reportedNames } }') &&
    heartbeatSection.includes("item.incusId ? item.incusId === instance.incusId : item.name === instance.name") &&
    !heartbeatSection.includes('item.name === instance.incusId'),
  'heartbeat mapping must use exact ID matching and name-only legacy fallback'
)

console.log('agent route ID guard tests passed')
