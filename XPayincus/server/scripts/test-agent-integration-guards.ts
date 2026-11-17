import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

const original = fs.readFileSync
fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
  const value = original(...args)
  return typeof value === 'string' ? value.replace(/\r\n/g, '\n') : value
}) as typeof fs.readFileSync
syncBuiltinESMExports()
for (const name of ['test-backup-route-id-guards', 'test-backup-task-race-guards', 'test-auto-policy-scheduler-guards', 'test-host-migration-consistency']) {
  await import(`./${name}.ts`)
}
