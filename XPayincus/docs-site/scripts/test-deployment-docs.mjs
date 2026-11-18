import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const workflowPath = '.github/workflows/ci.yml'
const scriptPath = 'XPayincus/docs-site/scripts/check-deployment-docs.mjs'
const fixtures = [
  scriptPath,
  'XPayincus/scripts/install-panel.sh',
  'XPayincus/docs-site/docs/deployment/manual-install.md',
  'XPayincus/docs-site/docs/en/deployment/manual-install.md',
  'XPayincus/docs-site/docs/deployment/systemd.md',
  'XPayincus/docs-site/docs/en/deployment/systemd.md',
  'XPayincus/docs-site/docs/.vitepress/config.ts',
  'XPayincus/docs-site/scripts/generate-changelog.mjs',
  'XPayincus/docs-site/docs/public/CNAME',
  'XPayincus/docs-site/docs/public/robots.txt'
]
const workflow = readFileSync(join(root, workflowPath), 'utf8')

function runGuard(t, source) {
  const directory = mkdtempSync(join(tmpdir(), 'xpayincus-docs-contract-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  for (const file of [...fixtures, workflowPath]) {
    const destination = join(directory, file)
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, file === workflowPath ? source : readFileSync(join(root, file)))
  }
  const result = spawnSync(process.execPath, [join(directory, scriptPath)], {
    cwd: directory,
    encoding: 'utf8'
  })
  assert.ifError(result.error)
  return result
}

test('deployment guard uses root CI', t => {
  const result = runGuard(t, workflow)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Deployment documentation guards passed/)
})

for (const command of [
  'node --test docs-site/scripts/test-deployment-docs.mjs',
  'pnpm --dir docs-site --ignore-workspace check:deployment',
  'pnpm --dir docs-site install --ignore-workspace --frozen-lockfile',
  'pnpm --dir docs-site --ignore-workspace build',
  'test -s docs-site/docs/.vitepress/dist/index.html'
]) {
  test(`deployment guard rejects missing CI command: ${command}`, t => {
    const source = workflow.replace(`run: ${command}`, 'run: true')
    assert.notEqual(source, workflow)
    const result = runGuard(t, source)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /root CI docs job: missing/)
  })
}

test('deployment guard rejects optional docs validation', t => {
  const source = workflow.replace('  docs:\n', '  docs:\n    continue-on-error: true\n')
  const result = runGuard(t, source)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /contains forbidden/)
})
