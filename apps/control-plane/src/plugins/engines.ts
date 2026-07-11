import fp from 'fastify-plugin'
import { FastifyPluginAsync } from 'fastify'
import { isDeviceRuntime } from '@gitorch/agents'
import { EngineConnectionService, resolveEngineId } from '../services/engine-connection.js'
import { ClientEnvironmentService } from '../services/environment.js'
import {
  AssistedLoginService,
  type AssistedLoginOptions,
  type LoginState,
} from '../services/assisted-login.js'

// Seam de teste: permite injetar um `runDeviceLoginImpl` fake em vez de
// disparar um container podman de verdade (usado pelos testes de
// engines.test.ts para as rotas de login assistido).
interface EnginesPluginOptions {
  runDeviceLoginImpl?: AssistedLoginOptions['runDeviceLoginImpl']
}

// Expõe o serviço de conexões de motor e as rotas do usuário para ver/gerir
// suas conexões. A credencial cifrada NUNCA é retornada — apenas o status.
const enginesPluginImpl: FastifyPluginAsync<EnginesPluginOptions> = async (app, opts) => {
  const service = new EngineConnectionService(app.prisma)
  app.decorate('engineConnections', service)

  // Ambiente isolado do user: o login assistido grava a credencial DENTRO dele
  // (HOME = dir 0700 do ambiente). Idempotente — reusa o provisório do aceite
  // dos termos; nunca cria um segundo.
  const clientEnvironments = new ClientEnvironmentService(app.prisma)

  const assistedLogin = new AssistedLoginService(service, {
    image: process.env['GITORCH_AGENT_IMAGE'] ?? 'localhost/gitorch-agent:latest',
    ...(opts.runDeviceLoginImpl ? { runDeviceLoginImpl: opts.runDeviceLoginImpl } : {}),
  })

  // Lista as conexões de motor do usuário autenticado (só status).
  app.get('/api/v1/engines', async (request, reply) => {
    const userId = await resolveUserId(app, request)
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED: user session required' })
    return reply.send({ engines: await service.list(userId) })
  })

  // Conecta o GitHub do usuário por token (fine-grained PAT). O valor nunca é
  // logado; o token segue o mesmo cofre cifrado das credenciais de motor e vira
  // GH_TOKEN dentro do sandbox das missões dos projetos deste usuário.
  app.post('/api/v1/engines/github/token', async (request, reply) => {
    const userId = await resolveUserId(app, request)
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED: user session required' })
    const { token } = (request.body ?? {}) as { token?: string }
    if (!token) return reply.code(400).send({ error: 'token é obrigatório' })
    try {
      const status = await service.connectGitHubToken(userId, token)
      return reply.send({ connected: true, status })
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message })
    }
  })

  // Conexão real dos motores de IA que não expõem um device-code servidor-side
  // hoje: o cliente cola o que o login LOCAL do CLI produziu — o `setup-token`
  // do Claude Code (vira env var) ou o conteúdo do arquivo de credencial do
  // Codex/Antigravity (auth.json / oauth-token). Mesmo cofre cifrado de
  // qualquer credencial; nunca logado.
  const ENV_CREDENTIAL_VAR: Record<string, string> = {
    claude: 'CLAUDE_CODE_OAUTH_TOKEN',
  }
  // `claude setup-token` documenta validade de ~1 ano. Sem gravar isto,
  // expiresAt (schema desde 151b471) ficava pra sempre null e a conexão nunca
  // era detectada como vencida — materializeToHome seguia servindo o token
  // morto pras missões até o CLI falhar a autenticação lá dentro.
  const ENV_CREDENTIAL_TTL_DAYS: Record<string, number> = {
    claude: 365,
  }
  app.post('/api/v1/engines/:runtime/token', async (request, reply) => {
    const userId = await resolveUserId(app, request)
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED: user session required' })
    const runtime = resolveEngineId((request.params as { runtime: string }).runtime)
    const { token } = (request.body ?? {}) as { token?: string }
    if (!token) return reply.code(400).send({ error: 'token é obrigatório' })
    try {
      const envVarName = ENV_CREDENTIAL_VAR[runtime]
      let status
      if (envVarName) {
        const ttlDays = ENV_CREDENTIAL_TTL_DAYS[runtime]
        const expiresAt = ttlDays ? new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000) : undefined
        status = await service.connectRawToken(userId, runtime, token, {
          envVarName,
          ...(expiresAt ? { expiresAt } : {}),
        })
      } else {
        status = await service.connectFileCredential(userId, runtime, token)
      }
      return reply.send({ connected: true, status })
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message })
    }
  })

  // Revoga (desconecta) um motor do usuário.
  app.delete('/api/v1/engines/:runtime', async (request, reply) => {
    const userId = await resolveUserId(app, request)
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED: user session required' })
    const runtime = resolveEngineId((request.params as { runtime: string }).runtime)
    await service.revoke(userId, runtime)
    return reply.send({ revoked: true, runtime })
  })

  // Atualiza e retorna o catálogo de modelos do provider (descoberto ao vivo).
  app.post('/api/v1/engines/:runtime/models/refresh', async (request, reply) => {
    const userId = await resolveUserId(app, request)
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED: user session required' })
    const runtime = resolveEngineId((request.params as { runtime: string }).runtime)
    const models = await service.refreshModels(userId, runtime)
    return reply.send({ runtime, models })
  })

  // Login assistido: inicia o CLI do motor num container isolado. O
  // frontend abre o stream SSE logo em seguida com o loginId retornado.
  app.post('/api/v1/engines/:runtime/login/start', async (request, reply) => {
    const userId = await resolveUserId(app, request)
    if (!userId || !request.user) {
      return reply.code(401).send({ error: 'UNAUTHORIZED: user session required' })
    }
    const runtime = resolveEngineId((request.params as { runtime: string }).runtime)
    if (!isDeviceRuntime(runtime)) {
      return reply
        .code(400)
        .send({ error: `runtime não suportado para login assistido: ${runtime}` })
    }
    // O motor loga DENTRO do ambiente isolado do user: HOME = dir 0700 do
    // ambiente, então a credencial que o CLI grava vive ali, protegida, e a
    // faxina 24h a destrói se o wizard for abandonado. createProvisional é
    // idempotente — no wizard reusa o ambiente nascido no aceite dos termos
    // (só um findFirst, sem recriar). `path` vazio (impossível na prática) cai
    // no fallback de HOME temporário do próprio serviço.
    //
    // O AMBIENTE é chaveado por `request.user.id` (o id do JWT) — a MESMA base
    // que TODO o ciclo de vida do ambiente no setup.ts usa (aceite dos termos,
    // clone, fix). O cofre de credenciais (captureFromHome/EngineConnection) é
    // que é chaveado por `userId` (id do banco, resolvido por e-mail). Misturar
    // as duas bases aqui criaria, quando o id do JWT diverge do id do banco
    // (cenário que o setup.ts documenta e trata), um ambiente SEPARADO do que
    // os termos criaram: o login gravaria a credencial num env que nunca é
    // fixado e a faxina 24h o apagaria, enquanto o env fixado ficaria sem a
    // credencial em disco. No caminho feliz os dois ids são iguais.
    const env = await clientEnvironments.createProvisional(request.user.id)
    const loginId = assistedLogin.start(userId, runtime, env.path || undefined)
    return reply.code(202).send({ loginId })
  })

  // Código colado de volta da página de OAuth (Claude/Antigravity — Codex não
  // usa esta rota, o CLI faz polling sozinho depois que o usuário aprova).
  app.post('/api/v1/engines/login/:loginId/code', async (request, reply) => {
    const userId = await resolveUserId(app, request)
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED: user session required' })
    const { loginId } = request.params as { loginId: string }
    const { code } = (request.body ?? {}) as { code?: string }
    if (!code) return reply.code(400).send({ error: 'code é obrigatório' })
    try {
      assistedLogin.submitCode(loginId, userId, code)
      return reply.send({ ok: true })
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message })
    }
  })

  // Snapshot pontual do estado (JSON puro, sem manter a conexão aberta) —
  // fallback de polling caso o `EventSource` do frontend falhe (proxy/rede
  // que bloqueia SSE), e também o único jeito de checar o estado de fora de
  // um browser real (ex.: `page.request.get` do Playwright, que não consome
  // SSE — ver tests/e2e/setup-wizard-assisted-login-codex.spec.ts). Reaproveita
  // `subscribe()`: seu primeiro callback é SEMPRE síncrono com o estado atual
  // (contrato testado em assisted-login.test.ts), então capturamos esse
  // primeiro valor e desinscrevemos na sequência — nunca ficamos de fato
  // inscritos. `unsubscribe === null` é o mesmo sinal de "não encontrada ou
  // não é sua" que a rota /stream já usa (mesma proteção contra IDOR).
  app.get('/api/v1/engines/login/:loginId', async (request, reply) => {
    const userId = await resolveUserId(app, request)
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED: user session required' })
    const { loginId } = request.params as { loginId: string }

    let state: LoginState | undefined
    const unsubscribe = assistedLogin.subscribe(loginId, userId, (s) => {
      state = s
    })
    if (!unsubscribe) {
      return reply.code(404).send({ error: 'sessão de login não encontrada' })
    }
    unsubscribe()
    return reply.send(state)
  })

  // Estado do login em tempo real (mesmo padrão de routes/events.ts).
  app.get('/api/v1/engines/login/:loginId/stream', async (request, reply) => {
    const userId = await resolveUserId(app, request)
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED: user session required' })
    const { loginId } = request.params as { loginId: string }

    const unsubscribe = assistedLogin.subscribe(loginId, userId, (state) => {
      reply.sse({ event: 'state', data: JSON.stringify(state) })
    })
    if (!unsubscribe) {
      return reply.code(404).send({ error: 'sessão de login não encontrada' })
    }

    request.raw.on('close', unsubscribe)
    await new Promise(() => {})
  })
}

// Resolve o id do usuário-dono a partir da sessão (email do JWT).
async function resolveUserId(
  app: Parameters<FastifyPluginAsync>[0],
  request: { user?: { email?: string } }
): Promise<string | null> {
  const email = request.user?.email
  if (!email) return null
  const user = await app.prisma.user.findUnique({ where: { email } })
  return user?.id ?? null
}

export const enginesPlugin = fp(enginesPluginImpl)

declare module 'fastify' {
  interface FastifyInstance {
    engineConnections: EngineConnectionService
  }
}
