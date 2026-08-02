import { FastifyInstance } from 'fastify'
import fastifyCookie from '@fastify/cookie'
import fastifyHelmet from '@fastify/helmet'
import fastifySwagger from '@fastify/swagger'
import fastifySwaggerUi from '@fastify/swagger-ui'
import fastifyUnderPressure from '@fastify/under-pressure'
import { Env } from '../config/env.js'
import { API_PREFIX } from '../config/constants.js'
import { parseRateLimitAllowList } from './rate-limit-keys.js'

import { prismaPlugin } from './prisma.js'
import { redisPlugin } from './redis.js'
import { authPlugin } from './auth.js'
import { ssePlugin } from './sse.js'
import { webhookVerifyPlugin } from './webhook-verify.js'
import { securityHookPlugin } from './security.js'
import { telemetryPlugin } from './telemetry.js'
import { schedulerPlugin } from './scheduler.js'
import { telegramPlugin } from './telegram.js'
import { cortexPlugin } from './cortex.js'
import { enginesPlugin } from './engines.js'
import { corsPlugin } from './cors.js'
import { devAgentQuestionRoutes } from '../routes/dev-agent-question.js'
import {
  fakeEnginesEnabled,
  FAKE_LIVENESS_DEPS,
  fakeRunDeviceLogin,
} from '../services/fake-engines.js'

import rateLimit from '@fastify/rate-limit'

export async function registerPlugins(app: FastifyInstance, env: Env): Promise<void> {
  // Achado I3: a ÚNICA combinação segura em produção atrás do Funnel é
  // trustProxy=1 E allowlist vazia — qualquer uma das duas erradas restaura
  // silenciosamente o bug original (peer loopback do tailscaled isento do
  // rate limit, ou rate limit contornável girando X-Forwarded-For). "Setar
  // uma env como vazia" é exatamente o tipo de config que mecanismo de
  // deploy trata de forma inconsistente (var ausente cai no default
  // '127.0.0.1,::1', não em ""), então nada garantia que isto seria notado.
  // Loga em `error` (não `warn`) pra ser impossível de não ver.
  if (env.NODE_ENV === 'production') {
    const allowlist = parseRateLimitAllowList(env.GITORCH_RATE_LIMIT_ALLOWLIST)
    if (allowlist.length > 0 || !env.GITORCH_TRUST_PROXY) {
      app.log.error(
        `[boot] Config de rate limit INSEGURA em produção: GITORCH_TRUST_PROXY=${env.GITORCH_TRUST_PROXY} GITORCH_RATE_LIMIT_ALLOWLIST=${JSON.stringify(allowlist)} — sem trustProxy=1 E allowlist vazia, o rate limit (incluindo o limitador de brute-force do login) fica contornável ou isenta todo tráfego do Funnel. Configure GITORCH_TRUST_PROXY=1 e GITORCH_RATE_LIMIT_ALLOWLIST= (vazio) no ambiente de produção.`
      )
    }
  }

  await app.register(securityHookPlugin)
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })

  await app.register(corsPlugin)

  // Sessão do wizard via cookie httpOnly (não mais token em ?query/localStorage).
  await app.register(fastifyCookie)

  if (env.NODE_ENV !== 'test') {
    // Limiares realistas para o control plane (Node + Prisma + Fastify já usam
    // ~160MB de baseline). Os valores antigos (heap 100MB / RSS 200MB) eram
    // menores que o próprio baseline, então o under-pressure devolvia 503 na API
    // inteira ao menor respiro. Teto do cgroup do serviço é 3G. Overridável por
    // env para ajuste em produção sem novo deploy.
    await app.register(fastifyUnderPressure, {
      maxEventLoopDelay: Number(process.env['GITORCH_MAX_EVENT_LOOP_DELAY_MS'] ?? 2000),
      maxHeapUsedBytes: Number(process.env['GITORCH_MAX_HEAP_BYTES'] ?? 1_200 * 1024 * 1024),
      maxRssBytes: Number(process.env['GITORCH_MAX_RSS_BYTES'] ?? 2_000 * 1024 * 1024),
      maxEventLoopUtilization: 0.98,
    })
  }

  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: 'GitOrch Control Plane API',
        description: 'API for GitOrch - AI-powered GitHub workflow orchestration',
        version: '0.1.0',
      },
      servers: [{ url: API_PREFIX, description: 'API Base Path' }],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
          },
        },
      },
    },
  })

  await app.register(fastifySwaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
    },
    staticCSP: true,
  })

  // Register custom plugins
  await app.register(telemetryPlugin)
  await app.register(prismaPlugin)
  await app.register(redisPlugin)

  // Register rate limit before auth to protect auth hooks from DoS
  // Using preHandler hook ensures wingId context is established for multi-tenant limits
  const rateLimitAllowList = parseRateLimitAllowList(env.GITORCH_RATE_LIMIT_ALLOWLIST)
  await app.register(rateLimit, {
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW_MS,
    hook: 'preHandler',
    keyGenerator: (request) => {
      const ip = request.ip
      const wingId = request.wingId
      return wingId ? `wing:${wingId}` : `ip:${ip}`
    },
    addHeaders: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
    },
    // Função, não array (achado descoberto ao escrever o teste de seam do
    // achado M2): @fastify/rate-limit compara um `allowList` array contra a
    // CHAVE pós-keyGenerator (`ip:<ip>` ou `wing:<wingId>`, ver acima), não
    // contra `request.ip` cru — um array de IPs crus (o que
    // GITORCH_RATE_LIMIT_ALLOWLIST documenta e parseRateLimitAllowList
    // produz) NUNCA batia com isso, deixando a allowlist permanentemente
    // inerte em QUALQUER ambiente desde que o keyGenerator por
    // wingId/sessão entrou (Task F2.1.1). Uma função ignora a chave e
    // compara sempre contra o IP resolvido de verdade.
    allowList: (request) => rateLimitAllowList.includes(request.ip),
  })

  await app.register(authPlugin)
  await app.register(ssePlugin)
  await app.register(webhookVerifyPlugin)
  await app.register(cortexPlugin)

  // GITORCH_FAKE_ENGINES=1 (nunca em produção — fakeEnginesEnabled() já
  // recusa NODE_ENV=production): troca o login assistido e a liveness dos 3
  // motores por fakes determinísticos no boot. Existe só para o E2E do funil
  // completo (tests/e2e/setup-wizard-funil-completo-fake.spec.ts) provar o
  // wizard inteiro em todo PR sem podman/CLIs reais/credenciais de provider —
  // ver services/fake-engines.ts.
  if (fakeEnginesEnabled()) {
    app.log.warn(
      '[boot] GITORCH_FAKE_ENGINES=1: login assistido e liveness dos motores são FAKES determinísticos — nunca use isto em produção'
    )
  }
  await app.register(
    enginesPlugin,
    fakeEnginesEnabled()
      ? { runDeviceLoginImpl: fakeRunDeviceLogin, livenessDeps: FAKE_LIVENESS_DEPS }
      : {}
  )
  await app.register(schedulerPlugin)
  // Ouve o bot do Telegram: é por aqui que o `/start <token>` do cliente vira o
  // chat_id vinculado — sem isto o passo 8 do wizard nunca sai de "aguardando".
  // Decora `app.agentQuestionService` (notify + Cortex ligados) — precisa vir
  // ANTES da rota de dev abaixo, que reusa essa MESMA instância.
  await app.register(telegramPlugin)

  // Rota de DEV isolada (W3.5.1 — Prova real): dispara a dúvida real das
  // cores oficiais pra provar o loop human-in-the-loop no gate do dono.
  // Desligada por padrão (flag GITORCH_DEV_ROUTES, não NODE_ENV — o ambiente
  // dev deployado roda NODE_ENV=production). Arquivo isolado em
  // routes/dev-agent-question.ts pra não conflitar com routes/setup.ts.
  await app.register(devAgentQuestionRoutes)
}
