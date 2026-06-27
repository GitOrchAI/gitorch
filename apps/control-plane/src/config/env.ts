import { z } from 'zod'

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4000),
  HOST: z.string().default('0.0.0.0'),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default('7d'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('30d'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: z.coerce.boolean().default(false),

  CORS_ORIGIN: z.string().default('*'),
  RATE_LIMIT_MAX: z.coerce.number().default(100),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60000),

  OTEL_SERVICE_NAME: z.string().default('gitorch-control-plane'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  PROMETHEUS_PORT: z.coerce.number().default(9464),

  GITHUB_APP_ID: z.string().optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),
})

export type Env = z.infer<typeof envSchema>

let cachedEnv: Env | null = null

export function getEnv(): Env {
  if (cachedEnv) return cachedEnv

  const result = envSchema.safeParse(process.env)
  if (!result.success) {
    console.error('❌ Invalid environment variables:', result.error.flatten().fieldErrors)
    process.exit(1)
  }

  cachedEnv = result.data
  return cachedEnv
}

export function resetEnvCache(): void {
  cachedEnv = null
}

export function loadEnv(): Env {
  return getEnv()
}
