import Fastify, { FastifyInstance } from 'fastify'
import { loadEnv } from './config/env.js'
import { registerPlugins } from './plugins/index.js'
import { registerRoutes } from './routes/index.js'
import { webStaticPlugin } from './plugins/web-static.js'

export async function buildApp(): Promise<FastifyInstance> {
  const env = loadEnv()

  const app = Fastify({
    // Confiar em EXATAMENTE 1 hop (não `true`/qualquer hop — achado I1):
    // `trustProxy: true` confia em TODO hop da cadeia X-Forwarded-For, e
    // `request.ip` vira a entrada MAIS À ESQUERDA — a que o próprio cliente
    // escreve. Isso deixa (a) qualquer requisição que chegue à porta da API
    // sem passar pelo Funnel (outro processo na mesma VM compartilhada,
    // qualquer peer da tailnet) escapar do rate limit girando o header, e
    // (b) `X-Forwarded-For: 127.0.0.1` cair na allowlist padrão e ficar
    // isento — derrubando também o limitador de brute-force do login, que
    // esta branch passou a depender de `request.ip`. Com `1`, `request.ip` é
    // a ÚLTIMA entrada da cadeia — a que o PRÓPRIO PROXY (o Funnel) anexou —
    // e qualquer prefixo que o cliente injete no header é ignorado.
    trustProxy: env.GITORCH_TRUST_PROXY ? 1 : false,
    logger: env.LOG_PRETTY
      ? {
          level: env.LOG_LEVEL,
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss Z' },
          },
        }
      : { level: env.LOG_LEVEL },
    ajv: {
      customOptions: { strict: true, coerceTypes: 'array' },
    },
  })

  await registerPlugins(app, env)
  await registerRoutes(app)
  // Depois das rotas de API: serve o wizard estático na MESMA origem (rotas
  // exatas de /api já registradas têm precedência sobre o wildcard do estático).
  await app.register(webStaticPlugin)

  return app
}

async function start(): Promise<void> {
  const env = loadEnv()
  const app = await buildApp()

  try {
    await app.listen({ port: env.PORT, host: env.HOST })
    app.log.info(`Server listening on ${env.HOST}:${env.PORT}`)
    app.log.info(`Documentation available at http://${env.HOST}:${env.PORT}/docs`)
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`${signal} received, shutting down gracefully...`)
    await app.close()
    process.exit(0)
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

// Guarda de entrypoint (achado M2): só sobe o servidor de verdade quando
// este arquivo é executado DIRETAMENTE (tsx/node em src|dist/index.*) —
// nunca quando é só IMPORTADO (ex.: um teste de seam real chamando
// buildApp() pra provar o wiring de trustProxy/allowList sem reimplementá-lo
// à parte). Sem isto, importar este módulo já dispara `start()` como efeito
// colateral: tenta ouvir porta e conectar Postgres/Redis reais dentro da
// suíte de teste.
const isMainModule =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`
if (isMainModule) {
  start()
}
