/**
 * API è¯·æ±‚/å“åº”ç±»åž‹å®šä¹‰
 */

import type { User, Instance, Host, Package } from './database.js'

// ==================== è®¤è¯ç›¸å…³ ====================

export interface LoginRequest {
  username: string
  password: string
}

export interface LoginResponse {
  token: string
  user: {
    id: number
    username: string
    email: string
    role: 'admin' | 'user'
    avatarStyle?: string
    avatarBadgeId?: string | null
  }
}

export interface RegisterRequest {
  username: string
  email: string
  password: string
  inviteCode?: string
}

export interface RegisterResponse {
  token: string
  user: {
    id: number
    username: string
    email: string
    role: 'admin' | 'user'
    avatarStyle?: string
    avatarBadgeId?: string | null
  }
}

// ==================== ç”¨æˆ·ç›¸å…³ ====================

export interface CreateUserRequest {
  username: string
  email: string
  password: string
  role?: 'admin' | 'user'
}

export interface UpdateUserRequest {
  email?: string
  role?: 'admin' | 'user'
  status?: 'active' | 'banned'
  emailCode?: string
}

// ==================== å®žä¾‹ç›¸å…³ ====================

export interface CreateInstanceRequest {
  name: string
  packageId: number
  planId?: number  // ä»˜è´¹æ–¹æ¡ˆIDï¼ˆä»˜è´¹å¥—é¤å¿…å¡«ï¼‰
  image: string
  cpu: number
  memory: number
  disk: number
  hostId: number
  sshKeyId: number
  networkMode?: 'nat' | 'nat_ipv6' | 'nat_ipv6_nat' | 'ipv6_only' | 'ipv6_nat' | 'public_ipv4' | 'public_ipv4_ipv6'
  portLimit?: number
  snapshotLimit?: number
  backupLimit?: number
}

export interface UpdateInstanceRequest {
  name?: string
  cpu?: number
  memory?: number
  disk?: number
  portLimit?: number
  snapshotLimit?: number
  backupLimit?: number
}

export interface InstanceWithDetails extends Instance {
  user?: Pick<User, 'id' | 'username' | 'email'>
  host?: Pick<Host, 'id' | 'name' | 'location'>
  package?: Pick<Package, 'id' | 'name'>
}

// ==================== èŠ‚ç‚¹ç›¸å…³ ====================

export interface CreateHostRequest {
  name: string
  url?: string
  location?: string
  countryCode?: string
  tags?: string[]
  certPath?: string
  keyPath?: string
  natConfig?: {
    publicIp?: string
    publicIpv6?: string
    bindIp?: string
    bindIpv6?: string
    portRangeStart?: number
    portRangeEnd?: number
  }
  ipAddress?: string
  storageDriver?: 'zfs' | 'lvm'
  storageType?: 'loop' | 'disk'
  storagePath?: string
  storageSize?: number
  ipv6Mode?: number
  ipv6Subnet?: string
  ipv6Gateway?: string
  ipv6ParentInterface?: string
  cpuAllowanceMax?: number
  memoryMax?: number
  instanceType?: 'container' | 'vm' | 'both'
}

export interface UpdateHostRequest {
  name?: string
  url?: string
  location?: string
  countryCode?: string
  status?: 'online' | 'offline' | 'maintenance'
  certPath?: string
  keyPath?: string
  cpuAllowanceMax?: number
  memoryMax?: number
  instanceType?: 'container' | 'vm' | 'both'
  ipv6ParentInterface?: string
  ipv6Subnet?: string
  trafficResetDay?: number  // æµé‡é‡ç½®æ—¥ï¼ˆ1-28ï¼?
  notifyPurchase?: boolean
  notifyRenew?: boolean
  notifyDestroy?: boolean
  transferEnabled?: boolean
  enableResourcePool?: boolean
  announcement?: string | null
  probeUrl?: string | null
  natConfig?: {
    publicIp?: string
    publicIpv6?: string
    bindIp?: string
    bindIpv6?: string
    portRangeStart?: number | null
    portRangeEnd?: number | null
  }
}
// ==================== å¥—é¤ç›¸å…³ ====================

export interface CreatePackageRequest {
  name: string
  description?: string
  cpuMax: number
  memoryMax: number
  diskMax: number
  bandwidthMax?: number
  networkMode?: 'nat' | 'nat_ipv6' | 'nat_ipv6_nat' | 'ipv6_only' | 'ipv6_nat' | 'public_ipv4' | 'public_ipv4_ipv6'
  instanceType?: 'container' | 'vm'  // å®žä¾‹ç±»åž‹
  hostIds?: number[]
  hostStoragePools?: Record<string, string | null>
  privileged?: boolean
  nested?: boolean
  active?: boolean
  // å¥—é¤èµ„æºé™åˆ¶
  portLimit?: number
  snapshotLimit?: number
  backupLimit?: number
  monthlyTrafficLimit?: string | null
  trafficResetPrice?: number
  // å­˜å‚¨ I/O é™åˆ¶
  ioLimitMode?: 'throughput' | 'iops'
  limitsRead?: string
  limitsWrite?: string
  limitsReadIops?: number
  limitsWriteIops?: number
  // ç½‘ç»œé™åˆ¶
  limitsIngress?: string
  limitsEgress?: string
  // è¿›ç¨‹ä¸Žè°ƒåº?
  limitsProcesses?: number
  limitsCpuPriority?: number
  // å¯åŠ¨é…ç½®
  bootAutostart?: boolean
  bootAutostartPriority?: number
  bootAutostartDelay?: number
  bootHostShutdownTimeout?: number
  // å…¨å±€å…±äº«é…ç½®
  globalShared?: boolean
  globalQuotaMultiplier?: number | null  // é…é¢å€æ•°é™åˆ¶ï¼Œå¦‚ 0.5, 1.0, 1.5, 2.0ï¼Œnull è¡¨ç¤ºæ— é™åˆ¶ï¼ˆ1xï¼?
  globalMaxInstances?: number | null  // å…¨å±€å…±äº«çš„æœ€å¤§å®žä¾‹æ•°ï¼Œnull è¡¨ç¤ºæ— é™åˆ?
  // å®žä¾‹æ“ä½œæƒé™
  allowInstanceDeletion?: boolean  // æ˜¯å¦å…è®¸ç”¨æˆ·åˆ é™¤å®žä¾‹
}

export interface UpdatePackageRequest {
  name?: string
  description?: string
  cpuMax?: number
  memoryMax?: number
  diskMax?: number
  bandwidthMax?: number
  networkMode?: 'nat' | 'nat_ipv6' | 'nat_ipv6_nat' | 'ipv6_only' | 'ipv6_nat' | 'public_ipv4' | 'public_ipv4_ipv6'
  instanceType?: 'container' | 'vm'  // å®žä¾‹ç±»åž‹
  hostIds?: number[]
  hostStoragePools?: Record<string, string | null>
  privileged?: boolean
  nested?: boolean
  active?: boolean
  // å¥—é¤èµ„æºé™åˆ¶
  portLimit?: number
  snapshotLimit?: number
  backupLimit?: number
  monthlyTrafficLimit?: string | null
  trafficResetPrice?: number
  // å­˜å‚¨ I/O é™åˆ¶
  ioLimitMode?: 'throughput' | 'iops'
  limitsRead?: string
  limitsWrite?: string
  limitsReadIops?: number
  limitsWriteIops?: number
  // ç½‘ç»œé™åˆ¶
  limitsIngress?: string
  limitsEgress?: string
  // è¿›ç¨‹ä¸Žè°ƒåº?
  limitsProcesses?: number
  limitsCpuPriority?: number
  // å¯åŠ¨é…ç½®
  bootAutostart?: boolean
  bootAutostartPriority?: number
  bootAutostartDelay?: number
  bootHostShutdownTimeout?: number
  // å…¨å±€å…±äº«é…ç½®
  globalShared?: boolean
  globalQuotaMultiplier?: number | null  // é…é¢å€æ•°é™åˆ¶ï¼Œå¦‚ 0.5, 1.0, 1.5, 2.0ï¼Œnull è¡¨ç¤ºæ— é™åˆ¶ï¼ˆ1xï¼?
  globalMaxInstances?: number | null  // å…¨å±€å…±äº«çš„æœ€å¤§å®žä¾‹æ•°ï¼Œnull è¡¨ç¤ºæ— é™åˆ?
  // å®žä¾‹æ“ä½œæƒé™
  allowInstanceDeletion?: boolean  // æ˜¯å¦å…è®¸ç”¨æˆ·åˆ é™¤å®žä¾‹
}

export interface InstanceConfig {
  limits_read: string
  limits_write: string
  limits_read_iops: number
  limits_write_iops: number
  limits_ingress: string
  limits_egress: string
  limits_processes: number
  limits_cpu_priority: number
  boot_autostart: boolean
  boot_autostart_priority: number
  boot_autostart_delay: number
  boot_host_shutdown_timeout: number
}

export interface InstanceSwapConfig {
  available: boolean
  enabled: boolean
  sizeMb: number
  kind: 'container' | 'vm'
  requiresRunning: boolean
}

export interface InstanceConfigResponse {
  config: InstanceConfig
  overrides: Record<keyof InstanceConfig, boolean>
  packageDefaults: InstanceConfig
  ioLimitMode: 'throughput' | 'iops'
  swap: InstanceSwapConfig
}

// å®žä¾‹é…ç½®è¦†ç›–è¯·æ±‚
export interface UpdateInstanceConfigRequest {
  limitsRead?: string | null
  limitsWrite?: string | null
  limitsReadIops?: number | null
  limitsWriteIops?: number | null
  limitsIngress?: string | null
  limitsEgress?: string | null
  limitsProcesses?: number | null
  limitsCpuPriority?: number | null
  bootAutostart?: boolean | null
  bootAutostartPriority?: number | null
  bootAutostartDelay?: number | null
  bootHostShutdownTimeout?: number | null
}

// ==================== å¿«ç…§/å¤‡ä»½ ====================

export interface CreateSnapshotRequest {
  name: string
  description?: string
}

export interface CreateBackupRequest {
  name: string
  description?: string
}

// ==================== é€šç”¨å“åº” ====================

export interface ApiResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
  message?: string
}

export interface PaginatedResponse<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}

