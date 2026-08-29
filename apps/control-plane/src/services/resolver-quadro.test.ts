import { describe, it, expect } from 'vitest'
import { decidirQuadro, type QuadroCandidato } from './resolver-quadro.js'

// Os oito cenários foram levantados na conta do próprio dono em 29/08 — nenhum
// é hipótese. A organização do gitorch tem três quadros (um ativo ligado, dois
// arquivados sem repositório) e a conta pessoal dele tem seis, entre eles o do
// Jardim das Patinhas, que existe mas não está ligado a repositório nenhum.

function quadro(over: Partial<QuadroCandidato> = {}): QuadroCandidato {
  return {
    id: 'PVT_1',
    number: 2,
    title: 'GitOrchAI/gitorch',
    closed: false,
    linkado: false,
    ...over,
  }
}

describe('decidirQuadro — os 8 cenários de quadro do cliente', () => {
  it('1. quadro ligado ao repositório: usa esse', () => {
    const d = decidirQuadro({ candidatos: [quadro({ linkado: true })] })
    expect(d.acao).toBe('usar')
    if (d.acao === 'usar') {
      expect(d.quadro.id).toBe('PVT_1')
      expect(d.precisaLigar).toBe(false)
    }
  })

  it('2. quadro existe mas não está ligado: usa e avisa que precisa ligar', () => {
    const d = decidirQuadro({
      candidatos: [quadro({ id: 'PVT_9', title: 'GitOrch — Jardim', issuesDesteRepo: 78 })],
    })
    expect(d.acao).toBe('usar')
    if (d.acao === 'usar') {
      expect(d.precisaLigar).toBe(true)
      expect(d.motivo).toContain('78')
    }
  })

  it('3. nenhum quadro: cria', () => {
    const d = decidirQuadro({ candidatos: [] })
    expect(d.acao).toBe('criar')
  })

  it('4. vários quadros, um ligado: o ligado ganha', () => {
    const d = decidirQuadro({
      candidatos: [
        quadro({ id: 'PVT_1', linkado: true }),
        quadro({ id: 'PVT_4', title: "@loureng's untitled project" }),
        quadro({ id: 'PVT_5', title: 'GitOrch — gitorch' }),
      ],
    })
    expect(d.acao).toBe('usar')
    if (d.acao === 'usar') expect(d.quadro.id).toBe('PVT_1')
  })

  it('5. quadro ARQUIVADO nunca é adotado — escrever sprint nele é escrever no vazio', () => {
    const d = decidirQuadro({
      candidatos: [
        quadro({ id: 'PVT_4', closed: true, linkado: true, issuesDesteRepo: 999 }),
        quadro({ id: 'PVT_5', closed: true }),
      ],
    })
    // Mesmo o arquivado estando LIGADO e cheio de issues, ele sai da disputa.
    expect(d.acao).toBe('criar')
    if (d.acao === 'criar') expect(d.motivo).toContain('arquivados')
  })

  it('6. conta pessoal sem a autorização de quadros: não cria por cima do que não enxerga', () => {
    const d = decidirQuadro({ candidatos: [], podeEstarCego: true })
    expect(d.acao).toBe('sem_acesso')
    if (d.acao === 'sem_acesso') expect(d.motivo).toContain('conta pessoal')
  })

  it('7 e 8. a decisão não olha campo de sprint — isso é do passo seguinte', () => {
    // Quadro sem campo Sprint (gitorch) e quadro com campo vazio (Jardim) são o
    // MESMO caso aqui: os dois são quadros válidos. A diferença aparece só na
    // hora de garantir a sprint.
    const d = decidirQuadro({ candidatos: [quadro({ linkado: true })] })
    expect(d.acao).toBe('usar')
  })

  it('empate entre quadros ligados: quem decide é o dono', () => {
    const d = decidirQuadro({
      candidatos: [quadro({ id: 'A', linkado: true }), quadro({ id: 'B', linkado: true })],
    })
    expect(d.acao).toBe('escolher')
    if (d.acao === 'escolher') expect(d.candidatos).toHaveLength(2)
  })

  it('desempata por USO quando nenhum está ligado', () => {
    const d = decidirQuadro({
      candidatos: [
        quadro({ id: 'pouco', issuesDesteRepo: 3 }),
        quadro({ id: 'muito', issuesDesteRepo: 78 }),
      ],
    })
    expect(d.acao).toBe('usar')
    if (d.acao === 'usar') expect(d.quadro.id).toBe('muito')
  })

  it('empate no uso também vira escolha do dono', () => {
    const d = decidirQuadro({
      candidatos: [
        quadro({ id: 'A', issuesDesteRepo: 10 }),
        quadro({ id: 'B', issuesDesteRepo: 10 }),
      ],
    })
    expect(d.acao).toBe('escolher')
  })

  it('quadro da conta sem relação com o repositório não é adotado sozinho', () => {
    // Pode ser de OUTRO projeto do mesmo cliente. Adotar seria invadir.
    const d = decidirQuadro({ candidatos: [quadro({ title: 'ECA Verify Development' })] })
    expect(d.acao).toBe('escolher')
    if (d.acao === 'escolher') expect(d.motivo).toContain('outro projeto')
  })

  it('arquivado é descartado antes de qualquer outra regra', () => {
    // O vivo perde em uso para o arquivado, e mesmo assim é o escolhido.
    const d = decidirQuadro({
      candidatos: [
        quadro({ id: 'morto', closed: true, issuesDesteRepo: 500 }),
        quadro({ id: 'vivo', issuesDesteRepo: 1 }),
      ],
    })
    expect(d.acao).toBe('usar')
    if (d.acao === 'usar') expect(d.quadro.id).toBe('vivo')
  })
})
