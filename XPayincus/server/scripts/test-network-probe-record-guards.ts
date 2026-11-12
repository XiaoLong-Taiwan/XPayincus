import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
process.env.DATABASE_URL ||= 'postgresql://test:test@127.0.0.1:5432/test'
import type { NetworkProbeTarget } from '../src/lib/network-probe.js'
const { isAllowedProbeRecord, NETWORK_PROBE_GLOBAL_LIMIT, NETWORK_PROBE_RECORD_LIMIT, NETWORK_PROBE_RETENTION_DAYS } = await import('../src/lib/network-probe-records.js')
type ProbeRecordInput = import('../src/lib/network-probe-records.js').ProbeRecordInput

const target: NetworkProbeTarget = { id: 'edge-1', label: 'Edge', host: 'edge.example.com', tcpPorts: [443], icmp: true, https: true, packageId: 5, hostId: 8 }
const base = { packageId: 5, hostId: 8, targetId: target.id, measuredAt: new Date().toISOString(), samples: [{ durationMs: 18.4, success: true }] }
const validBrowser: ProbeRecordInput = { ...base, source: 'browser', method: 'https' }
const validLocal: ProbeRecordInput = { ...base, source: 'manual-local', method: 'icmp', acknowledgedUnverified: true }

assert.equal(isAllowedProbeRecord(validBrowser, target), true)
assert.equal(isAllowedProbeRecord(validLocal, target), true)
assert.equal(isAllowedProbeRecord({ ...validLocal, acknowledgedUnverified: false }, target), false)
assert.equal(isAllowedProbeRecord({ ...validLocal, hostId: 9 }, target), false)
assert.equal(isAllowedProbeRecord({ ...validBrowser, method: 'https', source: 'manual-local', acknowledgedUnverified: true }, target), false)
assert.equal(isAllowedProbeRecord({ ...validLocal, method: 'tcp', port: 22 }, target), false)
assert.equal(isAllowedProbeRecord({ ...validLocal, samples: Array.from({ length: 11 }, () => ({ durationMs: 1, success: true })) }, target), false)
assert.equal(isAllowedProbeRecord({ ...validLocal, samples: [{ durationMs: 60001, success: true }] }, target), false)
assert.equal(isAllowedProbeRecord({ ...validLocal, measuredAt: new Date(Date.now() - 90000_000).toISOString() }, target), false)
assert.equal(NETWORK_PROBE_RECORD_LIMIT, 100)
assert.equal(NETWORK_PROBE_GLOBAL_LIMIT, 10000)
assert.equal(NETWORK_PROBE_RETENTION_DAYS, 30)

const storageSource = await readFile(new URL('../src/lib/network-probe-records.ts', import.meta.url), 'utf8')
const routeSource = await readFile(new URL('../src/routes/network-probe.ts', import.meta.url), 'utf8')
const migrationSource = await readFile(new URL('../prisma/migrations/20261111050000_network_probe_records/migration.sql', import.meta.url), 'utf8')
assert.match(storageSource, /owner_id = \$\{ownerId\} AND package_id = \$\{packageId\} AND host_id = \$\{hostId\}/)
assert.match(storageSource, /pg_advisory_xact_lock/)
assert.match(routeSource, /canAccessNode\(request\.user\.id, input\.packageId, input\.hostId\)/)
assert.match(migrationSource, /CHECK \("verified" = FALSE\)/)
assert.match(migrationSource, /REFERENCES "users"\("id"\) ON DELETE CASCADE/)

console.log('Network probe record validation guards passed')
