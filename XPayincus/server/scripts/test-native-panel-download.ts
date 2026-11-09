import assert from 'node:assert/strict'
import { readFileSync, createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, rm, stat, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import ts from 'typescript'
import { fetchRelease, getOtaReleaseInfo } from '../src/lib/system-version.js'

const originalFetch = globalThis.fetch
const savedEnv = new Map(['SYSTEM_UPDATE_RELEASE_REPOSITORY', 'SYSTEM_UPDATE_RELEASE_TOKEN'].map(key => [key, process.env[key]]))
const root = await mkdtemp(join(tmpdir(), 'native-panel-download-'))
const tag = 'v1.1.0'
const base = `https://github.com/fixture/panel/releases/download/${tag}`
const api = 'https://api.github.com/repos/fixture/panel/releases/assets/'
const bytes = Buffer.from('panel fixture')
const panel = { name: `xpayincus-panel-${tag}-linux-amd64.tar.gz`, platform: 'linux', arch: 'amd64', url: `${base}/xpayincus-panel-${tag}-linux-amd64.tar.gz`, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }
const manifest = { schemaVersion: 1, product: 'xpayincus', releaseChannel: 'unified-v1', version: tag, gitTag: tag, artifacts: [{ ...panel, downloadUrl: 'https://attacker.example/injected' }] }
const assets = [
  { name: 'ota-manifest.json', browser_download_url: `${base}/ota-manifest.json`, url: `${api}11` },
  { name: panel.name, browser_download_url: panel.url, url: `${api}12`, size: bytes.length }
]
const source = readFileSync(new URL('../src/scripts/run-system-update-task.ts', import.meta.url), 'utf8')
const downloadSource = source.slice(source.indexOf('async function downloadArtifact('), source.indexOf('async function assertArtifactStaging('))
const compiled = ts.transpileModule(downloadSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
const download = new Function('mkdir', 'join', 'updateDownloadDir', 'taskId', 'log', 'fetchRelease', 'pipeline', 'Readable', 'createWriteStream', 'stat', 'sha256File', 'rm', `${compiled}; return downloadArtifact`)(
  mkdir, join, root, 1, async () => {}, fetchRelease, pipeline, Readable, createWriteStream, stat,
  async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex'), rm
) as (artifact: typeof panel & { downloadUrl?: string }) => Promise<string>

try {
  process.env.SYSTEM_UPDATE_RELEASE_REPOSITORY = 'fixture/panel'
  process.env.SYSTEM_UPDATE_RELEASE_TOKEN = 'fixture-panel-token'
  const requests: string[] = []
  let mode = 'ok'
  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    requests.push(url)
    const headers = new Headers(init?.headers)
    if (url.startsWith('https://api.github.com/')) assert.equal(headers.get('authorization'), 'Bearer fixture-panel-token')
    else assert.equal(headers.get('authorization'), null)
    if (url.endsWith(`/tags/${tag}`)) return Response.json({ tag_name: tag, assets })
    if (url === `${api}11`) {
      assert.equal(headers.get('accept'), 'application/octet-stream')
      if (mode === 'manifest403') return new Response(null, { status: 403 })
      return Response.json(manifest)
    }
    if (url === `${api}12`) {
      assert.equal(headers.get('accept'), 'application/octet-stream')
      if (mode === '403') return new Response(null, { status: 403 })
      if (mode === 'timeout') throw new DOMException('download timed out', 'TimeoutError')
      return new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/fixture/panel' } })
    }
    if (url.startsWith('https://release-assets.githubusercontent.com/')) {
      if (mode === 'body-timeout') return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(bytes.subarray(0, 2))
        setTimeout(() => controller.error(new DOMException('body timed out', 'TimeoutError')), 5)
      } }))
      return new Response(mode === 'oversize' ? Buffer.concat([bytes, bytes]) : bytes)
    }
    throw new Error('Unexpected download destination')
  }) as typeof fetch

  const ota = await getOtaReleaseInfo(tag, 'v1.0.8')
  assert.equal(ota.error, null)
  assert.equal(ota.artifacts[0]?.url, panel.url)
  assert.equal(ota.artifacts[0]?.downloadUrl, `${api}12`)
  const artifact = ota.artifacts[0]! as typeof panel & { downloadUrl?: string }
  assert.deepEqual(await readFile(await download(artifact)), bytes)
  await rm(join(root, `1-${panel.name}`))
  assert.ok(!requests.some(url => url.startsWith('https://github.com/')))
  for (const failure of ['403', 'timeout', 'body-timeout', 'oversize', 'sha', 'short']) {
    mode = failure
    await assert.rejects(download({ ...artifact, ...(failure === 'sha' ? { sha256: 'a'.repeat(64) } : {}), ...(failure === 'short' ? { size: bytes.length + 1 } : {}) }), /OTA artifact download\/verification failed:/)
    assert.deepEqual(await readdir(root), [])
  }
  mode = 'manifest403'
  assert.match((await getOtaReleaseInfo(tag, 'v1.0.8')).error!, /OTA manifest download: HTTP 403/)
  mode = 'ok'
  for (const invalid of ['https://attacker.example/asset', `${api}12?token=x`, 'https://api.github.com/repos/other/repo/releases/assets/12']) {
    assets[0]!.url = invalid
    assert.match((await getOtaReleaseInfo(tag, 'v1.0.8')).error!, /Invalid release asset API URL/)
  }
  const apply = source.slice(source.indexOf('async function applyArtifactUpdate('), source.indexOf('async function applyGitUpdate('))
  assert.ok(apply.indexOf('await downloadArtifact(artifact)') < apply.indexOf("await run('tar'"))
  assert.ok(apply.indexOf('await assertArtifactStaging(stagingDir)') < apply.indexOf('return await applyArtifactAtomic'))
  assert.ok(!downloadSource.includes('systemctl') && !downloadSource.includes('switchCurrentRelease'))
  globalThis.fetch = (async (_input, init) => {
    assert.ok(init?.signal)
    return await new Promise<Response>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Download deadline did not abort')), 1000)
      init.signal!.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(init.signal!.reason)
      }, { once: true })
    })
  }) as typeof fetch
  await assert.rejects(fetchRelease(`${api}12`, null, 'application/octet-stream', 10), { name: 'TimeoutError' })
  console.log('native Panel download guards passed')
} finally {
  globalThis.fetch = originalFetch
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await rm(root, { recursive: true, force: true })
}
