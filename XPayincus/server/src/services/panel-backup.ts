import { createCipheriv, createHash, randomBytes, scrypt as scryptCallback } from 'crypto'
import { createWriteStream } from 'fs'
import { chmod, mkdir, readdir, rename, rm, stat } from 'fs/promises'
import { basename, join } from 'path'
import { spawn } from 'child_process'
import { pipeline } from 'stream/promises'
import { createGzip } from 'zlib'

const BACKUP_DIRECTORY = process.env.PANEL_BACKUP_DIRECTORY || '/opt/incudal/backups'
const RETENTION_COUNT = 7
const MAX_PASSPHRASE_LENGTH = 1024
const activeDownloads = new Map<string, { expiresAt: number; file: string; userId: number }>()
let activeBackup = false
let latestTask: { status: 'running' | 'success' | 'failed'; startedAt: string; backup?: PanelBackupRecord } | null = null

export type PanelBackupRecord = {
  id: string
  createdAt: string
  size: number
  status: 'success'
}

export function getPanelBackupTask(): { status: 'idle' | 'running' | 'success' | 'failed'; startedAt?: string; backup?: PanelBackupRecord } {
  return latestTask || { status: 'idle' }
}

function backupFilePattern(name: string): boolean {
  return /^panel-backup-\d{8}T\d{6}Z-[a-f0-9]{12}\.xpb$/.test(name)
}

export async function listPanelBackups(): Promise<PanelBackupRecord[]> {
  await mkdir(BACKUP_DIRECTORY, { recursive: true, mode: 0o700 })
  const names = (await readdir(BACKUP_DIRECTORY)).filter(backupFilePattern).sort().reverse()
  const records: PanelBackupRecord[] = []
  for (const name of names) {
    const info = await stat(join(BACKUP_DIRECTORY, name))
    if (!info.isFile() || (info.mode & 0o077) !== 0) continue
    records.push({
      id: name.slice('panel-backup-'.length, -'.xpb'.length),
      createdAt: info.mtime.toISOString(),
      size: info.size,
      status: 'success'
    })
  }
  return records
}

function startPgDump(): { stream: NodeJS.ReadableStream; completed: Promise<void> } {
  const databaseUrl = new URL(process.env.DATABASE_URL || '')
  if (databaseUrl.protocol !== 'postgresql:' && databaseUrl.protocol !== 'postgres:') throw new Error('Invalid database configuration')
  const env = { ...process.env, PGPASSWORD: decodeURIComponent(databaseUrl.password) }
  const child = spawn('pg_dump', [
    '--host', databaseUrl.hostname,
    '--port', databaseUrl.port || '5432',
    '--username', decodeURIComponent(databaseUrl.username),
    '--dbname', decodeURIComponent(databaseUrl.pathname.slice(1)),
    '--format=custom',
    '--no-owner',
    '--no-acl'
  ], {
    stdio: ['ignore', 'pipe', 'ignore'],
    env
  })
  const completed = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolve() : reject(new Error('Database export failed')))
  })
  return { stream: child.stdout!, completed }
}

async function writeArchive(outputPath: string, passphrase: Buffer, tarStream: NodeJS.ReadableStream): Promise<void> {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = await new Promise<Buffer>((resolve, reject) => {
    scryptCallback(passphrase, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, derivedKey) => error ? reject(error) : resolve(derivedKey))
  })
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from('xpayincus-panel-backup-v1'))
  const header = Buffer.from(JSON.stringify({ format: 'xpayincus-panel-backup', version: 1, kdf: 'scrypt-32768-8-1', salt: salt.toString('base64'), iv: iv.toString('base64') }) + '\n')
  let output: ReturnType<typeof createWriteStream> | null = null
  try {
    output = createWriteStream(outputPath, { mode: 0o600, flags: 'wx' })
    const outputStream = output
    await new Promise<void>((resolve, reject) => {
      outputStream.write(Buffer.concat([Buffer.from('XPB1'), Buffer.from(header.length.toString(16).padStart(8, '0'), 'hex'), header]), error => error ? reject(error) : resolve())
    })
    await pipeline(tarStream, createGzip(), cipher, outputStream, { end: false })
    const tag = cipher.getAuthTag()
    await new Promise<void>((resolve, reject) => {
      output!.once('error', reject)
      output!.end(tag, resolve)
    })
  } finally {
    if (output && !output.closed) output.destroy()
    key.fill(0)
    passphrase.fill(0)
  }
}

export function startPanelBackup(passphrase: string): { started: true } {
  if (activeBackup) throw new Error('A panel backup is already running')
  if (passphrase.length < 16 || passphrase.length > MAX_PASSPHRASE_LENGTH) throw new Error('Passphrase must be 16 to 1024 characters')
  activeBackup = true
  latestTask = { status: 'running', startedAt: new Date().toISOString() }
  const secret = Buffer.from(passphrase, 'utf8')
  void createPanelBackup(secret).then(backup => {
    latestTask = { status: 'success', startedAt: latestTask?.startedAt || new Date().toISOString(), backup }
  }).catch(() => {
    latestTask = { status: 'failed', startedAt: latestTask?.startedAt || new Date().toISOString() }
  }).finally(() => {
    secret.fill(0)
  })
  return { started: true }
}

async function createPanelBackup(passphrase: Buffer): Promise<PanelBackupRecord> {
  const id = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}-${randomBytes(6).toString('hex')}`
  const partial = join(BACKUP_DIRECTORY, `.panel-backup-${id}.partial`)
  const dumpPath = join(BACKUP_DIRECTORY, `.panel-backup-${id}.dump`)
  const finalPath = join(BACKUP_DIRECTORY, `panel-backup-${id}.xpb`)
  try {
    await mkdir(BACKUP_DIRECTORY, { recursive: true, mode: 0o700 })
    await chmod(BACKUP_DIRECTORY, 0o700)
    for (const orphan of await readdir(BACKUP_DIRECTORY)) {
      if (/^\.panel-backup-\d{8}T\d{6}Z-[a-f0-9]{12}\.(dump|partial)$/.test(orphan)) await rm(join(BACKUP_DIRECTORY, orphan), { force: true })
    }
    const pgDump = startPgDump()
    const dumpPipeline = pipeline(pgDump.stream, createWriteStream(dumpPath, { mode: 0o600, flags: 'wx' }))
    await Promise.all([dumpPipeline, pgDump.completed])
    const args = buildPanelBackupTarArgs(BACKUP_DIRECTORY, basename(dumpPath))
    if (process.env.INCUDAL_CONTAINER_DEPLOYMENT === 'true') {
      args.push('-C', '/run/incudal-backup', '.env')
      const certDirectory = '/opt/incudal/server/certs'
      for (const name of await readdir(certDirectory)) {
        if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) continue
        const certPath = join(certDirectory, name)
        const info = await stat(certPath)
        if (info.isFile() && (info.mode & 0o077) === 0) args.push('-C', '/opt/incudal/server', `certs/${name}`)
      }
    }
    const tar = spawn('tar', args, { stdio: ['ignore', 'pipe', 'ignore'] })
    const tarCompleted = new Promise<void>((resolve, reject) => {
      tar.once('error', reject)
      tar.once('close', code => code === 0 ? resolve() : reject(new Error('Backup packaging failed')))
    })
    await Promise.all([writeArchive(partial, passphrase, tar.stdout!), tarCompleted])
    await chmod(partial, 0o600)
    await rename(partial, finalPath)
    const result = await stat(finalPath)
    const backups = await listPanelBackups()
    for (const old of backups.slice(RETENTION_COUNT)) await rm(join(BACKUP_DIRECTORY, `panel-backup-${old.id}.xpb`), { force: true })
    return { id, createdAt: result.mtime.toISOString(), size: result.size, status: 'success' }
  } catch (error) {
    await rm(partial, { force: true })
    await rm(finalPath, { force: true })
    throw error
  } finally {
    await rm(dumpPath, { force: true })
    activeBackup = false
  }
}

export function buildPanelBackupTarArgs(directory: string, dumpName: string): string[] {
  const args = ['-c', '-f', '-', '--mode=0600', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-C', directory, '--transform=s|^[.]panel-backup-[^/]*[.]dump$|database.dump|', dumpName]
  const secretsDirectory = process.env.INCUDAL_CONTAINER_DEPLOYMENT === 'true'
    ? '/run/incudal-backup/secrets'
    : process.env.PANEL_SECRETS_DIRECTORY || './secrets'
  for (const secret of ['postgres_password', 'jwt_secret', 'cookie_secret', 'encryption_key', 'admin_password']) {
    args.push(`--transform=s|^${secret}$|secrets/${secret}|`)
  }
  args.push('-C', secretsDirectory, 'postgres_password', 'jwt_secret', 'cookie_secret', 'encryption_key', 'admin_password')
  return args
}

export function createPanelBackupDownload(userId: number, id: string): string | null {
  if (!/^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$/.test(id)) return null
  for (const [key, value] of activeDownloads) if (value.expiresAt < Date.now()) activeDownloads.delete(key)
  const token = randomBytes(32).toString('base64url')
  const file = join(BACKUP_DIRECTORY, `panel-backup-${id}.xpb`)
  if (!backupFilePattern(basename(file))) return null
  if (userId <= 0) return null
  activeDownloads.set(createHash('sha256').update(token).digest('hex'), { expiresAt: Date.now() + 60_000, file, userId })
  return token
}

export async function consumePanelBackupDownload(userId: number, token: string): Promise<string | null> {
  const key = createHash('sha256').update(token).digest('hex')
  const entry = activeDownloads.get(key)
  activeDownloads.delete(key)
  if (!entry || entry.userId !== userId || entry.expiresAt < Date.now()) return null
  const info = await stat(entry.file).catch(() => null)
  return info?.isFile() && (info.mode & 0o077) === 0 ? entry.file : null
}
