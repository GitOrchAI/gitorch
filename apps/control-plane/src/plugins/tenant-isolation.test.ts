import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tenantContext, applyTenantScope } from './prisma.js'
import type { Prisma } from '@prisma/client'

/**
 * O isolamento entre clientes é a garantia mais importante do control-plane:
 * um cliente NUNCA pode ler/alterar dado de outro. Antes destes testes o guard
 * existia mas era INERTE — o AsyncLocalStorage era aberto com um callback vazio
 * (`ctx.run(store, () => {})`), então o contexto morria antes do handler rodar e
 * `getStore()` devolvia undefined em toda rota. O guard parecia proteger e não
 * protegia nada.
 */
describe('isolamento por tenant (guard do Prisma)', () => {
  const params = (over: Partial<Prisma.MiddlewareParams>): Prisma.MiddlewareParams =>
    ({
      model: 'Project',
      action: 'findMany',
      args: {},
      dataPath: [],
      runInTransaction: false,
      ...over,
    }) as Prisma.MiddlewareParams

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('sem contexto de tenant, não injeta escopo (scheduler/webhook rodam fora de request)', () => {
    const p = params({ action: 'findMany', args: {} })
    applyTenantScope(p)
    expect(p.args.where).toBeUndefined()
  })

  it('dentro do contexto, LEITURA de Project é escopada pelo dono', () => {
    tenantContext.run({ userId: 'user_a' }, () => {
      const p = params({ action: 'findMany', args: { where: { isActive: true } } })
      applyTenantScope(p)
      expect(p.args.where).toEqual({ isActive: true, userId: 'user_a' })
    })
  })

  it('dentro do contexto, findFirst de Project de OUTRO dono não escapa do escopo', () => {
    tenantContext.run({ userId: 'user_b' }, () => {
      // usuário B tenta buscar o projeto do usuário A pelo repo (mesmo owner/repo)
      const p = params({ action: 'findFirst', args: { where: { wingId: 'acme/api' } } })
      applyTenantScope(p)
      expect(p.args.where).toEqual({ wingId: 'acme/api', userId: 'user_b' })
    })
  })

  it('dentro do contexto, ESCRITA (update/delete) é escopada pelo dono — mata IDOR', () => {
    tenantContext.run({ userId: 'user_b' }, () => {
      const p = params({ action: 'update', args: { where: { id: 'proj_do_user_a' }, data: {} } })
      applyTenantScope(p)
      expect(p.args.where).toEqual({ id: 'proj_do_user_a', userId: 'user_b' })
    })
  })

  it('não injeta escopo em modelo que não tem coluna userId (ex.: Plan)', () => {
    tenantContext.run({ userId: 'user_a' }, () => {
      const p = params({ model: 'Plan', action: 'findMany', args: {} })
      applyTenantScope(p)
      expect(p.args.where).toBeUndefined()
    })
  })

  it('o contexto sobrevive a await (enterWith/run propagam pela cadeia async)', async () => {
    await tenantContext.run({ userId: 'user_c' }, async () => {
      await new Promise((r) => setTimeout(r, 1))
      const p = params({ action: 'findMany', args: {} })
      applyTenantScope(p)
      expect(p.args.where).toEqual({ userId: 'user_c' })
    })
  })
})
