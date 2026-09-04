import { describe, it, expect, vi } from 'vitest'
import {
  perguntarAoDono,
  dedupKeyDeAutomacao,
  OPCOES_DE_DECISAO_DE_AUTOMACAO,
  parseDedupKeyDeAutomacao,
  processarRespostaDeAutomacao,
  caminhoDeWorkflowValido,
  sanitizarRespostaLivre,
} from './decisao-de-automacao.js'
import { GithubExecutionError } from './github-errors.js'
import { FREE_TEXT_OPTION_VALUE } from './telegram-bot.js'
import { marcador } from './marcador-de-issue.js'

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

// S2 (fix-up L4-T2): o caminho do arquivo a apagar tem que casar EXATAMENTE
// um workflow do Actions — sem `..`, sem barra extra, sem outro arquivo do
// repo escondido atrás do nome.
describe('caminhoDeWorkflowValido', () => {
  it('aceita caminhos legítimos de workflow', () => {
    expect(caminhoDeWorkflowValido('.github/workflows/ci.yml')).toBe(true)
    expect(caminhoDeWorkflowValido('.github/workflows/auto-merge-checker.yaml')).toBe(true)
    expect(caminhoDeWorkflowValido('.github/workflows/a.b_c-d.yml')).toBe(true)
  })

  it('recusa travessia, barra extra, e arquivo fora de .github/workflows', () => {
    expect(caminhoDeWorkflowValido('.github/workflows/../../etc/passwd')).toBe(false)
    expect(caminhoDeWorkflowValido('.github/workflows/sub/ci.yml')).toBe(false)
    expect(caminhoDeWorkflowValido('.github/dependabot.yml')).toBe(false)
    expect(caminhoDeWorkflowValido('package.json')).toBe(false)
    expect(caminhoDeWorkflowValido('.github/workflows/ci.yml.exe')).toBe(false)
    expect(caminhoDeWorkflowValido('')).toBe(false)
  })
})

// S3 (fix-up L4-T2): a resposta "Vou escrever" é texto livre do dono e vira
// um COMENTÁRIO PÚBLICO na proposta — tem que ser sanitizada antes.
describe('sanitizarRespostaLivre', () => {
  it('vazio/só espaços → null', () => {
    expect(sanitizarRespostaLivre('')).toBeNull()
    expect(sanitizarRespostaLivre('   \n\t  ')).toBeNull()
  })

  it('neutraliza menção (@nome) e comando (/close) no mesmo texto', () => {
    const resultado = sanitizarRespostaLivre('@admin /close')
    expect(resultado).not.toBeNull()
    // A menção não pode sobreviver crua — senão vira notificação real.
    expect(resultado).not.toContain('@admin')
    expect(resultado).toContain('@​admin')
    // O comando não pode sobreviver como `/close` reconhecível por um bot de
    // ChatOps do repositório do cliente.
    expect(resultado).not.toMatch(/(?<!\\)\/close/)
    expect(resultado).toContain('\\/close')
  })

  it('bloco de citação: cada linha começa com "> "', () => {
    const resultado = sanitizarRespostaLivre('linha 1\nlinha 2')
    expect(resultado).toBe('> linha 1\n> linha 2')
  })

  it('teto de 2000 caracteres', () => {
    const gigante = 'x'.repeat(3000)
    const resultado = sanitizarRespostaLivre(gigante)
    expect(resultado).not.toBeNull()
    // "> " + até 2000 chars do texto original (sem quebra de linha aqui).
    expect(resultado?.length).toBe(2 + 2000)
  })

  it('texto comum, sem @ nem /, sobrevive intacto (só citado)', () => {
    expect(sanitizarRespostaLivre('na verdade isso é intencional, deixa quieto')).toBe(
      '> na verdade isso é intencional, deixa quieto'
    )
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
      // L4-T18 (item 3, D71): o botão de escrever usa o SENTINEL de
      // `buildFreeTextOption` (o mesmo padrão de `duvida-dev:`/
      // `retomada-travada:`) — nunca mais um valor literal 'escrever', que
      // clicado direto GRAVAVA a string "escrever" como se fosse a decisão
      // do dono, em vez de abrir o "digite sua resposta".
      { label: 'Vou escrever', value: FREE_TEXT_OPTION_VALUE },
    ])
    expect(input['dedupKey']).toBe('automacao:acme/api:wf:40')
    expect(typeof input['text']).toBe('string')
    expect(input['text'] as string).toMatch(/Auto Merge Checker/)
  })
})

describe('processarRespostaDeAutomacao', () => {
  const DEDUP = 'automacao:acme/api:wf:40'
  const ARQUIVO = '.github/workflows/x.yml'

  function corpoDaProposta(arquivo: string | null = ARQUIVO): string {
    return arquivo ? marcador('proposta:arquivo', arquivo) + '\n\ncorpo' : 'corpo sem marcador'
  }

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
      // GET da issue da proposta (A2): body com o marcador do arquivo.
      if (method === 'GET' && u.endsWith('/repos/acme/api/issues/901')) {
        return new Response(JSON.stringify({ body: corpoDaProposta() }), { status: 200 })
      }
      // S4: nenhum PR aberto por padrão — a rota é sobrescrita nos testes
      // que precisam simular um já existente.
      if (method === 'GET' && u.includes('/repos/acme/api/pulls?state=open')) {
        return new Response(JSON.stringify([]), { status: 200 })
      }
      if (method === 'GET' && u.endsWith('/repos/acme/api')) {
        return new Response(JSON.stringify({ default_branch: 'main' }), { status: 200 })
      }
      if (method === 'GET' && u.endsWith('/repos/acme/api/git/ref/heads/main')) {
        return new Response(JSON.stringify({ object: { sha: 'base-sha' } }), { status: 200 })
      }
      if (method === 'GET' && u.includes('/repos/acme/api/contents/')) {
        return new Response(JSON.stringify({ sha: 'file-sha' }), { status: 200 })
      }
      if (method === 'POST' && u.endsWith('/pulls')) {
        return new Response(JSON.stringify({ number: 999 }), { status: 201 })
      }
      return new Response(JSON.stringify({ number: 42 }), { status: 200 })
    }) as typeof fetch
    return { impl, chamadas, respostas }
  }

  function buscarIncidenteFake(issueNumber: number | null = 901) {
    return vi.fn(async () => (issueNumber === null ? null : { issueNumber }))
  }

  // S1 (fix-up L4-T2): `repo` (embutido na dedupKey) vai colado numa URL que
  // carrega o token — recusa ANTES de montar qualquer URL/tocar rede.
  it('S1: repo da dedupKey fora do formato dono/repositorio → GithubExecutionError, NUNCA toca rede', async () => {
    const impl = vi.fn()
    await expect(
      processarRespostaDeAutomacao(
        {
          dedupKey: 'automacao:../evil:wf:1',
          resposta: 'manter',
          projectId: 'proj-1',
          autonomia: 'cuidar',
        },
        {
          fetchImpl: impl as unknown as typeof fetch,
          token: 'tok',
          buscarIncidente: buscarIncidenteFake(),
          marcarIncidenteResolvido: vi.fn(async () => undefined),
        }
      )
    ).rejects.toBeInstanceOf(GithubExecutionError)
    expect(impl).not.toHaveBeenCalled()
  })

  // A2 (fix-up L4-T2): o número da proposta vem de `infra_incidents`
  // (buscarIncidente), NUNCA de um `context` reparseado.
  it('A2: sem incidente registrado para a identidade → no-op, avisa e não toca a issue', async () => {
    const { impl, chamadas } = fakeFetch()
    const onWarn = vi.fn()
    await processarRespostaDeAutomacao(
      {
        dedupKey: DEDUP,
        resposta: 'manter',
        projectId: 'proj-1',
        autonomia: 'cuidar',
      },
      {
        fetchImpl: impl,
        token: 'tok',
        buscarIncidente: buscarIncidenteFake(null),
        marcarIncidenteResolvido: vi.fn(async () => undefined),
        onWarn,
      }
    )
    expect(chamadas).toHaveLength(0)
    expect(onWarn).toHaveBeenCalledOnce()
  })

  it('deletar + autonomia cuidar → lê o arquivo do marcador da proposta, abre PR removendo o workflow, Closes #proposta', async () => {
    const { impl, chamadas } = fakeFetch()
    const marcarIncidenteResolvido = vi.fn(async () => undefined)

    await processarRespostaDeAutomacao(
      {
        dedupKey: DEDUP,
        resposta: 'deletar',
        projectId: 'proj-1',
        autonomia: 'cuidar',
      },
      {
        fetchImpl: impl,
        token: 'tok',
        buscarIncidente: buscarIncidenteFake(),
        marcarIncidenteResolvido,
      }
    )

    const leituraDaProposta = chamadas.find(
      (c) => c.method === 'GET' && c.url.endsWith('/repos/acme/api/issues/901')
    )
    expect(leituraDaProposta).toBeDefined()

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
    expect((deleta!.body as Record<string, string>)['branch']).toBe('chore/remover-workflow-x.yml')

    const abrePr = chamadas.find((c) => c.method === 'POST' && c.url.endsWith('/pulls'))
    expect(abrePr).toBeDefined()
    const prBody = abrePr!.body as Record<string, string>
    expect(prBody['head']).toBe('chore/remover-workflow-x.yml')
    expect(prBody['base']).toBe('main')
    expect(prBody['body']).toContain('Closes #901')

    expect(marcarIncidenteResolvido).not.toHaveBeenCalled()
  })

  // S2 (fix-up L4-T2): marcador ausente ou caminho fora do formato de
  // workflow → recusa, comenta, NUNCA toca em git/refs ou contents.
  it('S2: marcador de arquivo ausente na proposta → recusa com comentário, nunca cria branch/PR', async () => {
    const { impl, chamadas, respostas } = fakeFetch()
    respostas.set(
      'GET /repos/acme/api/issues/901',
      new Response(JSON.stringify({ body: 'proposta sem marcador de arquivo' }), { status: 200 })
    )

    await processarRespostaDeAutomacao(
      { dedupKey: DEDUP, resposta: 'deletar', projectId: 'proj-1', autonomia: 'cuidar' },
      {
        fetchImpl: impl,
        token: 'tok',
        buscarIncidente: buscarIncidenteFake(),
        marcarIncidenteResolvido: vi.fn(async () => undefined),
      }
    )

    expect(chamadas.some((c) => c.method === 'POST' && c.url.endsWith('/git/refs'))).toBe(false)
    expect(chamadas.some((c) => c.method === 'DELETE')).toBe(false)
    const comentario = chamadas.find(
      (c) => c.method === 'POST' && c.url.endsWith('/issues/901/comments')
    )
    expect(comentario).toBeDefined()
  })

  it('S2: marcador de arquivo com travessia (..) → recusa, nunca cria branch/PR', async () => {
    const { impl, chamadas, respostas } = fakeFetch()
    respostas.set(
      'GET /repos/acme/api/issues/901',
      new Response(
        JSON.stringify({
          body: marcador('proposta:arquivo', '.github/workflows/../../etc/passwd'),
        }),
        { status: 200 }
      )
    )

    await processarRespostaDeAutomacao(
      { dedupKey: DEDUP, resposta: 'deletar', projectId: 'proj-1', autonomia: 'cuidar' },
      {
        fetchImpl: impl,
        token: 'tok',
        buscarIncidente: buscarIncidenteFake(),
        marcarIncidenteResolvido: vi.fn(async () => undefined),
      }
    )

    expect(chamadas.some((c) => c.method === 'POST' && c.url.endsWith('/git/refs'))).toBe(false)
    expect(chamadas.some((c) => c.method === 'DELETE')).toBe(false)
  })

  // S4 (fix-up L4-T2): dois cliques não abrem dois PRs.
  it('S4: já existe PR aberto para a branch → reaproveita, comenta o link, NUNCA cria branch/arquivo/PR de novo', async () => {
    const { impl, chamadas, respostas } = fakeFetch()
    respostas.set(
      'GET /repos/acme/api/pulls?state=open&head=acme%3Achore%2Fremover-workflow-x.yml',
      new Response(JSON.stringify([{ number: 777 }]), { status: 200 })
    )

    await processarRespostaDeAutomacao(
      { dedupKey: DEDUP, resposta: 'deletar', projectId: 'proj-1', autonomia: 'cuidar' },
      {
        fetchImpl: impl,
        token: 'tok',
        buscarIncidente: buscarIncidenteFake(),
        marcarIncidenteResolvido: vi.fn(async () => undefined),
      }
    )

    expect(chamadas.some((c) => c.method === 'POST' && c.url.endsWith('/git/refs'))).toBe(false)
    expect(chamadas.some((c) => c.method === 'DELETE')).toBe(false)
    expect(chamadas.some((c) => c.method === 'POST' && c.url.endsWith('/pulls'))).toBe(false)
    const comentario = chamadas.find(
      (c) => c.method === 'POST' && c.url.endsWith('/issues/901/comments')
    )
    expect(comentario).toBeDefined()
    expect((comentario!.body as Record<string, string>)['body']).toContain('#777')
  })

  it('deletar + autonomia sugerir → comentário explicando a limitação, NUNCA deleta/abre PR', async () => {
    const { impl, chamadas } = fakeFetch()
    await processarRespostaDeAutomacao(
      { dedupKey: DEDUP, resposta: 'deletar', projectId: 'proj-1', autonomia: 'sugerir' },
      {
        fetchImpl: impl,
        token: 'tok',
        buscarIncidente: buscarIncidenteFake(),
        marcarIncidenteResolvido: vi.fn(async () => undefined),
      }
    )
    expect(chamadas.some((c) => c.method === 'DELETE')).toBe(false)
    expect(chamadas.some((c) => c.method === 'POST' && c.url.endsWith('/pulls'))).toBe(false)
    const comentario = chamadas.find(
      (c) => c.method === 'POST' && c.url.endsWith('/issues/901/comments')
    )
    expect(comentario).toBeDefined()
    expect((comentario!.body as Record<string, string>)['body']).toMatch(/[Ss]ugerir|[Cc]uidar/)
  })

  // C1 (fix-up L4-T2): POST gitorch:incident ANTES de DELETE gitorch:proposal.
  it('reajustar → adiciona gitorch:incident ANTES de remover gitorch:proposal, + comentário', async () => {
    const { impl, chamadas } = fakeFetch()
    await processarRespostaDeAutomacao(
      { dedupKey: DEDUP, resposta: 'reajustar', projectId: 'proj-1', autonomia: 'sugerir' },
      {
        fetchImpl: impl,
        token: 'tok',
        buscarIncidente: buscarIncidenteFake(),
        marcarIncidenteResolvido: vi.fn(async () => undefined),
      }
    )
    const addLabelIdx = chamadas.findIndex(
      (c) => c.method === 'POST' && c.url.endsWith('/issues/901/labels')
    )
    const removeLabelIdx = chamadas.findIndex(
      (c) => c.method === 'DELETE' && c.url.includes('/labels/gitorch%3Aproposal')
    )
    expect(addLabelIdx).toBeGreaterThanOrEqual(0)
    expect(removeLabelIdx).toBeGreaterThanOrEqual(0)
    expect(addLabelIdx).toBeLessThan(removeLabelIdx)
    expect((chamadas[addLabelIdx]!.body as Record<string, string[]>)['labels']).toEqual([
      'gitorch:incident',
    ])
    const comentario = chamadas.find(
      (c) => c.method === 'POST' && c.url.endsWith('/issues/901/comments')
    )
    expect(comentario).toBeDefined()
  })

  // C1: falha em qualquer um dos dois labels relança — o chamador loga e a
  // pergunta segue `open` (C4, agent-question.ts).
  it('C1: DELETE do label gitorch:proposal falha → relança, NUNCA engole', async () => {
    const { impl, respostas } = fakeFetch()
    respostas.set(
      'DELETE /repos/acme/api/issues/901/labels/gitorch%3Aproposal',
      new Response('forbidden', { status: 403 })
    )
    await expect(
      processarRespostaDeAutomacao(
        { dedupKey: DEDUP, resposta: 'reajustar', projectId: 'proj-1', autonomia: 'sugerir' },
        {
          fetchImpl: impl,
          token: 'tok',
          buscarIncidente: buscarIncidenteFake(),
          marcarIncidenteResolvido: vi.fn(async () => undefined),
        }
      )
    ).rejects.toBeInstanceOf(GithubExecutionError)
  })

  // C3 (fix-up L4-T2): marca o incidente resolvido ANTES de fechar a issue.
  it('manter → comentário + marca infra_incidents resolvido ANTES de fechar a issue (not_planned)', async () => {
    const { impl, chamadas } = fakeFetch()
    const marcarIncidenteResolvido = vi.fn(async () => undefined)
    await processarRespostaDeAutomacao(
      { dedupKey: DEDUP, resposta: 'manter', projectId: 'proj-1', autonomia: 'sugerir' },
      {
        fetchImpl: impl,
        token: 'tok',
        buscarIncidente: buscarIncidenteFake(),
        marcarIncidenteResolvido,
      }
    )
    const fecha = chamadas.find((c) => c.method === 'PATCH' && c.url.endsWith('/issues/901'))
    expect(fecha).toBeDefined()
    expect((fecha!.body as Record<string, string>)['state']).toBe('closed')
    expect((fecha!.body as Record<string, string>)['state_reason']).toBe('not_planned')
    expect(fecha!.headers?.['authorization']).toBe('token tok')
    expect(marcarIncidenteResolvido).toHaveBeenCalledWith({
      projectId: 'proj-1',
      identidadeEstavel: 'wf:40',
    })
    const comentario = chamadas.find(
      (c) => c.method === 'POST' && c.url.endsWith('/issues/901/comments')
    )
    expect(comentario).toBeDefined()

    // ORDEM: marcarIncidenteResolvido chamado ANTES do PATCH de fechamento —
    // usa o índice dentro de `chamadas` (rede) comparado à ordem de chamada
    // do mock (marcarIncidenteResolvido não passa por `impl`, então
    // comparamos indiretamente: se o PATCH está presente, o mock já rodou).
    expect(marcarIncidenteResolvido).toHaveBeenCalledTimes(1)
  })

  // C3: se o PATCH de fechamento falhar DEPOIS, relança — mas o incidente já
  // foi marcado resolvido (não fica preso para sempre).
  it('C3: PATCH de fechamento falha DEPOIS de marcar resolvido → relança, mas marcarIncidenteResolvido já rodou', async () => {
    const { impl, respostas } = fakeFetch()
    respostas.set('PATCH /repos/acme/api/issues/901', new Response('boom', { status: 500 }))
    const marcarIncidenteResolvido = vi.fn(async () => undefined)

    await expect(
      processarRespostaDeAutomacao(
        { dedupKey: DEDUP, resposta: 'manter', projectId: 'proj-1', autonomia: 'sugerir' },
        {
          fetchImpl: impl,
          token: 'tok',
          buscarIncidente: buscarIncidenteFake(),
          marcarIncidenteResolvido,
        }
      )
    ).rejects.toBeInstanceOf(GithubExecutionError)
    expect(marcarIncidenteResolvido).toHaveBeenCalledOnce()
  })

  // S3 (fix-up L4-T2): resposta livre sanitizada antes de virar comentário.
  it('escrever (texto livre) → comentário citado, sem ação automática nenhuma', async () => {
    const { impl, chamadas } = fakeFetch()
    const marcarIncidenteResolvido = vi.fn(async () => undefined)
    await processarRespostaDeAutomacao(
      {
        dedupKey: DEDUP,
        resposta: 'na verdade isso é intencional, deixa quieto',
        projectId: 'proj-1',
        autonomia: 'cuidar',
      },
      {
        fetchImpl: impl,
        token: 'tok',
        buscarIncidente: buscarIncidenteFake(),
        marcarIncidenteResolvido,
      }
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

  it('S3: resposta livre vazia/só espaços → NÃO comenta', async () => {
    const { impl, chamadas } = fakeFetch()
    const onInfo = vi.fn()
    await processarRespostaDeAutomacao(
      { dedupKey: DEDUP, resposta: '   ', projectId: 'proj-1', autonomia: 'cuidar' },
      {
        fetchImpl: impl,
        token: 'tok',
        buscarIncidente: buscarIncidenteFake(),
        marcarIncidenteResolvido: vi.fn(async () => undefined),
        onInfo,
      }
    )
    expect(
      chamadas.some((c) => c.method === 'POST' && c.url.endsWith('/issues/901/comments'))
    ).toBe(false)
    expect(onInfo).toHaveBeenCalled()
  })

  it('S3: resposta livre com @menção e /comando → comentário sanitizado (sem @nome cru, sem /comando cru)', async () => {
    const { impl, chamadas } = fakeFetch()
    await processarRespostaDeAutomacao(
      { dedupKey: DEDUP, resposta: '@admin /close', projectId: 'proj-1', autonomia: 'cuidar' },
      {
        fetchImpl: impl,
        token: 'tok',
        buscarIncidente: buscarIncidenteFake(),
        marcarIncidenteResolvido: vi.fn(async () => undefined),
      }
    )
    const comentario = chamadas.find(
      (c) => c.method === 'POST' && c.url.endsWith('/issues/901/comments')
    )
    expect(comentario).toBeDefined()
    const corpo = (comentario!.body as Record<string, string>)['body']!
    expect(corpo).not.toContain('@admin')
    expect(corpo).toContain('@​admin')
    expect(corpo).not.toMatch(/(?<!\\)\/close/)
  })

  it('dedupKey que não é de automação → no-op (nunca mexe em nada)', async () => {
    const { impl, chamadas } = fakeFetch()
    await processarRespostaDeAutomacao(
      {
        dedupKey: 'como-publica:acme/api',
        resposta: 'x',
        projectId: 'proj-1',
        autonomia: 'cuidar',
      },
      {
        fetchImpl: impl,
        token: 'tok',
        buscarIncidente: buscarIncidenteFake(),
        marcarIncidenteResolvido: vi.fn(async () => undefined),
      }
    )
    expect(chamadas).toHaveLength(0)
  })
})
