import { vi } from 'vitest'

/**
 * Fake REST mínimo para as rotas de segurança (não-GraphQL) que
 * coletarDividaDeSeguranca chama — compartilhado entre os testes de
 * security-debt-collector, repo-context-collector e repo-context-cortex
 * para não manter três montagens paralelas do mesmo fake.
 *
 * É um `vi.fn`, não uma função simples: alguns testes precisam inspecionar
 * `.mock.calls` (ordem/URLs das chamadas); os demais simplesmente ignoram
 * essa capacidade extra.
 */
export function restDeMentira(
  mapa: Record<string, { status: number; corpo?: unknown; headers?: Record<string, string> }>
): typeof fetch {
  return vi.fn(async (url: string | URL) => {
    const caminho = String(url).replace('https://api.github.com', '')
    const r = mapa[caminho] ?? { status: 404 }
    // null, não '': status como 204 é "null body status" no Fetch nativo do
    // Node — corpo vazio como string ainda conta como corpo e o constructor
    // recusa. Nenhum teste aqui lê o corpo quando não há `corpo` definido.
    return new Response(r.corpo === undefined ? null : JSON.stringify(r.corpo), {
      status: r.status,
      ...(r.headers ? { headers: r.headers } : {}),
    })
  }) as unknown as typeof fetch
}
