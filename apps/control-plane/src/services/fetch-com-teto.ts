/**
 * Teto de tempo compartilhado para chamada de rede CURTA (metadado de
 * GitHub — REST/GraphQL — e aviso por Telegram), usado por toda função
 * alcançável pelo tique do relógio (`scheduler.ts`, `tick()`) sob a trava
 * `tickEmAndamento`: uma chamada pendurada aqui (rede parada, não um erro —
 * um erro cai no `catch` normalmente) prende essa trava para SEMPRE, e com
 * ela a varredura inteira, de todo projeto, sem log nenhum explicando por
 * quê. Mesma família de defeito que motivou o teto de `ghGet`/`ghSend`
 * (scheduler.ts, Crítico 1 da leva C) — este módulo fecha a MESMA classe
 * para o resto da família de closures irmãs (`gh`, `rest`, `gql`, o
 * notificador do Telegram) espalhadas pelos serviços de trilhos/GitHub que
 * o tique também atravessa.
 *
 * NÃO cobre a execução do motor (`adapter.run`, dentro de `scheduler.ts`):
 * aquilo é um passo de trilhos que pode legitimamente levar minutos (o
 * PROCESSO do motor, não uma chamada `fetch`) e já tem teto próprio,
 * deliberadamente mais largo (`timeoutMs: 10 * 60 * 1000`) — fora do
 * escopo desta família.
 */
export const TIMEOUT_PADRAO_DE_CHAMADA_MS = 10_000

/**
 * Embrulha um `fetch` para SEMPRE carregar um teto de tempo. Combina — nunca
 * substitui — um `signal` que o chamador já tenha passado no `init`, via
 * `AbortSignal.any`: um teto explícito do chamador não pode apagar o piso
 * desta função, e o piso desta função não pode apagar o teto do chamador.
 * (`init?.signal ?? AbortSignal.timeout(...)` erra exatamente aqui — o
 * `??` faz o segundo lado nunca ser avaliado quando o primeiro já existe,
 * deixando o teto sem efeito nenhum sempre que há um `signal` de fora.)
 */
export function fetchComTeto(
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = TIMEOUT_PADRAO_DE_CHAMADA_MS
): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const tetoSignal = AbortSignal.timeout(timeoutMs)
    const signal = init?.signal ? AbortSignal.any([init.signal, tetoSignal]) : tetoSignal
    return fetchImpl(input, { ...init, signal })
  }) as typeof fetch
}
