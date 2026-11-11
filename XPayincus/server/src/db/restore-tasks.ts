/**
 * 恢复任务数据库操作
 */

import { prisma } from './prisma.js'
import { HOST_TASK_CLAIM_LOCK_NAMESPACE, INSTANCE_OPERATION_LOCK_NAMESPACE, tryAdvisoryTransactionLock } from './advisory-locks.js'

export interface CreateRestoreTaskData {
    instanceId: number
    backupId: number | null
    hostId: number
    userId: number
    tempInstanceName: string
    originalInstanceName: string
    originalIncusId: string
}

/**
 * 创建恢复任务
 */
export async function createRestoreTask(data: CreateRestoreTaskData): Promise<number | null> {
    const task = await prisma.$transaction(async tx => {
        const locked = await tryAdvisoryTransactionLock(tx, INSTANCE_OPERATION_LOCK_NAMESPACE, data.instanceId)
        if (!locked) {
            return null
        }

        if (!await tryAdvisoryTransactionLock(tx, HOST_TASK_CLAIM_LOCK_NAMESPACE, data.hostId)) return null
        const instance = await tx.instance.findUnique({ where: { id: data.instanceId }, select: { hostId: true, status: true } })
        if (!instance || instance.hostId !== data.hostId || !['running', 'stopped'].includes(instance.status)) return null
        if (await tx.provisioningJob.findFirst({ where: { instanceId: data.instanceId, status: { in: ['preparing', 'pending', 'processing', 'review_required'] } }, select: { id: true } })) return null
        if (await tx.hostMaintenancePlan.findFirst({ where: { status: { in: ['running', 'recovering', 'review_required', 'completed'] }, OR: [{ sourceHostId: data.hostId }, { targetHostId: data.hostId }] }, select: { id: true } })) return null

        const activeTask = await tx.restoreTask.findFirst({
            where: {
                instanceId: data.instanceId,
                status: { in: ['PENDING', 'PROCESSING'] }
            },
            select: { id: true }
        })
        if (activeTask) {
            return null
        }

        return tx.restoreTask.create({
            data: {
                instanceId: data.instanceId,
                backupId: data.backupId,
                hostId: data.hostId,
                userId: data.userId,
                tempInstanceName: data.tempInstanceName,
                originalInstanceName: data.originalInstanceName,
                originalIncusId: data.originalIncusId,
                status: 'PENDING'
            }
        })
    })
    return task?.id ?? null
}

/**
 * 获取恢复任务
 */
export async function getRestoreTaskById(id: number) {
    return prisma.restoreTask.findUnique({ where: { id } })
}

/**
 * 获取实例的恢复任务列表
 */
export async function getRestoreTasksByInstanceId(instanceId: number) {
    return prisma.restoreTask.findMany({
        where: { instanceId },
        orderBy: { createdAt: 'desc' },
        take: 20
    })
}

/**
 * 更新恢复任务状态
 */
export async function updateRestoreTaskStatus(
    id: number,
    status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED',
    error?: string
) {
    return prisma.restoreTask.update({
        where: { id },
        data: {
            status,
            error: error ?? null,
            finishedAt: ['COMPLETED', 'FAILED'].includes(status) ? new Date() : undefined
        }
    })
}

/**
 * 取消恢复任务（仅 PENDING 状态）
 */
export async function cancelRestoreTask(id: number) {
    const task = await prisma.restoreTask.findUnique({
        where: { id }
    })

    if (!task || task.status !== 'PENDING') {
        return null
    }

    return prisma.$transaction(async tx => {
        const locked = await tryAdvisoryTransactionLock(tx, INSTANCE_OPERATION_LOCK_NAMESPACE, task.instanceId)
        if (!locked) {
            return null
        }

        const updateResult = await tx.restoreTask.updateMany({
            where: {
                id,
                status: 'PENDING'
            },
            data: {
                status: 'FAILED',
                error: '用户取消',
                finishedAt: new Date()
            }
        })

        if (updateResult.count !== 1) {
            return null
        }

        return tx.restoreTask.findUnique({
            where: { id }
        })
    })
}

// hasActiveRestoreTask 和 getQueuePosition 在 workers/restoreTaskWorker.ts 中定义
