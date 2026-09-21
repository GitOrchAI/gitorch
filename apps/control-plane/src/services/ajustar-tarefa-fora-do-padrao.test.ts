import { describe, it, expect, vi } from 'vitest'
import { ajustarTarefaForaDoPadrao } from './ajustar-tarefa-fora-do-padrao.js'

describe('ajustarTarefaForaDoPadrao', () => {
  it('devolve os 8 campos reescritos pelo PO', async () => {
    const execute = vi.fn(async () =>
      JSON.stringify({
        fields: {
          titulo: 'Corrigir cache de sessão',
          goal: 'g',
          taskDetails: 'd',
          taskDescription: 'd',
          implementationGuide: 'i',
          verificationCriteria: 'v',
          dependencies: 'x',
          relatedFiles: 'src/x.ts',
          notes: 'n',
        },
      })
    )
    const resultado = await ajustarTarefaForaDoPadrao({
      issueNumber: 88,
      repository: 'dono/repo',
      tituloOriginal: 'ajustar algo',
      corpoOriginal: 'texto solto sem seções',
      conferencia: {
        padraoOk: false,
        erros: ['titulo: empty', 'goal: empty'],
        peso: null,
        noQuadro: true,
        naSprint: true,
      },
      contextBlocks: [],
      execute,
    })
    expect('fields' in resultado && resultado.fields.titulo).toBe('Corrigir cache de sessão')
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('devolve o erro tratado se a validacao falhar', async () => {
    const execute = vi.fn(async () => 'lixo-que-nao-e-json')
    const resultado = await ajustarTarefaForaDoPadrao({
      issueNumber: 88,
      repository: 'dono/repo',
      tituloOriginal: 'ajustar algo',
      corpoOriginal: 'texto solto sem seções',
      conferencia: {
        padraoOk: false,
        erros: ['titulo: empty', 'goal: empty'],
        peso: null,
        noQuadro: true,
        naSprint: true,
      },
      contextBlocks: [],
      execute,
    })
    expect('erroDeValidacao' in resultado).toBe(true)
  })
})
