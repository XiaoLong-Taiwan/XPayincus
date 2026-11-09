import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '../..')
const read = (path: string): string => readFileSync(resolve(repoRoot, path), 'utf8').replace(/\r\n/g, '\n')
const route = read('server/src/routes/system-update.ts')
const compose = read('deploy/compose/compose.yaml')
const readme = read('deploy/compose/README.md')
const serverPackage = JSON.parse(read('server/package.json'))

function section(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex + start.length)
  assert.ok(startIndex >= 0 && endIndex > startIndex, `Missing section: ${start}`)
  return source.slice(startIndex, endIndex)
}

const api = section(compose, '\n  api:', '\n  user:')
assert.ok(api.includes("INCUDAL_CONTAINER_DEPLOYMENT: 'true'"), 'Compose API must explicitly identify container deployments')
const entry = read('deploy/compose/docker-compose.yml')
const envExample = read('deploy/compose/.env.example')
const cli = read('deploy/compose/panel.sh')
const edge = read('deploy/compose/edge-nginx.conf.template')
const tunnel = read('deploy/compose/tunnel-nginx.conf.template')
assert.equal(entry.trim(), 'include:\n  - path: ./compose.yaml', 'New entry must reference the sole legacy service definition')
assert.ok(!/^    ports:/m.test(api), 'API must remain private without published ports')
assert.ok(api.includes('container_name: incudal-panel-api') && !api.includes('replicas:'), 'API must remain a single fixed container')
assert.ok(compose.includes('127.0.0.1:${USER_PORT:-3000}:80') && compose.includes('127.0.0.1:${ADMIN_PORT:-3001}:80'), 'Dashboard and admin must default to loopback 3000 and 3001')
assert.ok(envExample.includes('USER_PORT=3000') && envExample.includes('ADMIN_PORT=3001') && envExample.includes('COMPOSE_PROFILES=nginx'), 'Environment example must retain the public entry defaults')
const nginx = section(compose, '\n  nginx:', '\n  tunnel-origin:')
const tunnelOrigin = section(compose, '\n  tunnel-origin:', '\n  cloudflared:')
const cloudflared = section(compose, '\n  cloudflared:', '\nnetworks:')
assert.ok(nginx.includes('profiles: [nginx]') && tunnelOrigin.includes('profiles: [cloudflare]') && cloudflared.includes('profiles: [cloudflare]'), 'Optional services must be profile gated')
assert.ok(!/^    ports:/m.test(tunnelOrigin) && !/^    ports:/m.test(cloudflared), 'Tunnel ingress must not publish host ports')
assert.ok(cloudflared.includes('--token-file, /run/secrets/cloudflare_tunnel_token') && cloudflared.includes('secrets:\n      - cloudflare_tunnel_token'), 'Tunnel token must be passed through a file secret')
assert.ok(compose.includes('file: ./secrets/cloudflare_tunnel_token') && !/TUNNEL_TOKEN[:=]|--token[, ]|\$\{[^}]*TOKEN/.test(compose + envExample + cli), 'Tunnel credentials must never be interpolated into configuration or arguments')
assert.ok(edge.includes('proxy_set_header X-Real-IP $remote_addr;') && tunnel.includes('proxy_set_header X-Real-IP $http_cf_connecting_ip;'), 'Each trusted ingress must overwrite client IP headers')
for (const source of [edge, tunnel]) {
  assert.ok(source.includes('proxy_pass http://user:80;') && source.includes('proxy_pass http://admin:80;'), 'Both ingress modes must route through the frontend boundary')
  assert.ok(source.includes('proxy_set_header Upgrade $http_upgrade;'), 'Ingress must preserve WebSocket upgrade')
}
for (const file of ['secrets', 'tls']) {
  assert.ok(read('deploy/compose/.gitignore').includes(`${file}/`), `${file} must remain ignored`)
  assert.ok(cli.includes(`--exclude=deploy/compose/${file}`), `Install must exclude private ${file} material`)
}
assert.ok(cli.includes('COMPOSE_PROFILES=%s') && cli.includes('BUILD_CONTEXT=%s') && cli.includes('COMPOSE_FILE=%s'), 'Init must write deployment settings without sourcing the env file')
assert.ok(!/^\s*(source|\.) .*\.env/m.test(cli), 'CLI must not execute the deployment env file')
assert.ok(cli.includes('--profile nginx --profile cloudflare stop nginx tunnel-origin cloudflared'), 'Mode changes must stop the previous ingress services')

assert.ok(!/^    build:/m.test(compose), 'Default deployment must only pull published images')
assert.match(api, /image: ghcr\.io\/xiaolong-taiwan\/xpayincus-api:v[0-9]+\.[0-9]+\.[0-9]+/)
assert.equal((compose.match(/image: ghcr\.io\/xiaolong-taiwan\/xpayincus-panel-web:v[0-9]+\.[0-9]+\.[0-9]+/g) || []).length, 2)
const up = section(cli, '\n  up)', '\n  down)')
assert.ok(up.includes('deployment_mode="${1:-pull}"') && up.includes('compose.build.yaml'))
assert.ok(up.includes('elif [[ -f "$base/compose.release.yaml" ]]; then\n      python3'), 'Official release deployments must retain digest validation')
assert.ok(up.includes('else\n      "${compose[@]}" pull --policy always\n    fi'), 'Manual deployments must pull existing Compose images without requiring adoption or build')
assert.ok(!up.includes('預設 pull 需要官方 compose.release.yaml'), 'Missing release overrides must not block pull')
const stop = up.indexOf('"${compose[@]}" stop user admin api')
const manualPull = up.indexOf('"${compose[@]}" pull --policy always\n')
assert.ok(stop >= 0 && manualPull >= 0 && manualPull < stop, 'Manual pull must succeed before stopping services')
for (const preparation of ['build api user admin', 'pull --ignore-buildable', 'resolve-images', 'pull --policy always api user admin', 'pull --policy missing --ignore-buildable db init', 'pull --policy missing nginx', 'pull --policy missing tunnel-origin cloudflared']) {
  assert.ok(up.indexOf(preparation) >= 0 && up.indexOf(preparation) < stop, `${preparation} must succeed before stopping services`)
}
assert.ok(up.includes('up -d --no-build --pull never --wait --wait-timeout 300'))
const webStartup = read('deploy/compose/web-entrypoint.sh')
assert.ok(webStartup.includes('grep -Eq') && webStartup.includes('mktemp') && webStartup.includes('mv -f'))
assert.ok(!/secret|token|password/i.test(webStartup), 'Runtime settings must contain public configuration only')
assert.ok(read('deploy/compose/Dockerfile.dockerignore').includes('!deploy/compose/web-entrypoint.sh'))
assert.ok(read('deploy/compose/Dockerfile').includes('/docker-entrypoint.d/40-panel-runtime.sh'))
assert.ok(read('deploy/compose/nginx.conf.template').includes('Cache-Control "no-store"'))
assert.ok(read('client/public/sw.js').includes("'/runtime-config.js'"))
const html = read('client/index.html')
assert.ok(html.indexOf('src="/runtime-config.js"') < html.indexOf('type="module"'))
const runtime = read('client/src/utils/runtime-config.ts')
for (const key of ['apiBaseUrl', 'customerBaseUrl', 'adminBaseUrl']) assert.ok(runtime.includes(`config?.${key}?.trim() || import.meta.env.VITE_`))
for (const file of ['client/src/api/index.ts', 'client/src/api/admin.ts', 'client/src/utils/api-url.ts']) {
  assert.ok(read(file).includes('import { API_BASE_URL }') && !read(file).includes('import.meta.env.VITE_API_BASE_URL'))
}

const policy = section(route, 'function getContainerUpdateError()', 'export default async function')
assert.ok(policy.includes("process.env.INCUDAL_CONTAINER_DEPLOYMENT === 'true'"), 'OTA policy must use the explicit deployment flag')
assert.ok(policy.includes(': null'), 'Host deployments must retain the existing OTA path')
assert.ok(policy.includes('Back up the database') && policy.includes('deploy/compose/panel.sh up'), 'Container rejection must explain the supported update procedure')
assert.ok(policy.includes('const error = getContainerUpdateError()') && policy.includes("reply.code(409).send({ error, code: 'CONTAINER_OTA_UNSUPPORTED' })"), 'Mutations must return a stable container OTA rejection')

const version = section(route, "fastify.get('/version'", "fastify.get('/check'")
assert.ok(version.includes('getCurrentVersionMetadata()') && !version.includes('requireHostSystemUpdate'), 'Version queries must remain available in containers')

const check = section(route, "fastify.get('/check'", "fastify.get('/tasks'")
assert.ok(check.includes('await checkForUpdates()') && check.includes('...result,'), 'Checks must preserve current and release metadata')
assert.ok(check.indexOf('...result,') < check.indexOf('repositoryAvailable: false'), 'Container capability must override the underlying repository probe')
assert.ok(check.includes('containerUpdateError ? { repositoryAvailable: false, repositoryError: containerUpdateError } : {}'), 'Only container checks must report OTA unavailable with its reason')
assert.ok(check.includes('canManageUpdates: await canManageSystemUpdates(getRequestUser(request))'), 'Management permissions must remain separate from deployment capability')

const start = section(route, "fastify.post<{ Body: StartUpdateBody }>('/start'", "fastify.post<{ Params: TaskParams }>('/tasks/:id/rollback'")
const rollback = route.slice(route.indexOf("fastify.post<{ Params: TaskParams }>('/tasks/:id/rollback'"))
for (const [name, body, operations] of [
  ['start', start, ['request.body.targetVersion.trim()', 'canApplyUpdate(targetVersion)', 'hasRunningSystemUpdateTask()', 'await mkdir(', 'await createSystemUpdateTask(', 'await startSystemUpdateWorker(']],
  ['rollback', rollback, ['parsePositiveId(request.params.id)', 'await getSystemUpdateTask(', 'hasRunningSystemUpdateTask()', 'await mkdir(', 'await startSystemUpdateWorker(', 'await markSystemUpdateTaskFinished(']]
] as const) {
  const guard = body.indexOf('if (!requireHostSystemUpdate(reply)) return')
  const auth = body.indexOf('if (!(await requireUpdateManager(request, reply))) return')
  assert.ok(auth >= 0 && guard > auth, `${name} must preserve management authorization before the container guard`)
  for (const operation of operations) {
    assert.ok(body.indexOf(operation) > guard, `${name} must reject containers before ${operation}`)
  }
}

const reads = section(route, "fastify.get('/tasks'", "fastify.post<{ Body: StartUpdateBody }>('/start'")
assert.ok(!reads.includes('requireHostSystemUpdate'), 'Task history and authorized logs must remain readable in containers')
assert.ok(readme.includes('INCUDAL_CONTAINER_DEPLOYMENT') && readme.includes('CONTAINER_OTA_UNSUPPORTED') && readme.includes('repositoryError'), 'Compose documentation must describe the flag and API behavior')
assert.ok(serverPackage.scripts['test:system-update-guards'].includes('pnpm test:system-update-container-guards'), 'Existing OTA guard entry point must include container guards')
assert.equal(serverPackage.scripts['test:system-update-container-guards'], 'node --import tsx scripts/test-system-update-container-guards.ts')

console.log('system update container guards passed')
