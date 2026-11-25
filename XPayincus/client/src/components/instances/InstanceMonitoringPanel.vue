<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { instanceMetrics, type InstanceHistory, type InstanceMetric, type MonitoringCounterStats } from '@/api/agent-monitoring'

const { t, locale } = useI18n()

const props = defineProps<{
  trend: InstanceHistory | null
  historyLoading: boolean
  historyError: { message: string; code?: string | null; status?: number | null } | null
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
  { key: 'rxBytes', totalLabel: 'instance.monitoring.rxBytes', label: 'instance.monitoring.received' },
  { key: 'txBytes', totalLabel: 'instance.monitoring.txBytes', label: 'instance.monitoring.transmitted' }
] as const
const bucketRows = computed(() => props.trend?.buckets ?? [])
const numberFormat = computed(() => new Intl.NumberFormat(locale.value, { maximumFractionDigits: 2 }))
const timeFormat = computed(() => new Intl.DateTimeFormat(locale.value, { dateStyle: 'short', timeStyle: 'short' }))
const byteUnits = ['B', 'KB', 'MB', 'GB', 'TB']

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

function formatCoverage(counter: MonitoringCounterStats | undefined): string {
  return counter ? `${Math.round(counter.coverage * 100)}%` : '—'
}

function formatCounterDelta(counter: MonitoringCounterStats | undefined): string {
  return counter && counter.coverage > 0 ? formatBytes(counter.delta) : '—'
}

function formatCounterPartial(counter: MonitoringCounterStats | undefined): string {
  return counter ? t(counter.partial ? 'common.yes' : 'common.no') : '—'
}

const charts = computed(() => {
  const trend = props.trend
  if (!trend) return []
  const from = Date.parse(trend.from)
  const duration = Math.max(1, Date.parse(trend.to) - from)
  return instanceMetrics.map(key => {
    const points = bucketRows.value.flatMap(bucket => {
      const avg = bucket.metrics[key]?.avg
      if (typeof avg !== 'number' || !Number.isFinite(avg)) return []
      return [{ from: Date.parse(bucket.from), to: Date.parse(bucket.to), avg }]
    })
    const max = Math.max(0, ...points.map(point => point.avg))
    let previousEnd = -Infinity
    const path = points.map(point => {
      const x = 2 + ((point.from + point.to) / 2 - from) / duration * 296
      const y = 62 - point.avg / (max || 1) * 60
      const command = point.from > previousEnd ? `M${x} ${y}h0.01` : `L${x} ${y}`
      previousEnd = point.to
      return command
    }).join(' ')
    return { key, max, path }
  })
})
</script>

<template>
  <section class="card space-y-4 p-4 text-themed sm:p-5" :aria-label="t('instance.monitoring.historyTab')" :aria-busy="historyLoading">
    <h2 class="text-sm font-semibold">{{ trend ? t('instance.monitoring.history', { seconds: trend.resolutionSeconds }) : t('instance.monitoring.historyTab') }}</h2>
    <p v-if="historyLoading" role="status" class="text-sm text-themed-muted">{{ t('instance.monitoring.loading') }}</p>
    <p v-else-if="historyError" role="alert" class="text-sm text-red-600">
      {{ t('instance.monitoring.historyLoadFailed') }}<span v-if="historyError.code">（{{ historyError.code }}）</span>
    </p>
    <template v-else-if="trend">
      <div class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-themed-muted">
        <span>{{ timeFormat.format(new Date(trend.from)) }} – {{ timeFormat.format(new Date(trend.to)) }}</span>
        <span>{{ t('instance.monitoring.retentionDays') }} · {{ trend.retentionDays }}</span>
      </div>
      <p v-if="trend.incomplete || trend.capacityTruncated || trend.bucketsTruncated" class="text-xs text-amber-600" role="status">
        {{ t('instance.monitoring.incomplete') }}
        <span v-if="trend.capacityTruncated"> · {{ t('instance.monitoring.capacityTruncated') }}</span>
        <span v-if="trend.bucketsTruncated"> · {{ t('instance.monitoring.bucketsTruncated') }}</span>
      </p>
      <div v-if="bucketRows.length" class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <article v-for="chart in charts" :key="chart.key" class="min-w-0 space-y-2 rounded-xl border border-themed p-3">
          <h3 class="text-sm font-medium">{{ t(metricLabels[chart.key]) }}</h3>
          <p class="text-xs text-themed-muted">
            {{ t('instance.monitoring.average') }} · <span class="font-mono tabular-nums text-themed">{{ formatMetric(trend.summary[chart.key]?.avg, chart.key) }}</span>
          </p>
          <template v-if="chart.path">
            <div class="flex items-stretch gap-2" aria-hidden="true">
              <div class="flex shrink-0 flex-col justify-between text-xs text-themed-muted tabular-nums">
                <span>{{ formatMetric(chart.max, chart.key) }}</span>
                <span>{{ formatMetric(0, chart.key) }}</span>
              </div>
              <svg class="h-16 min-w-0 flex-1 border-b border-l border-themed" viewBox="0 0 300 64" preserveAspectRatio="none">
                <path :d="chart.path" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
              </svg>
            </div>
          </template>
          <p v-else class="text-xs text-themed-muted">{{ t('instance.monitoring.empty') }}</p>
        </article>
      </div>
      <p v-else class="text-sm text-themed-muted">{{ t('instance.monitoring.empty') }}</p>

      <div v-if="counters.some(counter => trend?.summaryCounters[counter.key])" class="grid gap-3 sm:grid-cols-2">
        <article v-for="counter in counters" :key="counter.key" class="min-w-0 space-y-2 rounded-xl border border-themed p-3">
          <h3 class="text-sm font-medium">{{ t(counter.totalLabel) }}</h3>
          <p class="font-mono text-sm tabular-nums">{{ formatCounterDelta(trend.summaryCounters[counter.key]) }}</p>
          <dl class="grid grid-cols-2 gap-2 text-xs">
            <div><dt class="text-themed-muted">{{ t('instance.monitoring.coverage') }}</dt><dd>{{ formatCoverage(trend.summaryCounters[counter.key]) }}</dd></div>
            <div><dt class="text-themed-muted">{{ t('instance.monitoring.resetCount') }}</dt><dd>{{ trend.summaryCounters[counter.key]?.resetCount ?? '—' }}</dd></div>
            <div><dt class="text-themed-muted">{{ t('instance.monitoring.partial') }}</dt><dd>{{ formatCounterPartial(trend.summaryCounters[counter.key]) }}</dd></div>
            <div><dt class="text-themed-muted">{{ t('instance.monitoring.count') }}</dt><dd>{{ trend.summaryCounters[counter.key]?.count ?? '—' }}</dd></div>
          </dl>
        </article>
      </div>

      <details v-if="bucketRows.length" class="border-t border-themed pt-3 text-xs">
        <summary class="cursor-pointer font-medium">{{ t('instance.monitoring.historySamples') }}</summary>
        <div class="mt-2 max-h-72 space-y-2 overflow-y-auto">
          <article v-for="bucket in bucketRows" :key="bucket.from" class="border-b border-themed py-2">
            <time :datetime="bucket.from" class="font-medium">{{ timeFormat.format(new Date(bucket.from)) }}</time>
            <dl class="mt-1 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
              <div v-for="metric in instanceMetrics" :key="metric">
                <dt class="text-themed-muted">{{ t(metricLabels[metric]) }}</dt>
                <dd class="font-mono tabular-nums">{{ formatMetric(bucket.metrics[metric]?.avg, metric) }}</dd>
              </div>
              <div v-for="counter in counters" :key="counter.key">
                <dt class="text-themed-muted">{{ t(counter.label) }}</dt>
                <dd class="font-mono tabular-nums">{{ formatCounterDelta(bucket.counters[counter.key]) }}</dd>
              </div>
            </dl>
          </article>
        </div>
      </details>
    </template>
    <p v-else class="text-sm text-themed-muted">{{ t('instance.monitoring.empty') }}</p>
  </section>
</template>
