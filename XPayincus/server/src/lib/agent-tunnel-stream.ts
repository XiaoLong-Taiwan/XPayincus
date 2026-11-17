import { Readable } from 'node:stream'

export const CHUNK_SIZE = 64 * 1024
export interface StreamFrame {
  type: string
  id?: string
  body?: string
  status?: number
  headers?: Record<string, string>
  error?: string
  seq?: number
}

export class HttpTunnelStream {
  readonly body: Readable
  readonly response: Promise<{ statusCode: number; headers: Record<string, string>; body: Readable }>
  private resolve!: (value: { statusCode: number; headers: Record<string, string>; body: Readable }) => void
  private reject!: (error: Error) => void
  private waiter?: { seq: number; resolve: () => void; reject: (error: Error) => void }
  private received = 0
  private sent = 0
  private credit = false
  private finished = false
  private headersReceived = false
  private source?: AsyncIterable<Uint8Array>
  private timer: NodeJS.Timeout
  constructor(readonly id: string, private readonly send: (frame: StreamFrame) => void, private readonly remove: () => void) {
    this.response = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject })
    this.body = new Readable({
      highWaterMark: CHUNK_SIZE,
      read: () => {
        if (!this.credit && this.headersReceived && !this.finished) {
          this.credit = true
          try { this.send({ type: 'http-credit', id, seq: this.received }) }
          catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))) }
        }
      },
      destroy: (error, callback) => {
        if (!this.finished) this.fail(error ?? new Error('TUNNEL_STREAM_CANCELED_OUTCOME_UNKNOWN'))
        callback(error)
      }
    })
    this.body.on('error', () => {})
    this.timer = setTimeout(() => this.fail(new Error('TUNNEL_STREAM_TIMEOUT_OUTCOME_UNKNOWN')), 30 * 60 * 1000)
  }
  receive(frame: StreamFrame): void {
    if (this.finished) return
    if (frame.type === 'http-ack') {
      if (!this.waiter || frame.seq !== this.waiter.seq) throw new Error('TUNNEL_STREAM_SEQUENCE')
      const waiter = this.waiter
      this.waiter = undefined
      waiter.resolve()
    } else if (frame.type === 'http-head') {
      if (this.headersReceived || !Number.isInteger(frame.status) || frame.status! < 200 || frame.status! > 599) throw new Error('TUNNEL_STREAM_HEADERS')
      const headers: Record<string, string> = {}
      for (const [key, value] of Object.entries(frame.headers ?? {})) {
        if (!['content-type', 'content-length', 'x-incus-uid', 'x-incus-gid', 'x-incus-mode', 'x-incus-type'].includes(key) || typeof value !== 'string' || value.length > 4096 || /[\r\n]/.test(value)) throw new Error('TUNNEL_STREAM_HEADERS')
        headers[key] = value
      }
      this.headersReceived = true
      this.resolve({ statusCode: frame.status!, headers, body: this.body })
    } else if (frame.type === 'http-data') {
      if (!this.credit || frame.seq !== this.received || typeof frame.body !== 'string' || frame.body.length > Math.ceil(CHUNK_SIZE / 3) * 4) throw new Error('TUNNEL_STREAM_SEQUENCE')
      const data = Buffer.from(frame.body, 'base64')
      if (data.length > CHUNK_SIZE || data.toString('base64') !== frame.body) throw new Error('TUNNEL_STREAM_BODY')
      this.credit = false
      this.received++
      this.body.push(data)
    } else if (frame.type === 'http-end') {
      if (!this.headersReceived || frame.seq !== this.received) throw new Error('TUNNEL_STREAM_SEQUENCE')
      this.finished = true
      clearTimeout(this.timer)
      this.waiter?.reject(new Error('TUNNEL_UPLOAD_ENDED_EARLY'))
      if (this.source && 'destroy' in this.source && typeof this.source.destroy === 'function') this.source.destroy()
      this.body.push(null)
      this.remove()
    } else if (frame.type === 'http-error') {
      this.fail(new Error('TUNNEL_STREAM_FAILED_OUTCOME_UNKNOWN'))
    } else throw new Error('TUNNEL_STREAM_FRAME')
  }
  async upload(source?: AsyncIterable<Uint8Array>): Promise<void> {
    this.source = source
    try {
      if (source) {
        for await (const chunk of source) {
          const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          for (let offset = 0; offset < data.length; offset += CHUNK_SIZE) {
            if (this.finished) return
            const seq = this.sent++
            await new Promise<void>((resolve, reject) => {
              this.waiter = { seq, resolve, reject }
              this.send({ type: 'http-upload', id: this.id, seq, body: data.subarray(offset, offset + CHUNK_SIZE).toString('base64') })
            })
          }
        }
      }
      if (!this.finished) this.send({ type: 'http-upload-end', id: this.id, seq: this.sent })
    } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))) }
  }
  fail(error: Error): void {
    if (this.finished) return
    this.finished = true
    clearTimeout(this.timer)
    this.waiter?.reject(error)
    if (this.source && 'destroy' in this.source && typeof this.source.destroy === 'function') this.source.destroy(error)
    this.reject(error)
    this.body.destroy(error)
    try { this.send({ type: 'cancel', id: this.id }) } catch { }
    this.remove()
  }
}
