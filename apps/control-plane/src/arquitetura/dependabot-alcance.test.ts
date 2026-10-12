import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

// Importar a peça não prova que ela é alcançada: o ramo expresso do Dependabot
// já era importado pelo vigia e mesmo assim nunca rodava, porque o laço
// descartava o PR antes da decisão. Aqui o caminho é percorrido de verdade:
// do laço do vigia, com a listagem real e um GitHub falso, até
// `decidirMergeDoDependabot`.

const decidirMergeDoDependabotEspiao = vi.hoisted(() => vi.fn())

vi.mock('../services/dependabot-auto-merge.js', async (importarOriginal) => {
  const original = await importarOriginal<typeof import('../services/dependabot-auto-merge.js')>()
  decidirMergeDoDependabotEspiao.mockImplementation(original.decidirMergeDoDependabot)
  return { ...original, decidirMergeDoDependabot: decidirMergeDoDependabotEspiao }
})

const { listarPrsAbertosParaOVigia, vigiarPrsOrfaos } = await import('../services/vigia-do-pr.js')
const { decidirDependabotDoVigia } = await import('../services/dependabot-expresso.js')

const CI_VERDE = { check_runs: [{ status: 'completed', conclusion: 'success' }] }
const SEM_WORKFLOW_RODANDO = { workflow_runs: [{ status: 'completed', conclusion: 'success' }] }

function githubFalso() {
  const ghSend = vi.fn(async (): Promise<unknown> => ({}))
  const ghGet = async (caminho: string): Promise<unknown> => {
    if (caminho.startsWith('/repos/org/repo/pulls?state=open')) {
      return [
        {
          number: 403,
          title: 'Bump lodash from 4.17.20 to 4.17.21',
          user: { login: 'dependabot[bot]' },
          labels: [{ name: 'dependencies' }],
          body: 'Bumps lodash.',
          head: { sha: 'sha-dep', ref: 'dependabot/npm/lodash', repo: { full_name: 'org/repo' } },
        },
      ]
    }
    if (caminho === '/repos/org/repo/pulls/403') {
      return {
        number: 403,
        state: 'open',
        title: 'Bump lodash from 4.17.20 to 4.17.21',
        user: { login: 'dependabot[bot]' },
        body: 'Bumps lodash.',
        head: { sha: 'sha-dep', ref: 'dependabot/npm/lodash' },
        base: { ref: 'main' },
        mergeable: true,
      }
    }
    if (caminho === '/repos/org/repo') return { default_branch: 'main' }
    if (caminho.includes('/check-runs')) return CI_VERDE
    if (caminho.startsWith('/repos/org/repo/actions/runs')) return SEM_WORKFLOW_RODANDO
    return null
  }
  return { ghGet, ghSend }
}

describe('o PR do Dependabot ALCANÇA a decisão expressa a partir do laço do vigia', () => {
  it('vigiarPrsOrfaos → decidirDependabot → decidirMergeDoDependabot → merge', async () => {
    const { ghGet, ghSend } = githubFalso()
    const efeitosDoVigia: string[] = []
    decidirMergeDoDependabotEspiao.mockClear()

    const resumo = await vigiarPrsOrfaos({
      listarPrsAbertos: () =>
        listarPrsAbertosParaOVigia({
          repo: 'org/repo',
          ghGet,
          prsComSessaoViva: new Set<number>(),
          agora: new Date('2026-10-12T12:00:00Z'),
          onWarn: () => undefined,
        }),
      prsComSessaoViva: new Set<number>(),
      issueDoPr: () => null,
      issueAberta: async () => true,
      acoesAnteriores: async () => 0,
      tarefaJaDevolvidaAFila: async () => false,
      vagasLivres: 10,
      pedirJulgamento: async () => {
        efeitosDoVigia.push('julgamento')
      },
      abrirSessaoDeConserto: async () => {
        efeitosDoVigia.push('sessão')
        return true
      },
      fecharPr: async () => {
        efeitosDoVigia.push('fechou')
        return true
      },
      avisarDono: async () => {
        efeitosDoVigia.push('avisou')
        return true
      },
      registrarDecisao: async () => {
        efeitosDoVigia.push('decisão')
      },
      decidirDependabot: (pr) =>
        decidirDependabotDoVigia({
          runtimeConfig: { cuidaPorOrigem: { dependabot: 'sim' } },
          agora: new Date('2026-10-12T12:00:00Z'),
          projeto: { id: 'proj-1', wingId: 'org/repo' },
          token: 'tok',
          numero: pr.numero,
          ghGet,
          ghSend,
          registrarNoPainel: async () => undefined,
          prisma: {} as never,
          onWarn: () => undefined,
        }),
    })

    expect(decidirMergeDoDependabotEspiao).toHaveBeenCalledTimes(1)
    expect(decidirMergeDoDependabotEspiao.mock.calls[0]?.[0]).toMatchObject({
      politica: 'sim',
      verificacao: 'verde',
      mergeable: true,
    })
    expect(ghSend).toHaveBeenCalledWith(
      'PUT',
      '/repos/org/repo/pulls/403/merge',
      'tok',
      expect.objectContaining({ sha: 'sha-dep' })
    )
    // O vigia em si não fez nada com o Dependabot: nem sessão, nem fechamento.
    expect(efeitosDoVigia).toEqual([])
    expect(resumo).toContain('1 do dependabot')
  })

  it('o relógio do scheduler injeta a decisão expressa no vigia', () => {
    const raiz = join(dirname(fileURLToPath(import.meta.url)), '..')
    const texto = readFileSync(join(raiz, 'plugins', 'scheduler.ts'), 'utf-8')
    const fonte = ts.createSourceFile('scheduler.ts', texto, ts.ScriptTarget.ES2022, true)
    let propriedadeInjetada = false
    let chamaADecisao = false
    const visitar = (no: ts.Node): void => {
      if (
        ts.isPropertyAssignment(no) &&
        ts.isIdentifier(no.name) &&
        no.name.text === 'decidirDependabot'
      ) {
        propriedadeInjetada = true
      }
      if (
        ts.isCallExpression(no) &&
        ts.isIdentifier(no.expression) &&
        no.expression.text === 'decidirDependabotDoVigia'
      ) {
        chamaADecisao = true
      }
      ts.forEachChild(no, visitar)
    }
    visitar(fonte)
    expect(propriedadeInjetada, 'vigiarPrsOrfaos precisa receber decidirDependabot').toBe(true)
    expect(chamaADecisao, 'o scheduler precisa chamar decidirDependabotDoVigia').toBe(true)
  })
})
