import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const repoRoot = resolve(__dirname, '../..')

function readRepoFile(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8').replace(/\r\n/g, '\n')
}

const schema = readRepoFile('server/prisma/schema.prisma')
const app = readRepoFile('server/src/app.ts')
const serverSource = resolve(repoRoot, 'server/src')
const clientSource = resolve(repoRoot, 'client/src')

assert.ok(!schema.includes('ProxySite'), 'Prisma schema must not define ProxySite')
assert.ok(!schema.includes('siteLimit'), 'Prisma schema must not define legacy siteLimit fields')
assert.ok(!schema.includes('caddyEnabled'), 'Prisma schema must not define legacy Caddy fields')
assert.ok(!app.includes('proxy-sites'), 'server app must not register proxy site routes')
assert.ok(!existsSync(resolve(serverSource, 'routes/proxy-sites.ts')), 'proxy site route source must be removed')
assert.ok(!existsSync(resolve(serverSource, 'db/proxy-sites.ts')), 'proxy site database source must be removed')
assert.ok(!existsSync(resolve(serverSource, 'lib/caddy-client.ts')), 'Caddy client source must be removed')
assert.ok(!existsSync(resolve(clientSource, 'components/host/HostCaddyTab.vue')), 'Caddy host UI must be removed')
assert.ok(!existsSync(resolve(clientSource, 'components/instance/InstanceSitesTab.vue')), 'proxy site UI must be removed')

console.log('proxy sites removal guard checks passed')
