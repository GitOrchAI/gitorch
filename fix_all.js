const fs = require('fs');

const authPluginPath = 'apps/control-plane/src/plugins/auth.ts';
let authContent = fs.readFileSync(authPluginPath, 'utf8');

const newRoutes = `
  app.get('/api/v1/invites/claim/:token', async (request, reply) => {
    const { token } = request.params as { token: string }
    try {
      const payload = validateProjectInvitation(token)

      const invitationRecord = await prisma.projectInvitation.findUnique({
        where: { id: payload.invitationId }
      })

      if (!invitationRecord || invitationRecord.status !== 'pending' && invitationRecord.status !== 'PENDING_APPROVAL') {
        return reply.status(400).send({ error: 'Invitation already claimed or revoked' })
      }

      const projects = await prisma.project.findMany({
        where: { id: { in: payload.targetProjects }, userId: payload.userId },
        select: { id: true, wingId: true, name: true },
      })

      const user = await prisma.user.findUnique({
        where: { id: payload.userId },
        select: { id: true, githubLogin: true },
      })

      return reply.send({
        invitation: {
          expiresAt: payload.expiresAt,
          email: payload.email,
          githubLogin: payload.githubLogin,
        },
        projects,
        owner: user,
      })
    } catch (err) {
      if (err instanceof Error && err.message === 'Project invitation expired') {
        return reply.status(401).send({ error: 'Project invitation expired' })
      }
      if (err instanceof Error && err.name === 'CredentialDecryptError') {
        return reply.status(403).send({ error: 'Invalid or tampered invitation token' })
      }
      return reply.status(400).send({ error: 'Invalid invitation token' })
    }
  })

  app.post('/api/v1/invites/claim/:token', async (request, reply) => {
    const { token } = request.params as { token: string }
    try {
      const payload = validateProjectInvitation(token)

      const invitationRecord = await prisma.projectInvitation.findUnique({
        where: { id: payload.invitationId }
      })

      if (!invitationRecord || invitationRecord.status !== 'pending' && invitationRecord.status !== 'PENDING_APPROVAL') {
        return reply.status(400).send({ error: 'Invitation already claimed or revoked' })
      }

      await prisma.projectInvitation.update({
        where: { id: payload.invitationId },
        data: { status: 'claimed' }
      })

      return reply.send({ status: 'claimed' })
    } catch (err) {
      if (err instanceof Error && err.message === 'Project invitation expired') {
        return reply.status(401).send({ error: 'Project invitation expired' })
      }
      if (err instanceof Error && err.name === 'CredentialDecryptError') {
        return reply.status(403).send({ error: 'Invalid or tampered invitation token' })
      }
      return reply.status(400).send({ error: 'Invalid invitation token' })
    }
  })

`;

const insertIndex = authContent.indexOf(`  app.put('/guests/:guestId/scope',`);
if (insertIndex > -1) {
    authContent = authContent.slice(0, insertIndex) + newRoutes + authContent.slice(insertIndex);
}

authContent = authContent.replace(
  /'\/api\/v1\/invitations\/validate\/',/,
  `'/api/v1/invitations/validate/',\n    '/api/v1/invites/claim/',`
);
fs.writeFileSync(authPluginPath, authContent);

const securityPluginPath = 'apps/control-plane/src/plugins/security.ts';
let secContent = fs.readFileSync(securityPluginPath, 'utf8');
secContent = secContent.replace(
  /if \(request\.url\.startsWith\('\/api\/v1\/invitations\/validate\/'\)\) \{/g,
  `if (request.url.startsWith('/api/v1/invitations/validate/') || request.url.startsWith('/api/v1/invites/claim/')) {`
);
secContent = secContent.replace(
  /request\.url\.startsWith\('\/api\/v1\/invitations\/validate\/'\) \|\|/g,
  `request.url.startsWith('/api/v1/invitations/validate/') ||\n        request.url.startsWith('/api/v1/invites/claim/') ||`
);
secContent = secContent.replace(
  /const match = request\.url\.match\(\/\\\/api\\\/v1\\\/invitations\\\/validate\\\/\[\^\\\/\?\]\+\/\)/g,
  `const match = request.url.match(/\\/api\\/v1\\/(?:invitations\\/validate|invites\\/claim)\\/([^/?]+)/)`
);
fs.writeFileSync(securityPluginPath, secContent);
