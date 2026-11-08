import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { readPanelCertificatePair } from '../lib/incus/panel-certificate.js'

const certPath = process.env.PANEL_CRT_PATH || '/opt/incudal/server/certs/client.crt'
const keyPath = process.env.PANEL_KEY_PATH || '/opt/incudal/server/certs/client.key'

function pathExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

try {
  if (Boolean(process.env.PANEL_CRT_PATH) !== Boolean(process.env.PANEL_KEY_PATH)) throw new Error()
  if (!pathExists(certPath) && !pathExists(keyPath)) {
    const certDir = dirname(certPath)
    mkdirSync(certDir, { recursive: true, mode: 0o700 })
    const temporaryDir = mkdtempSync(join(certDir, `.client-${randomBytes(6).toString('hex')}-`))
    try {
      const temporaryKey = join(temporaryDir, 'client.key')
      const temporaryCert = join(temporaryDir, 'client.crt')
      await new Promise<void>((resolve, reject) => {
        const child = spawn('openssl', [
          'req', '-x509', '-newkey', 'rsa:4096', '-nodes', '-days', '3650',
          '-subj', '/CN=incudal-panel/O=XPayincus', '-keyout', temporaryKey, '-out', temporaryCert
        ], { stdio: 'ignore' })
        child.once('error', reject)
        child.once('exit', code => code === 0 ? resolve() : reject(new Error('certificate generation failed')))
      })
      chmodSync(temporaryKey, 0o600)
      readPanelCertificatePair(temporaryCert, temporaryKey)
      mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 })
      linkSync(temporaryKey, keyPath)
      linkSync(temporaryCert, certPath)
    } finally {
      rmSync(temporaryDir, { recursive: true, force: true })
    }
  }

  readPanelCertificatePair(certPath, keyPath)
} catch {
  process.stderr.write('Incus client certificate pair is missing, incomplete, unreadable or invalid. Restore the original matching client.crt/client.key from backup; do not delete a partial pair to regenerate. A changed pair requires renewed Incus trust.\n')
  process.exit(1)
}
