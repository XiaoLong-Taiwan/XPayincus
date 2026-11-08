import assert from 'node:assert/strict'
import { test } from 'node:test'
import { publication, docker } from './docker-release.mjs'

const sha = 'a'.repeat(40)
const env = { GITHUB_SHA: sha, IMAGE_TAG: 'v1.0.5', VERSION: 'v1.0.5' }
function fixture() {
  const registry = new Map()
  const writes = []
  const invoke = args => {
    if (args[0] === 'inspect') return registry.has(args[1]) ? JSON.stringify(registry.get(args[1])) : null
    const ref = args[2]
    const annotations = Object.fromEntries(args.filter(item => item.startsWith('index:')).map(item => {
      const [key, ...value] = item.slice(6).split('=')
      return [key, value.join('=')]
    }))
    const manifest = registry.get(args.at(-1)) || {
      manifests: ['amd64', 'arm64'].map(architecture => ({ digest: `sha256:${architecture}`, platform: { os: 'linux', architecture } })),
      annotations
    }
    registry.set(ref, structuredClone(manifest))
    writes.push(ref)
    return ''
  }
  return { registry, writes, run: publication(env, invoke, () => `sha256:${'b'.repeat(64)}`) }
}

test('publish creates both SHA indexes before version tags and retries without overwriting', () => {
  const { run, writes } = fixture()
  run.publish()
  assert.equal(writes.length, 4)
  assert.ok(writes.slice(0, 2).every(ref => ref.endsWith(`sha-${sha}`)))
  assert.ok(writes.slice(2).every(ref => ref.endsWith(':v1.0.5')))
  run.publish()
  assert.equal(writes.length, 4)
})

test('different commit, missing SHA evidence, and changed version index are rejected before writing', () => {
  for (const mutation of ['commit', 'missing', 'changed', 'platform']) {
    const { run, registry, writes } = fixture()
    run.publish()
    const ref = 'ghcr.io/xiaolong-taiwan/xpayincus-panel-web:v1.0.5'
    if (mutation === 'commit') registry.get(ref).annotations['org.opencontainers.image.revision'] = 'c'.repeat(40)
    if (mutation === 'missing') registry.delete(`ghcr.io/xiaolong-taiwan/xpayincus-panel-web:sha-${sha}`)
    if (mutation === 'changed') registry.get(ref).manifests[0].digest = 'sha256:changed'
    if (mutation === 'platform') registry.get(ref).manifests.pop()
    assert.throws(() => run.publish())
    assert.equal(writes.length, 4)
  }
})

test('partial publication can resume using existing SHA evidence', () => {
  const { run, registry, writes } = fixture()
  run.publish()
  registry.delete('ghcr.io/xiaolong-taiwan/xpayincus-panel-web:v1.0.5')
  run.publish()
  assert.equal(writes.length, 5)
})

test('invalid source SHA and mismatched version tag are rejected', () => {
  assert.throws(() => publication({ ...env, GITHUB_SHA: 'main' }))
  assert.throws(() => publication({ ...env, IMAGE_TAG: 'latest' }))
})

test('only registry missing-manifest errors allow creating new tags', () => {
  const result = stderr => () => ({ status: 1, stderr })
  for (const message of ['manifest unknown', 'ghcr.io/xiaolong-taiwan/xpayincus-api:v1.0.5: not found']) {
    assert.equal(docker(['inspect', 'image', '--raw'], result(message)), null)
  }
  for (const message of ['unauthorized: manifest unknown', 'denied', 'certificate not found', 'connection timeout', '503 Service Unavailable']) {
    assert.throws(() => docker(['inspect', 'image', '--raw'], result(message)))
  }
  assert.throws(() => docker(['create', '--tag', 'image'], result('manifest unknown')))
})
