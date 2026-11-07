import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { artifactNames, assertArtifacts, composeImages, validateVersions } from './release-contract.mjs'

const version = validateVersions()
const directory = path.resolve(process.argv[2] || 'dist/unified')
const repository = process.env.RELEASE_REPOSITORY || process.env.GITHUB_REPOSITORY
if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '')) throw new Error('Set RELEASE_REPOSITORY=owner/repository')
const base = `https://github.com/${repository}/releases/download/${encodeURIComponent(version)}`
const names = artifactNames(version)
assertArtifacts(directory, names)
const records = []
for (const name of names.sort()) {
  const file = path.join(directory, name)
  if (!fs.lstatSync(file).isFile()) throw new Error(`Not a regular artifact: ${name}`)
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  records.push({ name, sha256: hash.digest('hex'), size: fs.statSync(file).size, url: `${base}/${encodeURIComponent(name)}` })
}
const agent = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'))
if (agent.version !== version) throw new Error('Agent manifest version mismatch')
if (Object.keys(agent.files || {}).sort().join(',') !== 'linux-amd64,linux-arm64') throw new Error('Agent manifest architecture set mismatch')
for (const arch of ['amd64', 'arm64']) {
  const record = records.find(item => item.name === `xpayincus-agent-${version}-linux-${arch}.gz`)
  const entry = agent.files?.[`linux-${arch}`]
  if (entry?.name !== record.name || entry.sha256 !== record.sha256 || entry.size !== record.size || entry.gzip !== true) {
    throw new Error(`Agent manifest mismatch: ${arch}`)
  }
}
const buildTime = new Date().toISOString()
const ota = {
  schemaVersion: 1,
  product: 'xpayincus',
  releaseChannel: 'unified-v1',
  version,
  gitTag: version,
  gitCommit: (process.env.SOURCE_COMMIT || process.env.GITHUB_SHA || '').slice(0, 12),
  buildTime,
  minimumUpdaterVersion: 'v0.0.3',
  changelog: [`Unified Server/Agent ${version} build`],
  artifacts: records.filter(item => item.name.startsWith('xpayincus-panel-')).map(item => ({
    ...item, platform: 'linux', arch: item.name.includes('-amd64.') ? 'amd64' : 'arm64'
  }))
}
const outputs = new Map()
const json = value => JSON.stringify(value, null, 2) + '\n'
outputs.set('ota-manifest.json', json(ota))
outputs.set(`xpayincus-panel-${version}-ota-manifest.json`, json(ota))
outputs.set('release-manifest.json', json({
  schemaVersion: 1, product: 'xpayincus', releaseChannel: 'unified-v1', version, buildTime, artifacts: records,
  compose: {
    artifact: `xpayincus-dashboard-${version}-compose.tar.gz`,
    projectName: 'incudal-panel',
    override: 'XPayincus/deploy/compose/compose.release.yaml',
    defaultMode: 'pull',
    buildOverride: 'XPayincus/deploy/compose/compose.build.yaml',
    images: composeImages(version)
  },
  zfs: {
    status: 'source-only',
    kernelModulesBuilt: false,
    requirements: ['Debian', 'root', 'matching target kernel headers', 'ZFS DKMS source', 'matching architecture'],
    note: 'Builder source is not a prebuilt kernel module. Build and verify on a dedicated Debian host for each kernel ABI. Secure Boot may require module signing.'
  },
  rfw: { requirements: ['Linux kernel 5.15+ with XDP support', 'root or appropriate capabilities', 'XDP-capable network interface'] }
}))
for (const record of records) outputs.set(`${record.name}.sha256`, `${record.sha256}  ${record.name}\n`)
const checksums = records.map(item => `${item.sha256}  ${item.name}`)
for (const [name, content] of outputs) {
  if (name.endsWith('.json')) checksums.push(`${crypto.createHash('sha256').update(content).digest('hex')}  ${name}`)
}
outputs.set('SHA256SUMS', checksums.sort().join('\n') + '\n')
for (const name of outputs.keys()) {
  if (fs.existsSync(path.join(directory, name))) throw new Error(`Refusing to overwrite: ${name}`)
}
for (const [name, content] of outputs) fs.writeFileSync(path.join(directory, name), content, { flag: 'wx' })
assertArtifacts(directory, [...names, ...outputs.keys()])
