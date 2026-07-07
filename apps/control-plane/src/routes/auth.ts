import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { Prisma } from '@prisma/client'
import { getEnv } from '../config/env.js'
import jwt from 'jsonwebtoken'

// Fonte única do tempo de vida da sessão: o cookie e o JWT que ele carrega
// precisam expirar juntos, senão um sobrevive ao outro (cookie morto sendo
// reenviado, ou JWT válido descartado cedo demais).
const SESSION_LIFETIME_SECONDS = 7 * 24 * 60 * 60
const SESSION_LIFETIME_JWT = '7d'

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
        const emailsData: unknown = await emailsResponse.json()
        // GitHub devolve um objeto de erro (rate limit, etc.), não um array,
        // quando a chamada falha — sem esta checagem, `.find()` estourava e
        // virava um 500 não tratado no meio do callback OAuth.
        const emails = Array.isArray(emailsData)
          ? (emailsData as Array<{ email: string; primary: boolean; verified: boolean }>)
          : []
        email = emails.find((e) => e.primary && e.verified)?.email ?? emails[0]?.email
      }

      // O resto do sistema usa e-mail como chave de junção (User, plano,
      // EngineConnection) — sem ele o login "sucedia" silenciosamente (cookie
      // setado, redirect 302) mas sem User/credencial persistidos, e o
      // cliente caía num 401 sem explicação no primeiro /github/repos.
      if (!email) {
        return reply.code(400).send({
          error:
            'Não foi possível obter um e-mail verificado da sua conta GitHub. Verifique um e-mail em github.com/settings/emails e tente novamente.',
        })
      }

      // O User é criado/atualizado AQUI — nenhum outro lugar do código faz
      // isso hoje. Sem essa linha de vida, `setup/submit` nunca resolve um
      // dono pra um cliente novo (cai sempre no fallback legado single-
      // tenant), e EngineConnection.userId não tem a que se referir: as
      // rotas de motor (plugins/engines.ts) resolvem o id do usuário via
      // e-mail → Prisma User.id (cuid) — nunca o id numérico do GitHub. O id
      // da sessão precisa ser o MESMO id, senão a credencial cifrada e o
      // dono do projeto nunca se encontram.
      let dbUser
      try {
        dbUser = await app.prisma.user.upsert({
          where: { email },
          update: { githubLogin: userData.login },
          create: { email, githubLogin: userData.login },
        })
      } catch (err) {
        // Colisão: a conta trocou qual e-mail é primário/verificado no GitHub
        // desde o último login — o upsert por e-mail tenta CRIAR um User (não
        // existe nenhum com o e-mail novo) e esbarra na constraint única de
        // githubLogin, que já pertence ao User antigo dessa MESMA conta.
        // githubLogin identifica a conta com mais força que o e-mail (que
        // pode mudar do lado do provider), então re-vincula em vez de falhar.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          dbUser = await app.prisma.user.update({
            where: { githubLogin: userData.login },
            data: { email },
          })
        } else {
          throw err
        }
      }
      const userId = dbUser.id

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
        { expiresIn: SESSION_LIFETIME_JWT }
      )

      // Persiste o token do GitHub cifrado por usuário (se o serviço estiver
      // disponível — ausente apenas em testes de rota isolados).
      if (app.engineConnections) {
        await app.engineConnections.connectGitHubToken(userId, githubToken)
      }

      // Front (GitHub Pages/NEXT_PUBLIC_API_URL) e control-plane vivem em
      // origens diferentes fora do dev local — SameSite=Lax nunca acompanha
      // um fetch/XHR cross-site (só navegação top-level), então todo
      // credentials:'include' subsequente (auth/me, github/repos, setup/
      // submit) voltaria 401 logo após um login que acabou de funcionar.
      // SameSite=None exige Secure; em dev (http, localhost:3000<->:4000 são
      // portas diferentes mas mesmo site) Lax sem Secure continua correto.
      const isDev = env.NODE_ENV === 'development'
      reply.setCookie('gitorch_session', sessionToken, {
        httpOnly: true,
        secure: !isDev,
        sameSite: isDev ? 'lax' : 'none',
        path: '/',
        maxAge: SESSION_LIFETIME_SECONDS,
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
