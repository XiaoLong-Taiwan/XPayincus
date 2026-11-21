import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const repoRoot = resolve(__dirname, '../..')
const migrationsDir = resolve(repoRoot, 'server/prisma/migrations')
const migrationNames = readdirSync(migrationsDir).filter(name => name.includes('remove_proxy_sites_and_legacy_site_limits'))

assert.equal(migrationNames.length, 1, 'exactly one proxy sites cleanup migration must exist')

const migration = readFileSync(
  resolve(migrationsDir, migrationNames[0], 'migration.sql'),
  'utf8'
).replace(/\r\n/g, '\n')

assert.ok(migration.includes('DROP TABLE IF EXISTS "proxy_sites"'), 'cleanup migration must drop proxy_sites')
assert.ok(migration.includes('DROP TYPE IF EXISTS "ProxySiteStatus"'), 'cleanup migration must drop ProxySiteStatus')
for (const column of ['caddy_enabled', 'caddy_username', 'caddy_password', 'caddy_port']) {
  assert.ok(migration.includes(`DROP COLUMN IF EXISTS "${column}"`), `cleanup migration must drop ${column}`)
}
for (const table of ['packages', 'instances', 'package_plans']) {
  assert.ok(migration.includes(`ALTER TABLE "${table}"`), `cleanup migration must alter ${table}`)
}
assert.ok(migration.includes('DROP COLUMN IF EXISTS "site_limit"'), 'cleanup migration must drop legacy site_limit columns')

console.log('proxy sites migration guard checks passed')
