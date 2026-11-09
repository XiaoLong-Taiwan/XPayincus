import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import ts from 'typescript'
import { AgentReleaseCache, readBoundedAgentResponse, validateCachedAgentManifest, agentArtifactLimit } from '../src/lib/agent-release-cache.js'
import { fetchRelease, readReleaseJson } from '../src/lib/system-version.js'
import { assertAgentManifest } from '../src/lib/update-contract.js'

const root = await mkdtemp(join(tmpdir(), 'agent-release-cache-'))
const originalFetch = globalThis.fetch
const route = readFileSync(new URL('../src/routes/agent.ts', import.meta.url), 'utf8')
const compose = readFileSync(new URL('../../deploy/compose/compose.yaml', import.meta.url), 'utf8')
assert.ok(compose.includes('INCUDAL_AGENT_CACHE_DIR: /opt/incudal/config/agent-cache'))
assert.ok(compose.includes('./config:/opt/incudal/config') && compose.includes('chown 1000:1000 /deployment/certs /deployment/config'))
const binary = Buffer.from('isolated-agent-fixture')
const digest = createHash('sha256').update(binary).digest('hex')
const fixture = (version = 'v1.2.3') => ({
  schemaVersion: 1, minimumUpdaterVersion: 'v1.0.3', version,
  files: Object.fromEntries(['amd64', 'arm64'].map(arch => [`linux-${arch}`, {
    name: `xpayincus-agent-${version}-linux-${arch}.gz`, sha256: digest, size: binary.length, gzip: true
  }]))
})
const env: Record<string, string> = { INCUDAL_AGENT_CACHE_DIR: root, INCUDAL_AGENT_RELEASE_REPOSITORY: 'fixture/agent', INCUDAL_AGENT_RELEASE_TOKEN: 'mock-only' }
function controller() {
  const helpers = ['sanitizeShortString', 'isRecord', 'isSha256'].map(name => {
    const match = route.match(new RegExp(`^function ${name}\\([\\s\\S]*?^}`, 'm'))
    assert.ok(match)
    return match[0]
  }).join('\n')
  const source = `${helpers}
const defaultAgentReleaseRepository = 'XiaoLong-Taiwan/XPayincus'
const githubApiBaseUrl = 'https://api.github.com'
const githubDownloadBaseUrl = 'https://github.com'
const agentReleaseCacheTtlMs = 300000
const agentBinaryDownloadLimitBytes = 67108864
const agentReleaseFetchTimeoutMs = 15000
const agentBinaryNamePattern = /^xpayincus-agent-v[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?-linux-(amd64|arm64)(?:\\.gz)?$/
const agentReleaseBinaryNamePattern = /^xpayincus-agent-v[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?-linux-(amd64|arm64)$/
let agentReleaseManifestCache = null, agentReleaseBinaryCache = null, diskAgentReleaseCache = null
${route.slice(route.indexOf('function getAgentReleaseRepository()'), route.indexOf('async function getLatestAgentVersion()'))}
return { manifest: readAgentUpgradeManifest, binary: downloadAgentReleaseBinary, repository: getAgentReleaseRepository, prefix: getAgentReleaseTagPrefix, latest: fetchLatestAgentRelease }
`
  const dependencies = { process: { env }, createHash, existsSync, readFileSync, statSync, isAbsolute, join, homedir, AgentReleaseCache, readBoundedAgentResponse, validateCachedAgentManifest, fetchRelease, readReleaseJson }
  return new Function(...Object.keys(dependencies), ts.transpile(source, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }))(...Object.values(dependencies)) as {
    manifest: () => Promise<ReturnType<typeof fixture>>
    repository: () => string
    prefix: () => string
    latest: () => Promise<{ tag_name?: string } | null>
    binary: (input: { version: string; name: string; expectedSha256: string }) => Promise<Buffer>
  }
}

let requests: string[] = []
let manifest: Record<string, unknown> = fixture()
let failArm = false
let redirect = false
let rawLegacy = false
function mock() {
  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    if (url.endsWith('/latest')) return new Response(null, { status: 404 })
    requests.push(url)
    assert.equal(init?.redirect, 'manual')
    assert.ok(init?.signal)
    const headers = new Headers(init?.headers)
    assert.equal(headers.get('authorization'), url.startsWith('https://api.github.com/') ? 'Bearer mock-only' : null)
    const assets = [
      ...(!rawLegacy ? [{ name: 'manifest.json', size: 100, url: 'https://api.github.com/repos/fixture/agent/releases/assets/manifest' }] : []),
      ...Object.values(fixture().files).map((file, i) => ({ ...file, name: rawLegacy ? file.name.slice(0, -3) : file.name, url: `https://api.github.com/repos/fixture/agent/releases/assets/${i}` }))
    ]
    if (url.endsWith('/releases')) return Response.json([{ tag_name: 'agent-v1.2.3', assets }])
    if (url.includes('/tags/')) return Response.json({ tag_name: 'agent-v1.2.3', assets })
    if (url.endsWith('/manifest')) return Response.json(manifest)
    if (redirect && url.startsWith('https://api.github.com/') && url.endsWith('/0')) return new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/fixture/0' } })
    if (failArm && url.endsWith('/1')) return new Response('failure', { status: 503 })
    return new Response(binary)
  }) as typeof fetch
}

try {
  delete env.INCUDAL_AGENT_RELEASE_REPOSITORY
  assert.equal(controller().repository(), 'XiaoLong-Taiwan/XPayincus')
  assert.equal(controller().prefix(), '')
  env.INCUDAL_RELEASE_REPOSITORY = 'fixture/unified'
  env.INCUDAL_AGENT_RELEASE_REPOSITORY = 'XiaoLong-Taiwan/XPayincus'
  assert.equal(controller().prefix(), '')
  env.INCUDAL_AGENT_RELEASE_REPOSITORY = 'fixture/unified'
  assert.equal(controller().prefix(), '')
  delete env.INCUDAL_RELEASE_REPOSITORY
  env.INCUDAL_AGENT_RELEASE_REPOSITORY = 'fixture/agent'
  assert.equal(controller().prefix(), 'agent-')
  env.INCUDAL_AGENT_RELEASE_TAG_PREFIX = ''
  assert.equal(controller().prefix(), '')
  delete env.INCUDAL_AGENT_RELEASE_TAG_PREFIX
  globalThis.fetch = (async input => {
    assert.ok(String(input).endsWith('/latest'))
    return Response.json({ tag_name: 'agent-v1.2.3', assets: Object.values(fixture().files) })
  }) as typeof fetch
  assert.equal((await controller().latest())?.tag_name, 'agent-v1.2.3')
  globalThis.fetch = (async () => Response.json({ tag_name: 'agent-v1.2.3-rc.1', prerelease: true, assets: [] })) as typeof fetch
  assert.equal(await controller().latest(), null)
  const semverRoot = join(root, 'semver')
  const semverCache = new AgentReleaseCache(semverRoot, 'fixture')
  for (const version of ['v1.2.3+build.001', 'v1.2.3-rc.1+build.002']) {
    const manifest = fixture(version)
    assertAgentManifest(manifest)
    assert.equal((await semverCache.ensure('latest', async () => ({ manifest, download: async () => binary }), true))?.version, version)
    const reloaded = new AgentReleaseCache(semverRoot, 'fixture')
    assert.equal((await reloaded.current())?.version, version)
    assert.deepEqual(await reloaded.binary(version, manifest.files['linux-amd64']!.name, digest), binary)
    assert.equal((await reloaded.ensure(version, async () => { throw new Error('cached version must not download') }))?.version, version)
  }
  const semverNamespace = (await readdir(semverRoot))[0]!
  for (const version of ['../escape', '..\\escape', '/escape', 'C:\\escape', 'v1.2.3+build/../../escape', 'v1.2.3+build\\..\\escape', 'v1.2.3+build%2fescape', 'v1.2.3+build\0escape', 'v01.2.3', 'v1.2.3-01', 'v1.2.3+build..1']) {
    assert.throws(() => assertAgentManifest(fixture(version)), /version/)
    let loaded = false
    await assert.rejects(semverCache.ensure(version, async () => { loaded = true; return null }), /version/)
    assert.equal(loaded, false)
    await assert.rejects(semverCache.binary(version, 'ignored', digest), /version/)
    await writeFile(join(semverRoot, semverNamespace, 'current'), version)
    await assert.rejects(semverCache.current(), /version/)
  }
  await rm(semverRoot, { recursive: true, force: true })
  mock()
  const first = controller()
  const results = await Promise.all(Array.from({ length: 8 }, () => first.manifest()))
  assert.equal(results[0]?.minimumUpdaterVersion, 'v1.0.3')
  assert.equal(requests.filter(url => url.endsWith('/releases')).length, 1)
  assert.equal(requests.filter(url => /assets\/[01]$/.test(url)).length, 2)
  const file = results[0]!.files['linux-amd64']!
  const input = { version: 'v1.2.3', name: file.name, expectedSha256: digest }
  const count = requests.length
  assert.deepEqual(await first.binary(input), binary)
  assert.equal(requests.length, count)
  globalThis.fetch = (async () => { throw new Error('offline') }) as typeof fetch
  const restarted = controller()
  assert.deepEqual(await restarted.binary(input), binary)
  assert.equal((await restarted.manifest()).version, 'v1.2.3')
  await assert.rejects(restarted.binary({ ...input, expectedSha256: 'a'.repeat(64) }), /manifest/)
  await assert.rejects(restarted.binary({ ...input, version: '../escape' }), /version/)

  const namespace = (await readdir(root))[0]!
  for (const [path, failure] of [['/releases', '403'], ['/manifest', '403'], ['/0', '403'], ['/manifest', '429'], ['/manifest', 'timeout'], ['/0', 'interrupted']] as const) {
    mock()
    const upstream = globalThis.fetch
    let failures = 0
    globalThis.fetch = (async (url, init) => {
      if (String(url).endsWith(path)) {
        failures++
        if (failure === 'timeout') throw new DOMException('mock timeout', 'TimeoutError')
        if (failure === 'interrupted') return new Response(new ReadableStream({ start(stream) { stream.error(new TypeError('terminated')) } }))
        return new Response('unavailable', { status: Number(failure) })
      }
      if (String(url).endsWith('/manifest')) return Response.json(fixture('v1.2.4'))
      const response = await upstream(url, init)
      if (String(url).endsWith('/releases')) {
        const releases = await response.json() as { tag_name: string; assets: { name: string }[] }[]
        releases[0]!.tag_name = 'agent-v1.2.4'
        for (const asset of releases[0]!.assets) asset.name = asset.name.replace('v1.2.3', 'v1.2.4')
        return Response.json(releases)
      }
      return response
    }) as typeof fetch
    assert.equal((await controller().manifest()).version, 'v1.2.3')
    assert.equal(failures, ['timeout', 'interrupted'].includes(failure) ? 2 : 1)
    assert.equal(await readFile(join(root, namespace, 'current'), 'utf8'), 'v1.2.3')
    assert.deepEqual((await readdir(join(root, namespace))).sort(), ['current', 'v1.2.3'])
  }
  mock()
  const upstream = globalThis.fetch
  let transient = 0
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith('/releases') && transient++ === 0) return new Response(null, { status: 503 })
    return upstream(url, init)
  }) as typeof fetch
  assert.equal((await controller().manifest()).version, 'v1.2.3')
  assert.equal(transient, 2)
  mock()
  const validUpstream = globalThis.fetch
  globalThis.fetch = (async (url, init) => String(url).endsWith('/manifest')
    ? Response.json({ ...fixture(), schemaVersion: 2 }) : validUpstream(url, init)) as typeof fetch
  await assert.rejects(controller().manifest(), /schemaVersion/)

  await writeFile(join(root, namespace, 'v1.2.3', file.name), 'tampered')
  await assert.rejects(controller().manifest(), /size|sha256/)

  for (const [label, change] of [
    ['schema', { schemaVersion: 2 }], ['minimum', { minimumUpdaterVersion: null }],
    ['version', { version: 'v9.9.9' }], ['size', { files: { ...fixture().files, 'linux-amd64': { ...file, size: agentArtifactLimit + 1 } } }],
    ['arch', { files: { ...fixture().files, 'linux-amd64': fixture().files['linux-arm64'] } }],
    ['sha', { files: { ...fixture().files, 'linux-amd64': { ...file, sha256: 'a'.repeat(64) } } }],
    ['path', { files: { ...fixture().files, 'linux-amd64': { ...file, name: '../escape' } } }]
  ] as const) {
    env.INCUDAL_AGENT_CACHE_DIR = join(root, label)
    manifest = { ...fixture(), ...change }
    mock()
    await assert.rejects(controller().manifest())
    const dirs = await readdir(env.INCUDAL_AGENT_CACHE_DIR).catch(() => [])
    for (const dir of dirs) assert.deepEqual(await readdir(join(env.INCUDAL_AGENT_CACHE_DIR, dir)), [])
  }

  env.INCUDAL_AGENT_CACHE_DIR = join(root, 'partial')
  manifest = fixture()
  failArm = true
  mock()
  await assert.rejects(controller().manifest(), /503/)
  const partialNamespace = (await readdir(env.INCUDAL_AGENT_CACHE_DIR))[0]!
  assert.deepEqual(await readdir(join(env.INCUDAL_AGENT_CACHE_DIR, partialNamespace)), [])
  failArm = false
  redirect = true
  mock()
  assert.equal((await controller().manifest()).version, 'v1.2.3')

  env.INCUDAL_AGENT_CACHE_DIR = join(root, 'mixed-concurrency')
  requests = []
  mock()
  const mixed = controller()
  await Promise.all([mixed.manifest(), mixed.binary(input)])
  assert.equal(requests.filter(url => /assets\/[01]$/.test(url)).length, 2)

  globalThis.fetch = (async () => new Response(null, { status: 302, headers: { location: 'https://attacker.example/file' } })) as typeof fetch
  await assert.rejects(fetchRelease('https://api.github.com/repos/fixture/agent/releases/assets/0', 'mock-only', undefined, 15000), /Untrusted/)

  env.INCUDAL_AGENT_CACHE_DIR = join(root, 'legacy')
  rawLegacy = true
  mock()
  assert.equal((await controller().manifest()).files['linux-amd64']!.gzip, false)
  rawLegacy = false

  env.INCUDAL_AGENT_CACHE_DIR = join(root, 'published-legacy')
  manifest = { version: 'v1.2.3', files: Object.fromEntries(Object.entries(fixture().files).map(([platform, entry]) => [platform, { name: entry.name, sha256: entry.sha256 }])) }
  mock()
  assert.equal((await controller().manifest()).schemaVersion, undefined)
  assert.equal((await controller().manifest()).minimumUpdaterVersion, undefined)

  const atomic = new AgentReleaseCache(join(root, 'atomic'), 'fixture')
  await atomic.ensure('latest', async () => ({ manifest: fixture(), download: async () => binary }), true)
  let downloaded = 0
  await assert.rejects(atomic.ensure('latest', async () => ({ manifest: fixture('v1.2.4'), download: async () => {
    if (++downloaded === 2) throw new Error('interrupted')
    return binary
  } }), true), /interrupted/)
  assert.equal((await atomic.current())?.version, 'v1.2.3')
  const atomicNamespace = (await readdir(join(root, 'atomic')))[0]!
  assert.deepEqual((await readdir(join(root, 'atomic', atomicNamespace))).sort(), ['current', 'v1.2.3'])

  env.INCUDAL_AGENT_RELEASE_REPOSITORY = '../escape'
  await assert.rejects(controller().manifest(), /repository/)
  env.INCUDAL_AGENT_RELEASE_REPOSITORY = 'fixture/agent'

  env.INCUDAL_AGENT_RELEASE_DIR = join(root, 'explicit')
  await assert.rejects(controller().manifest(), /ENOENT/)
  delete env.INCUDAL_AGENT_RELEASE_DIR
  await assert.rejects(readBoundedAgentResponse(new Response('12345'), 4), /limit/)
  await assert.rejects(readBoundedAgentResponse(new Response('x', { headers: { 'content-length': '999' } }), 4), /limit/)
  globalThis.fetch = (async (_input, init) => new Promise<Response>((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout fixture did not abort')), 1000)
    init!.signal!.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(init!.signal!.reason)
    }, { once: true })
  })) as typeof fetch
  await assert.rejects(fetchRelease('https://api.github.com/repos/fixture/agent/releases/assets/0', null, undefined, 10), /timeout/i)

  const local = join(root, 'local')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(local)
  const localManifest = fixture()
  await writeFile(join(local, 'manifest.json'), JSON.stringify(localManifest))
  for (const entry of Object.values(localManifest.files)) await writeFile(join(local, entry.name), binary)
  env.INCUDAL_AGENT_RELEASE_DIR = local
  globalThis.fetch = (async () => { throw new Error('local must not fetch') }) as typeof fetch
  const localController = controller()
  assert.equal((await localController.manifest()).minimumUpdaterVersion, 'v1.0.3')
  assert.deepEqual(await localController.binary(input), binary)
  await writeFile(join(local, 'manifest.json'), JSON.stringify({ ...localManifest, schemaVersion: 2 }))
  await assert.rejects(localController.binary(input), /schemaVersion/)
  assert.ok((await readFile(join(root, namespace, 'current'), 'utf8')) === 'v1.2.3')
} finally {
  globalThis.fetch = originalFetch
  await rm(root, { recursive: true, force: true })
}
console.log('agent persistent release cache tests passed')
