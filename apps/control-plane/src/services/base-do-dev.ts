// A base de onde TODA sessão do dev assíncrono parte e para onde todo PR dele
// mira: a principal do projeto.
//
// Medido em produção (30/09/2026): retomadas que partiam do ramo do PR antigo
// (`startingBranch`) faziam o Jules abrir o PR novo com BASE nesse ramo — a
// entrega era "mesclada" no ramo velho e nunca chegava na main. Uma única
// fonte para a delegação normal e para todas as retomadas.

/** A principal do projeto (`GITORCH_DEV_BASE_BRANCH`, padrão `main`). */
export function baseDoDev(): string {
  return process.env['GITORCH_DEV_BASE_BRANCH'] ?? 'main'
}

/** Lê um campo de texto aninhado de uma resposta do GitHub, sem cast. */
function campoTexto(valor: unknown, ...caminho: string[]): string | null {
  let atual: unknown = valor
  for (const chave of caminho) {
    if (typeof atual !== 'object' || atual === null) return null
    atual = Object.getOwnPropertyDescriptor(atual, chave)?.value
  }
  return typeof atual === 'string' && atual.length > 0 ? atual : null
}

/** Lê um campo numérico de uma resposta do GitHub, sem cast. */
export function campoNumero(valor: unknown, chave: string): number | null {
  if (typeof valor !== 'object' || valor === null) return null
  const v: unknown = Object.getOwnPropertyDescriptor(valor, chave)?.value
  return typeof v === 'number' ? v : null
}

/** `base.ref` de um pull request (resposta do GitHub); `null` quando não veio. */
export function baseDoPrDe(pr: unknown): string | null {
  return campoTexto(pr, 'base', 'ref')
}

/**
 * A branch padrão REAL do repositório (`default_branch` do GitHub) — é para ela
 * que todo PR entregue precisa mirar. Quando a leitura falha ou não traz o
 * campo, cai na base do dev (nunca lança): o pior caso é barrar um merge, nunca
 * liberar um.
 */
export async function branchPadraoDoRepositorio(
  lerRepositorio: () => Promise<unknown>,
  onWarn?: (mensagem: string) => void
): Promise<string> {
  try {
    const padrao = campoTexto(await lerRepositorio(), 'default_branch')
    if (padrao) return padrao
  } catch (err) {
    onWarn?.(
      `[base-do-dev] não deu para ler a branch padrão do repositório (${(err as Error).message}); ` +
        `usando \`${baseDoDev()}\``
    )
  }
  return baseDoDev()
}
