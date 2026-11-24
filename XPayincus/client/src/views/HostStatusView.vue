<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import api from '@/api'
import FlagIcon from '@/components/FlagIcon.vue'

interface HostStatusPackage {
  id: number
  name: string
}

interface HostStatus {
  id: number
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
const countryFilter = ref('')
const packageFilter = ref('')
let refreshTimer: ReturnType<typeof setInterval> | undefined
let requestPending = false

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
  (!packageFilter.value || host.packages?.some(item => String(item.id) === packageFilter.value))
))

async function loadHosts(showLoading = true) {
  if (requestPending) return
  requestPending = true
  if (showLoading) loading.value = true
  try {
    const result = await api.hostStatus.list()
    hosts.value = result.hosts || []
    error.value = false
  } catch {
    error.value = true
  } finally {
    loading.value = false
    requestPending = false
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

function formatTime(value: string | null): string {
  return value ? new Date(value).toLocaleString(locale.value) : t('hostStatus.noValue')
}

onMounted(() => {
  void loadHosts()
  refreshTimer = setInterval(() => {
    if (document.visibilityState === 'visible') void loadHosts(false)
  }, 30_000)
})
onUnmounted(() => clearInterval(refreshTimer))
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
      </div>
    </header>

    <div v-if="loading" class="py-16 text-center text-sm text-themed-muted">{{ t('hostStatus.loading') }}</div>
    <div v-else-if="error" class="py-16 text-center">
      <p class="text-sm text-themed-muted">{{ t('hostStatus.loadFailed') }}</p>
      <button class="mt-3 rounded-md border border-themed px-3 py-2 text-sm text-themed hover:bg-themed-surface" @click="loadHosts()">{{ t('hostStatus.retry') }}</button>
    </div>
    <div v-else-if="!filteredHosts.length" class="py-16 text-center text-sm text-themed-muted">{{ t('hostStatus.empty') }}</div>
    <section v-else class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      <article v-for="host in filteredHosts" :key="host.id" class="rounded-lg border border-themed bg-themed-surface p-4">
        <div class="flex items-start justify-between gap-3 border-b border-themed pb-3">
          <div class="flex min-w-0 items-center gap-2">
            <FlagIcon v-if="host.countryCode" :code="host.countryCode" class="shrink-0" />
            <h2 class="truncate font-semibold text-themed">{{ t('hostStatus.hosts') }} #{{ host.id }}</h2>
          </div>
          <time class="shrink-0 text-right text-xs text-themed-muted">{{ t('hostStatus.sampledAt', { time: formatTime(host.sampledAt) }) }}</time>
        </div>
        <div class="mt-3 flex flex-wrap gap-1.5">
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
