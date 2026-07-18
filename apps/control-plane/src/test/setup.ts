import { vi } from 'vitest'

// Mock pino
vi.mock('pino', () => ({
  default: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
    })),
  })),
}))

// Mock ioredis with proper constructor
class MockRedis {
  constructor() {}
  connect = vi.fn().mockResolvedValue(undefined)
  quit = vi.fn().mockResolvedValue(undefined)
  on = vi.fn()
  ping = vi.fn().mockResolvedValue('PONG')
}

vi.mock('ioredis', () => ({
  default: MockRedis,
}))

// Mock @prisma/client with proper constructor
class MockPrismaClient {
  $connect = vi.fn().mockResolvedValue(undefined)
  $disconnect = vi.fn().mockResolvedValue(undefined)
  $use = vi.fn()
  $queryRaw = vi.fn().mockResolvedValue([1])
  webhookDelivery = { create: vi.fn() }
  mission = {
    create: vi.fn(),
    count: vi.fn(),
    updateMany: vi.fn(),
    findMany: vi.fn().mockResolvedValue([]),
    update: vi.fn(),
  }
  apiKey = {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  }
  project = {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  }
  user = { findUnique: vi.fn() }
  projectSchedule = {
    findMany: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
    create: vi.fn(),
    updateMany: vi.fn(),
  }
  engineConnection = {
    findUnique: vi.fn(),
    findMany: vi.fn().mockResolvedValue([]),
    upsert: vi.fn(),
    updateMany: vi.fn(),
  }
  clientEnvironment = {
    findFirst: vi.fn().mockResolvedValue(null),
    findUnique: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue({ id: 'env_test', status: 'provisional', path: '' }),
    update: vi.fn().mockResolvedValue({}),
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    delete: vi.fn().mockResolvedValue({}),
  }
}

// Mesma forma de PrismaClientKnownRequestError (code/meta), só sem a
// inicialização pesada da real — suficiente para o `instanceof` que o
// tratamento de colisão de constraint única (auth.ts) precisa checar.
class MockPrismaClientKnownRequestError extends Error {
  code: string
  meta: Record<string, unknown> | undefined
  constructor(message: string, opts: { code: string; meta?: Record<string, unknown> }) {
    super(message)
    this.code = opts.code
    this.meta = opts.meta
  }
}

vi.mock('@prisma/client', () => ({
  PrismaClient: MockPrismaClient,
  // O guard de isolamento deriva do DMMF quais modelos carregam `userId` (o
  // dono) e quais carregam `wingId` (o repositório) — este mock espelha o
  // schema real. Ele estava desatualizado (só listava wingId), o que mantinha
  // o escopo por dono invisível para os testes.
  Prisma: {
    dmmf: {
      datamodel: {
        models: [
          { name: 'Project', fields: [{ name: 'wingId' }, { name: 'userId' }] },
          { name: 'EngineConnection', fields: [{ name: 'userId' }] },
          { name: 'ClientEnvironment', fields: [{ name: 'userId' }] },
          { name: 'DiagnosisJob', fields: [{ name: 'userId' }] },
          { name: 'Subscription', fields: [{ name: 'userId' }] },
          { name: 'Mission', fields: [{ name: 'id' }] },
          { name: 'WebhookDelivery', fields: [{ name: 'id' }] },
          { name: 'Plan', fields: [{ name: 'id' }] },
        ],
      },
    },
    PrismaClientKnownRequestError: MockPrismaClientKnownRequestError,
  },
}))

// Mock @gitorch/github-sync
class MockGitHubWebhookVerifier {
  verify = vi.fn((payload: string, signature: string) => {
    const crypto = require('crypto')
    const expected =
      'sha256=' + crypto.createHmac('sha256', 'test-secret').update(payload).digest('hex')
    return signature === expected
  })
}

class MockGitHubWebhookNormalizer {
  normalize = vi.fn().mockReturnValue({})
}

class MockGitHubSyncEngine {
  ingest = vi.fn().mockReturnValue({ accepted: true })
}

vi.mock('@gitorch/github-sync', async (importOriginal) => ({
  // Mantém os exports reais (ex.: ProjectV2Client, usado pelos rails) e
  // sobrescreve apenas as classes de webhook/sync que os testes simulam.
  ...(await importOriginal<typeof import('@gitorch/github-sync')>()),
  GitHubWebhookVerifier: MockGitHubWebhookVerifier,
  GitHubWebhookNormalizer: MockGitHubWebhookNormalizer,
  GitHubSyncEngine: MockGitHubSyncEngine,
}))

// Mock @opentelemetry/sdk-metrics
class MockMeterProvider {
  addMetricReader = vi.fn()
}

vi.mock('@opentelemetry/sdk-metrics', () => ({
  MeterProvider: MockMeterProvider,
}))

// Mock @opentelemetry/exporter-prometheus
class MockPrometheusExporter {
  metrics = vi.fn().mockResolvedValue('')
  constructor() {}
}

vi.mock('@opentelemetry/exporter-prometheus', () => ({
  PrometheusExporter: MockPrometheusExporter,
}))

// Mock @opentelemetry/api
vi.mock('@opentelemetry/api', () => ({
  metrics: {
    getMeter: vi.fn(() => ({
      createCounter: vi.fn(() => ({ add: vi.fn() })),
      createHistogram: vi.fn(() => ({ record: vi.fn() })),
      createGauge: vi.fn(() => ({ add: vi.fn(), set: vi.fn() })),
    })),
    setGlobalMeterProvider: vi.fn(),
  },
  Counter: vi.fn(),
  Histogram: vi.fn(),
  Gauge: vi.fn(),
}))

// Mock @opentelemetry/resources
vi.mock('@opentelemetry/resources', () => ({
  Resource: vi.fn(() => ({})),
}))

// Mock @opentelemetry/semantic-conventions
vi.mock('@opentelemetry/semantic-conventions', () => ({
  SemanticResourceAttributes: {
    SERVICE_NAME: 'service.name',
  },
}))

const testEnv: Record<string, string> = {
  NODE_ENV: 'test',
  PORT: '4000',
  HOST: '0.0.0.0',
  DATABASE_URL: 'postgresql://test:***@localhost:5432/test',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'test-secret-key-that-is-at-least-32-characters-long',
  JWT_EXPIRES_IN: '7d',
  JWT_REFRESH_EXPIRES_IN: '30d',
  LOG_LEVEL: 'silent',
  LOG_PRETTY: 'false',
  CORS_ORIGIN: '*',
  RATE_LIMIT_MAX: '100',
  RATE_LIMIT_WINDOW_MS: '60000',
  OTEL_SERVICE_NAME: 'gitorch-control-plane-test',
  PROMETHEUS_PORT: '9464',
  GITHUB_WEBHOOK_SECRET: 'test-secret',
  SSE_HEARTBEAT_INTERVAL_MS: '30000',
}

Object.entries(testEnv).forEach(([key, value]) => {
  process.env[key] = value
})

global.console = {
  ...console,
  log: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}
