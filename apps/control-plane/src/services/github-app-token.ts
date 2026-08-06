import { sign } from 'node:crypto'

/**
 * Emite installation tokens de vida curta do GitHub App do gitorch (`gitorch-ai`),
 * para o caminho dos TRILHOS (PO/QA/SM) agir no GitHub como o PRÓPRIO gitorch —
 * nunca "pegando emprestado" o PAT de outro projeto por colisão de nome no .env.
 *
 * Contrato de degradação graciosa: qualquer problema (App não configurado, chave
 * inválida, API fora) resolve em `null` — NUNCA lança. O scheduler trata `null`
 * como "trilhos desligados" e cai no caminho clássico com log honesto.
 */

export interface AppTokenDeps {
  /** default: process.env['GITHUB_APP_ID'] */
  appId?: string | undefined
  /** default: process.env['GITHUB_APP_PRIVATE_KEY'] (aceita PEM com \n escapado) */
  privateKey?: string | undefined
  /** injeção para teste; default: fetch global */
  fetchImpl?: typeof fetch
  /** injeção para teste; default: Date.now */
  now?: () => number
  /**
   * Instalação explícita a mintar (ex.: users.github_installation_id do
   * cliente do wizard). Default: comportamento antigo — a PRIMEIRA
   * instalação do App (`installations[0]`), usado pelo caminho dos trilhos,
   * que não sabe (nem precisa saber) o ID de ninguém específico.
   */
  installationId?: number | undefined
  /**
   * Repositório do projeto (`dono/repo`) que o token vai operar. Quando
   * informado, a instalação é resolvida POR ELE (`/repos/{dono}/{repo}/
   * installation`) — a única que pode escrever ali.
   *
   * Sem isto, o caminho antigo pega `installations[0]`: a PRIMEIRA instalação
   * do App, que não tem relação nenhuma com o repositório do projeto. Com uma
   * instalação na conta pessoal e o repositório numa organização, o token
   * emitido não alcança o repositório e tudo falha com 403 confuso ("You do
   * not have permission to create labels on this repository") — o produto
   * parecia quebrado quando faltava apenas instalar o App na organização.
   */
  repository?: string | undefined
  /**
   * Chamado quando o App ESTÁ configurado e mesmo assim a emissão falha —
   * chave corrompida, App revogado, API fora. Default: console.error.
   * Existe porque o contrato de devolver `null` sem lançar já desligou o
   * produto inteiro em silêncio: sem token, PO/SM/QA caem no caminho clássico
   * e nunca criam uma issue. Ausência de App continua sendo silêncio legítimo.
   */
  onError?: (message: string) => void
  /**
   * Chamado para os avisos de degradação esperada (App sem instalação, HTTP
   * não-ok ao listar/emitir) — antes hardcoded em `console.warn`, invisível
   * na observabilidade estruturada. Produção (scheduler.ts) sempre passa
   * `app.log.warn`. Default: console.warn (só pra chamadas fora do plugin).
   */
  onWarn?: (message: string) => void
}

const GITHUB_API = 'https://api.github.com'
const TIMEOUT_MS = 10_000
const CLOCK_SKEW_MS = 60_000

interface CachedToken {
  token: string
  expiresAtMs: number
}

// Cache POR instalação — um cliente do wizard (installationId explícito) e o
// caminho dos trilhos (installations[0]) nunca devem compartilhar o token um
// do outro. `cachedInstallationId` continua existindo só para o caminho SEM
// installationId explícito, evitando repetir a chamada de listagem a cada
// tick — exatamente o comportamento de antes.
const tokenCacheByInstallation = new Map<number, CachedToken>()
let cachedInstallationId: number | null = null
// Instalação resolvida por repositório: evita repetir a consulta a cada tick
// sem nunca servir a um repositório a instalação descoberta para outro.
const installationIdByRepository = new Map<string, number>()

function base64url(input: string): string {
  return Buffer.from(input).toString('base64url')
}

/** O .env guarda a chave numa linha só com `\n` escapado (às vezes entre aspas). */
function normalizePem(raw: string): string {
  return raw.replace(/\\n/g, '\n').replace(/^"|"$/g, '').trim()
}

function signAppJwt(appId: string, privateKey: string, nowSec: number): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = base64url(JSON.stringify({ iat: nowSec - 60, exp: nowSec + 540, iss: appId }))
  const data = `${header}.${payload}`
  const signature = sign('RSA-SHA256', Buffer.from(data), normalizePem(privateKey)).toString(
    'base64url'
  )
  return `${data}.${signature}`
}

/**
 * Devolve um installation token do GitHub App do gitorch, ou `null` se o App não
 * estiver configurado/acessível. Faz cache do token até perto de expirar (a API do
 * GitHub emite tokens de ~1h), então o custo de rede é uma vez por hora, não por tick.
 */
export async function mintInstallationToken(deps: AppTokenDeps = {}): Promise<string | null> {
  const appId = deps.appId ?? process.env['GITHUB_APP_ID']
  const privateKey = deps.privateKey ?? process.env['GITHUB_APP_PRIVATE_KEY']
  if (!appId || !privateKey) return null

  const fetchImpl = deps.fetchImpl ?? fetch
  const nowMs = deps.now ? deps.now() : Date.now()

  // Resolve o ID sem tocar rede quando possível: explícito, o já descoberto
  // para ESTE repositório, ou (só no caminho sem repositório) o global.
  const repository = deps.repository
  let installationId =
    deps.installationId ??
    (repository ? installationIdByRepository.get(repository) : (cachedInstallationId ?? undefined))

  if (installationId !== undefined) {
    const cached = tokenCacheByInstallation.get(installationId)
    if (cached && cached.expiresAtMs - CLOCK_SKEW_MS > nowMs) {
      return cached.token
    }
  }

  const report = deps.onError ?? ((message: string) => console.error(message))
  const warn = deps.onWarn ?? ((message: string) => console.warn(message))

  let jwt: string
  try {
    jwt = signAppJwt(appId, privateKey, Math.floor(nowMs / 1000))
  } catch (err) {
    report(
      `[github-app-token] GITHUB_APP_PRIVATE_KEY presente (${privateKey.length} chars) mas INVALIDA: ${
        (err as Error).message
      } — trilhos desligados: PO/SM/QA nao criarao issues.`
    )
    return null
  }

  try {
    const headers = {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'gitorch-control-plane',
      'X-GitHub-Api-Version': '2022-11-28',
    }

    if (installationId === undefined && repository) {
      const res = await fetchImpl(`${GITHUB_API}/repos/${repository}/installation`, {
        headers,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!res.ok) {
        const dono = repository.split('/')[0] ?? repository
        warn(
          `[github-app-token] o GitHub App não está instalado em ${dono} (HTTP ${res.status} para ${repository}) — ` +
            `sem isso não há como criar issues ou quadro nesse repositório. Instale o App na conta/organização ${dono} e dê acesso ao repositório.`
        )
        return null
      }
      const instalacao = (await res.json()) as { id?: number }
      if (instalacao.id === undefined) {
        warn(
          `[github-app-token] resposta sem id de instalação para ${repository} — trilhos ficam desligados`
        )
        return null
      }
      installationId = instalacao.id
      installationIdByRepository.set(repository, installationId)

      const cachedDoRepo = tokenCacheByInstallation.get(installationId)
      if (cachedDoRepo && cachedDoRepo.expiresAtMs - CLOCK_SKEW_MS > nowMs) {
        return cachedDoRepo.token
      }
    }

    if (installationId === undefined) {
      const res = await fetchImpl(`${GITHUB_API}/app/installations`, {
        headers,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!res.ok) {
        warn(
          `[github-app-token] falha ao listar instalações (HTTP ${res.status}) — trilhos ficam desligados`
        )
        return null
      }
      const installations = (await res.json()) as Array<{ id: number }>
      installationId = installations[0]?.id ?? undefined
      if (installationId === undefined) {
        warn('[github-app-token] GitHub App sem nenhuma instalação — trilhos ficam desligados')
        return null
      }
      cachedInstallationId = installationId
    }

    const res = await fetchImpl(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) {
      // Reinstalar o App troca o id da instalação: sem esquecer o id velho,
      // a próxima volta reusaria um id morto para sempre (até reiniciar o
      // serviço) e o produto ficaria preso num 404 que já tem conserto.
      if (repository) installationIdByRepository.delete(repository)
      warn(
        `[github-app-token] falha ao emitir installation token (HTTP ${res.status}) — trilhos ficam desligados`
      )
      return null
    }
    const body = (await res.json()) as { token?: string; expires_at?: string }
    if (!body.token) return null

    const cachedToken: CachedToken = {
      token: body.token,
      expiresAtMs: body.expires_at ? Date.parse(body.expires_at) : nowMs + 55 * 60_000,
    }
    tokenCacheByInstallation.set(installationId, cachedToken)
    return cachedToken.token
  } catch (err) {
    if (repository) installationIdByRepository.delete(repository)
    report(
      `[github-app-token] erro ao emitir token do App (${(err as Error).message}) — trilhos ficam desligados`
    )
    return null
  }
}

/** Limpa o cache em memória — usado em testes. */
export function resetAppTokenCache(): void {
  tokenCacheByInstallation.clear()
  installationIdByRepository.clear()
  cachedInstallationId = null
}
