<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { networkProbeApi } from '@/api/network-probe'
import type { NetworkProbeRecord, NetworkProbeTarget } from '@/types/network-probe'
import { networkProbeCopy } from './network-probe-copy'
import { getLocale } from '@/locales'

const props = defineProps<{ packageId: number; hostId: number }>()
const targets = ref<NetworkProbeTarget[]>([])
const records = ref<NetworkProbeRecord[]>([])
const targetId = ref('')
const busy = ref(false)
const error = ref('')
const result = ref('')
const commands = ref('')
const copied = ref(false)
const manualMethod = ref<'icmp' | 'tcp'>('icmp')
const manualPort = ref<number | undefined>()
const manualDuration = ref<number | string>()
const manualSuccess = ref(false)
const acknowledgeLocal = ref(false)
const locale = getLocale()
const copy = locale.startsWith('zh-CN') ? networkProbeCopy['zh-CN'] : locale.startsWith('en') ? networkProbeCopy.en : networkProbeCopy['zh-TW']
const target = computed(() => targets.value.find(item => item.id === targetId.value))
const validManualDuration = computed(() => typeof manualDuration.value === 'number' && Number.isFinite(manualDuration.value) && manualDuration.value >= 0 && manualDuration.value <= 60000)
watch([target, manualMethod], ([currentTarget, method]) => {
  if (method === 'tcp' && currentTarget?.tcpPorts.length && !currentTarget.tcpPorts.includes(manualPort.value || 0)) manualPort.value = currentTarget.tcpPorts[0]
  if (method === 'icmp' && !currentTarget?.icmp && currentTarget?.tcpPorts.length) manualMethod.value = 'tcp'
  if (method === 'tcp' && !currentTarget?.tcpPorts.length && currentTarget?.icmp) manualMethod.value = 'icmp'
}, { immediate: true })
let disposed = false
let controller: AbortController | undefined

onBeforeUnmount(() => {
  disposed = true
  controller?.abort()
})

async function loadRecords() {
  const response = await networkProbeApi.records(props.packageId, props.hostId)
  if (!disposed) records.value = response.records
}

onMounted(async () => {
  try {
    const response = await networkProbeApi.targets(props.packageId, props.hostId)
    if (disposed) return
    targets.value = response.targets
    targetId.value = targets.value[0]?.id || ''
    await loadRecords()
  } catch {
    if (!disposed) error.value = copy.loadError
  }
})

async function saveRecord(input: Parameters<typeof networkProbeApi.save>[0]) {
  const response = await networkProbeApi.save(input)
  if (disposed) return
  records.value = [response.record, ...records.value].slice(0, 100)
}

async function prepare(https: boolean) {
  if (!target.value || busy.value) return
  busy.value = true
  error.value = ''
  result.value = ''
  commands.value = ''
  copied.value = false
  try {
    const prepared = await networkProbeApi.prepare(props.packageId, props.hostId, target.value.id)
    if (disposed) return
    const lines: string[] = []
    if (prepared.target.icmp) lines.push(`ping -c 4 ${prepared.address}`, `ping -n 4 ${prepared.address}`)
    for (const port of prepared.target.tcpPorts) {
      lines.push(`nc -vz -w 3 ${prepared.address} ${port}`, `Test-NetConnection -ComputerName '${prepared.address}' -Port ${port}`)
    }
    commands.value = lines.join('\n')
    if (!https || !prepared.httpsUrl) return
    controller = new AbortController()
    const timeout = window.setTimeout(() => controller?.abort(), 5000)
    const measuredAt = new Date().toISOString()
    const started = performance.now()
    let durationMs = 0
    let success = false
    try {
      const response = await fetch(`${prepared.httpsUrl}?nonce=${crypto.randomUUID()}`, { method: 'GET', mode: 'cors', credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal })
      durationMs = Math.round((performance.now() - started) * 10) / 10
      await response.body?.cancel()
      success = response.ok
      if (!success) throw new Error('HTTPS response failed')
      if (!disposed) result.value = copy.httpsResult.replace('{duration}', durationMs.toFixed(1))
    } catch {
      durationMs = Math.round((performance.now() - started) * 10) / 10
      if (!disposed) await saveRecord({ packageId: props.packageId, hostId: props.hostId, targetId: prepared.target.id, source: 'browser', method: 'https', measuredAt, samples: [{ durationMs, success: false }] })
      throw new Error('HTTPS measurement failed')
    } finally {
      window.clearTimeout(timeout)
    }
    if (!disposed) await saveRecord({ packageId: props.packageId, hostId: props.hostId, targetId: prepared.target.id, source: 'browser', method: 'https', measuredAt, samples: [{ durationMs, success }] })
  } catch {
    if (!disposed) error.value = copy.saveError
  } finally {
    if (!disposed) busy.value = false
  }
}

async function saveLocalRecord() {
  if (busy.value || !target.value || !acknowledgeLocal.value || !validManualDuration.value || typeof manualDuration.value !== 'number') return
  busy.value = true
  error.value = ''
  try {
    await saveRecord({
      packageId: props.packageId,
      hostId: props.hostId,
      targetId: target.value.id,
      source: 'manual-local',
      method: manualMethod.value,
      ...(manualMethod.value === 'tcp' ? { port: manualPort.value } : {}),
      measuredAt: new Date().toISOString(),
      samples: [{ durationMs: manualDuration.value, success: manualSuccess.value }],
      acknowledgedUnverified: true
    })
    acknowledgeLocal.value = false
  } catch {
    error.value = copy.localError
  } finally {
    if (!disposed) busy.value = false
  }
}

async function copyCommands() {
  try {
    await navigator.clipboard.writeText(commands.value)
    copied.value = true
  } catch {
    error.value = copy.clipboardError
  }
}
</script>

<template>
  <section v-if="targets.length || error" class="card space-y-3 p-5 text-sm text-themed">
    <h3 class="font-semibold">{{ copy.title }}</h3>
    <p class="text-themed-muted">{{ copy.notice }}</p>
    <label v-if="targets.length" class="block">{{ copy.target }}
      <select v-model="targetId" class="input mt-1" :disabled="busy" @change="result = ''; commands = ''; copied = false">
        <option v-for="item in targets" :key="item.id" :value="item.id">{{ item.label }} · {{ item.host }}</option>
      </select>
    </label>
    <div class="flex flex-wrap gap-2">
      <button v-if="target?.https" type="button" class="btn-secondary" :disabled="busy" @click="prepare(true)">{{ busy ? copy.loading : copy.https }}</button>
      <button v-if="target && (target.icmp || target.tcpPorts.length)" type="button" class="btn-secondary" :disabled="busy" @click="prepare(false)">{{ copy.commands }}</button>
    </div>
    <p v-if="result" role="status">{{ result }}</p>
    <p v-if="error" role="alert" class="text-red-600">{{ error }}</p>
    <div v-if="commands" class="space-y-2">
      <p class="text-themed-muted">{{ copy.commandNotice }}</p>
      <pre class="whitespace-pre-wrap break-all rounded border border-themed p-3">{{ commands }}</pre>
      <button type="button" class="btn-secondary" @click="copyCommands">{{ copied ? copy.copied : copy.copy }}</button>
    </div>
    <fieldset v-if="target && (target.icmp || target.tcpPorts.length)" class="space-y-2 border-t border-themed pt-3">
      <legend class="font-medium">{{ copy.localTitle }}</legend>
      <div class="flex flex-wrap gap-2">
        <select v-model="manualMethod" class="input" :disabled="busy">
          <option v-if="target.icmp" value="icmp">ICMP</option>
          <option v-if="target.tcpPorts.length" value="tcp">TCP</option>
        </select>
        <select v-if="manualMethod === 'tcp'" v-model.number="manualPort" class="input" :disabled="busy">
          <option v-for="port in target.tcpPorts" :key="port" :value="port">TCP {{ port }}</option>
        </select>
        <input v-model.number="manualDuration" class="input w-32" type="number" min="0" max="60000" step="0.1" :placeholder="copy.duration">
        <label><input v-model="manualSuccess" type="checkbox"> {{ copy.success }}</label>
      </div>
      <label class="block"><input v-model="acknowledgeLocal" type="checkbox"> {{ copy.acknowledge }}</label>
      <button type="button" class="btn-secondary" :disabled="busy || !acknowledgeLocal || !validManualDuration" @click="saveLocalRecord">{{ copy.save }}</button>
    </fieldset>
    <div class="space-y-2 border-t border-themed pt-3">
      <h4 class="font-medium">{{ copy.history }}</h4>
      <p v-if="records.length === 0" class="text-themed-muted">{{ copy.empty }}</p>
      <ul v-else class="space-y-2">
        <li v-for="record in records" :key="record.id" class="break-words">
          {{ new Date(record.measuredAt).toLocaleString() }} · {{ record.targetLabel }} · {{ record.method === 'https' ? copy.httpsMethod : record.method.toUpperCase() }} · {{ record.source === 'browser' ? copy.browser : copy.manual }} ·
          <span v-for="(sample, index) in record.samples" :key="index">{{ sample.success ? copy.succeeded : copy.failed }} {{ sample.durationMs }} ms<span v-if="index < record.samples.length - 1">；</span></span>
        </li>
      </ul>
    </div>
  </section>
</template>
