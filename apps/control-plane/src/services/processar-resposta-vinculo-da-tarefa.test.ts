import { describe, expect, it, vi } from 'vitest'
import {
  processarRespostaDoVinculoDaTarefa,
  type DepsDaRespostaDoVinculo,
} from './processar-resposta-vinculo-da-tarefa.js'
import { FREE_TEXT_OPTION_VALUE } from './telegram-bot.js'

const CHAVE = 'vinculo-da-tarefa:acme/api:590'
const OPCOES = [
  { label: '#713 — wishlist', value: 'vinculo-issue-713' },
  { label: '#30 — outra', value: 'vinculo-issue-30' },
  { label: 'Nenhuma destas', value: 'nenhuma-destas' },
  { label: 'Outro', value: FREE_TEXT_OPTION_VALUE },
]

function montar(extra: Partial<DepsDaRespostaDoVinculo> = {}) {
  const gravarVinculo = vi.fn(async () => undefined)
  const issueAberta = vi.fn(async (_n: number): Promise<boolean | null> => true)
  const registrarNoPainel = vi.fn(async () => undefined)
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

  it('texto livre com issue que não está aberta: não grava e registra no painel e no log', async () => {
    const m = montar({ issueAberta: vi.fn(async () => false) })

    await processarRespostaDoVinculoDaTarefa(
      { dedupKey: CHAVE, resposta: '#42', opcoes: OPCOES },
      m.deps
    )

    expect(m.gravarVinculo).not.toHaveBeenCalled()
    expect(m.registrarNoPainel).toHaveBeenCalledTimes(1)
    expect(m.onWarn).toHaveBeenCalled()
  })

  it('não deu para conferir a issue no GitHub: não grava (não é aberta até provar) e registra', async () => {
    const m = montar({ issueAberta: vi.fn(async () => null) })

    await processarRespostaDoVinculoDaTarefa(
      { dedupKey: CHAVE, resposta: '#42', opcoes: OPCOES },
      m.deps
    )

    expect(m.gravarVinculo).not.toHaveBeenCalled()
    expect(m.registrarNoPainel).toHaveBeenCalledTimes(1)
  })

  it('texto livre sem número, ou com dois números diferentes: não adivinha, não grava, registra', async () => {
    for (const resposta of ['não sei qual é', 'acho que #42 ou #43']) {
      const m = montar()
      await processarRespostaDoVinculoDaTarefa(
        { dedupKey: CHAVE, resposta, opcoes: OPCOES },
        m.deps
      )
      expect(m.gravarVinculo).not.toHaveBeenCalled()
      expect(m.issueAberta).not.toHaveBeenCalled()
      expect(m.registrarNoPainel).toHaveBeenCalledTimes(1)
    }
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
