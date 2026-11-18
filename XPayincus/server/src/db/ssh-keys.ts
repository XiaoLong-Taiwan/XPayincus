/**
 * SSH 密钥相关数据库操作
 * 使用 Prisma ORM
 */

import { prisma } from './prisma.js'
import type { SshKey } from '../types/database.js'
import { decryptSensitiveDataStrict } from '../lib/security.js'
import type { Prisma } from '@prisma/client'

/**
 * 获取用户的所有 SSH 密钥
 */
export async function getSSHKeysByUserId(userId: number): Promise<SshKey[]> {
  const sshKeys = await prisma.sshKey.findMany({
    where: { userId },
    orderBy: {
      createdAt: 'desc'
    }
  })
  
  return sshKeys.map(key => ({
    id: key.id,
    user_id: key.userId,
    name: key.name,
    public_key: key.publicKey,
    fingerprint: key.fingerprint,
    created_at: key.createdAt.toISOString()
  }))
}

/**
 * 根据 ID 获取 SSH 密钥
 */
export async function getSSHKeyById(id: number): Promise<SshKey | null> {
  const sshKey = await prisma.sshKey.findUnique({
    where: { id }
  })
  
  if (!sshKey) return null
  
  return {
    id: sshKey.id,
    user_id: sshKey.userId,
    name: sshKey.name,
    public_key: sshKey.publicKey,
    fingerprint: sshKey.fingerprint,
    created_at: sshKey.createdAt.toISOString()
  }
}

/**
 * 创建 SSH 密钥
 */
export async function createSSHKey(data: {
  userId: number
  name: string
  publicKey: string
  fingerprint: string
  privateKeyEncrypted?: string
  registrationTokenHash?: string
  registrationTokenExpiresAt?: Date
}): Promise<number> {
  const sshKey = await prisma.sshKey.create({
    data: {
      userId: data.userId,
      name: data.name,
      publicKey: data.publicKey,
      fingerprint: data.fingerprint,
      privateKeyEncrypted: data.privateKeyEncrypted,
      registrationTokenHash: data.registrationTokenHash,
      registrationTokenExpiresAt: data.registrationTokenExpiresAt
    }
  })
  
  return sshKey.id
}

export async function consumeRegistrationPrivateKeyInTransaction(
  tx: Prisma.TransactionClient,
  tokenHash: string,
  userId: number,
  now = new Date()
): Promise<string | null> {
  const key = await tx.sshKey.findFirst({
    where: {
      userId,
      registrationTokenHash: tokenHash,
      privateKeyConsumedAt: null,
      registrationTokenExpiresAt: { gt: now },
      privateKeyEncrypted: { not: null }
    },
    select: { id: true, privateKeyEncrypted: true }
  })
  if (!key?.privateKeyEncrypted) return null

  const privateKey = decryptSensitiveDataStrict(key.privateKeyEncrypted)
  if (!privateKey) return null

  const consumed = await tx.sshKey.updateMany({
    where: {
      id: key.id,
      registrationTokenHash: tokenHash,
      privateKeyConsumedAt: null,
      registrationTokenExpiresAt: { gt: now }
    },
    data: {
      privateKeyEncrypted: null,
      registrationTokenHash: null,
      registrationTokenExpiresAt: null,
      privateKeyConsumedAt: now
    }
  })
  return consumed.count === 1 ? privateKey : null
}

export async function consumeRegistrationPrivateKey(tokenHash: string, userId: number): Promise<string | null> {
  return prisma.$transaction(tx => consumeRegistrationPrivateKeyInTransaction(tx, tokenHash, userId))
}

/**
 * 删除 SSH 密钥
 */
export async function deleteSSHKey(id: number): Promise<void> {
  await prisma.sshKey.delete({
    where: { id }
  })
}
