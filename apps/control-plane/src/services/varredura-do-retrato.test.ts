import { describe, it, expect, vi } from 'vitest'
import { varrerRetratoDoProjeto, type VarreduraDoRetratoDeps } from './varredura-do-retrato.js'
import { classificarOrigemEIssueDoPr, type SessaoParaOrigem } from '../routes/github-webhook.js'

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
    expect(resumo).toEqual({ prs: 1, issues: 1, alertas: 0 })
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
    expect(resumo).toEqual({ prs: 2, issues: 1, alertas: 0 })
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
    expect(resumo).toEqual({ prs: 10, issues: 0, alertas: 0 })
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
    expect(resumo).toEqual({ prs: 1, issues: 0, alertas: 0 })
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
    expect(resumo).toEqual({ prs: 1, issues: 1, alertas: 0 })
    expect(atualizados).toContainEqual({ tipo: 'pr', numero: 10 })
    expect(atualizados).toContainEqual({ tipo: 'issue', numero: 20 })
  })
})
