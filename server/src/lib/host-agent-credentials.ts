import { Prisma } from '@prisma/client'
import { createHash, createHmac, randomBytes } from 'crypto'
import { prisma } from '../db/prisma.js'
import { HOST_AGENT_CREDENTIAL_LOCK_NAMESPACE, advisoryTransactionLock } from '../db/advisory-locks.js'
import { generateAgentId, generateAgentSecret, hashAgentSecret, isValidAgentId, isValidAgentSecret } from './agent-auth.js'
import { decryptSensitiveData, encryptSensitiveData } from './security.js'

export interface HostAgentRecord {
  id: number
  hostId: number
  agentId: string
  secretHash: string
  secretEncrypted: string
  installTokenHash: string | null
  installTokenExpiresAt: Date | null
  installTokenUsedAt: Date | null
  enabled: boolean
  status: string
  version: string | null
  capabilities: unknown
  lastReport: unknown
  lastSeenAt: Date | null
  lastHeartbeatIp: string | null
  createdAt: Date
  updatedAt: Date
}

const agentModel = prisma.hostAgent
const agentInstallTokenPrefix = 'ait_'
const agentInstallTokenTtlMs = 30 * 60 * 1000
const enrollmentProofPrefix = 'xpayincus-agent-enrollment-v1'

export interface HostAgentEnrollmentRecord {
  id: number
  hostId: number
  tokenHash: string
  expiresAt: Date
  usedAt: Date | null
  enabled: boolean
}

async function generateUniqueAgentId(): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const agentId = generateAgentId()
    const existing = await agentModel.findUnique({
      where: { agentId },
      select: { id: true }
    })
    if (!existing) {
      return agentId
    }
  }
  throw new Error('Unable to generate unique Agent ID')
}

export async function rotateHostAgentCredentials(hostId: number, enabled = true): Promise<{
  host: { id: number; name: string }
  agent: HostAgentRecord
  agentId: string
  agentSecret: string
}> {
  const agentId = await generateUniqueAgentId()
  const agentSecret = generateAgentSecret()
  return prisma.$transaction(async transaction => {
    await advisoryTransactionLock(transaction, HOST_AGENT_CREDENTIAL_LOCK_NAMESPACE, hostId)
    const host = await transaction.host.findUnique({
      where: { id: hostId },
      select: { id: true, name: true }
    })
    if (!host) throw new Error('HOST_NOT_FOUND')
    const now = new Date()
    const existingAgent = await transaction.hostAgent.findUnique({
      where: { hostId },
      select: { agentId: true }
    })
    if (existingAgent) await transaction.hostAgentNonce.deleteMany({ where: { agentId: existingAgent.agentId } })
    await transaction.hostAgentEnrollment.updateMany({
      where: { hostId, usedAt: null },
      data: { usedAt: now }
    })
    const agent = await transaction.hostAgent.upsert({
      where: { hostId },
      create: {
        hostId,
        agentId,
        secretHash: hashAgentSecret(agentSecret),
        secretEncrypted: encryptSensitiveData(agentSecret),
        installTokenHash: null,
        installTokenExpiresAt: null,
        installTokenUsedAt: null,
        enabled,
        status: 'offline'
      },
      update: {
        agentId,
        secretHash: hashAgentSecret(agentSecret),
        secretEncrypted: encryptSensitiveData(agentSecret),
        installTokenHash: null,
        installTokenExpiresAt: null,
        installTokenUsedAt: null,
        enabled,
        status: 'offline',
        version: null,
        capabilities: [] as Prisma.InputJsonValue,
        lastReport: {} as Prisma.InputJsonObject,
        lastSeenAt: null,
        lastHeartbeatIp: null
      }
    })
    return { host, agent, agentId, agentSecret }
  })
}

function generateAgentInstallToken(): string {
  return `${agentInstallTokenPrefix}${randomBytes(32).toString('base64url')}`
}

function hashAgentInstallToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function isAgentInstallToken(value: string): boolean {
  return value.startsWith(agentInstallTokenPrefix) && value.length >= agentInstallTokenPrefix.length + 32
}

export async function issueHostAgentInstallToken(hostId: number, enabled = true): Promise<{
  host: { id: number; name: string }
  agent: HostAgentRecord | null
  installToken: string
  installTokenExpiresAt: Date
}> {
  const installToken = generateAgentInstallToken()
  const installTokenExpiresAt = new Date(Date.now() + agentInstallTokenTtlMs)
  return prisma.$transaction(async transaction => {
    await advisoryTransactionLock(transaction, HOST_AGENT_CREDENTIAL_LOCK_NAMESPACE, hostId)
    const host = await transaction.host.findUnique({ where: { id: hostId }, select: { id: true, name: true } })
    if (!host) throw new Error('HOST_NOT_FOUND')
    await transaction.hostAgentEnrollment.updateMany({
      where: { hostId, usedAt: null },
      data: { usedAt: new Date() }
    })
    await transaction.hostAgent.updateMany({
      where: { hostId, installTokenHash: { not: null } },
      data: { installTokenHash: null, installTokenExpiresAt: null, installTokenUsedAt: new Date() }
    })
    await transaction.hostAgentEnrollment.create({
      data: { hostId, tokenHash: hashAgentInstallToken(installToken), expiresAt: installTokenExpiresAt, enabled }
    })
    const agent = await transaction.hostAgent.findUnique({ where: { hostId } })
    return { host, agent, installToken, installTokenExpiresAt }
  })
}

export function createEnrollmentProof(agentSecret: string, token: string, agentId: string, challenge: string): string {
  return createHmac('sha256', agentSecret).update(`${enrollmentProofPrefix}\n${token}\n${agentId}\n${challenge}`).digest('hex')
}

export async function exchangeHostAgentInstallToken(input: {
  token: string
  agentId: string
  agentSecret: string
  challenge: string
}): Promise<{ host: { id: number; name: string }; agent: HostAgentRecord; proof: string }> {
  if (!isAgentInstallToken(input.token)) throw new Error('AGENT_INSTALL_TOKEN_INVALID')
  if (!isValidAgentId(input.agentId) || !isValidAgentSecret(input.agentSecret) || !/^[A-Za-z0-9_-]{32,128}$/.test(input.challenge)) {
    throw new Error('AGENT_ENROLLMENT_INVALID')
  }
  const tokenHash = hashAgentInstallToken(input.token)
  const now = new Date()
  return prisma.$transaction(async transaction => {
    const enrollmentHost = await transaction.hostAgentEnrollment.findUnique({ where: { tokenHash }, select: { hostId: true } })
    if (!enrollmentHost) throw new Error('AGENT_INSTALL_TOKEN_INVALID')
    await advisoryTransactionLock(transaction, HOST_AGENT_CREDENTIAL_LOCK_NAMESPACE, enrollmentHost.hostId)
    const enrollment = await transaction.hostAgentEnrollment.findUnique({ where: { tokenHash } })
    if (!enrollment || enrollment.usedAt || enrollment.expiresAt < now) throw new Error('AGENT_INSTALL_TOKEN_INVALID')
    const host = await transaction.host.findUnique({ where: { id: enrollment.hostId }, select: { id: true, name: true } })
    if (!host) throw new Error('HOST_NOT_FOUND')
    const consumed = await transaction.hostAgentEnrollment.updateMany({ where: { id: enrollment.id, usedAt: null, expiresAt: { gte: now } }, data: { usedAt: now } })
    if (consumed.count !== 1) throw new Error('AGENT_INSTALL_TOKEN_INVALID')
    const existing = await transaction.hostAgent.findUnique({ where: { hostId: host.id }, select: { agentId: true } })
    if (existing) await transaction.hostAgentNonce.deleteMany({ where: { agentId: existing.agentId } })
    let agent: HostAgentRecord
    try {
      agent = await transaction.hostAgent.upsert({
        where: { hostId: host.id },
        create: { hostId: host.id, agentId: input.agentId, secretHash: hashAgentSecret(input.agentSecret), secretEncrypted: encryptSensitiveData(input.agentSecret), enabled: enrollment.enabled, status: 'offline' },
        update: { agentId: input.agentId, secretHash: hashAgentSecret(input.agentSecret), secretEncrypted: encryptSensitiveData(input.agentSecret), installTokenHash: null, installTokenExpiresAt: null, installTokenUsedAt: now, enabled: enrollment.enabled, status: 'offline', version: null, capabilities: [] as Prisma.InputJsonValue, lastReport: {} as Prisma.InputJsonObject, lastSeenAt: null, lastHeartbeatIp: null }
      })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new Error('AGENT_ID_ALREADY_REGISTERED')
      }
      throw error
    }
    return { host, agent, proof: createEnrollmentProof(input.agentSecret, input.token, input.agentId, input.challenge) }
  })
}

export async function consumeHostAgentInstallToken(token: string): Promise<{
  host: { id: number; name: string }
  agent: HostAgentRecord
  agentSecret: string
}> {
  if (!isAgentInstallToken(token)) {
    throw new Error('AGENT_INSTALL_TOKEN_INVALID')
  }

  const enrollment = await prisma.hostAgentEnrollment.findUnique({ where: { tokenHash: hashAgentInstallToken(token) } })
  if (enrollment) {
    const agentId = await generateUniqueAgentId()
    const agentSecret = generateAgentSecret()
    const result = await exchangeHostAgentInstallToken({ token, agentId, agentSecret, challenge: randomBytes(32).toString('base64url') })
    return { host: result.host, agent: result.agent, agentSecret }
  }

  const tokenHash = hashAgentInstallToken(token)
  const existingAgent = await agentModel.findUnique({
    where: { installTokenHash: tokenHash },
    select: { hostId: true }
  })
  if (!existingAgent) throw new Error('AGENT_INSTALL_TOKEN_INVALID')

  return prisma.$transaction(async transaction => {
    await advisoryTransactionLock(transaction, HOST_AGENT_CREDENTIAL_LOCK_NAMESPACE, existingAgent.hostId)
    const agent = await transaction.hostAgent.findUnique({
      where: { installTokenHash: tokenHash },
      include: {
        host: {
          select: { id: true, name: true }
        }
      }
    })
    if (!agent || !agent.installTokenExpiresAt || agent.installTokenUsedAt) {
      throw new Error('AGENT_INSTALL_TOKEN_INVALID')
    }
    const now = new Date()
    if (agent.installTokenExpiresAt < now) throw new Error('AGENT_INSTALL_TOKEN_EXPIRED')
    const updated = await transaction.hostAgent.updateMany({
      where: {
        id: agent.id,
        installTokenHash: tokenHash,
        installTokenUsedAt: null,
        installTokenExpiresAt: { gte: now }
      },
      data: {
        installTokenHash: null,
        installTokenExpiresAt: null,
        installTokenUsedAt: now
      }
    })
    if (updated.count !== 1) throw new Error('AGENT_INSTALL_TOKEN_INVALID')
    const agentSecret = decryptSensitiveData(agent.secretEncrypted)
    if (!agentSecret) throw new Error('AGENT_SECRET_INVALID')
    const { host, ...agentRecord } = agent
    return { host, agent: agentRecord, agentSecret }
  })
}
