import { prisma } from '../db/prisma.js'
import { cleanupAgentMonitoring } from './agent-monitoring.js'

export async function cleanupAgentMonitoringRetention(now = Date.now()): Promise<number> {
  const agents = await prisma.hostAgent.findMany({ select: { agentId: true } })
  let cleaned = 0
  for (const agent of agents) {
    if (cleanupAgentMonitoring(agent.agentId, now)) cleaned++
  }
  return cleaned
}

export function startAgentMonitoringCleanup(): NodeJS.Timeout {
  const run = () => {
    void cleanupAgentMonitoringRetention().catch(() => undefined)
  }
  run()
  return setInterval(run, 24 * 60 * 60 * 1000)
}
