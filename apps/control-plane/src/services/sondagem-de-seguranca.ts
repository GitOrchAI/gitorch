// A sondagem do que um repositório PODE receber em segurança, lida do próprio
// GitHub e não suposta pelo plano da conta.
//
// Cada recurso é lido onde ele vive e o resultado é um de quatro:
//  - `ligado` / `desligado`: o recurso existe neste repositório e está assim;
//  - `indisponivel`: o GitHub disse que não existe aqui (plano grátis em
//    repositório privado, sem Advanced Security, linguagem sem suporte);
//  - `desconhecido`: a credencial não alcança (sem administração), ou a leitura
//    falhou. NUNCA vira "desligado": o que não se sabe não vira escrita.
//
// O resultado fica em cache por projeto (uma ficha `sondagem`): a sondagem custa
// de 7 a 7+N leituras (N = workflows) e não muda a cada minuto. Só LÊ.

import type { Prisma } from '@prisma/client'
import type { PrismaDeFichas } from './prisma-de-fichas-de-seguranca.js'
import { repositorioValido } from './nota-de-seguranca.js'
import {
  campoDe,
  criarLeitorDeSeguranca,
  erroDeRedeSeguro,
  type AoReceberRespostaRuim,
  type RespostaDoGitHub,
} from './leitor-de-seguranca.js'
import { analisarWorkflow, caminhoDeWorkflowValido } from './workflows-de-seguranca.js'
import { limparSurrogatesEmJson } from './texto-seguro.js'

export const VALIDADE_DA_SONDAGEM_MS = 24 * 60 * 60_000
const MAXIMO_DE_WORKFLOWS = 30

export type EstadoDoRecurso = 'ligado' | 'desligado' | 'indisponivel' | 'desconhecido'

export interface WorkflowSondado {
  caminho: string
  declaraPermissoes: boolean | null
  ehDeploy: boolean
  seguroParaPermissaoMinima: boolean
  motivoDeNaoSeguro: string | null
  temGitleaks: boolean
  temCodeql: boolean
}

export interface WorkflowsSondados {
  /** `ausente` = o repositório não tem a pasta; `erro` = não deu para ler. */
  estado: 'lidos' | 'ausente' | 'erro'
  /** Havia mais workflows do que o teto: o que não foi lido não é "ok". */
  truncado: boolean
  itens: WorkflowSondado[]
}

export interface SondagemDoRepositorio {
  versao: 1
  repositorio: string
  sondadoEm: string
  /** A origem da credencial que sondou (nunca o token). */
  credencial: string
  /** A credencial provou ter administração do repositório. */
  comAdmin: boolean
  privado: boolean | null
  branchPadrao: string | null
  segredos: EstadoDoRecurso
  bloqueioDePush: EstadoDoRecurso
  alertasDeDependencias: EstadoDoRecurso
  atualizacoesDeSeguranca: EstadoDoRecurso
  varreduraDeCodigo: EstadoDoRecurso
  /** Famílias de linguagem do CodeQL que o repositório usa. */
  linguagensSuportadas: string[]
  permissaoDoWorkflow: 'read' | 'write' | null
  podeAprovarPrs: boolean | null
  workflows: WorkflowsSondados
}

export interface CredencialDaSondagem {
  /** Para o log ("cliente ou dono", "App do produto"); nunca o token. */
  origem: string
  token: string
}

const FAMILIAS_DO_CODEQL: Record<string, string> = {
  JavaScript: 'javascript-typescript',
  TypeScript: 'javascript-typescript',
  Python: 'python',
  Go: 'go',
  Ruby: 'ruby',
  Java: 'java-kotlin',
  Kotlin: 'java-kotlin',
  'C#': 'csharp',
  C: 'c-cpp',
  'C++': 'c-cpp',
  Swift: 'swift',
}

const MENSAGEM_DE_PLANO =
  /(upgrade to github|advanced security|code security|secret protection|not available|is not enabled|must be enabled|public repositor)/i

/** O GitHub disse que o recurso não existe neste repositório (e não que falta permissão)? */
export function respostaDizIndisponivel(r: Pick<RespostaDoGitHub, 'status' | 'mensagem'>): boolean {
  if (r.status !== 403 && r.status !== 404 && r.status !== 422) return false
  return r.mensagem !== null && MENSAGEM_DE_PLANO.test(r.mensagem)
}

function estadoDeSecurityAndAnalysis(valor: unknown): 'ligado' | 'desligado' | null {
  if (valor === 'enabled') return 'ligado'
  if (valor === 'disabled') return 'desligado'
  return null
}

function linguagensSuportadasDe(corpo: unknown): string[] {
  if (typeof corpo !== 'object' || corpo === null) return []
  const familias = new Set<string>()
  for (const nome of Object.keys(corpo)) {
    const familia = Object.hasOwn(FAMILIAS_DO_CODEQL, nome) ? FAMILIAS_DO_CODEQL[nome] : undefined
    if (familia) familias.add(familia)
  }
  return [...familias].sort()
}

/** A leitura não terminou (rede, 5xx, limite de taxa): a sondagem inteira é descartada. */
class LeituraIncompleta extends Error {
  constructor(mensagem: string) {
    super(mensagem)
    this.name = 'LeituraIncompleta'
  }
}

async function sondarWorkflows(
  ler: (caminho: string) => Promise<RespostaDoGitHub>,
  maximo: number
): Promise<WorkflowsSondados> {
  const lista = await ler('/contents/.github/workflows')
  if (lista.limitada || lista.status >= 500) {
    throw new LeituraIncompleta(
      `leitura incompleta: o GitHub respondeu ${lista.status} ao listar os workflows`
    )
  }
  if (lista.status === 404) return { estado: 'ausente', truncado: false, itens: [] }
  if (!lista.ok || !Array.isArray(lista.corpo))
    return { estado: 'erro', truncado: false, itens: [] }

  const caminhos = lista.corpo
    .map((entrada) => campoDe(entrada, 'path'))
    .filter((p): p is string => typeof p === 'string' && caminhoDeWorkflowValido(p))
    .sort()
  const lidos = caminhos.slice(0, maximo)
  const itens: WorkflowSondado[] = []
  for (const caminho of lidos) {
    let texto: string | null = null
    try {
      const arquivo = await ler(`/contents/${caminho}`)
      if (arquivo.limitada)
        throw new LeituraIncompleta('leitura incompleta: limite de taxa ao ler um workflow')
      const conteudo = campoDe(arquivo.corpo, 'content')
      if (
        arquivo.ok &&
        typeof conteudo === 'string' &&
        campoDe(arquivo.corpo, 'encoding') === 'base64'
      ) {
        texto = Buffer.from(conteudo, 'base64').toString('utf8')
      }
    } catch (erro) {
      if (erro instanceof LeituraIncompleta) throw erro
      if (erro instanceof DOMException && erro.name === 'AbortError') throw erro
      texto = null
    }
    if (texto === null) {
      itens.push({
        caminho,
        declaraPermissoes: null,
        ehDeploy: analisarWorkflow(caminho, '').ehDeploy,
        seguroParaPermissaoMinima: false,
        motivoDeNaoSeguro: 'não consegui ler o arquivo',
        temGitleaks: false,
        temCodeql: false,
      })
      continue
    }
    itens.push(analisarWorkflow(caminho, texto))
  }
  return { estado: 'lidos', truncado: caminhos.length > lidos.length, itens }
}

/**
 * Sonda UM repositório com UMA credencial. Lança se não conseguir ler o próprio
 * repositório (sem isso não há sondagem a guardar); o resto que falhar vira
 * `desconhecido`.
 */
export async function sondarRepositorio(deps: {
  repositorio: string
  credencial: CredencialDaSondagem
  fetchImpl: typeof fetch
  agora: Date
  aoReceberRespostaRuim?: AoReceberRespostaRuim
  maximoDeWorkflows?: number
}): Promise<SondagemDoRepositorio> {
  const ler = criarLeitorDeSeguranca({
    repositorio: deps.repositorio,
    token: deps.credencial.token,
    fetchImpl: deps.fetchImpl,
    ...(deps.aoReceberRespostaRuim ? { aoReceberRespostaRuim: deps.aoReceberRespostaRuim } : {}),
  })
  // Uma leitura que não terminou (rede, 5xx, limite de taxa) NÃO vira "desconhecido" num
  // cache de um dia: a sondagem inteira é descartada e tentada de novo depois.
  const segura = async (caminho: string): Promise<RespostaDoGitHub> => {
    let r: RespostaDoGitHub
    try {
      r = await ler(caminho)
    } catch (erro) {
      if (erro instanceof DOMException && erro.name === 'AbortError') throw erro
      throw new LeituraIncompleta(
        `leitura incompleta de ${deps.repositorio}: ${erroDeRedeSeguro(erro, deps.credencial.token)}`
      )
    }
    if (r.limitada || r.status >= 500) {
      throw new LeituraIncompleta(
        `leitura incompleta de ${deps.repositorio}: o GitHub respondeu ${r.status}`
      )
    }
    return r
  }

  let repo: RespostaDoGitHub
  try {
    repo = await ler('')
  } catch (erro) {
    throw new Error(
      `não consegui ler ${deps.repositorio}: ${erroDeRedeSeguro(erro, deps.credencial.token)}`
    )
  }
  if (!repo.ok) {
    throw new Error(`o GitHub respondeu ${repo.status} ao ler ${deps.repositorio}`)
  }

  const privadoBruto = campoDe(repo.corpo, 'private')
  const privado = typeof privadoBruto === 'boolean' ? privadoBruto : null
  const branchBruto = campoDe(repo.corpo, 'default_branch')
  const branchPadrao = typeof branchBruto === 'string' && branchBruto !== '' ? branchBruto : null
  const sa = campoDe(repo.corpo, 'security_and_analysis')
  const comAdmin =
    campoDe(repo.corpo, 'permissions', 'admin') === true || (typeof sa === 'object' && sa !== null)

  // Segredos e bloqueio de push saem do próprio retrato do repositório.
  let segredos: EstadoDoRecurso = 'desconhecido'
  let bloqueioDePush: EstadoDoRecurso = 'desconhecido'
  if (privado === true) {
    // Em privado o recurso é pago (Advanced Security): sem ele, não existe.
    const gas = estadoDeSecurityAndAnalysis(campoDe(sa, 'advanced_security', 'status'))
    const segredosVistos = estadoDeSecurityAndAnalysis(campoDe(sa, 'secret_scanning', 'status'))
    if (comAdmin && (gas === 'ligado' || segredosVistos === 'ligado')) {
      segredos = segredosVistos ?? 'desligado'
      bloqueioDePush =
        estadoDeSecurityAndAnalysis(campoDe(sa, 'secret_scanning_push_protection', 'status')) ??
        'desligado'
    } else if (comAdmin) {
      segredos = 'indisponivel'
      bloqueioDePush = 'indisponivel'
    }
  } else if (privado === false) {
    segredos =
      estadoDeSecurityAndAnalysis(campoDe(sa, 'secret_scanning', 'status')) ?? 'desconhecido'
    bloqueioDePush =
      estadoDeSecurityAndAnalysis(campoDe(sa, 'secret_scanning_push_protection', 'status')) ??
      'desconhecido'
  }

  // Alertas do Dependabot: 204 ligado, 404 "disabled" desligado.
  let alertasDeDependencias: EstadoDoRecurso = 'desconhecido'
  const alertas = await segura('/vulnerability-alerts')
  if (alertas.status === 204 || alertas.status === 200) alertasDeDependencias = 'ligado'
  else if (alertas.status === 404 && comAdmin) alertasDeDependencias = 'desligado'
  else if (respostaDizIndisponivel(alertas)) alertasDeDependencias = 'indisponivel'

  let atualizacoesDeSeguranca: EstadoDoRecurso = 'desconhecido'
  const correcoes = await segura('/automated-security-fixes')
  if (correcoes.ok) {
    const ativo = campoDe(correcoes.corpo, 'enabled')
    if (ativo === true) atualizacoesDeSeguranca = 'ligado'
    else if (ativo === false) atualizacoesDeSeguranca = 'desligado'
  } else if (correcoes.status === 404 && comAdmin) atualizacoesDeSeguranca = 'desligado'
  else if (respostaDizIndisponivel(correcoes)) atualizacoesDeSeguranca = 'indisponivel'

  const linguagens = await segura('/languages')
  const linguagensSuportadas = linguagens.ok ? linguagensSuportadasDe(linguagens.corpo) : []

  const workflowsLidos = await sondarWorkflowsSeguro(
    ler,
    deps.maximoDeWorkflows ?? MAXIMO_DE_WORKFLOWS
  )

  // Varredura de código: só existe onde o GitHub aceita, a linguagem tem suporte
  // e nenhum workflow do CodeQL ocupa o lugar do "default setup".
  let varreduraDeCodigo: EstadoDoRecurso = 'desconhecido'
  const codigo = await segura('/code-scanning/default-setup')
  if (codigo.ok) {
    const estado = campoDe(codigo.corpo, 'state')
    if (estado === 'configured') varreduraDeCodigo = 'ligado'
    else if (estado === 'not-configured') {
      const jaTemCodeql = workflowsLidos.itens.some((w) => w.temCodeql)
      varreduraDeCodigo =
        linguagensSuportadas.length === 0 || jaTemCodeql ? 'indisponivel' : 'desligado'
    }
  } else if (respostaDizIndisponivel(codigo) || (codigo.status === 404 && comAdmin)) {
    varreduraDeCodigo = 'indisponivel'
  }

  let permissaoDoWorkflow: 'read' | 'write' | null = null
  let podeAprovarPrs: boolean | null = null
  const permissao = await segura('/actions/permissions/workflow')
  if (permissao.ok) {
    const padrao = campoDe(permissao.corpo, 'default_workflow_permissions')
    if (padrao === 'read' || padrao === 'write') permissaoDoWorkflow = padrao
    const aprova = campoDe(permissao.corpo, 'can_approve_pull_request_reviews')
    if (typeof aprova === 'boolean') podeAprovarPrs = aprova
  }

  return {
    versao: 1,
    repositorio: deps.repositorio,
    sondadoEm: deps.agora.toISOString(),
    credencial: deps.credencial.origem,
    comAdmin,
    privado,
    branchPadrao,
    segredos,
    bloqueioDePush,
    alertasDeDependencias,
    atualizacoesDeSeguranca,
    varreduraDeCodigo,
    linguagensSuportadas,
    permissaoDoWorkflow,
    podeAprovarPrs,
    workflows: workflowsLidos,
  }
}

async function sondarWorkflowsSeguro(
  ler: (caminho: string) => Promise<RespostaDoGitHub>,
  maximo: number
): Promise<WorkflowsSondados> {
  try {
    return await sondarWorkflows(ler, maximo)
  } catch (erro) {
    if (erro instanceof LeituraIncompleta) throw erro
    if (erro instanceof DOMException && erro.name === 'AbortError') throw erro
    return { estado: 'erro', truncado: false, itens: [] }
  }
}

/** O recurso de varredura de senhas existe neste repositório? Público sempre; privado só se a sondagem o viu. */
export function recursoDeSegredosDisponivel(s: SondagemDoRepositorio): boolean {
  if (s.privado === false) return true
  if (s.privado === null) return false
  return s.segredos === 'ligado' || s.segredos === 'desligado'
}

// ------------------------------------------------------------------ cache

/** Só o que o cache precisa do Prisma. */
export interface PrismaDaSondagem {
  repoItem: Pick<PrismaDeFichas['repoItem'], 'findUnique' | 'upsert'>
}

const TIPO_DA_SONDAGEM = 'sondagem'

const ESTADOS_DO_RECURSO: readonly string[] = [
  'ligado',
  'desligado',
  'indisponivel',
  'desconhecido',
]
const ehEstadoDoRecurso = (v: unknown): v is EstadoDoRecurso =>
  typeof v === 'string' && ESTADOS_DO_RECURSO.includes(v)

function ehWorkflowSondado(v: unknown): v is WorkflowSondado {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof campoDe(v, 'caminho') === 'string' &&
    caminhoDeWorkflowValido(campoDe(v, 'caminho') as string) &&
    (campoDe(v, 'declaraPermissoes') === null ||
      typeof campoDe(v, 'declaraPermissoes') === 'boolean') &&
    typeof campoDe(v, 'ehDeploy') === 'boolean' &&
    typeof campoDe(v, 'seguroParaPermissaoMinima') === 'boolean' &&
    typeof campoDe(v, 'temGitleaks') === 'boolean' &&
    typeof campoDe(v, 'temCodeql') === 'boolean'
  )
}

/** Valida o JSON guardado: nada que veio do banco é confiado sem conferir. */
export function lerSondagemDoJson(bruto: unknown): SondagemDoRepositorio | null {
  const s = campoDe(bruto, 'sondagem')
  if (typeof s !== 'object' || s === null) return null
  const workflows = campoDe(s, 'workflows')
  const itens = campoDe(workflows, 'itens')
  if (
    campoDe(s, 'versao') !== 1 ||
    typeof campoDe(s, 'repositorio') !== 'string' ||
    typeof campoDe(s, 'sondadoEm') !== 'string' ||
    Number.isNaN(Date.parse(campoDe(s, 'sondadoEm') as string)) ||
    typeof campoDe(s, 'credencial') !== 'string' ||
    typeof campoDe(s, 'comAdmin') !== 'boolean' ||
    !ehEstadoDoRecurso(campoDe(s, 'segredos')) ||
    !ehEstadoDoRecurso(campoDe(s, 'bloqueioDePush')) ||
    !ehEstadoDoRecurso(campoDe(s, 'alertasDeDependencias')) ||
    !ehEstadoDoRecurso(campoDe(s, 'atualizacoesDeSeguranca')) ||
    !ehEstadoDoRecurso(campoDe(s, 'varreduraDeCodigo')) ||
    !Array.isArray(campoDe(s, 'linguagensSuportadas')) ||
    !['lidos', 'ausente', 'erro'].includes(String(campoDe(workflows, 'estado'))) ||
    typeof campoDe(workflows, 'truncado') !== 'boolean' ||
    !Array.isArray(itens) ||
    !itens.every(ehWorkflowSondado)
  ) {
    return null
  }
  return s as SondagemDoRepositorio
}

export async function lerSondagemEmCache(
  prisma: PrismaDaSondagem,
  projectId: string,
  agora: Date,
  opcoes: { exigirAdmin?: boolean; onWarn?: (m: string) => void } = {}
): Promise<SondagemDoRepositorio | null> {
  try {
    const ficha = await prisma.repoItem.findUnique({
      where: { projectId_tipo_numero: { projectId, tipo: TIPO_DA_SONDAGEM, numero: 0 } },
    })
    const sondagem = lerSondagemDoJson(ficha?.estado)
    if (!sondagem) return null
    const idade = agora.getTime() - Date.parse(sondagem.sondadoEm)
    if (idade < 0 || idade >= VALIDADE_DA_SONDAGEM_MS) return null
    if (opcoes.exigirAdmin && !sondagem.comAdmin) return null
    return sondagem
  } catch (erro) {
    opcoes.onWarn?.(
      `sondagem de segurança: não consegui ler o cache: ${erroDeRedeSeguro(erro, '')}`
    )
    return null
  }
}

export async function gravarSondagem(
  prisma: PrismaDaSondagem,
  projectId: string,
  sondagem: SondagemDoRepositorio
): Promise<void> {
  const estado = limparSurrogatesEmJson({
    sondagem,
  }) as unknown as Prisma.InputJsonObject
  await prisma.repoItem.upsert({
    where: { projectId_tipo_numero: { projectId, tipo: TIPO_DA_SONDAGEM, numero: 0 } },
    create: { projectId, tipo: TIPO_DA_SONDAGEM, numero: 0, estado },
    update: { estado },
  })
}

/** Marca o cache como vencido (o que a sondagem viu mudou): a próxima leitura sonda de novo. */
export async function invalidarSondagem(
  prisma: PrismaDaSondagem,
  projectId: string
): Promise<void> {
  const estado: Prisma.InputJsonObject = { invalidada: true }
  await prisma.repoItem.upsert({
    where: { projectId_tipo_numero: { projectId, tipo: TIPO_DA_SONDAGEM, numero: 0 } },
    create: { projectId, tipo: TIPO_DA_SONDAGEM, numero: 0, estado },
    update: { estado },
  })
}

export interface ResultadoDaObtencao {
  sondagem: SondagemDoRepositorio
  deCache: boolean
  /** A credencial que sondou (a que provou admin, se alguma provou). */
  credencial: CredencialDaSondagem
}

/**
 * O cache do dia, ou uma sondagem nova com as credenciais na ordem dada (a do
 * cliente primeiro): a primeira que prova administração vale; se nenhuma provar
 * e `exigirAdmin` não for pedido, vale a primeira que leu. `null` quando
 * nenhuma conseguiu ler (e então nada é gravado).
 */
export async function obterSondagem(deps: {
  prisma: PrismaDaSondagem
  projectId: string
  repositorio: string
  credenciais: readonly CredencialDaSondagem[]
  fetchImpl: typeof fetch
  agora: Date
  exigirAdmin: boolean
  aoReceberRespostaRuim?: AoReceberRespostaRuim
  onWarn?: (mensagem: string) => void
}): Promise<ResultadoDaObtencao | null> {
  if (!repositorioValido(deps.repositorio)) {
    deps.onWarn?.(`sondagem de segurança: ${deps.repositorio} não tem o formato dono/repo`)
    return null
  }
  const emCache = await lerSondagemEmCache(deps.prisma, deps.projectId, deps.agora, {
    exigirAdmin: deps.exigirAdmin,
    ...(deps.onWarn ? { onWarn: deps.onWarn } : {}),
  })
  if (emCache) {
    const credencial = deps.credenciais.find((c) => c.origem === emCache.credencial) ??
      deps.credenciais[0] ?? { origem: emCache.credencial, token: '' }
    return { sondagem: emCache, deCache: true, credencial }
  }

  let melhor: ResultadoDaObtencao | null = null
  for (const credencial of deps.credenciais) {
    try {
      const sondagem = await sondarRepositorio({
        repositorio: deps.repositorio,
        credencial,
        fetchImpl: deps.fetchImpl,
        agora: deps.agora,
        ...(deps.aoReceberRespostaRuim
          ? { aoReceberRespostaRuim: deps.aoReceberRespostaRuim }
          : {}),
      })
      const resultado = { sondagem, deCache: false, credencial }
      if (sondagem.comAdmin) {
        melhor = resultado
        break
      }
      melhor ??= resultado
    } catch (erro) {
      if (erro instanceof DOMException && erro.name === 'AbortError') throw erro
      deps.onWarn?.(
        `sondagem de segurança de ${deps.repositorio} (${credencial.origem}): ${erroDeRedeSeguro(erro, credencial.token)}`
      )
    }
  }
  if (!melhor) return null
  if (deps.exigirAdmin && !melhor.sondagem.comAdmin) {
    deps.onWarn?.(
      `sondagem de segurança de ${deps.repositorio}: nenhuma credencial provou administração; só leitura`
    )
  }
  try {
    await gravarSondagem(deps.prisma, deps.projectId, melhor.sondagem)
  } catch (erro) {
    deps.onWarn?.(
      `sondagem de segurança de ${deps.repositorio}: não consegui gravar o cache: ${erroDeRedeSeguro(erro, '')}`
    )
  }
  return melhor
}
