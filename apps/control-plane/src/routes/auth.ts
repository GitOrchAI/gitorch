import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { getEnv } from '../config/env.js'
import jwt from 'jsonwebtoken'

export const authRoutes = async (app: FastifyInstance): Promise<void> => {
  const env = getEnv()

  // Redirect to GitHub OAuth
  app.get(
    '/api/v1/auth/github',
    {
      config: {
        rateLimit: {
          max: 20,
          timeWindow: '1 minute',
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const clientId = env.GITHUB_CLIENT_ID
      if (!clientId) {
        return reply.code(500).send({ error: 'GITHUB_CLIENT_ID is not configured' })
      }

      // request.hostname NÃO carrega a porta (Fastify v5) — o callback morria
      // em dev (localhost sem :4000). request.host carrega; produção usa a URL
      // pública configurada.
      const publicBase = env.GITORCH_PUBLIC_URL ?? `${request.protocol}://${request.host}`
      const redirectUri = `${publicBase}/api/v1/auth/github/callback`
      const githubAuthUrl = `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=read:user%20user:email%20repo`

      return reply.redirect(githubAuthUrl)
    }
  )

  // Callback handler
  app.get(
    '/api/v1/auth/github/callback',
    {
      config: {
        rateLimit: {
          max: 20,
          timeWindow: '1 minute',
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
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

      // Contas com e-mail privado não devolvem `email` em /user (mesmo com o
      // escopo user:email concedido) — sem esse fallback, resolveUserId()
      // (que exige e-mail) derrubaria as rotas de motor com 401 logo após um
      // login bem-sucedido.
      let email = userData.email
      if (!email) {
        const emailsResponse = await fetch('https://api.github.com/user/emails', {
          headers: {
            Authorization: `Bearer ${githubToken}`,
            Accept: 'application/json',
            'User-Agent': 'gitorch-control-plane',
          },
        })
        const emails = (await emailsResponse.json()) as Array<{
          email: string
          primary: boolean
          verified: boolean
        }>
        email = emails.find((e) => e.primary && e.verified)?.email ?? emails[0]?.email
      }

      // O User é criado/atualizado AQUI — nenhum outro lugar do código faz
      // isso hoje. Sem essa linha de vida, `setup/submit` nunca resolve um
      // dono pra um cliente novo (cai sempre no fallback legado single-
      // tenant), e EngineConnection.userId não tem a que se referir: as
      // rotas de motor (plugins/engines.ts) resolvem o id do usuário via
      // e-mail → Prisma User.id (cuid) — nunca o id numérico do GitHub. O id
      // da sessão precisa ser o MESMO id, senão a credencial cifrada e o
      // dono do projeto nunca se encontram.
      let userId = String(userData.id)
      if (email) {
        const dbUser = await app.prisma.user.upsert({
          where: { email },
          update: { githubLogin: userData.login },
          create: { email, githubLogin: userData.login },
        })
        userId = dbUser.id
      }

      // Sign JWT session token. O token do GitHub NUNCA viaja aqui — o JWT é
      // devolvido dentro de um cookie httpOnly (JS não lê), mas mesmo assim
      // não guardamos o segredo repo-scoped num claim; ele vai cifrado no
      // cofre por usuário (mesmo caminho de qualquer credencial de motor).
      const sessionToken = jwt.sign(
        {
          userId,
          wingId: userData.login, // Default wingId is their username
          email,
        },
        env.JWT_SECRET,
        { expiresIn: '7d' }
      )

      // Persiste o token do GitHub cifrado por usuário (se o serviço estiver
      // disponível — ausente apenas em testes de rota isolados; e só quando
      // temos um id de usuário real, senão a credencial fica órfã).
      if (app.engineConnections && email) {
        await app.engineConnections.connectGitHubToken(userId, githubToken)
      }

      reply.setCookie('gitorch_session', sessionToken, {
        httpOnly: true,
        secure: env.NODE_ENV !== 'development',
        sameSite: 'lax',
        path: '/',
        maxAge: 7 * 24 * 60 * 60,
      })

      // Redireciona para o wizard sem token na URL (histórico/referrer/logs
      // deixam de expor a sessão — spec §17.4).
      const redirectUrl = `${env.FRONTEND_URL}/setup`
      return reply.redirect(redirectUrl)
    }
  )

  // Sessão atual (cookie ou Bearer, via hook global de auth). O front usa
  // isto pra saber se já está logado, sem ler token de localStorage/URL.
  app.get('/api/v1/auth/me', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      return reply.code(401).send({ error: 'UNAUTHORIZED: no session' })
    }
    return reply.send({
      authenticated: true,
      userId: request.user.id,
      wingId: request.user.wingId,
      email: request.user.email ?? null,
    })
  })
}

export default authRoutes
