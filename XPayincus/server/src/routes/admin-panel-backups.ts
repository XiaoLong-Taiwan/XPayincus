import type { FastifyInstance } from 'fastify'
import { createReadStream } from 'fs'
import { stat } from 'fs/promises'
import { basename, join } from 'path'
import { claimOperationVerificationRequirement } from '../lib/operation-verification.js'
import { consumePanelBackupDownload, createPanelBackupDownload, getPanelBackupTask, listPanelBackups, startPanelBackup } from '../services/panel-backup.js'

export default async function adminPanelBackupRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', {
    onRequest: [app.authenticate, app.requireAdmin],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } }
  }, async () => ({ backups: await listPanelBackups(), task: getPanelBackupTask() }))

  app.post('/', {
    onRequest: [app.authenticate, app.requireAdmin],
    config: { rateLimit: { max: 2, timeWindow: '1 hour' } },
    schema: {
      body: {
        type: 'object',
        required: ['passphrase'],
        additionalProperties: false,
        properties: { passphrase: { type: 'string', minLength: 16, maxLength: 1024 } }
      }
    }
  }, async (request, reply) => {
    const user = request.user!
    const requestBody = request.body as { passphrase: string }
    const passphrase = requestBody.passphrase
    requestBody.passphrase = ''
    try {
      const verification = await claimOperationVerificationRequirement(user.id, 'backup_panel')
      if (!verification.verified) return reply.code(403).send({ error: 'Second verification required', code: 'VERIFICATION_REQUIRED' })
      const task = startPanelBackup(passphrase)
      return reply.code(202).send({ task })
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      const statusCode = message.includes('already running') ? 409 : message.includes('Passphrase') ? 400 : 500
      return reply.code(statusCode).send({ error: statusCode === 500 ? 'Panel backup failed' : message })
    } finally {
      requestBody.passphrase = ''
    }
  })

  app.post('/:id/download-token', {
    onRequest: [app.authenticate, app.requireAdmin],
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$' } } } }
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const directory = process.env.PANEL_BACKUP_DIRECTORY || '/opt/incudal/backups'
    const name = `panel-backup-${id}.xpb`
    const info = await stat(join(directory, name)).catch(() => null)
    if (!info?.isFile() || (info.mode & 0o077) !== 0) return reply.code(404).send({ error: 'Backup not found' })
    const token = createPanelBackupDownload(request.user!.id, id)
    return token ? { token, expiresIn: 60 } : reply.code(404).send({ error: 'Backup not found' })
  })

  app.get('/download/:token', {
    onRequest: [app.authenticate, app.requireAdmin],
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: { params: { type: 'object', required: ['token'], properties: { token: { type: 'string', minLength: 43, maxLength: 43 } } } }
  }, async (request, reply) => {
    const { token } = request.params as { token: string }
    const file = await consumePanelBackupDownload(request.user!.id, token)
    if (!file) return reply.code(404).send({ error: 'Download token expired or invalid' })
    reply.header('Cache-Control', 'no-store, private')
    reply.header('Pragma', 'no-cache')
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Content-Type', 'application/octet-stream')
    reply.header('Content-Disposition', `attachment; filename="${basename(file)}"`)
    return reply.send(createReadStream(file))
  })
}
