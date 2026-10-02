import { z } from 'zod'

export const WorkloadProfileSchema = z.object({
  language: z.enum(['typescript', 'javascript', 'python', 'go', 'rust', 'unknown']),
  runtime: z.enum(['node', 'python', 'go', 'cargo', 'unknown']),
  packageManager: z.enum(['pnpm', 'yarn', 'npm', 'unknown']).optional(),
  framework: z.string().optional(), // 'next', 'fastify', 'express', etc.
  hasDatabase: z.boolean(),
  databaseEngine: z.enum(['postgres', 'mysql', 'sqlite', 'mongodb', 'unknown']).optional(),
  orm: z.enum(['prisma', 'drizzle', 'typeorm', 'mongoose', 'unknown']).optional(),
  hasMigrations: z.boolean(),
  isMonorepo: z.boolean(),
  testFramework: z
    .enum(['vitest', 'jest', 'playwright', 'cypress', 'pytest', 'unknown'])
    .optional(),
  dockerfilePresent: z.boolean(),
})
export type WorkloadProfile = z.infer<typeof WorkloadProfileSchema>

export interface RepoFileSnapshot {
  path: string
  content?: string
}

export function profileWorkload(files: RepoFileSnapshot[] | string[]): WorkloadProfile {
  let isMonorepo = false
  let packageManager: WorkloadProfile['packageManager'] = undefined
  let hasDatabase = false
  let orm: WorkloadProfile['orm'] = undefined
  let databaseEngine: WorkloadProfile['databaseEngine'] = undefined
  let framework: WorkloadProfile['framework'] = undefined
  let testFramework: WorkloadProfile['testFramework'] = undefined
  let dockerfilePresent = false
  let language: WorkloadProfile['language'] = 'unknown'
  let runtime: WorkloadProfile['runtime'] = 'unknown'

  for (const file of files) {
    const path = typeof file === 'string' ? file : file.path
    const content = typeof file === 'string' ? '' : file.content || ''

    if (path === 'pnpm-lock.yaml' || path === 'pnpm-workspace.yaml') {
      packageManager = 'pnpm'
      if (path === 'pnpm-workspace.yaml') {
        isMonorepo = true
      }
    }

    if (path === 'yarn.lock') {
      if (!packageManager) packageManager = 'yarn'
    }

    if (path === 'package-lock.json') {
      if (!packageManager) packageManager = 'npm'
    }

    if (path.endsWith('prisma/schema.prisma')) {
      hasDatabase = true
      orm = 'prisma'
      if (content.includes('provider = "postgresql"')) {
        databaseEngine = 'postgres'
      } else if (content.includes('provider = "mysql"')) {
        databaseEngine = 'mysql'
      } else if (content.includes('provider = "sqlite"')) {
        databaseEngine = 'sqlite'
      }
    }

    if (path.endsWith('package.json')) {
      language = 'typescript'
      runtime = 'node'
      if (content) {
        if (content.includes('"next"')) {
          framework = 'next'
        } else if (content.includes('"fastify"')) {
          framework = 'fastify'
        }

        if (content.includes('"vitest"')) {
          testFramework = 'vitest'
        }
      }
    }

    if (path.endsWith('vitest.config.ts')) {
      testFramework = 'vitest'
    }

    if (path === 'Dockerfile' || path.endsWith('/Dockerfile')) {
      dockerfilePresent = true
    }
  }

  // Fallbacks for language and runtime if not detected
  if (packageManager === 'pnpm' || packageManager === 'npm' || packageManager === 'yarn') {
    if (language === 'unknown') language = 'typescript'
    if (runtime === 'unknown') runtime = 'node'
  }

  return {
    language,
    runtime,
    packageManager: packageManager as WorkloadProfile['packageManager'],
    framework,
    hasDatabase,
    databaseEngine: databaseEngine as WorkloadProfile['databaseEngine'],
    orm: orm as WorkloadProfile['orm'],
    hasMigrations: false, // Default or specific detection
    isMonorepo,
    testFramework: testFramework as WorkloadProfile['testFramework'],
    dockerfilePresent,
  }
}
