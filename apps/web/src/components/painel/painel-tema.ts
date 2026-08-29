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

// --- store para useSyncExternalStore (o shell lê o tema por aqui) ------------
// O evento 'storage' do navegador não dispara na MESMA aba que escreveu, então
// mantemos a lista de assinantes à mão e notificamos no `definirTema`.

type Ouvinte = () => void
const ouvintes = new Set<Ouvinte>()

function store(): Pick<Storage, 'getItem' | 'setItem'> | null {
  return typeof window !== 'undefined' ? window.localStorage : null
}

/** Assina mudanças de tema (mesma aba via `definirTema`, outras abas via `storage`). */
export function assinarTema(ouvinte: Ouvinte): () => void {
  ouvintes.add(ouvinte)
  if (typeof window !== 'undefined') window.addEventListener('storage', ouvinte)
  return () => {
    ouvintes.delete(ouvinte)
    if (typeof window !== 'undefined') window.removeEventListener('storage', ouvinte)
  }
}

/** Snapshot do tema atual (client). */
export function temaAtual(): Tema {
  return lerTema(store())
}

/** Snapshot para o SSR — sempre 'light' (o client corrige na hidratação). */
export function temaNoServidor(): Tema {
  return 'light'
}

/** Define o tema: grava e notifica os assinantes. */
export function definirTema(t: Tema): void {
  salvarTema(store(), t)
  ouvintes.forEach((o) => o())
}
