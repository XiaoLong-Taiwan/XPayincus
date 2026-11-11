import type { PackageSource } from './publicCatalog'

export interface PurchaseDraft {
  source: PackageSource
  savedAt: number
  idempotencyKey?: string | null
  form: {
    name: string
    packageId: number | null
    planId: number | null
    hostId: number | null
    image: string
    cpu: number
    memory: number
    disk: number
    sshKeyId: number | null
    customInitCommandIds: number[]
    promoCode: string
    autoRemotePort: boolean
  }
}
const key = (userId: number) => `incudal.purchase-draft.${userId}`
export function readPurchaseDraft(userId: number): PurchaseDraft | null {
  try {
    const draft = JSON.parse(localStorage.getItem(key(userId)) || 'null') as PurchaseDraft | null
    if (!draft || !Number.isFinite(draft.savedAt) || draft.savedAt > Date.now() || Date.now() - draft.savedAt > 86400000 || !draft.form) return null
    const form = draft.form
    const validId = (value: unknown) => value === null || (Number.isInteger(value) && Number(value) > 0)
    if (typeof draft.source !== 'string' || !/^(official|market|zone:[1-9]\d*)$/.test(draft.source)
      || !Number.isInteger(form.packageId) || Number(form.packageId) <= 0
      || ![form.planId, form.hostId, form.sshKeyId].every(validId)
      || ![form.name, form.image, form.promoCode].every(value => typeof value === 'string')
      || ![form.cpu, form.memory, form.disk].every(value => Number.isFinite(value) && value > 0)
      || typeof form.autoRemotePort !== 'boolean' || !Array.isArray(form.customInitCommandIds)
      || !form.customInitCommandIds.every(value => Number.isInteger(value) && value > 0)) return null
    if (draft.idempotencyKey != null && (typeof draft.idempotencyKey !== 'string' || !/^[a-zA-Z0-9-]{1,160}$/.test(draft.idempotencyKey))) return null
    return draft
  } catch { return null }
}
export function savePurchaseDraft(userId: number, draft: PurchaseDraft) {
  const form = draft.form
  try {
    localStorage.setItem(key(userId), JSON.stringify({ source: draft.source, savedAt: draft.savedAt, idempotencyKey: draft.idempotencyKey || null, form: {
      name: form.name, packageId: form.packageId, planId: form.planId, hostId: form.hostId,
      image: form.image, cpu: form.cpu, memory: form.memory, disk: form.disk,
      sshKeyId: form.sshKeyId, customInitCommandIds: form.customInitCommandIds,
      promoCode: form.promoCode, autoRemotePort: form.autoRemotePort
    } }))
  } catch { /* Storage may be disabled; the current form remains usable. */ }
}
export function clearPurchaseDraft(userId: number) {
  try { localStorage.removeItem(key(userId)) } catch { /* Storage may be disabled. */ }
}
