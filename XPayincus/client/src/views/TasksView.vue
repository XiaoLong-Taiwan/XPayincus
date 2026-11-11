<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import api, { type OperationTask } from '@/api'
import { instanceDetailPath } from '@/utils/app-paths'
const { t, te } = useI18n()
const items = ref<OperationTask[]>([])
const page = ref(1)
const total = ref(0)
const loading = ref(false)
const error = ref('')
const retrying = ref<number | null>(null)
const pages = computed(() => Math.max(1, Math.ceil(total.value / 20)))
let timer: ReturnType<typeof setInterval> | undefined
let sequence = 0
async function load() {
  const request = ++sequence
  loading.value = true
  error.value = ''
  try {
    const result = await api.operations.tasks({ page: page.value, pageSize: 20 })
    if (request !== sequence) return
    items.value = result.items
    total.value = result.total
    if (page.value > pages.value) page.value = pages.value
  } catch {
    if (request === sequence) error.value = t('operations.error')
  } finally {
    if (request === sequence) loading.value = false
  }
}
async function retryProvisioning(item: OperationTask) {
  if (!item.instanceId || !item.canRetry || retrying.value !== null || !window.confirm(t('operations.provisioningRetryConfirm'))) return
  retrying.value = item.instanceId
  try {
    await api.instances.retryProvisioning(item.instanceId)
    await load()
  } catch (cause: any) {
    error.value = cause?.message || t('operations.error')
  } finally {
    retrying.value = null
  }
}
function taskLabel(group: 'taskKinds' | 'taskStatuses', value: string) {
  const key = `operations.${group}.${value.toLowerCase()}`
  return te(key) ? t(key) : value
}
function progress(value: OperationTask['progress']) {
  if (value === null || value === '') return '—'
  return typeof value === 'number' && Number.isFinite(value)
    ? `${Math.min(100, Math.max(0, value))}%` : String(value)
}
watch(page, load)
onMounted(() => { void load(); timer = setInterval(() => { if (!document.hidden && !loading.value) void load() }, 5000) })
onUnmounted(() => { sequence++; if (timer) clearInterval(timer) })
</script>

<template>
  <div class="space-y-5">
    <header class="page-header"><div><h1 class="page-title">{{ t('operations.title') }}</h1><p class="page-description">{{ t('operations.description') }}</p></div><button class="btn btn-secondary" :disabled="loading" @click="load">{{ t('operations.refresh') }}</button></header>
    <p v-if="error" class="text-red-500" role="alert">{{ error }}</p>
    <p v-if="!loading && !items.length">{{ t('operations.empty') }}</p>
    <div class="space-y-3 lg:hidden">
      <article v-for="item in items" :key="item.id" class="card p-4 space-y-2 break-words">
        <h2 class="font-semibold">{{ item.name || item.id }}</h2><p>{{ taskLabel('taskKinds', item.kind) }} · {{ taskLabel('taskStatuses', item.status) }} · {{ progress(item.progress) }}</p>
        <p>{{ t('operations.updated') }}: {{ new Date(item.updatedAt).toLocaleString() }}</p><p v-if="item.error" class="text-red-500">{{ item.error }}</p>
        <RouterLink v-if="item.instanceId" :to="instanceDetailPath(item.instanceId)" class="btn btn-secondary">{{ t('operations.instance') }} #{{ item.instanceId }}</RouterLink>
        <button v-if="item.canRetry" class="btn btn-secondary" :disabled="retrying !== null" @click="retryProvisioning(item)">{{ t('operations.provisioningRetry') }}</button>
      </article>
    </div>
    <div class="hidden overflow-hidden rounded-xl border border-themed lg:block">
      <table class="w-full table-fixed text-sm"><thead><tr><th class="w-[26%] p-3 text-left">{{ t('operations.name') }}</th><th class="w-[18%] p-3 text-left">{{ t('operations.kind') }}</th><th class="w-[18%] p-3 text-left">{{ t('operations.status') }}</th><th class="w-[14%] p-3 text-left">{{ t('operations.progress') }}</th><th class="w-[24%] p-3 text-left">{{ t('operations.result') }}</th></tr></thead>
        <tbody><tr v-for="item in items" :key="item.id" class="border-t border-themed"><td class="p-3 break-words">{{ item.name || item.id }}<RouterLink v-if="item.instanceId" class="block underline" :to="instanceDetailPath(item.instanceId)">#{{ item.instanceId }}</RouterLink><time class="block text-xs text-themed-muted">{{ new Date(item.updatedAt).toLocaleString() }}</time></td><td class="p-3 break-words">{{ taskLabel('taskKinds', item.kind) }}</td><td class="p-3 break-words">{{ taskLabel('taskStatuses', item.status) }}</td><td class="p-3 break-words">{{ progress(item.progress) }}</td><td class="p-3 break-words">{{ item.error || '—' }}<button v-if="item.canRetry" class="btn btn-secondary mt-2" :disabled="retrying !== null" @click="retryProvisioning(item)">{{ t('operations.provisioningRetry') }}</button></td></tr></tbody>
      </table>
    </div>
    <div class="flex items-center justify-between gap-2"><button class="btn btn-secondary" :disabled="page <= 1 || loading" @click="page--">{{ t('operations.previous') }}</button><span>{{ page }} / {{ pages }} · {{ total }}</span><button class="btn btn-secondary" :disabled="page >= pages || loading" @click="page++">{{ t('operations.next') }}</button></div>
  </div>
</template>
