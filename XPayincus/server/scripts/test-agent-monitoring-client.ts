import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const requireClient = createRequire(new URL('../../client/package.json', import.meta.url))
const axios = requireClient('axios')
const monitoringSource = readFileSync(new URL('../../client/src/api/agent-monitoring.ts', import.meta.url), 'utf8')
assert.match(monitoringSource, /import \{ http \} from '@\/api'/)

function client(initialToken: string, entry: 'index' | 'admin') {
  const apiSource = readFileSync(new URL(`../../client/src/api/${entry}.ts`, import.meta.url), 'utf8')
  const start = apiSource.indexOf('export const http: AxiosInstance = axios.create(')
  const end = apiSource.indexOf('// API 模块', start)
  assert.ok(start >= 0 && end > start, `${entry} must export the authenticated HTTP client`)
  const clientSource = apiSource.slice(start, end) + monitoringSource.replace(/^import .*$/gm, '')
  const storage = new Map([['token', initialToken]])
  let refreshes = 0
  let syncs = 0
  const context = {
    exports: {} as any,
    axios,
    API_BASE_URL: '/api',
    TIMEOUT: { DEFAULT: 30000 },
    buildApiUrl: (path: string) => `/api${path}`,
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key)
    },
    useAuthStore: () => ({ syncToken: () => { syncs++ } }),
    window: { location: { pathname: '/hosts/1', href: '' } },
    fetch: async (url: string, options: any) => {
      refreshes++
      assert.equal(url, '/api/auth/refresh')
      assert.equal(options.method, 'POST')
      assert.equal(options.credentials, 'include')
      await Promise.resolve()
      return { ok: true, json: async () => ({ token: 'renewed-token' }) }
    },
    AbortController, setTimeout, clearTimeout, atob, console
  }
  runInNewContext(ts.transpile(clientSource, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }), context)
  return { ...context.exports, storage, refreshes: () => refreshes, syncs: () => syncs }
}

export async function testAgentMonitoringClient() {
  for (const entry of ['index', 'admin'] as const) await testEntry(entry)
}

async function testEntry(entry: 'index' | 'admin') {
  const query = { from: new Date(Date.now() - 3600000).toISOString(), to: new Date(Date.now() - 1000).toISOString(), resolutionSeconds: 60, limit: 1000 }
  const expiredToken = `header.${Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url')}.signature`
  const proactive = client(expiredToken, entry)
  const requests: any[] = []
  proactive.http.defaults.adapter = async (config: any) => {
    requests.push(config)
    assert.equal(config.headers.Authorization, 'Bearer renewed-token')
    return { status: 200, statusText: 'OK', headers: {}, config, data: { schemaVersion: 2, path: config.url } }
  }
  const controller = new AbortController()
  const results = await Promise.all([
    proactive.agentMonitoringApi.history(1, query, controller.signal),
    proactive.agentMonitoringApi.top(1, query, 'cpuUsagePercent', 'avg', 10, controller.signal),
    proactive.agentMonitoringApi.events(1, query, controller.signal),
    proactive.agentMonitoringApi.instanceHistory(1, query, 'vm1', controller.signal)
  ])
  assert.equal(proactive.refreshes(), 1)
  assert.equal(proactive.syncs(), 1)
  assert.equal(proactive.storage.get('token'), 'renewed-token')
  assert.deepEqual(requests.map(config => config.url), [
    '/agent/hosts/1/monitoring/history', '/agent/hosts/1/monitoring/instances/top',
    '/agent/hosts/1/monitoring/events', '/agent/hosts/1/monitoring/instances/history'
  ])
  for (const [index, config] of requests.entries()) {
    assert.equal(config.baseURL, '/api')
    assert.equal(config.withCredentials, true)
    assert.equal(config.timeout, 30000)
    assert.equal(config.signal, controller.signal)
    assert.equal(config.params.from, query.from)
    assert.equal(config.params.to, query.to)
    assert.equal(results[index].schemaVersion, 2)
    assert.equal(results[index].path, config.url)
  }
  assert.equal(requests[1].params.metric, 'cpuUsagePercent')
  assert.equal(requests[1].params.top, 10)
  assert.equal(requests[3].params.name, 'vm1')
  controller.abort()
  await assert.rejects(proactive.agentMonitoringApi.history(1, query, controller.signal))
  assert.equal(requests.length, 4)

  const reactive = client('rejected-token', entry)
  let attempts = 0
  reactive.http.defaults.adapter = async (config: any) => {
    attempts++
    if (config.headers.Authorization !== 'Bearer renewed-token') {
      throw new axios.AxiosError('Unauthorized', 'ERR_BAD_REQUEST', config, undefined, { status: 401, data: { error: 'Unauthorized' }, headers: {}, config, statusText: 'Unauthorized' })
    }
    return { status: 200, statusText: 'OK', headers: {}, config, data: { schemaVersion: 2 } }
  }
  assert.equal((await reactive.agentMonitoringApi.history(1, query)).schemaVersion, 2)
  assert.equal(attempts, 2)
  assert.equal(reactive.refreshes(), 1)
}
