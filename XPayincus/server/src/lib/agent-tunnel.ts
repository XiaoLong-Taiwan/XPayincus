import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { WebSocket } from 'ws'
import { HttpTunnelStream } from './agent-tunnel-stream.js'

export const TUNNEL_PATH = '/api/agent/tunnel'
export const TUNNEL_PROTOCOL = 'xpayincus-tunnel-v1'
export const TUNNEL_MAX_BODY = 512 * 1024
export const TUNNEL_MAX_FRAME = 768 * 1024
export const TUNNEL_MAX_WS_DATA = 64 * 1024
export const TUNNEL_MAX_CONCURRENT = 8
export type TunnelTarget = 'incus' | 'caddy'
export interface TunnelResponse { statusCode: number; headers: Record<string, string>; body: Buffer }
interface Frame {
  type: string
  id?: string
  target?: TunnelTarget
  method?: string
  path?: string
  body?: string
  headers?: Record<string, string>
  status?: number
  error?: string
  timeout?: number
  binary?: boolean
  version?: number
  seq?: number
}

export class AgentTunnelError extends Error {
  constructor(readonly code: string, readonly outcomeUnknown = false) {
    super(`${code}${outcomeUnknown ? ': operation outcome unknown; do not replay writes' : ''}`)
  }
}

export function validateTunnelPath(target: TunnelTarget, path: string, websocket = false): void {
  if (typeof path !== 'string' || path.length > 8192 || !path.startsWith('/') || path.startsWith('//') || /[\\\r\n#]/.test(path)) throw new AgentTunnelError('TUNNEL_INVALID_PATH')
  let decoded: string
  try { decoded = decodeURIComponent(path.split('?')[0]!) } catch { throw new AgentTunnelError('TUNNEL_INVALID_PATH') }
  if (decoded.split('/').some(part => part === '.' || part === '..')) throw new AgentTunnelError('TUNNEL_INVALID_PATH')
  const url = new URL(path, 'http://localhost')
  if (url.origin !== 'http://localhost') throw new AgentTunnelError('TUNNEL_INVALID_PATH')
  if (websocket) {
    if (target !== 'incus' || !/^\/1\.0\/operations\/[A-Za-z0-9-]+\/websocket$/.test(decoded) || [...url.searchParams.keys()].length !== 1 || url.searchParams.getAll('secret').length !== 1 || (url.searchParams.get('secret')?.length ?? 0) < 8) throw new AgentTunnelError('TUNNEL_INVALID_WS_PATH')
  } else if (target === 'incus') {
    if (decoded !== '/1.0' && !decoded.startsWith('/1.0/')) throw new AgentTunnelError('TUNNEL_INVALID_PATH')
  } else if (target === 'caddy') {
    if (!decoded.startsWith('/config/') && !decoded.startsWith('/id/')) throw new AgentTunnelError('TUNNEL_INVALID_PATH')
  } else throw new AgentTunnelError('TUNNEL_INVALID_TARGET')
}

function decodeBody(value: unknown, limit: number): Buffer {
  if (typeof value !== 'string' || value.length > Math.ceil(limit / 3) * 4 || value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value)) throw new AgentTunnelError('TUNNEL_INVALID_BODY')
  const body = Buffer.from(value, 'base64')
  if (body.toString('base64') !== value) throw new AgentTunnelError('TUNNEL_INVALID_BODY')
  if (body.length > limit) throw new AgentTunnelError('TUNNEL_BODY_LIMIT')
  return body
}

export class TunnelSocket extends EventEmitter {
  readonly OPEN = 1
  readonly CONNECTING = 0
  readyState = 0
  private outgoing: Array<{ body: Buffer; binary: boolean }> = []
  private queuedBytes = 0
  private waiting = false
  private timer?: NodeJS.Timeout
  private incoming?: { body: Buffer; binary: boolean }
  constructor(private readonly connection: TunnelConnection, readonly id: string) {
    super()
    this.on('newListener', event => {
      if (event === 'message') queueMicrotask(() => this.deliverIncoming())
    })
  }
  receiveMessage(body: Buffer, binary: boolean): void {
    if (this.readyState !== this.OPEN) return
    if (this.incoming) { this.close(); return }
    this.incoming = { body, binary }
    this.deliverIncoming()
  }
  private deliverIncoming(): void {
    if (this.readyState !== this.OPEN || !this.incoming || this.listenerCount('message') === 0) return
    const frame = this.incoming
    this.incoming = undefined
    this.emit('message', frame.body, frame.binary)
    if (this.readyState === this.OPEN) this.connection.send({ type: 'ws-ack', id: this.id })
  }
  send(data: Buffer | string): void {
    const body = Buffer.isBuffer(data) ? data : Buffer.from(data)
    if (this.readyState !== this.OPEN || body.length > TUNNEL_MAX_WS_DATA) { this.close(); throw new AgentTunnelError('TUNNEL_WS_NOT_READY_OR_LIMIT') }
    if (this.queuedBytes + body.length > 256 * 1024 || this.outgoing.length >= 64) { this.close(); throw new AgentTunnelError('TUNNEL_WS_BACKPRESSURE') }
    this.outgoing.push({ body, binary: Buffer.isBuffer(data) })
    this.queuedBytes += body.length
    this.flush()
  }
  private flush(): void {
    if (this.waiting || !this.outgoing.length) return
    const frame = this.outgoing[0]!
    this.waiting = true
    this.connection.send({ type: 'ws-data', id: this.id, body: frame.body.toString('base64'), binary: frame.binary })
    this.timer = setTimeout(() => this.close(), 10000)
  }
  acknowledged(): void {
    if (!this.waiting) throw new AgentTunnelError('TUNNEL_WS_ACK')
    clearTimeout(this.timer)
    this.waiting = false
    this.queuedBytes -= this.outgoing.shift()!.body.length
    this.flush()
  }
  ping(): void { if (this.readyState === this.OPEN) this.emit('pong') }
  close(): void { this.connection.closeStream(this.id) }
  finish(): void { if (this.readyState === 3) return; this.readyState = 3; clearTimeout(this.timer); this.outgoing = []; this.queuedBytes = 0; this.incoming = undefined; this.emit('close') }
}

interface Pending {
  resolve: (response: TunnelResponse) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
  stream?: TunnelSocket
}

export class TunnelConnection {
  private readonly pending = new Map<string, Pending>()
  private readonly streams = new Map<string, TunnelSocket>()
  private readonly httpStreams = new Map<string, HttpTunnelStream>()
  private closed = false
  private alive = true
  private readonly heartbeat: NodeJS.Timeout
  constructor(readonly hostId: number, readonly agentId: string, private readonly ws: WebSocket, private readonly removed: () => void) {
    ws.on('message', (raw, binary) => {
      try {
        if (binary || !Buffer.isBuffer(raw) || raw.length > TUNNEL_MAX_FRAME) throw new AgentTunnelError('TUNNEL_FRAME_LIMIT')
        this.receive(JSON.parse(raw.toString()) as Frame)
      } catch { this.close('TUNNEL_PROTOCOL_ERROR') }
    })
    ws.on('pong', () => { this.alive = true })
    ws.on('error', () => this.close('TUNNEL_DISCONNECTED'))
    ws.on('close', () => this.close('TUNNEL_DISCONNECTED'))
    this.heartbeat = setInterval(() => {
      if (!this.alive) { this.close('TUNNEL_HEARTBEAT_TIMEOUT'); return }
      this.alive = false
      ws.ping()
    }, 25000)
    this.heartbeat.unref()
    this.send({ type: 'hello', version: 1 })
  }
  send(frame: Frame): void {
    const data = JSON.stringify(frame)
    if (this.closed || this.ws.readyState !== this.ws.OPEN) throw new AgentTunnelError('TUNNEL_OFFLINE')
    if (Buffer.byteLength(data) > TUNNEL_MAX_FRAME || this.ws.bufferedAmount + Buffer.byteLength(data) > 2 * TUNNEL_MAX_FRAME) {
      this.close('TUNNEL_BACKPRESSURE')
      throw new AgentTunnelError('TUNNEL_BACKPRESSURE', true)
    }
    this.ws.send(data, error => { if (error) this.close('TUNNEL_SEND_FAILED') })
  }
  private reserve(frame: Frame, timeout: number, stream?: TunnelSocket, signal?: AbortSignal): Promise<TunnelResponse> {
    if (signal?.aborted) throw new AgentTunnelError('TUNNEL_ABORTED')
    if (this.pending.size + this.streams.size + this.httpStreams.size >= TUNNEL_MAX_CONCURRENT) throw new AgentTunnelError('TUNNEL_CAPACITY')
    return new Promise((resolve, reject) => {
      const abort = () => {
        if (!this.pending.delete(frame.id!)) return
        clearTimeout(timer)
        try { this.send({ type: 'cancel', id: frame.id }) } catch { }
        reject(new AgentTunnelError('TUNNEL_ABORTED', true))
      }
      const cleanup = () => signal?.removeEventListener('abort', abort)
      const timer = setTimeout(() => {
        this.pending.delete(frame.id!)
        cleanup()
        try { this.send({ type: 'cancel', id: frame.id }) } catch { }
        stream?.finish()
        reject(new AgentTunnelError('TUNNEL_TIMEOUT', true))
      }, timeout)
      this.pending.set(frame.id!, { resolve: response => { cleanup(); resolve(response) }, reject: error => { cleanup(); reject(error) }, timer, stream })
      signal?.addEventListener('abort', abort, { once: true })
      try { this.send(frame) } catch (error) { cleanup(); clearTimeout(timer); this.pending.delete(frame.id!); reject(error) }
    })
  }
  async request(target: TunnelTarget, method: string, path: string, body = Buffer.alloc(0), headers: Record<string, string> = {}, timeout = 30000, signal?: AbortSignal): Promise<TunnelResponse> {
    validateTunnelPath(target, path)
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method) || body.length > TUNNEL_MAX_BODY || !Number.isInteger(timeout) || timeout < 1 || timeout > 120000) throw new AgentTunnelError('TUNNEL_INVALID_REQUEST')
    for (const [key, value] of Object.entries(headers)) {
      if (!['content-type', 'x-incus-name', 'x-incus-pool'].includes(key.toLowerCase()) || value.length > 4096 || /[\r\n]/.test(value)) throw new AgentTunnelError('TUNNEL_INVALID_HEADERS')
    }
    return this.reserve({ type: 'request', id: randomUUID(), target, method, path, body: body.toString('base64'), headers, timeout }, timeout + 1000, undefined, signal)
  }
  async openWebSocket(path: string): Promise<TunnelSocket> {
    validateTunnelPath('incus', path, true)
    const id = randomUUID()
    const stream = new TunnelSocket(this, id)
    await this.reserve({ type: 'ws-open', id, target: 'incus', path }, 10000, stream)
    return stream
  }
  async requestStream(target: TunnelTarget, method: string, path: string, source?: AsyncIterable<Uint8Array>, headers: Record<string, string> = {}, signal?: AbortSignal) {
    if (signal?.aborted) throw new AgentTunnelError('TUNNEL_ABORTED')
    validateTunnelPath(target, path)
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method)) throw new AgentTunnelError('TUNNEL_INVALID_REQUEST')
    for (const [key, value] of Object.entries(headers)) {
      if (!['content-type', 'x-incus-name', 'x-incus-pool', 'x-incus-uid', 'x-incus-gid', 'x-incus-mode', 'x-incus-type', 'x-incus-write'].includes(key.toLowerCase()) || value.length > 4096 || /[\r\n]/.test(value)) throw new AgentTunnelError('TUNNEL_INVALID_HEADERS')
    }
    if (this.pending.size + this.streams.size + this.httpStreams.size >= TUNNEL_MAX_CONCURRENT) throw new AgentTunnelError('TUNNEL_CAPACITY')
    const id = randomUUID()
    const abort = () => stream.fail(new AgentTunnelError('TUNNEL_ABORTED', true))
    const stream = new HttpTunnelStream(id, frame => this.send(frame), () => { this.httpStreams.delete(id); signal?.removeEventListener('abort', abort) })
    this.httpStreams.set(id, stream)
    signal?.addEventListener('abort', abort, { once: true })
    try { this.send({ type: 'http-open', id, target, method, path, headers }) }
    catch (error) { stream.fail(error instanceof Error ? error : new Error(String(error))) }
    void stream.upload(source)
    return stream.response
  }
  closeStream(id: string): void {
    const stream = this.streams.get(id)
    this.streams.delete(id)
    const pending = this.pending.get(id)
    if (pending) { clearTimeout(pending.timer); this.pending.delete(id); pending.reject(new AgentTunnelError('TUNNEL_WS_CLOSED', true)); pending.stream?.finish() }
    try { this.send({ type: 'ws-close', id }) } catch { }
    stream?.finish()
  }
  private receive(frame: Frame): void {
    if (!frame || typeof frame !== 'object' || typeof frame.id !== 'string') throw new AgentTunnelError('TUNNEL_INVALID_FRAME')
    if (frame.type.startsWith('http-')) { this.httpStreams.get(frame.id)?.receive(frame); return }
    if (frame.type === 'ws-ack') { this.streams.get(frame.id)?.acknowledged(); return }
    const pending = this.pending.get(frame.id)
    if (frame.type === 'ws-data') {
      const data = decodeBody(frame.body ?? '', TUNNEL_MAX_WS_DATA)
      if (typeof frame.binary !== 'boolean' && frame.binary !== undefined) throw new AgentTunnelError('TUNNEL_INVALID_FRAME')
      this.streams.get(frame.id)?.receiveMessage(data, frame.binary === true)
      return
    }
    if (frame.type === 'ws-close') { this.closeStream(frame.id); return }
    if (frame.type !== 'response' && frame.type !== 'ws-opened') throw new AgentTunnelError('TUNNEL_INVALID_FRAME')
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(frame.id)
    if (frame.error) { pending.stream?.finish(); pending.reject(new AgentTunnelError('TUNNEL_REMOTE_FAILED', /UNKNOWN/.test(frame.error))); return }
    if (frame.type === 'ws-opened') {
      if (!pending.stream) throw new AgentTunnelError('TUNNEL_INVALID_FRAME')
      pending.stream.readyState = 1
      this.streams.set(frame.id, pending.stream)
      pending.resolve({ statusCode: 101, headers: {}, body: Buffer.alloc(0) })
      return
    }
    if (pending.stream || !Number.isInteger(frame.status) || frame.status! < 100 || frame.status! > 599) { pending.reject(new AgentTunnelError('TUNNEL_INVALID_RESPONSE', true)); throw new AgentTunnelError('TUNNEL_INVALID_RESPONSE') }
    try {
      const headers: Record<string, string> = {}
      for (const [key, value] of Object.entries(frame.headers ?? {})) {
        if (key !== 'content-type' || typeof value !== 'string' || value.length > 4096 || /[\r\n]/.test(value)) throw new AgentTunnelError('TUNNEL_INVALID_HEADERS')
        headers[key] = value
      }
      pending.resolve({ statusCode: frame.status!, headers, body: decodeBody(frame.body ?? '', TUNNEL_MAX_BODY) })
    }
    catch (error) { pending.reject(error instanceof Error ? error : new Error(String(error))); throw error }
  }
  close(code = 'TUNNEL_DISCONNECTED'): void {
    if (this.closed) return
    this.closed = true
    clearInterval(this.heartbeat)
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new AgentTunnelError(code, true)); pending.stream?.finish() }
    this.pending.clear()
    for (const stream of this.streams.values()) stream.finish()
    this.streams.clear()
    for (const stream of this.httpStreams.values()) stream.fail(new AgentTunnelError(code, true))
    this.httpStreams.clear()
    this.ws.terminate()
    this.removed()
  }
}

const connections = new Map<number, TunnelConnection>()
export function attachAgentTunnel(hostId: number, agentId: string, ws: WebSocket): TunnelConnection {
  if (connections.has(hostId) || connections.size >= 4096) throw new AgentTunnelError('TUNNEL_CONNECTION_CAPACITY')
  const connection = new TunnelConnection(hostId, agentId, ws, () => { if (connections.get(hostId) === connection) connections.delete(hostId) })
  connections.set(hostId, connection)
  return connection
}
export function getAgentTunnel(hostId: number): TunnelConnection {
  const connection = connections.get(hostId)
  if (!connection) throw new AgentTunnelError('TUNNEL_OFFLINE')
  return connection
}
export function closeAgentTunnel(hostId: number): void { connections.get(hostId)?.close('TUNNEL_AUTH_REVOKED') }
export function closeAllAgentTunnels(): void { for (const connection of connections.values()) connection.close('TUNNEL_SERVER_DRAIN') }
