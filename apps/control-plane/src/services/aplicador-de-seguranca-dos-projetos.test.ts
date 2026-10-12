import { afterEach, describe, expect, it } from 'vitest'
import {
  aplicarMelhoriasDeSegurancaDosProjetos,
  desfazerMelhoriaDoProjeto,
  lerFichaDeMelhorias,
  INTERVALO_ENTRE_PASSADAS_MS,
  type ProjetoParaAplicar,
  type ResumoDaAplicacao,
} from './aplicador-de-seguranca-dos-projetos.js'
import { criarRitmoDeEscrita, PREFIXO_DOS_RAMOS_DE_SEGURANCA } from './escritor-de-seguranca.js'
import { fetchDoRepositorio } from './guarda-de-autonomia.js'
import { limparFreiosDeCota, registrarFreioDeCota } from './freio-de-cota-do-github.js'
import { ErroDoGitHub } from './erro-do-github.js'
import {
  INTERRUPTOR_DA_ALLOWLIST_DA_SEGURANCA,
  INTERRUPTOR_GERAL_DA_SEGURANCA,
  INTERRUPTOR_POR_MELHORIA,
} from './interruptores-de-seguranca.js'
import { CAMINHO_DO_WORKFLOW_DE_SENHAS } from './alternativa-gratuita-de-seguranca.js'
import { BLOCO_DE_PERMISSOES_MINIMAS } from './workflows-de-seguranca.js'
import {
  GitHubDeMelhoriasFalso,
  type ConfiguracaoDoRepositorioFalso,
} from '../test/github-de-melhorias-fake.js'
import {
  criarPerguntadorFalso,
  criarPrismaDeSegurancaEmMemoria,
} from '../test/prisma-de-seguranca-em-memoria.js'

const TOKEN_DO_CLIENTE = 'ghp_sentinela_do_cliente_000000000000'
const TOKEN_DO_APP = 'ghs_sentinela_do_app_00000000000000'
/** A credencial do App que assina os pull requests (a instalação), distinta das outras duas. */
const TOKEN_DO_PR = 'ghs_instalacao_dos_pull_requests_00'
const INICIO = Date.parse('2026-03-10T12:00:00.000Z')

const CI = [
  'name: ci',
  'on: push',
  '',
  'jobs:',
  '  t:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  `      - uses: actions/checkout@${'a'.repeat(40)}`,
  '      - run: npm test',
  '',
].join('\n')

function projeto(parcial: Partial<ProjetoParaAplicar> = {}): ProjetoParaAplicar {
  return {
    id: 'p1',
    wingId: 'acme/api',
    userId: 'u1',
    autonomia: 'cuidar',
    autonomiaDeSeguranca: 'cuidar',
    ...parcial,
  }
}

function repositorio(nome: string, extra: ConfiguracaoDoRepositorioFalso = {}) {
  return new GitHubDeMelhoriasFalso(nome, {
    privado: false,
    segredos: 'disabled',
    bloqueioDePush: 'disabled',
    alertasDeDependencias: false,
    atualizacoesDeSeguranca: false,
    varreduraDeCodigo: 'not-configured',
    linguagens: { TypeScript: 100 },
    permissaoDoWorkflow: 'write',
    podeAprovarPrs: false,
    arquivos: { '.github/workflows/ci.yml': CI },
    ...extra,
  })
}

function cenario(
  repos: Record<string, GitHubDeMelhoriasFalso>,
  projetos: ProjetoParaAplicar[],
  opcoes: {
    env?: Record<string, string | undefined>
    credenciais?: Array<{ origem: string; token: string }>
    comPerguntador?: boolean
    perguntadorFalha?: boolean
    fetchDeLeitura?: typeof fetch
    /** Sem o App neste repositório: não há credencial para assinar pull request. */
    semApp?: boolean
    /** O nível que a guarda de autonomia da SAÍDA DE REDE lê (padrão: o do projeto). */
    nivelDaGuarda?: string
  } = {}
) {
  let t = INICIO
  const memoria = criarPrismaDeSegurancaEmMemoria(() => new Date(t))
  const perguntador = criarPerguntadorFalso(memoria.perguntas, {
    falhar: opcoes.perguntadorFalha === true,
  })
  const infos: string[] = []
  const avisos: string[] = []
  const esperas: number[] = []
  const roteador: typeof fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit
  ) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const repo = /^\/repos\/([^/]+\/[^/]+)/.exec(url.pathname)?.[1]
    const alvo = repo ? repos[repo] : undefined
    if (!alvo) return new Response('{"message":"Not Found"}', { status: 404 })
    return alvo.fetchFalso(input, init)
  }) as typeof fetch
  for (const g of Object.values(repos)) g.usarRelogio(() => t)
  const ritmo = criarRitmoDeEscrita({
    esperar: async (ms) => {
      esperas.push(ms)
      t += ms
    },
    agora: () => t,
  })
  const credenciais = opcoes.credenciais ?? [
    { origem: 'cliente ou dono', token: TOKEN_DO_CLIENTE },
    { origem: 'App do produto', token: TOKEN_DO_APP },
  ]

  const passada = async (
    extra: { projetos?: ProjetoParaAplicar[]; orcamentoMs?: number } = {}
  ): Promise<ResumoDaAplicacao> =>
    aplicarMelhoriasDeSegurancaDosProjetos({
      prisma: memoria.prisma,
      projetos: extra.projetos ?? projetos,
      agora: () => new Date(t),
      credenciais: async () => credenciais,
      fetchDeLeitura: opcoes.fetchDeLeitura ?? roteador,
      tokenDoApp: async () => (opcoes.semApp === true ? null : TOKEN_DO_PR),
      fetchDeEscrita: (p) =>
        fetchDoRepositorio({
          nivel: () => opcoes.nivelDaGuarda ?? p.autonomia,
          fetchImpl: roteador,
        }),
      ritmo,
      agentQuestion: opcoes.comPerguntador === false ? null : perguntador,
      env: opcoes.env ?? {},
      onInfo: (m) => infos.push(m),
      onWarn: (m) => avisos.push(m),
      ...(extra.orcamentoMs !== undefined ? { orcamentoMs: extra.orcamentoMs } : {}),
    })

  /** Uma passada e o tempo anda até a próxima janela. */
  const passadaEAvanca = async () => {
    const r = await passada()
    t += INTERVALO_ENTRE_PASSADAS_MS + 1000
    return r
  }

  return {
    memoria,
    perguntador,
    infos,
    avisos,
    esperas,
    passada,
    passadaEAvanca,
    avancar: (ms: number) => {
      t += ms
    },
    agora: () => t,
  }
}

const escritas = (g: GitHubDeMelhoriasFalso) => g.escritas().map((e) => `${e.metodo} ${e.caminho}`)

afterEach(() => limparFreiosDeCota())

describe('aplicador: travas (nenhuma requisição quando não pode)', () => {
  it.each([
    ['autonomia so_olhar', projeto({ autonomia: 'so_olhar' })],
    ['autonomia sugerir', projeto({ autonomia: 'sugerir' })],
    ['autonomia de segurança so_olhar', projeto({ autonomiaDeSeguranca: 'so_olhar' })],
    ['autonomia de segurança sugerir', projeto({ autonomiaDeSeguranca: 'sugerir' })],
    ['autonomia nula', projeto({ autonomia: null })],
  ])('%s: ZERO requisições, nem de leitura', async (_n, p) => {
    const github = repositorio('acme/api')
    const c = cenario({ 'acme/api': github }, [p])
    const r = await c.passada()
    expect(r.resultado).toBe('nada-a-fazer')
    expect(github.registro).toEqual([])
    expect(c.memoria.fichas.size).toBe(0)
  })

  it('interruptor geral desligado: nada', async () => {
    const github = repositorio('acme/api')
    const c = cenario({ 'acme/api': github }, [projeto()], {
      env: { [INTERRUPTOR_GERAL_DA_SEGURANCA]: 'off' },
    })
    expect((await c.passada()).resultado).toBe('nada-a-fazer')
    expect(github.registro).toEqual([])
  })

  it('projeto fora da allowlist: nada; dentro dela, aplica', async () => {
    const github = repositorio('acme/api')
    const fora = cenario({ 'acme/api': github }, [projeto()], {
      env: { [INTERRUPTOR_DA_ALLOWLIST_DA_SEGURANCA]: 'outro/repo' },
    })
    expect((await fora.passada()).resultado).toBe('nada-a-fazer')
    expect(github.registro).toEqual([])

    const dentro = cenario({ 'acme/api': github }, [projeto()], {
      env: { [INTERRUPTOR_DA_ALLOWLIST_DA_SEGURANCA]: 'acme/api' },
    })
    expect((await dentro.passada()).resultado).toBe('aplicou')
    expect(escritas(github)).toHaveLength(1)
  })

  it('a allowlist deixa passar só o projeto listado entre dois', async () => {
    const a = repositorio('acme/api')
    const b = repositorio('acme/web')
    const c = cenario(
      { 'acme/api': a, 'acme/web': b },
      [projeto(), projeto({ id: 'p2', wingId: 'acme/web' })],
      {
        env: { [INTERRUPTOR_DA_ALLOWLIST_DA_SEGURANCA]: 'acme/web' },
      }
    )
    await c.passadaEAvanca()
    await c.passadaEAvanca()
    await c.passadaEAvanca()
    expect(a.registro).toEqual([])
    expect(b.escritas().length).toBeGreaterThan(0)
  })

  it('o interruptor de UMA peça pula só ela: a próxima da fila é aplicada', async () => {
    const github = repositorio('acme/api')
    const c = cenario({ 'acme/api': github }, [projeto()], {
      env: { [INTERRUPTOR_POR_MELHORIA['alertas-de-dependencias']]: 'off' },
    })
    const r = await c.passada()
    expect(r.melhoria).toBe('varredura-de-senhas')
    expect(escritas(github)).toEqual(['PATCH /repos/acme/api'])
    expect(github.config.alertasDeDependencias).toBe(false)
  })

  it('sem nenhuma credencial: nada é chamado e a passada não martela (espera o intervalo)', async () => {
    const github = repositorio('acme/api')
    const c = cenario({ 'acme/api': github }, [projeto()], { credenciais: [] })
    expect((await c.passada()).resultado).toBe('sem-credencial')
    expect(github.registro).toEqual([])
    expect((await c.passada()).resultado).toBe('nada-a-fazer')
  })

  it('freio de cota ativo para o dono: pula com uma linha, sem requisição', async () => {
    const github = repositorio('acme/api')
    const c = cenario({ 'acme/api': github }, [projeto()])
    registrarFreioDeCota(
      'acme',
      new ErroDoGitHub('cota', {
        status: 403,
        retryAfterSegundos: 600,
        limiteRestante: 0,
        limiteResetaEmSegundos: null,
      }),
      new Date(c.agora())
    )
    expect((await c.passada()).resultado).toBe('freio')
    expect(github.registro).toEqual([])
    expect(c.infos.join('\n')).toMatch(/freio de cota/)
  })
})

describe('aplicador: uma melhoria por projeto por passada, em ordem, com intervalo', () => {
  it('repositório público: as escritas saem uma por passada, na ordem combinada', async () => {
    const github = repositorio('acme/api')
    const c = cenario({ 'acme/api': github }, [projeto()])
    const porPassada: string[][] = []
    for (let i = 0; i < 7; i += 1) {
      const antes = github.escritas().length
      await c.passadaEAvanca()
      porPassada.push(
        github
          .escritas()
          .slice(antes)
          .map((e) => `${e.metodo} ${e.caminho}`)
      )
    }
    // nunca mais de uma melhoria por passada
    expect(porPassada.slice(0, 4)).toEqual([
      ['PUT /repos/acme/api/vulnerability-alerts'],
      ['PUT /repos/acme/api/automated-security-fixes'],
      ['PATCH /repos/acme/api'],
      ['PATCH /repos/acme/api/code-scanning/default-setup'],
    ])
    // a quinta passada abre o PR das permissões mínimas: ramo, arquivo e PR
    expect(porPassada[4]).toEqual([
      'POST /repos/acme/api/git/refs',
      'PUT /repos/acme/api/contents/.github/workflows/ci.yml',
      'POST /repos/acme/api/pulls',
    ])
    // e enquanto o PR não é mesclado, nada mais é escrito
    expect(porPassada[5]).toEqual([])
    expect(porPassada[6]).toEqual([])
    expect(github.config.permissaoDoWorkflow).toBe('write')
  })

  it('uma passada seguida da outra DENTRO do intervalo: a segunda não faz nada', async () => {
    const github = repositorio('acme/api')
    const c = cenario({ 'acme/api': github }, [projeto()])
    await c.passada()
    const antes = github.registro.length
    c.avancar(INTERVALO_ENTRE_PASSADAS_MS - 5000)
    expect((await c.passada()).resultado).toBe('nada-a-fazer')
    expect(github.registro).toHaveLength(antes)
    c.avancar(6000)
    expect((await c.passada()).resultado).toBe('aplicou')
  })

  it('os PRs: o pacote é concluído quando o dono mescla, e só então a permissão padrão do token muda', async () => {
    const github = repositorio('acme/api')
    const c = cenario({ 'acme/api': github }, [projeto()])
    for (let i = 0; i < 6; i += 1) await c.passadaEAvanca()
    expect(github.config.permissaoDoWorkflow).toBe('write')
    github.mesclarPull(1)
    // acompanha o PR (só leitura), re-sonda e então aplica
    for (let i = 0; i < 3; i += 1) await c.passadaEAvanca()
    expect(github.config.permissaoDoWorkflow).toBe('read')
    expect(github.arquivoNaPadrao('.github/workflows/ci.yml')).toContain(
      BLOCO_DE_PERMISSOES_MINIMAS
    )
    // a ordem: o PR vem ANTES do PUT, que é a última escrita
    const todas = escritas(github)
    expect(todas.at(-1)).toBe('PUT /repos/acme/api/actions/permissions/workflow')
    expect(todas.indexOf('POST /repos/acme/api/pulls')).toBeLessThan(todas.length - 1)
  })

  it('reentrância: com tudo aplicado, as passadas seguintes não escrevem nem repetem evento', async () => {
    const github = repositorio('acme/api')
    const c = cenario({ 'acme/api': github }, [projeto()])
    for (let i = 0; i < 6; i += 1) await c.passadaEAvanca()
    github.mesclarPull(1)
    for (let i = 0; i < 4; i += 1) await c.passadaEAvanca()
    const escritasAntes = github.escritas().length
    const eventosAntes = c.memoria.chavesDeEventos().length
    for (let i = 0; i < 3; i += 1) await c.passadaEAvanca()
    expect(github.escritas()).toHaveLength(escritasAntes)
    expect(c.memoria.chavesDeEventos()).toHaveLength(eventosAntes)
    expect(new Set(c.memoria.chavesDeEventos()).size).toBe(c.memoria.chavesDeEventos().length)
  })

  it('várias escritas do mesmo PR respeitam o intervalo de 1 s (relógio falso)', async () => {
    const github = repositorio('acme/api')
    const c = cenario({ 'acme/api': github }, [projeto()])
    for (let i = 0; i < 5; i += 1) await c.passadaEAvanca()
    const doPr = github.escritas().slice(-3)
    expect(doPr).toHaveLength(3)
    expect(doPr[1]!.em - doPr[0]!.em).toBeGreaterThanOrEqual(1000)
    expect(doPr[2]!.em - doPr[1]!.em).toBeGreaterThanOrEqual(1000)
    expect(c.esperas.filter((ms) => ms > 0).length).toBeGreaterThanOrEqual(2)
  })

  it('duas passadas ao mesmo tempo no mesmo projeto: só uma escreve, a outra não faz nada', async () => {
    const github = repositorio('acme/api')
    const c = cenario({ 'acme/api': github }, [projeto()])
    const [a, b] = await Promise.all([c.passada(), c.passada()])
    expect(escritas(github)).toEqual(['PUT /repos/acme/api/vulnerability-alerts'])
    expect([a.resultado, b.resultado].sort()).toEqual(['aplicou', 'nada-a-fazer'])
  })

  it('a passada reserva o projeto antes de ler ou escrever, para um segundo processo não pegá-lo', async () => {
    const github = repositorio('acme/api')
    let estadoDaFicha: () => unknown = () => undefined
    let reservaVista: string | null = null
    const leitura: typeof fetch = (async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit
    ) => {
      const ficha = estadoDaFicha() as { proximaPassadaEm?: string } | undefined
      reservaVista ??= ficha?.proximaPassadaEm ?? null
      return github.fetchFalso(input, init)
    }) as typeof fetch
    const c = cenario({ 'acme/api': github }, [projeto()], { fetchDeLeitura: leitura })
    estadoDaFicha = () => c.memoria.estadoDe('p1', 'melhorias')
    const inicio = c.agora()
    await c.passada()
    expect(reservaVista).not.toBeNull()
    expect(Date.parse(reservaVista as unknown as string)).toBeGreaterThan(inicio)
  })

  it('dois projetos: um por passada, o mais antigo primeiro', async () => {
    const a = repositorio('acme/api')
    const b = repositorio('acme/web')
    const c = cenario({ 'acme/api': a, 'acme/web': b }, [
      projeto(),
      projeto({ id: 'p2', wingId: 'acme/web' }),
    ])
    await c.passada()
    expect(a.escritas()).toHaveLength(1)
    expect(b.escritas()).toHaveLength(0)
    await c.passada()
    expect(b.escritas()).toHaveLength(1)
    expect(a.escritas()).toHaveLength(1)
  })
})

describe('aplicador: a trilha no painel e o estado explícito', () => {
  it('"aplicado" grava o evento com a chave combinada e o COMO DESFAZER; a ficha guarda o estado anterior', async () => {
    const github = repositorio('acme/api')
    const c = cenario({ 'acme/api': github }, [projeto()])
    await c.passada()
    expect(c.memoria.chavesDeEventos()).toContain(
      'melhoria-de-seguranca:acme/api:alertas-de-dependencias:aplicado'
    )
    const evento = c.memoria.eventos.find((e) => e.payload.chave?.endsWith(':aplicado'))
    expect(evento?.payload.texto).toMatch(/Como desfazer/)
    const ficha = c.memoria.estadoDe('p1', 'melhorias') as {
      melhorias: Record<string, { estado: string; anterior: unknown; desfazer: string }>
    }
    expect(ficha.melhorias['alertas-de-dependencias']).toMatchObject({
      estado: 'aplicado',
      anterior: { alertas: 'desligado' },
    })
    expect(ficha.melhorias['alertas-de-dependencias']?.desfazer).toMatch(/Como desfazer/)
  })

  it('403 "Upgrade to GitHub Pro" => "indisponível": nenhuma nova tentativa e o resto segue', async () => {
    const github = repositorio('acme/api', {
      forcar: {
        'PUT /vulnerability-alerts': {
          status: 403,
          mensagem: 'Upgrade to GitHub Pro or make this repository public to enable this feature.',
        },
      },
    })
    const c = cenario({ 'acme/api': github }, [projeto()])
    const r1 = await c.passadaEAvanca()
    expect(r1).toMatchObject({ melhoria: 'alertas-de-dependencias', estado: 'indisponivel' })
    expect(c.memoria.chavesDeEventos()).toContain(
      'melhoria-de-seguranca:acme/api:alertas-de-dependencias:indisponivel'
    )
    const tentativas = () =>
      github.escritas().filter((e) => e.caminho.endsWith('/vulnerability-alerts')).length
    expect(tentativas()).toBe(1)
    for (let i = 0; i < 4; i += 1) await c.passadaEAvanca()
    expect(tentativas()).toBe(1)
    expect(github.config.varreduraDeCodigo).toBe('configured')
  })

  it('sem permissão (403 de integração) => "recusado", no painel; nunca "aplicado"', async () => {
    const github = repositorio('acme/api', {
      forcar: {
        'PUT /vulnerability-alerts': {
          status: 403,
          mensagem: 'Resource not accessible by integration',
        },
      },
    })
    const c = cenario({ 'acme/api': github }, [projeto()])
    await c.passada()
    expect(c.memoria.chavesDeEventos()).toContain(
      'melhoria-de-seguranca:acme/api:alertas-de-dependencias:recusado'
    )
    expect(c.memoria.chavesDeEventos()).not.toContain(
      'melhoria-de-seguranca:acme/api:alertas-de-dependencias:aplicado'
    )
  })

  it('uma melhoria que falha não impede a seguinte nas passadas seguintes', async () => {
    const github = repositorio('acme/api', {
      forcar: { 'PUT /vulnerability-alerts': { status: 500, mensagem: 'boom' } },
    })
    const c = cenario({ 'acme/api': github }, [projeto()])
    await c.passadaEAvanca()
    const r2 = await c.passadaEAvanca()
    expect(r2.melhoria).toBe('varredura-de-senhas')
    expect(github.config.segredos).toBe('enabled')
  })
})

describe('aplicador: repositório privado em plano grátis', () => {
  it('não tenta nada pago; os alertas (grátis) saem por API e a alternativa gratuita sai por PR', async () => {
    const github = repositorio('acme/api', { privado: true, advancedSecurity: 'disabled' })
    const c = cenario({ 'acme/api': github }, [projeto()])
    for (let i = 0; i < 6; i += 1) await c.passadaEAvanca()
    const todas = escritas(github)
    expect(todas).toContain('PUT /repos/acme/api/vulnerability-alerts')
    expect(todas).toContain('PUT /repos/acme/api/automated-security-fixes')
    // nada de varredura de senhas nem de código pelas APIs pagas
    expect(todas).not.toContain('PATCH /repos/acme/api')
    expect(todas).not.toContain('PATCH /repos/acme/api/code-scanning/default-setup')
    // a alternativa gratuita: PR com o workflow do gitleaks, NUNCA na branch padrão
    const ramo = `${PREFIXO_DOS_RAMOS_DE_SEGURANCA}alternativa-de-varredura-de-senhas`
    expect(github.arquivoNoRamo(ramo, CAMINHO_DO_WORKFLOW_DE_SENHAS)).toContain('gitleaks')
    expect(github.arquivoNaPadrao(CAMINHO_DO_WORKFLOW_DE_SENHAS)).toBeUndefined()
    expect(github.pulls.some((p) => p.head === ramo)).toBe(true)
  })

  it('403 de plano grátis na escrita da varredura de senhas cai na alternativa por PR', async () => {
    // a sondagem acha que dá (Advanced Security aparece ligada), mas o PATCH volta 403
    const github = repositorio('acme/api', {
      privado: true,
      advancedSecurity: 'enabled',
      alertasDeDependencias: true,
      atualizacoesDeSeguranca: true,
      forcar: {
        'PATCH ': {
          status: 403,
          mensagem: 'Upgrade to GitHub Pro or make this repository public to enable this feature.',
        },
      },
    })
    const c = cenario({ 'acme/api': github }, [projeto()])
    const r1 = await c.passadaEAvanca()
    expect(r1).toMatchObject({ melhoria: 'varredura-de-senhas', estado: 'indisponivel' })
    expect(github.pulls).toHaveLength(0)
    for (let i = 0; i < 6; i += 1) await c.passadaEAvanca()
    const ramo = `${PREFIXO_DOS_RAMOS_DE_SEGURANCA}alternativa-de-varredura-de-senhas`
    expect(github.pulls.some((p) => p.head === ramo)).toBe(true)
    expect(github.arquivoNaPadrao(CAMINHO_DO_WORKFLOW_DE_SENHAS)).toBeUndefined()
  })
})

describe('aplicador: workflows de deploy/CD e a permissão padrão', () => {
  const CD = CI.replace('name: ci', 'name: cd')

  it('o workflow de deploy fica INTOCADO, e o dono é perguntado UMA vez (3 objetivas + 1 aberta)', async () => {
    const github = repositorio('acme/api', {
      arquivos: { '.github/workflows/ci.yml': CI, '.github/workflows/cd.yml': CD },
    })
    const c = cenario({ 'acme/api': github }, [projeto()])
    for (let i = 0; i < 12; i += 1) await c.passadaEAvanca()

    // nenhum ramo/PR mexeu no cd.yml
    expect(github.pulls.every((p) => !p.head.includes('cd-yml'))).toBe(true)
    expect(github.arquivoNaPadrao('.github/workflows/cd.yml')).toBe(CD)
    expect(escritas(github).some((e) => e.includes('cd.yml'))).toBe(false)

    expect(c.perguntador.chamadas).toHaveLength(1)
    const pergunta = c.perguntador.chamadas[0]!
    expect(pergunta.userId).toBe('u1')
    expect(pergunta.projectId).toBe('p1')
    const opcoes = pergunta.input['options'] as Array<{ label: string; value: string }>
    expect(opcoes).toHaveLength(4)
    expect(opcoes.slice(0, 3).map((o) => o.value)).toEqual([
      'permissoes-deploy-aplicar',
      'permissoes-deploy-manter',
      'permissoes-deploy-explicar',
    ])
    expect(pergunta.input['dedupKey']).toBe(
      'seguranca-permissoes:acme/api:.github/workflows/cd.yml'
    )
    expect(String(pergunta.input['text'])).toContain('cd.yml')
    // o PUT da permissão padrão fica bloqueado enquanto o deploy não declarar permissions
    github.mesclarPull(1)
    for (let i = 0; i < 4; i += 1) await c.passadaEAvanca()
    expect(github.config.permissaoDoWorkflow).toBe('write')
    expect(c.perguntador.chamadas).toHaveLength(1)
  })

  it('um workflow chamado "Build" que publica em tag é deploy pelo corpo: fica INTOCADO e o dono é perguntado', async () => {
    const BUILD_QUE_PUBLICA = [
      'name: Build',
      'on:',
      '  push:',
      '    tags: ["v*"]',
      '',
      'jobs:',
      '  build:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      `      - uses: actions/checkout@${'a'.repeat(40)}`,
      '      - run: npm ci',
      '      - run: npm publish',
      '',
    ].join('\n')
    const github = repositorio('acme/api', {
      arquivos: {
        '.github/workflows/ci.yml': CI,
        '.github/workflows/build.yml': BUILD_QUE_PUBLICA,
      },
    })
    const c = cenario({ 'acme/api': github }, [projeto()])
    for (let i = 0; i < 12; i += 1) await c.passadaEAvanca()

    expect(github.pulls.every((p) => !p.head.includes('build-yml'))).toBe(true)
    expect(github.arquivoNaPadrao('.github/workflows/build.yml')).toBe(BUILD_QUE_PUBLICA)
    expect(escritas(github).some((e) => e.includes('build.yml'))).toBe(false)
    expect(c.perguntador.chamadas).toHaveLength(1)
    expect(c.perguntador.chamadas[0]!.input['dedupKey']).toBe(
      'seguranca-permissoes:acme/api:.github/workflows/build.yml'
    )
  })

  const SHA = 'a'.repeat(40)
  const workflowDeCi = (passos: string[]): string =>
    [
      'name: ci',
      'on: push',
      '',
      'jobs:',
      '  build:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      `      - uses: actions/checkout@${SHA}`,
      ...passos.map((l) => `      ${l}`),
      '',
    ].join('\n')

  it.each([
    ['npm run deploy', workflowDeCi(['- run: npm run deploy'])],
    [
      'docker buildx build com --push na linha seguinte',
      workflowDeCi(['- run: |', '    docker buildx build \\', '      --push .']),
    ],
    [
      'action de imagem de terceiros com push: true',
      workflowDeCi([
        `- uses: crazy-max/ghaction-docker-buildx@${SHA}`,
        '  with:',
        '    push: true',
      ]),
    ],
    ['script externo go-live', workflowDeCi(['- run: ./scripts/go-live.sh'])],
  ])(
    'workflow com cara de CI mas que não se prova CI puro (%s): sem PR, INTOCADO, o dono é perguntado',
    async (_nome, texto) => {
      const github = repositorio('acme/api', { arquivos: { '.github/workflows/ci.yml': texto } })
      const c = cenario({ 'acme/api': github }, [projeto()])
      for (let i = 0; i < 12; i += 1) await c.passadaEAvanca()

      expect(github.pulls).toHaveLength(0)
      expect(github.arquivoNaPadrao('.github/workflows/ci.yml')).toBe(texto)
      expect(escritas(github).some((e) => e.includes('ci.yml'))).toBe(false)
      expect(c.perguntador.chamadas).toHaveLength(1)
      expect(c.perguntador.chamadas[0]!.input['dedupKey']).toBe(
        'seguranca-permissoes:acme/api:.github/workflows/ci.yml'
      )
    }
  )

  it('CI puro provado (instalar, lint, testar) continua recebendo o PR de permissão mínima, sem pergunta', async () => {
    const texto = workflowDeCi([
      `- uses: actions/setup-node@${SHA}`,
      '- run: pnpm install --frozen-lockfile',
      '- run: pnpm test',
    ])
    const github = repositorio('acme/api', { arquivos: { '.github/workflows/ci.yml': texto } })
    const c = cenario({ 'acme/api': github }, [projeto()])
    for (let i = 0; i < 6; i += 1) await c.passadaEAvanca()

    expect(github.pulls.some((p) => p.head.includes('ci-yml'))).toBe(true)
    expect(c.perguntador.chamadas).toEqual([])
  })

  it('não pergunta de novo se já há pergunta aberta (checagem antes do ask)', async () => {
    const github = repositorio('acme/api', {
      arquivos: { '.github/workflows/cd.yml': CD },
    })
    const c = cenario({ 'acme/api': github }, [projeto()])
    c.memoria.perguntas.push({
      id: 'q0',
      projectId: 'p1',
      userId: 'u1',
      text: 'antiga',
      options: [],
      dedupKey: 'seguranca-permissoes:acme/api:.github/workflows/cd.yml',
      status: 'open',
      answer: null,
    })
    for (let i = 0; i < 6; i += 1) await c.passadaEAvanca()
    expect(c.perguntador.chamadas).toEqual([])
  })

  it('o dono respondeu "pode aplicar": o deploy ganha o PR e, mesclado, a permissão padrão muda', async () => {
    const github = repositorio('acme/api', {
      arquivos: { '.github/workflows/cd.yml': CD },
    })
    const c = cenario({ 'acme/api': github }, [projeto()])
    for (let i = 0; i < 6; i += 1) await c.passadaEAvanca()
    expect(github.pulls).toHaveLength(0)
    const pergunta = c.memoria.perguntas[0]!
    pergunta.status = 'answered'
    pergunta.answer = 'permissoes-deploy-aplicar'
    for (let i = 0; i < 3; i += 1) await c.passadaEAvanca()
    expect(github.pulls).toHaveLength(1)
    github.mesclarPull(1)
    for (let i = 0; i < 4; i += 1) await c.passadaEAvanca()
    expect(github.arquivoNaPadrao('.github/workflows/cd.yml')).toContain(
      BLOCO_DE_PERMISSOES_MINIMAS
    )
    expect(github.config.permissaoDoWorkflow).toBe('read')
  })

  it('o dono respondeu "deixe como está": nada é escrito e a permissão padrão nunca muda', async () => {
    const github = repositorio('acme/api', {
      arquivos: { '.github/workflows/cd.yml': CD },
    })
    const c = cenario({ 'acme/api': github }, [projeto()])
    for (let i = 0; i < 3; i += 1) await c.passadaEAvanca()
    const pergunta = c.memoria.perguntas[0]!
    pergunta.status = 'answered'
    pergunta.answer = 'permissoes-deploy-manter'
    for (let i = 0; i < 8; i += 1) await c.passadaEAvanca()
    expect(github.pulls).toHaveLength(0)
    expect(github.config.permissaoDoWorkflow).toBe('write')
  })

  it('serviço de perguntas indisponível ou com falha: não derruba, não escreve no deploy, tenta de novo depois', async () => {
    const github = repositorio('acme/api', {
      arquivos: { '.github/workflows/cd.yml': CD },
    })
    const c = cenario({ 'acme/api': github }, [projeto()], { perguntadorFalha: true })
    for (let i = 0; i < 4; i += 1) await c.passadaEAvanca()
    expect(github.pulls).toHaveLength(0)
    expect(c.perguntador.chamadas.length).toBeGreaterThan(1)
    expect(c.avisos.join('\n')).toMatch(/pergunta/i)

    const semServico = cenario({ 'acme/api': github }, [projeto()], { comPerguntador: false })
    await semServico.passadaEAvanca()
    expect(github.pulls).toHaveLength(0)
  })

  it('um workflow que usa o token para escrever NÃO é editado: não se prova CI puro, o dono é perguntado e a permissão padrão não muda', async () => {
    const comToken = CI.replace('npm test', 'gh pr comment 1 --body oi')
    const github = repositorio('acme/api', {
      arquivos: { '.github/workflows/ci.yml': comToken },
    })
    const c = cenario({ 'acme/api': github }, [projeto()])
    for (let i = 0; i < 8; i += 1) await c.passadaEAvanca()
    expect(github.pulls).toHaveLength(0)
    expect(github.config.permissaoDoWorkflow).toBe('write')
    expect(escritas(github).some((e) => e.includes('ci.yml'))).toBe(false)
    expect(c.perguntador.chamadas).toHaveLength(1)
    expect(c.perguntador.chamadas[0]!.input['dedupKey']).toBe(
      'seguranca-permissoes:acme/api:.github/workflows/ci.yml'
    )
  })
})

describe('aplicador: credenciais (cliente primeiro, App depois) e segredos', () => {
  it('a escrita usa a credencial do cliente quando ela é admin; a do App nem é tentada', async () => {
    const github = repositorio('acme/api')
    const c = cenario({ 'acme/api': github }, [projeto()])
    await c.passada()
    const aut = new Set(github.registro.map((r) => r.autorizacao))
    expect(aut).toEqual(new Set([`Bearer ${TOKEN_DO_CLIENTE}`]))
  })

  it('quando só o App é admin, o App faz a leitura e a escrita; o cliente foi tentado antes', async () => {
    const github = repositorio('acme/api', { tokenDeAdmin: TOKEN_DO_APP })
    const c = cenario({ 'acme/api': github }, [projeto()])
    await c.passada()
    expect(github.registro[0]?.autorizacao).toBe(`Bearer ${TOKEN_DO_CLIENTE}`)
    const escrita = github.escritas()[0]!
    expect(escrita.autorizacao).toBe(`Bearer ${TOKEN_DO_APP}`)
  })

  // O autor do pull request é quem assina a escrita. Com a conta do dono, o
  // pull request nasceria "de participante" e o QA poderia julgá-lo e mesclá-lo.
  it('o pull request sai SEMPRE com o token do App (instalação), mesmo com a credencial do cliente administrando', async () => {
    const github = repositorio('acme/api', { privado: true, advancedSecurity: 'disabled' })
    const c = cenario({ 'acme/api': github }, [projeto()])
    for (let i = 0; i < 6; i += 1) await c.passadaEAvanca()
    const ramo = `${PREFIXO_DOS_RAMOS_DE_SEGURANCA}alternativa-de-varredura-de-senhas`
    expect(github.pulls.some((p) => p.head === ramo)).toBe(true)
    const doPr = github.escritas().filter((e) => /\/(git\/refs|contents\/|pulls)/.test(e.caminho))
    expect(doPr.length).toBeGreaterThanOrEqual(3)
    expect(new Set(doPr.map((e) => e.autorizacao))).toEqual(new Set([`Bearer ${TOKEN_DO_PR}`]))
    // a configuração por API segue com a credencial que provou administração
    const config = github.escritas().filter((e) => /vulnerability-alerts/.test(e.caminho))
    expect(new Set(config.map((e) => e.autorizacao))).toEqual(
      new Set([`Bearer ${TOKEN_DO_CLIENTE}`])
    )
    expect(github.pulls[0]?.autor.type).toBe('Bot')
  })

  it('sem o App no repositório: nenhum PR é aberto, o painel diz por quê, e a configuração por API segue', async () => {
    const github = repositorio('acme/api', { privado: true, advancedSecurity: 'disabled' })
    const c = cenario({ 'acme/api': github }, [projeto()], { semApp: true })
    for (let i = 0; i < 6; i += 1) await c.passadaEAvanca()
    expect(github.pulls).toEqual([])
    expect(github.escritas().some((e) => /\/(git\/refs|contents\/|pulls)/.test(e.caminho))).toBe(
      false
    )
    expect(github.config.alertasDeDependencias).toBe(true)
    const ficha = c.memoria.estadoDe('p1', 'melhorias') as {
      melhorias: Record<string, { estado: string; motivo: string }>
    }
    expect(ficha.melhorias['alternativa-de-varredura-de-senhas']).toMatchObject({
      estado: 'recusado',
    })
    expect(ficha.melhorias['alternativa-de-varredura-de-senhas']?.motivo).toContain('App')
  })

  it('a guarda de autonomia da saída de rede recusa no meio: vira "recusado" com o motivo, nunca "incerto"', async () => {
    const github = repositorio('acme/api')
    // as travas de cima passam (projeto em "cuidar"), a guarda lê outro nível na hora de escrever
    const c = cenario({ 'acme/api': github }, [projeto()], { nivelDaGuarda: 'sugerir' })
    const r = await c.passada()
    expect(r).toMatchObject({ melhoria: 'alertas-de-dependencias', estado: 'recusado' })
    expect(github.escritas()).toEqual([])
    const ficha = c.memoria.estadoDe('p1', 'melhorias') as {
      melhorias: Record<string, { estado: string; motivo: string }>
    }
    expect(ficha.melhorias['alertas-de-dependencias']?.estado).toBe('recusado')
    expect(ficha.melhorias['alertas-de-dependencias']?.motivo).toContain('autonomia')
  })

  it('NENHUM token aparece na ficha, nos eventos, nos logs nem nas perguntas (caminho feliz e de erro)', async () => {
    const github = repositorio('acme/api', {
      arquivos: { '.github/workflows/ci.yml': CI, '.github/workflows/cd.yml': CI },
      forcar: {
        'PUT /vulnerability-alerts': {
          status: 422,
          mensagem: `falhou com Authorization: Bearer ${TOKEN_DO_CLIENTE} e ${TOKEN_DO_APP}`,
        },
      },
    })
    const c = cenario({ 'acme/api': github }, [projeto()])
    for (let i = 0; i < 9; i += 1) await c.passadaEAvanca()
    const tudo = JSON.stringify([
      [...c.memoria.fichas.values()],
      c.memoria.eventos,
      c.memoria.perguntas,
      c.perguntador.chamadas,
      c.infos,
      c.avisos,
    ])
    expect(tudo).toContain('melhoria-de-seguranca:acme/api')
    expect(tudo).not.toContain(TOKEN_DO_CLIENTE)
    expect(tudo).not.toContain(TOKEN_DO_APP)
    expect(tudo).not.toContain(TOKEN_DO_PR)
    // controle positivo: o texto do erro do GitHub chegou ao painel (sem os tokens)
    expect(c.memoria.eventos.some((e) => /falhou com/.test(String(e.payload.texto)))).toBe(true)
  })

  it('o erro de rede da leitura sai sem a credencial no aviso', async () => {
    const github = repositorio('acme/api')
    const quebrado: typeof fetch = (async () => {
      throw new Error(`socket fechou: Authorization: Bearer ${TOKEN_DO_CLIENTE}`)
    }) as typeof fetch
    const c = cenario({ 'acme/api': github }, [projeto()], { fetchDeLeitura: quebrado })
    const r = await c.passada()
    expect(r.resultado).toBe('sem-sondagem')
    expect(c.avisos.join('\n')).not.toContain(TOKEN_DO_CLIENTE)
    expect(c.avisos.join('\n')).toMatch(/sondagem/)
  })
})

describe('aplicador: orçamento de tempo', () => {
  it('a passada que passa do orçamento é abandonada sem escrever nada', async () => {
    const github = repositorio('acme/api')
    const lento: typeof fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const t = setTimeout(() => resolve(github.fetchFalso(input, init)), 200)
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(t)
          reject(new Error('abortado'))
        })
      })) as typeof fetch
    const c = cenario({ 'acme/api': github }, [projeto()], { fetchDeLeitura: lento })
    const r = await c.passada({ orcamentoMs: 30 })
    expect(['abandonado', 'sem-sondagem']).toContain(r.resultado)
    expect(github.escritas()).toEqual([])
  })
})

describe('desfazer uma melhoria aplicada, pelo projeto', () => {
  it('restaura o estado anterior, marca "desfeito" e registra no painel', async () => {
    const github = repositorio('acme/api')
    const c = cenario({ 'acme/api': github }, [projeto()])
    await c.passadaEAvanca()
    expect(github.config.alertasDeDependencias).toBe(true)

    const ritmo = criarRitmoDeEscrita({ esperar: async () => {}, agora: () => c.agora() })
    const r = await desfazerMelhoriaDoProjeto({
      prisma: c.memoria.prisma,
      projeto: projeto(),
      melhoria: 'alertas-de-dependencias',
      credenciais: [{ origem: 'cliente ou dono', token: TOKEN_DO_CLIENTE }],
      tokenDoApp: TOKEN_DO_PR,
      fetchDeLeitura: github.fetchFalso,
      fetchDeEscrita: fetchDoRepositorio({ nivel: () => 'cuidar', fetchImpl: github.fetchFalso }),
      ritmo,
      agora: () => new Date(c.agora()),
    })
    expect(r.desfeito).toBe(true)
    expect(github.config.alertasDeDependencias).toBe(false)
    expect(c.memoria.chavesDeEventos()).toContain(
      'melhoria-de-seguranca:acme/api:alertas-de-dependencias:desfeito'
    )
    const ficha = c.memoria.estadoDe('p1', 'melhorias') as {
      melhorias: Record<string, { estado: string }>
    }
    expect(ficha.melhorias['alertas-de-dependencias']?.estado).toBe('desfeito')

    // e o aplicador NÃO a liga de novo: desfeito é decisão
    for (let i = 0; i < 3; i += 1) await c.passadaEAvanca()
    expect(github.config.alertasDeDependencias).toBe(false)
  })

  async function desfazerPr(tokenDoApp: string | null) {
    const github = repositorio('acme/api', { privado: true, advancedSecurity: 'disabled' })
    const c = cenario({ 'acme/api': github }, [projeto()])
    for (let i = 0; i < 6; i += 1) await c.passadaEAvanca()
    const ramo = `${PREFIXO_DOS_RAMOS_DE_SEGURANCA}alternativa-de-varredura-de-senhas`
    expect(github.pulls.some((p) => p.head === ramo)).toBe(true)
    github.registro.length = 0
    const ritmo = criarRitmoDeEscrita({ esperar: async () => {}, agora: () => c.agora() })
    const r = await desfazerMelhoriaDoProjeto({
      prisma: c.memoria.prisma,
      projeto: projeto(),
      melhoria: 'alternativa-de-varredura-de-senhas',
      credenciais: [{ origem: 'cliente ou dono', token: TOKEN_DO_CLIENTE }],
      tokenDoApp,
      fetchDeLeitura: github.fetchFalso,
      fetchDeEscrita: fetchDoRepositorio({ nivel: () => 'cuidar', fetchImpl: github.fetchFalso }),
      ritmo,
      agora: () => new Date(c.agora()),
    })
    return { r, github }
  }

  it('desfazer um PR aberto fecha e apaga o ramo com o token do App', async () => {
    const { r, github } = await desfazerPr(TOKEN_DO_PR)
    expect(r.desfeito).toBe(true)
    expect(
      github.pulls.find((p) => p.head.endsWith('alternativa-de-varredura-de-senhas'))?.state
    ).toBe('closed')
    expect(github.escritas()).toHaveLength(2)
    expect(new Set(github.escritas().map((e) => e.autorizacao))).toEqual(
      new Set([`Bearer ${TOKEN_DO_PR}`])
    )
  })

  it('sem o token do App, o PR não é fechado por ninguém mais (nem pela credencial do dono)', async () => {
    const { r, github } = await desfazerPr(null)
    expect(r.desfeito).toBe(false)
    expect(github.escritas()).toEqual([])
    expect(github.pulls.every((p) => p.state === 'open')).toBe(true)
  })

  it('melhoria que nunca foi aplicada: não escreve nada', async () => {
    const github = repositorio('acme/api')
    const c = cenario({ 'acme/api': github }, [projeto()])
    const ritmo = criarRitmoDeEscrita({ esperar: async () => {}, agora: () => c.agora() })
    const r = await desfazerMelhoriaDoProjeto({
      prisma: c.memoria.prisma,
      projeto: projeto(),
      melhoria: 'alertas-de-dependencias',
      credenciais: [{ origem: 'cliente ou dono', token: TOKEN_DO_CLIENTE }],
      tokenDoApp: TOKEN_DO_PR,
      fetchDeLeitura: github.fetchFalso,
      fetchDeEscrita: fetchDoRepositorio({ nivel: () => 'cuidar', fetchImpl: github.fetchFalso }),
      ritmo,
      agora: () => new Date(c.agora()),
    })
    expect(r.desfeito).toBe(false)
    expect(github.escritas()).toEqual([])
  })
})

describe('ficha de melhorias vinda do banco', () => {
  const registro = {
    estado: 'aplicado',
    atualizadoEm: '2026-03-10T12:00:00.000Z',
    proximaTentativaEm: null,
    tentativas: 1,
    motivo: 'x',
    desfazer: 'Como desfazer: ...',
  }
  it('descarta registro de melhoria fora da lista branca, de estado desconhecido ou com PR forjado', () => {
    const ficha = lerFichaDeMelhorias({
      proximaPassadaEm: '2026-03-10T12:30:00.000Z',
      melhorias: {
        'alertas-de-dependencias': registro,
        'proteger-a-branch': registro,
        __proto__: registro,
        'varredura-de-codigo': { ...registro, estado: 'talvez' },
        'alternativa-de-varredura-de-senhas': {
          ...registro,
          pr: { numero: 1, ramo: 'main', caminho: '../../x', acao: 'criar', url: null },
        },
        'permissoes-minimas-dos-workflows:src/index.ts': registro,
      },
    })
    expect(Object.keys(ficha.melhorias)).toEqual(['alertas-de-dependencias'])
    expect(ficha.proximaPassadaEm).toBe('2026-03-10T12:30:00.000Z')
  })
  it('lixo vira ficha vazia', () => {
    expect(lerFichaDeMelhorias(null)).toEqual({ proximaPassadaEm: null, melhorias: {} })
    expect(lerFichaDeMelhorias('texto')).toEqual({ proximaPassadaEm: null, melhorias: {} })
    expect(lerFichaDeMelhorias({ proximaPassadaEm: 'ontem', melhorias: 3 })).toEqual({
      proximaPassadaEm: null,
      melhorias: {},
    })
  })
})
