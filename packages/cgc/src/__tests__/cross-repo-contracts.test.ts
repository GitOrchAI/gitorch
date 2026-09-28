import { describe, it, expect, beforeEach, vi } from 'vitest'
import { join } from 'path'
import * as fs from 'fs'
import { summarizeWorkspace } from '../summarize-workspace'

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    readdirSync: vi.fn(),
    statSync: vi.fn(),
    readFileSync: vi.fn(),
  }
})

describe('cross-repo contracts', () => {
  const MOCK_WORKSPACE_PATH = '/mock/workspace'

  beforeEach(() => {
    vi.resetAllMocks()

    // Mock readdirSync
    const mockedReaddirSync = fs.readdirSync as import('vitest').Mock
    mockedReaddirSync.mockImplementation((dirPath: string) => {
      if (dirPath === MOCK_WORKSPACE_PATH) {
        return ['frontend', 'backend', 'db']
      }
      if (dirPath === join(MOCK_WORKSPACE_PATH, 'frontend')) {
        return ['api.ts']
      }
      if (dirPath === join(MOCK_WORKSPACE_PATH, 'backend')) {
        return ['routes.ts', 'db-usage.ts']
      }
      if (dirPath === join(MOCK_WORKSPACE_PATH, 'db')) {
        return ['schema.prisma']
      }
      return []
    })

    // Mock statSync
    const mockedStatSync = fs.statSync as import('vitest').Mock
    mockedStatSync.mockImplementation((filePath: string) => {
      return {
        isDirectory: () => {
          return (
            filePath.endsWith('frontend') || filePath.endsWith('backend') || filePath.endsWith('db')
          )
        },
        isFile: () => {
          return (
            filePath.endsWith('.ts') || filePath.endsWith('.prisma') || filePath.endsWith('.sql')
          )
        },
        size: 100,
      }
    })

    // Mock readFileSync
    const mockedReadFileSync = fs.readFileSync as import('vitest').Mock
    mockedReadFileSync.mockImplementation((filePath: string) => {
      if (filePath.endsWith('frontend/api.ts')) {
        return `
          async function getUser() {
            const res = await fetch('/api/users')
            return res.json()
          }

          async function createUser() {
            return axios.post('/api/users', { name: 'Test' })
          }
        `
      }
      if (filePath.endsWith('backend/routes.ts')) {
        return `
          import { app } from 'express'

          app.get('/api/users', (req, res) => {
            res.send([])
          })

          @Post('/api/users')
          create(req, res) {
            res.send('ok')
          }
        `
      }
      if (filePath.endsWith('backend/db-usage.ts')) {
        return `
          import { prisma } from './db'

          async function test() {
            const users = await prisma.user.findMany()
            const posts = await prisma.post.findFirst()
          }
        `
      }
      if (filePath.endsWith('db/schema.prisma')) {
        return `
          generator client {
            provider = "prisma-client-js"
          }

          model User {
            id Int @id @default(autoincrement())
            name String
          }

          model Post {
            id Int @id @default(autoincrement())
            title String
          }
        `
      }
      return ''
    })
  })

  it('identifies cross-repo HTTP calls and DB model references', async () => {
    const summary = await summarizeWorkspace(MOCK_WORKSPACE_PATH, {
      maxFiles: 10,
    })

    // fetch is matched with ANY method, so it can match both GET and POST.
    // axios.post matches POST
    expect(summary).toContain(
      '- Shared routes (cross-repo API calls): GET /api/users (frontend/api.ts -> backend/routes.ts), POST /api/users (frontend/api.ts -> backend/routes.ts), POST /api/users (frontend/api.ts -> backend/routes.ts)'
    )
    expect(summary).toContain(
      '- Shared models (database entities): User (backend/db-usage.ts -> db/schema.prisma), Post (backend/db-usage.ts -> db/schema.prisma)'
    )
  })
})
