import { describe, expect, it, vi } from 'vitest'
import {
  lerSondagemEmCache,
  obterSondagem,
  sondarRepositorio,
  VALIDADE_DA_SONDAGEM_MS,
  recursoDeSegredosDisponivel,
  type SondagemDoRepositorio,
} from './sondagem-de-seguranca.js'
import { GitHubDeMelhoriasFalso } from '../test/github-de-melhorias-fake.js'
import { criarPrismaDeSegurancaEmMemoria } from '../test/prisma-de-seguranca-em-memoria.js'

const REPO = 'acme/api'
const AGORA = new Date('2026-03-10T12:00:00.000Z')
const TOKEN = 'ghp_token_secreto_da_sondagem_000000'
const CREDENCIAL = { origem: 'cliente ou dono', token: TOKEN }

const WORKFLOW_SEM_PERMISSOES = [
  'name: ci',
  'on: push',
  'jobs:',
  '  t:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  `      - uses: actions/checkout@${'a'.repeat(40)}`,
  '',
].join('\n')

function publicoTudoDesligado(
  extra: Partial<ConstructorParameters<typeof GitHubDeMelhoriasFalso>[1]> = {}
) {
  return new GitHubDeMelhoriasFalso(REPO, {
    privado: false,
    segredos: 'disabled',
    bloqueioDePush: 'disabled',
    alertasDeDependencias: false,
    atualizacoesDeSeguranca: false,
    varreduraDeCodigo: 'not-configured',
    linguagens: { TypeScript: 1000, Shell: 20 },
    permissaoDoWorkflow: 'write',
    podeAprovarPrs: true,
    arquivos: { '.github/workflows/ci.yml': WORKFLOW_SEM_PERMISSOES },
    ...extra,
  })
}

async function sondar(github: GitHubDeMelhoriasFalso, opcoes: { token?: string } = {}) {
  return sondarRepositorio({
    repositorio: REPO,
    credencial: { origem: CREDENCIAL.origem, token: opcoes.token ?? TOKEN },
    fetchImpl: github.fetchFalso,
    agora: AGORA,
  })
}

describe('sondarRepositorio: o que o repositório pode receber', () => {
  it('repositório público com tudo desligado: cada recurso aparece "desligado"', async () => {
    const github = publicoTudoDesligado()
    const s = await sondar(github)
    expect(s).toMatchObject({
      repositorio: REPO,
      comAdmin: true,
      privado: false,
      branchPadrao: 'main',
      segredos: 'desligado',
      bloqueioDePush: 'desligado',
      alertasDeDependencias: 'desligado',
      atualizacoesDeSeguranca: 'desligado',
      varreduraDeCodigo: 'desligado',
      permissaoDoWorkflow: 'write',
      podeAprovarPrs: true,
      linguagensSuportadas: ['javascript-typescript'],
    })
    expect(s.sondadoEm).toBe(AGORA.toISOString())
    expect(s.workflows.estado).toBe('lidos')
    expect(s.workflows.itens).toEqual([
      expect.objectContaining({
        caminho: '.github/workflows/ci.yml',
        declaraPermissoes: false,
        ehDeploy: false,
        temGitleaks: false,
      }),
    ])
  })

  it('só LÊ: nenhuma escrita sai na sondagem', async () => {
    const github = publicoTudoDesligado()
    await sondar(github)
    expect(github.escritas()).toEqual([])
  })

  it('o que já está ligado aparece "ligado"', async () => {
    const github = publicoTudoDesligado({
      segredos: 'enabled',
      bloqueioDePush: 'enabled',
      alertasDeDependencias: true,
      atualizacoesDeSeguranca: true,
      varreduraDeCodigo: 'configured',
      permissaoDoWorkflow: 'read',
    })
    const s = await sondar(github)
    expect(s).toMatchObject({
      segredos: 'ligado',
      bloqueioDePush: 'ligado',
      alertasDeDependencias: 'ligado',
      atualizacoesDeSeguranca: 'ligado',
      varreduraDeCodigo: 'ligado',
      permissaoDoWorkflow: 'read',
    })
  })

  it('privado em plano grátis: 403 "Advanced Security" vira "indisponível" (sem tentar escrever)', async () => {
    const github = publicoTudoDesligado({ privado: true, advancedSecurity: 'disabled' })
    const s = await sondar(github)
    expect(s.privado).toBe(true)
    expect(s.segredos).toBe('indisponivel')
    expect(s.bloqueioDePush).toBe('indisponivel')
    expect(s.varreduraDeCodigo).toBe('indisponivel')
    // os alertas do Dependabot são grátis em qualquer repositório
    expect(s.alertasDeDependencias).toBe('desligado')
    expect(github.escritas()).toEqual([])
  })

  it('privado COM Advanced Security: segredos e código voltam a existir', async () => {
    const github = publicoTudoDesligado({ privado: true, advancedSecurity: 'enabled' })
    const s = await sondar(github)
    expect(s.segredos).toBe('desligado')
    expect(s.varreduraDeCodigo).toBe('desligado')
  })

  it('credencial sem administração: o que pede admin fica "desconhecido", nunca "desligado"', async () => {
    const github = publicoTudoDesligado({ admin: false })
    const s = await sondar(github)
    expect(s.comAdmin).toBe(false)
    expect(s.segredos).toBe('desconhecido')
    expect(s.alertasDeDependencias).toBe('desconhecido')
    expect(s.atualizacoesDeSeguranca).toBe('desconhecido')
    expect(s.varreduraDeCodigo).toBe('desconhecido')
    expect(s.permissaoDoWorkflow).toBeNull()
    // o que não pede admin continua lido
    expect(s.privado).toBe(false)
    expect(s.workflows.estado).toBe('lidos')
  })

  it('código: só linguagem sem suporte vira "indisponível"; workflow do CodeQL já existente também', async () => {
    const semSuporte = await sondar(publicoTudoDesligado({ linguagens: { Shell: 10, HTML: 5 } }))
    expect(semSuporte.linguagensSuportadas).toEqual([])
    expect(semSuporte.varreduraDeCodigo).toBe('indisponivel')

    const comCodeql = await sondar(
      publicoTudoDesligado({
        arquivos: {
          '.github/workflows/codeql.yml': `${WORKFLOW_SEM_PERMISSOES}      - uses: github/codeql-action/analyze@${'b'.repeat(40)}\n`,
        },
      })
    )
    expect(comCodeql.varreduraDeCodigo).toBe('indisponivel')
  })

  it('várias linguagens do GitHub caem nas famílias do CodeQL, sem repetir', async () => {
    const s = await sondar(
      publicoTudoDesligado({
        linguagens: {
          JavaScript: 1,
          TypeScript: 2,
          Python: 3,
          Go: 4,
          Kotlin: 5,
          Java: 6,
          'C++': 7,
          C: 8,
          Shell: 9,
        },
      })
    )
    expect(s.linguagensSuportadas).toEqual(
      ['c-cpp', 'go', 'java-kotlin', 'javascript-typescript', 'python'].sort()
    )
  })

  it('sem a pasta de workflows: "ausente" (404), não erro', async () => {
    const s = await sondar(publicoTudoDesligado({ arquivos: {} }))
    expect(s.workflows).toEqual({ estado: 'ausente', truncado: false, itens: [] })
  })

  it('a pasta de workflows com erro de permissão: "erro" (não vira "ausente")', async () => {
    const github = publicoTudoDesligado({
      forcar: { 'GET /contents/.github/workflows': { status: 403, mensagem: 'Forbidden' } },
    })
    const s = await sondar(github)
    expect(s.workflows.estado).toBe('erro')
  })

  it('workflow ilegível ou com nome fora do padrão não é lido (e conta como não analisado)', async () => {
    const github = publicoTudoDesligado({
      arquivos: { '.github/workflows/ci.yml': WORKFLOW_SEM_PERMISSOES },
      forcar: { 'GET /contents/.github/workflows/ci.yml': { status: 500, mensagem: 'boom' } },
    })
    const s = await sondar(github)
    expect(s.workflows.itens[0]).toMatchObject({
      caminho: '.github/workflows/ci.yml',
      declaraPermissoes: null,
    })
  })

  it('mais workflows que o teto: lê só até o teto e marca "truncado"', async () => {
    const arquivos: Record<string, string> = {}
    for (let n = 0; n < 5; n += 1) arquivos[`.github/workflows/w${n}.yml`] = WORKFLOW_SEM_PERMISSOES
    const github = publicoTudoDesligado({ arquivos })
    const s = await sondarRepositorio({
      repositorio: REPO,
      credencial: CREDENCIAL,
      fetchImpl: github.fetchFalso,
      agora: AGORA,
      maximoDeWorkflows: 3,
    })
    expect(s.workflows.truncado).toBe(true)
    expect(s.workflows.itens).toHaveLength(3)
  })

  it.each([
    ['uma sonda dá 5xx', { 'GET /vulnerability-alerts': { status: 502, mensagem: 'bad gateway' } }],
    [
      'o limite de taxa estoura no meio',
      {
        'GET /languages': {
          status: 403,
          mensagem: 'API rate limit exceeded',
          cabecalhos: { 'x-ratelimit-remaining': '0' },
        },
      },
    ],
    [
      'a pasta de workflows dá 5xx',
      { 'GET /contents/.github/workflows': { status: 500, mensagem: 'boom' } },
    ],
  ])(
    'leitura incompleta (%s): a sondagem inteira é descartada, não vira "desconhecido" para o dia todo',
    async (_n, forcar) => {
      const github = publicoTudoDesligado({ forcar })
      await expect(sondar(github)).rejects.toThrow(/leitura incompleta/)
      const memoria = criarPrismaDeSegurancaEmMemoria()
      const r = await obterSondagem({
        prisma: memoria.prisma,
        projectId: 'p1',
        repositorio: REPO,
        credenciais: [CREDENCIAL],
        fetchImpl: github.fetchFalso,
        agora: AGORA,
        exigirAdmin: false,
        onWarn: () => {},
      })
      expect(r).toBeNull()
      expect(memoria.estadoDe('p1', 'sondagem')).toBeUndefined()
    }
  )

  it('falha em ler o próprio repositório: lança (nada de sondagem falsa)', async () => {
    const github = publicoTudoDesligado({
      forcar: { 'GET ': { status: 404, mensagem: 'Not Found' } },
    })
    await expect(sondar(github)).rejects.toThrow(/404/)
  })

  it('o repositório com formato inválido é recusado ANTES de qualquer chamada', async () => {
    const github = publicoTudoDesligado()
    await expect(
      sondarRepositorio({
        repositorio: 'acme/../../outro',
        credencial: CREDENCIAL,
        fetchImpl: github.fetchFalso,
        agora: AGORA,
      })
    ).rejects.toThrow(/formato/)
    expect(github.registro).toEqual([])
  })

  it('cota estourada: avisa quem cuida do freio e lança', async () => {
    const github = publicoTudoDesligado({ limiteDeTaxa: true })
    const ruins: number[] = []
    await expect(
      sondarRepositorio({
        repositorio: REPO,
        credencial: CREDENCIAL,
        fetchImpl: github.fetchFalso,
        agora: AGORA,
        aoReceberRespostaRuim: (r) => ruins.push(r.status),
      })
    ).rejects.toThrow(/403/)
    expect(ruins).toEqual([403])
  })

  it('a credencial só viaja no cabeçalho: nem a sondagem nem o erro a carregam', async () => {
    const github = publicoTudoDesligado()
    const s = await sondar(github)
    expect(JSON.stringify(s)).not.toContain(TOKEN)
    expect(new Set(github.registro.map((r) => r.autorizacao))).toEqual(new Set([`Bearer ${TOKEN}`]))
    expect(github.registro.every((r) => !r.caminho.includes(TOKEN))).toBe(true)

    const quebrado = publicoTudoDesligado({ forcar: { 'GET ': { status: 500, mensagem: 'x' } } })
    const erro = await sondar(quebrado).catch((e: unknown) => e)
    expect(String((erro as Error).message)).not.toContain(TOKEN)
  })

  it('orçamento de leituras: no máximo 7 chamadas fixas mais uma por workflow', async () => {
    const github = publicoTudoDesligado()
    await sondar(github)
    // repositório, 3 recursos, linguagens, permissão do workflow, pasta de workflows + 1 arquivo
    expect(github.registro).toHaveLength(8)
  })
})

describe('recursoDeSegredosDisponivel', () => {
  const base = (parcial: Partial<SondagemDoRepositorio>): SondagemDoRepositorio =>
    ({
      repositorio: REPO,
      privado: false,
      segredos: 'desconhecido',
      ...parcial,
    }) as SondagemDoRepositorio

  it('repositório público: sempre existe', () => {
    expect(recursoDeSegredosDisponivel(base({ privado: false, segredos: 'desconhecido' }))).toBe(
      true
    )
  })
  it('privado: só se a sondagem viu o recurso (ligado ou desligado)', () => {
    expect(recursoDeSegredosDisponivel(base({ privado: true, segredos: 'ligado' }))).toBe(true)
    expect(recursoDeSegredosDisponivel(base({ privado: true, segredos: 'desligado' }))).toBe(true)
    expect(recursoDeSegredosDisponivel(base({ privado: true, segredos: 'indisponivel' }))).toBe(
      false
    )
    expect(recursoDeSegredosDisponivel(base({ privado: true, segredos: 'desconhecido' }))).toBe(
      false
    )
  })
  it('sem saber se é privado: não supõe que existe', () => {
    expect(recursoDeSegredosDisponivel(base({ privado: null }))).toBe(false)
  })
})

describe('cache da sondagem (uma por projeto por dia)', () => {
  it('sem ficha: nada em cache', async () => {
    const { prisma } = criarPrismaDeSegurancaEmMemoria()
    expect(await lerSondagemEmCache(prisma, 'p1', AGORA)).toBeNull()
  })

  it('obterSondagem sonda, grava e a chamada seguinte do mesmo dia NÃO chama o GitHub', async () => {
    const memoria = criarPrismaDeSegurancaEmMemoria()
    const github = publicoTudoDesligado()
    const deps = {
      prisma: memoria.prisma,
      projectId: 'p1',
      repositorio: REPO,
      credenciais: [CREDENCIAL],
      fetchImpl: github.fetchFalso,
      agora: AGORA,
      exigirAdmin: false,
    }
    const primeira = await obterSondagem(deps)
    expect(primeira?.deCache).toBe(false)
    const chamadas = github.registro.length
    expect(chamadas).toBeGreaterThan(0)

    const segunda = await obterSondagem({
      ...deps,
      agora: new Date(AGORA.getTime() + VALIDADE_DA_SONDAGEM_MS - 1000),
    })
    expect(segunda?.deCache).toBe(true)
    expect(segunda?.sondagem).toEqual(primeira?.sondagem)
    expect(github.registro).toHaveLength(chamadas)
  })

  it('passado o prazo, sonda de novo', async () => {
    const memoria = criarPrismaDeSegurancaEmMemoria()
    const github = publicoTudoDesligado()
    const deps = {
      prisma: memoria.prisma,
      projectId: 'p1',
      repositorio: REPO,
      credenciais: [CREDENCIAL],
      fetchImpl: github.fetchFalso,
      exigirAdmin: false,
    }
    await obterSondagem({ ...deps, agora: AGORA })
    const chamadas = github.registro.length
    const depois = await obterSondagem({
      ...deps,
      agora: new Date(AGORA.getTime() + VALIDADE_DA_SONDAGEM_MS + 1000),
    })
    expect(depois?.deCache).toBe(false)
    expect(github.registro.length).toBe(chamadas * 2)
  })

  it('cache feito SEM admin não serve a quem exige admin', async () => {
    const memoria = criarPrismaDeSegurancaEmMemoria()
    const github = publicoTudoDesligado({ tokenDeAdmin: 'token-admin' })
    const deps = {
      prisma: memoria.prisma,
      projectId: 'p1',
      repositorio: REPO,
      fetchImpl: github.fetchFalso,
      agora: AGORA,
    }
    const fraco = await obterSondagem({
      ...deps,
      credenciais: [{ origem: 'App do produto', token: 'token-comum' }],
      exigirAdmin: false,
    })
    expect(fraco?.sondagem.comAdmin).toBe(false)

    const forte = await obterSondagem({
      ...deps,
      credenciais: [{ origem: 'cliente ou dono', token: 'token-admin' }],
      exigirAdmin: true,
    })
    expect(forte?.deCache).toBe(false)
    expect(forte?.sondagem.comAdmin).toBe(true)
    expect(memoria.estadoDe('p1', 'sondagem')).toMatchObject({ sondagem: { comAdmin: true } })
  })

  it('a ordem das credenciais é respeitada: a primeira sem admin cede à segunda que prova admin', async () => {
    const memoria = criarPrismaDeSegurancaEmMemoria()
    const github = publicoTudoDesligado({ tokenDeAdmin: 'token-do-app' })
    const r = await obterSondagem({
      prisma: memoria.prisma,
      projectId: 'p1',
      repositorio: REPO,
      credenciais: [
        { origem: 'cliente ou dono', token: 'token-do-cliente' },
        { origem: 'App do produto', token: 'token-do-app' },
      ],
      fetchImpl: github.fetchFalso,
      agora: AGORA,
      exigirAdmin: true,
    })
    expect(r?.credencial.origem).toBe('App do produto')
    expect(r?.sondagem.comAdmin).toBe(true)
    // a do cliente foi tentada primeiro
    expect(github.registro[0]?.autorizacao).toBe('Bearer token-do-cliente')
  })

  it('credencial do cliente com admin: a do App nem é tentada', async () => {
    const memoria = criarPrismaDeSegurancaEmMemoria()
    const github = publicoTudoDesligado()
    await obterSondagem({
      prisma: memoria.prisma,
      projectId: 'p1',
      repositorio: REPO,
      credenciais: [
        { origem: 'cliente ou dono', token: 'token-do-cliente' },
        { origem: 'App do produto', token: 'token-do-app' },
      ],
      fetchImpl: github.fetchFalso,
      agora: AGORA,
      exigirAdmin: true,
    })
    expect(new Set(github.registro.map((r) => r.autorizacao))).toEqual(
      new Set(['Bearer token-do-cliente'])
    )
  })

  it('sondagem que falha NÃO é gravada e devolve null', async () => {
    const memoria = criarPrismaDeSegurancaEmMemoria()
    const github = publicoTudoDesligado({
      forcar: { 'GET ': { status: 404, mensagem: 'Not Found' } },
    })
    const avisos: string[] = []
    const r = await obterSondagem({
      prisma: memoria.prisma,
      projectId: 'p1',
      repositorio: REPO,
      credenciais: [CREDENCIAL],
      fetchImpl: github.fetchFalso,
      agora: AGORA,
      exigirAdmin: false,
      onWarn: (m) => avisos.push(m),
    })
    expect(r).toBeNull()
    expect(memoria.estadoDe('p1', 'sondagem')).toBeUndefined()
    expect(avisos.join(' ')).not.toContain(TOKEN)
    expect(avisos).toHaveLength(1)
  })

  it('ficha de sondagem corrompida é ignorada (sonda de novo), nunca confiada', async () => {
    const memoria = criarPrismaDeSegurancaEmMemoria()
    await memoria.prisma.repoItem.upsert({
      where: { projectId_tipo_numero: { projectId: 'p1', tipo: 'sondagem', numero: 0 } },
      create: {
        projectId: 'p1',
        tipo: 'sondagem',
        numero: 0,
        estado: { sondagem: { segredos: 42 } },
      },
      update: {},
    })
    expect(await lerSondagemEmCache(memoria.prisma, 'p1', AGORA)).toBeNull()
  })

  it('gravar a sondagem falhando não impede de usá-la', async () => {
    const memoria = criarPrismaDeSegurancaEmMemoria()
    const github = publicoTudoDesligado()
    const avisos: string[] = []
    const quebrado = {
      ...memoria.prisma,
      repoItem: {
        ...memoria.prisma.repoItem,
        upsert: vi.fn().mockRejectedValue(new Error('banco fora do ar')),
      },
    }
    const r = await obterSondagem({
      prisma: quebrado,
      projectId: 'p1',
      repositorio: REPO,
      credenciais: [CREDENCIAL],
      fetchImpl: github.fetchFalso,
      agora: AGORA,
      exigirAdmin: false,
      onWarn: (m) => avisos.push(m),
    })
    expect(r?.sondagem.segredos).toBe('desligado')
    expect(avisos.some((a) => a.includes('banco fora do ar'))).toBe(true)
  })
})
