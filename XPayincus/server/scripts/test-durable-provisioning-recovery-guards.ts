import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const instances = source('../src/routes/instances.ts')
const durable = source('../src/lib/durable-instance-provision.ts')
const operations = source('../src/routes/operations.ts')
const tasks = source('../../client/src/views/TasksView.vue')
const maintenance = source('../src/services/host-maintenance.ts')
const adminRouter = source('../../client/src/router/admin.ts')
const adminNavigation = source('../../client/src/config/side-nav-items-admin.ts')

function indexOfOrThrow(sourceText: string, pattern: string, label: string): number {
  const index = sourceText.indexOf(pattern)
  assert.ok(index >= 0, `Missing ${label}: ${pattern}`)
  return index
}

function section(sourceText: string, startPattern: string, endPattern: string): string {
  const start = indexOfOrThrow(sourceText, startPattern, startPattern)
  const end = indexOfOrThrow(sourceText.slice(start), endPattern, endPattern)
  return sourceText.slice(start, start + end)
}

const durableInputSection = section(durable, 'export interface DurableProvisionInput {', '\n}\n\nexport async function createPreparingProvisionJob')
const cloudInitStart = indexOfOrThrow(durable, '  if (config.instanceType === \'vm\') {', 'durable cloud-init generation')
const cloudInitEndMarker = '  Object.assign(config, { ipv4Address: ipv4, ipv6Address: ipv6, ipv6Gateway: host.ipv6_gateway, hostInterface: host.ipv6_parent_interface || \'eth0\', storagePool: pool })'
const cloudInitEnd = indexOfOrThrow(durable, cloudInitEndMarker, 'durable config preparation')
const cloudInitSection = durable.slice(cloudInitStart, cloudInitEnd + cloudInitEndMarker.length)

for (const path of ['../src/routes/admin-billing.ts', '../src/routes/hosts.ts']) {
  const route = source(path)
  assert.ok(route.includes('await createPreparingProvisionJob(tx, instance.id, {'), `${path} must create its job in the reservation transaction`)
  assert.ok(!route.includes('provisionManagedInstanceAsync(instanceId,') && !route.includes('createInstanceAsync(instanceId, host, {'), `${path} must use the durable worker`)
}
assert.ok(durableInputSection.includes('export interface DurableProvisionInput {'))
assert.ok(!/\brootPassword\s*[?:]/.test(durableInputSection), 'DurableProvisionInput must not contain a rootPassword field')
assert.ok(durable.includes('encryptSensitiveData(JSON.stringify(input))'))
assert.ok(!/\b(?:rootPassword|password)\s*[:?]/i.test(cloudInitSection), 'durable cloud-init and config preparation must not inject a root password')
assert.ok(cloudInitSection.includes('generateVmConfig({') && cloudInitSection.includes('generateIncusConfig({'))
assert.ok(cloudInitSection.includes('Object.assign(config, {'), 'durable preparation must retain the expected network/storage config assembly')
assert.ok(durable.includes('if (!ipv4) ipv4 = await db.allocateAndReserveNatIpv4'))
assert.ok(durable.includes('publicIpv4Address.findFirst'))
assert.ok(durable.includes('let ipv6 = instance.ipv6'))
assert.ok(durable.includes("where: { instanceId, status: 'preparing' }"))
assert.ok(durable.includes("status: 'pending', phase: 'queued'"))
assert.ok(instances.includes('await prepareDurableInstance(job.instanceId, host, input)'))
assert.ok(instances.includes("phase: 'postcommit'"))
assert.ok(instances.includes('提交後遠端資源歸屬不符'))
assert.ok(instances.includes('await finishInstanceProvisioning(job.instanceId, host, input.config, input.userId)'))
assert.ok(instances.includes("completed.has('ports_completed')") && instances.includes("completed.has('email_completed')"))
assert.ok(instances.includes('updatedAt: job.updatedAt, instance:'))
assert.ok(operations.includes("request.user.role === 'admin'") && operations.includes("=== 'review_required'"))
assert.ok(tasks.includes('v-if="item.canRetry"') && tasks.includes('api.instances.retryProvisioning(item.instanceId)'))
assert.ok(adminRouter.includes("path: '/admin/tasks'") && adminRouter.includes("import('@/views/TasksView.vue')"))
assert.ok(adminNavigation.includes("path: '/admin/tasks'"))
assert.ok(source('../../client/src/api/admin.ts').includes("http.get('/operations/tasks', { params })"))
for (const path of ['../../client/src/api/index.ts', '../../client/src/api/admin.ts']) {
  const api = source(path)
  assert.ok(api.includes('`/instances/${id}/provisioning/retry`'))
  assert.ok(api.includes('`/hosts/${id}/maintenance-plans/${planId}/review`'))
}
assert.ok(maintenance.includes('recorded.every(row => row.cleanupAuthorized === true)'))
assert.ok(maintenance.includes('Object.assign(result, { cleanupAuthorized: true })'))
assert.ok(maintenance.includes("action !== 'cleanup' && recorded.some(row => row.cleanupAuthorized)"))
console.log('durable provisioning recovery guards passed')
