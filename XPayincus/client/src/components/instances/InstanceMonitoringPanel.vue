<script setup lang="ts">
import { computed } from 'vue'
import type { InstanceHistory, InstanceMonitoringSample } from '@/api/agent-monitoring'

const props = defineProps<{
  sample: InstanceMonitoringSample | null
  trend: InstanceHistory | null
  status: 'connecting' | 'connected' | 'reconnecting' | 'offline' | 'error'
  historyLoading: boolean
  historyError: boolean
}>()

const statusLabel = computed(() => ({
  connecting: '連線中', connected: '即時監控', reconnecting: '重新連線中', offline: 'Agent 離線', error: '監控連線失敗'
})[props.status])

const latest = computed(() => props.sample?.metrics ?? {})
const trendRows = computed(() => props.trend?.buckets.slice(-24) ?? [])
const metrics = [
  { key: 'cpuUsagePercent', label: 'CPU', suffix: '%' },
  { key: 'memoryUsedBytes', label: '記憶體', suffix: ' B' },
  { key: 'rxBytesPerSecond', label: '網路接收', suffix: ' B/s' },
  { key: 'txBytesPerSecond', label: '網路傳送', suffix: ' B/s' }
]

function format(value: number | undefined, suffix: string): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value)}${suffix}` : '—'
}
</script>

<template>
  <section class="card mt-4 space-y-4 p-4 text-themed" aria-label="Instance monitoring" :aria-busy="historyLoading">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h2 class="text-sm font-semibold">即時監控</h2>
      <p class="text-xs" :class="status === 'connected' ? 'text-green-600' : status === 'offline' || status === 'error' ? 'text-red-600' : 'text-amber-600'" role="status" aria-live="polite">{{ statusLabel }}</p>
    </div>
    <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <div v-for="metric in metrics" :key="metric.key" class="border-l-2 border-themed pl-3">
        <p class="text-xs text-themed-muted">{{ metric.label }}</p>
        <p class="mt-1 break-words font-mono text-sm tabular-nums">{{ format(latest[metric.key], metric.suffix) }}</p>
      </div>
    </div>
    <p v-if="historyLoading" role="status" class="text-xs text-themed-muted">載入七日趨勢…</p>
    <p v-else-if="historyError" role="alert" class="text-xs text-red-600">七日趨勢載入失敗</p>
    <template v-else-if="trend">
      <h3 class="border-t border-themed pt-3 text-xs font-semibold">七日趨勢 · {{ trend.resolutionSeconds }} 秒解析度</h3>
      <div class="max-h-56 space-y-2 overflow-y-auto">
        <article v-for="bucket in trendRows" :key="bucket.from" class="grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-b border-themed py-2 text-xs">
          <time class="text-themed-muted">{{ new Date(bucket.from).toLocaleString() }}</time>
          <span class="font-mono tabular-nums">CPU {{ bucket.metrics.cpuUsagePercent?.avg?.toFixed(1) ?? '—' }}% · RAM {{ bucket.metrics.memoryUsedBytes?.avg?.toFixed(0) ?? '—' }} B</span>
        </article>
        <p v-if="!trendRows.length" class="text-xs text-themed-muted">尚無趨勢資料</p>
      </div>
    </template>
  </section>
</template>
