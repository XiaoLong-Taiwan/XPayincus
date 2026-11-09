import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { assertAgentManifest, assertManifestCompatibility } from '../src/lib/update-contract.js'
import { fetchRelease, getOtaReleaseInfo } from '../src/lib/system-version.js'

for (const schemaVersion of [null, '1', 0, 2, -1]) {
  assert.throws(() => assertManifestCompatibility({ schemaVersion }, 'v1.0.3', true))
}
assertManifestCompatibility({}, 'v1.0.3', true)
assertManifestCompatibility({ schemaVersion: 1, futureOptionalField: true }, 'v1.0.3')
for (const minimumUpdaterVersion of [null, '', 'v01.0.0', 'v1.0.4', 'v2.0.0']) {
  assert.throws(() => assertManifestCompatibility({ schemaVersion: 1, minimumUpdaterVersion }, 'v1.0.3'))
}
assertManifestCompatibility({ schemaVersion: 1, minimumUpdaterVersion: 'v1.0.3' }, 'v1.0.3')
const files = Object.fromEntries(['amd64', 'arm64'].map(arch => [`linux-${arch}`, {
  name: `xpayincus-agent-v1.1.0-linux-${arch}.gz`, sha256: 'a'.repeat(64), size: 100, gzip: true
}]))
const agent = { version: 'v1.1.0', files }
assertAgentManifest(agent)
assertAgentManifest({ ...agent, schemaVersion: 1, minimumUpdaterVersion: 'v2.0.0' })
assert.throws(() => assertAgentManifest({ ...agent, schemaVersion: 2 }))
for (const change of [{ name: files['linux-arm64']!.name }, { size: 0 }, { size: '100' }, { gzip: false }, { sha256: 'bad' }]) {
  assert.throws(() => assertAgentManifest({ ...agent, files: { ...files, 'linux-amd64': { ...files['linux-amd64'], ...change } } }))
}

const originalFetch = globalThis.fetch
const repository = process.env.SYSTEM_UPDATE_RELEASE_REPOSITORY
try {
  const agentRoute = readFileSync(new URL('../src/routes/agent.ts', import.meta.url), 'utf8')
  assert.ok(agentRoute.includes('published[0]?.url || published[0]?.browser_download_url'))
  assert.ok(agentRoute.includes("fetchRelease(url, process.env.INCUDAL_AGENT_RELEASE_TOKEN?.trim() || null, accept, agentReleaseFetchTimeoutMs)"))
  const requests: { url: string; headers: Headers }[] = []
  globalThis.fetch = (async (input, init) => {
    requests.push({ url: String(input), headers: new Headers(init?.headers) })
    assert.equal(init?.redirect, 'manual')
    return requests.length === 1
      ? new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/fixture/manifest.json' } })
      : new Response('{}')
  }) as typeof fetch
  await fetchRelease('https://api.github.com/repos/fixture/agent/releases/assets/123', 'fixture-agent-token', 'application/octet-stream')
  assert.equal(requests[0]!.headers.get('authorization'), 'Bearer fixture-agent-token')
  assert.equal(requests[0]!.headers.get('accept'), 'application/octet-stream')
  assert.equal(requests[1]!.headers.get('authorization'), null)
  requests.length = 0
  await fetchRelease('https://api.github.com/repos/fixture/agent/releases/assets/123', null)
  assert.equal(requests[0]!.headers.get('authorization'), null)
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    return new Response(null, { status: 302, headers: { location: 'https://attacker.example/payload' } })
  }) as typeof fetch
  await assert.rejects(fetchRelease('https://github.com/fixture/repo'), /Untrusted/)
  assert.equal(calls, 1)
  process.env.SYSTEM_UPDATE_RELEASE_REPOSITORY = 'fixture/repo'
  const tag = 'v1.1.0'
  const base = `https://github.com/fixture/repo/releases/download/${tag}`
  const panel = { name: `xpayincus-panel-${tag}-linux-amd64.tar.gz`, platform: 'linux', arch: 'amd64', sha256: 'a'.repeat(64), size: 100, url: `${base}/xpayincus-panel-${tag}-linux-amd64.tar.gz` }
  let manifest: Record<string, unknown> = { schemaVersion: 1, product: 'xpayincus', releaseChannel: 'unified-v1', version: tag, gitTag: tag, artifacts: [panel] }
  globalThis.fetch = (async input => new Response(JSON.stringify(String(input).startsWith('https://api.github.com/') ? {
    tag_name: tag, assets: [{ name: 'ota-manifest.json', browser_download_url: `${base}/ota-manifest.json` }, { name: panel.name, browser_download_url: panel.url, size: 100 }]
  } : manifest))) as typeof fetch
  assert.equal((await getOtaReleaseInfo(tag, 'v1.0.3')).manifestAvailable, true)
  for (const change of [{ minimumUpdaterVersion: 'v2.0.0' }, { schemaVersion: 2 }, { minimumUpdaterVersion: null }, { artifacts: [{ ...panel, size: 99 }] }]) {
    const saved = manifest
    manifest = { ...manifest, ...change }
    const result = await getOtaReleaseInfo(tag, 'v1.0.3')
    assert.equal(result.manifestAvailable, false)
    assert.ok(result.error)
    assert.deepEqual(result.artifacts, [])
    manifest = saved
  }
} finally {
  globalThis.fetch = originalFetch
  if (repository === undefined) delete process.env.SYSTEM_UPDATE_RELEASE_REPOSITORY
  else process.env.SYSTEM_UPDATE_RELEASE_REPOSITORY = repository
}
console.log('update manifest contract tests passed')
