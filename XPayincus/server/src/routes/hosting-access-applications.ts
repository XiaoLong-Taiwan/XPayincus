import type { FastifyInstance, FastifyRequest } from 'fastify'
import { prisma } from '../db/prisma.js'
import { createLog } from '../db/logs.js'
import { apiError, ErrorCode } from '../lib/errors.js'

const MAX_REASON_LENGTH = 1000
const POSITIVE_ROUTE_ID_PATTERN = /^[1-9]\d*$/

function parsePositiveRouteId(value: string): number | null {
  if (!POSITIVE_ROUTE_ID_PATTERN.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function normalizeReason(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const reason = value.trim()
  return reason.length > 0 && reason.length <= MAX_REASON_LENGTH ? reason : null
}

function formatApplication(application: {
  id: number
  userId: number
  status: string
  reason: string
  reviewReason: string | null
  reviewedById: number | null
  reviewedAt: Date | null
  createdAt: Date
  updatedAt: Date
  user?: { id: number; username: string; email: string | null }
  reviewedBy?: { id: number; username: string } | null
}) {
  return {
    id: application.id,
    userId: application.userId,
    status: application.status,
    reason: application.reason,
    reviewReason: application.reviewReason,
    reviewedById: application.reviewedById,
    reviewedAt: application.reviewedAt?.toISOString() ?? null,
    createdAt: application.createdAt.toISOString(),
    updatedAt: application.updatedAt.toISOString(),
    user: application.user ?? null,
    reviewedBy: application.reviewedBy ?? null
  }
}

export default async function hostingAccessApplicationRoutes(fastify: FastifyInstance) {
  fastify.get('/api/hosting/application', {
    onRequest: [fastify.authenticateUser]
  }, async (request) => {
    const application = await prisma.hostingAccessApplication.findUnique({
      where: { userId: request.user.id },
      include: { reviewedBy: { select: { id: true, username: true } } }
    })
    return { application: application ? formatApplication(application) : null }
  })

  fastify.post<{
    Body: { reason?: string }
  }>('/api/hosting/application', {
    onRequest: [fastify.authenticateUser],
    config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
    schema: {
      body: {
        type: 'object',
        required: ['reason'],
        properties: { reason: { type: 'string', minLength: 1, maxLength: MAX_REASON_LENGTH } }
      }
    }
  }, async (request: FastifyRequest<{ Body: { reason?: string } }>, reply) => {
    if (request.user.role === 'admin') {
      return reply.code(400).send(apiError(ErrorCode.INVALID_PARAMS, '管理員不需要提交托管申请'))
    }
    const reason = normalizeReason(request.body.reason)
    if (!reason) return reply.code(400).send(apiError(ErrorCode.INVALID_PARAMS, '申请理由不能为空且不能超过 1000 个字符'))

    const existing = await prisma.hostingAccessApplication.findUnique({ where: { userId: request.user.id } })
    if (existing?.status === 'approved') return reply.code(409).send({ error: '托管上架申请已通过', code: 'HOSTING_APPLICATION_APPROVED' })
    if (existing?.status === 'pending') return reply.code(409).send({ error: '托管上架申请正在审核中', code: 'HOSTING_APPLICATION_PENDING' })

    if (existing) {
      const updated = await prisma.hostingAccessApplication.updateMany({
        where: { id: existing.id, status: 'rejected', updatedAt: existing.updatedAt },
        data: { reason, status: 'pending', reviewReason: null, reviewedById: null, reviewedAt: null }
      })
      if (updated.count !== 1) return reply.code(409).send({ error: '申请状态已变更，请刷新重试' })
    } else {
      const created = await prisma.hostingAccessApplication.createMany({ data: [{ userId: request.user.id, reason }], skipDuplicates: true })
      if (created.count !== 1) return reply.code(409).send({ error: '申请已提交，请刷新状态' })
    }
    const application = await prisma.hostingAccessApplication.findUniqueOrThrow({ where: { userId: request.user.id } })
    await createLog(request.user.id, 'hosting', 'hosting.application.create', `Submitted hosting access application #${application.id}`, 'success')
    return reply.code(201).send({ application: formatApplication(application) })
  })

  fastify.get<{
    Querystring: { status?: 'pending' | 'approved' | 'rejected' }
  }>('/api/admin/hosting/applications', {
    onRequest: [fastify.authenticate, fastify.requireAdmin],
    schema: { querystring: { type: 'object', additionalProperties: false, properties: { status: { type: 'string', enum: ['pending', 'approved', 'rejected'] } } } }
  }, async (request) => {
    const applications = await prisma.hostingAccessApplication.findMany({
      where: request.query.status ? { status: request.query.status } : undefined,
      include: {
        user: { select: { id: true, username: true, email: true } },
        reviewedBy: { select: { id: true, username: true } }
      },
      orderBy: [{ status: 'asc' }, { createdAt: 'asc' }]
    })
    return { applications: applications.map(formatApplication) }
  })

  fastify.post<{
    Params: { id: string }
    Body: { reviewReason?: string }
  }>('/api/admin/hosting/applications/:id/approve', {
    onRequest: [fastify.authenticate, fastify.requireAdmin],
    schema: { body: { type: 'object', additionalProperties: false, properties: { reviewReason: { type: 'string', minLength: 1, maxLength: MAX_REASON_LENGTH } } } }
  }, async (request, reply) => {
    const id = parsePositiveRouteId(request.params.id)
    if (!id) return reply.code(400).send(apiError(ErrorCode.INVALID_ID))
    const reviewReason = request.body?.reviewReason ? normalizeReason(request.body.reviewReason) : null
    if (request.body?.reviewReason && !reviewReason) return reply.code(400).send(apiError(ErrorCode.INVALID_PARAMS, '审核备注不能为空且不能超过 1000 个字符'))
    const result = await prisma.hostingAccessApplication.updateMany({
      where: { id, status: 'pending' },
      data: { status: 'approved', reviewReason, reviewedById: request.user.id, reviewedAt: new Date() }
    })
    if (result.count !== 1) return reply.code(409).send({ error: '申请不存在或已处理', code: 'HOSTING_APPLICATION_ALREADY_PROCESSED' })
    const application = await prisma.hostingAccessApplication.findUniqueOrThrow({ where: { id }, include: { reviewedBy: { select: { id: true, username: true } } } })
    await createLog(request.user.id, 'admin', 'hosting.application.approve', `Approved hosting access application #${id}`, 'success')
    return { application: formatApplication(application) }
  })

  fastify.post<{
    Params: { id: string }
    Body: { reviewReason?: string }
  }>('/api/admin/hosting/applications/:id/reject', {
    onRequest: [fastify.authenticate, fastify.requireAdmin],
    schema: { body: { type: 'object', additionalProperties: false, required: ['reviewReason'], properties: { reviewReason: { type: 'string', minLength: 1, maxLength: MAX_REASON_LENGTH } } } }
  }, async (request, reply) => {
    const id = parsePositiveRouteId(request.params.id)
    if (!id) return reply.code(400).send(apiError(ErrorCode.INVALID_ID))
    const reviewReason = normalizeReason(request.body?.reviewReason)
    if (!reviewReason) return reply.code(400).send(apiError(ErrorCode.INVALID_PARAMS, '拒絕原因不能为空且不能超过 1000 个字符'))
    const result = await prisma.hostingAccessApplication.updateMany({
      where: { id, status: 'pending' },
      data: { status: 'rejected', reviewReason, reviewedById: request.user.id, reviewedAt: new Date() }
    })
    if (result.count !== 1) return reply.code(409).send({ error: '申请不存在或已处理', code: 'HOSTING_APPLICATION_ALREADY_PROCESSED' })
    const application = await prisma.hostingAccessApplication.findUniqueOrThrow({ where: { id }, include: { reviewedBy: { select: { id: true, username: true } } } })
    await createLog(request.user.id, 'admin', 'hosting.application.reject', `Rejected hosting access application #${id}`, 'success')
    return { application: formatApplication(application) }
  })
}
