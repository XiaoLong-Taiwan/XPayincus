<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import api from '@/api/admin'
import SensitiveVerificationModal from '@/components/SensitiveVerificationModal.vue'
import { useToast } from '@/stores/toast'

type Backup = { id: string; createdAt: string; size: number; status: 'success' }
const toast = useToast()
const backups = ref<Backup[]>([])
const taskStatus = ref<'idle' | 'running' | 'success' | 'failed'>('idle')
const loading = ref(true)
const creating = ref(false)
const showVerification = ref(false)
const showPassphrase = ref(false)
const passphrase = ref('')
const passphraseConfirm = ref('')
const verificationComplete = ref(false)
const polling = ref(false)
let pollTimer: number | null = null

const canCreate = computed(() => verificationComplete.value && passphrase.value.length >= 16 && passphrase.value === passphraseConfirm.value && !creating.value)

function clearPassphrase(): void {
  passphrase.value = ''
  passphraseConfirm.value = ''
  verificationComplete.value = false
  showPassphrase.value = false
}

async function refresh(): Promise<void> {
  try {
    const response = await api.admin.panelBackups.list()
    const previousTask = taskStatus.value
    backups.value = response.backups
    taskStatus.value = response.task.status
    if (response.task.status === 'success' && response.task.backup && !backups.value.some(item => item.id === response.task.backup?.id)) {
      backups.value = [response.task.backup, ...backups.value]
    }
    if (previousTask === 'running' && response.task.status === 'success') toast.success('加密備份已建立')
    if (previousTask === 'running' && response.task.status === 'failed') toast.error('備份失敗，請檢查伺服器狀態')
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '讀取備份清單失敗')
  } finally {
    loading.value = false
  }
}

function startCreate(): void {
  showVerification.value = true
}

function onVerified(): void {
  showVerification.value = false
  verificationComplete.value = true
  showPassphrase.value = true
}

async function createBackup(): Promise<void> {
  if (!canCreate.value) return
  creating.value = true
  const secret = passphrase.value
  try {
    await api.admin.panelBackups.create(secret)
    taskStatus.value = 'running'
    toast.success('備份工作已啟動')
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '備份失敗')
  } finally {
    clearPassphrase()
    creating.value = false
  }
}

async function downloadBackup(backup: Backup): Promise<void> {
  try {
    const { token } = await api.admin.panelBackups.createDownloadToken(backup.id)
    const file = await api.admin.panelBackups.download(token)
    const url = URL.createObjectURL(file)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `panel-backup-${backup.id}.xpb`
    anchor.click()
    URL.revokeObjectURL(url)
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '下載失敗')
  }
}

function formatSize(size: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB']
  let value = size
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(unit ? 1 : 0)} ${units[unit]}`
}

onMounted(() => {
  void refresh()
  pollTimer = window.setInterval(() => {
    if (!polling.value) {
      polling.value = true
      void refresh().finally(() => { polling.value = false })
    }
  }, 15000)
})

onUnmounted(() => {
  if (pollTimer !== null) window.clearInterval(pollTimer)
  clearPassphrase()
})
</script>

<template>
  <div class="space-y-6 p-4 md:p-6">
    <header class="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 class="text-2xl font-semibold text-themed">面板備份</h1>
        <p class="mt-2 max-w-3xl text-sm text-themed-secondary">包含 PostgreSQL 面板資料庫、部署環境設定、必要 secrets 與面板憑證。備份以 passphrase 加密；不包含 Incus VM、容器磁碟或宿主機資料。每個下載連結限時 60 秒且僅可使用一次。</p>
      </div>
      <button class="btn-primary" :disabled="creating" @click="startCreate">建立加密備份</button>
    </header>

    <section class="border-y border-themed py-4">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h2 class="text-base font-medium text-themed">備份檔案</h2>
        <span class="text-sm text-themed-muted">保留最近 7 份</span>
      </div>
      <p v-if="taskStatus === 'running'" class="mt-3 text-sm text-themed-secondary">備份工作正在執行</p>
      <p v-if="taskStatus === 'success'" class="mt-3 text-sm text-themed-secondary">最近一次備份工作已完成</p>
      <p v-if="taskStatus === 'failed'" class="mt-3 text-sm text-red-600">最近一次備份工作失敗</p>
      <div v-if="loading" class="py-8 text-sm text-themed-secondary">載入中…</div>
      <div v-else-if="backups.length === 0" class="py-8 text-sm text-themed-secondary">尚無面板備份</div>
      <ul v-else class="mt-3 divide-y divide-themed">
        <li v-for="backup in backups" :key="backup.id" class="flex flex-wrap items-center justify-between gap-3 py-3">
          <div>
            <div class="font-medium text-themed">{{ new Date(backup.createdAt).toLocaleString() }}</div>
            <div class="mt-1 text-sm text-themed-secondary">{{ formatSize(backup.size) }} · AES-256-GCM</div>
          </div>
          <button class="btn-secondary" @click="downloadBackup(backup)">下載</button>
        </li>
      </ul>
    </section>

    <section v-if="showPassphrase" class="max-w-xl space-y-4 border border-themed p-4">
      <h2 class="font-medium text-themed">設定備份 passphrase</h2>
      <p class="text-sm text-themed-secondary">至少 16 個字元。passphrase 不會儲存在伺服器；遺失後無法解密此備份。</p>
      <label class="block text-sm text-themed-secondary">Passphrase
        <input v-model="passphrase" type="password" autocomplete="new-password" maxlength="1024" class="input mt-1 w-full" />
      </label>
      <label class="block text-sm text-themed-secondary">再次輸入
        <input v-model="passphraseConfirm" type="password" autocomplete="new-password" maxlength="1024" class="input mt-1 w-full" />
      </label>
      <p v-if="passphraseConfirm && passphrase !== passphraseConfirm" class="text-sm text-red-600">兩次輸入不一致</p>
      <div class="flex gap-2">
        <button class="btn-secondary" :disabled="creating" @click="clearPassphrase">取消</button>
        <button class="btn-primary" :disabled="!canCreate" @click="createBackup">{{ creating ? '正在建立…' : '建立備份' }}</button>
      </div>
    </section>

    <SensitiveVerificationModal :show="showVerification" operation-type="backup_panel" @close="showVerification = false" @verified="onVerified" />
  </div>
</template>
