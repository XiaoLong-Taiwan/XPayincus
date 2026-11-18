import assert from 'node:assert/strict'
import Fastify from 'fastify'

process.env.DATABASE_URL ||= 'postgresql://localhost:5432/validation_only'
const { prisma } = await import('../src/db/prisma.js')
const { default: applicationRoutes } = await import('../src/routes/hosting-access-applications.js')
const { default: hostingRoutes } = await import('../src/routes/hosting.js')
const { setCachedConfig } = await import('../src/lib/config-cache.js')
const { checkHostingAccess, getUserHostingFeatureStatus } = await import('../src/lib/hosting-access.js')

let application: any = null
let hasCreatedHostBefore = false
let incomeReads = 0
let blockReads = 0
const originals = {
  find: prisma.hostingAccessApplication.findUnique,
  findOrThrow: prisma.hostingAccessApplication.findUniqueOrThrow,
  list: prisma.hostingAccessApplication.findMany,
  create: prisma.hostingAccessApplication.createMany,
  update: prisma.hostingAccessApplication.updateMany,
  user: prisma.user.findUnique,
  instance: prisma.instance.count,
  aggregate: prisma.hostingBalanceLog.aggregate,
  withdrawalAggregate: prisma.hostingWithdrawal.aggregate,
  blockList: prisma.hostingUserBlock.findMany,
  log: prisma.log.create
}
prisma.hostingAccessApplication.findUnique = (async () => application) as any
prisma.hostingAccessApplication.findUniqueOrThrow = (async () => application) as any
prisma.hostingAccessApplication.findMany = (async () => application ? [application] : []) as any
prisma.hostingAccessApplication.createMany = (async ({ data }: any) => {
  if (application) return { count: 0 }
  application = { id: 1, ...data[0], status: 'pending', reviewReason: null, reviewedById: null, reviewedAt: null, createdAt: new Date(), updatedAt: new Date() }
  return { count: 1 }
}) as any
prisma.hostingAccessApplication.updateMany = (async ({ where, data }: any) => {
  if (!application || where.id !== application.id || where.status !== application.status) return { count: 0 }
  application = { ...application, ...data, updatedAt: new Date() }
  return { count: 1 }
}) as any
prisma.user.findUnique = (async () => ({ role: 'user', hasCreatedHostBefore, hostingBalance: 25, hostingAccessApplications: application ? [{ status: application.status }] : [] })) as any
prisma.instance.count = (async () => 0) as any
prisma.hostingBalanceLog.aggregate = (async () => { incomeReads++; return { _sum: { amount: 0 } } }) as any
prisma.hostingWithdrawal.aggregate = (async () => ({ _sum: { actualAmount: 0, amount: 0 } })) as any
prisma.hostingUserBlock.findMany = (async () => { blockReads++; return [] }) as any
prisma.log.create = (async () => ({})) as any
setCachedConfig('hosting_feature_enabled', 'true')

const app = Fastify()
app.decorate('authenticate', async (request, reply) => {
  const role = request.headers.authorization
  if (role !== 'user' && role !== 'admin') return reply.code(401).send({ error: 'Unauthorized' })
  request.user = { id: role === 'admin' ? 2 : 1, role } as typeof request.user
})
app.decorate('authenticateUser', app.authenticate)
app.decorate('requireAdmin', async (request, reply) => {
  if (request.user.role !== 'admin') return reply.code(403).send({ error: 'Forbidden' })
})
await app.register(applicationRoutes)
await app.register(hostingRoutes, { prefix: '/api/hosting' })
const headers = { authorization: 'user' }
const admin = { authorization: 'admin' }
const blockRequests = [
  { method: 'GET', url: '/api/hosting/blocks' },
  { method: 'GET', url: '/api/hosting/blocks/search?keyword=example' },
  { method: 'POST', url: '/api/hosting/blocks', payload: { userId: 3 } },
  { method: 'DELETE', url: '/api/hosting/blocks/3' }
] as const

async function expectBlocksDenied() {
  for (const request of blockRequests) {
    const response = await app.inject({ ...request, headers })
    assert.equal(response.statusCode, 403, `${request.method} ${request.url}`)
    assert.equal(response.json().code, 'HOSTING_ACCESS_DENIED')
  }
}

try {
  assert.equal((await app.inject('/api/hosting/application')).statusCode, 401)
  assert.equal((await app.inject({ url: '/api/hosting/application', headers })).json().application, null)
  for (const status of [null, 'pending', 'rejected']) {
    application = status ? { status } : null
    assert.equal((await checkHostingAccess(1)).allowed, false)
    await expectBlocksDenied()
    for (const route of ['balance', 'logs', 'withdrawals', 'stats']) {
      assert.equal((await app.inject({ url: `/api/hosting/${route}`, headers })).statusCode, 403)
    }
    assert.equal((await app.inject({ method: 'POST', url: '/api/hosting/withdraw', headers, payload: { amount: 10 } })).statusCode, 403)
  }
  assert.equal(incomeReads, 0)
  hasCreatedHostBefore = true
  await expectBlocksDenied()
  assert.equal(blockReads, 0)
  hasCreatedHostBefore = false
  application = null
  const submit = (reason: string) => app.inject({ method: 'POST', url: '/api/hosting/application', headers, payload: { reason } })
  assert.equal((await submit('   ')).statusCode, 400)
  assert.equal((await submit('測試託管資源')).statusCode, 201)
  assert.equal((await submit('重複提交')).statusCode, 409)
  assert.equal((await app.inject({ url: '/api/admin/hosting/applications', headers })).statusCode, 403)
  assert.equal((await app.inject({ url: '/api/admin/hosting/applications?status=invalid', headers: admin })).statusCode, 400)
  const review = (action: string, payload = {}, id = '1') => app.inject({ method: 'POST', url: `/api/admin/hosting/applications/${id}/${action}`, headers: admin, payload })
  assert.equal((await review('approve', {}, '0')).statusCode, 400)
  assert.equal((await review('reject', { reviewReason: ' ' })).statusCode, 400)
  assert.equal((await review('reject', { reviewReason: '請補充資源說明' })).statusCode, 200)
  assert.equal((await submit('補充資源說明')).statusCode, 201)
  assert.equal((await review('approve')).statusCode, 200)
  assert.equal((await checkHostingAccess(1)).allowed, true)
  assert.equal((await review('approve')).statusCode, 409)
  assert.equal((await review('reject', { reviewReason: '重複審核' })).statusCode, 409)
  assert.equal((await submit('已核准再次提交')).statusCode, 409)
  assert.equal((await app.inject({ url: '/api/admin/hosting/applications', headers: admin })).json().applications[0].status, 'approved')
  assert.equal((await getUserHostingFeatureStatus(1)).canAccessHostingFeature, true)
  const listBlocks = () => app.inject({ url: '/api/hosting/blocks', headers })
  assert.equal((await listBlocks()).statusCode, 200)

  setCachedConfig('hosting_feature_enabled', 'false')
  assert.equal((await getUserHostingFeatureStatus(1)).canAccessHostingFeature, false)
  const access = (await app.inject({ url: '/api/hosting/access-check', headers })).json()
  assert.equal(access.allowed, false)
  assert.equal(access.details.hiddenBySystemSetting, true)
  await expectBlocksDenied()
  assert.equal(blockReads, 1)
  const balance = await app.inject({ url: '/api/hosting/balance', headers })
  assert.equal(balance.statusCode, 200)
  assert.equal(balance.json().balance.available, 25)

  hasCreatedHostBefore = true
  assert.equal((await getUserHostingFeatureStatus(1)).canAccessHostingFeature, true)
  assert.equal((await checkHostingAccess(1)).allowed, true)
  assert.equal((await listBlocks()).statusCode, 200)
  assert.equal(blockReads, 2)
  console.log('hosting application flow passed: review, block access, and feature visibility')
} finally {
  await app.close()
  prisma.hostingAccessApplication.findUnique = originals.find
  prisma.hostingAccessApplication.findUniqueOrThrow = originals.findOrThrow
  prisma.hostingAccessApplication.findMany = originals.list
  prisma.hostingAccessApplication.createMany = originals.create
  prisma.hostingAccessApplication.updateMany = originals.update
  prisma.user.findUnique = originals.user
  prisma.instance.count = originals.instance
  prisma.hostingBalanceLog.aggregate = originals.aggregate
  prisma.hostingWithdrawal.aggregate = originals.withdrawalAggregate
  prisma.hostingUserBlock.findMany = originals.blockList
  prisma.log.create = originals.log
  await prisma.$disconnect()
}
process.exit(0)
