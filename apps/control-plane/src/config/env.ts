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
  // Produção atrás do Tailscale Funnel: o proxy injeta X-Forwarded-For; sem
  // trustProxy o request.ip é o loopback do tailscaled e o rate limit colapsa
  // (P1-1). Ligar SÓ quando há proxy confiável na frente.
  //
  // z.coerce.boolean() faz Boolean(string) — "0"/"false"/"no" TODOS viram
  // `true` (só "" vira false); um operador desligando com =0 conseguiria o
  // OPOSTO do que pediu (achado I2). Preprocess compara a string CRUA contra
  // '1': só esse valor explícito liga, qualquer outra coisa (ausente, vazio,
  // espaço, '0', 'false') fica off — mesma convenção que o resto desta
  // branch já usa pra flag booleana por env (pipelineCheckEnabled em
  // config/pipeline-check.ts compara `=== '1'`; resolveMissionCpus em
  // config/mission-cpus.ts valida explicitamente em vez de confiar em
  // coerção implícita).
  GITORCH_TRUST_PROXY: z.preprocess((v) => v === '1', z.boolean()),
  // CSV de IPs isentos de rate limit. Default VAZIO (achado FW-2): antes o
  // default era '127.0.0.1,::1' — inofensivo enquanto a comparação da
  // allowlist estava quebrada (o bug corrigido na rodada anterior), mas
  // agora que ela funciona de verdade, QUALQUER ambiente que não declare
  // esta env explicitamente isenta o loopback de verdade. Atrás de um proxy
  // local com trust-proxy desligado — a forma do staging, alcançado por rede
  // privada — `request.ip` é SEMPRE o loopback do próprio proxy pra TODO
  // tráfego, então um default não-vazio zera o rate limit inteiro no
  // próximo deploy, sem aviso nenhum (o check de má-configuração em
  // plugins/index.ts só roda com NODE_ENV=production, staging não bate
  // nisso). Isenção agora é OPT-IN (setar a env), nunca opt-out (teria que
  // lembrar de zerar em todo ambiente nunca-produção). Dev local que precise
  // do loopback isento documenta isso em .env.example.
  GITORCH_RATE_LIMIT_ALLOWLIST: z.string().default(''),

  OTEL_SERVICE_NAME: z.string().default('gitorch-control-plane'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  PROMETHEUS_PORT: z.coerce.number().default(9464),

  GITHUB_APP_ID: z.string().optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),
  // Slug público do GitHub App (a parte depois de github.com/apps/) — usado
  // para montar o link de instalação (routes/github-app-install.ts). É
  // diferente do GITHUB_APP_ID (numérico, usado para assinar o JWT do App).
  GITHUB_APP_SLUG: z.string().optional(),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  FRONTEND_URL: z.string().url().default('http://localhost:3000'),
  // Base pública da API para o redirect_uri do OAuth (produção/funnel). Sem
  // ela, deriva do request — que em dev preserva a porta via request.host.
  GITORCH_PUBLIC_URL: z.string().url().optional(),
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
