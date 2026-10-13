import { describe, expect, it, vi } from 'vitest'
import { EscritaNaoAutorizadaError } from '@gitorch/cadence'
import {
  AcaoForaDaListaBrancaError,
  ACOES_DE_SEGURANCA,
  criarEscritorDeSeguranca,
  criarRitmoDeEscrita,
  PAUSA_ENTRE_ESCRITAS_MS,
  PREFIXO_DOS_RAMOS_DE_SEGURANCA,
} from './escritor-de-seguranca.js'

const REPO = 'acme/api'
const TOKEN = 'ghp_segredo_do_escritor_0000000000'
const SHA = 'c'.repeat(40)
const RAMO = `${PREFIXO_DOS_RAMOS_DE_SEGURANCA}permissoes-ci-yml`

interface Chamada {
  url: string
  metodo: string
  corpo: unknown
  cabecalhos: Headers
  em: number
}

function montar(
  responder: (c: Chamada) => Response = () => new Response(null, { status: 204 }),
  extra: { pausaMs?: number } = {}
) {
  let agora = 1_000_000
  const chamadas: Chamada[] = []
  const esperas: number[] = []
  const fetchImpl = vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const chamada: Chamada = {
      url: String(url),
      metodo: (init?.method ?? 'GET').toUpperCase(),
      corpo: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null,
      cabecalhos: new Headers(init?.headers),
      em: agora,
    }
    chamadas.push(chamada)
    return responder(chamada)
  }) as unknown as typeof fetch
  const esperar = async (ms: number) => {
    esperas.push(ms)
    agora += ms
  }
  const ritmo = criarRitmoDeEscrita({
    esperar,
    agora: () => agora,
    ...(extra.pausaMs !== undefined ? { pausaMs: extra.pausaMs } : {}),
  })
  const escritor = criarEscritorDeSeguranca({ repositorio: REPO, fetchImpl, ritmo })
  return {
    escritor,
    ritmo,
    chamadas,
    esperas,
    fetchImpl,
    avancar: (ms: number) => {
      agora += ms
    },
  }
}

describe('escritor de segurança: a lista branca', () => {
  const casos: Array<
    [
      string,
      Parameters<ReturnType<typeof montar>['escritor']['enviar']>[0],
      string,
      string,
      unknown,
    ]
  > = [
    [
      'ativar alertas',
      { acao: 'ativar-alertas-de-dependencias', caminho: '/vulnerability-alerts', token: TOKEN },
      'PUT',
      `/repos/${REPO}/vulnerability-alerts`,
      null,
    ],
    [
      'desativar alertas',
      { acao: 'desativar-alertas-de-dependencias', caminho: '/vulnerability-alerts', token: TOKEN },
      'DELETE',
      `/repos/${REPO}/vulnerability-alerts`,
      null,
    ],
    [
      'ativar atualizações',
      {
        acao: 'ativar-atualizacoes-de-seguranca',
        caminho: '/automated-security-fixes',
        token: TOKEN,
      },
      'PUT',
      `/repos/${REPO}/automated-security-fixes`,
      null,
    ],
    [
      'desativar atualizações',
      {
        acao: 'desativar-atualizacoes-de-seguranca',
        caminho: '/automated-security-fixes',
        token: TOKEN,
      },
      'DELETE',
      `/repos/${REPO}/automated-security-fixes`,
      null,
    ],
    [
      'senhas',
      {
        acao: 'configurar-varredura-de-senhas',
        caminho: '',
        corpo: {
          security_and_analysis: {
            secret_scanning: { status: 'enabled' },
            secret_scanning_push_protection: { status: 'enabled' },
          },
        },
        token: TOKEN,
      },
      'PATCH',
      `/repos/${REPO}`,
      {
        security_and_analysis: {
          secret_scanning: { status: 'enabled' },
          secret_scanning_push_protection: { status: 'enabled' },
        },
      },
    ],
    [
      'código',
      {
        acao: 'configurar-varredura-de-codigo',
        caminho: '/code-scanning/default-setup',
        corpo: { state: 'configured', query_suite: 'default' },
        token: TOKEN,
      },
      'PATCH',
      `/repos/${REPO}/code-scanning/default-setup`,
      { state: 'configured', query_suite: 'default' },
    ],
    [
      'permissão padrão',
      {
        acao: 'definir-permissao-padrao-do-workflow',
        caminho: '/actions/permissions/workflow',
        corpo: { default_workflow_permissions: 'read', can_approve_pull_request_reviews: false },
        token: TOKEN,
      },
      'PUT',
      `/repos/${REPO}/actions/permissions/workflow`,
      { default_workflow_permissions: 'read', can_approve_pull_request_reviews: false },
    ],
    [
      'criar ramo',
      {
        acao: 'criar-ramo-de-seguranca',
        caminho: '/git/refs',
        corpo: { ref: `refs/heads/${RAMO}`, sha: SHA },
        token: TOKEN,
      },
      'POST',
      `/repos/${REPO}/git/refs`,
      { ref: `refs/heads/${RAMO}`, sha: SHA },
    ],
    [
      'gravar arquivo',
      {
        acao: 'gravar-arquivo-no-ramo',
        caminho: '/contents/.github/workflows/ci.yml',
        corpo: { message: 'm', content: 'YQ==', branch: RAMO, sha: SHA },
        token: TOKEN,
      },
      'PUT',
      `/repos/${REPO}/contents/.github/workflows/ci.yml`,
      { message: 'm', content: 'YQ==', branch: RAMO, sha: SHA },
    ],
    [
      'apagar arquivo',
      {
        acao: 'apagar-arquivo-no-ramo',
        caminho: '/contents/.github/workflows/ci.yml',
        corpo: { message: 'm', sha: SHA, branch: RAMO },
        token: TOKEN,
      },
      'DELETE',
      `/repos/${REPO}/contents/.github/workflows/ci.yml`,
      { message: 'm', sha: SHA, branch: RAMO },
    ],
    [
      'abrir PR',
      {
        acao: 'abrir-pr-de-seguranca',
        caminho: '/pulls',
        corpo: { title: 't', body: 'b', head: RAMO, base: 'main' },
        token: TOKEN,
      },
      'POST',
      `/repos/${REPO}/pulls`,
      { title: 't', body: 'b', head: RAMO, base: 'main' },
    ],
    [
      'fechar PR',
      {
        acao: 'fechar-pr-de-seguranca',
        caminho: '/pulls/7',
        corpo: { state: 'closed' },
        token: TOKEN,
      },
      'PATCH',
      `/repos/${REPO}/pulls/7`,
      { state: 'closed' },
    ],
    [
      'comentar PR',
      {
        acao: 'comentar-pr-de-seguranca',
        caminho: '/issues/7/comments',
        corpo: { body: 'Fechado a pedido do dono.' },
        token: TOKEN,
      },
      'POST',
      `/repos/${REPO}/issues/7/comments`,
      { body: 'Fechado a pedido do dono.' },
    ],
    [
      'mesclar PR (com o commit esperado)',
      {
        acao: 'mesclar-pr-de-seguranca',
        caminho: '/pulls/7/merge',
        corpo: { sha: SHA, commit_title: 't' },
        token: TOKEN,
      },
      'PUT',
      `/repos/${REPO}/pulls/7/merge`,
      { sha: SHA, commit_title: 't' },
    ],
    [
      'apagar ramo',
      { acao: 'apagar-ramo-de-seguranca', caminho: `/git/refs/heads/${RAMO}`, token: TOKEN },
      'DELETE',
      `/repos/${REPO}/git/refs/heads/${RAMO}`,
      null,
    ],
  ]

  it('a lista branca tem exatamente as ações testadas aqui', () => {
    expect([...ACOES_DE_SEGURANCA].sort()).toEqual(casos.map((c) => c[1].acao).sort())
  })

  it.each(casos)(
    '%s: método, endereço, corpo e credencial exatos',
    async (_n, pedido, metodo, caminho, corpo) => {
      const { escritor, chamadas } = montar()
      const resposta = await escritor.enviar(pedido)
      expect(resposta.ok).toBe(true)
      expect(chamadas).toHaveLength(1)
      const c = chamadas[0]!
      expect(c.metodo).toBe(metodo)
      expect(c.url).toBe(`https://api.github.com${caminho}`)
      expect(c.corpo).toEqual(corpo)
      expect(c.cabecalhos.get('authorization')).toBe(`Bearer ${TOKEN}`)
      expect(c.url).not.toContain(TOKEN)
    }
  )

  it('a mescla exige o commit esperado e recusa corpo com campo a mais ou sem sha', async () => {
    const { escritor, fetchImpl } = montar()
    for (const corpo of [
      undefined,
      {},
      { sha: 'abc' },
      { sha: SHA, merge_method: 'squash', extra: 1 },
      { sha: SHA, commit_title: 3 },
    ]) {
      await expect(
        escritor.enviar({
          acao: 'mesclar-pr-de-seguranca',
          caminho: '/pulls/7/merge',
          ...(corpo === undefined ? {} : { corpo }),
          token: TOKEN,
        })
      ).rejects.toThrow(/lista branca/)
    }
    await expect(
      escritor.enviar({
        acao: 'mesclar-pr-de-seguranca',
        caminho: '/pulls/7/merge/../../x',
        corpo: { sha: SHA },
        token: TOKEN,
      })
    ).rejects.toThrow(/lista branca/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('uma ação que não está na lista é recusada SEM chamar a rede', async () => {
    const { escritor, fetchImpl } = montar()
    for (const acao of [
      'proteger-a-branch',
      'apagar-repositorio',
      'mesclar-pr',
      'tornar-publico',
      '',
      'toString',
      '__proto__',
    ]) {
      await expect(
        escritor.enviar({ acao: acao as never, caminho: '/branches/main/protection', token: TOKEN })
      ).rejects.toBeInstanceOf(AcaoForaDaListaBrancaError)
    }
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('o endereço tem de ser o da ação: a mesma ação não serve a outra rota', async () => {
    const { escritor, fetchImpl } = montar()
    const ruins: Array<[string, string]> = [
      ['ativar-alertas-de-dependencias', '/branches/main/protection'],
      ['ativar-alertas-de-dependencias', '/vulnerability-alerts/../x'],
      ['ativar-alertas-de-dependencias', '/vulnerability-alerts?x=1'],
      ['configurar-varredura-de-codigo', '/code-scanning/default-setup/../../x'],
      ['fechar-pr-de-seguranca', '/pulls/7/merge'],
      ['fechar-pr-de-seguranca', '/pulls/abc'],
      ['apagar-ramo-de-seguranca', '/git/refs/heads/main'],
      ['apagar-ramo-de-seguranca', `/git/refs/heads/${RAMO}/../../main`],
      ['gravar-arquivo-no-ramo', '/contents/src/index.ts'],
      ['gravar-arquivo-no-ramo', '/contents/.github/workflows/../../src/x.yml'],
      ['gravar-arquivo-no-ramo', '/contents/.github/workflows/sub/x.yml'],
      ['criar-ramo-de-seguranca', '/git/refs/heads/x'],
    ]
    for (const [acao, caminho] of ruins) {
      await expect(
        escritor.enviar({ acao: acao as never, caminho, corpo: { state: 'closed' }, token: TOKEN })
      ).rejects.toBeInstanceOf(AcaoForaDaListaBrancaError)
    }
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('nunca escreve na branch padrão: ramo, referência e PR têm de ser do GitOrch', async () => {
    const { escritor, fetchImpl } = montar()
    const ruins: Array<Parameters<typeof escritor.enviar>[0]> = [
      {
        acao: 'gravar-arquivo-no-ramo',
        caminho: '/contents/.github/workflows/ci.yml',
        corpo: { message: 'm', content: 'YQ==', branch: 'main', sha: SHA },
        token: TOKEN,
      },
      {
        acao: 'gravar-arquivo-no-ramo',
        caminho: '/contents/.github/workflows/ci.yml',
        corpo: { message: 'm', content: 'YQ==', sha: SHA },
        token: TOKEN,
      },
      {
        acao: 'apagar-arquivo-no-ramo',
        caminho: '/contents/.github/workflows/ci.yml',
        corpo: { message: 'm', sha: SHA, branch: 'master' },
        token: TOKEN,
      },
      {
        acao: 'criar-ramo-de-seguranca',
        caminho: '/git/refs',
        corpo: { ref: 'refs/heads/main', sha: SHA },
        token: TOKEN,
      },
      {
        acao: 'criar-ramo-de-seguranca',
        caminho: '/git/refs',
        corpo: { ref: `refs/heads/${PREFIXO_DOS_RAMOS_DE_SEGURANCA}../main`, sha: SHA },
        token: TOKEN,
      },
      {
        acao: 'criar-ramo-de-seguranca',
        caminho: '/git/refs',
        corpo: { ref: `refs/heads/${RAMO}`, sha: 'nao-e-sha' },
        token: TOKEN,
      },
      {
        acao: 'abrir-pr-de-seguranca',
        caminho: '/pulls',
        corpo: { title: 't', body: 'b', head: 'feature/x', base: 'main' },
        token: TOKEN,
      },
    ]
    for (const pedido of ruins) {
      await expect(escritor.enviar(pedido)).rejects.toBeInstanceOf(AcaoForaDaListaBrancaError)
    }
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('o PATCH do repositório só aceita security_and_analysis (nunca visibilidade, nome, arquivamento)', async () => {
    const { escritor, fetchImpl } = montar()
    const ruins: unknown[] = [
      { private: false },
      { archived: true },
      { name: 'outro' },
      { default_branch: 'x' },
      { security_and_analysis: { secret_scanning: { status: 'enabled' } }, private: false },
      { security_and_analysis: { advanced_security: { status: 'enabled' } } },
      { security_and_analysis: { secret_scanning: { status: 'talvez' } } },
      { security_and_analysis: {} },
      {},
      null,
    ]
    for (const corpo of ruins) {
      await expect(
        escritor.enviar({
          acao: 'configurar-varredura-de-senhas',
          caminho: '',
          corpo,
          token: TOKEN,
        })
      ).rejects.toBeInstanceOf(AcaoForaDaListaBrancaError)
    }
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('a permissão padrão do workflow só aceita read ou write; o código só configured ou not-configured', async () => {
    const { escritor, fetchImpl } = montar()
    await expect(
      escritor.enviar({
        acao: 'definir-permissao-padrao-do-workflow',
        caminho: '/actions/permissions/workflow',
        corpo: { default_workflow_permissions: 'admin' },
        token: TOKEN,
      })
    ).rejects.toBeInstanceOf(AcaoForaDaListaBrancaError)
    await expect(
      escritor.enviar({
        acao: 'configurar-varredura-de-codigo',
        caminho: '/code-scanning/default-setup',
        corpo: { state: 'configured', runner_type: 'self-hosted' },
        token: TOKEN,
      })
    ).rejects.toBeInstanceOf(AcaoForaDaListaBrancaError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('o escritor é amarrado a UM repositório: formato inválido não monta endereço', () => {
    expect(() =>
      criarEscritorDeSeguranca({
        repositorio: 'acme/../x',
        fetchImpl: vi.fn() as unknown as typeof fetch,
        ritmo: criarRitmoDeEscrita({ esperar: async () => {}, agora: () => 0 }),
      })
    ).toThrow(/formato/)
  })
})

describe('escritor de segurança: ritmo (pelo menos 1 s entre escritas)', () => {
  const alertas = {
    acao: 'ativar-alertas-de-dependencias',
    caminho: '/vulnerability-alerts',
    token: TOKEN,
  } as const

  it('a pausa padrão é de 1 segundo', () => {
    expect(PAUSA_ENTRE_ESCRITAS_MS).toBe(1000)
  })

  it('duas escritas seguidas ficam 1 s afastadas; a primeira não espera', async () => {
    const { escritor, chamadas, esperas } = montar()
    await escritor.enviar(alertas)
    await escritor.enviar(alertas)
    await escritor.enviar(alertas)
    expect(esperas).toEqual([PAUSA_ENTRE_ESCRITAS_MS, PAUSA_ENTRE_ESCRITAS_MS])
    expect(chamadas[1]!.em - chamadas[0]!.em).toBeGreaterThanOrEqual(1000)
    expect(chamadas[2]!.em - chamadas[1]!.em).toBeGreaterThanOrEqual(1000)
  })

  it('se já passou mais de 1 s desde a última, não espera nada', async () => {
    const { escritor, esperas, avancar } = montar()
    await escritor.enviar(alertas)
    avancar(5000)
    await escritor.enviar(alertas)
    expect(esperas).toEqual([])
  })

  it('só espera o que falta', async () => {
    const { escritor, esperas, avancar } = montar()
    await escritor.enviar(alertas)
    avancar(400)
    await escritor.enviar(alertas)
    expect(esperas).toEqual([600])
  })

  it('escritas disparadas ao mesmo tempo saem em série, pelo mesmo ritmo, inclusive de escritores diferentes', async () => {
    const { escritor, ritmo, chamadas, fetchImpl } = montar()
    const outro = criarEscritorDeSeguranca({ repositorio: 'acme/outro', fetchImpl, ritmo })
    await Promise.all([
      escritor.enviar(alertas),
      outro.enviar(alertas),
      escritor.enviar(alertas),
      outro.enviar(alertas),
    ])
    expect(chamadas).toHaveLength(4)
    for (let i = 1; i < chamadas.length; i += 1) {
      expect(chamadas[i]!.em - chamadas[i - 1]!.em).toBeGreaterThanOrEqual(1000)
    }
  })

  it('uma escrita recusada pela lista branca NÃO gasta o ritmo', async () => {
    const { escritor, esperas } = montar()
    await escritor.enviar(alertas)
    await expect(
      escritor.enviar({ acao: 'x' as never, caminho: '/y', token: TOKEN })
    ).rejects.toBeInstanceOf(AcaoForaDaListaBrancaError)
    await escritor.enviar(alertas)
    expect(esperas).toEqual([PAUSA_ENTRE_ESCRITAS_MS])
  })

  it('uma escrita que falha na rede também conta para o ritmo e não trava a fila', async () => {
    let n = 0
    const { escritor, esperas } = montar(() => {
      n += 1
      if (n === 1) throw new Error('rede caiu')
      return new Response(null, { status: 204 })
    })
    await expect(escritor.enviar(alertas)).rejects.toThrow(/rede caiu/)
    await escritor.enviar(alertas)
    expect(esperas).toEqual([PAUSA_ENTRE_ESCRITAS_MS])
  })
})

describe('escritor de segurança: respostas', () => {
  const alertas = {
    acao: 'ativar-alertas-de-dependencias',
    caminho: '/vulnerability-alerts',
    token: TOKEN,
  } as const

  it('204 sem corpo é sucesso', async () => {
    const { escritor } = montar()
    expect(await escritor.enviar(alertas)).toMatchObject({ ok: true, status: 204, mensagem: null })
  })

  it('erro do GitHub: devolve status e mensagem, sem lançar', async () => {
    const { escritor } = montar(
      () =>
        new Response(
          JSON.stringify({ message: 'Upgrade to GitHub Pro or make this repository public' }),
          {
            status: 403,
          }
        )
    )
    expect(await escritor.enviar(alertas)).toMatchObject({
      ok: false,
      status: 403,
      mensagem: 'Upgrade to GitHub Pro or make this repository public',
    })
  })

  it('a mensagem sai cortada e SEM credencial, mesmo que o GitHub a repita', async () => {
    const longa = `${'x'.repeat(2000)} Bearer ${TOKEN}`
    const { escritor } = montar(
      () => new Response(JSON.stringify({ message: `${TOKEN} ${longa}` }), { status: 422 })
    )
    const r = await escritor.enviar(alertas)
    expect(r.mensagem).not.toBeNull()
    expect(r.mensagem!).not.toContain(TOKEN)
    expect(Array.from(r.mensagem!).length).toBeLessThanOrEqual(300)
  })

  it('corpo que não é JSON não derruba: a mensagem fica nula', async () => {
    const { escritor } = montar(() => new Response('<html>erro</html>', { status: 502 }))
    expect(await escritor.enviar(alertas)).toMatchObject({ ok: false, status: 502, mensagem: null })
  })

  it('erro de rede: lança com a mensagem sem a credencial', async () => {
    const { escritor } = montar(() => {
      throw new Error(`falha em https://x?token=${TOKEN} com Authorization: Bearer ${TOKEN}`)
    })
    const erro = await escritor.enviar(alertas).catch((e: unknown) => e as Error)
    expect(erro).toBeInstanceOf(Error)
    expect(String((erro as Error).message)).not.toContain(TOKEN)
  })

  // A guarda de autonomia fica no `fetch` recebido e recusa ANTES de a rede ser
  // tocada. Essa recusa não pode virar "erro de rede" (que o executor lê como
  // "pode ter chegado", ou seja, incerto): sobe com a identidade dela.
  it('a recusa da guarda de autonomia sobe como ela mesma, nunca como erro de rede', async () => {
    const { escritor } = montar(() => {
      throw new EscritaNaoAutorizadaError('mesclar', 'sugerir', 'cuidar', 'nível "sugerir"')
    })
    const erro = await escritor.enviar(alertas).catch((e: unknown) => e)
    expect(erro).toBeInstanceOf(EscritaNaoAutorizadaError)
  })

  it('avisa quem cuida da cota quando vem 403 ou 429', async () => {
    const ruins: number[] = []
    const fetchImpl = (async () => new Response('{}', { status: 429 })) as unknown as typeof fetch
    const escritor = criarEscritorDeSeguranca({
      repositorio: REPO,
      fetchImpl,
      ritmo: criarRitmoDeEscrita({ esperar: async () => {}, agora: () => 0 }),
      aoReceberRespostaRuim: (r) => ruins.push(r.status),
    })
    await escritor.enviar(alertas)
    expect(ruins).toEqual([429])
  })
})
