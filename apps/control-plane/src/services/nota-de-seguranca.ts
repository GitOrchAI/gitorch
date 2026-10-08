// Nota de segurança do repositório: 6 checks simples e gratuitos pela API do
// GitHub, inspirados no OpenSSF Scorecard (não uma reimplementação dele —
// uma nota interna, simplificada, dos sinais que já dá para medir sem custo
// extra). `null` = não verificado, EXCLUÍDO do denominador: a nota nunca
// pune o que a credencial não alcançou, e o painel mostra "sobre N de 6".

import { fetchSemPermissao } from './guarda-de-autonomia.js'

export interface ChecksDeSeguranca {
  /** Branch padrão exige checagens (status checks) antes de mesclar. A revisão
   *  obrigatória NÃO entra: é só informativa (`InformativosDeSeguranca`), porque
   *  exigi-la trava o merge automático e nem todo projeto a quer. */
  branchProtection: boolean | null
  /** TODAS as Actions do workflow fixadas por SHA (40 hex), nunca por tag. */
  actionsFixadasPorSha: boolean | null
  /** Permissão padrão do GITHUB_TOKEN nas Actions do repositório. */
  permissaoPadraoDoToken: 'read' | 'write' | null
  codeowners: boolean | null
  securityMd: boolean | null
  dependabotConfigurado: boolean | null
}

/** Sinais que aparecem junto da nota mas NÃO entram na conta. */
export interface InformativosDeSeguranca {
  /** A proteção também exige revisão de pull request. `null` = não verificado. */
  revisaoObrigatoria: boolean | null
}

export interface EntradaDaArvore {
  path: string
  type: string
  sha: string | null
  size: number | null
}

/** A árvore de arquivos do branch padrão (uma chamada recursiva). */
export interface ArvoreDoRepositorio {
  entradas: EntradaDaArvore[]
  /** O GitHub cortou a lista: ausência de arquivo deixa de ser prova. */
  truncada: boolean
}

export interface ColetaDeSeguranca {
  checks: ChecksDeSeguranca
  informativos: InformativosDeSeguranca
  /** A árvore lida, para quem precisa de mais arquivos sem pedir de novo. */
  arvore: ArvoreDoRepositorio | null
}

export interface NotaDeSeguranca {
  nota: number | null
  maximo: number
  formula: string[]
}

const NOMES: Record<keyof ChecksDeSeguranca, string> = {
  branchProtection: 'proteção com checagens obrigatórias no branch padrão',
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
/** Onde o GitHub serve o texto cru dos arquivos (o `download_url` da listagem). */
const HOST_DO_TEXTO_CRU = 'raw.githubusercontent.com'

const SEGMENTO_VALIDO = /^[A-Za-z0-9._-]+$/
const BRANCH_VALIDO = /^[A-Za-z0-9._/-]+$/

/** `dono/repo` no formato que o GitHub aceita: o valor vem de uma escolha do
 *  cliente e entra na URL de chamadas que levam credencial. */
export function repositorioValido(repository: string): boolean {
  const partes = repository.split('/')
  return (
    partes.length === 2 && partes.every((p) => p !== '.' && p !== '..' && SEGMENTO_VALIDO.test(p))
  )
}

function branchValido(branch: string): boolean {
  return BRANCH_VALIDO.test(branch) && !branch.includes('..')
}

type AoReceberRespostaRuim = (resposta: Response) => void

/** Porta de saída PRÓPRIA deste arquivo — mesma disciplina de host-check de
 *  security-debt-collector.ts/incidente-ci.ts, nunca uma porta compartilhada
 *  entre arquivos de segurança (cada um audita a própria). */
async function pedirUrlSegura(
  url: string,
  fetchImpl: typeof fetch,
  token: string,
  aoReceberRespostaRuim?: AoReceberRespostaRuim
): Promise<Response> {
  if (new URL(url).host !== HOST_API_GITHUB) {
    throw new Error('recusado: URL fora do host da API do GitHub')
  }
  const resposta = await fetchImpl(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'gitorch',
    },
  })
  if (!resposta.ok) {
    try {
      aoReceberRespostaRuim?.(resposta.clone())
    } catch {
      // O aviso é só para o freio de cota; nunca derruba a leitura.
    }
  }
  return resposta
}

/** Baixa o texto de um arquivo do repositório. SEM credencial: o endereço vem
 *  da resposta da API (dado de fora), então só vale o host do texto cru do
 *  GitHub, e nada além disso recebe a requisição. Resposta fora de 2xx é
 *  falha: um HTML de 404 não pode ser lido como se fosse o workflow. */
async function baixarTextoCru(url: string, fetchImpl: typeof fetch): Promise<string | null> {
  try {
    if (new URL(url).host !== HOST_DO_TEXTO_CRU) return null
    const resposta = await fetchImpl(url)
    if (!resposta.ok) return null
    return await resposta.text()
  } catch {
    return null
  }
}

/** `uses: dono/repo[/caminho]@ref`, fora de comentário. Locais (`./`) e
 *  `docker://` não têm `@ref` de repositório e ficam de fora. */
const LINHA_USES = /^[ \t]*(?:-[ \t]*)?uses:[ \t]*['"]?([^\s'"#]+)/gm
const SHA_COMPLETO = /^[0-9a-f]{40}$/i

/** `true` = achou Action por tag/branch; `false` = todas fixadas por SHA. */
function temActionNaoFixada(conteudo: string): boolean {
  for (const achado of conteudo.matchAll(LINHA_USES)) {
    const uso = achado[1] ?? ''
    if (uso.startsWith('./') || uso.startsWith('docker://')) continue
    const arroba = uso.lastIndexOf('@')
    if (arroba < 0) continue
    if (!SHA_COMPLETO.test(uso.slice(arroba + 1))) return true
  }
  return false
}

const ARQUIVOS_DE_CODEOWNERS = ['CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS']
const ARQUIVOS_DE_SECURITY = ['SECURITY.md', '.github/SECURITY.md', 'docs/SECURITY.md']
const ARQUIVOS_DO_DEPENDABOT = ['.github/dependabot.yml', '.github/dependabot.yaml']
const EH_WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/

/** Presença de um arquivo numa árvore: ausência só é prova com a árvore inteira. */
function presenteNaArvore(arvore: ArvoreDoRepositorio | null, caminhos: string[]): boolean | null {
  if (!arvore) return null
  const achou = arvore.entradas.some((e) => e.type === 'blob' && caminhos.includes(e.path))
  if (achou) return true
  return arvore.truncada ? null : false
}

async function lerArvore(
  repository: string,
  branch: string,
  fetchImpl: typeof fetch,
  token: string,
  aoReceberRespostaRuim?: AoReceberRespostaRuim
): Promise<ArvoreDoRepositorio | null> {
  try {
    const resp = await pedirUrlSegura(
      `${GITHUB_API}/repos/${repository}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
      fetchImpl,
      token,
      aoReceberRespostaRuim
    )
    if (!resp.ok) return null
    const dados = (await resp.json()) as { tree?: unknown; truncated?: unknown }
    if (!Array.isArray(dados.tree)) return null
    const entradas: EntradaDaArvore[] = []
    for (const bruto of dados.tree as Array<Record<string, unknown>>) {
      if (typeof bruto['path'] !== 'string' || typeof bruto['type'] !== 'string') continue
      entradas.push({
        path: bruto['path'],
        type: bruto['type'],
        sha: typeof bruto['sha'] === 'string' ? bruto['sha'] : null,
        size: typeof bruto['size'] === 'number' ? bruto['size'] : null,
      })
    }
    return { entradas, truncada: dados.truncated === true }
  } catch {
    return null
  }
}

async function actionsFixadasPorSha(
  repository: string,
  fetchImpl: typeof fetch,
  token: string,
  arvore: ArvoreDoRepositorio | null,
  aoReceberRespostaRuim?: AoReceberRespostaRuim
): Promise<boolean | null> {
  try {
    // A árvore completa já diz se há workflow: sem nenhum, não há o que medir
    // e a listagem da pasta seria uma chamada à toa.
    if (arvore && !arvore.truncada && !arvore.entradas.some((e) => EH_WORKFLOW.test(e.path))) {
      return null
    }
    const resp = await pedirUrlSegura(
      `${GITHUB_API}/repos/${repository}/contents/.github/workflows`,
      fetchImpl,
      token,
      aoReceberRespostaRuim
    )
    if (!resp.ok) return null
    const arquivos = (await resp.json()) as Array<{ name: string; download_url?: string }>
    const yamls = arquivos.filter((a) => /\.ya?ml$/.test(a.name))
    if (yamls.length === 0) return null
    let semLer = false
    for (const arq of yamls) {
      const conteudo = arq.download_url ? await baixarTextoCru(arq.download_url, fetchImpl) : null
      if (conteudo === null) {
        semLer = true
        continue
      }
      // Qualquer Action por tag/branch reprova o repositório inteiro, mesmo que
      // outro arquivo não tenha podido ser lido.
      if (temActionNaoFixada(conteudo)) return false
    }
    return semLer ? null : true
  } catch {
    return null
  }
}

export async function coletarSegurancaDoRepositorio(deps: {
  repository: string
  defaultBranch: string
  token: string
  fetchImpl?: typeof fetch
  /** Só mede estes checks (para completar o que outra credencial não alcançou). */
  apenas?: ReadonlySet<keyof ChecksDeSeguranca>
  /** Chamado com cada resposta fora de 2xx da API (alimenta o freio de cota). */
  aoReceberRespostaRuim?: AoReceberRespostaRuim
}): Promise<ColetaDeSeguranca> {
  const f = deps.fetchImpl ?? fetchSemPermissao()
  const aviso = deps.aoReceberRespostaRuim
  const quer = (chave: keyof ChecksDeSeguranca) => !deps.apenas || deps.apenas.has(chave)

  const vazia: ColetaDeSeguranca = {
    checks: {
      branchProtection: null,
      actionsFixadasPorSha: null,
      permissaoPadraoDoToken: null,
      codeowners: null,
      securityMd: null,
      dependabotConfigurado: null,
    },
    informativos: { revisaoObrigatoria: null },
    arvore: null,
  }
  if (!repositorioValido(deps.repository) || !branchValido(deps.defaultBranch)) return vazia

  let branchProtection: boolean | null = null
  let revisaoObrigatoria: boolean | null = null
  if (quer('branchProtection')) {
    try {
      const resp = await pedirUrlSegura(
        `${GITHUB_API}/repos/${deps.repository}/branches/${encodeURIComponent(deps.defaultBranch)}/protection`,
        f,
        deps.token,
        aviso
      )
      if (resp.status === 404) {
        // "Branch not protected" é a ausência de proteção; qualquer outro 404
        // (branch ou repositório que a credencial não enxerga) não prova nada.
        const dados = (await resp.json().catch(() => null)) as { message?: unknown } | null
        const mensagem = typeof dados?.message === 'string' ? dados.message : ''
        if (/not protected/i.test(mensagem)) branchProtection = false
      } else if (resp.ok) {
        // 403 "Upgrade to GitHub Pro" (privado em plano grátis) e 403 de permissão
        // caem no `else`: o item fica FORA do denominador, nunca vira "falta".
        const dados = (await resp.json()) as {
          required_status_checks?: { contexts?: unknown; checks?: unknown } | null
          required_pull_request_reviews?: unknown
        }
        const exigidas = dados.required_status_checks
        branchProtection =
          Array.isArray(exigidas?.contexts) && exigidas.contexts.length > 0
            ? true
            : Array.isArray(exigidas?.checks) && exigidas.checks.length > 0
        revisaoObrigatoria = Boolean(dados.required_pull_request_reviews)
      }
    } catch {
      // best-effort: continua nulo
    }
  }

  let permissaoPadraoDoToken: 'read' | 'write' | null = null
  if (quer('permissaoPadraoDoToken')) {
    try {
      const resp = await pedirUrlSegura(
        `${GITHUB_API}/repos/${deps.repository}/actions/permissions/workflow`,
        f,
        deps.token,
        aviso
      )
      if (resp.ok) {
        const dados = (await resp.json()) as { default_workflow_permissions?: string }
        permissaoPadraoDoToken = dados.default_workflow_permissions === 'write' ? 'write' : 'read'
      }
    } catch {
      // best-effort: continua nulo
    }
  }

  // UMA chamada de árvore responde CODEOWNERS, SECURITY.md, o arquivo do
  // Dependabot e a lista de workflows; antes eram uma consulta por arquivo e só
  // a raiz era procurada.
  const precisaDaArvore =
    quer('codeowners') ||
    quer('securityMd') ||
    quer('dependabotConfigurado') ||
    quer('actionsFixadasPorSha')
  const arvore = precisaDaArvore
    ? await lerArvore(deps.repository, deps.defaultBranch, f, deps.token, aviso)
    : null

  return {
    checks: {
      branchProtection,
      actionsFixadasPorSha: quer('actionsFixadasPorSha')
        ? await actionsFixadasPorSha(deps.repository, f, deps.token, arvore, aviso)
        : null,
      permissaoPadraoDoToken,
      codeowners: quer('codeowners') ? presenteNaArvore(arvore, ARQUIVOS_DE_CODEOWNERS) : null,
      securityMd: quer('securityMd') ? presenteNaArvore(arvore, ARQUIVOS_DE_SECURITY) : null,
      dependabotConfigurado: quer('dependabotConfigurado')
        ? presenteNaArvore(arvore, ARQUIVOS_DO_DEPENDABOT)
        : null,
    },
    informativos: { revisaoObrigatoria },
    arvore,
  }
}

export async function coletarChecksDeSeguranca(
  deps: Parameters<typeof coletarSegurancaDoRepositorio>[0]
): Promise<ChecksDeSeguranca> {
  return (await coletarSegurancaDoRepositorio(deps)).checks
}

/** Os checks que ainda não foram medidos (nulos). */
export function checksNaoVerificados(checks: ChecksDeSeguranca): Set<keyof ChecksDeSeguranca> {
  return new Set(
    (Object.keys(checks) as Array<keyof ChecksDeSeguranca>).filter(
      (chave) => checks[chave] === null
    )
  )
}
