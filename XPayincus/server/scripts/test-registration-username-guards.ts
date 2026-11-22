import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const serverRoot = process.cwd()
const authSource = readFileSync(resolve(serverRoot, 'src/routes/auth.ts'), 'utf8')
const appSource = readFileSync(resolve(serverRoot, 'src/app.ts'), 'utf8')
const clientRoot = resolve(serverRoot, '../client/src')
const validationSource = readFileSync(resolve(clientRoot, 'utils/validation.ts'), 'utf8')
const localeSources = ['en.ts', 'zh-CN.ts', 'zh-TW.ts'].map((file) =>
  readFileSync(resolve(clientRoot, 'locales', file), 'utf8')
)

const usernamePattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/
const isValidUsername = (username: string): boolean =>
  username.length >= 3 && username.length <= 32 && usernamePattern.test(username)
for (const username of ['Daniel', '123Daniel', 'daniel_1', 'daniel-user']) {
  assert.equal(isValidUsername(username), true, `${username} should be accepted`)
}
for (const username of ['ab', 'a'.repeat(33), '_daniel', '-daniel', 'daniel.name', 'daniel name']) {
  assert.equal(isValidUsername(username), false, `${username} should be rejected`)
}

assert.ok(authSource.includes("pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]*$'"))
assert.ok(authSource.includes("validateIdentifier(username, 'Username', 3, 32)"))
assert.ok(authSource.includes('apiError(ErrorCode.VALIDATION_ERROR)'))
assert.ok(validationSource.includes('const STRICT_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9\\-_]*$/'))
assert.ok(appSource.includes('code: \'VALIDATION_ERROR\''))
for (const locale of localeSources) {
  assert.ok(locale.includes('VALIDATION_ERROR:'), 'each locale must translate validation errors')
  assert.ok(locale.includes('must start with a letter or number') || locale.includes('必須以字母或數字開頭') || locale.includes('必须以字母或数字开头'))
}

console.log('registration username guard tests passed')
