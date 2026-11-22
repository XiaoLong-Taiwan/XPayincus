import { nanoid } from 'nanoid'

export type ActionTicketType = 'oauth-bind' | 'terminal' | 'monitoring-stream'

interface BaseActionTicket {
  type: ActionTicketType
  userId: number
  issuedAt: number
  sessionId?: string
  expiresAt: number
  createdAt: number
  usageCount: number
  maxUsage: number
}

interface OAuthBindTicket extends BaseActionTicket {
  type: 'oauth-bind'
}

interface TerminalTicket extends BaseActionTicket {
  type: 'terminal'
  instanceId: number
}

interface MonitoringStreamTicket extends BaseActionTicket {
  type: 'monitoring-stream'
  instanceId: number
}

type ActionTicket = OAuthBindTicket | TerminalTicket | MonitoringStreamTicket

const actionTickets = new Map<string, ActionTicket>()

const ACTION_TICKET_TTL_MS = {
  'oauth-bind': 60 * 1000,
  terminal: 60 * 1000,
  'monitoring-stream': 30 * 1000
} as const

setInterval(() => {
  const now = Date.now()
  for (const [token, data] of actionTickets.entries()) {
    if (now > data.expiresAt || data.usageCount >= data.maxUsage) {
      actionTickets.delete(token)
    }
  }
}, 60 * 1000)

function createTicket<T extends ActionTicket>(ticket: T): string {
  const token = nanoid(32)
  actionTickets.set(token, ticket)
  return token
}

export function generateOAuthBindTicket(
  userId: number,
  issuedAt: number,
  sessionId?: string
): string {
  const now = Date.now()
  return createTicket({
    type: 'oauth-bind',
    userId,
    issuedAt,
    sessionId,
    expiresAt: now + ACTION_TICKET_TTL_MS['oauth-bind'],
    createdAt: now,
    usageCount: 0,
    maxUsage: 1
  })
}

export function generateTerminalAccessTicket(
  userId: number,
  instanceId: number,
  issuedAt: number,
  sessionId?: string
): string {
  const now = Date.now()
  return createTicket({
    type: 'terminal',
    userId,
    instanceId,
    issuedAt,
    sessionId,
    expiresAt: now + ACTION_TICKET_TTL_MS.terminal,
    createdAt: now,
    usageCount: 0,
    maxUsage: 1
  })
}

export function generateMonitoringStreamAccessTicket(
  userId: number,
  instanceId: number,
  issuedAt: number,
  sessionId?: string
): string {
  const now = Date.now()
  return createTicket({
    type: 'monitoring-stream',
    userId,
    instanceId,
    issuedAt,
    sessionId,
    expiresAt: now + ACTION_TICKET_TTL_MS['monitoring-stream'],
    createdAt: now,
    usageCount: 0,
    maxUsage: 1
  })
}

export interface OAuthBindTicketConsumeResult {
  valid: boolean
  userId?: number
  issuedAt?: number
  sessionId?: string
  error?: string
}

export interface TerminalTicketConsumeResult {
  valid: boolean
  userId?: number
  instanceId?: number
  issuedAt?: number
  sessionId?: string
  error?: string
}

export interface MonitoringStreamTicketConsumeResult {
  valid: boolean
  userId?: number
  instanceId?: number
  issuedAt?: number
  sessionId?: string
  error?: string
}

export function inspectMonitoringStreamAccessTicket(
  token: string,
  expectedInstanceId?: number
): MonitoringStreamTicketConsumeResult {
  const ticket = actionTickets.get(token)
  if (!ticket || ticket.type !== 'monitoring-stream') {
    return { valid: false, error: 'Ticket not found or already used' }
  }
  if (Date.now() > ticket.expiresAt) {
    actionTickets.delete(token)
    return { valid: false, error: 'Ticket expired' }
  }
  if (expectedInstanceId !== undefined && ticket.instanceId !== expectedInstanceId) {
    return { valid: false, error: 'Instance mismatch' }
  }
  return {
    valid: true,
    userId: ticket.userId,
    instanceId: ticket.instanceId,
    issuedAt: ticket.issuedAt,
    sessionId: ticket.sessionId
  }
}

export function consumeOAuthBindTicket(token: string): OAuthBindTicketConsumeResult {
  const ticket = actionTickets.get(token)
  if (!ticket || ticket.type !== 'oauth-bind') {
    return { valid: false, error: 'Ticket not found or already used' }
  }

  if (Date.now() > ticket.expiresAt) {
    actionTickets.delete(token)
    return { valid: false, error: 'Ticket expired' }
  }

  ticket.usageCount += 1
  if (ticket.usageCount >= ticket.maxUsage) {
    actionTickets.delete(token)
  } else {
    actionTickets.set(token, ticket)
  }

  return {
    valid: true,
    userId: ticket.userId,
    issuedAt: ticket.issuedAt,
    sessionId: ticket.sessionId
  }
}

export function consumeTerminalAccessTicket(
  token: string,
  expectedInstanceId?: number
): TerminalTicketConsumeResult {
  const ticket = actionTickets.get(token)
  if (!ticket || ticket.type !== 'terminal') {
    return { valid: false, error: 'Ticket not found or already used' }
  }

  if (Date.now() > ticket.expiresAt) {
    actionTickets.delete(token)
    return { valid: false, error: 'Ticket expired' }
  }

  if (expectedInstanceId !== undefined && ticket.instanceId !== expectedInstanceId) {
    actionTickets.delete(token)
    return { valid: false, error: 'Instance mismatch' }
  }

  ticket.usageCount += 1
  if (ticket.usageCount >= ticket.maxUsage) {
    actionTickets.delete(token)
  } else {
    actionTickets.set(token, ticket)
  }

  return {
    valid: true,
    userId: ticket.userId,
    instanceId: ticket.instanceId,
    issuedAt: ticket.issuedAt,
    sessionId: ticket.sessionId
  }
}

export function consumeMonitoringStreamAccessTicket(
  token: string,
  expectedInstanceId?: number
): MonitoringStreamTicketConsumeResult {
  const inspected = inspectMonitoringStreamAccessTicket(token, expectedInstanceId)
  if (!inspected.valid) return inspected
  actionTickets.delete(token)
  return inspected
}

export function revokeActionTicketsForSession(sessionId: string): number {
  let revoked = 0
  for (const [token, data] of actionTickets.entries()) {
    if (data.sessionId === sessionId) {
      actionTickets.delete(token)
      revoked += 1
    }
  }
  return revoked
}
