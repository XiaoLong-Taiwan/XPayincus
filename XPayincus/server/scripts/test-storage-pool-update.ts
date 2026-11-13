import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Fastify from 'fastify'
import ts from 'typescript'
import type { StoragePurpose } from '@prisma/client'
import type { UpdateStoragePoolData } from '../src/db/storage-pools.js'

const rows = [
  { hostId: 1, name: 'shared', purpose: 'instance_storage' as StoragePurpose, description: 'original', config: {} },
  { hostId: 2, name: 'shared', purpose: 'instance_storage' as StoragePurpose, description: 'other', config: {} }
]
let forceZero = false
let writes = 0
const events: string[] = []
const prisma = {
  storagePool: {
    findUnique: async ({ where }: { where: { hostId_name: { hostId: number; name: string } } }) => {
      events.push(`lookup:${where.hostId_name.hostId}:${where.hostId_name.name}`)
      return rows.find(row => row.hostId === where.hostId_name.hostId && row.name === where.hostId_name.name) ?? null
    },
    updateMany: async ({ where, data }: { where: { hostId: number; name: string }; data: UpdateStoragePoolData }) => {
      events.push(`write:${where.hostId}:${where.name}`)
      writes++
      const matches = forceZero ? [] : rows.filter(row => row.hostId === where.hostId && row.name === where.name)
      for (const row of matches) Object.assign(row, data)
      return { count: matches.length }
    }
  }
}
const dbSource = readFileSync(new URL('../src/db/storage-pools.ts', import.meta.url), 'utf8')
const exports = {}
new Function('require', 'exports', ts.transpile(dbSource, {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS
}))((name: string) => {
  assert.equal(name, './prisma.js')
  return { prisma }
}, exports)
const storage = exports as typeof import('../src/db/storage-pools.js')

assert.deepEqual(await storage.updateStoragePool(1, 'shared', { purpose: 'instance_data' }), { count: 1 })
assert.equal(rows[0]!.purpose, 'instance_data')
assert.equal(rows[1]!.purpose, 'instance_storage')
assert.deepEqual(await storage.updateStoragePool(1, 'shared', { purpose: 'instance_storage' }), { count: 1 })
assert.equal(rows[0]!.purpose, 'instance_storage')
await storage.updateStoragePool(1, 'shared', { description: '', config: { size: '20GiB' } })
assert.equal(rows[0]!.description, '')
assert.deepEqual(rows[0]!.config, { size: '20GiB' })
assert.equal(rows[0]!.purpose, 'instance_storage')
assert.equal(rows[1]!.description, 'other')
await assert.rejects(storage.updateStoragePool(3, 'shared', { purpose: 'instance_data' }), /先关联/)
rows[0]!.description = 'original'

const routeSource = readFileSync(new URL('../src/routes/hosts.ts', import.meta.url), 'utf8')
const start = routeSource.indexOf('  fastify.patch<{', routeSource.indexOf('// 修改存储池配置'))
const end = routeSource.indexOf('// ==================== Caddy', start)
assert.ok(start > 0 && end > start)
let incusClients = 0
const incusUpdates: unknown[][] = []
let failIncusUpdate = false
let successLogs = 0
const app = Fastify()
app.decorate('authenticate', async (request, reply) => {
  const id = Number(request.headers['x-test-user'])
  if (!id) return reply.code(401).send({ error: 'Unauthorized' })
  request.user = { id, role: request.headers['x-test-role'] ?? 'user' } as typeof request.user
})
new Function('fastify', 'db', 'parsePositiveRouteId', 'apiError', 'ErrorCode', 'getIncusClient', 'updateStoragePool', 'createLog',
  ts.transpile(routeSource.slice(start, end), { target: ts.ScriptTarget.ES2022 }))(
  app,
  { ...storage, getHostById: async (id: number) => id <= 3 ? { id, user_id: 1, name: `host-${id}` } : null },
  (value: string) => /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null,
  (code: string) => ({ code }),
  { INVALID_ID: 'INVALID_ID', HOST_NOT_FOUND: 'HOST_NOT_FOUND', FORBIDDEN: 'FORBIDDEN' },
  async (host: { id: number }) => { events.push(`incus:${host.id}`); incusClients++; return {} },
  async (...args: unknown[]) => {
    events.push('incus:update')
    incusUpdates.push(args)
    if (failIncusUpdate) throw new Error('Incus update failed')
  },
  async () => { events.push('log:success'); successLogs++ }
)
const patch = (hostId: number | string, payload: object, headers = { 'x-test-user': '1' }) =>
  app.inject({ method: 'PATCH', url: `/${hostId}/storage-pools/shared`, payload, headers })
try {
  for (const purpose of ['instance_data', 'instance_storage'] as const) {
    events.length = 0
    const response = await patch(1, { purpose })
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(rows[0]!.purpose, purpose)
    assert.equal(rows[1]!.purpose, 'instance_storage')
    assert.deepEqual(events, ['lookup:1:shared', 'write:1:shared', 'log:success'])
  }
  assert.equal(incusClients, 0)
  assert.equal(incusUpdates.length, 0)
  assert.equal(successLogs, 2)

  const writesBeforeRejections = writes
  for (const payload of [
    { purpose: 'instance_data' }, { size: '40GiB' }, { description: 'new' },
    { size: '40GiB', description: 'new', purpose: 'instance_data' }
  ]) {
    events.length = 0
    const response = await patch(3, payload)
    assert.equal(response.statusCode, 404)
    assert.match(response.json().error, /先关联已有存储池/)
    assert.deepEqual(events, ['lookup:3:shared'])
  }
  events.length = 0
  const missingPool = await app.inject({
    method: 'PATCH', url: '/1/storage-pools/missing', payload: { size: '40GiB' },
    headers: { 'x-test-user': '1' }
  })
  assert.equal(missingPool.statusCode, 404)
  assert.match(missingPool.json().error, /先关联已有存储池/)
  assert.deepEqual(events, ['lookup:1:missing'])
  assert.equal((await patch(1, { purpose: 'instance_data' }, {})).statusCode, 401)
  assert.equal((await patch(1, { purpose: 'instance_data' }, { 'x-test-user': '2' })).statusCode, 403)
  assert.equal((await patch('1abc', { purpose: 'instance_data' })).statusCode, 400)
  assert.equal((await patch(4, { purpose: 'instance_data' })).statusCode, 404)
  assert.equal((await patch(1, { purpose: 'invalid' })).statusCode, 400)
  assert.equal((await patch(1, {})).statusCode, 400)
  assert.equal(writes, writesBeforeRejections)
  assert.equal(incusClients, 0)
  assert.equal(successLogs, 2)

  forceZero = true
  const zero = await patch(1, { purpose: 'instance_data' })
  assert.equal(zero.statusCode, 500)
  assert.match(zero.json().error, /关联已失效/)
  assert.equal(rows[0]!.purpose, 'instance_storage')
  assert.equal(successLogs, 2)
  assert.equal(incusClients, 0)
  forceZero = false

  const admin = await app.inject({
    method: 'PATCH', url: '/2/storage-pools/shared', payload: { purpose: 'instance_data' },
    headers: { 'x-test-user': '2', 'x-test-role': 'admin' }
  })
  assert.equal(admin.statusCode, 200)
  assert.equal(rows[1]!.purpose, 'instance_data')
  assert.equal(rows[0]!.purpose, 'instance_storage')

  events.length = 0
  const unchangedDescription = await patch(1, { description: 'original', purpose: 'instance_data' })
  assert.equal(unchangedDescription.statusCode, 200, unchangedDescription.body)
  assert.equal(rows[0]!.purpose, 'instance_data')
  assert.equal(incusClients, 0)
  assert.deepEqual(events, ['lookup:1:shared', 'write:1:shared', 'log:success'])

  const description = await patch(1, { description: '' })
  assert.equal(description.statusCode, 200)
  assert.equal(incusClients, 1)
  assert.deepEqual(incusUpdates, [[{}, 'shared', { config: undefined, description: '' }]])

  events.length = 0
  const unchangedEmptyDescription = await patch(1, { description: '', purpose: 'instance_storage' })
  assert.equal(unchangedEmptyDescription.statusCode, 200, unchangedEmptyDescription.body)
  assert.equal(rows[0]!.purpose, 'instance_storage')
  assert.equal(incusClients, 1)
  assert.deepEqual(events, ['lookup:1:shared', 'write:1:shared', 'log:success'])

  events.length = 0
  const mixed = await patch(1, { size: '40GiB', description: 'updated', purpose: 'instance_data' })
  assert.equal(mixed.statusCode, 200, mixed.body)
  assert.deepEqual(events, ['lookup:1:shared', 'incus:1', 'incus:update', 'write:1:shared', 'log:success'])
  assert.deepEqual(incusUpdates.at(-1), [{}, 'shared', { config: { size: '40GiB' }, description: 'updated' }])
  assert.equal(rows[0]!.purpose, 'instance_data')
  assert.equal(rows[0]!.description, 'updated')
  assert.equal(rows[1]!.description, 'other')

  events.length = 0
  const writesBeforeSize = writes
  const size = await patch(1, { size: '60GiB' })
  assert.equal(size.statusCode, 200, size.body)
  assert.deepEqual(events, ['lookup:1:shared', 'incus:1', 'incus:update', 'log:success'])
  assert.deepEqual(incusUpdates.at(-1), [{}, 'shared', { config: { size: '60GiB' }, description: undefined }])
  assert.equal(writes, writesBeforeSize)

  events.length = 0
  const rowsBeforeFailure = structuredClone(rows)
  const logsBeforeFailure = successLogs
  failIncusUpdate = true
  const failed = await patch(1, { size: '80GiB', description: 'failed', purpose: 'instance_storage' })
  assert.equal(failed.statusCode, 500)
  assert.match(failed.json().error, /Incus update failed/)
  assert.deepEqual(events, ['lookup:1:shared', 'incus:1', 'incus:update'])
  assert.deepEqual(rows, rowsBeforeFailure)
  assert.equal(writes, writesBeforeSize)
  assert.equal(successLogs, logsBeforeFailure)
} finally {
  await app.close()
}
console.log('storage pool update behavior tests passed')
