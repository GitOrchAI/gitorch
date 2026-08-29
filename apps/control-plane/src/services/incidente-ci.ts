// Os "olhos" do GitOrch para a infra do repositório do cliente: varre os
// workflows do Actions e o job do Dependabot e devolve ACHADOS tipados —
// nunca abre issue (D54, 29/08). Quem entende a causa é o RA; quem escreve a
// issue padrão Shrimp é o PO (ESTEIRA-T8). Aqui só coletamos e classificamos.
//
// Duas correções de método que moldam este arquivo (medidas 29/08):
//  1. IDENTIDADE ESTÁVEL — `wf:<workflow_id>`, NUNCA `run.name`. O nome da run
//     do Dependabot carrega "- Update #1544086901", que muda toda rodada; usá-lo
//     como fingerprint abria uma issue nova a cada varredura.
//  2. SÓ A ÚLTIMA RUN CONTA — olhamos `?branch=<default>&per_page=1`. O filtro
//     `?status=failure` devolve a falha ANTIGA mesmo depois de o workflow ter
//     se recuperado, e o sensor ficava "vendo" um incêndio já apagado.

import { fetchComTeto } from './fetch-com-teto.js'
import { fetchSemPermissao } from './guarda-de-autonomia.js'
import { GithubExecutionError } from './github-errors.js'
import {
  classificarFalhaDeInfra,
  type ClasseDeFalha,
  type MetaDoWorkflow,
} from './classificar-falha-de-infra.js'

const GITHUB_API = 'https://api.github.com'
const HOST_API_GITHUB = new URL(GITHUB_API).host
const SEGMENTO_VALIDO = /^[A-Za-z0-9._-]+$/

/** Conclusões de run que contam como "quebrou" (as demais são ruído). */
const CONCLUSOES_DE_FALHA = new Set(['failure', 'timed_out', 'startup_failure'])

/** Teto de achados por varredura — proteção contra tempestade. */
export const TETO_DE_ACHADOS_POR_VARREDURA = 20

/**
 * Teto de workflows cuja última run é conferida por varredura. Esta função é
 * alcançável pelo tique do relógio (wake do RA) sob `tickEmAndamento` — sem
 * teto, um repo com dezenas de workflows numa rede lenta prenderia a trava
 * (mesma classe de defeito que motivou `fetchComTeto`). Repos reais têm bem
 * menos que isto; o corte só protege o caso patológico.
 */
export const MAX_WORKFLOWS_POR_VARREDURA = 40

/** Quantas checagens de "última run" correm em paralelo (limita o relógio). */
const LOTE_DE_CHECAGEM_DE_RUN = 6

/** Quantos caracteres do fim do log entram na evidência. */
const CHARS_DE_LOG_NA_EVIDENCIA = 1_400
/** Quantos caracteres do YAML do workflow entram na evidência. */
const CHARS_DE_CONFIG_NA_EVIDENCIA = 700

export interface AchadoDeInfra {
  classe: ClasseDeFalha
  /** Dedup — `wf:<workflow_id>` | `dependabot:updates`. NUNCA o run.name. */
  identidadeEstavel: string
  titulo: string
  /** Este workflow trava o merge (é um check exigido / roda no gate)? */
  travaMerge: boolean
  /** Legível: tail do log da run que falhou + trecho do YAML do workflow. */
  evidencia: string
  /** Arquivo(s) de workflow envolvidos, para o RA/PO abrirem. */
  paths: string[]
}

export interface ColetarAchadosDeInfraOpts {
  /** `dono/repo` — vem do wingId do projeto (valor escolhido pelo cliente). */
  repository: string
  /** Credencial do cliente (a do produto não alcança o Actions do cliente). */
  githubToken: string
  /**
   * Contextos que a proteção do branch EXIGE. Se omitido, tentamos ler de
   * `/branches/{default}/protection/required_status_checks` (403/404 → []).
   */
  contextosQueTravamMerge?: string[]
  fetchImpl?: typeof fetch
  teto?: number
  onWarn?: (message: string) => void
}

interface WorkflowDaApi {
  id: number
  name: string
  path: string
  state: string
}

interface RunDaApi {
  id: number
  name?: string
  event?: string
  status?: string
  conclusion?: string | null
  path?: string
  html_url?: string
  run_started_at?: string
  created_at?: string
  head_branch?: string
}

function repositorioValido(repository: string): boolean {
  const partes = repository.split('/')
  if (partes.length !== 2) return false
  const [dono, nome] = partes
  if (!dono || !nome) return false
  if (!SEGMENTO_VALIDO.test(dono) || !SEGMENTO_VALIDO.test(nome)) return false
  if (dono.includes('..') || nome.includes('..')) return false
  return true
}

/**
 * A ÚNICA porta de saída de rede deste arquivo. A credencial do cliente vai
 * no cabeçalho de toda chamada; a checagem de host mora AQUI, não nos
 * chamadores, para que um caminho novo nasça protegido (mesmo padrão de
 * `pedirUrlSegura` em security-debt-collector.ts). Comparação de host
 * EXATA — `api.github.com.alheio` bate em startsWith mas é outro host.
 */
async function pedir(f: typeof fetch, token: string, caminho: string): Promise<Response> {
  const url = caminho.startsWith('http') ? caminho : `${GITHUB_API}${caminho}`
  let host: string
  try {
    host = new URL(url).host
  } catch {
    throw new GithubExecutionError(`incidente-ci: URL malformada (${caminho})`)
  }
  if (host !== HOST_API_GITHUB) {
    throw new GithubExecutionError('incidente-ci: recusado — URL fora do host da API do GitHub')
  }
  return f(url, {
    headers: {
      authorization: `token ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'gitorch',
      'x-github-api-version': '2022-11-28',
    },
  })
}

async function pedirJson<T>(f: typeof fetch, token: string, caminho: string): Promise<T> {
  const resp = await pedir(f, token, caminho)
  if (!resp.ok) {
    throw new GithubExecutionError(`incidente-ci: GET ${caminho} falhou (${resp.status})`)
  }
  return (await resp.json()) as T
}

/** Best-effort: devolve `''` em qualquer falha, nunca joga. */
async function pedirTextoOuVazio(f: typeof fetch, token: string, caminho: string): Promise<string> {
  try {
    const resp = await pedir(f, token, caminho)
    if (!resp.ok) return ''
    return await resp.text()
  } catch {
    return ''
  }
}

async function lerContextosExigidos(
  f: typeof fetch,
  token: string,
  repository: string,
  branch: string
): Promise<string[]> {
  try {
    const dados = await pedirJson<{ contexts?: string[] }>(
      f,
      token,
      `/repos/${repository}/branches/${encodeURIComponent(branch)}/protection/required_status_checks`
    )
    return Array.isArray(dados.contexts) ? dados.contexts : []
  } catch {
    // 403 (sem alcance) / 404 (branch sem proteção) — a classificação cai
    // na heurística de evento (push/pull_request → ci-do-cliente).
    return []
  }
}

/** Tail do log da run + trecho do YAML do workflow. Nunca joga. */
async function montarEvidencia(
  f: typeof fetch,
  token: string,
  repository: string,
  run: RunDaApi,
  wfPath: string,
  branch: string,
  yamlDoWorkflow: string
): Promise<string> {
  const partes: string[] = []

  let logTail = ''
  try {
    const jobs = await pedirJson<{ jobs?: Array<{ id: number; conclusion?: string | null }> }>(
      f,
      token,
      `/repos/${repository}/actions/runs/${run.id}/jobs?per_page=20`
    )
    const jobQuebrado = (jobs.jobs ?? []).find((j) => CONCLUSOES_DE_FALHA.has(j.conclusion ?? ''))
    if (jobQuebrado) {
      const texto = await pedirTextoOuVazio(
        f,
        token,
        `/repos/${repository}/actions/jobs/${jobQuebrado.id}/logs`
      )
      if (texto) logTail = texto.slice(-CHARS_DE_LOG_NA_EVIDENCIA)
    }
  } catch {
    // segue sem o log
  }

  if (logTail) {
    partes.push('### Fim do log da run que falhou', '```', logTail.trimEnd(), '```')
  } else if (run.html_url) {
    partes.push(`### Run que falhou\n${run.html_url} (log não recuperado pela API)`)
  }

  const yaml = yamlDoWorkflow || (await pedirConteudo(f, token, repository, wfPath, branch))
  if (yaml) {
    partes.push(
      `### ${wfPath}`,
      '```yaml',
      yaml.slice(0, CHARS_DE_CONFIG_NA_EVIDENCIA).trimEnd(),
      '```'
    )
  }

  return partes.join('\n\n')
}

/** Conteúdo de um arquivo do repo, decodificado. `''` em qualquer falha. */
async function pedirConteudo(
  f: typeof fetch,
  token: string,
  repository: string,
  caminho: string,
  branch: string
): Promise<string> {
  try {
    const dados = await pedirJson<{ content?: string; encoding?: string }>(
      f,
      token,
      `/repos/${repository}/contents/${caminho}?ref=${encodeURIComponent(branch)}`
    )
    if (dados.encoding === 'base64' && dados.content) {
      return Buffer.from(dados.content, 'base64').toString('utf8')
    }
    return typeof dados.content === 'string' ? dados.content : ''
  } catch {
    return ''
  }
}

function travaMergePorNome(
  contextos: string[],
  wfName: string,
  wfBase: string,
  event: string
): boolean {
  const semExt = wfBase.replace(/\.ya?ml$/, '')
  const casaContexto = contextos.some(
    (c) => c === wfName || c.includes(semExt) || semExt.includes(c) || c.includes(wfBase)
  )
  return casaContexto || event === 'push' || event === 'pull_request'
}

/**
 * Varre workflows + job do Dependabot e devolve achados tipados. Best-effort
 * por contrato: uma rota que falha vira `onWarn`, nunca derruba a coleta.
 */
export async function coletarAchadosDeInfra(
  opts: ColetarAchadosDeInfraOpts
): Promise<AchadoDeInfra[]> {
  const warn = opts.onWarn ?? (() => undefined)
  if (!repositorioValido(opts.repository)) {
    warn(`incidente-ci: repository inválido (${opts.repository})`)
    return []
  }
  // `fetchSemPermissao` mesmo aqui, que hoje só lê: leitura passa, e no dia em
  // que alguém acrescentar uma escrita neste arquivo ela já nasce barrada.
  const f = fetchComTeto(opts.fetchImpl ?? fetchSemPermissao())
  const token = opts.githubToken
  const teto = opts.teto ?? TETO_DE_ACHADOS_POR_VARREDURA
  const achados: AchadoDeInfra[] = []

  // Branch default do repo — o `?branch=` do Actions não aceita o literal
  // "default", precisa do nome real.
  let branch = 'main'
  try {
    const repo = await pedirJson<{ default_branch?: string }>(f, token, `/repos/${opts.repository}`)
    if (repo.default_branch) branch = repo.default_branch
  } catch (err) {
    warn(`incidente-ci: não li o branch default (${String(err).slice(0, 120)})`)
  }

  const contextos =
    opts.contextosQueTravamMerge ?? (await lerContextosExigidos(f, token, opts.repository, branch))

  // --- Workflows do Actions ---------------------------------------------
  let workflows: WorkflowDaApi[] = []
  try {
    const dados = await pedirJson<{ workflows?: WorkflowDaApi[] }>(
      f,
      token,
      `/repos/${opts.repository}/actions/workflows?per_page=100`
    )
    workflows = dados.workflows ?? []
  } catch (err) {
    warn(`incidente-ci: lista de workflows falhou (${String(err).slice(0, 120)})`)
  }

  // Workflows implícitos do GitHub (pages-build-deployment, Dependabot Updates)
  // não têm arquivo — o job do Dependabot é tratado à parte.
  const workflowsComArquivo = workflows
    .filter((wf) => wf.path && wf.path.startsWith('.github/workflows/'))
    .slice(0, MAX_WORKFLOWS_POR_VARREDURA)
  if (workflows.length > MAX_WORKFLOWS_POR_VARREDURA) {
    warn(
      `incidente-ci: ${workflows.length} workflows em ${opts.repository}; conferindo os primeiros ${MAX_WORKFLOWS_POR_VARREDURA}`
    )
  }

  // A checagem da "última run" de cada workflow é uma chamada independente por
  // workflow. Sequencial, num repo com dezenas de workflows e rede lenta, isso
  // prenderia a trava do tique (`fetchComTeto` já dá teto de 10s por chamada,
  // mas 30×10s ainda é muito). Em lotes paralelos o relógio fica limitado a
  // ~ceil(N/LOTE)×10s no pior caso.
  const ultimaRunPorWorkflow = new Map<number, RunDaApi | undefined>()
  for (let i = 0; i < workflowsComArquivo.length; i += LOTE_DE_CHECAGEM_DE_RUN) {
    const lote = workflowsComArquivo.slice(i, i + LOTE_DE_CHECAGEM_DE_RUN)
    const resultados = await Promise.all(
      lote.map(async (wf) => {
        try {
          const dados = await pedirJson<{ workflow_runs?: RunDaApi[] }>(
            f,
            token,
            `/repos/${opts.repository}/actions/workflows/${wf.id}/runs?branch=${encodeURIComponent(
              branch
            )}&per_page=1`
          )
          return [wf.id, dados.workflow_runs?.[0]] as const
        } catch (err) {
          warn(`incidente-ci: runs de ${wf.path} falharam (${String(err).slice(0, 120)})`)
          return [wf.id, undefined] as const
        }
      })
    )
    for (const [id, run] of resultados) ultimaRunPorWorkflow.set(id, run)
  }

  for (const wf of workflowsComArquivo) {
    if (achados.length >= teto) break

    const ultima = ultimaRunPorWorkflow.get(wf.id)
    if (!ultima) continue
    if (ultima.status !== 'completed') continue
    if (!CONCLUSOES_DE_FALHA.has(ultima.conclusion ?? '')) continue

    const yaml = await pedirConteudo(f, token, opts.repository, wf.path, branch)
    const meta: MetaDoWorkflow = {
      state: wf.state,
      ...(ultima.run_started_at || ultima.created_at
        ? { ultimaRunEm: ultima.run_started_at ?? ultima.created_at }
        : {}),
    }
    const evento = ultima.event ?? ''
    const classe = classificarFalhaDeInfra(
      { path: wf.path, event: evento, name: ultima.name ?? wf.name },
      meta,
      contextos,
      yaml
    )
    const wfBase = wf.path.split('/').pop() ?? wf.path
    achados.push({
      classe,
      identidadeEstavel: `wf:${wf.id}`,
      titulo: `Workflow "${wf.name}" falhou na ${branch}`,
      travaMerge: travaMergePorNome(contextos, wf.name, wfBase, evento),
      evidencia: await montarEvidencia(f, token, opts.repository, ultima, wf.path, branch, yaml),
      paths: [wf.path],
    })
  }

  // --- Job do Dependabot (dynamic/dependabot/dependabot-updates) ---------
  // NÃO existe API para o log de version-update do Dependabot — só a UI. O
  // que dá para ver é se a ÚLTIMA run do job terminou em falha.
  if (achados.length < teto) {
    try {
      const dados = await pedirJson<{ workflow_runs?: RunDaApi[] }>(
        f,
        token,
        `/repos/${opts.repository}/actions/runs?per_page=30`
      )
      const doDependabot = (dados.workflow_runs ?? [])
        .filter((r) => (r.path ?? '').startsWith('dynamic/dependabot/'))
        .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
      const ultima = doDependabot[0]
      if (
        ultima &&
        ultima.status === 'completed' &&
        CONCLUSOES_DE_FALHA.has(ultima.conclusion ?? '')
      ) {
        const dependabotYml = await pedirConteudo(
          f,
          token,
          opts.repository,
          '.github/dependabot.yml',
          branch
        )
        achados.push({
          classe: 'dependabot-travado',
          identidadeEstavel: 'dependabot:updates',
          titulo: 'O Dependabot está falhando ao atualizar dependências',
          travaMerge: false,
          evidencia: [
            `A última execução do updater do Dependabot terminou em \`${ultima.conclusion}\`.`,
            ultima.html_url ? `Run: ${ultima.html_url}` : '',
            'Não há API para o log deste job — a causa raiz sai da aba Actions → Dependabot na UI.',
            dependabotYml
              ? `\n### .github/dependabot.yml\n\`\`\`yaml\n${dependabotYml
                  .slice(0, CHARS_DE_CONFIG_NA_EVIDENCIA)
                  .trimEnd()}\n\`\`\``
              : '',
          ]
            .filter(Boolean)
            .join('\n'),
          paths: ['.github/dependabot.yml'],
        })
      }
    } catch (err) {
      warn(`incidente-ci: leitura do job do Dependabot falhou (${String(err).slice(0, 120)})`)
    }
  }

  return achados
}
