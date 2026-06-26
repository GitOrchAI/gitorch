import { vi } from 'vitest'

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
