import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const source = readFileSync(new URL('../src/routes/agent.ts', import.meta.url), 'utf8')
const builder = source.slice(source.indexOf('function buildAgentInstallConfig('), source.indexOf('function getAgentReleaseRepository('))
const route = source.slice(source.indexOf("  fastify.get<{ Params: AgentInstallTokenParams;"), source.indexOf('  fastify.get<{ Params: AgentBinaryParams;'))

async function invoke(bootstrap: boolean, installed = false, failure = '') {
  let handler: (request: unknown, reply: unknown) => Promise<unknown>
  let consumed = 0
  let status = 200
  let payload = ''
  const reply = {
    code(value: number) { status = value; return this },
    header() { return this },
    send(value: string) { payload = value; return this }
  }
  const compiled = ts.transpileModule(builder + '\n' + route, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
  }).outputText
  new Function('fastify', 'consumeHostAgentInstallToken', 'prisma', 'readPanelCertificatePair',
    'existsSync', 'join', 'dirname', '__dirname', 'shellEscape', 'createLog', 'LogModule', 'LogResult', compiled)(
    { get(_path: string, _options: unknown, callback: typeof handler) { handler = callback } },
    async () => {
      consumed++
      if (failure === 'invalid' || failure === 'expired') throw new Error(failure === 'invalid' ? 'AGENT_INSTALL_TOKEN_INVALID' : 'AGENT_INSTALL_TOKEN_EXPIRED')
      return { host: { id: 1, name: 'fixture' }, agent: { agentId: 'fixture-agent' }, agentSecret: 'fixture-secret' }
    },
    { host: { findUnique: async () => ({ isInstalled: installed }) } },
    () => { if (failure === 'certificate') throw new Error('private-key-marker'); return { cert: Buffer.from('fixture-certificate') } },
    () => false, (...parts: string[]) => parts.join('/'), () => '', '/fixture',
    (value: string) => `'${value}'`, async () => {}, { HOST: 'host' }, { SUCCESS: 'success' }
  )
  await handler!({ params: { token: 'fixture' }, query: bootstrap ? { bootstrap: '1' } : {}, log: { info() {} } }, reply)
  return { consumed, status, payload }
}

for (const installed of [true, false]) {
  const result = await invoke(true, installed)
  assert.equal(result.status, 200)
  assert.equal(result.consumed, 1)
  assert.ok(result.payload.includes(`INCUDAL_HOST_INSTALLED='${installed}'`))
  assert.ok(result.payload.includes(`INCUDAL_PANEL_CERTIFICATE='${Buffer.from('fixture-certificate').toString('base64')}'`))
  assert.equal(result.payload.trim().split('\n').length, 4)
}
const legacy = await invoke(false)
assert.equal(legacy.payload.trim().split('\n').length, 2)
for (const failure of ['invalid', 'expired']) {
  const result = await invoke(true, false, failure)
  assert.equal(result.status, 403)
  assert.ok(!result.payload.includes('INCUDAL_'))
}
const invalidPair = await invoke(true, false, 'certificate')
assert.equal(invalidPair.status, 503)
assert.equal(invalidPair.consumed, 0)
assert.ok(!invalidPair.payload.includes('private-key-marker'))
console.log('agent bootstrap behavior tests passed')
