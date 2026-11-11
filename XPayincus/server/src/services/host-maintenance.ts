import { Readable } from 'node:stream'
import { Prisma } from '@prisma/client'
import { HOST_TASK_CLAIM_LOCK_NAMESPACE, INSTANCE_OPERATION_LOCK_NAMESPACE, tryAdvisoryTransactionLock } from '../db/advisory-locks.js'
import { request as httpRequest } from 'undici'
import type { FastifyInstance } from 'fastify'
import { prisma } from '../db/prisma.js'
import * as db from '../db/index.js'
import { getIncusClient, getInstance, stopInstance, startInstance, updateInstance, deleteInstance } from '../lib/incus/index.js'
import { createBackup, deleteBackup, getBackupExportStream } from '../lib/incus/incus-backups.js'
import { getStoragePoolResources } from '../lib/incus/incus-storage.js'
import { waitForOperation } from '../lib/incus/incus-utils.js'

const activeMutators = new Map<number, number>()
const claimingHosts = new Set<number>()

export function registerMaintenanceMutatorGuard(fastify: FastifyInstance, scope: 'hosts' | 'instances') {
  const requests = new WeakMap<object, number[]>()
  fastify.addHook('preHandler', async (request, reply) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method) || request.routeOptions.url?.includes('maintenance-plans')) return
    const params = request.params as { id?: string }
    if (!params.id || !/^[1-9]\d*$/.test(params.id)) return
    const id = Number(params.id)
    if (scope === 'instances' && !request.routeOptions.url?.includes('/provisioning/retry')) {
      const job = await prisma.provisioningJob.findFirst({ where: { instanceId: id, status: { in: ['preparing', 'pending', 'processing', 'review_required'] } }, select: { id: true } })
      if (job) return reply.code(409).send({ error: '實例交付尚未結束', code: 'PROVISIONING_IN_PROGRESS' })
    }
    const instance = scope === 'instances' ? await prisma.instance.findUnique({ where: { id }, select: { hostId: true } }) : null
    const hostId = scope === 'hosts' ? id : instance?.hostId
    if (!hostId) return
    if (claimingHosts.has(hostId)) return reply.code(409).send({ error: '節點正在建立維護計畫', code: 'MAINTENANCE_IN_PROGRESS' })
    activeMutators.set(hostId, (activeMutators.get(hostId) || 0) + 1)
    requests.set(request, [hostId])
    const plan = await prisma.hostMaintenancePlan.findFirst({ where: { status: { in: ['running', 'completed', 'review_required', 'recovering'] }, OR: [{ sourceHostId: hostId }, { targetHostId: hostId }] }, select: { id: true } })
    if (plan) return reply.code(409).send({ error: '節點維護計畫尚未解除', code: 'MAINTENANCE_IN_PROGRESS', planId: plan.id })
  })
  fastify.addHook('onResponse', async request => {
    for (const hostId of requests.get(request) || []) {
      const remaining = (activeMutators.get(hostId) || 1) - 1
      if (remaining) activeMutators.set(hostId, remaining)
      else activeMutators.delete(hostId)
    }
    requests.delete(request)
  })
}

async function preflight(sourceHostId: number, targetHostId: number, ids: number[], executing = false) {
  if (sourceHostId === targetHostId) throw new Error('來源與目標必須不同')
  const source = await db.getHostById(sourceHostId)
  const target = await db.getHostById(targetHostId)
  if (!source || !target || (!executing && (source.status !== 'online' || target.status !== 'online')) || (executing && (source.status !== 'maintenance' || target.status !== 'maintenance'))) throw new Error('來源或目標節點不可用')
  const [sourceRow, targetRow, instances] = await Promise.all([
    prisma.host.findUniqueOrThrow({ where: { id: sourceHostId } }),
    prisma.host.findUniqueOrThrow({ where: { id: targetHostId }, include: { instances: { where: { status: { not: 'deleted' } } } } }),
    prisma.instance.findMany({ where: { id: { in: ids }, hostId: sourceHostId }, include: { portMappings: true, proxySites: true } })
  ])
  if (instances.length !== ids.length) throw new Error('實例不存在或不屬於來源節點')
  if (sourceRow.architecture !== targetRow.architecture || sourceRow.instanceType !== targetRow.instanceType) throw new Error('節點架構或實例類型不相容')
  const cpu = instances.reduce((n, i) => n + i.cpu, 0)
  const memory = instances.reduce((n, i) => n + i.memory, 0)
  const disk = instances.reduce((n, i) => n + i.disk, 0)
  const calculated = await db.calculateHostResourcesFromInstances(targetHostId)
  const used = { cpu: Math.max(calculated.cpuUsed, targetRow.cpuUsed), memory: Math.max(calculated.memoryUsed, targetRow.memoryUsed), disk: Math.max(calculated.diskUsed, targetRow.diskUsed) }
  if (executing) {
    const plan = await prisma.hostMaintenancePlan.findFirst({ where: { sourceHostId, targetHostId, status: { in: ['running', 'recovering'] } }, orderBy: { id: 'desc' } })
    const reservations = (plan?.results || []) as Array<{ instanceId: number; targetRetained?: boolean; cpu?: number; memory?: number; disk?: number }>
    for (const instance of instances) {
      const reservation = reservations.find(row => row.instanceId === instance.id)
      if (reservation && reservation.targetRetained !== false) {
        used.cpu -= reservation.cpu ?? instance.cpu
        used.memory -= reservation.memory ?? instance.memory
        used.disk -= reservation.disk ?? instance.disk
      }
    }
  }
  if (targetRow.cpuAllowanceMax - used.cpu < cpu || targetRow.memoryMax - used.memory < memory || targetRow.storageSize * 1024 - used.disk < disk) throw new Error('目標 CPU、記憶體或儲存容量不足')
  const sourceClient = await getIncusClient(source)
  const targetClient = await getIncusClient(target)
  const pools = new Map<number, string>()
  const poolRequirements = new Map<string, number>()
  for (const instance of instances) {
    if (!['running', 'stopped'].includes(instance.status)) throw new Error(`實例 #${instance.id} 狀態不允許搬遷`)
    if (instance.networkMode !== 'nat' || instance.ipv6 || instance.portMappings.length || instance.proxySites.length) throw new Error(`實例 #${instance.id} 僅支援無端口映射、無反向代理的 IPv4 NAT 冷搬遷`)
    if (!sourceRow.natPublicIp || sourceRow.natPublicIp !== targetRow.natPublicIp) throw new Error('冷搬遷需要相同對外 NAT 位址及共享網路')
    const remote = await getInstance(sourceClient, instance.incusId) as { expanded_devices?: Record<string, { type?: string; path?: string; network?: string; nictype?: string; parent?: string }> }
    const devices = Object.values(remote.expanded_devices || {})
    if (!devices.length) throw new Error('無法核實實例展開後的裝置配置')
    if (devices.some(d => d.type === 'disk' && d.path !== '/')) throw new Error(`實例 #${instance.id} 有外掛磁碟，不能以根磁碟備份搬遷`)
    const active = await prisma.instanceTask.count({ where: { instanceId: instance.id, status: { in: ['PENDING', 'PROCESSING'] } } })
    if (active) throw new Error(`實例 #${instance.id} 有進行中的操作`)
    const pool = await db.resolveStoragePoolForNewInstance(targetHostId, { packageId: instance.packageId })
    if (!pool) throw new Error('目標缺少可用儲存池')
    pools.set(instance.id, pool)
    const targetNetworks = await targetClient.request<Array<{ name: string; config?: Record<string, string> }>>('GET', '/1.0/networks?recursion=1')
    const sourceNetworks = await sourceClient.request<Array<{ name: string; config?: Record<string, string> }>>('GET', '/1.0/networks?recursion=1')
    const nics = devices.filter(device => device.type === 'nic')
    if (!nics.length || nics.some(nic => !nic.network)) throw new Error('只支援使用受管理網路的網卡')
    for (const nic of nics) {
      const network = sourceNetworks.find(row => row.name === nic.network)
      const other = targetNetworks.find(row => row.name === nic.network)
      if (!network?.config?.['ipv4.address'] || network.config['ipv4.address'] !== other?.config?.['ipv4.address']) throw new Error('實例使用的網路與目標不相容')
      const sourceType = network as typeof network & { type?: string }
      const targetType = other as typeof other & { type?: string }
      if (sourceType.type !== 'ovn' || targetType.type !== 'ovn' || !network.config['user.xpayincus.shared_network'] || network.config['user.xpayincus.shared_network'] !== other?.config?.['user.xpayincus.shared_network']) throw new Error('需由管理員在雙端 OVN 網路設定相同 user.xpayincus.shared_network 識別共享網路')
    }
    if (instance.ipv4 && await prisma.instance.findFirst({ where: { hostId: targetHostId, ipv4: instance.ipv4, status: { not: 'deleted' } } })) throw new Error('目標 IPv4 已被使用')
    const remoteTargets = await targetClient.request<string[]>('GET', '/1.0/instances')
    const targetExists = remoteTargets.includes(`/1.0/instances/${encodeURIComponent(instance.incusId)}`)
    if (targetExists) {
      if (!executing) throw new Error('目標已有同名實例')
      const plan = await prisma.hostMaintenancePlan.findFirst({ where: { sourceHostId, targetHostId, status: { in: ['running', 'recovering'] } }, orderBy: { id: 'desc' } })
      if (!(plan?.results as Array<{ instanceId: number; targetReady?: boolean }> | undefined)?.some(row => row.instanceId === instance.id && row.targetReady)) throw new Error('目標匯入完成紀錄不足，請先人工核實並 takeover 或 rollback')
      const copy = await getInstance(targetClient, instance.incusId) as { config?: Record<string, string>; status?: string; expanded_devices?: Record<string, { type?: string; path?: string; pool?: string }> }
      if (copy.config?.['user.xpayincus.instance_id'] !== String(instance.id) || copy.status !== 'Stopped' || copy.config['boot.autostart'] !== 'false' || !Object.values(copy.expanded_devices || {}).some(device => device.type === 'disk' && device.path === '/' && device.pool === pool)) throw new Error('目標副本歸屬、停止狀態或儲存池無法核實，請先 takeover 或 rollback')
    }
    if (!targetExists) poolRequirements.set(pool, (poolRequirements.get(pool) || 0) + instance.disk * 1024 * 1024)
  }
  for (const [pool, required] of poolRequirements) {
    const resources = await getStoragePoolResources(targetClient, pool)
    if (!resources.space || resources.space.total - resources.space.used < required) throw new Error('目標儲存池實際空間不足')
  }
  return { sourceClient, targetClient, instances, pools, cpu, memory, disk }
}

const runningPlans = new Set<number>()
async function executePlan(id: number) {
  if (runningPlans.has(id)) return
  runningPlans.add(id)
  let currentId: number | undefined
  try {
    const plan = await prisma.hostMaintenancePlan.findUniqueOrThrow({ where: { id } })
    if (plan.status !== 'running') return
    const ids = plan.instanceIds as number[]
    const remaining = await prisma.instance.findMany({ where: { id: { in: ids }, hostId: plan.sourceHostId }, select: { id: true } })
    const checked = await preflight(plan.sourceHostId, plan.targetHostId, remaining.map(instance => instance.id), true)
    const results = plan.results as Array<{ instanceId: number; status: string; sourceRetained: boolean; targetRetained?: boolean; targetReady?: boolean; originalStatus?: string; backupName?: string; error?: string; cpu?: number; memory?: number; disk?: number }>
    for (const instance of checked.instances) {
      currentId = instance.id
      const backupName = `maintenance-${id}-${instance.id}`
      const current = results.find(result => result.instanceId === instance.id)!
      current.originalStatus ??= instance.status
      current.targetRetained = true
      current.status = 'stopping'
      current.backupName = backupName
      await prisma.hostMaintenancePlan.update({ where: { id }, data: { results } })
      const sourceRemote = await getInstance(checked.sourceClient, instance.incusId) as { status?: string; config?: Record<string, string> }
      if (sourceRemote.config?.['user.xpayincus.instance_id'] && sourceRemote.config['user.xpayincus.instance_id'] !== String(instance.id)) throw new Error('來源資源歸屬不符')
      await updateInstance(checked.sourceClient, instance.incusId, { config: { 'boot.autostart': 'false', 'user.xpayincus.instance_id': String(instance.id) } })
      if (sourceRemote.status === 'Running') await stopInstance(checked.sourceClient, instance.incusId, false)
      else if (sourceRemote.status !== 'Stopped') throw new Error('來源實例停止狀態無法核實')
      await prisma.instance.updateMany({ where: { id: instance.id, hostId: plan.sourceHostId }, data: { status: 'stopped' } })
      const backups = await checked.sourceClient.request<string[]>('GET', `/1.0/instances/${encodeURIComponent(instance.incusId)}/backups`)
      if (!backups.some(name => name.endsWith(`/backups/${backupName}`))) await createBackup(checked.sourceClient, instance.incusId, backupName, { instanceOnly: false, optimizedStorage: false })
      current.status = 'restoring'
      await prisma.hostMaintenancePlan.update({ where: { id }, data: { results } })
      const targetNames = await checked.targetClient.request<string[]>('GET', '/1.0/instances')
      const targetExists = targetNames.includes(`/1.0/instances/${encodeURIComponent(instance.incusId)}`)
      if (targetExists && !current.targetReady) throw new Error('目標副本缺少匯入完成紀錄，請人工核實')
      if (!targetExists) {
        const exported = await getBackupExportStream(checked.sourceClient, instance.incusId, backupName)
        if (!checked.targetClient.agent) throw new Error('目標連線不可用')
        const response = await httpRequest(`${checked.targetClient.baseUrl}/1.0/instances`, {
          method: 'POST', dispatcher: checked.targetClient.agent,
          headers: { 'Content-Type': 'application/octet-stream', 'X-Incus-name': instance.incusId, 'X-Incus-pool': checked.pools.get(instance.id)! },
          body: Readable.fromWeb(exported.stream as Parameters<typeof Readable.fromWeb>[0]), bodyTimeout: 0, headersTimeout: 1800000
        })
        const imported = await response.body.json() as { type?: string; error?: string; operation?: string }
        if (response.statusCode >= 400 || imported.type === 'error') throw new Error(imported.error || '備份匯入失敗')
        if (imported.operation) await waitForOperation(checked.targetClient, imported.operation, 1800000)
      }
      const restored = await getInstance(checked.targetClient, instance.incusId) as { status?: string; config?: Record<string, string> }
      if (restored.config?.['user.xpayincus.instance_id'] !== String(instance.id)) throw new Error('目標資源歸屬不符')
      if (restored.status === 'Running') await stopInstance(checked.targetClient, instance.incusId, false)
      else if (restored.status !== 'Stopped') throw new Error('目標停止狀態無法核實')
      await updateInstance(checked.targetClient, instance.incusId, { config: { 'boot.autostart': 'false' } })
      current.targetReady = true
      current.status = 'committing'
      await prisma.hostMaintenancePlan.update({ where: { id }, data: { results } })
      const moved = await prisma.$transaction(async tx => {
        await tx.$queryRaw(Prisma.sql`SELECT id FROM hosts WHERE id IN (${Prisma.join([plan.sourceHostId, plan.targetHostId].sort((a, b) => a - b))}) ORDER BY id FOR UPDATE`)
        const claimed = await tx.instance.updateMany({ where: { id: instance.id, hostId: plan.sourceHostId, status: 'stopped' }, data: { hostId: plan.targetHostId, status: 'stopped', storagePoolName: checked.pools.get(instance.id) } })
        if (claimed.count !== 1) throw new Error('實例在搬遷途中已變更，來源已保留')
        await tx.ipAddress.updateMany({ where: { instanceId: instance.id }, data: { hostId: plan.targetHostId } })
        current.status = 'committed'
        await tx.hostMaintenancePlan.update({ where: { id }, data: { results } })
        for (const hostId of [plan.sourceHostId, plan.targetHostId]) await db.updateHostResources(hostId, await db.calculateHostResourcesFromInstances(hostId, tx), tx)
        return claimed
      })
      if (moved.count && current.originalStatus === 'running') {
        await startInstance(checked.targetClient, instance.incusId)
        await prisma.instance.update({ where: { id: instance.id }, data: { status: 'running' } })
      }
      current.status = 'completed'
      await prisma.hostMaintenancePlan.update({ where: { id }, data: { results } })
    }
    await prisma.hostMaintenancePlan.update({ where: { id }, data: { status: 'completed' } })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const plan = await prisma.hostMaintenancePlan.findUniqueOrThrow({ where: { id } })
    const results = plan.results as Array<Record<string, string | number | boolean>>
    if (currentId) {
      const current = results.find(result => result.instanceId === currentId)
      if (current) {
        current.status = 'failed'; current.error = message
        try {
          const target = await db.getHostById(plan.targetHostId)
          const instance = await prisma.instance.findUnique({ where: { id: currentId } })
          if (target && instance) {
            const client = await getIncusClient(target)
            const names = await client.request<string[]>('GET', '/1.0/instances')
            if (names.includes(`/1.0/instances/${encodeURIComponent(instance.incusId)}`)) {
              const remote = await getInstance(client, instance.incusId) as { status?: string; config?: Record<string, string> }
              if (remote.config?.['user.xpayincus.instance_id'] !== String(instance.id)) throw new Error('目標資源歸屬不符，保留現場待核實')
              await updateInstance(client, instance.incusId, { config: { 'boot.autostart': 'false' } })
              if (remote.status === 'Running') await stopInstance(client, instance.incusId, false)
              await prisma.instance.updateMany({ where: { id: instance.id, hostId: plan.targetHostId }, data: { status: 'stopped' } })
            }
          }
        } catch (stopError) {
          current.error = `${message}；無法確認目標已停止：${stopError instanceof Error ? stopError.message : String(stopError)}`
        }
      }
    }
    for (const result of results) if (result.status === 'pending') result.status = 'skipped'
    await prisma.hostMaintenancePlan.update({ where: { id }, data: { status: 'review_required', error: message, results } })
  } finally { runningPlans.delete(id) }
}

export async function registerHostMaintenanceRoutes(fastify: FastifyInstance) {
  fastify.post<{ Params: { id: string }; Body: { targetHostId: number; instanceIds: number[]; dryRun?: boolean } }>('/:id/maintenance-plans', {
    onRequest: [fastify.authenticate, fastify.requireAdmin],
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[1-9][0-9]*$', maxLength: 10 } } }, body: { type: 'object', required: ['targetHostId', 'instanceIds'], additionalProperties: false, properties: { targetHostId: { type: 'integer', minimum: 1, maximum: 2147483647 }, instanceIds: { type: 'array', minItems: 1, maxItems: 100, uniqueItems: true, items: { type: 'integer', minimum: 1, maximum: 2147483647 } }, dryRun: { type: 'boolean' } } } }
  }, async (request, reply) => {
    const sourceHostId = Number(request.params.id)
    if (!Number.isSafeInteger(sourceHostId) || sourceHostId > 2147483647) return reply.code(400).send({ error: '無效的節點 ID' })
    const hostIds = [sourceHostId, request.body.targetHostId].sort((a, b) => a - b)
    if (hostIds.some(hostId => claimingHosts.has(hostId) || activeMutators.has(hostId))) return reply.code(409).send({ error: '節點有進行中的寫入操作' })
    for (const hostId of hostIds) claimingHosts.add(hostId)
    try {
      const checked = await preflight(sourceHostId, request.body.targetHostId, request.body.instanceIds)
      if (request.body.dryRun) return { passed: true, cpu: checked.cpu, memory: checked.memory, disk: checked.disk, sourceRetained: true }
      const plan = await prisma.$transaction(async tx => {
        const hostIds = [sourceHostId, request.body.targetHostId].sort((a, b) => a - b)
        if (hostIds.some(hostId => activeMutators.has(hostId))) throw new Error('節點有進行中的寫入操作，請稍後重試')
        for (const hostId of hostIds) {
          if (!await tryAdvisoryTransactionLock(tx, HOST_TASK_CLAIM_LOCK_NAMESPACE, hostId)) throw new Error('節點正在領取操作任務')
        }
        await tx.$queryRaw(Prisma.sql`SELECT id FROM hosts WHERE id IN (${Prisma.join(hostIds)}) ORDER BY id FOR UPDATE`)
        if (await tx.instanceTask.count({ where: { status: { in: ['PENDING', 'PROCESSING'] }, OR: [{ hostId: { in: hostIds } }, { targetHostId: { in: hostIds } }] } })) throw new Error('節點有進行中的操作任務')
        if (await tx.provisioningJob.count({ where: { status: { in: ['preparing', 'pending', 'processing', 'review_required'] }, instance: { hostId: { in: hostIds } } } })) throw new Error('節點有尚未結束的交付任務')
        if (await tx.restoreTask.count({ where: { hostId: { in: hostIds }, status: { in: ['PENDING', 'PROCESSING'] } } })) throw new Error('節點有尚未結束的還原任務')
        if (await tx.backupUploadTask.count({ where: { hostId: { in: hostIds }, status: { in: ['PENDING', 'PROCESSING'] } } })) throw new Error('節點有尚未結束的備份上傳任務')
        if (await tx.backup.count({ where: { status: 'creating', instance: { hostId: { in: hostIds } } } })) throw new Error('節點有尚未結束的備份建立操作')
        const conflicting = await tx.hostMaintenancePlan.count({ where: { status: { in: ['running', 'review_required', 'completed', 'recovering'] }, OR: [{ sourceHostId: { in: hostIds } }, { targetHostId: { in: hostIds } }] } })
        if (conflicting) throw new Error('節點已有未解除的維護計畫，請先確認保留的來源與目標')
        for (const instance of checked.instances) {
          if (!await tryAdvisoryTransactionLock(tx, INSTANCE_OPERATION_LOCK_NAMESPACE, instance.id)) throw new Error('實例有其他操作')
          const current = await tx.instance.findUnique({ where: { id: instance.id } })
          if (!current || current.updatedAt.getTime() !== instance.updatedAt.getTime() || current.hostId !== sourceHostId || !['running', 'stopped'].includes(current.status)) throw new Error('實例在預檢後已變更，請重新預檢')
          if (await tx.instanceTask.count({ where: { instanceId: instance.id, status: { in: ['PENDING', 'PROCESSING'] } } })) throw new Error('實例有其他操作')
          if (await tx.restoreTask.count({ where: { instanceId: instance.id, status: { in: ['PENDING', 'PROCESSING'] } } })) throw new Error('實例有還原操作')
          if (await tx.backupUploadTask.count({ where: { instanceId: instance.id, status: { in: ['PENDING', 'PROCESSING'] } } })) throw new Error('實例有備份操作')
        }
        const target = await tx.host.findUniqueOrThrow({ where: { id: request.body.targetHostId } })
        const source = await tx.host.findUniqueOrThrow({ where: { id: sourceHostId } })
        const usage = await db.calculateHostResourcesFromInstances(target.id, tx)
        const cpuUsed = Math.max(target.cpuUsed, usage.cpuUsed)
        const memoryUsed = Math.max(target.memoryUsed, usage.memoryUsed)
        const diskUsed = Math.max(target.diskUsed, usage.diskUsed)
        if (source.status !== 'online' || target.status !== 'online' || target.cpuAllowanceMax - cpuUsed < checked.cpu || target.memoryMax - memoryUsed < checked.memory || target.storageSize * 1024 - diskUsed < checked.disk) throw new Error('目標容量或節點狀態已改變，請重新預檢')
        await tx.host.updateMany({ where: { id: { in: hostIds } }, data: { status: 'maintenance' } })
        await tx.host.update({ where: { id: request.body.targetHostId }, data: {
          cpuUsed: cpuUsed + checked.cpu, memoryUsed: memoryUsed + checked.memory, diskUsed: diskUsed + checked.disk
        } })
        return tx.hostMaintenancePlan.create({ data: { sourceHostId, targetHostId: request.body.targetHostId, createdBy: request.user.id, instanceIds: request.body.instanceIds, results: checked.instances.map(instance => ({ instanceId: instance.id, status: 'pending', originalStatus: instance.status, sourceRetained: true, targetRetained: true, cpu: instance.cpu, memory: instance.memory, disk: instance.disk })), status: 'running' } })
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
      void executePlan(plan.id).catch(error => fastify.log.error(error))
      return reply.code(202).send({ plan })
    } catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) }) }
    finally { for (const hostId of hostIds) claimingHosts.delete(hostId) }
  })
  fastify.get<{ Params: { id: string } }>('/:id/maintenance-plans', { onRequest: [fastify.authenticate, fastify.requireAdmin] }, async (request, reply) => {
    if (!/^[1-9]\d*$/.test(request.params.id) || Number(request.params.id) > 2147483647) return reply.code(400).send({ error: '無效的節點 ID' })
    return { plans: await prisma.hostMaintenancePlan.findMany({ where: { sourceHostId: Number(request.params.id) }, orderBy: { id: 'desc' }, take: 100 }) }
  })
  fastify.post<{ Params: { id: string; planId: string }; Body: { action?: 'review' | 'takeover' | 'rollback' | 'resume' | 'cleanup' } }>('/:id/maintenance-plans/:planId/review', {
    onRequest: [fastify.authenticate, fastify.requireAdmin],
    schema: { body: { type: 'object', additionalProperties: false, properties: { action: { type: 'string', enum: ['review', 'takeover', 'rollback', 'resume', 'cleanup'] } } } }
  }, async (request, reply) => {
    const { id, planId } = request.params
    if (![id, planId].every(value => /^[1-9]\d*$/.test(value) && Number(value) <= 2147483647)) return reply.code(400).send({ error: '無效的計畫 ID' })
    const plan = await prisma.hostMaintenancePlan.findFirst({ where: { id: Number(planId), sourceHostId: Number(id) } })
    if (!plan) return reply.code(404).send({ error: '維護計畫不存在' })
    if (!['completed', 'review_required'].includes(plan.status) || runningPlans.has(plan.id)) return reply.code(409).send({ error: '計畫尚不能核實' })
    const action = request.body?.action || 'review'
    const recorded = plan.results as Array<{ cleanupAuthorized?: boolean }>
    if (!recorded.length || recorded.length !== (plan.instanceIds as number[]).length) return reply.code(409).send({ error: '計畫資源紀錄不完整' })
    if (action !== 'cleanup' && recorded.some(row => row.cleanupAuthorized)) return reply.code(409).send({ error: '副本清理已開始，請繼續 cleanup' })
    if (action === 'cleanup' && plan.status !== 'completed' && !recorded.every(row => row.cleanupAuthorized === true)) return reply.code(409).send({ error: '請先完成 review、takeover 或 rollback，確認主副本後才能清理' })
    runningPlans.add(plan.id)
    let ownsClaim = false
    try {
      const claimed = await prisma.hostMaintenancePlan.updateMany({ where: { id: plan.id, status: plan.status }, data: { status: 'recovering' } })
      if (!claimed.count) throw new Error('計畫已由其他請求處理')
      ownsClaim = true
      const source = await db.getHostById(plan.sourceHostId)
      const target = await db.getHostById(plan.targetHostId)
      if (!source || !target) throw new Error('節點不可用')
      const sourceClient = await getIncusClient(source)
      const targetClient = await getIncusClient(target)
      const targetNames = await targetClient.request<string[]>('GET', '/1.0/instances')
      const instances = await prisma.instance.findMany({ where: { id: { in: plan.instanceIds as number[] } } })
      if (instances.length !== (plan.instanceIds as number[]).length) throw new Error('實例紀錄不完整，需人工處理')
      const results = plan.results as Array<{ instanceId: number; status: string; sourceRetained?: boolean; targetRetained?: boolean; cpu?: number; memory?: number; disk?: number }>
      if (action === 'resume') {
        const remaining = instances.filter(instance => instance.hostId === plan.sourceHostId)
        if (!remaining.length) throw new Error('沒有待繼續搬遷的實例，請核實計畫')
        await preflight(plan.sourceHostId, plan.targetHostId, remaining.map(instance => instance.id), true)
        for (const instance of remaining) {
          const result = results.find(row => row.instanceId === instance.id)
          if (!result) throw new Error('計畫資源紀錄不完整')
          result.targetRetained = true
        }
        await prisma.$transaction(async tx => {
          await tx.$queryRaw(Prisma.sql`SELECT id FROM hosts WHERE id IN (${Prisma.join([plan.sourceHostId, plan.targetHostId].sort((a, b) => a - b))}) ORDER BY id FOR UPDATE`)
          const claimed = await tx.hostMaintenancePlan.updateMany({ where: { id: plan.id, status: 'recovering' }, data: { status: 'running', error: null, results } })
          if (!claimed.count) throw new Error('計畫狀態已改變')
          for (const hostId of [plan.sourceHostId, plan.targetHostId]) await db.updateHostResources(hostId, await db.calculateHostResourcesFromInstances(hostId, tx), tx)
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
        setImmediate(() => { void executePlan(plan.id).catch(error => fastify.log.error(error)) })
        return reply.code(202).send({ success: true, status: 'running' })
      }
      if (action === 'cleanup') {
        for (const result of results) Object.assign(result, { cleanupAuthorized: true })
        await prisma.hostMaintenancePlan.update({ where: { id: plan.id }, data: { results } })
      }
      const sourceNames = await sourceClient.request<string[]>('GET', '/1.0/instances')
      for (const instance of instances) {
        const result = results.find(row => row.instanceId === instance.id)
        if (!result) throw new Error('計畫資源紀錄不完整')
        if (action === 'cleanup') {
          if (![plan.sourceHostId, plan.targetHostId].includes(instance.hostId) || instance.status === 'deleted') throw new Error('實例歸屬無法核實')
          const ownerClient = instance.hostId === plan.sourceHostId ? sourceClient : targetClient
          const owner = await getInstance(ownerClient, instance.incusId) as { config?: Record<string, string>; status?: string }
          if (owner.config?.['user.xpayincus.instance_id'] !== String(instance.id) || !['Running', 'Stopped'].includes(owner.status || '')) throw new Error('主實例歸屬或狀態無法核實')
          const copyClient = instance.hostId === plan.sourceHostId ? targetClient : sourceClient
          const names = instance.hostId === plan.sourceHostId ? targetNames : sourceNames
          if (names.includes(`/1.0/instances/${encodeURIComponent(instance.incusId)}`)) {
            const copy = await getInstance(copyClient, instance.incusId) as { config?: Record<string, string>; status?: string }
            if (copy.config?.['user.xpayincus.instance_id'] !== String(instance.id) || copy.status !== 'Stopped' || copy.config['boot.autostart'] !== 'false') throw new Error('保留副本歸屬或停止狀態無法核實')
            await deleteInstance(copyClient, instance.incusId)
          }
          const backupName = `maintenance-${plan.id}-${instance.id}`
          const backups = await ownerClient.request<string[]>('GET', `/1.0/instances/${encodeURIComponent(instance.incusId)}/backups`)
          if (backups.some(name => name.endsWith(`/backups/${backupName}`))) await deleteBackup(ownerClient, instance.incusId, backupName)
          result.sourceRetained = false
          result.targetRetained = false
          await prisma.hostMaintenancePlan.update({ where: { id: plan.id }, data: { results } })
          continue
        }
        const original = await getInstance(sourceClient, instance.incusId) as { status?: string; config?: Record<string, string>; expanded_devices?: Record<string, { type?: string; path?: string; pool?: string }> }
        const exists = targetNames.includes(`/1.0/instances/${encodeURIComponent(instance.incusId)}`)
        if (original.config?.['user.xpayincus.instance_id'] !== String(instance.id)) throw new Error(`來源 #${instance.id} 無法核實資源歸屬`)
        result.cpu ??= instance.cpu; result.memory ??= instance.memory; result.disk ??= instance.disk
        if (action === 'takeover' || action === 'rollback') {
          if (![plan.sourceHostId, plan.targetHostId].includes(instance.hostId)) throw new Error('實例歸屬已改變')
          await updateInstance(sourceClient, instance.incusId, { config: { 'boot.autostart': 'false' } })
          if (original.status === 'Running') await stopInstance(sourceClient, instance.incusId, false)
          else if (original.status !== 'Stopped') throw new Error('來源狀態未明')
          let remote: { status?: string; config?: Record<string, string>; expanded_devices?: Record<string, { type?: string; path?: string; pool?: string }> } | undefined
          if (exists) {
            remote = await getInstance(targetClient, instance.incusId) as typeof remote
            if (remote?.config?.['user.xpayincus.instance_id'] !== String(instance.id)) throw new Error('目標資源歸屬不符')
            await updateInstance(targetClient, instance.incusId, { config: { 'boot.autostart': 'false' } })
            if (remote.status === 'Running') await stopInstance(targetClient, instance.incusId, false)
            else if (remote.status !== 'Stopped') throw new Error('目標狀態未明')
          }
          if (action === 'takeover' && !exists) throw new Error('目標尚未匯入，請使用 resume')
          const owner = action === 'rollback' ? plan.sourceHostId : plan.targetHostId
          const pool = action === 'takeover' ? Object.values(remote?.expanded_devices || {}).find(device => device.type === 'disk' && device.path === '/')?.pool : Object.values((original as typeof remote)?.expanded_devices || {}).find(device => device.type === 'disk' && device.path === '/')?.pool
          if (!pool) throw new Error('無法核實接管節點的根磁碟儲存池')
          await prisma.$transaction(async tx => {
            await tx.$queryRaw(Prisma.sql`SELECT id FROM hosts WHERE id IN (${Prisma.join([plan.sourceHostId, plan.targetHostId].sort((a, b) => a - b))}) ORDER BY id FOR UPDATE`)
            const claimed = await tx.instance.updateMany({ where: { id: instance.id, hostId: instance.hostId }, data: { hostId: owner, status: 'stopped', storagePoolName: pool } })
            if (!claimed.count) throw new Error('實例歸屬已改變')
            await tx.ipAddress.updateMany({ where: { instanceId: instance.id }, data: { hostId: owner } })
            result.status = action === 'rollback' ? 'rolled_back' : 'completed'
            result.sourceRetained = true
            result.targetRetained = exists && action === 'rollback'
            await tx.hostMaintenancePlan.update({ where: { id: plan.id }, data: { results } })
            for (const hostId of [plan.sourceHostId, plan.targetHostId]) await db.updateHostResources(hostId, await db.calculateHostResourcesFromInstances(hostId, tx), tx)
          }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
          continue
        }
        if (instance.hostId === plan.targetHostId) {
          if (original.status !== 'Stopped' || original.config?.['boot.autostart'] !== 'false') throw new Error(`來源 #${instance.id} 尚未停止或仍可自動啟動`)
          if (!exists) throw new Error(`目標 #${instance.id} 不存在`)
          const remote = await getInstance(targetClient, instance.incusId) as { status?: string; config?: Record<string, string> }
          if (remote.config?.['user.xpayincus.instance_id'] !== String(instance.id)) throw new Error('目標資源歸屬不符')
          if (!['Running', 'Stopped'].includes(remote.status || '')) throw new Error(`目標 #${instance.id} 狀態未明`)
          await prisma.instance.update({ where: { id: instance.id }, data: { status: remote.status === 'Running' ? 'running' : 'stopped' } })
        } else if (instance.hostId === plan.sourceHostId && !exists) {
          result.targetRetained = false
        } else throw new Error(`實例 #${instance.id} 歸屬與遠端不一致；請保留資料並人工處理`)
      }
      const status = action === 'cleanup' ? 'reviewed' : 'completed'
      await prisma.$transaction(async tx => {
        await tx.$queryRaw(Prisma.sql`SELECT id FROM hosts WHERE id IN (${Prisma.join([plan.sourceHostId, plan.targetHostId].sort((a, b) => a - b))}) ORDER BY id FOR UPDATE`)
        const claimed = await tx.hostMaintenancePlan.updateMany({ where: { id: plan.id, status: 'recovering' }, data: { status, error: null, results } })
        if (!claimed.count) throw new Error('計畫已由其他請求處理')
        for (const hostId of [plan.sourceHostId, plan.targetHostId]) {
          await db.updateHostResources(hostId, await db.calculateHostResourcesFromInstances(hostId, tx), tx)
        }
        if (action === 'cleanup') await tx.host.updateMany({ where: { id: { in: [plan.sourceHostId, plan.targetHostId] }, status: 'maintenance' }, data: { status: 'online' } })
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
      return { success: true, status, sourceRetained: action !== 'cleanup', sourceStatus: action === 'cleanup' ? 'online' : 'maintenance', targetStatus: action === 'cleanup' ? 'online' : 'maintenance', action }
    } catch (error) {
      if (ownsClaim) await prisma.hostMaintenancePlan.updateMany({ where: { id: plan.id, status: 'recovering' }, data: { status: 'review_required', error: error instanceof Error ? error.message : String(error) } })
      return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) })
    } finally { runningPlans.delete(plan.id) }
  })
  fastify.addHook('onReady', async () => {
    const interrupted = await prisma.hostMaintenancePlan.findMany({ where: { status: { in: ['running', 'recovering'] } } })
    for (const plan of interrupted) {
      const results = (plan.results as Array<Record<string, string | number | boolean>>).map(result => ({
        ...result, status: result.status === 'pending' ? 'skipped' : result.status === 'completed' ? 'completed' : 'review_required'
      }))
      await prisma.hostMaintenancePlan.update({ where: { id: plan.id }, data: { status: 'review_required', results, error: '程序中斷；節點維持維護模式，來源與備份保留，請逐台核實目標與資料庫歸屬' } })
      await prisma.$transaction(async tx => {
        const hostIds = [plan.sourceHostId, plan.targetHostId].sort((a, b) => a - b)
        await tx.$queryRaw(Prisma.sql`SELECT id FROM hosts WHERE id IN (${Prisma.join(hostIds)}) ORDER BY id FOR UPDATE`)
        await tx.host.updateMany({ where: { id: { in: hostIds } }, data: { status: 'maintenance' } })
        for (const hostId of hostIds) await db.updateHostResources(hostId, await db.calculateHostResourcesFromInstances(hostId, tx), tx)
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    }
  })
}
