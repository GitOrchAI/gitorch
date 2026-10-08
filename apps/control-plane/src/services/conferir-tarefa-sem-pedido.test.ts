import { describe, it, expect } from 'vitest'
import {
  camposFaltandoDosErros,
  conferirTarefaSemPedido,
  hashDosErros,
  hashDoCorpoDaTarefa,
  montarConferenciaGravada,
} from './conferir-tarefa-sem-pedido.js'

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

const AGORA = new Date('2026-10-08T12:00:00.000Z')

describe('conferência gravada na ficha', () => {
  it('8 de 8 campos: padrão ok, nada faltando, peso lido', () => {
    const c = conferirTarefaSemPedido({
      titulo: 'Corrigir cache',
      corpo: CORPO_NO_PADRAO,
      estaNoQuadro: true,
      estaNaSprintAtual: false,
    })
    const g = montarConferenciaGravada({
      conferencia: c,
      titulo: 'Corrigir cache',
      corpo: CORPO_NO_PADRAO,
      emExecucao: false,
      agora: AGORA,
    })
    expect(g).toMatchObject({
      padraoOk: true,
      camposFaltando: [],
      erros: [],
      pesoOk: true,
      peso: 3,
      estaNoQuadro: true,
      naSprint: false,
      emExecucao: false,
      conferidoEm: AGORA.toISOString(),
      estadoDoQuadro: 'quadro:sim|sprint:nao',
    })
    expect(g.hashDoCorpo).toBe(hashDoCorpoDaTarefa('Corrigir cache', CORPO_NO_PADRAO))
  })

  it('parcial: lista exatamente os campos que faltam', () => {
    const corpo = ['## Goal', 'g', '## Task Details', 'd', '## Notes', 'n'].join('\n\n')
    const c = conferirTarefaSemPedido({
      titulo: 'Algo',
      corpo,
      estaNoQuadro: true,
      estaNaSprintAtual: true,
    })
    const g = montarConferenciaGravada({
      conferencia: c,
      titulo: 'Algo',
      corpo,
      emExecucao: true,
      agora: AGORA,
    })
    expect(g.padraoOk).toBe(false)
    expect(g.camposFaltando.sort()).toEqual(
      [
        'dependencies',
        'implementationGuide',
        'relatedFiles',
        'taskDescription',
        'verificationCriteria',
      ].sort()
    )
    expect(g.pesoOk).toBe(false)
    expect(g.peso).toBeNull()
    expect(g.emExecucao).toBe(true)
  })

  it('nenhum campo e título vazio: falta tudo, inclusive o título', () => {
    const c = conferirTarefaSemPedido({
      titulo: '',
      corpo: 'texto solto',
      estaNoQuadro: false,
      estaNaSprintAtual: false,
    })
    const g = montarConferenciaGravada({
      conferencia: c,
      titulo: '',
      corpo: 'texto solto',
      emExecucao: false,
      agora: AGORA,
    })
    expect(g.camposFaltando).toHaveLength(9)
    expect(g.camposFaltando).toContain('titulo')
  })

  it('quadro desconhecido (null) fica null na ficha, nunca false', () => {
    const c = conferirTarefaSemPedido({
      titulo: 'x',
      corpo: CORPO_NO_PADRAO,
      estaNoQuadro: null,
      estaNaSprintAtual: null,
    })
    const g = montarConferenciaGravada({
      conferencia: c,
      titulo: 'x',
      corpo: CORPO_NO_PADRAO,
      emExecucao: false,
      agora: AGORA,
    })
    expect(g.estaNoQuadro).toBeNull()
    expect(g.naSprint).toBeNull()
    expect(g.estadoDoQuadro).toBe('quadro:?|sprint:?')
  })

  it('o hash do corpo é estável e muda com o título ou com uma letra do corpo', () => {
    const a = hashDoCorpoDaTarefa('t', 'corpo')
    expect(hashDoCorpoDaTarefa('t', 'corpo')).toBe(a)
    expect(hashDoCorpoDaTarefa('t2', 'corpo')).not.toBe(a)
    expect(hashDoCorpoDaTarefa('t', 'corpo.')).not.toBe(a)
    expect(a).toMatch(/^[0-9a-f]{16}$/)
  })

  it('o hash dos erros não depende da ordem e distingue ok de falha', () => {
    expect(hashDosErros(false, ['b: x', 'a: y'])).toBe(hashDosErros(false, ['a: y', 'b: x']))
    expect(hashDosErros(true, [])).not.toBe(hashDosErros(false, ['a: y']))
  })

  it('camposFaltandoDosErros lê a chave de cada mensagem do validador', () => {
    expect(
      camposFaltandoDosErros([
        'goal: empty (DoD requires all 8 fields)',
        'verificationCriteria: needs at least one verifiable criterion',
      ])
    ).toEqual(['goal', 'verificationCriteria'])
  })
})
