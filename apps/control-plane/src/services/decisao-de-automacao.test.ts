import { describe, it, expect, vi } from 'vitest'
import {
  perguntarAoDono,
  dedupKeyDeAutomacao,
  OPCOES_DE_DECISAO_DE_AUTOMACAO,
  parseDedupKeyDeAutomacao,
  propostaDoContexto,
  arquivoDoContexto,
  processarRespostaDeAutomacao,
} from './decisao-de-automacao.js'

describe('dedupKeyDeAutomacao / parseDedupKeyDeAutomacao', () => {
  it('monta e desfaz o dedupKey mesmo quando a identidade carrega ":"', () => {
    const chave = dedupKeyDeAutomacao('acme/api', 'wf:40')
    expect(chave).toBe('automacao:acme/api:wf:40')
    expect(parseDedupKeyDeAutomacao(chave)).toEqual({ repo: 'acme/api', identidade: 'wf:40' })
  })

  it('dedupKey que não começa com automacao: → null', () => {
    expect(parseDedupKeyDeAutomacao('outra-coisa:x')).toBeNull()
  })
})

describe('propostaDoContexto / arquivoDoContexto', () => {
  it('extrai o número da proposta e o arquivo do texto de contexto', () => {
    const ctx = 'dispara em "push" · proposta #901 · arquivo:.github/workflows/x.yml'
    expect(propostaDoContexto(ctx)).toBe(901)
    expect(arquivoDoContexto(ctx)).toBe('.github/workflows/x.yml')
  })
  it('contexto nulo/sem match → null', () => {
    expect(propostaDoContexto(null)).toBeNull()
    expect(arquivoDoContexto('nada aqui')).toBeNull()
  })
})

describe('perguntarAoDono', () => {
  it('D71: pergunta em PT-BR com EXATAMENTE 4 opções (deletar/reajustar/manter/escrever) e o dedupKey certo', async () => {
    const ask = vi.fn(async () => ({ deduped: false, question: {} }) as never)
    await perguntarAoDono(
      {
        userId: 'user-1',
        projectId: 'proj-1',
        repo: 'acme/api',
        identidade: 'wf:40',
        nome: 'Auto Merge Checker',
        arquivo: '.github/workflows/auto-merge-checker.yml',
        gatilho: 'push',
        desde: '2026-08-20',
        resumo: 'dispara em "push"',
        numeroProposta: 901,
      },
      { agentQuestion: { ask } }
    )

    expect(ask).toHaveBeenCalledOnce()
    const [userId, projectId, input] = ask.mock.calls[0] as unknown as [
      string,
      string,
      Record<string, unknown>,
    ]
    expect(userId).toBe('user-1')
    expect(projectId).toBe('proj-1')
    expect(input['options']).toEqual(OPCOES_DE_DECISAO_DE_AUTOMACAO)
    expect(input['options']).toEqual([
      { label: 'Deletar o workflow', value: 'deletar' },
      { label: 'Reajustar (vira tarefa)', value: 'reajustar' },
      { label: 'Manter como está', value: 'manter' },
      { label: 'Vou escrever', value: 'escrever' },
    ])
    expect(input['dedupKey']).toBe('automacao:acme/api:wf:40')
    expect(typeof input['text']).toBe('string')
    expect(input['text'] as string).toMatch(/Auto Merge Checker/)
  })
})

describe('processarRespostaDeAutomacao', () => {
  const CONTEXTO = 'dispara em "push" · proposta #901 · arquivo:.github/workflows/x.yml'
  const DEDUP = 'automacao:acme/api:wf:40'

  function fakeFetch() {
    const chamadas: Array<{
      url: string
      method: string
      body?: unknown
      headers?: Record<string, string>
    }> = []
    const respostas = new Map<string, unknown>()
    const impl = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const u = String(url)
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      chamadas.push({ url: u, method, body, headers: init?.headers as Record<string, string> })
      const chave = `${method} ${u.replace(/^https:\/\/api\.github\.com/, '')}`
      const especial = respostas.get(chave)
      if (especial) return especial as Response
      return new Response(JSON.stringify({ number: 42, sha: 'sha-base', default_branch: 'main' }), {
        status: 200,
      })
    }) as typeof fetch
    return { impl, chamadas, respostas }
  }

  it('deletar + autonomia cuidar → abre PR removendo o arquivo do workflow (branch + delete + PR), Closes #proposta', async () => {
    const { impl, chamadas, respostas } = fakeFetch()
    respostas.set(
      'GET /repos/acme/api',
      new Response(JSON.stringify({ default_branch: 'main' }), { status: 200 })
    )
    respostas.set(
      'GET /repos/acme/api/git/ref/heads/main',
      new Response(JSON.stringify({ object: { sha: 'base-sha' } }), { status: 200 })
    )
    respostas.set(
      'GET /repos/acme/api/contents/.github%2Fworkflows%2Fx.yml?ref=main',
      new Response(JSON.stringify({ sha: 'file-sha' }), { status: 200 })
    )
    respostas.set(
      'POST /repos/acme/api/pulls',
      new Response(JSON.stringify({ number: 999 }), { status: 201 })
    )
    const marcarIncidenteResolvido = vi.fn(async () => undefined)

    await processarRespostaDeAutomacao(
      {
        dedupKey: DEDUP,
        context: CONTEXTO,
        resposta: 'deletar',
        projectId: 'proj-1',
        autonomia: 'cuidar',
      },
      { fetchImpl: impl, token: 'tok', marcarIncidenteResolvido }
    )

    const criarRef = chamadas.find((c) => c.method === 'POST' && c.url.endsWith('/git/refs'))
    expect(criarRef).toBeDefined()
    expect((criarRef!.body as Record<string, string>)['ref']).toBe(
      'refs/heads/chore/remover-workflow-x.yml'
    )
    expect((criarRef!.body as Record<string, string>)['sha']).toBe('base-sha')

    const deleta = chamadas.find(
      (c) => c.method === 'DELETE' && c.url.includes('/contents/.github%2Fworkflows%2Fx.yml')
    )
    expect(deleta).toBeDefined()
    expect((deleta!.body as Record<string, string>)['sha']).toBe('file-sha')
    expect((deleta!.body as Record<string, string>)['branch']).toBe('chore/remover-workflow-x.yml')

    const abrePr = chamadas.find((c) => c.method === 'POST' && c.url.endsWith('/pulls'))
    expect(abrePr).toBeDefined()
    const prBody = abrePr!.body as Record<string, string>
    expect(prBody['head']).toBe('chore/remover-workflow-x.yml')
    expect(prBody['base']).toBe('main')
    expect(prBody['body']).toContain('Closes #901')

    expect(marcarIncidenteResolvido).not.toHaveBeenCalled()
  })

  it('deletar + autonomia sugerir → comentário explicando a limitação, NUNCA deleta/abre PR', async () => {
    const { impl, chamadas } = fakeFetch()
    await processarRespostaDeAutomacao(
      {
        dedupKey: DEDUP,
        context: CONTEXTO,
        resposta: 'deletar',
        projectId: 'proj-1',
        autonomia: 'sugerir',
      },
      { fetchImpl: impl, token: 'tok', marcarIncidenteResolvido: vi.fn(async () => undefined) }
    )
    expect(chamadas.some((c) => c.method === 'DELETE')).toBe(false)
    expect(chamadas.some((c) => c.method === 'POST' && c.url.endsWith('/pulls'))).toBe(false)
    const comentario = chamadas.find(
      (c) => c.method === 'POST' && c.url.endsWith('/issues/901/comments')
    )
    expect(comentario).toBeDefined()
    expect((comentario!.body as Record<string, string>)['body']).toMatch(/[Ss]ugerir|[Cc]uidar/)
  })

  it('reajustar → troca gitorch:proposal por gitorch:incident + comentário', async () => {
    const { impl, chamadas } = fakeFetch()
    await processarRespostaDeAutomacao(
      {
        dedupKey: DEDUP,
        context: CONTEXTO,
        resposta: 'reajustar',
        projectId: 'proj-1',
        autonomia: 'sugerir',
      },
      { fetchImpl: impl, token: 'tok', marcarIncidenteResolvido: vi.fn(async () => undefined) }
    )
    const removeLabel = chamadas.find(
      (c) => c.method === 'DELETE' && c.url.includes('/labels/gitorch%3Aproposal')
    )
    expect(removeLabel).toBeDefined()
    const addLabel = chamadas.find(
      (c) => c.method === 'POST' && c.url.endsWith('/issues/901/labels')
    )
    expect(addLabel).toBeDefined()
    expect((addLabel!.body as Record<string, string[]>)['labels']).toEqual(['gitorch:incident'])
    const comentario = chamadas.find(
      (c) => c.method === 'POST' && c.url.endsWith('/issues/901/comments')
    )
    expect(comentario).toBeDefined()
  })

  it('manter → comentário + fecha not_planned + marca infra_incidents resolvido', async () => {
    const { impl, chamadas } = fakeFetch()
    const marcarIncidenteResolvido = vi.fn(async () => undefined)
    await processarRespostaDeAutomacao(
      {
        dedupKey: DEDUP,
        context: CONTEXTO,
        resposta: 'manter',
        projectId: 'proj-1',
        autonomia: 'sugerir',
      },
      { fetchImpl: impl, token: 'tok', marcarIncidenteResolvido }
    )
    const fecha = chamadas.find((c) => c.method === 'PATCH' && c.url.endsWith('/issues/901'))
    expect(fecha).toBeDefined()
    expect((fecha!.body as Record<string, string>)['state']).toBe('closed')
    expect((fecha!.body as Record<string, string>)['state_reason']).toBe('not_planned')
    // Bug real pego na revisão: as chamadas tinham que carregar autenticação
    // (sem isto, toda chamada real ao GitHub voltaria 401/anônima).
    expect(fecha!.headers?.['authorization']).toBe('token tok')
    expect(marcarIncidenteResolvido).toHaveBeenCalledWith({
      projectId: 'proj-1',
      identidadeEstavel: 'wf:40',
    })
    const comentario = chamadas.find(
      (c) => c.method === 'POST' && c.url.endsWith('/issues/901/comments')
    )
    expect(comentario).toBeDefined()
  })

  it('escrever (texto livre) → comentário com o texto, sem ação automática nenhuma', async () => {
    const { impl, chamadas } = fakeFetch()
    const marcarIncidenteResolvido = vi.fn(async () => undefined)
    await processarRespostaDeAutomacao(
      {
        dedupKey: DEDUP,
        context: CONTEXTO,
        resposta: 'na verdade isso é intencional, deixa quieto',
        projectId: 'proj-1',
        autonomia: 'cuidar',
      },
      { fetchImpl: impl, token: 'tok', marcarIncidenteResolvido }
    )
    expect(chamadas.some((c) => c.method === 'DELETE')).toBe(false)
    expect(chamadas.some((c) => c.method === 'PATCH')).toBe(false)
    expect(marcarIncidenteResolvido).not.toHaveBeenCalled()
    const comentario = chamadas.find(
      (c) => c.method === 'POST' && c.url.endsWith('/issues/901/comments')
    )
    expect(comentario).toBeDefined()
    expect((comentario!.body as Record<string, string>)['body']).toContain(
      'na verdade isso é intencional, deixa quieto'
    )
  })

  it('dedupKey que não é de automação → no-op (nunca mexe em nada)', async () => {
    const { impl, chamadas } = fakeFetch()
    await processarRespostaDeAutomacao(
      {
        dedupKey: 'como-publica:acme/api',
        context: null,
        resposta: 'x',
        projectId: 'proj-1',
        autonomia: 'cuidar',
      },
      { fetchImpl: impl, token: 'tok', marcarIncidenteResolvido: vi.fn(async () => undefined) }
    )
    expect(chamadas).toHaveLength(0)
  })
})
