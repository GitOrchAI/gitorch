import { describe, expect, it } from 'vitest'
import {
  acompanharPrDeSeguranca,
  classificarRespostaDeEscrita,
  comoDesfazerDaMelhoria,
  ehRegistroDoPr,
  conferirConfiguracaoAplicada,
  desfazerMelhoriaDeSeguranca,
  executarAlternativaDeSenhas,
  executarMelhoriaDeConfiguracao,
  executarPermissoesMinimas,
  type ContextoDeExecucao,
  type RegistroDaMelhoria,
} from './executores-de-seguranca.js'
import {
  criarEscritorDeSeguranca,
  criarRitmoDeEscrita,
  PREFIXO_DOS_RAMOS_DE_SEGURANCA,
} from './escritor-de-seguranca.js'
import { ehPrDeSeguranca, MARCA_DO_PR_DE_SEGURANCA } from './pr-de-seguranca.js'
import { criarLeitorDeSeguranca } from './leitor-de-seguranca.js'
import { sondarRepositorio } from './sondagem-de-seguranca.js'
import {
  CAMINHO_DO_WORKFLOW_DE_SENHAS,
  workflowDeAlternativaGratuita,
} from './alternativa-gratuita-de-seguranca.js'
import { analisarWorkflow, BLOCO_DE_PERMISSOES_MINIMAS } from './workflows-de-seguranca.js'
import {
  GitHubDeMelhoriasFalso,
  type ConfiguracaoDoRepositorioFalso,
} from '../test/github-de-melhorias-fake.js'

const REPO = 'acme/api'
const TOKEN = 'ghp_segredo_dos_executores_00000000'
const TOKEN_DO_APP = 'ghs_segredo_do_app_dos_executores_0000'
const AGORA = new Date('2026-03-10T12:00:00.000Z')

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

function repositorio(extra: ConfiguracaoDoRepositorioFalso = {}) {
  return new GitHubDeMelhoriasFalso(REPO, {
    privado: false,
    segredos: 'disabled',
    bloqueioDePush: 'disabled',
    alertasDeDependencias: false,
    atualizacoesDeSeguranca: false,
    varreduraDeCodigo: 'not-configured',
    linguagens: { TypeScript: 100 },
    permissaoDoWorkflow: 'write',
    podeAprovarPrs: true,
    arquivos: { '.github/workflows/ci.yml': CI },
    ...extra,
  })
}

async function contexto(
  github: GitHubDeMelhoriasFalso,
  tokenDoApp: string | null = TOKEN_DO_APP
): Promise<ContextoDeExecucao> {
  let t = 5_000_000
  github.usarRelogio(() => t)
  const ritmo = criarRitmoDeEscrita({
    esperar: async (ms) => {
      t += ms
    },
    agora: () => t,
  })
  const sondagem = await sondarRepositorio({
    repositorio: REPO,
    credencial: { origem: 'cliente ou dono', token: TOKEN },
    fetchImpl: github.fetchFalso,
    agora: AGORA,
  })
  github.registro.length = 0
  return {
    repositorio: REPO,
    token: TOKEN,
    tokenDoApp,
    escritor: criarEscritorDeSeguranca({ repositorio: REPO, fetchImpl: github.fetchFalso, ritmo }),
    ler: criarLeitorDeSeguranca({ repositorio: REPO, token: TOKEN, fetchImpl: github.fetchFalso }),
    sondagem,
    agora: AGORA,
  }
}

const registroDoPrAberto = (
  r: { pr?: RegistroDaMelhoria['pr'] },
  id: string
): RegistroDaMelhoria => ({
  estado: 'aguardando-revisao',
  atualizadoEm: AGORA.toISOString(),
  proximaTentativaEm: null,
  tentativas: 1,
  motivo: 'PR aberto',
  ...(r.pr ? { pr: r.pr } : {}),
  desfazer: comoDesfazerDaMelhoria(id, REPO),
})

const rotas = (github: GitHubDeMelhoriasFalso) =>
  github.registro.map((r) => `${r.metodo} ${r.caminho.split('?')[0]}`)

describe('classificarRespostaDeEscrita', () => {
  const r = (status: number, mensagem: string | null, limitada = false) => ({
    ok: status >= 200 && status < 300,
    status,
    corpo: null,
    mensagem,
    limitada,
  })
  it.each([
    [r(204, null), 'ok'],
    [r(200, null), 'ok'],
    [r(202, null), 'ok'],
    [
      r(403, 'Upgrade to GitHub Pro or make this repository public to enable this feature.'),
      'indisponivel',
    ],
    [
      r(403, 'Advanced Security must be enabled for this repository to use code scanning.'),
      'indisponivel',
    ],
    [
      r(422, 'Advanced security must be enabled for this repository to use secret scanning.'),
      'indisponivel',
    ],
    [r(403, 'Resource not accessible by integration'), 'recusado'],
    [r(404, 'Not Found'), 'recusado'],
    [r(409, 'Conflict'), 'recusado'],
    [r(422, 'Validation Failed'), 'recusado'],
    [r(401, 'Bad credentials'), 'recusado'],
    [r(403, 'API rate limit exceeded', true), 'cota'],
    [r(429, 'slow down', true), 'cota'],
    [r(500, 'boom'), 'falhou'],
    [r(502, null), 'falhou'],
  ])('%j => %s', (resposta, esperado) => {
    expect(classificarRespostaDeEscrita(resposta)).toBe(esperado)
  })
})

describe('melhorias de configuração (uma chamada exata, releitura antes, confirmação depois)', () => {
  it('alertas de dependências: lê, liga com PUT, confirma com GET e guarda o estado anterior', async () => {
    const github = repositorio()
    const ctx = await contexto(github)
    const resultado = await executarMelhoriaDeConfiguracao('alertas-de-dependencias', ctx)
    expect(rotas(github)).toEqual([
      `GET /repos/${REPO}/vulnerability-alerts`,
      `PUT /repos/${REPO}/vulnerability-alerts`,
      `GET /repos/${REPO}/vulnerability-alerts`,
    ])
    expect(resultado).toMatchObject({ estado: 'aplicado', anterior: { alertas: 'desligado' } })
    expect(github.config.alertasDeDependencias).toBe(true)
    expect(github.escritas()).toHaveLength(1)
  })

  it('atualizações de segurança: PUT em automated-security-fixes, confirmado pelo GET', async () => {
    const github = repositorio({ alertasDeDependencias: true })
    const ctx = await contexto(github)
    const resultado = await executarMelhoriaDeConfiguracao('atualizacoes-de-seguranca', ctx)
    expect(rotas(github)).toEqual([
      `GET /repos/${REPO}/automated-security-fixes`,
      `PUT /repos/${REPO}/automated-security-fixes`,
      `GET /repos/${REPO}/automated-security-fixes`,
    ])
    expect(resultado).toMatchObject({ estado: 'aplicado', anterior: { atualizacoes: 'desligado' } })
    expect(github.config.atualizacoesDeSeguranca).toBe(true)
  })

  it('senhas vazadas: um PATCH com os DOIS campos, confirmado; guarda o que estava antes', async () => {
    const github = repositorio()
    const ctx = await contexto(github)
    const resultado = await executarMelhoriaDeConfiguracao('varredura-de-senhas', ctx)
    const escritas = github.escritas()
    expect(escritas).toHaveLength(1)
    expect(escritas[0]).toMatchObject({
      metodo: 'PATCH',
      caminho: `/repos/${REPO}`,
      corpo: {
        security_and_analysis: {
          secret_scanning: { status: 'enabled' },
          secret_scanning_push_protection: { status: 'enabled' },
        },
      },
    })
    expect(resultado).toMatchObject({
      estado: 'aplicado',
      anterior: { segredos: 'disabled', bloqueioDePush: 'disabled' },
    })
    expect(github.config.segredos).toBe('enabled')
    expect(github.config.bloqueioDePush).toBe('enabled')
  })

  it('senhas vazadas: se só o bloqueio de push estava desligado, só ele é enviado', async () => {
    const github = repositorio({ segredos: 'enabled' })
    const ctx = await contexto(github)
    const resultado = await executarMelhoriaDeConfiguracao('varredura-de-senhas', ctx)
    expect(github.escritas()[0]?.corpo).toEqual({
      security_and_analysis: { secret_scanning_push_protection: { status: 'enabled' } },
    })
    expect(resultado.anterior).toEqual({ bloqueioDePush: 'disabled' })
  })

  it('varredura de código: PATCH default-setup configured, confirmado', async () => {
    const github = repositorio()
    const ctx = await contexto(github)
    const resultado = await executarMelhoriaDeConfiguracao('varredura-de-codigo', ctx)
    expect(github.escritas()).toHaveLength(1)
    expect(github.escritas()[0]).toMatchObject({
      metodo: 'PATCH',
      caminho: `/repos/${REPO}/code-scanning/default-setup`,
      corpo: { state: 'configured', query_suite: 'default' },
    })
    expect(resultado).toMatchObject({ estado: 'aplicado', anterior: { codigo: 'not-configured' } })
    expect(github.config.varreduraDeCodigo).toBe('configured')
  })

  it('permissão padrão do token: PUT read, preservando "pode aprovar PR"; guarda os valores de antes', async () => {
    const github = repositorio({ podeAprovarPrs: true })
    const ctx = await contexto(github)
    const resultado = await executarMelhoriaDeConfiguracao('permissao-padrao-do-workflow', ctx)
    expect(github.escritas()).toHaveLength(1)
    expect(github.escritas()[0]).toMatchObject({
      metodo: 'PUT',
      caminho: `/repos/${REPO}/actions/permissions/workflow`,
      corpo: { default_workflow_permissions: 'read', can_approve_pull_request_reviews: true },
    })
    expect(resultado).toMatchObject({
      estado: 'aplicado',
      anterior: { permissao: 'write', podeAprovarPrs: true },
    })
    expect(github.config.permissaoDoWorkflow).toBe('read')
  })

  it('o estado já mudou desde a sondagem (alguém ligou antes): NÃO escreve e não vira "aplicado"', async () => {
    const github = repositorio()
    const ctx = await contexto(github)
    github.config.alertasDeDependencias = true
    const resultado = await executarMelhoriaDeConfiguracao('alertas-de-dependencias', ctx)
    expect(github.escritas()).toEqual([])
    expect(resultado.estado).toBe('dispensado')
    expect(resultado.motivo).toMatch(/já estava/)
    expect(resultado.anterior).toBeUndefined()
  })

  it('a releitura antes da escrita falha: não escreve, "falhou"', async () => {
    const github = repositorio()
    const ctx = await contexto(github)
    github.config.forcar = { 'GET /vulnerability-alerts': { status: 500, mensagem: 'boom' } }
    const resultado = await executarMelhoriaDeConfiguracao('alertas-de-dependencias', ctx)
    expect(github.escritas()).toEqual([])
    expect(resultado.estado).toBe('falhou')
  })

  it('plano grátis (403 "Upgrade"): "indisponível", com o motivo do GitHub', async () => {
    const github = repositorio({
      forcar: {
        'PUT /vulnerability-alerts': {
          status: 403,
          mensagem: 'Upgrade to GitHub Pro or make this repository public to enable this feature.',
        },
      },
    })
    const ctx = await contexto(github)
    const resultado = await executarMelhoriaDeConfiguracao('alertas-de-dependencias', ctx)
    expect(resultado.estado).toBe('indisponivel')
    expect(resultado.motivo).toContain('Upgrade to GitHub Pro')
    expect(github.config.alertasDeDependencias).toBe(false)
  })

  it('sem permissão (403 de integração): "recusado", nunca "aplicado"', async () => {
    const github = repositorio({
      forcar: {
        'PUT /vulnerability-alerts': {
          status: 403,
          mensagem: 'Resource not accessible by integration',
        },
      },
    })
    const ctx = await contexto(github)
    const resultado = await executarMelhoriaDeConfiguracao('alertas-de-dependencias', ctx)
    expect(resultado.estado).toBe('recusado')
  })

  it('limite de taxa: "falhou" com espera, e não "recusado"', async () => {
    const github = repositorio({
      forcar: {
        'PUT /vulnerability-alerts': {
          status: 403,
          mensagem: 'API rate limit exceeded',
          cabecalhos: { 'x-ratelimit-remaining': '0', 'retry-after': '60' },
        },
      },
    })
    const ctx = await contexto(github)
    const resultado = await executarMelhoriaDeConfiguracao('alertas-de-dependencias', ctx)
    expect(resultado.estado).toBe('falhou')
    expect(resultado.limitada).toBe(true)
  })

  it('a escrita deu 2xx mas a confirmação não bate: "incerto" (nunca "aplicado" por engano)', async () => {
    const github = repositorio()
    const ctx = await contexto(github)
    // o GET de confirmação passa a dizer que continua desligado
    let gets = 0
    const original = github.atender.bind(github)
    github.atender = (metodo, caminho, corpo, aut) => {
      if (metodo === 'GET' && caminho.endsWith('/vulnerability-alerts')) {
        gets += 1
        if (gets >= 2) {
          return { status: 404, corpo: { message: 'Vulnerability alerts are disabled.' } }
        }
      }
      return original(metodo, caminho, corpo, aut)
    }
    const resultado = await executarMelhoriaDeConfiguracao('alertas-de-dependencias', ctx)
    expect(resultado.estado).toBe('incerto')
    expect(resultado.anterior).toEqual({ alertas: 'desligado' })
  })

  it('senhas vazadas sem poder ler security_and_analysis na confirmação: "incerto"', async () => {
    const github = repositorio({ tokenDeAdmin: TOKEN })
    const ctx = await contexto(github)
    // na confirmação a credencial deixa de ver o campo
    let leituras = 0
    const original = github.atender.bind(github)
    github.atender = (metodo, caminho, corpo, aut) => {
      if (metodo === 'GET' && caminho === `/repos/${REPO}`) {
        leituras += 1
        if (leituras >= 2) return { status: 200, corpo: { full_name: REPO, private: false } }
      }
      return original(metodo, caminho, corpo, aut)
    }
    const resultado = await executarMelhoriaDeConfiguracao('varredura-de-senhas', ctx)
    expect(resultado.estado).toBe('incerto')
  })

  it('rede cai no meio da escrita: "falhou" com a mensagem sem a credencial', async () => {
    const github = repositorio()
    const ctx = await contexto(github)
    const original = github.fetchFalso
    const quebrado: typeof fetch = (async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit
    ) => {
      if ((init?.method ?? 'GET') === 'PUT') throw new Error(`socket fechou com ${TOKEN}`)
      return original(input, init)
    }) as typeof fetch
    const ritmo = criarRitmoDeEscrita({ esperar: async () => {}, agora: () => 0 })
    const resultado = await executarMelhoriaDeConfiguracao('alertas-de-dependencias', {
      ...ctx,
      escritor: criarEscritorDeSeguranca({ repositorio: REPO, fetchImpl: quebrado, ritmo }),
    })
    expect(resultado.estado).toBe('incerto')
    expect(resultado.motivo).not.toContain(TOKEN)
  })

  it('conferirConfiguracaoAplicada (depois de um "incerto"): se o GET agora bate, vira "aplicado" sem escrever', async () => {
    const github = repositorio({ alertasDeDependencias: true })
    const ctx = await contexto(github)
    const r = await conferirConfiguracaoAplicada('alertas-de-dependencias', ctx)
    expect(r).toMatchObject({ estado: 'aplicado' })
    expect(github.escritas()).toEqual([])
    const github2 = repositorio()
    const r2 = await conferirConfiguracaoAplicada(
      'alertas-de-dependencias',
      await contexto(github2)
    )
    // a leitura funcionou e mostra que NÃO está ligado: a escrita não valeu, pode tentar de novo
    expect(r2.estado).toBe('falhou')
    expect(github2.escritas()).toEqual([])
  })
})

describe('desfazer a configuração restaura o estado anterior', () => {
  const registroDe = (id: string, resultado: { anterior?: unknown }): RegistroDaMelhoria => ({
    estado: 'aplicado',
    atualizadoEm: AGORA.toISOString(),
    proximaTentativaEm: null,
    tentativas: 1,
    motivo: 'aplicado',
    ...(resultado.anterior !== undefined ? { anterior: resultado.anterior } : {}),
    desfazer: comoDesfazerDaMelhoria(id, REPO),
  })

  it('alertas', async () => {
    const github = repositorio()
    const ctx = await contexto(github)
    const feito = await executarMelhoriaDeConfiguracao('alertas-de-dependencias', ctx)
    const r = await desfazerMelhoriaDeSeguranca(
      'alertas-de-dependencias',
      registroDe('alertas-de-dependencias', feito),
      ctx
    )
    expect(r.desfeito).toBe(true)
    expect(github.config.alertasDeDependencias).toBe(false)
  })

  it('atualizações', async () => {
    const github = repositorio({ alertasDeDependencias: true })
    const ctx = await contexto(github)
    const feito = await executarMelhoriaDeConfiguracao('atualizacoes-de-seguranca', ctx)
    const r = await desfazerMelhoriaDeSeguranca(
      'atualizacoes-de-seguranca',
      registroDe('atualizacoes-de-seguranca', feito),
      ctx
    )
    expect(r.desfeito).toBe(true)
    expect(github.config.atualizacoesDeSeguranca).toBe(false)
    expect(github.config.alertasDeDependencias).toBe(true)
  })

  it('senhas vazadas: volta SÓ o que o GitOrch tinha ligado', async () => {
    const github = repositorio({ segredos: 'enabled', bloqueioDePush: 'disabled' })
    const ctx = await contexto(github)
    const feito = await executarMelhoriaDeConfiguracao('varredura-de-senhas', ctx)
    expect(github.config.bloqueioDePush).toBe('enabled')
    const r = await desfazerMelhoriaDeSeguranca(
      'varredura-de-senhas',
      registroDe('varredura-de-senhas', feito),
      ctx
    )
    expect(r.desfeito).toBe(true)
    expect(github.config.bloqueioDePush).toBe('disabled')
    // a varredura de senhas já estava ligada antes: o desfazer NÃO a desliga
    expect(github.config.segredos).toBe('enabled')
  })

  it('código', async () => {
    const github = repositorio()
    const ctx = await contexto(github)
    const feito = await executarMelhoriaDeConfiguracao('varredura-de-codigo', ctx)
    const r = await desfazerMelhoriaDeSeguranca(
      'varredura-de-codigo',
      registroDe('varredura-de-codigo', feito),
      ctx
    )
    expect(r.desfeito).toBe(true)
    expect(github.config.varreduraDeCodigo).toBe('not-configured')
  })

  it('permissão padrão do workflow: volta para os DOIS valores de antes', async () => {
    const github = repositorio({ permissaoDoWorkflow: 'write', podeAprovarPrs: true })
    const ctx = await contexto(github)
    const feito = await executarMelhoriaDeConfiguracao('permissao-padrao-do-workflow', ctx)
    expect(github.config.permissaoDoWorkflow).toBe('read')
    const r = await desfazerMelhoriaDeSeguranca(
      'permissao-padrao-do-workflow',
      registroDe('permissao-padrao-do-workflow', feito),
      ctx
    )
    expect(r.desfeito).toBe(true)
    expect(github.config.permissaoDoWorkflow).toBe('write')
    expect(github.config.podeAprovarPrs).toBe(true)
  })

  it('sem o valor anterior guardado, não adivinha: não desfaz', async () => {
    const github = repositorio({ permissaoDoWorkflow: 'read' })
    const ctx = await contexto(github)
    const r = await desfazerMelhoriaDeSeguranca(
      'permissao-padrao-do-workflow',
      registroDe('permissao-padrao-do-workflow', {}),
      ctx
    )
    expect(r.desfeito).toBe(false)
    expect(github.escritas()).toEqual([])
  })

  it('só desfaz o que está "aplicado": outro estado não vira escrita', async () => {
    const github = repositorio()
    const ctx = await contexto(github)
    const registro = {
      ...registroDe('alertas-de-dependencias', { anterior: { alertas: 'desligado' } }),
      estado: 'recusado' as const,
    }
    const r = await desfazerMelhoriaDeSeguranca('alertas-de-dependencias', registro, ctx)
    expect(r.desfeito).toBe(false)
    expect(github.escritas()).toEqual([])
  })

  // O texto vai para o painel e para o dono, que não tem rota nem tela para
  // chamar uma função interna: o passo precisa ser algo que uma pessoa faça.
  it('o texto de "como desfazer" é um passo que uma pessoa consegue seguir, sem mandar chamar função interna', () => {
    for (const id of [
      'alertas-de-dependencias',
      'atualizacoes-de-seguranca',
      'varredura-de-senhas',
      'varredura-de-codigo',
      'permissao-padrao-do-workflow',
      'alternativa-de-varredura-de-senhas',
      'permissoes-minimas-dos-workflows:.github/workflows/ci.yml',
    ]) {
      const texto = comoDesfazerDaMelhoria(id, REPO)
      expect(texto).toMatch(/Como desfazer/)
      expect(texto).toContain(REPO)
      // desligar tudo de uma vez
      expect(texto).toContain('GITORCH_APLICAR_SEGURANCA=0')
      // a função da equipe é citada como tal, nunca como "chame isto"
      expect(texto).toContain('desfazerMelhoriaDoProjeto')
      expect(texto).not.toMatch(/chame\s+desfazerMelhoriaDeSeguranca/i)
      expect(texto).not.toContain('desfazerMelhoriaDeSeguranca(')
    }
  })

  it.each([
    ['alertas-de-dependencias', /Configurações[^]*Dependabot alerts/],
    ['atualizacoes-de-seguranca', /Configurações[^]*Dependabot security updates/],
    ['varredura-de-senhas', /Configurações[^]*Secret scanning[^]*Push protection/],
    ['varredura-de-codigo', /Configurações[^]*Code scanning/],
    ['permissao-padrao-do-workflow', /Configurações[^]*Workflow permissions/],
  ])('"%s": o passo manual equivalente no GitHub está escrito', (id, esperado) => {
    expect(comoDesfazerDaMelhoria(id, REPO)).toMatch(esperado)
  })

  it.each([
    'alternativa-de-varredura-de-senhas',
    'permissoes-minimas-dos-workflows:.github/workflows/ci.yml',
  ])('"%s": se o PR está aberto, fechar e apagar o ramo; se já foi mesclado, reverter', (id) => {
    const texto = comoDesfazerDaMelhoria(id, REPO)
    expect(texto).toMatch(/feche/i)
    expect(texto).toMatch(/apague o ramo/i)
    expect(texto).toMatch(/reverta/i)
  })
})

describe('mudança em arquivo SEMPRE por PR: alternativa gratuita de varredura de senhas', () => {
  const privadoGratis = () =>
    repositorio({
      privado: true,
      advancedSecurity: 'disabled',
      arquivos: { '.github/workflows/ci.yml': CI },
    })

  it('cria o ramo próprio, grava só o arquivo novo nele e abre o PR; a branch padrão não é tocada', async () => {
    const github = privadoGratis()
    const ctx = await contexto(github)
    const resultado = await executarAlternativaDeSenhas(ctx)
    const ramo = `${PREFIXO_DOS_RAMOS_DE_SEGURANCA}alternativa-de-varredura-de-senhas`

    expect(github.escritas().map((e) => `${e.metodo} ${e.caminho}`)).toEqual([
      `POST /repos/${REPO}/git/refs`,
      `PUT /repos/${REPO}/contents/${CAMINHO_DO_WORKFLOW_DE_SENHAS}`,
      `POST /repos/${REPO}/pulls`,
    ])
    // o único ref escrito é o ramo novo
    expect(github.escritas()[0]?.corpo).toMatchObject({ ref: `refs/heads/${ramo}` })
    expect(github.escritas()[1]?.corpo).toMatchObject({ branch: ramo })
    // a branch padrão ficou intacta
    expect(github.arquivoNaPadrao(CAMINHO_DO_WORKFLOW_DE_SENHAS)).toBeUndefined()
    expect(github.arquivoNoRamo(ramo, CAMINHO_DO_WORKFLOW_DE_SENHAS)).toBe(
      workflowDeAlternativaGratuita()
    )
    // o PR aberto, em português, diz o que muda, por quê e como reverter
    expect(github.pulls).toHaveLength(1)
    const pull = github.pulls[0]!
    expect(pull).toMatchObject({ state: 'open', head: ramo, base: 'main' })
    expect(pull.body).toMatch(/O que muda/)
    expect(pull.body).toMatch(/Por que/)
    expect(pull.body).toMatch(/Como reverter/)
    expect(pull.body).toContain(CAMINHO_DO_WORKFLOW_DE_SENHAS)
    expect(resultado).toMatchObject({
      estado: 'aguardando-revisao',
      pr: { numero: 1, ramo, caminho: CAMINHO_DO_WORKFLOW_DE_SENHAS, acao: 'criar' },
    })
  })

  it('nome de branch padrão com caractere especial vira caminho codificado e o fluxo fecha', async () => {
    const github = repositorio({
      privado: true,
      advancedSecurity: 'disabled',
      branchPadrao: 'feature/a#b',
    })
    const ctx = await contexto(github)
    const resultado = await executarAlternativaDeSenhas(ctx)
    expect(resultado.estado).toBe('aguardando-revisao')
    expect(
      github.registro.some((r) =>
        r.caminho.startsWith('/repos/acme/api/git/ref/heads/feature/a%23b')
      )
    ).toBe(true)
    expect(github.pulls[0]).toMatchObject({ base: 'feature/a#b' })
  })

  it('NENHUMA escrita fora do ramo novo: nem commit direto, nem outro ref', async () => {
    const github = privadoGratis()
    const ctx = await contexto(github)
    await executarAlternativaDeSenhas(ctx)
    for (const e of github.escritas()) {
      const corpo = e.corpo as { branch?: string; ref?: string; head?: string } | null
      if (e.caminho.includes('/contents/')) {
        expect(corpo?.branch).toMatch(new RegExp(`^${PREFIXO_DOS_RAMOS_DE_SEGURANCA}`))
      }
      if (e.caminho.endsWith('/git/refs')) {
        expect(corpo?.ref).toMatch(new RegExp(`^refs/heads/${PREFIXO_DOS_RAMOS_DE_SEGURANCA}`))
      }
    }
  })

  it('reentrante: a segunda vez não escreve nada, só acha o PR aberto', async () => {
    const github = privadoGratis()
    const ctx = await contexto(github)
    await executarAlternativaDeSenhas(ctx)
    github.registro.length = 0
    const segunda = await executarAlternativaDeSenhas(ctx)
    expect(github.escritas()).toEqual([])
    expect(segunda).toMatchObject({ estado: 'aguardando-revisao', pr: { numero: 1 } })
    expect(github.pulls).toHaveLength(1)
  })

  it('retoma de onde parou: ramo criado e arquivo gravado, falta só o PR', async () => {
    const github = privadoGratis()
    const ctx = await contexto(github)
    // primeira tentativa morre depois de gravar o arquivo
    github.config.forcar = { 'POST /pulls': { status: 500, mensagem: 'boom' } }
    const primeira = await executarAlternativaDeSenhas(ctx)
    expect(primeira.estado).toBe('falhou')
    expect(github.pulls).toHaveLength(0)
    github.config.forcar = {}
    github.registro.length = 0
    const segunda = await executarAlternativaDeSenhas(ctx)
    expect(segunda.estado).toBe('aguardando-revisao')
    expect(github.escritas().map((e) => `${e.metodo} ${e.caminho}`)).toEqual([
      `POST /repos/${REPO}/pulls`,
    ])
  })

  it('PR já mesclado: confirma "aplicado" sem escrever', async () => {
    const github = privadoGratis()
    const ctx = await contexto(github)
    await executarAlternativaDeSenhas(ctx)
    github.mesclarPull(1)
    github.registro.length = 0
    const r = await executarAlternativaDeSenhas(ctx)
    expect(r.estado).toBe('aplicado')
    expect(github.escritas()).toEqual([])
  })

  it('PR fechado sem mesclar: o dono disse não; "dispensado", e não reabre', async () => {
    const github = privadoGratis()
    const ctx = await contexto(github)
    await executarAlternativaDeSenhas(ctx)
    github.fecharPullSemMesclar(1)
    github.registro.length = 0
    const r = await executarAlternativaDeSenhas(ctx)
    expect(r.estado).toBe('dispensado')
    expect(github.escritas()).toEqual([])
  })

  it('o arquivo já existe na branch padrão: não abre PR', async () => {
    const github = repositorio({
      privado: true,
      advancedSecurity: 'disabled',
      arquivos: {
        '.github/workflows/ci.yml': CI,
        [CAMINHO_DO_WORKFLOW_DE_SENHAS]: 'name: x\njobs: {}\n',
      },
    })
    const ctx = await contexto(github)
    const r = await executarAlternativaDeSenhas(ctx)
    expect(r.estado).toBe('dispensado')
    expect(github.escritas()).toEqual([])
  })

  it('falha ao criar o ramo: nada mais é escrito', async () => {
    const github = privadoGratis()
    github.config.forcar = {
      'POST /git/refs': { status: 403, mensagem: 'Resource not accessible by integration' },
    }
    const ctx = await contexto(github)
    const r = await executarAlternativaDeSenhas(ctx)
    expect(r.estado).toBe('recusado')
    expect(github.escritas()).toHaveLength(1)
    expect(github.pulls).toHaveLength(0)
  })
})

describe('ehRegistroDoPr: o que vem do banco não é confiado', () => {
  const bom = {
    numero: 3,
    ramo: `${PREFIXO_DOS_RAMOS_DE_SEGURANCA}permissoes-ci-yml`,
    caminho: '.github/workflows/ci.yml',
    acao: 'editar',
    url: 'https://github.com/acme/api/pull/3',
  }
  it('aceita o que o GitOrch grava', () => {
    expect(ehRegistroDoPr(bom)).toBe(true)
    expect(ehRegistroDoPr({ ...bom, url: null })).toBe(true)
  })
  it.each([
    ['número zero', { ...bom, numero: 0 }],
    ['número quebrado', { ...bom, numero: 1.5 }],
    ['ramo de fora', { ...bom, ramo: 'main' }],
    ['ramo com ..', { ...bom, ramo: `${PREFIXO_DOS_RAMOS_DE_SEGURANCA}..` }],
    ['caminho fora dos workflows', { ...bom, caminho: 'src/index.ts' }],
    ['caminho com ..', { ...bom, caminho: '.github/workflows/../../x.yml' }],
    ['ação desconhecida', { ...bom, acao: 'mesclar' }],
    ['url que não é https', { ...bom, url: 'javascript:alert(1)' }],
    ['lixo', 'texto'],
    ['nulo', null],
  ])('recusa %s', (_n, v) => {
    expect(ehRegistroDoPr(v)).toBe(false)
  })
})

describe('mudança em arquivo SEMPRE por PR: permissões mínimas de um workflow', () => {
  const caminho = '.github/workflows/ci.yml'
  const workflowDe = (ctx: ContextoDeExecucao) => {
    const w = ctx.sondagem.workflows.itens.find((i) => i.caminho === caminho)
    if (!w) throw new Error('workflow não sondado')
    return w
  }

  it('abre PR com o bloco de permissões mínimas; a branch padrão continua igual', async () => {
    const github = repositorio()
    const ctx = await contexto(github)
    const resultado = await executarPermissoesMinimas(ctx, workflowDe(ctx))
    const ramo = `${PREFIXO_DOS_RAMOS_DE_SEGURANCA}permissoes-ci-yml`
    expect(github.arquivoNaPadrao(caminho)).toBe(CI)
    const novo = github.arquivoNoRamo(ramo, caminho)!
    expect(novo).toContain(BLOCO_DE_PERMISSOES_MINIMAS)
    expect(analisarWorkflow(caminho, novo).declaraPermissoes).toBe(true)
    expect(novo.replace(BLOCO_DE_PERMISSOES_MINIMAS, '')).toBe(CI)
    expect(github.escritas().map((e) => `${e.metodo} ${e.caminho}`)).toEqual([
      `POST /repos/${REPO}/git/refs`,
      `PUT /repos/${REPO}/contents/${caminho}`,
      `POST /repos/${REPO}/pulls`,
    ])
    expect(github.pulls[0]?.body).toMatch(/Como reverter/)
    expect(github.pulls[0]?.body).toContain('contents: read')
    expect(resultado).toMatchObject({
      estado: 'aguardando-revisao',
      pr: { ramo, caminho, acao: 'editar' },
    })
  })

  it('o arquivo mudou e agora já declara permissions: não abre PR', async () => {
    const github = repositorio()
    const ctx = await contexto(github)
    github.definirArquivoNaPadrao(
      caminho,
      CI.replace('jobs:', 'permissions:\n  contents: read\n\njobs:')
    )
    const r = await executarPermissoesMinimas(ctx, workflowDe(ctx))
    expect(r.estado).toBe('dispensado')
    expect(github.escritas()).toEqual([])
  })

  it('o arquivo mudou e agora tem sinal de escrita (token): não mexe', async () => {
    const github = repositorio()
    const ctx = await contexto(github)
    github.definirArquivoNaPadrao(caminho, `${CI}      - run: gh pr comment 1 --body oi\n`)
    const r = await executarPermissoesMinimas(ctx, workflowDe(ctx))
    expect(r.estado).toBe('dispensado')
    expect(github.escritas()).toEqual([])
  })

  it('workflow de deploy/CD NUNCA é editado pela função, mesmo que alguém a chame', async () => {
    const github = repositorio({
      arquivos: { '.github/workflows/deploy.yml': CI },
    })
    const ctx = await contexto(github)
    const w = ctx.sondagem.workflows.itens.find((i) => i.caminho.endsWith('deploy.yml'))!
    expect(w.ehDeploy).toBe(true)
    const r = await executarPermissoesMinimas(ctx, w)
    expect(r.estado).toBe('dispensado')
    expect(github.registro).toEqual([])
  })

  it('caminho de workflow inválido nunca vira endereço', async () => {
    const github = repositorio()
    const ctx = await contexto(github)
    const w = { ...workflowDe(ctx), caminho: '.github/workflows/../../src/x.yml' }
    const r = await executarPermissoesMinimas(ctx, w)
    expect(r.estado).toBe('dispensado')
    expect(github.registro).toEqual([])
  })
})

// O pull request do aplicador é aberto SEMPRE com a credencial do App (instalação),
// nunca com a do dono ou do cliente: com a conta do dono, o autor passaria a ser o
// dono e o pull request viraria "de participante" aos olhos do QA. As chamadas de
// configuração seguem com a credencial que provou administração.
describe('credenciais: pull request com o App, configuração com a credencial que administra', () => {
  const caminho = '.github/workflows/ci.yml'
  const autorizacoes = (github: GitHubDeMelhoriasFalso) =>
    new Set(github.escritas().map((e) => e.autorizacao))

  it('toda escrita do PR de permissões mínimas (ramo, arquivo, pull) sai com o token do App', async () => {
    const github = repositorio()
    const ctx = await contexto(github)
    const w = ctx.sondagem.workflows.itens.find((i) => i.caminho === caminho)!
    const r = await executarPermissoesMinimas(ctx, w)
    expect(r.estado).toBe('aguardando-revisao')
    expect(github.escritas()).toHaveLength(3)
    expect(autorizacoes(github)).toEqual(new Set([`Bearer ${TOKEN_DO_APP}`]))
  })

  it('toda escrita do PR da alternativa gratuita de senhas sai com o token do App', async () => {
    const github = repositorio({ privado: true, advancedSecurity: 'disabled' })
    const ctx = await contexto(github)
    const r = await executarAlternativaDeSenhas(ctx)
    expect(r.estado).toBe('aguardando-revisao')
    expect(github.escritas().length).toBeGreaterThanOrEqual(3)
    expect(autorizacoes(github)).toEqual(new Set([`Bearer ${TOKEN_DO_APP}`]))
  })

  it('fechar o PR e apagar o ramo (desfazer) também saem com o token do App', async () => {
    const github = repositorio({ privado: true, advancedSecurity: 'disabled' })
    const ctx = await contexto(github)
    const feito = await executarAlternativaDeSenhas(ctx)
    github.registro.length = 0
    const r = await desfazerMelhoriaDeSeguranca(
      'alternativa-de-varredura-de-senhas',
      registroDoPrAberto(feito, 'alternativa-de-varredura-de-senhas'),
      ctx
    )
    expect(r.desfeito).toBe(true)
    expect(github.escritas()).toHaveLength(2)
    expect(autorizacoes(github)).toEqual(new Set([`Bearer ${TOKEN_DO_APP}`]))
  })

  it('a configuração por API (PUT/PATCH) usa a credencial que administra, nunca a do App por engano', async () => {
    const github = repositorio()
    const ctx = await contexto(github)
    const r = await executarMelhoriaDeConfiguracao('alertas-de-dependencias', ctx)
    expect(r.estado).toBe('aplicado')
    expect(github.escritas()).toHaveLength(1)
    expect(autorizacoes(github)).toEqual(new Set([`Bearer ${TOKEN}`]))
  })

  it.each([
    [
      'permissões mínimas',
      async (ctx: ContextoDeExecucao) =>
        executarPermissoesMinimas(
          ctx,
          ctx.sondagem.workflows.itens.find((i) => i.caminho === caminho)!
        ),
      {},
    ],
    [
      'alternativa de senhas',
      async (ctx: ContextoDeExecucao) => executarAlternativaDeSenhas(ctx),
      { privado: true, advancedSecurity: 'disabled' as const },
    ],
  ])(
    'sem token do App (%s): NÃO abre PR, não escreve nada e diz por quê',
    async (_n, executar, config) => {
      const github = repositorio(config)
      const ctx = await contexto(github, null)
      const r = await executar(ctx)
      expect(r.estado).toBe('recusado')
      expect(r.motivo).toContain('App')
      expect(github.escritas()).toEqual([])
      expect(github.pulls).toEqual([])
    }
  )

  it('o corpo do PR começa com a marca de segurança e o ramo tem o prefixo do GitOrch', async () => {
    const github = repositorio()
    const ctx = await contexto(github)
    const w = ctx.sondagem.workflows.itens.find((i) => i.caminho === caminho)!
    await executarPermissoesMinimas(ctx, w)
    expect(github.pulls[0]?.body.startsWith(MARCA_DO_PR_DE_SEGURANCA)).toBe(true)
    expect(github.pulls[0]?.head.startsWith(PREFIXO_DOS_RAMOS_DE_SEGURANCA)).toBe(true)
    expect(ehPrDeSeguranca({ ramo: github.pulls[0]?.head, corpo: github.pulls[0]?.body })).toBe(
      true
    )
  })

  it('o PR de reversão (desfazer um PR já mesclado) também leva a marca e o token do App', async () => {
    const github = repositorio({ privado: true, advancedSecurity: 'disabled' })
    const ctx = await contexto(github)
    const feito = await executarAlternativaDeSenhas(ctx)
    github.mesclarPull(1)
    github.registro.length = 0
    const r = await desfazerMelhoriaDeSeguranca(
      'alternativa-de-varredura-de-senhas',
      { ...registroDoPrAberto(feito, 'alternativa-de-varredura-de-senhas'), estado: 'aplicado' },
      ctx
    )
    expect(r.desfeito).toBe(true)
    expect(github.pulls[1]?.body.startsWith(MARCA_DO_PR_DE_SEGURANCA)).toBe(true)
    expect(autorizacoes(github)).toEqual(new Set([`Bearer ${TOKEN_DO_APP}`]))
  })
})

// O número do PR vem da ficha (banco). Antes de fechar ou de dar o PR por
// mesclado, a leitura do PR confirma que é o do aplicador: ramo do GitOrch e
// autoria do App.
describe('o número do PR guardado é amarrado ao ramo e ao autor do aplicador', () => {
  async function comPrAberto() {
    const github = repositorio({ privado: true, advancedSecurity: 'disabled' })
    const ctx = await contexto(github)
    const feito = await executarAlternativaDeSenhas(ctx)
    const registro = registroDoPrAberto(feito, 'alternativa-de-varredura-de-senhas')
    github.registro.length = 0
    return { github, ctx, registro, feito }
  }

  it('o PR guardado tem outro ramo (o número foi parar em outro PR): não fecha nem apaga nada', async () => {
    const { github, ctx, registro } = await comPrAberto()
    github.pulls[0]!.head = 'feature/trabalho-de-uma-pessoa'
    const r = await desfazerMelhoriaDeSeguranca('alternativa-de-varredura-de-senhas', registro, ctx)
    expect(r.desfeito).toBe(false)
    expect(r.motivo).toContain('ramo')
    expect(github.escritas()).toEqual([])
    expect(github.pulls[0]?.state).toBe('open')
  })

  it('o PR guardado foi aberto por uma pessoa, não pelo App: não fecha', async () => {
    const { github, ctx, registro } = await comPrAberto()
    github.pulls[0]!.autor = { login: 'dono-do-repo', type: 'User' }
    const r = await desfazerMelhoriaDeSeguranca('alternativa-de-varredura-de-senhas', registro, ctx)
    expect(r.desfeito).toBe(false)
    expect(r.motivo).toMatch(/App|autor/)
    expect(github.escritas()).toEqual([])
    expect(github.pulls[0]?.state).toBe('open')
  })

  it('o ramo é do aplicador mas não é o do registro: não fecha', async () => {
    const { github, ctx, registro } = await comPrAberto()
    github.pulls[0]!.head = `${PREFIXO_DOS_RAMOS_DE_SEGURANCA}outro-ramo`
    const r = await desfazerMelhoriaDeSeguranca('alternativa-de-varredura-de-senhas', registro, ctx)
    expect(r.desfeito).toBe(false)
    expect(github.escritas()).toEqual([])
  })

  it('PR do aplicador, do App e do ramo certo: fecha normalmente', async () => {
    const { github, ctx, registro } = await comPrAberto()
    const r = await desfazerMelhoriaDeSeguranca('alternativa-de-varredura-de-senhas', registro, ctx)
    expect(r.desfeito).toBe(true)
    expect(github.pulls[0]?.state).toBe('closed')
  })

  it('acompanhar: um PR de outro ramo mesclado NÃO conta como "aplicado"', async () => {
    const { github, ctx, registro } = await comPrAberto()
    github.mesclarPull(1)
    github.pulls[0]!.head = 'feature/trabalho-de-uma-pessoa'
    const r = await acompanharPrDeSeguranca(registro, ctx)
    expect(r.estado).toBe('incerto')
    expect(r.motivo).toContain('ramo')
  })
})

describe('workflow de deploy lido do arquivo de agora (não só da sondagem)', () => {
  it('a sondagem velha dizia "não é deploy", mas o arquivo de agora publica em tag: não abre PR', async () => {
    const BUILD = [
      'name: Build',
      'on:',
      '  push:',
      '    tags: ["v*"]',
      'jobs:',
      '  b:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      `      - uses: actions/checkout@${'a'.repeat(40)}`,
      '      - run: npm publish',
      '',
    ].join('\n')
    const caminho = '.github/workflows/build.yml'
    const github = repositorio({ arquivos: { [caminho]: BUILD } })
    const ctx = await contexto(github)
    const w = ctx.sondagem.workflows.itens.find((i) => i.caminho === caminho)!
    // a sondagem em cache ficou de antes do arquivo virar publicação
    const r = await executarPermissoesMinimas(ctx, { ...w, ehDeploy: false })
    expect(r.estado).toBe('dispensado')
    expect(r.motivo).toContain('deploy')
    expect(github.escritas()).toEqual([])
  })
})

describe('acompanhar o PR e desfazer as mudanças em arquivo', () => {
  const caminho = '.github/workflows/ci.yml'
  const registroDoPr = (r: { pr?: RegistroDaMelhoria['pr'] }, id: string): RegistroDaMelhoria => ({
    estado: 'aguardando-revisao',
    atualizadoEm: AGORA.toISOString(),
    proximaTentativaEm: null,
    tentativas: 1,
    motivo: 'PR aberto',
    ...(r.pr ? { pr: r.pr } : {}),
    desfazer: comoDesfazerDaMelhoria(id, REPO),
  })

  it('acompanhar: aberto continua aguardando; mesclado vira aplicado; fechado vira dispensado; só lê', async () => {
    const github = repositorio({ privado: true, advancedSecurity: 'disabled' })
    const ctx = await contexto(github)
    const feito = await executarAlternativaDeSenhas(ctx)
    const registro = registroDoPr(feito, 'alternativa-de-varredura-de-senhas')
    github.registro.length = 0
    expect((await acompanharPrDeSeguranca(registro, ctx)).estado).toBe('aguardando-revisao')
    github.mesclarPull(1)
    expect((await acompanharPrDeSeguranca(registro, ctx)).estado).toBe('aplicado')
    expect(github.escritas()).toEqual([])

    const outro = repositorio({ privado: true, advancedSecurity: 'disabled' })
    const ctx2 = await contexto(outro)
    const feito2 = await executarAlternativaDeSenhas(ctx2)
    outro.fecharPullSemMesclar(1)
    expect(
      (
        await acompanharPrDeSeguranca(
          registroDoPr(feito2, 'alternativa-de-varredura-de-senhas'),
          ctx2
        )
      ).estado
    ).toBe('dispensado')
  })

  it('desfazer com o PR ainda aberto: fecha o PR e apaga o ramo, sem tocar na branch padrão', async () => {
    const github = repositorio({ privado: true, advancedSecurity: 'disabled' })
    const ctx = await contexto(github)
    const feito = await executarAlternativaDeSenhas(ctx)
    github.registro.length = 0
    const r = await desfazerMelhoriaDeSeguranca(
      'alternativa-de-varredura-de-senhas',
      registroDoPr(feito, 'alternativa-de-varredura-de-senhas'),
      ctx
    )
    expect(r.desfeito).toBe(true)
    expect(github.pulls[0]?.state).toBe('closed')
    expect(github.temRamo(feito.pr!.ramo)).toBe(false)
    expect(github.escritas().map((e) => `${e.metodo} ${e.caminho}`)).toEqual([
      `PATCH /repos/${REPO}/pulls/1`,
      `DELETE /repos/${REPO}/git/refs/heads/${feito.pr!.ramo}`,
    ])
  })

  it('desfazer o gitleaks já mesclado: abre outro PR que APAGA o arquivo (nunca apaga direto)', async () => {
    const github = repositorio({ privado: true, advancedSecurity: 'disabled' })
    const ctx = await contexto(github)
    const feito = await executarAlternativaDeSenhas(ctx)
    github.mesclarPull(1)
    github.registro.length = 0
    const r = await desfazerMelhoriaDeSeguranca(
      'alternativa-de-varredura-de-senhas',
      { ...registroDoPr(feito, 'alternativa-de-varredura-de-senhas'), estado: 'aplicado' },
      ctx
    )
    expect(r.desfeito).toBe(true)
    expect(r.pr).toBeDefined()
    expect(github.arquivoNaPadrao(CAMINHO_DO_WORKFLOW_DE_SENHAS)).toBeDefined()
    const ramoDoDesfazer = r.pr!.ramo
    expect(ramoDoDesfazer).toMatch(new RegExp(`^${PREFIXO_DOS_RAMOS_DE_SEGURANCA}desfazer-`))
    expect(github.arquivoNoRamo(ramoDoDesfazer, CAMINHO_DO_WORKFLOW_DE_SENHAS)).toBeUndefined()
    expect(github.pulls).toHaveLength(2)
    github.mesclarPull(2)
    expect(github.arquivoNaPadrao(CAMINHO_DO_WORKFLOW_DE_SENHAS)).toBeUndefined()
  })

  it('desfazer as permissões mínimas já mescladas: PR que devolve o texto ORIGINAL do arquivo', async () => {
    const github = repositorio()
    const ctx = await contexto(github)
    const w = ctx.sondagem.workflows.itens.find((i) => i.caminho === caminho)!
    const feito = await executarPermissoesMinimas(ctx, w)
    github.mesclarPull(1)
    expect(github.arquivoNaPadrao(caminho)).not.toBe(CI)
    const r = await desfazerMelhoriaDeSeguranca(
      `permissoes-minimas-dos-workflows:${caminho}`,
      { ...registroDoPr(feito, `permissoes-minimas-dos-workflows:${caminho}`), estado: 'aplicado' },
      ctx
    )
    expect(r.desfeito).toBe(true)
    github.mesclarPull(2)
    expect(github.arquivoNaPadrao(caminho)).toBe(CI)
  })

  it('desfazer permissões cujo bloco foi alterado à mão: não adivinha, não abre PR', async () => {
    const github = repositorio()
    const ctx = await contexto(github)
    const w = ctx.sondagem.workflows.itens.find((i) => i.caminho === caminho)!
    const feito = await executarPermissoesMinimas(ctx, w)
    github.mesclarPull(1)
    github.definirArquivoNaPadrao(
      caminho,
      (github.arquivoNaPadrao(caminho) ?? '').replace('contents: read', 'contents: write')
    )
    github.registro.length = 0
    const r = await desfazerMelhoriaDeSeguranca(
      `permissoes-minimas-dos-workflows:${caminho}`,
      { ...registroDoPr(feito, `permissoes-minimas-dos-workflows:${caminho}`), estado: 'aplicado' },
      ctx
    )
    expect(r.desfeito).toBe(false)
    expect(github.escritas()).toEqual([])
  })
})
