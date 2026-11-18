import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

process.env.ENCRYPTION_KEY ||= 'registration-ssh-key-behavior-test-key'

const { prisma, closePrismaDatabase } = await import('../src/db/prisma.js')
const createdUserIds: number[] = []

try {
  const { encryptSensitiveData } = await import('../src/lib/security.js')
  const { consumeRegistrationPrivateKey } = await import('../src/db/ssh-keys.js')

  const marker = `ssh-registration-test-${randomUUID()}`
  const tokenHash = `${marker}-token`
  const privateKey = '-----BEGIN RSA PRIVATE KEY-----\nbehavior-test\n-----END RSA PRIVATE KEY-----'
  const encryptedPrivateKey = encryptSensitiveData(privateKey)
  const future = new Date(Date.now() + 15 * 60 * 1000)
  const past = new Date(Date.now() - 60 * 1000)

  const userA = await prisma.user.create({
    data: {
      username: `${marker}-a`,
      passwordHash: 'behavior-test-password-hash'
    }
  })
  createdUserIds.push(userA.id)
  const userB = await prisma.user.create({
    data: {
      username: `${marker}-b`,
      passwordHash: 'behavior-test-password-hash'
    }
  })
  createdUserIds.push(userB.id)

  const validKey = await prisma.sshKey.create({
    data: {
      userId: userA.id,
      name: `${marker}-valid`,
      publicKey: 'ssh-rsa behavior-test-valid',
      fingerprint: `${marker}-valid-fingerprint`,
      privateKeyEncrypted: encryptedPrivateKey,
      registrationTokenHash: tokenHash,
      registrationTokenExpiresAt: future
    }
  })

  const validResult = await consumeRegistrationPrivateKey(tokenHash, userA.id)
  assert.equal(validResult, privateKey)

  const consumedRow = await prisma.sshKey.findUniqueOrThrow({ where: { id: validKey.id } })
  assert.equal(consumedRow.privateKeyEncrypted, null)
  assert.equal(consumedRow.registrationTokenHash, null)
  assert.ok(consumedRow.privateKeyConsumedAt)

  assert.equal(await consumeRegistrationPrivateKey(tokenHash, userA.id), null)

  const crossAccountToken = `${marker}-cross-account-token`
  await prisma.sshKey.create({
    data: {
      userId: userB.id,
      name: `${marker}-cross-account`,
      publicKey: 'ssh-rsa behavior-test-cross-account',
      fingerprint: `${marker}-cross-account-fingerprint`,
      privateKeyEncrypted: encryptedPrivateKey,
      registrationTokenHash: crossAccountToken,
      registrationTokenExpiresAt: future
    }
  })
  assert.equal(await consumeRegistrationPrivateKey(crossAccountToken, userA.id), null)

  const expiredToken = `${marker}-expired-token`
  await prisma.sshKey.create({
    data: {
      userId: userA.id,
      name: `${marker}-expired`,
      publicKey: 'ssh-rsa behavior-test-expired',
      fingerprint: `${marker}-expired-fingerprint`,
      privateKeyEncrypted: encryptedPrivateKey,
      registrationTokenHash: expiredToken,
      registrationTokenExpiresAt: past
    }
  })
  assert.equal(await consumeRegistrationPrivateKey(expiredToken, userA.id), null)

  const invalidEncryptionToken = `${marker}-invalid-encryption-token`
  const invalidEncryptionKey = await prisma.sshKey.create({
    data: {
      userId: userA.id,
      name: `${marker}-invalid-encryption`,
      publicKey: 'ssh-rsa behavior-test-invalid-encryption',
      fingerprint: `${marker}-invalid-encryption-fingerprint`,
      privateKeyEncrypted: 'invalid-ciphertext',
      registrationTokenHash: invalidEncryptionToken,
      registrationTokenExpiresAt: future
    }
  })
  assert.equal(await consumeRegistrationPrivateKey(invalidEncryptionToken, userA.id), null)
  const invalidEncryptionRow = await prisma.sshKey.findUniqueOrThrow({ where: { id: invalidEncryptionKey.id } })
  assert.equal(invalidEncryptionRow.privateKeyEncrypted, 'invalid-ciphertext')
  assert.equal(invalidEncryptionRow.registrationTokenHash, invalidEncryptionToken)

  const concurrentToken = `${marker}-concurrent-token`
  const concurrentKey = await prisma.sshKey.create({
    data: {
      userId: userA.id,
      name: `${marker}-concurrent`,
      publicKey: 'ssh-rsa behavior-test-concurrent',
      fingerprint: `${marker}-concurrent-fingerprint`,
      privateKeyEncrypted: encryptedPrivateKey,
      registrationTokenHash: concurrentToken,
      registrationTokenExpiresAt: future
    }
  })
  const concurrentResults = await Promise.all([
    consumeRegistrationPrivateKey(concurrentToken, userA.id),
    consumeRegistrationPrivateKey(concurrentToken, userA.id)
  ])
  assert.equal(concurrentResults.filter(result => result === privateKey).length, 1)
  assert.equal(concurrentResults.filter(result => result === null).length, 1)

  const concurrentRow = await prisma.sshKey.findUniqueOrThrow({ where: { id: concurrentKey.id } })
  assert.equal(concurrentRow.privateKeyEncrypted, null)
  assert.equal(concurrentRow.registrationTokenHash, null)
} finally {
  try {
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
    }
  } finally {
    await closePrismaDatabase()
  }
}

console.log('registration SSH key PostgreSQL behavior tests passed')
