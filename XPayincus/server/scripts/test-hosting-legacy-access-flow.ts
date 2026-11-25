import assert from 'node:assert/strict'
import Fastify from 'fastify'

process.env.DATABASE_URL ||= 'postgresql://localhost:5432/validation_only'
const { prisma } = await import('../src/db/prisma.js')
const { default: hostingRoutes } = await import('../src/routes/hosting.js')
const { default: adminHostingRoutes } = await import('../src/routes/admin-hosting.js')
const { setCachedConfig } = await import('../src/lib/config-cache.js')
const { checkHostingAccess, getUserHostingFeatureStatus } = await import('../src/lib/hosting-access.js')

type LegacyStatus = 'pending' | 'approved' | 'rejected' | null

let status: LegacyStatus = null
let hasCreatedHostBefore = false
let instanceCount = 0
let incomeReads = 0
let blockReads = 0
const originals = {
  user: prisma.user.findUnique,
  instance: prisma.instance.count,
  aggregate: prisma.hostingBalanceLog.aggregate,
  withdrawalAggregate: prisma.hostingWithdrawal.aggregate,
  blockList: prisma.hostingUserBlock.findMany
}

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

const headers = { authorization: 'user' }
const admin = { authorization: 'admin' }
const blockRequests = [
  { method: 'GET', url: '/api/hosting/blocks' },
  { method: 'GET', url: '/api/hosting/blocks/search?keyword=example' },
  { method: 'POST', url: '/api/hosting/blocks', payload: { userId: 3 } },
  { method: 'DELETE', url: '/api/hosting/blocks/3' }
] as const

const assetRequests = [
  { method: 'GET', url: '/api/hosting/balance' },
  { method: 'GET', url: '/api/hosting/logs' },
  { method: 'GET', url: '/api/hosting/withdrawals' },
  { method: 'GET', url: '/api/hosting/stats' },
  { method: 'POST', url: '/api/hosting/withdraw', payload: { amount: 10 } }
] as const

async function expectDenied(requests: typeof blockRequests | typeof assetRequests) {
  for (const request of requests) {
    const response = await app.inject({ ...request, headers })
    assert.equal(response.statusCode, 403, `${request.method} ${request.url}`)
    assert.equal(response.json().code, 'HOSTING_ACCESS_DENIED')
  }
}

try {
  prisma.user.findUnique = (async ({ where }: { where: { id?: number } }) => {
    if (where.id !== 1 && where.id !== 2) return null
    return {
      role: where.id === 2 ? 'admin' : 'user',
      hasCreatedHostBefore,
      hostingBalance: 25,
      hostingAccessApplications: status ? [{ status }] : []
    }
  }) as typeof prisma.user.findUnique
  prisma.instance.count = (async () => instanceCount) as typeof prisma.instance.count
  prisma.hostingBalanceLog.aggregate = (async () => {
    incomeReads++
    return { _sum: { amount: 0 } }
  }) as typeof prisma.hostingBalanceLog.aggregate
  prisma.hostingWithdrawal.aggregate = (async () => ({ _sum: { actualAmount: 0, amount: 0 } })) as typeof prisma.hostingWithdrawal.aggregate
  prisma.hostingUserBlock.findMany = (async () => {
    blockReads++
    return []
  }) as typeof prisma.hostingUserBlock.findMany
  setCachedConfig('hosting_feature_enabled', 'true')

  await app.register(hostingRoutes, { prefix: '/api/hosting' })
  await app.register(adminHostingRoutes)

  const removedRequests = [
    { method: 'GET', url: '/api/hosting/application', headers },
    { method: 'POST', url: '/api/hosting/application', headers, payload: { reason: 'retired' } },
    { method: 'GET', url: '/api/admin/hosting/applications', headers: admin },
    { method: 'POST', url: '/api/admin/hosting/applications/1/approve', headers: admin, payload: {} },
    { method: 'POST', url: '/api/admin/hosting/applications/1/reject', headers: admin, payload: { reviewReason: 'retired' } }
  ] as const
  for (const request of removedRequests) {
    assert.equal((await app.inject(request)).statusCode, 404, `${request.method} ${request.url}`)
  }

  assert.equal((await app.inject('/api/hosting/access-check')).statusCode, 401)
  const accessCheck = () => app.inject({ url: '/api/hosting/access-check', headers })
  const listBlocks = () => app.inject({ url: '/api/hosting/blocks', headers })

  hasCreatedHostBefore = true
  instanceCount = 2
  const unapprovedStatuses: LegacyStatus[] = [null, 'pending', 'rejected']
  for (const legacyStatus of unapprovedStatuses) {
    status = legacyStatus
    assert.equal((await checkHostingAccess(1)).allowed, false)
    assert.equal((await getUserHostingFeatureStatus(1)).canAccessHostingFeature, false)
    await expectDenied(blockRequests)
    await expectDenied(assetRequests)
  }
  assert.equal(incomeReads, 0)
  assert.equal(blockReads, 0)
  assert.equal((await checkHostingAccess(3)).allowed, false)
  assert.equal((await checkHostingAccess(2)).allowed, true)

  status = 'approved'
  hasCreatedHostBefore = false
  instanceCount = 0
  assert.equal((await checkHostingAccess(1)).allowed, true)
  assert.equal((await getUserHostingFeatureStatus(1)).canAccessHostingFeature, true)
  const legacyAccess = await accessCheck()
  assert.equal(legacyAccess.statusCode, 200)
  assert.equal(legacyAccess.json().details.applicationStatus, 'approved')
  assert.equal((await listBlocks()).statusCode, 200)

  setCachedConfig('hosting_feature_enabled', 'false')
  assert.equal((await getUserHostingFeatureStatus(1)).canAccessHostingFeature, false)
  const hiddenAccess = (await accessCheck()).json()
  assert.equal(hiddenAccess.allowed, false)
  assert.equal(hiddenAccess.details.hiddenBySystemSetting, true)
  await expectDenied(blockRequests)
  assert.equal(blockReads, 1)

  const balance = await app.inject({ url: '/api/hosting/balance', headers })
  assert.equal(balance.statusCode, 200)
  assert.equal(balance.json().balance.available, 25)

  hasCreatedHostBefore = true
  assert.equal((await getUserHostingFeatureStatus(1)).canAccessHostingFeature, true)
  assert.equal((await checkHostingAccess(1)).allowed, true)
  assert.equal((await listBlocks()).statusCode, 200)
  assert.equal(blockReads, 2)
  console.log('hosting legacy access flow passed')
} finally {
  await app.close()
  prisma.user.findUnique = originals.user
  prisma.instance.count = originals.instance
  prisma.hostingBalanceLog.aggregate = originals.aggregate
  prisma.hostingWithdrawal.aggregate = originals.withdrawalAggregate
  prisma.hostingUserBlock.findMany = originals.blockList
  await prisma.$disconnect()
}
process.exit(0)
