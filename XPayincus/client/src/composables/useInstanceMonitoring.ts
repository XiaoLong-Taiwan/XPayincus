import { computed, onBeforeUnmount, ref } from 'vue'
import { agentMonitoringApi, createInstanceMonitoringStreamTicket, instanceMonitoringStreamUrl, type InstanceHistory, type InstanceMonitoringSample } from '@/api/agent-monitoring'

const MAX_TREND_POINTS = 100
const MAX_RECONNECT_ATTEMPTS = 5
const MONITORING_FRESHNESS_MS = 120000

export function useInstanceMonitoring() {
  const sample = ref<InstanceMonitoringSample | null>(null)
  const trend = ref<InstanceHistory | null>(null)
  const status = ref<'connecting' | 'connected' | 'reconnecting' | 'offline' | 'error'>('connecting')
  const reconnectAttempt = ref(0)
  const historyLoading = ref(false)
  const historyError = ref<{ message: string; code?: string | null; status?: number | null } | null>(null)
  let source: EventSource | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let staleTimer: ReturnType<typeof setTimeout> | null = null
  let activeInstanceId = 0
  let generation = 0
  let connectionAttempt = 0
  let points: InstanceMonitoringSample[] = []

  const isOffline = computed(() => status.value === 'offline')

  function clearTimers() {
    if (reconnectTimer) clearTimeout(reconnectTimer)
    if (staleTimer) clearTimeout(staleTimer)
    reconnectTimer = null
    staleTimer = null
  }

  function connect(instanceId: number, hostId: number, instanceName: string, onSample?: (value: InstanceMonitoringSample) => void) {
    disconnect()
    activeInstanceId = instanceId
    const currentGeneration = ++generation
    points = []
    sample.value = null
    trend.value = null
    status.value = 'connecting'
    historyLoading.value = true
    historyError.value = null
    const historyNow = Date.now()
    void agentMonitoringApi.instanceHistory(
      hostId,
      { from: new Date(historyNow - 7 * 86400000).toISOString(), to: new Date(historyNow - 1000).toISOString(), resolutionSeconds: 3600, limit: 1000 },
      instanceName
    ).then((result) => {
      if (generation === currentGeneration) trend.value = result
    }).catch((cause: any) => {
      if (generation === currentGeneration) {
        historyError.value = {
          message: cause?.message || '七日趨勢載入失敗',
          code: cause?.code,
          status: cause?.status
        }
      }
    }).finally(() => {
      if (generation === currentGeneration) historyLoading.value = false
    })

    const open = () => {
      if (generation !== currentGeneration || activeInstanceId !== instanceId) return
      const attempt = ++connectionAttempt
      void createInstanceMonitoringStreamTicket(instanceId).then(({ ticket }) => {
        if (generation !== currentGeneration || activeInstanceId !== instanceId || attempt !== connectionAttempt) return
        const eventSource = new EventSource(instanceMonitoringStreamUrl(instanceId, ticket), { withCredentials: true })
        source?.close()
        source = eventSource
        eventSource.onopen = () => {
          if (generation !== currentGeneration || attempt !== connectionAttempt) return
          reconnectAttempt.value = 0
          status.value = 'connected'
          if (staleTimer) clearTimeout(staleTimer)
          staleTimer = setTimeout(() => {
            status.value = 'offline'
          }, MONITORING_FRESHNESS_MS)
        }
        eventSource.onmessage = (event) => {
          if (generation !== currentGeneration || attempt !== connectionAttempt) return
          try {
            const payload = JSON.parse(event.data) as InstanceMonitoringSample | { type: string; sample?: InstanceMonitoringSample; online?: boolean }
            if ('type' in payload && payload.type === 'offline') {
              status.value = 'offline'
              return
            }
            const next: InstanceMonitoringSample | undefined = 'sampledAt' in payload
              ? payload
              : payload.sample
            if (!next?.sampledAt || !next.metrics) return
            if (next.online === false) {
              status.value = 'offline'
              return
            }
            sample.value = next
            onSample?.(next)
            status.value = 'connected'
            points.push(next)
            if (points.length > MAX_TREND_POINTS) points = points.slice(-MAX_TREND_POINTS)
            if (staleTimer) clearTimeout(staleTimer)
            staleTimer = setTimeout(() => { status.value = 'offline' }, MONITORING_FRESHNESS_MS)
          } catch {
            status.value = 'error'
          }
        }
        eventSource.onerror = () => {
          if (generation !== currentGeneration || attempt !== connectionAttempt) {
            eventSource.close()
            return
          }
          eventSource.close()
          source = null
          reconnectAttempt.value += 1
          if (reconnectAttempt.value > MAX_RECONNECT_ATTEMPTS) {
            status.value = 'offline'
            return
          }
          status.value = 'reconnecting'
          reconnectTimer = setTimeout(open, Math.min(1000 * 2 ** (reconnectAttempt.value - 1), 16000))
        }
      }).catch(() => {
        if (generation !== currentGeneration || activeInstanceId !== instanceId || attempt !== connectionAttempt) return
        reconnectAttempt.value += 1
        if (reconnectAttempt.value > MAX_RECONNECT_ATTEMPTS) {
          status.value = 'offline'
          return
        }
        status.value = 'reconnecting'
        reconnectTimer = setTimeout(open, Math.min(1000 * 2 ** (reconnectAttempt.value - 1), 16000))
      })
    }
    open()
  }

  function disconnect() {
    generation += 1
    connectionAttempt += 1
    activeInstanceId = 0
    source?.close()
    source = null
    clearTimers()
  }

  onBeforeUnmount(disconnect)

  return { sample, trend, status, reconnectAttempt, historyLoading, historyError, isOffline, connect, disconnect }
}
