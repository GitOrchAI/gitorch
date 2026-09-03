// R2 (fix-up L4-T2): headers + fetch-JSON da API do GitHub, ÚNICOS.
// `services/proposta.ts` e `services/decisao-de-automacao.ts` montavam os
// MESMOS headers (`authorization`/`accept`/`user-agent`) e repetiam a MESMA
// checagem de `resp.ok` → erro com status + corpo, cada um do seu jeito.
// `ghJson`/`headersGithub` viram a fonte única — os dois arquivos passam a
// chamar daqui.

import { GithubExecutionError } from './github-errors.js'

/** Quantos caracteres do corpo de uma resposta de erro entram na mensagem. */
const MAX_CHARS_DO_DETALHE = 150

export function headersGithub(token: string, comCorpo = false): Record<string, string> {
  return {
    authorization: `token ${token}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'gitorch',
    ...(comCorpo ? { 'content-type': 'application/json' } : {}),
  }
}

/**
 * Chamada JSON à API do GitHub. Monta os headers padrão, serializa `body`
 * quando informado, checa `resp.ok` e lança `GithubExecutionError` com
 * método + url + status + até 150 chars do corpo (NUNCA o token) quando a
 * resposta falha. Corpo de resposta que não é JSON válido (ex.: 204 sem
 * corpo) devolve `{}` em vez de explodir.
 */
export async function ghJson<T = unknown>(
  fetchImpl: typeof fetch,
  token: string,
  method: string,
  url: string,
  body?: unknown
): Promise<T> {
  const resp = await fetchImpl(url, {
    method,
    headers: headersGithub(token, body !== undefined),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '')
    throw new GithubExecutionError(
      `GitHub ${method} ${url} → ${resp.status}: ${detail.slice(0, MAX_CHARS_DO_DETALHE)}`
    )
  }
  const data: unknown = await resp.json().catch(() => ({}))
  return data as T
}
