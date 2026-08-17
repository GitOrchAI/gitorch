import { describe, expect, it } from 'vitest'
import { sessoesParaAcompanharPublicacao, type SessaoParaVarredura } from './pos-merge.js'
import { CADENCIA_DE_PUBLICACAO_MS } from './publicacao.js'

const base: SessaoParaVarredura = {
  id: 's1',
  mergeCommitSha: 'abc',
  deployState: null,
  deployCheckedAt: null,
  closedAt: null,
}

describe('sessoesParaAcompanharPublicacao', () => {
  it('pega quem mesclou e ainda não tem veredito', () => {
    expect(sessoesParaAcompanharPublicacao([base], new Date())).toHaveLength(1)
  })

  it('ignora quem não mesclou', () => {
    expect(
      sessoesParaAcompanharPublicacao([{ ...base, mergeCommitSha: null }], new Date())
    ).toHaveLength(0)
  })

  // Crítico 2 (leva C): "já está no ar" só é motivo para pular quando a linha
  // está DE FATO fechada (`closedAt` não-nulo) — nunca só pelo veredito. Sem
  // isso, uma linha órfã (veredito final, `closedAt` ainda nulo — o exato
  // cenário de um restart entre `registrarEstadoDaPublicacao` e
  // `fecharSessao`, scheduler.ts) desaparecia desta lista para sempre.
  it('ignora quem já está no ar E DE FATO fechado (closedAt preenchido)', () => {
    expect(
      sessoesParaAcompanharPublicacao(
        [{ ...base, deployState: 'no-ar', closedAt: new Date() }],
        new Date()
      )
    ).toHaveLength(0)
  })

  it('ignora quem já foi encerrado por não publicar E DE FATO fechado (closedAt preenchido)', () => {
    expect(
      sessoesParaAcompanharPublicacao(
        [{ ...base, deployState: 'sem-publicacao', closedAt: new Date() }],
        new Date()
      )
    ).toHaveLength(0)
  })

  it('CRÍTICO 2: NÃO ignora uma sessão ÓRFÃ — veredito final ("no-ar") mas closedAt ainda nulo — a vigília volta a examiná-la', () => {
    expect(
      sessoesParaAcompanharPublicacao(
        [{ ...base, deployState: 'no-ar', closedAt: null }],
        new Date()
      )
    ).toHaveLength(1)
  })

  it('CRÍTICO 2: o mesmo vale para "sem-publicacao" órfã (closedAt nulo)', () => {
    expect(
      sessoesParaAcompanharPublicacao(
        [{ ...base, deployState: 'sem-publicacao', closedAt: null }],
        new Date()
      )
    ).toHaveLength(1)
  })

  it('respeita a cadência: não reexamina antes da hora', () => {
    const agora = new Date('2026-08-16T12:00:00Z')
    const recem = {
      ...base,
      deployState: 'publicando',
      deployCheckedAt: new Date(agora.getTime() - (CADENCIA_DE_PUBLICACAO_MS - 60_000)),
    }
    expect(sessoesParaAcompanharPublicacao([recem], agora)).toHaveLength(0)
  })

  it('reexamina quem já passou da cadência', () => {
    const agora = new Date('2026-08-16T12:00:00Z')
    const velho = {
      ...base,
      deployState: 'publicando',
      deployCheckedAt: new Date(agora.getTime() - (CADENCIA_DE_PUBLICACAO_MS + 60_000)),
    }
    expect(sessoesParaAcompanharPublicacao([velho], agora)).toHaveLength(1)
  })

  // falhou/commit-errado NÃO são finais de propósito: o CD pode ser
  // retentado pelo cliente, e uma execução presa na fila (commit-errado)
  // pode ser sucedida pela execução certa — continuam sendo reexaminados,
  // respeitando a cadência como qualquer outro estado não-final.
  it('reexamina falhou/commit-errado depois da cadência — não são veredito final', () => {
    const agora = new Date('2026-08-16T12:00:00Z')
    const velho = new Date(agora.getTime() - (CADENCIA_DE_PUBLICACAO_MS + 60_000))
    expect(
      sessoesParaAcompanharPublicacao(
        [
          { ...base, deployState: 'falhou', deployCheckedAt: velho },
          { ...base, id: 's2', deployState: 'commit-errado', deployCheckedAt: velho },
        ],
        agora
      )
    ).toHaveLength(2)
  })
})
