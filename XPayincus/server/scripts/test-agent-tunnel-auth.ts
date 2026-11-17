import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import { createAgentSignature, generateAgentId, generateAgentSecret } from '../src/lib/agent-auth.js'

process.env.DATABASE_URL = 'postgresql://fixture:fixture@127.0.0.1:1/fixture'
const secret = generateAgentSecret()
const agentId = generateAgentId()
let enabled = true
const nonces = new Set<string>()
const fixture = {
  hostAgent: { findUnique: async () => ({ hostId: 17, agentId, enabled, secretEncrypted: secret }) },
  hostAgentNonce: {
    deleteMany: () => null,
    create: (input: { data: { nonce: string } }) => input.data.nonce
  },
  $transaction: async (values: unknown[]) => {
    const nonce = String(values[1])
    if (nonces.has(nonce)) throw new Error('duplicate nonce')
    nonces.add(nonce)
  }
}
;(globalThis as unknown as { prisma: unknown }).prisma = fixture
const { default: routes } = await import('../src/routes/agent-tunnel.js')
const { getAgentTunnel, closeAgentTunnel } = await import('../src/lib/agent-tunnel.js')
const app = Fastify()
await app.register(websocket)
await app.register(routes, { prefix: '/api/agent' })
await app.ready()

function headers(timestamp = String(Date.now())): Record<string, string> {
  const payload = { method: 'GET', path: '/api/agent/tunnel', timestamp, nonce: randomUUID(), bodyHash: createHash('sha256').update('').digest('hex') }
  return {
    'sec-websocket-protocol': 'xpayincus-tunnel-v1',
    'x-incudal-agent-id': agentId,
    'x-incudal-timestamp': timestamp,
    'x-incudal-nonce': payload.nonce,
    'x-incudal-body-sha256': payload.bodyHash,
    'x-incudal-signature': createAgentSignature(secret, payload)
  }
}

try {
  for (const invalid of [
    { ...headers(), origin: 'https://browser.invalid' },
    { ...headers(), 'sec-websocket-protocol': 'wrong' },
    { ...headers(), 'x-incudal-signature': '0'.repeat(64) },
    headers(String(Date.now() - 600000))
  ]) {
    const result = await app.inject({ method: 'GET', url: '/api/agent/tunnel', headers: invalid })
    assert.equal(result.statusCode, 401)
  }
  enabled = false
  assert.equal((await app.inject({ method: 'GET', url: '/api/agent/tunnel', headers: headers() })).statusCode, 401)
  enabled = true
  const valid = headers()
  const socket = await app.injectWS('/api/agent/tunnel', { headers: valid })
  assert.equal(getAgentTunnel(17).agentId, agentId)
  assert.equal((await app.inject({ method: 'GET', url: '/api/agent/tunnel', headers: valid })).statusCode, 401)
  closeAgentTunnel(17)
  assert.throws(() => getAgentTunnel(17), /OFFLINE/)
  socket.terminate()
  console.log('agent tunnel Fastify handshake, HMAC, expiry, replay and revocation tests passed')
} finally {
  await app.close()
}
process.exit(0)
