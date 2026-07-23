import { randomBytes, timingSafeEqual } from 'node:crypto'
import { XPayincusPublicApiClient } from '../payincus-public-api'

interface OAuthTokenResponse {
  access_token: string
  refresh_token: string
  token_type: 'Bearer'
  expires_in: number
}

const baseUrl = process.env.XPAYINCUS_BASE_URL || 'https://panel.example.com'
const clientId = process.env.XPAYINCUS_OAUTH_CLIENT_ID || ''
const clientSecret = process.env.XPAYINCUS_OAUTH_CLIENT_SECRET || ''
const redirectUri = process.env.XPAYINCUS_OAUTH_REDIRECT_URI || 'https://example.com/oauth/callback'
const state = randomBytes(24).toString('base64url')

function buildAuthorizationUrl() {
  const url = new URL('/oauth/authorize', baseUrl)
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', 'profile:read services:read services:operate')
  url.searchParams.set('state', state)
  return url.toString()
}

function verifyOAuthState(receivedState: string) {
  const expected = Buffer.from(state)
  const received = Buffer.from(receivedState)
  return expected.length === received.length && timingSafeEqual(expected, received)
}

async function exchangeAuthorizationCode(code: string): Promise<OAuthTokenResponse> {
  const endpoint = new URL('/api/oauth-provider/token', baseUrl)
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grantType: 'authorization_code',
      clientId,
      clientSecret,
      code,
      redirectUri
    })
  })
  if (!response.ok) throw new Error(`OAuth token exchange failed: ${response.status}`)
  return await response.json() as OAuthTokenResponse
}

async function refreshAccessToken(refreshToken: string): Promise<OAuthTokenResponse> {
  const endpoint = new URL('/api/oauth-provider/token', baseUrl)
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grantType: 'refresh_token',
      clientId,
      clientSecret,
      refreshToken
    })
  })
  if (!response.ok) throw new Error(`OAuth token refresh failed: ${response.status}`)
  return await response.json() as OAuthTokenResponse
}

async function main() {
  console.log(`Open this URL in the browser: ${buildAuthorizationUrl()}`)

  const code = process.env.XPAYINCUS_OAUTH_CODE || ''
  const state = process.env.XPAYINCUS_OAUTH_STATE || ''
  if (!code || !verifyOAuthState(state)) {
    throw new Error('Set XPAYINCUS_OAUTH_CODE and a valid XPAYINCUS_OAUTH_STATE after the callback')
  }

  const token = await exchangeAuthorizationCode(code)
  const api = new XPayincusPublicApiClient({ baseUrl, token: token.access_token })
  const profile = await api.getProfile()
  console.log(`authorized profile ${profile.data.username}`)

  const refreshed = await refreshAccessToken(token.refresh_token)
  const refreshTokenRotated = refreshed.refresh_token !== token.refresh_token
  console.log(`refreshTokenRotated=${refreshTokenRotated}`)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
