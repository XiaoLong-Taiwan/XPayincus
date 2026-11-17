import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import WebSocket, { WebSocketServer } from 'ws'
import { attachAgentTunnel, getAgentTunnel, closeAllAgentTunnels } from '../src/lib/agent-tunnel.js'
import { IncusClient } from '../src/lib/incus/incus-client.js'
import { getBackupExportStream } from '../src/lib/incus/incus-backups.js'
import { restoreFromStream } from '../src/lib/incus/incus-restore.js'
import { AgentTunnelDispatcher } from '../src/lib/agent-tunnel-dispatcher.js'
import { request } from 'undici'

const http = createServer()
const wss = new WebSocketServer({ server: http })
wss.on('connection', ws => attachAgentTunnel(41, 'fixture', ws))
await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
const address = http.address()
assert.ok(address && typeof address !== 'string')
const agent = new WebSocket(`ws://127.0.0.1:${address.port}`)
const total = 8 * 1024 * 1024
const chunk = Buffer.alloc(64 * 1024, 0x5a)
const states = new Map<string, { seq: number; offset: number; upload: number; method: string }>()
let credits = 0
let uploaded = 0
agent.on('message', raw => {
  const f = JSON.parse(raw.toString())
  if (f.type === 'http-open') {
    states.set(f.id, { seq: 0, offset: 0, upload: 0, method: f.method })
    if (f.method === 'GET') agent.send(JSON.stringify({ type: 'http-head', id: f.id, status: 200, headers: { 'content-length': String(total) } }))
  }
  const state = states.get(f.id)
  if (!state) return
  if (f.type === 'http-upload') {
    assert.equal(f.seq, state.upload++)
    const data = Buffer.from(f.body, 'base64')
    assert.ok(data.length <= 64 * 1024)
    uploaded += data.length
    agent.send(JSON.stringify({ type: 'http-ack', id: f.id, seq: f.seq }))
  }
  if (f.type === 'http-upload-end' && state.method === 'POST') agent.send(JSON.stringify({ type: 'http-head', id: f.id, status: 200 }))
  if (f.type === 'http-credit') {
    credits++
    assert.equal(f.seq, state.seq)
    if (state.method === 'POST') {
      agent.send(JSON.stringify({ type: 'http-data', id: f.id, seq: state.seq++, body: Buffer.from('{"type":"sync"}').toString('base64') }))
      agent.send(JSON.stringify({ type: 'http-end', id: f.id, seq: state.seq }))
    } else if (state.offset < total) {
      state.offset += chunk.length
      agent.send(JSON.stringify({ type: 'http-data', id: f.id, seq: state.seq++, body: chunk.toString('base64') }))
    } else agent.send(JSON.stringify({ type: 'http-end', id: f.id, seq: state.seq }))
  }
})
try {
  await once(agent, 'open')
  const client = new IncusClient({ hostId: 41, url: 'https://never-connect.invalid', certPath: null, keyPath: null })
  client.agent = {} as typeof client.agent
  const { stream, contentLength } = await getBackupExportStream(client, 'demo', 'backup')
  assert.equal(contentLength, total)
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.ok(credits <= 3, `slow consumer received ${credits} credits`)
  const digest = createHash('sha256')
  let downloaded = 0
  for await (const data of Readable.fromWeb(stream as import('node:stream/web').ReadableStream)) { downloaded += data.length; digest.update(data) }
  assert.equal(downloaded, total)
  const expected = createHash('sha256')
  for (let i = 0; i < total; i += chunk.length) expected.update(chunk)
  assert.equal(digest.digest('hex'), expected.digest('hex'))
  await restoreFromStream({ client, targetName: 'restore', backupStream: Readable.from((async function* () { for (let i = 0; i < total; i += chunk.length) yield chunk })()) })
  assert.equal(uploaded, total)
  const dispatcher = new AgentTunnelDispatcher(async () => 41, 'incus')
  const imported = await request('https://never-connect.invalid/1.0/instances', {
    dispatcher, method: 'POST', body: Readable.from((async function* () { for (let i = 0; i < total; i += chunk.length) yield chunk })()),
    headers: { 'content-type': 'application/octet-stream' }
  })
  assert.deepEqual(await imported.body.json(), { type: 'sync' })
  assert.equal(uploaded, total * 2)
  await dispatcher.close()
  const response = await getAgentTunnel(41).requestStream('incus', 'GET', '/1.0/instances/demo/files?path=/test')
  response.body.destroy()
  console.log('bounded 8 MiB backup download/restore, hashes, consumer credit and cancellation passed')
} finally {
  closeAllAgentTunnels()
  agent.terminate()
  await new Promise<void>(resolve => wss.close(() => resolve()))
  await new Promise<void>(resolve => http.close(() => resolve()))
}
