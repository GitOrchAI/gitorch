import { describe, expect, it, vi } from 'vitest'
import { gerarPerguntaSobrePrParado } from './pr-parado-mission.js'
import type { StepExecutor } from './role-rails.js'

describe('pr-parado-mission', () => {
  it('gera a pergunta estruturada usando runFormStep', async () => {
    const mockExecute = vi.fn().mockResolvedValue(
      JSON.stringify({
        resumo_do_pr: 'Faz o login funcionar',
        motivo_da_espera: 'CI falhou',
        recomendacao_do_agente: 'Pedir ajuste',
        opcoes_sob_medida: [
          { label: 'Pedir Ajuste', action: 'pedir-ajuste' },
          { label: 'Fechar', action: 'fechar' },
        ],
      })
    ) as unknown as StepExecutor

    const resultado = await gerarPerguntaSobrePrParado({
      contextoPr: {
        titulo: 'Fix login',
        idadeDias: 10,
        estadoCi: 'failure',
        conflitos: false,
      },
      execute: mockExecute,
    })

    expect(resultado.resumo_do_pr).toBe('Faz o login funcionar')
    expect(resultado.opcoes_sob_medida).toHaveLength(2)
    expect(mockExecute).toHaveBeenCalled()
  })
})
