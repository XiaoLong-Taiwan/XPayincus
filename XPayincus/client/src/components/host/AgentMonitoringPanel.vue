<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { agentMonitoringApi, instanceMetrics, type ComponentEvents, type InstanceHistory, type InstanceMetric, type InstanceTop, type MonitoringCounterStats, type MonitoringHistory, type MonitoringQuery, type MonitoringStats } from '@/api/agent-monitoring'
import { agentMonitoringCopy, type MonitoringCopyKey } from './agent-monitoring-copy'

const props = defineProps<{ hostId: number }>()
const { locale } = useI18n()
const copy = computed(() => agentMonitoringCopy[locale.value as keyof typeof agentMonitoringCopy] ?? agentMonitoringCopy.en)
const windowSeconds = ref(86400)
const resolutionSeconds = ref(3600)
const metric = ref<InstanceMetric>('cpuUsagePercent')
const orderBy = ref<'avg' | 'max'>('avg')
const top = ref(10)
const hostMetric = ref('cpuUsagePercent')
const history = ref<MonitoringHistory | null>(null)
const ranking = ref<InstanceTop | null>(null)
const events = ref<ComponentEvents | null>(null)
const loading = ref(false)
const failed = ref(false)
const selectedInstance = ref('')
const instanceLoading = ref(false)
const instanceFailed = ref(false)
const instanceHistory = ref<InstanceHistory | null>(null)
const activeQuery = ref<MonitoringQuery | null>(null)
let controller: AbortController | null = null
let instanceController: AbortController | null = null
const statsKeys = ['min', 'max', 'avg', 'count', 'coverage'] as const
const counterKeys = ['first', 'last', 'delta', 'resetCount', 'count', 'coverage'] as const
const hostMetricKeys = computed(() => [...new Set([...Object.keys(history.value?.summary ?? {}), ...Object.keys(history.value?.summaryCounters ?? {})])].sort())
const selectedSummary = computed(() => history.value?.summary[hostMetric.value])
const selectedCounter = computed(() => history.value?.summaryCounters[hostMetric.value])
const instanceSummary = computed(() => instanceHistory.value?.summary[metric.value])

function label(key: string): string {
  if (key.startsWith('psi.')) return `${copy.value.psi} · ${key.split('.').slice(1).map(label).join(' · ')}`
  return copy.value[(key === 'error' ? 'errorField' : key) as MonitoringCopyKey] ?? key
}

function number(value: number): string {
  return value.toLocaleString(locale.value, { maximumFractionDigits: 2 })
}

function stat(stats: MonitoringStats, key: typeof statsKeys[number]): string {
  return key === 'coverage' ? `${number(stats.coverage * 100)}%` : number(stats[key])
}

function counterStat(stats: MonitoringCounterStats, key: typeof counterKeys[number]): string {
  if (key === 'delta' && stats.coverage === 0) return copy.value.counterUnavailable
  return key === 'coverage' ? `${number(stats.coverage * 100)}%` : number(stats[key])
}

function time(value: string): string {
  return new Date(value).toLocaleString(locale.value)
}

async function load() {
  controller?.abort()
  instanceController?.abort()
  const current = new AbortController()
  controller = current
  loading.value = true
  failed.value = false
  history.value = null
  ranking.value = null
  events.value = null
  activeQuery.value = null
  instanceHistory.value = null
  instanceLoading.value = false
  instanceFailed.value = false
  const to = Date.now() - 1000
  const query: MonitoringQuery = {
    from: new Date(to - windowSeconds.value * 1000 + (windowSeconds.value === 2592000 ? 60000 : 0)).toISOString(),
    to: new Date(to).toISOString(), resolutionSeconds: resolutionSeconds.value, limit: 1000
  }
  try {
    const [host, instances, changes] = await Promise.all([
      agentMonitoringApi.history(props.hostId, query, current.signal),
      agentMonitoringApi.top(props.hostId, query, metric.value, orderBy.value, top.value, current.signal),
      agentMonitoringApi.events(props.hostId, query, current.signal)
    ])
    if (current.signal.aborted) return
    history.value = host
    ranking.value = instances
    events.value = changes
    activeQuery.value = query
    if (!host.summary[hostMetric.value] && !host.summaryCounters[hostMetric.value]) hostMetric.value = hostMetricKeys.value[0] ?? 'cpuUsagePercent'
    if (selectedInstance.value) void loadInstanceHistory()
  } catch {
    if (!current.signal.aborted) failed.value = true
  } finally {
    if (!current.signal.aborted) loading.value = false
  }
}

async function loadInstanceHistory() {
  instanceController?.abort()
  instanceHistory.value = null
  instanceFailed.value = false
  instanceLoading.value = false
  if (!activeQuery.value || !selectedInstance.value) return
  const current = new AbortController()
  instanceController = current
  instanceLoading.value = true
  const query = { ...activeQuery.value }
  const name = selectedInstance.value
  const hostId = props.hostId
  try {
    const result = await agentMonitoringApi.instanceHistory(hostId, query, name, current.signal)
    if (!current.signal.aborted) instanceHistory.value = result
  } catch {
    if (!current.signal.aborted) instanceFailed.value = true
  } finally {
    if (!current.signal.aborted) instanceLoading.value = false
  }
}

function flatten(value: unknown, path = '', result = new Map<string, unknown>()): Map<string, unknown> {
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value)
    if (entries.length) {
      for (const [key, child] of entries) flatten(child, path ? `${path}.${key}` : key, result)
      return result
    }
  }
  result.set(path, value)
  return result
}

function valueLabel(value: unknown, present: boolean): string {
  if (!present) return copy.value.missing
  if (value === null) return copy.value.nullValue
  if (typeof value === 'boolean') return value ? copy.value.yes : copy.value.no
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

const eventRows = computed(() => {
  const snapshots = events.value?.events ?? []
  return snapshots.map((event, index) => {
    const before = index ? flatten(snapshots[index - 1]!.components) : new Map<string, unknown>()
    const after = flatten(event.components)
    const fields = [...new Set([...before.keys(), ...after.keys()])].sort()
    return {
      ...event, baseline: index === 0,
      changes: fields.filter(key => before.has(key) !== after.has(key) || JSON.stringify(before.get(key)) !== JSON.stringify(after.get(key))).map(key => ({
        key, name: key.split('.').map(label).join(' · '),
        before: valueLabel(before.get(key), before.has(key)), after: valueLabel(after.get(key), after.has(key))
      }))
    }
  }).reverse()
})

watch(() => props.hostId, () => { selectedInstance.value = ''; void load() }, { immediate: true })
watch([windowSeconds, resolutionSeconds, metric, orderBy, top], () => { void load() })
watch(selectedInstance, () => { void loadInstanceHistory() })
onBeforeUnmount(() => { controller?.abort(); instanceController?.abort() })
</script>

<template>
  <section class="card mt-4 space-y-5 p-5 text-themed" :aria-label="copy.title" :aria-busy="loading">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h2 class="text-sm font-semibold">{{ copy.title }}</h2>
      <button type="button" class="btn btn-secondary text-xs" :disabled="loading" @click="load">{{ copy.refresh }}</button>
    </div>
    <div class="grid gap-3 sm:grid-cols-2">
      <label class="space-y-1 text-xs">{{ copy.window }}
        <select v-model="windowSeconds" class="input w-full">
          <option :value="3600">{{ copy.hour }}</option><option :value="86400">{{ copy.day }}</option>
          <option :value="604800">{{ copy.week }}</option><option :value="2592000">{{ copy.month }}</option>
        </select>
      </label>
      <label class="space-y-1 text-xs">{{ copy.resolution }}
        <select v-model="resolutionSeconds" class="input w-full">
          <option :value="60">{{ copy.minute }}</option><option :value="300">{{ copy.fiveMinutes }}</option>
          <option :value="3600">{{ copy.oneHour }}</option><option :value="21600">{{ copy.sixHours }}</option>
        </select>
      </label>
    </div>
    <p class="text-xs text-themed-muted">{{ copy.coverageHint }}</p>
    <p v-if="loading" role="status" class="text-sm text-themed-muted">{{ copy.loading }}</p>
    <p v-if="failed" role="alert" class="text-sm text-red-600">{{ copy.error }}</p>
    <p v-if="history?.capacityTruncated || ranking?.capacityTruncated || events?.capacityTruncated || instanceHistory?.capacityTruncated" role="status" class="text-xs text-amber-600">{{ copy.capacity }}</p>
    <template v-if="history && ranking && events">
      <p class="text-xs text-themed-muted">{{ time(history.from) }} — {{ time(history.to) }}</p>
      <section class="space-y-3 border-t border-themed pt-4">
        <h3 class="text-sm font-semibold">{{ copy.host }} · {{ copy.psi }}</h3>
        <p class="text-xs text-themed-muted">{{ copy.psiHint }}</p>
        <p v-if="!hostMetricKeys.length" class="text-sm text-themed-muted">{{ copy.empty }}</p>
        <template v-else>
          <label class="block text-xs">{{ copy.metric }}
            <select v-model="hostMetric" class="input mt-1 w-full"><option v-for="key in hostMetricKeys" :key="key" :value="key">{{ label(key) }}</option></select>
          </label>
          <p v-if="selectedCounter" class="text-xs text-themed-muted">{{ copy.counterHint }}</p>
          <h4 class="text-xs font-semibold">{{ copy.summary }}</h4>
          <dl v-if="selectedCounter" class="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div v-for="key in counterKeys" :key="key"><dt class="text-xs text-themed-muted">{{ copy[key] }}</dt><dd class="break-words text-sm">{{ counterStat(selectedCounter, key) }}</dd></div>
          </dl>
          <dl v-if="selectedSummary" class="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <div v-for="key in statsKeys" :key="key"><dt class="text-xs text-themed-muted">{{ copy[key] }}</dt><dd class="break-words text-sm">{{ stat(selectedSummary, key) }}</dd></div>
          </dl>
          <p v-if="history.bucketsTruncated" class="text-xs text-amber-600">{{ copy.buckets }}</p>
          <div class="max-h-80 space-y-2 overflow-y-auto">
            <article v-for="bucket in history.buckets" :key="bucket.from" class="rounded border border-themed p-3">
              <p class="mb-2 text-xs text-themed-muted">{{ time(bucket.from) }} — {{ time(bucket.to) }}</p>
              <dl v-if="bucket.counters[hostMetric]" class="grid grid-cols-2 gap-2 sm:grid-cols-3">
                <div v-for="key in counterKeys" :key="key"><dt class="text-xs text-themed-muted">{{ copy[key] }}</dt><dd class="break-words text-xs">{{ counterStat(bucket.counters[hostMetric]!, key) }}</dd></div>
              </dl>
              <dl v-else-if="bucket.metrics[hostMetric]" class="grid grid-cols-2 gap-2 sm:grid-cols-5">
                <div v-for="key in statsKeys" :key="key"><dt class="text-xs text-themed-muted">{{ copy[key] }}</dt><dd class="break-words text-xs">{{ stat(bucket.metrics[hostMetric]!, key) }}</dd></div>
              </dl>
              <p v-else class="text-xs text-themed-muted">{{ copy.empty }}</p>
            </article>
          </div>
        </template>
      </section>
      <section class="space-y-3 border-t border-themed pt-4">
        <h3 class="text-sm font-semibold">{{ copy.topTitle }}</h3>
        <div class="grid gap-3 sm:grid-cols-3">
          <label class="text-xs">{{ copy.metric }}<select v-model="metric" class="input mt-1 w-full"><option v-for="key in instanceMetrics" :key="key" :value="key">{{ label(key) }}</option></select></label>
          <label class="text-xs">{{ copy.order }}<select v-model="orderBy" class="input mt-1 w-full"><option value="avg">{{ copy.avg }}</option><option value="max">{{ copy.max }}</option></select></label>
          <label class="text-xs">{{ copy.top }}<select v-model="top" class="input mt-1 w-full"><option v-for="count in [5, 10, 20, 50, 100]" :key="count" :value="count">{{ count }}</option></select></label>
        </div>
        <p v-if="!ranking.items.length" class="text-sm text-themed-muted">{{ copy.empty }}</p>
        <div class="max-h-80 space-y-2 overflow-y-auto">
          <article v-for="(item, index) in ranking.items" :key="item.name" class="space-y-2 rounded border border-themed p-3">
            <button type="button" class="btn btn-secondary max-w-full break-all text-xs" :aria-pressed="selectedInstance === item.name" @click="selectedInstance = item.name">#{{ index + 1 }} · {{ item.name }} · {{ copy.select }}</button>
            <dl class="grid grid-cols-2 gap-2 sm:grid-cols-5"><div v-for="key in statsKeys" :key="key"><dt class="text-xs text-themed-muted">{{ copy[key] }}</dt><dd class="break-words text-xs">{{ stat(item, key) }}</dd></div></dl>
          </article>
        </div>
      </section>
      <section class="space-y-3 border-t border-themed pt-4" :aria-busy="instanceLoading">
        <h3 class="break-all text-sm font-semibold">{{ copy.instanceHistory }}<span v-if="selectedInstance"> · {{ selectedInstance }} · {{ label(metric) }}</span></h3>
        <p class="text-xs text-themed-muted">{{ copy.historyHint }}</p>
        <p v-if="!selectedInstance" class="text-sm text-themed-muted">{{ copy.choose }}</p>
        <p v-if="instanceLoading" role="status" class="text-sm text-themed-muted">{{ copy.loading }}</p>
        <p v-if="instanceFailed" role="alert" class="text-sm text-red-600">{{ copy.error }}</p>
        <template v-if="instanceHistory">
          <h4 class="text-xs font-semibold">{{ copy.summary }}</h4>
          <dl v-if="instanceSummary" class="grid grid-cols-2 gap-2 sm:grid-cols-5"><div v-for="key in statsKeys" :key="key"><dt class="text-xs text-themed-muted">{{ copy[key] }}</dt><dd class="break-words text-xs">{{ stat(instanceSummary, key) }}</dd></div></dl>
          <p v-else class="text-sm text-themed-muted">{{ copy.empty }}</p>
          <p v-if="instanceHistory.bucketsTruncated" class="text-xs text-amber-600">{{ copy.buckets }}</p>
        </template>
        <div class="max-h-80 space-y-2 overflow-y-auto">
          <article v-for="row in instanceHistory?.buckets ?? []" :key="row.from" class="rounded border border-themed p-3">
            <p class="mb-2 text-xs text-themed-muted">{{ time(row.from) }} — {{ time(row.to) }}</p>
            <dl v-if="row.metrics[metric]" class="grid grid-cols-2 gap-2 sm:grid-cols-5"><div v-for="key in statsKeys" :key="key"><dt class="text-xs text-themed-muted">{{ copy[key] }}</dt><dd class="break-words text-xs">{{ stat(row.metrics[metric]!, key) }}</dd></div></dl>
            <p v-else class="text-xs text-themed-muted">{{ copy.empty }}</p>
          </article>
        </div>
      </section>
      <section class="space-y-3 border-t border-themed pt-4">
        <h3 class="text-sm font-semibold">{{ copy.events }}</h3>
        <p v-if="events.eventsTruncated" class="text-xs text-amber-600">{{ copy.eventsTruncated }}</p>
        <p v-if="!eventRows.length" class="text-sm text-themed-muted">{{ copy.empty }}</p>
        <div class="max-h-96 space-y-3 overflow-y-auto">
          <article v-for="event in eventRows" :key="event.id" class="space-y-2 rounded border border-themed p-3">
            <p class="text-xs font-semibold">{{ time(event.sampledAt) }}</p>
            <p v-if="event.baseline" class="text-xs text-themed-muted">{{ copy.baseline }}</p>
            <p v-if="!event.changes.length" class="text-xs text-themed-muted">{{ copy.unchanged }}</p>
            <div v-for="change in event.changes" :key="change.key" class="space-y-1 border-t border-themed pt-2 text-xs">
              <p class="break-all font-medium">{{ change.name }}</p>
              <p v-if="!event.baseline" class="whitespace-pre-wrap break-all text-themed-muted">{{ copy.before }}: {{ change.before }}</p>
              <p class="whitespace-pre-wrap break-all">{{ copy.after }}: {{ change.after }}</p>
            </div>
          </article>
        </div>
      </section>
    </template>
  </section>
</template>
