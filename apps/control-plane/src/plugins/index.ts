import { FastifyInstance } from 'fastify'
import fastifyCors from '@fastify/cors'
import fastifyHelmet from '@fastify/helmet'
import fastifySwagger from '@fastify/swagger'
import fastifySwaggerUi from '@fastify/swagger-ui'
import fastifyUnderPressure from '@fastify/under-pressure'
import { Env } from '../config/env.js'
import { API_PREFIX, CORS_MAX_AGE } from '../config/constants.js'

import { prismaPlugin } from './prisma.js'
import { redisPlugin } from './redis.js'
import { rateLimitPlugin } from './rate-limit.js'
import { authPlugin } from './auth.js'
import { ssePlugin } from './sse.js'
import { webhookVerifyPlugin } from './webhook-verify.js'
import { securityHookPlugin } from './security.js'
import { telemetryPlugin } from './telemetry.js'

export async function registerPlugins(app: FastifyInstance, env: Env): Promise<void> {
  await app.register(securityHookPlugin)
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })

  await app.register(fastifyCors, {
    origin: env.CORS_ORIGIN === '*' ? true : env.CORS_ORIGIN.split(',').map((o) => o.trim()),
    credentials: true,
    maxAge: CORS_MAX_AGE,
  })

  if (env.NODE_ENV !== 'test') {
    await app.register(fastifyUnderPressure, {
      maxEventLoopDelay: 1000,
      maxHeapUsedBytes: 100 * 1024 * 1024,
      maxRssBytes: 200 * 1024 * 1024,
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
  // Register rate limit before auth to protect against DoS attacks on the auth hook
  await app.register(rateLimitPlugin)
  await app.register(authPlugin)
  await app.register(ssePlugin)
  await app.register(webhookVerifyPlugin)
}
