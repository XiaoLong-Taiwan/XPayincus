import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { artifactNames, composeImages, root, validateVersions } from './release-contract.mjs'

const version = validateVersions()
assert.equal(version, 'v1.0.16')
const images = composeImages(version)
const compose = fs.readFileSync(path.join(root, 'XPayincus/deploy/compose/compose.yaml'), 'utf8')
const build = fs.readFileSync(path.join(root, 'XPayincus/deploy/compose/compose.build.yaml'), 'utf8')
for (const image of Object.values(images)) assert.ok(compose.includes(`image: ${image}`))
assert.equal((build.match(new RegExp(`org.opencontainers.image.version: ${version.replaceAll('.', '\\.')}`, 'g')) || []).length, 2)
assert.ok(fs.readFileSync(path.join(root, 'XPayincus-Agent/cmd/incudal-agent/main.go'), 'utf8').includes(`var version = "${version}"`))
assert.deepEqual(images, {
  api: 'ghcr.io/xiaolong-taiwan/xpayincus-api:v1.0.16',
  user: 'ghcr.io/xiaolong-taiwan/xpayincus-panel-web:v1.0.16',
  admin: 'ghcr.io/xiaolong-taiwan/xpayincus-panel-web:v1.0.16'
})
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'xpayincus-compose-'))
function run(script, directory, success = true) {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', script), ...[directory].flat()], {
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
  const incoming = path.join(temporary, 'incoming')
  const group = path.join(incoming, 'build')
  fs.mkdirSync(group, { recursive: true })
  const content = Buffer.from('fixture artifact')
  const filesByArch = Object.fromEntries(['amd64', 'arm64'].map(arch => [`linux-${arch}`, {
    name: `xpayincus-agent-${version}-linux-${arch}.gz`,
    sha256: crypto.createHash('sha256').update(content).digest('hex'), size: content.length, gzip: true
  }]))
  for (const name of artifactNames(version)) {
    if (name.includes('dashboard-') || name.includes('zfs-builder-') || name.startsWith('xpayincus-compose-')) continue
    fs.writeFileSync(path.join(group, name), name === 'manifest.json' ? JSON.stringify({ version, files: filesByArch }) : content)
  }
  const duplicate = path.join(incoming, 'duplicate')
  fs.mkdirSync(duplicate)
  fs.copyFileSync(path.join(group, 'manifest.json'), path.join(duplicate, 'manifest.json'))
  run('collect-release-artifacts.mjs', [incoming, artifacts], false)
  fs.rmSync(duplicate, { recursive: true })
  fs.renameSync(path.join(group, 'manifest.json'), path.join(temporary, 'manifest.json'))
  run('collect-release-artifacts.mjs', [incoming, artifacts], false)
  fs.renameSync(path.join(temporary, 'manifest.json'), path.join(group, 'manifest.json'))
  fs.writeFileSync(path.join(group, `xpayincus-compose-${version}.tar.gz`), content)
  run('collect-release-artifacts.mjs', [incoming, artifacts], false)
  fs.unlinkSync(path.join(group, `xpayincus-compose-${version}.tar.gz`))
  run('collect-release-artifacts.mjs', [incoming, artifacts])
  run('collect-release-artifacts.mjs', [incoming, artifacts], false)
  for (const name of artifactNames(version).filter(name => !fs.existsSync(path.join(artifacts, name)))) {
    if (name === `xpayincus-compose-${version}.tar.gz`) continue
    fs.writeFileSync(path.join(artifacts, name), content)
  }
  run('generate-release-manifests.mjs', artifacts, false)
  run('package-compose-bundle.mjs', [source, artifacts])
  const bundleName = `xpayincus-compose-${version}.tar.gz`
  const bundleContent = fs.readFileSync(path.join(artifacts, bundleName))
  run('package-compose-bundle.mjs', [source, artifacts], false)
  assert.deepEqual(fs.readFileSync(path.join(artifacts, bundleName)), bundleContent)
  run('generate-release-manifests.mjs', artifacts)
  const manifest = JSON.parse(fs.readFileSync(path.join(artifacts, 'release-manifest.json'), 'utf8'))
  assert.equal(manifest.compose.defaultMode, 'pull')
  assert.equal(manifest.compose.buildOverride, 'XPayincus/deploy/compose/compose.build.yaml')
  assert.deepEqual(manifest.compose.images, images)
  assert.equal(manifest.compose.artifact, `xpayincus-dashboard-${version}-compose.tar.gz`)
  assert.equal(manifest.compose.bundle, bundleName)
  const bundle = manifest.artifacts.find(item => item.name === bundleName)
  assert.equal(bundle.sha256, crypto.createHash('sha256').update(bundleContent).digest('hex'))
  assert.equal(bundle.size, bundleContent.length)
  assert.equal(bundle.url, `https://github.com/fixture/repository/releases/download/${version}/${bundleName}`)
  const sums = fs.readFileSync(path.join(artifacts, 'SHA256SUMS'), 'utf8').trim().split('\n')
  assert.equal(sums.length, 16)
  for (const line of sums) {
    const [hash, name] = line.split('  ')
    assert.equal(hash, crypto.createHash('sha256').update(fs.readFileSync(path.join(artifacts, name))).digest('hex'))
  }
  assert.equal(fs.readFileSync(path.join(artifacts, `${bundleName}.sha256`), 'utf8'), `${bundle.sha256}  ${bundleName}\n`)
  for (const name of ['ota-manifest.json', `xpayincus-panel-${version}-ota-manifest.json`]) {
    const ota = JSON.parse(fs.readFileSync(path.join(artifacts, name), 'utf8'))
    assert.deepEqual(ota.artifacts.map(item => item.name).sort(), ['amd64', 'arm64'].map(arch => `xpayincus-panel-${version}-linux-${arch}.tar.gz`))
  }
  const bootstrap = manifest.artifacts.find(item => item.name === `xpayincus-compose-${version}.sh`)
  assert.equal(bootstrap.sha256, crypto.createHash('sha256').update(content).digest('hex'))
  assert.ok(fs.readFileSync(path.join(artifacts, 'SHA256SUMS'), 'utf8').includes(`${bootstrap.sha256}  ${bootstrap.name}`))
  assert.equal(fs.readdirSync(artifacts).length, 30)
  run('generate-release-manifests.mjs', artifacts, false)
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8')
  assert.ok(workflow.includes('bash scripts/package-dashboard-release.sh'))
  assert.ok(workflow.includes('-eq 30'))
  assert.ok(workflow.includes('test -s "xpayincus-compose-${VERSION}.tar.gz"'))
  assert.ok(workflow.includes('sha256sum --check SHA256SUMS'))
  assert.ok(workflow.includes('gh release create "$VERSION" ./*'))
  assert.ok(fs.readFileSync(path.join(root, 'scripts/package-dashboard-release.sh'), 'utf8').includes('node "$ROOT_DIR/scripts/package-compose-bundle.mjs" "$STAGING/source" "$DIST_DIR"'))
  console.log('Compose release contract and manifest fixtures passed')
} finally {
  fs.rmSync(temporary, { recursive: true, force: true })
}
