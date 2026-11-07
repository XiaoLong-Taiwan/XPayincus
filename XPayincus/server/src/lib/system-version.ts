import { execFile } from 'child_process'
import { readFile } from 'fs/promises'
import { join, resolve } from 'path'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export interface VersionMetadata {
  version: string
  gitTag: string | null
  gitCommit: string | null
  buildTime: string | null
  deployedAt: string | null
  changelog: string[]
}

export interface AvailableUpdate {
  version: string
  commit: string | null
  date: string | null
  changelog: string[]
  ota: OtaReleaseInfo
}

export interface UpdateCheckResult {
  current: VersionMetadata
  latest: AvailableUpdate | null
  updates: AvailableUpdate[]
  updateAvailable: boolean
  repositoryAvailable: boolean
  repositoryError: string | null
}

const tagPattern = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

export interface OtaArtifactInfo {
  name: string
  platform: string
  arch: string
  url: string
  sha256: string
  size: number | null
}

export interface OtaReleaseInfo {
  manifestAvailable: boolean
  manifestUrl: string | null
  artifacts: OtaArtifactInfo[]
  error: string | null
}

interface GitHubReleaseAsset {
  name?: string
  size?: number
  browser_download_url?: string
}

interface GitHubReleaseResponse {
  assets?: GitHubReleaseAsset[]
  tag_name?: string
  name?: string
  body?: string
  draft?: boolean
  prerelease?: boolean
  published_at?: string
}

export function getProjectRoot(): string {
  return resolve(process.env.INCUDAL_APP_DIR || process.cwd())
}

export function isValidReleaseTag(value: string): boolean {
  if (!tagPattern.test(value)) return false
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(value)
  return match !== null && [match[4], match[5]].every((part, index) => part === undefined ||
    part.split('.').every(identifier => identifier.length > 0 &&
      (index === 1 || !/^\d+$/.test(identifier) || identifier === '0' || !identifier.startsWith('0'))))
}

export function compareReleaseTags(left: string, right: string): number {
  if (!isValidReleaseTag(left) || !isValidReleaseTag(right)) throw new Error('Invalid release tag')
  const parse = (tag: string) => tag.slice(1).split('+')[0]!.split(/-(.*)/s)
  const [leftCore, leftPre] = parse(left)
  const [rightCore, rightPre] = parse(right)
  const compareNumber = (a: string, b: string) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0)
  const leftParts = leftCore!.split('.')
  const rightParts = rightCore!.split('.')
  for (let index = 0; index < 3; index++) {
    const result = compareNumber(leftParts[index]!, rightParts[index]!)
    if (result) return result
  }
  if (leftPre === rightPre) return 0
  if (leftPre === undefined) return 1
  if (rightPre === undefined) return -1
  const a = leftPre.split('.')
  const b = rightPre.split('.')
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    if (a[index] === undefined) return -1
    if (b[index] === undefined) return 1
    const x = a[index]!
    const y = b[index]!
    if (x === y) continue
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    return nx && ny ? compareNumber(x, y) : nx !== ny ? nx ? -1 : 1 : x < y ? -1 : 1
  }
  return 0
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return null
  }
}

async function runGit(args: string[], cwd = getProjectRoot()): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      timeout: 30000,
      maxBuffer: 1024 * 1024
    })
    return stdout.trim()
  } catch {
    return null
  }
}

function getReleaseRepository(): string {
  const configured = process.env.SYSTEM_UPDATE_RELEASE_REPOSITORY?.trim() ||
    process.env.GITHUB_REPO?.trim() ||
    ''
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(configured) ? configured : 'XiaoLong-Taiwan/XPayincus'
}

export function getReleaseToken(): string | null {
  return process.env.SYSTEM_UPDATE_RELEASE_TOKEN ||
    process.env.GITHUB_TOKEN ||
    null
}

function normalizeOtaArtifact(input: unknown): OtaArtifactInfo | null {
  if (!input || typeof input !== 'object') return null
  const value = input as Partial<OtaArtifactInfo>
  const name = typeof value.name === 'string' ? value.name.trim() : ''
  const platform = typeof value.platform === 'string' ? value.platform.trim() : ''
  const arch = typeof value.arch === 'string' ? value.arch.trim() : ''
  const url = typeof value.url === 'string' ? value.url.trim() : ''
  const sha256 = typeof value.sha256 === 'string' ? value.sha256.trim().toLowerCase() : ''
  const size = typeof value.size === 'number' && Number.isSafeInteger(value.size) && value.size >= 0
    ? value.size
    : null

  if (!name || !platform || !arch || !url || !/^[a-f0-9]{64}$/.test(sha256)) return null
  return { name, platform, arch, url, sha256, size }
}

/**
 * 判断 URL 是否为可信的 GitHub Release 主机。
 * 仅对可信主机附带 release token，避免被构造的 release JSON 把凭证泄露到攻击者主机。
 */
export function isTrustedReleaseHost(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl)
    if (u.protocol !== 'https:') return false
    const host = u.hostname.toLowerCase()
    return host === 'github.com'
      || host === 'api.github.com'
      || host === 'codeload.github.com'
      || host === 'objects.githubusercontent.com'
      || host.endsWith('.githubusercontent.com')
  } catch {
    return false
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'xpayincus-online-update'
  }
  const token = getReleaseToken()
  if (token && isTrustedReleaseHost(url)) headers.authorization = `Bearer ${token}`

  const response = await fetch(url, { headers })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }
  return await response.json() as T
}

export async function getOtaReleaseInfo(tag: string): Promise<OtaReleaseInfo> {
  const repository = getReleaseRepository()
  const releaseApiUrl = `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`

  try {
    if (!isValidReleaseTag(tag)) throw new Error('Invalid release tag')
    const release = await fetchJson<GitHubReleaseResponse>(releaseApiUrl)
    if (release.tag_name !== tag || release.draft || release.prerelease) {
      throw new Error('Release tag/status mismatch')
    }
    const assets = Array.isArray(release.assets) ? release.assets : []
    const namedManifests = assets.filter(asset => asset.name === `xpayincus-panel-${tag}-ota-manifest.json`)
    const manifests = namedManifests.length > 0 ? namedManifests : assets.filter(asset => asset.name === 'ota-manifest.json')
    if (manifests.length > 1) throw new Error('Ambiguous OTA manifest assets')
    const manifestAsset = manifests[0]
    const manifestUrl = manifestAsset?.browser_download_url || null
    if (!manifestUrl) {
      return {
        manifestAvailable: false,
        manifestUrl: null,
        artifacts: [],
        error: 'GitHub Release 未提供 OTA manifest'
      }
    }

    const manifest = await fetchJson<{
      schemaVersion?: unknown
      product?: unknown
      releaseChannel?: unknown
      version?: unknown
      gitTag?: unknown
      artifacts?: unknown
    } | null>(manifestUrl)
    if (!manifest || manifest.schemaVersion !== 1 || manifest.product !== 'xpayincus' ||
      manifest.releaseChannel !== 'unified-v1' || manifest.version !== tag || manifest.gitTag !== tag ||
      !Array.isArray(manifest.artifacts)) {
      throw new Error('OTA manifest schema/product/channel/version/tag mismatch')
    }
    const panelEntries = manifest.artifacts.filter(input => {
      if (!input || typeof input !== 'object') return false
      const name = (input as { name?: unknown }).name
      return typeof name === 'string' && name.startsWith('xpayincus-panel-')
    })
    const artifacts = panelEntries
      .map(normalizeOtaArtifact)
      .filter((artifact): artifact is OtaArtifactInfo => artifact !== null)
      .filter(artifact => artifact.name === `xpayincus-panel-${tag}-${artifact.platform}-${artifact.arch}.tar.gz` &&
        artifact.platform === 'linux' && ['amd64', 'arm64'].includes(artifact.arch))
    if (artifacts.length === 0 || artifacts.length !== panelEntries.length ||
      new Set(artifacts.map(artifact => artifact.name)).size !== artifacts.length) {
      throw new Error('Missing or ambiguous panel tar artifacts')
    }
    for (const artifact of artifacts) {
      const matchingAssets = assets.filter(asset => asset.name === artifact.name)
      const expectedUrl = `https://github.com/${repository}/releases/download/${tag}/${artifact.name}`
      if (matchingAssets.length !== 1 || artifact.url !== expectedUrl ||
        matchingAssets[0]?.browser_download_url !== artifact.url) {
        throw new Error('Panel artifact does not match release asset')
      }
    }

    return {
      manifestAvailable: artifacts.length > 0,
      manifestUrl,
      artifacts,
      error: artifacts.length > 0 ? null : 'OTA manifest 中没有有效 artifact'
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      manifestAvailable: false,
      manifestUrl: null,
      artifacts: [],
      error: `读取 GitHub Release OTA manifest 失败: ${message}`
    }
  }
}

export async function isGitRepository(root = getProjectRoot()): Promise<boolean> {
  return (await runGit(['rev-parse', '--is-inside-work-tree'], root)) === 'true'
}

export function getRuntimePlatform(): string {
  return process.platform
}

export function getRuntimeArch(): string {
  if (process.arch === 'x64') return 'amd64'
  if (process.arch === 'arm64') return 'arm64'
  return process.arch
}

export function selectRuntimeArtifact(artifacts: OtaArtifactInfo[], tag?: string): OtaArtifactInfo | null {
  const platform = getRuntimePlatform()
  const arch = getRuntimeArch()
  const matches = artifacts.filter(artifact => {
    if (artifact.platform !== platform || artifact.arch !== arch) return false
    const prefix = 'xpayincus-panel-'
    const suffix = `-${platform}-${arch}.tar.gz`
    if (!artifact.name.startsWith(prefix) || !artifact.name.endsWith(suffix)) return false
    const artifactTag = artifact.name.slice(prefix.length, -suffix.length)
    return isValidReleaseTag(artifactTag) && (tag === undefined || artifactTag === tag)
  })
  return matches.length === 1 ? matches[0]! : null
}

export async function hasUsableOtaArtifact(tag: string): Promise<boolean> {
  if (!isValidReleaseTag(tag)) return false
  try {
    const ota = await getOtaReleaseInfo(tag)
    return ota.manifestAvailable && selectRuntimeArtifact(ota.artifacts, tag) !== null
  } catch {
    return false
  }
}

export async function canApplyUpdate(tag: string, root = getProjectRoot()): Promise<boolean> {
  if (!isValidReleaseTag(tag)) return false
  const current = await getCurrentVersionMetadata(root)
  if (!isValidReleaseTag(current.version) || compareReleaseTags(tag, current.version) <= 0) return false
  if (process.env.SYSTEM_UPDATE_APPLY_MODE?.trim().toLowerCase() === 'git') {
    return await isGitRepository(root)
  }
  if (await hasUsableOtaArtifact(tag)) return true
  return false
}

// 非 Git 部署下的版本发现：改用 GitHub Releases API，语义与 `git tag --list` 一致（只取正式 release tag）。
async function listReleaseTagsFromGitHub(): Promise<string[] | null> {
  const repository = getReleaseRepository()
  try {
    const releases = await fetchJson<GitHubReleaseResponse[]>(
      `https://api.github.com/repos/${repository}/releases?per_page=30`
    )
    if (!Array.isArray(releases)) return null
    return releases
      .filter(release => !release.draft && !release.prerelease)
      .map(release => String(release.tag_name || '').trim())
      .filter(tag => isValidReleaseTag(tag))
      .sort((left, right) => compareReleaseTags(right, left))
  } catch {
    return null
  }
}

function normalizeChangelog(input: unknown): string[] {
  if (Array.isArray(input)) {
    return input
      .map(item => String(item).trim())
      .filter(Boolean)
      .slice(0, 50)
  }
  if (typeof input === 'string') {
    return input
      .split(/\r?\n/)
      .map(line => line.replace(/^[-*]\s+/, '').trim())
      .filter(Boolean)
      .slice(0, 50)
  }
  return []
}

async function getPackageVersion(root: string): Promise<string> {
  const pkg = await readJsonFile<{ version?: string }>(join(root, 'package.json'))
  return pkg?.version || '0.0.0'
}

async function readVersionJson(root: string): Promise<Partial<VersionMetadata> | null> {
  return await readJsonFile<Partial<VersionMetadata>>(join(root, 'version.json'))
}

async function getTagChangelog(tag: string, root = getProjectRoot()): Promise<string[]> {
  const message = await runGit(['tag', '-l', tag, '--format=%(contents)'], root)
  const normalized = normalizeChangelog(message)
  if (normalized.length > 0) return normalized

  const log = await runGit(['log', '-1', '--pretty=%s', tag], root)
  return normalizeChangelog(log)
}

export async function getCurrentVersionMetadata(root = getProjectRoot()): Promise<VersionMetadata> {
  const versionJson = await readVersionJson(root)
  const gitTag = await runGit(['describe', '--tags', '--exact-match', 'HEAD'], root)
  const nearestTag = gitTag || await runGit(['describe', '--tags', '--abbrev=0'], root)
  const gitCommit = await runGit(['rev-parse', '--short=12', 'HEAD'], root)
  const packageVersion = await getPackageVersion(root)
  const version = versionJson?.version || gitTag || nearestTag || `v${packageVersion}`

  return {
    version,
    gitTag: versionJson?.gitTag || gitTag || nearestTag,
    gitCommit: versionJson?.gitCommit || gitCommit,
    buildTime: versionJson?.buildTime || null,
    deployedAt: versionJson?.deployedAt || null,
    changelog: normalizeChangelog(versionJson?.changelog).length > 0
      ? normalizeChangelog(versionJson?.changelog)
      : nearestTag ? await getTagChangelog(nearestTag, root) : []
  }
}

async function getTagDate(tag: string, root: string): Promise<string | null> {
  const date = await runGit(['log', '-1', '--format=%cI', tag], root)
  return date || null
}

async function getTagCommit(tag: string, root: string): Promise<string | null> {
  return await runGit(['rev-list', '-n', '1', '--abbrev-commit', '--abbrev=12', tag], root)
}

async function checkForUpdatesWithoutGit(current: VersionMetadata): Promise<UpdateCheckResult> {
  const tags = await listReleaseTagsFromGitHub()
  if (!tags) {
    return {
      current,
      latest: null,
      updates: [],
      updateAvailable: false,
      repositoryAvailable: false,
      repositoryError: '無法存取 GitHub Releases，暫時無法檢查 OTA 更新。請檢查伺服器到 api.github.com 的網路與倉庫授權後重試。'
    }
  }

  const buildAvailableUpdate = async (tag: string): Promise<AvailableUpdate> => ({
    version: tag,
    commit: null,
    date: null,
    changelog: [],
    ota: await getOtaReleaseInfo(tag)
  })
  const candidates = [...new Set(tags)].sort((left, right) => compareReleaseTags(right, left))
  let latest: AvailableUpdate | null = null
  const updates: AvailableUpdate[] = []

  for (const tag of candidates) {
    if (!isValidReleaseTag(current.version) || compareReleaseTags(tag, current.version) < 0) continue
    const update = await buildAvailableUpdate(tag)
    if (!update.ota.manifestAvailable) continue
    latest ??= update
    if (compareReleaseTags(tag, current.version) > 0) updates.push(update)
  }

  return {
    current,
    latest,
    updates,
    updateAvailable: updates.length > 0,
    repositoryAvailable: true,
    repositoryError: null
  }
}

export async function checkForUpdates(root = getProjectRoot()): Promise<UpdateCheckResult> {
  const current = await getCurrentVersionMetadata(root)
  if (process.env.SYSTEM_UPDATE_APPLY_MODE?.trim().toLowerCase() !== 'git' || !(await isGitRepository(root))) {
    return await checkForUpdatesWithoutGit(current)
  }

  await runGit(['fetch', '--tags', '--quiet'], root)
  const tagOutput = await runGit(['tag', '--list', 'v*', '--sort=-v:refname'], root)
  const tags = (tagOutput || '')
    .split(/\r?\n/)
    .map(tag => tag.trim())
    .filter(tag => isValidReleaseTag(tag))
    .sort((left, right) => compareReleaseTags(right, left))
    .slice(0, 30)

  const buildAvailableUpdate = async (tag: string): Promise<AvailableUpdate> => ({
    version: tag,
    commit: await getTagCommit(tag, root),
    date: await getTagDate(tag, root),
    changelog: await getTagChangelog(tag, root),
    ota: await getOtaReleaseInfo(tag)
  })
  let latest: AvailableUpdate | null = null
  const updates: AvailableUpdate[] = []

  for (const tag of tags) {
    if (!isValidReleaseTag(current.version) || compareReleaseTags(tag, current.version) < 0) continue
    const update = await buildAvailableUpdate(tag)
    latest ??= update
    if (compareReleaseTags(tag, current.version) > 0) updates.push(update)
  }

  return {
    current,
    latest,
    updates,
    updateAvailable: updates.length > 0,
    repositoryAvailable: true,
    repositoryError: null
  }
}
