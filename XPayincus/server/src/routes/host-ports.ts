import type { FastifyInstance } from 'fastify'
import * as db from '../db/index.js'
import { apiError, ErrorCode } from '../lib/errors.js'
import { getIncusClient } from '../lib/incus/index.js'
import { getInstance } from '../lib/incus/incus-instances.js'
import { prisma } from '../db/prisma.js'

type AddressFamily = 'ipv4' | 'ipv6' | 'unknown'
type InstanceType = 'container' | 'virtual-machine' | 'unknown'

function parseProxyListen(listen: string): { protocol: string; address: string; port: number } | null {
  const match = /^(tcp|udp):(.+):(\d+)$/.exec(listen)
  if (!match) return null
  const port = Number(match[3])
  if (!Number.isSafeInteger(port) || port <= 0) return null
  return {
    protocol: match[1],
    address: match[2].replace(/^\[|\]$/g, ''),
    port
  }
}

function resolveAddressFamilies(listenValues: string[]): Array<'ipv4' | 'ipv6' | 'unknown'> {
  const families = new Set<AddressFamily>()
  for (const listen of listenValues) {
    const parsed = parseProxyListen(listen)
    if (!parsed) {
      families.add('unknown')
      continue
    }
    const address = parsed.address
    if (address.includes(':')) families.add('ipv6')
    else if (/^(\d{1,3}\.){3}\d{1,3}$/.test(address)) families.add('ipv4')
    else families.add('unknown')
  }
  return families.size ? [...families] : ['unknown']
}

export default async function hostPortRoutes(fastify: FastifyInstance) {
  fastify.get<{ Params: { id: string } }>('/:id/ports', {
    onRequest: [fastify.authenticate]
  }, async (request, reply) => {
    if (request.user.role !== 'admin') {
      return reply.code(403).send(apiError(ErrorCode.FORBIDDEN))
    }
    const hostId = Number(request.params.id)
    if (!Number.isSafeInteger(hostId) || hostId <= 0) {
      return reply.code(400).send(apiError(ErrorCode.INVALID_ID))
    }
    const host = await db.getHostById(hostId)
    if (!host) return reply.code(404).send(apiError(ErrorCode.HOST_NOT_FOUND))

    const mappings = await prisma.portMapping.findMany({
      where: { hostId },
      include: { instance: { select: { id: true, name: true, incusId: true, status: true, networkMode: true } } },
      orderBy: [{ publicPort: 'asc' }, { protocol: 'asc' }]
    })
    const deviceFamilies = new Map<number, Array<AddressFamily>>()
    const instanceTypes = new Map<number, InstanceType>()
    let readFailures = 0
    if (host.status === 'online' && mappings.length) {
      try {
        const client = await getIncusClient(host)
        const instanceIds = [...new Set(mappings.map(mapping => mapping.instanceId))]
        const results = await Promise.allSettled(instanceIds.map(async instanceId => {
          const instance = mappings.find(mapping => mapping.instanceId === instanceId)?.instance
          if (!instance) throw new Error('Instance missing')
          const remote = await getInstance(client, instance.incusId)
          instanceTypes.set(instanceId, remote.type === 'container' || remote.type === 'virtual-machine' ? remote.type : 'unknown')
          const listeners = Object.values(remote.expanded_devices || remote.devices || {})
            .filter(device => device.type === 'proxy' && typeof device.listen === 'string')
            .map(device => String(device.listen))
          const instanceMappings = mappings.filter(mapping => mapping.instanceId === instanceId)
          for (const mapping of instanceMappings) {
            const matchingListeners = listeners.filter(listen => {
              const parsed = parseProxyListen(listen)
              return parsed !== null && parsed.protocol === mapping.protocol && parsed.port === mapping.publicPort
            })
            deviceFamilies.set(mapping.id, resolveAddressFamilies(matchingListeners))
          }
        }))
        readFailures = results.filter(result => result.status === 'rejected').length
      } catch {
        readFailures = new Set(mappings.map(mapping => mapping.instanceId)).size
      }
    } else if (mappings.length) {
      readFailures = new Set(mappings.map(mapping => mapping.instanceId)).size
    }

    return {
      source: 'managed-mappings',
      completeness: readFailures ? 'partial' : 'managed-only',
      listenerCoverage: 'unavailable',
      readFailures,
      mappings: mappings.map(mapping => ({
        id: mapping.id,
        instanceId: mapping.instanceId,
        instanceName: mapping.instance.name,
        instanceStatus: mapping.instance.status,
        instanceType: instanceTypes.get(mapping.instanceId) || 'unknown',
        protocol: mapping.protocol,
        publicPort: mapping.publicPort,
        privatePort: mapping.privatePort,
        addressFamilies: deviceFamilies.get(mapping.id) || ['unknown'],
        systemManaged: mapping.systemManaged,
        remark: mapping.remark
      }))
    }
  })
}
