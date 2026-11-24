import { computed, onBeforeUnmount, ref } from 'vue'
import { getOwnInstanceMonitoringHistory, createInstanceMonitoringStreamTicket, instanceMonitoringStreamUrl, type InstanceHistory, type InstanceMonitoringSample } from '@/api/agent-monitoring'

const MAX_RECONNECT_ATTEMPTS = 5
const MONITORING_FRESHNESS_MS = 120000
const MAX_SAMPLE_CLOCK_SKEW_MS = 60000

export function useInstanceMonitoring() {
  const sample = ref<InstanceMonitoringSample | null>(null)
  const trend = ref<InstanceHistory | null>(null)
  const status = ref<'connecting' | 'connected' | 'reconnecting' | 'offline' | 'error'>('connecting')
  const reconnectAttempt = ref(0)
  const historyLoading = ref(false)
  const historyError = ref<{ message: string; code?: string | null; status?: number | null } | null>(null)
  let historyRequest: AbortController | null = null
  let source: EventSource | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let staleTimer: ReturnType<typeof setTimeout> | null = null
  let activeInstanceId = 0
  let generation = 0
  let connectionAttempt = 0

  const isOffline = computed(() => status.value === 'offline')

  function clearStaleTimer() {
    if (staleTimer) clearTimeout(staleTimer)
    staleTimer = null
  }

  function clearSample(nextStatus: 'offline' | 'reconnecting' | 'error') {
    clearStaleTimer()
    sample.value = null
    status.value = nextStatus
  }

  function connect(instanceId: number) {
    disconnect()
    reconnectAttempt.value = 0
    activeInstanceId = instanceId
    const currentGeneration = ++generation
    let lastSampledAt = -Infinity
    status.value = 'connecting'
    historyLoading.value = true
    const request = new AbortController()
    historyRequest = request
    void getOwnInstanceMonitoringHistory(instanceId, request.signal).then((result) => {
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
      if (generation === currentGeneration) {
        historyRequest = null
        historyLoading.value = false
      }
    })

    function scheduleReconnect() {
      reconnectAttempt.value += 1
      if (reconnectAttempt.value > MAX_RECONNECT_ATTEMPTS) {
        clearSample('offline')
        return
      }
      clearSample('reconnecting')
      reconnectTimer = setTimeout(open, Math.min(1000 * 2 ** (reconnectAttempt.value - 1), 16000))
    }

    const open = () => {
      if (generation !== currentGeneration || activeInstanceId !== instanceId) return
      reconnectTimer = null
      const attempt = ++connectionAttempt
      const isCurrentAttempt = () => generation === currentGeneration && attempt === connectionAttempt
      void createInstanceMonitoringStreamTicket(instanceId).then(({ ticket }) => {
        if (!isCurrentAttempt()) return
        const eventSource = new EventSource(instanceMonitoringStreamUrl(instanceId, ticket), { withCredentials: true })
        source?.close()
        source = eventSource
        let receivedSample = false
        const isCurrentSource = () => isCurrentAttempt() && source === eventSource
        const scheduleExpiry = (delay: number) => {
          clearStaleTimer()
          staleTimer = setTimeout(() => {
            if (isCurrentSource()) clearSample('offline')
          }, delay)
        }
        eventSource.onopen = () => {
          if (!isCurrentSource() || sample.value) return
          scheduleExpiry(MONITORING_FRESHNESS_MS)
        }
        eventSource.onmessage = (event) => {
          if (!isCurrentSource()) return
          try {
            const payload = JSON.parse(event.data) as InstanceMonitoringSample | { type: string; sample?: InstanceMonitoringSample; online?: boolean } | null
            if (!payload || typeof payload !== 'object') return
            if (payload.online === false || ('type' in payload && payload.type === 'offline')) {
              clearSample('offline')
              return
            }
            const next: InstanceMonitoringSample | undefined = 'sampledAt' in payload
              ? payload
              : payload.sample
            if (next?.online === false) {
              clearSample('offline')
              return
            }
            if (next?.online !== true || typeof next.sampledAt !== 'string') return
            const sampledAt = Date.parse(next.sampledAt)
            const age = Date.now() - sampledAt
            if (!Number.isFinite(sampledAt) || sampledAt < lastSampledAt || age < -MAX_SAMPLE_CLOCK_SKEW_MS) return
            if (sampledAt === lastSampledAt && receivedSample) return
            if (age >= MONITORING_FRESHNESS_MS) {
              clearSample('offline')
              return
            }
            if (!next.metrics || typeof next.metrics !== 'object' || Array.isArray(next.metrics) ||
                !Object.values(next.metrics).some(value => Number.isFinite(value))) return
            lastSampledAt = sampledAt
            receivedSample = true
            sample.value = next
            status.value = 'connected'
            reconnectAttempt.value = 0
            scheduleExpiry(MONITORING_FRESHNESS_MS - Math.max(0, age))
          } catch {
            clearSample('error')
          }
        }
        eventSource.onerror = () => {
          eventSource.close()
          if (!isCurrentSource()) return
          source = null
          scheduleReconnect()
        }
      }).catch(() => {
        if (isCurrentAttempt()) scheduleReconnect()
      })
    }
    open()
  }

  function disconnect() {
    generation += 1
    connectionAttempt += 1
    activeInstanceId = 0
    historyRequest?.abort()
    historyRequest = null
    historyLoading.value = false
    source?.close()
    source = null
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = null
    clearSample('offline')
    trend.value = null
    historyError.value = null
  }

  onBeforeUnmount(disconnect)

  return { sample, trend, status, reconnectAttempt, historyLoading, historyError, isOffline, connect, disconnect }
}
