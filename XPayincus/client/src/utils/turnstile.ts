/**
 * Turnstile 工具函数
 * 用于在 API 调用前执行隐式验证，以及从可见组件读取 token。
 */
import { useTurnstile } from '@/composables/useTurnstile'
import i18n from '@/locales'

interface TurnstileTokenReader {
  getToken?: () => string
}

let globalTurnstile: ReturnType<typeof useTurnstile> | null = null

export function getGlobalTurnstile() {
  if (!globalTurnstile) {
    globalTurnstile = useTurnstile()
  }
  return globalTurnstile
}

export async function getTurnstileToken(_action?: string): Promise<string | undefined> {
  const turnstile = getGlobalTurnstile()

  if (!turnstile.isEnabled.value) {
    return undefined
  }

  try {
    return await turnstile.execute()
  } catch (error) {
    console.error('Turnstile verification failed:', error)
    throw new Error(i18n.global.t('common.turnstileFailed'))
  }
}

export async function withTurnstile<T extends Record<string, any>>(
  data: T,
  action?: string
): Promise<T & { turnstileToken?: string }> {
  const token = await getTurnstileToken(action)
  return {
    ...data,
    turnstileToken: token
  }
}

export function readTurnstileToken(
  widget: TurnstileTokenReader | null | undefined,
  currentToken: string,
  root: ParentNode = document
): string {
  const widgetToken = widget?.getToken?.()?.trim()
  if (widgetToken) return widgetToken

  const stateToken = currentToken.trim()
  if (stateToken) return stateToken

  return root
    .querySelector<HTMLInputElement>('input[name="cf-turnstile-response"]')
    ?.value
    ?.trim() || ''
}

export function focusTurnstileSection(section: HTMLElement | null | undefined): void {
  if (!section) return

  section.scrollIntoView({ behavior: 'smooth', block: 'center' })
  window.setTimeout(() => {
    section.focus({ preventScroll: true })
  }, 250)
}
