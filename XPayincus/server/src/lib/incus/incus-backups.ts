/**
 * Incus 备份管理
 */

import type { IncusClient } from './incus-client.js'
import { Readable } from 'node:stream'
import type { IncusBackup, CreateBackupOptions } from '../../types/incus.js'

/**
 * 获取实例的备份列表
 */
export async function listBackups(client: IncusClient, instanceName: string): Promise<IncusBackup[]> {
  return client.request<IncusBackup[]>('GET', `/1.0/instances/${instanceName}/backups`)
}

/**
 * 获取备份详情
 */
export async function getBackup(
  client: IncusClient,
  instanceName: string,
  backupName: string
): Promise<IncusBackup> {
  return client.request<IncusBackup>(
    'GET',
    `/1.0/instances/${instanceName}/backups/${backupName}`
  )
}

/**
 * 创建备份
 */
export async function createBackup(
  client: IncusClient,
  instanceName: string,
  backupName: string,
  options: CreateBackupOptions = {}
): Promise<unknown> {
  return client.request('POST', `/1.0/instances/${instanceName}/backups`, {
    name: backupName,
    instance_only: options.instanceOnly !== false, // 默认不包含快照
    optimized_storage: options.optimizedStorage !== false, // 默认优化存储
    compression_algorithm: options.compression || 'gzip'
  })
}

/**
 * 删除备份
 */
export async function deleteBackup(
  client: IncusClient,
  instanceName: string,
  backupName: string
): Promise<unknown> {
  return client.request('DELETE', `/1.0/instances/${instanceName}/backups/${backupName}`)
}

/**
 * 导出备份（下载）
 * 返回备份文件的 URL
 */
export function getBackupExportUrl(
  client: IncusClient,
  instanceName: string,
  backupName: string
): string {
  return `${client.baseUrl}/1.0/instances/${instanceName}/backups/${backupName}/export`
}

/**
 * 获取备份导出流
 * 用于流式传输备份文件到客户端
 * 备份文件可能很大，需要更长的超时时间
 */
export async function getBackupExportStream(
  client: IncusClient,
  instanceName: string,
  backupName: string
): Promise<{ stream: ReadableStream<Uint8Array>; contentLength?: number }> {
  if (!client.agent) {
    throw new Error('Incus 客户端未连接')
  }

  const response = await client.stream('GET', `/1.0/instances/${encodeURIComponent(instanceName)}/backups/${encodeURIComponent(backupName)}/export`)
  if (response.statusCode !== 200) {
    response.body.destroy()
    throw new Error(`导出备份失败: HTTP ${response.statusCode}`)
  }
  const length = Number(response.headers['content-length'])
  const contentLength = Number.isSafeInteger(length) && length >= 0 ? length : undefined
  return {
    stream: Readable.toWeb(response.body, { strategy: { highWaterMark: 64 * 1024, size: chunk => chunk.length } }) as ReadableStream<Uint8Array>,
    contentLength
  }
}

/**
 * 从备份恢复实例
 */
export async function restoreFromBackup(
  client: IncusClient,
  newInstanceName: string,
  backupData: Record<string, unknown>
): Promise<unknown> {
  return client.request('POST', '/1.0/instances', {
    name: newInstanceName,
    source: {
      type: 'backup',
      ...backupData
    }
  })
}

