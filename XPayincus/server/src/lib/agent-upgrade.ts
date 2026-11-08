import { compareReleaseTags, isValidReleaseTag } from './system-version.js'

export function agentVersionStatus(current: string | null, latest: string | null): 'latest' | 'outdated' | 'unknown' {
  if (!current || !latest || !isValidReleaseTag(current) || !isValidReleaseTag(latest)) return 'unknown'
  return compareReleaseTags(latest, current) > 0 ? 'outdated' : 'latest'
}

export interface AuthorizedAgentUpgrade {
  available: boolean
  version?: string
  url?: string
  sha256?: string
  size?: number
  gzip?: boolean
  schemaVersion?: number
  minimumUpdaterVersion?: string
  platform?: string
  arch?: string
}

export interface AgentUpgradeState {
  targetVersion: string
  requestedAt: string
  expiresAt: string
  deliveredAt: string | null
  status: 'pending' | 'delivered' | 'succeeded' | 'unconfirmed'
}

export class AgentUpgradeRequests {
  private requests = new Map<string, { state: AgentUpgradeState; instruction: AuthorizedAgentUpgrade }>()

  get(agentId: string, now = Date.now()): AgentUpgradeState | null {
    const entry = this.requests.get(agentId)
    if (!entry) return null
    if (now > Date.parse(entry.state.expiresAt) && ['pending', 'delivered'].includes(entry.state.status)) {
      entry.state.status = 'unconfirmed'
    }
    return { ...entry.state }
  }

  request(agentId: string, instruction: AuthorizedAgentUpgrade, heartbeatSeconds: number, now = Date.now()): AgentUpgradeState {
    const existing = this.get(agentId, now)
    if (existing && ['pending', 'delivered'].includes(existing.status)) return existing
    if (!instruction.available || !instruction.version || !instruction.url || !instruction.sha256) throw new Error('Invalid Agent upgrade authorization')
    for (const [key, entry] of this.requests) {
      if (now > Date.parse(entry.state.expiresAt) + 86400000) this.requests.delete(key)
    }
    if (this.requests.size >= 10000 && !this.requests.has(agentId)) throw new Error('Agent upgrade request capacity reached')
    const state: AgentUpgradeState = {
      targetVersion: instruction.version,
      requestedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + (heartbeatSeconds * 2 + 1200) * 1000).toISOString(),
      deliveredAt: null,
      status: 'pending'
    }
    this.requests.set(agentId, { state, instruction: { ...instruction } })
    return { ...state }
  }

  heartbeat(agentId: string, current: string | undefined, runtime: Record<string, unknown>, now = Date.now()): AuthorizedAgentUpgrade {
    const state = this.get(agentId, now)
    const entry = this.requests.get(agentId)
    if (!state || !entry || !current || !isValidReleaseTag(current)) return { available: false }
    if (entry.state.deliveredAt && compareReleaseTags(current, state.targetVersion) >= 0) {
      entry.state.status = 'succeeded'
      return { available: false }
    }
    if (state.status !== 'pending' || compareReleaseTags(state.targetVersion, current) <= 0 ||
      runtime.goos !== entry.instruction.platform || runtime.goarch !== entry.instruction.arch) return { available: false }
    entry.state.status = 'delivered'
    entry.state.deliveredAt = new Date(now).toISOString()
    return { ...entry.instruction }
  }
}
