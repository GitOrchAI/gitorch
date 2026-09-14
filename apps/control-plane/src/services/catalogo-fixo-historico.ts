/**
 * A lista fixa que o descobridor de modelos do Claude devolvia como FALLBACK
 * antes do conserto de PR #584 (task 2098ea40) — ver
 * services/model-catalog.ts, `makeClaudeModelDiscoverer`. Sempre que a
 * descoberta real falhava, o produto devolvia ESTA lista com cara de
 * catálogo vivo, e `refreshModels`/`captureFromHome` gravavam
 * `models`+`modelsRefreshedAt` JUNTOS — como se fosse uma leitura que de
 * fato aconteceu.
 *
 * Linhas de `engine_connections` (runtime='claude') gravadas ANTES desse
 * conserto continuam com esta lista exata e uma `models_refreshed_at` que
 * NUNCA foi uma leitura real do provedor. MEDIDO em produção em 14/09/2026:
 * a única conexão claude do banco tinha `models` batendo esta lista
 * caractere por caractere, com `models_refreshed_at` de 12/09 e um
 * `last_error` de tentativa de recoleta mais recente (403) que nunca
 * conseguiu limpar a mentira, porque `refreshModels` só sobrescreve
 * `models`/`modelsRefreshedAt` em coleta BEM-SUCEDIDA (fail-closed
 * consciente, ver o comentário em engine-connection.ts).
 */
export const CATALOGO_FIXO_HISTORICO_CLAUDE = [
  'claude-fable-5',
  'claude-opus-4-8',
  'claude-sonnet-5',
  'claude-haiku-4-5-20251001',
] as const

/**
 * `models` é EXATAMENTE a lista fixa histórica — mesmo conteúdo, qualquer
 * ordem, sem sobra nem falta? Comparação por CONJUNTO porque o coletor antigo
 * nunca garantiu ordem, só o conteúdo (era um array literal no código).
 *
 * Um catálogo REAL que por coincidência viesse com um subconjunto ou uma
 * lista maior NÃO bate aqui — só o match exato prova que a linha nunca teve
 * leitura real, e é isso que decide "sem apagar se houver leitura real".
 */
export function ehCatalogoFixoHistorico(models: readonly unknown[]): boolean {
  if (models.length !== CATALOGO_FIXO_HISTORICO_CLAUDE.length) return false
  const esperado = new Set<string>(CATALOGO_FIXO_HISTORICO_CLAUDE)
  const visto = new Set<string>()
  for (const m of models) {
    if (typeof m !== 'string' || !esperado.has(m)) return false
    visto.add(m)
  }
  return visto.size === esperado.size
}

/** O motivo gravado em `last_error` quando a linha é reclassificada. */
export const MOTIVO_CATALOGO_FIXO_HISTORICO =
  'catálogo antigo: era a lista fixa de reserva do produto (removida no conserto ' +
  'da task 2098ea40), nunca uma leitura real do provedor — recoletando na próxima tentativa'

type LinhaClaude = { id: string; models: unknown }

type PrismaParaReclassificacao = {
  engineConnection: {
    findMany: (args: {
      where: { runtime: string }
      select: { id: true; models: true }
    }) => Promise<LinhaClaude[]>
    updateMany: (args: {
      where: { id: { in: string[] } }
      // `string[]`, não `unknown[]`: o Prisma real exige que `models` (coluna
      // JSON) seja um `InputJsonValue` — um array de `unknown` não é
      // estruturalmente um JSON válido aos olhos do tipo gerado
      // (`Index signature for type 'string' is missing in type 'unknown[]'`,
      // erro de build real). Todo modelo já é sempre uma string em
      // engine-connection.ts; esta rotina só grava `[]`.
      data: { models: string[]; modelsRefreshedAt: null; lastError: string }
    }) => Promise<{ count: number }>
  }
}

type LogParaReclassificacao = { warn: (obj: unknown, msg?: string) => void }

/**
 * Reclassifica como NÃO LIDA toda linha `claude` cujo `models` é exatamente o
 * catálogo fixo histórico (ver CATALOGO_FIXO_HISTORICO_CLAUDE acima).
 *
 * Zera `models` JUNTO com `modelsRefreshedAt` — nunca só um dos dois. O resto
 * do produto trata "tem `models`" e "tem `modelsRefreshedAt`" como o MESMO
 * fato: a rota do painel (routes/cascata.ts, `catalogosDoDono`) lista
 * `models` como opção 'vivo' sem olhar `modelsRefreshedAt` — deixar `models`
 * preenchido com a lista falsa faria a tela continuar oferecendo-a como
 * catálogo real, exatamente o defeito que esta rotina existe para consertar.
 * Zerando os dois juntos, a rota já trata a linha como "nunca lida" sem
 * precisar de nenhuma mudança nela.
 *
 * Idempotente por construção, sem flag nem tabela de controle: depois de
 * zerada, `models` vira `[]`, que não bate mais com o catálogo fixo (tamanho
 * diferente) — rodar de novo não encontra a linha outra vez.
 *
 * Nunca lança e nunca derruba o boot: best-effort, como todo o resto do
 * arranque (ver contrato-de-motor.ts, banco-atrasado.ts).
 */
export async function reclassificarCatalogoFixoNoBoot(
  prisma: PrismaParaReclassificacao,
  log: LogParaReclassificacao = console as unknown as LogParaReclassificacao
): Promise<number> {
  try {
    const linhas = await prisma.engineConnection.findMany({
      where: { runtime: 'claude' },
      select: { id: true, models: true },
    })
    const idsParaCorrigir = linhas
      .filter((l) => ehCatalogoFixoHistorico(Array.isArray(l.models) ? l.models : []))
      .map((l) => l.id)
    if (idsParaCorrigir.length === 0) return 0

    await prisma.engineConnection.updateMany({
      where: { id: { in: idsParaCorrigir } },
      data: { models: [], modelsRefreshedAt: null, lastError: MOTIVO_CATALOGO_FIXO_HISTORICO },
    })
    log.warn(
      { quantidade: idsParaCorrigir.length },
      `[catalogo-fixo-historico] ${idsParaCorrigir.length} conexão(ões) claude com catálogo fixo ` +
        'histórico reclassificada(s) como não lida'
    )
    return idsParaCorrigir.length
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      '[catalogo-fixo-historico] a reclassificação do catálogo fixo histórico falhou'
    )
    return 0
  }
}
