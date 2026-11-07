import { spawn } from 'node:child_process'
import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import { getSystemConfig } from '../db/system-config.js'
import { getSystemConfigNumber } from '../db/system-config.js'

export const NETWORK_PROBE_CONFIG_KEY = 'network_probe_targets'
const MAX_TARGETS = 30
const MIN_PORT = 1
const MAX_PORT = 65535

export interface NetworkProbeTarget {
  id: string
  label: string
  host: string
  tcpPorts: number[]
  icmp: boolean
}

export interface NetworkProbeResult {
  id: string
  label: string
  host: string
  method: 'tcp' | 'icmp'
  port?: number
  success: boolean
  latencyMs: number | null
  error?: string
}

const requestBuckets = new Map<string, number[]>()
let activeProbes = 0

function isPublicIpv4(value: string): boolean {
  const octets = value.split('.').map(Number)
  if (octets.length !== 4 || octets.some(part => part < 0 || part > 255)) return false
  const [a, b] = octets
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) || (a === 198 && (b === 18 || b === 19)))
}

function isPublicIpv6(value: string): boolean {
  const normalized = value.toLowerCase()
  const firstHextet = Number.parseInt(normalized.split(':')[0] || '0', 16)
  return firstHextet >= 0x2000 && firstHextet <= 0x3fff && !normalized.startsWith('2001:db8:')
}

export async function resolvePublicTargetHost(host: string): Promise<string | null> {
  if (host.length > 253 || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(host)) return null
  if (isIP(host)) return null
  try {
    const addresses = await lookup(host, { all: true, verbatim: true })
    if (!addresses.length || addresses.some(item => item.family === 4 ? !isPublicIpv4(item.address) : !isPublicIpv6(item.address))) return null
    return addresses[Math.floor(Math.random() * addresses.length)].address
  } catch {
    return null
  }
}

export function parseNetworkProbeTargets(value: unknown): NetworkProbeTarget[] | null {
  if (!Array.isArray(value) || value.length > MAX_TARGETS) return null
  const ids = new Set<string>()
  const targets: NetworkProbeTarget[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null
    const candidate = item as Record<string, unknown>
    if (typeof candidate.id !== 'string' || !/^[a-z0-9_-]{1,40}$/.test(candidate.id) || ids.has(candidate.id)) return null
    if (typeof candidate.label !== 'string' || !candidate.label.trim() || candidate.label.trim().length > 80) return null
    if (typeof candidate.host !== 'string' || candidate.host !== candidate.host.trim() || !/^[a-z0-9.-]{1,253}$/i.test(candidate.host)) return null
    if (isIP(candidate.host)) return null
    if (!Array.isArray(candidate.tcpPorts) || candidate.tcpPorts.length > 10 || candidate.tcpPorts.some(port => !Number.isInteger(port) || (port as number) < MIN_PORT || (port as number) > MAX_PORT)) return null
    if (typeof candidate.icmp !== 'boolean' || (!candidate.icmp && candidate.tcpPorts.length === 0)) return null
    ids.add(candidate.id)
    targets.push({ id: candidate.id, label: candidate.label.trim(), host: candidate.host.toLowerCase(), tcpPorts: Array.from(new Set(candidate.tcpPorts as number[])), icmp: candidate.icmp })
  }
  return targets
}

export async function getNetworkProbeTargets(): Promise<NetworkProbeTarget[]> {
  const raw = await getSystemConfig(NETWORK_PROBE_CONFIG_KEY)
  if (!raw) return []
  try {
    return parseNetworkProbeTargets(JSON.parse(raw)) || []
  } catch {
    return []
  }
}

export function checkNetworkProbeRateLimit(key: string): boolean {
  const now = Date.now()
  if (requestBuckets.size >= 10000 && !requestBuckets.has(key)) {
    for (const [bucketKey, timestamps] of requestBuckets) {
      if (timestamps.every(timestamp => now - timestamp >= 60_000)) requestBuckets.delete(bucketKey)
    }
    if (requestBuckets.size >= 10000) return false
  }
  const recent = (requestBuckets.get(key) || []).filter(timestamp => now - timestamp < 60_000)
  if (recent.length >= 5) return false
  recent.push(now)
  requestBuckets.set(key, recent)
  return true
}

export async function runNetworkProbe(target: NetworkProbeTarget, method: 'tcp' | 'icmp', port?: number): Promise<NetworkProbeResult> {
  const base: NetworkProbeResult = { id: target.id, label: target.label, host: target.host, method, ...(method === 'tcp' ? { port } : {}), success: false, latencyMs: null }
  if (activeProbes >= 10) return { ...base, error: '探測併發量已滿，請稍後重試' }
  activeProbes++
  try {
    const timeoutSeconds = Math.max(1, Math.min(5, await getSystemConfigNumber('network_probe_timeout_seconds', 3)))
    const address = await resolvePublicTargetHost(target.host)
    if (!address) return { ...base, error: '目標 DNS 不可用或解析至非公開位址' }
    const started = performance.now()
    if (method === 'tcp') {
      const net = await import('node:net')
      return await new Promise(resolve => {
        const socket = new net.Socket()
        let settled = false
        const finish = (success: boolean, error?: string) => {
          if (settled) return
          settled = true
          socket.destroy()
          resolve({ ...base, success, latencyMs: Math.round(performance.now() - started), ...(error ? { error } : {}) })
        }
        socket.setTimeout(timeoutSeconds * 1000, () => finish(false, '連線逾時'))
        socket.once('error', () => finish(false, 'TCP 連線失敗'))
        socket.connect(port!, address, () => finish(true))
      })
    }
    return await new Promise(resolve => {
      const args = process.platform === 'win32' ? ['-n', '1', '-w', String(timeoutSeconds * 1000), address] : ['-n', '-c', '1', '-W', String(timeoutSeconds), address]
      const child = spawn('ping', args, { shell: false, stdio: 'ignore', windowsHide: true })
      const timeout = setTimeout(() => child.kill(), (timeoutSeconds + 1) * 1000)
      child.once('error', () => {
        clearTimeout(timeout)
        resolve({ ...base, error: 'ICMP 工具不可用' })
      })
      child.once('close', code => {
        clearTimeout(timeout)
        const success = code === 0
        resolve({ ...base, success, latencyMs: success ? Math.round(performance.now() - started) : null, ...(!success ? { error: 'ICMP 無回應或探測逾時' } : {}) })
      })
    })
  } finally {
    activeProbes--
  }
}
