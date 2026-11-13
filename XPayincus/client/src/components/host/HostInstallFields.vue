<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from '@/stores/toast'
import type { HostInstallDetails } from '@/types/api'

defineProps<{ details: HostInstallDetails }>()

const { t } = useI18n()
const toast = useToast()
const fields = ['installCommand', 'panelUrl', 'installToken'] as const
type InstallField = typeof fields[number]
const copyStates = ref<Partial<Record<InstallField, 'copied' | 'error'>>>({})
const resetTimers = new Map<InstallField, ReturnType<typeof setTimeout>>()
let disposed = false

async function copyValue(field: InstallField, value: string) {
  clearTimeout(resetTimers.get(field))
  delete copyStates.value[field]
  try {
    await navigator.clipboard.writeText(value)
    if (disposed) return
    copyStates.value[field] = 'copied'
    toast.success(t('common.copied'))
  } catch {
    if (disposed) return
    copyStates.value[field] = 'error'
    toast.error(t('admin.hosts.installCopyFailed'))
  }
  resetTimers.set(field, setTimeout(() => {
    delete copyStates.value[field]
    resetTimers.delete(field)
  }, 2500))
}

onBeforeUnmount(() => {
  disposed = true
  resetTimers.forEach(timer => clearTimeout(timer))
})
</script>

<template>
  <div class="space-y-3">
    <p class="text-xs text-themed-muted">{{ t('admin.hosts.installSeparateInputsHint') }}</p>
    <div class="grid grid-cols-1 gap-3 lg:grid-cols-3">
      <div v-for="field in fields" :key="field" class="min-w-0 space-y-2 rounded-lg border border-themed bg-themed-secondary p-3">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span class="text-xs font-medium text-themed">{{ t(`admin.hosts.installField_${field}`) }}</span>
          <button type="button" class="btn-secondary btn-xs" :aria-label="t('admin.hosts.installCopyField', { field: t(`admin.hosts.installField_${field}`) })" @click="copyValue(field, details[field])"><span aria-live="polite">{{ copyStates[field] === 'copied' ? t('common.copied') : t('common.copy') }}</span></button>
        </div>
        <code class="block whitespace-pre-wrap break-all font-mono text-xs text-themed">{{ details[field] }}</code>
        <p v-if="copyStates[field] === 'error'" role="alert" class="text-xs text-red-600 dark:text-red-400">{{ t('admin.hosts.installCopyFailed') }}</p>
      </div>
    </div>
    <p v-if="details.installTokenExpiresAt" class="text-xs text-themed-muted">{{ t('admin.hosts.agentInstallTokenExpiresAt', { time: new Date(details.installTokenExpiresAt).toLocaleString() }) }}</p>
  </div>
</template>
