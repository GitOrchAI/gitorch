// Um GitHub de mentira para a nota de segurança e a conformidade: as MESMAS
// respostas que a API devolveu quando foi lida (corpo e código de status de
// cada rota), montadas a partir de uma descrição curta do repositório. Serve
// aos testes de unidade (como `fetch`), ao de integração (atrás de um servidor
// HTTP local) e ao do scheduler (no `global.fetch`).
//
// Nada daqui é código de produção: fica em `src/test/`.

import { createHash } from 'node:crypto'

export type ProtecaoFalsa =
  /** Checagens obrigatórias, histórico linear, sem force-push, SEM revisão obrigatória. */
  | 'checks-sem-revisao'
  | 'checks-com-revisao'
  | 'so-revisao'
  | 'sem-protecao'
  /** Repositório privado em plano grátis. */
  | 'plano-gratis'
  | 'sem-permissao'

export interface RepositorioFalso {
  branchPadrao?: string
  protecao: ProtecaoFalsa
  permissaoDoToken: 'read' | 'write' | 'indisponivel'
  /** Caminho → conteúdo. A árvore, a listagem dos workflows e os blobs saem daqui. */
  arquivos: Record<string, string>
  /** `null` = o endpoint responde 404 (como em repositório sem o grafo). */
  sbom: Array<{ name: string; licenca: string | null }> | null
  arvoreTruncada?: boolean
  /** A proteção do branch só responde com esta credencial (as outras levam 403). */
  protecaoExigeToken?: string
  /** Todas as rotas da API respondem limite de taxa. */
  limiteDeTaxa?: boolean
  /** Atraso em cada resposta da API, em ms. */
  latenciaMs?: number
}

export interface RespostaFalsa {
  status: number
  corpo: string
  headers: Record<string, string>
}

export const MENSAGEM_PLANO_GRATIS =
  'Upgrade to GitHub Pro or make this repository public to enable this feature.'

const DOC = 'https://docs.github.com/rest'

function json(status: number, valor: unknown, headers: Record<string, string> = {}): RespostaFalsa {
  return {
    status,
    corpo: JSON.stringify(valor),
    headers: { 'content-type': 'application/json', ...headers },
  }
}

function naoEncontrado(): RespostaFalsa {
  return json(404, { message: 'Not Found', documentation_url: DOC, status: '404' })
}

export function shaDe(texto: string): string {
  return createHash('sha1').update(texto).digest('hex')
}

function protecaoDe(tipo: ProtecaoFalsa, repo: string, branch: string): RespostaFalsa {
  const base = `https://api.github.com/repos/${repo}/branches/${branch}/protection`
  if (tipo === 'plano-gratis') {
    return json(403, {
      message: MENSAGEM_PLANO_GRATIS,
      documentation_url: `${DOC}/branches/branch-protection#get-branch-protection`,
      status: '403',
    })
  }
  if (tipo === 'sem-permissao') {
    return json(403, { message: 'Resource not accessible by integration', status: '403' })
  }
  if (tipo === 'sem-protecao') {
    return json(404, {
      message: 'Branch not protected',
      documentation_url: `${DOC}/branches/branch-protection#get-branch-protection`,
      status: '404',
    })
  }
  const comChecks = tipo === 'checks-sem-revisao' || tipo === 'checks-com-revisao'
  const comRevisao = tipo === 'checks-com-revisao' || tipo === 'so-revisao'
  return json(200, {
    url: base,
    ...(comChecks
      ? {
          required_status_checks: {
            url: `${base}/required_status_checks`,
            strict: false,
            contexts: ['zero-tolerance', 'infra-guard'],
            checks: [
              { context: 'zero-tolerance', app_id: 15368 },
              { context: 'infra-guard', app_id: 15368 },
            ],
          },
        }
      : {}),
    ...(comRevisao
      ? {
          required_pull_request_reviews: {
            url: `${base}/required_pull_request_reviews`,
            dismiss_stale_reviews: false,
            require_code_owner_reviews: false,
            required_approving_review_count: 1,
          },
        }
      : {}),
    enforce_admins: { url: `${base}/enforce_admins`, enabled: false },
    required_linear_history: { enabled: true },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false },
  })
}

function sbomDe(repo: string, pacotes: Array<{ name: string; licenca: string | null }>) {
  return {
    sbom: {
      spdxVersion: 'SPDX-2.3',
      dataLicense: 'CC0-1.0',
      SPDXID: 'SPDXRef-DOCUMENT',
      name: `com.github.${repo.replace('/', '.')}`,
      packages: [
        {
          SPDXID: 'SPDXRef-github-raiz',
          name: `com.github.${repo.replace('/', '.')}`,
          versionInfo: '',
          downloadLocation: `git+https://github.com/${repo}.git`,
          filesAnalyzed: false,
          licenseConcluded: 'NOASSERTION',
        },
        {
          SPDXID: 'SPDXRef-githubactions-actions-checkout-4',
          name: 'actions/checkout',
          versionInfo: '4.x',
          downloadLocation: 'NOASSERTION',
          filesAnalyzed: false,
        },
        ...pacotes.map((p, n) => ({
          SPDXID: `SPDXRef-npm-${n}`,
          name: p.name,
          versionInfo: '1.0.0',
          downloadLocation: 'NOASSERTION',
          filesAnalyzed: false,
          ...(p.licenca === null ? {} : { licenseConcluded: p.licenca }),
        })),
      ],
      relationships: [
        {
          spdxElementId: 'SPDXRef-DOCUMENT',
          relatedSpdxElement: 'SPDXRef-github-raiz',
          relationshipType: 'DESCRIBES',
        },
      ],
    },
  }
}

export function criarGitHubFalso(repositorios: Record<string, RepositorioFalso>) {
  const chamadas: string[] = []

  const atender = (urlTexto: string, autorizacao?: string): RespostaFalsa => {
    const url = new URL(urlTexto)
    const rotulo = `${url.host}${url.pathname}${url.search}`
    chamadas.push(rotulo)

    if (url.host === 'raw.githubusercontent.com') {
      const [dono, nome, , ...resto] = url.pathname.split('/').filter(Boolean)
      const repo = repositorios[`${dono}/${nome}`]
      const caminho = resto.join('/')
      const conteudo = repo?.arquivos[caminho]
      if (conteudo === undefined) return { status: 404, corpo: '404: Not Found', headers: {} }
      return { status: 200, corpo: conteudo, headers: { 'content-type': 'text/plain' } }
    }
    if (url.host !== 'api.github.com') return { status: 502, corpo: 'host inesperado', headers: {} }

    const achou = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(url.pathname)
    if (!achou) return naoEncontrado()
    const repo = `${achou[1]}/${achou[2]}`
    const resto = achou[3] ?? ''
    const config = repositorios[repo]
    if (!config) return naoEncontrado()
    const branch = config.branchPadrao ?? 'main'

    if (config.limiteDeTaxa) {
      return json(
        403,
        { message: 'API rate limit exceeded', documentation_url: `${DOC}/overview/rate-limits` },
        {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600),
        }
      )
    }

    if (resto === '') return json(200, { full_name: repo, default_branch: branch })
    if (resto === `/branches/${branch}/protection`) {
      if (config.protecaoExigeToken && autorizacao !== `Bearer ${config.protecaoExigeToken}`) {
        return json(403, { message: 'Resource not accessible by integration', status: '403' })
      }
      return protecaoDe(config.protecao, repo, branch)
    }
    if (resto === '/actions/permissions/workflow') {
      if (config.permissaoDoToken === 'indisponivel') {
        return json(403, { message: 'Resource not accessible by integration', status: '403' })
      }
      return json(200, {
        default_workflow_permissions: config.permissaoDoToken,
        can_approve_pull_request_reviews: false,
      })
    }
    if (resto === `/git/trees/${branch}`) {
      return json(200, {
        sha: shaDe(`${repo}@arvore`),
        url: `https://api.github.com/repos/${repo}/git/trees/${shaDe(`${repo}@arvore`)}`,
        tree: Object.entries(config.arquivos).map(([path, conteudo]) => ({
          path,
          mode: '100644',
          type: 'blob',
          sha: shaDe(conteudo),
          size: Buffer.byteLength(conteudo),
          url: `https://api.github.com/repos/${repo}/git/blobs/${shaDe(conteudo)}`,
        })),
        truncated: config.arvoreTruncada === true,
      })
    }
    if (resto === '/contents/.github/workflows') {
      const workflows = Object.keys(config.arquivos).filter((p) =>
        /^\.github\/workflows\/[^/]+$/.test(p)
      )
      if (workflows.length === 0) return naoEncontrado()
      return json(
        200,
        workflows.map((path) => ({
          name: path.split('/').pop(),
          path,
          sha: shaDe(config.arquivos[path] ?? ''),
          type: 'file',
          download_url: `https://raw.githubusercontent.com/${repo}/${branch}/${path}`,
        }))
      )
    }
    const blob = /^\/git\/blobs\/([0-9a-f]{40})$/.exec(resto)
    if (blob) {
      const conteudo = Object.values(config.arquivos).find((c) => shaDe(c) === blob[1])
      if (conteudo === undefined) return naoEncontrado()
      return json(200, {
        sha: blob[1],
        encoding: 'base64',
        size: Buffer.byteLength(conteudo),
        content: Buffer.from(conteudo).toString('base64'),
      })
    }
    if (resto === '/dependency-graph/sbom') {
      return config.sbom === null ? naoEncontrado() : json(200, sbomDe(repo, config.sbom))
    }
    // Qualquer outra rota (por exemplo `contents/CODEOWNERS`): 404 de verdade.
    return naoEncontrado()
  }

  const fetchFalso = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const urlTexto = input instanceof Request ? input.url : String(input)
    const cabecalhos = new Headers(init?.headers)
    const resposta = atender(urlTexto, cabecalhos.get('authorization') ?? undefined)
    const repo = /^\/repos\/([^/]+\/[^/]+)/.exec(new URL(urlTexto).pathname)?.[1]
    const atraso = repo ? repositorios[repo]?.latenciaMs : undefined
    if (atraso) await new Promise((r) => setTimeout(r, atraso))
    return new Response(resposta.corpo, { status: resposta.status, headers: resposta.headers })
  }) as typeof fetch

  return { chamadas, atender, fetchFalso }
}

/** Workflow com todas as Actions fixadas por SHA. */
export const WORKFLOW_FIXADO = [
  'name: ci',
  'jobs:',
  '  build:',
  '    steps:',
  '      - uses: actions/checkout@' + 'a'.repeat(40) + ' # v4',
  '      - uses: actions/cache/restore@' + 'b'.repeat(40) + ' # v4',
].join('\n')

/** Workflow com uma Action por tag e outra de subcaminho por tag. */
export const WORKFLOW_POR_TAG = [
  'name: ci',
  'jobs:',
  '  build:',
  '    steps:',
  '      - uses: actions/checkout@v4',
  '      - uses: actions/cache/restore@v4',
].join('\n')
