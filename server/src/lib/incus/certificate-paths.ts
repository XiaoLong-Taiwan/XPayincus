import { existsSync, readFileSync } from 'fs'
import { basename, dirname, join } from 'path'

function stableCertificatePath(filePath: string): string | null {
  const fileName = basename(filePath)
  const installDir = process.env.XPAYINCUS_INSTALL_DIR || '/opt/xpayincus'
  const explicitPath = fileName === 'client.crt' ? process.env.PANEL_CRT_PATH : process.env.PANEL_KEY_PATH
  const candidates = [
    explicitPath,
    join(installDir, 'server/certs', fileName),
    join('/opt/xpayincus/server/certs', fileName)
  ].filter((candidate): candidate is string => !!candidate)

  return candidates.find(candidate => existsSync(candidate)) ?? null
}

export function resolveCertificatePath(filePath: string | null): string | null {
  if (!filePath) return null
  if (existsSync(filePath)) return filePath
  return stableCertificatePath(filePath) ?? filePath
}

export function resolveCertificatePair(certPath: string | null, keyPath: string | null): { certPath: string | null; keyPath: string | null } {
  return {
    certPath: resolveCertificatePath(certPath),
    keyPath: resolveCertificatePath(keyPath)
  }
}

export function readIncusTlsCredentials(certPath: string, keyPath: string): {
  cert: Buffer
  key: Buffer
  ca?: Buffer
  rejectUnauthorized: boolean
} {
  const cert = readFileSync(certPath)
  const key = readFileSync(keyPath)
  const serverCertificatePath = join(dirname(certPath), 'server.crt')
  if (!existsSync(serverCertificatePath)) return { cert, key, rejectUnauthorized: false }
  return { cert, key, ca: readFileSync(serverCertificatePath), rejectUnauthorized: true }
}
