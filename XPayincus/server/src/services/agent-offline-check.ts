import type { PrismaClient } from '@prisma/client'
import { deriveAgentStatus } from '../lib/agent-status.js'

let isCheckRunning = false

export async function runAgentOfflineCheck(db: Pick<PrismaClient, 'hostAgent'>): Promise<number> {
  if (isCheckRunning) return 0
  isCheckRunning = true
  try {
    return await checkAgentOffline(db)
  } finally {
    isCheckRunning = false
  }
}

export async function checkAgentOffline(db: Pick<PrismaClient, 'hostAgent'>, now = new Date()): Promise<number> {
  const agents = await db.hostAgent.findMany({
    where: { enabled: true, status: 'online' },
    select: { id: true, agentId: true, enabled: true, status: true, lastSeenAt: true, lastReport: true, updatedAt: true }
  })
  let changed = 0
  for (const agent of agents) {
    if (deriveAgentStatus(agent, now) !== 'offline') continue
    const result = await db.hostAgent.updateMany({
      where: {
        id: agent.id,
        agentId: agent.agentId,
        enabled: true,
        status: 'online',
        lastSeenAt: agent.lastSeenAt,
        updatedAt: agent.updatedAt
      },
      data: { status: 'offline' }
    })
    changed += result.count
  }
  return changed
}
