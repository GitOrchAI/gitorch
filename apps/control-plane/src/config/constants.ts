export const APP_NAME = 'gitorch-control-plane'
export const API_VERSION = 'v1'
export const API_PREFIX = `/api/${API_VERSION}`

export const HEALTH_CHECK_PATH = '/health'
export const READINESS_PATH = '/ready'
export const METRICS_PATH = '/metrics'

export const DEFAULT_PAGE_SIZE = 20
export const MAX_PAGE_SIZE = 100

export const JWT_ISSUER = 'gitorch-control-plane'
export const JWT_AUDIENCE = 'gitorch-clients'

export const GITHUB_API_BASE = 'https://api.github.com'
export const GITHUB_WEBHOOK_EVENTS = [
  'push',
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
  'issues',
  'issue_comment',
  'release',
  'workflow_run',
  'check_run',
  'check_suite',
  'deployment',
  'deployment_status',
] as const

export const RATE_LIMIT_DEFAULT_WINDOW_MS = 60_000
export const RATE_LIMIT_DEFAULT_MAX = 100

export const CORS_MAX_AGE = 86400

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

export const NODE_ENVS = ['development', 'production', 'test'] as const
export type NodeEnv = (typeof NODE_ENVS)[number]

export const HEALTH_CHECK_INTERVAL_MS = 30_000
export const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 30_000
