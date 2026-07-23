import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateDomainName } from '../src/lib/security.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverRoot = resolve(__dirname, '..')
const repoRoot = resolve(serverRoot, '..')
const hostsSource = readFileSync(resolve(serverRoot, 'src/routes/hosts.ts'), 'utf8')
const monitorSource = readFileSync(resolve(serverRoot, 'src/services/host-address-monitor.ts'), 'utf8')
const createViewSource = readFileSync(resolve(repoRoot, 'client/src/views/resources/MyHostCreateView.vue'), 'utf8')
const configTabSource = readFileSync(resolve(repoRoot, 'client/src/components/host/MyHostConfigTab.vue'), 'utf8')

for (const valid of ['node.example.com', 'edge-1.example.co.uk', 'NODE.EXAMPLE.COM.']) {
  assert.equal(validateDomainName(valid).valid, true, `${valid} must be accepted as a display domain`)
}

for (const invalid of ['https://node.example.com', '203.0.113.10', 'node.example.com:8443', 'localhost', '-node.example.com']) {
  assert.equal(validateDomainName(invalid).valid, false, `${invalid} must be rejected as a display domain`)
}

assert.ok(
  hostsSource.includes("validateIpAddress(ipAddress, 'Manual IPv4 address')") &&
    hostsSource.includes("validateDomainName(ipv4Alias, 'Display domain')") &&
    hostsSource.includes('ipAddress: normalizedIpAddress,') &&
    hostsSource.includes('prepareHostAddressSnapshotForWrite(url, undefined, normalizedIpAddress, normalizedIpv4Alias)'),
  'host writes must store manual IPv4 in Host.ipAddress and validate ipv4Alias as a display domain'
)

assert.ok(
  monitorSource.includes('if (displayDomain?.kind === \'domain\') domains.add(displayDomain.address)') &&
    monitorSource.includes('const resolvedGroups = await Promise.all([...domains].map(resolveDomainAddresses))') &&
    monitorSource.includes('buildSnapshot(input, resolved, ipAddress || undefined, displayDomain?.address)') &&
    monitorSource.includes('recordHostAddressResolutionFailure(hostId, url, trigger, error, ipAddress, ipv4Alias, tx)'),
  'host address registry must resolve display domains and retain manual inputs during resolution failures'
)

for (const source of [createViewSource, configTabSource]) {
  assert.ok(
    source.includes('validateIpv4(form.value.ipAddress') &&
      source.includes('validateDomainName(form.value.ipv4Alias') &&
      source.includes('ipAddress: form.value.ipAddress.trim()'),
    'host forms must validate manual IPv4 separately from the display domain'
  )
}

console.log('host address registry guard tests passed')
