import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const view = readFileSync(resolve(__dirname, '../views/HostingApplicationView.vue'), 'utf8').replace(/\r\n/g, '\n')

assert.ok(
  view.includes('class="kawaii-page space-y-5 animate-fade-in"') &&
    view.includes('class="page-header') &&
    view.includes('class="page-title"') &&
    view.includes('class="page-description"'),
  'hosting application must use the shared page header pattern'
)

assert.ok(
  view.includes('<section v-else class="card space-y-6 p-5 sm:p-7">') &&
    view.includes('class="input min-h-36 w-full resize-y"') &&
    view.includes('class="btn btn-primary"') &&
    view.includes('class="btn btn-secondary mt-4"'),
  'hosting application must use shared card, input, and button patterns'
)

assert.ok(
  view.includes("import SkeletonLoader from '@/components/SkeletonLoader.vue'") &&
    view.includes('<SkeletonLoader v-if="loading" type="card" />'),
  'hosting application must render the shared loading skeleton'
)

assert.ok(
  view.includes('v-else-if="loadFailed"') &&
    view.includes('@click="loadApplication"') &&
    view.includes('hosting.application.retry'),
  'hosting application must preserve the error retry state'
)

assert.ok(
  view.includes("application.value.status === 'pending'") &&
    view.includes("application.value.status === 'approved'") &&
    view.includes("application.status === 'rejected'") &&
    view.includes("application?.status === 'approved'") &&
    view.includes('hosting.application.pendingMessage'),
  'hosting application must preserve pending, approved, and rejected states'
)

assert.ok(
  view.includes('application?.reviewReason') &&
    view.includes('hosting.application.reviewReason') &&
    view.includes('api.hosting.getApplication()') &&
    view.includes('api.hosting.submitApplication(value)'),
  'hosting application must preserve review reason and API flows'
)

assert.ok(
  view.includes('to="/resources/hosts"') &&
    view.includes('to="/resources/packages"') &&
    view.includes('to="/hosting-wallet"'),
  'approved hosting application must preserve all management links'
)

assert.ok(!view.includes('<style scoped>') && !view.includes('application-panel'), 'hosting application must not keep page-local presentation styles')

console.log('hosting application UI guard tests passed')
