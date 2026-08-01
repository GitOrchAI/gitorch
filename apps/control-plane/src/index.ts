import Fastify, { FastifyInstance } from 'fastify'
import { loadEnv } from './config/env.js'
import { registerPlugins } from './plugins/index.js'
import { registerRoutes } from './routes/index.js'
import { webStaticPlugin } from './plugins/web-static.js'

async function buildApp(): Promise<FastifyInstance> {
  const env = loadEnv()

  const app = Fastify({
    trustProxy: env.GITORCH_TRUST_PROXY,
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

start()
