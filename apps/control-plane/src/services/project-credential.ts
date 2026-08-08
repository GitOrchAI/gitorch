// A credencial que o cliente fornece é a única chave que alcança o que o App
// do produto não alcança: quadro de conta pessoal e qualquer rota de
// segurança. Antes de guardá-la, conferir que ela serve — descobrir isso na
// hora de usar significaria descobrir com o cliente já fora da tela.

import { decryptCredential, encryptCredential } from '../lib/credential-crypto.js'

const GITHUB_API = 'https://api.github.com'

/** Escopos sem os quais a credencial não cumpre o que foi prometido. */
const ESCOPOS_EXIGIDOS = ['repo', 'project'] as const

export type EscopoFaltante = (typeof ESCOPOS_EXIGIDOS)[number]

export interface CredencialVerificada {
  login: string
  escopos: string[]
  faltando: EscopoFaltante[]
}

export async function verificarCredencial(deps: {
  token: string
  fetchImpl?: typeof fetch
}): Promise<CredencialVerificada | null> {
  const f = deps.fetchImpl ?? fetch
  const resp = await f(`${GITHUB_API}/user`, {
    headers: {
      Authorization: `Bearer ${deps.token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'gitorch',
    },
  })

  if (!resp.ok) return null

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
