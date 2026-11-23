import { http } from '@/api'
import { buildApiUrl } from '@/utils/api-url'

export interface MonitoringStats {
  min: number
  max: number
  avg: number
  count: number
  coverage: number
}
export interface MonitoringCounterStats {
  first: number
  last: number
  delta: number
  resetCount: number
  count: number
  coverage: number
  partial: boolean
  unit: 'microseconds' | 'bytes'
}

export const instanceMetrics = ['cpuUsagePercent', 'memoryUsedBytes', 'diskReadBytesPerSecond', 'diskWriteBytesPerSecond', 'diskIOBytesPerSecond', 'rxBytesPerSecond', 'txBytesPerSecond'] as const
export type InstanceMetric = typeof instanceMetrics[number]
export interface MonitoringQuery {
  from: string
  to: string
  resolutionSeconds: number
  limit: number
}
interface MonitoringResponse {
  hostId: number
  schemaVersion: 2
  from: string
  to: string
  capacityTruncated: boolean
}
export interface MonitoringHistory extends MonitoringResponse {
  incomplete: boolean
  retentionDays: number
  resolutionSeconds: number
  summary: Record<string, MonitoringStats>
  summaryCounters: Record<string, MonitoringCounterStats>
  buckets: Array<{ from: string; to: string; metrics: Record<string, MonitoringStats>; counters: Record<string, MonitoringCounterStats> }>
  bucketsTruncated: boolean
}
export interface InstanceHistory extends MonitoringHistory {
  name: string
}
export interface InstanceTop extends MonitoringResponse {
  metric: InstanceMetric
  orderBy: 'avg' | 'max'
  top: number
  items: Array<MonitoringStats & { name: string }>
}
export interface ComponentEvent {
  id: string
  sampledAt: string
  type: 'component-state'
  components: Record<string, unknown>
}
export interface ComponentEvents extends MonitoringResponse {
  eventsTruncated: boolean
  events: ComponentEvent[]
}

export interface InstanceMonitoringSample {
  sampledAt: string
  online: boolean
  metrics: Record<string, number | undefined>
}

export interface InstanceMonitoringSnapshot extends MonitoringResponse {
  online: boolean
  sample?: InstanceMonitoringSample
}

async function get<T>(hostId: number, view: string, params: MonitoringQuery & { name?: string; metric?: InstanceMetric; orderBy?: 'avg' | 'max'; top?: number }, signal?: AbortSignal): Promise<T> {
  return http.get<T, T>(`/agent/hosts/${hostId}/monitoring/${view}`, {
    params,
    signal,
    timeout: 30000
  })
}

export const agentMonitoringApi = {
  history: (hostId: number, query: MonitoringQuery, signal?: AbortSignal) => get<MonitoringHistory>(hostId, 'history', query, signal),
  instanceHistory: (hostId: number, query: MonitoringQuery, name: string, signal?: AbortSignal) => get<InstanceHistory>(hostId, 'instances/history', { ...query, name }, signal),
  top: (hostId: number, query: MonitoringQuery, metric: InstanceMetric, orderBy: 'avg' | 'max', top: number, signal?: AbortSignal) => get<InstanceTop>(hostId, 'instances/top', { ...query, metric, orderBy, top }, signal),
  events: (hostId: number, query: MonitoringQuery, signal?: AbortSignal) => get<ComponentEvents>(hostId, 'events', query, signal)
}

export function getOwnInstanceMonitoringHistory(instanceId: number, signal: AbortSignal): Promise<InstanceHistory> {
  return http.get<InstanceHistory, InstanceHistory>(`/instances/${instanceId}/monitoring/history`, { signal, timeout: 30000 })
}

export async function createInstanceMonitoringStreamTicket(instanceId: number): Promise<{ ticket: string; expiresIn: number }> {
  return http.post(`/instances/${instanceId}/monitoring/stream-ticket`, {})
}

export function instanceMonitoringStreamUrl(instanceId: number, ticket: string): string {
  const url = new URL(buildApiUrl(`/instances/${instanceId}/monitoring/stream`), window.location.origin)
  url.searchParams.set('ticket', ticket)
  return url.toString()
}
