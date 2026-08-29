import { describe, it, expect } from 'vitest'
import {
  fraseDoErroDePedido,
  enviarPedido,
  responderDecisao,
  descreverEventoSSE,
  ROTAS,
} from './painel-api'

const fetchQueRetorna = (status: number, body: unknown): typeof fetch =>
  (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch

describe('fraseDoErroDePedido — verbatim do produto', () => {
  it('REPO_SEM_ACESSO', () => {
    expect(fraseDoErroDePedido({ code: 'REPO_SEM_ACESSO' })).toBe(
      'Você não tem mais acesso de escrita a este repositório no GitHub, então não dá para registrar o pedido nele.'
    )
  })
  it('GITHUB_DESCONECTADO', () => {
    expect(fraseDoErroDePedido({ code: 'GITHUB_DESCONECTADO' })).toBe(
      'Sua conexão com o GitHub não vale mais. Reconecte sua conta e mande de novo.'
    )
  })
  it('REPO_NAO_VERIFICAVEL', () => {
    expect(fraseDoErroDePedido({ code: 'REPO_NAO_VERIFICAVEL' })).toBe(
      'Não consegui confirmar no GitHub que este repositório ainda é seu. Tente de novo em instantes.'
    )
  })
  it('413 mostra o limite real formatado em pt-BR', () => {
    expect(fraseDoErroDePedido({ status: 413, corpo: { limite: 60000 } })).toContain('60.000')
  })
  it('404', () => {
    expect(fraseDoErroDePedido({ status: 404 })).toBe('Projeto não encontrado.')
  })
  it('400', () => {
    expect(fraseDoErroDePedido({ status: 400 })).toBe(
      'Escreva o que precisa acontecer antes de pedir.'
    )
  })
  it('fallback genérico', () => {
    expect(fraseDoErroDePedido({ status: 500 })).toBe('Não consegui registrar o pedido agora.')
  })
})

describe('enviarPedido', () => {
  it('201 devolve ok + número + endereço', async () => {
    const r = await enviarPedido({
      projectId: 'p1',
      texto: 'oi',
      fetchImpl: fetchQueRetorna(201, { numero: 7, endereco: '#' }),
    })
    expect(r).toEqual({ ok: true, numero: 7, endereco: '#' })
  })
  it('403 REPO_SEM_ACESSO vira a frase certa e ok:false', async () => {
    const r = await enviarPedido({
      projectId: 'p1',
      texto: 'oi',
      fetchImpl: fetchQueRetorna(403, { code: 'REPO_SEM_ACESSO' }),
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.erro).toContain('acesso de escrita')
  })
  it('502 cai no fallback', async () => {
    const r = await enviarPedido({
      projectId: 'p1',
      texto: 'oi',
      fetchImpl: fetchQueRetorna(502, {}),
    })
    expect(r).toEqual({ ok: false, erro: 'Não consegui registrar o pedido agora.' })
  })
})

describe('responderDecisao', () => {
  it('200 devolve a resposta', async () => {
    const r = await responderDecisao('d1', 'Sim', {
      fetchImpl: fetchQueRetorna(200, { answer: 'Sim' }),
    })
    expect(r).toEqual({ ok: true, resposta: 'Sim' })
  })
  it('409 devolve a resposta que já veio pelo Telegram', async () => {
    const r = await responderDecisao('d1', 'Sim', {
      fetchImpl: fetchQueRetorna(409, { answer: 'Não' }),
    })
    expect(r).toEqual({
      ok: false,
      jaRespondida: 'Não',
      erro: 'Essa decisão já foi respondida pelo Telegram.',
    })
  })
  it('404 diz que a decisão sumiu', async () => {
    const r = await responderDecisao('d1', 'Sim', { fetchImpl: fetchQueRetorna(404, {}) })
    expect(r).toEqual({ ok: false, erro: 'Essa decisão não existe mais.' })
  })
  it('outro erro cai no fallback', async () => {
    const r = await responderDecisao('d1', 'Sim', { fetchImpl: fetchQueRetorna(500, {}) })
    expect(r).toEqual({ ok: false, erro: 'Não consegui enviar a resposta agora.' })
  })
})

describe('descreverEventoSSE', () => {
  it('usa a descrição do payload', () => {
    expect(descreverEventoSSE(JSON.stringify({ descricao: 'Jules subiu algo' }))).toBe(
      'Jules subiu algo'
    )
  })
  it('cai em message quando não há descrição', () => {
    expect(descreverEventoSSE(JSON.stringify({ message: 'algo' }))).toBe('algo')
  })
  it('payload sem nada útil cai na frase neutra', () => {
    expect(descreverEventoSSE('{}')).toBe('Movimento novo na esteira')
  })
  it('payload quebrado não lança', () => {
    expect(descreverEventoSSE('nao é json')).toBe('Movimento novo na esteira')
  })
})

describe('ROTAS', () => {
  it('responder monta o caminho com o id', () => {
    expect(ROTAS.responder('abc')).toBe('/api/v1/painel/decisoes/abc/responder')
  })
  it('as rotas novas têm o prefixo /api/v1/painel', () => {
    expect(ROTAS.pulso).toBe('/api/v1/painel/pulso')
    expect(ROTAS.agentes).toBe('/api/v1/painel/agentes')
  })
})
