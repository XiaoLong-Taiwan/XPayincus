import fs from 'node:fs'
import path from 'node:path'
import { composeImages, validateVersions } from './release-contract.mjs'

const version = validateVersions()
const directory = path.resolve(process.argv[2])
for (const file of [
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
  'client/package.json', 'client/index.html', 'client/vite.config.ts', 'client/tsconfig.json', 'client/tsconfig.node.json', 'client/src/main.ts', 'client/src/admin/main.ts',
  'server/package.json', 'server/tsconfig.json', 'server/src/app.ts', 'server/prisma.config.ts', 'server/prisma/schema.prisma', 'server/prisma/migrations/migration_lock.toml',
  'server/templates/install.sh', 'server/templates/agent-install.sh', 'server/templates/caddy.sh',
  'server/scripts/export-legacy-host.mjs', 'server/scripts/LEGACY_HOST_EXPORT.md',
  'deploy/compose/docker-compose.yml', 'deploy/compose/compose.yaml', 'deploy/compose/compose.build.yaml', 'deploy/compose/Dockerfile', 'deploy/compose/Dockerfile.dockerignore',
  'deploy/compose/web-entrypoint.sh', 'client/public/runtime-config.js', 'client/src/utils/runtime-config.ts',
  'deploy/compose/panel.sh', 'deploy/compose/download.sh', 'deploy/compose/update.py', 'deploy/compose/api-entrypoint.sh', 'deploy/compose/nginx.conf.template',
  'deploy/compose/origin-entrypoint.sh', 'deploy/compose/edge-nginx.conf.template', 'deploy/compose/tunnel-nginx.conf.template',
  'deploy/compose/README.md', 'deploy/compose/https-proxy.conf.example'
]) {
  const source = path.join(directory, 'XPayincus', file)
  const entry = fs.lstatSync(source)
  if (!entry.isFile() || entry.size === 0) throw new Error(`Missing or empty regular Dashboard source: ${file}`)
  fs.accessSync(source, fs.constants.R_OK)
}
if (fs.readFileSync(path.join(directory, 'VERSION'), 'utf8').replace(/\r?\n$/, '') !== version) throw new Error('Committed VERSION mismatch')
for (const file of ['package.json', 'client/package.json', 'server/package.json']) {
  if (JSON.parse(fs.readFileSync(path.join(directory, 'XPayincus', file), 'utf8')).version !== version.slice(1)) {
    throw new Error(`Committed Dashboard version mismatch: ${file}`)
  }
}
const services = Object.fromEntries(Object.entries(composeImages(version)).map(([service, image]) => [service, {
  image
}]))
fs.writeFileSync(path.join(directory, 'XPayincus/deploy/compose/compose.release.yaml'), JSON.stringify({ services }, null, 2) + '\n', { flag: 'wx' })
