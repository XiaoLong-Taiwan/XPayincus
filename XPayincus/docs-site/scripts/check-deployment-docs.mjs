import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const docsSiteDir = resolve(fileURLToPath(new URL('..', import.meta.url)))
const repoRoot = resolve(docsSiteDir, '..')

function read(relativePath) {
  return readFileSync(resolve(repoRoot, relativePath), 'utf8')
}

function requireText(content, expected, label) {
  if (!content.includes(expected)) {
    throw new Error(`${label}: missing ${JSON.stringify(expected)}`)
  }
}

function rejectText(content, rejected, label) {
  if (content.includes(rejected)) {
    throw new Error(`${label}: contains forbidden ${JSON.stringify(rejected)}`)
  }
}

const installer = read('scripts/install-panel.sh')
for (const expected of [
  'is_atomic_layout()',
  'verify_release_checksum()',
  'validate_release_archive()',
  '检测到原子 OTA 布局'
]) {
  requireText(installer, expected, 'installer')
}

for (const path of [
  'docs-site/docs/deployment/manual-install.md',
  'docs-site/docs/en/deployment/manual-install.md'
]) {
  const manual = read(path)
  requireText(manual, '${PACKAGE}.sha256', path)
  requireText(manual, 'sha256sum -c', path)
  requireText(manual, '/opt/incudal/releases/.next-current', path)
}

for (const path of [
  'docs-site/docs/deployment/systemd.md',
  'docs-site/docs/en/deployment/systemd.md'
]) {
  const systemd = read(path)
  rejectText(systemd, 'ExecStartPre=cd ', path)
  requireText(systemd, "ExecStartPre=/usr/bin/bash -lc", path)
}

const config = read('docs-site/docs/.vitepress/config.ts')
requireText(config, "const siteOrigin = 'https://xpayincus.com'", 'VitePress config')
requireText(config, 'transformHead({ pageData })', 'VitePress config')
requireText(config, 'hostname: siteOrigin', 'VitePress config')

const changelogGenerator = read('docs-site/scripts/generate-changelog.mjs')
requireText(changelogGenerator, "--format=%H%x09%cs%x09%s", 'changelog generator')
requireText(changelogGenerator, 'fullHash.slice(0, 9)', 'changelog generator')
requireText(changelogGenerator, 'normalizeEmbeddedReleaseNoteHeadings', 'changelog generator')

const cname = read('docs-site/docs/public/CNAME').trim()
if (cname !== 'xpayincus.com') {
  throw new Error(`CNAME must be xpayincus.com, received ${JSON.stringify(cname)}`)
}

const robots = read('docs-site/docs/public/robots.txt')
requireText(robots, 'Sitemap: https://xpayincus.com/sitemap.xml', 'robots.txt')

const rootWorkflow = readFileSync(resolve(repoRoot, '..', '.github/workflows/ci.yml'), 'utf8')
const docsJob = rootWorkflow.match(/^  docs:\r?\n([\s\S]*?)(?=^  [\w-]+:\r?$|$(?![\s\S]))/m)?.[1]
if (!docsJob) {
  throw new Error('root CI: missing docs job')
}
for (const expected of [
  'needs: version',
  'working-directory: XPayincus',
  'fetch-depth: 0',
  'version: 9.14.2',
  "node-version: '22'",
  'cache-dependency-path: XPayincus/docs-site/pnpm-lock.yaml',
  'run: node --test docs-site/scripts/test-deployment-docs.mjs',
  'run: pnpm --dir docs-site --ignore-workspace check:deployment',
  'run: pnpm --dir docs-site install --ignore-workspace --frozen-lockfile',
  'run: pnpm --dir docs-site --ignore-workspace build',
  'run: test -s docs-site/docs/.vitepress/dist/index.html'
]) {
  requireText(docsJob, expected, 'root CI docs job')
}
rejectText(docsJob, 'continue-on-error:', 'root CI docs job')
rejectText(docsJob, 'if:', 'root CI docs job')

console.log('Deployment documentation guards passed.')
