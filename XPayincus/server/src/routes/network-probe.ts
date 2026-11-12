import type { FastifyInstance } from 'fastify'
import { isIP } from 'node:net'
import { prisma } from '../db/prisma.js'
import { invalidateCachedConfigs } from '../lib/config-cache.js'
import { apiError, ErrorCode } from '../lib/errors.js'
import { logAdminAction } from '../lib/security.js'
import { isAllowedProbeRecord, networkProbeRecords, NETWORK_PROBE_RECORD_LIMIT, NETWORK_PROBE_RETENTION_DAYS, type ProbeRecordInput } from '../lib/network-probe-records.js'
import { checkNetworkProbeRateLimit, getNetworkProbeTargets, NETWORK_PROBE_CONFIG_KEY, parseNetworkProbeTargets, resolvePublicTargetHost, runNetworkProbe } from '../lib/network-probe.js'

const scopeProperties = { packageId: { type: 'integer', minimum: 1, maximum: 2147483647 }, hostId: { type: 'integer', minimum: 1, maximum: 2147483647 } }

async function canAccessNode(userId: number, packageId: number, hostId: number) {
  return !!(await prisma.package.findFirst({
    where: { id: packageId, active: true, OR: [{ userId }, { globalShared: true }, { shares: { some: { sharedToId: userId } } }], packageHosts: { some: { hostId } } },
    select: { id: true }
  }))
}

export default async function networkProbeRoutes(fastify: FastifyInstance) {
  fastify.get<{ Querystring: { packageId: number; hostId: number } }>('/records', {
    onRequest: [fastify.authenticateUser],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: { querystring: { type: 'object', additionalProperties: false, required: ['packageId', 'hostId'], properties: scopeProperties } }
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const { packageId, hostId } = request.query
    if (!(await canAccessNode(request.user.id, packageId, hostId))) return reply.code(404).send({ error: '商品節點不存在或未獲授權' })
    return { records: await networkProbeRecords.list(request.user.id, packageId, hostId), limit: NETWORK_PROBE_RECORD_LIMIT, retentionDays: NETWORK_PROBE_RETENTION_DAYS }
  })

  fastify.post<{ Body: ProbeRecordInput }>('/records', {
    onRequest: [fastify.authenticateUser],
    bodyLimit: 8192,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: { body: {
      type: 'object', additionalProperties: false,
      required: ['packageId', 'hostId', 'targetId', 'source', 'method', 'measuredAt', 'samples'],
      properties: {
        ...scopeProperties,
        targetId: { type: 'string', pattern: '^[a-z0-9_-]{1,40}$' },
        source: { type: 'string', enum: ['browser', 'manual-local'] },
        method: { type: 'string', enum: ['https', 'tcp', 'icmp'] },
        port: { type: 'integer', minimum: 1, maximum: 65535 },
        measuredAt: { type: 'string', format: 'date-time', maxLength: 40 },
        acknowledgedUnverified: { type: 'boolean' },
        samples: { type: 'array', minItems: 1, maxItems: 10, items: {
          type: 'object', additionalProperties: false, required: ['durationMs', 'success'],
          properties: { durationMs: { type: 'number', minimum: 0, maximum: 60000 }, success: { type: 'boolean' } }
        } }
      }
    } }
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    if (!checkNetworkProbeRateLimit(`record:${request.user.id}`)) return reply.code(429).send({ error: '紀錄寫入過於頻繁' })
    const input = request.body
    if (!(await canAccessNode(request.user.id, input.packageId, input.hostId))) return reply.code(404).send({ error: '商品節點不存在或未獲授權' })
    const target = (await getNetworkProbeTargets()).find(item => item.id === input.targetId && item.packageId === input.packageId && item.hostId === input.hostId)
    if (!target || !isAllowedProbeRecord(input, target) || !(await resolvePublicTargetHost(target.host))) return reply.code(400).send({ error: '目標、方式、時間或未驗證聲明無效' })
    return reply.code(201).send({ record: await networkProbeRecords.create(request.user.id, input, target) })
  })

  fastify.get<{ Querystring: { packageId: number; hostId: number } }>('/targets', {
    onRequest: [fastify.authenticateUser],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: { querystring: { type: 'object', additionalProperties: false, required: ['packageId', 'hostId'], properties: scopeProperties } }
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const { packageId, hostId } = request.query
    if (!(await canAccessNode(request.user.id, packageId, hostId))) return reply.code(404).send({ error: '商品節點不存在或未獲授權' })
    const configured = await getNetworkProbeTargets()
    const targets = []
    for (const target of configured) {
      if (target.packageId === packageId && target.hostId === hostId && await resolvePublicTargetHost(target.host)) targets.push(target)
    }
    return { targets }
  })

  fastify.post<{ Body: { packageId: number; hostId: number; targetId: string } }>('/prepare', {
    onRequest: [fastify.authenticateUser],
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    schema: { body: { type: 'object', additionalProperties: false, required: ['packageId', 'hostId', 'targetId'], properties: { ...scopeProperties, targetId: { type: 'string', pattern: '^[a-z0-9_-]{1,40}$' } } } }
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    if (!checkNetworkProbeRateLimit(`user:${request.user.id}`)) return reply.code(429).send({ error: '每位使用者每分鐘最多測試 5 次' })
    const { packageId, hostId, targetId } = request.body
    if (!(await canAccessNode(request.user.id, packageId, hostId))) return reply.code(404).send({ error: '商品節點不存在或未獲授權' })
    const target = (await getNetworkProbeTargets()).find(item => item.id === targetId && item.packageId === packageId && item.hostId === hostId)
    const address = target ? await resolvePublicTargetHost(target.host) : null
    if (!target || !address) return reply.code(400).send({ error: '目標未獲核准或 DNS 非公開位址' })
    return { target, address, httpsUrl: target.https ? `https://${target.host}/.well-known/network-probe` : null }
  })

  fastify.post<{ Body: { targetId: string; method: 'tcp' | 'icmp'; port?: number } }>('/test', {
    onRequest: [fastify.authenticateAdmin],
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    schema: { body: { type: 'object', additionalProperties: false, required: ['targetId', 'method'], properties: { targetId: { type: 'string', pattern: '^[a-z0-9_-]{1,40}$' }, method: { type: 'string', enum: ['tcp', 'icmp'] }, port: { type: 'integer', minimum: 1, maximum: 65535 } } } }
  }, async (request, reply) => {
    const userId = request.user?.id !== undefined ? String(request.user.id) : request.ip
    if (!checkNetworkProbeRateLimit(userId)) return reply.code(429).send({ error: '每位使用者每分鐘最多測試 5 次' })
    const { targetId, method, port } = request.body
    const target = (await getNetworkProbeTargets()).find(item => item.id === targetId)
    if (!target || (method === 'icmp' && !target.icmp) || (method === 'tcp' && (!port || !target.tcpPorts.includes(port)))) return reply.code(400).send({ error: '測試目標或方式未獲管理員允許' })
    if (!(await resolvePublicTargetHost(target.host))) return reply.code(400).send({ error: '目標目前解析至非公開位址或 DNS 不可用' })
    return { source: 'panel-api', results: [await runNetworkProbe(target, method, port)] }
  })

  fastify.put<{ Body: { targets: unknown } }>('/manage-targets', {
    onRequest: [fastify.authenticateAdmin],
    schema: { body: { type: 'object', additionalProperties: false, required: ['targets'], properties: { targets: { type: 'array', maxItems: 30 } } } }
  }, async (request, reply) => {
    const targets = parseNetworkProbeTargets(request.body.targets)
    if (!targets) return reply.code(400).send(apiError(ErrorCode.CONFIG_INVALID_VALUE, 'network_probe_targets'))
    for (const target of targets) {
      if (isIP(target.host) || !(await resolvePublicTargetHost(target.host))) return reply.code(400).send({ error: `目標 ${target.label} 必須是解析至公開 IP 的 DNS hostname` })
      if (!(await prisma.packageHost.findUnique({ where: { packageId_hostId: { packageId: target.packageId, hostId: target.hostId } }, select: { id: true } }))) return reply.code(400).send({ error: '目標必須綁定商品既有的 host' })
    }
    const value = JSON.stringify(targets)
    await prisma.systemConfig.upsert({
      where: { key: NETWORK_PROBE_CONFIG_KEY },
      update: { value, type: 'json', label: '網路測試公開目標', description: '管理員維護的 TCP/ICMP 固定目標' },
      create: { key: NETWORK_PROBE_CONFIG_KEY, value, type: 'json', label: '網路測試公開目標', description: '管理員維護的 TCP/ICMP 固定目標' }
    })
    invalidateCachedConfigs([NETWORK_PROBE_CONFIG_KEY])
    await logAdminAction(request.user.id, 'NETWORK_PROBE_TARGETS_UPDATED', { resourceType: 'system_config', resourceId: NETWORK_PROBE_CONFIG_KEY, metadata: { count: targets.length } })
    return { targets }
  })
}
