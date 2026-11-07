import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

export function docker(args, execute = spawnSync) {
  const result = execute('docker', ['buildx', 'imagetools', ...args], { encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) {
    if (args[0] === 'inspect' && /manifest unknown|name unknown|ghcr\.io\/[^\s]+: not found/i.test(result.stderr) && !/unauthorized|denied|forbidden/i.test(result.stderr)) return null
    throw new Error(`Docker ${args[0]} failed: ${result.stderr}`)
  }
  return result.stdout
}

export function publication(env = process.env, invoke = docker, read = file => fs.readFileSync(file, 'utf8')) {
  const { GITHUB_SHA: sha, IMAGE_TAG: tag, VERSION: version } = env
  if (!/^[a-f0-9]{40}$/.test(sha || '')) throw new Error('Expected full commit SHA')
  if (!/^[\w][\w.-]{0,127}$/.test(tag || '') || tag !== version?.replace('+', '_')) throw new Error('Invalid image version tag')
  const source = 'https://github.com/xiaolong-taiwan/xpayincus'
  const annotations = {
    'org.opencontainers.image.revision': sha,
    'org.opencontainers.image.version': version,
    'org.opencontainers.image.source': source
  }
  const inspect = ref => {
    const raw = invoke(['inspect', ref, '--raw'])
    return raw === null ? null : JSON.parse(raw)
  }
  const verify = manifest => {
    if (!manifest || !Array.isArray(manifest.manifests)) throw new Error('Expected multi-platform index')
    for (const [key, value] of Object.entries(annotations)) {
      if (manifest.annotations?.[key] !== value) throw new Error(`Image source mismatch: ${key}`)
    }
    const platforms = manifest.manifests.map(item => `${item.platform?.os}/${item.platform?.architecture}`)
    const runtime = platforms.filter(item => item !== 'unknown/unknown').sort()
    if (JSON.stringify(runtime) !== JSON.stringify(['linux/amd64', 'linux/arm64'])) throw new Error('Expected exactly amd64 and arm64 images')
  }
  const check = () => ['api', 'web'].map(target => {
    const image = `ghcr.io/xiaolong-taiwan/xpayincus-${target}`
    const immutable = inspect(`${image}:sha-${sha}`)
    const existing = inspect(`${image}:${tag}`)
    if (immutable) verify(immutable)
    if (existing) {
      verify(existing)
      if (!immutable || JSON.stringify(existing) !== JSON.stringify(immutable)) throw new Error('Version tag differs from SHA tag or has no SHA evidence')
    }
    return { target, image, immutable, existing }
  })
  const create = (ref, sources) => {
    const args = ['create', '--tag', ref]
    for (const [key, value] of Object.entries(annotations)) args.push('--annotation', `index:${key}=${value}`)
    invoke([...args, ...sources])
    const result = inspect(ref)
    verify(result)
    return result
  }
  return {
    check,
    publish() {
      const images = check()
      for (const entry of images) {
        if (entry.immutable) continue
        const sources = ['amd64', 'arm64'].map(arch => {
          const digest = read(`digests/${entry.target}-${arch}`).trim()
          if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid build digest')
          return `${entry.image}@${digest}`
        })
        create(`${entry.image}:sha-${sha}`, sources)
      }
      for (const entry of check()) {
        if (entry.existing) continue
        const immutable = entry.immutable
        invoke(['create', '--tag', `${entry.image}:${tag}`, `${entry.image}:sha-${sha}`])
        const existing = inspect(`${entry.image}:${tag}`)
        verify(existing)
        if (JSON.stringify(existing) !== JSON.stringify(immutable)) throw new Error('Published version differs from SHA index')
      }
      check()
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2]
  if (!['check', 'publish'].includes(command)) throw new Error('Expected check or publish')
  publication()[command]()
}
