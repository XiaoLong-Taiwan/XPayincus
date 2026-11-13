import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const root = fileURLToPath(new URL('../', import.meta.url))
const read = path => readFileSync(resolve(root, path), 'utf8')
const source = read('src/composables/useHostInstallDetails.ts')
const hooks = []
const module = { exports: {} }
runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
  exports: module.exports,
  require: name => {
    assert.equal(name, 'vue')
    return { ref: value => ({ value }), onBeforeUnmount: fn => hooks.push(fn), onDeactivated: fn => hooks.push(fn) }
  }
})
const state = module.exports.useHostInstallDetails()
const response = {
  panelUrl: 'https://panel.example.test',
  installScriptUrl: 'https://panel.example.test/api/agent/install.sh',
  installCommand: 'curl -fsSL https://panel.example.test/api/agent/install.sh | sudo bash',
  installToken: 'synthetic-test-value',
  installTokenExpiresAt: '2026-11-13T12:00:00Z'
}
await state.loadInstallDetails(async () => response)
assert.equal(state.installDetails.value.installToken, response.installToken)
assert.equal(state.installDetails.value.installTokenExpiresAt, response.installTokenExpiresAt)
assert.equal(hooks.length, 2)
for (const hook of hooks) {
  await state.loadInstallDetails(async () => response)
  hook()
  assert.equal(state.installDetails.value, null)
}
let complete
const pending = state.loadInstallDetails(() => new Promise(resolve => { complete = resolve }))
state.clearInstallDetails()
complete(response)
assert.equal(await pending, null)
assert.equal(state.installDetails.value, null)
await state.loadInstallDetails(async () => ({ panelUrl: response.panelUrl }))
assert.equal(state.installDetails.value, null)
await assert.rejects(state.loadInstallDetails(async () => ({ ...response, installCommand: response.installToken })), /Invalid installation response/)
assert.equal(state.installDetails.value, null)
for (const path of ['views/resources/MyHostCreateView.vue', 'views/resources/MyHostDetailView.vue', 'components/host/HostInfoTab.vue']) {
  const view = read(`src/${path}`)
  assert.ok(view.includes('<HostInstallFields v-if="installDetails"') || view.includes('<HostInstallFields :details="installDetails"'))
  assert.ok(view.includes('useHostInstallDetails()'))
}
assert.ok(read('src/views/resources/MyHostCreateView.vue').includes('v-if="showInstallScript && installDetails"'))
assert.ok(read('src/views/resources/MyHostDetailView.vue').includes("window.confirm(t('admin.hosts.hostInstallTokenRotateConfirm'))"))
assert.ok(read('src/components/host/HostInfoTab.vue').includes("window.confirm(t('admin.hosts.agentInstallCommandConfirm'))"))
const fields = read('src/components/host/HostInstallFields.vue')
assert.ok(fields.includes("['installCommand', 'panelUrl', 'installToken'] as const"))
assert.ok(fields.includes('await navigator.clipboard.writeText(value)'))
assert.ok(fields.includes('lg:grid-cols-3'))
assert.ok(fields.includes('details.installTokenExpiresAt'))
assert.ok(fields.includes("copyStates[field] === 'copied' ? t('common.copied') : t('common.copy')"))
assert.ok(fields.includes('role="alert"'))
const fieldScript = fields.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
const timers = new Map()
const feedback = []
let unmount
let rejectClipboard = false
const fieldModule = { exports: {} }
runInNewContext(ts.transpileModule(`${fieldScript}\nexport { copyValue, copyStates }`, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
  exports: fieldModule.exports,
  defineProps: () => ({}),
  navigator: { clipboard: { writeText: async () => { if (rejectClipboard) throw new Error('denied') } } },
  setTimeout: (fn, delay) => {
    assert.equal(delay, 2500)
    const id = Symbol()
    timers.set(id, () => {
      timers.delete(id)
      fn()
    })
    return id
  },
  clearTimeout: id => timers.delete(id),
  require: name => {
    if (name === 'vue') return { ref: value => ({ value }), onBeforeUnmount: fn => { unmount = fn } }
    if (name === 'vue-i18n') return { useI18n: () => ({ t: key => key }) }
    assert.equal(name, '@/stores/toast')
    return { useToast: () => ({ success: key => feedback.push(key), error: key => feedback.push(key) }) }
  }
})
const copy = fieldModule.exports
await copy.copyValue('installCommand', 'synthetic-command')
assert.equal(copy.copyStates.value.installCommand, 'copied')
assert.equal(feedback.at(-1), 'common.copied')
await copy.copyValue('panelUrl', 'https://panel.example.test')
assert.equal(copy.copyStates.value.installCommand, 'copied')
assert.equal(copy.copyStates.value.panelUrl, 'copied')
rejectClipboard = true
await copy.copyValue('installCommand', 'synthetic-command')
assert.equal(copy.copyStates.value.installCommand, 'error')
assert.equal(feedback.at(-1), 'admin.hosts.installCopyFailed')
assert.equal(timers.size, 2)
for (const reset of [...timers.values()]) reset()
assert.equal(Object.keys(copy.copyStates.value).length, 0)
assert.equal(timers.size, 0)
rejectClipboard = false
await copy.copyValue('installToken', 'synthetic-value')
assert.equal(copy.copyStates.value.installToken, 'copied')
unmount()
assert.equal(timers.size, 0)
for (const text of [source, fields]) assert.ok(!/localStorage|sessionStorage|console\./.test(text))
for (const path of ['src/api/index.ts', 'src/api/admin.ts']) {
  const api = read(path)
  assert.ok(api.includes('Promise<CreateHostResponse>'))
  assert.ok(api.includes('Promise<RegenerateHostInstallResponse>'))
}
console.log('host install UI guard tests passed')
