import type { FastifyInstance, FastifyRequest } from 'fastify'
import { prisma } from '../db/prisma.js'
import { subscribeInstanceMonitoring, type InstanceMonitoringStreamEvent } from '../lib/agent-monitoring-stream.js'
import { monitoringFreshnessMs, readAgentInstanceHistory, readAgentInstanceSnapshot } from '../services/agent-monitoring.js'
import { consumeMonitoringStreamAccessTicket, generateMonitoringStreamAccessTicket, inspectMonitoringStreamAccessTicket } from '../lib/action-ticket.js'
import { isAccessTokenInvalidated } from '../lib/security.js'

const positiveIdPattern = /^[1-9]\d*$/
function writeEvent(response: NodeJS.WritableStream, event: InstanceMonitoringStreamEvent): void {
  response.write(`data: ${JSON.stringify(event)}\n\n`)
}

export default async function agentMonitoringStreamRoutes(fastify: FastifyInstance) {
  fastify.get<{ Params: { instanceId: string } }>('/instances/:instanceId/monitoring/history', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const instanceId = Number(request.params.instanceId)
    if (!positiveIdPattern.test(request.params.instanceId) || !Number.isSafeInteger(instanceId) || instanceId > 2147483647) {
      return reply.code(400).send({ error: 'Invalid instance ID', code: 'INVALID_INSTANCE_ID' })
    }
    const instance = await prisma.instance.findUnique({
      where: { id: instanceId },
      select: { userId: true, hostId: true, incusId: true, name: true, status: true }
    })
    if (!instance || instance.status === 'deleted' || (instance.userId !== request.user.id && request.user.role !== 'admin')) {
      return reply.code(404).send({ error: 'Instance not found', code: 'INSTANCE_NOT_FOUND' })
    }
    const agent = await prisma.hostAgent.findUnique({ where: { hostId: instance.hostId }, select: { agentId: true } })
    const now = Date.now()
    const range = { from: now - 7 * 86400000, to: now, resolutionSeconds: 3600, limit: 169 }
    reply.header('Cache-Control', 'no-store')
    try {
      return {
        hostId: instance.hostId,
        ...readAgentInstanceHistory(
          agent?.agentId ?? null,
          range,
          instance.name,
          now,
          instance.incusId ?? undefined
        )
      }
    } catch (error) {
      request.log.warn({ error, instanceId }, 'Instance monitoring storage unavailable')
      return reply.code(503).send({ error: 'Monitoring storage unavailable', code: 'AGENT_MONITORING_UNAVAILABLE' })
    }
  })

  fastify.post<{ Params: { instanceId: string } }>('/instances/:instanceId/monitoring/stream-ticket', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    if (!positiveIdPattern.test(request.params.instanceId)) {
      return reply.code(400).send({ error: 'Invalid instance ID', code: 'INVALID_INSTANCE_ID' })
    }
    const instanceId = Number(request.params.instanceId)
    const instance = await prisma.instance.findUnique({
      where: { id: instanceId },
      select: { id: true, userId: true, status: true }
    })
    if (!instance || instance.status === 'deleted') return reply.code(404).send({ error: 'Instance not found', code: 'INSTANCE_NOT_FOUND' })
    if (instance.userId !== request.user.id && request.user.role !== 'admin') return reply.code(403).send({ error: 'Forbidden', code: 'FORBIDDEN' })
    if (!request.user.iat) return reply.code(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' })
    return {
      ticket: generateMonitoringStreamAccessTicket(request.user.id, instanceId, request.user.iat, request.user.sid),
      expiresIn: 30
    }
  })

  fastify.get<{ Params: { instanceId: string }; Querystring: { ticket?: string } }>('/instances/:instanceId/monitoring/stream', async (request: FastifyRequest<{ Params: { instanceId: string }; Querystring: { ticket?: string } }>, reply) => {
    if (!positiveIdPattern.test(request.params.instanceId)) {
      return reply.code(400).send({ error: 'Invalid instance ID', code: 'INVALID_INSTANCE_ID' })
    }
    const instanceId = Number(request.params.instanceId)
    const ticket = request.query.ticket
    if (!ticket) return reply.code(401).send({ error: 'Authentication ticket is required', code: 'UNAUTHORIZED' })
    const inspected = inspectMonitoringStreamAccessTicket(ticket, instanceId)
    if (!inspected.valid || !inspected.userId || !inspected.issuedAt) return reply.code(401).send({ error: inspected.error || 'Authentication failed', code: 'UNAUTHORIZED' })
    if (await isAccessTokenInvalidated(inspected.userId, inspected.issuedAt, inspected.sessionId)) return reply.code(401).send({ error: 'Session expired', code: 'SESSION_INVALIDATED' })
    const user = await prisma.user.findUnique({ where: { id: inspected.userId }, select: { role: true, status: true } })
    if (!user || user.status !== 'active') return reply.code(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' })
    const instance = await prisma.instance.findUnique({
      where: { id: instanceId },
      select: { id: true, userId: true, hostId: true, name: true, incusId: true, status: true }
    })
    if (!instance || instance.status === 'deleted') return reply.code(404).send({ error: 'Instance not found', code: 'INSTANCE_NOT_FOUND' })
    if (instance.userId !== inspected.userId && user.role !== 'admin') return reply.code(403).send({ error: 'Forbidden', code: 'FORBIDDEN' })
    const authResult = consumeMonitoringStreamAccessTicket(ticket, instanceId)
    if (!authResult.valid || !authResult.userId || !authResult.issuedAt) return reply.code(401).send({ error: authResult.error || 'Authentication failed', code: 'UNAUTHORIZED' })

    const agent = await prisma.hostAgent.findUnique({ where: { hostId: instance.hostId }, select: { agentId: true } })
    const snapshot = readAgentInstanceSnapshot(
      agent?.agentId ?? null,
      instance.name,
      Date.now(),
      instance.incusId ?? undefined
    )
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
      const age = sampledAt ? Math.max(0, Date.now() - Date.parse(sampledAt)) : monitoringFreshnessMs
      freshnessTimer = setTimeout(sendOffline, Math.max(0, monitoringFreshnessMs - age))
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
