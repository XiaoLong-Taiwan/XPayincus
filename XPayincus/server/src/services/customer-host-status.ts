import { deriveAgentStatus, type AgentStatusInput } from '../lib/agent-status.js'

export interface CustomerHostRealtimePoint {
  agentId: string
  sampledAt: number
  cpuPercent?: number
  ramPercent?: number
  diskPercent?: number
  swapPercent?: number
  rxBytesPerSecond?: number
  txBytesPerSecond?: number
}

const customerHostRealtimePoints = new Map<number, { point: CustomerHostRealtimePoint; receivedAt: number }>()
const customerHostRealtimeFreshnessMs = 15000
const customerHostRealtimeLimit = 10000

export function publishCustomerHostRealtimePoint(hostId: number, point: CustomerHostRealtimePoint, receivedAt: number): boolean {
  const previous = customerHostRealtimePoints.get(hostId)
  if (previous?.point.agentId === point.agentId && receivedAt - previous.receivedAt <= customerHostRealtimeFreshnessMs && point.sampledAt <= previous.point.sampledAt) return false
  customerHostRealtimePoints.delete(hostId)
  customerHostRealtimePoints.set(hostId, { point, receivedAt })
  while (customerHostRealtimePoints.size > customerHostRealtimeLimit) {
    customerHostRealtimePoints.delete(customerHostRealtimePoints.keys().next().value!)
  }
  return true
}

export function readCustomerHostRealtimePoint(hostId: number, agentId: string, now: number): CustomerHostRealtimePoint | null {
  const entry = customerHostRealtimePoints.get(hostId)
  return entry?.point.agentId === agentId && now - Math.min(entry.receivedAt, entry.point.sampledAt) <= customerHostRealtimeFreshnessMs
    ? entry.point
    : null
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function metric(value: unknown, upperBound = Infinity): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= upperBound ? value : null
}

export function customerHostMetrics(agent: AgentStatusInput | null, now: Date, hostId?: number, agentId?: string) {
  const realtime = hostId !== undefined && agentId && agent?.enabled
    ? readCustomerHostRealtimePoint(hostId, agentId, now.getTime())
    : null
  if (realtime) return {
    sampledAt: new Date(realtime.sampledAt).toISOString(),
    source: 'realtime' as const,
    cpuPercent: metric(realtime.cpuPercent, 100),
    ramPercent: metric(realtime.ramPercent, 100),
    diskPercent: metric(realtime.diskPercent, 100),
    swapPercent: metric(realtime.swapPercent, 100),
    rxBytesPerSecond: metric(realtime.rxBytesPerSecond),
    txBytesPerSecond: metric(realtime.txBytesPerSecond)
  }
  const fresh = agent?.enabled && agent.lastSeenAt && deriveAgentStatus(agent, now) === 'online' ? agent : null
  const resources = record(record(fresh?.lastReport).resources)
  const sampledAt = fresh?.lastSeenAt?.toISOString() ?? null
  return {
    sampledAt,
    source: sampledAt ? 'heartbeat' as const : null,
    cpuPercent: metric(resources.cpuUsagePercent, 100),
    ramPercent: metric(resources.memoryUsagePercent, 100),
    diskPercent: metric(resources.diskUsagePercent, 100),
    swapPercent: metric(resources.swapUsagePercent, 100),
    rxBytesPerSecond: metric(resources.hostRxBytesPerSecond),
    txBytesPerSecond: metric(resources.hostTxBytesPerSecond)
  }
}
