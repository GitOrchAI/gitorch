// A credencial que o cliente fornece é a única chave que alcança o que o App
// do produto não alcança: quadro de conta pessoal e qualquer rota de
// segurança. Antes de guardá-la, conferir que ela serve — descobrir isso na
// hora de usar significaria descobrir com o cliente já fora da tela.

import { decryptCredential, encryptCredential } from '../lib/credential-crypto.js'

const GITHUB_API = 'https://api.github.com'

// Única chamada externa da rota de verificação — síncrona, com o cliente
// esperando na tela do wizard. 10s é generoso o bastante para absorver uma
// lentidão transitória do GitHub (latência típica desta rota é bem abaixo de
// 1s) sem deixar o cliente preso indefinidamente numa API que não vai
// responder.
const VERIFICACAO_TIMEOUT_MS = 10_000

/** Escopos sem os quais a credencial não cumpre o que foi prometido. */
const ESCOPOS_EXIGIDOS = ['repo', 'project'] as const

export type EscopoFaltante = (typeof ESCOPOS_EXIGIDOS)[number]

export interface CredencialVerificada {
  login: string
  escopos: string[]
  faltando: EscopoFaltante[]
}

/** Falha em COMUNICAR com o GitHub (instabilidade, rate limit, 5xx) — nunca
 *  culpa da credencial em si. Distinta do `null` de verificarCredencial (que
 *  é reservado para credencial que realmente não autentica): confundir as
 *  duas diria ao cliente "sua credencial está errada" quando o problema é do
 *  GitHub estar fora do ar. */
export class VerificacaoIndisponivelError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VerificacaoIndisponivelError'
  }
}

export async function verificarCredencial(deps: {
  token: string
  fetchImpl?: typeof fetch
  /** Override só para teste — não faz sentido esperar o timeout de produção
   *  rodar de verdade numa suíte. */
  timeoutMs?: number
}): Promise<CredencialVerificada | null> {
  const f = deps.fetchImpl ?? fetch
  const timeoutMs = deps.timeoutMs ?? VERIFICACAO_TIMEOUT_MS
  let resp: Response
  try {
    resp = await f(`${GITHUB_API}/user`, {
      headers: {
        Authorization: `Bearer ${deps.token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'gitorch',
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    // AbortSignal.timeout aborta com um TimeoutError (confirmado contra o
    // fetch nativo do Node) — distinto de um abort manual. Estouro de tempo
    // é indisponibilidade do GitHub, não credencial inválida: usa o mesmo
    // VerificacaoIndisponivelError que já cobre rate limit/5xx, para o
    // cliente nunca ouvir "sua credencial está errada" quando o problema é
    // a rede.
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new VerificacaoIndisponivelError(
        `GitHub não respondeu em ${timeoutMs}ms ao tentar verificar a credencial`
      )
    }
    throw err
  }

  if (!resp.ok) {
    // 401 é a única resposta que a API do GitHub reserva para credencial
    // inválida/expirada neste endpoint (a mesma garantia que
    // classifyGithubApiError usa em setup-errors.ts). Qualquer outro status
    // de falha (rate limit, 5xx) é o GitHub instável, não a credencial.
    if (resp.status === 401) return null
    throw new VerificacaoIndisponivelError(
      `GitHub respondeu ${resp.status} ao tentar verificar a credencial`
    )
  }

  const corpo = (await resp.json()) as { login?: string }
  // Credencial de formato novo não declara escopos neste cabeçalho. Ausência é
  // "não sei", e "não sei" conta como faltando — nunca como autorizado.
  const bruto = resp.headers.get('x-oauth-scopes') ?? ''
  const escopos = bruto
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  return {
    login: corpo.login ?? '',
    escopos,
    faltando: ESCOPOS_EXIGIDOS.filter((e) => !escopos.includes(e)),
  }
}

/** Recorte do Prisma que o cofre precisa — só o suficiente para gravar e ler
 *  a credencial do projeto, sem acoplar este serviço ao client inteiro. */
export interface PrismaLike {
  project: {
    update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>
    findUnique: (args: {
      where: { id: string }
      select: Record<string, boolean>
    }) => Promise<{ encryptedClientToken?: string | null } | null>
  }
}

/** Cifra a credencial do cliente e grava no projeto. Nunca toca o banco com
 *  texto puro — a cifragem acontece antes de qualquer chamada ao Prisma. */
export async function guardarCredencialDoProjeto(deps: {
  prisma: PrismaLike
  projectId: string
  token: string
}): Promise<void> {
  await deps.prisma.project.update({
    where: { id: deps.projectId },
    data: { encryptedClientToken: encryptCredential(deps.token) },
  })
}

/** Lê e decifra a credencial do projeto. Projeto sem credencial guardada
 *  devolve nulo — ausência não é erro, é um estado válido do fluxo. */
export async function lerCredencialDoProjeto(deps: {
  prisma: PrismaLike
  projectId: string
}): Promise<string | null> {
  const registro = await deps.prisma.project.findUnique({
    where: { id: deps.projectId },
    select: { encryptedClientToken: true },
  })
  if (!registro?.encryptedClientToken) return null
  return decryptCredential(registro.encryptedClientToken)
}
