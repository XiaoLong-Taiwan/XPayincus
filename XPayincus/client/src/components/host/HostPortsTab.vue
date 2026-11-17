<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import adminApi from '@/api/admin'
import api from '@/api'
import { useToast } from '@/stores/toast'
import { instanceDetailPath } from '@/utils/app-paths'
import { translateError } from '@/utils/errorHandler'

const props = defineProps<{ hostId: number }>()
const { t } = useI18n()
const router = useRouter()
const toast = useToast()
type PortList = Awaited<ReturnType<typeof adminApi.hosts.getPorts>>
const data = ref<PortList | null>(null)
const loading = ref(false)
const removingId = ref<number | null>(null)

async function load() {
  loading.value = true
  try {
    data.value = await adminApi.hosts.getPorts(props.hostId)
  } catch (error) {
    toast.error(translateError(error))
  } finally {
    loading.value = false
  }
}

async function removeMapping(mapping: PortList['mappings'][number]) {
  if (!window.confirm(t('admin.hosts.removePortConfirm', { port: mapping.publicPort, protocol: mapping.protocol.toUpperCase() }))) return
  removingId.value = mapping.id
  try {
    await api.instances.deletePort(mapping.instanceId, mapping.id)
    toast.success(t('admin.hosts.removePortSuccess'))
    await load()
  } catch (error) {
    toast.error(translateError(error))
  } finally {
    removingId.value = null
  }
}

function addressFamilyLabel(families: PortList['mappings'][number]['addressFamilies']): string {
  return families.map(family => family === 'ipv4' ? 'IPv4' : family === 'ipv6' ? 'IPv6' : t('admin.hosts.portAddressUnknown')).join(' / ')
}

onMounted(load)
watch(() => props.hostId, load)
</script>

<template>
  <section class="space-y-4">
    <div class="flex flex-wrap items-start justify-between gap-3 border-b border-themed pb-4">
      <div>
        <h2 class="text-lg font-semibold text-themed">{{ t('admin.hosts.portMappings') }}</h2>
        <p class="mt-1 text-sm text-themed-muted">{{ t('admin.hosts.portCoverageNotice') }}</p>
      </div>
      <button class="btn-secondary btn-sm" :disabled="loading" @click="load">{{ t('common.refresh') }}</button>
    </div>
    <div v-if="data?.completeness === 'partial'" class="border-l-2 border-amber-500 pl-3 text-sm text-themed-muted">
      {{ t('admin.hosts.portReadPartial', { count: data.readFailures }) }}
    </div>
    <div v-if="loading" class="py-8 text-center text-themed-muted">{{ t('common.loading') }}</div>
    <div v-else-if="!data?.mappings.length" class="py-8 text-center text-themed-muted">{{ t('admin.hosts.portMappingsEmpty') }}</div>
    <div v-else class="divide-y divide-themed">
      <article v-for="mapping in data.mappings" :key="mapping.id" class="grid grid-cols-1 items-center gap-3 py-4 md:grid-cols-[minmax(0,1fr)_auto_auto_auto]">
        <button class="min-w-0 text-left" @click="router.push({ path: instanceDetailPath(mapping.instanceId), query: { fromHost: String(props.hostId), tab: 'network', managePorts: '1' } })">
          <span class="block truncate font-medium text-themed">{{ mapping.instanceName }} <span class="font-normal text-themed-muted">#{{ mapping.instanceId }}</span></span>
          <span class="text-xs text-themed-muted">{{ mapping.instanceType === 'container' ? t('admin.hosts.container') : mapping.instanceType === 'virtual-machine' ? t('admin.hosts.virtualMachine') : t('admin.hosts.portAddressUnknown') }}</span>
        </button>
        <div class="font-mono text-sm text-themed">{{ mapping.protocol.toUpperCase() }} · {{ mapping.publicPort }} → {{ mapping.privatePort }}</div>
        <div class="text-sm text-themed-muted">{{ addressFamilyLabel(mapping.addressFamilies) }}</div>
        <div class="flex items-center justify-between gap-3 md:justify-end">
          <span class="text-xs text-themed-muted">{{ mapping.systemManaged ? t('admin.hosts.systemManagedPort') : t('admin.hosts.userManagedPort') }}</span>
          <button v-if="!mapping.systemManaged" class="btn-danger btn-sm" :disabled="removingId === mapping.id" @click="removeMapping(mapping)">{{ removingId === mapping.id ? t('common.processing') : t('common.delete') }}</button>
        </div>
      </article>
    </div>
  </section>
</template>
