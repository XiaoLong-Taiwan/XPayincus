import type { HostAgentStatus } from '@/types/api'

export function agentStatusRefreshSeconds(agent: HostAgentStatus | null): number {
  const seconds = agent?.lastReport?.metrics?.heartbeatIntervalSeconds
  return typeof seconds === 'number' && Number.isSafeInteger(seconds) && seconds >= 5 && seconds <= 3600
    ? seconds
    : 30
}

export function agentStatusIndicator(agent: HostAgentStatus | null) {
  if (!agent) return { key: 'admin.hosts.agentNotInstalled', dot: 'bg-gray-500' }
  if (!agent.enabled) return { key: 'admin.hosts.agentDisabled', dot: 'bg-amber-500' }
  if (agent.status === 'online') return { key: 'admin.hosts.agentOnline', dot: 'bg-green-500' }
  if (agent.status === 'offline') return { key: 'admin.hosts.agentOffline', dot: 'bg-rose-500' }
  return { key: 'admin.hosts.agentUnknown', dot: 'bg-gray-500' }
}
