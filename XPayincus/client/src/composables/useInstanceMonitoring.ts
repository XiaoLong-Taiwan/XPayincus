import { computed, onBeforeUnmount, ref } from 'vue'
import { agentMonitoringApi, instanceMonitoringStreamUrl, type InstanceHistory, type InstanceMonitoringSample } from '@/api/agent-monitoring'
import { useAuthStore } from '@/stores/auth'

const MAX_TREND_POINTS = 100
const MAX_RECONNECT_ATTEMPTS = 5

export function useInstanceMonitoring() {
  const auth = useAuthStore()
  const sample = ref<InstanceMonitoringSample | null>(null)
  const trend = ref<InstanceHistory | null>(null)
  const status = ref<'connecting' | 'connected' | 'reconnecting' | 'offline' | 'error'>('connecting')
  const reconnectAttempt = ref(0)
  const historyLoading = ref(false)
  const historyError = ref(false)
  let source: EventSource | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let staleTimer: ReturnType<typeof setTimeout> | null = null
  let activeInstanceId = 0
  let generation = 0
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
    historyError.value = false
    void agentMonitoringApi.instanceHistory(
      hostId,
      { from: new Date(Date.now() - 7 * 86400000).toISOString(), to: new Date().toISOString(), resolutionSeconds: 3600, limit: 1000 },
      instanceName
    ).then((result) => {
      if (generation === currentGeneration) trend.value = result
    }).catch(() => {
      if (generation === currentGeneration) historyError.value = true
    }).finally(() => {
      if (generation === currentGeneration) historyLoading.value = false
    })

    const open = () => {
      if (generation !== currentGeneration || activeInstanceId !== instanceId) return
      const token = auth.token || localStorage.getItem('token')
      if (!token) {
        status.value = 'error'
        return
      }
      source = new EventSource(instanceMonitoringStreamUrl(instanceId, token), { withCredentials: true })
      source.onopen = () => {
        reconnectAttempt.value = 0
        status.value = 'connected'
        if (staleTimer) clearTimeout(staleTimer)
        staleTimer = setTimeout(() => {
          status.value = 'offline'
        }, 45000)
      }
      source.onmessage = (event) => {
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
          sample.value = next
          onSample?.(next)
          status.value = 'connected'
          points.push(next)
          if (points.length > MAX_TREND_POINTS) points = points.slice(-MAX_TREND_POINTS)
          if (staleTimer) clearTimeout(staleTimer)
          staleTimer = setTimeout(() => { status.value = 'offline' }, 45000)
        } catch {
          status.value = 'error'
        }
      }
      source.onerror = () => {
        source?.close()
        source = null
        reconnectAttempt.value += 1
        if (reconnectAttempt.value > MAX_RECONNECT_ATTEMPTS) {
          status.value = 'offline'
          return
        }
        status.value = 'reconnecting'
        reconnectTimer = setTimeout(open, Math.min(1000 * 2 ** (reconnectAttempt.value - 1), 16000))
      }
    }
    open()
  }

  function disconnect() {
    generation += 1
    activeInstanceId = 0
    source?.close()
    source = null
    clearTimers()
  }

  onBeforeUnmount(disconnect)

  return { sample, trend, status, reconnectAttempt, historyLoading, historyError, isOffline, connect, disconnect }
}
