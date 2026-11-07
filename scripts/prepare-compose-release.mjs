import fs from 'node:fs'
import path from 'node:path'
import { composeImages, validateVersions } from './release-contract.mjs'

const version = validateVersions()
const directory = path.resolve(process.argv[2])
if (fs.readFileSync(path.join(directory, 'VERSION'), 'utf8').replace(/\r?\n$/, '') !== version) throw new Error('Committed VERSION mismatch')
for (const file of ['package.json', 'client/package.json', 'server/package.json']) {
  if (JSON.parse(fs.readFileSync(path.join(directory, 'XPayincus', file), 'utf8')).version !== version.slice(1)) {
    throw new Error(`Committed Dashboard version mismatch: ${file}`)
  }
}
const services = Object.fromEntries(Object.entries(composeImages(version)).map(([service, image]) => [service, {
  image,
  build: { labels: { 'org.opencontainers.image.version': version } }
}]))
fs.writeFileSync(path.join(directory, 'XPayincus/deploy/compose/compose.release.yaml'), JSON.stringify({ services }, null, 2) + '\n', { flag: 'wx' })
