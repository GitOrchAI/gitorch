import { describe, expect, it } from 'vitest'
import {
  precisaConferirSeOCiTerminou,
  headDoAvisoDeVerificacao,
  verificacaoTerminou,
} from './github-webhook.js'

// POR QUE ESTE ARQUIVO EXISTE — a segunda metade das acordadas vazias.
//
// MEDIDO em 23/08/2026: das 34 acordadas do julgamento vindas de aviso do
// GitHub, 26 devolveram "verificação em pending", e havia sondagens do MESMO
// pull request separadas por quinze segundos.
//
// A CAUSA: um repositório com oito workflows dispara OITO avisos de conclusão
// para o mesmo commit, um por workflow que termina. O julgamento acordava em
// todos, encontrava a entrega, via que ainda havia verificação rodando e
// voltava vazio. Só o ÚLTIMO aviso tem informação nova; os outros sete são o
// mesmo commit num estado que ainda não dá para julgar.

describe('precisaConferirSeOCiTerminou', () => {
  it('aviso de verificação concluída exige conferência', () => {
    expect(precisaConferirSeOCiTerminou('check_suite', { action: 'completed' })).toBe(true)
    expect(precisaConferirSeOCiTerminou('workflow_run', { action: 'completed' })).toBe(true)
  })

  it('outros avisos não — o PR recém-aberto não tem verificação para esperar', () => {
    expect(precisaConferirSeOCiTerminou('pull_request', { action: 'opened' })).toBe(false)
    expect(precisaConferirSeOCiTerminou('issues', { action: 'opened' })).toBe(false)
    expect(precisaConferirSeOCiTerminou('check_suite', { action: 'requested' })).toBe(false)
  })
})

describe('headDoAvisoDeVerificacao', () => {
  it('lê o commit dos dois formatos de aviso', () => {
    expect(headDoAvisoDeVerificacao({ check_suite: { head_sha: 'abc' } })).toBe('abc')
    expect(headDoAvisoDeVerificacao({ workflow_run: { head_sha: 'def' } })).toBe('def')
  })

  it('sem commit no aviso, devolve null', () => {
    expect(headDoAvisoDeVerificacao({})).toBeNull()
  })
})

describe('verificacaoTerminou', () => {
  it('tudo concluído: terminou', () => {
    expect(verificacaoTerminou([{ status: 'completed' }, { status: 'completed' }])).toBe(true)
  })

  it('UM ainda rodando: não terminou — é este o caso das 26 acordadas vazias', () => {
    expect(verificacaoTerminou([{ status: 'completed' }, { status: 'in_progress' }])).toBe(false)
  })

  it('não dá para saber devolve null, e quem chama ACORDA na dúvida', () => {
    // A assimetria é deliberada e é a guarda mais importante daqui: acordar à
    // toa custa um contêiner; NÃO acordar deixa a entrega sem parecer, parada
    // para sempre. Na dúvida, sempre o lado que julga.
    expect(verificacaoTerminou([])).toBeNull()
    expect(verificacaoTerminou(undefined)).toBeNull()
    expect(verificacaoTerminou(null)).toBeNull()
  })
})
