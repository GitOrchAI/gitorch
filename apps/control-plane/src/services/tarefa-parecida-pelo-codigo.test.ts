import { describe, it, expect, vi } from 'vitest'
import { racharTarefaParecidaPeloCodigo } from './tarefa-parecida-pelo-codigo.js'

describe('racharTarefaParecidaPeloCodigo', () => {
  it('devolve o formulário que o executor do RA produziu', async () => {
    const execute = vi.fn(async () =>
      JSON.stringify({
        issueNumberEncontrado: 88,
        justificativa:
          'o diff mexe em services/pagamento.ts, e a issue #88 pede exatamente essa mudança',
      })
    )
    const resultado = await racharTarefaParecidaPeloCodigo({
      numeroDoPr: 7,
      repository: 'dono/repo',
      diffResumo: 'services/pagamento.ts: +12 -3',
      contextBlocks: ['contexto do codegraph'],
      execute,
    })
    expect(resultado.issueNumberEncontrado).toBe(88)
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('sem tarefa parecida: issueNumberEncontrado null, com justificativa honesta', async () => {
    const execute = vi.fn(async () =>
      JSON.stringify({
        issueNumberEncontrado: null,
        justificativa: 'nenhuma issue aberta descreve esta mudança',
      })
    )
    const resultado = await racharTarefaParecidaPeloCodigo({
      numeroDoPr: 7,
      repository: 'dono/repo',
      diffResumo: 'x',
      contextBlocks: [],
      execute,
    })
    expect(resultado.issueNumberEncontrado).toBeNull()
  })
})
