<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { InstanceHistory, InstanceMonitoringSample } from '@/api/agent-monitoring'
import { formatMemory } from '@/utils/formatters'

const { t } = useI18n()

const props = defineProps<{
  sample: InstanceMonitoringSample | null
  trend: InstanceHistory | null
  status: 'connecting' | 'connected' | 'reconnecting' | 'offline' | 'error'
  historyLoading: boolean
  historyError: { message: string; code?: string | null; status?: number | null } | null
}>()

const statusLabel = computed(() => t(`instance.monitoring.${props.status}`))

const latest = computed(() => props.sample?.metrics ?? {})
const trendRows = computed(() => props.trend?.buckets.slice(-24) ?? [])
const trafficSummary = computed(() => ({
  rx: props.trend?.summaryCounters.rxBytes,
  tx: props.trend?.summaryCounters.txBytes
}))
const trafficCoverage = computed<number | null>(() => {
  const counters = [trafficSummary.value.rx, trafficSummary.value.tx].filter(Boolean)
  return counters.length ? Math.min(...counters.map(counter => counter!.coverage)) : null
})
const trafficPartial = computed(() => Boolean(
  props.trend?.incomplete ||
  trafficSummary.value.rx?.partial ||
  trafficSummary.value.tx?.partial
))
const trafficResetCount = computed(() => (
  (trafficSummary.value.rx?.resetCount ?? 0) + (trafficSummary.value.tx?.resetCount ?? 0)
))
const metrics = [
  { key: 'cpuUsagePercent', label: 'CPU', suffix: '%' },
  { key: 'memoryUsedBytes', label: t('instance.monitoring.memory'), suffix: '' },
  { key: 'diskIOBytesPerSecond', label: t('instance.monitoring.diskIo'), suffix: ' B/s' },
  { key: 'rxBytesPerSecond', label: t('instance.monitoring.rx'), suffix: ' B/s' },
  { key: 'txBytesPerSecond', label: t('instance.monitoring.tx'), suffix: ' B/s' }
]
const trendMetrics = metrics.filter(metric => metric.key !== 'rxBytesPerSecond' && metric.key !== 'txBytesPerSecond')

const integerFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 })

function format(value: number | undefined, metric: typeof metrics[number]): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  if (metric.key === 'memoryUsedBytes') return value === 0 ? '0 MB' : formatMemory(value / 1024 / 1024)
  return `${integerFormat.format(value)}${metric.suffix}`
}

function formatBytes(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—'
  if (value === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const unit = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1)
  return `${(value / 1024 ** unit).toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}
</script>

<template>
  <section class="card mt-4 space-y-4 p-4 text-themed" :aria-label="t('instance.monitoring.title')" :aria-busy="historyLoading">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h2 class="text-sm font-semibold">{{ t('instance.monitoring.title') }}</h2>
      <p class="text-xs" :class="status === 'connected' ? 'text-green-600' : status === 'offline' || status === 'error' ? 'text-red-600' : 'text-amber-600'" role="status" aria-live="polite">{{ statusLabel }}</p>
    </div>
    <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <div v-for="metric in metrics" :key="metric.key" class="border-l-2 border-themed pl-3">
        <p class="text-xs text-themed-muted">{{ metric.label }}</p>
        <p class="mt-1 break-words font-mono text-sm tabular-nums">{{ format(latest[metric.key], metric) }}</p>
      </div>
    </div>
    <p v-if="historyLoading" role="status" class="text-xs text-themed-muted">{{ t('instance.monitoring.loading') }}</p>
    <p v-else-if="historyError" role="alert" class="text-xs text-red-600">{{ historyError.message }}<span v-if="historyError.code">（{{ historyError.code }}）</span></p>
    <template v-else-if="trend">
      <h3 class="border-t border-themed pt-3 text-xs font-semibold">{{ t('instance.monitoring.history', { seconds: trend.resolutionSeconds }) }}</h3>
      <div class="grid grid-cols-2 gap-3 text-xs lg:grid-cols-4">
        <div class="border-l-2 border-themed pl-3">
          <p class="text-themed-muted">{{ t('instance.monitoring.rxBytes') }}</p>
          <p class="mt-1 font-mono tabular-nums">{{ formatBytes(trafficSummary.rx?.delta) }}</p>
        </div>
        <div class="border-l-2 border-themed pl-3">
          <p class="text-themed-muted">{{ t('instance.monitoring.txBytes') }}</p>
          <p class="mt-1 font-mono tabular-nums">{{ formatBytes(trafficSummary.tx?.delta) }}</p>
        </div>
        <div class="border-l-2 border-themed pl-3">
          <p class="text-themed-muted">{{ t('instance.monitoring.coverage') }}</p>
          <p class="mt-1 font-mono tabular-nums">{{ trafficCoverage === null ? '—' : `${Math.round(trafficCoverage * 100)}%` }}</p>
        </div>
        <div class="border-l-2 border-themed pl-3">
          <p class="text-themed-muted">{{ t('instance.monitoring.dataStatus') }}</p>
          <p class="mt-1 font-mono tabular-nums">{{ trafficPartial ? t('instance.monitoring.partial') : t('instance.monitoring.complete') }}<span v-if="trafficResetCount"> · {{ t('instance.monitoring.resetCount') }} {{ trafficResetCount }}</span></p>
        </div>
      </div>
      <p v-if="trafficPartial" class="text-xs text-amber-600" role="status">{{ t('instance.monitoring.incomplete') }}</p>
      <div class="max-h-56 space-y-2 overflow-y-auto">
        <article v-for="bucket in trendRows" :key="bucket.from" class="grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-b border-themed py-2 text-xs">
          <time class="text-themed-muted">{{ new Date(bucket.from).toLocaleString() }}</time>
          <div class="text-right font-mono tabular-nums">
            <p>{{ trendMetrics.map(metric => `${metric.label} ${format(bucket.metrics[metric.key]?.avg, metric)}`).join(' · ') }}</p>
            <p class="mt-1 text-themed-muted">{{ t('instance.monitoring.received') }} {{ formatBytes(bucket.counters.rxBytes?.delta) }} · {{ t('instance.monitoring.transmitted') }} {{ formatBytes(bucket.counters.txBytes?.delta) }}</p>
          </div>
        </article>
        <p v-if="!trendRows.length" class="text-xs text-themed-muted">{{ t('instance.monitoring.empty') }}</p>
      </div>
    </template>
  </section>
</template>
