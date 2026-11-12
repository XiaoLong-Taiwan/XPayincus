import { readAgentMonitoringJournal, writeAgentMonitoringJournal } from './agent-durable-state.js'

const retentionMs = 30 * 86400000
const replayWindowMs = 8 * 86400000
const hostKeys = ['cpuTotal', 'cpuUsagePercent', 'memoryTotalMb', 'memoryAvailableMb', 'memoryUsedMb', 'memoryUsagePercent', 'swapTotalMb', 'swapUsedMb', 'swapUsagePercent', 'diskTotalBytes', 'diskUsedBytes', 'diskAvailableBytes', 'diskUsagePercent', 'processCount', 'load1', 'load5', 'load15', 'uptimeSeconds']
for (const resource of ['cpu', 'memory', 'io']) {
  for (const kind of ['some', 'full']) {
    for (const field of ['avg10', 'avg60', 'avg300', 'total']) hostKeys.push(`psi.${resource}.${kind}.${field}`)
  }
}
export const instanceMonitoringKeys = ['cpuUsagePercent', 'memoryUsedBytes', 'diskReadBytesPerSecond', 'diskWriteBytesPerSecond', 'diskIOBytesPerSecond'] as const
export type InstanceMonitoringMetric = typeof instanceMonitoringKeys[number]
export function isMonitoringInstanceName(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value)
}
interface Point { sampledAt: number; intervalSeconds: number; metrics: Record<string, number> }
interface MetricStats { min: number; max: number; avg: number; count: number; coverage: number }
interface CounterStats { first: number; last: number; delta: number; resetCount: number; count: number; coverage: number; unit: 'microseconds' }
interface InstancePoint extends Point { name: string }
interface Sample extends Point { id: string; instances: InstancePoint[] }
interface ComponentEvent { id: string; sampledAt: string; type: 'component-state'; components: Record<string, unknown> }
interface Journal { samples: Sample[]; events: ComponentEvent[]; receipts: Record<string, number>; truncated: boolean }
export interface MonitoringRange { from: number; to: number; resolutionSeconds: number; limit: number }

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function numbers(value: unknown, keys: readonly string[]): Record<string, number> {
  const object = record(value)
  return Object.fromEntries(keys.flatMap(key => {
    const number = object[key]
    if (typeof number !== 'number' || !Number.isFinite(number) || number < 0 || number > Number.MAX_SAFE_INTEGER) return []
    if (key.startsWith('psi.') && !key.endsWith('.total') && number > 100) return []
    return [[key, number]]
  }))
}

function semantic(value: unknown, depth = 0): unknown {
  if (depth > 10) return null
  if (Array.isArray(value)) return value.slice(0, 128).map(item => semantic(item, depth + 1)).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(record(value)).sort(([a], [b]) => a.localeCompare(b)).filter(([key]) => !['collectedAt', 'collectedAtUnix', 'observedAt', 'reportedAt', 'timestamp', 'source'].includes(key)).slice(0, 128).map(([key, child]) => [key, semantic(child, depth + 1)]))
  return typeof value === 'string' ? value.slice(0, 4096) : value
}

function load(agentId: string, now: number): Journal {
  const state = readAgentMonitoringJournal<Journal>(agentId) ?? { samples: [], events: [], receipts: {}, truncated: false }
  state.samples = state.samples.filter(item => item.sampledAt >= now - retentionMs)
  state.events = state.events.filter(item => Date.parse(item.sampledAt) >= now - retentionMs)
  state.receipts = Object.fromEntries(Object.entries(state.receipts).filter(([, at]) => at >= now - replayWindowMs))
  return state
}

export function ingestAgentMonitoring(agentId: string, payload: unknown, now = Date.now()): string[] {
  const envelope = record(payload)
  if (envelope.schemaVersion !== 2 || !Array.isArray(envelope.samples) || envelope.samples.length > 32 || Buffer.byteLength(JSON.stringify(payload)) > 400 * 1024) return []
  const state = load(agentId, now)
  const accepted: string[] = []
  let receiptCount = Object.keys(state.receipts).length
  const instanceSamples = new Set(state.samples.flatMap(sample => sample.instances.map(point => `${point.name}:${point.sampledAt}`)))
  const eventIds = new Set(state.events.map(event => event.id))
  for (const raw of envelope.samples) {
    const sample = record(raw)
    if (typeof sample.id !== 'string' || !/^[a-f0-9]{32}$/.test(sample.id) || typeof sample.sampledAt !== 'string') continue
    const sampledAt = Date.parse(sample.sampledAt)
    if (!Number.isFinite(sampledAt) || sampledAt > now + 60000) continue
    if (state.receipts[sample.id] !== undefined || sampledAt < now - replayWindowMs) { accepted.push(sample.id); continue }
    if (receiptCount >= 32768) continue
    const interval = record(sample.metrics).heartbeatIntervalSeconds
    const intervalSeconds = typeof interval === 'number' && Number.isInteger(interval) && interval >= 30 && interval <= 3600 ? interval : 60
    const instances: InstancePoint[] = []
    const seen = new Set<string>()
    if (Array.isArray(sample.instances) && sample.instances.length <= 500) {
      for (const rawInstance of sample.instances) {
        const instance = record(rawInstance)
        if (!isMonitoringInstanceName(instance.name) || seen.has(instance.name)) continue
        const time = typeof instance.sampledAt === 'string' ? Date.parse(instance.sampledAt) : NaN
        if (!Number.isFinite(time) || time > sampledAt + 60000 || time < sampledAt - 3600000) continue
        const identity = `${instance.name}:${time}`
        if (instanceSamples.has(identity)) continue
        instanceSamples.add(identity)
        seen.add(instance.name)
        const duration = instance.intervalSeconds
        const instanceInterval = typeof duration === 'number' && Number.isFinite(duration) && duration > 0 && duration <= 3600 ? duration : 0
        instances.push({ name: instance.name, sampledAt: time, intervalSeconds: instanceInterval, metrics: numbers(instance.metrics, instanceMonitoringKeys) })
      }
    }
    const metrics = { ...numbers(sample.resources, hostKeys), ...numbers(sample.metrics, hostKeys) }
    if (Object.keys(metrics).length > 0 || instances.length > 0) state.samples.push({ id: sample.id, sampledAt, intervalSeconds, metrics, instances })
    if (Array.isArray(sample.events) && sample.events.length <= 2) {
      for (const rawEvent of sample.events) {
        const event = record(rawEvent)
        if (event.type !== 'component-state') continue
        const id = typeof event.id === 'string' && /^[a-f0-9]{32}$/.test(event.id) ? event.id : sample.id
        const eventTime = typeof event.sampledAt === 'string' ? Date.parse(event.sampledAt) : sampledAt
        if (eventIds.has(id) || !Number.isFinite(eventTime) || eventTime > sampledAt + 60000 || eventTime < now - replayWindowMs) continue
        const source = record(event.components)
        const components = record(semantic(Object.fromEntries(['rfw', 'zfs'].filter(key => source[key] !== undefined).map(key => [key, source[key]]))))
        if (Buffer.byteLength(JSON.stringify(components)) > 128 * 1024) continue
        state.events.push({ id, sampledAt: new Date(eventTime).toISOString(), type: 'component-state', components })
        eventIds.add(id)
      }
    }
    state.receipts[sample.id] = sampledAt
    receiptCount++
    accepted.push(sample.id)
  }
  state.samples.sort((a, b) => a.sampledAt - b.sampledAt || a.id.localeCompare(b.id))
  state.events.sort((a, b) => Date.parse(a.sampledAt) - Date.parse(b.sampledAt) || a.id.localeCompare(b.id))
  let bytes = Buffer.byteLength(JSON.stringify(state.samples))
  while (bytes > 1536 * 1024 || state.samples.length > 8192) {
    bytes -= Buffer.byteLength(JSON.stringify(state.samples.shift())) + 1
    state.truncated = true
  }
  bytes = Buffer.byteLength(JSON.stringify(state.events))
  while (bytes > 256 * 1024 || state.events.length > 512) {
    bytes -= Buffer.byteLength(JSON.stringify(state.events.shift())) + 1
    state.truncated = true
  }
  writeAgentMonitoringJournal(agentId, state)
  return accepted
}

function coverage(points: Point[], from: number, to: number): number {
  if (to <= from) return 0
  const intervals = points.map(point => [Math.max(from, point.sampledAt - point.intervalSeconds * 1000), Math.min(to, point.sampledAt)] as const).filter(([a, b]) => b > a).sort(([a], [b]) => a - b)
  let end = from
  let covered = 0
  for (const [a, b] of intervals) { covered += Math.max(0, b - Math.max(a, end)); end = Math.max(end, b) }
  return Math.min(1, covered / (to - from))
}

export function aggregateMonitoring(points: Point[], from: number, to: number): Record<string, MetricStats> {
  const unique = [...new Map(points.filter(point => point.sampledAt >= from && point.sampledAt < to).map(point => [point.sampledAt, point])).values()]
  const keys = new Set(unique.flatMap(point => Object.keys(point.metrics).filter(key => !isPressureCounter(key))))
  return Object.fromEntries([...keys].sort().map(key => {
    const available = unique.filter(point => point.metrics[key] !== undefined)
    const values = available.map(point => point.metrics[key]!)
    const sum = values.reduce((total, value) => total + value, 0)
    return [key, { min: Math.min(...values), max: Math.max(...values), avg: sum / values.length, count: values.length, coverage: coverage(available, from, to) }]
  }))
}

function isPressureCounter(key: string): boolean {
  return /^psi\.(cpu|memory|io)\.(some|full)\.total$/.test(key)
}

export function aggregateMonitoringCounters(points: Point[], from: number, to: number): Record<string, CounterStats> {
  const unique = [...new Map(points.filter(point => point.sampledAt >= from && point.sampledAt < to).map(point => [point.sampledAt, point])).values()].sort((a, b) => a.sampledAt - b.sampledAt)
  const keys = new Set(unique.flatMap(point => Object.keys(point.metrics).filter(isPressureCounter)))
  return Object.fromEntries([...keys].sort().map(key => {
    const available = unique.filter(point => point.metrics[key] !== undefined)
    const intervals: Point[] = []
    let delta = 0
    let resetCount = 0
    for (let index = 1; index < available.length; index++) {
      const before = available[index - 1]!
      const after = available[index]!
      const elapsed = (after.sampledAt - before.sampledAt) / 1000
      const reboot = before.metrics.uptimeSeconds !== undefined && after.metrics.uptimeSeconds !== undefined && after.metrics.uptimeSeconds < before.metrics.uptimeSeconds
      if (reboot || after.metrics[key]! < before.metrics[key]!) { resetCount++; continue }
      if (elapsed <= 0 || elapsed > 3600) continue
      delta += after.metrics[key]! - before.metrics[key]!
      intervals.push({ ...after, intervalSeconds: elapsed })
    }
    return [key, { first: available[0]!.metrics[key]!, last: available[available.length - 1]!.metrics[key]!, delta, resetCount, count: available.length, coverage: coverage(intervals, from, to), unit: 'microseconds' as const }]
  }))
}

export function readAgentMonitoring(agentId: string | null, range: MonitoringRange, now = Date.now()) {
  const state = agentId ? load(agentId, now) : { samples: [] as Sample[], events: [], truncated: false }
  return monitoringHistory(state.samples, range, state.truncated, now)
}

function monitoringHistory(samples: Point[], range: MonitoringRange, truncated: boolean, now: number) {
  const from = Math.max(range.from, now - retentionMs)
  const to = Math.min(range.to, now)
  const points = [...new Map(samples.filter(point => point.sampledAt >= from && point.sampledAt < to).map(point => [point.sampledAt, point])).values()]
  const buckets = new Map<number, Point[]>()
  const resolution = range.resolutionSeconds * 1000
  for (const point of points) {
    const start = Math.floor(point.sampledAt / resolution) * resolution
    const values = buckets.get(start) ?? []
    values.push(point); buckets.set(start, values)
  }
  return {
    schemaVersion: 2, retentionDays: 30, capacityTruncated: truncated,
    from: new Date(from).toISOString(), to: new Date(to).toISOString(), resolutionSeconds: range.resolutionSeconds,
    summary: aggregateMonitoring(points, from, to),
    summaryCounters: aggregateMonitoringCounters(points, from, to),
    buckets: [...buckets].sort(([a], [b]) => a - b).slice(-range.limit).map(([start, values]) => ({
      from: new Date(Math.max(from, start)).toISOString(), to: new Date(Math.min(to, start + resolution)).toISOString(),
      metrics: aggregateMonitoring(values, Math.max(from, start), Math.min(to, start + resolution)),
      counters: aggregateMonitoringCounters(values, Math.max(from, start), Math.min(to, start + resolution))
    })),
    bucketsTruncated: buckets.size > range.limit
  }
}

export function readAgentInstanceHistory(agentId: string | null, range: MonitoringRange, name: string, now = Date.now()) {
  if (!isMonitoringInstanceName(name)) throw new Error('Invalid monitoring instance name')
  const state = agentId ? load(agentId, now) : { samples: [] as Sample[], truncated: false }
  const points = state.samples.flatMap(sample => sample.instances.filter(point => point.name === name))
  return { name, ...monitoringHistory(points, range, state.truncated, now) }
}

export function readAgentInstanceTop(agentId: string | null, range: MonitoringRange, metric: InstanceMonitoringMetric, orderBy: 'avg' | 'max', top: number, now = Date.now()) {
  const state = agentId ? load(agentId, now) : { samples: [] as Sample[], truncated: false }
  const from = Math.max(range.from, now - retentionMs)
  const to = Math.min(range.to, now)
  const groups = new Map<string, InstancePoint[]>()
  for (const sample of state.samples) for (const point of sample.instances) {
    if (point.sampledAt < from || point.sampledAt >= to) continue
    const points = groups.get(point.name) ?? []
    points.push(point); groups.set(point.name, points)
  }
  const items = [...groups].flatMap(([name, points]) => {
    const stats = aggregateMonitoring(points, from, to)[metric]
    return stats ? [{ name, ...stats }] : []
  }).sort((a, b) => b[orderBy] - a[orderBy] || a.name.localeCompare(b.name)).slice(0, top)
  return { schemaVersion: 2, from: new Date(from).toISOString(), to: new Date(to).toISOString(), metric, orderBy, top, capacityTruncated: state.truncated, items }
}

export function readAgentComponentEvents(agentId: string | null, range: MonitoringRange, now = Date.now()) {
  const state = agentId ? load(agentId, now) : { events: [], truncated: false }
  const events = state.events.filter((event, index, events) => index === 0 || JSON.stringify(event.components) !== JSON.stringify(events[index - 1]!.components))
    .filter(event => Date.parse(event.sampledAt) >= range.from && Date.parse(event.sampledAt) < range.to)
  return { schemaVersion: 2, from: new Date(range.from).toISOString(), to: new Date(range.to).toISOString(), capacityTruncated: state.truncated, eventsTruncated: events.length > range.limit, events: events.slice(-range.limit) }
}
