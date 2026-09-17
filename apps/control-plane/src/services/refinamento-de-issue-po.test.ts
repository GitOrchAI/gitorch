import { describe, it, expect } from 'vitest'
import {
  montarCorpoRefinado,
  montarComentarioDeRefinamento,
  executarRefinamentoDoPo,
} from './refinamento-de-issue-po.js'

describe('montarCorpoRefinado', () => {
  it('preserva o corpo atual e adiciona a seção de refinamento do PO', () => {
    const corpoAtual =
      '## Goal\n\nFazer feature X.\n\n## Verification Criteria\n\nPassar nos testes.'
    const resultado = montarCorpoRefinado({
      corpoAtual,
      pedidoRevisado: 'Novo pedido com instruções claras.',
      causaComum: 'Faltava mock no teste.',
    })

    expect(resultado).toContain('## Goal\n\nFazer feature X.')
    expect(resultado).toContain('## Verification Criteria\n\nPassar nos testes.')
    expect(resultado).toContain('## Refinamento do Backlog (PO)')
    expect(resultado).toContain('Novo pedido com instruções claras.')
    expect(resultado).toContain('Faltava mock no teste.')
  })

  it('atualiza a seção de refinamento existente sem duplicar', () => {
    const corpoAtual =
      '## Goal\n\nFazer feature X.\n\n## Refinamento do Backlog (PO)\n\nVersão antiga do pedido.\n\n## Verification Criteria\n\nPassar nos testes.'
    const resultado = montarCorpoRefinado({
      corpoAtual,
      pedidoRevisado: 'Versão novíssima do pedido.',
    })

    expect(resultado).not.toContain('Versão antiga do pedido.')
    expect(resultado).toContain('Versão novíssima do pedido.')
    const ocorrencias = resultado.split('## Refinamento do Backlog (PO)').length - 1
    expect(ocorrencias).toBe(1)
  })

  it('injeta a seção de Related Files quando houver arquivos', () => {
    const corpoAtual = '## Goal\n\nFazer feature X.'
    const resultado = montarCorpoRefinado({
      corpoAtual,
      pedidoRevisado: 'Instruções refinadas.',
      arquivos: ['src/services/a.ts', 'src/services/b.ts'],
    })

    expect(resultado).toContain('## Related Files')
    expect(resultado).toContain('- src/services/a.ts')
    expect(resultado).toContain('- src/services/b.ts')
  })

  it('atualiza a seção de Related Files se ela já existir', () => {
    const corpoAtual = '## Goal\n\nFazer feature X.\n\n## Related Files\n\n- src/antigo.ts'
    const resultado = montarCorpoRefinado({
      corpoAtual,
      pedidoRevisado: 'Instruções refinadas.',
      arquivos: ['src/novo.ts'],
    })

    expect(resultado).not.toContain('- src/antigo.ts')
    expect(resultado).toContain('- src/novo.ts')
    const ocorrencias = resultado.split('## Related Files').length - 1
    expect(ocorrencias).toBe(1)
  })
})

describe('montarComentarioDeRefinamento', () => {
  it('gera texto formal do PO com causa comum e pedido revisado', () => {
    const comentario = montarComentarioDeRefinamento({
      pedidoRevisado: 'Favor verificar a camada de cache antes de salvar.',
      causaComum: 'Timeout na chamada de rede.',
    })

    expect(comentario).toContain('Refinamento do Backlog pelo Product Owner (PO)')
    expect(comentario).toContain('Timeout na chamada de rede.')
    expect(comentario).toContain('Favor verificar a camada de cache antes de salvar.')
  })

  it('funciona mesmo sem causa comum informada', () => {
    const comentario = montarComentarioDeRefinamento({
      pedidoRevisado: 'Novo direcionamento.',
    })

    expect(comentario).toContain('Refinamento do Backlog pelo Product Owner (PO)')
    expect(comentario).toContain('Novo direcionamento.')
  })
})

describe('executarRefinamentoDoPo', () => {
  it('orquestra PATCH na issue e POST nos comentários', async () => {
    const chamadas: Array<{ metodo: string; caminho: string; corpo?: unknown }> = []
    const chamadorHttp = async (metodo: string, caminho: string, corpo?: unknown) => {
      chamadas.push({ metodo, caminho, corpo })
      return { ok: true }
    }

    await executarRefinamentoDoPo({
      repository: 'GitOrchAI/gitorch',
      issueNumber: 42,
      corpoAtual: '## Goal\n\nFeature 42',
      pedidoRevisado: 'Pedido revisado para a issue 42',
      causaComum: 'Falha intermitente',
      arquivos: ['src/index.ts'],
      chamadorHttp,
    })

    expect(chamadas).toHaveLength(2)
    expect(chamadas[0]?.metodo).toBe('PATCH')
    expect(chamadas[0]?.caminho).toBe('/repos/GitOrchAI/gitorch/issues/42')
    const patchBody = chamadas[0]?.corpo as { body: string }
    expect(patchBody.body).toContain('## Refinamento do Backlog (PO)')
    expect(patchBody.body).toContain('src/index.ts')

    expect(chamadas[1]?.metodo).toBe('POST')
    expect(chamadas[1]?.caminho).toBe('/repos/GitOrchAI/gitorch/issues/42/comments')
    const postBody = chamadas[1]?.corpo as { body: string }
    expect(postBody.body).toContain('Refinamento do Backlog pelo Product Owner (PO)')
    expect(postBody.body).toContain('Pedido revisado para a issue 42')
  })
})
