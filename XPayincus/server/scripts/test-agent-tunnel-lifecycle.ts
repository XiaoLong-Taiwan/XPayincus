import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import type { WebSocket } from 'ws'
import { attachAgentTunnel, closeAgentTunnel, getAgentTunnel } from '../src/lib/agent-tunnel.js'
import { createTerminalSession, closeTerminalSession } from '../src/lib/terminal-proxy.js'
import type { Host } from '../src/types/database.js'

interface Frame {
  type: string
  id?: string
  path?: string
  body?: string
  binary?: boolean
  error?: string
  status?: number
}

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('tunnel lifecycle test timed out')), 1000)
    })])
  } finally { clearTimeout(timer) }
}

class FixtureSocket extends EventEmitter {
  readonly OPEN = 1
  readyState = 1
  bufferedAmount = 0
  readonly sent: Frame[] = []
  respond: (frame: Frame) => void = () => {}
  send(data: string, callback?: (error?: Error) => void): void {
    const frame = JSON.parse(data) as Frame
    this.sent.push(frame)
    queueMicrotask(() => { this.respond(frame); callback?.() })
  }
  receive(frame: Frame): void { this.emit('message', Buffer.from(JSON.stringify(frame)), false) }
  ping(): void {}
  terminate(): void { if (this.readyState === 3) return; this.readyState = 3; this.emit('close') }
}

class FixtureBrowser extends EventEmitter {
  readonly OPEN = 1
  readyState = 1
  bufferedAmount = 0
  readonly output: Array<string | Buffer> = []
  send(data: string | Buffer): void { this.output.push(data) }
  ping(): void {}
  close(): void { this.readyState = 3; this.emit('close') }
}

const hostId = 9017
const socket = new FixtureSocket()
const connection = attachAgentTunnel(hostId, 'lifecycle-fixture', socket as unknown as WebSocket)
let terminalSessionId: string | undefined
try {
  socket.respond = frame => {
    if (frame.type === 'http-open') socket.receive({ type: 'http-error', id: frame.id, error: 'CAPACITY' })
  }
  for (let i = 0; i < 9; i++) {
    const source = new Readable({ read() { this.push(Buffer.from('upload')) } })
    source.on('error', () => {})
    const closed = new Promise<void>(resolve => source.once('close', resolve))
    await assert.rejects(bounded(connection.requestStream('incus', 'POST', '/1.0/instances', source)), /TUNNEL_STREAM_FAILED/)
    await bounded(closed)
    assert.equal(source.destroyed, true)
  }
  assert.equal(socket.sent.filter(frame => frame.type === 'http-open').length, 9)
  socket.respond = frame => {
    if (frame.type === 'http-open') socket.receive({ type: 'http-head', id: frame.id, status: 200 })
  }
  const responses = await bounded(Promise.all(Array.from({ length: 8 }, () => connection.requestStream('incus', 'GET', '/1.0'))))
  await assert.rejects(connection.requestStream('incus', 'GET', '/1.0'), /CAPACITY/)
  for (const response of responses) response.body.destroy()

  const prompt = Buffer.from('welcome\r\nroot@fixture:~# ')
  const following = Buffer.from('next output\r\n')
  let dataId: string | undefined
  let controlOpened = false
  let followingSent = false
  socket.respond = frame => {
    if (frame.type === 'request') {
      socket.receive({ type: 'response', id: frame.id, status: 200, body: Buffer.from(JSON.stringify({
        type: 'async', operation: '/1.0/operations/early', metadata: { metadata: { fds: { '0': 'data-secret', control: 'control-secret' } } }
      })).toString('base64') })
    }
    if (frame.type === 'ws-open') {
      if (frame.path?.includes('data-secret')) {
        dataId = frame.id
        socket.receive({ type: 'ws-opened', id: frame.id })
        socket.receive({ type: 'ws-data', id: frame.id, body: prompt.toString('base64'), binary: true })
      } else {
        assert.ok(dataId)
        assert.equal(socket.sent.some(sent => sent.type === 'ws-ack' && sent.id === dataId), false)
        controlOpened = true
        socket.receive({ type: 'ws-opened', id: frame.id })
      }
    }
    if (frame.type === 'ws-ack' && frame.id === dataId && !followingSent) {
      followingSent = true
      socket.receive({ type: 'ws-data', id: dataId, body: following.toString('base64'), binary: true })
    }
  }
  const browser = new FixtureBrowser()
  const session = await bounded(createTerminalSession(browser as unknown as WebSocket, { id: hostId, url: 'https://fixture.invalid' } as Host, 9017, 'fixture', 9017))
  terminalSessionId = session.id
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(controlOpened, true)
  assert.deepEqual(browser.output.filter(Buffer.isBuffer), [prompt, following])
  assert.equal(socket.sent.filter(frame => frame.type === 'ws-ack' && frame.id === dataId).length, 2)
  closeTerminalSession(session.id)
  terminalSessionId = undefined

  socket.respond = frame => {
    if (frame.type === 'ws-open') {
      socket.receive({ type: 'ws-opened', id: frame.id })
      socket.receive({ type: 'ws-data', id: frame.id, body: prompt.toString('base64'), binary: true })
    }
  }
  const closedEarly = await bounded(connection.openWebSocket('/1.0/operations/closed/websocket?secret=12345678'))
  closedEarly.close()
  const discarded: Buffer[] = []
  closedEarly.on('message', data => discarded.push(data))
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(discarded, [])
  assert.equal(socket.sent.some(frame => frame.type === 'ws-ack' && frame.id === closedEarly.id), false)

  const overflow = await bounded(connection.openWebSocket('/1.0/operations/overflow/websocket?secret=12345678'))
  socket.receive({ type: 'ws-data', id: overflow.id, body: prompt.toString('base64'), binary: true })
  assert.equal(overflow.readyState, 3)
  assert.equal(socket.sent.some(frame => frame.type === 'ws-ack' && frame.id === overflow.id), false)
  assert.equal(getAgentTunnel(hostId), connection)
  console.log('tunnel capacity cleanup and terminal early-data delivery, close and bounds passed')
} finally {
  if (terminalSessionId) closeTerminalSession(terminalSessionId)
  closeAgentTunnel(hostId)
}
