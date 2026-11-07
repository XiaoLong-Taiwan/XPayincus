<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import api from '@/api'

const { t } = useI18n()
const targets = ref<Array<{ id: string; label: string; host: string; tcpPorts: number[]; icmp: boolean }>>([])
const selectedId = ref('')
const selectedPort = ref<number | null>(null)
const method = ref<'tcp' | 'icmp'>('tcp')
const loading = ref(false)
const error = ref('')
const result = ref<{ source: 'panel-api'; results: Array<{ label: string; host: string; method: 'tcp' | 'icmp'; port?: number; success: boolean; latencyMs: number | null; error?: string }> } | null>(null)

const selectedTarget = () => targets.value.find(target => target.id === selectedId.value)

onMounted(async () => {
  try {
    const response = await api.networkProbe.targets()
    targets.value = response.targets
    selectedId.value = targets.value[0]?.id || ''
    selectedPort.value = targets.value[0]?.tcpPorts[0] || null
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '載入公開測試目標失敗'
  }
})

async function runTest() {
  const target = selectedTarget()
  if (!target || (method.value === 'tcp' && selectedPort.value === null)) return
  loading.value = true
  error.value = ''
  result.value = null
  try {
    result.value = await api.networkProbe.test(target.id, method.value, method.value === 'tcp' ? selectedPort.value || undefined : undefined)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '網路測試失敗'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <main class="mx-auto max-w-3xl px-4 py-8 sm:px-6">
    <header class="border-b border-themed pb-5">
      <h1 class="text-2xl font-semibold text-themed">{{ t('networkTest.title') }}</h1>
      <p class="mt-2 text-sm text-themed-muted">{{ t('networkTest.description') }}</p>
    </header>
    <section class="mt-6 max-w-xl space-y-4">
      <label class="block space-y-1 text-sm text-themed-secondary">
        <span>{{ t('networkTest.target') }}</span>
        <select v-model="selectedId" class="input" @change="selectedPort = selectedTarget()?.tcpPorts[0] || null">
          <option v-for="target in targets" :key="target.id" :value="target.id">{{ target.label }} · {{ target.host }}</option>
        </select>
      </label>
      <div class="flex flex-wrap items-center gap-4">
        <label class="flex items-center gap-2 text-sm text-themed"><input v-model="method" type="radio" value="tcp" :disabled="!selectedTarget()?.tcpPorts.length" />TCP</label>
        <select v-if="method === 'tcp'" v-model.number="selectedPort" class="input w-auto">
          <option v-for="port in selectedTarget()?.tcpPorts || []" :key="port" :value="port">Port {{ port }}</option>
        </select>
        <label v-if="selectedTarget()?.icmp" class="flex items-center gap-2 text-sm text-themed"><input v-model="method" type="radio" value="icmp" />ICMP</label>
        <button type="button" class="btn-primary" :disabled="loading || !selectedTarget()" @click="runTest">{{ loading ? t('networkTest.testing') : t('networkTest.run') }}</button>
      </div>
      <p class="rounded border border-themed p-3 text-sm text-themed-muted">{{ t('networkTest.sourceWarning') }}</p>
      <p v-if="error" class="text-sm text-red-600">{{ error }}</p>
      <div v-if="result?.results[0]" class="border-t border-themed pt-4 text-sm text-themed">
        <p class="font-medium">{{ result.results[0].label }} ({{ result.results[0].host }})</p>
        <p>{{ result.results[0].method.toUpperCase() }}<span v-if="result.results[0].port">:{{ result.results[0].port }}</span> · {{ result.results[0].success ? t('networkTest.success') : result.results[0].error }}<span v-if="result.results[0].latencyMs !== null"> · {{ result.results[0].latencyMs }} ms</span></p>
      </div>
    </section>
  </main>
</template>
