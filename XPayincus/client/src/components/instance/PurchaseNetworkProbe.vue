<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import api from '@/api'
import type { NetworkProbeTarget } from '@/types/network-probe'

const props = defineProps<{ packageId: number; hostId: number }>()
const targets = ref<NetworkProbeTarget[]>([])
const targetId = ref('')
const busy = ref(false)
const error = ref('')
const result = ref('')
const commands = ref('')
const copied = ref(false)
const target = computed(() => targets.value.find(item => item.id === targetId.value))
let disposed = false
let controller: AbortController | undefined

onBeforeUnmount(() => {
  disposed = true
  controller?.abort()
})

onMounted(async () => {
  try {
    const response = await api.networkProbe.targets(props.packageId, props.hostId)
    if (disposed) return
    targets.value = response.targets
    targetId.value = targets.value[0]?.id || ''
  } catch {
    if (!disposed) error.value = '無法載入此商品節點的核准測試目標'
  }
})

async function prepare(https: boolean) {
  if (!target.value || busy.value) return
  busy.value = true
  error.value = ''
  result.value = ''
  commands.value = ''
  copied.value = false
  try {
    const prepared = await api.networkProbe.prepare(props.packageId, props.hostId, target.value.id)
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
    try {
      const started = performance.now()
      const response = await fetch(`${prepared.httpsUrl}?nonce=${crypto.randomUUID()}`, { method: 'GET', mode: 'cors', credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal })
      const elapsed = performance.now() - started
      await response.body?.cancel()
      if (!response.ok) throw new Error('HTTPS 回應失敗')
      if (!disposed) result.value = `此瀏覽器 → ${prepared.target.label}：HTTPS 回應標頭耗時 ${elapsed.toFixed(1)} ms（非 TCP／ICMP 延遲）`
    } finally {
      window.clearTimeout(timeout)
    }
  } catch {
    if (!disposed) error.value = '測試無法完成：可能為未授權、限流、DNS、CORS、憑證、端點或逾時問題；不代表節點離線。'
  } finally {
    if (!disposed) busy.value = false
  }
}

async function copyCommands() {
  try {
    await navigator.clipboard.writeText(commands.value)
    copied.value = true
  } catch {
    error.value = '無法存取剪貼簿，請手動選取指令複製。'
  }
}
</script>

<template>
  <section v-if="targets.length || error" class="card space-y-3 p-5 text-sm text-themed">
    <h3 class="font-semibold">此商品節點網路測試</h3>
    <p class="text-themed-muted">瀏覽器 HTTPS 包含 DNS、TLS、HTTP 與服務處理時間，受連線重用、代理及快取影響，非 TCP／ICMP ping；若目標使用 CDN，結果只到 CDN。API 不代替客戶測量。</p>
    <label v-if="targets.length" class="block">核准目標
      <select v-model="targetId" class="input mt-1" :disabled="busy" @change="result = ''; commands = ''; copied = false">
        <option v-for="item in targets" :key="item.id" :value="item.id">{{ item.label }} · {{ item.host }}</option>
      </select>
    </label>
    <div class="flex flex-wrap gap-2">
      <button v-if="target?.https" type="button" class="btn-secondary" :disabled="busy" @click="prepare(true)">{{ busy ? '處理中…' : '從此瀏覽器測試 HTTPS' }}</button>
      <button v-if="target && (target.icmp || target.tcpPorts.length)" type="button" class="btn-secondary" :disabled="busy" @click="prepare(false)">產生本機 TCP／ICMP 指令</button>
    </div>
    <p v-if="result" role="status">{{ result }}</p>
    <p v-if="error" role="alert" class="text-red-600">{{ error }}</p>
    <div v-if="commands" class="space-y-2">
      <p class="text-themed-muted">請僅在本機或自己已授權的主機執行。指令固定使用此次核准的公開 IP；ping -c／nc 適用 Linux，ping -n／Test-NetConnection 適用 Windows PowerShell。TCP 指令只檢查連通性，不回報精確 RTT。平台不收集或驗證執行結果，尚未提供 Agent 遠端測量。</p>
      <pre class="whitespace-pre-wrap break-all rounded border border-themed p-3">{{ commands }}</pre>
      <button type="button" class="btn-secondary" @click="copyCommands">{{ copied ? '已複製' : '複製指令' }}</button>
    </div>
  </section>
</template>
