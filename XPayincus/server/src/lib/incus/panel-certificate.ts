import { readFileSync, statSync } from 'fs'
import { createPrivateKey, X509Certificate } from 'crypto'
import { createSecureContext } from 'tls'

export const PANEL_CERTIFICATE_ERROR = '面板 Incus 客戶端憑證無法讀取或配對無效。請檢查 PANEL_CRT_PATH／PANEL_KEY_PATH、Compose 的 ./certs 掛載及 API 執行使用者讀取權限（目錄 700、檔案 600）；缺少任一檔案時請還原原配對，勿覆寫現有憑證。全新部署兩檔皆缺時請初始化 client.crt／client.key；更換配對後須重新匯入 Incus trust。'

export function readPanelCertificatePair(certPath: string, keyPath: string): { cert: Buffer; key: Buffer } {
  try {
    if (!statSync(certPath).isFile() || !statSync(keyPath).isFile()) throw new Error()
    if (process.platform !== 'win32' && (statSync(keyPath).mode & 0o077) !== 0) throw new Error()
    const cert = readFileSync(certPath)
    const key = readFileSync(keyPath)
    const certificate = new X509Certificate(cert)
    const privateKey = createPrivateKey({ key, passphrase: '' })
    if (!certificate.checkPrivateKey(privateKey)) throw new Error()
    createSecureContext({ cert, key })
    return { cert: Buffer.from(certificate.toString()), key }
  } catch {
    throw new Error(PANEL_CERTIFICATE_ERROR)
  }
}
