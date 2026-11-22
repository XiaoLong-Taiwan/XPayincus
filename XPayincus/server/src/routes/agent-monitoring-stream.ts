import type { FastifyInstance, FastifyRequest } from 'fastify'
import { prisma } from '../db/prisma.js'
import { subscribeInstanceMonitoring, type InstanceMonitoringStreamEvent } from '../lib/agent-monitoring-stream.js'
import { readAgentInstanceSnapshot } from '../services/agent-monitoring.js'

const positiveIdPattern = /^[1-9]\d*$/
const freshnessMs = 45 * 1000

function writeEvent(response: NodeJS.WritableStream, event: InstanceMonitoringStreamEvent): void {
  response.write(`data: ${JSON.stringify(event)}\n\n`)
}

export default async function agentMonitoringStreamRoutes(fastify: FastifyInstance) {
  fastify.get<{ Params: { instanceId: string }; Querystring: { token?: string } }>('/instances/:instanceId/monitoring/stream', async (request: FastifyRequest<{ Params: { instanceId: string }; Querystring: { token?: string } }>, reply) => {
    const token = request.query.token
    if (typeof token === 'string' && token.length > 0) {
      request.headers.authorization = `Bearer ${token}`
    }
    await fastify.authenticate(request, reply)
    if (reply.sent) return

    if (!positiveIdPattern.test(request.params.instanceId)) {
      return reply.code(400).send({ error: 'Invalid instance ID', code: 'INVALID_INSTANCE_ID' })
    }
    const instanceId = Number(request.params.instanceId)
    const instance = await prisma.instance.findUnique({
      where: { id: instanceId },
      select: { id: true, userId: true, hostId: true, name: true, status: true }
    })
    if (!instance || instance.status === 'deleted') return reply.code(404).send({ error: 'Instance not found', code: 'INSTANCE_NOT_FOUND' })
    if (instance.userId !== request.user.id && request.user.role !== 'admin') return reply.code(403).send({ error: 'Forbidden', code: 'FORBIDDEN' })

    const agent = await prisma.hostAgent.findUnique({ where: { hostId: instance.hostId }, select: { agentId: true } })
    const snapshot = readAgentInstanceSnapshot(agent?.agentId ?? null, instance.name)
    const response = reply.raw
    reply.hijack()
    response.statusCode = 200
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    response.setHeader('Cache-Control', 'no-cache, no-store')
    response.setHeader('Connection', 'keep-alive')
    response.flushHeaders?.()

    let closed = false
    let freshnessTimer: NodeJS.Timeout | null = null
    const sendOffline = () => {
      if (!closed) writeEvent(response, { type: 'offline', online: false })
    }
    const scheduleFreshness = (sampledAt?: string) => {
      if (freshnessTimer) clearTimeout(freshnessTimer)
      const age = sampledAt ? Math.max(0, Date.now() - Date.parse(sampledAt)) : freshnessMs
      freshnessTimer = setTimeout(sendOffline, Math.max(0, freshnessMs - age))
    }
    const onEvent = (event: InstanceMonitoringStreamEvent) => {
      if (closed) return
      writeEvent(response, event)
      if ('sampledAt' in event) scheduleFreshness(event.sampledAt)
    }
    const unsubscribe = subscribeInstanceMonitoring(instanceId, onEvent)
    const heartbeat = setInterval(() => {
      if (!closed) response.write(': heartbeat\n\n')
    }, 15000)
    const cleanup = () => {
      if (closed) return
      closed = true
      clearInterval(heartbeat)
      if (freshnessTimer) clearTimeout(freshnessTimer)
      unsubscribe()
    }
    response.on('close', cleanup)
    response.on('error', cleanup)
    if (snapshot) {
      writeEvent(response, snapshot)
      scheduleFreshness(snapshot.sampledAt)
    } else {
      sendOffline()
      scheduleFreshness()
    }
  })
}
