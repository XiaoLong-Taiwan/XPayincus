import { XPayincusPublicApiClient, XPayincusPublicApiError } from '../payincus-public-api'

const client = new XPayincusPublicApiClient({
  baseUrl: process.env.XPAYINCUS_BASE_URL || 'https://panel.example.com',
  token: process.env.XPAYINCUS_API_TOKEN || ''
})

async function main() {
  const serviceId = Number(process.env.XPAYINCUS_SERVICE_ID || 0)
  const months = Number(process.env.XPAYINCUS_RENEW_MONTHS || 1)
  if (!serviceId) throw new Error('XPAYINCUS_SERVICE_ID is required')
  if (!Number.isInteger(months) || months < 1) throw new Error('XPAYINCUS_RENEW_MONTHS must be a positive integer')

  const result = await client.renewService(serviceId, months)
  console.log(`renewed service ${result.data.service.id} for ${months} month(s)`)
}

main().catch(error => {
  if (error instanceof XPayincusPublicApiError) {
    console.error(`XPayincus API error ${error.status}: ${error.message}`, error.details)
    process.exit(1)
  }
  throw error
})
