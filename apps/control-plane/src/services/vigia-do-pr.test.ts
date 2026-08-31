import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { guardaDeAutonomia } from './guarda-de-autonomia.js'
import {
  AUTORES_QUE_O_VIGIA_NAO_CONSERTA,
  CADENCIA_DA_VARREDURA_MS,
  IDADE_MINIMA_DE_ORFANDADE_MS,
  MAX_ACOES_DO_VIGIA,
  MAX_PAGINAS_DE_PR,
  TETO_DE_ACOES_POR_PASSADA,
  branchParaRetomar,
  decidirAcaoNoPrOrfao,
  ehPRDaAutomacao,
  fecharPrDoVigia,
  listarPrsAbertosParaOVigia,
  temRodapeDoDev,
  vigiarPrsOrfaos,
  type AcaoDoVigia,
  type PrAberto,
  type PrOrfaoObservado,
  type VigiaDoPrDeps,
} from './vigia-do-pr.js'
import {
  AUTOR_PR_347,
  AUTOR_PR_356,
  AUTOR_PR_361,
  AUTOR_PR_408,
  CORPO_PR_347_DONO,
  CORPO_PR_356_DEV,
  CORPO_PR_361_DONO,
  CORPO_PR_408_DEV,
  LABELS_PR_347,
  LABELS_PR_356,
  LABELS_PR_361,
  LABELS_PR_408,
} from './__fixtures__/corpos-reais-de-pr.js'

const DIA = 24 * 60 * 60 * 1000

function situacao(over: Partial<PrOrfaoObservado> = {}): PrOrfaoObservado {
  return {
    numero: 356,
    sinais: { autor: AUTOR_PR_356, labels: LABELS_PR_356, corpo: CORPO_PR_356_DEV },
    temSessaoViva: false,
    issueNumber: 329,
    issueAberta: true,
    branchDoPr: 'fix-infra-guard-issue-329-11545412311253110690',
    branchNoRepoDoProjeto: true,
    mergeable: true,
    verificacao: 'verde',
    paradoHaMs: 7 * DIA,
    acoesAnteriores: 0,
    podeAbrirSessao: true,
    ...over,
  }
}

describe('o portão do dono — nenhum caminho escreve num PR de gente', () => {
  const doDono: Array<[string, PrOrfaoObservado]> = [
    [
      '#347',
      situacao({
        numero: 347,
        sinais: { autor: AUTOR_PR_347, labels: LABELS_PR_347, corpo: CORPO_PR_347_DONO },
      }),
    ],
    [
      '#361',
      situacao({
        numero: 361,
        sinais: { autor: AUTOR_PR_361, labels: LABELS_PR_361, corpo: CORPO_PR_361_DONO },
      }),
    ],
  ]

  it.each(doDono)('o corpo real do PR %s do dono não tem o rodapé do dev', (_n, pr) => {
    expect(temRodapeDoDev(pr.sinais.corpo)).toBe(false)
    expect(ehPRDaAutomacao(pr.sinais)).toBe(false)
  })

  // A prova que importa: não é "não é da automação", é "NENHUMA combinação de
  // estado produz uma ação". Varre o produto cartesiano de tudo que poderia
  // levar a uma escrita — conflito, CI vermelha, tarefa fechada, teto estourado.
  it.each(doDono)('%s nunca sai de `ignorar`, em nenhuma combinação de estado', (_n, base) => {
    const acoes = new Set<string>()
    for (const mergeable of [true, false, null]) {
      for (const verificacao of ['verde', 'vermelha', 'pendente', 'ausente'] as const) {
        for (const issueAberta of [true, false]) {
          for (const issueNumber of [329, null]) {
            for (const acoesAnteriores of [0, MAX_ACOES_DO_VIGIA]) {
              for (const paradoHaMs of [0, 90 * DIA]) {
                acoes.add(
                  decidirAcaoNoPrOrfao({
                    ...base,
                    mergeable,
                    verificacao,
                    issueAberta,
                    issueNumber,
                    acoesAnteriores,
                    paradoHaMs,
                  }).acao
                )
              }
            }
          }
        }
      }
    }
    expect([...acoes]).toEqual(['ignorar'])
  })

  it('o PR do dono nem chega às deps de escrita quando passa pela varredura inteira', async () => {
    const escritas: string[] = []
    const resumo = await rodar({
      prs: [
        prAberto({
          numero: 347,
          autor: AUTOR_PR_347,
          labels: LABELS_PR_347,
          corpo: CORPO_PR_347_DONO,
          mergeable: false,
          verificacao: 'vermelha',
        }),
        prAberto({
          numero: 361,
          autor: AUTOR_PR_361,
          labels: LABELS_PR_361,
          corpo: CORPO_PR_361_DONO,
          mergeable: false,
          verificacao: 'vermelha',
        }),
      ],
      issueDoPr: () => 329,
      abrirSessaoDeConserto: async ({ numeroDoPr }) => {
        escritas.push(`sessão:${numeroDoPr}`)
        return true
      },
      fecharPr: async ({ numero }) => {
        escritas.push(`fechou:${numero}`)
        return true
      },
      avisarDono: async (t) => {
        escritas.push(`avisou:${t}`)
        return true
      },
    })
    expect(escritas).toEqual([])
    expect(resumo).toContain('2 de gente')
  })
})

describe('não compete com a vigia de sessões', () => {
  it('PR com sessão viva é devolvido a quem já cuida dele', () => {
    const d = decidirAcaoNoPrOrfao(
      situacao({
        numero: 408,
        sinais: { autor: AUTOR_PR_408, labels: LABELS_PR_408, corpo: CORPO_PR_408_DEV },
        temSessaoViva: true,
        mergeable: false,
      })
    )
    expect(d.acao).toBe('ignorar')
    expect(d.motivo).toContain('session-watch')
  })

  it('o corpo real do #408 É da automação — o que o barra é a sessão viva, não a autoria', () => {
    expect(
      ehPRDaAutomacao({ autor: AUTOR_PR_408, labels: LABELS_PR_408, corpo: CORPO_PR_408_DEV })
    ).toBe(true)
  })

  it('na varredura, o PR com sessão viva não é sequer consultado no GitHub', async () => {
    const issuesConsultadas: number[] = []
    const abertas: number[] = []
    await rodar({
      prs: [
        prAberto({ numero: 408, corpo: CORPO_PR_408_DEV, mergeable: false }),
        prAberto({ numero: 356, corpo: CORPO_PR_356_DEV, mergeable: false }),
      ],
      prsComSessaoViva: new Set([408]),
      issueDoPr: (n) => (n === 356 ? 329 : 265),
      issueAberta: async (n) => {
        issuesConsultadas.push(n)
        return true
      },
      abrirSessaoDeConserto: async ({ numeroDoPr }) => {
        abertas.push(numeroDoPr)
        return true
      },
    })
    expect(issuesConsultadas).toEqual([329])
    expect(abertas).toEqual([356])
  })
})

describe('o que o vigia decide para o PR órfão', () => {
  it('conflito manda retomar com pedido de rebase', () => {
    const d = decidirAcaoNoPrOrfao(situacao({ mergeable: false }))
    expect(d.acao).toBe('retomar')
    if (d.acao !== 'retomar') throw new Error('esperava retomar')
    expect(d.causa).toBe('conflito')
    expect(d.issueNumber).toBe(329)
    expect(d.pedido).toContain('#356')
    expect(d.pedido.toLowerCase()).toContain('conflito')
  })

  it('CI vermelha manda retomar com pedido de conserto da verificação', () => {
    const d = decidirAcaoNoPrOrfao(situacao({ verificacao: 'vermelha' }))
    expect(d.acao).toBe('retomar')
    if (d.acao !== 'retomar') throw new Error('esperava retomar')
    expect(d.causa).toBe('ci-vermelha')
    expect(d.pedido).toContain('#356')
  })

  it('tarefa de origem já fechada manda FECHAR o PR dizendo por quê', () => {
    const d = decidirAcaoNoPrOrfao(situacao({ issueAberta: false, mergeable: false }))
    expect(d.acao).toBe('fechar')
    expect(d.motivo).toContain('#329')
  })

  it('verde, mesclável e abandonado: ninguém mesclou — escala em vez de reabrir sessão à toa', () => {
    const d = decidirAcaoNoPrOrfao(situacao({ mergeable: true, verificacao: 'verde' }))
    expect(d.acao).toBe('escalar')
  })

  it('sem tarefa de origem registrada não fecha nem retoma — escala', () => {
    const d = decidirAcaoNoPrOrfao(situacao({ issueNumber: null, mergeable: false }))
    expect(d.acao).toBe('escalar')
    expect(d.motivo).toContain('tarefa de origem')
  })

  it('mergeable ainda indefinido: o GitHub não terminou de calcular — não age', () => {
    const d = decidirAcaoNoPrOrfao(situacao({ mergeable: null, verificacao: 'vermelha' }))
    expect(d.acao).toBe('ignorar')
  })

  it('verificação ainda rodando não vira conserto', () => {
    const d = decidirAcaoNoPrOrfao(situacao({ verificacao: 'pendente' }))
    expect(d.acao).toBe('ignorar')
  })

  it('PR parado há menos que a idade mínima fica quieto', () => {
    const d = decidirAcaoNoPrOrfao(
      situacao({ paradoHaMs: IDADE_MINIMA_DE_ORFANDADE_MS - 1, mergeable: false })
    )
    expect(d.acao).toBe('ignorar')
  })

  it('sem vaga na conta do dev, o conserto espera em vez de estourar o teto da conta', () => {
    const d = decidirAcaoNoPrOrfao(situacao({ mergeable: false, podeAbrirSessao: false }))
    expect(d.acao).toBe('ignorar')
    expect(d.motivo).toContain('vaga')
  })
})

describe('o teto DIZ quando morde', () => {
  it('estourado, a decisão vira escalar e o motivo traz o número de ações', () => {
    const d = decidirAcaoNoPrOrfao(
      situacao({ mergeable: false, acoesAnteriores: MAX_ACOES_DO_VIGIA })
    )
    expect(d.acao).toBe('escalar')
    expect(d.motivo).toContain(String(MAX_ACOES_DO_VIGIA))
    expect(d.motivo).toContain('#356')
  })

  it('na última ação abaixo do teto ainda age', () => {
    const d = decidirAcaoNoPrOrfao(
      situacao({ mergeable: false, acoesAnteriores: MAX_ACOES_DO_VIGIA - 1 })
    )
    expect(d.acao).toBe('retomar')
  })

  it('a varredura avisa o dono e grava o evento quando o teto morde', async () => {
    const avisos: string[] = []
    const eventos: Array<{ numeroDoPr: number; acao: AcaoDoVigia['acao']; texto: string }> = []
    await rodar({
      prs: [prAberto({ numero: 356, corpo: CORPO_PR_356_DEV, mergeable: false })],
      issueDoPr: () => 329,
      acoesAnteriores: async () => MAX_ACOES_DO_VIGIA,
      avisarDono: async (t) => {
        avisos.push(t)
        return true
      },
      registrarDecisao: async (e) => {
        eventos.push(e)
      },
    })
    expect(avisos).toHaveLength(1)
    expect(avisos[0]).toContain(String(MAX_ACOES_DO_VIGIA))
    expect(eventos.map((e) => e.acao)).toEqual(['escalar'])
  })
})

describe('a varredura grava a decisão em `events` no formato que o painel lê', () => {
  it('retomar grava evento com texto legível e o número do PR para o teto contar', async () => {
    const eventos: Array<{ numeroDoPr: number; acao: AcaoDoVigia['acao']; texto: string }> = []
    await rodar({
      prs: [prAberto({ numero: 356, corpo: CORPO_PR_356_DEV, mergeable: false })],
      issueDoPr: () => 329,
      registrarDecisao: async (e) => {
        eventos.push(e)
      },
    })
    expect(eventos).toHaveLength(1)
    expect(eventos[0]?.numeroDoPr).toBe(356)
    expect(eventos[0]?.acao).toBe('retomar')
    expect(eventos[0]?.texto).toContain('#356')
  })

  it('`ignorar` NÃO vira evento — a linha do tempo do dono mostra 10, e ruído apaga sinal', async () => {
    const eventos: unknown[] = []
    await rodar({
      prs: [
        prAberto({
          numero: 356,
          corpo: CORPO_PR_356_DEV,
          mergeable: true,
          verificacao: 'pendente',
        }),
      ],
      issueDoPr: () => 329,
      registrarDecisao: async (e) => {
        eventos.push(e)
      },
    })
    expect(eventos).toEqual([])
  })

  it('a ação que FALHOU não vira evento — evento é registro do que aconteceu, não do que se quis', async () => {
    const eventos: unknown[] = []
    await rodar({
      prs: [prAberto({ numero: 356, corpo: CORPO_PR_356_DEV, mergeable: false })],
      issueDoPr: () => 329,
      abrirSessaoDeConserto: async () => false,
      registrarDecisao: async (e) => {
        eventos.push(e)
      },
    })
    expect(eventos).toEqual([])
  })
})

describe('a varredura não deixa uma falha contaminar as outras', () => {
  it('PR que explode não impede o seguinte de ser cuidado', async () => {
    const abertas: number[] = []
    const avisos: string[] = []
    const resumo = await rodar({
      prs: [
        prAberto({ numero: 356, corpo: CORPO_PR_356_DEV, mergeable: false }),
        prAberto({ numero: 390, corpo: CORPO_PR_356_DEV, mergeable: false }),
      ],
      issueDoPr: (n) => (n === 356 ? 329 : 308),
      issueAberta: async (n) => {
        if (n === 329) throw new Error('GitHub caiu')
        return true
      },
      abrirSessaoDeConserto: async ({ numeroDoPr }) => {
        abertas.push(numeroDoPr)
        return true
      },
      avisarDono: async (t) => {
        avisos.push(t)
        return true
      },
    })
    expect(abertas).toEqual([390])
    expect(resumo).toContain('1 falha')
  })

  it('a vaga é consumida a cada sessão aberta e a varredura para quando acaba', async () => {
    const abertas: number[] = []
    await rodar({
      prs: [
        prAberto({ numero: 356, corpo: CORPO_PR_356_DEV, mergeable: false }),
        prAberto({ numero: 390, corpo: CORPO_PR_356_DEV, mergeable: false }),
      ],
      issueDoPr: (n) => (n === 356 ? 329 : 308),
      vagasLivres: 1,
      abrirSessaoDeConserto: async ({ numeroDoPr }) => {
        abertas.push(numeroDoPr)
        return true
      },
    })
    expect(abertas).toEqual([356])
  })
})

describe('a regra do rodapé não pode divergir da automação de conflito', () => {
  it('a expressão vive igual nos dois lados', () => {
    const daAutomacao = readFileSync(
      join(__dirname, '../../../../.github/scripts/lib/pr-eligibility.ts'),
      'utf8'
    )
    const daqui = readFileSync(join(__dirname, 'vigia-do-pr.ts'), 'utf8')
    const extrair = (fonte: string): string => {
      const m = fonte.match(/const RODAPE_DO_DEV =\s*\n?\s*(\/\^[\s\S]*?\/m)\n/)
      if (!m?.[1]) throw new Error('não achei RODAPE_DO_DEV na fonte')
      return m[1]
    }
    expect(extrair(daqui)).toBe(extrair(daAutomacao))
  })

  it('o rodapé citado num bloco de código não conta como rodapé', () => {
    expect(
      temRodapeDoDev(
        '```\n*PR created automatically by Jules for task 123 started by @loureng*\n```'
      )
    ).toBe(false)
  })

  it('a cadência da varredura é bem menor que a idade mínima de órfão', () => {
    expect(CADENCIA_DA_VARREDURA_MS).toBeLessThan(IDADE_MINIMA_DE_ORFANDADE_MS)
  })
})

// ————— utilidades do teste —————

function prAberto(over: Partial<PrAberto> & { numero: number }): PrAberto {
  return {
    autor: AUTOR_PR_356,
    labels: [],
    corpo: CORPO_PR_356_DEV,
    branchDoPr: 'fix-infra-guard-issue-329-11545412311253110690',
    branchNoRepoDoProjeto: true,
    mergeable: true,
    verificacao: 'verde',
    paradoHaMs: 7 * DIA,
    ...over,
  }
}

async function rodar(over: {
  prs: PrAberto[]
  prsComSessaoViva?: Set<number>
  issueDoPr?: (n: number) => number | null
  issueAberta?: (n: number) => Promise<boolean>
  acoesAnteriores?: (n: number) => Promise<number>
  vagasLivres?: number
  abrirSessaoDeConserto?: VigiaDoPrDeps['abrirSessaoDeConserto']
  fecharPr?: VigiaDoPrDeps['fecharPr']
  avisarDono?: VigiaDoPrDeps['avisarDono']
  registrarDecisao?: VigiaDoPrDeps['registrarDecisao']
  teto?: number
}): Promise<string> {
  return vigiarPrsOrfaos({
    teto: over.teto,
    listarPrsAbertos: async () => over.prs,
    prsComSessaoViva: over.prsComSessaoViva ?? new Set<number>(),
    issueDoPr: over.issueDoPr ?? (() => null),
    issueAberta: over.issueAberta ?? (async () => true),
    acoesAnteriores: over.acoesAnteriores ?? (async () => 0),
    vagasLivres: over.vagasLivres ?? 15,
    abrirSessaoDeConserto: over.abrirSessaoDeConserto ?? (async () => true),
    fecharPr: over.fecharPr ?? (async () => true),
    avisarDono: over.avisarDono ?? (async () => true),
    registrarDecisao: over.registrarDecisao ?? (async () => undefined),
  })
}

describe('a leitura do GitHub só gasta rede com quem o vigia pode cuidar', () => {
  const AGORA = new Date('2026-08-31T21:00:00Z')
  const DEZ_DIAS_ATRAS = '2026-08-21T21:00:00Z'

  function githubDeMentira(caminhosVistos: string[]) {
    return async (caminho: string): Promise<unknown> => {
      caminhosVistos.push(caminho)
      if (caminho.includes('/pulls?state=open')) {
        return [
          {
            number: 347,
            user: { login: AUTOR_PR_347 },
            labels: [],
            body: CORPO_PR_347_DONO,
            head: { sha: 'sha-dono' },
          },
          {
            number: 408,
            user: { login: AUTOR_PR_408 },
            labels: [],
            body: CORPO_PR_408_DEV,
            head: { sha: 'sha-viva' },
          },
          {
            number: 356,
            user: { login: AUTOR_PR_356 },
            labels: LABELS_PR_356,
            body: CORPO_PR_356_DEV,
            head: { sha: 'sha-orfao' },
          },
        ]
      }
      if (caminho === '/repos/dono/repo/pulls/356') return { mergeable: false }
      if (caminho === '/repos/dono/repo/commits/sha-orfao') {
        return { commit: { committer: { date: DEZ_DIAS_ATRAS } } }
      }
      if (caminho.includes('check-runs')) {
        return { check_runs: [{ status: 'completed', conclusion: 'failure' }] }
      }
      throw new Error(`caminho inesperado: ${caminho}`)
    }
  }

  it('não busca nada sobre o PR do dono nem sobre o que tem sessão viva', async () => {
    const caminhos: string[] = []
    const prs = await listarPrsAbertosParaOVigia({
      repo: 'dono/repo',
      ghGet: githubDeMentira(caminhos),
      prsComSessaoViva: new Set([408]),
      agora: AGORA,
      onWarn: () => undefined,
    })
    expect(caminhos.filter((c) => c.includes('347'))).toEqual([])
    expect(caminhos.filter((c) => c.includes('408') || c.includes('sha-viva'))).toEqual([])
    expect(caminhos.filter((c) => c.includes('356') || c.includes('sha-orfao'))).toHaveLength(3)

    // O que não foi enriquecido sai com os valores que NÃO fazem agir.
    const dono = prs.find((p) => p.numero === 347)
    expect(dono).toMatchObject({ mergeable: null, verificacao: 'pendente', paradoHaMs: 0 })
    const orfao = prs.find((p) => p.numero === 356)
    expect(orfao?.mergeable).toBe(false)
    expect(orfao?.verificacao).toBe('vermelha')
    expect(orfao?.paradoHaMs).toBe(10 * DIA)
  })

  it('a falha ao ler UM pull request não derruba a listagem — ele sai conservador', async () => {
    const avisos: string[] = []
    const prs = await listarPrsAbertosParaOVigia({
      repo: 'dono/repo',
      ghGet: async (caminho) => {
        if (caminho.includes('/pulls?state=open')) {
          return [
            {
              number: 356,
              user: { login: AUTOR_PR_356 },
              labels: [],
              body: CORPO_PR_356_DEV,
              head: { sha: 'x' },
            },
          ]
        }
        throw new Error('GitHub 502')
      },
      prsComSessaoViva: new Set<number>(),
      agora: AGORA,
      onWarn: (m) => avisos.push(m),
    })
    expect(prs).toEqual([
      expect.objectContaining({ numero: 356, mergeable: null, verificacao: 'pendente' }),
    ])
    expect(avisos[0]).toContain('502')
    expect(decidirAcaoNoPrOrfao(situacao({ ...prs[0]!, sinais: prs[0]! })).acao).toBe('ignorar')
  })

  it('a paginação não para calada: alcançar o teto de páginas vira aviso', async () => {
    const avisos: string[] = []
    let paginas = 0
    await listarPrsAbertosParaOVigia({
      repo: 'dono/repo',
      ghGet: async (caminho) => {
        if (!caminho.includes('/pulls?state=open')) throw new Error('não deveria enriquecer')
        paginas += 1
        // Cem por página, sempre cheias: obriga a paginação a ir até o teto.
        return Array.from({ length: 100 }, (_, i) => ({
          number: paginas * 1000 + i,
          user: { login: 'alguem' },
          labels: [],
          body: 'sem rodapé',
          head: { sha: 's' },
        }))
      },
      prsComSessaoViva: new Set<number>(),
      agora: AGORA,
      onWarn: (m) => avisos.push(m),
    })
    expect(paginas).toBe(MAX_PAGINAS_DE_PR)
    expect(avisos.join(' ')).toContain('INCOMPLETA')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// O QUE O QA REPROVOU. Cada bloco abaixo prova UM achado.
// ═══════════════════════════════════════════════════════════════════════════

describe('ACHADO 1 — a sessão de conserto nasce no RAMO DO PR, nunca na principal', () => {
  // O trabalho do dev está no ramo DELE. Abrir sessão em `main` faria o dev
  // recomeçar do zero e, com AUTO_CREATE_PR, abrir um SEGUNDO pull request —
  // a ação que dá nome à tarefa ("retomar") não retomaria nada.
  it('retomar carrega o ramo do pull request para quem vai abrir a sessão', () => {
    const d = decidirAcaoNoPrOrfao(situacao({ mergeable: false, branchDoPr: 'ramo-do-356' }))
    expect(d.acao).toBe('retomar')
    if (d.acao !== 'retomar') throw new Error('esperava retomar')
    expect(d.branchDoPr).toBe('ramo-do-356')
  })

  it.each([
    ['ramo desconhecido', { branchDoPr: null }],
    ['ramo vazio', { branchDoPr: '' }],
    ['ramo de um fork', { branchDoPr: 'ramo-do-fork', branchNoRepoDoProjeto: false }],
  ])('%s NÃO vira sessão na principal — escala', (_nome, over) => {
    for (const causa of [{ mergeable: false }, { verificacao: 'vermelha' as const }]) {
      const d = decidirAcaoNoPrOrfao(situacao({ ...causa, ...over }))
      expect(d.acao).toBe('escalar')
      expect(d.motivo).toContain('ramo')
    }
  })

  it('nenhuma combinação de estado produz `retomar` sem ramo utilizável', () => {
    const semRamoUtilizavel = [
      { branchDoPr: null, branchNoRepoDoProjeto: true },
      { branchDoPr: '', branchNoRepoDoProjeto: true },
      { branchDoPr: '   ', branchNoRepoDoProjeto: true },
      { branchDoPr: 'ramo-de-fork', branchNoRepoDoProjeto: false },
      { branchDoPr: null, branchNoRepoDoProjeto: false },
    ]
    const acoes = new Set<string>()
    for (const ramo of semRamoUtilizavel) {
      for (const mergeable of [true, false, null]) {
        for (const verificacao of ['verde', 'vermelha', 'pendente', 'ausente'] as const) {
          for (const issueAberta of [true, false]) {
            acoes.add(
              decidirAcaoNoPrOrfao(situacao({ ...ramo, mergeable, verificacao, issueAberta })).acao
            )
          }
        }
      }
    }
    expect([...acoes].sort()).toEqual(['escalar', 'fechar', 'ignorar'])
  })

  it('a varredura repassa o ramo do PR para `abrirSessaoDeConserto`', async () => {
    const pedidos: Array<{ numeroDoPr: number; branchDoPr: string }> = []
    await rodar({
      prs: [
        prAberto({
          numero: 356,
          corpo: CORPO_PR_356_DEV,
          mergeable: false,
          branchDoPr: 'ramo-356',
        }),
      ],
      issueDoPr: () => 329,
      abrirSessaoDeConserto: async ({ numeroDoPr, branchDoPr }) => {
        pedidos.push({ numeroDoPr, branchDoPr })
        return true
      },
    })
    expect(pedidos).toEqual([{ numeroDoPr: 356, branchDoPr: 'ramo-356' }])
  })

  it('`branchParaRetomar` só devolve ramo que o dev alcança', () => {
    expect(branchParaRetomar({ branchDoPr: 'r', branchNoRepoDoProjeto: true })).toBe('r')
    expect(branchParaRetomar({ branchDoPr: 'r', branchNoRepoDoProjeto: false })).toBeNull()
    expect(branchParaRetomar({ branchDoPr: null, branchNoRepoDoProjeto: true })).toBeNull()
    expect(branchParaRetomar({ branchDoPr: '  ', branchNoRepoDoProjeto: true })).toBeNull()
  })
})

describe('ACHADO 2 — a estreia não pode ser uma limpeza em massa', () => {
  // Medido no repositório do produto em 31/08/2026, com o código real rodando
  // seco contra o GitHub e o banco: a PRIMEIRA passada fecharia SEIS pull
  // requests (#314, #324, #330, #331, #335, #341). O teto por passada existe
  // para que a estreia seja visível antes de ser irreversível.
  const seisParaFechar = [314, 324, 330, 331, 335, 341]

  it('o teto por passada é MENOR que a população que a primeira passada fecharia', () => {
    expect(TETO_DE_ACOES_POR_PASSADA).toBeLessThan(seisParaFechar.length)
    expect(TETO_DE_ACOES_POR_PASSADA).toBeGreaterThan(0)
  })

  it('com seis a fechar, só o teto sai — e o resto fica para a próxima passada', async () => {
    const fechados: number[] = []
    const resumo = await rodar({
      prs: seisParaFechar.map((numero) =>
        prAberto({ numero, corpo: CORPO_PR_356_DEV, mergeable: true, verificacao: 'verde' })
      ),
      issueDoPr: (n) => n - 10,
      issueAberta: async () => false,
      fecharPr: async ({ numero }) => {
        fechados.push(numero)
        return true
      },
    })
    expect(fechados).toHaveLength(TETO_DE_ACOES_POR_PASSADA)
    expect(fechados).toEqual(seisParaFechar.slice(0, TETO_DE_ACOES_POR_PASSADA))
    // O teto DIZ quando morde — teto silencioso é o defeito que ele conserta.
    expect(resumo).toContain('teto desta passada')
    expect(resumo).toContain(String(seisParaFechar.length - TETO_DE_ACOES_POR_PASSADA))
  })

  it('o teto conta TODA ação, não só o fechamento — seis escaladas não viram enxurrada', async () => {
    const avisos: string[] = []
    await rodar({
      prs: seisParaFechar.map((numero) =>
        prAberto({ numero, corpo: CORPO_PR_356_DEV, mergeable: true, verificacao: 'verde' })
      ),
      issueDoPr: () => null,
      avisarDono: async (t) => {
        avisos.push(t)
        return true
      },
    })
    expect(avisos).toHaveLength(TETO_DE_ACOES_POR_PASSADA)
  })

  it('abaixo do teto nada é cortado e o recado sobre o teto não aparece', async () => {
    const resumo = await rodar({
      prs: [prAberto({ numero: 356, corpo: CORPO_PR_356_DEV, mergeable: false })],
      issueDoPr: () => 329,
    })
    expect(resumo).not.toContain('teto desta passada')
  })
})

describe('ACHADO 4 — o comentário nunca sai de um fechamento que não aconteceu', () => {
  function ghDeMentira(falharEm?: 'fechar' | 'comentar') {
    const chamadas: Array<{ metodo: string; caminho: string }> = []
    const ghSend = async (metodo: string, caminho: string): Promise<void> => {
      chamadas.push({ metodo, caminho })
      if (falharEm === 'fechar' && metodo === 'PATCH') throw new Error('GitHub 502')
      if (falharEm === 'comentar' && caminho.includes('/comments')) throw new Error('GitHub 502')
    }
    return { chamadas, ghSend }
  }

  it('FECHA primeiro e comenta depois — nesta ordem', async () => {
    const { chamadas, ghSend } = ghDeMentira()
    const ok = await fecharPrDoVigia({
      repo: 'dono/repo',
      numero: 342,
      motivo: 'porque sim',
      ghSend,
    })
    expect(ok).toBe(true)
    expect(chamadas.map((c) => c.metodo)).toEqual(['PATCH', 'POST'])
    expect(chamadas[0]?.caminho).toBe('/repos/dono/repo/pulls/342')
    expect(chamadas[1]?.caminho).toBe('/repos/dono/repo/issues/342/comments')
  })

  it('fechamento que FALHA não deixa comentário nenhum — nem nesta passada nem nas próximas', async () => {
    const { chamadas, ghSend } = ghDeMentira('fechar')
    const ok = await fecharPrDoVigia({ repo: 'dono/repo', numero: 342, motivo: 'x', ghSend })
    expect(ok).toBe(false)
    expect(chamadas.filter((c) => c.caminho.includes('/comments'))).toEqual([])
  })

  it('comentário que falha não desfaz o fechamento — a ação aconteceu e conta', async () => {
    const avisos: string[] = []
    const { ghSend } = ghDeMentira('comentar')
    const ok = await fecharPrDoVigia({
      repo: 'dono/repo',
      numero: 342,
      motivo: 'x',
      ghSend,
      onWarn: (m) => avisos.push(m),
    })
    expect(ok).toBe(true)
    expect(avisos.join(' ')).toContain('342')
  })

  it('o fechamento que falhou não vira evento — o teto não é gasto por queda nossa', async () => {
    const eventos: unknown[] = []
    await rodar({
      prs: [prAberto({ numero: 342, corpo: CORPO_PR_356_DEV })],
      issueDoPr: () => 329,
      issueAberta: async () => false,
      fecharPr: async () => false,
      registrarDecisao: async (e) => {
        eventos.push(e)
      },
    })
    expect(eventos).toEqual([])
  })
})

describe('ACHADO 6 — o Dependabot sai da população do vigia', () => {
  // Ele É automação (`ehPRDaAutomacao` continua dizendo a verdade), mas não há
  // sessão de dev atrás dele: não há o que retomar. Medido em 31/08/2026, os
  // dois PRs do Dependabot abertos (#403 e #404) não têm tarefa de origem — ao
  // passar dos 3 dias cada um viraria DUAS escaladas ao dono, sobre algo que o
  // próprio Dependabot fecha sozinho (foi o que aconteceu com o #360).
  const doDependabot = { autor: 'dependabot[bot]', labels: ['dependencies'], corpo: 'Bumps x.' }

  it('continua sendo reconhecido como automação — a autoria não mente', () => {
    expect(ehPRDaAutomacao(doDependabot)).toBe(true)
    expect(AUTORES_QUE_O_VIGIA_NAO_CONSERTA).toContain('dependabot[bot]')
  })

  it('nenhuma combinação de estado produz ação sobre um PR do Dependabot', () => {
    const acoes = new Set<string>()
    for (const mergeable of [true, false, null]) {
      for (const verificacao of ['verde', 'vermelha', 'pendente', 'ausente'] as const) {
        for (const issueAberta of [true, false]) {
          for (const issueNumber of [329, null]) {
            for (const acoesAnteriores of [0, MAX_ACOES_DO_VIGIA]) {
              acoes.add(
                decidirAcaoNoPrOrfao(
                  situacao({
                    numero: 403,
                    sinais: doDependabot,
                    mergeable,
                    verificacao,
                    issueAberta,
                    issueNumber,
                    acoesAnteriores,
                    paradoHaMs: 90 * DIA,
                  })
                ).acao
              )
            }
          }
        }
      }
    }
    expect([...acoes]).toEqual(['ignorar'])
  })

  it('na varredura ele não chega a nenhuma dep de escrita e é contado à parte', async () => {
    const escritas: string[] = []
    const resumo = await rodar({
      prs: [
        prAberto({ numero: 403, ...doDependabot, mergeable: true, verificacao: 'verde' }),
        prAberto({ numero: 404, ...doDependabot, mergeable: false, verificacao: 'vermelha' }),
      ],
      issueDoPr: () => null,
      abrirSessaoDeConserto: async () => {
        escritas.push('sessão')
        return true
      },
      fecharPr: async () => {
        escritas.push('fechou')
        return true
      },
      avisarDono: async () => {
        escritas.push('avisou')
        return true
      },
    })
    expect(escritas).toEqual([])
    expect(resumo).toContain('2 do dependabot')
  })

  it('a listagem não gasta rede enriquecendo PR do Dependabot', async () => {
    const caminhos: string[] = []
    await listarPrsAbertosParaOVigia({
      repo: 'dono/repo',
      ghGet: async (caminho) => {
        caminhos.push(caminho)
        if (caminho.includes('/pulls?state=open')) {
          return [
            {
              number: 403,
              user: { login: 'dependabot[bot]' },
              labels: [{ name: 'dependencies' }],
              body: 'Bumps x.',
              head: { sha: 'sha-dep', ref: 'dependabot/npm', repo: { full_name: 'dono/repo' } },
            },
          ]
        }
        throw new Error(`não deveria enriquecer: ${caminho}`)
      },
      prsComSessaoViva: new Set<number>(),
      agora: new Date(),
      onWarn: () => undefined,
    })
    expect(caminhos.filter((c) => !c.includes('/pulls?state=open'))).toEqual([])
  })
})

describe('a listagem traz o ramo do pull request (ACHADO 1, do lado da rede)', () => {
  it('lê head.ref e sabe se o ramo vive neste repositório', async () => {
    const prs = await listarPrsAbertosParaOVigia({
      repo: 'dono/repo',
      ghGet: async (caminho) => {
        if (caminho.includes('/pulls?state=open')) {
          return [
            {
              number: 356,
              user: { login: AUTOR_PR_356 },
              labels: [],
              body: CORPO_PR_356_DEV,
              head: { sha: 's1', ref: 'ramo-de-casa', repo: { full_name: 'dono/repo' } },
            },
            {
              number: 357,
              user: { login: AUTOR_PR_356 },
              labels: [],
              body: CORPO_PR_356_DEV,
              head: { sha: 's2', ref: 'ramo-de-fora', repo: { full_name: 'outro/fork' } },
            },
          ]
        }
        if (caminho.startsWith('/repos/dono/repo/pulls/')) return { mergeable: false }
        if (caminho.startsWith('/repos/dono/repo/commits/')) {
          return { commit: { committer: { date: '2026-08-01T00:00:00Z' } } }
        }
        return { check_runs: [{ status: 'completed', conclusion: 'success' }] }
      },
      prsComSessaoViva: new Set<number>(),
      agora: new Date('2026-08-31T00:00:00Z'),
      onWarn: () => undefined,
    })
    expect(prs.find((p) => p.numero === 356)).toMatchObject({
      branchDoPr: 'ramo-de-casa',
      branchNoRepoDoProjeto: true,
    })
    expect(prs.find((p) => p.numero === 357)).toMatchObject({
      branchDoPr: 'ramo-de-fora',
      branchNoRepoDoProjeto: false,
    })
  })

  it('sem head.ref o ramo sai nulo — o valor que NÃO faz agir', async () => {
    const prs = await listarPrsAbertosParaOVigia({
      repo: 'dono/repo',
      ghGet: async (caminho) => {
        if (caminho.includes('/pulls?state=open')) {
          return [
            {
              number: 356,
              user: { login: AUTOR_PR_356 },
              labels: [],
              body: CORPO_PR_356_DEV,
              head: {},
            },
          ]
        }
        return { mergeable: false }
      },
      prsComSessaoViva: new Set<number>(),
      agora: new Date(),
      onWarn: () => undefined,
    })
    expect(prs[0]?.branchDoPr).toBeNull()
    expect(branchParaRetomar(prs[0]!)).toBeNull()
  })
})

describe('ACHADO 1 — a ponta que nenhum teste de unidade alcança: o relógio', () => {
  // Mesma técnica do DRIFT GUARD do rodapé, e pelo mesmo motivo: o defeito
  // reprovado (`startingBranch: 'main'`) não vivia na decisão, vivia na LIGAÇÃO
  // dentro de `scheduler.ts`, que nenhum teste de unidade importa. Um teste que
  // prova a decisão e deixa a ligação solta não teria pegado o defeito — foi
  // exatamente o que aconteceu. Então a ligação é lida do disco.
  const scheduler = readFileSync(join(__dirname, '../plugins/scheduler.ts'), 'utf8')

  function corpoDeAbrirSessaoDeConsertoDoPr(): string {
    const i = scheduler.indexOf('const abrirSessaoDeConsertoDoPr = async')
    expect(i).toBeGreaterThan(-1)
    const j = scheduler.indexOf('const criada = await criarSessaoJules({', i)
    expect(j).toBeGreaterThan(i)
    return scheduler.slice(j, scheduler.indexOf('})', j))
  }

  it('a sessão de conserto nasce no ramo do PR — e NÃO na principal', () => {
    const chamada = corpoDeAbrirSessaoDeConsertoDoPr()
    expect(chamada).toContain('startingBranch: args.branchDoPr')
    expect(chamada).not.toContain("'main'")
    expect(chamada).not.toContain('GITORCH_DEV_BASE_BRANCH')
  })

  it('e devolve o trabalho no mesmo ramo, para não abrir um SEGUNDO pull request', () => {
    expect(corpoDeAbrirSessaoDeConsertoDoPr()).toContain('workingBranch: args.branchDoPr')
  })

  it('o fechamento no relógio passa por `fecharPrDoVigia` — a ordem não é recopiada lá', () => {
    const i = scheduler.indexOf('fecharPr: ')
    expect(i).toBeGreaterThan(-1)
    expect(scheduler.slice(i, i + 400)).toContain('fecharPrDoVigia({')
  })
})

describe('ACHADO 4 + ACHADO 5 juntos — o pior caso que os dois defeitos formavam', () => {
  // Os dois achados se multiplicavam. Num cliente no nível "Sugerir":
  //   · o fechamento era classificado como `propor` → seria PERMITIDO (achado 5);
  //   · e o comentário saía ANTES do fechamento (achado 4).
  // Corrigido só o 5, o fechamento passa a ser RECUSADO — e, com a ordem
  // antiga, o comentário já teria saído: recusa a cada seis horas, comentário
  // novo a cada seis horas, para sempre, no repositório de quem só autorizou
  // "não mexo". Com a ordem certa, a recusa acontece ANTES de qualquer escrita.
  it('no nível "Sugerir" o vigia não escreve NADA ao tentar fechar', async () => {
    const escritas: string[] = []
    const fetchDoCliente = guardaDeAutonomia(
      (async (url: string | URL | Request, init?: RequestInit) => {
        escritas.push(`${init?.method ?? 'GET'} ${String(url)}`)
        return new Response('{}', { status: 200 })
      }) as unknown as typeof fetch,
      () => 'sugerir'
    )

    const ghSend = async (metodo: 'POST' | 'PATCH', caminho: string, corpo: unknown) => {
      const r = await fetchDoCliente(`https://api.github.com${caminho}`, {
        method: metodo,
        body: JSON.stringify(corpo),
      })
      if (!r.ok) throw new Error(`GitHub ${metodo} ${caminho} (${r.status})`)
      return r.json()
    }

    const ok = await fecharPrDoVigia({
      repo: 'cliente/repo',
      numero: 77,
      motivo: 'a tarefa de origem já está fechada',
      ghSend,
      onWarn: () => undefined,
    })

    expect(ok).toBe(false)
    // O que importa: ZERO escrita chegou ao repositório do cliente. Nem o
    // fechamento (recusado pela guarda) nem — e este é o ponto — o comentário.
    expect(escritas).toEqual([])
  })

  it('no nível "Cuidar" o mesmo caminho fecha e comenta, nesta ordem', async () => {
    const escritas: string[] = []
    const fetchDoCliente = guardaDeAutonomia(
      (async (url: string | URL | Request, init?: RequestInit) => {
        escritas.push(`${init?.method ?? 'GET'} ${new URL(String(url)).pathname}`)
        return new Response('{}', { status: 200 })
      }) as unknown as typeof fetch,
      () => 'cuidar'
    )
    const ok = await fecharPrDoVigia({
      repo: 'cliente/repo',
      numero: 77,
      motivo: 'x',
      ghSend: async (metodo, caminho, corpo) => {
        const r = await fetchDoCliente(`https://api.github.com${caminho}`, {
          method: metodo,
          body: JSON.stringify(corpo),
        })
        return r.json()
      },
    })
    expect(ok).toBe(true)
    expect(escritas).toEqual([
      'PATCH /repos/cliente/repo/pulls/77',
      'POST /repos/cliente/repo/issues/77/comments',
    ])
  })
})
