import type { HeleketConfig, HeleketPayment } from './heleket.js'
import { extractHeleketPaymentDetails, getHeleketInvoiceAmount } from './heleket.js'
import type { AntomConfig, AntomPaymentInquiryResponse, AntomPaymentNotification } from './antom.js'
import { calculateAntomMinorAmount } from './antom.js'

export interface RechargePaymentDetails {
  kind?: string
  recharge?: {
    amount?: number | null
    payableAmount?: number | null
    fee?: number | null
    feeRate?: number | null
    feeFixed?: number | null
    feeMode?: 'surcharge' | 'deduct'
    paymentMethod?: string | null
  }
  manual?: {
    instructions?: string | null
  }
  heleket?: {
    invoiceCurrency?: string | null
    invoiceAmount?: number | null
    lifetimeSeconds?: number | null
    orderId?: string | null
    status?: string | null
    statusDescription?: string | null
    uuid?: string | null
    txid?: string | null
    payerCurrency?: string | null
    network?: string | null
    paymentMethodCode?: string | null
    paymentAmount?: string | null
    paymentAmountUsd?: string | null
    merchantAmount?: string | null
    address?: string | null
    from?: string | null
  }
  antom?: {
    paymentRequestId?: string | null
    paymentId?: string | null
    currency?: string | null
    amountMinor?: string | null
    currencyRate?: number | null
    currencyExponent?: number | null
    status?: string | null
    statusDescription?: string | null
  }
}

export function buildManualRechargePaymentDetails(instructions: string): RechargePaymentDetails {
  return {
    kind: 'manual',
    manual: {
      instructions
    }
  }
}

export interface RechargePaymentDisplayInfo {
  invoiceCurrency: string | null
  paymentCurrency: string | null
  paymentNetwork: string | null
  actualPaymentMethod: string | null
  paymentUuid: string | null
  paymentTxid: string | null
  gatewayStatus: string | null
  gatewayStatusDescription: string | null
}

export function readRechargePaymentDetails(value: unknown): RechargePaymentDetails {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }

  return value as RechargePaymentDetails
}

export function buildHeleketInvoicePaymentDetails(
  orderNo: string,
  amount: number,
  config: HeleketConfig
): RechargePaymentDetails {
  return {
    kind: 'heleket',
    heleket: {
      orderId: orderNo,
      invoiceCurrency: config.currency || 'CNY',
      invoiceAmount: amount,
      lifetimeSeconds: config.lifetimeSeconds
    }
  }
}

export function buildAntomPaymentDetails(
  orderNo: string,
  amountCny: number,
  config: AntomConfig
): RechargePaymentDetails {
  return {
    kind: 'antom',
    antom: {
      paymentRequestId: orderNo,
      currency: config.currency,
      amountMinor: calculateAntomMinorAmount(amountCny, config),
      currencyRate: config.currencyRate,
      currencyExponent: config.currencyExponent,
      status: 'PENDING'
    }
  }
}

export function mergeRechargeAmountDetails(
  existingValue: unknown,
  input: {
    amount: number
    payableAmount: number
    fee: number
    feeRate: number
    feeFixed: number
    feeMode?: 'surcharge' | 'deduct'
    paymentMethod?: string | null
  }
): RechargePaymentDetails {
  const existing = readRechargePaymentDetails(existingValue)

  return {
    ...existing,
    recharge: {
      ...existing.recharge,
      amount: input.amount,
      payableAmount: input.payableAmount,
      fee: input.fee,
      feeRate: input.feeRate,
      feeFixed: input.feeFixed,
      feeMode: input.feeMode || 'surcharge',
      paymentMethod: input.paymentMethod || null
    }
  }
}

export function getRechargePayableAmount(record: { amount: unknown; fee?: unknown; paymentDetails?: unknown }): number {
  const paymentDetails = readRechargePaymentDetails(record.paymentDetails)
  const configuredPayableAmount = paymentDetails.recharge?.payableAmount

  if (configuredPayableAmount !== undefined && configuredPayableAmount !== null) {
    const amount = Number(configuredPayableAmount)
    if (Number.isFinite(amount) && amount > 0) {
      return amount
    }
  }

  return Number(record.amount)
}

export function mergeHeleketPaymentDetails(
  existingValue: unknown,
  payment: HeleketPayment | Record<string, unknown>,
  config?: Partial<HeleketConfig>,
  fallback?: {
    orderNo?: string
    invoiceAmount?: number
  }
): RechargePaymentDetails {
  const existing = readRechargePaymentDetails(existingValue)
  const heleketDetails = extractHeleketPaymentDetails(payment)
  const invoiceAmount = getHeleketInvoiceAmount(payment)

  return {
    ...existing,
    kind: 'heleket',
    heleket: {
      ...existing.heleket,
      orderId: fallback?.orderNo || existing.heleket?.orderId || null,
      invoiceCurrency: config?.currency || existing.heleket?.invoiceCurrency || null,
      invoiceAmount: invoiceAmount ?? fallback?.invoiceAmount ?? existing.heleket?.invoiceAmount ?? null,
      lifetimeSeconds: config?.lifetimeSeconds ?? existing.heleket?.lifetimeSeconds ?? null,
      status: heleketDetails.status,
      statusDescription: heleketDetails.statusDescription,
      uuid: heleketDetails.uuid,
      txid: heleketDetails.txid,
      payerCurrency: heleketDetails.payerCurrency,
      network: heleketDetails.network,
      paymentMethodCode: heleketDetails.paymentMethodCode,
      paymentAmount: heleketDetails.paymentAmount,
      paymentAmountUsd: heleketDetails.paymentAmountUsd,
      merchantAmount: heleketDetails.merchantAmount,
      address: heleketDetails.address,
      from: heleketDetails.from
    }
  }
}

export function mergeAntomPaymentDetails(
  existingValue: unknown,
  payment: AntomPaymentNotification | AntomPaymentInquiryResponse,
  config: AntomConfig,
  fallback: { orderNo: string; amountCny: number }
): RechargePaymentDetails {
  const existing = readRechargePaymentDetails(existingValue)
  const amount = payment.actualPaymentAmount || payment.paymentAmount
  const status = 'paymentStatus' in payment
    ? payment.paymentStatus || null
    : payment.result?.resultStatus || null
  const statusDescription = 'paymentResultMessage' in payment
    ? payment.paymentResultMessage || payment.result?.resultMessage || null
    : payment.result?.resultMessage || null

  return {
    ...existing,
    kind: 'antom',
    antom: {
      ...existing.antom,
      paymentRequestId: payment.paymentRequestId || existing.antom?.paymentRequestId || fallback.orderNo,
      paymentId: payment.paymentId || existing.antom?.paymentId || null,
      currency: amount?.currency || existing.antom?.currency || config.currency,
      amountMinor: amount?.value || existing.antom?.amountMinor || calculateAntomMinorAmount(fallback.amountCny, config),
      currencyRate: existing.antom?.currencyRate ?? config.currencyRate,
      currencyExponent: existing.antom?.currencyExponent ?? config.currencyExponent,
      status,
      statusDescription
    }
  }
}

export function extractRechargePaymentDisplayInfo(value: unknown): RechargePaymentDisplayInfo {
  const details = readRechargePaymentDetails(value)
  const heleket = details.heleket
  const antom = details.antom

  return {
    invoiceCurrency: heleket?.invoiceCurrency || antom?.currency || null,
    paymentCurrency: heleket?.payerCurrency || antom?.currency || null,
    paymentNetwork: heleket?.network || null,
    actualPaymentMethod: heleket?.paymentMethodCode || null,
    paymentUuid: heleket?.uuid || antom?.paymentId || null,
    paymentTxid: heleket?.txid || null,
    gatewayStatus: heleket?.status || antom?.status || null,
    gatewayStatusDescription: heleket?.statusDescription || antom?.statusDescription || null
  }
}
