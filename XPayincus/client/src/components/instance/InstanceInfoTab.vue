<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { formatMemory, formatDisk, formatDate } from '@/utils/formatters'
import type { Instance } from '@/types/api'
import type { InstanceHistory, InstanceMonitoringSample } from '@/api/agent-monitoring'
import FlagIcon from '@/components/FlagIcon.vue'
import UserAvatar from '@/components/UserAvatar.vue'
import { getVipBadgeInlineStyle, normalizeVipBadgeStyle } from '@/utils/vipBadge'

const { t } = useI18n()

// SSH 连接帮助弹窗
const showSshHelpModal = ref(false)

// 托管者信息弹窗
const showHostOwnerModal = ref(false)

interface ResourceStats {
  memory: { usage: number; limit: number; usagePercent: number }
  disk: { usage: number; limit: number; usagePercent: number }
}

interface TrafficData {
  monthlyUsed: string
  monthlyUsedFormatted: string
  monthlyLimit: string | null
  monthlyLimitFormatted: string | null
  trafficStatus: 'NORMAL' | 'WARNING' | 'LIMITED'
  percentage: number
}

interface Props {
  instance: Instance
  stats: ResourceStats
  statsLoading: boolean
  trafficData?: TrafficData | null
  trafficLoading?: boolean
  showPassword: Record<string, boolean>
  instancePassword?: Record<string, string | null>
  canEditConfig?: boolean
  enableResourcePool?: boolean
  monitoringSample?: InstanceMonitoringSample | null
  monitoringTrend?: InstanceHistory | null
  monitoringStatus?: 'connecting' | 'connected' | 'reconnecting' | 'offline' | 'error'
  monitoringHistoryLoading?: boolean
  monitoringHistoryError?: { message: string; code?: string | null; status?: number | null } | null
}

interface Emits {
  (e: 'toggle-password', instanceId: number): void
  (e: 'change-password'): void
  (e: 'copy', text: string): void
  (e: 'edit-config'): void
  (e: 'redeem'): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()

const ipv4Address = computed(() => {
  const instance = props.instance as any
  const publicAddress = instance.nat_public_ip ?? instance.natPublicIp ?? instance.host?.nat_public_ip
  const isNat = ['nat', 'nat_ipv6', 'nat_ipv6_nat', 'ipv6_nat', 'ipv6_only'].includes(props.instance.network_mode || '')
  if (typeof publicAddress === 'string' && publicAddress) return publicAddress
  return isNat ? null : props.instance.ipv4 || null
})
const ipv6Address = computed(() => {
  const instance = props.instance as any
  const hostIpv6 = instance.host_ipv6_address ?? instance.hostIpv6Address ?? instance.host_ip_address ?? instance.hostIpAddress ?? instance.host?.ip_address
  const isSharedIpv6 = ['nat_ipv6_nat', 'ipv6_nat'].includes(props.instance.network_mode || '')
  const address = isSharedIpv6 && typeof hostIpv6 === 'string' && hostIpv6.includes(':') ? hostIpv6 : props.instance.ipv6
  return typeof address === 'string' && address.includes(':') ? address : null
})
const mappedSshPort = computed(() => {
  const mapping = (props.instance as any).port_mappings?.find((item: any) => item.protocol === 'tcp' && (item.privatePort ?? item.private_port) === 22)
  return mapping?.publicPort ?? mapping?.public_port ?? props.instance.ssh_port ?? null
})
const isRunning = computed(() => props.instance.status?.toLowerCase() === 'running')
const hasLiveMonitoring = computed(() => isRunning.value && props.monitoringStatus === 'connected' && props.monitoringSample?.online === true)
const monitoringMetrics = computed(() => hasLiveMonitoring.value ? props.monitoringSample?.metrics ?? {} : {})
const monitoringTrendRows = computed(() => props.monitoringTrend?.buckets ?? [])
const historyMetrics = [
  { key: 'cpuUsagePercent', label: 'instance.detail.info.cpu', suffix: '%' },
  { key: 'memoryUsedBytes', label: 'instance.monitoring.memory', suffix: '' },
  { key: 'diskIOBytesPerSecond', label: 'instance.monitoring.diskIo', suffix: ' B/s' },
  { key: 'rxBytesPerSecond', label: 'instance.monitoring.rx', suffix: ' B/s' },
  { key: 'txBytesPerSecond', label: 'instance.monitoring.tx', suffix: ' B/s' }
]
const memoryUsageMb = computed(() => {
  const bytes = monitoringMetrics.value.memoryUsedBytes
  return typeof bytes === 'number' && Number.isFinite(bytes) ? bytes / 1024 / 1024 : null
})
const memoryLimitMb = computed(() => props.stats.memory.limit > 0 ? props.stats.memory.limit : props.instance.memory)
const memoryUsagePercent = computed(() => {
  if (memoryUsageMb.value === null || memoryLimitMb.value <= 0) return 0
  return clampPercent(memoryUsageMb.value / memoryLimitMb.value * 100)
})
const diskUsagePercent = computed(() => hasLiveMonitoring.value ? props.stats.disk.usagePercent : 0)

// 是否可以编辑配置（只有 running 或 stopped 状态才能编辑，且需要权限）
const canEditConfig = computed<boolean>(() => {
  const s = props.instance?.status?.toLowerCase()
  const statusOk = s === 'running' || s === 'stopped'
  // 只有明确传递 true 时才允许编辑，默认 false
  const hasPermission = props.canEditConfig === true
  return statusOk && hasPermission
})

// 获取实例类型的样式类
function getInstanceTypeClass(type: string | undefined | null): string {
  const normalizedType = String(type || 'container').toLowerCase()
  switch (normalizedType) {
    case 'vm':
      return 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300 border border-gray-200 dark:border-gray-700'
    case 'container':
    default:
      return 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300 border border-gray-200 dark:border-gray-700'
  }
}

// 获取实例类型的标签文本
function getInstanceTypeLabel(type: string | undefined | null): string {
  const normalizedType = String(type || 'container').toLowerCase()
  switch (normalizedType) {
    case 'vm':
      return t('common.instanceType.vm')
    case 'container':
    default:
      return t('common.instanceType.container')
  }
}

// 获取网络模式的样式类
function getNetworkModeClass(mode: string | undefined | null): string {
  const normalizedMode = String(mode || 'nat').toLowerCase()
  const neutralChip = 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300 border border-gray-200 dark:border-gray-700'
  switch (normalizedMode) {
    case 'nat':
      return neutralChip
    case 'nat_ipv6':
      return neutralChip
    case 'nat_ipv6_nat':
      return neutralChip
    case 'ipv6_only':
      return neutralChip
    case 'ipv6_nat':
      return neutralChip
    default:
      return neutralChip
  }
}

// 获取网络模式的标签文本
function getNetworkModeLabel(mode: string | undefined | null): string {
  const normalizedMode = String(mode || 'nat').toLowerCase()
  // 直接使用国际化 key，所有模式的 key 格式统一为 common.networkMode.<mode>
  const key = `common.networkMode.${normalizedMode}`
  const translated = t(key)
  // 如果翻译 key 不存在（返回 key 本身），回退到 nat 标签
  return translated === key ? t('common.networkMode.nat') : translated
}

// 流量进度条颜色
const trafficProgressBarClass = computed(() => {
  if (!props.trafficData) return 'bg-blue-500'
  if (props.trafficData.percentage >= 100) return 'bg-red-500'
  if (props.trafficData.percentage >= 80) return 'bg-yellow-500'
  return 'bg-blue-500'
})

// 格式化镜像名称：优先使用 imageName，否则去掉 images: 前缀
function formatImageName(image: string, imageName?: string | null): string {
  if (imageName) return imageName
  return image?.replace(/^images:/, '') || ''
}

// 获取封停原因的显示文本
function getSuspendReasonText(reason: string | null | undefined): string {
  if (!reason) return t('instance.detail.info.suspendReasonDefault')
  if (reason === 'expired') return t('instance.detail.info.suspendReasonExpired')
  return reason
}

const integerFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 })

function formatMonitoringMetric(value: number | undefined, suffix = ''): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${integerFormat.format(value)}${suffix}` : '—'
}

function formatHistoryMetric(value: number | undefined, metric: typeof historyMetrics[number]): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  if (metric.key === 'memoryUsedBytes') return value === 0 ? '0 MB' : formatMemory(value / 1024 / 1024)
  if (metric.suffix === ' B/s') return formatBytesPerSecond(value)
  return formatMonitoringMetric(value, metric.suffix)
}

function formatBytes(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let amount = value
  let unit = 0
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024
    unit++
  }
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(amount)} ${units[unit]}`
}

function formatBytesPerSecond(value: number | undefined): string {
  const formatted = formatBytes(value)
  return formatted === '—' ? formatted : `${formatted}/s`
}

function clampPercent(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0
}

function rateBarWidth(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return Math.min(100, Math.max(4, (value / (1024 * 1024)) * 20))
}

// 格式化带宽值，统一换算成 Mbps
function formatBandwidth(bandwidth: string | null | undefined): string {
  const value = String(bandwidth || '').trim()
  if (!value || value === '0') return t('traffic.unlimited')

  const unitMatch = value.match(/^(\d+(?:\.\d+)?)\s*(m|g)?(?:bit|bps)$/i)
  if (unitMatch) {
    const numeric = Number(unitMatch[1])
    if (!Number.isFinite(numeric) || numeric <= 0) return t('traffic.unlimited')
    const multiplier = unitMatch[2]?.toLowerCase() === 'g' ? 1024 : 1
    const mbps = numeric * multiplier
    return `${Number.isInteger(mbps) ? mbps.toFixed(0) : mbps.toFixed(1)} Mbps`
  }

  if (/^\d+$/.test(value)) {
    const bytes = BigInt(value)
    const GB = BigInt(1024 * 1024 * 1024)
    const MB = BigInt(1024 * 1024)

    if (bytes >= GB) {
      const gbps = Number(bytes / GB)
      return `${gbps * 1024} Mbps`
    }
    if (bytes >= MB) {
      return `${Number(bytes / MB)} Mbps`
    }
    return t('traffic.unlimited')
  }

  return value
}
</script>

<template>
  <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
    <!-- Basic Info -->
    <div class="card shadow-pop p-5 rounded-2xl border-2 border-themed">
      <h2 class="text-themed font-semibold text-sm mb-4">
        {{ t('instance.detail.info.title') }}
      </h2>
      <dl class="space-y-3 text-sm">
        <div class="flex justify-between items-center">
          <dt class="text-themed-muted">{{ t('instance.detail.info.instanceId') }}</dt>
          <dd class="flex items-center gap-2">
            <span class="font-mono text-xs text-themed-muted">
              {{ instance.id }}
              <template v-if="instance.incus_id">
                <span class="text-themed-secondary">/</span>
                <span>{{ instance.incus_id }}</span>
              </template>
            </span>
            <!-- 托管UID：仅托管节点实例显示 -->
            <button
              v-if="instance.hostOwnerInfo"
              class="text-xs px-1.5 py-0.5 rounded-lg bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700 hover:shadow-glow-sakura transition-all border border-gray-200 dark:border-gray-700"
              @click="showHostOwnerModal = true"
            >
              {{ t('instance.detail.info.hostUid') }}:{{ instance.hostOwnerInfo.id }}
            </button>
          </dd>
        </div>
        <div class="flex justify-between">
          <dt class="text-themed-muted">{{ t('instance.detail.info.image') }}</dt>
          <dd class="text-themed font-medium">{{ formatImageName(instance.image, (instance as any).imageName) }}</dd>
        </div>
        <div class="flex justify-between items-center">
          <dt class="text-themed-muted">{{ t('instance.detail.info.instanceMode') }}</dt>
          <dd class="flex flex-wrap items-center gap-2">
            <span
              :class="[
                'text-xs px-1.5 py-0.5 rounded-lg',
                getInstanceTypeClass((instance as any).instance_type)
              ]"
            >
              {{ getInstanceTypeLabel((instance as any).instance_type) }}
            </span>
            <span
              :class="[
                'text-xs px-1.5 py-0.5 rounded-lg',
                getNetworkModeClass(instance.network_mode)
              ]"
            >
              {{ getNetworkModeLabel(instance.network_mode) }}
            </span>
          </dd>
        </div>
        <div v-if="ipv4Address || ipv6Address || mappedSshPort" class="space-y-2 border-t border-themed pt-3">
          <div v-if="ipv4Address" class="flex items-center justify-between gap-3">
            <dt class="text-themed-muted">IPv4</dt>
            <dd class="flex min-w-0 items-center gap-2 text-themed font-medium">
              <span class="break-all text-right font-mono">{{ ipv4Address }}</span>
              <button type="button" class="shrink-0 text-themed-muted hover:text-themed" :title="t('common.copy')" @click="emit('copy', ipv4Address)">
                <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
              </button>
            </dd>
          </div>
          <div v-if="ipv6Address" class="flex items-center justify-between gap-3">
            <dt class="text-themed-muted">IPv6</dt>
            <dd class="flex min-w-0 items-center gap-2 text-themed font-medium">
              <span class="break-all text-right font-mono">{{ ipv6Address }}</span>
              <button type="button" class="shrink-0 text-themed-muted hover:text-themed" :title="t('common.copy')" @click="emit('copy', ipv6Address)">
                <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
              </button>
            </dd>
          </div>
        </div>
        <div v-if="mappedSshPort" class="flex justify-between">
          <dt class="text-themed-muted">{{ t('instance.detail.info.sshPort') }}</dt>
          <dd class="flex items-center gap-2 text-themed font-medium">
            <span class="font-mono">{{ mappedSshPort }}</span>
            <button
              class="text-themed-muted hover:text-themed transition-colors"
              :title="t('instance.detail.info.sshHelpTitle')"
              @click="showSshHelpModal = true"
            >
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </button>
            <button
              class="text-xs text-themed-muted hover:text-themed transition-colors"
              @click="emit('copy', String(mappedSshPort))"
            >
              {{ t('instance.detail.info.copy') }}
            </button>
          </dd>
        </div>
        <div class="flex justify-between">
          <dt class="text-themed-muted">{{ t('instance.detail.info.rootPassword') }}</dt>
          <dd class="flex items-center gap-2 text-themed font-medium">
            <span
              :id="'pwd-' + instance.id"
              class="font-mono"
            >{{ showPassword[instance.id] && instancePassword?.[instance.id] ? instancePassword[instance.id] : '••••••••' }}</span>
            <button
              class="text-xs text-themed-muted hover:text-themed transition-colors"
              @click="emit('toggle-password', instance.id)"
            >
              {{ showPassword[instance.id] ? t('instance.detail.info.hide') : t('instance.detail.info.show') }}
            </button>
            <button
              class="text-xs text-themed-muted hover:text-themed transition-colors"
              @click="emit('change-password')"
            >
              {{ t('instance.detail.password.change', 'Change password') }}
            </button>
            <button
              v-if="showPassword[instance.id] && instancePassword?.[instance.id]"
              class="text-xs text-themed-muted hover:text-themed transition-colors"
              @click="emit('copy', instancePassword[instance.id] || '')"
            >
              {{ t('instance.detail.info.copy') }}
            </button>
          </dd>
        </div>
        <!-- 节点 - 移到创建/到期时间上面 -->
        <div class="flex justify-between">
          <dt class="text-themed-muted">{{ t('instance.detail.info.host') }}</dt>
          <dd class="flex items-center gap-2 text-themed font-medium">
            <FlagIcon v-if="(instance as any).host?.country_code || (instance as any).hostCountryCode" :code="(instance as any).host?.country_code || (instance as any).hostCountryCode || 'us'" size="sm" />
            <span class="uppercase">{{ (instance as any).host?.name || (instance as any).host || '-' }}</span>
          </dd>
        </div>
        <div class="flex justify-between">
          <dt class="text-themed-muted">{{ t('instance.detail.info.createdAt') }}</dt>
          <dd class="text-xs text-themed-muted">
            {{ formatDate(instance.created_at) }}
          </dd>
        </div>
        <!-- 到期时间 -->
        <div v-if="instance.expires_at" class="flex justify-between">
          <dt class="text-themed-muted">{{ t('instance.detail.info.expiresAt') }}</dt>
          <dd
            class="text-xs"
            :class="new Date(instance.expires_at) <= new Date() ? 'text-rose-600 dark:text-rose-400' : 'text-themed-muted'"
          >
            {{ formatDate(instance.expires_at) }}
          </dd>
        </div>
        <!-- 封停信息 -->
        <div v-if="instance.status === 'suspended'" class="p-2 rounded-lg bg-rose-50 border border-rose-200 dark:bg-rose-500/15 dark:border-rose-500/30">
          <div class="flex items-center gap-2 mb-1">
            <svg class="w-4 h-4 text-rose-600 dark:text-rose-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <span class="text-sm font-medium text-rose-600 dark:text-rose-400">{{ t('instance.detail.info.suspended') }}</span>
          </div>
          <p class="text-xs text-rose-700 dark:text-rose-300">
            <span class="font-medium">{{ t('instance.detail.info.suspendReasonLabel') }}:</span>
            {{ getSuspendReasonText(instance.suspend_reason) }}
          </p>
          <p v-if="instance.suspended_at" class="text-xs mt-1 text-rose-600/70 dark:text-rose-400/70">
            {{ t('instance.detail.info.suspendedAt') }}: {{ formatDate(instance.suspended_at) }}
          </p>
          <p class="text-xs mt-2 text-rose-600/80 dark:text-rose-400/80">
            {{ t('instance.detail.info.suspendTip') }}
          </p>
        </div>
      </dl>
    </div>

    <!-- Resource Usage -->
    <div class="card shadow-pop p-5 rounded-2xl border-2 border-themed">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-themed font-semibold text-sm">
          {{ t('instance.detail.info.resourceUsage') }}
        </h2>
        <div class="flex items-center gap-2">
          <!-- 兑换按钮 -->
          <button
            v-if="props.enableResourcePool"
            class="text-xs px-2 py-1 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 dark:bg-gray-800 dark:hover:bg-gray-700 dark:text-gray-300 hover:shadow-glow-sakura transition-all border border-gray-200 dark:border-gray-700"
            @click="emit('redeem')"
          >
            <svg class="w-3.5 h-3.5 inline-block mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v13m0-13V6a2 2 0 112 2h-2zm0 0V5.5A2.5 2.5 0 109.5 8H12zm-7 4h14M5 12a2 2 0 110-4h14a2 2 0 110 4M5 12v7a2 2 0 002 2h10a2 2 0 002-2v-7" />
            </svg>
            {{ t('instance.detail.info.redeem') }}
          </button>
          <!-- 编辑按钮 -->
          <button
            class="text-xs px-2 py-1 rounded-lg transition-all border"
            :class="[
              canEditConfig
                ? 'bg-gray-800/50 hover:bg-gray-700/50 text-themed-muted hover:text-themed border-themed/30 hover:shadow-glow-sakura'
                : 'bg-gray-800/30 text-themed-secondary cursor-not-allowed border-themed/20'
            ]"
            :disabled="!canEditConfig"
            :title="canEditConfig ? '' : t('instance.detail.info.cannotEditConfig')"
            @click="canEditConfig && emit('edit-config')"
          >
            <svg class="w-3.5 h-3.5 inline-block mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
            {{ t('common.edit') }}
          </button>
          <div
            v-if="isRunning && statsLoading"
            class="w-3 h-3 border-2 border-sakura-400 border-t-transparent rounded-full animate-spin"
          ></div>
        </div>
      </div>
      <div class="space-y-4">
        <!-- CPU -->
        <div>
          <div class="flex justify-between text-sm mb-1">
            <span class="text-themed-muted">
              <svg class="w-4 h-4 inline-block mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
              </svg>
              {{ t('instance.detail.info.cpu') }}
            </span>
            <span class="text-themed font-medium">{{ formatMonitoringMetric(monitoringMetrics.cpuUsagePercent, '%') }}<span v-if="typeof monitoringMetrics.cpuUsagePercent === 'number'"> ({{ Math.round(clampPercent(monitoringMetrics.cpuUsagePercent)) }}%)</span></span>
          </div>
          <div class="h-2 rounded-full overflow-hidden bg-themed/20">
            <div class="h-full rounded-full bg-green-500 transition-all duration-500" :style="{ width: clampPercent(monitoringMetrics.cpuUsagePercent) + '%' }"></div>
          </div>
        </div>
        <!-- Memory -->
        <div>
          <div class="flex justify-between text-sm mb-1">
            <span class="text-themed-muted">
              <svg class="w-4 h-4 inline-block mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
              </svg>
              {{ t('instance.detail.info.memory') }}
              <span class="text-xs text-themed-secondary ml-1">({{ t('instance.detail.info.includesCache') }})</span>
            </span>
            <span class="text-themed font-medium">
              <template v-if="memoryUsageMb !== null">
                {{ formatMemory(memoryUsageMb) }} /
              </template>
              <template v-else>— / </template>
              {{ formatMemory(memoryLimitMb) }}
              <span v-if="memoryUsagePercent > 0" class="text-xs text-themed-muted ml-1">
                ({{ Math.round(memoryUsagePercent) }}%)
              </span>
            </span>
          </div>
          <div class="h-2 rounded-full overflow-hidden bg-themed/20">
            <div
              class="h-full rounded-full transition-all duration-500"
              :class="memoryUsagePercent > 80 ? 'bg-red-500' : memoryUsagePercent > 60 ? 'bg-yellow-500' : 'bg-green-500'"
              :style="{ width: memoryUsagePercent + '%' }"></div>
          </div>
        </div>
        <!-- Disk -->
        <div>
          <div class="flex justify-between text-sm mb-1">
            <span class="text-themed-muted">
              <svg class="w-4 h-4 inline-block mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
              </svg>
              {{ t('instance.detail.info.disk') }}
            </span>
            <span class="text-themed font-medium">
              <template v-if="hasLiveMonitoring && stats.disk.usage > 0">
                {{ formatDisk(stats.disk.usage) }} /
              </template>
              {{ formatDisk(stats.disk.limit > 0 ? stats.disk.limit : instance.disk) }}
              <span v-if="diskUsagePercent > 0" class="text-xs text-themed-muted ml-1">
                ({{ diskUsagePercent }}%)
              </span>
            </span>
          </div>
          <div class="h-2 rounded-full overflow-hidden bg-themed/20">
            <div
              class="h-full rounded-full transition-all duration-500"
              :class="diskUsagePercent > 80 ? 'bg-red-500' : diskUsagePercent > 60 ? 'bg-yellow-500' : 'bg-purple-500'"
              :style="{ width: clampPercent(diskUsagePercent) + '%' }"
            ></div>
          </div>
        </div>
        <!-- Monthly Traffic -->
        <div>
          <div class="flex justify-between text-sm mb-1">
            <span class="text-themed-muted">
              <svg class="w-4 h-4 inline-block mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z" />
              </svg>
              {{ t('traffic.monthlyUsage') }}
            </span>
            <span class="text-themed font-medium">
              <template v-if="trafficLoading">
                <span class="text-xs text-themed-secondary">{{ t('common.loading') }}</span>
              </template>
              <template v-else-if="trafficData">
                {{ trafficData.monthlyUsedFormatted }}
                <template v-if="trafficData.monthlyLimitFormatted">
                  / {{ trafficData.monthlyLimitFormatted }}
                </template>
                <template v-else>
                  / {{ t('traffic.unlimited') }}
                </template>
                <span class="text-xs text-themed-muted ml-1">
                  ({{ (trafficData.percentage || 0).toFixed(1) }}%)
                </span>
              </template>
              <template v-else>
                <span class="text-xs text-themed-secondary">{{ t('traffic.noData') }}</span>
              </template>
            </span>
          </div>
          <div
            class="h-2 rounded-full overflow-hidden bg-themed/20"
            :class="{ 'opacity-0': !trafficData || trafficLoading }"
          >
            <div
              :class="['h-full rounded-full transition-all duration-500', trafficProgressBarClass]"
              :style="{ width: clampPercent(trafficData?.percentage) + '%' }"
            ></div>
          </div>
        </div>
        <!-- Network Rates -->
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <div class="flex justify-between text-sm mb-1">
              <span class="text-themed-muted">{{ t('instance.monitoring.rx') }}</span>
              <span class="text-themed font-medium">{{ formatBytesPerSecond(monitoringMetrics.rxBytesPerSecond) }}</span>
            </div>
            <div class="h-2 rounded-full overflow-hidden bg-themed/20">
              <div class="h-full rounded-full bg-sky-500 transition-all duration-500" :style="{ width: rateBarWidth(monitoringMetrics.rxBytesPerSecond) + '%' }"></div>
            </div>
          </div>
          <div>
            <div class="flex justify-between text-sm mb-1">
              <span class="text-themed-muted">{{ t('instance.monitoring.tx') }}</span>
              <span class="text-themed font-medium">{{ formatBytesPerSecond(monitoringMetrics.txBytesPerSecond) }}</span>
            </div>
            <div class="h-2 rounded-full overflow-hidden bg-themed/20">
              <div class="h-full rounded-full bg-sky-500 transition-all duration-500" :style="{ width: rateBarWidth(monitoringMetrics.txBytesPerSecond) + '%' }"></div>
            </div>
          </div>
        </div>
        <div class="border-t border-themed pt-3">
          <p class="text-xs" :class="monitoringStatus === 'connected' ? 'text-green-600' : monitoringStatus === 'offline' || monitoringStatus === 'error' ? 'text-red-600' : 'text-amber-600'" role="status" aria-live="polite">
            {{ t(`instance.monitoring.${monitoringStatus ?? 'connecting'}`) }}
          </p>
          <p v-if="monitoringHistoryLoading" class="mt-2 text-xs text-themed-muted" role="status">{{ t('instance.monitoring.loading') }}</p>
          <p v-else-if="monitoringHistoryError" class="mt-2 text-xs text-red-600" role="alert">
            {{ monitoringHistoryError.message }}<span v-if="monitoringHistoryError.code">（{{ monitoringHistoryError.code }}）</span>
          </p>
          <details v-else-if="monitoringTrend" class="mt-2 text-xs">
            <summary class="cursor-pointer text-themed-muted">{{ t('instance.monitoring.history', { seconds: monitoringTrend.resolutionSeconds }) }}</summary>
            <dl class="my-2 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
              <div><dt class="text-themed-muted">{{ t('instance.monitoring.retentionDays') }}</dt><dd>{{ monitoringTrend.retentionDays }}</dd></div>
              <div><dt class="text-themed-muted">{{ t('instance.monitoring.resolutionSeconds') }}</dt><dd>{{ monitoringTrend.resolutionSeconds }}</dd></div>
              <div><dt class="text-themed-muted">{{ t('instance.monitoring.incomplete') }}</dt><dd>{{ monitoringTrend.incomplete ? t('common.yes') : t('common.no') }}</dd></div>
              <div><dt class="text-themed-muted">{{ t('instance.monitoring.capacityTruncated') }}</dt><dd>{{ monitoringTrend.capacityTruncated ? t('common.yes') : t('common.no') }}</dd></div>
              <div><dt class="text-themed-muted">{{ t('instance.monitoring.bucketsTruncated') }}</dt><dd>{{ monitoringTrend.bucketsTruncated ? t('common.yes') : t('common.no') }}</dd></div>
            </dl>
            <p v-if="monitoringTrend.incomplete || monitoringTrend.capacityTruncated || monitoringTrend.bucketsTruncated" class="mt-2 text-amber-600">{{ t('instance.monitoring.incomplete') }}</p>
            <dl class="my-2 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
              <div v-for="key in ['rxBytes', 'txBytes']" :key="key" class="min-w-0 rounded border border-themed p-2">
                <dt class="text-themed-muted">{{ t(`instance.monitoring.${key}`) }}</dt>
                <dd class="font-mono tabular-nums">{{ formatBytes(monitoringTrend.summaryCounters[key]?.delta) }} {{ t('instance.monitoring.bytes') }}</dd>
                <dd class="mt-1 text-themed-muted">{{ t('instance.monitoring.coverage') }}: {{ Math.round((monitoringTrend.summaryCounters[key]?.coverage ?? 0) * 100) }}%</dd>
                <dd class="text-themed-muted">{{ t('instance.monitoring.resetCount') }}: {{ monitoringTrend.summaryCounters[key]?.resetCount ?? 0 }}</dd>
                <dd class="text-themed-muted">{{ t('instance.monitoring.partial') }}: {{ monitoringTrend.summaryCounters[key]?.partial ? t('common.yes') : t('common.no') }}</dd>
                <dd class="text-themed-muted">{{ t('instance.monitoring.count') }}: {{ monitoringTrend.summaryCounters[key]?.count ?? 0 }}</dd>
              </div>
            </dl>
            <template v-if="monitoringTrendRows.length">
              <h4 class="mt-3 font-semibold">{{ t('instance.monitoring.average') }}</h4>
              <dl class="my-2 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
                <div v-for="metric in historyMetrics" :key="metric.key" class="min-w-0 rounded border border-themed p-2">
                  <dt class="text-themed-muted">{{ t(metric.label) }}</dt>
                  <dd class="font-mono tabular-nums">{{ formatHistoryMetric(monitoringTrend.summary[metric.key]?.avg, metric) }}</dd>
                </div>
              </dl>
              <div class="max-h-64 space-y-2 overflow-y-auto">
                <article v-for="bucket in monitoringTrendRows" :key="bucket.from" class="border-b border-themed py-2">
                  <time :datetime="bucket.from" class="text-themed-muted">{{ new Date(bucket.from).toLocaleString() }}</time>
                  <dl class="mt-1 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
                    <div v-for="metric in historyMetrics" :key="metric.key">
                      <dt class="text-themed-muted">{{ t(metric.label) }}</dt>
                      <dd class="font-mono tabular-nums">{{ formatHistoryMetric(bucket.metrics[metric.key]?.avg, metric) }}</dd>
                    </div>
                  </dl>
                </article>
              </div>
            </template>
            <p v-else class="mt-2 text-themed-muted">{{ t('instance.monitoring.empty') }}</p>
          </details>
        </div>
        <!-- Bandwidth Limits -->
        <div class="pt-2 border-t-2 border-themed">
          <div class="flex justify-between text-xs text-themed-muted">
            <span>
              <span class="inline-block w-2 h-2 bg-gray-400 dark:bg-gray-500 rounded-full mr-1"></span>
              {{ t('instance.detail.info.ingressLimit') }}: {{ formatBandwidth(instance.limitsIngress) }}
            </span>
            <span>
              <span class="inline-block w-2 h-2 bg-gray-400 dark:bg-gray-500 rounded-full mr-1"></span>
              {{ t('instance.detail.info.egressLimit') }}: {{ formatBandwidth(instance.limitsEgress) }}
            </span>
          </div>
        </div>
      </div>
    </div>

    <!-- SSH 连接帮助弹窗 -->
    <Teleport to="body">
      <Transition name="modal">
        <div v-if="showSshHelpModal" class="modal-overlay">
          <div class="modal-backdrop" @click="showSshHelpModal = false"></div>
          <div class="modal-content max-w-md">
            <div class="modal-header">
              <h3 class="modal-title">{{ t('instance.detail.info.sshHelpTitle') }}</h3>
              <button class="text-themed-muted hover:text-themed" @click="showSshHelpModal = false">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div class="modal-body space-y-4">
              <!-- IPv4 连接说明 -->
              <div class="p-3 rounded-lg bg-themed/30 border border-themed/30">
                <div class="flex items-center gap-2 mb-2">
                  <span class="text-xs font-medium px-2 py-0.5 rounded-lg bg-themed/50 text-themed border border-themed/30">IPv4</span>
                </div>
                <p class="text-sm text-themed">
                  {{ t('instance.detail.info.sshHelpIpv4') }}
                </p>
              </div>
              <!-- IPv6 连接说明（仅在 nat_ipv6 模式下显示） -->
              <div
                v-if="instance.network_mode === 'nat_ipv6'"
                class="p-3 rounded-lg bg-themed/30 border border-themed/30"
              >
                <div class="flex items-center gap-2 mb-2">
                  <span class="text-xs font-medium px-2 py-0.5 rounded-lg bg-themed/50 text-themed border border-themed/30">IPv6</span>
                </div>
                <p class="text-sm text-themed">
                  {{ t('instance.detail.info.sshHelpIpv6') }}
                </p>
              </div>
            </div>
            <div class="modal-footer">
              <button class="btn-primary" @click="showSshHelpModal = false">
                {{ t('common.gotIt') }}
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

    <!-- 托管者信息弹窗 -->
    <Teleport to="body">
      <Transition name="modal">
        <div v-if="showHostOwnerModal && instance.hostOwnerInfo" class="modal-overlay">
          <div class="modal-backdrop" @click="showHostOwnerModal = false"></div>
          <div class="modal-content max-w-sm">
            <div class="modal-header">
              <h3 class="modal-title">{{ t('instance.detail.info.hostOwnerTitle') }}</h3>
              <button type="button" class="text-themed-muted hover:text-themed" @click="showHostOwnerModal = false">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div class="modal-body">
              <!-- 用户头像区域 -->
              <div class="flex items-center gap-4 mb-6">
                <UserAvatar
                  :username="instance.hostOwnerInfo.username"
                  :email="instance.hostOwnerInfo.email"
                  :avatar-style="instance.hostOwnerInfo.avatarStyle"
                  :badge-id="instance.hostOwnerInfo.avatarBadgeId"
                  :size="56"
                />
                <div class="flex-1">
                  <p class="font-medium text-themed">{{ instance.hostOwnerInfo.username }}</p>
                  <p class="text-sm text-themed-muted">UID: {{ instance.hostOwnerInfo.id }}</p>
                </div>
                <!-- VIP徽章 -->
                <div 
                  v-if="instance.hostOwnerInfo.vipLevel > 0"
                  class="px-3 py-1.5 rounded-full border text-xs font-bold flex items-center gap-1.5 shadow-sm"
                  :style="getVipBadgeInlineStyle(normalizeVipBadgeStyle(instance.hostOwnerInfo.vipBadgeStyle, instance.hostOwnerInfo.vipLevel))"
                >
                  <svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
                  </svg>
                  VIP{{ instance.hostOwnerInfo.vipLevel }}
                </div>
              </div>
              <!-- 详细信息 -->
              <div class="space-y-3">
                <div
                  class="flex items-center justify-between p-3 rounded-lg bg-themed/30 border border-themed/30"
                >
                  <span class="text-sm text-themed-muted flex items-center gap-2">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01" />
                    </svg>
                    {{ t('instance.detail.info.hostOwnerHostCount') }}
                  </span>
                  <span class="text-sm font-semibold text-themed">
                    {{ instance.hostOwnerInfo.hostCount }}
                  </span>
                </div>
                <div
                  class="flex items-center justify-between p-3 rounded-lg bg-themed/30 border border-themed/30"
                >
                  <span class="text-sm text-themed-muted flex items-center gap-2">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                    </svg>
                    {{ t('instance.detail.info.hostOwnerInstanceCount') }}
                  </span>
                  <span class="text-sm font-semibold text-themed">
                    {{ instance.hostOwnerInfo.instanceCount }}
                  </span>
                </div>
                <div
                  class="flex items-center justify-between p-3 rounded-lg bg-themed/30 border border-themed/30"
                >
                  <span class="text-sm text-themed-muted flex items-center gap-2">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                    </svg>
                    {{ t('instance.detail.info.hostOwnerRegisteredDays') }}
                  </span>
                  <span class="text-sm font-semibold text-themed">
                    {{ instance.hostOwnerInfo.registeredDays }} {{ t('common.days') }}
                  </span>
                </div>
              </div>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn-primary" @click="showHostOwnerModal = false">
                {{ t('common.close') }}
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>
