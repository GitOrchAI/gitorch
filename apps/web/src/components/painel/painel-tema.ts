// Tema do painel do owner, fora do React (o app web testa lógica, não
// componente — mesma decisão de painel/desejo.ts e setup/submit-flow.ts).
//
// O default é 'light': a direção visual A do handoff ("claro corporativo").
// O tema vive no wrapper `.gl` via `data-theme` e é guardado em localStorage
// para durar entre visitas. Toda leitura/escrita é defensiva: modo privado,
// quota estourada ou SSR (store nulo) nunca podem quebrar o painel.

export type Tema = 'light' | 'dark'

export const CHAVE_TEMA = 'gitorch-painel-tema'

const VALIDOS: readonly Tema[] = ['light', 'dark']

/** Lê o tema salvo. Valor ausente, inválido ou store indisponível → 'light'. */
export function lerTema(store: Pick<Storage, 'getItem'> | null): Tema {
  try {
    const v = store?.getItem(CHAVE_TEMA)
    return VALIDOS.includes(v as Tema) ? (v as Tema) : 'light'
  } catch {
    return 'light'
  }
}

/** Grava o tema. Falha de storage (modo privado/quota) é silenciosa — o
 *  tema volta ao default na próxima visita, sem derrubar a tela. */
export function salvarTema(store: Pick<Storage, 'setItem'> | null, t: Tema): void {
  try {
    store?.setItem(CHAVE_TEMA, t)
  } catch {
    /* sem storage: aceitável, o tema não persiste mas o painel funciona */
  }
}

/** Alterna claro ↔ escuro. */
export function proximoTema(t: Tema): Tema {
  return t === 'dark' ? 'light' : 'dark'
}
