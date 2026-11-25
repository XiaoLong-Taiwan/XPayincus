<script setup lang="ts">
import { computed, onActivated, onDeactivated, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import api from '@/api'
import FlagIcon from '@/components/FlagIcon.vue'

interface HostStatusPackage {
  id: number
  name: string
}

interface HostStatus {
  id: number
  displayName: string | null
  category: string | null
  source: 'realtime' | 'heartbeat' | null
  countryCode: string | null
  packages: HostStatusPackage[]
  sampledAt: string | null
  cpuPercent: number | null
  ramPercent: number | null
  diskPercent: number | null
  swapPercent: number | null
  rxBytesPerSecond: number | null
  txBytesPerSecond: number | null
}

const { t, locale } = useI18n()
const hosts = ref<HostStatus[]>([])
const loading = ref(true)
const error = ref(false)
const now = ref(Date.now())
const realtimeFreshnessMs = 15000
const countryFilter = ref('')
const packageFilter = ref('')
const categoryFilter = ref('')
let refreshTimer: ReturnType<typeof setTimeout> | undefined
let ageTimer: ReturnType<typeof setInterval> | undefined
const requestPending = ref(false)
let refreshRequested = false
let active = false

const sampleDotClass = {
  realtime: 'bg-green-500',
  heartbeat: 'bg-amber-500',
  stale: 'bg-amber-500',
  error: 'bg-rose-500',
  noSample: 'bg-gray-500'
}

const categories = computed(() => [...new Set(hosts.value.map(host => host.category).filter((category): category is string => Boolean(category)))].sort((a, b) => a.localeCompare(b, locale.value)))
const countries = computed(() => [...new Set(hosts.value.map(host => host.countryCode).filter((code): code is string => Boolean(code)))].sort())
const packages = computed(() => {
  const entries = new Map<number, string>()
  for (const host of hosts.value) {
    for (const item of host.packages || []) entries.set(item.id, item.name)
  }
  return [...entries].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, locale.value))
})
const filteredHosts = computed(() => hosts.value.filter(host =>
  (!countryFilter.value || host.countryCode === countryFilter.value) &&
  (!packageFilter.value || host.packages?.some(item => String(item.id) === packageFilter.value)) &&
  (!categoryFilter.value || host.category === categoryFilter.value)
))
const relativeTime = computed(() => new Intl.RelativeTimeFormat(locale.value))
const hostCards = computed(() => filteredHosts.value.map(host => {
  const timestamp = host.sampledAt ? Date.parse(host.sampledAt) : NaN
  const hasSample = Number.isFinite(timestamp)
  const ageMs = hasSample ? Math.max(0, now.value - timestamp) : 0
  const seconds = Math.floor(ageMs / 1000)
  const status: keyof typeof sampleDotClass = error.value ? 'error' : getSampleStatus(host.source, hasSample, ageMs)
  return {
    host,
    status,
    sampledAt: hasSample ? new Date(timestamp).toLocaleString(locale.value) : t('hostStatus.noValue'),
    age: hasSample ? formatSampleAge(seconds) : null
  }
}))

function getSampleStatus(source: HostStatus['source'], hasSample: boolean, ageMs: number) {
  if (!hasSample || !source) return 'noSample'
  if (source === 'heartbeat') return 'heartbeat'
  return ageMs > realtimeFreshnessMs ? 'stale' : 'realtime'
}

function formatSampleAge(seconds: number): string {
  const formatter = relativeTime.value
  if (seconds >= 86400) return formatter.format(-Math.floor(seconds / 86400), 'day')
  if (seconds >= 3600) return formatter.format(-Math.floor(seconds / 3600), 'hour')
  if (seconds >= 60) return formatter.format(-Math.floor(seconds / 60), 'minute')
  return formatter.format(-seconds, 'second')
}

function scheduleRefresh() {
  clearTimeout(refreshTimer)
  if (active && document.visibilityState === 'visible') {
    refreshTimer = setTimeout(() => void loadHosts(false), 3000)
  }
}

async function loadHosts(showLoading = false) {
  if (!active || document.visibilityState !== 'visible') return
  if (requestPending.value) {
    refreshRequested = true
    return
  }
  clearTimeout(refreshTimer)
  requestPending.value = true
  if (showLoading) loading.value = true
  try {
    const result = await api.hostStatus.list()
    if (!active) return
    hosts.value = result.hosts || []
    error.value = false
  } catch {
    if (active) error.value = true
  } finally {
    const refreshAgain = refreshRequested
    refreshRequested = false
    requestPending.value = false
    if (active) {
      now.value = Date.now()
      loading.value = false
      if (refreshAgain && document.visibilityState === 'visible') void loadHosts(false)
      else scheduleRefresh()
    }
  }
}

function formatPercent(value: number | null): string {
  return value === null || value === undefined ? t('hostStatus.noValue') : `${value.toFixed(1)}%`
}

function formatRate(value: number | null): string {
  if (value === null || value === undefined) return t('hostStatus.noValue')
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s', 'TB/s']
  let rate = value
  let unit = 0
  while (rate >= 1000 && unit < units.length - 1) {
    rate /= 1000
    unit++
  }
  return `${rate.toLocaleString(locale.value, { maximumFractionDigits: 1 })} ${units[unit]}`
}

function startSampleClock() {
  now.value = Date.now()
  ageTimer = setInterval(() => { now.value = Date.now() }, 1000)
}

function handleVisibilityChange() {
  clearTimeout(refreshTimer)
  clearInterval(ageTimer)
  if (document.visibilityState === 'visible') {
    startSampleClock()
    void loadHosts(false)
  }
}

function activate() {
  if (active) return
  active = true
  document.addEventListener('visibilitychange', handleVisibilityChange)
  handleVisibilityChange()
}

function deactivate() {
  active = false
  refreshRequested = false
  clearTimeout(refreshTimer)
  clearInterval(ageTimer)
  document.removeEventListener('visibilitychange', handleVisibilityChange)
}

onMounted(activate)
onActivated(activate)
onDeactivated(deactivate)
onUnmounted(deactivate)
</script>

<template>
  <div class="mx-auto max-w-7xl space-y-6 p-4 sm:p-6">
    <header class="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 class="text-2xl font-semibold text-themed">{{ t('hostStatus.title') }}</h1>
        <p class="mt-1 text-sm text-themed-muted">{{ t('hostStatus.description') }}</p>
      </div>
      <div class="flex flex-wrap gap-3">
        <label class="grid gap-1 text-xs text-themed-muted">
          {{ t('hostStatus.country') }}
          <select v-model="countryFilter" class="min-w-40 rounded-md border-themed bg-themed-surface px-3 py-2 text-sm text-themed">
            <option value="">{{ t('hostStatus.allCountries') }}</option>
            <option v-for="country in countries" :key="country" :value="country">{{ country }}</option>
          </select>
        </label>
        <label class="grid gap-1 text-xs text-themed-muted">
          {{ t('hostStatus.package') }}
          <select v-model="packageFilter" class="min-w-44 rounded-md border-themed bg-themed-surface px-3 py-2 text-sm text-themed">
            <option value="">{{ t('hostStatus.allPackages') }}</option>
            <option v-for="item in packages" :key="item.id" :value="String(item.id)">{{ item.name }}</option>
          </select>
        </label>
        <label class="grid gap-1 text-xs text-themed-muted">
          {{ t('hostStatus.category') }}
          <select v-model="categoryFilter" class="min-w-40 rounded-md border-themed bg-themed-surface px-3 py-2 text-sm text-themed">
            <option value="">{{ t('hostStatus.allCategories') }}</option>
            <option v-for="category in categories" :key="category" :value="category">{{ category }}</option>
          </select>
        </label>
        <button type="button" class="btn btn-secondary self-end" :disabled="requestPending" @click="loadHosts()">{{ t('common.refresh') }}</button>
      </div>
    </header>

    <p v-if="error && !loading && hosts.length" role="status" class="rounded-md border border-amber-500/40 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">{{ t('hostStatus.refreshFailed') }} <button class="underline" @click="loadHosts(false)">{{ t('hostStatus.retry') }}</button></p>
    <div v-if="loading" class="py-16 text-center text-sm text-themed-muted">{{ t('hostStatus.loading') }}</div>
    <div v-else-if="error && !hosts.length" class="py-16 text-center">
      <p class="text-sm text-themed-muted">{{ t('hostStatus.loadFailed') }}</p>
      <button class="mt-3 rounded-md border border-themed px-3 py-2 text-sm text-themed hover:bg-themed-surface" @click="loadHosts(true)">{{ t('hostStatus.retry') }}</button>
    </div>
    <div v-else-if="!hostCards.length" class="py-16 text-center text-sm text-themed-muted">{{ t('hostStatus.empty') }}</div>
    <section v-else class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      <article v-for="{ host, status, sampledAt, age } in hostCards" :key="host.id" class="rounded-lg border border-themed bg-themed-surface p-4">
        <div class="flex items-start justify-between gap-3 border-b border-themed pb-3">
          <div class="flex min-w-0 items-center gap-2">
            <FlagIcon v-if="host.countryCode" :code="host.countryCode" class="shrink-0" />
            <div class="min-w-0">
              <h2 class="truncate font-semibold text-themed">{{ host.displayName || t('hostStatus.hostId', { id: host.id }) }}</h2>
              <p v-if="host.displayName" class="text-xs text-themed-muted">{{ t('hostStatus.hostId', { id: host.id }) }}</p>
            </div>
          </div>
          <span class="inline-flex shrink-0 items-center gap-1.5 text-xs text-themed-muted">
            <span aria-hidden="true" class="h-2 w-2 shrink-0 rounded-full" :class="sampleDotClass[status]" />
            {{ t(`hostStatus.${status}`) }}
          </span>
        </div>
        <p class="mt-2 text-xs text-themed-muted">
          {{ t('hostStatus.sampledAt', { time: sampledAt }) }}<span v-if="age"> · {{ age }}</span>
        </p>
        <div class="mt-3 flex flex-wrap gap-1.5">
          <span v-if="host.category" class="rounded border border-themed px-2 py-1 text-xs text-themed">{{ host.category }}</span>
          <span v-for="item in host.packages" :key="item.id" class="rounded border border-themed px-2 py-1 text-xs text-themed-muted">{{ item.name }}</span>
        </div>
        <dl class="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
          <div><dt class="text-xs text-themed-muted">{{ t('hostStatus.cpu') }}</dt><dd class="mt-1 font-medium tabular-nums text-themed">{{ formatPercent(host.cpuPercent) }}</dd></div>
          <div><dt class="text-xs text-themed-muted">{{ t('hostStatus.ram') }}</dt><dd class="mt-1 font-medium tabular-nums text-themed">{{ formatPercent(host.ramPercent) }}</dd></div>
          <div><dt class="text-xs text-themed-muted">{{ t('hostStatus.disk') }}</dt><dd class="mt-1 font-medium tabular-nums text-themed">{{ formatPercent(host.diskPercent) }}</dd></div>
          <div><dt class="text-xs text-themed-muted">{{ t('hostStatus.swap') }}</dt><dd class="mt-1 font-medium tabular-nums text-themed">{{ formatPercent(host.swapPercent) }}</dd></div>
        </dl>
        <div class="mt-4 border-t border-themed pt-3">
          <h3 class="text-xs font-medium text-themed-muted">{{ t('hostStatus.network') }}</h3>
          <dl class="mt-2 grid grid-cols-2 gap-3 text-sm">
            <div><dt class="text-xs text-themed-muted">{{ t('hostStatus.receive') }}</dt><dd class="mt-1 font-medium tabular-nums text-themed">{{ formatRate(host.rxBytesPerSecond) }}</dd></div>
            <div><dt class="text-xs text-themed-muted">{{ t('hostStatus.transmit') }}</dt><dd class="mt-1 font-medium tabular-nums text-themed">{{ formatRate(host.txBytesPerSecond) }}</dd></div>
          </dl>
        </div>
      </article>
    </section>
  </div>
</template>
