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

// ---------------------------------------------------------------------------
// O LAÇO DOS QUADROS (medido na API do GitHub em 31/08/2026, no repositório do
// dono `loureng/patinhas-3d-crafts`):
//
//   #3  "Jardim das Patinhas"       146 itens · 24 campos · criado 04/04 pelo dono
//   #5  "@loureng's untitled..."      0 itens · 13 campos · FECHADO
//   #11 "loureng/patinhas-3d-crafts"  0 itens · 13 campos · criado 31/08 03:02:46
//   #12 "loureng/patinhas-3d-crafts"  0 itens · 13 campos · criado 31/08 03:03:28
//
// #11 e #12 nasceram com 42 SEGUNDOS de diferença e levam o nome do
// REPOSITÓRIO como título: assinatura do produto, não do dono. A mecânica é um
// laço que piora sozinho — a decisão devolvia `escolher` ("só o dono sabe qual
// vale") e OUTRO caminho criava um quadro para resolver a falta; cada criação
// deixa mais um quadro ligado, e na volta seguinte a dúvida é maior.
//
// A saída não é adivinhar: é reparar que 146 itens contra zero não é empate.
// ---------------------------------------------------------------------------
describe('desempate automático entre quadros ligados', () => {
  const jardim = (): QuadroCandidato[] => [
    quadro({
      id: 'PVT_12',
      number: 12,
      title: 'loureng/patinhas-3d-crafts',
      linkado: true,
      itensCount: 0,
      camposCount: 13,
    }),
    quadro({
      id: 'PVT_11',
      number: 11,
      title: 'loureng/patinhas-3d-crafts',
      linkado: true,
      itensCount: 0,
      camposCount: 13,
    }),
    quadro({
      id: 'PVT_5',
      number: 5,
      title: "@loureng's untitled project",
      closed: true,
      linkado: true,
      itensCount: 0,
      camposCount: 13,
    }),
    quadro({
      id: 'PVT_3',
      number: 3,
      title: 'Jardim das Patinhas',
      linkado: true,
      itensCount: 146,
      camposCount: 24,
    }),
  ]

  it('o Jardim real: escolhe o #3 sozinho, sem pedir nada ao dono', () => {
    const d = decidirQuadro({ candidatos: jardim() })
    expect(d.acao).toBe('usar')
    if (d.acao === 'usar') {
      expect(d.quadro.number).toBe(3)
      expect(d.precisaLigar).toBe(false)
      expect(d.motivo).toContain('146')
    }
  })

  it('MAIS ITENS vence MAIS CAMPOS: uso real é sinal mais forte que investimento', () => {
    const d = decidirQuadro({
      candidatos: [
        quadro({ id: 'rico_e_vazio', linkado: true, itensCount: 0, camposCount: 40 }),
        quadro({ id: 'pobre_e_usado', linkado: true, itensCount: 12, camposCount: 13 }),
      ],
    })
    expect(d.acao).toBe('usar')
    if (d.acao === 'usar') expect(d.quadro.id).toBe('pobre_e_usado')
  })

  it('itens empatados: aí sim desempata por MAIS CAMPOS', () => {
    const d = decidirQuadro({
      candidatos: [
        quadro({ id: 'padrao', linkado: true, itensCount: 7, camposCount: 13 }),
        quadro({ id: 'cuidado', linkado: true, itensCount: 7, camposCount: 24 }),
      ],
    })
    expect(d.acao).toBe('usar')
    if (d.acao === 'usar') expect(d.quadro.id).toBe('cuidado')
  })

  it('empate de VERDADE (mesmos itens, mesmos campos) continua sendo pergunta ao dono', () => {
    const d = decidirQuadro({
      candidatos: [
        quadro({ id: 'A', linkado: true, itensCount: 9, camposCount: 13 }),
        quadro({ id: 'B', linkado: true, itensCount: 9, camposCount: 13 }),
      ],
    })
    expect(d.acao).toBe('escolher')
    if (d.acao === 'escolher') expect(d.candidatos).toHaveLength(2)
  })

  it('o quadro FECHADO não entra no desempate nem quando é o único com itens', () => {
    const d = decidirQuadro({
      candidatos: [
        quadro({ id: 'morto', closed: true, linkado: true, itensCount: 999, camposCount: 99 }),
        quadro({ id: 'vivo_a', linkado: true, itensCount: 4, camposCount: 13 }),
        quadro({ id: 'vivo_b', linkado: true, itensCount: 1, camposCount: 13 }),
      ],
    })
    expect(d.acao).toBe('usar')
    if (d.acao === 'usar') expect(d.quadro.id).toBe('vivo_a')
  })
})
