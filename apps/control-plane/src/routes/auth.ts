import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { getEnv } from '../config/env.js'
import jwt from 'jsonwebtoken'

// Fonte única do tempo de vida da sessão: o cookie e o JWT que ele carrega
// precisam expirar juntos, senão um sobrevive ao outro (cookie morto sendo
// reenviado, ou JWT válido descartado cedo demais).
const SESSION_LIFETIME_SECONDS = 7 * 24 * 60 * 60
const SESSION_LIFETIME_JWT = '7d'

// O `state` do OAuth vive 10 min: tempo de sobra para a pessoa autorizar no
// GitHub, curto o bastante para não virar um passe reutilizável.
const OAUTH_STATE_LIFETIME = '10m'

export const authRoutes = async (app: FastifyInstance): Promise<void> => {
  const env = getEnv()

  /**
   * Origens para onde é seguro devolver a pessoa depois do login: as mesmas do
   * CORS, mais o front configurado e a URL pública da API. NUNCA um destino
   * arbitrário vindo da query — isso seria open redirect.
   */
  const allowedReturnBases = (): string[] => {
    const fromCors = (process.env['CORS_ORIGIN'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && s !== '*')
    const bases = [...fromCors, env.FRONTEND_URL]
    if (env.GITORCH_PUBLIC_URL) bases.push(env.GITORCH_PUBLIC_URL)
    return bases
  }

  const resolveReturnTo = (candidate: string | undefined): string => {
    if (!candidate) return env.FRONTEND_URL
    const allowed = allowedReturnBases().some(
      (base) => candidate === base || candidate.startsWith(`${base}/`)
    )
    return allowed ? candidate : env.FRONTEND_URL
  }

  // Planos válidos do wizard — mesmo conjunto que o front usa pra validar
  // `?plan=` (apps/web/src/components/setup/plan-persistence.ts). Um valor
  // fora daqui é descartado silenciosamente: nunca vira um plano não
  // reconhecido pendurado no state assinado nem no redirect final.
  const VALID_PLANS = ['free', 'solo', 'pro', 'team']
  const resolvePlanParam = (candidate: string | undefined): string | undefined =>
    candidate && VALID_PLANS.includes(candidate) ? candidate : undefined

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

      // Devolver a pessoa para a origem de onde ela veio (o front pode estar no
      // Pages OU servido pela própria API, same-origin). Antes o retorno era
      // fixo no FRONTEND_URL: quem abrisse o wizard pelo endereço same-origin
      // era cuspido para fora dele no meio do login, e a sessão — cujo cookie
      // nasce no domínio da API — ficava órfã.
      //
      // O destino viaja no `state`, ASSINADO: além de carregar a origem, isso
      // finalmente dá ao fluxo um state (não havia nenhum), fechando a brecha de
      // CSRF em que um terceiro dispara o callback com um `code` que não pediu.
      // O plano de entrada (?plan=pro na landing) viaja no mesmo `state`
      // assinado — é a ÚNICA forma de sobreviver ao round-trip do OAuth (a
      // navegação de página inteira apaga qualquer estado em memória React).
      // Sem isso, quem entrava querendo pagar voltava do login como 'free'.
      const { return_to: returnToParam, plan: planParam } = request.query as {
        return_to?: string
        plan?: string
      }
      const returnTo = resolveReturnTo(returnToParam)
      const plan = resolvePlanParam(planParam)
      const state = jwt.sign({ returnTo, ...(plan ? { plan } : {}) }, env.JWT_SECRET, {
        expiresIn: OAUTH_STATE_LIFETIME,
      })

      // Sem `&scope=`: GITHUB_CLIENT_ID é um GitHub App (client_id Iv23...)
      // — Apps IGNORAM o parâmetro `scope` da URL de autorização (achado
      // F8). As permissões de um GitHub App vêm de outro lugar: "Account
      // permissions" configuradas na própria página do App no GitHub
      // (email, etc.) e as permissões de REPOSITÓRIO da instalação (ver
      // routes/github-app-install.ts). O `scope=read:user user:email repo`
      // que existia aqui parecia controlar algo — não controlava nada; só
      // confundia quem lesse o código achando que dava para restringir
      // acesso por esta URL.
      const githubAuthUrl =
        `https://github.com/login/oauth/authorize?client_id=${clientId}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&state=${encodeURIComponent(state)}`

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
      const { code, state } = request.query as { code?: string; state?: string }
      if (!code) {
        return reply.code(400).send({ error: 'Missing code query parameter' })
      }

      // O `state` é a prova de que este fluxo começou aqui (anti-CSRF) e carrega
      // para onde devolver a pessoa — e, agora, o plano de entrada. Sem ele, ou
      // adulterado, o login não segue.
      let returnTo = env.FRONTEND_URL
      let plan: string | undefined
      if (state) {
        try {
          const decoded = jwt.verify(state, env.JWT_SECRET) as { returnTo?: string; plan?: string }
          returnTo = resolveReturnTo(decoded.returnTo)
          plan = resolvePlanParam(decoded.plan)
        } catch {
          return reply.code(400).send({ error: 'Invalid or expired OAuth state' })
        }
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

      // F8: GitHub Apps com "User-to-server token expiration" LIGADO (o
      // nosso caso) devolvem, junto do access_token, um refresh_token e o
      // tempo de vida de cada um (expires_in ~8h, refresh_token_expires_in
      // ~6 meses). Antes desta task esses três campos eram lidos e
      // IGNORADOS — o token expirava sozinho em ~8h e nada renovava.
      const tokenData = (await tokenResponse.json()) as {
        access_token?: string
        error?: string
        refresh_token?: string
        expires_in?: number
        refresh_token_expires_in?: number
      }
      if (tokenData.error || !tokenData.access_token) {
        return reply.code(400).send({ error: tokenData.error || 'Failed to exchange OAuth code' })
      }

      const githubToken = tokenData.access_token
      const agoraDoLogin = new Date()
      // undefined quando o App não tem token expirável ligado (ou é um
      // OAuth App clássico) — connectGitHubToken grava expiresAt/refreshToken
      // só quando presentes; ausência aqui preserva o comportamento anterior
      // (token sem prazo, nunca marcado para renovar).
      const refreshInfo =
        tokenData.refresh_token && typeof tokenData.expires_in === 'number'
          ? {
              refreshToken: tokenData.refresh_token,
              expiresAt: new Date(agoraDoLogin.getTime() + tokenData.expires_in * 1000),
              ...(typeof tokenData.refresh_token_expires_in === 'number'
                ? {
                    refreshTokenExpiresAt: new Date(
                      agoraDoLogin.getTime() + tokenData.refresh_token_expires_in * 1000
                    ),
                  }
                : {}),
            }
          : undefined

      // Fetch user details from GitHub
      const userResponse = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: 'application/json',
          'User-Agent': 'gitorch-control-plane',
        },
      })

      const userData = (await userResponse.json()) as { id: number; login: string; email?: string }
      // Exige login E id numérico: o id é a âncora de identidade estável (o
      // login pode ser renomeado/reusado). Sem o guard, um /user degenerado
      // geraria um e-mail noreply tipo `undefined+login@...`.
      if (!userData.login || typeof userData.id !== 'number') {
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
        // Só e-mail VERIFICADO vira chave de identidade — nunca o primeiro da
        // lista sem checar (um secundário não-verificado não prova posse).
        email =
          emails.find((e) => e.primary && e.verified)?.email ??
          emails.find((e) => e.verified)?.email
      }

      // Sem e-mail utilizável (conta com e-mail privado; ou a credencial é um
      // GitHub App — client_id Iv23... — cujo /user/emails responde 403 porque
      // o `scope=user:email` da URL de autorização é IGNORADO por Apps): cai no
      // endereço NOREPLY estável do GitHub (id+login@users.noreply.github.com).
      // É único e permanente por usuário (o id numérico nunca muda), formato
      // oficial do próprio GitHub — serve de chave de identidade sem depender de
      // scope/permissão de e-mail. Login nunca trava por e-mail indisponível.
      if (!email) {
        email = `${userData.id}+${userData.login}@users.noreply.github.com`
      }

      // O User é criado/atualizado AQUI — nenhum outro lugar do código faz
      // isso hoje. Sem essa linha de vida, `setup/submit` nunca resolve um
      // dono pra um cliente novo (cai sempre no fallback legado single-
      // tenant), e EngineConnection.userId não tem a que se referir: as
      // rotas de motor (plugins/engines.ts) resolvem o id do usuário via
      // e-mail → Prisma User.id (cuid) — nunca o id numérico do GitHub. O id
      // da sessão precisa ser o MESMO id, senão a credencial cifrada e o
      // dono do projeto nunca se encontram.
      //
      // F1 Onda 2 — identidade por githubId: o `login` pode ser renomeado, e
      // o username abandonado fica livre para OUTRA conta reivindicar. Casar
      // primeiro por e-mail/githubLogin faria essa outra conta "herdar" o
      // User (e os projetos) de quem tinha o username antes — um takeover
      // silencioso. O id numérico do GitHub nunca muda nem é reciclado: é a
      // âncora que resolvemos PRIMEIRO, antes de qualquer coisa baseada em
      // e-mail ou login.
      const githubId = BigInt(userData.id)
      let dbUser
      const byGithubId = await app.prisma.user.findUnique({ where: { githubId } })
      if (byGithubId) {
        dbUser = await app.prisma.user.update({
          where: { id: byGithubId.id },
          data: { email, githubLogin: userData.login },
        })
      } else {
        // Backfill: sem githubId ainda — conta nova, ou um User de antes
        // desta coluna existir. Cai no caminho de sempre (casar por e-mail) e
        // GRAVA o githubId agora, fechando a lacuna pros próximos logins.
        try {
          dbUser = await app.prisma.user.upsert({
            where: { email },
            update: { githubLogin: userData.login, githubId },
            create: { email, githubLogin: userData.login, githubId },
          })
        } catch (err) {
          // Colisão: a conta trocou qual e-mail é primário/verificado no
          // GitHub desde o último login — o upsert por e-mail tenta CRIAR um
          // User (não existe nenhum com o e-mail novo) e esbarra na
          // constraint única de githubLogin, que já pertence ao User antigo
          // dessa MESMA conta. githubLogin identifica a conta com mais força
          // que o e-mail (que pode mudar do lado do provider), então
          // re-vincula em vez de falhar. Não grava githubId aqui de
          // propósito (mantém este resgate idêntico ao de antes) — ele
          // fecha sozinho no PRÓXIMO login, quando o e-mail já bate e o
          // upsert normal acima roda sem colidir.
          if (
            typeof err === 'object' &&
            err !== null &&
            'code' in err &&
            (err as { code: string }).code === 'P2002'
          ) {
            dbUser = await app.prisma.user.update({
              where: { githubLogin: userData.login },
              data: { email },
            })
          } else {
            throw err
          }
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
        // Conjunto de argumentos DIFERENTE conforme haja ou não par de
        // renovação — nunca um 3º argumento `undefined` explícito, que
        // teria arity 3 e quebraria qualquer chamador que espera
        // exatamente `(userId, token)`.
        await (refreshInfo
          ? app.engineConnections.connectGitHubToken(userId, githubToken, refreshInfo)
          : app.engineConnections.connectGitHubToken(userId, githubToken))
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
      // deixam de expor a sessão — spec §17.4), de volta à origem de onde a
      // pessoa saiu (validada contra a allowlist, nunca destino arbitrário).
      // O plano de entrada volta na query quando presente — é o front
      // (page.tsx) que lê `?plan=` de novo pós-mount e retoma de onde parou.
      const redirectUrl = plan ? `${returnTo}/setup?plan=${plan}` : `${returnTo}/setup`
      return reply.redirect(redirectUrl)
    }
  )

  // Sessão atual (cookie ou Bearer, via hook global de auth). O front usa
  // isto pra saber se já está logado, sem ler token de localStorage/URL.
  app.get('/api/v1/auth/me', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      return reply.code(401).send({ error: 'UNAUTHORIZED: no session' })
    }
    // Sessão-zumbi: o cookie é um JWT auto-contido — a assinatura sobrevive a
    // troca/reset de banco e a usuário apagado. Sem esta checagem, o wizard
    // pula o login com um "usuário" que nenhuma rota protegida resolve (caso
    // real 18/07: repos morria em "GitHub not connected" sem saída). Usuário
    // sumiu => 401 + cookie limpo => a pessoa volta pro login de verdade.
    // A checagem de "o dono ainda existe" saiu daqui: ela vive no hook de
    // autenticação (plugins/auth.ts), então vale para TODA rota de sessão —
    // não só para esta. Antes, qualquer outra rota estourava em 500 com um
    // cookie de usuário apagado; aqui ela era conferida e no resto do produto
    // não. Repetir a consulta agora seria só uma ida ao banco a mais.
    return reply.send({
      authenticated: true,
      userId: request.user.id,
      wingId: request.user.wingId,
      email: request.user.email ?? null,
    })
  })
}

export default authRoutes
