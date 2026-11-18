import crypto from 'crypto'

function writeUInt32BE(value: number): Buffer {
  const buf = Buffer.alloc(4)
  buf.writeUInt32BE(value, 0)
  return buf
}

function convertRSAToOpenSSHFormat(pemPublicKey: string): string {
  const publicKeyObject = crypto.createPublicKey({ key: pemPublicKey, format: 'pem' })
  const jwk = publicKeyObject.export({ format: 'jwk' }) as { n?: string; e?: string }
  if (!jwk.n || !jwk.e) throw new Error('Failed to export RSA public key as JWK')

  const n = Buffer.from(jwk.n, 'base64url')
  const e = Buffer.from(jwk.e, 'base64url')
  const nWithPadding = n[0] & 0x80 ? Buffer.concat([Buffer.from([0x00]), n]) : n
  const eWithPadding = e[0] & 0x80 ? Buffer.concat([Buffer.from([0x00]), e]) : e
  const keyType = Buffer.from('ssh-rsa', 'utf8')
  const blob = Buffer.concat([
    writeUInt32BE(keyType.length),
    keyType,
    writeUInt32BE(eWithPadding.length),
    eWithPadding,
    writeUInt32BE(nWithPadding.length),
    nWithPadding
  ])

  return `ssh-rsa ${blob.toString('base64')}`
}

export function calculateSshFingerprint(publicKey: string): string {
  const parts = publicKey.trim().split(/\s+/)
  const keyData = Buffer.from(parts[1] || '', 'base64')
  return `SHA256:${crypto.createHash('sha256').update(keyData).digest('base64').replace(/=+$/, '')}`
}

export function generateSshKeyPair(): { publicKey: string; privateKey: string; fingerprint: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 4096,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' }
  })
  const sshPublicKey = convertRSAToOpenSSHFormat(publicKey)
  return {
    publicKey: sshPublicKey,
    privateKey,
    fingerprint: calculateSshFingerprint(sshPublicKey)
  }
}
