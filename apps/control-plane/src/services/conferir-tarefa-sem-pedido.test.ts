import { describe, it, expect } from 'vitest'
import { conferirTarefaSemPedido } from './conferir-tarefa-sem-pedido.js'

const CORPO_NO_PADRAO = [
  '## Goal',
  'g',
  '## Task Details',
  'd',
  '## Task Description',
  'd',
  '## Implementation Guide',
  'i com passo concreto',
  '## Verification Criteria',
  'rodar `pnpm test` e ver 0 falhas',
  '## Dependencies',
  'nenhuma',
  '## Related Files',
  'src/x.ts',
  '## Notes',
  'n',
  '## Peso',
  '**3**',
].join('\n\n')

describe('conferirTarefaSemPedido', () => {
  it('issue no padrão, com peso, no quadro e na sprint: tudo ok', () => {
    const r = conferirTarefaSemPedido({
      titulo: 'Corrigir cache',
      corpo: CORPO_NO_PADRAO,
      estaNoQuadro: true,
      estaNaSprintAtual: true,
    })
    expect(r).toEqual({ padraoOk: true, erros: [], peso: 3, noQuadro: true, naSprint: true })
  })

  it('issue criada à mão, sem os 8 campos: padraoOk false com os erros', () => {
    const r = conferirTarefaSemPedido({
      titulo: 'Ajustar algo',
      corpo: 'só um parágrafo solto',
      estaNoQuadro: false,
      estaNaSprintAtual: false,
    })
    expect(r.padraoOk).toBe(false)
    expect(r.erros.length).toBeGreaterThan(0)
    expect(r.peso).toBeNull()
    expect(r.noQuadro).toBe(false)
  })
})
