import { describe, it, expect } from 'vitest'
import {
  calcularExigeRevisaoDeSeguranca,
  criarGuardaDeSegurancaDoVigia,
} from './exigir-revisao-de-seguranca.js'
import type { SondagemDoRepositorio, WorkflowSondado } from './sondagem-de-seguranca.js'
import { GitHubDeMelhoriasFalso } from '../test/github-de-melhorias-fake.js'
import { criarPrismaDeSegurancaEmMemoria } from '../test/prisma-de-seguranca-em-memoria.js'

function workflow(parcial: Partial<WorkflowSondado> = {}): WorkflowSondado {
  return {
    caminho: '.github/workflows/ci.yml',
    declaraPermissoes: false,
    ehDeploy: false,
    seguroParaPermissaoMinima: true,
    motivoDeNaoSeguro: null,
    temGitleaks: false,
    temCodeql: false,
    ...parcial,
  }
}

function sondagem(parcial: Partial<SondagemDoRepositorio> = {}): SondagemDoRepositorio {
  return {
    versao: 1,
    repositorio: 'acme/api',
    sondadoEm: '2026-03-10T12:00:00.000Z',
    credencial: 'App do produto',
    comAdmin: true,
    privado: true,
    branchPadrao: 'main',
    segredos: 'indisponivel',
    bloqueioDePush: 'indisponivel',
    alertasDeDependencias: 'desligado',
    atualizacoesDeSeguranca: 'desligado',
    varreduraDeCodigo: 'indisponivel',
    linguagensSuportadas: [],
    permissaoDoWorkflow: 'write',
    podeAprovarPrs: false,
    workflows: { estado: 'lidos', truncado: false, itens: [workflow()] },
    ...parcial,
  }
}

describe('calcularExigeRevisaoDeSeguranca (a partir da sondagem)', () => {
  it('sem sondagem não bloqueia ninguém (falha de leitura nunca trava o merge)', () => {
    expect(calcularExigeRevisaoDeSeguranca(null)).toBe(false)
  })

  it('repositório público: o recurso existe, não exige', () => {
    expect(
      calcularExigeRevisaoDeSeguranca(sondagem({ privado: false, segredos: 'desligado' }))
    ).toBe(false)
  })

  it('privado sem o recurso e sem gitleaks em nenhum workflow: exige revisão', () => {
    expect(calcularExigeRevisaoDeSeguranca(sondagem())).toBe(true)
  })

  it('privado sem o recurso, MAS com um workflow com gitleaks: não exige', () => {
    const s = sondagem({
      workflows: {
        estado: 'lidos',
        truncado: false,
        itens: [workflow(), workflow({ caminho: '.github/workflows/seg.yml', temGitleaks: true })],
      },
    })
    expect(calcularExigeRevisaoDeSeguranca(s)).toBe(false)
  })

  it('privado onde o recurso existe (Advanced Security): não exige', () => {
    expect(calcularExigeRevisaoDeSeguranca(sondagem({ segredos: 'desligado' }))).toBe(false)
    expect(calcularExigeRevisaoDeSeguranca(sondagem({ segredos: 'ligado' }))).toBe(false)
  })

  it('privado sem pasta de workflows (404): sem alternativa, exige', () => {
    const s = sondagem({ workflows: { estado: 'ausente', truncado: false, itens: [] } })
    expect(calcularExigeRevisaoDeSeguranca(s)).toBe(true)
  })

  it('erro ao ler os workflows: avisa-se e NÃO bloqueia (mesmo comportamento de sempre)', () => {
    const s = sondagem({ workflows: { estado: 'erro', truncado: false, itens: [] } })
    expect(calcularExigeRevisaoDeSeguranca(s)).toBe(false)
  })
})

describe('criarGuardaDeSegurancaDoVigia: uma leitura por projeto, reaproveitada por todos os PRs', () => {
  const AGORA = new Date('2026-03-10T12:00:00.000Z')
  const montar = () => {
    const github = new GitHubDeMelhoriasFalso('acme/api', {
      privado: true,
      advancedSecurity: 'disabled',
      arquivos: { '.github/workflows/ci.yml': 'name: ci\njobs:\n  a:\n    steps: []\n' },
    })
    const memoria = criarPrismaDeSegurancaEmMemoria()
    const avisos: string[] = []
    const guarda = criarGuardaDeSegurancaDoVigia({
      prisma: memoria.prisma,
      projectId: 'p1',
      repositorio: 'acme/api',
      credenciais: [{ origem: 'App do produto', token: 'tok' }],
      fetchImpl: github.fetchFalso,
      agora: () => AGORA,
      onWarn: (m) => avisos.push(m),
    })
    return { github, memoria, guarda, avisos }
  }

  it('20 PRs na mesma passada: a sondagem é feita UMA vez (nenhuma chamada repetida)', async () => {
    const { github, guarda } = montar()
    const respostas = await Promise.all(Array.from({ length: 20 }, () => guarda()))
    expect(respostas.every((r) => r === true)).toBe(true)
    const rotas = github.registro.map((r) => `${r.metodo} ${r.caminho}`)
    expect(new Set(rotas).size).toBe(rotas.length)
    expect(rotas.filter((r) => r.includes('/contents/.github/workflows'))).toHaveLength(2)
  })

  it('a passada seguinte (outra criação da guarda) lê do cache do dia: zero chamadas', async () => {
    const { github, memoria, guarda } = montar()
    await guarda()
    const chamadas = github.registro.length
    const segunda = criarGuardaDeSegurancaDoVigia({
      prisma: memoria.prisma,
      projectId: 'p1',
      repositorio: 'acme/api',
      credenciais: [{ origem: 'App do produto', token: 'tok' }],
      fetchImpl: github.fetchFalso,
      agora: () => new Date(AGORA.getTime() + 3 * 3_600_000),
      onWarn: () => {},
    })
    expect(await segunda()).toBe(true)
    expect(github.registro).toHaveLength(chamadas)
  })

  it('não escreve nada no GitHub', async () => {
    const { github, guarda } = montar()
    await guarda()
    expect(github.escritas()).toEqual([])
  })

  it('a sondagem falhando devolve false (não trava merge) e avisa UMA vez, sem credencial', async () => {
    const github = new GitHubDeMelhoriasFalso('acme/api', {
      forcar: { 'GET ': { status: 500, mensagem: 'boom' } },
    })
    const memoria = criarPrismaDeSegurancaEmMemoria()
    const avisos: string[] = []
    const guarda = criarGuardaDeSegurancaDoVigia({
      prisma: memoria.prisma,
      projectId: 'p1',
      repositorio: 'acme/api',
      credenciais: [{ origem: 'App do produto', token: 'tok-secreto-123456' }],
      fetchImpl: github.fetchFalso,
      agora: () => AGORA,
      onWarn: (m) => avisos.push(m),
    })
    expect(await guarda()).toBe(false)
    expect(await guarda()).toBe(false)
    expect(avisos).toHaveLength(1)
    expect(avisos[0]).not.toContain('tok-secreto-123456')
  })
})
