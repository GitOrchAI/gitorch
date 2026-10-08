import { describe, it, expect } from 'vitest'
import {
  calcularNotaDeSeguranca,
  coletarChecksDeSeguranca,
  coletarSegurancaDoRepositorio,
  type ChecksDeSeguranca,
} from './nota-de-seguranca.js'
import {
  criarGitHubFalso,
  shaDe,
  WORKFLOW_FIXADO,
  WORKFLOW_POR_TAG,
  type RepositorioFalso,
} from '../test/github-de-seguranca-fake.js'

const REPO = 'dono/repo'

function repositorio(extra: Partial<RepositorioFalso> = {}): RepositorioFalso {
  return {
    protecao: 'checks-sem-revisao',
    permissaoDoToken: 'read',
    arquivos: {},
    sbom: null,
    ...extra,
  }
}

async function coletar(
  extra: Partial<RepositorioFalso> = {},
  opcoes: { apenas?: ReadonlySet<keyof ChecksDeSeguranca> } = {}
) {
  const github = criarGitHubFalso({ [REPO]: repositorio(extra) })
  const coleta = await coletarSegurancaDoRepositorio({
    repository: REPO,
    defaultBranch: 'main',
    token: 't',
    fetchImpl: github.fetchFalso,
    ...opcoes,
  })
  return { ...github, coleta }
}

describe('calcularNotaDeSeguranca', () => {
  it('todos os 6 checks passando: nota 100 sobre 6', () => {
    const r = calcularNotaDeSeguranca({
      branchProtection: true,
      actionsFixadasPorSha: true,
      permissaoPadraoDoToken: 'read',
      codeowners: true,
      securityMd: true,
      dependabotConfigurado: true,
    })
    expect(r).toEqual({ nota: 100, maximo: 6, formula: expect.any(Array) })
  })

  it('só 2 de 6 passando: nota 33', () => {
    const r = calcularNotaDeSeguranca({
      branchProtection: true,
      actionsFixadasPorSha: false,
      permissaoPadraoDoToken: 'write',
      codeowners: true,
      securityMd: false,
      dependabotConfigurado: false,
    })
    expect(r.nota).toBe(33)
  })

  it('check não verificado (null) é excluído do denominador, não conta contra', () => {
    const r = calcularNotaDeSeguranca({
      branchProtection: true,
      actionsFixadasPorSha: null,
      permissaoPadraoDoToken: 'read',
      codeowners: true,
      securityMd: true,
      dependabotConfigurado: true,
    })
    expect(r).toEqual({ nota: 100, maximo: 5, formula: expect.any(Array) })
  })

  it('nenhum check verificado: nota null, nunca 0 nem 100 inventados', () => {
    const r = calcularNotaDeSeguranca({
      branchProtection: null,
      actionsFixadasPorSha: null,
      permissaoPadraoDoToken: null,
      codeowners: null,
      securityMd: null,
      dependabotConfigurado: null,
    })
    expect(r.nota).toBeNull()
    expect(r.maximo).toBe(0)
  })

  it('a fórmula diz que o check de proteção é sobre checagens obrigatórias', () => {
    const r = calcularNotaDeSeguranca({
      branchProtection: true,
      actionsFixadasPorSha: true,
      permissaoPadraoDoToken: 'read',
      codeowners: true,
      securityMd: true,
      dependabotConfigurado: true,
    })
    expect(r.formula[0]).toContain('checagens obrigatórias')
  })
})

describe('coletarSegurancaDoRepositorio: arquivos pela árvore', () => {
  it('acha .github/CODEOWNERS (a raiz dá 404) com UMA chamada de árvore, sem consultar arquivo por arquivo', async () => {
    const { coleta, chamadas } = await coletar({
      arquivos: { '.github/CODEOWNERS': '* @dono', 'README.md': '# oi' },
    })
    expect(coleta.checks.codeowners).toBe(true)
    expect(chamadas.filter((c) => c.includes('/git/trees/'))).toHaveLength(1)
    expect(chamadas.some((c) => c.includes('/contents/CODEOWNERS'))).toBe(false)
    expect(chamadas.some((c) => c.includes('/contents/SECURITY.md'))).toBe(false)
  })

  it('aceita CODEOWNERS e SECURITY.md na raiz, em .github/ e em docs/', async () => {
    for (const lugar of ['', '.github/', 'docs/']) {
      const { coleta } = await coletar({
        arquivos: { [`${lugar}CODEOWNERS`]: '* @a', [`${lugar}SECURITY.md`]: '# s' },
      })
      expect(coleta.checks.codeowners, `CODEOWNERS em "${lugar}"`).toBe(true)
      expect(coleta.checks.securityMd, `SECURITY.md em "${lugar}"`).toBe(true)
    }
  })

  it('não confunde um arquivo de mesmo nome em pasta qualquer (src/CODEOWNERS)', async () => {
    const { coleta } = await coletar({ arquivos: { 'src/CODEOWNERS': 'x', 'a/SECURITY.md': 'x' } })
    expect(coleta.checks.codeowners).toBe(false)
    expect(coleta.checks.securityMd).toBe(false)
  })

  it('ausente numa árvore completa: false; árvore truncada: ausência vira não verificado, presença segue true', async () => {
    const completa = await coletar({ arquivos: { 'README.md': 'x' } })
    expect(completa.coleta.checks.codeowners).toBe(false)
    const truncada = await coletar({
      arquivos: { 'README.md': 'x', 'SECURITY.md': '# s' },
      arvoreTruncada: true,
    })
    expect(truncada.coleta.checks.codeowners).toBeNull()
    expect(truncada.coleta.checks.securityMd).toBe(true)
  })

  it('Dependabot configurado vem do arquivo da árvore (.yml ou .yaml), sem listar alertas', async () => {
    const yml = await coletar({ arquivos: { '.github/dependabot.yml': 'version: 2' } })
    expect(yml.coleta.checks.dependabotConfigurado).toBe(true)
    const yaml = await coletar({ arquivos: { '.github/dependabot.yaml': 'version: 2' } })
    expect(yaml.coleta.checks.dependabotConfigurado).toBe(true)
    const nenhum = await coletar({ arquivos: { 'README.md': 'x' } })
    expect(nenhum.coleta.checks.dependabotConfigurado).toBe(false)
    expect(nenhum.chamadas.some((c) => c.includes('dependabot/alerts'))).toBe(false)
  })

  it('árvore indisponível: os três checks de arquivo ficam não verificados', async () => {
    const github = criarGitHubFalso({ [REPO]: repositorio() })
    const fetchSemArvore = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      String(input).includes('/git/trees/')
        ? new Response('{"message":"Server Error"}', { status: 500 })
        : github.fetchFalso(input, init)) as typeof fetch
    const { checks } = await coletarSegurancaDoRepositorio({
      repository: REPO,
      defaultBranch: 'main',
      token: 't',
      fetchImpl: fetchSemArvore,
    })
    expect([checks.codeowners, checks.securityMd, checks.dependabotConfigurado]).toEqual([
      null,
      null,
      null,
    ])
  })
})

describe('coletarSegurancaDoRepositorio: proteção do branch', () => {
  it('proteção com checagens obrigatórias e SEM revisão obrigatória conta como OK', async () => {
    const { coleta } = await coletar({ protecao: 'checks-sem-revisao' })
    expect(coleta.checks.branchProtection).toBe(true)
    expect(coleta.informativos.revisaoObrigatoria).toBe(false)
  })

  it('revisão obrigatória é só informativa: aparece, e não muda o check', async () => {
    const { coleta } = await coletar({ protecao: 'checks-com-revisao' })
    expect(coleta.checks.branchProtection).toBe(true)
    expect(coleta.informativos.revisaoObrigatoria).toBe(true)
  })

  it('proteção sem nenhuma checagem obrigatória não conta como OK', async () => {
    const { coleta } = await coletar({ protecao: 'so-revisao' })
    expect(coleta.checks.branchProtection).toBe(false)
    expect(coleta.informativos.revisaoObrigatoria).toBe(true)
  })

  it('404 "Branch not protected": FALTA', async () => {
    const { coleta } = await coletar({ protecao: 'sem-protecao' })
    expect(coleta.checks.branchProtection).toBe(false)
  })

  it('403 "Upgrade to GitHub Pro" (privado em plano grátis): não verificado, fora do denominador', async () => {
    const { coleta } = await coletar({ protecao: 'plano-gratis' })
    expect(coleta.checks.branchProtection).toBeNull()
    expect(coleta.informativos.revisaoObrigatoria).toBeNull()
    const nota = calcularNotaDeSeguranca(coleta.checks)
    expect(nota.formula[0]).toContain('não verificado (fora do denominador)')
    expect(nota.maximo).toBeLessThan(6)
  })

  it('403 de permissão da credencial: não verificado, nunca "falta"', async () => {
    const { coleta } = await coletar({ protecao: 'sem-permissao' })
    expect(coleta.checks.branchProtection).toBeNull()
  })
})

describe('coletarSegurancaDoRepositorio: permissão do token e Actions', () => {
  it('lê a permissão padrão do GITHUB_TOKEN; falha vira null', async () => {
    expect(
      (await coletar({ permissaoDoToken: 'write' })).coleta.checks.permissaoPadraoDoToken
    ).toBe('write')
    expect((await coletar({ permissaoDoToken: 'read' })).coleta.checks.permissaoPadraoDoToken).toBe(
      'read'
    )
    expect(
      (await coletar({ permissaoDoToken: 'indisponivel' })).coleta.checks.permissaoPadraoDoToken
    ).toBeNull()
  })

  it('todas as Actions fixadas por SHA (inclusive de subcaminho): OK', async () => {
    const { coleta } = await coletar({
      arquivos: { '.github/workflows/ci.yml': WORKFLOW_FIXADO },
    })
    expect(coleta.checks.actionsFixadasPorSha).toBe(true)
  })

  it('uma Action por tag, mesmo de subcaminho (actions/cache/restore@v4): FALTA', async () => {
    const { coleta } = await coletar({
      arquivos: {
        '.github/workflows/ok.yml': WORKFLOW_FIXADO,
        '.github/workflows/ci.yml': 'steps:\n  - uses: actions/cache/restore@v4\n',
      },
    })
    expect(coleta.checks.actionsFixadasPorSha).toBe(false)
    const outra = await coletar({
      arquivos: { '.github/workflows/ci.yml': WORKFLOW_POR_TAG },
    })
    expect(outra.coleta.checks.actionsFixadasPorSha).toBe(false)
  })

  it('sem workflows: não aplicável (null) e sem listar a pasta quando a árvore já mostra que não há', async () => {
    const { coleta, chamadas } = await coletar({ arquivos: { 'README.md': 'x' } })
    expect(coleta.checks.actionsFixadasPorSha).toBeNull()
    expect(chamadas.some((c) => c.includes('/contents/.github/workflows'))).toBe(false)
  })

  it('o download de um workflow falha (resp.ok falso): não vira "tudo fixado" nem "tudo solto", fica não verificado', async () => {
    const github = criarGitHubFalso({
      [REPO]: repositorio({ arquivos: { '.github/workflows/ci.yml': WORKFLOW_FIXADO } }),
    })
    const fetchComDownloadQuebrado = (async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit
    ) =>
      String(input).startsWith('https://raw.githubusercontent.com/')
        ? new Response('<html>404: Not Found</html>', { status: 404 })
        : github.fetchFalso(input, init)) as typeof fetch
    const { checks } = await coletarSegurancaDoRepositorio({
      repository: REPO,
      defaultBranch: 'main',
      token: 't',
      fetchImpl: fetchComDownloadQuebrado,
    })
    expect(checks.actionsFixadasPorSha).toBeNull()
  })

  it('se um download falha mas OUTRO workflow já provou uma Action solta, o resultado é FALTA', async () => {
    const github = criarGitHubFalso({
      [REPO]: repositorio({
        arquivos: {
          '.github/workflows/a-solto.yml': WORKFLOW_POR_TAG,
          '.github/workflows/b-quebrado.yml': WORKFLOW_FIXADO,
        },
      }),
    })
    const fetchQuebraUm = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      String(input).endsWith('b-quebrado.yml')
        ? new Response('boom', { status: 500 })
        : github.fetchFalso(input, init)) as typeof fetch
    const { checks } = await coletarSegurancaDoRepositorio({
      repository: REPO,
      defaultBranch: 'main',
      token: 't',
      fetchImpl: fetchQuebraUm,
    })
    expect(checks.actionsFixadasPorSha).toBe(false)
  })

  it('download_url que não aponta para o raw do GitHub nunca é buscado', async () => {
    const buscadas: string[] = []
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input)
      buscadas.push(url)
      if (url.includes('/git/trees/')) {
        return new Response(
          JSON.stringify({
            tree: [{ path: '.github/workflows/ci.yml', type: 'blob', sha: shaDe('x'), size: 1 }],
            truncated: false,
          }),
          { status: 200 }
        )
      }
      if (url.includes('/contents/.github/workflows')) {
        return new Response(
          JSON.stringify([
            {
              name: 'ci.yml',
              path: '.github/workflows/ci.yml',
              download_url: 'https://servidor-alheio.example/ci.yml',
            },
          ]),
          { status: 200 }
        )
      }
      return new Response('{}', { status: 404 })
    }) as typeof fetch
    const { checks } = await coletarSegurancaDoRepositorio({
      repository: REPO,
      defaultBranch: 'main',
      token: 't',
      fetchImpl,
    })
    expect(checks.actionsFixadasPorSha).toBeNull()
    expect(buscadas.some((u) => u.includes('servidor-alheio'))).toBe(false)
  })
})

describe('coletarSegurancaDoRepositorio: orçamento e proteções', () => {
  it('um repositório típico custa 4 chamadas à API (proteção, permissão, árvore, workflows) mais os downloads fora da cota', async () => {
    const { chamadas } = await coletar({
      arquivos: {
        '.github/workflows/ci.yml': WORKFLOW_FIXADO,
        '.github/workflows/cd.yml': WORKFLOW_POR_TAG,
      },
    })
    const api = chamadas.filter((c) => c.startsWith('api.github.com'))
    expect(api).toHaveLength(4)
    expect(chamadas.filter((c) => c.startsWith('raw.githubusercontent.com'))).toHaveLength(2)
  })

  it('"apenas" limita as leituras ao que falta medir', async () => {
    const { chamadas, coleta } = await coletar(
      { arquivos: { 'SECURITY.md': '# s' } },
      { apenas: new Set(['branchProtection'] as const) }
    )
    expect(chamadas).toHaveLength(1)
    expect(chamadas[0]).toContain('/protection')
    expect(coleta.checks.securityMd).toBeNull()
    expect(coleta.checks.branchProtection).toBe(true)
  })

  it('repositório com formato inválido não faz chamada nenhuma e devolve tudo não verificado', async () => {
    const github = criarGitHubFalso({})
    const { checks } = await coletarSegurancaDoRepositorio({
      repository: 'dono/repo/../../x?y=1',
      defaultBranch: 'main',
      token: 't',
      fetchImpl: github.fetchFalso,
    })
    expect(github.chamadas).toEqual([])
    expect(Object.values(checks).every((v) => v === null)).toBe(true)
  })

  it('branch padrão com caractere fora do padrão não monta URL', async () => {
    const github = criarGitHubFalso({ [REPO]: repositorio() })
    await coletarSegurancaDoRepositorio({
      repository: REPO,
      defaultBranch: 'main?x=1#y',
      token: 't',
      fetchImpl: github.fetchFalso,
    })
    expect(github.chamadas.some((c) => c.includes('x=1'))).toBe(false)
  })

  it('avisa quem chama de cada resposta ruim (para o freio de cota)', async () => {
    const respostas: number[] = []
    const github = criarGitHubFalso({ [REPO]: repositorio({ limiteDeTaxa: true }) })
    await coletarSegurancaDoRepositorio({
      repository: REPO,
      defaultBranch: 'main',
      token: 't',
      fetchImpl: github.fetchFalso,
      aoReceberRespostaRuim: (resposta) => respostas.push(resposta.status),
    })
    expect(respostas.length).toBeGreaterThan(0)
    expect(respostas.every((s) => s === 403)).toBe(true)
  })
})

describe('coletarChecksDeSeguranca (compatível: só os checks)', () => {
  it('devolve os 6 sinais', async () => {
    const github = criarGitHubFalso({
      [REPO]: repositorio({
        arquivos: {
          '.github/CODEOWNERS': '* @a',
          '.github/dependabot.yml': 'version: 2',
          '.github/workflows/ci.yml': WORKFLOW_FIXADO,
        },
      }),
    })
    const checks = await coletarChecksDeSeguranca({
      repository: REPO,
      defaultBranch: 'main',
      token: 't',
      fetchImpl: github.fetchFalso,
    })
    expect(checks).toEqual({
      branchProtection: true,
      actionsFixadasPorSha: true,
      permissaoPadraoDoToken: 'read',
      codeowners: true,
      securityMd: false,
      dependabotConfigurado: true,
    })
  })
})
