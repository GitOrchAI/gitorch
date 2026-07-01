import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { getEnv } from '../config/env.js'
import jwt from 'jsonwebtoken'

export const authRoutes = async (app: FastifyInstance): Promise<void> => {
  const env = getEnv()

  // Redirect to GitHub OAuth
  app.get('/api/v1/auth/github', async (request: FastifyRequest, reply: FastifyReply) => {
    const clientId = env.GITHUB_CLIENT_ID
    if (!clientId) {
      return reply.code(500).send({ error: 'GITHUB_CLIENT_ID is not configured' })
    }

    const redirectUri = `${request.protocol}://${request.hostname}/api/v1/auth/github/callback`
    const githubAuthUrl = `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=read:user%20user:email%20repo`

    return reply.redirect(githubAuthUrl)
  })

  // Callback handler
  app.get('/api/v1/auth/github/callback', async (request: FastifyRequest, reply: FastifyReply) => {
    const { code } = request.query as { code?: string }
    if (!code) {
      return reply.code(400).send({ error: 'Missing code query parameter' })
    }

    const clientId = env.GITHUB_CLIENT_ID
    const clientSecret = env.GITHUB_CLIENT_SECRET
    if (!clientId || !clientSecret) {
      return reply.code(500).send({ error: 'GitHub OAuth is not configured' })
    }

    // Exchange code for access token
    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
      }),
    })

    const tokenData = (await tokenResponse.json()) as { access_token?: string; error?: string }
    if (tokenData.error || !tokenData.access_token) {
      return reply.code(400).send({ error: tokenData.error || 'Failed to exchange OAuth code' })
    }

    const githubToken = tokenData.access_token

    // Fetch user details from GitHub
    const userResponse = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: 'application/json',
        'User-Agent': 'gitorch-control-plane',
      },
    })

    const userData = (await userResponse.json()) as { id: number; login: string; email?: string }
    if (!userData.login) {
      return reply.code(400).send({ error: 'Failed to fetch user profile from GitHub' })
    }

    // Sign JWT session token
    const sessionToken = jwt.sign(
      {
        userId: String(userData.id),
        wingId: userData.login, // Default wingId is their username
        githubToken,
        email: userData.email,
      },
      env.JWT_SECRET,
      { expiresIn: '7d' }
    )

    // Redirect to frontend setup wizard page with token
    const redirectUrl = `${env.FRONTEND_URL}/setup?token=${sessionToken}`
    return reply.redirect(redirectUrl)
  })
}

export default authRoutes
