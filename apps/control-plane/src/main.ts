import Fastify, { FastifyInstance } from 'fastify'
import { getEnv } from './config/env.js'
import { registerPlugins } from './plugins/index.js'
import { registerRoutes } from './routes/index.js'
import { HEALTH_CHECK_PATH, READINESS_PATH } from './config/constants.js'

async function buildApp(): Promise<FastifyInstance> {
  const env = getEnv()

  const app = Fastify({
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

  app.get(HEALTH_CHECK_PATH, async () => ({ status: 'ok', timestamp: new Date().toISOString() }))

  app.get(READINESS_PATH, async () => ({ status: 'ready', timestamp: new Date().toISOString() }))

  return app
}

async function start(): Promise<void> {
  const env = getEnv()
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
