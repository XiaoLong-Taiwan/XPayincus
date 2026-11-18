import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const authSource = readFileSync(resolve(process.cwd(), 'src/routes/auth.ts'), 'utf8')
const sshRouteSource = readFileSync(resolve(process.cwd(), 'src/routes/ssh-keys.ts'), 'utf8')
const userDbSource = readFileSync(resolve(process.cwd(), 'src/db/users.ts'), 'utf8')
const sshDbSource = readFileSync(resolve(process.cwd(), 'src/db/ssh-keys.ts'), 'utf8')
const schemaSource = readFileSync(resolve(process.cwd(), 'prisma/schema.prisma'), 'utf8')
const cryptoSource = readFileSync(resolve(process.cwd(), 'src/lib/security.ts'), 'utf8')

assert.ok(schemaSource.includes('privateKeyEncrypted') && schemaSource.includes('registrationTokenHash'))
assert.ok(userDbSource.includes('tx.sshKey.create({') && userDbSource.includes('encryptSensitiveData(sshKeyPair.privateKey)'))
assert.ok(userDbSource.includes('return {') && userDbSource.includes('downloadToken'))
assert.ok(authSource.includes('sshKey: registrationSshKey'))
assert.ok(sshRouteSource.includes("fastify.post<{ Body: { token?: string } }>") && sshRouteSource.includes("'/registration-private-key'") && sshRouteSource.includes("Cache-Control', 'no-store, private"))
assert.ok(sshDbSource.includes('consumeRegistrationPrivateKeyInTransaction') && sshDbSource.includes('select: { id: true, privateKeyEncrypted: true }'))
assert.ok(sshDbSource.includes('updateMany({') && sshDbSource.includes('privateKeyConsumedAt: null'))
assert.ok(!sshDbSource.includes('private_key_encrypted:') && !sshDbSource.includes('registration_token_hash:') && !sshDbSource.includes('private_key_consumed_at:'))
assert.ok(cryptoSource.includes('export function decryptSensitiveDataStrict') && cryptoSource.includes('return null'))
assert.ok(!sshRouteSource.includes('console.log') && !authSource.includes('privateKey:'))

console.log('registration SSH key guard tests passed')
