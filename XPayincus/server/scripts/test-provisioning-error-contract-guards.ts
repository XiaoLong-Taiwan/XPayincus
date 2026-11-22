import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const schema = readFileSync(resolve(root, 'prisma/schema.prisma'), 'utf8')
const migration = readFileSync(resolve(root, 'prisma/migrations/20261122000000_add_provisioning_error_metadata/migration.sql'), 'utf8')
const service = readFileSync(resolve(root, 'src/services/provisioning-error.ts'), 'utf8')
const instances = readFileSync(resolve(root, 'src/routes/instances.ts'), 'utf8')
const operations = readFileSync(resolve(root, 'src/routes/operations.ts'), 'utf8')
const tasks = readFileSync(resolve(root, 'src/db/instance-tasks.ts'), 'utf8')
const compensation = readFileSync(resolve(root, 'scripts/test-instance-create-failure-compensation.ts'), 'utf8')
const turnstile = readFileSync(resolve(root, 'src/routes/instances.ts'), 'utf8')

for (const field of ['errorCode', 'errorDetail', 'errorRequestId', 'errorRetryable']) {
  assert.ok(schema.includes(field), `ProvisioningJob must define ${field}`)
  assert.ok(migration.includes(field.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)), `migration must add ${field}`)
  assert.ok(operations.includes(field), `operations must expose ${field}`)
}
assert.match(service, /normalizeProvisioningError/)
assert.match(service, /SECRET_PATTERN/)
assert.match(service, /retryable/)
assert.match(instances, /checkInstanceOperationPermission/)
assert.match(instances, /provisioningErrorFields\(normalizeProvisioningError\(/)
assert.match(instances, /errorRequestId/)
assert.match(tasks, /ProvisioningJobErrorView/)
assert.doesNotMatch(instances, /select:\s*\{[^}]*payload[^}]*\}/s)
assert.doesNotMatch(operations, /t\.payload/)
assert.match(compensation, /await compensateFailedInstanceCreation\(/)
assert.match(turnstile, /await turnstileVerifier\(request, reply\)/)
assert.match(turnstile, /normalPaidIdempotencyKey/)
assert.match(turnstile, /compensateFailedInstancePurchase/)

console.log('provisioning error contract guard tests passed')
