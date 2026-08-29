// Qual projeto o painel está mostrando — fora do React, como o tema
// (painel-tema.ts). O app web testa lógica, não componente.
//
// Por que existe: o GitOrch cuida dos repositórios do cliente, e um cliente
// tem de 1 a 10 conosco. O executivo precisa ver como flui CADA um — às vezes
// todos de uma vez, às vezes um por vez. Decisão do dono (29/08): o seletor
// fica no topo, ao lado do rastro, e o estado inicial é TODOS.
//
// A escolha dura entre visitas (localStorage). Toda leitura e escrita é
// defensiva: modo privado, quota estourada ou SSR nunca derrubam o painel.

/** `null` = todos os projetos. Uma string = o nome daquele projeto. */
export type ProjetoEscolhido = string | null

export const CHAVE_PROJETO = 'gitorch-painel-projeto'

/** O valor guardado quando a escolha é "todos" — precisa ser explícito para
 *  diferenciar de "nunca escolhi" no storage. Os dois caem em todos, mas
 *  gravar a escolha deixa claro que foi deliberada. */
export const TODOS = '__todos__'

/**
 * Lê o projeto escolhido. Ausente, "todos" ou store indisponível → `null`.
 *
 * `projetosValidos` existe para o caso real de o dono ter escolhido um projeto
 * e depois removê-lo do GitOrch: sem essa conferência o painel ficaria filtrando
 * por um projeto que não existe mais e mostrando vazio para sempre, sem o dono
 * entender por quê.
 */
export function lerProjeto(
  store: Pick<Storage, 'getItem'> | null,
  projetosValidos?: readonly string[]
): ProjetoEscolhido {
  try {
    const v = store?.getItem(CHAVE_PROJETO)
    if (!v || v === TODOS) return null
    if (projetosValidos && !projetosValidos.includes(v)) return null
    return v
  } catch {
    return null
  }
}

/** Grava a escolha. Falha de storage é silenciosa: a escolha não dura, mas o
 *  painel funciona. */
export function salvarProjeto(store: Pick<Storage, 'setItem'> | null, p: ProjetoEscolhido): void {
  try {
    store?.setItem(CHAVE_PROJETO, p ?? TODOS)
  } catch {
    /* sem storage: aceitável */
  }
}

/**
 * O trecho de querystring para as rotas do painel.
 *
 * Todos → string vazia, e não `?projeto=`: mandar a chave vazia faria a rota
 * receber um filtro por nome em branco.
 */
export function filtroDeProjeto(p: ProjetoEscolhido): string {
  return p ? `?projeto=${encodeURIComponent(p)}` : ''
}

/** O que o seletor mostra como rótulo do estado atual. */
export function rotuloDoProjeto(p: ProjetoEscolhido): string {
  return p ?? 'Todos os projetos'
}

// --- store para useSyncExternalStore -----------------------------------------
// Mesma razão do tema: o evento 'storage' não dispara na aba que escreveu.

type Ouvinte = () => void
const ouvintes = new Set<Ouvinte>()

function store(): Pick<Storage, 'getItem' | 'setItem'> | null {
  return typeof window !== 'undefined' ? window.localStorage : null
}

/** Assina mudanças (mesma aba via `definirProjeto`, outras abas via 'storage'). */
export function assinarProjeto(ouvinte: Ouvinte): () => void {
  ouvintes.add(ouvinte)
  if (typeof window !== 'undefined') window.addEventListener('storage', ouvinte)
  return () => {
    ouvintes.delete(ouvinte)
    if (typeof window !== 'undefined') window.removeEventListener('storage', ouvinte)
  }
}

/** Snapshot do projeto atual (client). */
export function projetoAtual(): ProjetoEscolhido {
  return lerProjeto(store())
}

/** Snapshot para o SSR — sempre todos; o client corrige na hidratação. */
export function projetoNoServidor(): ProjetoEscolhido {
  return null
}

/** Define o projeto: grava e notifica os assinantes. */
export function definirProjeto(p: ProjetoEscolhido): void {
  salvarProjeto(store(), p)
  ouvintes.forEach((o) => o())
}
