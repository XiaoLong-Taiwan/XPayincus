import type { FastifyInstance, FastifyRequest } from 'fastify'
import { prisma } from '../db/prisma.js'
import { subscribeInstanceMonitoring, type InstanceMonitoringStreamEvent } from '../lib/agent-monitoring-stream.js'
import { monitoringFreshnessMs, monitoringInstanceScope, monitoringInstanceSelect, readManagedInstanceHistory, readManagedInstanceSnapshot } from '../services/agent-monitoring.js'
import { consumeMonitoringStreamAccessTicket, generateMonitoringStreamAccessTicket, inspectMonitoringStreamAccessTicket } from '../lib/action-ticket.js'
import { isAccessTokenInvalidated } from '../lib/security.js'
import { customerHostMetrics } from '../services/customer-host-status.js'

const positiveIdPattern = /^[1-9]\d*$/
const streamInstanceSelect = { ...monitoringInstanceSelect, status: true, host: { select: { agent: { select: { agentId: true } } } } } as const
const snapshotInstanceSelect = {
  ...streamInstanceSelect,
  host: { select: {
    ...streamInstanceSelect.host.select,
    instances: { where: { status: { not: 'deleted' } }, select: { id: true, incusId: true } }
  } }
} as const

function otherMonitoringIdentifiers(instance: { id: number; host: { instances: { id: number; incusId: string }[] } }): Set<string> {
  return new Set(instance.host.instances.filter(other => other.id !== instance.id).map(other => other.incusId))
}

function writeEvent(response: NodeJS.WritableStream, event: InstanceMonitoringStreamEvent): void {
  response.write(`data: ${JSON.stringify(event)}\n\n`)
}

export default async function agentMonitoringStreamRoutes(fastify: FastifyInstance) {
  fastify.get('/host-status', {
    onRequest: [fastify.authenticate],
    config: { rateLimit: { max: 120, timeWindow: '1 minute', keyGenerator: request => `host-status:${request.user.id}` } }
  }, async (request, reply) => {
    const userId = request.user.id
    const ownInstance = { userId, status: { not: 'deleted' as const } }
    const packageLabel = { id: true, name: true } as const
    const hosts = await prisma.host.findMany({
      where: { monitoringVisible: true, OR: [{ userId }, { instances: { some: ownInstance } }] },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        countryCode: true,
        monitoringDisplayName: true,
        monitoringCategory: true,
        agent: { select: { agentId: true, enabled: true, status: true, lastSeenAt: true, lastReport: true } },
        instances: { where: ownInstance, distinct: ['packageId'], select: { package: { select: packageLabel } } },
        packageHosts: { where: { package: { userId } }, select: { package: { select: packageLabel } } }
      }
    })
    const now = new Date()
    reply.header('Cache-Control', 'no-store')
    return {
      hosts: hosts.map(host => {
        const packages = new Map<number, { id: number; name: string }>()
        for (const row of [...host.packageHosts, ...host.instances]) {
          if (row.package) packages.set(row.package.id, row.package)
        }
        const metrics = customerHostMetrics(host.agent, now, host.id, host.agent?.agentId)
        const customName = host.monitoringDisplayName?.trim() || null
        return {
          id: host.id,
          displayName: customName,
          category: host.monitoringCategory?.trim() || null,
          countryCode: host.countryCode,
          packages: [...packages.values()],
          ...metrics
        }
      })
    }
  })

  fastify.get<{ Params: { instanceId: string } }>('/instances/:instanceId/monitoring/history', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const instanceId = Number(request.params.instanceId)
    if (!positiveIdPattern.test(request.params.instanceId) || !Number.isSafeInteger(instanceId) || instanceId > 2147483647) {
      return reply.code(400).send({ error: 'Invalid instance ID', code: 'INVALID_INSTANCE_ID' })
    }
    const instance = await prisma.instance.findUnique({
      where: { id: instanceId },
      select: { ...snapshotInstanceSelect, name: true }
    })
    if (!instance || instance.status === 'deleted' || (instance.userId !== request.user.id && request.user.role !== 'admin')) {
      return reply.code(404).send({ error: 'Instance not found', code: 'INSTANCE_NOT_FOUND' })
    }
    const now = Date.now()
    const range = { from: now - 7 * 86400000, to: now, resolutionSeconds: 3600, limit: 169 }
    reply.header('Cache-Control', 'no-store')
    try {
      return {
        hostId: instance.hostId,
        ...readManagedInstanceHistory(instance.host.agent?.agentId ?? null, range, instance, otherMonitoringIdentifiers(instance), now)
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
      select: snapshotInstanceSelect
    })
    if (!instance || instance.status === 'deleted') return reply.code(404).send({ error: 'Instance not found', code: 'INSTANCE_NOT_FOUND' })
    if (instance.userId !== inspected.userId && user.role !== 'admin') return reply.code(403).send({ error: 'Forbidden', code: 'FORBIDDEN' })
    const authResult = consumeMonitoringStreamAccessTicket(ticket, instanceId)
    if (!authResult.valid || !authResult.userId || !authResult.issuedAt) return reply.code(401).send({ error: authResult.error || 'Authentication failed', code: 'UNAUTHORIZED' })

    const agentId = instance.host.agent?.agentId ?? null
    const scope = monitoringInstanceScope(agentId, instance)
    const snapshot = readManagedInstanceSnapshot(agentId, instance, otherMonitoringIdentifiers(instance))
    const response = reply.raw
    reply.hijack()
    response.statusCode = 200
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    response.setHeader('Cache-Control', 'no-cache, no-store')
    response.setHeader('Connection', 'keep-alive')
    response.setHeader('X-Accel-Buffering', 'no')
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
    const unsubscribe = subscribeInstanceMonitoring(scope, onEvent)
    let checkingScope = false
    const heartbeat = setInterval(async () => {
      if (closed || checkingScope) return
      checkingScope = true
      try {
        const current = await prisma.instance.findUnique({ where: { id: instanceId }, select: streamInstanceSelect })
        if (closed) return
        if (!current || current.status === 'deleted' || monitoringInstanceScope(current.host.agent?.agentId ?? null, current) !== scope) {
          cleanup()
          response.end()
          return
        }
        response.write(': heartbeat\n\n')
      } catch (error) {
        request.log.warn({ error, instanceId }, 'Instance monitoring stream scope unavailable')
        if (!closed) {
          cleanup()
          response.end()
        }
      } finally {
        checkingScope = false
      }
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
