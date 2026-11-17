import type { FastifyInstance } from 'fastify'
import { createHash } from 'node:crypto'
import { prisma } from '../db/prisma.js'
import { decryptSensitiveData } from '../lib/security.js'
import { agentNonceTtlMs, isAgentTimestampFresh, isValidAgentSecret, readAgentAuthHeaders, validateAgentHeaders, verifyAgentSignature } from '../lib/agent-auth.js'
import { attachAgentTunnel, closeAllAgentTunnels, TUNNEL_PATH, TUNNEL_PROTOCOL } from '../lib/agent-tunnel.js'

export default async function agentTunnelRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preClose', async () => { closeAllAgentTunnels() })
  const authenticated = new WeakMap<object, { hostId: number; agentId: string }>()
  app.get('/tunnel', {
    websocket: true,
    onRequest: async (request, reply) => {
      const headers = readAgentAuthHeaders(request.headers)
      const bodyHash = createHash('sha256').update('').digest('hex')
      if (request.url !== TUNNEL_PATH || request.headers.origin || request.headers['sec-websocket-protocol'] !== TUNNEL_PROTOCOL || !headers || validateAgentHeaders(headers) || !isAgentTimestampFresh(headers.timestamp) || headers.bodyHash !== bodyHash) {
        return reply.code(401).send({ code: 'AGENT_TUNNEL_AUTH_INVALID' })
      }
      const agent = await prisma.hostAgent.findUnique({ where: { agentId: headers.agentId } })
      const secret = agent?.enabled ? decryptSensitiveData(agent.secretEncrypted) : null
      if (!agent || !secret || !isValidAgentSecret(secret) || !verifyAgentSignature(secret, { method: 'GET', path: TUNNEL_PATH, timestamp: headers.timestamp, nonce: headers.nonce, bodyHash }, headers.signature)) {
        return reply.code(401).send({ code: 'AGENT_TUNNEL_AUTH_INVALID' })
      }
      try {
        await prisma.$transaction([
          prisma.hostAgentNonce.deleteMany({ where: { expiresAt: { lt: new Date() } } }),
          prisma.hostAgentNonce.create({ data: { agentId: agent.agentId, nonce: headers.nonce, expiresAt: new Date(Date.now() + agentNonceTtlMs) } })
        ])
      } catch { return reply.code(401).send({ code: 'AGENT_TUNNEL_NONCE_REJECTED' }) }
      authenticated.set(request, { hostId: agent.hostId, agentId: agent.agentId })
    }
  }, (socket, request) => {
    const auth = authenticated.get(request)
    if (!auth) { socket.terminate(); return }
    authenticated.delete(request)
    try {
      const connection = attachAgentTunnel(auth.hostId, auth.agentId, socket)
      let checking = false
      const revalidate = setInterval(() => {
        if (checking) return
        checking = true
        void prisma.hostAgent.findUnique({ where: { hostId: auth.hostId }, select: { agentId: true, enabled: true } }).then(agent => {
          if (!agent?.enabled || agent.agentId !== auth.agentId) connection.close('TUNNEL_AUTH_REVOKED')
        }).catch(() => connection.close('TUNNEL_AUTH_UNAVAILABLE')).finally(() => { checking = false })
      }, 15000)
      revalidate.unref()
      socket.once('close', () => clearInterval(revalidate))
    } catch { socket.terminate() }
  })
}
