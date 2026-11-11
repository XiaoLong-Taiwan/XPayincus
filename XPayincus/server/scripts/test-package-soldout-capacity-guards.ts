import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const packagesSource = readFileSync(resolve(__dirname, '../src/db/packages.ts'), 'utf8')
const readinessSource = readFileSync(resolve(__dirname, '../src/scripts/verify-production-db-readiness.ts'), 'utf8')
const hostsSource = readFileSync(resolve(__dirname, '../src/db/hosts.ts'), 'utf8')
const stockSource = readFileSync(resolve(__dirname, '../src/services/stock-subscriptions.ts'), 'utf8')

function includes(source: string, pattern: string, label: string): void {
  assert.ok(source.includes(pattern), `Missing ${label}: ${pattern}`)
}

function functionSection(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start)
  assert.notEqual(startIndex, -1, `Missing section start: ${start}`)
  if (!end) {
    return source.slice(startIndex)
  }
  const endIndex = source.indexOf(end, startIndex + start.length)
  assert.notEqual(endIndex, -1, `Missing section end: ${end}`)
  return source.slice(startIndex, endIndex)
}

const singleSoldOutSection = functionSection(
  packagesSource,
  'export async function checkPackageSoldOut(packageId: number): Promise<boolean> {',
  '/**\n * 批量检查多个套餐的售罄状态'
)

const batchSoldOutSection = functionSection(
  packagesSource,
  'export async function checkPackagesSoldOut(packageIds: number[]): Promise<Map<number, boolean>> {',
  ''
)

includes(singleSoldOutSection, 'checkPackagesSoldOut([packageId])', 'single lookup must share batch semantics')
includes(batchSoldOutSection, 'include: { plans: true, packageHosts: true }', 'batch must preload plans and bindings')
includes(batchSoldOutSection, 'const cache: HostAvailabilityCache = new Map()', 'availability cache must be scoped to a batch')
includes(batchSoldOutSection, 'plan.isActive && !plan.isSoldOut', 'only complete active sellable plans count')
includes(batchSoldOutSection, 'cpu: 15, memory: 128, disk: 512', 'free package defaults must match create defaults')
includes(batchSoldOutSection, "findAvailablePackageHost(pkg.id, plan, '', { pkg, cache })", 'batch must evaluate complete plans using shared host selection')
assert.ok(!batchSoldOutSection.includes('Math.min('), 'different plans must never be combined into a synthetic minimum configuration')
includes(packagesSource, 'resources.portLimit ?? pkg.portLimit', 'plan port requirement must override package defaults')
includes(hostsSource, 'diskUsedEffective + disk', 'host selection must enforce effective disk reservations')
includes(hostsSource, 'host.storageSize * 1024', 'host disk capacity must convert GB to MB')
includes(hostsSource, '`usage:${host.id}`', 'resource queries must be shared within one availability batch')
includes(hostsSource, '`pool:${host.id}:${packageId}`', 'storage selection cache must remain package-specific')
includes(stockSource, 'const plansById = new Map(', 'subscriptions must preload plans')
includes(stockSource, 'const availability = new Map<string, Promise<boolean>>()', 'identical plan-region checks must be deduplicated')
includes(stockSource, 'const access = new Map<string, Promise<boolean>>()', 'access checks must deduplicate per user-package without sharing authorization between users')

includes(readinessSource, 'storageSize: true', 'production readiness must select host storage size')
includes(readinessSource, 'select: { cpu: true, memory: true, disk: true }', 'production readiness must select instance disk usage')
includes(readinessSource, 'select: { cpu: true, memory: true, disk: true, isSoldOut: true }', 'production readiness must select plan disk requirement')
includes(readinessSource, 'configurations.some(plan =>', 'production readiness must evaluate complete plan configurations')
includes(readinessSource, 'availableDisk >= plan.disk', 'production readiness must compare each plan disk requirement')
includes(readinessSource, 'const availableDisk = (host.storageSize || 0) * 1024 - usedDisk', 'production readiness must compute available disk')
includes(readinessSource, 'minimum CPU/memory/disk requirement', 'production readiness warning must name disk capacity')

console.log('package sold-out capacity guard tests passed')
