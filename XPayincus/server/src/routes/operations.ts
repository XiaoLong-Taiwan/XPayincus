import type { FastifyInstance } from 'fastify'
import { Prisma } from '@prisma/client'
import { prisma } from '../db/prisma.js'
import { calculateRenewBilling } from '../db/billing-operations.js'
import { getInstanceAffBinding } from '../db/aff.js'
import { arbitrateVipPrice, getUserContinuousVipBenefit } from '../services/vip-benefits.js'
import { addMonths } from '../lib/billing-calc.js'

interface OperationTask {
  id: string
  kind: string
  instanceId: number
  name: string
  status: string
  progress: string | null
  error: string | null
  createdAt: Date
  updatedAt: Date
}

function positiveInteger(value: unknown, fallback: number): number {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return fallback
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : fallback
}

export default async function operationsRoutes(fastify: FastifyInstance) {
  fastify.get<{ Querystring: { page?: string; pageSize?: string } }>('/tasks', {
    onRequest: [fastify.authenticateUser]
  }, async (request, reply) => {
    const page = positiveInteger(request.query.page, 1)
    const pageSize = Math.min(positiveInteger(request.query.pageSize, 20), 100)
    const offset = (page - 1) * pageSize
    if (!Number.isSafeInteger(offset) || offset > 2147483647) {
      return reply.code(400).send({ error: 'Invalid page' })
    }
    const user = request.user
    const taskOwner = user.role === 'admin' ? Prisma.empty
      : Prisma.sql`AND t.user_id = ${user.id} AND i.user_id = ${user.id}`
    const instanceOwner = user.role === 'admin' ? Prisma.empty : Prisma.sql`AND i.user_id = ${user.id}`
    const tasks = Prisma.sql`
      SELECT 'instance-task:' || t.id AS id, t.task_type::text AS kind,
        t.instance_id AS "instanceId", i.name, t.status::text AS status,
        t.progress, t.error, t.created_at AS "createdAt",
        COALESCE(t.finished_at, t.started_at, t.created_at) AS "updatedAt"
      FROM instance_tasks t JOIN instances i ON i.id = t.instance_id
      WHERE TRUE ${taskOwner}
      UNION ALL
      SELECT 'restore-task:' || t.id, 'restore', t.instance_id, i.name,
        t.status::text, t.progress, t.error, t.created_at,
        COALESCE(t.finished_at, t.started_at, t.created_at)
      FROM restore_tasks t JOIN instances i ON i.id = t.instance_id
      WHERE TRUE ${taskOwner}
      UNION ALL
      SELECT 'provisioning-job:' || t.id, 'create', t.instance_id, i.name,
        CASE t.status WHEN 'completed' THEN 'COMPLETED' WHEN 'failed' THEN 'FAILED'
          WHEN 'review_required' THEN 'FAILED' WHEN 'pending' THEN 'PENDING' ELSE 'PROCESSING' END,
        t.phase, t.error, t.created_at, t.updated_at
      FROM provisioning_jobs t JOIN instances i ON i.id = t.instance_id
      WHERE TRUE ${instanceOwner}
      UNION ALL
      SELECT 'instance-create:' || i.id, 'create', i.id, i.name,
        'PROCESSING', NULL::text, NULL::text, i.created_at, i.updated_at
      FROM instances i WHERE i.status = 'creating' ${instanceOwner}
        AND NOT EXISTS (SELECT 1 FROM provisioning_jobs job WHERE job.instance_id = i.id)
        AND NOT EXISTS (
          SELECT 1 FROM instance_tasks active
          WHERE (active.instance_id = i.id OR active.new_instance_id = i.id)
            AND active.status IN ('PENDING', 'PROCESSING')
        )
    `
    return prisma.$transaction(async tx => {
      const counts = await tx.$queryRaw<Array<{ total: bigint }>>(Prisma.sql`
        SELECT COUNT(*) AS total FROM (${tasks}) operations
      `)
      const items = await tx.$queryRaw<OperationTask[]>(Prisma.sql`
        SELECT * FROM (${tasks}) operations
        ORDER BY "createdAt" DESC, id DESC LIMIT ${pageSize} OFFSET ${offset}
      `)
      const ids = items.filter(item => item.id.startsWith('provisioning-job:')).map(item => item.instanceId)
      const jobs = ids.length ? await tx.provisioningJob.findMany({ where: { instanceId: { in: ids } }, select: { instanceId: true, status: true } }) : []
      const states = new Map(jobs.map(job => [job.instanceId, job.status]))
      return { items: items.map(item => ({ ...item, canRetry: request.user.role === 'admin' && item.id.startsWith('provisioning-job:') && states.get(item.instanceId) === 'review_required' })), total: Number(counts[0].total) }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead })
  })

  fastify.get<{ Querystring: { days?: string } }>('/renewal-forecast', {
    onRequest: [fastify.authenticateUser]
  }, async (request, reply) => {
    if (request.query.days !== undefined && !['7', '30'].includes(request.query.days)) {
      return reply.code(400).send({ error: 'days must be 7 or 30' })
    }
    const days = request.query.days === '30' ? 30 : 7
    const now = new Date()
    const end = new Date(now.getTime() + days * 24 * 60 * 60 * 1000)
    const renewAheadMs = 24 * 60 * 60 * 1000
    const userId = request.user.id
    const [user, instances, vip] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { balance: true } }),
      prisma.instance.findMany({
        where: {
          userId, autoRenew: true, packagePlanId: { not: null },
          autoRenewAttempts: { lt: 3 },
          status: { notIn: ['suspended', 'deleted'] },
          expiresAt: { gt: now, lte: new Date(end.getTime() + renewAheadMs) }
        },
        orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }]
      }),
      getUserContinuousVipBenefit(userId)
    ])
    const groups = await Promise.all(instances.map(async instance => {
      const months = instance.billingCycle || 1
      const quote = calculateRenewBilling(instance, months)
      const affBinding = await getInstanceAffBinding(instance.id)
      const amount = arbitrateVipPrice({
        basePrice: quote.amount,
        affDiscountRate: affBinding?.affCode.enabled ? Number(affBinding.affCode.discountRate) : 0,
        vipDiscountPercent: vip.benefit.orderDiscountPercent
      }).finalPrice
      const items: Array<{ instanceId: number; name: string; dueAt: string; amount: number; autoRenew: boolean }> = []
      let expiry = instance.expiresAt!
      while (expiry.getTime() - renewAheadMs <= end.getTime()) {
        items.push({
          instanceId: instance.id, name: instance.name,
          dueAt: new Date(Math.max(now.getTime(), expiry.getTime() - renewAheadMs)).toISOString(),
          amount, autoRenew: true
        })
        expiry = addMonths(expiry, months)
      }
      return items
    }))
    const items = groups.flat().sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.instanceId - b.instanceId)
    const balanceCents = Math.round(Number(user.balance) * 100)
    let totalCents = 0
    let firstShortfallAt: string | null = null
    for (const item of items) {
      totalCents += Math.round(item.amount * 100)
      if (firstShortfallAt === null && totalCents > balanceCents) firstShortfallAt = item.dueAt
    }
    return {
      days, balance: balanceCents / 100, total: totalCents / 100,
      shortfall: Math.max(0, totalCents - balanceCents) / 100,
      firstShortfallAt, items
    }
  })
}
