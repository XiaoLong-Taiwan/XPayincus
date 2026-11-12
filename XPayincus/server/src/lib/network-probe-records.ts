import { randomUUID } from 'node:crypto'
import { prisma } from '../db/prisma.js'
import type { NetworkProbeTarget } from './network-probe.js'

export const NETWORK_PROBE_RECORD_LIMIT = 100
export const NETWORK_PROBE_GLOBAL_LIMIT = 10000
export const NETWORK_PROBE_RETENTION_DAYS = 30

export interface ProbeSample {
  durationMs: number
  success: boolean
}

export interface ProbeRecordInput {
  packageId: number
  hostId: number
  targetId: string
  source: 'browser' | 'manual-local'
  method: 'https' | 'tcp' | 'icmp'
  port?: number
  measuredAt: string
  samples: ProbeSample[]
  acknowledgedUnverified?: boolean
}

export interface ProbeRecord {
  id: string
  packageId: number
  hostId: number
  targetId: string
  targetHost: string
  targetLabel: string
  source: ProbeRecordInput['source']
  method: ProbeRecordInput['method']
  port: number | null
  measuredAt: Date
  recordedAt: Date
  verified: false
  samples: ProbeSample[]
}

export function isAllowedProbeRecord(input: ProbeRecordInput, target: NetworkProbeTarget, now = Date.now()): boolean {
  const measuredAt = Date.parse(input.measuredAt)
  return target.id === input.targetId && target.packageId === input.packageId && target.hostId === input.hostId
    && Number.isFinite(measuredAt) && measuredAt <= now + 60_000 && measuredAt >= now - 86400_000
    && input.samples.length >= 1 && input.samples.length <= 10
    && input.samples.every(sample => typeof sample.success === 'boolean' && Number.isFinite(sample.durationMs) && sample.durationMs >= 0 && sample.durationMs <= 60_000)
    && ((input.source === 'browser' && input.method === 'https' && target.https)
      || (input.source === 'manual-local' && input.acknowledgedUnverified === true
        && ((input.method === 'icmp' && target.icmp) || (input.method === 'tcp' && target.tcpPorts.includes(input.port!)))))
    && (input.method === 'tcp' ? Number.isInteger(input.port) : input.port === undefined)
}

export const networkProbeRecords = {
  async create(ownerId: number, input: ProbeRecordInput, target: NetworkProbeTarget): Promise<ProbeRecord> {
    const id = randomUUID()
    const rows = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(718205, 1)`
      await tx.$executeRaw`DELETE FROM network_probe_records WHERE recorded_at < NOW() - INTERVAL '30 days'`
      const rows = await tx.$queryRaw<ProbeRecord[]>`
        INSERT INTO network_probe_records (id, owner_id, package_id, host_id, target_id, target_host, target_label, source, method, port, measured_at, samples)
        VALUES (${id}, ${ownerId}, ${input.packageId}, ${input.hostId}, ${target.id}, ${target.host}, ${target.label}, ${input.source}, ${input.method}, ${input.port ?? null}, ${new Date(input.measuredAt)}, ${JSON.stringify(input.samples)}::jsonb)
        RETURNING id, package_id AS "packageId", host_id AS "hostId", target_id AS "targetId", target_host AS "targetHost", target_label AS "targetLabel", source, method, port, measured_at AS "measuredAt", recorded_at AS "recordedAt", verified, samples
      `
      await tx.$executeRaw`DELETE FROM network_probe_records WHERE id IN (SELECT id FROM network_probe_records WHERE owner_id = ${ownerId} ORDER BY recorded_at DESC, id DESC OFFSET ${NETWORK_PROBE_RECORD_LIMIT})`
      await tx.$executeRaw`DELETE FROM network_probe_records WHERE id IN (SELECT id FROM network_probe_records ORDER BY recorded_at DESC, id DESC OFFSET ${NETWORK_PROBE_GLOBAL_LIMIT})`
      return rows[0]
    })
    return { ...rows, id, ownerId, verified: false } as ProbeRecord
  },
  async list(ownerId: number, packageId: number, hostId: number): Promise<ProbeRecord[]> {
    return prisma.$queryRaw<ProbeRecord[]>`
      SELECT id, package_id AS "packageId", host_id AS "hostId", target_id AS "targetId", target_host AS "targetHost", target_label AS "targetLabel", source, method, port, measured_at AS "measuredAt", recorded_at AS "recordedAt", verified, samples
      FROM network_probe_records
      WHERE owner_id = ${ownerId} AND package_id = ${packageId} AND host_id = ${hostId} AND recorded_at >= NOW() - INTERVAL '30 days'
      ORDER BY recorded_at DESC, id DESC LIMIT ${NETWORK_PROBE_RECORD_LIMIT}
    `
  }
}
