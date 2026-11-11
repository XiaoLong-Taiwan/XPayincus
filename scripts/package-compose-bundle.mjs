import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { composeBundleFiles, composeImages, validateVersions } from './release-contract.mjs'

const version = validateVersions()
const source = path.resolve(process.argv[2])
const destination = path.resolve(process.argv[3])
const output = path.join(destination, `xpayincus-compose-${version}.tar.gz`)
for (const file of composeBundleFiles) {
  const entry = fs.lstatSync(path.join(source, file))
  if (!entry.isFile() || entry.size === 0 || entry.size > 2097152) throw new Error(`Invalid Compose bundle file: ${file}`)
  let parent = path.dirname(file)
  while (parent !== '.') {
    const directory = fs.lstatSync(path.join(source, parent))
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error(`Invalid Compose bundle directory: ${parent}`)
    parent = path.dirname(parent)
  }
  fs.accessSync(path.join(source, file), fs.constants.R_OK)
}
if (fs.readFileSync(path.join(source, 'VERSION'), 'utf8').replace(/\r?\n$/, '') !== version) throw new Error('Compose bundle VERSION mismatch')
if (!fs.readFileSync(path.join(source, 'XPayincus/deploy/compose/README.md'), 'utf8').includes('incudal-operations-v1')) {
  throw new Error('Compose bundle is missing operations capability and recovery guidance')
}
const expected = { services: Object.fromEntries(Object.entries(composeImages(version)).map(([service, image]) => [service, { image }])) }
if (JSON.stringify(JSON.parse(fs.readFileSync(path.join(source, 'XPayincus/deploy/compose/compose.release.yaml'), 'utf8'))) !== JSON.stringify(expected)) {
  throw new Error('Compose bundle release override mismatch')
}
fs.mkdirSync(destination, { recursive: true })
try {
  fs.lstatSync(output)
  throw new Error(`Refusing to overwrite: ${output}`)
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}
const temporary = fs.mkdtempSync(path.join(destination, '.compose-bundle-'))
try {
  const archive = path.join(temporary, 'bundle.tar.gz')
  execFileSync('tar', ['-czf', archive, '-C', source, ...composeBundleFiles], { stdio: 'pipe' })
  fs.linkSync(archive, output)
} finally {
  fs.rmSync(temporary, { recursive: true, force: true })
}
