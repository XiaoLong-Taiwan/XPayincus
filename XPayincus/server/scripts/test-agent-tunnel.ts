import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import WebSocket, { WebSocketServer } from 'ws'
import { request } from 'undici'
import { AgentTunnelError, attachAgentTunnel, getAgentTunnel, closeAllAgentTunnels, validateTunnelPath, TUNNEL_MAX_BODY } from '../src/lib/agent-tunnel.js'
import { AgentTunnelDispatcher } from '../src/lib/agent-tunnel-dispatcher.js'
import { IncusClient } from '../src/lib/incus/incus-client.js'
import { CaddyClient } from '../src/lib/caddy-client.js'
import './test-agent-tunnel-lifecycle.js'

for (const path of ['https://evil.test/1.0', '//evil.test/1.0', '/1.0/../config/', '/1.0/%2e%2e/config/', '/1.0\\evil', '/1.0#x']) assert.throws(() => validateTunnelPath('incus', path))
assert.throws(() => validateTunnelPath('caddy', '/load'))
assert.throws(() => validateTunnelPath('incus', '/1.0/events', true))
assert.throws(() => validateTunnelPath('incus', '/1.0/operations/abc/websocket?secret=12345678&secret=abcdefgh', true))
validateTunnelPath('incus', '/1.0/operations/abc/websocket?secret=12345678', true)

const http = createServer()
const wss = new WebSocketServer({ server: http, maxPayload: 768 * 1024 })
const received: Record<string, unknown>[] = []
wss.on('connection', ws => attachAgentTunnel(1, 'fixture-agent', ws))
await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
const address = http.address()
assert.ok(address && typeof address !== 'string')
const agent = new WebSocket(`ws://127.0.0.1:${address.port}`)
let respond = true
agent.on('message', raw => {
  const frame = JSON.parse(raw.toString())
  received.push(frame)
  if (frame.type === 'request' && respond) {
    const data = frame.target === 'incus' ? { type: 'sync', metadata: { ok: true } } : { apps: {} }
    const body = frame.path === '/1.0/large' ? Buffer.alloc(TUNNEL_MAX_BODY) : Buffer.from(JSON.stringify(data))
    agent.send(JSON.stringify({ type: 'response', id: frame.id, status: frame.path === '/config/missing' ? 404 : 200, headers: { 'content-type': 'application/json' }, body: body.toString('base64') }))
  }
  if (frame.type === 'ws-open') agent.send(JSON.stringify({ type: 'ws-opened', id: frame.id }))
  if (frame.type === 'ws-data') agent.send(JSON.stringify(frame))
})
try {
  await once(agent, 'open')
  const connection = getAgentTunnel(1)
  const response = await connection.request('incus', 'POST', '/1.0/instances', Buffer.from('payload'))
  assert.equal(response.statusCode, 200)
  assert.equal(received.filter(frame => frame.type === 'request').length, 1)
  assert.equal((await connection.request('incus', 'GET', '/1.0/large')).body.length, TUNNEL_MAX_BODY)
  await assert.rejects(connection.request('incus', 'POST', '/1.0', Buffer.alloc(TUNNEL_MAX_BODY + 1)))
  await assert.rejects(connection.request('incus', 'POST', '/1.0', Buffer.alloc(0), { Authorization: 'forbidden' }))
  const dispatcher = new AgentTunnelDispatcher(async () => 1, 'incus')
  const throughUndici = await request('https://must-never-connect.invalid/1.0', { dispatcher })
  assert.equal(throughUndici.statusCode, 200)
  assert.equal(throughUndici.headers['content-type'], 'application/json')
  assert.equal((await throughUndici.body.json() as { metadata: { ok: boolean } }).metadata.ok, true)
  await new Promise<void>(resolve => dispatcher.close(resolve))
  await assert.rejects(request('https://must-never-connect.invalid/1.0', { dispatcher }), /DISPATCHER_CLOSED/)
  await new Promise<void>(resolve => dispatcher.destroy(resolve))
  const client = new IncusClient({ hostId: 1, url: 'https://must-never-connect.invalid:8443', certPath: null, keyPath: null })
  assert.deepEqual(await client.connect(), { ok: true })
  assert.deepEqual(await client.getResources(), { ok: true })
  const caddy = new CaddyClient({ hostId: 1, host: 'must-never-connect.invalid', port: 8444, username: 'unused', password: 'unused' })
  assert.deepEqual(await caddy.getConfig(), { apps: {} })
  const stream = await connection.openWebSocket('/1.0/operations/abc/websocket?secret=12345678')
  const message = once(stream, 'message')
  stream.send(Buffer.from([0, 1, 255]))
  assert.deepEqual((await message)[0], Buffer.from([0, 1, 255]))
  stream.close()
  const slow = await connection.openWebSocket('/1.0/operations/slow/websocket?secret=12345678')
  for (let i = 0; i < 4; i++) slow.send(Buffer.alloc(64 * 1024))
  assert.throws(() => slow.send(Buffer.alloc(64 * 1024)), /BACKPRESSURE/)
  assert.equal(slow.readyState, 3)
  respond = false
  const controller = new AbortController()
  const canceled = connection.request('incus', 'POST', '/1.0/instances', Buffer.alloc(0), {}, 30000, controller.signal)
  controller.abort()
  await assert.rejects(canceled, /TUNNEL_ABORTED/)
  while (!received.some(frame => frame.type === 'cancel')) await once(agent, 'message')
  const canceledId = received.find(frame => frame.type === 'cancel')!.id
  assert.equal(received.filter(frame => frame.type === 'request' && frame.id === canceledId).length, 1)
  const caddyRequests = received.filter(frame => frame.type === 'request' && frame.target === 'caddy').length
  const disconnectedCaddy = assert.rejects(caddy.getConfig(), (error: unknown) =>
    error instanceof AgentTunnelError && error.code === 'TUNNEL_DISCONNECTED' && error.outcomeUnknown)
  while (received.filter(frame => frame.type === 'request' && frame.target === 'caddy').length === caddyRequests) await once(agent, 'message')
  const pending = Array.from({ length: 7 }, () => connection.request('incus', 'POST', '/1.0/instances'))
  const settled = Promise.allSettled(pending)
  await assert.rejects(connection.request('incus', 'GET', '/1.0'), /CAPACITY/)
  agent.terminate()
  const results = await settled
  await disconnectedCaddy
  assert.ok(results.every(result => result.status === 'rejected' && result.reason instanceof AgentTunnelError && result.reason.outcomeUnknown))
  assert.throws(() => getAgentTunnel(1), /OFFLINE/)
  await assert.rejects(caddy.getConfig(), (error: unknown) => error instanceof AgentTunnelError && error.code === 'TUNNEL_OFFLINE')
  await client.close()
  console.log('agent tunnel HTTP/WS, clients, bounds and disconnect behavior tests passed')
} finally {
  closeAllAgentTunnels()
  agent.terminate()
  await new Promise<void>(resolve => wss.close(() => resolve()))
  await new Promise<void>(resolve => http.close(() => resolve()))
}
