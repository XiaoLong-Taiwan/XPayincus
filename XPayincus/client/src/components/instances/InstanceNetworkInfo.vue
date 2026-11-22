<script setup lang="ts">
import { computed } from 'vue'
import type { InstanceWithDetails } from '@/types/api'

const props = defineProps<{ instance: InstanceWithDetails }>()

const ipv4 = computed(() => {
  const value = props.instance.ipv4 ?? (props.instance as any).nat_public_ip ?? props.instance.natPublicIp ?? props.instance.host?.nat_public_ip
  return typeof value === 'string' && value ? value : null
})
const ipv6 = computed(() => {
  const value = props.instance.ipv6 ?? (props.instance as any).ipv6_address ?? null
  return typeof value === 'string' && value.includes(':') ? value : null
})
const sshPort = computed(() => {
  const mapping = props.instance.port_mappings?.find((item) => item.protocol === 'tcp' && (item.privatePort ?? item.private_port) === 22)
  return mapping?.publicPort ?? mapping?.public_port ?? props.instance.ssh_port ?? null
})
</script>

<template>
  <section class="card mt-4 p-4 text-themed" aria-label="Instance network information">
    <h2 class="text-sm font-semibold">網路資訊</h2>
    <dl class="mt-3 grid gap-3 sm:grid-cols-3">
      <div><dt class="text-xs text-themed-muted">IPv4</dt><dd class="mt-1 break-all font-mono text-sm">{{ ipv4 ?? '—' }}</dd></div>
      <div v-if="ipv6"><dt class="text-xs text-themed-muted">IPv6</dt><dd class="mt-1 break-all font-mono text-sm">{{ ipv6 }}</dd></div>
      <div v-if="sshPort"><dt class="text-xs text-themed-muted">SSH</dt><dd class="mt-1 font-mono text-sm">{{ ipv4 ?? '—' }}:{{ sshPort }}</dd></div>
    </dl>
  </section>
</template>
