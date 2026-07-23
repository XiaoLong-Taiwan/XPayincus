import { XPayincusPublicApiClient, XPayincusPublicApiError, type XPayincusServiceAction } from '../payincus-public-api'

const client = new XPayincusPublicApiClient({
  baseUrl: process.env.XPAYINCUS_BASE_URL || 'https://panel.example.com',
  token: process.env.XPAYINCUS_API_TOKEN || ''
})

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function queuePowerTask(serviceId: number, action: XPayincusServiceAction) {
  return client.queueServiceAction(serviceId, action)
}

async function waitForTask(serviceId: number, taskId: number) {
  for (;;) {
    const task = await client.getServiceTask(serviceId, taskId)
    if (task.data.status !== 'PENDING' && task.data.status !== 'PROCESSING') {
      return task
    }
    await sleep(3000)
  }
}

async function main() {
  const services = await client.listServices({
    status: 'running',
    include: ['product', 'plan'],
    sort: 'displayOrder'
  })
  const service = services.data[0]
  if (!service) throw new Error('No running service is available for this token')

  const queued = await queuePowerTask(service.id, 'restart')
  const taskId = queued.data.task.id
  const finished = await waitForTask(service.id, taskId)
  console.log(`service ${service.id} restart task ${taskId}: ${finished.data.status}`)
}

main().catch(error => {
  if (error instanceof XPayincusPublicApiError) {
    console.error(`XPayincus API error ${error.status}: ${error.message}`, error.details)
    process.exit(1)
  }
  throw error
})
