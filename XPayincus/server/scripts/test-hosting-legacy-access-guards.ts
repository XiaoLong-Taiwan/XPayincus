import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const app = await readFile(resolve(root, 'src/app.ts'), 'utf8')
const packageRoutes = await readFile(resolve(root, 'src/routes/packages.ts'), 'utf8')
const packageDb = await readFile(resolve(root, 'src/db/packages.ts'), 'utf8')
const hostRoutes = await readFile(resolve(root, 'src/routes/hosts.ts'), 'utf8')

assert.ok(!existsSync(resolve(root, 'src/routes/hosting-access-applications.ts')), 'retired application route implementation must be removed')
assert.doesNotMatch(app, /hostingAccessApplicationRoutes|hosting-access-applications|\/api\/(?:admin\/)?hosting\/applications?\b/)

assert.match(hostRoutes, /const accessCheck = await checkHostingAccess\(request\.user\.id\)\s+if \(!accessCheck\.allowed\)/, 'host creation must enforce legacy hosting eligibility')
assert.match(packageRoutes, /FastifyRequest<\{ Body: CreatePackageRequest \}>[^\n]+\n\s+if \(request\.user\.role !== 'admin'\) \{\s+const accessCheck = await checkHostingAccess\(request\.user\.id\)\s+if \(!accessCheck\.allowed\)/, 'package creation must enforce legacy hosting eligibility')
assert.match(packageRoutes, /if \(!isAdmin && !willBeGlobalShared && packageInput\.active === true\) \{\s+const accessCheck = await checkHostingAccess\(request\.user\.id\)\s+if \(!accessCheck\.allowed\)/, 'private package activation must enforce legacy hosting eligibility')
assert.match(packageRoutes, /if \(request\.user\.role !== 'admin' && globalShared === true\) \{\s+return reply\.code\(403\)\.send\(PACKAGE_PUBLISHING_FORBIDDEN\)/, 'public package creation must be reserved for admins')
assert.match(packageRoutes, /const isMakingPublic = globalShared === true && !currentGlobalShared\s+const isReactivatingPublic = willBeGlobalShared && packageInput\.active === true && pkg\.active !== 1\s+if \(!isAdmin && \(isMakingPublic \|\| isReactivatingPublic\)\) \{\s+return reply\.code\(403\)\.send\(PACKAGE_PUBLISHING_FORBIDDEN\)/, 'public publishing restrictions must depend on the state transition, not unchanged edit flags')
assert.match(packageRoutes, /await db\.updatePackage\(packageId, updateData, isAdmin, currentGlobalShared\)/, 'conditional writes must receive the sharing state used to authorize the edit')
assert.match(packageDb, /globalShared: willBeGlobalShared,\s+\.\.\.\(willBeGlobalShared && data\.active === true \? \{ active: true \} : \{\}\)/, 'a stale activation request must not override a concurrent delisting or sharing change')
assert.match(packageDb, /if \(publishingGuard\) \{\s+await prisma\.\$transaction\(tx => updatePackageUnchecked\(id, data, isAdmin, tx, publishingGuard\)\)/, 'guarded updates must roll back related writes if the guard fails')
assert.match(packageDb, /client\.package\.update\(\{ where: \{ \.\.\.publishingGuard, id \}, data: updateData \}\)/, 'the final package write must enforce the publishing guard')

console.log('hosting legacy access guards passed')
