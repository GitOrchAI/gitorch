import { describe, it, expect, vi } from 'vitest'
import { racharTarefaParecidaPeloCodigo } from './tarefa-parecida-pelo-codigo.js'

describe('racharTarefaParecidaPeloCodigo', () => {
  it('devolve o formulário que o executor do RA produziu', async () => {
    const execute = vi.fn(async () =>
      JSON.stringify({
        issueNumberEncontrado: 88,
        justificativa:
          'o diff mexe em services/pagamento.ts, e a issue #88 pede exatamente essa mudança',
      })
    )
    const resultado = await racharTarefaParecidaPeloCodigo({
      numeroDoPr: 7,
      repository: 'dono/repo',
      diffResumo: 'services/pagamento.ts: +12 -3',
      contextBlocks: ['contexto do codegraph'],
      issuesAbertas: [{ numero: 88, titulo: 'Ajustar o pagamento' }],
      execute,
    })
    expect(resultado.issueNumberEncontrado).toBe(88)
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('título de issue com emoji na fronteira dos 140 caracteres não deixa substituto solto no prompt', async () => {
    const emoji = '\u{1F600}'
    const execute = vi.fn(async (_prompt: string) =>
      JSON.stringify({ issueNumberEncontrado: null, justificativa: 'nada parecido' })
    )
    await racharTarefaParecidaPeloCodigo({
      numeroDoPr: 7,
      repository: 'dono/repo',
      diffResumo: 'x',
      contextBlocks: [],
      issuesAbertas: [{ numero: 5, titulo: `${'a'.repeat(139)}${emoji}${'b'.repeat(30)}` }],
      execute,
    })
    const prompt = String(execute.mock.calls[0]?.[0])
    expect(prompt).toContain(`#5 — ${'a'.repeat(139)}${emoji}`)
    expect(prompt).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
    )
  })

  it('sem tarefa parecida: issueNumberEncontrado null, com justificativa honesta', async () => {
    const execute = vi.fn(async () =>
      JSON.stringify({
        issueNumberEncontrado: null,
        justificativa: 'nenhuma issue aberta descreve esta mudança',
      })
    )
    const resultado = await racharTarefaParecidaPeloCodigo({
      numeroDoPr: 7,
      repository: 'dono/repo',
      diffResumo: 'x',
      contextBlocks: [],
      issuesAbertas: [],
      execute,
    })
    expect(resultado.issueNumberEncontrado).toBeNull()
  })

  it('entrega ao RA a lista de issues abertas (número e título): sem ela não há de onde tirar o número', async () => {
    const execute = vi.fn(async (_prompt: string) =>
      JSON.stringify({ issueNumberEncontrado: null, justificativa: 'nada parecido' })
    )
    await racharTarefaParecidaPeloCodigo({
      numeroDoPr: 590,
      repository: 'dono/repo',
      diffResumo: 'services/wishlist.ts (modified, +4 -1)',
      contextBlocks: [],
      issuesAbertas: [
        { numero: 713, titulo: '/wishlist add responde confirmação mas não registra o pedido' },
        { numero: 30, titulo: 'Outra tarefa' },
      ],
      execute,
    })
    const prompt = execute.mock.calls[0]![0]
    expect(prompt).toContain('#713')
    expect(prompt).toContain('/wishlist add responde confirmação mas não registra o pedido')
    expect(prompt).toContain('#30')
  })

  it('lista de issues vazia: o prompt diz que não há issue aberta, em vez de omitir o bloco', async () => {
    const execute = vi.fn(async (_prompt: string) =>
      JSON.stringify({ issueNumberEncontrado: null, justificativa: 'nenhuma aberta' })
    )
    await racharTarefaParecidaPeloCodigo({
      numeroDoPr: 5,
      repository: 'dono/repo',
      diffResumo: 'x',
      contextBlocks: [],
      issuesAbertas: [],
      execute,
    })
    expect(execute.mock.calls[0]![0]).toContain('Issues abertas do repositório: nenhuma')
  })
})
