import fs from 'node:fs'
import path from 'node:path'
import { artifactNames, validateVersions } from './release-contract.mjs'

const version = validateVersions()
const source = path.resolve(process.argv[2])
const destination = path.resolve(process.argv[3])
const expected = artifactNames(version).filter(name => name !== `xpayincus-dashboard-${version}-compose.tar.gz` && name !== `xpayincus-zfs-builder-${version}-source.tar.gz`)
const files = new Map()
for (const group of fs.readdirSync(source)) {
  const directory = path.join(source, group)
  if (!fs.lstatSync(directory).isDirectory()) throw new Error(`Invalid artifact group: ${group}`)
  for (const name of fs.readdirSync(directory)) {
    const file = path.join(directory, name)
    if (!expected.includes(name) || files.has(name) || !fs.lstatSync(file).isFile()) throw new Error(`Unexpected or duplicate artifact: ${name}`)
    files.set(name, file)
  }
}
if (expected.some(name => !files.has(name))) throw new Error('Missing build artifacts')
fs.mkdirSync(destination, { recursive: true })
if (fs.readdirSync(destination).length) throw new Error('Assembly directory must be empty')
for (const [name, file] of files) fs.copyFileSync(file, path.join(destination, name), fs.constants.COPYFILE_EXCL)
