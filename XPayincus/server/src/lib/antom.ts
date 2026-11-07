import { createSign, createVerify } from 'node:crypto'
import { assertSafeHttpUrl, safeOutboundDispatcher } from './outbound-security.js'

const ANTOM_ENDPOINT_HOSTS = new Set([
  'open.antglobal-us.com',
  'open-na-global.alipay.com',
  'open-na.alipay.com',
  'open-sea-global.alipay.com',
  'open-sea.alipay.com',
  'open-de-global.alipay.com',
  'open-eu.alipay.com'
])

const CURRENCY_PATTERN = /^[A-Z]{3}$/
const REGION_PATTERN = /^[A-Z]{2}$/
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{3,64}$/
const PAYMENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const DEFAULT_ENDPOINT = 'https://open-sea-global.alipay.com'
const DEFAULT_TIMEOUT_MS = 15_000

export type AntomEnvironment = 'sandbox' | 'production'

export interface AntomConfig {
  environment: AntomEnvironment
  apiurl: string
  clientId: string
  antomPublicKey: string
  merchantPrivateKey: string
  keyVersion: number
  currency: string
  currencyRate: number
  currencyExponent: number
  merchantRegion?: string
  settlementCurrency?: string
  merchantAccountId?: string
  locale?: string
  orderDescription: string
  sessionExpiryMinutes: number
}

export interface AntomAmount {
  currency: string
  value: string
}

export interface AntomResult {
  resultCode?: string
  resultMessage?: string
  resultStatus?: 'S' | 'F' | 'U' | string
}

export interface AntomPaymentSessionResponse {
  normalUrl?: string
  paymentSessionData?: string
  paymentSessionExpiryTime?: string
  paymentSessionId?: string
  result?: AntomResult
}

export interface AntomPaymentInquiryResponse {
  result?: AntomResult
  paymentStatus?: 'SUCCESS' | 'FAIL' | 'PROCESSING' | 'CANCELLED' | string
  paymentResultCode?: string
  paymentResultMessage?: string
  paymentRequestId?: string
  paymentId?: string
  paymentAmount?: AntomAmount
  actualPaymentAmount?: AntomAmount
}

export interface AntomPaymentNotification {
  notifyType?: string
  paymentRequestId?: string
  paymentId?: string
  paymentAmount?: AntomAmount
  actualPaymentAmount?: AntomAmount
  result?: AntomResult
}

interface AntomFetchResponse {
  ok: boolean
  status: number
  headers: Headers
  text(): Promise<string>
}

type AntomFetch = (
  input: string | URL,
  init?: RequestInit & { dispatcher?: unknown }
) => Promise<AntomFetchResponse>

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizePem(value: string, label: string, kind: 'PUBLIC KEY' | 'PRIVATE KEY'): string {
  const trimmed = value.trim().replace(/\\n/g, '\n')
  if (!trimmed) throw new Error(`${label}不能为空`)
  if (trimmed.includes('-----BEGIN ')) return trimmed

  const body = trimmed.replace(/\s+/g, '')
  if (!/^[A-Za-z0-9+/=]+$/.test(body)) throw new Error(`${label}格式不合法`)
  const lines = body.match(/.{1,64}/g) || []
  return `-----BEGIN ${kind}-----\n${lines.join('\n')}\n-----END ${kind}-----`
}

function normalizeEndpoint(value: unknown): string {
  const candidate = normalizeString(value) || DEFAULT_ENDPOINT
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    throw new Error('Antom API 地址不合法')
  }
  if (parsed.protocol !== 'https:' || !ANTOM_ENDPOINT_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error('Antom API 地址必须使用官方 HTTPS 网关')
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new Error('Antom API 地址只能填写官方网关域名，不要包含 API 路径')
  }
  return `${parsed.protocol}//${parsed.host}`
}

export function buildAntomConfig(input: Record<string, unknown>): {
  config: AntomConfig
  valid: boolean
  error?: string
} {
  try {
    const environment = input.environment === 'production' ? 'production' : 'sandbox'
    const clientId = normalizeString(input.clientId ?? input.client_id)
    if (!CLIENT_ID_PATTERN.test(clientId)) throw new Error('Antom Client ID 不合法')

    const currency = (normalizeString(input.currency) || 'USD').toUpperCase()
    if (!CURRENCY_PATTERN.test(currency)) throw new Error('Antom 支付币种必须是三位大写代码')

    const currencyRate = Number(input.currencyRate ?? input.currency_rate ?? 1)
    if (!Number.isFinite(currencyRate) || currencyRate <= 0 || currencyRate > 1_000_000) {
      throw new Error('Antom 币种换算率不合法')
    }

    const currencyExponent = Number(input.currencyExponent ?? input.currency_exponent ?? 2)
    if (!Number.isSafeInteger(currencyExponent) || currencyExponent < 0 || currencyExponent > 3) {
      throw new Error('Antom 币种小数位必须是 0 到 3 的整数')
    }

    const keyVersion = Number(input.keyVersion ?? input.key_version ?? 1)
    if (!Number.isSafeInteger(keyVersion) || keyVersion < 0 || keyVersion > 999) {
      throw new Error('Antom Key Version 不合法')
    }

    const sessionExpiryMinutes = Number(input.sessionExpiryMinutes ?? input.session_expiry_minutes ?? 30)
    if (!Number.isSafeInteger(sessionExpiryMinutes) || sessionExpiryMinutes < 5 || sessionExpiryMinutes > 60) {
      throw new Error('Antom 支付会话有效期必须在 5 到 60 分钟之间')
    }

    const merchantRegion = normalizeString(input.merchantRegion ?? input.merchant_region).toUpperCase()
    if (merchantRegion && !REGION_PATTERN.test(merchantRegion)) throw new Error('Antom 商户地区必须是两位代码')

    const settlementCurrency = normalizeString(input.settlementCurrency ?? input.settlement_currency).toUpperCase()
    if (settlementCurrency && !CURRENCY_PATTERN.test(settlementCurrency)) {
      throw new Error('Antom 结算币种必须是三位大写代码')
    }

    const merchantAccountId = normalizeString(input.merchantAccountId ?? input.merchant_account_id)
    if (merchantAccountId.length > 64) throw new Error('Antom Merchant Account ID 过长')

    const locale = normalizeString(input.locale)
    if (locale.length > 16) throw new Error('Antom 页面语言代码过长')

    const orderDescription = normalizeString(input.orderDescription ?? input.order_description) || 'XPayincus account recharge'
    if (orderDescription.length > 256) throw new Error('Antom 订单描述过长')

    const config: AntomConfig = {
      environment,
      apiurl: normalizeEndpoint(input.apiurl),
      clientId,
      antomPublicKey: normalizePem(
        normalizeString(input.antom_public_key ?? input.antomPublicKey),
        'Antom 公钥',
        'PUBLIC KEY'
      ),
      merchantPrivateKey: normalizePem(
        normalizeString(input.merchant_private_key ?? input.merchantPrivateKey),
        '商户私钥',
        'PRIVATE KEY'
      ),
      keyVersion,
      currency,
      currencyRate,
      currencyExponent,
      ...(merchantRegion ? { merchantRegion } : {}),
      ...(settlementCurrency ? { settlementCurrency } : {}),
      ...(merchantAccountId ? { merchantAccountId } : {}),
      ...(locale ? { locale } : {}),
      orderDescription,
      sessionExpiryMinutes
    }

    return { config, valid: true }
  } catch (error) {
    return {
      config: {
        environment: 'sandbox',
        apiurl: DEFAULT_ENDPOINT,
        clientId: '',
        antomPublicKey: '',
        merchantPrivateKey: '',
        keyVersion: 1,
        currency: 'USD',
        currencyRate: 1,
        currencyExponent: 2,
        orderDescription: 'XPayincus account recharge',
        sessionExpiryMinutes: 30
      },
      valid: false,
      error: error instanceof Error ? error.message : 'Antom 配置不合法'
    }
  }
}

function getApiPath(config: AntomConfig, endpoint: 'createPaymentSession' | 'inquiryPayment'): string {
  const prefix = config.environment === 'sandbox' ? '/ams/sandbox/api' : '/ams/api'
  return `${prefix}/v1/payments/${endpoint}`
}

function createContentToSign(method: string, uri: string, clientId: string, requestTime: string, body: string): string {
  return `${method.toUpperCase()} ${uri}\n${clientId}.${requestTime}.${body}`
}

function parseSignatureValue(header: string): string | null {
  const match = header.match(/(?:^|,\s*)signature=([^,\s]+)/i)
  if (!match?.[1]) return null
  try {
    return decodeURIComponent(match[1])
  } catch {
    return null
  }
}

export function signAntomContent(content: string, merchantPrivateKey: string): string {
  const signer = createSign('RSA-SHA256')
  signer.update(content, 'utf8')
  signer.end()
  return signer.sign(merchantPrivateKey).toString('base64')
}

export function verifyAntomContent(content: string, signatureHeader: string, antomPublicKey: string): boolean {
  const signature = parseSignatureValue(signatureHeader)
  if (!signature) return false
  try {
    const verifier = createVerify('RSA-SHA256')
    verifier.update(content, 'utf8')
    verifier.end()
    return verifier.verify(antomPublicKey, Buffer.from(signature, 'base64'))
  } catch {
    return false
  }
}

export function calculateAntomMinorAmount(amountCny: number, config: AntomConfig): string {
  const multiplier = 10 ** config.currencyExponent
  const minor = Math.round(amountCny * config.currencyRate * multiplier)
  if (!Number.isSafeInteger(minor) || minor <= 0) throw new Error('Antom 支付金额换算结果不合法')
  return String(minor)
}

export function antomMinorAmountToCny(value: unknown, config: AntomConfig): number | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null
  const minor = Number(value)
  if (!Number.isSafeInteger(minor) || minor <= 0) return null
  const amountCny = minor / (10 ** config.currencyExponent) / config.currencyRate
  return Math.round(amountCny * 100) / 100
}

export function verifyAntomWebhook(input: {
  config: AntomConfig
  method: string
  requestUri: string
  requestTime: string
  clientId: string
  signature: string
  rawBody: string
}): boolean {
  if (input.clientId !== input.config.clientId || !input.requestTime || !input.rawBody) return false
  const content = createContentToSign(
    input.method,
    input.requestUri,
    input.clientId,
    input.requestTime,
    input.rawBody
  )
  return verifyAntomContent(content, input.signature, input.config.antomPublicKey)
}

export function antomNotificationResponse(success: boolean): {
  result: { resultCode: string; resultStatus: 'S' | 'F'; resultMessage: string }
} {
  return {
    result: {
      resultCode: success ? 'SUCCESS' : 'FAIL',
      resultStatus: success ? 'S' : 'F',
      resultMessage: success ? 'Success' : 'Failed'
    }
  }
}

export class AntomClient {
  constructor(
    private readonly config: AntomConfig,
    private readonly fetcher: AntomFetch = fetch as AntomFetch
  ) {}

  private async call<T extends { result?: AntomResult }>(
    endpoint: 'createPaymentSession' | 'inquiryPayment',
    payload: Record<string, unknown>
  ): Promise<T> {
    const path = getApiPath(this.config, endpoint)
    const url = await assertSafeHttpUrl(`${this.config.apiurl}${path}`, 'Antom API URL')
    if (!ANTOM_ENDPOINT_HOSTS.has(url.hostname.toLowerCase())) {
      throw new Error('Antom API 地址不在官方网关白名单中')
    }

    const body = JSON.stringify(payload)
    const requestTime = String(Date.now())
    const content = createContentToSign('POST', path, this.config.clientId, requestTime, body)
    const signature = encodeURIComponent(signAntomContent(content, this.config.merchantPrivateKey))
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)

    let response: AntomFetchResponse
    try {
      response = await this.fetcher(url, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json; charset=UTF-8',
          'client-id': this.config.clientId,
          'request-time': requestTime,
          signature: `algorithm=RSA256, keyVersion=${this.config.keyVersion}, signature=${signature}`
        },
        body,
        redirect: 'manual',
        signal: controller.signal,
        dispatcher: safeOutboundDispatcher
      })
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw new Error('Antom API 请求超时')
      throw error
    } finally {
      clearTimeout(timeout)
    }

    const responseBody = await response.text()
    if (!response.ok) throw new Error(`Antom API 返回 HTTP ${response.status}`)

    const responseClientId = response.headers.get('client-id') || ''
    const responseTime = response.headers.get('response-time') || ''
    const responseSignature = response.headers.get('signature') || ''
    const responseContent = createContentToSign('POST', path, responseClientId, responseTime, responseBody)
    if (
      responseClientId !== this.config.clientId ||
      !responseTime ||
      !verifyAntomContent(responseContent, responseSignature, this.config.antomPublicKey)
    ) {
      throw new Error('Antom API 响应签名验证失败')
    }

    let parsed: T
    try {
      parsed = JSON.parse(responseBody) as T
    } catch {
      throw new Error('Antom API 返回了无效 JSON')
    }
    return parsed
  }

  async createPaymentSession(input: {
    orderNo: string
    amountCny: number
    notifyUrl: string
    redirectUrl: string
  }): Promise<AntomPaymentSessionResponse> {
    if (!PAYMENT_ID_PATTERN.test(input.orderNo)) throw new Error('Antom 订单号不合法')
    const amount: AntomAmount = {
      currency: this.config.currency,
      value: calculateAntomMinorAmount(input.amountCny, this.config)
    }
    const payload: Record<string, unknown> = {
      productCode: 'CASHIER_PAYMENT',
      productScene: 'CHECKOUT_PAYMENT',
      paymentRequestId: input.orderNo,
      paymentAmount: amount,
      order: {
        referenceOrderId: input.orderNo,
        orderDescription: this.config.orderDescription,
        orderAmount: amount
      },
      paymentNotifyUrl: input.notifyUrl,
      paymentRedirectUrl: input.redirectUrl,
      paymentSessionExpiryTime: new Date(Date.now() + this.config.sessionExpiryMinutes * 60_000).toISOString(),
      env: { terminalType: 'WEB' },
      ...(this.config.merchantRegion ? { merchantRegion: this.config.merchantRegion } : {}),
      ...(this.config.settlementCurrency
        ? { settlementStrategy: { settlementCurrency: this.config.settlementCurrency } }
        : {}),
      ...(this.config.merchantAccountId ? { merchantAccountId: this.config.merchantAccountId } : {}),
      ...(this.config.locale ? { locale: this.config.locale } : {})
    }
    return this.call<AntomPaymentSessionResponse>('createPaymentSession', payload)
  }

  async inquiryPayment(paymentRequestId: string): Promise<AntomPaymentInquiryResponse> {
    if (!PAYMENT_ID_PATTERN.test(paymentRequestId)) throw new Error('Antom 订单号不合法')
    return this.call<AntomPaymentInquiryResponse>('inquiryPayment', { paymentRequestId })
  }
}
