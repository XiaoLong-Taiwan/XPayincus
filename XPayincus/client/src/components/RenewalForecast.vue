<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import api, { type RenewalForecast } from '@/api'
import { instanceDetailPath, walletPath } from '@/utils/app-paths'
const { t } = useI18n()
const days = ref<7 | 30>(7)
const forecast = ref<RenewalForecast | null>(null)
const loading = ref(false)
const error = ref('')
let sequence = 0
async function load() {
  const request = ++sequence
  loading.value = true
  error.value = ''
  forecast.value = null
  try { const result = await api.operations.renewalForecast(days.value); if (request === sequence) forecast.value = result }
  catch { if (request === sequence) error.value = t('operations.error') }
  finally { if (request === sequence) loading.value = false }
}
const money = (value: number) => `¥${Number(value).toFixed(2)}`
watch(days, load)
onMounted(load)
onUnmounted(() => { sequence++ })
</script>
<template>
  <section class="card p-4 space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-3"><h2 class="font-semibold">{{ t('operations.forecast') }}</h2><div class="flex flex-wrap gap-2"><select v-model="days" class="input w-auto" :aria-label="t('operations.forecast')"><option :value="7">{{ t('operations.days', { days: 7 }) }}</option><option :value="30">{{ t('operations.days', { days: 30 }) }}</option></select><button class="btn btn-secondary" :disabled="loading" @click="load">{{ t('operations.refresh') }}</button></div></div>
    <p class="text-sm text-themed-muted">{{ t('operations.forecastHint') }}</p>
    <p v-if="error" role="alert" class="text-red-500">{{ error }}</p>
    <template v-if="forecast">
      <dl class="grid grid-cols-2 gap-3 md:grid-cols-4"><div><dt>{{ t('operations.balance') }}</dt><dd>{{ money(forecast.balance) }}</dd></div><div><dt>{{ t('operations.total') }}</dt><dd>{{ money(forecast.total) }}</dd></div><div><dt>{{ t('operations.shortfall') }}</dt><dd>{{ money(forecast.shortfall) }}</dd></div><div><dt>{{ t('operations.firstShortfall') }}</dt><dd>{{ forecast.firstShortfallAt ? new Date(forecast.firstShortfallAt).toLocaleString() : '—' }}</dd></div></dl>
      <RouterLink v-if="forecast.shortfall > 0" :to="walletPath()" class="btn btn-secondary">{{ t('operations.recharge') }}</RouterLink>
      <div class="space-y-2 lg:hidden"><article v-for="item in forecast.items" :key="`${item.instanceId}:${item.dueAt}`" class="rounded-lg border border-themed p-3 break-words"><RouterLink class="underline" :to="instanceDetailPath(item.instanceId)">{{ item.name }}</RouterLink><p>{{ new Date(item.dueAt).toLocaleString() }} · {{ money(item.amount) }}</p><p>{{ t('operations.autoRenew') }}: {{ t(item.autoRenew ? 'common.yes' : 'common.no') }}</p></article></div>
      <div class="hidden overflow-hidden lg:block"><table class="w-full table-fixed text-sm"><thead><tr><th class="w-[35%] text-left p-2">{{ t('operations.instance') }}</th><th class="w-[30%] text-left p-2">{{ t('operations.due') }}</th><th class="w-[20%] text-left p-2">{{ t('operations.price') }}</th><th class="w-[15%] text-left p-2">{{ t('operations.autoRenew') }}</th></tr></thead><tbody><tr v-for="item in forecast.items" :key="`${item.instanceId}:${item.dueAt}`"><td class="p-2 break-words"><RouterLink class="underline" :to="instanceDetailPath(item.instanceId)">{{ item.name }}</RouterLink></td><td class="p-2 break-words">{{ new Date(item.dueAt).toLocaleString() }}</td><td class="p-2">{{ money(item.amount) }}</td><td class="p-2">{{ t(item.autoRenew ? 'common.yes' : 'common.no') }}</td></tr></tbody></table></div>
      <p v-if="!forecast.items.length">{{ t('operations.empty') }}</p>
    </template>
  </section>
</template>
