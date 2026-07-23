import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const modeSource = readFileSync(resolve(__dirname, '../../client/src/utils/hostNetworkMode.ts'), 'utf8')
const createSource = readFileSync(resolve(__dirname, '../../client/src/views/resources/MyHostCreateView.vue'), 'utf8')
const configSource = readFileSync(resolve(__dirname, '../../client/src/components/host/MyHostConfigTab.vue'), 'utf8')
const routeSource = readFileSync(resolve(__dirname, '../src/routes/hosts.ts'), 'utf8')
const clientTypeSource = readFileSync(resolve(__dirname, '../../client/src/types/api.ts'), 'utf8')

for (const mode of ['nat', 'nat_ipv6', 'nat_ipv6_nat', 'ipv6_only', 'ipv6_nat', 'public_ipv4', 'public_ipv4_ipv6']) {
  assert.ok(modeSource.includes(`  '${mode}'`), `host network mode config must include ${mode}`)
}

assert.ok(
  modeSource.includes('nat: { ipv6Mode: 3, needsIpv6Subnet: false, needsNatIpv4: true, needsNatIpv6: false }') &&
    modeSource.includes('nat_ipv6: { ipv6Mode: 1, needsIpv6Subnet: true, needsNatIpv4: true, needsNatIpv6: false }') &&
    modeSource.includes('nat_ipv6_nat: { ipv6Mode: 2, needsIpv6Subnet: false, needsNatIpv4: true, needsNatIpv6: true }') &&
    modeSource.includes('ipv6_only: { ipv6Mode: 1, needsIpv6Subnet: true, needsNatIpv4: false, needsNatIpv6: false }') &&
    modeSource.includes('ipv6_nat: { ipv6Mode: 2, needsIpv6Subnet: false, needsNatIpv4: false, needsNatIpv6: true }') &&
    modeSource.includes('public_ipv4: { ipv6Mode: 3, needsIpv6Subnet: false, needsNatIpv4: false, needsNatIpv6: false }') &&
    modeSource.includes('public_ipv4_ipv6: { ipv6Mode: 1, needsIpv6Subnet: true, needsNatIpv4: false, needsNatIpv6: false }'),
  'host network modes must map to the correct IPv6, routed subnet, and NAT capabilities'
)

assert.ok(
  createSource.includes('v-for="mode in hostNetworkModes"') &&
    createSource.includes('ipv6Mode: modeConfig.ipv6Mode') &&
    configSource.includes('v-for="mode in hostNetworkModes"') &&
    configSource.includes('ipv6Mode: selectedNetworkModeConfig.value.ipv6Mode') &&
    configSource.includes('hasPublicIpv4: Boolean(newHost.ipAddress)'),
  'host create and config views must expose and persist the shared complete network mode mapping'
)

assert.ok(
  routeSource.includes("ipv6Mode: { type: 'integer', minimum: 1, maximum: 3 }") &&
    routeSource.includes('const nextIpv6Mode = updates.ipv6Mode ?? host.ipv6_mode ?? 1') &&
    routeSource.match(/ipv6Mode: updates\.ipv6Mode/g)?.length === 2 &&
    clientTypeSource.includes('ipv6Mode?: 1 | 2 | 3'),
  'host PATCH must accept optional ipv6Mode without changing the endpoint or existing request fields'
)

console.log('host network mode guard tests passed')
