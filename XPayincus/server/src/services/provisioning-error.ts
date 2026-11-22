const SECRET_PATTERN = /(password|passwd|secret|token|private.?key|ssh.?key|authorization|cookie|credential|init.?command)/i
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/

export interface ProvisioningErrorMetadata {
  code: string
  detail: string
  requestId: string | null
  retryable: boolean
}

function safeText(value: unknown, fallback: string, maxLength: number): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || SECRET_PATTERN.test(text)) return fallback
  return text.slice(0, maxLength)
}

function requestIdFromError(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null
  const candidate = (error as { requestId?: unknown }).requestId
  return typeof candidate === 'string' && REQUEST_ID_PATTERN.test(candidate) ? candidate : null
}

export function normalizeProvisioningError(error: unknown, requestId?: string | null): ProvisioningErrorMetadata {
  const source = error instanceof Error ? error.message : String(error)
  const code = safeText((error as { code?: unknown } | null)?.code, 'PROVISIONING_FAILED', 64).toUpperCase().replace(/[^A-Z0-9_:-]/g, '_')
  const detail = safeText(source, '實例建立失敗，請稍後重試或聯絡支援。', 500)
  const normalizedRequestId = requestId && REQUEST_ID_PATTERN.test(requestId) ? requestId : requestIdFromError(error)
  const retryable = !/review|ownership|already exists|狀態|歸屬|核實/i.test(`${code} ${detail}`)
  return { code, detail, requestId: normalizedRequestId, retryable }
}

export function provisioningErrorFields(metadata: ProvisioningErrorMetadata) {
  return {
    error: metadata.detail,
    errorCode: metadata.code,
    errorDetail: metadata.detail,
    errorRequestId: metadata.requestId,
    errorRetryable: metadata.retryable
  }
}
