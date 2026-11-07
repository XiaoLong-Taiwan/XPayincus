#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'

process.umask(0o077)
let output
let child
let interrupted = false
const tracked = []
const warnings = []
class ExportError extends Error {}
const fail = message => { throw new ExportError(message) }
const exists = name => {
  try { fs.lstatSync(name); return true } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}
const inside = (parent, name) => name === parent || name.startsWith(`${parent}${path.sep}`)
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const write = (name, data) => fs.writeFileSync(path.join(output, name), data, { flag: 'wx', mode: 0o600 })
const mkdir = name => fs.mkdirSync(path.join(output, name), { mode: 0o700 })

function fileHash(name) {
  const digest = crypto.createHash('sha256')
  const fd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    if (!fs.fstatSync(fd).isFile()) fail('雜湊來源必須為一般檔案。')
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let size
    while ((size = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) digest.update(buffer.subarray(0, size))
    return digest.digest('hex')
  } finally { fs.closeSync(fd) }
}

function parseArgs() {
  const options = { root: '/opt/incudal', archive: false }
  const names = new Map([
    ['--root', 'root'], ['--env-file', 'env'], ['--output', 'output'],
    ['--encryption-key-file', 'key']
  ])
  const seen = new Set()
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i]
    if (arg === '--help') {
      process.stdout.write('Usage: node export-legacy-host.mjs --output /private/new-export [--root /opt/incudal] [--env-file /absolute/.env] [--encryption-key-file /private/effective-key] [--archive]\n')
      return null
    }
    if (seen.has(arg)) fail('選項不可重複。')
    seen.add(arg)
    if (arg === '--archive') { options.archive = true; continue }
    if (!names.has(arg) || !process.argv[i + 1] || process.argv[i + 1].startsWith('--')) fail('未知選項或缺少選項值；請使用 --help。')
    const value = process.argv[++i]
    if (!path.isAbsolute(value) || /[\r\n\0]/.test(value)) fail('所有路徑必須為不含控制字元的絕對路徑。')
    options[names.get(arg)] = value
  }
  if (!options.output) fail('必須指定 --output，且目的目錄不可已存在。')
  return options
}

function regularBytes(name) {
  const fd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    if (!fs.fstatSync(fd).isFile()) fail('來源必須為一般檔案。')
    return fs.readFileSync(fd)
  } finally { fs.closeSync(fd) }
}

function capture(source, destination) {
  const resolved = fs.realpathSync(source)
  const bytes = regularBytes(resolved)
  write(destination, bytes)
  tracked.push({ source: resolved, digest: hash(bytes) })
  return bytes
}

function copyTree(source, destination) {
  const resolved = fs.realpathSync(source)
  if (inside(resolved, output) || inside(output, resolved)) fail('設定或憑證來源與輸出目錄重疊。')
  if (!fs.statSync(resolved).isDirectory()) fail('設定或憑證來源必須是目錄。')
  const entries = fs.readdirSync(resolved, { withFileTypes: true })
  mkdir(destination)
  for (const entry of entries) {
    const from = path.join(resolved, entry.name)
    const to = path.join(destination, entry.name)
    if (entry.isDirectory()) copyTree(from, to)
    else if (entry.isFile()) capture(from, to)
    else fail('設定或憑證目錄內含符號連結或特殊檔案；請另行確認並備份。')
  }
  tracked.push({ directory: resolved, entries: entries.map(entry => entry.name).sort().join('\0') })
}

function parseEnv(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '')
  const values = new Map()
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match) fail(`env 第 ${index + 1} 行不是支援的單行指派；未執行其內容。`)
    const [, key, tail] = match
    if (values.has(key)) fail(`env 第 ${index + 1} 行有重複欄位，請提供無歧義的私有 env 副本。`)
    let value
    if (tail.startsWith('"') || tail.startsWith("'")) {
      const quote = tail[0]
      const end = tail.indexOf(quote, 1)
      if (end < 0 || !/^\s*(?:#.*)?$/.test(tail.slice(end + 1))) fail(`env 第 ${index + 1} 行有不支援的引號或多行語法。`)
      value = tail.slice(1, end)
      if (quote === '"' && value.includes('\\')) fail(`env 第 ${index + 1} 行有不支援的跳脫語法；請提供已確認實際值的私有副本。`)
    } else {
      value = tail.replace(/\s+#.*$/, '').trimEnd()
      if (/[\s'"\\]/.test(value)) fail(`env 第 ${index + 1} 行有不支援的未加引號語法。`)
    }
    if (/[\r\n\0`]/.test(value) || /\$[({A-Za-z_]/.test(value)) fail(`env 第 ${index + 1} 行含插值或命令語法；工具不會展開或執行。`)
    values.set(key, value)
  }
  return values
}

function run(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    if (interrupted) return reject(new ExportError('操作已中斷。'))
    const log = fs.openSync(path.join(output, 'private-tool.log'), 'a', 0o600)
    child = spawn(command, args, { env, cwd: output, stdio: ['ignore', log, log] })
    fs.closeSync(log)
    child.once('error', () => { child = undefined; reject(new ExportError('無法啟動外部工具；請確認 PATH 與 PostgreSQL client 安裝。')) })
    child.once('close', code => {
      child = undefined
      if (code !== 0 || interrupted) reject(new ExportError('外部工具失敗或中斷；私有目錄保留未完成資料，請勿匯入。'))
      else resolve()
    })
  })
}

function connection(values) {
  let url
  try { url = new URL(values.get('DATABASE_URL')) } catch { fail('DATABASE_URL 缺失或格式無效。') }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hash) fail('僅支援 PostgreSQL URL。')
  const decode = value => decodeURIComponent(value)
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PG')))
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const database = decode(url.pathname.slice(1))
  const user = decode(url.username)
  const password = decode(url.password)
  if (!host || !database || !user || [host, database, user, password].some(value => /[\r\n\0]/.test(value))) fail('資料庫 URL 欄位無效。')
  Object.assign(env, { PGHOST: host, PGPORT: url.port || '5432', PGDATABASE: database, PGUSER: user, PGCONNECT_TIMEOUT: '15', PGAPPNAME: 'incudal-legacy-export' })
  const mapping = { sslmode: 'PGSSLMODE', sslrootcert: 'PGSSLROOTCERT', sslcert: 'PGSSLCERT', sslkey: 'PGSSLKEY', connect_timeout: 'PGCONNECT_TIMEOUT' }
  const ignored = new Set(['schema', 'connection_limit', 'pool_timeout', 'pgbouncer', 'statement_cache_size'])
  const seen = new Set()
  for (const [key, value] of url.searchParams) {
    if (seen.has(key) || /[\r\n\0]/.test(value)) fail('資料庫 URL 查詢參數重複或無效。')
    seen.add(key)
    if (ignored.has(key)) continue
    if (!Object.hasOwn(mapping, key)) fail('資料庫 URL 含不支援的連線參數；請先核對 libpq 語意。')
    if (['sslrootcert', 'sslcert', 'sslkey'].includes(key) && !path.isAbsolute(value)) fail('TLS 檔案路徑必須是絕對路徑。')
    env[mapping[key]] = value
  }
  if (password) {
    const escape = value => value.replaceAll('\\', '\\\\').replaceAll(':', '\\:')
    write('.pgpass', [host, env.PGPORT, database, user, password].map(escape).join(':') + '\n')
  } else write('.pgpass', '')
  env.PGPASSFILE = path.join(output, '.pgpass')
  return env
}

function inventory(directory = '') {
  const entries = []
  for (const item of fs.readdirSync(path.join(output, directory), { withFileTypes: true })) {
    const name = path.join(directory, item.name)
    if (item.isDirectory()) entries.push(...inventory(name))
    else if (!['INCOMPLETE', 'private-tool.log'].includes(name)) entries.push({ path: name.split(path.sep).join('/'), bytes: fs.statSync(path.join(output, name)).size, sha256: fileHash(path.join(output, name)) })
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path))
}

async function main() {
  const options = parseArgs()
  if (!options) return
  if (os.platform() !== 'linux') fail('此工具只供 Linux 宿主執行。')
  const root = fs.realpathSync(options.root)
  const current = path.join(root, 'current')
  const hadCurrent = exists(current)
  const app = hadCurrent ? fs.realpathSync(current) : root
  if (!fs.statSync(app).isDirectory()) fail('current 必須指向可讀的應用目錄。')
  const envPath = options.env || path.join(root, '.env')
  const bytes = regularBytes(fs.realpathSync(envPath))
  const values = parseEnv(bytes)
  const parent = fs.realpathSync(path.dirname(options.output))
  const target = path.join(parent, path.basename(options.output))
  const parentStat = fs.statSync(parent)
  if (parentStat.uid !== process.getuid() || (parentStat.mode & 0o077)) fail('輸出父目錄必須由執行帳號擁有，且權限為 0700。')
  if (inside(root, target) || inside(app, target) || inside(target, root) || inside(target, app)) fail('輸出必須位於舊部署與 current 來源樹之外。')
  if (exists(target)) fail('目的路徑已存在；拒絕覆寫。')
  fs.mkdirSync(target, { mode: 0o700 })
  output = target
  write('INCOMPLETE', '未完成，不可用於匯入。\n')
  mkdir('source')
  mkdir('secrets')
  write('source/legacy.env', bytes)
  tracked.push({ source: fs.realpathSync(envPath), digest: hash(bytes) })
  for (const [key, file] of [['JWT_SECRET', 'jwt_secret'], ['COOKIE_SECRET', 'cookie_secret'], ['ADMIN_PASSWORD', 'admin_password']]) {
    if (values.get(key)) write(`secrets/${file}`, values.get(key))
    else warnings.push(`缺少 ${key}；首次啟動前須人工確認舊版實際值或登入影響。`)
  }
  let encryptionKey = values.get('ENCRYPTION_KEY')
  if (options.key) {
    const override = regularBytes(fs.realpathSync(options.key))
    encryptionKey = new TextDecoder('utf-8', { fatal: true }).decode(override)
    tracked.push({ source: fs.realpathSync(options.key), digest: hash(override) })
  }
  if (!encryptionKey || /[\r\n\0]/.test(encryptionKey)) fail('缺少可確定的 ENCRYPTION_KEY；舊版須以 --encryption-key-file 提供經核對的實際加密字串（無換行）。')
  write('secrets/encryption_key', encryptionKey)
  for (const [label, base] of [['stable', root], ['active', app]]) {
    if (label === 'active' && root === app) continue
    for (const relative of ['server/certs', 'certs', 'config']) {
      const from = path.join(base, relative)
      if (exists(from)) copyTree(from, `source/${label}-${relative.replaceAll('/', '-')}`)
    }
  }
  mkdir('certs')
  for (const [key, name] of [['PANEL_CRT_PATH', 'client.crt'], ['PANEL_KEY_PATH', 'client.key']]) {
    const explicit = values.get(key)
    const candidates = explicit
      ? [path.resolve(app, explicit)]
      : [path.join(root, 'server/certs', name), path.join(app, 'server/certs', name), path.join(root, 'certs', name)]
    const selected = candidates.find(exists)
    if (selected) capture(selected, `certs/${name}`)
    else if (explicit) fail('明確指定的 Incus 憑證或私鑰不存在。')
    else warnings.push(`未找到 ${name}；須核對舊版 DB 自訂憑證路徑與 Incus 信任。`)
  }
  const startedAt = new Date().toISOString()
  const pgEnv = connection(values)
  try {
    await run('pg_dump', ['--format=custom', '--no-owner', '--no-acl', '--no-password', '--lock-wait-timeout=30s', '--file', path.join(output, 'database.dump')], pgEnv)
  } finally {
    fs.unlinkSync(path.join(output, '.pgpass'))
  }
  if (fs.statSync(path.join(output, 'database.dump')).size === 0) fail('資料庫備份為空。')
  await run('pg_restore', ['--list', path.join(output, 'database.dump')], pgEnv)
  for (const item of tracked) {
    if (item.directory) {
      if (fs.readdirSync(item.directory).sort().join('\0') !== item.entries) fail('匯出期間來源目錄改變；請重新匯出至新目錄。')
    } else if (fileHash(item.source) !== item.digest) fail('匯出期間來源設定或憑證改變；請重新匯出至新目錄。')
  }
  if (exists(current) !== hadCurrent || (hadCurrent && fs.realpathSync(current) !== app)) fail('匯出期間 current 改變；請重新匯出。')
  write('manifest.json', JSON.stringify({
    format: 'incudal-legacy-host-export-v1', layout: app === root ? 'flat' : 'current',
    root, app, envFile: fs.realpathSync(envPath), startedAt, finishedAt: new Date().toISOString(),
    databaseFormat: 'PostgreSQL custom', sourceStopped: false,
    warnings, files: inventory()
  }, null, 2) + '\n')
  write('COMPLETE', '資料庫一致性快照完成；檔案與資料庫不構成跨資源原子快照。\n')
  if (options.archive) {
    await run('tar', ['--create', '--gzip', '--file', path.join(output, 'migration.tar.gz'), '--', 'database.dump', 'source', 'secrets', 'certs', 'manifest.json', 'COMPLETE'])
    fs.chmodSync(path.join(output, 'migration.tar.gz'), 0o600)
    write('migration.tar.gz.sha256', `${fileHash(path.join(output, 'migration.tar.gz'))}  migration.tar.gz\n`)
  }
  if (interrupted) fail('操作已中斷。')
  fs.unlinkSync(path.join(output, 'INCOMPLETE'))
  process.stdout.write(`匯出完成；警告 ${warnings.length} 項，詳見私有 manifest.json。輸出含未加密密鑰與資料，請安全保存。\n`)
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { interrupted = true; child?.kill(signal) })
}

main().catch(error => {
  const message = error instanceof ExportError
    ? error.message : '檔案、URL 或系統操作失敗；請檢查存取權限與私有輸出。'
  process.stderr.write(`匯出失敗：${message}\n`)
  process.exitCode = 1
})
