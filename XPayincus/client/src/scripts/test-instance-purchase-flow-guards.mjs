import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const view = fs.readFileSync(path.join(root, 'views', 'InstanceCreateView.vue'), 'utf8')
const stepper = fs.readFileSync(path.join(root, 'components', 'instances', 'InstancePurchaseStepper.vue'), 'utf8')

const assertions = [
  ['stepper component exists', stepper.includes('data-instance-purchase-stepper')],
  ['package step exists', view.includes('activeStep === 1')],
  ['configuration step exists', view.includes('activeStep === 2')],
  ['confirmation step exists', view.includes('activeStep === 3')],
  ['payment step exists', view.includes('activeStep === 4')],
  ['idempotency is retained', view.includes('createIntentIdempotencyKey')],
  ['Turnstile is retained', view.includes('getCreateTurnstileToken')],
  ['active submit is disabled', stepper.includes('!props.canSubmit || isCreating')],
  ['creating state exists', stepper.includes('data-state="creating"')],
  ['success state exists', stepper.includes('data-state="success"')],
  ['failure state exists', stepper.includes('data-state="failure"')],
  ['back navigation exists', stepper.includes("emit('previous')")],
  ['submit behavior is retained', view.includes('api.instances.create(requestPayload)')],
  ['all instance fields remain in the payload', ['name:', 'packageId:', 'planId:', 'hostId:', 'image:', 'cpu:', 'memory:', 'disk:', 'sshKeyId:', 'customInitCommandIds:', 'promoCode:', 'autoRemotePort:'].every(field => view.includes(field))],
  ['redirect behavior is retained', view.includes('instancesPath()') && view.includes('created: String(response.instance.id)')],
  ['structured submission details are shown', view.includes('submissionErrorDetails.requestId') && view.includes('submissionErrorDetails.taskId')],
  ['host lookup failure remains retryable', !/availableHosts\.value = \[\][\s\S]{0,180}hostsLoadedIntent\.value = requestedHostIntent/.test(view)]
]

const failures = assertions.filter(([, passed]) => !passed).map(([name]) => name)
if (failures.length) {
  console.error(`Instance purchase flow guard failed: ${failures.join(', ')}`)
  process.exit(1)
}
console.log(`Instance purchase flow guards passed (${assertions.length})`)
