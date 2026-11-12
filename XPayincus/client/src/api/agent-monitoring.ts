import axios from 'axios'
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
  unit: 'microseconds'
}

export const instanceMetrics = ['cpuUsagePercent', 'memoryUsedBytes', 'diskReadBytesPerSecond', 'diskWriteBytesPerSecond', 'diskIOBytesPerSecond'] as const
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

async function get<T>(hostId: number, view: string, params: MonitoringQuery & { name?: string; metric?: InstanceMetric; orderBy?: 'avg' | 'max'; top?: number }, signal?: AbortSignal): Promise<T> {
  const token = localStorage.getItem('token')
  const response = await axios.get<T>(buildApiUrl(`/agent/hosts/${hostId}/monitoring/${view}`), {
    params,
    signal,
    withCredentials: true,
    timeout: 30000,
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  })
  return response.data
}

export const agentMonitoringApi = {
  history: (hostId: number, query: MonitoringQuery, signal?: AbortSignal) => get<MonitoringHistory>(hostId, 'history', query, signal),
  instanceHistory: (hostId: number, query: MonitoringQuery, name: string, signal?: AbortSignal) => get<InstanceHistory>(hostId, 'instances/history', { ...query, name }, signal),
  top: (hostId: number, query: MonitoringQuery, metric: InstanceMetric, orderBy: 'avg' | 'max', top: number, signal?: AbortSignal) => get<InstanceTop>(hostId, 'instances/top', { ...query, metric, orderBy, top }, signal),
  events: (hostId: number, query: MonitoringQuery, signal?: AbortSignal) => get<ComponentEvents>(hostId, 'events', query, signal)
}
