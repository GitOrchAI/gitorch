// Nota de segurança do repositório: 6 checks simples e gratuitos pela API do
// GitHub, inspirados no OpenSSF Scorecard (não uma reimplementação dele —
// uma nota interna, simplificada, dos sinais que já dá para medir sem custo
// extra). `null` = não verificado, EXCLUÍDO do denominador: a nota nunca
// pune o que a credencial não alcançou, e o painel mostra "sobre N de 6".

import { coletarDividaDeSeguranca } from './security-debt-collector.js'

export interface ChecksDeSeguranca {
  /** Branch padrão exige pull request + revisão antes de mesclar. */
  branchProtection: boolean | null
  /** TODAS as Actions do workflow fixadas por SHA (40 hex), nunca por tag. */
  actionsFixadasPorSha: boolean | null
  /** Permissão padrão do GITHUB_TOKEN nas Actions do repositório. */
  permissaoPadraoDoToken: 'read' | 'write' | null
  codeowners: boolean | null
  securityMd: boolean | null
  dependabotConfigurado: boolean | null
}

export interface NotaDeSeguranca {
  nota: number | null
  maximo: number
  formula: string[]
}

const NOMES: Record<keyof ChecksDeSeguranca, string> = {
  branchProtection: 'branch protection no branch padrão',
  actionsFixadasPorSha: 'Actions fixadas por SHA',
  permissaoPadraoDoToken: 'permissão padrão do GITHUB_TOKEN é leitura',
  codeowners: 'CODEOWNERS presente',
  securityMd: 'SECURITY.md presente',
  dependabotConfigurado: 'Dependabot configurado',
}

export function calcularNotaDeSeguranca(checks: ChecksDeSeguranca): NotaDeSeguranca {
  const formula: string[] = []
  let pontos = 0
  let verificados = 0

  const marcar = (chave: keyof ChecksDeSeguranca, valor: boolean | null) => {
    if (valor === null) {
      formula.push(`${NOMES[chave]}: não verificado (fora do denominador)`)
      return
    }
    verificados += 1
    if (valor) pontos += 1
    formula.push(`${NOMES[chave]}: ${valor ? 'OK' : 'FALTA'}`)
  }

  marcar('branchProtection', checks.branchProtection)
  marcar('actionsFixadasPorSha', checks.actionsFixadasPorSha)
  marcar(
    'permissaoPadraoDoToken',
    checks.permissaoPadraoDoToken === null ? null : checks.permissaoPadraoDoToken === 'read'
  )
  marcar('codeowners', checks.codeowners)
  marcar('securityMd', checks.securityMd)
  marcar('dependabotConfigurado', checks.dependabotConfigurado)

  return {
    nota: verificados === 0 ? null : Math.round((pontos / verificados) * 100),
    maximo: verificados,
    formula,
  }
}

const GITHUB_API = 'https://api.github.com'
const HOST_API_GITHUB = new URL(GITHUB_API).host

/** Porta de saída PRÓPRIA deste arquivo — mesma disciplina de host-check de
 *  security-debt-collector.ts/incidente-ci.ts, nunca uma porta compartilhada
 *  entre arquivos de segurança (cada um audita a própria). */
function pedirUrlSegura(url: string, fetchImpl: typeof fetch, token: string): Promise<Response> {
  if (new URL(url).host !== HOST_API_GITHUB) {
    return Promise.reject(new Error('recusado: URL fora do host da API do GitHub'))
  }
  return fetchImpl(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'gitorch',
    },
  })
}

async function actionsFixadasPorSha(
  repository: string,
  fetchImpl: typeof fetch,
  token: string
): Promise<boolean | null> {
  try {
    const resp = await pedirUrlSegura(
      `${GITHUB_API}/repos/${repository}/contents/.github/workflows`,
      fetchImpl,
      token
    )
    if (!resp.ok) return null
    const arquivos = (await resp.json()) as Array<{ name: string; download_url?: string }>
    const yamls = arquivos.filter((a) => /\.ya?ml$/.test(a.name))
    if (yamls.length === 0) return null
    for (const arq of yamls) {
      if (!arq.download_url) continue
      const conteudo = await (await fetchImpl(arq.download_url)).text()
      // `uses: owner/repo@ref` — ref de 40 hex é SHA; qualquer outra coisa
      // (tag, branch) reprova o check para o repositório inteiro.
      const usos = [...conteudo.matchAll(/uses:\s*[\w.-]+\/[\w.-]+@([\w.-]+)/g)]
      if (usos.some((m) => !/^[0-9a-f]{40}$/i.test(m[1] ?? ''))) return false
    }
    return true
  } catch {
    return null
  }
}

async function existeArquivo(
  repository: string,
  caminho: string,
  fetchImpl: typeof fetch,
  token: string
): Promise<boolean | null> {
  try {
    const resp = await pedirUrlSegura(
      `${GITHUB_API}/repos/${repository}/contents/${caminho}`,
      fetchImpl,
      token
    )
    if (resp.status === 200) return true
    if (resp.status === 404) return false
    return null
  } catch {
    return null
  }
}

export async function coletarChecksDeSeguranca(deps: {
  repository: string
  defaultBranch: string
  token: string
  fetchImpl?: typeof fetch
}): Promise<ChecksDeSeguranca> {
  const f = deps.fetchImpl ?? fetch

  const branchProtection = await (async (): Promise<boolean | null> => {
    try {
      const resp = await pedirUrlSegura(
        `${GITHUB_API}/repos/${deps.repository}/branches/${deps.defaultBranch}/protection`,
        f,
        deps.token
      )
      if (resp.status === 404) return false
      if (!resp.ok) return null
      const dados = (await resp.json()) as { required_pull_request_reviews?: unknown }
      return Boolean(dados.required_pull_request_reviews)
    } catch {
      return null
    }
  })()

  const permissaoPadraoDoToken = await (async (): Promise<'read' | 'write' | null> => {
    try {
      const resp = await pedirUrlSegura(
        `${GITHUB_API}/repos/${deps.repository}/actions/permissions/workflow`,
        f,
        deps.token
      )
      if (!resp.ok) return null
      const dados = (await resp.json()) as { default_workflow_permissions?: string }
      return dados.default_workflow_permissions === 'write' ? 'write' : 'read'
    } catch {
      return null
    }
  })()

  // Dependabot: reaproveita coletarDividaDeSeguranca (Fase 5.2 já lê alertas
  // por essa mesma rota) — nunca uma segunda leitura de
  // .github/dependabot.yml aqui.
  const divida = await coletarDividaDeSeguranca({
    repository: deps.repository,
    token: deps.token,
    fetchImpl: f,
  })

  return {
    branchProtection,
    actionsFixadasPorSha: await actionsFixadasPorSha(deps.repository, f, deps.token),
    permissaoPadraoDoToken,
    codeowners: await existeArquivo(deps.repository, 'CODEOWNERS', f, deps.token),
    securityMd: await existeArquivo(deps.repository, 'SECURITY.md', f, deps.token),
    dependabotConfigurado: divida.naoVerificado.includes('configuracao')
      ? null
      : divida.temConfiguracao,
  }
}
