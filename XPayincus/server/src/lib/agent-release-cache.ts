import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { assertAgentManifest } from './update-contract.js'
import { isValidReleaseTag } from './system-version.js'

export interface CachedAgentManifest {
  schemaVersion?: number
  minimumUpdaterVersion?: string
  version: string
  generatedAt?: string
  files: Record<string, { name: string; sha256: string; size?: number; gzip?: boolean }>
}

export const agentArtifactLimit = 64 * 1024 * 1024
const jsonLimit = 2 * 1024 * 1024

export function validateCachedAgentManifest(raw: unknown): CachedAgentManifest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid Agent manifest')
  assertAgentManifest(raw as Record<string, unknown>)
  const manifest = raw as CachedAgentManifest
  if (Object.keys(manifest.files).sort().join(',') !== 'linux-amd64,linux-arm64') throw new Error('Invalid Agent architecture set')
  for (const file of Object.values(manifest.files)) {
    if (file.size !== undefined && file.size > agentArtifactLimit) throw new Error('Agent artifact exceeds download limit')
  }
  return manifest
}

export async function readBoundedAgentResponse(response: Response, limit = agentArtifactLimit): Promise<Buffer> {
  if (!response.ok || !response.body) throw new Error(`Agent release HTTP ${response.status}`)
  const declared = response.headers.get('content-length')
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    await response.body.cancel()
    throw new Error('Agent response exceeds download limit')
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.byteLength
    if (size > limit) throw new Error('Agent response exceeds download limit')
    chunks.push(Buffer.from(chunk))
  }
  if (!size) throw new Error('Empty Agent response')
  return Buffer.concat(chunks)
}

function verifyBinary(binary: Buffer, file: CachedAgentManifest['files'][string]): void {
  if (!binary.length || binary.length > agentArtifactLimit || (file.size !== undefined && file.size !== binary.length)) {
    throw new Error('Agent artifact size mismatch')
  }
  if (createHash('sha256').update(binary).digest('hex') !== file.sha256.toLowerCase()) throw new Error('Agent artifact sha256 mismatch')
}

async function regularFile(path: string, limit: number): Promise<Buffer> {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.size <= 0 || stat.size > limit) throw new Error('Invalid local Agent cache file')
  return readFile(path)
}

export class AgentReleaseCache {
  private pending = new Map<string, Promise<CachedAgentManifest | null>>()
  private publications = new Map<string, Promise<CachedAgentManifest | null>>()

  constructor(private root: string, source: string) {
    if (!isAbsolute(root) || root.includes('\0')) throw new Error('Agent cache directory must be absolute')
    this.root = join(root, createHash('sha256').update(source).digest('hex'))
  }

  private async readVersion(version: string): Promise<CachedAgentManifest | null> {
    if (!isValidReleaseTag(version)) throw new Error('Invalid Agent cache version')
    const dir = join(this.root, version)
    try {
      const stat = await lstat(dir)
      if (!stat.isDirectory()) throw new Error('Invalid Agent cache directory')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    const manifest = validateCachedAgentManifest(JSON.parse((await regularFile(join(dir, 'manifest.json'), jsonLimit)).toString('utf8')))
    if (manifest.version !== version) throw new Error('Agent cache version mismatch')
    for (const file of Object.values(manifest.files)) verifyBinary(await regularFile(join(dir, file.name), agentArtifactLimit), file)
    return manifest
  }

  async current(): Promise<CachedAgentManifest | null> {
    let version: string
    try {
      version = (await regularFile(join(this.root, 'current'), 128)).toString('utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    const manifest = await this.readVersion(version)
    if (!manifest) throw new Error('Incomplete Agent cache publication')
    return manifest
  }

  async ensure(key: string, load: () => Promise<{
    manifest: unknown
    download: (file: CachedAgentManifest['files'][string]) => Promise<Buffer>
  } | null>, publishCurrent = false): Promise<CachedAgentManifest | null> {
    const pending = this.pending.get(key)
    if (pending) return pending
    const work = this.populate(key, load, publishCurrent)
    this.pending.set(key, work)
    try {
      return await work
    } finally {
      this.pending.delete(key)
    }
  }

  private async populate(key: string, load: Parameters<AgentReleaseCache['ensure']>[1], publishCurrent: boolean): Promise<CachedAgentManifest | null> {
    if (key !== 'latest') {
      const cached = await this.readVersion(key)
      if (cached) return cached
    }
    const release = await load()
    if (!release) return null
    const manifest = validateCachedAgentManifest(release.manifest)
    if (key !== 'latest' && key !== manifest.version) throw new Error('Agent release version mismatch')
    const pending = this.publications.get(manifest.version)
    if (pending) {
      await pending
      return this.publish(manifest, release.download, publishCurrent)
    }
    const work = this.publish(manifest, release.download, publishCurrent)
    this.publications.set(manifest.version, work)
    try {
      return await work
    } finally {
      this.publications.delete(manifest.version)
    }
  }

  private async publish(manifest: CachedAgentManifest, download: (file: CachedAgentManifest['files'][string]) => Promise<Buffer>, publishCurrent: boolean) {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    if (!(await lstat(this.root)).isDirectory()) throw new Error('Invalid Agent cache root')
    const stage = await mkdtemp(join(this.root, '.partial-'))
    const pointer = join(this.root, `.current-${randomUUID()}`)
    try {
      if (!await this.readVersion(manifest.version)) {
        for (const file of Object.values(manifest.files)) {
          const binary = await download(file)
          verifyBinary(binary, file)
          await writeFile(join(stage, file.name), binary, { flag: 'wx', mode: 0o600 })
        }
        await writeFile(join(stage, 'manifest.json'), JSON.stringify(manifest), { flag: 'wx', mode: 0o600 })
        try {
          await rename(stage, join(this.root, manifest.version))
        } catch (error) {
          if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code || '')) throw error
          const existing = await this.readVersion(manifest.version)
          if (!this.sameRelease(existing, manifest)) throw new Error('Agent cache publication conflict')
        }
      } else {
        const existing = await this.readVersion(manifest.version)
        if (!this.sameRelease(existing, manifest)) throw new Error('Agent release changed after caching')
      }
      if (publishCurrent) {
        await writeFile(pointer, manifest.version, { flag: 'wx', mode: 0o600 })
        await rename(pointer, join(this.root, 'current'))
      }
      return await this.readVersion(manifest.version)
    } finally {
      await rm(stage, { recursive: true, force: true })
      await rm(pointer, { force: true })
    }
  }

  private sameRelease(existing: CachedAgentManifest | null, manifest: CachedAgentManifest): boolean {
    const identity = (value: CachedAgentManifest | null) => value && [value.version, value.schemaVersion, value.minimumUpdaterVersion,
      ...['linux-amd64', 'linux-arm64'].map(platform => {
        const file = value.files[platform]!
        return [file.name, file.sha256.toLowerCase(), file.size, file.gzip ?? file.name.endsWith('.gz')]
      })]
    return JSON.stringify(identity(existing)) === JSON.stringify(identity(manifest))
  }

  async binary(version: string, name: string, sha256: string): Promise<Buffer | null> {
    const manifest = await this.readVersion(version)
    if (!manifest) return null
    const file = Object.values(manifest.files).find(file => file.name === name && file.sha256.toLowerCase() === sha256.toLowerCase())
    if (!file) throw new Error('Agent binary does not match cached manifest')
    const binary = await regularFile(join(this.root, version, file.name), agentArtifactLimit)
    verifyBinary(binary, file)
    return binary
  }
}
