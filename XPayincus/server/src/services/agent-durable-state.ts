import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { compareReleaseTags, isValidReleaseTag } from '../lib/system-version.js'
import type { AuthorizedAgentUpgrade } from '../lib/agent-upgrade.js'

// Single API process only: the filesystem journal and read/modify/write operations are not shared locks.
function root(): string {
  const path = process.env.INCUDAL_AGENT_STATE_DIR?.trim() || join(homedir(), '.local', 'state', 'xpayincus', 'agent')
  if (!isAbsolute(path)) throw new Error('Agent state directory must be absolute')
  let ancestor = resolve(path)
  while (true) {
    if (existsSync(join(ancestor, '.git')) || existsSync(join(ancestor, 'package.json'))) throw new Error('Agent state directory must be outside the application repository')
    const parent = dirname(ancestor)
    if (parent === ancestor) break
    ancestor = parent
  }
  mkdirSync(path, { recursive: true, mode: 0o700 })
  return path
}

function filename(key: string): string {
  return join(root(), createHash('sha256').update(key).digest('hex') + '.json')
}

function read<T>(key: string): T | null {
  const path = filename(key)
  if (!existsSync(path)) return null
  if (statSync(path).size > 4 * 1024 * 1024) throw new Error('Agent journal exceeds file limit')
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

export function readAgentMonitoringJournal<T>(agentId: string): T | null {
  return read<T>(`monitoring-v2:${agentId}`)
}

export function writeAgentMonitoringJournal(agentId: string, value: unknown): void {
  write(`monitoring-v2:${agentId}`, value)
}

function write(key: string, value: unknown): void {
  const path = filename(key)
  const body = JSON.stringify(value)
  const bytes = Buffer.byteLength(body)
  if (bytes > 4 * 1024 * 1024) throw new Error('Agent journal exceeds file limit')
  const directoryPath = root()
  const files = readdirSync(directoryPath).filter(name => {
    if (!/^[a-f0-9]{64}\.json(?:\.tmp)?$/.test(name)) return false
    const entry = join(directoryPath, name)
    const age = Date.now() - statSync(entry).mtimeMs
    if (age > 31 * 86400000 || (name.endsWith('.tmp') && age > 3600000)) {
      unlinkSync(entry)
      return false
    }
    return name.endsWith('.json')
  })
  const total = files.reduce((sum, name) => sum + statSync(join(directoryPath, name)).size, 0)
  const previous = existsSync(path) ? statSync(path).size : 0
  if ((!previous && files.length >= 10000) || total - previous + bytes > 256 * 1024 * 1024) throw new Error('Agent journal capacity reached')
  const temp = path + '.tmp'
  const fd = openSync(temp, 'w', 0o600)
  try {
    writeFileSync(fd, body)
    fsyncSync(fd)
  } finally { closeSync(fd) }
  renameSync(temp, path)
  if (process.platform !== 'win32') {
    const directory = openSync(root(), 'r')
    try { fsyncSync(directory) } finally { closeSync(directory) }
  }
}

const heartbeatQueues = new Map<string, Promise<void>>()

export async function serializeAgentHeartbeat<T>(agentId: string, action: () => Promise<T>): Promise<T> {
  const previous = heartbeatQueues.get(agentId) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>(resolve => { release = resolve })
  heartbeatQueues.set(agentId, current)
  await previous
  try { return await action() } finally {
    release()
    if (heartbeatQueues.get(agentId) === current) heartbeatQueues.delete(agentId)
  }
}

interface HostSample {
  id: string
  sampledAt: string
  resources: Record<string, number>
  metrics: Record<string, number>
}

const resourceKeys = ['cpuTotal', 'cpuUsagePercent', 'memoryTotalMb', 'memoryAvailableMb', 'memoryUsedMb', 'memoryUsagePercent', 'swapTotalMb', 'swapUsedMb', 'swapUsagePercent', 'diskTotalBytes', 'diskUsedBytes', 'diskAvailableBytes', 'diskUsagePercent', 'processCount']
const metricKeys = ['load1', 'load5', 'load15', 'uptimeSeconds', 'heartbeatIntervalSeconds']
function numericFields(value: unknown, keys: string[]): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(keys.flatMap(key => {
    const field = (value as Record<string, unknown>)[key]
    return typeof field === 'number' && Number.isFinite(field) && field >= 0 ? [[key, field]] : []
  }))
}

export function ingestAgentHistory(agentId: string, payload: unknown, now = Date.now()): string[] {
  if (!payload || typeof payload !== 'object') return []
  const envelope = payload as { schemaVersion?: unknown; samples?: unknown }
  if (envelope.schemaVersion !== 1 || !Array.isArray(envelope.samples) || envelope.samples.length > 32) return []
  const key = `history:${agentId}`
  const stored = read<{ samples: HostSample[]; receipts: Record<string, number> }>(key)
  const existing = stored?.samples ?? []
  const receipts: Record<string, number> = Object.fromEntries(Object.entries(stored?.receipts ?? {}).filter(([, at]) => at >= now - 8 * 86400000))
  const byId = new Map(existing.map(sample => [sample.id, sample]))
  const accepted: string[] = []
  for (const raw of envelope.samples) {
    if (!raw || typeof raw !== 'object') continue
    const sample = raw as Record<string, unknown>
    if (typeof sample.id !== 'string' || !/^[a-f0-9]{32}$/.test(sample.id) || typeof sample.sampledAt !== 'string') continue
    const time = Date.parse(sample.sampledAt)
    if (!Number.isFinite(time) || time > now + 60000) continue
    if (receipts[sample.id] !== undefined || byId.has(sample.id) || time < now - 30 * 86400000) {
      accepted.push(sample.id)
      continue
    }
    if (Object.keys(receipts).length >= 32768) continue
    accepted.push(sample.id)
    receipts[sample.id] = now
    byId.set(sample.id, { id: sample.id, sampledAt: new Date(time).toISOString(), resources: numericFields(sample.resources, resourceKeys), metrics: numericFields(sample.metrics, metricKeys) })
  }
  const buckets = new Map<number, HostSample>()
  for (const sample of [...byId.values()].sort((a, b) => Date.parse(a.sampledAt) - Date.parse(b.sampledAt))) {
    const time = Date.parse(sample.sampledAt)
    if (time < now - 30 * 86400000) continue
    const resolution = time < now - 86400000 ? 3600000 : 30000
    buckets.set(Math.floor(time / resolution) * resolution, sample)
  }
  write(key, { samples: [...buckets.values()].sort((a, b) => Date.parse(a.sampledAt) - Date.parse(b.sampledAt)).slice(-4096), receipts })
  return accepted
}

export function readAgentHistory(agentId: string, from: number, to: number, limit: number, resolution: number): HostSample[] {
  const now = Date.now()
  const samples = (read<{ samples: HostSample[] }>(`history:${agentId}`)?.samples ?? []).filter(sample => {
    const time = Date.parse(sample.sampledAt)
    return time >= Math.max(from, now - 30 * 86400000) && time <= Math.min(to, now)
  })
  const buckets = new Map<number, HostSample>()
  for (const sample of samples) buckets.set(Math.floor(Date.parse(sample.sampledAt) / resolution), sample)
  return [...buckets.values()].slice(-limit)
}

interface Operation {
  operationId: string
  targetVersion: string
  requestedAt: string
  expiresAt: string
  deliveredAt: string | null
  status: 'pending' | 'delivered' | 'succeeded' | 'failed' | 'unconfirmed'
  phase: string
  error: string | null
  updatedAt: string
  instruction: AuthorizedAgentUpgrade
  requiresHealth?: boolean
}

function publicState(operation: Operation) {
  const { instruction: _instruction, ...state } = operation
  return state
}

export class DurableAgentUpgradeRequests {
  get(agentId: string, now = Date.now()) {
    const operation = read<Operation>(`upgrade:${agentId}`)
    if (!operation) return null
    if (now > Date.parse(operation.expiresAt) && ['pending', 'delivered'].includes(operation.status)) {
      operation.status = 'unconfirmed'
      operation.phase = 'health-timeout'
      operation.updatedAt = new Date(now).toISOString()
      write(`upgrade:${agentId}`, operation)
    }
    return publicState(operation)
  }

  request(agentId: string, instruction: AuthorizedAgentUpgrade, heartbeatSeconds: number, now = Date.now()) {
    const existing = this.get(agentId, now)
    if (existing && ['pending', 'delivered'].includes(existing.status)) return existing
    if (!instruction.available || !instruction.version || !instruction.url || !instruction.sha256) throw new Error('Invalid Agent upgrade authorization')
    const operation: Operation = {
      operationId: randomUUID(), targetVersion: instruction.version,
      requestedAt: new Date(now).toISOString(), expiresAt: new Date(now + (heartbeatSeconds * 2 + 1200) * 1000).toISOString(),
      deliveredAt: null, status: 'pending', phase: 'pending', error: null, updatedAt: new Date(now).toISOString(), instruction: { ...instruction }
    }
    write(`upgrade:${agentId}`, operation)
    return publicState(operation)
  }

  heartbeat(agentId: string, current: string | undefined, runtime: Record<string, unknown>, now = Date.now(), report?: Record<string, unknown>, capabilities: string[] = []): AuthorizedAgentUpgrade & { operationId?: string } {
    this.get(agentId, now)
    const operation = read<Operation>(`upgrade:${agentId}`)
    if (!operation || !current || !isValidReleaseTag(current)) return { available: false }
    const modern = operation.deliveredAt ? operation.requiresHealth === true : capabilities.includes('upgrade-status-v1')
    operation.requiresHealth = modern
    const matching = report?.operationId === operation.operationId && report?.targetVersion === operation.targetVersion
    if (operation.deliveredAt && !['succeeded', 'failed'].includes(operation.status)) {
      const phases = ['pending', 'delivered', 'scheduled', 'downloading', 'verifying', 'replacing', 'awaiting-health', 'healthy', 'failed']
      if (matching && phases.indexOf(String(report?.phase)) >= Math.max(2, phases.indexOf(operation.phase))) {
        operation.phase = String(report!.phase)
        if (report!.phase === 'failed') {
          operation.status = 'failed'
          operation.error = 'Agent reported upgrade failure; inspect host service logs'
        }
      }
      if (operation.status !== 'failed' && current === operation.targetVersion && (!modern || (matching && report?.phase === 'healthy'))) {
        operation.status = 'succeeded'
        operation.phase = modern ? 'healthy' : 'version-confirmed-legacy'
      }
      operation.updatedAt = new Date(now).toISOString()
      write(`upgrade:${agentId}`, operation)
    }
    if (!['pending', 'delivered'].includes(operation.status) || compareReleaseTags(operation.targetVersion, current) <= 0 ||
      runtime.goos !== operation.instruction.platform || runtime.goarch !== operation.instruction.arch) return { available: false }
    if (operation.status === 'delivered' && (!modern || matching)) return { available: false }
    operation.status = 'delivered'
    operation.phase = 'delivered'
    operation.deliveredAt ??= new Date(now).toISOString()
    operation.updatedAt = new Date(now).toISOString()
    write(`upgrade:${agentId}`, operation)
    return { ...operation.instruction, operationId: operation.operationId }
  }
}
