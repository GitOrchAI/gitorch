import { describe, it, expect, vi } from 'vitest'
import { varrerRetratoDoProjeto, type VarreduraDoRetratoDeps } from './varredura-do-retrato.js'
import { classificarOrigemEIssueDoPr, type SessaoParaOrigem } from '../routes/github-webhook.js'
import type { AlertaDeSeguranca, DividaDeSeguranca } from './security-debt-collector.js'
import type { EstadoDoItem } from './ficha-do-item.js'

function ghGetFake(rotas: Record<string, unknown>) {
  return vi.fn(async (caminho: string) => {
    for (const [padrao, resposta] of Object.entries(rotas)) {
      if (caminho.startsWith(padrao)) return resposta
    }
    throw new Error(`rota não mapeada no teste: ${caminho}`)
  })
}

describe('varrerRetratoDoProjeto', () => {
  it('grava a ficha de cada PR e cada issue abertos', async () => {
    const atualizados: Array<{ tipo: string; numero: number }> = []
    const ghGet = ghGetFake({
      '/repos/dono/repo/pulls?': [{ number: 10, state: 'open', draft: false, mergeable: true }],
      '/repos/dono/repo/issues?': [{ number: 20, state: 'open', pull_request: undefined }],
    })
    const resumo = await varrerRetratoDoProjeto({
      repo: 'dono/repo',
      ghGet,
      atualizarFicha: async (args) => {
        atualizados.push({ tipo: args.tipo, numero: args.numero })
      },
    })
    expect(resumo).toEqual({
      prs: 1,
      issues: 1,
      alertas: 0,
      alertasFechados: 0,
      falhasDeAlerta: ['leitura-nao-configurada'],
    })
    expect(atualizados).toContainEqual({ tipo: 'pr', numero: 10 })
    expect(atualizados).toContainEqual({ tipo: 'issue', numero: 20 })
  })

  it('issue que é na verdade um pull request (a API do GitHub mistura os dois em /issues) é ignorada aqui', async () => {
    const atualizados: Array<{ tipo: string; numero: number }> = []
    const ghGet = ghGetFake({
      '/repos/dono/repo/pulls?': [],
      '/repos/dono/repo/issues?': [{ number: 20, state: 'open', pull_request: { url: 'x' } }],
    })
    await varrerRetratoDoProjeto({
      repo: 'dono/repo',
      ghGet,
      atualizarFicha: async (args) => {
        atualizados.push({ tipo: args.tipo, numero: args.numero })
      },
    })
    expect(atualizados).toEqual([])
  })

  it('issue #877: com backfillGrafo, tenta o backfill até o TETO por ciclo (nunca mais)', async () => {
    const ghGet = ghGetFake({
      '/repos/dono/repo/pulls?': [
        { number: 10, state: 'open', draft: false, mergeable: true },
        { number: 11, state: 'open', draft: false, mergeable: true },
      ],
      '/repos/dono/repo/issues?': [{ number: 20, state: 'open', pull_request: undefined }],
    })
    // `aplicar` retorna true = de fato disparou a coleta (item não tinha
    // grafo ainda) — é isso que consome o teto, não a mera chamada.
    const aplicar = vi.fn(async () => true)
    const resumo = await varrerRetratoDoProjeto({
      repo: 'dono/repo',
      ghGet,
      atualizarFicha: async () => {},
      backfillGrafo: { aplicar, teto: 1 },
    })
    expect(resumo).toEqual({
      prs: 2,
      issues: 1,
      alertas: 0,
      alertasFechados: 0,
      falhasDeAlerta: ['leitura-nao-configurada'],
    })
    expect(aplicar).toHaveBeenCalledTimes(1)
    expect(aplicar).toHaveBeenCalledWith({ tipo: 'pr', numero: 10 })
  })

  it('issue #877: itens que JÁ TÊM grafo não gastam o teto — o teto fica pra quem realmente precisa', async () => {
    // Bug real em produção (commit 4dfb2f86, ciclos 13:44 e 14:14 UTC de
    // 29/09): o contador do teto incrementava para TODO item do lote, mesmo
    // os que já tinham `vinculos` preenchido — então os 5 slots eram sempre
    // consumidos pelos itens mais recentes (já cobertos em ciclos
    // anteriores), e itens antigos sem grafo (ex.: PR #583) nunca eram
    // alcançados. Lote de 10 PRs: os 5 primeiros (1-5) já têm grafo
    // (`aplicar` retorna false = não coletou), os 5 últimos (6-10) não têm
    // (`aplicar` retorna true = coletou). Com teto=5, os 5 ÚLTIMOS devem ser
    // os que efetivamente disparam a coleta.
    const coletaram: number[] = []
    const aplicar = vi.fn(async ({ numero }: { tipo: string; numero: number }) => {
      const jaTinhaGrafo = numero <= 5
      if (jaTinhaGrafo) return false
      coletaram.push(numero)
      return true
    })
    const ghGet = ghGetFake({
      '/repos/dono/repo/pulls?': Array.from({ length: 10 }, (_, i) => ({
        number: i + 1,
        state: 'open',
        draft: false,
        mergeable: true,
      })),
      '/repos/dono/repo/issues?': [],
    })
    const resumo = await varrerRetratoDoProjeto({
      repo: 'dono/repo',
      ghGet,
      atualizarFicha: async () => {},
      backfillGrafo: { aplicar, teto: 5 },
    })
    expect(resumo).toEqual({
      prs: 10,
      issues: 0,
      alertas: 0,
      alertasFechados: 0,
      falhasDeAlerta: ['leitura-nao-configurada'],
    })
    // todos os 10 itens são ao menos consultados (pra saber se já têm grafo)…
    expect(aplicar).toHaveBeenCalledTimes(10)
    // …mas só os 5 últimos (sem grafo ainda) de fato coletaram.
    expect(coletaram).toEqual([6, 7, 8, 9, 10])
  })

  it('issue #877 (conserto pós-#979): com reclassificarOrigem, chama aplicar com o PR cru para cada PR', async () => {
    const ghGet = ghGetFake({
      '/repos/dono/repo/pulls?': [
        {
          number: 583,
          state: 'open',
          draft: false,
          mergeable: true,
          body: 'PR created automatically by Jules for task [16385381233224183643](https://jules.google.com/task/16385381233224183643) started by @loureng',
          user: { login: 'google-labs-jules[bot]' },
          labels: [],
          head: { ref: 'fix-tests-and-pipeline-check-16385381233224183643' },
        },
      ],
      '/repos/dono/repo/issues?': [],
    })
    const aplicar = vi.fn(async () => true)
    const resumo = await varrerRetratoDoProjeto({
      repo: 'dono/repo',
      ghGet,
      atualizarFicha: async () => {},
      reclassificarOrigem: { aplicar, teto: 5 },
    })
    expect(resumo).toEqual({
      prs: 1,
      issues: 0,
      alertas: 0,
      alertasFechados: 0,
      falhasDeAlerta: ['leitura-nao-configurada'],
    })
    expect(aplicar).toHaveBeenCalledTimes(1)
    expect(aplicar).toHaveBeenCalledWith({
      numero: 583,
      pr: expect.objectContaining({ number: 583 }),
    })
  })

  it('issue #877 (conserto pós-#979): reclassificarOrigem grava o RESULTADO da classificação, não só dispara a chamada — caso real do PR #583', async () => {
    // A revisão de QA achou o furo: o teste anterior só provava que `aplicar`
    // foi chamado com o PR cru. Não provava que a classificação de fato virou
    // `{ origem: 'jules_gitorch', issueNumber: 580 }` nem que quem grava a
    // ficha recebeu esses valores — o mesmo tipo de furo que deixou o bug real
    // do teto (commit 4dfb2f86) passar despercebido por dois ciclos em
    // produção. Este teste usa `classificarOrigemEIssueDoPr` de verdade (é
    // pura, sem rede — mockar aqui só esconderia um bug real na classificação)
    // com os dados reais do PR #583 e a sessão real da issue #580, e afirma
    // sobre o registro que `aplicar` grava — não sobre a chamada.
    const prCru583 = {
      number: 583,
      state: 'open',
      draft: false,
      mergeable: true,
      body: 'PR created automatically by Jules for task [16385381233224183643](https://jules.google.com/task/16385381233224183643) started by @loureng',
      user: { login: 'google-labs-jules[bot]' },
      labels: [],
      head: { ref: 'fix-tests-and-pipeline-check-16385381233224183643' },
    }
    const ghGet = ghGetFake({
      '/repos/dono/repo/pulls?': [prCru583],
      '/repos/dono/repo/issues?': [],
    })

    // A sessão real do dev assíncrono que faltava em produção (achado real
    // 29/09/2026): o branch do PR #583 termina no mesmo identificador que a
    // sessão da issue #580 usa.
    const sessoesDoProjeto: SessaoParaOrigem[] = [
      { sessionName: 'jules/16385381233224183643', issueNumber: 580, pullRequestNumber: null },
    ]

    // Simula o que `atualizarFichaDoItem` grava em produção (scheduler.ts) —
    // sem prisma, só pra provar que o valor certo chega até quem persiste.
    const fichasGravadas: Record<number, { origem: string; issueNumber: number | null }> = {}

    type ArgsDoAplicar = Parameters<
      NonNullable<VarreduraDoRetratoDeps['reclassificarOrigem']>['aplicar']
    >[0]
    const aplicar = vi.fn(async ({ numero, pr }: ArgsDoAplicar) => {
      const classificacao = classificarOrigemEIssueDoPr({
        payload: { pull_request: pr },
        commits: [],
        sessoesDoProjeto,
      })
      fichasGravadas[numero] = {
        origem: classificacao.origem,
        issueNumber: classificacao.issueNumber,
      }
      return true
    })

    await varrerRetratoDoProjeto({
      repo: 'dono/repo',
      ghGet,
      atualizarFicha: async () => {},
      reclassificarOrigem: { aplicar, teto: 5 },
    })

    // A prova real: não "aplicar foi chamado", e sim "o que foi gravado bate
    // com a classificação correta do caso real que motivou a issue #877".
    expect(fichasGravadas[583]).toEqual({ origem: 'jules_gitorch', issueNumber: 580 })
  })

  it('issue #877: reclassificarOrigem respeita o TETO por ciclo (nunca mais)', async () => {
    const ghGet = ghGetFake({
      '/repos/dono/repo/pulls?': [
        { number: 1, state: 'open', draft: false, mergeable: true },
        { number: 2, state: 'open', draft: false, mergeable: true },
      ],
      '/repos/dono/repo/issues?': [],
    })
    const aplicar = vi.fn(async () => true)
    await varrerRetratoDoProjeto({
      repo: 'dono/repo',
      ghGet,
      atualizarFicha: async () => {},
      reclassificarOrigem: { aplicar, teto: 1 },
    })
    expect(aplicar).toHaveBeenCalledTimes(1)
  })

  it('issue #877: PR já classificado corretamente (aplicar retorna false) não gasta o teto — o resto do lote continua sendo consultado', async () => {
    const ghGet = ghGetFake({
      '/repos/dono/repo/pulls?': [
        { number: 1, state: 'open', draft: false, mergeable: true },
        { number: 2, state: 'open', draft: false, mergeable: true },
        { number: 3, state: 'open', draft: false, mergeable: true },
      ],
      '/repos/dono/repo/issues?': [],
    })
    // PR 1 e 2 já classificados com confiança (aplicar decide isso sozinho,
    // igual ao backfillGrafo.aplicar) — só o 3 realmente reclassifica.
    const reclassificaram: number[] = []
    const aplicar = vi.fn(async ({ numero }: { numero: number }) => {
      if (numero !== 3) return false
      reclassificaram.push(numero)
      return true
    })
    await varrerRetratoDoProjeto({
      repo: 'dono/repo',
      ghGet,
      atualizarFicha: async () => {},
      reclassificarOrigem: { aplicar, teto: 1 },
    })
    expect(aplicar).toHaveBeenCalledTimes(3)
    expect(reclassificaram).toEqual([3])
  })

  it('reclassificarOrigem nunca é chamado para issues (só PRs têm origem classificada por webhook)', async () => {
    const ghGet = ghGetFake({
      '/repos/dono/repo/pulls?': [],
      '/repos/dono/repo/issues?': [{ number: 20, state: 'open', pull_request: undefined }],
    })
    const aplicar = vi.fn(async () => true)
    await varrerRetratoDoProjeto({
      repo: 'dono/repo',
      ghGet,
      atualizarFicha: async () => {},
      reclassificarOrigem: { aplicar, teto: 5 },
    })
    expect(aplicar).not.toHaveBeenCalled()
  })

  it('sem backfillGrafo (como hoje): comportamento antigo preservado, nenhum backfill tentado', async () => {
    const atualizados: Array<{ tipo: string; numero: number }> = []
    const ghGet = ghGetFake({
      '/repos/dono/repo/pulls?': [{ number: 10, state: 'open', draft: false, mergeable: true }],
      '/repos/dono/repo/issues?': [{ number: 20, state: 'open', pull_request: undefined }],
    })
    const resumo = await varrerRetratoDoProjeto({
      repo: 'dono/repo',
      ghGet,
      atualizarFicha: async (args) => {
        atualizados.push({ tipo: args.tipo, numero: args.numero })
      },
    })
    expect(resumo).toEqual({
      prs: 1,
      issues: 1,
      alertas: 0,
      alertasFechados: 0,
      falhasDeAlerta: ['leitura-nao-configurada'],
    })
    expect(atualizados).toContainEqual({ tipo: 'pr', numero: 10 })
    expect(atualizados).toContainEqual({ tipo: 'issue', numero: 20 })
  })
})

describe('varrerRetratoDoProjeto — alertas de segurança (Fase 1.2/5.2)', () => {
  const semPrsNemIssues = () =>
    ghGetFake({ '/repos/dono/repo/pulls?': [], '/repos/dono/repo/issues?': [] })

  function alertaDe(numero: number, parcial: Partial<AlertaDeSeguranca> = {}): AlertaDeSeguranca {
    return {
      numero,
      severidade: 'high',
      pacote: 'sharp',
      ecossistema: 'npm',
      manifesto: 'pnpm-lock.yaml',
      resumo: 'resumo',
      versaoCorrigida: '0.34.5',
      ghsa: `GHSA-${numero}`,
      url: `https://github.com/dono/repo/security/dependabot/${numero}`,
      criadoEm: '2026-10-01T00:00:00Z',
      escopo: 'runtime',
      ...parcial,
    }
  }

  function divida(alertas: AlertaDeSeguranca[], naoVerificado: string[] = []): DividaDeSeguranca {
    return {
      temConfiguracao: true,
      alertas,
      porSeveridade: { critical: 0, high: alertas.length, medium: 0, low: 0 },
      naoVerificado,
    }
  }

  it('alerta novo vira ficha tipo alerta com pacote, GHSA, gravidade, escopo e correção', async () => {
    const fichas: Array<{ tipo: string; numero: number; estado: EstadoDoItem }> = []
    const resumo = await varrerRetratoDoProjeto({
      repo: 'dono/repo',
      ghGet: semPrsNemIssues(),
      atualizarFicha: async (args) => {
        fichas.push(args)
      },
      alertas: {
        ler: async () => ({
          tipo: 'lido',
          divida: divida([alertaDe(7)]),
          lerFichaAtual: vi.fn(),
        }),
        numerosAbertosNaFicha: async () => [],
      },
    })
    expect(resumo.alertas).toBe(1)
    expect(resumo.falhasDeAlerta).toEqual([])
    const ficha = fichas.find((f) => f.tipo === 'alerta')
    expect(ficha?.numero).toBe(7)
    expect(ficha?.estado.status).toBe('open')
    expect(ficha?.estado.alerta).toMatchObject({
      pacote: 'sharp',
      ghsa: 'GHSA-7',
      gravidade: 'high',
      escopo: 'runtime',
      versaoCorrigida: '0.34.5',
      destino: 'sprint-atual',
    })
  })

  it('alerta que fechou no GitHub vira ficha fechada (com o estado real do GitHub)', async () => {
    const fichas: Array<{ tipo: string; numero: number; estado: EstadoDoItem }> = []
    const lerFichaAtual = vi.fn(async (_numero: number) => ({
      status: 'fixed',
      verificacao: 'high',
    }))
    const resumo = await varrerRetratoDoProjeto({
      repo: 'dono/repo',
      ghGet: semPrsNemIssues(),
      atualizarFicha: async (args) => {
        fichas.push(args)
      },
      alertas: {
        ler: async () => ({ tipo: 'lido', divida: divida([alertaDe(7)]), lerFichaAtual }),
        numerosAbertosNaFicha: async () => [3, 7],
      },
    })
    expect(lerFichaAtual).toHaveBeenCalledTimes(1)
    expect(lerFichaAtual).toHaveBeenCalledWith(3)
    expect(fichas).toContainEqual(
      expect.objectContaining({
        tipo: 'alerta',
        numero: 3,
        estado: expect.objectContaining({ status: 'fixed' }),
      })
    )
    expect(resumo.alertasFechados).toBe(1)
  })

  it('falha de API na leitura dos alertas não zera nada: nenhuma ficha fechada, falha contada', async () => {
    const atualizarFicha = vi.fn(async () => {})
    const numerosAbertosNaFicha = vi.fn(async () => [3, 7])
    const onWarn = vi.fn()
    const resumo = await varrerRetratoDoProjeto({
      repo: 'dono/repo',
      ghGet: semPrsNemIssues(),
      atualizarFicha,
      onWarn,
      alertas: {
        ler: async () => ({
          tipo: 'lido',
          divida: divida([], ['alertas']),
          lerFichaAtual: vi.fn(),
        }),
        numerosAbertosNaFicha,
      },
    })
    expect(atualizarFicha).not.toHaveBeenCalled()
    expect(numerosAbertosNaFicha).not.toHaveBeenCalled()
    expect(resumo.falhasDeAlerta).toContain('alertas')
    expect(onWarn).toHaveBeenCalledWith(expect.stringMatching(/alertas/))
  })

  it('leitura parcial (teto de páginas) grava o que leu mas não fecha ficha nenhuma', async () => {
    const lerFichaAtual = vi.fn()
    const resumo = await varrerRetratoDoProjeto({
      repo: 'dono/repo',
      ghGet: semPrsNemIssues(),
      atualizarFicha: async () => {},
      alertas: {
        ler: async () => ({
          tipo: 'lido',
          divida: divida([alertaDe(7)], ['alertas-parcial']),
          lerFichaAtual,
        }),
        numerosAbertosNaFicha: async () => [3, 7],
      },
    })
    expect(resumo.alertas).toBe(1)
    expect(lerFichaAtual).not.toHaveBeenCalled()
    expect(resumo.falhasDeAlerta).toEqual(['alertas-parcial'])
  })

  it('exceção ao ler os alertas é contada e logada, sem derrubar PRs e issues', async () => {
    const onWarn = vi.fn()
    const resumo = await varrerRetratoDoProjeto({
      repo: 'dono/repo',
      ghGet: semPrsNemIssues(),
      atualizarFicha: async () => {},
      onWarn,
      alertas: {
        ler: async () => {
          throw new Error('rede caiu')
        },
        numerosAbertosNaFicha: async () => [],
      },
    })
    expect(resumo.falhasDeAlerta).toEqual(['alertas'])
    expect(onWarn).toHaveBeenCalledWith(expect.stringMatching(/rede caiu/))
  })

  it('sem credencial que alcance o projeto: pula com mensagem clara, sem fingir zero', async () => {
    const onWarn = vi.fn()
    const resumo = await varrerRetratoDoProjeto({
      repo: 'dono/repo',
      ghGet: semPrsNemIssues(),
      atualizarFicha: async () => {},
      onWarn,
      alertas: {
        ler: async () => ({ tipo: 'sem-credencial', motivo: 'nenhuma credencial alcança' }),
        numerosAbertosNaFicha: async () => [],
      },
    })
    expect(resumo.falhasDeAlerta).toEqual(['sem-credencial'])
    expect(onWarn).toHaveBeenCalledWith(expect.stringMatching(/nenhuma credencial alcança/))
  })

  it('entrega os alertas lidos para a geração de tarefas e devolve o resumo', async () => {
    const gerarTarefas = vi.fn(async () => ({
      autorizado: true,
      criadas: [{ pacote: 'sharp', issue: 90, destino: 'sprint-atual' as const }],
      jaExistiam: 0,
      fechadasRecentemente: 0,
      adiadas: 0,
      semTarefa: 0,
      falhas: 0,
    }))
    const resumo = await varrerRetratoDoProjeto({
      repo: 'dono/repo',
      ghGet: semPrsNemIssues(),
      atualizarFicha: async () => {},
      alertas: {
        ler: async () => ({ tipo: 'lido', divida: divida([alertaDe(7)]), lerFichaAtual: vi.fn() }),
        numerosAbertosNaFicha: async () => [],
        gerarTarefas,
      },
    })
    expect(gerarTarefas).toHaveBeenCalledWith([expect.objectContaining({ numero: 7 })])
    expect(resumo.tarefasDeSeguranca?.criadas).toHaveLength(1)
  })
})

describe('varrerRetratoDoProjeto: vínculo da tarefa', () => {
  const prsAbertos = (numeros: number[]) =>
    numeros.map((number) => ({ number, state: 'open', draft: false, mergeable: true }))

  it('chama o vínculo para cada PR DEPOIS de baixar as issues, com as etiquetas da lista de issues abertas', async () => {
    const ordem: string[] = []
    const ghGet = vi.fn(async (caminho: string) => {
      ordem.push(caminho.includes('/pulls?') ? 'pulls' : 'issues')
      if (caminho.includes('/pulls?')) return prsAbertos([10, 11])
      return [
        { number: 74, state: 'open', labels: [{ name: 'jules' }, { name: 'gitorch:task' }] },
        { number: 75, state: 'open', labels: ['bug'] },
        { number: 76, state: 'open' },
      ]
    })
    const vistos: Array<{
      numero: number
      etiquetas74: readonly string[]
      etiquetas75: readonly string[]
      etiquetas76: readonly string[]
      etiquetas999: readonly string[]
    }> = []
    const aplicar = vi.fn(
      async (args: { numero: number; etiquetasDaIssue: (n: number) => readonly string[] }) => {
        ordem.push(`vincular-${args.numero}`)
        vistos.push({
          numero: args.numero,
          etiquetas74: args.etiquetasDaIssue(74),
          etiquetas75: args.etiquetasDaIssue(75),
          etiquetas76: args.etiquetasDaIssue(76),
          etiquetas999: args.etiquetasDaIssue(999),
        })
        return true
      }
    )

    await varrerRetratoDoProjeto({
      repo: 'dono/repo',
      ghGet,
      atualizarFicha: async () => {},
      vincularTarefa: { aplicar, teto: 5, orcamentoMs: 8000 },
    })

    expect(ordem).toEqual(['pulls', 'issues', 'vincular-10', 'vincular-11'])
    expect(aplicar).toHaveBeenCalledWith(
      expect.objectContaining({ numero: 10, pr: expect.objectContaining({ number: 10 }) })
    )
    expect(vistos[0]).toEqual({
      numero: 10,
      etiquetas74: ['jules', 'gitorch:task'],
      etiquetas75: ['bug'],
      etiquetas76: [],
      etiquetas999: [],
    })
  })

  it('sem o gancho, nada muda (comportamento de antes)', async () => {
    const resumo = await varrerRetratoDoProjeto({
      repo: 'dono/repo',
      ghGet: ghGetFake({
        '/repos/dono/repo/pulls?': prsAbertos([10]),
        '/repos/dono/repo/issues?': [],
      }),
      atualizarFicha: async () => {},
    })
    expect(resumo.prs).toBe(1)
  })

  it('só gasta o teto quem o gancho diz que procurou (true); respeita o teto por ciclo', async () => {
    const chamados: number[] = []
    const aplicar = vi.fn(async ({ numero }: { numero: number }) => {
      chamados.push(numero)
      return numero > 3 // 1 a 3 não tinham nada a procurar
    })

    await varrerRetratoDoProjeto({
      repo: 'dono/repo',
      ghGet: ghGetFake({
        '/repos/dono/repo/pulls?': prsAbertos([1, 2, 3, 4, 5, 6, 7, 8, 9]),
        '/repos/dono/repo/issues?': [],
      }),
      atualizarFicha: async () => {},
      vincularTarefa: { aplicar, teto: 2, orcamentoMs: 8000 },
    })

    expect(chamados).toEqual([1, 2, 3, 4, 5])
  })

  it('para quando o orçamento de tempo do projeto acaba e avisa uma vez', async () => {
    const onWarn = vi.fn()
    let agoraMs = 0
    const aplicar = vi.fn(async () => {
      agoraMs += 3000
      return true
    })

    await varrerRetratoDoProjeto({
      repo: 'dono/repo',
      ghGet: ghGetFake({
        '/repos/dono/repo/pulls?': prsAbertos([1, 2, 3, 4, 5]),
        '/repos/dono/repo/issues?': [],
      }),
      atualizarFicha: async () => {},
      onWarn,
      vincularTarefa: { aplicar, teto: 5, orcamentoMs: 8000, agora: () => agoraMs },
    })

    // 0 s, 3 s, 6 s dentro do orçamento; aos 9 s a varredura para.
    expect(aplicar).toHaveBeenCalledTimes(3)
    const avisos = onWarn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('orçamento'))
    expect(avisos).toHaveLength(1)
  })

  it('erro do gancho vira aviso, conta no teto e não derruba a varredura', async () => {
    const onWarn = vi.fn()
    const aplicar = vi.fn(async () => {
      throw new Error('graphql fora do ar')
    })

    const resumo = await varrerRetratoDoProjeto({
      repo: 'dono/repo',
      ghGet: ghGetFake({
        '/repos/dono/repo/pulls?': prsAbertos([1, 2, 3]),
        '/repos/dono/repo/issues?': [],
      }),
      atualizarFicha: async () => {},
      onWarn,
      vincularTarefa: { aplicar, teto: 2, orcamentoMs: 8000 },
    })

    expect(resumo.prs).toBe(3)
    expect(aplicar).toHaveBeenCalledTimes(2)
    expect(onWarn).toHaveBeenCalledWith(
      expect.stringMatching(/vínculo da tarefa.*#1.*graphql fora do ar/)
    )
  })
})

describe('varrerRetratoDoProjeto: conferência da tarefa', () => {
  const issuesDoGitHub = [
    {
      number: 20,
      state: 'open',
      title: 'Tarefa no padrão',
      body: 'corpo vinte',
      labels: [{ name: 'gitorch:task' }, 'bug'],
    },
    { number: 21, state: 'open', title: 'Sem corpo', body: null, labels: [] },
    { number: 22, state: 'open', title: 'PR disfarçado', pull_request: { url: 'x' } },
    { number: 23, state: 'open' }, // resposta sem título: não dá para conferir
  ]

  function rotas() {
    return ghGetFake({
      '/repos/dono/repo/pulls?': [],
      '/repos/dono/repo/issues?': issuesDoGitHub,
    })
  }

  it('entrega título, corpo e etiquetas de cada issue (nunca PR) ao gancho, sem chamada nova ao GitHub', async () => {
    const ghGet = rotas()
    const conferirTarefa = vi.fn(async () => undefined)
    await varrerRetratoDoProjeto({
      repo: 'dono/repo',
      ghGet,
      atualizarFicha: async () => {},
      conferirTarefa,
    })
    expect(conferirTarefa.mock.calls).toEqual([
      [
        {
          numero: 20,
          titulo: 'Tarefa no padrão',
          corpo: 'corpo vinte',
          etiquetas: ['gitorch:task', 'bug'],
        },
      ],
      [{ numero: 21, titulo: 'Sem corpo', corpo: '', etiquetas: [] }],
    ])
    // só as duas leituras de sempre: PRs e issues
    expect(ghGet).toHaveBeenCalledTimes(2)
  })

  it('o gancho roda DEPOIS de a ficha da issue ser gravada', async () => {
    const ordem: string[] = []
    await varrerRetratoDoProjeto({
      repo: 'dono/repo',
      ghGet: rotas(),
      atualizarFicha: async (a) => {
        ordem.push(`ficha ${a.tipo} ${a.numero}`)
      },
      conferirTarefa: async (i) => {
        ordem.push(`confere ${i.numero}`)
      },
    })
    expect(ordem.indexOf('ficha issue 20')).toBeLessThan(ordem.indexOf('confere 20'))
    expect(ordem.indexOf('ficha issue 21')).toBeLessThan(ordem.indexOf('confere 21'))
  })

  it('erro do gancho vira aviso e a varredura segue para a próxima issue', async () => {
    const avisos: string[] = []
    const conferirTarefa = vi.fn(async (i: { numero: number }) => {
      if (i.numero === 20) throw new Error('quadro fora do ar')
    })
    const resumo = await varrerRetratoDoProjeto({
      repo: 'dono/repo',
      ghGet: rotas(),
      atualizarFicha: async () => {},
      conferirTarefa,
      onWarn: (m) => avisos.push(m),
    })
    expect(conferirTarefa).toHaveBeenCalledTimes(2)
    expect(resumo.issues).toBe(3)
    expect(avisos.some((a) => a.includes('#20') && a.includes('quadro fora do ar'))).toBe(true)
  })

  it('sem o gancho, nada muda (comportamento de antes)', async () => {
    const resumo = await varrerRetratoDoProjeto({
      repo: 'dono/repo',
      ghGet: rotas(),
      atualizarFicha: async () => {},
    })
    expect(resumo.issues).toBe(3)
  })
})
