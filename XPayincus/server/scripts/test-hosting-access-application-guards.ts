import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const hostingRoutes = await readFile(resolve(root, 'src/routes/hosting.ts'), 'utf8')
const packageRoutes = await readFile(resolve(root, 'src/routes/packages.ts'), 'utf8')
const hostRoutes = await readFile(resolve(root, 'src/routes/hosts.ts'), 'utf8')
const applicationRoutes = await readFile(resolve(root, 'src/routes/hosting-access-applications.ts'), 'utf8')
const accessModule = await readFile(resolve(root, 'src/lib/hosting-access.ts'), 'utf8')

const assetRoutes = ['/balance', '/logs', '/withdraw', '/withdrawals', '/stats']
for (const route of assetRoutes) {
  const start = hostingRoutes.indexOf(`'${route}'`)
  if (start === -1) throw new Error(`missing hosting route: ${route}`)
  const end = hostingRoutes.indexOf('\n  })', start)
  if (!hostingRoutes.slice(start, end).includes('ensureHostingAccess(request, reply, false)')) throw new Error(`missing approval-only access check: ${route}`)
}

if (!packageRoutes.includes('checkHostingAccess')) throw new Error('package route is missing hosting access check')
if (!hostRoutes.includes('const accessCheck = await checkHostingAccess(request.user.id)')) throw new Error('host creation must enforce hosting approval')
if (!applicationRoutes.includes("'/api/hosting/application'")) throw new Error('user application routes are missing')
if (!applicationRoutes.includes("'/api/admin/hosting/applications'")) throw new Error('admin application routes are missing')
if (!accessModule.includes("state.applicationStatus === 'approved'")) throw new Error('hosting approval status is not enforced')

console.log('hosting access application guards passed')
