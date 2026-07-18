import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import jwt from 'jsonwebtoken'
import { getEnv } from '../config/env.js'

/**
 * Instalação do GitHub App (gitorch) por usuário — complementa o login OAuth
 * App clássico (routes/auth.ts) sem mexer nele.
 *
 * O login atual já usa uma credencial de App (user-to-server, `Iv23...`),
 * mas nunca passou pela tela de INSTALAÇÃO do App: o token que ele guarda
 * enxerga o escopo amplo (`repo`) da autorização OAuth clássica — todos os
 * repositórios da conta, de uma vez, sem a pessoa escolher. A instalação
 * (github.com/apps/<slug>/installations/new) é uma etapa DIFERENTE e
 * opcional: é lá que a pessoa decide "todos os repositórios" ou uma lista
 * específica, e é o `installation_id` resultante — gravado aqui no User —
 * que passa a ser o caminho preferido de GET /api/v1/github/repos (rota em
 * setup.ts), restringindo a listagem ao que ela realmente autorizou.
 *
 * Não confundir com `projects.github_installation_id` (github-webhook.ts,
 * projects.ts): aquela coluna é por REPOSITÓRIO — o webhook casa eventos por
 * ela. Esta aqui, em `users.github_installation_id`, é por USUÁRIO.
 */

// Mesmo padrão de `routes/auth.ts`: o `state` do fluxo de instalação é um
// JWT de vida curta assinado com o mesmo segredo de sessão — curto o
// bastante para não virar um passe reutilizável, longo o bastante para a
// pessoa terminar a instalação no GitHub.
const INSTALL_STATE_LIFETIME = '10m'

export const githubAppInstallRoutes = async (app: FastifyInstance): Promise<void> => {
  const env = getEnv()

  // Duplicado de `routes/auth.ts` de propósito (em vez de extrair um
  // util compartilhado): mantém este arquivo isolado do login OAuth
  // clássico, que outra onda de trabalho pode estar tocando em paralelo.
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

  // GET /api/v1/auth/github/install — leva a pessoa (já logada; esta rota
  // exige sessão, ao contrário do /auth/github inicial) para a tela de
  // instalação do App, onde ELA escolhe quais repositórios autorizar. O
  // `state` carrega o userId de quem começou o fluxo: é dele, não da
  // sessão que porventura chegar no callback, que tiramos o dono real do
  // vínculo — a mesma garantia de CSRF que o login OAuth já usa.
  app.get(
    '/api/v1/auth/github/install',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) {
        return reply.code(401).send({ error: 'UNAUTHORIZED: session required' })
      }

      const slug = env.GITHUB_APP_SLUG
      if (!slug) {
        return reply.code(500).send({ error: 'GITHUB_APP_SLUG is not configured' })
      }

      const { return_to: returnToParam } = request.query as { return_to?: string }
      const returnTo = resolveReturnTo(returnToParam)

      const state = jwt.sign({ userId: request.user.id, returnTo }, env.JWT_SECRET, {
        expiresIn: INSTALL_STATE_LIFETIME,
      })

      const installUrl =
        `https://github.com/apps/${encodeURIComponent(slug)}/installations/new` +
        `?state=${encodeURIComponent(state)}`

      return reply.redirect(installUrl)
    }
  )

  // GET /api/v1/auth/github/install/callback — GitHub devolve
  // installation_id + setup_action (install|update|request) + o state que
  // mandamos. O próprio GitHub avisa (docs da API de Apps) para não confiar
  // cegamente no installation_id da query — pode ser forjado por quem
  // simplesmente chame esta URL sem passar pela instalação de verdade. O
  // `state` assinado é a prova real: comparamos o userId nele contra o da
  // sessão atual (a mesma pessoa que saiu é a que voltou) antes de gravar
  // qualquer coisa.
  app.get(
    '/api/v1/auth/github/install/callback',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) {
        return reply.code(401).send({ error: 'UNAUTHORIZED: session required' })
      }

      const {
        installation_id: installationIdRaw,
        state,
        setup_action: setupAction,
      } = request.query as { installation_id?: string; state?: string; setup_action?: string }

      if (!state) {
        return reply.code(400).send({ error: 'Missing state query parameter' })
      }

      let decoded: { userId?: string; returnTo?: string }
      try {
        decoded = jwt.verify(state, env.JWT_SECRET) as { userId?: string; returnTo?: string }
      } catch {
        return reply.code(400).send({ error: 'Invalid or expired install state' })
      }

      // Vínculo entre quem abriu o fluxo (state) e quem voltou (sessão
      // atual) — sem isso, um state assinado vazado/reaproveitado poderia
      // gravar uma instalação alheia na sessão de outra pessoa.
      if (!decoded.userId || decoded.userId !== request.user.id) {
        return reply.code(400).send({ error: 'Invalid or expired install state' })
      }

      const returnTo = resolveReturnTo(decoded.returnTo)

      // 'request' = instalação numa organização que exige aprovação de um
      // admin: não existe installation_id utilizável ainda (só nasce quando
      // alguém aprovar). Nada a gravar agora — devolve ao wizard mesmo
      // assim, sem erro (a pessoa não fez nada de errado).
      if (setupAction === 'request' || !installationIdRaw) {
        return reply.redirect(`${returnTo}/setup`)
      }

      const installationId = Number(installationIdRaw)
      if (!Number.isInteger(installationId) || installationId <= 0) {
        return reply.code(400).send({ error: 'Invalid installation_id' })
      }

      await app.prisma.user.update({
        where: { id: request.user.id },
        data: { githubInstallationId: installationId },
      })

      return reply.redirect(`${returnTo}/setup`)
    }
  )
}

export default githubAppInstallRoutes
