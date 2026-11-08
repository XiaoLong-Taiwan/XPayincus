import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { buildPanelBackupTarArgs } from '../src/services/panel-backup.js'

const service = readFileSync(resolve(process.cwd(), 'src/services/panel-backup.ts'), 'utf8')
const routes = readFileSync(resolve(process.cwd(), 'src/routes/admin-panel-backups.ts'), 'utf8')
const compose = readFileSync(resolve(process.cwd(), '../deploy/compose/compose.yaml'), 'utf8')
const page = readFileSync(resolve(process.cwd(), '../client/src/views/admin/PanelBackupsView.vue'), 'utf8')
const entrypoint = readFileSync(resolve(process.cwd(), '../deploy/compose/api-entrypoint.sh'), 'utf8')
const dockerfile = readFileSync(resolve(process.cwd(), '../deploy/compose/Dockerfile'), 'utf8')

assert.ok(service.includes("createCipheriv('aes-256-gcm'") && service.includes('scrypt-32768-8-1'))
assert.ok(service.includes('mode: 0o600') && service.includes('chmod(BACKUP_DIRECTORY, 0o700)'))
assert.ok(service.includes('RETENTION_COUNT = 7') && service.includes('activeBackup'))
assert.ok(service.includes("'--format=custom'") && service.includes('finally') && service.includes('database.dump'))
assert.ok(service.includes('createGzip()') && service.includes('pipeline(tarStream, createGzip(), cipher, output'))
assert.ok(service.includes("'--no-owner'") && service.includes("'--no-acl'"))
assert.ok(service.includes("'postgres_password', 'jwt_secret', 'cookie_secret', 'encryption_key', 'admin_password'"))
assert.ok(service.includes("'/opt/incudal/server/certs'"))
assert.ok(routes.includes('app.requireAdmin') && routes.includes("claimOperationVerificationRequirement(user.id, 'backup_panel')"))
assert.ok(routes.includes("'Cache-Control', 'no-store, private'") && routes.includes('expiresIn: 60'))
assert.ok(compose.includes('source: ./.env') && compose.includes('target: /deployment/.env') && compose.includes('read_only: true'))
assert.ok(compose.includes('./backups:/opt/incudal/backups') && !compose.includes('/var/run/docker.sock'))
assert.ok(page.includes('operation-type="backup_panel"') && page.includes('passphraseConfirm') && page.includes('不包含 Incus VM'))
assert.ok(!service.includes('docker.sock') && !service.includes('data/postgres'))
assert.ok(entrypoint.includes('/opt/incudal/backups /run/incudal-backup /run/incudal-backup/secrets'))
assert.ok(entrypoint.includes('install -m 600 -o node -g node "/run/secrets/$secret_name" "/run/incudal-backup/secrets/$secret_name"'))
assert.ok(entrypoint.includes('install -m 600 -o node -g node /deployment/.env /run/incudal-backup/.env'))
assert.ok(dockerfile.includes('postgresql-client-16') && dockerfile.includes('signed-by=') && dockerfile.includes('pg_dump --version'))

const temporary = mkdtempSync(join(tmpdir(), 'panel-backup-tar-'))
const deployment = process.env.INCUDAL_CONTAINER_DEPLOYMENT
const secretsDirectory = process.env.PANEL_SECRETS_DIRECTORY
try {
  process.env.INCUDAL_CONTAINER_DEPLOYMENT = 'false'
  process.env.PANEL_SECRETS_DIRECTORY = join(temporary, 'secrets')
  mkdirSync(process.env.PANEL_SECRETS_DIRECTORY)
  mkdirSync(join(temporary, 'certs'))
  const dumpName = '.panel-backup-20261108T000000Z-123456abcdef.dump'
  writeFileSync(join(temporary, dumpName), 'database fixture')
  const secrets = ['postgres_password', 'jwt_secret', 'cookie_secret', 'encryption_key', 'admin_password']
  for (const name of secrets) writeFileSync(join(temporary, 'secrets', name), `fixture ${name}`)
  writeFileSync(join(temporary, '.env'), 'fixture environment')
  writeFileSync(join(temporary, 'certs', 'client.key'), 'fixture key')
  writeFileSync(join(temporary, 'certs', 'jwt_secret'), 'fixture cert with secret name')
  const args = buildPanelBackupTarArgs(temporary, dumpName)
  args.push('-C', temporary, '.env', 'certs/client.key', 'certs/jwt_secret')
  const tar = process.env.BACKUP_TEST_TAR || 'tar'
  const archive = spawnSync(tar, args, { maxBuffer: 1024 * 1024 })
  assert.equal(archive.status, 0, archive.stderr.toString())
  const listing = spawnSync(tar, ['-tf', '-'], { input: archive.stdout, encoding: 'utf8' })
  assert.equal(listing.status, 0, listing.stderr)
  assert.deepEqual(listing.stdout.trim().split(/\r?\n/), ['database.dump', ...secrets.map(name => `secrets/${name}`), '.env', 'certs/client.key', 'certs/jwt_secret'])
  for (const [name, content] of [['database.dump', 'database fixture'], ['.env', 'fixture environment'], ['certs/client.key', 'fixture key'], ...secrets.map(name => [`secrets/${name}`, `fixture ${name}`])]) {
    const extracted = spawnSync(tar, ['-xOf', '-', name!], { input: archive.stdout, encoding: 'utf8' })
    assert.equal(extracted.status, 0, extracted.stderr)
    assert.equal(extracted.stdout, content)
  }
} finally {
  rmSync(temporary, { recursive: true, force: true })
  if (deployment === undefined) delete process.env.INCUDAL_CONTAINER_DEPLOYMENT
  else process.env.INCUDAL_CONTAINER_DEPLOYMENT = deployment
  if (secretsDirectory === undefined) delete process.env.PANEL_SECRETS_DIRECTORY
  else process.env.PANEL_SECRETS_DIRECTORY = secretsDirectory
}

console.log('panel backup guard tests passed')
