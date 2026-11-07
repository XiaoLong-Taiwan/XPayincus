import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { artifactNames, composeImages, root, validateVersions } from './release-contract.mjs'

const version = validateVersions()
assert.equal(version, 'v1.0.2')
const images = composeImages(version)
assert.deepEqual(images, {
  api: 'ghcr.io/xiaolong-taiwan/xpayincus-api:v1.0.2',
  user: 'ghcr.io/xiaolong-taiwan/xpayincus-panel-web:v1.0.2',
  admin: 'ghcr.io/xiaolong-taiwan/xpayincus-panel-web:v1.0.2'
})
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'xpayincus-compose-'))
function run(script, directory, success = true) {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', script), directory], {
    encoding: 'utf8', env: { ...process.env, RELEASE_REPOSITORY: 'fixture/repository' }
  })
  if (success) assert.equal(result.status, 0, result.stderr)
  else assert.notEqual(result.status, 0)
}
try {
  const source = path.join(temporary, 'source')
  const prepare = fs.readFileSync(path.join(root, 'scripts/prepare-compose-release.mjs'), 'utf8')
  const files = [...prepare.split('for (const file of [')[1].split(']) {')[0].matchAll(/'([^']+)'/g)].map(match => match[1])
  for (const file of ['VERSION', ...files.map(file => `XPayincus/${file}`)]) {
    const target = path.join(source, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(path.join(root, file), target)
  }
  run('prepare-compose-release.mjs', source)
  const override = path.join(source, 'XPayincus/deploy/compose/compose.release.yaml')
  assert.deepEqual(JSON.parse(fs.readFileSync(override, 'utf8')), {
    services: Object.fromEntries(Object.entries(images).map(([service, image]) => [service, { image }]))
  })
  const original = fs.readFileSync(override, 'utf8')
  run('prepare-compose-release.mjs', source, false)
  assert.equal(fs.readFileSync(override, 'utf8'), original)
  const artifacts = path.join(temporary, 'artifacts')
  fs.mkdirSync(artifacts)
  const content = Buffer.from('fixture artifact')
  const filesByArch = Object.fromEntries(['amd64', 'arm64'].map(arch => [`linux-${arch}`, {
    name: `xpayincus-agent-${version}-linux-${arch}.gz`,
    sha256: crypto.createHash('sha256').update(content).digest('hex'), size: content.length, gzip: true
  }]))
  for (const name of artifactNames(version)) {
    fs.writeFileSync(path.join(artifacts, name), name === 'manifest.json' ? JSON.stringify({ version, files: filesByArch }) : content)
  }
  run('generate-release-manifests.mjs', artifacts)
  const manifest = JSON.parse(fs.readFileSync(path.join(artifacts, 'release-manifest.json'), 'utf8'))
  assert.equal(manifest.compose.defaultMode, 'pull')
  assert.equal(manifest.compose.buildOverride, 'XPayincus/deploy/compose/compose.build.yaml')
  assert.deepEqual(manifest.compose.images, images)
  assert.equal(fs.readdirSync(artifacts).length, 26)
  console.log('Compose release contract and manifest fixtures passed')
} finally {
  fs.rmSync(temporary, { recursive: true, force: true })
}
