import { describe, expect, it, vi } from 'vitest'
import {
  listarPrsAbertosParaOVigia,
  vigiarPrsOrfaos,
  type AcaoDoVigia,
  type PrAberto,
  type VigiaDoPrDeps,
} from './vigia-do-pr.js'
import { CORPO_PR_356_DEV } from './__fixtures__/corpos-reais-de-pr.js'

const HORA = 60 * 60 * 1000

function prDoDono(sobrepor: Partial<PrAberto> = {}): PrAberto {
  return {
    numero: 42,
    autor: 'dono',
    labels: [],
    corpo: null,
    rascunho: false,
    branchDoPr: 'ajuste-do-robo',
    branchNoRepoDoProjeto: true,
    headSha: 'abc1234',
    mergeable: true,
    verificacao: 'verde',
    paradoHaMs: 25 * HORA,
    ...sobrepor,
  }
}

const ASSUME: AcaoDoVigia = {
  acao: 'retomar',
  issueNumber: 7,
  causa: 'qa-reprovou',
  pedido: 'Faça o ajuste.',
  branchDoPr: 'ajuste-do-robo',
  motivo: 'assumindo',
  assumidoDoDono: true,
}

function rodar(sobrepor: {
  prs: PrAberto[]
  prsComSessaoViva?: Set<number>
  ehPrDoDono?: VigiaDoPrDeps['ehPrDoDono']
  decidirPedidoDoDono?: VigiaDoPrDeps['decidirPedidoDoDono']
  abrirSessaoDeConserto?: VigiaDoPrDeps['abrirSessaoDeConserto']
  registrarDecisao?: VigiaDoPrDeps['registrarDecisao']
  fecharPr?: VigiaDoPrDeps['fecharPr']
  avisarDono?: VigiaDoPrDeps['avisarDono']
  issueDoPr?: (n: number) => number | null
  acoesAnteriores?: (n: number) => Promise<number>
  teto?: number
  vagasLivres?: number
}): Promise<string> {
  return vigiarPrsOrfaos({
    listarPrsAbertos: async () => sobrepor.prs,
    prsComSessaoViva: sobrepor.prsComSessaoViva ?? new Set<number>(),
    issueDoPr: sobrepor.issueDoPr ?? (() => 7),
    issueAberta: async () => true,
    acoesAnteriores: sobrepor.acoesAnteriores ?? (async () => 0),
    tarefaJaDevolvidaAFila: async () => false,
    vagasLivres: sobrepor.vagasLivres ?? 5,
    pedirJulgamento: async () => undefined,
    abrirSessaoDeConserto: sobrepor.abrirSessaoDeConserto ?? (async () => true),
    fecharPr: sobrepor.fecharPr ?? (async () => true),
    avisarDono: sobrepor.avisarDono ?? (async () => true),
    registrarDecisao: sobrepor.registrarDecisao ?? (async () => undefined),
    ...(sobrepor.teto !== undefined ? { teto: sobrepor.teto } : {}),
    ...(sobrepor.ehPrDoDono ? { ehPrDoDono: sobrepor.ehPrDoDono } : {}),
    ...(sobrepor.decidirPedidoDoDono ? { decidirPedidoDoDono: sobrepor.decidirPedidoDoDono } : {}),
  })
}

describe('vigiarPrsOrfaos — PR aberto pela conta do dono', () => {
  it('quando a decisão do dono manda retomar, abre a sessão pela MESMA retomada e registra', async () => {
    const abrir = vi.fn(async () => true)
    const registrar = vi.fn(async () => undefined)
    const resumo = await rodar({
      prs: [prDoDono()],
      ehPrDoDono: (pr) => pr.autor === 'dono',
      decidirPedidoDoDono: async () => ASSUME,
      abrirSessaoDeConserto: abrir,
      registrarDecisao: registrar,
    })
    expect(abrir).toHaveBeenCalledTimes(1)
    expect(abrir).toHaveBeenCalledWith({
      numeroDoPr: 42,
      issueNumber: 7,
      causa: 'qa-reprovou',
      pedido: 'Faça o ajuste.',
      branchDoPr: 'ajuste-do-robo',
    })
    expect(registrar).toHaveBeenCalledTimes(1)
    const gravado = (
      registrar.mock.calls as unknown as Array<
        [{ acao: string; texto: string; issueNumber?: number }]
      >
    )[0]![0]
    expect(gravado.acao).toBe('retomar')
    // A tarefa fica no registro: é por ela que o PR novo acha o PR do dono para substituí-lo.
    expect(gravado.issueNumber).toBe(7)
    expect(gravado.texto).toContain('dono')
    expect(gravado.texto).toContain('#42')
    expect(resumo).toContain('1 retomado')
  })

  it('a decisão recebe a tarefa de origem, as ações anteriores e se há vaga', async () => {
    const decidir = vi.fn(async (): Promise<AcaoDoVigia> => ({ acao: 'ignorar', motivo: 'x' }))
    await rodar({
      prs: [prDoDono()],
      ehPrDoDono: () => true,
      decidirPedidoDoDono: decidir,
      issueDoPr: () => 9,
      acoesAnteriores: async () => 1,
      vagasLivres: 0,
    })
    expect(decidir).toHaveBeenCalledWith(expect.objectContaining({ numero: 42 }), {
      issueNumber: 9,
      acoesAnteriores: 1,
      podeAbrirSessao: false,
    })
  })

  it('decisão "ignorar" não abre sessão nem grava nada', async () => {
    const abrir = vi.fn(async () => true)
    const registrar = vi.fn(async () => undefined)
    await rodar({
      prs: [prDoDono()],
      ehPrDoDono: () => true,
      decidirPedidoDoDono: async () => ({ acao: 'ignorar', motivo: 'aguardando' }),
      abrirSessaoDeConserto: abrir,
      registrarDecisao: registrar,
    })
    expect(abrir).not.toHaveBeenCalled()
    expect(registrar).not.toHaveBeenCalled()
  })

  it('PR de OUTRA pessoa nunca chega à decisão do dono e nada acontece com ele', async () => {
    const decidir = vi.fn(async () => ASSUME)
    const abrir = vi.fn(async () => true)
    const fechar = vi.fn(async () => true)
    const avisar = vi.fn(async () => true)
    const resumo = await rodar({
      prs: [prDoDono({ numero: 77, autor: 'colaborador' })],
      ehPrDoDono: (pr) => pr.autor === 'dono',
      decidirPedidoDoDono: decidir,
      abrirSessaoDeConserto: abrir,
      fecharPr: fechar,
      avisarDono: avisar,
    })
    expect(decidir).not.toHaveBeenCalled()
    expect(abrir).not.toHaveBeenCalled()
    expect(fechar).not.toHaveBeenCalled()
    expect(avisar).not.toHaveBeenCalled()
    expect(resumo).toContain('1 de gente')
  })

  it('sem as dependências novas o PR do dono continua sendo tratado como de gente', async () => {
    const abrir = vi.fn(async () => true)
    const resumo = await rodar({ prs: [prDoDono()], abrirSessaoDeConserto: abrir })
    expect(abrir).not.toHaveBeenCalled()
    expect(resumo).toContain('1 de gente')
  })

  it('PR do dono com sessão do dev viva fica com a vigia de sessões', async () => {
    const decidir = vi.fn(async () => ASSUME)
    const resumo = await rodar({
      prs: [prDoDono()],
      prsComSessaoViva: new Set([42]),
      ehPrDoDono: () => true,
      decidirPedidoDoDono: decidir,
    })
    expect(decidir).not.toHaveBeenCalled()
    expect(resumo).toContain('1 com sessão viva')
  })

  it('PR do dono que também é entrega do dev segue o caminho do dev, não o do dono', async () => {
    const decidirDono = vi.fn(async () => ASSUME)
    await rodar({
      prs: [prDoDono({ corpo: CORPO_PR_356_DEV })],
      ehPrDoDono: () => true,
      decidirPedidoDoDono: decidirDono,
    })
    expect(decidirDono).not.toHaveBeenCalled()
  })

  it('PR do aplicador de segurança, mesmo do dono, não vai à decisão', async () => {
    const decidir = vi.fn(async () => ASSUME)
    const resumo = await rodar({
      prs: [prDoDono({ branchDoPr: 'gitorch/seguranca/permissoes-ci-yml' })],
      ehPrDoDono: () => true,
      decidirPedidoDoDono: decidir,
    })
    expect(decidir).not.toHaveBeenCalled()
    expect(resumo).toContain('1 de segurança')
  })

  it('o teto de ações da passada vale também para os PRs do dono', async () => {
    const abrir = vi.fn(async () => true)
    const resumo = await rodar({
      prs: [prDoDono({ numero: 1 }), prDoDono({ numero: 2 }), prDoDono({ numero: 3 })],
      ehPrDoDono: () => true,
      decidirPedidoDoDono: async () => ASSUME,
      abrirSessaoDeConserto: abrir,
      teto: 2,
    })
    expect(abrir).toHaveBeenCalledTimes(2)
    expect(resumo).toContain('1 além do teto desta passada (2)')
  })

  it('sessão que não abriu não grava decisão (a próxima passada tenta de novo)', async () => {
    const registrar = vi.fn(async () => undefined)
    await rodar({
      prs: [prDoDono()],
      ehPrDoDono: () => true,
      decidirPedidoDoDono: async () => ASSUME,
      abrirSessaoDeConserto: async () => false,
      registrarDecisao: registrar,
    })
    expect(registrar).not.toHaveBeenCalled()
  })

  it('falha na decisão de um PR não derruba os outros', async () => {
    const abrir = vi.fn(async () => true)
    let chamada = 0
    const resumo = await rodar({
      prs: [prDoDono({ numero: 1 }), prDoDono({ numero: 2 })],
      ehPrDoDono: () => true,
      decidirPedidoDoDono: async () => {
        chamada += 1
        if (chamada === 1) throw new Error('quebrou')
        return ASSUME
      },
      abrirSessaoDeConserto: abrir,
    })
    expect(abrir).toHaveBeenCalledTimes(1)
    expect(resumo).toContain('1 falha')
  })
})

describe('listarPrsAbertosParaOVigia — leitura do PR do dono', () => {
  const AGORA = new Date('2026-03-10T12:00:00Z')

  function github(caminhos: string[]) {
    return async (caminho: string): Promise<unknown> => {
      caminhos.push(caminho)
      if (caminho.includes('/pulls?state=open')) {
        return [
          {
            number: 10,
            user: { login: 'dono' },
            labels: [{ name: 'gitorch:nao-mexer' }],
            body: 'x',
            head: { sha: 'sha-dono', ref: 'robo', repo: { full_name: 'acme/api' } },
          },
          {
            number: 11,
            user: { login: 'colaborador' },
            labels: [],
            body: 'y',
            head: { sha: 'sha-colab', ref: 'colab', repo: { full_name: 'acme/api' } },
          },
        ]
      }
      if (caminho === '/repos/acme/api/pulls/10') return { mergeable: false }
      if (caminho === '/repos/acme/api/commits/sha-dono') {
        return { commit: { committer: { date: '2026-03-08T12:00:00Z' } } }
      }
      if (caminho.includes('check-runs')) {
        return { check_runs: [{ status: 'completed', conclusion: 'failure' }] }
      }
      throw new Error(`caminho inesperado: ${caminho}`)
    }
  }

  it('lê o estado do PR da conta do dono e não gasta nada com o de outra pessoa', async () => {
    const caminhos: string[] = []
    const prs = await listarPrsAbertosParaOVigia({
      repo: 'acme/api',
      ghGet: github(caminhos),
      prsComSessaoViva: new Set<number>(),
      agora: AGORA,
      onWarn: () => undefined,
      ehContaDoDono: (autor) => autor === 'dono',
    })
    const dono = prs.find((p) => p.numero === 10)
    expect(dono).toMatchObject({ mergeable: false, verificacao: 'vermelha' })
    expect(dono?.paradoHaMs).toBe(2 * 24 * HORA)
    expect(dono?.labels).toContain('gitorch:nao-mexer')
    expect(caminhos.filter((c) => c.includes('sha-colab') || c.endsWith('/pulls/11'))).toEqual([])
    expect(prs.find((p) => p.numero === 11)).toMatchObject({
      mergeable: null,
      verificacao: 'pendente',
      paradoHaMs: 0,
    })
  })

  it('sem a função de dono, a leitura é a de antes (ninguém além da automação é lido)', async () => {
    const caminhos: string[] = []
    await listarPrsAbertosParaOVigia({
      repo: 'acme/api',
      ghGet: github(caminhos),
      prsComSessaoViva: new Set<number>(),
      agora: AGORA,
      onWarn: () => undefined,
    })
    expect(caminhos).toHaveLength(1)
  })
})
