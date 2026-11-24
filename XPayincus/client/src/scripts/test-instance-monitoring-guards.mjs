import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const api = read('../api/agent-monitoring.ts')
const composable = read('../composables/useInstanceMonitoring.ts')
const info = read('../components/instance/InstanceInfoTab.vue')
const network = read('../components/instance/InstanceNetworkTab.vue')
const detail = read('../views/InstanceDetailView.vue')
const panel = read('../components/instances/InstanceMonitoringPanel.vue')

assert.match(api, /instanceMonitoringStreamUrl/)
assert.match(api, /createInstanceMonitoringStreamTicket/)
assert.match(api, /http\.post\(`\/instances\/\$\{instanceId\}\/monitoring\/stream-ticket`/)
assert.match(api, /url\.searchParams\.set\('ticket', ticket\)/)
assert.doesNotMatch(api, /searchParams\.set\('token'/)
assert.match(api, /\/instances\/\$\{instanceId\}\/monitoring\/history/)
assert.match(info, /cpuUsagePercent/)
assert.match(api, /rxBytesPerSecond/)
assert.match(api, /txBytesPerSecond/)
assert.match(info, /rxBytesPerSecond/)
assert.match(info, /txBytesPerSecond/)
assert.doesNotMatch(info, /networkReceiveBytesPerSecond|networkTransmitBytesPerSecond/)
assert.match(info, /memoryUsedBytes/)
assert.match(info, /instance\.monitoring\.history/)
assert.match(info, /instance\.monitoring\.\$\{monitoringStatus/)
assert.match(info, /diskIOBytesPerSecond/)
assert.match(info, /mappedSshPort/)
assert.match(info, /emit\('copy', ipv4Address/)
assert.match(info, /emit\('copy', ipv6Address/)
assert.match(network, /publicIpv4Address/)
assert.match(network, /displayIpv6/)
assert.doesNotMatch(network, /privateIpv4|內網 IPv4|內部 IPv4/)
assert.match(info, /privatePort.*22/)
assert.match(info, /publicPort.*public_port/)
assert.doesNotMatch(detail, /InstanceMonitoringPanel/)
assert.doesNotMatch(detail, /InstanceNetworkInfo/)
assert.match(detail, /connectInstanceMonitoring/)
assert.doesNotMatch(detail, /setInterval\(loadStats/)
assert.match(panel, /summaryCounters\.rxBytes/)
assert.match(panel, /summaryCounters\.txBytes/)
assert.match(panel, /formatBytes\(trafficSummary\.rx\?\.delta\)/)
assert.match(panel, /formatBytes\(trafficSummary\.tx\?\.delta\)/)
assert.doesNotMatch(panel, /summaryCounters\.rxBytesPerSecond|summaryCounters\.txBytesPerSecond/)
assert.match(panel, /rxBytesPerSecond.*suffix: ' B\/s'/)
assert.match(panel, /txBytesPerSecond.*suffix: ' B\/s'/)
assert.match(panel, /instance\.monitoring\.received/)
assert.match(panel, /instance\.monitoring\.transmitted/)
assert.match(panel, /trafficCoverage === null \? '—'/)

const sources = []
const timers = new Map()
const historyRequests = []
const history = { resolutionSeconds: 3600 }
let now = Date.parse('2026-11-25T00:00:00Z')
let timerId = 0

class MockEventSource {
  constructor(url, options) {
    assert.equal(options.withCredentials, true)
    this.url = url
    sources.push(this)
  }

  close() {
    this.closed = true
  }

  send(value) {
    this.onmessage({ data: JSON.stringify(value) })
  }
}

function advanceToNextTimer(delay) {
  assert.equal(timers.size, 1)
  const [[id, timer]] = timers
  assert.equal(timer.at - now, delay)
  timers.delete(id)
  now = timer.at
  timer.callback()
}

const exports = {}
runInNewContext(ts.transpileModule(composable, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText, {
  exports,
  require(name) {
    if (name === 'vue') return { computed: () => {}, onBeforeUnmount: () => {}, ref: value => ({ value }) }
    assert.equal(name, '@/api/agent-monitoring')
    let ticketCount = 0
    return {
      getOwnInstanceMonitoringHistory: async (id, signal) => {
        historyRequests.push({ id, signal })
        return history
      },
      createInstanceMonitoringStreamTicket: async id => ({ ticket: `${id}-${++ticketCount}` }),
      instanceMonitoringStreamUrl: (id, ticket) => `/${id}?ticket=${ticket}`
    }
  },
  AbortController,
  Date: class extends Date { static now() { return now } },
  EventSource: MockEventSource,
  setTimeout(callback, delay) {
    timers.set(++timerId, { at: now + delay, callback })
    return timerId
  },
  clearTimeout: id => timers.delete(id)
})

const monitoring = exports.useInstanceMonitoring()
monitoring.connect(42)
await Promise.resolve()
assert.equal(monitoring.trend.value, history)
assert.equal(historyRequests[0].id, 42)
assert.equal(historyRequests[0].signal.aborted, false)
const [firstSource] = sources
assert.equal(firstSource.url, '/42?ticket=42-1')
firstSource.onopen()
const firstSampleAt = now - 10000
const point = (at, usage) => ({ sampledAt: new Date(at).toISOString(), online: true, metrics: { cpuUsagePercent: usage } })
firstSource.send(point(firstSampleAt, 25))
assert.equal(monitoring.status.value, 'connected')
assert.equal(monitoring.sample.value.metrics.cpuUsagePercent, 25)

firstSource.onerror()
assert.equal(firstSource.closed, true)
assert.equal(monitoring.sample.value, null)
assert.equal(monitoring.status.value, 'reconnecting')
advanceToNextTimer(1000)
await Promise.resolve()
const secondSource = sources[1]
assert.equal(secondSource.url, '/42?ticket=42-2')
secondSource.onopen()
firstSource.send(point(now, 99))
secondSource.send(point(firstSampleAt - 1, 90))
assert.equal(monitoring.sample.value, null)
secondSource.send(point(firstSampleAt, 25))
assert.equal(monitoring.status.value, 'connected')
assert.equal(monitoring.reconnectAttempt.value, 0)
assert.equal(monitoring.sample.value.metrics.cpuUsagePercent, 25)
secondSource.send(point(firstSampleAt, 99))
assert.equal(monitoring.sample.value.metrics.cpuUsagePercent, 25)
advanceToNextTimer(109000)
assert.equal(monitoring.status.value, 'offline')
assert.equal(monitoring.sample.value, null)

secondSource.onerror()
advanceToNextTimer(1000)
await Promise.resolve()
sources[2].send(point(firstSampleAt, 25))
assert.equal(monitoring.status.value, 'offline')
assert.equal(monitoring.sample.value, null)
assert.equal(historyRequests.length, 1)

for (const delay of [2000, 4000, 8000, 16000]) {
  sources.at(-1).onerror()
  advanceToNextTimer(delay)
  await Promise.resolve()
}
sources.at(-1).onerror()
assert.equal(monitoring.status.value, 'offline')
assert.equal(timers.size, 0)
monitoring.disconnect()
assert.equal(monitoring.trend.value, null)

console.log('instance monitoring guards passed')
