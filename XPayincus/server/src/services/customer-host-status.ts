import { deriveAgentStatus, type AgentStatusInput } from '../lib/agent-status.js'

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function metric(value: unknown, upperBound = Infinity): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= upperBound ? value : null
}

export function customerHostMetrics(agent: AgentStatusInput | null, now: Date) {
  const fresh = agent?.enabled && agent.lastSeenAt && deriveAgentStatus(agent, now) === 'online' ? agent : null
  const resources = record(record(fresh?.lastReport).resources)
  return {
    sampledAt: fresh?.lastSeenAt?.toISOString() ?? null,
    cpuPercent: metric(resources.cpuUsagePercent, 100),
    ramPercent: metric(resources.memoryUsagePercent, 100),
    diskPercent: metric(resources.diskUsagePercent, 100),
    swapPercent: metric(resources.swapUsagePercent, 100),
    rxBytesPerSecond: metric(resources.hostRxBytesPerSecond),
    txBytesPerSecond: metric(resources.hostTxBytesPerSecond)
  }
}
