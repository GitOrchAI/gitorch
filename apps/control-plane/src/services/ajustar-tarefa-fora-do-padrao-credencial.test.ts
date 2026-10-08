import { describe, it, expect, vi } from 'vitest'
import { wrapClientRequest } from '@gitorch/cadence'
import { ajustarTarefaForaDoPadrao } from './ajustar-tarefa-fora-do-padrao.js'
import { RailsStepError, runFormStep } from './rails-runner.js'

// O que sobe do formulário do motor para a ficha da tarefa (`erroDeValidacao`)
// não pode carregar uma credencial, venha o erro da cerca do texto da issue ou
// da validação do formulário. As funções reais são envolvidas só para que a
// mensagem do erro possa citar a credencial sentinela.

vi.mock('@gitorch/cadence', async (importarOriginal) => {
  const real = await importarOriginal<typeof import('@gitorch/cadence')>()
  return { ...real, wrapClientRequest: vi.fn(real.wrapClientRequest) }
})
vi.mock('./rails-runner.js', async (importarOriginal) => {
  const real = await importarOriginal<typeof import('./rails-runner.js')>()
  return { ...real, runFormStep: vi.fn(real.runFormStep) }
})

const TOKEN = 'sentinela-gh-9f2c41d7a8'
const ARGS = {
  issueNumber: 88,
  repository: 'dono/repo',
  tituloOriginal: 'ajustar algo',
  corpoOriginal: 'texto solto sem seções',
  conferencia: {
    padraoOk: false,
    erros: ['goal: empty'],
    peso: null,
    noQuadro: true,
    naSprint: true,
  },
  contextBlocks: [],
  execute: vi.fn(async () => '{}'),
}

describe('ajustarTarefaForaDoPadrao: nenhuma credencial vai para o erro de validação', () => {
  it('erro da cerca do texto da issue que cita a credencial: sai mascarado', async () => {
    vi.mocked(wrapClientRequest).mockImplementationOnce(() => {
      throw new Error(`recusado: Authorization: Bearer ${TOKEN} no texto`)
    })
    const resultado = await ajustarTarefaForaDoPadrao(ARGS)

    if (!('erroDeValidacao' in resultado)) throw new Error('esperava erroDeValidacao')
    // controle positivo: o resto da mensagem chegou
    expect(resultado.erroDeValidacao).toContain('recusado')
    expect(resultado.erroDeValidacao).not.toContain(TOKEN)
  })

  it('erro da cerca lançado como texto, undefined ou null: não lança e sai mascarado', async () => {
    for (const lancado of [
      `token ${TOKEN} ghp_abcdefghijklmnopqrstuvwxyz0123456789`,
      undefined,
      null,
    ]) {
      vi.mocked(wrapClientRequest).mockImplementationOnce(() => {
        throw lancado
      })
      const resultado = await ajustarTarefaForaDoPadrao(ARGS)
      if (!('erroDeValidacao' in resultado)) throw new Error('esperava erroDeValidacao')
      expect(resultado.erroDeValidacao).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789')
    }
  })

  it('formulário do motor que nunca validou e cita a credencial: sai mascarado', async () => {
    vi.mocked(runFormStep).mockRejectedValueOnce(
      new RailsStepError(`Form step failed after 3 attempts: campo com Bearer ${TOKEN}`, [], 3)
    )
    const resultado = await ajustarTarefaForaDoPadrao(ARGS)

    if (!('erroDeValidacao' in resultado)) throw new Error('esperava erroDeValidacao')
    expect(resultado.erroDeValidacao).toContain('Form step failed')
    expect(resultado.erroDeValidacao).not.toContain(TOKEN)
  })
})
