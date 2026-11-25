<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { instanceMetrics, type InstanceHistory, type InstanceMetric, type MonitoringCounterStats } from '@/api/agent-monitoring'

const { t, locale } = useI18n()

const props = defineProps<{
  trend: InstanceHistory | null
  historyLoading: boolean
  historyError: { message: string; code?: string | null; status?: number | null } | null
  monitoringStatus: 'connecting' | 'connected' | 'reconnecting' | 'offline' | 'error'
  sampledAt?: string
}>()

const metricLabels: Record<InstanceMetric, string> = {
  cpuUsagePercent: 'instance.detail.info.cpu',
  memoryUsedBytes: 'instance.monitoring.memory',
  diskReadBytesPerSecond: 'instance.monitoring.diskRead',
  diskWriteBytesPerSecond: 'instance.monitoring.diskWrite',
  diskIOBytesPerSecond: 'instance.monitoring.diskIo',
  rxBytesPerSecond: 'instance.monitoring.rx',
  txBytesPerSecond: 'instance.monitoring.tx'
}
const counters = [
  { key: 'rxBytes', label: 'instance.monitoring.rxBytes' },
  { key: 'txBytes', label: 'instance.monitoring.txBytes' }
] as const
const numberFormat = computed(() => new Intl.NumberFormat(locale.value, { maximumFractionDigits: 2 }))
const timeFormat = computed(() => new Intl.DateTimeFormat(locale.value, { dateStyle: 'short', timeStyle: 'short' }))
const byteUnits = ['B', 'KB', 'MB', 'GB', 'TB']

const liveStatusLabels = {
  connecting: 'instance.monitoring.connecting',
  connected: 'instance.monitoring.historyFresh',
  reconnecting: 'instance.monitoring.reconnecting',
  offline: 'instance.monitoring.historyOffline',
  error: 'instance.monitoring.error'
} as const
const liveStatusClasses = {
  connecting: 'text-themed-muted',
  connected: 'text-emerald-600 dark:text-emerald-400',
  reconnecting: 'text-amber-600 dark:text-amber-400',
  offline: 'text-amber-600 dark:text-amber-400',
  error: 'text-red-600 dark:text-red-400'
} as const

function formatBytes(value: number | undefined, perSecond = false): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  let unit = 0
  while (value >= 1024 && unit < byteUnits.length - 1) {
    value /= 1024
    unit++
  }
  return `${numberFormat.value.format(value)} ${byteUnits[unit]}${perSecond ? '/s' : ''}`
}

function formatMetric(value: number | undefined, metric: InstanceMetric): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  if (metric === 'cpuUsagePercent') return `${numberFormat.value.format(value)}%`
  return formatBytes(value, metric !== 'memoryUsedBytes')
}

function formatCounterDelta(counter: MonitoringCounterStats | undefined): string {
  return counter && counter.coverage > 0 ? formatBytes(counter.delta) : '—'
}

const charts = computed(() => {
  const trend = props.trend
  if (!trend) return []
  const from = Date.parse(trend.from)
  const duration = Math.max(1, Date.parse(trend.to) - from)
  return instanceMetrics.flatMap(key => {
    const points = trend.buckets.flatMap(bucket => {
      const avg = bucket.metrics[key]?.avg
      if (typeof avg !== 'number' || !Number.isFinite(avg)) return []
      return [{ from: Date.parse(bucket.from), to: Date.parse(bucket.to), avg }]
    })
    if (!points.length) return []
    const max = Math.max(0, ...points.map(point => point.avg))
    const scaleMax = key === 'cpuUsagePercent' ? Math.max(100, max) : max || 1
    let previousEnd = -Infinity
    const path = points.map(point => {
      const x = 2 + ((point.from + point.to) / 2 - from) / duration * 296
      const y = 62 - point.avg / scaleMax * 60
      const command = point.from > previousEnd ? `M${x} ${y}h0.01` : `L${x} ${y}`
      previousEnd = point.to
      return command
    }).join(' ')
    return [{ key, scaleMax, path }]
  })
})
</script>

<template>
  <section class="card space-y-4 p-4 text-themed sm:p-5" :aria-label="t('instance.monitoring.historyTab')">
    <header class="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
      <h2 class="text-sm font-semibold">{{ t('instance.monitoring.historyReference') }}</h2>
      <p class="flex flex-wrap items-center gap-x-2 text-xs">
        <span class="inline-flex items-center gap-1.5 font-medium" :class="liveStatusClasses[monitoringStatus]" role="status">
          <span class="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
          {{ t(liveStatusLabels[monitoringStatus]) }}
        </span>
        <time v-if="monitoringStatus === 'connected' && sampledAt" :datetime="sampledAt" class="text-themed-muted tabular-nums">
          {{ timeFormat.format(new Date(sampledAt)) }}
        </time>
      </p>
    </header>

    <div :aria-busy="historyLoading" class="space-y-3">
      <p v-if="historyLoading" role="status" class="text-sm text-themed-muted">{{ t('instance.monitoring.loading') }}</p>
      <p v-else-if="historyError" role="alert" class="text-sm text-red-600 dark:text-red-400">
        {{ t('instance.monitoring.historyLoadFailed') }}<span v-if="historyError.code">（{{ historyError.code }}）</span>
      </p>
      <template v-else-if="trend">
        <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-themed-muted">
          <p class="tabular-nums">
            <time :datetime="trend.from">{{ timeFormat.format(new Date(trend.from)) }}</time>
            –
            <time :datetime="trend.to">{{ timeFormat.format(new Date(trend.to)) }}</time>
          </p>
          <p v-if="trend.incomplete || trend.capacityTruncated || trend.bucketsTruncated" class="text-amber-600 dark:text-amber-400">
            {{ t('instance.monitoring.incomplete') }}
          </p>
        </div>

        <div v-if="charts.length" class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <figure v-for="chart in charts" :key="chart.key" class="min-w-0 space-y-2 rounded-xl border border-themed p-3">
            <figcaption class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <span class="text-sm font-medium">{{ t(metricLabels[chart.key]) }}</span>
              <span class="text-xs text-themed-muted tabular-nums">
                {{ t('instance.monitoring.average') }} {{ formatMetric(trend.summary[chart.key]?.avg, chart.key) }}
              </span>
            </figcaption>
            <div class="flex items-stretch gap-2" aria-hidden="true">
              <div class="flex shrink-0 flex-col justify-between text-xs text-themed-muted tabular-nums">
                <span>{{ formatMetric(chart.scaleMax, chart.key) }}</span>
                <span>{{ formatMetric(0, chart.key) }}</span>
              </div>
              <svg class="h-20 min-w-0 flex-1 border-b border-l border-themed" viewBox="0 0 300 64" preserveAspectRatio="none">
                <path :d="chart.path" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
              </svg>
            </div>
          </figure>
        </div>
        <p v-else class="text-sm text-themed-muted">{{ t('instance.monitoring.empty') }}</p>

        <dl v-if="counters.some(counter => trend?.summaryCounters[counter.key])" class="flex flex-wrap gap-x-5 gap-y-1 text-xs">
          <div v-for="counter in counters" :key="counter.key" class="flex items-baseline gap-2">
            <dt class="text-themed-muted">{{ t(counter.label) }}</dt>
            <dd class="tabular-nums">{{ formatCounterDelta(trend.summaryCounters[counter.key]) }}</dd>
          </div>
        </dl>
      </template>
      <p v-else class="text-sm text-themed-muted">{{ t('instance.monitoring.empty') }}</p>
    </div>
  </section>
</template>
