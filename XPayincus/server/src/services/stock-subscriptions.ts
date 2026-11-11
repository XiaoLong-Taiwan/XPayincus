import { prisma } from '../db/prisma.js'
import { findAvailablePackageHost } from '../db/packages.js'
import { canUserAccessPackage } from '../db/package-shares.js'
import type { HostAvailabilityCache } from '../db/hosts.js'

let checking = false
let lastFullCheck = 0

export async function isPlanAvailable(packageId: number, planId: number, region: string): Promise<boolean> {
  const plan = await prisma.packagePlan.findFirst({ where: { id: planId, packageId, isActive: true, isSoldOut: false, package: { active: true } }, include: { package: { include: { packageHosts: true } } } })
  if (!plan) return false
  return !!await findAvailablePackageHost(packageId, plan, region, { pkg: plan.package, cache: new Map() })
}

export async function checkStockSubscriptions(packageId?: number): Promise<void> {
  if (checking || (!packageId && Date.now() - lastFullCheck < 60000)) return
  if (!packageId) lastFullCheck = Date.now()
  checking = true
  try {
    const subscriptions = await prisma.stockSubscription.findMany({ where: { active: true, ...(packageId ? { packageId } : {}) } })
    const plans = await prisma.packagePlan.findMany({ where: { id: { in: [...new Set(subscriptions.map(row => row.planId))] }, isActive: true, isSoldOut: false, package: { active: true } }, include: { package: { include: { packageHosts: true } } } })
    const plansById = new Map(plans.map(plan => [plan.id, plan]))
    const availability = new Map<string, Promise<boolean>>()
    const access = new Map<string, Promise<boolean>>()
    const cache: HostAvailabilityCache = new Map()
    for (const subscription of subscriptions) {
      const accessKey = `${subscription.userId}:${subscription.packageId}`
      if (!access.has(accessKey)) access.set(accessKey, canUserAccessPackage(subscription.userId, subscription.packageId))
      if (!await access.get(accessKey)) {
        await prisma.stockSubscription.updateMany({ where: { id: subscription.id }, data: { active: false } })
        continue
      }
      const key = `${subscription.packageId}:${subscription.planId}:${subscription.region}`
      if (!availability.has(key)) {
        const plan = plansById.get(subscription.planId)
        availability.set(key, plan && plan.packageId === subscription.packageId
          ? findAvailablePackageHost(subscription.packageId, plan, subscription.region, { pkg: plan.package, cache }).then(Boolean)
          : Promise.resolve(false))
      }
      const available = await availability.get(key)
      if (!available) {
        await prisma.stockSubscription.updateMany({ where: { id: subscription.id, active: true }, data: { wasAvailable: false } })
        continue
      }
      if (subscription.wasAvailable || (subscription.lastNotifiedAt && Date.now() - subscription.lastNotifiedAt.getTime() < subscription.cooldownHours * 3600000)) continue
      await prisma.$transaction(async tx => {
        const claimed = await tx.stockSubscription.updateMany({ where: { id: subscription.id, active: true, wasAvailable: false, lastNotifiedAt: subscription.lastNotifiedAt }, data: { wasAvailable: true, lastNotifiedAt: new Date() } })
        if (claimed.count !== 1) return
        await tx.inboxMessage.create({ data: { userId: subscription.userId, eventType: 'package.stock_available', title: '方案已恢復供應', content: `您訂閱的方案 #${subscription.planId}${subscription.region ? `（${subscription.region}）` : ''} 已恢復可售，庫存以購買時為準。`, data: { packageId: subscription.packageId, planId: subscription.planId, region: subscription.region } } })
      })
    }
  } finally {
    checking = false
  }
}
