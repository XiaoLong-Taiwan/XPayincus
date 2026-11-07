import { getSystemConfig, getSystemConfigNumber } from '../db/system-config.js'

function envFirst(keys: string | string[]): string {
  const envKeys = Array.isArray(keys) ? keys : [keys]
  for (const key of envKeys) {
    const value = process.env[key]?.trim()
    if (value) return value
  }
  return ''
}

function splitCsv(value: string | null | undefined): string[] {
  if (!value) return []
  return value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
}

export async function getRuntimeConfigString(
  configKey: string,
  envKeys: string | string[],
  fallback = ''
): Promise<string> {
  const dbValue = (await getSystemConfig(configKey))?.trim()
  if (dbValue) return dbValue
  return envFirst(envKeys) || fallback
}

export async function getRuntimeConfigBoolean(
  configKey: string,
  envKey: string,
  fallback = false
): Promise<boolean> {
  const dbValue = await getSystemConfig(configKey)
  if (dbValue === 'true' || dbValue === '1') return true
  if (dbValue === 'false' || dbValue === '0') return false
  const envValue = process.env[envKey]?.trim().toLowerCase()
  if (envValue === 'true' || envValue === '1' || envValue === 'yes') return true
  if (envValue === 'false' || envValue === '0' || envValue === 'no') return false
  return fallback
}

export async function getRuntimeConfigNumber(
  configKey: string,
  envKey: string,
  fallback: number,
  min: number,
  max: number
): Promise<number> {
  const dbValue = await getSystemConfigNumber(configKey, Number.NaN)
  if (Number.isInteger(dbValue) && dbValue >= min && dbValue <= max) return dbValue
  const envValue = Number(process.env[envKey])
  if (Number.isInteger(envValue) && envValue >= min && envValue <= max) return envValue
  return fallback
}

export async function getCombinedAdminIdAllowlist(
  configKey: string,
  envKeys: string | string[]
): Promise<{ ids: Set<number>; configured: boolean }> {
  const ids = new Set<number>()
  const rawValues = [
    await getSystemConfig(configKey),
    envFirst(envKeys)
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0)

  for (const raw of rawValues) {
    for (const part of splitCsv(raw)) {
      const id = Number(part)
      if (Number.isSafeInteger(id) && id > 0) ids.add(id)
    }
  }

  return { ids, configured: rawValues.length > 0 }
}
