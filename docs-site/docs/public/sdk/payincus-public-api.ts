export type XPayincusPublicApiSort = 'createdAt' | '-createdAt' | 'updatedAt' | '-updatedAt' | 'displayOrder' | '-displayOrder'
export type XPayincusPublicApiScope =
  | 'profile:read'
  | 'profile:write'
  | 'balance:read'
  | 'balance:write'
  | 'billing:read'
  | 'products:read'
  | 'services:read'
  | 'services:operate'
  | 'services:billing'
  | 'orders:read'
  | 'tickets:read'
  | 'tickets:write'
  | 'notifications:read'
  | 'notifications:send'

export interface XPayincusPublicApiErrorBody {
  code?: string
  message?: string
  error?: string
  details?: unknown
  retryAfter?: number
}

export interface XPayincusPublicApiScopeMetadata {
  scope: XPayincusPublicApiScope
  title: string
  description: string
  risk: 'low' | 'medium' | 'high'
  access: 'read' | 'write' | 'operate'
  resources: string[]
  implemented: boolean
  notes?: string
}

export interface XPayincusListOptions {
  page?: number
  pageSize?: number
  sort?: XPayincusPublicApiSort
}

export interface XPayincusListMeta {
  page: number
  pageSize: number
  total: number
  totalPages: number
  sort?: string
}

export interface XPayincusListResponse<T> {
  data: T[]
  meta: XPayincusListMeta
}

export interface XPayincusResponse<T> {
  data: T
}

export class XPayincusPublicApiError extends Error {
  status: number
  code?: string
  details?: unknown
  retryAfter?: number

  constructor(status: number, body: XPayincusPublicApiErrorBody | null, fallback: string) {
    super(body?.message || body?.error || fallback)
    this.name = 'XPayincusPublicApiError'
    this.status = status
    this.code = body?.code
    this.details = body?.details
    this.retryAfter = body?.retryAfter
  }
}

export interface XPayincusProfile {
  id: number
  username: string
  email?: string
  role: string
  status: string
  avatarStyle?: string
}

export interface XPayincusBalance {
  balance: string
  currency?: string
}

export interface XPayincusBalanceLog {
  id: number
  type: string
  amount: string
  createdAt: string
  description?: string
}

export interface XPayincusBalanceLogOptions extends XPayincusListOptions {
  type?: string
  lotteryGift?: boolean
}

export interface XPayincusBalanceAdjustmentRequest {
  id: number
  amount: string
  reason: string
  status: 'pending' | 'approved' | 'rejected'
  createdAt: string
}

export interface XPayincusBalanceAdjustmentRequestListOptions extends XPayincusListOptions {
  status?: 'pending' | 'approved' | 'rejected'
}

export interface XPayincusCreateBalanceAdjustmentRequestInput {
  amount: number | string
  reason: string
  externalReference?: string
}

export interface XPayincusBillingRecord {
  id: number
  serviceId?: number
  type: string
  amount: string
  status: string
  createdAt: string
}

export interface XPayincusBillingRecordListOptions extends XPayincusListOptions {
  type?: string
  serviceId?: number
}

export interface XPayincusProduct {
  id: number
  name: string
  description?: string
  plans?: unknown[]
}

export type XPayincusServiceStatus = 'running' | 'stopped' | 'suspended' | 'pending' | 'failed'
export type XPayincusServiceInclude = 'product' | 'plan'

export interface XPayincusServiceIncludeOptions {
  include?: XPayincusServiceInclude | XPayincusServiceInclude[]
}

export interface XPayincusServiceListOptions extends XPayincusListOptions, XPayincusServiceIncludeOptions {
  status?: XPayincusServiceStatus | string
}

export interface XPayincusServiceIncluded {
  product?: XPayincusProduct
  plan?: unknown
}

export interface XPayincusService {
  id: number
  name: string
  status: XPayincusServiceStatus | string
  expiresAt?: string
  included?: XPayincusServiceIncluded
}

export type XPayincusServiceListResponse = XPayincusListResponse<XPayincusService>
export type XPayincusServiceResponse = XPayincusResponse<XPayincusService>
export type XPayincusServiceAction = 'start' | 'stop' | 'restart'

export interface XPayincusServiceTask {
  id: number
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'
  progress?: number
  error?: string
}

export interface XPayincusServiceActionResult {
  task: XPayincusServiceTask
}

export interface XPayincusServiceRenewResult {
  service: XPayincusService
  billingRecord?: XPayincusBillingRecord
}

export interface XPayincusOrderListOptions extends XPayincusListOptions {
  status?: string
}

export interface XPayincusOrder {
  id: string
  type: string
  status: string
  amount: string
  createdAt: string
}

export interface XPayincusTicketAttachment {
  id?: number
  name: string
  url?: string
  size?: number
  mimeType?: string
}

export interface XPayincusTicketImageAttachment {
  blob: Blob
  filename: string
}

export interface XPayincusTicketListOptions extends XPayincusListOptions {
  status?: string
  category?: string
  priority?: string
}

export interface XPayincusCreateTicketInput {
  subject: string
  category?: string
  priority?: string
  content: string
  attachments?: XPayincusTicketImageAttachment[]
}

export interface XPayincusCreateTicketReplyInput {
  content: string
  attachments?: XPayincusTicketImageAttachment[]
}

export interface XPayincusTicket {
  id: number
  subject: string
  status: string
  messages?: unknown[]
  attachments?: XPayincusTicketAttachment[]
}

export type XPayincusTicketStatusAction = 'close' | 'reopen'
export interface XPayincusTicketStatusResult {
  id: number
  status: string
}

export interface XPayincusNotificationListOptions extends XPayincusListOptions {
  isRead?: boolean
}

export type XPayincusNotificationTemplateId = 'service_action_update' | 'billing_notice'

export interface XPayincusNotificationInput {
  title?: string
  message?: string
  template: XPayincusNotificationTemplateId | null
  variables?: Record<string, string | number | boolean>
  source?: string
}

export interface XPayincusPublicApiClientOptions {
  baseUrl: string
  token: string
}

export class XPayincusPublicApiClient {
  private baseUrl: string
  private token: string

  constructor(options: XPayincusPublicApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.token = options.token
  }

  private query(options: Record<string, unknown> = {}): string {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(options)) {
      if (value === undefined || value === null) continue
      params.set(key, Array.isArray(value) ? value.join(',') : String(value))
    }
    const text = params.toString()
    return text ? `?${text}` : ''
  }

  private parsePayload(text: string): unknown {
    if (!text) return null
    try {
      return JSON.parse(text)
    } catch {
      return { error: text }
    }
  }

  private errorBody(payload: unknown): XPayincusPublicApiErrorBody | null {
    if (!payload || typeof payload !== 'object') return null
    return payload as XPayincusPublicApiErrorBody
  }

  private ticketFormData(input: XPayincusCreateTicketInput | XPayincusCreateTicketReplyInput): FormData {
    const form = new FormData()
    form.append('content', input.content)
    if ('subject' in input) form.append('subject', input.subject)
    if ('category' in input && input.category) form.append('category', input.category)
    if ('priority' in input && input.priority) form.append('priority', input.priority)
    for (const attachment of input.attachments || []) {
      const { blob, filename } = attachment
      form.append('images', blob, filename)
    }
    return form
  }

  private async request<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
    const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData
    const headers = {
      Authorization: `Bearer ${this.token}`,
      ...(options.body === undefined || isFormData ? {} : { 'Content-Type': 'application/json' })
    }
    const response = await fetch(`${this.baseUrl}/api/v1${path}`, {
      method: options.method || 'GET',
      headers,
      body: options.body === undefined ? undefined : isFormData ? options.body as BodyInit : JSON.stringify(options.body)
    })
    const payload = await this.parsePayload(await response.text())
    if (!response.ok) {
      const errorBody = this.errorBody(payload)
      throw new XPayincusPublicApiError(response.status, errorBody, errorBody?.details ?? payload ? String(errorBody?.details ?? 'Request failed') : 'Request failed')
    }
    return payload as T
  }

  private async oauthProviderRequest<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}/api/oauth-provider${path}`, {
      method: options.method || 'GET',
      headers: options.body ? { 'Content-Type': 'application/json' } : {},
      body: options.body ? JSON.stringify(options.body) : undefined
    })
    const payload = await this.parsePayload(await response.text())
    if (!response.ok) throw new XPayincusPublicApiError(response.status, this.errorBody(payload), 'OAuth provider request failed')
    return payload as T
  }

  listOAuthScopes() {
    return this.oauthProviderRequest('/scopes') as Promise<XPayincusResponse<XPayincusPublicApiScopeMetadata[]>>
  }

  getProfile() {
    return this.request<XPayincusResponse<XPayincusProfile>>('/me')
  }

  updateProfile(input: { avatarStyle: string }) {
    return this.request('/me', { method: 'PATCH', body: input }) as Promise<XPayincusResponse<XPayincusProfile>>
  }

  getBalance() {
    return this.request<XPayincusResponse<XPayincusBalance>>('/balance')
  }

  listBalanceLogs(options: XPayincusBalanceLogOptions = {}) {
    return this.request<XPayincusListResponse<XPayincusBalanceLog>>(`/balance/logs${this.query(options)}`)
  }

  listBalanceAdjustmentRequests(options: XPayincusBalanceAdjustmentRequestListOptions = {}) {
    return this.request(`/balance/adjustment-requests${this.query(options)}`) as Promise<XPayincusListResponse<XPayincusBalanceAdjustmentRequest>>
  }

  createBalanceAdjustmentRequest(input: XPayincusCreateBalanceAdjustmentRequestInput) {
    return this.request('/balance/adjustment-requests', { method: 'POST', body: input }) as Promise<XPayincusResponse<XPayincusBalanceAdjustmentRequest>>
  }

  listBillingRecords(options: XPayincusBillingRecordListOptions = {}) {
    return this.request(`/billing-records${this.query(options)}`) as Promise<XPayincusListResponse<XPayincusBillingRecord>>
  }

  getBillingRecord(id: number) {
    return this.request(`/billing-records/${id}`) as Promise<XPayincusResponse<XPayincusBillingRecord>>
  }

  listProducts(options: XPayincusListOptions = {}) {
    return this.request<XPayincusListResponse<XPayincusProduct>>(`/products${this.query(options)}`)
  }

  getProduct(id: number) {
    return this.request<XPayincusResponse<XPayincusProduct>>(`/products/${id}`)
  }

  listServices(options: XPayincusServiceListOptions = {}) {
    return this.request<XPayincusServiceListResponse>(`/services${this.query(options)}`)
  }

  getService(id: number, options: XPayincusServiceIncludeOptions = {}) {
    return this.request<XPayincusServiceResponse>(`/services/${id}${this.query(options)}`)
  }

  queueServiceAction(id: number, action: XPayincusServiceAction) {
    return this.request(`/services/${id}/actions`, { method: 'POST', body: { action } }) as Promise<XPayincusResponse<XPayincusServiceActionResult>>
  }

  getServiceTask(id: number, taskId: number) {
    return this.request(`/services/${id}/tasks/${taskId}`) as Promise<XPayincusResponse<XPayincusServiceTask>>
  }

  cancelServiceTask(id: number, taskId: number) {
    return this.request(`/services/${id}/tasks/${taskId}`, { method: 'DELETE' }) as Promise<XPayincusResponse<XPayincusServiceTask>>
  }

  renewService(id: number, months: number) {
    return this.request(`/services/${id}/renew`, { method: 'POST', body: { months } }) as Promise<XPayincusResponse<XPayincusServiceRenewResult>>
  }

  listOrders(options: XPayincusOrderListOptions = {}) {
    return this.request<XPayincusListResponse<XPayincusOrder>>(`/orders${this.query(options)}`)
  }

  getOrder(id: string) {
    return this.request(`/orders/${encodeURIComponent(id)}`) as Promise<XPayincusResponse<XPayincusOrder>>
  }

  listTickets(options: XPayincusTicketListOptions = {}) {
    return this.request<XPayincusListResponse<XPayincusTicket>>(`/tickets${this.query(options)}`)
  }

  createTicket(input: XPayincusCreateTicketInput) {
    const attachments = input.attachments
    return this.request('/tickets', {
      method: 'POST',
      body: attachments?.length ? this.ticketFormData(input) : input
    }) as Promise<XPayincusResponse<XPayincusTicket>>
  }

  getTicket(id: number) {
    return this.request<XPayincusResponse<XPayincusTicket>>(`/tickets/${id}`)
  }

  replyToTicket(id: number, input: string | XPayincusCreateTicketReplyInput) {
    const payload = typeof input === 'string' ? { content: input } : input
    const attachments = payload.attachments
    return this.request<XPayincusResponse<XPayincusTicket>>(`/tickets/${id}/replies`, {
      method: 'POST',
      body: attachments?.length ? this.ticketFormData(payload) : payload
    })
  }

  updateTicketStatus(id: number, action: XPayincusTicketStatusAction) {
    return this.request(`/tickets/${id}/status`, { method: 'PATCH', body: { action } }) as Promise<XPayincusResponse<XPayincusTicketStatusResult>>
  }

  listNotifications(options: XPayincusNotificationListOptions = {}) {
    return this.request<XPayincusListResponse<unknown>>(`/notifications${this.query(options)}`)
  }

  getUnreadNotificationCount() {
    return this.request<XPayincusResponse<{ count: number }>>('/notifications/unread-count')
  }

  sendNotification(input: XPayincusNotificationInput) {
    return this.request('/notifications', { method: 'POST', body: input }) as Promise<XPayincusResponse<unknown>>
  }

}
