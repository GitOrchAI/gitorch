import { describe, it, expect } from 'vitest'

describe('Environment Configuration', () => {
  it('should have test environment setup', () => {
    expect(process.env['NODE_ENV']).toBe('test')
    expect(process.env['PORT']).toBe('4000')
  })

  it('should have required environment variables', () => {
    expect(process.env['DATABASE_URL']).toBeDefined()
    expect(process.env['REDIS_URL']).toBeDefined()
    expect(process.env['JWT_SECRET']).toBeDefined()
  })
})

describe('Basic arithmetic', () => {
  it('should add numbers correctly', () => {
    expect(1 + 1).toBe(2)
  })
})
