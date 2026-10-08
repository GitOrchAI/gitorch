import { describe, it, expect, vi } from 'vitest'
import type { InfraIssueForm } from '@gitorch/cadence'
import {
  HISTORICO_MAXIMO_DE_ITENS,
  JANELA_DE_EDICAO_HUMANA_MS,
  TITULO_MAXIMO,
  acrescentarAoHistorico,
  ajusteDeTarefaLigado,
  avaliarSePodeReescrever,
  cercaDeCodigoAberta,
  desfazerAjusteDeTarefa,
  detalhesBalanceadosEmOrdem,
  extrairReferencias,
  reescreverTarefa,
  validarAjusteDeTarefa,
  type DepsDoAplicador,
  type DepsDoDesfazer,
  type IssueNoGitHub,
} from './aplicar-ajuste-de-tarefa.js'
import { conferirTarefaSemPedido, hashDoCorpoDaTarefa } from './conferir-tarefa-sem-pedido.js'

const AGORA = new Date('2026-10-08T12:00:00.000Z')
const HORAS = (h: number) => new Date(AGORA.getTime() - h * 3_600_000)

const ORIGINAL_TITULO = 'ajustar o cache'
const ORIGINAL_CORPO = [
  '<!-- gitorch:node:5:task:2 -->',
  '',
  'Precisamos mexer no cache da sessão (ver #123 e o PR #130).',
  'Detalhes em https://exemplo.com/doc/cache e em acme/outro#7.',
  '',
  '## Peso',
  '',
  '**5** (escala 1, 2, 3, 5, 8, 13)',
  '',
  'por causa do invalidador',
].join('\n')

function formulario(sobrescrever: Partial<InfraIssueForm['fields']> = {}): InfraIssueForm {
  return {
    fields: {
      titulo: 'Corrigir o cache de sessão',
      goal: 'Cache de sessão deixa de servir dado velho (#123).',
      taskDetails: 'Invalidar ao trocar de usuário. Contexto: https://exemplo.com/doc/cache',
      taskDescription: 'Mexer no invalidador; PR #130 já mexeu perto. Ver acme/outro#7.',
      implementationGuide: '1. ler o invalidador\n2. trocar a chave',
      verificationCriteria: '- pnpm test passa\n- o cache invalida ao trocar de usuário',
      dependencies: 'nenhuma',
      relatedFiles: 'src/cache.ts',
      notes: 'sem notas',
      ...sobrescrever,
    },
  }
}

describe('extrairReferencias', () => {
  it('acha #N, repo#N, links soltos e alvos de link markdown', () => {
    const refs = extrairReferencias(
      'ver #12 e acme/api#7, https://x.com/a?b=1#frag. [doc](docs/a.md) e ![img](http://i.png).'
    )
    expect(refs).toEqual(
      expect.arrayContaining([
        '#12',
        'acme/api#7',
        'https://x.com/a?b=1#frag',
        'docs/a.md',
        'http://i.png',
      ])
    )
  })

  it('não confunde #12 com #123 nem conta o # de cabeçalho ou de âncora de link', () => {
    expect(extrairReferencias('## Goal\n\nver #123')).toEqual(['#123'])
    expect(extrairReferencias('veja https://x.com/p#12')).toEqual(['https://x.com/p#12'])
  })
})

describe('validarAjusteDeTarefa', () => {
  const base = { tituloOriginal: ORIGINAL_TITULO, corpoOriginal: ORIGINAL_CORPO }

  it('aceita o formulário completo e monta o corpo com o original inteiro num bloco recolhido', () => {
    const r = validarAjusteDeTarefa({ ...base, form: formulario() })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.titulo).toBe('Corrigir o cache de sessão')
    expect(r.corpo).toContain('<details><summary>Texto original</summary>')
    expect(r.corpo).toContain('</details>')
    expect(r.corpo).toContain(ORIGINAL_CORPO)
    expect(r.corpo).toContain(ORIGINAL_TITULO)
    // o marcador do nó continua na raiz do corpo, fora do bloco recolhido
    expect(r.corpo.split('<details>')[0]).toContain('<!-- gitorch:node:5:task:2 -->')
    // o peso do original segue como seção própria
    expect(r.corpo.split('<details>')[0]).toContain('**5**')
  })

  it('o corpo novo passa na MESMA conferência do sistema (ida e volta)', () => {
    const r = validarAjusteDeTarefa({ ...base, form: formulario() })
    if (!r.ok) throw new Error(r.motivo)
    const c = conferirTarefaSemPedido({
      titulo: r.titulo,
      corpo: r.corpo,
      estaNoQuadro: true,
      estaNaSprintAtual: null,
    })
    expect(c.padraoOk).toBe(true)
    expect(c.peso).toBe(5)
  })

  it.each([
    ['goal', { goal: '' }],
    ['taskDetails', { taskDetails: '   ' }],
    ['relatedFiles', { relatedFiles: '' }],
    ['notes', { notes: '' }],
  ])('recusa campo vazio (%s)', (_nome, sobrescrever) => {
    const r = validarAjusteDeTarefa({ ...base, form: formulario(sobrescrever) })
    expect(r.ok).toBe(false)
  })

  it('recusa título vazio e título acima do limite', () => {
    expect(validarAjusteDeTarefa({ ...base, form: formulario({ titulo: '  ' }) }).ok).toBe(false)
    const longo = validarAjusteDeTarefa({
      ...base,
      form: formulario({ titulo: 'x'.repeat(TITULO_MAXIMO + 1) }),
    })
    expect(longo.ok).toBe(false)
  })

  it('recusa título com quebra de linha', () => {
    expect(validarAjusteDeTarefa({ ...base, form: formulario({ titulo: 'a\nb' }) }).ok).toBe(false)
  })

  it('recusa quando uma referência #N do original some do texto novo', () => {
    const r = validarAjusteDeTarefa({
      ...base,
      form: formulario({ goal: 'Cache deixa de servir dado velho.' }), // sumiu #123
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.motivo).toContain('#123')
  })

  it('não conta como preservada a referência que só aparece no bloco do original', () => {
    // #123 está no bloco recolhido (original inteiro), mas o texto novo a perdeu
    const r = validarAjusteDeTarefa({
      ...base,
      form: formulario({ goal: 'sem referência alguma' }),
    })
    expect(r.ok).toBe(false)
  })

  it('recusa quando um link do original some', () => {
    const r = validarAjusteDeTarefa({
      ...base,
      form: formulario({ taskDetails: 'sem o link' }),
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.motivo).toContain('https://exemplo.com/doc/cache')
  })

  it('recusa quando a referência entre repositórios some', () => {
    const r = validarAjusteDeTarefa({
      ...base,
      form: formulario({ taskDescription: 'mexer no invalidador; PR #130.' }),
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.motivo).toContain('acme/outro#7')
  })

  it('aceita referências espalhadas por campos diferentes dos de origem', () => {
    const r = validarAjusteDeTarefa({
      ...base,
      form: formulario({
        goal: 'Sem refs aqui.',
        notes: 'refs: #123 #130 https://exemplo.com/doc/cache acme/outro#7',
        taskDetails: 'x',
        taskDescription: 'y',
      }),
    })
    expect(r.ok).toBe(true)
  })

  it('recusa campo que traz cabeçalho de seção (quebraria a leitura do padrão)', () => {
    const r = validarAjusteDeTarefa({
      ...base,
      form: formulario({ notes: 'a\n## Goal\nb' }),
    })
    expect(r.ok).toBe(false)
  })

  it('recusa campo que tenta abrir ou fechar o bloco recolhido', () => {
    expect(
      validarAjusteDeTarefa({ ...base, form: formulario({ notes: 'x </details> y' }) }).ok
    ).toBe(false)
    expect(
      validarAjusteDeTarefa({ ...base, form: formulario({ notes: 'x <details> y' }) }).ok
    ).toBe(false)
  })

  it('em dúvida não escreve: original com <details> desbalanceado ou cerca de código aberta', () => {
    const desbalanceado = validarAjusteDeTarefa({
      tituloOriginal: 't',
      corpoOriginal:
        'abre <details> e não fecha #123 https://exemplo.com/doc/cache acme/outro#7 #130',
      form: formulario(),
    })
    expect(desbalanceado.ok).toBe(false)
    const cerca = validarAjusteDeTarefa({
      tituloOriginal: 't',
      corpoOriginal: '```\ncódigo aberto #123 #130 https://exemplo.com/doc/cache acme/outro#7',
      form: formulario(),
    })
    expect(cerca.ok).toBe(false)
  })

  it('original com <details> balanceado é aceito', () => {
    const r = validarAjusteDeTarefa({
      tituloOriginal: 't',
      corpoOriginal:
        '<details><summary>x</summary>detalhe</details> #123 #130 https://exemplo.com/doc/cache acme/outro#7',
      form: formulario(),
    })
    expect(r.ok).toBe(true)
  })

  it('recusa corpo novo acima do limite do GitHub', () => {
    const r = validarAjusteDeTarefa({
      tituloOriginal: 't',
      corpoOriginal: `#123 #130 https://exemplo.com/doc/cache acme/outro#7 ${'a'.repeat(70_000)}`,
      form: formulario(),
    })
    expect(r.ok).toBe(false)
  })

  it('original sem peso: o corpo novo não inventa seção de peso', () => {
    const r = validarAjusteDeTarefa({
      tituloOriginal: 't',
      corpoOriginal: '#123 #130 https://exemplo.com/doc/cache acme/outro#7',
      form: formulario(),
    })
    if (!r.ok) throw new Error(r.motivo)
    expect(r.corpo.split('<details>')[0]).not.toContain('## Peso')
  })
})

describe('interruptor da peça', () => {
  it('vem ligado por padrão (variável ausente)', () => {
    expect(ajusteDeTarefaLigado({})).toBe(true)
  })

  it.each(['0', 'false', 'off', 'nao', 'não', 'desligado', 'OFF', ' False '])(
    'desliga com %j',
    (valor) => {
      expect(ajusteDeTarefaLigado({ GITORCH_AJUSTE_DE_TAREFA: valor })).toBe(false)
    }
  )

  it.each(['1', 'true', 'on', 'sim', ''])('continua ligado com %j', (valor) => {
    expect(ajusteDeTarefaLigado({ GITORCH_AJUSTE_DE_TAREFA: valor })).toBe(true)
  })
})

// ---------------------------------------------------------------------------

function issueDoGitHub(extra: Partial<IssueNoGitHub> = {}): IssueNoGitHub {
  return {
    titulo: ORIGINAL_TITULO,
    corpo: ORIGINAL_CORPO,
    etiquetas: ['gitorch:task'],
    estado: 'open',
    ehPullRequest: false,
    atualizadaEm: HORAS(48),
    ...extra,
  }
}

function montar(
  issue: IssueNoGitHub = issueDoGitHub(),
  sobrescrever: Partial<DepsDoAplicador> = {}
) {
  const chamadas: string[] = []
  const conferencias: Array<Record<string, unknown>> = []
  const eventos: Array<{ chave: string; texto: string }> = []
  const escritas: Array<{ numero: number; titulo: string; corpo: string }> = []
  const ficha: Record<string, unknown> = {}
  const deps: DepsDoAplicador = {
    repo: 'acme/api',
    autonomia: () => 'cuidar',
    interruptorLigado: () => true,
    lerIssue: vi.fn(async () => {
      chamadas.push('GET')
      return issue
    }),
    escreverIssue: vi.fn(async (numero, d) => {
      chamadas.push('PATCH')
      escritas.push({ numero, titulo: d.titulo, corpo: d.corpo })
    }),
    temSessaoDoDevViva: vi.fn(async () => false),
    temEntregaEmJulgamento: vi.fn(async () => false),
    gravarConferencia: vi.fn(async (_n, parcial) => {
      chamadas.push('GRAVA')
      conferencias.push(parcial)
      Object.assign(ficha, parcial)
    }),
    lerConferencia: vi.fn(async () => (Object.keys(ficha).length > 0 ? { ...ficha } : null)),
    registrarNoPainel: vi.fn(async (e) => {
      eventos.push(e)
    }),
    agora: () => AGORA,
    ...sobrescrever,
  }
  return { deps, chamadas, conferencias, eventos, escritas, ficha }
}

const HASH_CONFERIDO = hashDoCorpoDaTarefa(ORIGINAL_TITULO, ORIGINAL_CORPO)

describe('avaliarSePodeReescrever (as travas, antes de gastar motor)', () => {
  const pedido = { numero: 7, hashDoCorpoConferido: HASH_CONFERIDO }

  it('issue aberta, parada há 48 h, sem sessão do dev e sem entrega em julgamento: pode', async () => {
    const m = montar()
    const r = await avaliarSePodeReescrever(m.deps, pedido)
    expect(r.pode).toBe(true)
    if (r.pode) expect(r.issue.corpo).toBe(ORIGINAL_CORPO)
  })

  it('interruptor desligado: nem lê a issue', async () => {
    const m = montar(issueDoGitHub(), { interruptorLigado: () => false })
    const r = await avaliarSePodeReescrever(m.deps, pedido)
    expect(r.pode).toBe(false)
    expect(m.deps.lerIssue).not.toHaveBeenCalled()
  })

  it.each(['sugerir', 'so_olhar', '', null, undefined])(
    'autonomia %j (não é cuidar): nem lê a issue',
    async (autonomia) => {
      const m = montar(issueDoGitHub(), { autonomia: () => autonomia })
      const r = await avaliarSePodeReescrever(m.deps, pedido)
      expect(r.pode).toBe(false)
      expect(m.deps.lerIssue).not.toHaveBeenCalled()
    }
  )

  it('pull request nunca', async () => {
    const m = montar(issueDoGitHub({ ehPullRequest: true }))
    expect((await avaliarSePodeReescrever(m.deps, pedido)).pode).toBe(false)
  })

  it('issue fechada nunca', async () => {
    const m = montar(issueDoGitHub({ estado: 'closed' }))
    expect((await avaliarSePodeReescrever(m.deps, pedido)).pode).toBe(false)
  })

  it('editada há menos de 24 h: não escreve', async () => {
    const m = montar(
      issueDoGitHub({ atualizadaEm: new Date(AGORA.getTime() - JANELA_DE_EDICAO_HUMANA_MS + 1) })
    )
    const r = await avaliarSePodeReescrever(m.deps, pedido)
    expect(r.pode).toBe(false)
    if (!r.pode) expect(r.motivo).toContain('24 h')
  })

  it('editada há exatamente 24 h ou mais: pode', async () => {
    const m = montar(
      issueDoGitHub({ atualizadaEm: new Date(AGORA.getTime() - JANELA_DE_EDICAO_HUMANA_MS) })
    )
    expect((await avaliarSePodeReescrever(m.deps, pedido)).pode).toBe(true)
  })

  it('sem data de atualização legível: na dúvida, não escreve', async () => {
    const m = montar(issueDoGitHub({ atualizadaEm: null }))
    expect((await avaliarSePodeReescrever(m.deps, pedido)).pode).toBe(false)
  })

  it('o texto mudou depois da conferência: não escreve (gente mexeu no meio)', async () => {
    const m = montar(issueDoGitHub({ corpo: `${ORIGINAL_CORPO}\n\nmais uma linha` }))
    const r = await avaliarSePodeReescrever(m.deps, pedido)
    expect(r.pode).toBe(false)
    if (!r.pode) expect(r.motivo).toContain('conferência')
  })

  it('etiqueta de entrega ao dev: não escreve', async () => {
    for (const etiqueta of ['jules', 'gitorch:agent:jules']) {
      const m = montar(issueDoGitHub({ etiquetas: ['gitorch:task', etiqueta] }))
      expect((await avaliarSePodeReescrever(m.deps, pedido)).pode).toBe(false)
    }
  })

  it('sessão do dev viva: não escreve, e nem chega a ler o GitHub', async () => {
    const m = montar(issueDoGitHub(), { temSessaoDoDevViva: vi.fn(async () => true) })
    const r = await avaliarSePodeReescrever(m.deps, pedido)
    expect(r.pode).toBe(false)
    if (!r.pode) expect(r.motivo).toContain('sessão')
    expect(m.deps.lerIssue).not.toHaveBeenCalled()
  })

  it('entrega em julgamento (PR aberto ou parecer travado): não escreve', async () => {
    const m = montar(issueDoGitHub(), { temEntregaEmJulgamento: vi.fn(async () => true) })
    const r = await avaliarSePodeReescrever(m.deps, pedido)
    expect(r.pode).toBe(false)
    expect(m.deps.lerIssue).not.toHaveBeenCalled()
  })
})

describe('reescreverTarefa (o aplicador)', () => {
  const pedido = (form: InfraIssueForm = formulario()) => ({
    numero: 7,
    hashDoCorpoConferido: HASH_CONFERIDO,
    form,
    motivo: 'faltavam goal, taskDetails',
  })

  it('guarda o original ANTES de escrever, escreve uma vez e registra como desfazer', async () => {
    const m = montar()
    const r = await reescreverTarefa(m.deps, pedido())
    expect(r.tipo).toBe('aplicado')
    // GET (travas), GRAVA (original, antes), PATCH, GRAVA (resultado)
    expect(m.chamadas).toEqual(['GET', 'GRAVA', 'PATCH', 'GRAVA'])
    expect(m.conferencias[0]).toMatchObject({
      original: { titulo: ORIGINAL_TITULO, corpo: ORIGINAL_CORPO },
      ajuste: { estado: 'iniciado', hashDoCorpoOriginal: HASH_CONFERIDO },
    })
    expect(m.escritas).toHaveLength(1)
    expect(m.escritas[0]?.corpo).toContain('<details><summary>Texto original</summary>')
    expect(m.escritas[0]?.corpo).toContain(ORIGINAL_CORPO)
    expect(m.conferencias[1]).toMatchObject({
      ajuste: {
        estado: 'aplicado',
        hashDoCorpoOriginal: HASH_CONFERIDO,
        hashDoCorpoNovo: hashDoCorpoDaTarefa(m.escritas[0]!.titulo, m.escritas[0]!.corpo),
      },
    })
    expect(m.eventos).toHaveLength(1)
    expect(m.eventos[0]?.chave).toBe(`ajuste:acme/api:7:${HASH_CONFERIDO}`)
    expect(m.eventos[0]?.texto).toContain('https://github.com/acme/api/issues/7')
    expect(m.eventos[0]?.texto).toContain('faltavam goal, taskDetails')
    expect(m.eventos[0]?.texto).toContain('Como desfazer')
  })

  it('validação reprovada: não escreve, não guarda original, registra o motivo no painel', async () => {
    const m = montar()
    const r = await reescreverTarefa(m.deps, pedido(formulario({ goal: 'sem a referência' })))
    expect(r.tipo).toBe('invalido')
    expect(m.escritas).toEqual([])
    expect(m.chamadas).toEqual(['GET', 'GRAVA'])
    expect(m.conferencias[0]).toMatchObject({
      ajuste: { estado: 'invalido', hashDoCorpoOriginal: HASH_CONFERIDO },
    })
    expect(m.conferencias[0]).not.toHaveProperty('original')
    expect(m.eventos).toHaveLength(1)
    expect(m.eventos[0]?.texto).toContain('#123')
  })

  describe('original com surrogate solto: a limpeza o trocaria por U+FFFD e o desfazer devolveria outro texto', () => {
    const SOLTO = '\uD83D'

    it.each([
      ['no título', { titulo: `${ORIGINAL_TITULO} ${SOLTO}`, corpo: ORIGINAL_CORPO }],
      ['no corpo', { titulo: ORIGINAL_TITULO, corpo: `${ORIGINAL_CORPO}\n\nfim ${SOLTO}` }],
    ])(
      '%s: recusa, não escreve, não guarda original e registra o motivo no painel',
      async (_onde, texto) => {
        const m = montar(issueDoGitHub(texto))
        const r = await reescreverTarefa(m.deps, {
          ...pedido(),
          hashDoCorpoConferido: hashDoCorpoDaTarefa(texto.titulo, texto.corpo),
        })

        expect(r.tipo).toBe('invalido')
        if (r.tipo === 'invalido') expect(r.motivo).toMatch(/surrogate|substituto/i)
        expect(m.escritas).toEqual([])
        expect(m.chamadas).toEqual(['GET', 'GRAVA'])
        expect(m.conferencias[0]).not.toHaveProperty('original')
        expect(m.conferencias[0]).toMatchObject({ ajuste: { estado: 'invalido' } })
        expect(m.eventos).toHaveLength(1)
        expect(m.eventos[0]?.texto).toMatch(/Nada foi alterado no GitHub/)
      }
    )

    it('a validação sozinha também recusa', () => {
      const r = validarAjusteDeTarefa({
        tituloOriginal: ORIGINAL_TITULO,
        corpoOriginal: `${ORIGINAL_CORPO} ${SOLTO}`,
        form: formulario(),
      })
      expect(r.ok).toBe(false)
    })

    it('um emoji inteiro (par completo) no original não é surrogate solto: a reescrita segue', () => {
      const r = validarAjusteDeTarefa({
        tituloOriginal: `${ORIGINAL_TITULO} \u{1F600}`,
        corpoOriginal: `${ORIGINAL_CORPO}\n\n\u{1F600}`,
        form: formulario(),
      })
      expect(r.ok).toBe(true)
    })
  })

  it('a trava vence o formulário: bloqueado não escreve nada nem grava nada', async () => {
    const m = montar(issueDoGitHub({ atualizadaEm: HORAS(1) }))
    const r = await reescreverTarefa(m.deps, pedido())
    expect(r.tipo).toBe('bloqueado')
    expect(m.chamadas).toEqual(['GET'])
    expect(m.eventos).toEqual([])
  })

  it('PATCH recusado pelo GitHub: o original segue guardado e o resultado é falha contada', async () => {
    const m = montar(issueDoGitHub(), {
      escreverIssue: vi.fn(async () => {
        throw new Error('GitHub PATCH /repos/acme/api/issues/7 failed (500)')
      }),
    })
    const r = await reescreverTarefa(m.deps, pedido())
    expect(r.tipo).toBe('falhou')
    const ultimo = m.conferencias.at(-1)
    expect(ultimo).toMatchObject({ ajuste: { estado: 'falhou', falhas: 1 } })
    expect(m.eventos).toEqual([])
  })

  describe('a credencial que o erro de escrita citar não chega à ficha, ao painel nem ao resultado', () => {
    const TOKEN = 'sentinela-gh-9f2c41d7a8'
    const erroComToken = () =>
      new Error(`GitHub PATCH /repos/acme/api/issues/7 failed (401) Authorization: Bearer ${TOKEN}`)

    function tudoQueSaiu(
      m: ReturnType<typeof montar>,
      resultado: Awaited<ReturnType<typeof reescreverTarefa>>
    ): string {
      return JSON.stringify({ conferencias: m.conferencias, eventos: m.eventos, resultado })
    }

    it('escrita recusada e a tarefa segue com o original: a ficha e o resultado sem o token', async () => {
      const m = montar(issueDoGitHub(), {
        escreverIssue: vi.fn(async () => {
          throw erroComToken()
        }),
      })
      const r = await reescreverTarefa(m.deps, pedido())

      expect(r.tipo).toBe('falhou')
      // controle positivo: o motivo gravado traz o resto da mensagem
      expect(m.conferencias.at(-1)).toMatchObject({
        ajuste: { estado: 'falhou', motivo: expect.stringContaining('failed (401)') },
      })
      expect(tudoQueSaiu(m, r)).not.toContain(TOKEN)
    })

    it('nem a releitura funciona (incerto): a ficha, o painel e o resultado sem o token', async () => {
      let leituras = 0
      const m = montar(issueDoGitHub(), {
        lerIssue: vi.fn(async () => {
          leituras += 1
          if (leituras > 1) throw new Error(`rede caiu (Bearer ${TOKEN})`)
          return issueDoGitHub()
        }),
        escreverIssue: vi.fn(async () => {
          throw erroComToken()
        }),
      })
      const r = await reescreverTarefa(m.deps, pedido())

      expect(r.tipo).toBe('incerto')
      expect(m.conferencias.at(-1)).toMatchObject({
        ajuste: { estado: 'incerto', motivo: expect.stringContaining('failed (401)') },
      })
      expect(m.eventos).toHaveLength(1)
      expect(tudoQueSaiu(m, r)).not.toContain(TOKEN)
    })

    it('a tarefa está com outro texto (gente editou): a ficha e o resultado sem o token', async () => {
      let leituras = 0
      const m = montar(issueDoGitHub(), {
        lerIssue: vi.fn(async () => {
          leituras += 1
          return leituras > 1
            ? issueDoGitHub({ corpo: `${ORIGINAL_CORPO}\n\nedição` })
            : issueDoGitHub()
        }),
        escreverIssue: vi.fn(async () => {
          throw erroComToken()
        }),
      })
      const r = await reescreverTarefa(m.deps, pedido())

      expect(r.tipo).toBe('falhou')
      expect(tudoQueSaiu(m, r)).not.toContain(TOKEN)
    })

    it.each([
      ['undefined', undefined],
      ['null', null],
      ['texto', `falhou com ${TOKEN}-fim ghp_abcdefghijklmnopqrstuvwxyz0123456789`],
    ])(
      'escrita que lança %s (não-Error): vira falha contada, sem lançar e sem token',
      async (_n, lancado) => {
        const m = montar(issueDoGitHub(), {
          escreverIssue: vi.fn(async () => {
            throw lancado
          }),
        })
        const r = await reescreverTarefa(m.deps, pedido())

        expect(r.tipo).toBe('falhou')
        expect(tudoQueSaiu(m, r)).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789')
      }
    )
  })

  it('a contagem de falhas continua a de antes', async () => {
    const m = montar(issueDoGitHub(), {
      escreverIssue: vi.fn(async () => {
        throw new Error('x')
      }),
    })
    await reescreverTarefa(m.deps, { ...pedido(), falhasAnteriores: 1 })
    expect(m.conferencias.at(-1)).toMatchObject({ ajuste: { estado: 'falhou', falhas: 2 } })
  })
})

describe('desfazerAjusteDeTarefa', () => {
  function cenario() {
    const m = montar()
    const escritas: Array<{ titulo: string; corpo: string }> = []
    const novo = { titulo: 'Título novo', corpo: 'Corpo novo' }
    const conferencia: Record<string, unknown> = {
      original: { titulo: ORIGINAL_TITULO, corpo: ORIGINAL_CORPO },
      ajuste: {
        estado: 'aplicado',
        hashDoCorpoOriginal: HASH_CONFERIDO,
        hashDoCorpoNovo: hashDoCorpoDaTarefa(novo.titulo, novo.corpo),
      },
    }
    const gravadas: Array<Record<string, unknown>> = []
    const eventos: Array<{ chave: string; texto: string }> = []
    const deps = {
      repo: 'acme/api',
      lerIssue: vi.fn(async () => issueDoGitHub({ titulo: novo.titulo, corpo: novo.corpo })),
      escreverIssue: vi.fn(async (_n: number, d: { titulo: string; corpo: string }) => {
        escritas.push(d)
      }),
      lerConferencia: vi.fn(async () => conferencia),
      gravarConferencia: vi.fn(async (_n: number, p: Record<string, unknown>) => {
        gravadas.push(p)
      }),
      registrarNoPainel: vi.fn(async (e: { chave: string; texto: string }) => {
        eventos.push(e)
      }),
      agora: () => AGORA,
    }
    return { m, deps, escritas, gravadas, eventos, conferencia }
  }

  it('restaura título e corpo do original, marca desfeito e registra no painel', async () => {
    const c = cenario()
    const r = await desfazerAjusteDeTarefa(c.deps, { numero: 7 })
    expect(r).toEqual({ desfeito: true })
    expect(c.escritas).toEqual([{ titulo: ORIGINAL_TITULO, corpo: ORIGINAL_CORPO }])
    expect(c.gravadas[0]).toMatchObject({ ajuste: { estado: 'desfeito' } })
    expect(c.eventos).toHaveLength(1)
    expect(c.eventos[0]?.texto).toContain('#7')
  })

  it('sem original guardado: não faz nada', async () => {
    const c = cenario()
    c.deps.lerConferencia = vi.fn(async () => ({ padraoOk: false }))
    const r = await desfazerAjusteDeTarefa(c.deps, { numero: 7 })
    expect(r.desfeito).toBe(false)
    expect(c.escritas).toEqual([])
  })

  it('ajuste que nunca chegou a ser aplicado (inválido ou falho) não é desfeito', async () => {
    const c = cenario()
    c.deps.lerConferencia = vi.fn(async () => ({
      original: { titulo: 'a', corpo: 'b' },
      ajuste: { estado: 'falhou', hashDoCorpoOriginal: 'x' },
    }))
    const r = await desfazerAjusteDeTarefa(c.deps, { numero: 7 })
    expect(r.desfeito).toBe(false)
    expect(c.escritas).toEqual([])
  })

  it('o texto foi editado depois do ajuste: recusa, a menos que se force', async () => {
    const c = cenario()
    c.deps.lerIssue = vi.fn(async () =>
      issueDoGitHub({ titulo: 'Título novo', corpo: 'Corpo novo EDITADO' })
    )
    const recusado = await desfazerAjusteDeTarefa(c.deps, { numero: 7 })
    expect(recusado.desfeito).toBe(false)
    expect(c.escritas).toEqual([])
    const forcado = await desfazerAjusteDeTarefa(c.deps, { numero: 7, forcar: true })
    expect(forcado).toEqual({ desfeito: true })
    expect(c.escritas).toHaveLength(1)
  })

  it('já desfeito: não escreve de novo', async () => {
    const c = cenario()
    ;(c.conferencia['ajuste'] as Record<string, unknown>)['estado'] = 'desfeito'
    const r = await desfazerAjusteDeTarefa(c.deps, { numero: 7 })
    expect(r.desfeito).toBe(false)
    expect(c.escritas).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Validação endurecida do bloco recolhido
// ---------------------------------------------------------------------------

describe('o bloco recolhido nunca quebra', () => {
  const REFS = '#123 #130 https://exemplo.com/doc/cache acme/outro#7'

  it('detalhesBalanceadosEmOrdem: ordem importa, não só a contagem', () => {
    expect(detalhesBalanceadosEmOrdem('<details><summary>a</summary>x</details>')).toBe(true)
    expect(detalhesBalanceadosEmOrdem('<details>a<details>b</details></details>')).toBe(true)
    expect(detalhesBalanceadosEmOrdem('sem bloco algum')).toBe(true)
    expect(detalhesBalanceadosEmOrdem('</details> x <details>')).toBe(false)
    expect(detalhesBalanceadosEmOrdem('<details>')).toBe(false)
    expect(detalhesBalanceadosEmOrdem('</details>')).toBe(false)
    expect(detalhesBalanceadosEmOrdem('<DETAILS open>a</Details >')).toBe(true)
  })

  it('cercaDeCodigoAberta: cerca mista, mais curta ou sem fechamento fica aberta', () => {
    expect(cercaDeCodigoAberta('```\ncódigo\n```')).toBe(false)
    expect(cercaDeCodigoAberta('~~~\ncódigo\n~~~')).toBe(false)
    expect(cercaDeCodigoAberta('````\n```\ndentro\n```\n````')).toBe(false)
    expect(cercaDeCodigoAberta('```\ncódigo\n~~~')).toBe(true)
    expect(cercaDeCodigoAberta('~~~\ncódigo\n```')).toBe(true)
    expect(cercaDeCodigoAberta('````\ncódigo\n```')).toBe(true)
    expect(cercaDeCodigoAberta('```\ncódigo')).toBe(true)
    expect(cercaDeCodigoAberta('texto com ```código em linha``` e mais')).toBe(false)
  })

  it('recusa original com </details> ANTES de <details> (contagem igual, ordem quebrada)', () => {
    const r = validarAjusteDeTarefa({
      tituloOriginal: 't',
      corpoOriginal: `fecha antes </details> e abre depois <details> ${REFS}`,
      form: formulario(),
    })
    expect(r.ok).toBe(false)
  })

  it('recusa original com cerca mista (``` aberta e ~~~ aberta contam par, mas nenhuma fecha)', () => {
    const r = validarAjusteDeTarefa({
      tituloOriginal: 't',
      corpoOriginal: `\`\`\`\ncódigo\n~~~\n${REFS}`,
      form: formulario(),
    })
    expect(r.ok).toBe(false)
  })

  it('recusa título novo com <details> ou </details>', () => {
    expect(
      validarAjusteDeTarefa({
        ...{ tituloOriginal: ORIGINAL_TITULO, corpoOriginal: ORIGINAL_CORPO },
        form: formulario({ titulo: 'Corrigir </details> o cache' }),
      }).ok
    ).toBe(false)
    expect(
      validarAjusteDeTarefa({
        ...{ tituloOriginal: ORIGINAL_TITULO, corpoOriginal: ORIGINAL_CORPO },
        form: formulario({ titulo: 'Corrigir <details> o cache' }),
      }).ok
    ).toBe(false)
  })

  it('recusa título ORIGINAL com tag de bloco (iria dentro do bloco recolhido)', () => {
    const r = validarAjusteDeTarefa({
      tituloOriginal: 'ajustar </details> o cache',
      corpoOriginal: ORIGINAL_CORPO,
      form: formulario(),
    })
    expect(r.ok).toBe(false)
  })

  it('recusa campo novo com cerca de código aberta (engoliria o bloco do original)', () => {
    const r = validarAjusteDeTarefa({
      tituloOriginal: ORIGINAL_TITULO,
      corpoOriginal: ORIGINAL_CORPO,
      form: formulario({ implementationGuide: '```\npnpm test' }),
    })
    expect(r.ok).toBe(false)
  })

  it('aceita campo novo com cerca de código fechada', () => {
    const r = validarAjusteDeTarefa({
      tituloOriginal: ORIGINAL_TITULO,
      corpoOriginal: ORIGINAL_CORPO,
      form: formulario({ implementationGuide: '```\npnpm test\n```' }),
    })
    expect(r.ok).toBe(true)
  })

  it('o corpo montado tem exatamente um bloco, balanceado e em ordem', () => {
    const r = validarAjusteDeTarefa({
      tituloOriginal: 't',
      corpoOriginal: `<details><summary>x</summary>detalhe</details> ${REFS}`,
      form: formulario(),
    })
    if (!r.ok) throw new Error(r.motivo)
    expect(detalhesBalanceadosEmOrdem(r.corpo)).toBe(true)
    expect(cercaDeCodigoAberta(r.corpo)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Histórico: o original verdadeiro nunca se perde
// ---------------------------------------------------------------------------

describe('acrescentarAoHistorico', () => {
  const entrada = (n: number) => ({
    em: `2026-10-08T12:00:0${n % 10}.000Z`,
    titulo: `t${n}`,
    corpo: `c${n}`,
    hash: `h${n}`,
  })

  it('acrescenta no fim e não repete o mesmo texto seguido', () => {
    const um = acrescentarAoHistorico(undefined, entrada(1))
    expect(um.historico).toEqual([entrada(1)])
    const dois = acrescentarAoHistorico(um.historico, entrada(2))
    expect(dois.historico.map((e) => e.hash)).toEqual(['h1', 'h2'])
    const repetido = acrescentarAoHistorico(dois.historico, entrada(2))
    expect(repetido.historico.map((e) => e.hash)).toEqual(['h1', 'h2'])
  })

  it('com teto de itens: guarda SEMPRE o primeiro e o mais novo, e conta o que descartou', () => {
    let h: ReturnType<typeof acrescentarAoHistorico>['historico'] = []
    let descartados = 0
    for (let n = 1; n <= HISTORICO_MAXIMO_DE_ITENS + 5; n += 1) {
      const r = acrescentarAoHistorico(h, entrada(n))
      h = r.historico
      descartados += r.descartados
    }
    expect(h).toHaveLength(HISTORICO_MAXIMO_DE_ITENS)
    expect(h[0]?.hash).toBe('h1')
    expect(h.at(-1)?.hash).toBe(`h${HISTORICO_MAXIMO_DE_ITENS + 5}`)
    expect(descartados).toBe(5)
  })

  it('ignora o que não é lista ou entrada legível', () => {
    expect(acrescentarAoHistorico('lixo', entrada(1)).historico).toEqual([entrada(1)])
    expect(acrescentarAoHistorico([{ titulo: 1 }, null], entrada(1)).historico).toEqual([
      entrada(1),
    ])
  })
})

// ---------------------------------------------------------------------------
// Um mundo com estado: GitHub, ficha e painel de verdade (em memória)
// ---------------------------------------------------------------------------

function mundo(inicial: { titulo: string; corpo: string }) {
  const issue = { titulo: inicial.titulo, corpo: inicial.corpo }
  const ficha: Record<string, unknown> = {}
  const painel: Array<{ chave: string; texto: string }> = []
  const patches: Array<{ titulo: string; corpo: string }> = []
  const controle = {
    /** O PATCH chega ao servidor, mas o cliente recebe erro (timeout, 500 na volta). */
    erroNaRespostaDoPatch: false,
    /** O PATCH nem chega ao servidor. */
    recusaOPatch: false,
    /** A leitura falha (usada para simular a releitura que também cai). */
    leituraQuebrada: false,
  }
  const deps: DepsDoAplicador & DepsDoDesfazer = {
    repo: 'acme/api',
    autonomia: () => 'cuidar',
    interruptorLigado: () => true,
    lerIssue: vi.fn(async () => {
      if (controle.leituraQuebrada) throw new Error('GitHub GET falhou (502)')
      return issueDoGitHub({ titulo: issue.titulo, corpo: issue.corpo })
    }),
    escreverIssue: vi.fn(async (_n, d) => {
      if (controle.recusaOPatch) throw new Error('GitHub PATCH recusado (403)')
      issue.titulo = d.titulo
      issue.corpo = d.corpo
      patches.push(d)
      if (controle.erroNaRespostaDoPatch) {
        throw new Error('timeout esperando a resposta do PATCH')
      }
    }),
    temSessaoDoDevViva: vi.fn(async () => false),
    temEntregaEmJulgamento: vi.fn(async () => false),
    gravarConferencia: vi.fn(async (_n, parcial) => {
      Object.assign(ficha, parcial)
    }),
    lerConferencia: vi.fn(async () => (Object.keys(ficha).length > 0 ? { ...ficha } : null)),
    registrarNoPainel: vi.fn(async (e) => {
      painel.push(e)
    }),
    agora: () => AGORA,
  }
  const pedido = (hashConferido: string) => ({
    numero: 7,
    hashDoCorpoConferido: hashConferido,
    form: formulario(),
    motivo: 'faltavam goal, taskDetails',
  })
  return { issue, ficha, painel, patches, controle, deps, pedido }
}

const TITULO_HUMANO = 'cache da sessão (anotado por gente)'
const CORPO_HUMANO =
  'Gente anotou: o cache da sessão ainda serve dado velho, ver #123 e #130. ' +
  'https://exemplo.com/doc/cache e acme/outro#7.'

/** Reescreve, uma pessoa edita (quebrando o padrão) e o sistema reescreve de novo. */
async function duasReescritas() {
  const w = mundo({ titulo: ORIGINAL_TITULO, corpo: ORIGINAL_CORPO })
  const primeira = await reescreverTarefa(w.deps, w.pedido(HASH_CONFERIDO))
  expect(primeira.tipo).toBe('aplicado')
  const textoDaPrimeira = { titulo: w.issue.titulo, corpo: w.issue.corpo }

  w.issue.titulo = TITULO_HUMANO
  w.issue.corpo = CORPO_HUMANO
  const hashHumano = hashDoCorpoDaTarefa(TITULO_HUMANO, CORPO_HUMANO)
  const segunda = await reescreverTarefa(w.deps, w.pedido(hashHumano))
  expect(segunda.tipo).toBe('aplicado')
  return { w, textoDaPrimeira, hashHumano }
}

describe('segunda reescrita: a cadeia guarda o original verdadeiro', () => {
  it('"original" segue sendo o PRIMEIRO texto e o histórico guarda cada texto anterior', async () => {
    const { w, hashHumano } = await duasReescritas()
    expect(w.ficha['original']).toMatchObject({ titulo: ORIGINAL_TITULO, corpo: ORIGINAL_CORPO })
    expect(w.ficha['historico']).toEqual([
      expect.objectContaining({
        titulo: ORIGINAL_TITULO,
        corpo: ORIGINAL_CORPO,
        hash: HASH_CONFERIDO,
      }),
      expect.objectContaining({ titulo: TITULO_HUMANO, corpo: CORPO_HUMANO, hash: hashHumano }),
    ])
  })

  it('desfazer (padrão) volta ao ORIGINAL VERDADEIRO, não ao texto da pessoa', async () => {
    const { w } = await duasReescritas()
    const r = await desfazerAjusteDeTarefa(w.deps, { numero: 7 })
    expect(r).toEqual({ desfeito: true })
    expect(w.issue).toEqual({ titulo: ORIGINAL_TITULO, corpo: ORIGINAL_CORPO })
  })

  it('desfazer para o anterior volta ao texto imediatamente anterior à última reescrita', async () => {
    const { w } = await duasReescritas()
    const r = await desfazerAjusteDeTarefa(w.deps, { numero: 7, alvo: 'anterior' })
    expect(r).toEqual({ desfeito: true })
    expect(w.issue).toEqual({ titulo: TITULO_HUMANO, corpo: CORPO_HUMANO })
  })

  it('depois de desfazer, o texto restaurado não é reescrito de novo pela mesma conferência', async () => {
    const { w } = await duasReescritas()
    await desfazerAjusteDeTarefa(w.deps, { numero: 7 })
    expect((w.ficha['ajuste'] as Record<string, unknown>)['estado']).toBe('desfeito')
    expect((w.ficha['ajuste'] as Record<string, unknown>)['hashDoCorpoOriginal']).toBe(
      HASH_CONFERIDO
    )
    expect(w.painel.at(-1)?.texto).toContain('#7')
  })

  it('o aviso do painel diz como voltar ao original e como voltar só ao anterior', async () => {
    const { w } = await duasReescritas()
    const aviso = w.painel.at(-1)?.texto ?? ''
    expect(aviso).toContain('Como desfazer')
    expect(aviso).toMatch(/original/i)
    expect(aviso).toMatch(/anterior/i)
  })

  it('"anterior" sem histórico legível: recusa e não escreve', async () => {
    const w = mundo({ titulo: 'Título novo', corpo: 'Corpo novo' })
    Object.assign(w.ficha, {
      original: { titulo: ORIGINAL_TITULO, corpo: ORIGINAL_CORPO },
      ajuste: {
        estado: 'aplicado',
        hashDoCorpoOriginal: HASH_CONFERIDO,
        hashDoCorpoNovo: hashDoCorpoDaTarefa('Título novo', 'Corpo novo'),
      },
    })
    const r = await desfazerAjusteDeTarefa(w.deps, { numero: 7, alvo: 'anterior' })
    expect(r.desfeito).toBe(false)
    expect(w.patches).toEqual([])
  })

  it('a falha de uma tentativa no mesmo texto não duplica o histórico', async () => {
    const w = mundo({ titulo: ORIGINAL_TITULO, corpo: ORIGINAL_CORPO })
    w.controle.recusaOPatch = true
    expect((await reescreverTarefa(w.deps, w.pedido(HASH_CONFERIDO))).tipo).toBe('falhou')
    w.controle.recusaOPatch = false
    expect((await reescreverTarefa(w.deps, w.pedido(HASH_CONFERIDO))).tipo).toBe('aplicado')
    expect(w.ficha['historico']).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// PATCH aplicado, resposta com erro
// ---------------------------------------------------------------------------

describe('PATCH que chega ao GitHub mas devolve erro ao cliente', () => {
  it('a releitura acha o texto novo: conta como aplicado, com evento no painel, e dá para desfazer', async () => {
    const w = mundo({ titulo: ORIGINAL_TITULO, corpo: ORIGINAL_CORPO })
    w.controle.erroNaRespostaDoPatch = true
    const r = await reescreverTarefa(w.deps, w.pedido(HASH_CONFERIDO))
    expect(r.tipo).toBe('aplicado')
    expect(w.ficha['ajuste']).toMatchObject({
      estado: 'aplicado',
      hashDoCorpoOriginal: HASH_CONFERIDO,
      hashDoCorpoNovo: hashDoCorpoDaTarefa(w.issue.titulo, w.issue.corpo),
    })
    expect(w.painel).toHaveLength(1)
    expect(w.painel[0]?.chave).toBe(`ajuste:acme/api:7:${HASH_CONFERIDO}`)
    expect(w.painel[0]?.texto).toContain('Como desfazer')

    w.controle.erroNaRespostaDoPatch = false
    const volta = await desfazerAjusteDeTarefa(w.deps, { numero: 7 })
    expect(volta).toEqual({ desfeito: true })
    expect(w.issue).toEqual({ titulo: ORIGINAL_TITULO, corpo: ORIGINAL_CORPO })
  })

  it('o PATCH nem chegou (a releitura vê o original): falhou de verdade, sem evento', async () => {
    const w = mundo({ titulo: ORIGINAL_TITULO, corpo: ORIGINAL_CORPO })
    w.controle.recusaOPatch = true
    const r = await reescreverTarefa(w.deps, w.pedido(HASH_CONFERIDO))
    expect(r.tipo).toBe('falhou')
    expect(w.ficha['ajuste']).toMatchObject({ estado: 'falhou', falhas: 1 })
    expect(w.painel).toEqual([])
  })

  it('a releitura vê OUTRO texto (gente editou): falhou com o motivo e nada é tocado', async () => {
    const w = mundo({ titulo: ORIGINAL_TITULO, corpo: ORIGINAL_CORPO })
    w.deps.escreverIssue = vi.fn(async () => {
      // alguém editou no meio e o PATCH do sistema não chegou a valer
      w.issue.corpo = `${ORIGINAL_CORPO}\n\nedição de gente`
      throw new Error('GitHub PATCH falhou (500)')
    })
    const r = await reescreverTarefa(w.deps, w.pedido(HASH_CONFERIDO))
    expect(r.tipo).toBe('falhou')
    if (r.tipo === 'falhou') expect(r.motivo).toMatch(/outro texto|editou/i)
    expect(w.ficha['ajuste']).toMatchObject({ estado: 'falhou' })
    expect(w.painel).toEqual([])
    expect(w.issue.corpo).toBe(`${ORIGINAL_CORPO}\n\nedição de gente`)
  })

  it('a releitura também cai: estado "incerto", evento no painel pedindo conferência', async () => {
    const w = mundo({ titulo: ORIGINAL_TITULO, corpo: ORIGINAL_CORPO })
    w.controle.erroNaRespostaDoPatch = true
    const escrever = w.deps.escreverIssue
    w.deps.escreverIssue = vi.fn(async (n, d) => {
      try {
        await escrever(n, d)
      } finally {
        w.controle.leituraQuebrada = true
      }
    })
    const r = await reescreverTarefa(w.deps, w.pedido(HASH_CONFERIDO))
    expect(r.tipo).toBe('incerto')
    expect(w.ficha['ajuste']).toMatchObject({
      estado: 'incerto',
      hashDoCorpoOriginal: HASH_CONFERIDO,
      hashDoCorpoNovo: hashDoCorpoDaTarefa(w.issue.titulo, w.issue.corpo),
    })
    expect(w.painel).toHaveLength(1)
    expect(w.painel[0]?.texto).toMatch(/confira|conferir|conferência/i)
    expect(w.painel[0]?.texto).toContain('https://github.com/acme/api/issues/7')
  })

  it('o desfazer aceita "incerto": relê antes de decidir e restaura quando o texto novo está lá', async () => {
    const w = mundo({ titulo: ORIGINAL_TITULO, corpo: ORIGINAL_CORPO })
    w.controle.erroNaRespostaDoPatch = true
    const escrever = w.deps.escreverIssue
    w.deps.escreverIssue = vi.fn(async (n, d) => {
      try {
        await escrever(n, d)
      } finally {
        w.controle.leituraQuebrada = true
      }
    })
    await reescreverTarefa(w.deps, w.pedido(HASH_CONFERIDO))
    w.controle.leituraQuebrada = false
    w.controle.erroNaRespostaDoPatch = false
    w.deps.escreverIssue = escrever

    const r = await desfazerAjusteDeTarefa(w.deps, { numero: 7 })
    expect(r).toEqual({ desfeito: true })
    expect(w.issue).toEqual({ titulo: ORIGINAL_TITULO, corpo: ORIGINAL_CORPO })
  })

  it('o desfazer de "incerto" não escreve quando a releitura mostra que o texto novo nunca entrou', async () => {
    const w = mundo({ titulo: ORIGINAL_TITULO, corpo: ORIGINAL_CORPO })
    Object.assign(w.ficha, {
      original: { titulo: ORIGINAL_TITULO, corpo: ORIGINAL_CORPO },
      ajuste: {
        estado: 'incerto',
        hashDoCorpoOriginal: HASH_CONFERIDO,
        hashDoCorpoNovo: hashDoCorpoDaTarefa('novo', 'texto novo'),
      },
    })
    const r = await desfazerAjusteDeTarefa(w.deps, { numero: 7 })
    expect(r.desfeito).toBe(false)
    expect(w.patches).toEqual([])
  })
})
