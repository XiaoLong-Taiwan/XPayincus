/**
 * 自动快照/备份策略调度器
 * 负责定时执行用户配置的自动快照和自动备份策略
 */

import { schedule } from 'node-cron'
import { randomUUID } from 'node:crypto'
import { createBackup as createIncusBackup, deleteBackup as deleteIncusBackup } from '../lib/incus/incus-backups.js'
import { INSTANCE_OPERATION_LOCK_NAMESPACE, tryAdvisoryTransactionLock } from '../db/advisory-locks.js'
import { createBackupWithQuotaReservation } from '../db/backups.js'
import pLimit from 'p-limit'
import { prisma } from '../db/prisma.js'
import { IncusClient } from '../lib/incus/incus-client.js'
import { createSnapshot as createIncusSnapshot } from '../lib/incus/incus-snapshots.js'
import { acquireLock, releaseLock } from '../lib/distributed-lock.js'
import * as db from '../db/index.js'
import { sendNotification } from '../lib/notifier.js'
import { createLog } from '../db/logs.js'

// 并发限制：同时最多处理 5 个任务
const limit = pLimit(5)

// 最大重试次数
const MAX_RETRIES = 3
// 重试延迟（毫秒）
const RETRY_DELAY = 5000
const AUTO_POLICY_LOCK_EXPIRE_MS = 30 * 60 * 1000
const AUTO_POLICY_LOCK_WAIT_MS = 100
let schedulerStarted = false

function getAutoSnapshotPolicyLockKey(instanceId: number): string {
    return `auto-policy:snapshot:${instanceId}`
}

/**
 * 延迟函数
 */
function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * 获取或创建 Incus 客户端
 */
async function getIncusClient(host: {
    url: string
    certPath: string | null
    keyPath: string | null
}): Promise<IncusClient | null> {
    if (!host.certPath || !host.keyPath) {
        return null
    }

    const client = new IncusClient({
        url: host.url,
        certPath: host.certPath,
        keyPath: host.keyPath
    })

    try {
        await client.connect()
        return client
    } catch (error) {
        console.error('[AutoPolicy] Failed to connect to host:', error)
        return null
    }
}

/**
 * 生成快照/备份名称
 */
function generateName(prefix: string): string {
    const now = new Date()
    const timestamp = now.toISOString()
        .replace(/[-:]/g, '')
        .replace('T', '-')
        .slice(0, 15)
    return `${prefix}-${timestamp}`
}

/**
 * 执行自动快照（带重试）
 * 配额继承自套餐包，满额时删除最旧的自动快照
 */
async function executeAutoSnapshot(
    policy: {
        instanceId: number
        instance: {
            id: number
            incusId: string
            name: string
            userId: number
            snapshotLimit: number | null
            host: {
                url: string
                name: string
                certPath: string | null
                keyPath: string | null
            }
        }
    }
): Promise<void> {
    const { instance } = policy
    const snapshotLimit = instance.snapshotLimit
    
    // 没有配额，无法创建自动快照
    if (!snapshotLimit || snapshotLimit <= 0) {
        console.log(`[AutoPolicy] Instance ${instance.id} has no snapshot quota, skipping`)
        return
    }
    
    let lastError: Error | null = null

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            console.log(`[AutoPolicy] Creating auto snapshot for instance ${instance.id} (attempt ${attempt}/${MAX_RETRIES})`)

            const client = await getIncusClient(instance.host)
            if (!client) {
                throw new Error('Failed to connect to host')
            }

            const snapshotName = generateName('auto')
            
            // 检查当前快照数量
            const currentSnapshots = await prisma.snapshot.findMany({
                where: { instanceId: instance.id },
                orderBy: { createdAt: 'asc' }
            })
            
            let deletedSnapshotName: string | null = null
            
            // 如果已达到配额上限，先删除最旧的自动快照
            if (currentSnapshots.length >= snapshotLimit) {
                // 优先删除最旧的自动快照
                const autoSnapshots = currentSnapshots.filter(s => s.name.startsWith('auto-'))
                const snapshotToDelete = autoSnapshots[0] || currentSnapshots[0]
                
                if (snapshotToDelete) {
                    try {
                        const { deleteSnapshot } = await import('../lib/incus/incus-snapshots.js')
                        await deleteSnapshot(client, instance.incusId, snapshotToDelete.incusName)
                        await prisma.snapshot.delete({ where: { id: snapshotToDelete.id } })
                        deletedSnapshotName = snapshotToDelete.name
                        console.log(`[AutoPolicy] Deleted old snapshot to make room: ${snapshotToDelete.name}`)
                    } catch (delErr) {
                        console.error(`[AutoPolicy] Failed to delete old snapshot:`, delErr)
                        throw new Error(`Failed to delete old snapshot: ${snapshotToDelete.name}`)
                    }
                }
            }

            // 在 Incus 中创建快照
            await createIncusSnapshot(client, instance.incusId, snapshotName)

            // 在数据库中记录
            await db.createSnapshot({
                instanceId: instance.id,
                incusName: snapshotName,
                name: snapshotName,
                description: '自动快照',
                stateful: false
            })

            // 更新策略最后运行时间
            await db.updateSnapshotPolicyLastRun(instance.id)

            // 发送通知（区分是否轮换）
            if (deletedSnapshotName) {
                await sendNotification(instance.userId, 'auto_snapshot_rotated', {
                    instanceName: instance.name,
                    snapshotName,
                    deletedName: deletedSnapshotName,
                    quotaLimit: snapshotLimit,
                    hostName: instance.host.name
                })
            } else {
                await sendNotification(instance.userId, 'auto_snapshot', {
                    instanceName: instance.name,
                    snapshotName,
                    hostName: instance.host.name
                })
            }

            // 记录日志
            await createLog(
                instance.userId,
                'snapshot',
                'snapshot.auto_create',
                `Auto snapshot "${snapshotName}" created for instance "${instance.name}"${deletedSnapshotName ? ` (deleted old: ${deletedSnapshotName})` : ''}`,
                'success',
                { instanceId: instance.id }
            )

            console.log(`[AutoPolicy] Auto snapshot created for instance ${instance.id}: ${snapshotName}`)
            return // 成功，退出重试循环

        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error))
            console.error(`[AutoPolicy] Auto snapshot failed for instance ${instance.id} (attempt ${attempt}):`, lastError.message)

            if (attempt < MAX_RETRIES) {
                await delay(RETRY_DELAY * attempt) // 递增延迟
            }
        }
    }

    // 所有重试都失败
    console.error(`[AutoPolicy] Auto snapshot failed after ${MAX_RETRIES} attempts for instance ${instance.id}`)
    
    // 即使失败也更新下次运行时间，避免无限重试
    await db.updateSnapshotPolicyLastRun(instance.id)
    
    // 发送失败通知
    await sendNotification(instance.userId, 'snapshot_failed', {
        instanceName: instance.name,
        error: lastError?.message || 'Unknown error',
        hostName: instance.host.name
    })
    
    await createLog(
        instance.userId,
        'snapshot',
        'snapshot.auto_create',
        `Auto snapshot failed for instance "${instance.name}": ${lastError?.message}`,
        'failed',
        { instanceId: instance.id }
    )
}

async function executeLockedAutoSnapshot(candidate: { instanceId: number }): Promise<void> {
    const lockKey = getAutoSnapshotPolicyLockKey(candidate.instanceId)
    const lockResult = await acquireLock(lockKey, {
        expireMs: AUTO_POLICY_LOCK_EXPIRE_MS,
        waitTimeoutMs: AUTO_POLICY_LOCK_WAIT_MS,
        retryIntervalMs: 50
    })

    if (!lockResult.success || !lockResult.ownerId) {
        console.log(`[AutoPolicy] Skip auto snapshot for instance ${candidate.instanceId}: lock already held`)
        return
    }

    try {
        const now = new Date()
        const policy = await prisma.snapshotPolicy.findUnique({
            where: { instanceId: candidate.instanceId },
            include: {
                instance: {
                    include: {
                        host: true
                    }
                }
            }
        })

        if (!policy?.enabled || (policy.nextRunAt !== null && policy.nextRunAt > now)) {
            console.log(`[AutoPolicy] Skip auto snapshot for instance ${candidate.instanceId}: policy no longer due`)
            return
        }

        if (
            !policy.instance ||
            !['running', 'stopped'].includes(policy.instance.status) ||
            policy.instance.host.status !== 'online'
        ) {
            console.log(`[AutoPolicy] Skip auto snapshot for instance ${candidate.instanceId}: instance or host no longer eligible`)
            return
        }

        await executeAutoSnapshot({
            instanceId: policy.instanceId,
            instance: {
                id: policy.instance.id,
                incusId: policy.instance.incusId,
                name: policy.instance.name,
                userId: policy.instance.userId,
                snapshotLimit: policy.instance.snapshotLimit,
                host: {
                    url: policy.instance.host.url,
                    name: policy.instance.host.name,
                    certPath: policy.instance.host.certPath,
                    keyPath: policy.instance.host.keyPath
                }
            }
        })
    } finally {
        await releaseLock(lockKey, lockResult.ownerId)
    }
}

/**
 * 运行自动快照任务
 */
export async function runAutoSnapshotJob(): Promise<void> {
    console.log('[AutoPolicy] Starting auto snapshot job...')
    const startTime = Date.now()

    try {
        const now = new Date()

        // 获取待执行的快照策略
        const policies = await prisma.snapshotPolicy.findMany({
            where: {
                enabled: true,
                OR: [
                    { nextRunAt: null },
                    { nextRunAt: { lte: now } }
                ]
            },
            include: {
                instance: {
                    include: {
                        host: true
                    }
                }
            }
        })

        // 过滤掉已删除的实例，允许 running 和 stopped 状态
        const validPolicies = policies.filter(p =>
            p.instance &&
            ['running', 'stopped'].includes(p.instance.status) &&
            p.instance.host.status === 'online'
        )

        console.log(`[AutoPolicy] Found ${validPolicies.length} snapshot policies to execute`)

        // 并发执行（允许 running 和 stopped 状态）
        await Promise.all(
            validPolicies.map(policy =>
                limit(() => executeLockedAutoSnapshot(policy))
            )
        )

        const duration = Date.now() - startTime
        console.log(`[AutoPolicy] Auto snapshot job completed in ${duration}ms`)
    } catch (error) {
        console.error('[AutoPolicy] Auto snapshot job failed:', error)
    }
}

async function executeLockedAutoBackup(instanceId: number): Promise<void> {
    const lockKey = `auto-policy:backup:${instanceId}`
    const lock = await acquireLock(lockKey, {
        expireMs: AUTO_POLICY_LOCK_EXPIRE_MS,
        waitTimeoutMs: AUTO_POLICY_LOCK_WAIT_MS,
        retryIntervalMs: 50
    })
    if (!lock.success || !lock.ownerId) return
    const snapshotLockKey = getAutoSnapshotPolicyLockKey(instanceId)
    const snapshotLock = await acquireLock(snapshotLockKey, {
        expireMs: AUTO_POLICY_LOCK_EXPIRE_MS,
        waitTimeoutMs: AUTO_POLICY_LOCK_WAIT_MS,
        retryIntervalMs: 50
    })
    if (!snapshotLock.success || !snapshotLock.ownerId) {
        await releaseLock(lockKey, lock.ownerId)
        return
    }

    try {
        const result = await prisma.$transaction(async tx => {
            if (!await tryAdvisoryTransactionLock(tx, INSTANCE_OPERATION_LOCK_NAMESPACE, instanceId)) return null
            const now = new Date()
            const policy = await tx.backupPolicy.findUnique({
                where: { instanceId },
                include: { instance: { include: { host: true } } }
            })
            if (!policy?.enabled || (policy.nextRunAt && policy.nextRunAt > now)) return null
            const instance = policy.instance
            const defer = async () => {
                await tx.backupPolicy.update({
                    where: { instanceId },
                    data: { nextRunAt: new Date(Date.now() + 5 * 60 * 1000) }
                })
            }
            const [restore, upload, task, transfer, creating] = await Promise.all([
                tx.restoreTask.count({ where: { instanceId, status: { in: ['PENDING', 'PROCESSING'] } } }),
                tx.backupUploadTask.count({ where: { instanceId, status: { in: ['PENDING', 'PROCESSING'] } } }),
                tx.instanceTask.count({ where: { instanceId, status: { in: ['PENDING', 'PROCESSING'] } } }),
                tx.instanceTransfer.count({ where: { instanceId, status: { in: ['pending', 'processing'] } } }),
                tx.backup.count({ where: { instanceId, status: 'creating' } })
            ])
            if (!['running', 'stopped'].includes(instance.status) || instance.host.status !== 'online'
                || restore || upload || task || transfer || creating || !(instance.backupLimit && instance.backupLimit > 0)) {
                await defer()
                return null
            }
            const client = await getIncusClient(instance.host)
            if (!client) {
                await defer()
                return null
            }
            const backupName = `${generateName('auto')}-${randomUUID().slice(0, 8)}`
            let deletedName: string | null = null
            let backupId: number | undefined
            let error: string | null = null
            try {
                const backups = await tx.backup.findMany({
                    where: { instanceId, status: { in: ['creating', 'ready'] } },
                    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
                })
                const removeCount = Math.max(0, backups.length - instance.backupLimit + 1)
                const automatic = backups.filter(backup => backup.status === 'ready'
                    && backup.name.startsWith('auto-') && backup.description === '自动备份')
                if (automatic.length < removeCount) {
                    await defer()
                    return null
                }
                for (const backup of automatic.slice(0, removeCount)) {
                    await deleteIncusBackup(client, instance.incusId, backup.incusName)
                    await tx.backup.update({ where: { id: backup.id }, data: { status: 'deleted' } })
                    deletedName = deletedName ? `${deletedName}, ${backup.name}` : backup.name
                }
                const reservation = await createBackupWithQuotaReservation({
                    instanceId, incusName: backupName, name: backupName, description: '自动备份'
                }, tx)
                if (!reservation.allowed || !reservation.backupId) {
                    await defer()
                    return null
                }
                backupId = reservation.backupId
                await createIncusBackup(client, instance.incusId, backupName, {
                    instanceOnly: true, optimizedStorage: true
                })
                await tx.backup.update({ where: { id: backupId }, data: { status: 'ready' } })
            } catch (err) {
                error = err instanceof Error ? err.message : String(err)
                if (backupId) await tx.backup.update({ where: { id: backupId }, data: { status: 'error' } })
            }
            const finishedAt = new Date()
            await tx.backupPolicy.update({
                where: { instanceId },
                data: {
                    lastRunAt: finishedAt,
                    nextRunAt: new Date(finishedAt.getTime() + policy.intervalMinutes * 60 * 1000)
                }
            })
            return { instance, backupName, deletedName, error }
        }, { timeout: AUTO_POLICY_LOCK_EXPIRE_MS, maxWait: 5000 })
        if (!result) return
        const { instance, backupName, deletedName, error } = result
        await sendNotification(instance.userId, error ? 'backup_failed' : deletedName ? 'auto_backup_rotated' : 'auto_backup', {
            instanceName: instance.name, backupName, deletedName: deletedName ?? undefined,
            quotaLimit: instance.backupLimit ?? 0, hostName: instance.host.name, error: error ?? undefined
        })
        await createLog(instance.userId, 'backup', 'backup.auto_create',
            error ? `Auto backup failed for instance "${instance.name}": ${error}`
                : `Auto backup "${backupName}" created for instance "${instance.name}"${deletedName ? ` (deleted old: ${deletedName})` : ''}`,
            error ? 'failed' : 'success', { instanceId })
    } finally {
        try {
            await releaseLock(snapshotLockKey, snapshotLock.ownerId)
        } finally {
            await releaseLock(lockKey, lock.ownerId)
        }
    }
}

export async function runAutoBackupJob(): Promise<void> {
    const policies = await prisma.backupPolicy.findMany({
        where: { enabled: true, OR: [{ nextRunAt: null }, { nextRunAt: { lte: new Date() } }] },
        select: { instanceId: true }
    })
    await Promise.all(policies.map(policy => limit(async () => {
        try {
            await executeLockedAutoBackup(policy.instanceId)
        } catch (error) {
            console.error(`[AutoPolicy] Auto backup job failed for instance ${policy.instanceId}:`, error)
        }
    })))
}

/**
 * 启动自动策略调度器
 */
export function startAutoPolicyScheduler(): void {
    if (schedulerStarted) {
        return
    }

    schedulerStarted = true

    // 每 5 分钟检查一次快照策略（支持10分钟频率）
    schedule('*/5 * * * *', () => {
        runAutoSnapshotJob().catch(console.error)
        runAutoBackupJob().catch(console.error)
    })

    console.log('[AutoPolicy] Scheduler started')
    console.log('[AutoPolicy] - Auto snapshot/backup: every 5 minutes')
}
