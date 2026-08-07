import { describe, it, expect } from 'vitest'
import { decidirMerge, ultimoVeredito } from './merge-gate.js'

// Visto em produção, num PR escrito pelo dev assíncrono:
//
//   review de gitorch-ai · CHANGES_REQUESTED · 13:34:57
//   merge   por app/github-actions              · 13:36:20
//
// O QA leu o PR, reprovou e publicou o motivo. Oitenta e três segundos depois a
// automação aprovou o mesmo PR em nome do sistema e mandou para a linha
// principal, porque só olhava os testes. Um produto que vende julgamento não
// pode mesclar o que o próprio julgamento recusou.

const QA = 'gitorch-ai'
const SHA = 'abc123'

describe('ultimoVeredito', () => {
  it('vale a última revisão do QA, não a primeira', () => {
    const v = ultimoVeredito(
      [
        { autor: QA, estado: 'CHANGES_REQUESTED', commitId: SHA, em: '2026-01-01T10:00:00Z' },
        { autor: QA, estado: 'APPROVED', commitId: SHA, em: '2026-01-01T11:00:00Z' },
      ],
      QA
    )
    expect(v?.estado).toBe('APPROVED')
  })

  it('ignora revisão de quem não é o QA', () => {
    const v = ultimoVeredito(
      [
        {
          autor: 'app/github-actions',
          estado: 'APPROVED',
          commitId: SHA,
          em: '2026-01-01T10:00:00Z',
        },
      ],
      QA
    )
    expect(v).toBeUndefined()
  })

  it('comentário sem veredito não vira veredito', () => {
    const v = ultimoVeredito(
      [{ autor: QA, estado: 'COMMENTED', commitId: SHA, em: '2026-01-01T10:00:00Z' }],
      QA
    )
    expect(v).toBeUndefined()
  })

  it('revisão descartada deixa de contar', () => {
    const v = ultimoVeredito(
      [{ autor: QA, estado: 'DISMISSED', commitId: SHA, em: '2026-01-01T10:00:00Z' }],
      QA
    )
    expect(v).toBeUndefined()
  })

  it('sem revisão nenhuma não há veredito', () => {
    expect(ultimoVeredito([], QA)).toBeUndefined()
  })
})

describe('decidirMerge', () => {
  it('o caso real: reprovado pelo QA não entra na linha principal', () => {
    const d = decidirMerge({
      revisorDeQualidade: QA,
      revisoes: [
        { autor: QA, estado: 'CHANGES_REQUESTED', commitId: SHA, em: '2026-01-01T13:34:57Z' },
      ],
      commitAtual: SHA,
      exigeAprovacao: true,
    })
    expect(d.pode).toBe(false)
    expect(d.motivo).toContain('reprov')
  })

  it('aprovado pelo QA sobre a versão atual: pode mesclar', () => {
    const d = decidirMerge({
      revisorDeQualidade: QA,
      revisoes: [{ autor: QA, estado: 'APPROVED', commitId: SHA, em: '2026-01-01T13:40:00Z' }],
      commitAtual: SHA,
      exigeAprovacao: true,
    })
    expect(d.pode).toBe(true)
  })

  // Sem isto, bastaria enviar qualquer commit depois da reprovação para o
  // veredito virar "de outra versão" e o merge passar sem ninguém reler nada.
  it('correção enviada depois do veredito exige novo julgamento', () => {
    const d = decidirMerge({
      revisorDeQualidade: QA,
      revisoes: [
        { autor: QA, estado: 'APPROVED', commitId: 'versao-velha', em: '2026-01-01T13:40:00Z' },
      ],
      commitAtual: SHA,
      exigeAprovacao: true,
    })
    expect(d.pode).toBe(false)
    expect(d.motivo).toContain('outra versão')
  })

  it('reprovação de versão anterior também segura o merge', () => {
    const d = decidirMerge({
      revisorDeQualidade: QA,
      revisoes: [
        {
          autor: QA,
          estado: 'CHANGES_REQUESTED',
          commitId: 'versao-velha',
          em: '2026-01-01T13:34:57Z',
        },
      ],
      commitAtual: SHA,
      exigeAprovacao: true,
    })
    expect(d.pode).toBe(false)
  })

  it('PR do dev sem nenhum veredito espera o QA em vez de entrar', () => {
    const d = decidirMerge({
      revisorDeQualidade: QA,
      revisoes: [],
      commitAtual: SHA,
      exigeAprovacao: true,
    })
    expect(d.pode).toBe(false)
    expect(d.motivo).toContain('aguardando')
  })

  // Bump de dependência não passa pelo QA do produto: exigir aprovação dele
  // travaria a automação de segurança inteira, que é justamente o que não pode
  // ficar parado.
  it('rotina de dependência sem veredito continua entrando', () => {
    const d = decidirMerge({
      revisorDeQualidade: QA,
      revisoes: [],
      commitAtual: SHA,
      exigeAprovacao: false,
    })
    expect(d.pode).toBe(true)
  })

  it('rotina de dependência com aprovação de versão anterior segue entrando', () => {
    const d = decidirMerge({
      revisorDeQualidade: QA,
      revisoes: [
        { autor: QA, estado: 'APPROVED', commitId: 'versao-velha', em: '2026-01-01T13:40:00Z' },
      ],
      commitAtual: SHA,
      exigeAprovacao: false,
    })
    expect(d.pode).toBe(true)
  })

  it('mas rotina de dependência reprovada pelo QA para', () => {
    const d = decidirMerge({
      revisorDeQualidade: QA,
      revisoes: [
        { autor: QA, estado: 'CHANGES_REQUESTED', commitId: SHA, em: '2026-01-01T13:34:57Z' },
      ],
      commitAtual: SHA,
      exigeAprovacao: false,
    })
    expect(d.pode).toBe(false)
  })

  // A automação dava `--approve` em nome do sistema antes de mesclar. Se essa
  // aprovação contasse, o portão se abriria sozinho.
  it('a aprovação da própria automação não conta como julgamento', () => {
    const d = decidirMerge({
      revisorDeQualidade: QA,
      revisoes: [
        {
          autor: 'app/github-actions',
          estado: 'APPROVED',
          commitId: SHA,
          em: '2026-01-01T13:36:00Z',
        },
      ],
      commitAtual: SHA,
      exigeAprovacao: true,
    })
    expect(d.pode).toBe(false)
  })

  // O teste acima passa porque, na configuração de hoje, o QA é outra
  // identidade. Isso é sorte, não garantia: quem configura o revisor pode
  // apontá-lo, por engano, para a identidade que a própria automação usa — e aí
  // o portão volta a se auto-aprovar, calado. A recusa tem que estar no código.
  it('nem que configurem o revisor como a própria automação: o sistema não julga a si mesmo', () => {
    for (const identidadeDoSistema of [
      'github-actions',
      'github-actions[bot]',
      'app/github-actions',
    ]) {
      const d = decidirMerge({
        revisorDeQualidade: identidadeDoSistema,
        revisoes: [
          {
            autor: identidadeDoSistema,
            estado: 'APPROVED',
            commitId: SHA,
            em: '2026-01-01T13:36:20Z',
          },
        ],
        commitAtual: SHA,
        exigeAprovacao: true,
      })
      expect(d.pode, `${identidadeDoSistema} não pode valer como veredito`).toBe(false)
    }
  })

  // Revisão antiga do GitHub pode não trazer o commit julgado; tratar ausência
  // como "serve para qualquer versão" reabriria a porta que este portão fecha.
  it('veredito sem versão registrada não é aceito como atual', () => {
    const d = decidirMerge({
      revisorDeQualidade: QA,
      revisoes: [{ autor: QA, estado: 'APPROVED', commitId: null, em: '2026-01-01T13:40:00Z' }],
      commitAtual: SHA,
      exigeAprovacao: true,
    })
    expect(d.pode).toBe(false)
  })

  it('o motivo sempre explica o que fazer para destravar', () => {
    for (const caso of [
      { revisoes: [], exigeAprovacao: true },
      {
        revisoes: [
          {
            autor: QA,
            estado: 'CHANGES_REQUESTED' as const,
            commitId: SHA,
            em: '2026-01-01T13:34:57Z',
          },
        ],
        exigeAprovacao: true,
      },
    ]) {
      const d = decidirMerge({ revisorDeQualidade: QA, commitAtual: SHA, ...caso })
      expect(d.motivo.length).toBeGreaterThan(20)
    }
  })
})
