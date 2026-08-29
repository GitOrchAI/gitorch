import { describe, it, expect, vi } from 'vitest'
import {
  montarPromptDeAnalise,
  runAnaliseDeFalha,
  SCHEMA_ANALISE_DE_FALHA,
  type EntradaDaAnalise,
} from './analise-de-falha-do-dev.js'

const entrada: EntradaDaAnalise = {
  issueNumber: 42,
  tituloDaIssue: 'Migrar check_jobs.ts para capturar o log',
  corpoDaIssue:
    'Related Files: scripts/check_jobs.ts\nVerification Criteria: o log vira ci-failure-raw.json',
  sessoesMortas: [
    {
      sessionName: 'sessions/aa',
      estado: 'FAILED',
      ultimaAtividade: 'não achei o arquivo scripts/check_jobs.ts',
    },
    {
      sessionName: 'sessions/bb',
      estado: 'COMPLETED',
      ultimaAtividade: 'abri PR mas o CI ficou vermelho no lint',
    },
  ],
  comentariosDeQa: ['@jules o PR precisa passar o lint antes de aprovar'],
}

describe('montarPromptDeAnalise', () => {
  it('inclui o corpo da issue, as 2 sessões mortas e as 4 perguntas numeradas', () => {
    const p = montarPromptDeAnalise(entrada)
    expect(p).toContain('#42')
    expect(p).toContain('scripts/check_jobs.ts')
    expect(p).toContain('não achei o arquivo')
    expect(p).toContain('CI ficou vermelho no lint')
    expect(p).toContain('QA rework comment 1')
    expect(p).toContain('1. causaComum')
    expect(p).toContain('2. faltouNaIssue')
    expect(p).toContain('3. pedidoRevisado')
    expect(p).toContain('4. padraoDoJules')
  })

  it('sem comentários de QA, diz que não há', () => {
    const p = montarPromptDeAnalise({ ...entrada, comentariosDeQa: [] })
    expect(p).toContain('(no QA rework comments)')
  })
})

describe('SCHEMA_ANALISE_DE_FALHA', () => {
  it('exige os 4 campos', () => {
    expect(SCHEMA_ANALISE_DE_FALHA.required).toEqual([
      'causaComum',
      'faltouNaIssue',
      'pedidoRevisado',
      'padraoDoJules',
    ])
  })
})

describe('runAnaliseDeFalha', () => {
  it('roda o passo de formulário e devolve a análise', async () => {
    const execute = vi.fn(async () =>
      JSON.stringify({
        causaComum: 'as duas não leram o caminho certo do arquivo',
        faltouNaIssue: 'o caminho real é .github/scripts/check_jobs.ts, não scripts/',
        pedidoRevisado:
          'ATENÇÃO: o arquivo é .github/scripts/check_jobs.ts. Rode `pnpm lint` antes de abrir o PR.',
        padraoDoJules:
          'issues deste repo precisam do caminho completo do arquivo e do comando de lint no corpo',
      })
    )
    const r = await runAnaliseDeFalha(execute, entrada)
    expect(execute).toHaveBeenCalledOnce()
    expect(r.pedidoRevisado).toContain('.github/scripts/check_jobs.ts')
    expect(r.padraoDoJules).toContain('caminho completo')
  })
})
