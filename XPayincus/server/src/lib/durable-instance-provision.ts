import type { Prisma } from '@prisma/client'
import { prisma } from '../db/prisma.js'
import * as db from '../db/index.js'
import { encryptSensitiveData, decryptSensitiveData } from './security.js'
import { generateIncusConfig } from './incus-config-generator.js'
import { generateRandomIPv6 } from './ip-calculator.js'
import { networkModeNeedsNatIpv4, networkModeNeedsPublicIpv4, networkModeNeedsRoutedIpv6 } from './network-modes.js'
import type { ManagedInstanceProvisionConfig } from './managed-instance-provision.js'
import type { Host } from '../types/database.js'

export interface DurableProvisionInput {
  hostId: number
  userId: number
  resources: { cpu: number; memory: number; disk: number }
  config: ManagedInstanceProvisionConfig & { swapEnabled?: boolean; swapSize?: number | null }
  preparation?: { displayName: string; sshKey: string; extraShellCommands?: string }
}

export async function createPreparingProvisionJob(tx: Prisma.TransactionClient, instanceId: number, input: DurableProvisionInput): Promise<void> {
  await tx.provisioningJob.create({ data: {
    instanceId, status: 'preparing', phase: 'preparing', payload: encryptSensitiveData(JSON.stringify(input))
  } })
  await tx.provisioningEvent.create({ data: { instanceId, phase: 'preparing' } })
}

export async function prepareDurableInstance(instanceId: number, host: Host, input: DurableProvisionInput): Promise<void> {
  if (!input.preparation) throw new Error('交付準備資料缺失')
  const instance = await prisma.instance.findUniqueOrThrow({ where: { id: instanceId } })
  const config = input.config
  if (instance.status !== 'creating' || instance.hostId !== host.id || instance.userId !== input.userId || instance.incusId !== config.name) throw new Error('交付準備歸屬不符')
  let ipv4 = instance.ipv4
  let ipv6 = instance.ipv6
  let assignment: Awaited<ReturnType<typeof db.reservePublicIpv4ForInstance>> = null
  if (networkModeNeedsNatIpv4(config.networkMode)) {
    if (!ipv4) ipv4 = await db.allocateAndReserveNatIpv4(host.id, instanceId)
    if (!ipv4) throw new Error('NAT IPv4 配置不足')
    await prisma.instance.update({ where: { id: instanceId }, data: { ipv4 } })
  } else if (networkModeNeedsPublicIpv4(config.networkMode)) {
    assignment = await prisma.$transaction(async tx => {
      const reserved = await tx.publicIpv4Address.findFirst({ where: { hostId: host.id, instanceId, status: 'assigned' }, include: { pool: true } })
      if (!reserved) return db.reservePublicIpv4ForInstance(tx, { hostId: host.id, instanceId })
      const gateway = reserved.gateway || reserved.pool?.gateway
      if (!gateway) throw new Error('已預留 IPv4 缺少閘道')
      const dns = Array.isArray(reserved.dns) && reserved.dns.length ? reserved.dns : reserved.pool?.dns
      return { id: reserved.id, address: reserved.address, prefixLength: reserved.prefixLength, gateway, dns: Array.isArray(dns) ? dns.filter((value): value is string => typeof value === 'string') : ['1.1.1.1', '8.8.8.8'] }
    })
    if (!assignment) throw new Error('獨立 IPv4 配置不足')
    ipv4 = assignment.address
  }
  if (networkModeNeedsRoutedIpv6(config.networkMode) && !ipv6) {
    if (!host.ipv6_subnet || !host.ipv6_parent_interface) throw new Error('routed IPv6 配置不足')
    for (let attempt = 0; attempt < 50; attempt++) {
      const candidate = generateRandomIPv6(host.ipv6_subnet)
      if (await db.isIpAddressExists(candidate)) continue
      await prisma.$transaction(async tx => {
        await tx.ipAddress.create({ data: { address: candidate, type: 'inet6', isPrimary: true, device: 'eth1', instanceId, hostId: host.id } })
        await tx.instance.update({ where: { id: instanceId }, data: { ipv6: candidate } })
      })
      ipv6 = candidate
      break
    }
    if (!ipv6) throw new Error('routed IPv6 配置不足')
  }
  const pool = await db.resolveStoragePoolForNewInstance(host.id, { packageId: instance.packageId })
  if (!pool) throw new Error('無可用系統儲存池')
  const rootPassword = instance.rootPassword ? decryptSensitiveData(instance.rootPassword) : null
  if (!rootPassword) throw new Error('交付密碼無法解密')
  const network = ipv4 ? {
    ipAddress: `${ipv4}/${assignment?.prefixLength ?? 22}`,
    gateway: assignment?.gateway || '10.10.0.1',
    dns: assignment?.dns || ['10.10.0.1'],
    ipv6Address: ipv6 ? (config.instanceType === 'vm' ? ipv6 : `${ipv6}/128`) : undefined,
    ipv6Gateway: ipv6 ? (config.instanceType === 'vm' ? host.ipv6_gateway || undefined : 'fe80::1') : undefined
  } : undefined
  if (config.instanceType === 'vm') {
    const { generateVmConfig } = await import('./incus-config-vm.js')
    config.cloudInitConfig = generateVmConfig({ instanceName: input.preparation.displayName, instanceIdSeed: config.name, imageAlias: config.image, rootPassword, sshKey: input.preparation.sshKey, network, networkMode: config.networkMode, extraShellCommands: input.preparation.extraShellCommands }).configPayload
  } else {
    config.cloudInitConfig = generateIncusConfig({ instanceName: input.preparation.displayName, imageAlias: config.image, rootPassword, sshKey: input.preparation.sshKey, networkMode: config.networkMode, type: 'container', network, extraShellCommands: input.preparation.extraShellCommands }).configPayload
  }
  Object.assign(config, { ipv4Address: ipv4, ipv6Address: ipv6, ipv6Gateway: host.ipv6_gateway, hostInterface: host.ipv6_parent_interface || 'eth0', storagePool: pool })
  delete input.preparation
  await prisma.$transaction(async tx => {
    const claimed = await tx.provisioningJob.updateMany({ where: { instanceId, status: 'preparing' }, data: { status: 'pending', phase: 'queued', payload: encryptSensitiveData(JSON.stringify(input)), error: null } })
    if (claimed.count !== 1) throw new Error('交付準備狀態已變更')
    await tx.instance.update({ where: { id: instanceId }, data: { ipv4, ipv6, storagePoolName: pool } })
    await tx.provisioningEvent.create({ data: { instanceId, phase: 'queued' } })
  })
}
