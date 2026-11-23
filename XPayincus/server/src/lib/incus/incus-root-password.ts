import type { TunnelConnection, TunnelSocket } from '../agent-tunnel.js'

export function isValidInstanceRootPassword(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 12 && value.length <= 128 &&
    !/[^\x20-\x7e]|:/.test(value) && value.trim().length > 0
}

export async function changeIncusRootPassword(
  tunnel: Pick<TunnelConnection, 'request' | 'openWebSocket'>,
  instanceName: string,
  password: string
): Promise<void> {
  if (!isValidInstanceRootPassword(password)) throw new Error('Invalid root password')
  const sockets: TunnelSocket[] = []
  const deadline = AbortSignal.timeout(20_000)
  try {
    const exec = await tunnel.request('incus', 'POST', `/1.0/instances/${encodeURIComponent(instanceName)}/exec`,
      Buffer.from(JSON.stringify({ command: ['chpasswd'], user: 0, group: 0, interactive: false, 'wait-for-websocket': true, 'record-output': false })),
      { 'content-type': 'application/json' }, 5_000, deadline)
    const operation = JSON.parse(exec.body.toString()) as { type?: string; operation?: string; metadata?: { metadata?: { fds?: Record<string, string> } } }
    const path = operation.operation
    const fds = operation.metadata?.metadata?.fds
    if (exec.statusCode !== 202 || operation.type !== 'async' || typeof path !== 'string' ||
        !/^\/1\.0\/operations\/[A-Za-z0-9-]+$/.test(path) || !fds) throw new Error('Invalid Incus exec operation')

    const descriptors = ['0', '1', '2', 'control'] as const
    const secrets = descriptors.map(fd => fds[fd])
    if (secrets.some(secret => typeof secret !== 'string' || secret.length < 8) || new Set(secrets).size !== descriptors.length) {
      throw new Error('Invalid Incus exec descriptors')
    }
    // Open all descriptors (including control, required by the VM agent). Discard guest output.
    const opened = await Promise.allSettled(secrets.map(async secret => {
      const socket = await tunnel.openWebSocket(`${path}/websocket?secret=${encodeURIComponent(secret!)}`)
      sockets.push(socket)
      socket.on('message', () => {})
      return socket
    }))
    const stdin = opened[0]
    if (stdin?.status !== 'fulfilled' || opened.some(result => result.status === 'rejected' || result.value.readyState !== result.value.OPEN)) {
      throw new Error('Incus exec channel unavailable')
    }
    deadline.throwIfAborted()
    stdin.value.send(Buffer.from(`root:${password}\n`))
    // Incus uses an empty text frame as the pipe EOF; closing the socket can abort exec.
    stdin.value.send('')

    const waited = await tunnel.request('incus', 'GET', `${path}/wait?timeout=10`, undefined, {}, 12_000, deadline)
    const result = JSON.parse(waited.body.toString()) as { type?: string; metadata?: { status_code?: number; metadata?: { return?: number } } }
    if (waited.statusCode !== 200 || result.type !== 'sync' || result.metadata?.status_code !== 200 || result.metadata.metadata?.return !== 0) {
      throw new Error('Incus did not confirm the password change')
    }
  } catch {
    // Never propagate transport responses, WebSocket tokens, or guest output.
    throw new Error('Incus did not confirm the password change')
  } finally {
    for (const socket of sockets) socket.close()
  }
}
