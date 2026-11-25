import { prisma } from '../db/index.js'
import { getSystemConfigBoolean } from '../db/system-config.js'

type LegacyApplicationStatus = 'pending' | 'approved' | 'rejected' | null

export interface HostingAccessResult {
  allowed: boolean
  reason?: string
  details?: {
    instanceCount: number
    hasCreatedHostBefore: boolean
    featureEnabled: boolean
    hiddenBySystemSetting: boolean
    applicationStatus?: LegacyApplicationStatus
  }
}

interface CheckHostingAccessOptions {
  enforceFeatureVisibility?: boolean
}

interface HostingFeatureState {
  role: 'admin' | 'user'
  hasCreatedHostBefore: boolean
  featureEnabled: boolean
  applicationStatus: LegacyApplicationStatus
}

async function getHostingFeatureState(userId: number): Promise<HostingFeatureState | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      role: true,
      hasCreatedHostBefore: true,
      hostingAccessApplications: { select: { status: true } }
    }
  })

  if (!user) {
    return null
  }

  const featureEnabled = await getSystemConfigBoolean('hosting_feature_enabled', true)

  return {
    role: user.role,
    hasCreatedHostBefore: user.hasCreatedHostBefore,
    featureEnabled,
    applicationStatus: user.hostingAccessApplications[0]?.status ?? null
  }
}

export async function getUserHostingFeatureStatus(userId: number): Promise<{
  canAccessHostingFeature: boolean
  hasCreatedHostBefore: boolean
  featureEnabled: boolean
}> {
  const state = await getHostingFeatureState(userId)
  if (!state) {
    return {
      canAccessHostingFeature: false,
      hasCreatedHostBefore: false,
      featureEnabled: false
    }
  }

  if (state.role === 'admin') {
    return {
      canAccessHostingFeature: true,
      hasCreatedHostBefore: state.hasCreatedHostBefore,
      featureEnabled: true
    }
  }

  return {
    canAccessHostingFeature: state.applicationStatus === 'approved' && (state.featureEnabled || state.hasCreatedHostBefore),
    hasCreatedHostBefore: state.hasCreatedHostBefore,
    featureEnabled: state.featureEnabled
  }
}

/**
 * 检查用户是否满足托管准入条件
 */
export async function checkHostingAccess(
  userId: number,
  { enforceFeatureVisibility = true }: CheckHostingAccessOptions = {}
): Promise<HostingAccessResult> {
  const state = await getHostingFeatureState(userId)
  if (!state) {
    return { allowed: false, reason: '用户不存在' }
  }

  // 管理员直接放行
  if (state.role === 'admin') {
    return { allowed: true }
  }

  const instanceCount = await prisma.instance.count({
    where: { userId }
  })

  const details = {
    instanceCount,
    hasCreatedHostBefore: state.hasCreatedHostBefore,
    featureEnabled: state.featureEnabled,
    hiddenBySystemSetting: !state.featureEnabled && !state.hasCreatedHostBefore,
    applicationStatus: state.applicationStatus
  }

  if (enforceFeatureVisibility && details.hiddenBySystemSetting) {
    return {
      allowed: false,
      reason: '托管功能暂未向未创建过节点的用户开放',
      details
    }
  }

  if (state.applicationStatus !== 'approved') {
    return {
      allowed: false,
      reason: '此帳號未取得託管上架資格',
      details
    }
  }

  return { allowed: true, details }
}

/**
 * 判断节点是否为用户托管节点（非管理员节点）
 */
export async function isUserHostedNode(hostId: number): Promise<boolean> {
  const host = await prisma.host.findUnique({
    where: { id: hostId },
    select: {
      user: {
        select: {
          role: true
        }
      }
    }
  })
  return host?.user.role === 'user'
}

/**
 * 获取节点所有者ID
 */
export async function getHostOwnerId(hostId: number): Promise<number | null> {
  const host = await prisma.host.findUnique({
    where: { id: hostId },
    select: { userId: true }
  })
  return host?.userId ?? null
}
