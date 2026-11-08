import { compareReleaseTags, isValidReleaseTag } from './system-version.js'

export function assertManifestCompatibility(
  manifest: Record<string, unknown>, currentVersion: string, legacy = false
): void {
  if (!(legacy && !Object.hasOwn(manifest, 'schemaVersion')) && manifest.schemaVersion !== 1) {
    throw new Error(`Unsupported manifest schemaVersion: ${String(manifest.schemaVersion)}`)
  }
  if (Object.hasOwn(manifest, 'minimumUpdaterVersion')) {
    const minimum = manifest.minimumUpdaterVersion
    if (typeof minimum !== 'string' || !isValidReleaseTag(minimum)) {
      throw new Error('Invalid manifest minimumUpdaterVersion')
    }
    if (!isValidReleaseTag(currentVersion) || compareReleaseTags(currentVersion, minimum) < 0) {
      throw new Error(`Updater ${currentVersion} does not support minimumUpdaterVersion ${minimum}`)
    }
  }
}

export function assertAgentManifest(manifest: Record<string, unknown>): void {
  assertManifestCompatibility(manifest, typeof manifest.minimumUpdaterVersion === 'string' ? manifest.minimumUpdaterVersion : 'v0.0.0', true)
  if (typeof manifest.version !== 'string' || !isValidReleaseTag(manifest.version) ||
    !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) {
    throw new Error('Invalid Agent manifest version/files')
  }
  for (const platform of ['linux-amd64', 'linux-arm64']) {
    const file = (manifest.files as Record<string, unknown>)[platform]
    if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error(`Missing Agent platform ${platform}`)
    const entry = file as Record<string, unknown>
    const rawName = `xpayincus-agent-${manifest.version}-${platform}`
    if (![rawName, `${rawName}.gz`].includes(String(entry.name)) ||
      typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(entry.sha256) ||
      (Object.hasOwn(entry, 'size') && (!Number.isSafeInteger(entry.size) || Number(entry.size) <= 0)) ||
      (Object.hasOwn(entry, 'gzip') && entry.gzip !== String(entry.name).endsWith('.gz'))) {
      throw new Error(`Invalid Agent artifact for ${platform}`)
    }
  }
}
