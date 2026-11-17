import { Dispatcher } from 'undici'
import { AgentTunnelError, getAgentTunnel, TUNNEL_MAX_BODY, type TunnelTarget } from './agent-tunnel.js'

export async function resolveTunnelHostId(hostId: number | undefined, url: string): Promise<number> {
  if (hostId !== undefined) {
    if (!Number.isSafeInteger(hostId) || hostId < 1) throw new AgentTunnelError('TUNNEL_INVALID_HOST')
    return hostId
  }
  const { prisma } = await import('../db/prisma.js')
  const hosts = await prisma.host.findMany({ where: { url }, select: { id: true }, take: 2 })
  if (hosts.length !== 1) throw new AgentTunnelError('TUNNEL_HOST_ID_REQUIRED')
  return hosts[0]!.id
}

export class AgentTunnelDispatcher extends Dispatcher {
  private closed = false
  private readonly active = new Map<AbortController, Promise<void>>()
  constructor(private readonly host: () => Promise<number>, private readonly target: TunnelTarget) { super() }

  override close(): Promise<void>
  override close(callback: () => void): void
  override close(callback?: () => void): Promise<void> | void {
    this.closed = true
    const done = Promise.allSettled(this.active.values()).then(() => {})
    if (callback) { void done.then(callback); return }
    return done
  }

  override destroy(): Promise<void>
  override destroy(error: Error | null): Promise<void>
  override destroy(callback: () => void): void
  override destroy(error: Error | null, callback: () => void): void
  override destroy(errorOrCallback?: Error | null | (() => void), callback?: () => void): Promise<void> | void {
    this.closed = true
    for (const controller of this.active.keys()) controller.abort()
    const done = Promise.allSettled(this.active.values()).then(() => {})
    const complete = typeof errorOrCallback === 'function' ? errorOrCallback : callback
    if (complete) { void done.then(complete); return }
    return done
  }

  override dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    if (this.closed) { queueMicrotask(() => handler.onError?.(new AgentTunnelError('TUNNEL_DISPATCHER_CLOSED'))); return false }
    let aborted = false
    const controller = new AbortController()
    handler.onConnect?.((error) => { aborted = true; controller.abort(); handler.onError?.(error ?? new AgentTunnelError('TUNNEL_ABORTED', true)) })
    const task = (async () => {
      const body = options.body
      const streaming = body != null && typeof body !== 'string' && !Buffer.isBuffer(body) && !(body instanceof Uint8Array)
      const buffer = streaming || body == null ? Buffer.alloc(0) : Buffer.from(body as string | Uint8Array)
      if (buffer.length > TUNNEL_MAX_BODY) throw new AgentTunnelError('TUNNEL_BODY_LIMIT')
      const headers: Record<string, string> = {}
      if (Array.isArray(options.headers)) {
        for (let i = 0; i < options.headers.length; i += 2) headers[String(options.headers[i]).toLowerCase()] = String(options.headers[i + 1])
      } else {
        for (const [key, value] of Object.entries(options.headers ?? {})) headers[key.toLowerCase()] = String(value)
      }
      delete headers['content-length']
      const hostId = await this.host()
      if (aborted) return
      if (streaming) {
        if (!(Symbol.asyncIterator in Object(body))) throw new AgentTunnelError('TUNNEL_STREAMING_UNSUPPORTED')
        const result = await getAgentTunnel(hostId).requestStream(this.target, options.method, options.path, body as AsyncIterable<Uint8Array>, headers, controller.signal)
        if (aborted) { result.body.destroy(); return }
        let resume: (() => void) | undefined
        const unblock = () => { resume?.(); resume = undefined }
        const abort = () => { result.body.destroy(new AgentTunnelError('TUNNEL_ABORTED', true)); unblock() }
        controller.signal.addEventListener('abort', abort, { once: true })
        try {
          handler.onHeaders?.(result.statusCode, Object.entries(result.headers).flatMap(([key, value]) => [Buffer.from(key), Buffer.from(value)]), unblock, '')
          for await (const chunk of result.body) {
            if (aborted) return
            if (handler.onData?.(chunk) === false) await new Promise<void>(resolve => { resume = resolve; if (aborted) unblock() })
          }
          if (!aborted) handler.onComplete?.([])
        } finally { controller.signal.removeEventListener('abort', abort); result.body.destroy() }
        return
      }
      const result = await getAgentTunnel(hostId).request(this.target, options.method, options.path, buffer, headers, Math.min(120000, options.headersTimeout || 30000), controller.signal)
      if (aborted) return
      handler.onHeaders?.(result.statusCode, Object.entries(result.headers).flatMap(([key, value]) => [Buffer.from(key), Buffer.from(value)]), () => {}, '')
      handler.onData?.(result.body)
      handler.onComplete?.([])
    })().catch(error => { if (!aborted) handler.onError?.(error instanceof Error ? error : new Error(String(error))) }).finally(() => { this.active.delete(controller) })
    this.active.set(controller, task)
    return true
  }
}
