import { describe, expect, it } from 'vitest'
import { sessoesParaAcompanharPublicacao, type SessaoParaVarredura } from './pos-merge.js'
import { CADENCIA_DE_PUBLICACAO_MS } from './publicacao.js'

const base: SessaoParaVarredura = {
  id: 's1',
  mergeCommitSha: 'abc',
  deployState: null,
  deployCheckedAt: null,
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

  it('ignora quem já está no ar', () => {
    expect(
      sessoesParaAcompanharPublicacao([{ ...base, deployState: 'no-ar' }], new Date())
    ).toHaveLength(0)
  })

  it('ignora quem já foi encerrado por não publicar', () => {
    expect(
      sessoesParaAcompanharPublicacao([{ ...base, deployState: 'sem-publicacao' }], new Date())
    ).toHaveLength(0)
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
