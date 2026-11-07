export interface AgentStatusInput {
  enabled: boolean
  status: string
  lastSeenAt: Date | null
  lastReport: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function clampAgentHeartbeatIntervalSeconds(value: unknown): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN
  if (!Number.isSafeInteger(parsed) || !parsed) {
    return 30
  }
  return Math.min(3600, Math.max(5, parsed))
}

export function getAgentHeartbeatIntervalSeconds(agent: Pick<AgentStatusInput, 'lastReport'>): number {
  const report = agent.lastReport
  const metrics = isRecord(report) && isRecord(report.metrics) ? report.metrics : null
  return clampAgentHeartbeatIntervalSeconds(metrics?.heartbeatIntervalSeconds)
}

export function getAgentOfflineThresholdMs(agent: Pick<AgentStatusInput, 'lastReport'>): number {
  return Math.max(getAgentHeartbeatIntervalSeconds(agent) * 3, 120) * 1000
}

export function deriveAgentStatus(agent: AgentStatusInput, now = new Date()): string {
  if (!agent.enabled || agent.status !== 'online') {
    return agent.status
  }
  if (!agent.lastSeenAt || !Number.isFinite(agent.lastSeenAt.getTime())) {
    return 'offline'
  }
  return now.getTime() - agent.lastSeenAt.getTime() > getAgentOfflineThresholdMs(agent) ? 'offline' : 'online'
}

export function summarizeAgentStatuses(agents: AgentStatusInput[], now = new Date()): { online: number; stale: number } {
  const result = { online: 0, stale: 0 }
  for (const agent of agents) {
    if (!agent.enabled) continue
    if (deriveAgentStatus(agent, now) === 'online') result.online += 1
    else result.stale += 1
  }
  return result
}
