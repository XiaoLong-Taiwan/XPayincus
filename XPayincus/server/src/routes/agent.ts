/**
 * 宿主机 Agent 路由
 * 负责 Agent 凭据签发、HMAC 鉴权和心跳上报。
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { Prisma } from '@prisma/client'
import { createHash, createHmac } from 'crypto'
import { Agent, request as undiciRequest } from 'undici'
import { existsSync, readFileSync, statSync } from 'fs'
import { isIP } from 'net'
import { dirname, isAbsolute, join } from 'path'
import { fileURLToPath } from 'url'
import { prisma } from '../db/prisma.js'
import { createLog, LogModule, LogResult } from '../db/logs.js'
import { decryptSensitiveData } from '../lib/security.js'
import {
  agentNonceTtlMs,
  createAgentBodyHash,
  isAgentTimestampFresh,
  isValidAgentSecret,
  readAgentAuthHeaders,
  validateAgentHeaders,
  verifyAgentSignature
} from '../lib/agent-auth.js'
import {
  consumeHostAgentInstallToken,
  issueHostAgentInstallToken,
  rotateHostAgentCredentials,
  type HostAgentRecord
} from '../lib/host-agent-credentials.js'
import { processAgentInstanceReport } from '../services/agent-instance-report.js'
import { clampAgentHeartbeatIntervalSeconds, deriveAgentStatus, getAgentHeartbeatIntervalSeconds } from '../lib/agent-status.js'
import { AgentReleaseCache, readBoundedAgentResponse, validateCachedAgentManifest } from '../lib/agent-release-cache.js'
import { homedir } from 'node:os'
import { compareReleaseTags, fetchRelease, isValidReleaseTag, readReleaseJson } from '../lib/system-version.js'
import { agentVersionStatus } from '../lib/agent-upgrade.js'
import { DurableAgentUpgradeRequests, ingestAgentHistory, readAgentHistory, serializeAgentHeartbeat } from '../services/agent-durable-state.js'
import { readPanelCertificatePair } from '../lib/incus/panel-certificate.js'
import { ingestAgentMonitoring, instanceMonitoringKeys, isMonitoringInstanceName, readAgentComponentEvents, readAgentInstanceHistory, readAgentInstanceTop, readAgentMonitoring, type InstanceMonitoringMetric } from '../services/agent-monitoring.js'

interface AgentCredentialsParams {
  hostId: string
}

interface AgentCredentialsBody {
  enabled?: boolean
}

interface AgentInstallCommandBody {
  enabled?: boolean
  baseUrl?: string
  binaryUrl?: string
  binarySha256?: string
}

interface AgentHeartbeatBody {
  version?: string
  capabilities?: string[]
  runtime?: Record<string, unknown>
  incus?: Record<string, unknown>
  instances?: Record<string, unknown>
  resources?: Record<string, unknown>
  metrics?: Record<string, unknown>
  components?: Record<string, unknown>
  upgradeStatus?: Record<string, unknown>
  history?: Record<string, unknown>
  monitoring?: Record<string, unknown>
}

interface AgentBinaryParams {
  name: string
}

interface AgentBinaryQuery {
  v?: string
  sha256?: string
}

interface AgentInstallTokenParams {
  token: string
}

interface AgentUpgradeManifestFile {
  name?: string
  sha256?: string
  size?: number
  gzip?: boolean
}

interface AgentUpgradeManifest {
  source?: 'local' | 'release' | 'cache'
  schemaVersion?: number
  minimumUpdaterVersion?: string
  version?: string
  generatedAt?: string
  files?: Record<string, AgentUpgradeManifestFile>
}

interface GitHubReleaseAsset {
  name?: string
  size?: number
  url?: string
  browser_download_url?: string
}

interface GitHubRelease {
  prerelease?: boolean
  draft?: boolean
  tag_name?: string
  name?: string
  published_at?: string
  assets?: GitHubReleaseAsset[]
}

interface AgentUpgradeInstruction {
  schemaVersion?: number
  minimumUpdaterVersion?: string
  platform?: string
  arch?: string
  error?: string
  available: boolean
  version?: string
  url?: string
  sha256?: string
  gzip?: boolean
  size?: number
}

const agentModel = prisma.hostAgent
const nonceModel = prisma.hostAgentNonce
const agentUpgradeRequests = new DurableAgentUpgradeRequests()
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const agentBinaryNamePattern = /^xpayincus-agent-v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?-linux-(amd64|arm64)(?:\.gz)?$/
const agentReleaseBinaryNamePattern = /^xpayincus-agent-v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?-linux-(amd64|arm64)$/
const defaultAgentReleaseRepository = 'XiaoLong-Taiwan/XPayincus'
const githubApiBaseUrl = 'https://api.github.com'
const githubDownloadBaseUrl = 'https://github.com'
const agentReleaseCacheTtlMs = 5 * 60 * 1000
const agentBinaryDownloadLimitBytes = 64 * 1024 * 1024
const agentReleaseFetchTimeoutMs = 15 * 1000
const maxAgentInstallUrlLength = 2048
let agentReleaseManifestCache: { expiresAt: number; manifest: AgentUpgradeManifest } | null = null
let agentReleaseBinaryCache: { expiresAt: number; binaries: Map<string, Buffer> } | null = null
let diskAgentReleaseCache: { key: string; cache: AgentReleaseCache } | null = null
const positiveRouteIdPattern = /^[1-9]\d*$/

function parsePositiveId(value: string): number | null {
  if (!positiveRouteIdPattern.test(value)) {
    return null
  }
  const id = Number(value)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

function sanitizeShortString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, maxLength) : null
}

function normalizeCapabilities(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  const uniqueCapabilities = new Set<string>()
  for (const item of value) {
    const capability = sanitizeShortString(item, 80)
    if (capability) {
      uniqueCapabilities.add(capability)
    }
    if (uniqueCapabilities.size >= 64) {
      break
    }
  }
  return Array.from(uniqueCapabilities)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function buildRequestPath(request: FastifyRequest): string {
  return request.url.split('?')[0] || request.url
}

function firstHeaderValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null
  }
  return value ?? null
}

function normalizeIpCandidate(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  let candidate = value.trim()
  if (!candidate) {
    return null
  }

  if (candidate.startsWith('[')) {
    const closingBracketIndex = candidate.indexOf(']')
    if (closingBracketIndex > 0) {
      candidate = candidate.slice(1, closingBracketIndex)
    }
  }

  const ipv4WithPort = candidate.match(/^(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?$/)
  if (ipv4WithPort) {
    candidate = ipv4WithPort[1]
  }

  if (candidate.startsWith('::ffff:')) {
    const mapped = candidate.slice(7)
    if (isIP(mapped)) {
      return mapped
    }
  }

  return isIP(candidate) ? candidate : null
}

function firstForwardedIp(request: FastifyRequest): string | null {
  const headerValues = [
    firstHeaderValue(request.headers['cf-connecting-ip']),
    firstHeaderValue(request.headers['true-client-ip']),
    firstHeaderValue(request.headers['x-real-ip']),
    firstHeaderValue(request.headers['x-forwarded-for'])
  ]

  for (const value of headerValues) {
    if (!value) {
      continue
    }
    for (const part of value.split(',')) {
      const ip = normalizeIpCandidate(part)
      if (ip) {
        return ip
      }
    }
  }

  return null
}

function isLocalOrPrivateIp(ip: string | null): boolean {
  if (!ip) {
    return false
  }

  if (ip === '::1' || ip === '127.0.0.1' || ip.startsWith('127.')) {
    return true
  }

  if (ip.startsWith('10.') || ip.startsWith('192.168.') || ip.startsWith('169.254.')) {
    return true
  }

  const parts = ip.split('.').map((part) => Number.parseInt(part, 10))
  if (parts.length === 4 && parts.every((part) => Number.isInteger(part))) {
    return parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31
  }

  const lowerIp = ip.toLowerCase()
  return lowerIp.startsWith('fc') || lowerIp.startsWith('fd') || lowerIp.startsWith('fe80:')
}

function getAgentHeartbeatIp(request: FastifyRequest): string {
  const directIp = normalizeIpCandidate(request.ip) ?? request.ip
  const forwardedIp = firstForwardedIp(request)
  const trustForwardedIp = process.env.AGENT_TRUST_FORWARDED_IP === 'true' || isLocalOrPrivateIp(directIp)

  return forwardedIp && trustForwardedIp ? forwardedIp : directIp
}

function normalizeBaseUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed) {
    return null
  }
  if (trimmed.length > maxAgentInstallUrlLength) {
    return null
  }

  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null
    }
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return null
  }
}

function normalizeAgentBinaryUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed || trimmed.length > maxAgentInstallUrlLength) {
    return null
  }

  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null
    }
    return parsed.toString()
  } catch {
    return null
  }
}

function derivePanelUrl(request: FastifyRequest, explicitBaseUrl?: string): string {
  const explicit = normalizeBaseUrl(explicitBaseUrl)
  if (explicit) {
    return explicit
  }

  const frontendUrl = normalizeBaseUrl(process.env.FRONTEND_URL?.split(',')[0])
  if (frontendUrl) {
    return frontendUrl
  }

  const refererBaseUrl = normalizeBaseUrl(firstHeaderValue(request.headers.origin) ?? firstHeaderValue(request.headers.referer))
  if (refererBaseUrl) {
    return refererBaseUrl
  }

  const forwardedProto = firstHeaderValue(request.headers['x-forwarded-proto'])?.split(',')[0]?.trim()
  const forwardedHost = firstHeaderValue(request.headers['x-forwarded-host'])?.split(',')[0]?.trim()
  const directHost = firstHeaderValue(request.headers.host)?.trim()
  const protocol = forwardedProto === 'https' || forwardedProto === 'http'
    ? forwardedProto
    : (request.protocol || 'http')
  const host = forwardedHost || directHost

  if (host) {
    return `${protocol}://${host}`
  }

  return 'https://incudal.com'
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function buildAgentInstallCommand(input: {
  panelUrl: string
  binaryUrl?: string | null
  binarySha256?: string | null
}): string {
  const envParts = [
    `INCUDAL_PANEL_URL=${shellEscape(input.panelUrl)}`
  ]

  const binaryUrl = input.binaryUrl?.trim()
  if (binaryUrl) {
    envParts.push(`INCUDAL_AGENT_BINARY_URL=${shellEscape(binaryUrl)}`)
    envParts.push(`INCUDAL_AGENT_BINARY_SHA256=${shellEscape(input.binarySha256 || '')}`)
  }

  return `curl -fsSL ${shellEscape(`${input.panelUrl}/api/agent/install.sh`)} | sudo env ${envParts.join(' ')} bash`
}

function buildAgentInstallConfig(input: {
  agentId: string
  agentSecret: string
}): string {
  return [
    `INCUDAL_AGENT_ID=${shellEscape(input.agentId)}`,
    `INCUDAL_AGENT_SECRET=${shellEscape(input.agentSecret)}`
  ].join('\n') + '\n'
}

function getAgentReleaseRepository(): string {
  const configured = process.env.INCUDAL_AGENT_RELEASE_REPOSITORY?.trim()
  const repository = configured || process.env.INCUDAL_RELEASE_REPOSITORY?.trim() || defaultAgentReleaseRepository
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(repository)) throw new Error('Invalid Agent release repository')
  return repository
}

function getAgentReleaseTagPrefix(): string {
  const configured = process.env.INCUDAL_AGENT_RELEASE_TAG_PREFIX
  if (configured !== undefined) {
    const prefix = configured.trim()
    if (!/^[A-Za-z0-9._-]{0,64}$/.test(prefix)) {
      throw new Error('Invalid Agent release tag prefix')
    }
    return prefix
  }
  const unifiedRepository = process.env.INCUDAL_RELEASE_REPOSITORY?.trim()
  const repository = getAgentReleaseRepository()
  return !process.env.INCUDAL_AGENT_RELEASE_REPOSITORY?.trim() ||
    repository === defaultAgentReleaseRepository || repository === unifiedRepository
    ? '' : 'agent-'
}

function getAgentReleaseTag(version: string): string {
  return `${getAgentReleaseTagPrefix()}${version}`
}

function getLocalAgentReleaseDir(): string | null {
  const dir = process.env.INCUDAL_AGENT_RELEASE_DIR?.trim()
  if (!dir) return null
  if (!isAbsolute(dir) || dir.includes('\0')) throw new Error('Agent local release directory must be absolute')
  return dir
}

function hashLocalFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function normalizeLocalAgentManifest(raw: unknown, releaseDir: string): AgentUpgradeManifest | null {
  if (!isRecord(raw)) {
    return null
  }
  const version = normalizeAgentBinaryVersion(raw.version)
  validateCachedAgentManifest(raw)
  const files = isRecord(raw.files) ? raw.files : null
  if (!version || !files) {
    return null
  }

  const manifest: AgentUpgradeManifest = {
    version,
    ...(raw.schemaVersion === 1 ? { schemaVersion: 1 } : {}),
    ...(typeof raw.minimumUpdaterVersion === 'string' ? { minimumUpdaterVersion: raw.minimumUpdaterVersion } : {}),
    generatedAt: sanitizeShortString(raw.generatedAt, 80) ?? new Date().toISOString(),
    files: {}
  }

  for (const platform of ['linux-amd64', 'linux-arm64'] as const) {
    const file = isRecord(files[platform]) ? files[platform] : null
    const name = sanitizeShortString(file?.name, 128)
    const sha256 = sanitizeShortString(file?.sha256, 128)?.toLowerCase()
    if (!file || !name || !agentBinaryNamePattern.test(name) || !isSha256(sha256)) {
      return null
    }

    const path = join(releaseDir, name)
    if (!existsSync(path)) {
      return null
    }
    const stat = statSync(path)
    if (!stat.isFile() || stat.size <= 0 || stat.size > agentBinaryDownloadLimitBytes ||
      (file.size !== undefined && file.size !== stat.size)) {
      return null
    }
    if (hashLocalFile(path) !== sha256) {
      return null
    }

    manifest.files![platform] = {
      name,
      sha256,
      size: stat.size,
      gzip: typeof file.gzip === 'boolean' ? file.gzip : name.endsWith('.gz')
    }
  }

  return manifest
}

async function readLocalAgentUpgradeManifest(): Promise<AgentUpgradeManifest | null> {
  const releaseDir = getLocalAgentReleaseDir()
  if (!releaseDir) {
    return null
  }

  try {
    const manifestPath = join(releaseDir, 'manifest.json')
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const manifest = normalizeLocalAgentManifest(raw, releaseDir)
    if (!manifest) throw new Error('Invalid local Agent manifest or artifact')
    return manifest
  } catch (error) {
    console.warn('[AgentRelease] Failed to read local Agent release manifest', error)
    throw error
  }
}

function getAgentReleaseApiUrl(): string {
  return `${githubApiBaseUrl}/repos/${getAgentReleaseRepository()}/releases`
}

function getAgentReleaseAssetUrl(tag: string, assetName: string): string {
  const repository = getAgentReleaseRepository()
  return `${githubDownloadBaseUrl}/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`
}

function assertTrustedAgentReleaseDownloadUrl(rawUrl: string): void {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error('Agent release download URL is invalid')
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || (parsed.port && parsed.port !== '443')) {
    throw new Error('Agent release download URL must use HTTPS')
  }

  const repository = getAgentReleaseRepository()
  const encodedRepositoryPath = `/${repository}/`
  if (parsed.hostname === 'api.github.com') {
    if (!parsed.pathname.startsWith(`/repos${encodedRepositoryPath}`)) {
      throw new Error('Agent release API URL repository is not trusted')
    }
    return
  }
  if (parsed.hostname === 'github.com') {
    if (!parsed.pathname.startsWith(encodedRepositoryPath)) {
      throw new Error('Agent release download URL repository is not trusted')
    }
    return
  }

  throw new Error('Agent release download URL host is not trusted')
}

function normalizeAgentReleaseVersion(tagName: string | undefined): string | null {
  const tag = sanitizeShortString(tagName, 128)
  const prefix = getAgentReleaseTagPrefix()
  if (!tag?.startsWith(prefix)) {
    return null
  }
  const version = tag.slice(prefix.length)
  return /^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(version) ? version : null
}

function normalizeAgentBinaryVersion(value: unknown): string | null {
  const version = sanitizeShortString(value, 128)
  return version && /^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(version) ? version : null
}

function agentApiBinaryNameToReleaseAssetName(name: string, version: string): string | null {
  if (['amd64', 'arm64'].some(arch => name === `xpayincus-agent-${version}-linux-${arch}.gz`)) return name
  if (name === `xpayincus-agent-${version}-linux-amd64`) {
    return `xpayincus-agent-${version}-linux-amd64`
  }
  if (name === `xpayincus-agent-${version}-linux-arm64`) {
    return `xpayincus-agent-${version}-linux-arm64`
  }
  return null
}

function releaseAssetNameToAgentPlatform(name: string, version: string): 'linux-amd64' | 'linux-arm64' | null {
  if (name === `xpayincus-agent-${version}-linux-amd64`) {
    return 'linux-amd64'
  }
  if (name === `xpayincus-agent-${version}-linux-arm64`) {
    return 'linux-arm64'
  }
  return null
}

async function readAgentReleaseResponse<T>(url: string, accept: string, read: (response: Response) => Promise<T>): Promise<T> {
  assertTrustedAgentReleaseDownloadUrl(url)
  for (let attempt = 0; attempt < 2; attempt++) {
    let response: Response
    try {
      response = await fetchRelease(url, process.env.INCUDAL_AGENT_RELEASE_TOKEN?.trim() || null, accept, agentReleaseFetchTimeoutMs)
    } catch (error) {
      if (error instanceof Error && /Untrusted|redirect/i.test(error.message)) throw error
      if (attempt === 0) continue
      throw new AgentReleaseNetworkError('Agent release connection failed')
    }
    if (!response.ok) {
      await response.body?.cancel()
      if (attempt === 0 && [502, 503, 504].includes(response.status)) continue
      throw new AgentReleaseNetworkError(`Agent release HTTP ${response.status}`)
    }
    try {
      return await read(response)
    } catch (error) {
      if (!(error instanceof Error) || !['AbortError', 'TimeoutError', 'TypeError'].includes(error.name)) throw error
      if (attempt === 0) continue
      throw new AgentReleaseNetworkError('Agent release response interrupted')
    }
  }
  throw new AgentReleaseNetworkError('Agent release unavailable')
}

async function fetchJsonFromGitHub<T>(url: string): Promise<T> {
  return readAgentReleaseResponse(url, 'application/vnd.github+json', response => readReleaseJson<T>(response))
}

async function fetchLatestAgentRelease(): Promise<GitHubRelease | null> {
  let latest: unknown
  try {
    latest = await fetchJsonFromGitHub<unknown>(`${getAgentReleaseApiUrl()}/latest`)
  } catch (error) {
    if (!(error instanceof AgentReleaseNetworkError) || !error.message.endsWith('404')) throw error
  }
  const releases = isRecord(latest) ? [latest] : await fetchJsonFromGitHub<unknown>(getAgentReleaseApiUrl())
  if (!Array.isArray(releases)) {
    return null
  }

  for (const release of releases) {
    if (!isRecord(release)) {
      continue
    }
    const version = normalizeAgentReleaseVersion(sanitizeShortString(release.tag_name, 128) ?? undefined)
    const assets = Array.isArray(release.assets) ? release.assets : []
    if (version && !version.includes('-') && !release.draft && !release.prerelease && ['amd64', 'arm64'].every(arch =>
      assets.some(asset => isRecord(asset) && (asset.name === `xpayincus-agent-${version}-linux-${arch}` || asset.name === `xpayincus-agent-${version}-linux-${arch}.gz`))
    )) {
      return release as GitHubRelease
    }
  }
  return null
}

async function fetchAgentReleaseAssetSha256(asset: GitHubReleaseAsset): Promise<string | null> {
  const downloadUrl = sanitizeShortString(asset.url, 2048) ?? sanitizeShortString(asset.browser_download_url, 2048)
  if (!downloadUrl) {
    return null
  }
  const binary = await readAgentReleaseResponse(downloadUrl, 'application/octet-stream', readBoundedAgentResponse)
  return createHash('sha256').update(binary).digest('hex')
}

async function readAgentUpgradeManifest(): Promise<AgentUpgradeManifest | null> {
  if (getLocalAgentReleaseDir()) {
    const local = await readLocalAgentUpgradeManifest()
    return local ? { ...local, source: 'local' } : null
  }
  if (agentReleaseManifestCache && agentReleaseManifestCache.expiresAt > Date.now()) {
    return agentReleaseManifestCache.manifest
  }

  const cache = getDiskAgentReleaseCache()
  const current = await cache.current()
  let manifest: AgentUpgradeManifest | null
  try {
    manifest = await cache.ensure('latest', () => loadRemoteAgentRelease(), true)
    if (manifest) manifest = { ...manifest, source: 'release' }
  } catch (error) {
    if (!(error instanceof AgentReleaseNetworkError) || !current) throw error
    manifest = { ...current, source: 'cache' }
  }
  if (manifest) agentReleaseManifestCache = { expiresAt: Date.now() + agentReleaseCacheTtlMs, manifest }
  return manifest
}

class AgentReleaseNetworkError extends Error {}

function getDiskAgentReleaseCache(): AgentReleaseCache {
  const root = process.env.INCUDAL_AGENT_CACHE_DIR?.trim() || join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'xpayincus-agent')
  const source = `${getAgentReleaseRepository()}:${getAgentReleaseTagPrefix()}`
  const key = `${root}:${source}`
  if (!diskAgentReleaseCache || diskAgentReleaseCache.key !== key) diskAgentReleaseCache = { key, cache: new AgentReleaseCache(root, source) }
  return diskAgentReleaseCache.cache
}

async function loadRemoteAgentRelease(exactVersion?: string) {
  const release = exactVersion
    ? await fetchJsonFromGitHub<GitHubRelease>(`${getAgentReleaseApiUrl()}/tags/${encodeURIComponent(getAgentReleaseTag(exactVersion))}`)
    : await fetchLatestAgentRelease()
  const version = normalizeAgentReleaseVersion(release?.tag_name)
  if (!release || !version || release.draft || (exactVersion && version !== exactVersion) || !Array.isArray(release.assets)) {
    return null
  }

  const manifest: AgentUpgradeManifest = {
    version,
    generatedAt: sanitizeShortString(release.published_at, 80) ?? new Date().toISOString(),
    files: {}
  }
  const assets = new Map<string, GitHubReleaseAsset>()
  const namedManifest = release.assets.filter(asset => asset.name === `xpayincus-agent-${version}-manifest.json`)
  const published = namedManifest.length ? namedManifest : release.assets.filter(asset => asset.name === 'manifest.json')
  if (published.length > 1) throw new Error('Ambiguous Agent manifest assets')
  if (published.length === 1) {
    const url = published[0]?.url || published[0]?.browser_download_url
    if (!url) throw new Error('Missing Agent manifest URL')
    assertTrustedAgentReleaseDownloadUrl(url)
    const raw = await readAgentReleaseResponse(url, 'application/octet-stream', response => readReleaseJson<unknown>(response))
    if (!isRecord(raw)) throw new Error('Invalid published Agent manifest')
    validateCachedAgentManifest(raw)
    if (raw.version !== version) throw new Error('Agent manifest release version mismatch')
    if (Object.hasOwn(raw, 'schemaVersion')) manifest.schemaVersion = raw.schemaVersion as number
    if (Object.hasOwn(raw, 'minimumUpdaterVersion')) manifest.minimumUpdaterVersion = raw.minimumUpdaterVersion as string
    manifest.files = raw.files as Record<string, AgentUpgradeManifestFile>
    for (const file of Object.values(manifest.files)) {
      const matches = release.assets.filter(asset => asset.name === file.name)
      if (matches.length !== 1 || (file.size !== undefined && matches[0]?.size !== file.size)) {
        throw new Error('Agent manifest artifact does not match release asset')
      }
      assets.set(file.name!, matches[0]!)
    }
    return prepareRemoteAgentRelease(manifest, assets)
  }

  for (const asset of release.assets) {
    if (!isRecord(asset)) {
      continue
    }
    const name = sanitizeShortString(asset.name, 256)
    const size = typeof asset.size === 'number' && Number.isFinite(asset.size) ? asset.size : undefined
    if (!name || !agentReleaseBinaryNamePattern.test(name)) {
      continue
    }
    const platform = releaseAssetNameToAgentPlatform(name, version)
    if (!platform) {
      continue
    }
    if (assets.has(name)) throw new Error('Ambiguous Agent binary assets')
    const sha256 = await fetchAgentReleaseAssetSha256(asset as GitHubReleaseAsset)
    if (!sha256) {
      continue
    }

    manifest.files![platform] = {
      name: platform === 'linux-amd64' ? `xpayincus-agent-${version}-linux-amd64` : `xpayincus-agent-${version}-linux-arm64`,
      sha256,
      size,
      gzip: false
    }
    assets.set(name, asset as GitHubReleaseAsset)
  }

  if (!manifest.files?.['linux-amd64'] || !manifest.files?.['linux-arm64']) {
    return null
  }

  return prepareRemoteAgentRelease(manifest, assets)
}

function prepareRemoteAgentRelease(manifest: AgentUpgradeManifest, assets: Map<string, GitHubReleaseAsset>) {
  const validated = validateCachedAgentManifest(manifest)
  return {
    manifest: validated,
    download: async (file: typeof validated.files[string]) => {
      const asset = assets.get(file.name)
      if (!asset || !Number.isSafeInteger(asset.size) || !asset.size || asset.size > agentBinaryDownloadLimitBytes) throw new Error('Invalid Agent release asset size')
      const assetName = agentApiBinaryNameToReleaseAssetName(file.name, validated.version)
      if (!assetName) throw new Error('Invalid Agent release asset name')
      const url = asset.url || asset.browser_download_url || getAgentReleaseAssetUrl(getAgentReleaseTag(validated.version), assetName)
      assertTrustedAgentReleaseDownloadUrl(url)
      const binary = await readAgentReleaseResponse(url, 'application/octet-stream', readBoundedAgentResponse)
      if (binary.length !== asset.size) throw new Error('Agent release asset size mismatch')
      return binary
    }
  }
}

async function downloadAgentReleaseBinary(input: {
  name: string
  version: string
  expectedSha256: string
}): Promise<Buffer | null> {
  const localReleaseDir = getLocalAgentReleaseDir()
  const localManifest = localReleaseDir ? await readLocalAgentUpgradeManifest() : null
  if (localManifest && !Object.values(localManifest.files || {}).some(file =>
    localManifest.version === input.version && file.name === input.name && file.sha256?.toLowerCase() === input.expectedSha256.toLowerCase()
  )) throw new Error('Agent binary does not match local manifest')
  const cacheKey = `${input.version}:${input.name}:${input.expectedSha256.toLowerCase()}`
  const cachedBinary = agentReleaseBinaryCache?.expiresAt && agentReleaseBinaryCache.expiresAt > Date.now()
    ? agentReleaseBinaryCache.binaries.get(cacheKey)
    : null
  if (cachedBinary) {
    return cachedBinary
  }

  if (localReleaseDir && agentBinaryNamePattern.test(input.name)) {
    const localPath = join(localReleaseDir, input.name)
    if (existsSync(localPath)) {
      const stat = statSync(localPath)
      if (!stat.isFile() || stat.size <= 0 || stat.size > agentBinaryDownloadLimitBytes) {
        return null
      }
      const binary = readFileSync(localPath)
      const actualSha256 = createHash('sha256').update(binary).digest('hex')
      if (!isSha256(input.expectedSha256) || actualSha256 !== input.expectedSha256.toLowerCase()) {
        throw new Error(`Local Agent release binary sha256 mismatch: expected=${input.expectedSha256} actual=${actualSha256}`)
      }
      if (!agentReleaseBinaryCache || agentReleaseBinaryCache.expiresAt <= Date.now()) {
        agentReleaseBinaryCache = {
          expiresAt: Date.now() + agentReleaseCacheTtlMs,
          binaries: new Map()
        }
      }
      agentReleaseBinaryCache.binaries.set(cacheKey, binary)
      return binary
    }
  }

  const cache = getDiskAgentReleaseCache()
  const cached = await cache.binary(input.version, input.name, input.expectedSha256)
  if (cached) return cached
  if (localReleaseDir) throw new Error('Missing local Agent artifact')
  const manifest = await cache.ensure(input.version, () => loadRemoteAgentRelease(input.version))
  if (!manifest) return null
  return cache.binary(input.version, input.name, input.expectedSha256)
}

async function getLatestAgentVersion(): Promise<string | null> {
  return sanitizeShortString((await readAgentUpgradeManifest())?.version, 128)
}

function getAgentVersionStatus(agentVersion: string | null, latestVersion: string | null): 'latest' | 'outdated' | 'unknown' {
  return agentVersionStatus(agentVersion, latestVersion)
}

function isSha256(value: string | undefined): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)
}

async function buildAgentUpgradeInstruction(request: FastifyRequest, body: AgentHeartbeatBody): Promise<AgentUpgradeInstruction> {
  let manifest: AgentUpgradeManifest | null
  try {
    manifest = await readAgentUpgradeManifest()
  } catch (error) {
    return { available: false, error: error instanceof Error ? error.message : 'Agent manifest rejected' }
  }
  const manifestVersion = sanitizeShortString(manifest?.version, 128)
  if (!manifest || !manifestVersion) {
    return { available: false }
  }

  const currentVersion = sanitizeShortString(body.version, 128)
  if (!currentVersion || !isValidReleaseTag(currentVersion) || !isValidReleaseTag(manifestVersion)) {
    return { available: false, error: 'Invalid Agent current/target version' }
  }
  if (compareReleaseTags(manifestVersion, currentVersion) < 0) {
    return { available: false, version: manifestVersion, error: 'Agent downgrade rejected' }
  }
  if (manifest.minimumUpdaterVersion && compareReleaseTags(currentVersion, manifest.minimumUpdaterVersion) < 0) {
    return { available: false, version: manifestVersion, error: `Agent requires minimumUpdaterVersion ${manifest.minimumUpdaterVersion}` }
  }
  if (currentVersion === manifestVersion) {
    return { available: false, version: manifestVersion }
  }

  const runtimeInfo = body.runtime ?? {}
  const goos = sanitizeShortString(runtimeInfo.goos, 32)
  const goarch = sanitizeShortString(runtimeInfo.goarch, 32)
  if (goos !== 'linux' || (goarch !== 'amd64' && goarch !== 'arm64')) {
    return { available: false, version: manifestVersion, error: 'Unsupported Agent platform/arch' }
  }

  const file = manifest.files?.[`${goos}-${goarch}`]
  const name = sanitizeShortString(file?.name, 128)
  if (!file || !name || !agentBinaryNamePattern.test(name) || !isSha256(file.sha256)) {
    return { available: false, version: manifestVersion }
  }

  const upgradeUrl = `${derivePanelUrl(request)}/api/agent/binary/${encodeURIComponent(name)}?v=${encodeURIComponent(manifestVersion)}&sha256=${encodeURIComponent(file.sha256)}`
  const instruction: AgentUpgradeInstruction = {
    schemaVersion: manifest.schemaVersion,
    minimumUpdaterVersion: manifest.minimumUpdaterVersion,
    platform: goos,
    arch: goarch,
    available: true,
    version: manifestVersion,
    url: upgradeUrl,
    sha256: file.sha256,
    gzip: file.gzip ?? name.endsWith('.gz')
  }
  if (typeof file.size === 'number' && Number.isFinite(file.size) && file.size > 0) {
    instruction.size = file.size
  }
  return instruction
}

function normalizeAgentMetrics(metrics: Record<string, unknown> | undefined): Record<string, unknown> {
  return {
    ...(metrics ?? {}),
    heartbeatIntervalSeconds: clampAgentHeartbeatIntervalSeconds(metrics?.heartbeatIntervalSeconds)
  }
}

async function serializeAgent(agent: HostAgentRecord) {
  const latestVersion = await getLatestAgentVersion()
  const versionStatus = getAgentVersionStatus(agent.version, latestVersion)

  return {
    id: agent.id,
    hostId: agent.hostId,
    agentId: agent.agentId,
    enabled: agent.enabled,
    status: deriveAgentStatus(agent),
    version: agent.version,
    latestVersion,
    versionStatus,
    upgrade: agentUpgradeRequests.get(agent.agentId),
    capabilities: agent.capabilities ?? [],
    lastReport: agent.lastReport ?? {},
    lastSeenAt: agent.lastSeenAt?.toISOString() ?? null,
    lastHeartbeatIp: agent.lastHeartbeatIp,
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString()
  }
}

async function serializeAgentStatus(agent: HostAgentRecord) {
  const latestVersion = await getLatestAgentVersion()
  const versionStatus = getAgentVersionStatus(agent.version, latestVersion)

  return {
    id: agent.id,
    hostId: agent.hostId,
    agentId: agent.agentId,
    enabled: agent.enabled,
    status: deriveAgentStatus(agent),
    version: agent.version,
    latestVersion,
    versionStatus,
    upgrade: agentUpgradeRequests.get(agent.agentId),
    capabilities: agent.capabilities ?? [],
    lastReport: agent.lastReport ?? {},
    lastSeenAt: agent.lastSeenAt?.toISOString() ?? null,
    lastHeartbeatIp: agent.lastHeartbeatIp,
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString()
  }
}

function buildHeartbeatReport(body: AgentHeartbeatBody): Record<string, unknown> {
  return {
    runtime: body.runtime ?? {},
    incus: body.incus ?? {},
    components: body.components ?? {},
    upgradeStatus: body.upgradeStatus ?? {},
    instanceSampledAt: body.instances?.reportedAt ?? null,
    resources: body.resources ?? {},
    metrics: normalizeAgentMetrics(body.metrics)
  }
}

async function authenticateAgentRequest(
  request: FastifyRequest<{ Body: AgentHeartbeatBody }>,
  reply: FastifyReply
): Promise<HostAgentRecord | null> {
  const headers = readAgentAuthHeaders(request.headers)
  if (!headers) {
    reply.code(401).send({ error: 'Agent authentication headers are required', code: 'AGENT_AUTH_REQUIRED' })
    return null
  }

  const headerError = validateAgentHeaders(headers)
  if (headerError) {
    reply.code(401).send({ error: 'Invalid Agent authentication headers', code: 'AGENT_AUTH_INVALID', details: headerError })
    return null
  }

  if (!isAgentTimestampFresh(headers.timestamp)) {
    reply.code(401).send({ error: 'Agent request timestamp is expired', code: 'AGENT_AUTH_EXPIRED' })
    return null
  }

  const bodyHash = request.rawAgentBody
    ? createHash('sha256').update(request.rawAgentBody).digest('hex')
    : createAgentBodyHash(request.body ?? {})
  if (bodyHash !== headers.bodyHash.toLowerCase()) {
    reply.code(401).send({ error: 'Agent body hash mismatch', code: 'AGENT_BODY_HASH_MISMATCH' })
    return null
  }

  const agent = await agentModel.findUnique({
    where: { agentId: headers.agentId }
  })

  if (!agent || !agent.enabled) {
    reply.code(401).send({ error: 'Agent is not enabled', code: 'AGENT_DISABLED' })
    return null
  }

  const secret = decryptSensitiveData(agent.secretEncrypted)
  if (!secret || !isValidAgentSecret(secret)) {
    reply.code(401).send({ error: 'Agent secret is not available', code: 'AGENT_SECRET_INVALID' })
    return null
  }

  const signatureOk = verifyAgentSignature(secret, {
    method: request.method,
    path: buildRequestPath(request),
    timestamp: headers.timestamp,
    nonce: headers.nonce,
    bodyHash
  }, headers.signature)

  if (!signatureOk) {
    reply.code(401).send({ error: 'Agent signature verification failed', code: 'AGENT_SIGNATURE_INVALID' })
    return null
  }

  try {
    await prisma.$transaction([
      nonceModel.deleteMany({
        where: {
          expiresAt: { lt: new Date() }
        }
      }),
      nonceModel.create({
        data: {
          agentId: agent.agentId,
          nonce: headers.nonce,
          expiresAt: new Date(Date.now() + agentNonceTtlMs)
        }
      })
    ])
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      reply.code(401).send({ error: 'Agent nonce was already used', code: 'AGENT_NONCE_REPLAY' })
      return null
    }
    throw error
  }

  return agent
}

export default async function agentRoutes(fastify: FastifyInstance) {
  fastify.post<{ Body: AgentHeartbeatBody; Params: { phase: string } }>('/panel-trust/:phase', async (request, reply) => {
    if (request.params.phase !== 'certificate' && request.params.phase !== 'verify') {
      return reply.code(404).send({ error: 'Unknown trust operation' })
    }
    const agent = await authenticateAgentRequest(request, reply)
    if (!agent) return
    const host = await prisma.host.findUnique({ where: { id: agent.hostId }, select: { url: true, isInstalled: true } })
    if (!host?.isInstalled) return reply.code(403).send({ error: 'Installed host required' })
    try {
      const appDir = process.env.INCUDAL_APP_DIR || process.cwd()
      const installDir = process.env.INSTALL_DIR || (appDir.endsWith('/current') ? dirname(appDir) : null)
      const stableDir = installDir ? join(installDir, 'server/certs') : null
      const certDir = stableDir && (existsSync(join(stableDir, 'client.crt')) || existsSync(join(stableDir, 'client.key')))
        ? stableDir : join(__dirname, '../../certs')
      const explicit = process.env.PANEL_CRT_PATH || process.env.PANEL_KEY_PATH
      const pair = readPanelCertificatePair(
        explicit ? process.env.PANEL_CRT_PATH || '' : join(certDir, 'client.crt'),
        explicit ? process.env.PANEL_KEY_PATH || '' : join(certDir, 'client.key')
      )
      if (request.params.phase === 'verify') {
        const serverCertificate = request.body.incus?.serverCertificate
        if (typeof serverCertificate !== 'string' || serverCertificate.length > 16384) {
          return reply.code(400).send({ error: 'Host server certificate required' })
        }
        const dispatcher = new Agent({ connect: {
          cert: pair.cert, key: pair.key, ca: serverCertificate, rejectUnauthorized: true,
          checkServerIdentity: () => undefined, timeout: 10000
        } })
        try {
          const response = await undiciRequest(new URL('/1.0/resources', host.url), {
            dispatcher, method: 'GET', headersTimeout: 10000, bodyTimeout: 10000
          })
          const data = await response.body.json() as { type?: string; status_code?: number }
          if (response.statusCode !== 200 || data.type !== 'sync' || data.status_code !== 200) {
            return reply.code(409).send({ error: 'Panel certificate is not trusted by host' })
          }
        } catch {
          request.log.warn({ code: 'PANEL_TRUST_HOST_UNREACHABLE', hostId: agent.hostId }, 'Panel trust verification could not reach the host Incus API')
          return reply.code(502).send({ error: 'Panel cannot reach the host Incus API for trust verification', code: 'PANEL_TRUST_HOST_UNREACHABLE' })
        } finally {
          await dispatcher.close()
        }
      }
      const headers = readAgentAuthHeaders(request.headers)!
      const digest = createHash('sha256').update(pair.cert).digest('hex')
      const proof = createHmac('sha256', decryptSensitiveData(agent.secretEncrypted)!)
        .update(`panel-trust\n${request.params.phase}\n${headers.nonce}\n${digest}`).digest('hex')
      return reply.header('Cache-Control', 'no-store').type('text/plain').send(`${proof}\n${pair.cert.toString('utf8')}`)
    } catch {
      request.log.error({ code: 'PANEL_TRUST_OPERATION_FAILED', phase: request.params.phase, hostId: agent.hostId }, 'Panel trust operation failed')
      return reply.code(503).send({ error: 'Panel trust operation failed' })
    }
  })

  fastify.get('/install.sh', async (_request: FastifyRequest, reply: FastifyReply) => {
    const scriptPath = join(__dirname, '../../templates/agent-install.sh')
    const script = readFileSync(scriptPath, 'utf8')
    return reply
      .header('Content-Type', 'text/x-shellscript; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .send(script)
  })

  fastify.get<{ Querystring: { version?: string } }>('/manifest.json', async (request, reply: FastifyReply) => {
    const version = request.query.version
    if (version !== undefined && !normalizeAgentBinaryVersion(version)) return reply.code(400).send({ error: 'Invalid Agent version' })
    const manifest = version && !getLocalAgentReleaseDir()
      ? await getDiskAgentReleaseCache().ensure(version, () => loadRemoteAgentRelease(version))
      : await readAgentUpgradeManifest()
    if (version && manifest?.version !== version) return reply.code(404).send({ error: 'Requested Agent version not available' })
    if (!manifest) {
      return reply.code(404).send({ error: 'Agent manifest not found', code: 'AGENT_MANIFEST_NOT_FOUND' })
    }

    return reply
      .header('Content-Type', 'application/json; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="manifest.json"')
      .header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
      .header('Pragma', 'no-cache')
      .header('Expires', '0')
      .send(manifest)
  })

  fastify.get<{ Params: AgentInstallTokenParams }>('/install-config/:token', {
    logLevel: 'silent'
  }, async (
    request: FastifyRequest<{ Params: AgentInstallTokenParams }>,
    reply: FastifyReply
  ) => {
    const { token } = request.params
    try {
      const result = await consumeHostAgentInstallToken(token)
      request.log.info(
        { hostId: result.host.id, agentId: result.agent.agentId },
        'Host Agent install token consumed'
      )
      await createLog(
        null,
        LogModule.HOST,
        'host.agent_install_token_consume',
        `宿主机 Agent 一次性安装 token 已消费: ${result.host.name} (#${result.host.id})`,
        LogResult.SUCCESS
      )

      return reply
        .header('Content-Type', 'text/plain; charset=utf-8')
        .header('Cache-Control', 'no-store')
        .send(buildAgentInstallConfig({
          agentId: result.agent.agentId,
          agentSecret: result.agentSecret
        }))
    } catch (error) {
      if (error instanceof Error && error.message === 'AGENT_INSTALL_TOKEN_EXPIRED') {
        return reply.code(403).send('# Error: Agent install token has expired')
      }
      if (error instanceof Error && (
        error.message === 'AGENT_INSTALL_TOKEN_INVALID' ||
        error.message === 'AGENT_SECRET_INVALID'
      )) {
        return reply.code(403).send('# Error: Invalid Agent install token')
      }
      throw error
    }
  })

  fastify.get<{ Params: AgentBinaryParams; Querystring: AgentBinaryQuery }>('/binary/:name', async (
    request: FastifyRequest<{ Params: AgentBinaryParams; Querystring: AgentBinaryQuery }>,
    reply: FastifyReply
  ) => {
    const { name } = request.params
    if (!agentBinaryNamePattern.test(name)) {
      return reply.code(400).send({ error: 'Invalid Agent binary name', code: 'INVALID_AGENT_BINARY_NAME' })
    }

    const requestedVersion = typeof request.query?.v === 'string' ? normalizeAgentBinaryVersion(request.query.v) : null
    const requestedSha256 = typeof request.query?.sha256 === 'string' && isSha256(request.query.sha256)
      ? request.query.sha256.toLowerCase()
      : null
    if (
      (request.query?.v !== undefined || request.query?.sha256 !== undefined) &&
      (!requestedVersion || !requestedSha256)
    ) {
      return reply.code(400).send({
        error: 'Agent binary version and sha256 must be provided together',
        code: 'AGENT_BINARY_QUERY_INCOMPLETE'
      })
    }

    let version = requestedVersion
    let expectedSha256 = requestedSha256
    let binaryName = name
    const platform = name.includes('amd64') ? 'linux-amd64' : 'linux-arm64'
    if (!version || !expectedSha256) {
      const manifest = await readAgentUpgradeManifest()
      version = sanitizeShortString(manifest?.version, 128)
      const file = manifest?.files?.[platform]
      if (!manifest || !version || !file || !isSha256(file.sha256)) {
        return reply.code(404).send({ error: 'Agent binary not found', code: 'AGENT_BINARY_NOT_FOUND' })
      }
      const manifestName = sanitizeShortString(file.name, 128)
      if (manifestName && agentBinaryNamePattern.test(manifestName)) {
        binaryName = manifestName
      }
      expectedSha256 = file.sha256.toLowerCase()
    }

    let binary: Buffer | null = null
    try {
      binary = await downloadAgentReleaseBinary({
        name: binaryName,
        version,
        expectedSha256
      })
    } catch (error) {
      request.log.warn({ error, name: binaryName, version }, 'Failed to download Agent release binary')
      return reply.code(502).send({ error: 'Agent binary download failed', code: 'AGENT_BINARY_DOWNLOAD_FAILED' })
    }

    if (!binary) {
      return reply.code(404).send({ error: 'Agent binary not found', code: 'AGENT_BINARY_NOT_FOUND' })
    }

    return reply
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Disposition', `attachment; filename="${binaryName}"`)
      .header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
      .header('Pragma', 'no-cache')
      .header('Expires', '0')
      .send(binary)
  })

  fastify.get<{ Params: AgentCredentialsParams }>('/hosts/:hostId/status', {
    onRequest: [fastify.authenticate]
  }, async (request: FastifyRequest<{ Params: AgentCredentialsParams }>, reply: FastifyReply) => {
    const hostId = parsePositiveId(request.params.hostId)
    if (!hostId) {
      return reply.code(400).send({ error: 'Invalid host ID', code: 'INVALID_HOST_ID' })
    }

    const host = await prisma.host.findUnique({
      where: { id: hostId },
      select: { id: true, name: true, userId: true }
    })
    if (!host) {
      return reply.code(404).send({ error: 'Host not found', code: 'HOST_NOT_FOUND' })
    }

    if (host.userId !== request.user.id && request.user.role !== 'admin') {
      return reply.code(403).send({ error: 'Forbidden', code: 'FORBIDDEN' })
    }

    const agent = await agentModel.findUnique({
      where: { hostId }
    })

    return {
      host: {
        id: host.id,
        name: host.name
      },
      agent: agent ? await serializeAgentStatus(agent) : null
    }
  })

  fastify.get<{ Params: AgentCredentialsParams; Querystring: { from?: string; to?: string; limit?: string; resolutionSeconds?: string } }>('/hosts/:hostId/history', {
    onRequest: [fastify.authenticate]
  }, async (request, reply) => {
    const hostId = parsePositiveId(request.params.hostId)
    if (!hostId) return reply.code(400).send({ error: 'Invalid host ID', code: 'INVALID_HOST_ID' })
    const host = await prisma.host.findUnique({ where: { id: hostId }, select: { userId: true } })
    if (!host) return reply.code(404).send({ error: 'Host not found', code: 'HOST_NOT_FOUND' })
    if (host.userId !== request.user.id && request.user.role !== 'admin') return reply.code(403).send({ error: 'Forbidden', code: 'FORBIDDEN' })
    const now = Date.now()
    const from = request.query.from ? Date.parse(request.query.from) : now - 86400000
    const to = request.query.to ? Date.parse(request.query.to) : now
    const limit = Number(request.query.limit ?? 1000)
    const resolutionSeconds = Number(request.query.resolutionSeconds ?? 60)
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to || !Number.isInteger(limit) || limit < 1 || limit > 2000 ||
      !Number.isInteger(resolutionSeconds) || resolutionSeconds < 30 || resolutionSeconds > 86400) {
      return reply.code(400).send({ error: 'Invalid history range, limit or resolution', code: 'AGENT_HISTORY_INVALID_QUERY' })
    }
    const agent = await agentModel.findUnique({ where: { hostId } })
    return { hostId, retentionDays: 30, recentResolutionSeconds: 30, archiveResolutionSeconds: 3600,
      samples: agent ? readAgentHistory(agent.agentId, from, to, limit, resolutionSeconds * 1000) : [] }
  })

  for (const view of ['history', 'instances/top', 'instances/history', 'events'] as const) {
    fastify.get<{ Params: AgentCredentialsParams; Querystring: { name?: string; from?: string; to?: string; limit?: string; resolutionSeconds?: string; metric?: string; orderBy?: string; top?: string } }>(`/hosts/:hostId/monitoring/${view}`, {
      onRequest: [fastify.authenticate]
    }, async (request, reply) => {
      const hostId = parsePositiveId(request.params.hostId)
      if (!hostId) return reply.code(400).send({ error: 'Invalid host ID', code: 'INVALID_HOST_ID' })
      const host = await prisma.host.findUnique({ where: { id: hostId }, select: { userId: true } })
      if (!host) return reply.code(404).send({ error: 'Host not found', code: 'HOST_NOT_FOUND' })
      if (host.userId !== request.user.id && request.user.role !== 'admin') return reply.code(403).send({ error: 'Forbidden', code: 'FORBIDDEN' })
      const now = Date.now()
      const from = request.query.from === undefined ? now - 86400000 : Date.parse(request.query.from)
      const to = request.query.to === undefined ? now : Date.parse(request.query.to)
      const limit = Number(request.query.limit ?? 1000)
      const resolutionSeconds = Number(request.query.resolutionSeconds ?? 60)
      const top = Number(request.query.top ?? 10)
      const metric = request.query.metric ?? 'cpuUsagePercent'
      const orderBy = request.query.orderBy ?? 'avg'
      const name = request.query.name
      if (view === 'instances/history' && !isMonitoringInstanceName(name)) {
        return reply.code(400).send({ error: 'Valid instance name is required', code: 'AGENT_MONITORING_INVALID_NAME' })
      }
      if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to || from < now - 30 * 86400000 || to > now ||
        !Number.isInteger(limit) || limit < 1 || limit > 2000 || !Number.isInteger(resolutionSeconds) || resolutionSeconds < 30 || resolutionSeconds > 86400 ||
        !Number.isInteger(top) || top < 1 || top > 100 || !instanceMonitoringKeys.includes(metric as InstanceMonitoringMetric) || !['avg', 'max'].includes(orderBy)) {
        return reply.code(400).send({ error: 'Invalid monitoring query', code: 'AGENT_MONITORING_INVALID_QUERY' })
      }
      const agent = await agentModel.findUnique({ where: { hostId } })
      const agentId = agent?.agentId ?? null
      const range = { from, to, limit, resolutionSeconds }
      try {
        reply.header('Cache-Control', 'no-store')
        if (view === 'instances/history') return { hostId, ...readAgentInstanceHistory(agentId, range, name!, now) }
        if (view === 'instances/top') return { hostId, ...readAgentInstanceTop(agentId, range, metric as InstanceMonitoringMetric, orderBy as 'avg' | 'max', top, now) }
        if (view === 'events') return { hostId, ...readAgentComponentEvents(agentId, range, now) }
        return { hostId, ...readAgentMonitoring(agentId, range, now) }
      } catch (error) {
        request.log.warn({ error, hostId }, 'Agent monitoring journal unavailable')
        return reply.code(503).send({ error: 'Monitoring storage unavailable', code: 'AGENT_MONITORING_UNAVAILABLE' })
      }
    })
  }

  fastify.post<{ Params: AgentCredentialsParams; Body: { confirm: boolean; targetVersion: string } }>('/hosts/:hostId/upgrade', {
    onRequest: [fastify.authenticate],
    preValidation: async (request, reply) => {
      if (!isRecord(request.body) || request.body.confirm !== true || typeof request.body.targetVersion !== 'string' ||
        Object.keys(request.body).some(key => key !== 'confirm' && key !== 'targetVersion')) {
        return reply.code(400).send({ error: 'Explicit Agent update confirmation and target version are required', code: 'AGENT_UPGRADE_INVALID_REQUEST' })
      }
    },
    schema: {
      body: {
        type: 'object',
        required: ['confirm', 'targetVersion'],
        additionalProperties: false,
        properties: {
          confirm: { type: 'boolean', const: true },
          targetVersion: { type: 'string', maxLength: 128 }
        }
      }
    }
  }, async (request, reply) => {
    const hostId = parsePositiveId(request.params.hostId)
    if (!hostId) {
      return reply.code(400).send({ error: 'Invalid host ID', code: 'INVALID_HOST_ID' })
    }

    const host = await prisma.host.findUnique({
      where: { id: hostId },
      select: { id: true, name: true, userId: true }
    })
    if (!host) {
      return reply.code(404).send({ error: 'Host not found', code: 'HOST_NOT_FOUND' })
    }

    if (host.userId !== request.user.id && request.user.role !== 'admin') {
      return reply.code(403).send({ error: 'Forbidden', code: 'FORBIDDEN' })
    }

    const agent = await agentModel.findUnique({
      where: { hostId }
    })
    if (!agent) {
      return reply.code(404).send({ error: 'Agent not found', code: 'AGENT_NOT_FOUND' })
    }

    const latestVersion = await getLatestAgentVersion()
    const versionStatus = getAgentVersionStatus(agent.version, latestVersion)
    const derivedStatus = deriveAgentStatus(agent)

    if (!latestVersion) {
      return reply.code(503).send({ error: 'Agent latest version unavailable', code: 'AGENT_LATEST_VERSION_UNAVAILABLE' })
    }
    if (request.body.confirm !== true || request.body.targetVersion !== latestVersion) {
      return reply.code(409).send({ error: 'Refresh and confirm the current Agent release', code: 'AGENT_TARGET_CHANGED' })
    }
    if (versionStatus === 'unknown') {
      return reply.code(409).send({ error: 'Agent version unknown', code: 'AGENT_VERSION_UNKNOWN' })
    }
    if (versionStatus === 'latest') {
      return {
        requested: false,
        currentVersion: agent.version,
        latestVersion,
        versionStatus,
        nextHeartbeatSeconds: getAgentHeartbeatIntervalSeconds(agent),
        message: 'Agent is already latest'
      }
    }
    if (!agent.enabled || derivedStatus !== 'online') {
      return reply.code(409).send({ error: 'Agent is not online', code: 'AGENT_NOT_ONLINE' })
    }

    const nextHeartbeatSeconds = getAgentHeartbeatIntervalSeconds(agent)
    const report = isRecord(agent.lastReport) ? agent.lastReport : {}
    const instruction = await buildAgentUpgradeInstruction(request, {
      version: agent.version ?? undefined,
      runtime: isRecord(report.runtime) ? report.runtime : {}
    })
    if (!instruction.available || instruction.version !== latestVersion) {
      return reply.code(409).send({ error: 'Agent release is incompatible or changed', code: 'AGENT_UPGRADE_UNAVAILABLE' })
    }
    await createLog(
      request.user.id,
      LogModule.HOST,
      'host.agent_upgrade_request',
      `请求宿主机 Agent 升级: ${host.name} (#${host.id}) ${agent.version || 'unknown'} -> ${latestVersion}`,
      LogResult.SUCCESS
    )
    const upgrade = agentUpgradeRequests.request(agent.agentId, instruction, nextHeartbeatSeconds)

    return {
      requested: true,
      upgrade,
      currentVersion: agent.version,
      latestVersion,
      versionStatus,
      nextHeartbeatSeconds,
      message: 'Agent upgrade request accepted; upgrade instruction will be delivered on next heartbeat'
    }
  })

  fastify.post<{ Params: AgentCredentialsParams; Body: AgentCredentialsBody }>('/hosts/:hostId/install-command', {
    onRequest: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          enabled: { type: 'boolean' }
        }
      }
    }
  }, async (
    request: FastifyRequest<{ Params: AgentCredentialsParams; Body: AgentCredentialsBody }>,
    reply: FastifyReply
  ) => {
    const hostId = parsePositiveId(request.params.hostId)
    if (!hostId) {
      return reply.code(400).send({ error: 'Invalid host ID', code: 'INVALID_HOST_ID' })
    }

    const host = await prisma.host.findUnique({
      where: { id: hostId },
      select: { id: true, name: true, userId: true }
    })
    if (!host) {
      return reply.code(404).send({ error: 'Host not found', code: 'HOST_NOT_FOUND' })
    }

    if (host.userId !== request.user.id && request.user.role !== 'admin') {
      return reply.code(403).send({ error: 'Forbidden', code: 'FORBIDDEN' })
    }

    const panelUrl = derivePanelUrl(request)
    let result: Awaited<ReturnType<typeof issueHostAgentInstallToken>>
    try {
      result = await issueHostAgentInstallToken(hostId, request.body?.enabled ?? true)
    } catch (error) {
      if (error instanceof Error && error.message === 'HOST_NOT_FOUND') {
        return reply.code(404).send({ error: 'Host not found', code: 'HOST_NOT_FOUND' })
      }
      throw error
    }
    const installCommand = buildAgentInstallCommand({
      panelUrl
    })

    await createLog(
      request.user.id,
      LogModule.HOST,
      'host.agent_install_command_generate',
      `生成宿主机 Agent 安装命令: ${host.name} (#${host.id})`,
      LogResult.SUCCESS
    )

    return reply.code(201).send({
      host: result.host,
      panelUrl,
      agent: await serializeAgentStatus(result.agent),
      installToken: result.installToken,
      installTokenExpiresAt: result.installTokenExpiresAt.toISOString(),
      installScriptUrl: `${panelUrl}/api/agent/install.sh`,
      installCommand,
      warning: '請另外輸入一次性 Agent 安裝 TOKEN；30 分鐘內有效且只能使用一次，確認摘要後才使用。'
    })
  })

  fastify.get<{ Params: AgentCredentialsParams }>('/admin/hosts/:hostId/status', {
    onRequest: [fastify.authenticateAdmin]
  }, async (request: FastifyRequest<{ Params: AgentCredentialsParams }>, reply: FastifyReply) => {
    const hostId = parsePositiveId(request.params.hostId)
    if (!hostId) {
      return reply.code(400).send({ error: 'Invalid host ID', code: 'INVALID_HOST_ID' })
    }

    const host = await prisma.host.findUnique({
      where: { id: hostId },
      select: { id: true, name: true }
    })
    if (!host) {
      return reply.code(404).send({ error: 'Host not found', code: 'HOST_NOT_FOUND' })
    }

    const agent = await agentModel.findUnique({
      where: { hostId }
    })

    return {
      host,
      agent: agent ? await serializeAgent(agent) : null
    }
  })

  fastify.post<{ Params: AgentCredentialsParams; Body: AgentCredentialsBody }>('/admin/hosts/:hostId/credentials', {
    onRequest: [fastify.authenticateAdmin],
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          enabled: { type: 'boolean' }
        }
      }
    }
  }, async (
    request: FastifyRequest<{ Params: AgentCredentialsParams; Body: AgentCredentialsBody }>,
    reply: FastifyReply
  ) => {
    const hostId = parsePositiveId(request.params.hostId)
    if (!hostId) {
      return reply.code(400).send({ error: 'Invalid host ID', code: 'INVALID_HOST_ID' })
    }

    let result: Awaited<ReturnType<typeof rotateHostAgentCredentials>>
    try {
      result = await rotateHostAgentCredentials(hostId, request.body?.enabled ?? true)
    } catch (error) {
      if (error instanceof Error && error.message === 'HOST_NOT_FOUND') {
        return reply.code(404).send({ error: 'Host not found', code: 'HOST_NOT_FOUND' })
      }
      throw error
    }

    await createLog(
      request.user.id,
      LogModule.HOST,
      'host.agent_credentials_rotate',
      `重置宿主机 Agent 凭据: ${result.host.name} (#${result.host.id})`,
      LogResult.SUCCESS
    )

    return reply.code(201).send({
      host: result.host,
      agent: await serializeAgent(result.agent),
      credentials: {
        agentId: result.agentId,
        agentSecret: result.agentSecret
      },
      warning: 'agentSecret 只会在本次响应中返回，请写入宿主机 Agent 配置后妥善保存。'
    })
  })

  fastify.post<{ Params: AgentCredentialsParams; Body: AgentInstallCommandBody }>('/admin/hosts/:hostId/install-command', {
    onRequest: [fastify.authenticateAdmin],
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          enabled: { type: 'boolean' },
          baseUrl: { type: 'string', minLength: 1 },
          binaryUrl: { type: 'string', minLength: 1 },
          binarySha256: { type: 'string', minLength: 64, maxLength: 64 }
        }
      }
    }
  }, async (
    request: FastifyRequest<{ Params: AgentCredentialsParams; Body: AgentInstallCommandBody }>,
    reply: FastifyReply
  ) => {
    const hostId = parsePositiveId(request.params.hostId)
    if (!hostId) {
      return reply.code(400).send({ error: 'Invalid host ID', code: 'INVALID_HOST_ID' })
    }
    const baseUrlInput = request.body?.baseUrl
    if (typeof baseUrlInput === 'string' && !normalizeBaseUrl(baseUrlInput)) {
      return reply.code(400).send({
        error: 'baseUrl must be a valid HTTP(S) URL',
        code: 'INVALID_AGENT_BASE_URL'
      })
    }

    const binaryUrlInput = request.body?.binaryUrl
    const binaryUrl = typeof binaryUrlInput === 'string' ? normalizeAgentBinaryUrl(binaryUrlInput) : null
    if (typeof binaryUrlInput === 'string' && !binaryUrl) {
      return reply.code(400).send({
        error: 'binaryUrl must be a valid HTTP(S) URL',
        code: 'INVALID_AGENT_BINARY_URL'
      })
    }
    if (binaryUrl && !isSha256(request.body.binarySha256)) {
      return reply.code(400).send({
        error: 'binarySha256 is required when binaryUrl is provided',
        code: 'AGENT_BINARY_SHA256_REQUIRED'
      })
    }

    const panelUrl = derivePanelUrl(request, request.body?.baseUrl)
    let result: Awaited<ReturnType<typeof issueHostAgentInstallToken>>
    try {
      result = await issueHostAgentInstallToken(hostId, request.body?.enabled ?? true)
    } catch (error) {
      if (error instanceof Error && error.message === 'HOST_NOT_FOUND') {
        return reply.code(404).send({ error: 'Host not found', code: 'HOST_NOT_FOUND' })
      }
      throw error
    }

    const installCommand = buildAgentInstallCommand({
      panelUrl,
      binaryUrl,
      binarySha256: request.body?.binarySha256
    })

    await createLog(
      request.user.id,
      LogModule.HOST,
      'host.agent_install_command_generate',
      `生成宿主机 Agent 安装命令: ${result.host.name} (#${result.host.id})`,
      LogResult.SUCCESS
    )

    return reply.code(201).send({
      host: result.host,
      panelUrl,
      agent: await serializeAgent(result.agent),
      installToken: result.installToken,
      installTokenExpiresAt: result.installTokenExpiresAt.toISOString(),
      installScriptUrl: `${panelUrl}/api/agent/install.sh`,
      installCommand,
      warning: '請另外輸入一次性 Agent 安裝 TOKEN；30 分鐘內有效且只能使用一次，確認摘要後才使用。'
    })
  })

  fastify.post<{ Body: AgentHeartbeatBody }>('/heartbeat', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: true,
        properties: {
          version: { type: 'string', maxLength: 128 },
          capabilities: {
            type: 'array',
            maxItems: 64,
            items: { type: 'string', maxLength: 80 }
          },
          runtime: { type: 'object', additionalProperties: true },
          incus: { type: 'object', additionalProperties: true },
          instances: { type: 'object', additionalProperties: true },
          resources: { type: 'object', additionalProperties: true },
          metrics: { type: 'object', additionalProperties: true },
          components: { type: 'object', additionalProperties: true },
          upgradeStatus: { type: 'object', additionalProperties: true },
          history: { type: 'object', additionalProperties: true },
          monitoring: { type: 'object', additionalProperties: true }
        }
      }
    }
  }, async (request: FastifyRequest<{ Body: AgentHeartbeatBody }>, reply: FastifyReply) => {
    const agent = await authenticateAgentRequest(request, reply)
    if (!agent) {
      return
    }

    return serializeAgentHeartbeat(agent.agentId, async () => {
    const latestAgent = await agentModel.findUnique({ where: { agentId: agent.agentId } })
    if (!latestAgent?.enabled) return reply.code(409).send({ error: 'Agent is disabled', code: 'AGENT_HEARTBEAT_REJECTED' })
    const now = new Date()
    const previousReport = isRecord(latestAgent.lastReport) ? latestAgent.lastReport : {}
    const nextReport = buildHeartbeatReport(request.body)
    nextReport.instanceSampledAt = previousReport.instanceSampledAt ?? null
    let instanceReport: Awaited<ReturnType<typeof processAgentInstanceReport>> | null = null
    try {
      const reportedAt = request.body.instances?.reportedAt
      const sampledAt = typeof reportedAt === 'string' ? Date.parse(reportedAt) : now.getTime()
      const previousTime = typeof previousReport.instanceSampledAt === 'string' ? Date.parse(previousReport.instanceSampledAt) : 0
      const previousAt = Number.isFinite(previousTime) ? previousTime : 0
      const freshWindow = Math.max(120000, getAgentHeartbeatIntervalSeconds(agent) * 2000)
      if (Number.isFinite(sampledAt) && sampledAt > previousAt && sampledAt <= now.getTime() + 60000 && sampledAt >= now.getTime() - freshWindow) {
        instanceReport = await processAgentInstanceReport(agent.hostId, request.body.instances)
        nextReport.instanceSampledAt = new Date(sampledAt).toISOString()
      }
    } catch (error) {
      request.log.warn(
        { agentId: agent.agentId, hostId: agent.hostId, error },
        'Failed to process Agent instance report'
      )
    }

    const heartbeatResult = await agentModel.updateMany({
      where: {
        agentId: agent.agentId,
        enabled: true,
        OR: [{ lastSeenAt: null }, { lastSeenAt: { lte: now } }]
      },
      data: {
        status: 'online',
        version: sanitizeShortString(request.body.version, 128),
        capabilities: normalizeCapabilities(request.body.capabilities) as Prisma.InputJsonValue,
        lastReport: nextReport as Prisma.InputJsonObject,
        lastSeenAt: now,
        lastHeartbeatIp: sanitizeShortString(getAgentHeartbeatIp(request), 128)
      }
    })

    if (heartbeatResult.count !== 1) {
      return reply.code(409).send({ error: 'Agent heartbeat is superseded or Agent is disabled', code: 'AGENT_HEARTBEAT_REJECTED' })
    }

    let acceptedSampleIds: string[] = []
    try {
      acceptedSampleIds = ingestAgentHistory(agent.agentId, request.body.history)
    } catch (error) {
      request.log.warn({ error, agentId: agent.agentId }, 'Agent history persistence unavailable; samples retained by Agent')
    }
    let upgrade: AgentUpgradeInstruction = { available: false }
    let acceptedMonitoringSampleIds: string[] = []
    try {
      acceptedMonitoringSampleIds = ingestAgentMonitoring(agent.agentId, request.body.monitoring, now.getTime())
    } catch (error) {
      request.log.warn({ error, agentId: agent.agentId }, 'Agent monitoring persistence unavailable; samples retained by Agent')
    }
    try {
      upgrade = agentUpgradeRequests.heartbeat(agent.agentId, request.body.version, request.body.runtime ?? {}, now.getTime(), request.body.upgradeStatus, normalizeCapabilities(request.body.capabilities))
    } catch (error) {
      request.log.warn({ error, agentId: agent.agentId }, 'Agent upgrade journal unavailable')
    }
    return {
      ok: true,
      acceptedSampleIds,
      monitoringAck: { schemaVersion: 2, acceptedSampleIds: acceptedMonitoringSampleIds },
      serverTime: now.toISOString(),
      taskPollIntervalSeconds: 15,
      instanceReport,
      upgrade
    }
    })
  })
}
