<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import api from '@/api'
import { useAuthStore } from '@/stores/auth'
import { useToast } from '@/stores/toast'
import { validateIdentifier } from '@/utils/validation'
import { hostsPath } from '@/utils/app-paths'
import HostInstallFields from '@/components/host/HostInstallFields.vue'
import { useHostInstallDetails } from '@/composables/useHostInstallDetails'

const { t } = useI18n()
const router = useRouter()
const toast = useToast()
const authStore = useAuthStore()

const isAdmin = computed(() => authStore.user?.role === 'admin')

// 节点名称前缀，仅普通用户需要
const hostNamePrefix = computed(() => `PEER${authStore.user?.id}-`)

const saving = ref(false)
const showInstallScript = ref(false)
const { installDetails, clearInstallDetails, loadInstallDetails } = useHostInstallDetails()


const hostId = ref<number>(0)
const installStatus = ref<'waiting' | 'verifying' | 'success' | 'error'>('waiting')
const verifyError = ref('')

const form = ref({
  name: '',
  nameSuffix: ''
})

// 验证并连接宿主机
async function verifyHost() {
  if (!hostId.value) return
  installStatus.value = 'verifying'
  verifyError.value = ''
  
  try {
    const res = await api.hosts.getAgentStatus(hostId.value)
    if (res.agent?.status === 'online') {
      installStatus.value = 'success'
      toast.success(t('admin.hosts.verifySuccess'))
    } else {
      installStatus.value = 'waiting'
      verifyError.value = t('admin.hosts.agentWaitingForHeartbeat')
    }
  } catch (err: any) {
    installStatus.value = 'error'
    verifyError.value = err?.message || String(err)
    toast.error(t('admin.hosts.verifyFailed') + ': ' + verifyError.value)
  }
}

async function createHost() {
  // 根据用户角色确定节点名称
  let fullName: string
  if (isAdmin.value) {
    // 管理员直接使用完整名称
    if (!form.value.name.trim()) {
      toast.error(t('admin.hosts.hostNameRequired'))
      return
    }
    fullName = form.value.name
  } else {
    // 普通用户：前缀 + 后缀
    if (!form.value.nameSuffix.trim()) {
      toast.error(t('resources.hosts.nameSuffixRequired'))
      return
    }
    fullName = hostNamePrefix.value + form.value.nameSuffix
  }
  
  // 验证完整名称
  const nameValidation = validateIdentifier(fullName, t('admin.hosts.hostName'), 2, 64)
  if (!nameValidation.valid) { toast.error(nameValidation.message || t('admin.hosts.hostNameHint')); return }
  
  saving.value = true
  try {
    const formData = {
      name: fullName
    }

    const response = await loadInstallDetails(() => api.hosts.create(formData))
    if (!response) return
    hostId.value = response.host.id
    toast.success(t('admin.hosts.hostAdded'))
    if (installDetails.value) {
      showInstallScript.value = true
      installStatus.value = 'waiting'
    } else {
      router.push(hostsPath())
    }
  } catch (err: any) {
    const errorCode = err?.code
    const errorMessage = errorCode ? t(`errors.${errorCode}`) : (err?.message || String(err))
    const details = err?.details ? ` (${err.details})` : ''
    toast.error(`${t('admin.hosts.addFailed')}: ${errorMessage}${details}`)
  } finally {
    saving.value = false
  }
}

function closeAndGoBack() {
  showInstallScript.value = false
  clearInstallDetails()
  router.push(hostsPath())
}
</script>

<template>
  <div class="kawaii-page space-y-6 animate-fade-in">

    <!-- 居中容器 -->
    <div class="flex justify-center">
      <div class="w-full max-w-3xl space-y-6">
        <!-- 页面头部 -->
        <div class="page-header">
          <div>
            <h1 class="page-title">{{ t('resources.hosts.create') }}</h1>
            <p class="page-description">{{ t('resources.hosts.createDesc') }}</p>
          </div>
          <RouterLink :to="hostsPath()" class="btn btn-secondary btn-sm gap-1">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 19l-7-7 7-7" /></svg>
            {{ t('common.back') }}
          </RouterLink>
        </div>

        <!-- 部署说明 -->
        <div class="flex items-start gap-3 rounded-xl border border-themed bg-themed-secondary p-4">
          <svg class="mt-0.5 h-5 w-5 shrink-0 icon-themed-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <div class="space-y-1.5 text-sm text-themed-secondary">
            <p>{{ t('resources.hosts.ubuntuOnlyHint') }}</p>
            <p>{{ t('resources.hosts.installHintTitle') }}</p>
            <p class="text-xs text-themed-muted">{{ t('resources.hosts.installHintIpv6') }}</p>
          </div>
        </div>

        <!-- 表单 -->
        <form class="space-y-5" @submit.prevent="createHost">
          <!-- 基本信息 -->
          <section class="nimbus-card space-y-4 rounded-xl border border-themed bg-themed-surface p-5 sm:p-6">
            <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div class="space-y-1.5">
                <label class="block text-sm font-medium text-themed-secondary">{{ t('admin.hosts.hostName') }}</label>
                <!-- 管理员输入完整节点名称 -->
                <template v-if="isAdmin">
                  <input v-model="form.name" type="text" class="input font-mono" placeholder="node-01" required pattern="^[a-zA-Z0-9_-]+$" @input="form.name = form.name.replace(/[^a-zA-Z0-9_-]/g, '')" />
                  <p class="text-xs text-themed-muted">{{ t('admin.hosts.hostNameHint') }}</p>
                </template>
                <!-- 普通用户输入节点名称后缀 -->
                <template v-else>
                  <div class="flex">
                    <span class="inline-flex items-center rounded-l-lg border border-r-0 border-themed bg-themed-secondary px-3 font-mono text-sm text-themed-muted">{{ hostNamePrefix }}</span>
                    <input v-model="form.nameSuffix" type="text" class="input flex-1 rounded-l-none font-mono" placeholder="myhost" required pattern="^[a-zA-Z0-9_-]+$" @input="form.nameSuffix = form.nameSuffix.replace(/[^a-zA-Z0-9_-]/g, '')" />
                  </div>
                  <p class="text-xs text-themed-muted">{{ t('resources.hosts.nameHint') }}</p>
                </template>
                <p class="text-xs text-amber-500">{{ t('common.noIncudalHint') }}</p>
              </div>
            </div>
          </section>

          <!-- 存储池提示 -->
          <div class="flex items-start gap-2.5 rounded-lg border border-themed bg-themed-secondary px-4 py-3">
            <svg class="mt-0.5 h-4 w-4 shrink-0 icon-themed-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M13 16h-1v-4h-1m1-4h.01M12 2a10 10 0 100 20 10 10 0 000-20z" />
            </svg>
            <p class="text-xs leading-relaxed text-themed-secondary">{{ t('resources.hosts.storagePoolAfterConnectHint') }}</p>
          </div>

          <!-- 按钮 -->
          <div class="flex items-center justify-end gap-3 border-t border-themed pt-5">
            <RouterLink :to="hostsPath()" class="btn-secondary">{{ t('common.cancel') }}</RouterLink>
            <button type="submit" class="btn-primary" :disabled="saving || (isAdmin ? !form.name : !form.nameSuffix)">
              <svg v-if="saving" class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
              {{ t('common.create') }}
            </button>
          </div>
        </form>
      </div>
    </div>

    <!-- 安装脚本弹窗 -->
    <Teleport to="body">
      <Transition name="modal">
        <div v-if="showInstallScript && installDetails" class="modal-overlay">
          <div class="modal-backdrop" @click="closeAndGoBack"></div>
          <div class="modal-content" style="max-width: 72rem; width: 95%;">
            <div class="modal-header">
              <h3 class="modal-title">{{ t('admin.hosts.installScript') }}</h3>
              <button class="text-themed-muted transition-colors hover:text-themed" @click="closeAndGoBack">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <div class="modal-body space-y-5">
              <!-- 步骤 1: 执行安装命令 -->
              <div class="space-y-3">
                <div class="flex items-center gap-2.5">
                  <span class="flex items-center justify-center w-6 h-6 rounded-full text-xs font-semibold" :class="installStatus === 'success' ? 'bg-green-500 text-white' : 'bg-primary-600 text-white'">1</span>
                  <span class="text-sm font-medium text-themed">{{ t('admin.hosts.step1RunScript') }}</span>
                </div>
                <p class="text-xs text-themed-muted ml-8">{{ t('admin.hosts.runOnHost') }}</p>
                <HostInstallFields v-if="installDetails" :details="installDetails" class="ml-8" />
              </div>

              <!-- 步骤 2：验证并连接 -->
              <div class="space-y-3 pt-5 border-t border-themed">
                <div class="flex items-center gap-2.5">
                  <span class="flex items-center justify-center w-6 h-6 rounded-full text-xs font-semibold" :class="installStatus === 'success' ? 'bg-green-500 text-white' : 'bg-themed-tertiary text-themed-muted'">2</span>
                  <span class="text-sm font-medium text-themed">{{ t('admin.hosts.step2Verify') }}</span>
                </div>
                <p class="text-xs text-themed-muted ml-8">{{ t('admin.hosts.agentHeartbeatVerifyHint') }}</p>

                <!-- 状态显示 -->
                <div class="ml-8 flex flex-wrap items-center gap-3">
                  <button
                    class="btn-secondary btn-sm gap-1.5"
                    :disabled="installStatus === 'verifying' || installStatus === 'success'"
                    @click="verifyHost"
                  >
                    <svg v-if="installStatus === 'verifying'" class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                      <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
                    </svg>
                    {{ installStatus === 'verifying' ? t('admin.hosts.verifying') : t('admin.hosts.checkAgentStatus') }}
                  </button>

                  <!-- 成功状态 -->
                  <span v-if="installStatus === 'success'" class="inline-flex items-center gap-1.5 rounded-full bg-green-500/10 px-2 py-0.5 text-xs font-mono text-green-500">
                    <span class="h-1.5 w-1.5 rounded-full bg-green-500"></span>
                    {{ t('admin.hosts.verifySuccess') }}
                  </span>
                </div>

                <!-- 错误提示 -->
                <div v-if="installStatus === 'error' && verifyError" class="ml-8 rounded-lg border border-rose-500/20 bg-rose-500/10 p-3 text-sm text-rose-500">
                  {{ verifyError }}
                </div>
              </div>
            </div>
            <div class="modal-footer">
              <button class="btn-secondary" @click="closeAndGoBack">{{ t('common.close') }}</button>
              <button v-if="installStatus === 'success'" class="btn-primary" @click="closeAndGoBack">{{ t('common.done') }}</button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
/* 交互卡片的轻微悬浮抬升 */
.nimbus-card {
  transition: transform 150ms ease, box-shadow 150ms ease, border-color 150ms ease;
}

.nimbus-card:hover {
  transform: translateY(-1px);
  box-shadow: 0 10px 30px -18px rgba(0, 0, 0, 0.25);
}

@media (prefers-reduced-motion: reduce) {
  .nimbus-card,
  .nimbus-card:hover {
    transition: none;
    transform: none;
  }
}
</style>
