// A credencial que o cliente fornece é a única chave que alcança o que o App
// do produto não alcança: quadro de conta pessoal e qualquer rota de
// segurança. Antes de guardá-la, conferir que ela serve — descobrir isso na
// hora de usar significaria descobrir com o cliente já fora da tela.

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
