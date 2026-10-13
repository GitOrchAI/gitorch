import { describe, expect, it, vi } from 'vitest'
import {
  processarRespostaDoVinculoDaTarefa,
  type DepsDaRespostaDoVinculo,
} from './processar-resposta-vinculo-da-tarefa.js'
import { FREE_TEXT_OPTION_VALUE } from './telegram-bot.js'

const CHAVE = 'vinculo-da-tarefa:acme/api:590'
const MENSAGEM_DO_EXEMPLO = 'responda só com o número da tarefa, por exemplo 3976'
const OPCOES = [
  { label: '#713 — wishlist', value: 'vinculo-issue-713' },
  { label: '#30 — outra', value: 'vinculo-issue-30' },
  { label: 'Nenhuma destas', value: 'nenhuma-destas' },
  { label: 'Outro', value: FREE_TEXT_OPTION_VALUE },
]

function montar(extra: Partial<DepsDaRespostaDoVinculo> = {}) {
  const gravarVinculo = vi.fn(async () => undefined)
  const issueAberta = vi.fn(async (_n: number): Promise<boolean | null> => true)
  const vistas = new Set<string>()
  const registrarNoPainel = vi.fn(async (a: { chave: string; texto: string }) => {
    if (vistas.has(a.chave)) return false
    vistas.add(a.chave)
    return true
  })
  const onWarn = vi.fn()
  const deps: DepsDaRespostaDoVinculo = {
    gravarVinculo,
    issueAberta,
    registrarNoPainel,
    onWarn,
    ...extra,
  }
  return { deps, gravarVinculo, issueAberta, registrarNoPainel, onWarn }
}

describe('processarRespostaDoVinculoDaTarefa', () => {
  it('clicou na candidata: grava a issue no PR como confirmação do dono, sem consultar o GitHub', async () => {
    const m = montar()

    await processarRespostaDoVinculoDaTarefa(
      { dedupKey: CHAVE, resposta: 'vinculo-issue-713', opcoes: OPCOES },
      m.deps
    )

    expect(m.gravarVinculo).toHaveBeenCalledWith({ numeroDoPr: 590, issueNumber: 713 })
    expect(m.issueAberta).not.toHaveBeenCalled()
  })

  it('"nenhuma destas": não muda nada', async () => {
    const m = montar()

    await processarRespostaDoVinculoDaTarefa(
      { dedupKey: CHAVE, resposta: 'nenhuma-destas', opcoes: OPCOES },
      m.deps
    )

    expect(m.gravarVinculo).not.toHaveBeenCalled()
    expect(m.issueAberta).not.toHaveBeenCalled()
  })

  it('chave de outra pergunta: não é com este tratador', async () => {
    const m = montar()

    await processarRespostaDoVinculoDaTarefa(
      {
        dedupKey: 'cuida-deste-pedido:acme/api:590',
        resposta: 'vinculo-issue-713',
        opcoes: OPCOES,
      },
      m.deps
    )

    expect(m.gravarVinculo).not.toHaveBeenCalled()
  })

  it('valor "vinculo-issue-N" que NÃO estava entre as opções da pergunta não vale (nada de número forjado)', async () => {
    const m = montar()

    await processarRespostaDoVinculoDaTarefa(
      { dedupKey: CHAVE, resposta: 'vinculo-issue-9999', opcoes: OPCOES },
      m.deps
    )

    expect(m.gravarVinculo).not.toHaveBeenCalled()
    expect(m.registrarNoPainel).toHaveBeenCalledTimes(1)
  })

  it('texto livre com "#N" de uma issue aberta: grava', async () => {
    const m = montar()

    await processarRespostaDoVinculoDaTarefa(
      { dedupKey: CHAVE, resposta: 'é a tarefa #42, a do carrinho', opcoes: OPCOES },
      m.deps
    )

    expect(m.issueAberta).toHaveBeenCalledWith(42)
    expect(m.gravarVinculo).toHaveBeenCalledWith({ numeroDoPr: 590, issueNumber: 42 })
  })

  it('texto livre com issue que não está aberta: não grava, deixa a pergunta aberta e explica em português simples', async () => {
    const m = montar({ issueAberta: vi.fn(async () => false) })

    const r = await processarRespostaDoVinculoDaTarefa(
      { dedupKey: CHAVE, resposta: '#42', opcoes: OPCOES },
      m.deps
    )

    expect(m.gravarVinculo).not.toHaveBeenCalled()
    expect(m.registrarNoPainel).toHaveBeenCalledTimes(1)
    expect(m.onWarn).toHaveBeenCalled()
    expect(r).toEqual({ naoEntendida: expect.stringContaining('A tarefa #42 não está aberta') })
    expect(r?.naoEntendida).toContain('acme/api')
    expect(r?.naoEntendida).not.toMatch(/api\.github|status|404/i)
  })

  it('não deu para conferir a issue no GitHub: não grava, pergunta segue aberta e pede para tentar de novo', async () => {
    const m = montar({ issueAberta: vi.fn(async () => null) })

    const r = await processarRespostaDoVinculoDaTarefa(
      { dedupKey: CHAVE, resposta: '#42', opcoes: OPCOES },
      m.deps
    )

    expect(m.gravarVinculo).not.toHaveBeenCalled()
    expect(r?.naoEntendida).toContain('Não consegui conferir')
    expect(r?.naoEntendida).toContain('#42')
  })

  it.each([
    ['3976', 3976],
    ['é a 3976', 3976],
    ['tarefa 3976', 3976],
    ['issue 3976', 3976],
    ['3976.', 3976],
    ['https://github.com/acme/api/issues/3976', 3976],
  ])('resposta sem formato rígido %j vincula a tarefa %i', async (resposta, numero) => {
    const m = montar()

    const r = await processarRespostaDoVinculoDaTarefa(
      { dedupKey: CHAVE, resposta, opcoes: OPCOES },
      m.deps
    )

    expect(m.issueAberta).toHaveBeenCalledWith(numero)
    expect(m.gravarVinculo).toHaveBeenCalledWith({ numeroDoPr: 590, issueNumber: numero })
    expect(r).toBeUndefined()
  })

  it.each(['nenhuma', 'não tem tarefa', 'é avulso', 'sem tarefa', 'pode seguir', 'não'])(
    '%j: segue como "nenhuma destas" (não liga a nada, pergunta fechada) e anota no painel',
    async (resposta) => {
      const m = montar()

      const r = await processarRespostaDoVinculoDaTarefa(
        { dedupKey: CHAVE, resposta, opcoes: OPCOES },
        m.deps
      )

      expect(m.gravarVinculo).not.toHaveBeenCalled()
      expect(m.issueAberta).not.toHaveBeenCalled()
      expect(r).toBeUndefined()
      expect(m.registrarNoPainel).toHaveBeenCalledTimes(1)
      expect(m.registrarNoPainel.mock.calls[0]![0].texto).toContain('não pertence a nenhuma tarefa')
    }
  )

  it('texto que é só conversa não fecha a pergunta e devolve UMA mensagem com exemplo', async () => {
    const m = montar()

    const r = await processarRespostaDoVinculoDaTarefa(
      { dedupKey: CHAVE, resposta: 'ok', opcoes: OPCOES },
      m.deps
    )

    expect(m.gravarVinculo).not.toHaveBeenCalled()
    expect(m.issueAberta).not.toHaveBeenCalled()
    expect(r?.naoEntendida).toContain(MENSAGEM_DO_EXEMPLO)
    expect(r?.naoEntendida).toContain('nenhuma')
  })

  it('o exemplo sai no máximo 2 vezes para a mesma pergunta; da 3ª em diante só registra', async () => {
    const m = montar()
    const respostas: Array<string | undefined> = []
    for (const resposta of ['ok', 'vi', 'depois vejo', 'beleza']) {
      const r = await processarRespostaDoVinculoDaTarefa(
        { dedupKey: CHAVE, resposta, opcoes: OPCOES },
        m.deps
      )
      respostas.push(r?.naoEntendida)
    }

    expect(respostas[0]).toContain(MENSAGEM_DO_EXEMPLO)
    expect(respostas[1]).toContain(MENSAGEM_DO_EXEMPLO)
    expect(respostas[2]).toBe('')
    expect(respostas[3]).toBe('')
    expect(m.gravarVinculo).not.toHaveBeenCalled()
    const chaves = new Set(m.registrarNoPainel.mock.calls.map(([a]) => a.chave))
    expect([...chaves].sort()).toEqual([
      'vinculo-resposta:acme/api:590:nao-entendida-1',
      'vinculo-resposta:acme/api:590:nao-entendida-2',
      'vinculo-resposta:acme/api:590:nao-entendida-3',
    ])
  })

  it('dois números: pede para escolher uma, citando os que ele mandou, e não grava', async () => {
    const m = montar()

    const r = await processarRespostaDoVinculoDaTarefa(
      { dedupKey: CHAVE, resposta: 'acho que #42 ou #43', opcoes: OPCOES },
      m.deps
    )

    expect(m.gravarVinculo).not.toHaveBeenCalled()
    expect(m.issueAberta).not.toHaveBeenCalled()
    expect(r?.naoEntendida).toContain('#42')
    expect(r?.naoEntendida).toContain('#43')
    expect(r?.naoEntendida).toContain('uma só')
  })

  it('link de tarefa de outro repositório: não grava e diz de qual repositório a pergunta é', async () => {
    const m = montar()

    const r = await processarRespostaDoVinculoDaTarefa(
      { dedupKey: CHAVE, resposta: 'https://github.com/acme/outro/issues/42', opcoes: OPCOES },
      m.deps
    )

    expect(m.gravarVinculo).not.toHaveBeenCalled()
    expect(m.issueAberta).not.toHaveBeenCalled()
    expect(r?.naoEntendida).toContain('acme/outro')
    expect(r?.naoEntendida).toContain('acme/api')
  })

  it('o mesmo número repetido no texto vale como um só', async () => {
    const m = montar()

    await processarRespostaDoVinculoDaTarefa(
      { dedupKey: CHAVE, resposta: '#42, sim, a #42', opcoes: OPCOES },
      m.deps
    )

    expect(m.gravarVinculo).toHaveBeenCalledWith({ numeroDoPr: 590, issueNumber: 42 })
  })

  it('idempotente: responder duas vezes grava o mesmo vínculo duas vezes, sem erro', async () => {
    const m = montar()
    const args = { dedupKey: CHAVE, resposta: 'vinculo-issue-713', opcoes: OPCOES }

    await processarRespostaDoVinculoDaTarefa(args, m.deps)
    await processarRespostaDoVinculoDaTarefa(args, m.deps)

    expect(m.gravarVinculo).toHaveBeenCalledTimes(2)
    expect(m.gravarVinculo).toHaveBeenNthCalledWith(1, { numeroDoPr: 590, issueNumber: 713 })
    expect(m.gravarVinculo).toHaveBeenNthCalledWith(2, { numeroDoPr: 590, issueNumber: 713 })
  })

  it('falha ao gravar sobe (a pergunta continua aberta para nova tentativa)', async () => {
    const m = montar({
      gravarVinculo: vi.fn(async () => {
        throw new Error('banco fora')
      }),
    })

    await expect(
      processarRespostaDoVinculoDaTarefa(
        { dedupKey: CHAVE, resposta: 'vinculo-issue-713', opcoes: OPCOES },
        m.deps
      )
    ).rejects.toThrow('banco fora')
  })
})
