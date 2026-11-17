/**
 * Incus 备份恢复服务
 * 实现从备份流恢复实例、重命名实例等功能
 */

import { waitForOperation } from './incus-utils.js'
import type { Readable } from 'stream'
import type { IncusClient } from './incus-client.js'

/**
 * 生成临时实例名称
 * 格式: {originalName}-restore-{timestamp}
 */
export function generateTempInstanceName(originalName: string): string {
    const timestamp = Date.now()
    return `${originalName}-restore-${timestamp}`
}

/**
 * 等待 Incus 异步操作完成（用于恢复操作，超时 5 分钟）
 */

interface RestoreFromStreamParams {
    client: IncusClient
    backupStream: Readable
    targetName: string
    poolName?: string
}

/**
 * 从备份流恢复实例
 * 使用二进制流直接 POST 到 Incus API
 */
export async function restoreFromStream({
    client,
    backupStream,
    targetName,
    poolName
}: RestoreFromStreamParams): Promise<void> {
    try {
        const headers: Record<string, string> = { 'content-type': 'application/octet-stream', 'x-incus-name': targetName }
        if (poolName) headers['x-incus-pool'] = poolName
        const response = await client.stream('POST', '/1.0/instances', backupStream, headers)
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of response.body) {
            size += chunk.length
            if (size > 512 * 1024) throw new Error('RESTORE_RESPONSE_LIMIT_OUTCOME_UNKNOWN')
            chunks.push(chunk)
        }
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (response.statusCode >= 400 || data.type === 'error') throw new Error(data.error || 'Restore failed')
        if (data.operation) await waitForOperation(client, data.operation, 5 * 60 * 1000)
    } finally {
        backupStream.destroy()
    }
}

/**
 * 重命名实例
 */
export async function renameInstance(
    client: IncusClient,
    oldName: string,
    newName: string
): Promise<void> {
    await client.request('POST', `/1.0/instances/${oldName}`, {
        name: newName
    })
}

/**
 * 检查实例是否存在
 */
export async function instanceExists(
    client: IncusClient,
    instanceName: string
): Promise<boolean> {
    try {
        await client.request('GET', `/1.0/instances/${instanceName}`)
        return true
    } catch {
        return false
    }
}
