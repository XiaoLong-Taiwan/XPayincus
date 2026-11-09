import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const clientRoot = resolve(__dirname, '../../client/src')
const apiUrlSource = readFileSync(resolve(clientRoot, 'utils/api-url.ts'), 'utf8')
const telegramViewSource = readFileSync(resolve(clientRoot, 'views/admin/TelegramConfigView.vue'), 'utf8')
const oauthViewSource = readFileSync(resolve(clientRoot, 'views/admin/OAuthConfigView.vue'), 'utf8').replace(/\r\n/g, '\n')

assert.ok(
  apiUrlSource.includes('export function getFrontendOrigin(): string') &&
    apiUrlSource.includes('return window.location.origin'),
  'frontend public callback helpers must use the browser frontend origin'
)
assert.ok(
  apiUrlSource.includes('export function buildPublicApiUrl(path: string): string') &&
    apiUrlSource.includes("return new URL(`/api${normalizePath(path)}`, getFrontendOrigin()).toString()"),
  'frontend public callback URLs must resolve under the frontend /api path'
)
assert.ok(
  !apiUrlSource.includes('getApiBaseOrigin'),
  'API base origin helper should not be kept for public callback URL setup'
)

assert.ok(
  telegramViewSource.includes("import { buildPublicApiUrl, getFrontendOrigin } from '@/utils/api-url'"),
  'Telegram admin view must import public frontend URL helpers'
)
assert.ok(
  telegramViewSource.includes("const telegramWebhookUrl = computed(() => buildPublicApiUrl('/telegram/webhook'))"),
  'Telegram admin view must display the frontend public /api webhook URL'
)
assert.ok(
  telegramViewSource.includes('baseUrl: getFrontendOrigin()'),
  'Telegram webhook setup must submit the frontend origin to the backend'
)
assert.ok(
  !telegramViewSource.includes('getApiBaseOrigin'),
  'Telegram webhook setup must not derive baseUrl from VITE_API_BASE_URL or API origin'
)

assert.ok(
  oauthViewSource.includes("import { CUSTOMER_BASE_URL } from '@/utils/runtime-config'") &&
    oauthViewSource.includes('customerBaseUrl.value = response.customerBaseUrl === undefined') &&
    !oauthViewSource.includes('buildPublicApiUrl') &&
    !oauthViewSource.includes('window.location.origin'),
  'OAuth callback information must prefer server customer configuration, then frontend customer configuration, without using the admin origin'
)

const selection = oauthViewSource.match(/customerBaseUrl\.value = response\.customerBaseUrl === undefined[\s\S]*?: response\.customerBaseUrl/)?.[0]
assert.ok(selection, 'OAuth customer configuration selection must exist')
for (const [serverUrl, expected] of [
  [undefined, 'https://legacy-customer.example'],
  [null, null],
  ['', ''],
  ['https://server-customer.example', 'https://server-customer.example']
] as const) {
  const context = {
    response: { customerBaseUrl: serverUrl },
    CUSTOMER_BASE_URL: 'https://legacy-customer.example',
    customerBaseUrl: { value: null as string | null }
  }
  runInNewContext(selection, context)
  assert.equal(context.customerBaseUrl.value, expected, 'Only older servers without the field may use frontend configuration')
}
assert.ok(oauthViewSource.includes('loading.value = true\n  customerBaseUrl.value = null'), 'Reload must clear stale callback information before requesting configuration')

const oauthSource = readFileSync(resolve(__dirname, '../src/routes/oauth.ts'), 'utf8').replace(/\r\n/g, '\n')
const configsSection = oauthSource.slice(oauthSource.indexOf("fastify.get('/configs'"), oauthSource.indexOf('fastify.put<{'))
assert.ok(
  configsSection.includes('onRequest: [fastify.authenticateAdmin]') &&
    configsSection.includes('customerBaseUrl: getConfiguredCustomerBaseUrl()'),
  'OAuth config information must expose the existing customer base URL only through the admin-protected endpoint'
)

const customerHelpers = oauthSource.slice(oauthSource.indexOf('function normalizePublicBaseUrl('), oauthSource.indexOf('function getConfiguredAdminBaseUrl('))
  .replaceAll(': string | undefined', '')
  .replaceAll(': string | null', '')
  .replaceAll(': string', '')
for (const [env, expected] of [
  [{ SITE_URL: ' https://site.example/path/ ', FRONTEND_URL: 'https://frontend.example,https://other.example' }, 'https://site.example'],
  [{ SITE_URL: ' ', FRONTEND_URL: ' https://frontend.example/path/,https://other.example' }, 'https://frontend.example'],
  [{ ADMIN_FRONTEND_URL: 'https://admin.example' }, null],
  [{ SITE_URL: 'invalid', FRONTEND_URL: 'https://frontend.example' }, null]
] as const) {
  assert.equal(runInNewContext(`${customerHelpers}; getConfiguredCustomerBaseUrl()`, { URL, process: { env } }), expected)
}

const callbackFunction = oauthViewSource.match(/function getCallbackUrl\(path\?: string\): string \{[\s\S]*?\n\}/)?.[0]
assert.ok(callbackFunction, 'OAuth callback information builder must exist')
const callbackJavaScript = callbackFunction.replace('path?: string', 'path').replace('): string', ')')
for (const baseUrl of ['https://customer.example/', 'https://customer.example/subpath/']) {
  for (const provider of ['github', 'google', 'discord']) {
    const result = runInNewContext(`${callbackJavaScript}; getCallbackUrl(path)`, {
      URL, customerBaseUrl: { value: baseUrl }, path: `/oauth/callback/${provider}`
    })
    assert.equal(result, `https://customer.example/api/oauth/callback/${provider}`)
  }
}
for (const baseUrl of [null, '', 'invalid', 'javascript:alert(1)']) {
  const result = runInNewContext(`${callbackJavaScript}; getCallbackUrl(path)`, {
    URL, customerBaseUrl: { value: baseUrl }, path: '/oauth/callback/github'
  })
  assert.equal(result, '', 'Missing or invalid customer configuration must not fall back to the admin origin')
}

console.log('frontend public callback URL tests passed')
