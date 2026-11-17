import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'

const routePath = resolve(process.cwd(), 'src/routes/proxy-sites.ts')
const source = readFileSync(routePath, 'utf8')
const caddyClientPath = resolve(process.cwd(), 'src/lib/caddy-client.ts')
const caddyClientSource = readFileSync(caddyClientPath, 'utf8')
const instanceRoutePath = resolve(process.cwd(), 'src/routes/instances.ts')
const transferRoutePath = resolve(process.cwd(), 'src/routes/transfers.ts')
const instanceTaskWorkerPath = resolve(process.cwd(), 'src/workers/instanceTaskWorker.ts')
const instanceRouteSource = readFileSync(instanceRoutePath, 'utf8')
const transferRouteSource = readFileSync(transferRoutePath, 'utf8')
const instanceTaskWorkerSource = readFileSync(instanceTaskWorkerPath, 'utf8')
const outboundSecurityPath = resolve(process.cwd(), 'src/lib/outbound-security.ts')
const outboundSecuritySource = readFileSync(outboundSecurityPath, 'utf8')

assert.ok(
  source.includes('function parsePositiveRouteId(value: string): number | null') &&
    source.includes('const POSITIVE_ROUTE_ID_PATTERN = /^[1-9]\\d*$/') &&
    source.includes('Number.isSafeInteger(parsed)'),
  'proxy site routes must use a strict positive safe-integer route ID parser'
)

assert.equal(
  source.match(/const instanceId = parsePositiveRouteId\(request\.params\.id\)/g)?.length ?? 0,
  8,
  'all proxy site instance path IDs must use the strict parser'
)

assert.equal(
  source.match(/const siteId = parsePositiveRouteId\(request\.params\.siteId\)/g)?.length ?? 0,
  6,
  'all proxy site path IDs must use the strict parser'
)

const forbiddenPatterns = [
  'parseInt(request.params.id, 10)',
  'parseInt(request.params.siteId, 10)',
  'isNaN(instanceId)',
  'isNaN(siteId)'
]

for (const pattern of forbiddenPatterns) {
  assert.ok(!source.includes(pattern), `proxy site route ID guard must not use ${pattern}`)
}

const certificateResolution = 'const [certificateAddress] = await resolvePublicHostname(site.domain)'
const certificateConnection = 'host: certificateAddress.address'
assert.ok(
  source.includes("import { resolvePublicHostname } from '../lib/outbound-security.js'") &&
    source.includes(certificateResolution) &&
    source.includes(certificateConnection) &&
    source.includes('servername: site.domain'),
  'certificate lookup must validate DNS through outbound security, pin the TLS host to that IP, and preserve SNI'
)
assert.ok(
  source.indexOf(certificateResolution) < source.indexOf('const socket = tls.connect({'),
  'certificate DNS validation must complete before opening the TLS connection'
)
assert.doesNotMatch(
  source,
  /tls\.connect\(\{[\s\S]*?host:\s*site\.domain/,
  'certificate TLS must not resolve the tenant-controlled hostname again at connect time'
)
assert.ok(
  outboundSecuritySource.includes('export async function resolvePublicHostname') &&
    outboundSecuritySource.includes('for (const record of records)') &&
    outboundSecuritySource.includes('isIpPrivateOrReserved(record.address)') &&
    outboundSecuritySource.includes('return records'),
  'outbound hostname resolution must reject every private or reserved result before returning pinned addresses'
)

assert.ok(
  caddyClientSource.includes('class CaddyApiError extends Error') &&
    caddyClientSource.includes('readonly statusCode: number') &&
    caddyClientSource.includes('throw new CaddyApiError(response.statusCode, errorText)'),
  'Caddy failures must preserve the HTTP status code for exact 404 handling'
)

for (const [label, routeSource] of [
  ['proxy sites', source],
  ['instances', instanceRouteSource],
  ['transfers', transferRouteSource],
  ['instance tasks', instanceTaskWorkerSource]
]) {
  assert.doesNotMatch(routeSource, /createCaddyClient\s*\(\s*\{[^}]*host:\s*(?:targetHost|caddyHost|host\.(?:nat_public_ip|ip_address)|sourceHost\.(?:nat_public_ip|ip_address))/s, `${label} must never use a host IP as the Caddy management destination`)
  assert.match(routeSource, /createCaddyClient\s*\(\s*\{[^}]*hostId:\s*[^,}]+,[^}]*host:\s*['"]127\.0\.0\.1['"],[^}]*port:\s*2019/s, `${label} Caddy calls must target loopback 2019 through the host-bound WSS dispatcher`)
}

assert.doesNotMatch(source, /site\.host\.caddy(?:Username|Password)/, 'proxy management must not require legacy Caddy credentials')

assert.ok(
  caddyClientSource.includes(
    'if (!(postError instanceof CaddyApiError) || postError.statusCode !== 404)'
  ) && caddyClientSource.includes('throw postError'),
  'non-404 route POST failures must be rethrown instead of triggering server creation'
)

assert.ok(
  caddyClientSource.includes("await this.request('POST', routesPath, route)") &&
    caddyClientSource.includes(
      "existingServer = await this.request<{ routes?: CaddyRoute[] }>('GET', serverPath)"
    ) &&
    caddyClientSource.includes('if (Array.isArray(existingServer.routes))') &&
    caddyClientSource.includes("await this.request('PUT', routesPath, [route])"),
  'route writes must use array append and re-read sites before any conditional creation'
)

assert.ok(
  caddyClientSource.indexOf(
    "existingServer = await this.request<{ routes?: CaddyRoute[] }>('GET', serverPath)"
  ) <
    caddyClientSource.indexOf("await this.request('PUT', serverPath, serverConfig)"),
  'sites must be read and confirmed missing before its server config is created'
)

assert.ok(
  caddyClientSource.includes("await this.request('GET', httpAppPath)") &&
    caddyClientSource.indexOf("await this.request('GET', httpAppPath)") <
      caddyClientSource.indexOf("await this.request('PUT', httpAppPath, {"),
  'the HTTP app must be read and confirmed missing before conditional creation'
)

for (const forbiddenPattern of [
  "this.request('PATCH', '/config/apps/http'",
  "postErrorMsg.includes('404')",
  'POST 失败，可能服务器不存在'
]) {
  assert.ok(
    !caddyClientSource.includes(forbiddenPattern),
    `Caddy route guard forbids unsafe fallback: ${forbiddenPattern}`
  )
}

assert.doesNotMatch(
  caddyClientSource,
  /rejectUnauthorized\s*:\s*false/,
  'credentialed Caddy management requests must never disable TLS certificate verification'
)

await import('./test-agent-tunnel.js')

const deleteSiteSource = caddyClientSource.slice(caddyClientSource.indexOf('async deleteSite('), caddyClientSource.indexOf('async getSites('))
assert.ok(
  caddyClientSource.includes("Buffer.from(domain).toString('base64url')") &&
    deleteSiteSource.includes("domain.replace(/\\./g, '-')") &&
    deleteSiteSource.includes("await this.request<CaddyRoute>('GET', `/id/${routeId}`)") &&
    deleteSiteSource.includes('route.match[0].host.length !== 1') &&
    deleteSiteSource.includes('route.match[0].host[0] !== domain') &&
    deleteSiteSource.indexOf('route.match[0].host[0] !== domain') < deleteSiteSource.indexOf("await this.request('DELETE'"),
  'Caddy deletion must verify the exact domain before deleting either the encoded or colliding legacy route ID'
)
assert.ok(
  caddyClientSource.includes("method: 'GET' | 'POST' | 'PUT' | 'DELETE'") &&
    caddyClientSource.includes('getAddressFamily(normalizedTargetIp) === 6') &&
    caddyClientSource.includes('`[${normalizedTargetIp}]`'),
  'Caddy requests must use typed HTTP methods and bracket IPv6 upstream addresses'
)

console.log('proxy site route ID guard tests passed')
