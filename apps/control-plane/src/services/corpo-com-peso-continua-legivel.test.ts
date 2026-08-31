import { describe, it, expect } from 'vitest'
import { applyBacklog, type BacklogGitHub, type BacklogPlan } from './backlog-executor.js'
import { arquivosDeclarados } from './secao-da-issue.js'
import { runSmDelegation, extractBlockers } from './sm-delegation.js'
import { montarPedidoAoDev } from './pedido-ao-dev.js'
import type { DoDFields } from '@gitorch/cadence'

// L3-T8 — O LADO DE QUEM LÊ.
//
// A entrega meteu uma seção nova ("## Peso") ANTES do "## Goal", no topo do
// corpo de toda issue de task. Esse corpo não é enfeite: TRÊS serviços em
// produção o leem por cabeçalho, via `lerSecaoDaIssue` (secao-da-issue.ts) —
// `sm-delegation` (Related Files + "Blocked by"), `qa-rails-mission`
// (Verification Criteria) e `pedido-ao-dev` (Implementation Guide). Mudar o
// topo do documento sem provar quem o parseia é exatamente como se quebra um
// leitor em silêncio: nada estoura, a seção só volta vazia e o produto age
// com menos informação do que tem.
//
// O corpo destes testes NÃO é fixture escrita à mão. É o corpo que
// `applyBacklog` publicaria hoje no GitHub, gerado aqui pela mesma função de
// produção — fixture antiga passaria verde justamente por não ter o "## Peso"
// que é o risco. As asserções olham o RESULTADO de cada leitor: o arquivo
// achado, a task delegada, o passo na lista de conferência.
// (O terceiro leitor, o julgamento do QA, é provado ponta a ponta em
// qa-rails-mission.test.ts — lá a missão inteira roda contra este mesmo corpo.)

function fields(over: Partial<DoDFields> = {}): DoDFields {
  return {
    titulo: '[Task] schema',
    goal: 'Filtrar por material.',
    taskDetails: 'Coluna nova e filtro na listagem.',
    taskDescription: 'O dono filtra os produtos por material.',
    implementationGuide:
      '1. Migração criando a coluna material\n' +
      '2. Filtro na rota de listagem\n' +
      '3. Ligar o filtro na tela do catálogo',
    verificationCriteria: '- GET /produtos?material=couro devolve só couro\n- teste de API verde',
    dependencies: 'nenhuma',
    relatedFiles: 'src/produtos/rota.ts, src/db/migracoes/0007.sql',
    notes: 'n',
    ...over,
  }
}

/** O plano mínimo que produz DUAS tasks, a segunda bloqueada pela primeira. */
function plano(): BacklogPlan {
  return {
    wish: { number: 100, nodeId: 'I_wish' },
    journeysCount: 1,
    phases: [
      {
        title: 'Fase 1 — Dados',
        goal: 'estruturar',
        rationale: 'base',
        usableOutcome: 'O dono filtra os produtos por material e vê o resultado certo.',
      },
    ],
    epics: [
      { phaseIndex: 0, title: 'Épico: coluna material', description: 'desc', journeyIndexes: [0] },
    ],
    features: [{ epicIndex: 0, title: '[Feature] filtro', description: 'filtro por material' }],
    tasks: [
      {
        featureIndex: 0,
        fields: fields(),
        weight: 3,
        weightRationale: 'Uma coluna nova e um filtro; o padrão já existe no schema.',
      },
      {
        featureIndex: 0,
        fields: fields({
          titulo: '[Task] tela',
          relatedFiles: 'src/produtos/rota.ts',
          implementationGuide: '1. Ligar o filtro na tela',
        }),
        blockedByTaskIndexes: [0],
        weight: 8,
        weightRationale: 'Toca duas telas e a rota; a incerteza está no cache.',
      },
    ],
    roadmap: {
      sprintGoal: 'Filtrar por material',
      assignments: [
        { taskIndex: 0, sprint: 1 },
        { taskIndex: 1, sprint: 1 },
      ],
    },
  }
}

/**
 * Publica o plano e devolve os corpos REAIS das duas tasks, com o número da
 * issue que cada uma recebeu. É o mesmo caminho da produção — inclusive a
 * linha "Blocked by #N", que `applyBacklog` cola DEPOIS do corpo.
 */
async function corposPublicados(): Promise<Array<{ numero: number; corpo: string }>> {
  const criadas: Array<{ numero: number; title: string; body: string }> = []
  let n = 0
  const gh: BacklogGitHub = {
    async findIssueByMarker() {
      return null
    },
    async createIssue(input) {
      n += 1
      criadas.push({ numero: n, title: input.title, body: input.body })
      return { number: n, nodeId: `I_${n}` }
    },
    async addSubIssue() {},
    async addToBoard(nodeId) {
      return `PVTI_${nodeId}`
    },
    async setSprint() {},
    async addLabels() {},
  }
  await applyBacklog({ github: gh, plan: plano() })
  return criadas
    .filter((c) => c.title.startsWith('[Task]'))
    .map((c) => ({ numero: c.numero, corpo: c.body }))
}

describe('o corpo novo (com "## Peso" no topo) continua legível pelos três leitores', () => {
  it('o corpo gerado REALMENTE tem o "## Peso" antes do "## Goal" — senão estes testes não provam nada', async () => {
    const [primeira] = await corposPublicados()
    const corpo = primeira!.corpo
    expect(corpo.indexOf('## Peso')).toBeGreaterThan(-1)
    expect(corpo.indexOf('## Peso')).toBeLessThan(corpo.indexOf('## Goal'))
  })

  it('sm-delegation: acha os arquivos declarados e os bloqueios no corpo novo', async () => {
    const [primeira, segunda] = await corposPublicados()

    expect(arquivosDeclarados(primeira!.corpo)).toEqual([
      'src/produtos/rota.ts',
      'src/db/migracoes/0007.sql',
    ])
    expect(extractBlockers(segunda!.corpo)).toEqual([primeira!.numero])
  })

  it('sm-delegation ponta a ponta: a task bloqueada NÃO é delegada, a livre é', async () => {
    const [primeira, segunda] = await corposPublicados()
    const delegadas: number[] = []

    const f = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const u = String(url)
      const metodo = init?.method ?? 'GET'
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200 })

      if (u.includes('/issues?') && u.includes('gitorch%3Atask')) {
        return json([
          { number: primeira!.numero, labels: [{ name: 'gitorch:task' }], body: primeira!.corpo },
          { number: segunda!.numero, labels: [{ name: 'gitorch:task' }], body: segunda!.corpo },
        ])
      }
      // O bloqueador (a primeira task) segue ABERTO.
      const m = u.match(/\/issues\/(\d+)$/)
      if (m && metodo === 'GET') return json({ number: Number(m[1]), state: 'open' })
      const lm = u.match(/\/issues\/(\d+)\/labels$/)
      if (lm && metodo === 'POST') {
        const corpo = init?.body ? (JSON.parse(String(init.body)) as { labels: string[] }) : null
        if (corpo?.labels.includes('jules')) delegadas.push(Number(lm[1]))
        return json([])
      }
      return json({})
    }) as typeof fetch

    const r = await runSmDelegation({ repository: 'o/r', githubToken: 't', fetchImpl: f })

    // A segunda depende da primeira, que está aberta: entregá-la agora seria
    // mandar o dev trabalhar em cima do que ainda não existe.
    expect(delegadas).toEqual([primeira!.numero])
    expect(r.delegated).toEqual([primeira!.numero])
  })

  it('pedido-ao-dev: os 3 passos do Implementation Guide viram lista de conferência', async () => {
    const [primeira] = await corposPublicados()

    const pedido = montarPedidoAoDev({
      numero: primeira!.numero,
      repositorio: 'GitOrchAI/gitorch',
      titulo: '[Task] schema',
      corpo: primeira!.corpo,
    })

    // O RESULTADO: a lista numerada que o dev tem que ticar antes de abrir o
    // PR. Corpo mal lido devolve seção vazia e a lista SOME sem erro nenhum —
    // que é o defeito silencioso que este teste existe para pegar.
    expect(pedido).toContain('  1. [ ] Migração criando a coluna material')
    expect(pedido).toContain('  2. [ ] Filtro na rota de listagem')
    expect(pedido).toContain('  3. [ ] Ligar o filtro na tela do catálogo')
    // E a seção do peso NÃO vaza para dentro da lista de passos: o "**3**
    // (escala 1, 2, 3, 5, 8, 13)" não é um passo de implementação.
    expect(pedido).not.toContain('[ ] **3**')
  })
})
