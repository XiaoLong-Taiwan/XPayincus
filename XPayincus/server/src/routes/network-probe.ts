import type { FastifyInstance } from 'fastify'
import { isIP } from 'node:net'
import { prisma } from '../db/prisma.js'
import { invalidateCachedConfigs } from '../lib/config-cache.js'
import { apiError, ErrorCode } from '../lib/errors.js'
import { logAdminAction } from '../lib/security.js'
import { checkNetworkProbeRateLimit, getNetworkProbeTargets, NETWORK_PROBE_CONFIG_KEY, parseNetworkProbeTargets, resolvePublicTargetHost, runNetworkProbe } from '../lib/network-probe.js'

export default async function networkProbeRoutes(fastify: FastifyInstance) {
  fastify.get('/targets', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async () => {
    const configured = await getNetworkProbeTargets()
    const targets = []
    for (const target of configured) {
      if (await resolvePublicTargetHost(target.host)) targets.push({ id: target.id, label: target.label, host: target.host, tcpPorts: target.tcpPorts, icmp: target.icmp })
    }
    return { targets }
  })

  fastify.post<{ Body: { targetId: string; method: 'tcp' | 'icmp'; port?: number } }>('/test', {
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
