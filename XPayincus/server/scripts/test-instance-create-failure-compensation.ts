import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const instancesSource = readFileSync(resolve(__dirname, '../src/routes/instances.ts'), 'utf8')
const adminBillingSource = readFileSync(resolve(__dirname, '../src/routes/admin-billing.ts'), 'utf8')
const managedProvisionSource = readFileSync(resolve(__dirname, '../src/lib/managed-instance-provision.ts'), 'utf8')
const appSource = readFileSync(resolve(__dirname, '../src/app.ts'), 'utf8')
const compensationSource = readFileSync(resolve(__dirname, '../src/db/instance-provisioning-compensation.ts'), 'utf8')
const durableSource = readFileSync(resolve(__dirname, '../src/lib/durable-instance-provision.ts'), 'utf8')

function indexOfOrThrow(source: string, pattern: string, label: string): number {
  const index = source.indexOf(pattern.replace(/\n/g, source.includes('\r\n') ? '\r\n' : '\n'))
  assert.ok(index >= 0, `Missing ${label}: ${pattern}`)
  return index
}

function section(source: string, startPattern: string, endPattern: string): string {
  const start = indexOfOrThrow(source, startPattern, startPattern)
  const relativeEnd = indexOfOrThrow(source.slice(start), endPattern, endPattern)
  return source.slice(start, start + relativeEnd)
}

const compensationSection = compensationSource

const failureSection = section(
  instancesSource,
  'async function executeInstanceProvisioning(',
  '    throw error\n  }\n}'
)

const createInstanceAsyncSection = instancesSource.slice(
  indexOfOrThrow(instancesSource, 'async function createInstanceAsync(', 'createInstanceAsync')
)

const staticIpAllocationSection = section(
  instancesSource,
  '    if (networkModeNeedsNatIpv4(networkMode)) {',
  '    console.log(`[Provisioning] IP 分配完成: IPv4=${staticIPv4}, IPv6=${staticIPv6}`)'
)

const postTransactionPreparationSection = section(
  instancesSource,
  '    // 事务成功后，完成 IP 分配和存储池选择',
  '    // ==================== 阶段六: 异步执行创建 ===================='
)

const publicIpv4ReleaseHelperSection = section(
  instancesSource,
  'async function releaseReservedPublicIpv4ForFailedCreation(',
  '\n}\n\nasync function compensateFailedInstanceCreation('
)

const compensationHelperSection = section(
  instancesSource,
  'async function compensateFailedInstanceCreation(',
  '\n}\n\n/**\n * 异步创建实例'
)

assert.ok(
  staticIpAllocationSection.includes('staticIpAllocationError = `NAT 内网 IPv4 分配失败') &&
    staticIpAllocationSection.includes("staticIpAllocationError ||= '宿主机未配置 routed IPv6 子网'") &&
    staticIpAllocationSection.includes('staticIpAllocationError ||= `routed IPv6 分配失败') &&
    staticIpAllocationSection.includes('throw new Error(staticIpAllocationError)') &&
    !staticIpAllocationSection.includes('实例将使用动态 IP') &&
    !staticIpAllocationSection.includes('将使用动态分配'),
  'fatal NAT IPv4 and routed IPv6 allocation failures must enter provisioning compensation and return an explicit failure'
)

assert.ok(
  postTransactionPreparationSection.includes('try {') &&
    postTransactionPreparationSection.includes('db.reservePublicIpv4ForInstance') &&
    postTransactionPreparationSection.includes('await db.resolveStoragePoolForNewInstance') &&
    postTransactionPreparationSection.includes('} catch (error) {') &&
    postTransactionPreparationSection.includes('await compensateFailedInstanceCreation({') &&
    postTransactionPreparationSection.includes('return reply.code(503).send(apiError(ErrorCode.HOST_RESOURCES_INSUFFICIENT, errorMessage))'),
  'all synchronous post-transaction IP and storage preparation failures must be compensated immediately'
)

assert.ok(
  failureSection.includes('await compensateFailedInstanceCreation({') &&
    compensationHelperSection.includes("status: 'creating'") &&
    compensationHelperSection.includes('if (updateResult.count === 0)') &&
    compensationHelperSection.includes('await db.rollbackResources({') &&
    compensationHelperSection.includes('await releaseReservedPublicIpv4ForFailedCreation(instanceId, networkMode)') &&
    compensationHelperSection.includes('await db.compensateFailedInstancePurchase(instanceId, userId, host.id)'),
  'sync preparation and async provisioning failures must share the idempotent creating->error compensation helper'
)

assert.ok(
  publicIpv4ReleaseHelperSection.includes('if (!networkModeNeedsPublicIpv4(networkMode))') &&
    publicIpv4ReleaseHelperSection.includes('db.releasePublicIpv4ForInstance(tx, instanceId)') &&
    compensationHelperSection.includes('if (networkModeNeedsPublicIpv4(networkMode)) await db.releasePublicIpv4ForInstance(tx, instanceId)'),
  'persistent compensation must release public IPv4 inside its atomic compensation transaction'
)

assert.ok(
  appSource.includes('const { getStuckCreatingInstances, getHostById, compensateFailedInstancePurchase, releasePublicIpv4ForInstance } = await import') &&
    appSource.includes("status: 'creating' // 原子条件：只有状态仍为 creating 时才更新") &&
    appSource.includes('const compensation = await compensateFailedInstancePurchase(instance.id, instance.user_id, instance.host_id)'),
  'create-timeout cleanup must run paid purchase compensation after winning creating->error transition'
)

assert.ok(
  appSource.includes('const instanceCreationReservesPorts = (networkMode: string) => networkModeAllowsPortMapping(networkMode)') &&
    appSource.includes('portCount: instanceCreationReservesPorts(instance.network_mode) ? (instance.port_limit || 0) : 0') &&
    appSource.includes('if (networkModeNeedsPublicIpv4(instance.network_mode))') &&
    appSource.includes('await prisma.$transaction((tx) => releasePublicIpv4ForInstance(tx, instance.id))'),
  'create-timeout cleanup must use the shared network-mode helper for port quota and release reserved public IPv4 addresses'
)

assert.ok(
  !adminBillingSource.includes('async function createInstanceAsync(') &&
    failureSection.includes('await compensateFailedInstanceCreation({') &&
    compensationHelperSection.includes("status: 'creating'") &&
    compensationHelperSection.includes('await db.rollbackResources({') &&
    compensationHelperSection.includes('await db.releasePublicIpv4ForInstance(tx, instanceId)') &&
    compensationHelperSection.includes('await db.compensateFailedInstancePurchase(instanceId, userId, host.id, tx)'),
  'admin paid jobs must use the shared worker and atomic resource/public IPv4/billing compensation instead of a legacy executor'
)

assert.ok(
  failureSection.includes("if (current && ['running', 'stopped'].includes(current.status)) throw error") &&
    failureSection.includes('if (names.includes(`/1.0/instances/${encodeURIComponent(config.name)}`)) throw error') &&
    failureSection.includes("throw new Error('實例狀態已改變；保留遠端資源並等待核實')") &&
    !failureSection.includes('await deleteInstance(client, config.name)'),
  'shared provisioning must preserve committed or existing remote resources for ownership review rather than refunding or deleting them after an uncertain failure'
)

const managedAsyncSection = section(
  managedProvisionSource,
  'export async function provisionManagedInstanceAsync(',
  '\n}\n'
)

assert.ok(
  managedAsyncSection.includes("where: { id: instanceId, status: 'creating' }") &&
    managedAsyncSection.includes('await db.rollbackResources({') &&
    managedAsyncSection.includes('await prisma.$transaction((tx) => db.releasePublicIpv4ForInstance(tx, instanceId))') &&
    managedAsyncSection.includes('await db.compensateFailedInstancePurchase(instanceId, instance.userId, instance.hostId)') &&
    managedAsyncSection.includes('await deleteInstance(client, config.name)'),
  'managed host-owner/admin gifted instance async failures must claim creating->error, release resources/public IPv4, compensate any paid ledger, and clean Incus leftovers'
)

assert.ok(
  instancesSource.includes('宿主机 ${host.name} 没有可用独立 IPv4 地址') &&
    postTransactionPreparationSection.includes('throw new Error(`宿主机 ${host.name} 没有可用独立 IPv4 地址`)'),
  'public IPv4 allocation races must enter the same resource and billing compensation path'
)

assert.ok(adminBillingSource.includes('await createPreparingProvisionJob(tx, instance.id, {') && !adminBillingSource.includes('createInstanceAsync(instanceId, host, {'), 'admin creation must enqueue within the purchase transaction instead of launching the legacy executor')

const hostRoutesSource = readFileSync(resolve(__dirname, '../src/routes/hosts.ts'), 'utf8')
assert.ok(hostRoutesSource.includes('await createPreparingProvisionJob(tx, instance.id, {') && !hostRoutesSource.includes('provisionManagedInstanceAsync(instanceId,'), 'managed creation must enqueue within its reservation transaction')
assert.ok(durableSource.includes("status: 'preparing', phase: 'preparing'") && durableSource.includes('encryptSensitiveData(JSON.stringify(input))'), 'preparing jobs must preserve encrypted recovery input')
assert.ok(durableSource.includes('if (!ipv4) ipv4 = await db.allocateAndReserveNatIpv4') && durableSource.includes('publicIpv4Address.findFirst') && durableSource.includes('let ipv6 = instance.ipv6'), 'preparing recovery must reuse previously reserved addresses')
assert.ok(durableSource.includes("status: 'pending', phase: 'queued'") && durableSource.includes('tx.instance.update'), 'preparation must commit queued payload and instance addresses together')
assert.ok(instancesSource.includes('await prepareDurableInstance(job.instanceId, host, input)') && instancesSource.includes('await finishInstanceProvisioning(job.instanceId, host, input.config, input.userId)') && instancesSource.includes("phase: 'postcommit'"), 'worker must recover both preparing and already committed creation')

assert.ok(
  managedAsyncSection.includes('await stopInstance(client, config.name, true)') &&
    managedAsyncSection.includes('await deleteInstance(client, config.name)'),
  'managed async success must clean Incus if timeout cleanup won the creating status race'
)

assert.ok(
  compensationSection.includes('await advisoryTransactionLock(tx, USER_BALANCE_LOCK_NAMESPACE, userId)'),
  'failed paid provisioning refund must use a blocking user balance lock'
)

assert.ok(
  compensationSection.includes("type: 'newPurchase'") &&
    compensationSection.includes("type: 'refund'") &&
    compensationSection.includes("remark: { contains: '实例创建失败自动退款' }"),
  'failed paid provisioning refund must be idempotent against existing failure refunds'
)

assert.ok(
  compensationSection.includes("data: { balance: { increment: refundAmount } }") &&
    compensationSection.includes("type: 'refund'") &&
    compensationSection.includes('amount: refundAmount') &&
    compensationSection.includes('amount: -refundAmount') &&
    compensationSection.includes('balanceLogId: balanceLog.id'),
  'failed paid provisioning must refund user balance and create matching billing refund record'
)

assert.ok(
  compensationSection.includes('USER_AFF_BALANCE_LOCK_NAMESPACE') &&
    compensationSection.includes("type: 'new_purchase'") &&
    compensationSection.includes('amount: -commissionAmount') &&
    compensationSection.includes("remark: `实例创建失败返利冲正：${instance.name}`") &&
    compensationSection.includes('usedCount: { decrement: 1 }') &&
    compensationSection.includes('totalEarnings: { decrement: commissionAmount }'),
  'failed paid provisioning must reverse AFF commission logs and counters'
)

assert.ok(
  compensationSection.includes('await tx.hostingBalanceLog.deleteMany({') &&
    compensationSection.includes("type: 'income'") &&
    compensationSection.includes("actionType: 'purchase'") &&
    compensationSection.includes('frozen: true'),
  'failed paid provisioning must remove unearned hosted-node frozen purchase income'
)

console.log('instance create failure compensation checks passed')
