import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = fileURLToPath(new URL('../', import.meta.url))
const numeric = '(0|[1-9][0-9]*)'
const identifier = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)'
const semver = new RegExp(`^v${numeric}\\.${numeric}\\.${numeric}(?:-${identifier}(?:\\.${identifier})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?![\\s\\S])`)

function readVersion(file) {
  const text = fs.readFileSync(path.join(root, file), 'utf8')
  const value = text.replace(/\r?\n$/, '')
  if (!semver.test(value)) throw new Error(`Invalid canonical vSemVer: ${file}`)
  return value
}

export function validateVersions() {
  validateSourceLayout()
  const version = readVersion('VERSION')
  for (const file of ['XPayincus/package.json', 'XPayincus/client/package.json', 'XPayincus/server/package.json', 'XPayincus/docs-site/package.json']) {
    if (JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')).version !== version.slice(1)) {
      throw new Error(`Version mismatch with root VERSION: ${file}`)
    }
  }
  for (const file of ['XPayincus-Agent/VERSION', 'XPayincus-Agent/components/zfs/VERSION']) {
    if (readVersion(file) !== version) throw new Error(`Version mismatch with root VERSION: ${file}`)
  }
  for (const crate of ['rfw', 'rfw-common', 'rfw-ebpf']) {
    const file = `XPayincus-Agent/components/rfw/${crate}/Cargo.toml`
    const text = fs.readFileSync(path.join(root, file), 'utf8')
    const section = text.split(/^\[package\]\s*$/m)[1]?.split(/^\[/m)[0]
    const versions = [...(section || '').matchAll(/^version\s*=\s*"([^"\r\n]+)"\s*(?:#.*)?$/gm)]
    if (versions.length !== 1 || versions[0][1] !== version.slice(1)) {
      throw new Error(`Version mismatch or unsupported package version: ${file}`)
    }
  }
  composeImageTag(version)
  return version
}

export function validateSourceLayout() {
  for (const directory of ['XPayincus-Agent/components/rfw', 'XPayincus-Agent/components/zfs']) {
    const entry = fs.lstatSync(path.join(root, directory))
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`Component must be a physical source directory: ${directory}`)
  }
  for (const directory of ['XPayincus-RFW', 'XPayincus-ZFS']) {
    try {
      fs.lstatSync(path.join(root, directory))
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    throw new Error(`Legacy component source directory must be removed: ${directory}`)
  }
}

export const composeImageTag = version => {
  const tag = version.replace('+', '_')
  if (tag.length > 128) throw new Error('Version exceeds Docker image tag length limit')
  return tag
}
export const composeImages = version => Object.fromEntries(['api', 'user', 'admin'].map(service => [service, `ghcr.io/xiaolong-taiwan/xpayincus-${service === 'api' ? 'api' : 'panel-web'}:${composeImageTag(version)}`]))

export function artifactNames(version) {
  const names = ['manifest.json', `xpayincus-zfs-builder-${version}-source.tar.gz`, `xpayincus-dashboard-${version}-compose.tar.gz`]
  for (const arch of ['amd64', 'arm64']) {
    names.push(`xpayincus-panel-${version}-linux-${arch}.tar.gz`)
    names.push(`xpayincus-agent-${version}-linux-${arch}`, `xpayincus-agent-${version}-linux-${arch}.gz`)
    names.push(`xpayincus-rfw-${version}-linux-${arch}`)
  }
  return names.sort()
}

export function assertArtifacts(directory, names) {
  const actual = fs.readdirSync(directory)
  const missing = names.filter(name => !actual.includes(name))
  const extra = actual.filter(name => !names.includes(name))
  if (missing.length || extra.length) throw new Error(`Artifact set mismatch; missing: ${missing.join(', ')}; unexpected: ${extra.join(', ')}`)
  for (const name of names) {
    if (!fs.lstatSync(path.join(directory, name)).isFile()) throw new Error(`Not a regular artifact: ${name}`)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${validateVersions()}\n`)
}
